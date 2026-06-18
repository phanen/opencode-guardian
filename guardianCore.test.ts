import { __test_internals, createGuardianHooks, type GuardianReply } from "./guardianCore";
import type { GuardianAction, GuardianAssessment, GuardianTranscriptEntry } from "./prompt";
import { GuardianReviewError } from "./review";
import type { GuardianMode } from "./state";

interface ReplyCall {
  requestID: string;
  reply: GuardianReply;
  message?: string;
}

interface Deps {
  mode: GuardianMode;
  decisions?: GuardianAssessment[];
  reviewError?: Error;
  transcript?: GuardianTranscriptEntry[];
}

function makeDeps(d: Deps) {
  let mode = d.mode;
  const writes: GuardianMode[] = [];
  const reviewCalls: Array<GuardianAction> = [];
  const transcriptsLoaded: Array<string> = [];
  const replies: ReplyCall[] = [];

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
    runReview: async (action: GuardianAction): Promise<GuardianAssessment> => {
      reviewCalls.push(action);
      if (d.reviewError) throw d.reviewError;
      const next = d.decisions?.shift();
      return (
        next ?? {
          risk_level: "low" as const,
          user_authorization: "high" as const,
          outcome: "allow" as const,
          rationale: "default",
        }
      );
    },
    replyPermission: async (
      sessionID: string,
      requestID: string,
      reply: GuardianReply,
      message?: string,
    ) => {
      replies.push(
        message !== undefined
          ? { requestID, reply, message, sessionID }
          : { requestID, reply, sessionID },
      );
    },
  };

  return { deps, writes, reviewCalls, transcriptsLoaded, replies, getMode: () => mode };
}

const sampleRequest = {
  id: "req-1",
  sessionID: "ses-1",
  permission: "bash",
  patterns: ["rm -rf build"],
  metadata: { command: "rm -rf build" },
  always: ["rm -rf build"],
};

async function emitPermissionAsked(
  hooks: Awaited<ReturnType<typeof createGuardianHooks>>,
  req: typeof sampleRequest,
) {
  await hooks.event!({
    event: { type: "permission.asked", properties: req },
  });
}

describe("guardianCore — event-driven permission review", () => {
  test("user mode does not call review or reply", async () => {
    const t = makeDeps({ mode: "user" });
    const hooks = await createGuardianHooks({}, t.deps);
    await emitPermissionAsked(hooks, sampleRequest);
    expect(t.reviewCalls).toEqual([]);
    expect(t.replies).toEqual([]);
  });

  test("auto_review + allow → reply once", async () => {
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
    await emitPermissionAsked(hooks, sampleRequest);
    expect(t.reviewCalls).toHaveLength(1);
    expect(t.transcriptsLoaded).toEqual(["ses-1"]);
    expect(t.replies).toEqual([{ sessionID: "ses-1", requestID: "req-1", reply: "once" }]);
  });

  test("auto_review + deny → reply reject with rationale", async () => {
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
    await emitPermissionAsked(hooks, sampleRequest);
    expect(t.replies).toHaveLength(1);
    expect(t.replies[0]?.reply).toBe("reject");
    expect(t.replies[0]?.message).toMatch(/Dangerous\./);
    expect(t.replies[0]?.message).toMatch(/workaround/);
  });

  test("review error → no reply, falls back to user", async () => {
    const t = makeDeps({
      mode: "auto_review",
      reviewError: new GuardianReviewError("timeout", "timed out"),
    });
    const hooks = await createGuardianHooks({}, t.deps);
    await emitPermissionAsked(hooks, sampleRequest);
    expect(t.replies).toEqual([]);
    expect(t.reviewCalls).toHaveLength(1);
  });

  test("circuit breaker trips after max consecutive denials, falls back to user", async () => {
    const deny: GuardianAssessment = {
      risk_level: "high",
      user_authorization: "low",
      outcome: "deny",
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

    for (let i = 0; i < 5; i++) {
      await emitPermissionAsked(hooks, { ...sampleRequest, id: `req-${i}` });
    }

    // req-0 and req-1 reply 'reject'; req-2 trips the breaker (no reply —
    // dialog goes to the user); req-3 and req-4 see interrupted=true and
    // also bail out without replying.
    expect(t.replies).toEqual([
      expect.objectContaining({ requestID: "req-0", reply: "reject" }),
      expect.objectContaining({ requestID: "req-1", reply: "reject" }),
    ]);
  });

  test("consecutive allow resets the counter", async () => {
    const deny: GuardianAssessment = {
      risk_level: "high",
      user_authorization: "low",
      outcome: "deny",
      rationale: "no",
    };
    const allow: GuardianAssessment = {
      risk_level: "low",
      user_authorization: "high",
      outcome: "allow",
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

    for (let i = 0; i < 7; i++) {
      await emitPermissionAsked(hooks, { ...sampleRequest, id: `req-${i}` });
    }

    // Sequence:
    //   req-0 deny  → reject     (count=1)
    //   req-1 deny  → reject     (count=2)
    //   req-2 allow → once       (count reset to 0)
    //   req-3 deny  → reject     (count=1)
    //   req-4 deny  → reject     (count=2)
    //   req-5 deny  → trip!      (count=3, no reply)
    //   req-6 already tripped, no reply
    expect(t.replies.map((r) => r.requestID)).toEqual([
      "req-0",
      "req-1",
      "req-2",
      "req-3",
      "req-4",
    ]);
    expect(t.replies.filter((r) => r.reply === "once")).toHaveLength(1);
    expect(t.replies.filter((r) => r.reply === "reject")).toHaveLength(4);
  });

  test("denies bash `guardian` invocations without consulting LLM", async () => {
    const t = makeDeps({ mode: "auto_review" });
    const hooks = await createGuardianHooks({}, t.deps);
    await emitPermissionAsked(hooks, {
      id: "req-guard",
      sessionID: "ses-x",
      permission: "bash",
      patterns: ["guardian status"],
    });
    expect(t.reviewCalls).toEqual([]);
    expect(t.replies).toEqual([
      expect.objectContaining({ requestID: "req-guard", reply: "reject" }),
    ]);
  });

  test("active-command flag is cleared after /guardian returns (regression)", async () => {
    const t = makeDeps({ mode: "auto_review" });
    const hooks = await createGuardianHooks({}, t.deps);
    await hooks["command.execute.before"]!(
      { command: "guardian", sessionID: "ses-cmd", arguments: "status" },
      { parts: [] },
    );
    await emitPermissionAsked(hooks, {
      id: "req-after",
      sessionID: "ses-cmd",
      permission: "task",
      patterns: [],
    });
    // No deny-local should fire after the command returns; review runs and
    // replies with the default 'allow' from the mock.
    expect(t.replies).toEqual([expect.objectContaining({ requestID: "req-after", reply: "once" })]);
    expect(t.reviewCalls).toHaveLength(1);
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

  test("session.idle also clears the active-command flag and the circuit breaker", async () => {
    const deny: GuardianAssessment = {
      risk_level: "high",
      user_authorization: "low",
      outcome: "deny",
      rationale: "no",
    };
    const t = makeDeps({
      mode: "auto_review",
      decisions: [deny, deny, deny, deny],
    });
    const hooks = await createGuardianHooks(
      { maxConsecutiveDenials: 3, maxRecentDenials: 100, recentDenialWindow: 50 },
      t.deps,
    );
    // Run /guardian to set the active flag
    await hooks["command.execute.before"]!(
      { command: "guardian", sessionID: "ses-idle", arguments: "on" },
      { parts: [] },
    );
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses-idle" } } });
    // After idle the active flag must be cleared and circuit breaker reset.
    await hooks["tool.execute.before"]!(
      { tool: "bash", sessionID: "ses-idle", callID: "c-3" },
      { args: { command: "ls" } },
    );
    // Circuit breaker for ses-idle was cleared → first denial after idle does
    // not trip because the breaker state was wiped.
    await emitPermissionAsked(hooks, {
      id: "req-postidle",
      sessionID: "ses-idle",
      permission: "bash",
      patterns: ["ls"],
    });
    expect(t.replies).toEqual([expect.objectContaining({ reply: "reject" })]);
  });

  test("question permission type is never auto-reviewed", async () => {
    const t = makeDeps({ mode: "auto_review" });
    const hooks = await createGuardianHooks({}, t.deps);
    await emitPermissionAsked(hooks, {
      id: "req-q",
      sessionID: "ses-q",
      permission: "question",
      patterns: [],
    });
    expect(t.reviewCalls).toEqual([]);
    expect(t.replies).toEqual([]);
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
    const deny: GuardianAssessment = {
      risk_level: "high",
      user_authorization: "low",
      outcome: "deny",
      rationale: "no",
    };
    const t = makeDeps({
      mode: "auto_review",
      decisions: [deny, deny, deny, deny, deny, deny, deny, deny],
    });
    const hooks = await createGuardianHooks(
      { maxConsecutiveDenials: 3, maxRecentDenials: 100, recentDenialWindow: 50 },
      t.deps,
    );

    await emitPermissionAsked(hooks, { ...sampleRequest, id: "r0" });
    await emitPermissionAsked(hooks, { ...sampleRequest, id: "r1" });
    // r2 trips the breaker → no reply
    await emitPermissionAsked(hooks, { ...sampleRequest, id: "r2" });
    expect(t.replies.map((r) => r.requestID)).toEqual(["r0", "r1"]);

    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses-1" } } });

    // After idle, breaker is reset: next deny does NOT trip (consecutive=1)
    await emitPermissionAsked(hooks, { ...sampleRequest, id: "r3" });
    expect(t.replies.map((r) => r.requestID)).toEqual(["r0", "r1", "r3"]);
  });
});

describe("actionFromPermission (internals)", () => {
  const { actionFromPermission, normalizePatterns, isGuardianCommandPattern } = __test_internals;

  test("normalizePatterns dedupes and filters empty", () => {
    expect(normalizePatterns(["foo", "bar", "foo", ""])).toEqual(["foo", "bar"]);
    expect(normalizePatterns(undefined)).toEqual([]);
    expect(normalizePatterns([])).toEqual([]);
  });

  test("actionFromPermission produces all fields from event payload", () => {
    const a = actionFromPermission({
      id: "req-1",
      sessionID: "ses-1",
      permission: "bash",
      patterns: ["rm -rf build"],
      metadata: { command: "rm -rf build" },
      always: ["rm -rf build"],
      tool: { callID: "call-1", messageID: "msg-1" },
    });
    expect(a.id).toBe("req-1");
    expect(a.permission).toBe("bash");
    expect(a.patterns).toEqual(["rm -rf build"]);
    expect(a.always).toEqual(["rm -rf build"]);
    expect(a.metadata).toEqual({ command: "rm -rf build" });
    expect(a.tool).toEqual({ callID: "call-1", messageID: "msg-1" });
    expect(a.sessionID).toBe("ses-1");
  });

  test("isGuardianCommandPattern detects guardian invocations", () => {
    expect(isGuardianCommandPattern(["guardian status"])).toBe(true);
    expect(isGuardianCommandPattern(["/guardian on"])).toBe(true);
    expect(isGuardianCommandPattern(["npm test"])).toBe(false);
  });
});