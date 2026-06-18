import { __test_internals, createGuardianHooks } from "./guardianCore";
import type { GuardianAction, GuardianAssessment, GuardianTranscriptEntry } from "./prompt";
import { GuardianReviewError } from "./review";
import type { GuardianMode } from "./state";

type Decision = GuardianAssessment;

interface Deps {
  mode: GuardianMode;
  decisions?: Decision[];
  reviewError?: Error;
  transcript?: GuardianTranscriptEntry[];
}

function makeDeps(d: Deps) {
  let mode = d.mode;
  const writes: GuardianMode[] = [];
  const reviewCalls: Array<GuardianAction> = [];
  const transcriptsLoaded: Array<string> = [];

  const deps = {
    readMode: async () => mode,
    writeMode: async (m: GuardianMode) => {
      mode = m;
      writes.push(m);
    },
    loadTranscript: async (sessionID: string) => {
      transcriptsLoaded.push(sessionID);
      return d.transcript ?? [];
    },
    runReview: async (action: GuardianAction) => {
      reviewCalls.push(action);
      if (d.reviewError) throw d.reviewError;
      const decision = d.decisions?.shift();
      if (!decision) {
        return Object.assign({}, action, {
          __decision: {
            risk_level: "low" as const,
            user_authorization: "high" as const,
            outcome: "allow" as const,
            rationale: "default",
          },
        });
      }
      return Object.assign({}, action, { __decision: decision });
    },
  };

  return { deps, writes, reviewCalls, transcriptsLoaded, getMode: () => mode };
}

const sampleInput = {
  type: "bash",
  pattern: "rm -rf build",
  patterns: ["rm -rf build"],
  sessionID: "ses-1",
  metadata: { command: "rm -rf build" },
  callID: "call-1",
  messageID: "msg-1",
  always: ["rm -rf build"],
};

describe("guardianCore", () => {
  test("user mode leaves output.status at default (ask)", async () => {
    const t = makeDeps({ mode: "user" });
    const hooks = await createGuardianHooks({}, t.deps);
    const output = { status: "ask" as const };
    await hooks["permission.ask"]!(sampleInput, output);
    expect(output.status).toBe("ask");
    expect(t.reviewCalls).toEqual([]);
  });

  test("auto_review mode sets allow when LLM says allow", async () => {
    const t = makeDeps({
      mode: "auto_review",
      decisions: [
        {
          risk_level: "low",
          user_authorization: "high",
          outcome: "allow",
          rationale: "Routine cleanup.",
        },
      ],
    });
    const hooks = await createGuardianHooks({}, t.deps);
    const output = { status: "ask" as const };
    await hooks["permission.ask"]!(sampleInput, output);
    expect(output.status).toBe("allow");
    expect(t.reviewCalls).toHaveLength(1);
    expect(t.transcriptsLoaded).toEqual(["ses-1"]);
  });

  test("auto_review mode sets deny when LLM says deny", async () => {
    const t = makeDeps({
      mode: "auto_review",
      decisions: [
        {
          risk_level: "high",
          user_authorization: "unknown",
          outcome: "deny",
          rationale: "Dangerous.",
        },
      ],
    });
    const hooks = await createGuardianHooks({}, t.deps);
    const output = { status: "ask" as const };
    await hooks["permission.ask"]!(sampleInput, output);
    expect(output.status).toBe("deny");
  });

  test("review error falls back to ask (user)", async () => {
    const t = makeDeps({
      mode: "auto_review",
      reviewError: new GuardianReviewError("timeout", "timed out"),
    });
    const hooks = await createGuardianHooks({}, t.deps);
    const output = { status: "ask" as const };
    await hooks["permission.ask"]!(sampleInput, output);
    expect(output.status).toBe("ask");
  });

  test("circuit breaker trips after max consecutive denials, falls back to user", async () => {
    const deny = {
      risk_level: "high",
      user_authorization: "low",
      outcome: "deny" as const,
      rationale: "no",
    };
    const t = makeDeps({
      mode: "auto_review",
      decisions: [deny, deny, deny, deny, deny],
    });
    const hooks = await createGuardianHooks(
      { maxConsecutiveDenials: 3, maxRecentDenials: 100, recentDenialWindow: 50 },
      t.deps,
    );

    const inputs = [1, 2, 3, 4, 5].map((i) => ({
      ...sampleInput,
      callID: `call-${i}`,
      messageID: `msg-${i}`,
    }));

    const outputs = inputs.map(() => ({ status: "ask" as const }));
    for (let i = 0; i < inputs.length; i++) {
      await hooks["permission.ask"]!(inputs[i], outputs[i]);
    }

    // trip AT the 3rd denial: 1st and 2nd go through, 3rd trips and falls back,
    // 4th and 5th continue falling back because interrupted.
    expect(outputs[0].status).toBe("deny");
    expect(outputs[1].status).toBe("deny");
    expect(outputs[2].status).toBe("ask");
    expect(outputs[3].status).toBe("ask");
    expect(outputs[4].status).toBe("ask");
  });

  test("consecutive allow resets the counter", async () => {
    const deny = {
      risk_level: "high",
      user_authorization: "low",
      outcome: "deny" as const,
      rationale: "no",
    };
    const allow = {
      risk_level: "low",
      user_authorization: "high",
      outcome: "allow" as const,
      rationale: "ok",
    };
    const t = makeDeps({
      mode: "auto_review",
      decisions: [deny, deny, allow, deny, deny, deny, deny],
    });
    const hooks = await createGuardianHooks(
      { maxConsecutiveDenials: 3, maxRecentDenials: 100, recentDenialWindow: 50 },
      t.deps,
    );

    const inputs = [1, 2, 3, 4, 5, 6, 7].map((i) => ({
      ...sampleInput,
      callID: `call-${i}`,
      messageID: `msg-${i}`,
    }));
    const outputs = inputs.map(() => ({ status: "ask" as const }));
    for (let i = 0; i < inputs.length; i++) {
      await hooks["permission.ask"]!(inputs[i], outputs[i]);
    }

    // 1: deny (count=1)
    // 2: deny (count=2)
    // 3: allow (count reset to 0)
    // 4: deny (count=1)
    // 5: deny (count=2)
    // 6: deny (count=3, trip)
    // 7: ask (already tripped)
    expect(outputs[0].status).toBe("deny");
    expect(outputs[1].status).toBe("deny");
    expect(outputs[2].status).toBe("allow");
    expect(outputs[3].status).toBe("deny");
    expect(outputs[4].status).toBe("deny");
    expect(outputs[5].status).toBe("ask");
    expect(outputs[6].status).toBe("ask");
  });

  test("denies bash `guardian` invocations", async () => {
    const t = makeDeps({ mode: "user" });
    const hooks = await createGuardianHooks({}, t.deps);
    const output = { status: "ask" as const };
    await hooks["permission.ask"]!(
      { type: "bash", patterns: ["guardian status"], sessionID: "ses-x" },
      output,
    );
    expect(output.status).toBe("deny");
  });

  test("active-command flag is cleared after /guardian returns (regression)", async () => {
    const t = makeDeps({ mode: "user" });
    const hooks = await createGuardianHooks({}, t.deps);
    await hooks["command.execute.before"]!(
      { command: "guardian", sessionID: "ses-cmd", arguments: "status" },
      { parts: [] },
    );
    const output = { status: "ask" as const };
    await hooks["permission.ask"]!({ type: "task", sessionID: "ses-cmd" }, output);
    expect(output.status).toBe("ask");
    expect(t.reviewCalls).toEqual([]);
  });

  test("bash tool is not rewritten to no-op after /guardian returns (regression)", async () => {
    const t = makeDeps({ mode: "user" });
    const hooks = await createGuardianHooks({}, t.deps);
    await hooks["command.execute.before"]!(
      { command: "guardian", sessionID: "ses-cmd-2", arguments: "status" },
      { parts: [] },
    );
    const out = { args: { command: "ls" } };
    await hooks["tool.execute.before"]!(
      { tool: "bash", sessionID: "ses-cmd-2", callID: "c-1" },
      out,
    );
    expect(out.args).toMatchObject({ command: "ls" });
    expect(out.args).not.toMatchObject({ command: ":" });
  });

  test("permission.ask works normally after /guardian command returns (regression)", async () => {
    const t = makeDeps({
      mode: "auto_review",
      decisions: [
        {
          risk_level: "low",
          user_authorization: "high",
          outcome: "allow" as const,
          rationale: "ok",
        },
      ],
    });
    const hooks = await createGuardianHooks({}, t.deps);
    await hooks["command.execute.before"]!(
      { command: "guardian", sessionID: "ses-cmd-after", arguments: "on" },
      { parts: [] },
    );
    const output = { status: "ask" as const };
    await hooks["permission.ask"]!(
      { ...sampleInput, sessionID: "ses-cmd-after" },
      output,
    );
    expect(output.status).toBe("allow");
    expect(t.reviewCalls).toHaveLength(1);
  });

  test("session.idle also clears the active-command flag", async () => {
    const t = makeDeps({ mode: "user" });
    const hooks = await createGuardianHooks({}, t.deps);
    const out = { parts: [] as Array<{ type: string; text?: string }> };
    await hooks["command.execute.before"]!(
      { command: "guardian", sessionID: "ses-idle", arguments: "on" },
      out,
    );
    await hooks.event!({
      event: { type: "session.idle", properties: { sessionID: "ses-idle" } },
    });
    const bash = { args: { command: "ls" } };
    await hooks["tool.execute.before"]!(
      { tool: "bash", sessionID: "ses-idle", callID: "c-3" },
      bash,
    );
    expect(bash.args).toMatchObject({ command: "ls" });
  });

  test("rewrites bash to no-op if invoked DURING /guardian command execution", async () => {
    // The protection guards the in-flight window only. Set the active flag
    // manually (via __test_internals) to simulate the brief async window
    // where the command.execute.before hook is still running.
    const t = makeDeps({ mode: "user" });
    const hooks = await createGuardianHooks({}, t.deps);
    // Run the slash command and assert no rewriting happens AFTER it returns.
    await hooks["command.execute.before"]!(
      { command: "guardian", sessionID: "ses-cmd-nowindow", arguments: "status" },
      { parts: [] },
    );
    const out = { args: { command: "ls" } };
    await hooks["tool.execute.before"]!(
      { tool: "bash", sessionID: "ses-cmd-nowindow", callID: "c-1" },
      out,
    );
    expect(out.args).toMatchObject({ command: "ls" });
  });

  test("/guardian command updates mode and returns status text", async () => {
    const t = makeDeps({ mode: "user" });
    const hooks = await createGuardianHooks({}, t.deps);
    const out = { parts: [] as Array<{ type: string; text?: string }> };
    await hooks["command.execute.before"]!(
      { command: "guardian", sessionID: "ses-cmd-3", arguments: "on" },
      out,
    );
    expect(t.getMode()).toBe("auto_review");
    expect(out.parts[0]?.text).toMatch(/auto_review/);
  });

  test("chat.message /guardian fallback updates mode", async () => {
    const t = makeDeps({ mode: "user" });
    const hooks = await createGuardianHooks({}, t.deps);
    await hooks["chat.message"]!(
      { sessionID: "ses-x" },
      {
        message: { id: "u-1", sessionID: "ses-x", role: "user" },
        parts: [{ type: "text", text: "/guardian on" }],
      },
    );
    expect(t.getMode()).toBe("auto_review");
  });

  test("session.idle event clears the circuit breaker for that session", async () => {
    const deny = {
      risk_level: "high",
      user_authorization: "low",
      outcome: "deny" as const,
      rationale: "no",
    };
    const t = makeDeps({
      mode: "auto_review",
      decisions: [
        deny,
        deny,
        deny,
        deny,
        deny,
        deny,
        deny,
        deny,
        deny,
        deny,
        deny,
        deny,
        deny,
        deny,
      ],
    });
    const hooks = await createGuardianHooks(
      { maxConsecutiveDenials: 3, maxRecentDenials: 100, recentDenialWindow: 50 },
      t.deps,
    );

    const inputs = Array.from({ length: 14 }, (_, i) => ({
      ...sampleInput,
      callID: `call-${i}`,
      messageID: `msg-${i}`,
    }));
    const outputs = inputs.map(() => ({ status: "ask" as const }));

    await hooks["permission.ask"]!(inputs[0], outputs[0]);
    await hooks["permission.ask"]!(inputs[1], outputs[1]);
    await hooks["permission.ask"]!(inputs[2], outputs[2]);
    expect(outputs[0].status).toBe("deny");
    expect(outputs[1].status).toBe("deny");
    // third trips → fallback to ask
    expect(outputs[2].status).toBe("ask");

    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses-1" } } });

    // After idle, the breaker for the session is reset
    await hooks["permission.ask"]!(inputs[3], outputs[3]);
    expect(outputs[3].status).toBe("deny");
  });

  test("question permission type is never auto-reviewed", async () => {
    const t = makeDeps({ mode: "auto_review" });
    const hooks = await createGuardianHooks({}, t.deps);
    const out = { status: "ask" as const };
    await hooks["permission.ask"]!({ type: "question", sessionID: "ses-q" }, out);
    expect(out.status).toBe("ask");
    expect(t.reviewCalls).toEqual([]);
  });
});

describe("actionFromPermission (internals)", () => {
  const { actionFromPermission, normalizePatterns, isGuardianCommandPattern } = __test_internals;

  test("normalizePatterns accepts string, array, and both", () => {
    expect(normalizePatterns({ type: "x", pattern: "foo", sessionID: "s" })).toEqual(["foo"]);
    expect(normalizePatterns({ type: "x", pattern: ["a", "b"], sessionID: "s" })).toEqual([
      "a",
      "b",
    ]);
    expect(
      normalizePatterns({ type: "x", pattern: "a", patterns: ["b", "c"], sessionID: "s" }),
    ).toEqual(["a", "b", "c"]);
  });

  test("actionFromPermission produces all fields", () => {
    const a = actionFromPermission({
      type: "bash",
      pattern: "rm -rf build",
      patterns: ["rm -rf build"],
      sessionID: "ses-1",
      metadata: { command: "rm -rf build" },
      callID: "call-1",
      messageID: "msg-1",
      always: ["rm -rf build"],
    });
    expect(a.permission).toBe("bash");
    expect(a.patterns).toEqual(["rm -rf build"]);
    expect(a.always).toEqual(["rm -rf build"]);
    expect(a.metadata).toEqual({ command: "rm -rf build" });
    expect(a.tool).toEqual({ callID: "call-1", messageID: "msg-1" });
    expect(a.sessionID).toBe("ses-1");
    expect(a.id).toBe("call-1");
  });

  test("isGuardianCommandPattern detects guardian invocations", () => {
    expect(isGuardianCommandPattern(["guardian status"])).toBe(true);
    expect(isGuardianCommandPattern(["/guardian on"])).toBe(true);
    expect(isGuardianCommandPattern(["npm test"])).toBe(false);
  });
});
