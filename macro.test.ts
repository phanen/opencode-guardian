import { describe, expect, it } from "vitest";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { $log } from "./debugLog.macro";
import { debugLog, DEBUG_LOG_PATH } from "./utils";

void debugLog; // runtime target of the $log! macro

describe("$log! macro expansion", () => {
  it("auto-injects labels for Identifier args", () => {
    if (existsSync(DEBUG_LOG_PATH)) unlinkSync(DEBUG_LOG_PATH);
    const x = "foo";
    const y = 42;
    $log!("TEST", x, y);
    const content = readFileSync(DEBUG_LOG_PATH, "utf8");
    const lastLine = content.trimEnd().split("\n").pop() ?? "";
    expect(lastLine).toContain("[TEST]");
    expect(lastLine).toContain("x=foo");
    expect(lastLine).toContain("y=42");
  });

  it("forwards string literals as orphan values", () => {
    const x = "bar";
    $log!("TEST", "reason=just-a-message", "next-orphan", x);
    const content = readFileSync(DEBUG_LOG_PATH, "utf8");
    const lastLine = content.trimEnd().split("\n").pop() ?? "";
    expect(lastLine).toContain("reason=just-a-message");
    expect(lastLine).toContain("next-orphan");
    expect(lastLine).toContain("x=bar");
    if (existsSync(DEBUG_LOG_PATH)) unlinkSync(DEBUG_LOG_PATH);
  });

  it("does not double-inject when a manual label precedes the value", () => {
    const x = "baz";
    $log!("TEST", "manual_label=", x);
    const content = readFileSync(DEBUG_LOG_PATH, "utf8");
    const lastLine = content.trimEnd().split("\n").pop() ?? "";
    expect(lastLine).toContain("manual_label=");
    if (existsSync(DEBUG_LOG_PATH)) unlinkSync(DEBUG_LOG_PATH);
  });

  it("expands object literal arg using property keys as labels", () => {
    const requestID = "req_abc";
    const status = 200;
    $log!("TEST", { request_id: requestID, status, ok: true });
    const content = readFileSync(DEBUG_LOG_PATH, "utf8");
    const lastLine = content.trimEnd().split("\n").pop() ?? "";
    expect(lastLine).toContain("[TEST]");
    expect(lastLine).toContain("request_id=req_abc");
    expect(lastLine).toContain("status=200");
    expect(lastLine).toContain("ok=true");
  });

  it("cleans up the log file", () => {
    if (existsSync(DEBUG_LOG_PATH)) unlinkSync(DEBUG_LOG_PATH);
  });
});
