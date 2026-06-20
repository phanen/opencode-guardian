import {
  buildGuardianUserContent,
  buildQuestionUserContent,
  formatActionSummary,
  type GuardianAction,
  parseGuardianAssessment,
  parseQuestionDecision,
} from "./prompt";
import type { QuestionAskedRequest } from "./types";

const baseAction: GuardianAction = {
  id: "perm-1",
  permission: "bash",
  patterns: ["npm test"],
  metadata: { command: "npm test" },
  always: ["npm test"],
  sessionID: "ses-1",
  tool: { callID: "call-1", messageID: "msg-1" },
};

describe("prompt", () => {
  test("buildGuardianUserContent contains transcript, action, and policy markers", () => {
    const text = buildGuardianUserContent(baseAction, [
      { role: "user", text: "Please run the tests." },
      { role: "assistant", text: "I'll run npm test." },
    ]);
    expect(text).toContain(">>> TRANSCRIPT START");
    expect(text).toContain(">>> TRANSCRIPT END");
    expect(text).toContain(">>> ACTION START");
    expect(text).toContain(">>> ACTION END");
    expect(text).toContain("npm test");
    expect(text).toContain("Please run the tests.");
  });

  test("buildGuardianUserContent handles empty transcript", () => {
    const text = buildGuardianUserContent(baseAction, []);
    expect(text).toContain("(empty)");
  });

  test("parseGuardianAssessment accepts plain JSON object", () => {
    const r = parseGuardianAssessment(
      JSON.stringify({
        risk_level: "medium",
        user_authorization: "medium",
        outcome: "allow",
        rationale: "Routine test run.",
      }),
    );
    expect(r.outcome).toBe("allow");
    expect(r.risk_level).toBe("medium");
  });

  test("parseGuardianAssessment strips markdown fence", () => {
    const r = parseGuardianAssessment(
      "```json\n" +
        JSON.stringify({
          risk_level: "high",
          user_authorization: "low",
          outcome: "deny",
          rationale: "Will push to a protected branch.",
        }) +
        "\n```",
    );
    expect(r.outcome).toBe("deny");
    expect(r.risk_level).toBe("high");
  });

  test("parseGuardianAssessment rejects missing fields", () => {
    expect(() => parseGuardianAssessment("{}")).toThrow();
    expect(() => parseGuardianAssessment('{"outcome":"allow"}')).toThrow();
    expect(() =>
      parseGuardianAssessment(JSON.stringify({ risk_level: "high", user_authorization: "low", outcome: "deny" })),
    ).toThrow();
  });

  test("parseGuardianAssessment rejects invalid enums", () => {
    expect(() =>
      parseGuardianAssessment(
        JSON.stringify({
          risk_level: "huge",
          user_authorization: "low",
          outcome: "deny",
          rationale: "x",
        }),
      ),
    ).toThrow();
  });

  test("parseGuardianAssessment rejects unparseable text", () => {
    expect(() => parseGuardianAssessment("not json at all")).toThrow();
  });

  test("parseGuardianAssessment extracts JSON out of surrounding prose", () => {
    const r = parseGuardianAssessment(
      'Here is my decision:\n{"risk_level":"low","user_authorization":"high","outcome":"allow","rationale":"OK"}',
    );
    expect(r.outcome).toBe("allow");
  });

  test("formatActionSummary includes permission, pattern, and metadata", () => {
    const s = formatActionSummary(baseAction);
    expect(s).toContain("bash");
    expect(s).toContain("npm test");
  });

  test("formatActionSummary omits empty metadata", () => {
    const s = formatActionSummary({ ...baseAction, metadata: {} });
    expect(s).toContain("bash(npm test)");
  });
});

const baseQuestion: QuestionAskedRequest = {
  id: "q-1",
  sessionID: "ses-1",
  questions: [
    {
      question: "Delete the build directory?",
      header: "Delete build?",
      options: [
        { label: "Yes", description: "Run rm -rf build" },
        { label: "No", description: "Keep build" },
      ],
    },
  ],
};

describe("prompt — question helpers", () => {
  test("buildQuestionUserContent includes transcript and questions", () => {
    const text = buildQuestionUserContent(baseQuestion, [{ role: "user", text: "Please clean up." }]);
    expect(text).toContain(">>> TRANSCRIPT START");
    expect(text).toContain(">>> QUESTIONS START");
    expect(text).toContain("Delete the build directory?");
    expect(text).toContain("Yes");
    expect(text).toContain("No");
  });

  test("parseQuestionDecision accepts plain answer JSON", () => {
    const r = parseQuestionDecision(JSON.stringify({ action: "answer", answers: [["No"]] }), baseQuestion);
    expect(r.action).toBe("answer");
    if (r.action === "answer") {
      expect(r.answers).toEqual([["No"]]);
    }
  });

  test("parseQuestionDecision accepts reject", () => {
    const r = parseQuestionDecision(JSON.stringify({ action: "reject", answers: [] }), baseQuestion);
    expect(r.action).toBe("reject");
  });

  test("parseQuestionDecision strips markdown fence", () => {
    const r = parseQuestionDecision(
      `\`\`\`json\n${JSON.stringify({ action: "answer", answers: [["Yes"]] })}\n\`\`\``,
      baseQuestion,
    );
    expect(r.action).toBe("answer");
  });

  test("parseQuestionDecision rejects unknown label", () => {
    expect(() =>
      parseQuestionDecision(JSON.stringify({ action: "answer", answers: [["Maybe"]] }), baseQuestion),
    ).toThrow(/unknown label/);
  });

  test("parseQuestionDecision rejects wrong answer count", () => {
    expect(() => parseQuestionDecision(JSON.stringify({ action: "answer", answers: [] }), baseQuestion)).toThrow(
      /answers\.length=0/,
    );
  });

  test("parseQuestionDecision rejects empty per-question array", () => {
    expect(() => parseQuestionDecision(JSON.stringify({ action: "answer", answers: [[]] }), baseQuestion)).toThrow(
      /non-empty array/,
    );
  });

  test("parseQuestionDecision rejects missing action", () => {
    expect(() => parseQuestionDecision(JSON.stringify({ answers: [["Yes"]] }), baseQuestion)).toThrow(/action/);
  });

  test("parseQuestionDecision handles multi-question request", () => {
    const multi: QuestionAskedRequest = {
      id: "q-2",
      sessionID: "ses-1",
      questions: [
        {
          question: "Q1",
          header: "h1",
          options: [
            { label: "A", description: "" },
            { label: "B", description: "" },
          ],
        },
        {
          question: "Q2",
          header: "h2",
          options: [
            { label: "X", description: "" },
            { label: "Y", description: "" },
          ],
        },
      ],
    };
    const r = parseQuestionDecision(JSON.stringify({ action: "answer", answers: [["A"], ["X", "Y"]] }), multi);
    expect(r.action).toBe("answer");
    if (r.action === "answer") {
      expect(r.answers).toEqual([["A"], ["X", "Y"]]);
    }
  });
});

describe("parseQuestionDecision — (Recommended) suffix and fuzzy match", () => {
  const withRecommended: QuestionAskedRequest = {
    id: "q-1",
    sessionID: "ses-1",
    questions: [
      {
        question: "Pick one",
        header: "h",
        options: [
          { label: "派之前先确认 spec (Recommended)", description: "..." },
          { label: "你写啥我派啥", description: "..." },
        ],
      },
    ],
  };

  test("accepts answer that omits the (Recommended) suffix", () => {
    const r = parseQuestionDecision(
      JSON.stringify({ action: "answer", answers: [["派之前先确认 spec"]] }),
      withRecommended,
    );
    expect(r.action).toBe("answer");
    if (r.action === "answer") {
      // Returns the canonical option label, not the LLM's mangled input.
      expect(r.answers).toEqual([["派之前先确认 spec (Recommended)"]]);
    }
  });

  test("accepts the canonical label with (Recommended) unchanged", () => {
    const r = parseQuestionDecision(
      JSON.stringify({ action: "answer", answers: [["派之前先确认 spec (Recommended)"]] }),
      withRecommended,
    );
    expect(r.action).toBe("answer");
    if (r.action === "answer") {
      expect(r.answers).toEqual([["派之前先确认 spec (Recommended)"]]);
    }
  });

  test("tolerates trailing whitespace before (Recommended)", () => {
    const r = parseQuestionDecision(
      JSON.stringify({ action: "answer", answers: [["派之前先确认 spec  (Recommended)"]] }),
      withRecommended,
    );
    expect(r.action).toBe("answer");
  });

  test("fuzzy-matches a label with shared prefix above threshold", () => {
    const r = parseQuestionDecision(JSON.stringify({ action: "answer", answers: [["派之前先确认"]] }), withRecommended);
    expect(r.action).toBe("answer");
    if (r.action === "answer") {
      expect(r.answers).toEqual([["派之前先确认 spec (Recommended)"]]);
    }
  });

  test("rejects a clearly different option (no shared prefix)", () => {
    expect(() =>
      parseQuestionDecision(JSON.stringify({ action: "answer", answers: [["完全不相关"]] }), withRecommended),
    ).toThrow(/unknown label/);
  });

  test("rejects label below fuzzy-match threshold", () => {
    // 1 char of overlap out of 8 = 0.125, well below 0.3.
    expect(() =>
      parseQuestionDecision(JSON.stringify({ action: "answer", answers: [["派不相干"]] }), withRecommended),
    ).toThrow(/unknown label/);
  });
});

describe("parseQuestionDecision — flat answers auto-wrap", () => {
  const singleQuestion: QuestionAskedRequest = {
    id: "q-flat-1",
    sessionID: "ses-1",
    questions: [
      {
        question: "Pick one",
        header: "h",
        options: [
          { label: "成功, 看到了 question UI", description: "" },
          { label: "成功, 但 UI 渲染有问题", description: "" },
          { label: "没有看到 dialog", description: "" },
        ],
      },
    ],
  };

  const multiQuestion: QuestionAskedRequest = {
    id: "q-flat-2",
    sessionID: "ses-1",
    questions: [
      {
        question: "Q1",
        header: "h1",
        options: [
          { label: "A", description: "" },
          { label: "B", description: "" },
        ],
      },
      {
        question: "Q2",
        header: "h2",
        options: [
          { label: "X", description: "" },
          { label: "Y", description: "" },
        ],
      },
    ],
  };

  test("auto-wraps flat answer array for a single question", () => {
    const r = parseQuestionDecision(
      JSON.stringify({ action: "answer", answers: ["成功, 看到了 question UI"] }),
      singleQuestion,
    );
    expect(r.action).toBe("answer");
    if (r.action === "answer") {
      expect(r.answers).toEqual([["成功, 看到了 question UI"]]);
    }
  });

  test("auto-wraps flat answer array for multiple questions", () => {
    const r = parseQuestionDecision(JSON.stringify({ action: "answer", answers: ["A", "Y"] }), multiQuestion);
    expect(r.action).toBe("answer");
    if (r.action === "answer") {
      expect(r.answers).toEqual([["A"], ["Y"]]);
    }
  });

  test("flat answer honors (Recommended) suffix stripping", () => {
    const req: QuestionAskedRequest = {
      id: "q-flat-3",
      sessionID: "ses-1",
      questions: [
        {
          question: "Pick",
          header: "h",
          options: [
            { label: "派之前先确认 spec (Recommended)", description: "" },
            { label: "你写啥我派啥", description: "" },
          ],
        },
      ],
    };
    const r = parseQuestionDecision(JSON.stringify({ action: "answer", answers: ["派之前先确认 spec"] }), req);
    expect(r.action).toBe("answer");
    if (r.action === "answer") {
      expect(r.answers).toEqual([["派之前先确认 spec (Recommended)"]]);
    }
  });

  test("flat answer length mismatch throws", () => {
    expect(() =>
      parseQuestionDecision(JSON.stringify({ action: "answer", answers: ["A", "B"] }), singleQuestion),
    ).toThrow(/answers\.length=2/);
  });

  test("rejects mixed-shape answers (string + array)", () => {
    expect(() =>
      parseQuestionDecision(JSON.stringify({ action: "answer", answers: [["A"], "B"] }), multiQuestion),
    ).toThrow(/non-empty array of label strings/);
  });

  test("still accepts canonical nested-array answers", () => {
    const r = parseQuestionDecision(JSON.stringify({ action: "answer", answers: [["A", "B"]] }), {
      id: "q-flat-4",
      sessionID: "ses-1",
      questions: [
        {
          question: "Pick many",
          header: "h",
          options: [
            { label: "A", description: "" },
            { label: "B", description: "" },
          ],
        },
      ],
    });
    expect(r.action).toBe("answer");
    if (r.action === "answer") {
      expect(r.answers).toEqual([["A", "B"]]);
    }
  });
});
