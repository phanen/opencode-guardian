import { type GuardianMode, readMode, writeMode } from "./state";

export interface GuardianCommandResult {
  handled: boolean;
  mode?: GuardianMode;
}

interface CommandDeps {
  readMode: () => Promise<GuardianMode>;
  writeMode: (mode: GuardianMode) => Promise<void>;
}

const defaultDeps: CommandDeps = {
  readMode: async () => readMode(),
  writeMode,
};

export async function maybeHandleGuardianCommand(
  text: string,
  deps: CommandDeps = defaultDeps,
): Promise<GuardianCommandResult> {
  const value = text.trim().toLowerCase();
  if (!value.startsWith("/guardian")) return { handled: false };

  const rest = value.slice("/guardian".length).trim();

  if (rest === "" || rest === "toggle") {
    const current = await deps.readMode();
    const next: GuardianMode = current === "auto_review" ? "user" : "auto_review";
    await deps.writeMode(next);
    return { handled: true, mode: next };
  }

  if (rest === "on" || rest === "auto_review" || rest === "auto" || rest === "guardian") {
    await deps.writeMode("auto_review");
    return { handled: true, mode: "auto_review" };
  }

  if (rest === "off" || rest === "user") {
    await deps.writeMode("user");
    return { handled: true, mode: "user" };
  }

  if (rest === "status") {
    return { handled: true, mode: await deps.readMode() };
  }

  return { handled: false };
}

export function statusLineFor(mode: GuardianMode): string {
  return mode === "auto_review"
    ? "Guardian mode: auto_review (LLM reviews each approval request)."
    : "Guardian mode: user (all approvals go to the human).";
}
