import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readMode, writeMode } from "./state";

describe("state", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "guardian-state-"));
    file = path.join(dir, ".guardian.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("readMode returns default when file does not exist", async () => {
    const mode = await readMode("user", file);
    expect(mode).toBe("user");
  });

  test("writeMode then readMode round-trips", async () => {
    await writeMode("auto_review", file);
    const mode = await readMode("user", file);
    expect(mode).toBe("auto_review");
  });

  test("readMode returns default when file is malformed", async () => {
    const fs = await import("node:fs/promises");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, "not-json", "utf8");
    const mode = await readMode("user", file);
    expect(mode).toBe("user");
  });

  test("readMode returns default when mode is invalid", async () => {
    const fs = await import("node:fs/promises");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, JSON.stringify({ mode: "garbage" }), "utf8");
    const mode = await readMode("user", file);
    expect(mode).toBe("user");
  });

  test("writeMode creates parent dir if missing", async () => {
    const nested = path.join(dir, "nested", "deep", ".guardian.json");
    await writeMode("auto_review", nested);
    const mode = await readMode("user", nested);
    expect(mode).toBe("auto_review");
  });
});
