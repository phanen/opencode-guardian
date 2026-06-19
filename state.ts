import { promises as fs } from "node:fs";
import path from "node:path";

function defaultStatePath() {
  return path.join(process.cwd(), ".guardian.json");
}

interface StateFile {
  mode?: "user" | "auto_review" | "dangerously_skip";
  updatedAt?: string;
}

export type GuardianMode = "user" | "auto_review" | "dangerously_skip";

function isGuardianMode(value: unknown): value is GuardianMode {
  return value === "user" || value === "auto_review" || value === "dangerously_skip";
}

export async function readMode(
  defaultValue: GuardianMode = "user",
  filePath = defaultStatePath(),
): Promise<GuardianMode> {
  try {
    const data = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(data) as StateFile;
    return isGuardianMode(parsed.mode) ? parsed.mode : defaultValue;
  } catch {
    return defaultValue;
  }
}

export async function writeMode(mode: GuardianMode, filePath = defaultStatePath()): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload: StateFile = {
    mode,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}
