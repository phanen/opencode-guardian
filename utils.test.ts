import { describe, expect, it } from "vitest";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { debugLog, DEBUG_LOG_PATH } from "./utils";

describe("debugLog runtime formatting", () => {
  it("pairs trailing-= labels with the next value", () => {
    debugLog("TAG", "k1=", 1, "k2=", "hello", "k3=", true);
    const content = readFileSync(DEBUG_LOG_PATH, "utf8");
    const lastLine = content.trimEnd().split("\n").pop() ?? "";
    expect(lastLine).toContain("[TAG]");
    expect(lastLine).toContain("k1=1");
    expect(lastLine).toContain("k2=hello");
    expect(lastLine).toContain("k3=true");
  });

  it("emits bare strings as orphans without an =", () => {
    debugLog("TAG", "reason=just-a-message", "next-string", 99);
    const content = readFileSync(DEBUG_LOG_PATH, "utf8");
    const lastLine = content.trimEnd().split("\n").pop() ?? "";
    expect(lastLine).toContain("[TAG]");
    expect(lastLine).toContain("reason=just-a-message");
    expect(lastLine).toContain("next-string 99");
  });

  it("expands plain object args via Reflect.ownKeys", () => {
    debugLog("OBJ", { k1: "v1", k2: 42 });
    const content = readFileSync(DEBUG_LOG_PATH, "utf8");
    const lastLine = content.trimEnd().split("\n").pop() ?? "";
    expect(lastLine).toContain("[OBJ]");
    expect(lastLine).toContain("k1=v1");
    expect(lastLine).toContain("k2=42");
  });

  it("cleans up the log file", () => {
    if (existsSync(DEBUG_LOG_PATH)) unlinkSync(DEBUG_LOG_PATH);
  });
});
