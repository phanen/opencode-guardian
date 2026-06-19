import type { GuardianAction, GuardianAssessment, GuardianTranscriptEntry } from "./prompt";
import { GuardianReviewError, type GuardianReviewerDeps, runGuardianReview } from "./review";
import type { ContentPart } from "./types";

const action: GuardianAction = {
  id: "perm-1",
  permission: "bash",
  patterns: ["rm -rf /tmp/build"],
  metadata: { command: "rm -rf /tmp/build" },
  always: [],
  sessionID: "ses-1",
};

const transcript: GuardianTranscriptEntry[] = [{ role: "user", text: "clean up the build dir" }];

type Handler = (parts: ContentPart[]) => GuardianAssessment | Error;

function makeDeps(handler: Handler): GuardianReviewerDeps {
  return {
    createSession: async () => ({ id: "guardian-ses" }),
    prompt: async () => {
      const r = handler([]);
      if (r instanceof Error) throw r;
      return {
        info: { id: "msg-1", sessionID: "guardian-ses", role: "assistant" },
        parts: [
          {
            type: "text",
            text: JSON.stringify(r),
          },
        ],
      };
    },
  };
}

const allowAssessment: GuardianAssessment = {
  risk_level: "low",
  user_authorization: "high",
  outcome: "allow",
  rationale: "Routine local cleanup.",
};

describe("review", () => {
  test("returns parsed assessment on success", async () => {
    const deps = makeDeps(() => allowAssessment);
    const r = await runGuardianReview(
      action,
      transcript,
      { timeoutMs: 5000, maxAttempts: 1, baseBackoffMs: 10 },
      deps,
    );
    expect(r).toEqual(allowAssessment);
  });

  test("retries on parse failure then succeeds", async () => {
    let calls = 0;
    const deps: GuardianReviewerDeps = {
      createSession: async () => ({ id: "guardian-ses" }),
      prompt: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            info: { id: "msg-1", sessionID: "guardian-ses", role: "assistant" },
            parts: [{ type: "text", text: "not json" }],
          };
        }
        return {
          info: { id: "msg-2", sessionID: "guardian-ses", role: "assistant" },
          parts: [{ type: "text", text: JSON.stringify(allowAssessment) }],
        };
      },
    };
    const r = await runGuardianReview(
      action,
      transcript,
      { timeoutMs: 5000, maxAttempts: 3, baseBackoffMs: 1 },
      deps,
    );
    expect(r).toEqual(allowAssessment);
    expect(calls).toBe(2);
  });

  test("throws GuardianReviewError on persistent parse failure", async () => {
    const deps: GuardianReviewerDeps = {
      createSession: async () => ({ id: "guardian-ses" }),
      prompt: async () => ({
        info: { id: "msg-1", sessionID: "guardian-ses", role: "assistant" },
        parts: [{ type: "text", text: "garbage" }],
      }),
    };
    await expect(
      runGuardianReview(
        action,
        transcript,
        { timeoutMs: 5000, maxAttempts: 2, baseBackoffMs: 1 },
        deps,
      ),
    ).rejects.toBeInstanceOf(GuardianReviewError);
  });

  test("throws timeout when deadline is reached", async () => {
    const deps: GuardianReviewerDeps = {
      createSession: async () => ({ id: "guardian-ses" }),
      prompt: async () => {
        await new Promise((r) => setTimeout(r, 100));
        return {
          info: { id: "msg-1", sessionID: "guardian-ses", role: "assistant" },
          parts: [{ type: "text", text: JSON.stringify(allowAssessment) }],
        };
      },
    };
    await expect(
      runGuardianReview(
        action,
        transcript,
        { timeoutMs: 10, maxAttempts: 1, baseBackoffMs: 1 },
        deps,
      ),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  test("throws cancelled when signal aborts", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 5);
    const deps: GuardianReviewerDeps = {
      createSession: async () => ({ id: "guardian-ses" }),
      prompt: async () => {
        await new Promise((r) => setTimeout(r, 100));
        return {
          info: { id: "msg-1", sessionID: "guardian-ses", role: "assistant" },
          parts: [{ type: "text", text: JSON.stringify(allowAssessment) }],
        };
      },
    };
    await expect(
      runGuardianReview(
        action,
        transcript,
        { timeoutMs: 1000, maxAttempts: 1, baseBackoffMs: 1 },
        deps,
        ac.signal,
      ),
    ).rejects.toMatchObject({ kind: "cancelled" });
  });

  test("reuses same session across retries", async () => {
    let createCount = 0;
    let promptCount = 0;
    const deps: GuardianReviewerDeps = {
      createSession: async () => {
        createCount += 1;
        return { id: "guardian-ses" };
      },
      prompt: async () => {
        promptCount += 1;
        if (promptCount < 2) throw new Error("transient");
        return {
          info: { id: "msg-1", sessionID: "guardian-ses", role: "assistant" },
          parts: [{ type: "text", text: JSON.stringify(allowAssessment) }],
        };
      },
    };
    const r = await runGuardianReview(
      action,
      transcript,
      { timeoutMs: 5000, maxAttempts: 3, baseBackoffMs: 1 },
      deps,
    );
    expect(r.outcome).toBe("allow");
    expect(createCount).toBe(1);
    expect(promptCount).toBe(2);
  });
});
