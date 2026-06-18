import {
  buildGuardianUserContent,
  formatActionSummary,
  type GuardianAction,
  parseGuardianAssessment,
} from "./prompt";

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
      parseGuardianAssessment(
        JSON.stringify({ risk_level: "high", user_authorization: "low", outcome: "deny" }),
      ),
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
