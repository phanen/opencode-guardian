import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { maybeHandleGuardianCommand, statusLineFor } from "./commands";
import type { GuardianAction, GuardianTranscriptEntry } from "./prompt";
import { GuardianReviewError } from "./review";
import type { GuardianMode } from "./state";

const YOLO_DEBUG_LOG = "/tmp/guardian-debug.log";

// Stable per-process prefix so concurrent opencode sessions are easy to
// distinguish when they all append to the same shared log file.
const INSTANCE_ID = randomBytes(3).toString("hex");
const PROCESS_PID = process.pid;
const PROCESS_CWD = process.cwd();

function guardianLog(...args: unknown[]) {
  try {
    const line =
      `${new Date().toISOString()} [GUARDIAN pid=${PROCESS_PID} inst=${INSTANCE_ID}] ` +
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") +
      "\n";
    appendFileSync(YOLO_DEBUG_LOG, line);
  } catch {
    // never throw from logging
  }
}

export interface GuardianOptions {
  mode?: GuardianMode;
  guardianModel?: { providerID: string; modelID: string };
  timeoutMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  transcriptCacheLimit?: number;
  maxConsecutiveDenials?: number;
  maxRecentDenials?: number;
  recentDenialWindow?: number;
  fallbackOnCircuitBreak?: boolean;
  debugLogPath?: string;
}

export interface GuardianRuntimeDeps {
  readMode: () => Promise<GuardianMode>;
  writeMode: (mode: GuardianMode) => Promise<void>;
  loadTranscript: (sessionID: string, limit: number) => Promise<GuardianTranscriptEntry[]>;
  runReview: (
    action: GuardianAction,
    transcript: GuardianTranscriptEntry[],
    signal?: AbortSignal,
  ) => Promise<GuardianAction & { __decision: import("./prompt").GuardianAssessment }>;
  isPermissionAllowedByUserRule?: (input: PermissionInput) => boolean;
}

export interface PermissionInput {
  type: string;
  pattern?: string | string[];
  sessionID: string;
  metadata?: Record<string, unknown>;
  patterns?: string[];
  always?: string[];
  callID?: string;
  messageID?: string;
  id?: string;
}

export interface PermissionOutput {
  status: "ask" | "deny" | "allow";
}

export interface Hooks {
  "permission.ask"?: (input: PermissionInput, output: PermissionOutput) => Promise<void>;
  event?: (input: { event: unknown }) => Promise<void>;
  "command.execute.before"?: (
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Array<{ type: string; text?: string }> },
  ) => Promise<void>;
  "chat.message"?: (
    input: { sessionID?: string },
    output: {
      message?: { id?: string; sessionID?: string; role?: string };
      parts?: Array<{ type?: string; text?: string }>;
    },
  ) => Promise<void>;
  "tool.execute.before"?: (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: any },
  ) => Promise<void>;
  dispose?: () => Promise<void>;
}

const DEFAULT_TRANSCRIPT_CACHE_LIMIT = 40;
const DEFAULT_MAX_CONSECUTIVE_DENIALS = 3;
const DEFAULT_MAX_RECENT_DENIALS = 10;
const DEFAULT_RECENT_DENIAL_WINDOW = 50;
const DEFAULT_FALLBACK_ON_CIRCUIT_BREAK = true;

const GUARDIAN_DENIAL_INSTRUCTIONS =
  "The agent must not attempt to achieve the same outcome via workaround, " +
  "indirect execution, or policy circumvention. " +
  "Proceed only with a materially safer alternative, " +
  "or if the user explicitly approves the action after being informed of the risk. " +
  "Otherwise, stop and request user input.";

const GUARDIAN_TIMEOUT_INSTRUCTIONS =
  "The automatic permission approval review did not finish before its deadline. " +
  "Do not assume the action is unsafe based on the timeout alone. " +
  "You may retry once, or ask the user for guidance or explicit approval.";

const GUARDIAN_COMMAND_NAME = "guardian";

function normalizePatterns(input: PermissionInput): string[] {
  const raw: string[] = [];
  if (Array.isArray(input.pattern)) raw.push(...input.pattern);
  if (typeof input.pattern === "string") raw.push(input.pattern);
  if (Array.isArray(input.patterns)) raw.push(...input.patterns);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of raw) {
    if (typeof p !== "string" || p.length === 0) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function actionFromPermission(input: PermissionInput): GuardianAction {
  const patterns = normalizePatterns(input);
  return {
    id: input.id ?? input.callID ?? `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    permission: input.type,
    patterns,
    metadata: input.metadata ?? {},
    always: input.always ?? [],
    sessionID: input.sessionID,
    tool:
      input.callID && input.messageID
        ? { callID: input.callID, messageID: input.messageID }
        : undefined,
  };
}

function isGuardianCommandPattern(patterns: string[]): boolean {
  return patterns.some((p) => /(^|\s)\/?guardian(\s|$)/.test(p));
}

function denialMessage(rationale: string, source: "agent" | "timeout"): string {
  if (source === "timeout") return GUARDIAN_TIMEOUT_INSTRUCTIONS;
  return `This action was rejected by the Guardian auto-review.\nReason: ${rationale.trim()}\n${GUARDIAN_DENIAL_INSTRUCTIONS}`;
}

interface CircuitBreakerTurn {
  consecutiveDenials: number;
  recentDenials: boolean[];
  interrupted: boolean;
}

class CircuitBreaker {
  private turns = new Map<string, CircuitBreakerTurn>();

  isTripped(turnID: string): boolean {
    return this.turns.get(turnID)?.interrupted === true;
  }

  recordDeny(
    turnID: string,
    opts: { maxConsecutive: number; maxRecent: number; window: number },
  ): {
    tripped: boolean;
    consecutiveDenials: number;
    recentDenials: number;
  } {
    let turn = this.turns.get(turnID);
    if (!turn) {
      turn = { consecutiveDenials: 0, recentDenials: [], interrupted: false };
      this.turns.set(turnID, turn);
    }
    turn.consecutiveDenials += 1;
    turn.recentDenials.push(true);
    if (turn.recentDenials.length > opts.window) turn.recentDenials.shift();

    const recentCount = turn.recentDenials.filter(Boolean).length;
    const tripped =
      !turn.interrupted &&
      (turn.consecutiveDenials >= opts.maxConsecutive || recentCount >= opts.maxRecent);
    if (tripped) turn.interrupted = true;
    return { tripped, consecutiveDenials: turn.consecutiveDenials, recentDenials: recentCount };
  }

  recordAllow(turnID: string): void {
    const turn = this.turns.get(turnID);
    if (!turn) return;
    turn.consecutiveDenials = 0;
    turn.recentDenials.push(false);
    if (turn.recentDenials.length > 50) turn.recentDenials.shift();
  }

  clearTurn(turnID: string): void {
    this.turns.delete(turnID);
  }

  cleanup(maxAgeMs: number, now: number): void {
    void maxAgeMs;
    void now;
  }
}

export async function createGuardianHooks(
  options: GuardianOptions,
  deps: GuardianRuntimeDeps,
): Promise<Hooks> {
  let mode = await deps.readMode();
  guardianLog(
    "[PLUGIN-LOAD] mode=",
    mode,
    "cwd=",
    PROCESS_CWD,
    "guardian_model=",
    options.guardianModel ? `${options.guardianModel.providerID}/${options.guardianModel.modelID}` : "(default)",
    "timeoutMs=",
    options.timeoutMs ?? 90_000,
    "max_consecutive_denials=",
    options.maxConsecutiveDenials ?? DEFAULT_MAX_CONSECUTIVE_DENIALS,
    "max_recent_denials=",
    options.maxRecentDenials ?? DEFAULT_MAX_RECENT_DENIALS,
  );

  const transcriptCacheLimit = options.transcriptCacheLimit ?? DEFAULT_TRANSCRIPT_CACHE_LIMIT;
  const maxConsecutiveDenials = options.maxConsecutiveDenials ?? DEFAULT_MAX_CONSECUTIVE_DENIALS;
  const maxRecentDenials = options.maxRecentDenials ?? DEFAULT_MAX_RECENT_DENIALS;
  const recentDenialWindow = options.recentDenialWindow ?? DEFAULT_RECENT_DENIAL_WINDOW;
  const fallbackOnCircuitBreak =
    options.fallbackOnCircuitBreak ?? DEFAULT_FALLBACK_ON_CIRCUIT_BREAK;

  const circuitBreaker = new CircuitBreaker();
  const activeGuardianCommandSessions = new Set<string>();

  function recordSessionIdle(sessionID: string) {
    circuitBreaker.clearTurn(sessionID);
  }

  return {
    "permission.ask": async (input, output) => {
      // Always block bash invocations of `guardian` — it isn't a real binary.
      const patterns = normalizePatterns(input);
      const isYoloLike = isGuardianCommandPattern(patterns);
      const isActiveCommand = activeGuardianCommandSessions.has(input.sessionID);
      if (isActiveCommand && input.type !== "question") {
        output.status = "deny";
        guardianLog(
          "[DENY-LOCAL] session=",
          input.sessionID,
          "type=",
          input.type,
          "reason=tool-blocked-during-/guardian-command",
          "patterns=",
          JSON.stringify(patterns),
        );
        return;
      }
      if (isYoloLike && input.type === "bash") {
        output.status = "deny";
        guardianLog(
          "[DENY-LOCAL] session=",
          input.sessionID,
          "type=bash",
          "reason=bash-invokes-guardian-binary",
          "patterns=",
          JSON.stringify(patterns),
        );
        return;
      }

      if (input.type === "question") return;

      // Bypass when guardian mode is `user` — log explicitly so we can tell
      // from the log whether guardian was even consulted for this request.
      if (mode === "user") {
        guardianLog(
          "[ASK-USER] session=",
          input.sessionID,
          "type=",
          input.type,
          "reason=mode-is-user (guardian bypassed)",
          "patterns=",
          JSON.stringify(patterns),
        );
        return;
      }

      const action = actionFromPermission(input);
      // key the circuit breaker by session — a "turn" in OpenCode is the
      // whole user-prompt + agent-response cycle, so consecutive denials
      // across tool calls in the same response should trip together.
      const turnID = action.sessionID;

      // If this session is already in tripped state, hand control back to
      // the user without spending a guardian review.
      if (circuitBreaker.isTripped(turnID)) {
        guardianLog(
          "[ASK-USER] session=",
          turnID,
          "type=",
          input.type,
          "reason=circuit-breaker-tripped (guardian bypassed)",
          "patterns=",
          JSON.stringify(patterns),
        );
        return;
      }

      const transcript = await deps.loadTranscript(input.sessionID, transcriptCacheLimit);
      guardianLog(
        "[REVIEW] session=",
        turnID,
        "type=",
        action.permission,
        "patterns=",
        JSON.stringify(patterns),
        "transcript_entries=",
        transcript.length,
      );

      try {
        const result = await deps.runReview(action, transcript);
        const decision = (
          result as GuardianAction & { __decision: import("./prompt").GuardianAssessment }
        ).__decision;

        if (decision.outcome === "allow") {
          circuitBreaker.recordAllow(turnID);
          output.status = "allow";
          guardianLog(
            "[ALLOW] session=",
            turnID,
            "type=",
            action.permission,
            "risk=",
            decision.risk_level,
            "auth=",
            decision.user_authorization,
            "rationale=",
            decision.rationale.slice(0, 200),
          );
        } else {
          const breaker = circuitBreaker.recordDeny(turnID, {
            maxConsecutive: maxConsecutiveDenials,
            maxRecent: maxRecentDenials,
            window: recentDenialWindow,
          });
          if (breaker.tripped && fallbackOnCircuitBreak) {
            guardianLog(
              "[ASK-USER] session=",
              turnID,
              "type=",
              action.permission,
              "risk=",
              decision.risk_level,
              "auth=",
              decision.user_authorization,
              "reason=circuit-breaker-tripped",
              "consecutive_denials=",
              breaker.consecutiveDenials,
              "recent_denials=",
              breaker.recentDenials,
              "rationale=",
              decision.rationale.slice(0, 200),
            );
            // leave output.status as-is (i.e. "ask") so the user decides
            return;
          }
          output.status = "deny";
          guardianLog(
            "[DENY] session=",
            turnID,
            "type=",
            action.permission,
            "risk=",
            decision.risk_level,
            "auth=",
            decision.user_authorization,
            "consecutive_denials=",
            breaker.consecutiveDenials,
            "recent_denials=",
            breaker.recentDenials,
            "rationale=",
            decision.rationale.slice(0, 200),
          );
        }
      } catch (err) {
        if (err instanceof GuardianReviewError) {
          guardianLog(
            "[ASK-USER] session=",
            turnID,
            "type=",
            action.permission,
            "reason=guardian-review-failed",
            "error_kind=",
            err.kind,
            "error=",
            err.message,
          );
        } else {
          guardianLog(
            "[ASK-USER] session=",
            turnID,
            "type=",
            action.permission,
            "reason=guardian-review-threw",
            "error=",
            String(err),
          );
        }
        // fail-open to user: don't override output.status, let the user decide
      }
    },

    event: async ({ event }) => {
      const e = event as { type?: string; properties?: any };
      if (!e || typeof e.type !== "string") return;
      if (e.type === "session.idle") {
        const sid = e.properties?.sessionID;
        if (typeof sid === "string") {
          const wasActive = activeGuardianCommandSessions.delete(sid);
          guardianLog(
            "[SESSION-IDLE] session=",
            sid,
            "circuit_breaker_cleared=true",
            "active_command_cleared=",
            wasActive,
          );
          recordSessionIdle(sid);
        }
      }
    },

    "command.execute.before": async (input, output) => {
      if (input.command !== GUARDIAN_COMMAND_NAME) return;
      activeGuardianCommandSessions.add(input.sessionID);

      try {
        const args = input.arguments.trim().toLowerCase();
        let text: string;
        if (args === "start" || args === "kickoff") {
          text =
            mode === "auto_review"
              ? "Guardian mode is auto_review. Approval requests will be LLM-reviewed automatically."
              : "Guardian mode is user. Switch with /guardian on to enable auto-review.";
        } else {
          const commandText = args ? `/guardian ${args}` : "/guardian";
          const result = await maybeHandleGuardianCommand(commandText, {
            readMode: deps.readMode,
            writeMode: deps.writeMode,
          });
          if (result.handled && result.mode) {
            mode = result.mode;
            guardianLog(
              "[MODE-CHANGE] session=",
              input.sessionID,
              "via=command",
              "new_mode=",
              result.mode,
              "args=",
              JSON.stringify(input.arguments),
            );
          }
          text =
            result.handled && result.mode
              ? statusLineFor(result.mode)
              : `Unknown /guardian argument: ${args || "(none)"}`;
        }
        // Mutate the existing parts array in place rather than reassigning
        // output.parts — OpenCode's command.execute.before consumer reads
        // `parts` from its closure scope, so a reassignment would not be
        // visible to it.
        output.parts.length = 0;
        output.parts.push({ type: "text", text });
        guardianLog(
          "[CMD] session=",
          input.sessionID,
          "command=/guardian",
          "args=",
          JSON.stringify(input.arguments),
          "response=",
          text.slice(0, 120),
        );
      } finally {
        // /guardian is a synchronous text-only command — the entire body
        // lives in this hook. Clear the active flag so subsequent tool
        // calls in this session are not silently denied or replaced with
        // a no-op. Without this, the session stays "active" forever and
        // every bash call gets [DENY-LOCAL] / [NOOP-BASH] for the rest
        // of the session's life.
        activeGuardianCommandSessions.delete(input.sessionID);
      }
    },

    "chat.message": async (_input, output) => {
      if (output.message?.role !== "user") return;
      const text = (output.parts ?? [])
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => (p.text ?? "").trim())
        .filter(Boolean)
        .join("\n");
      if (!text) return;
      const result = await maybeHandleGuardianCommand(text, {
        readMode: deps.readMode,
        writeMode: deps.writeMode,
      });
      if (result.handled && result.mode) {
        mode = result.mode;
        guardianLog(
          "[MODE-CHANGE] session=",
          output.message?.sessionID ?? "(unknown)",
          "via=chat",
          "new_mode=",
          result.mode,
          "trigger=",
          JSON.stringify(text.slice(0, 80)),
        );
      }
    },

    "tool.execute.before": async (input, output) => {
      if (!activeGuardianCommandSessions.has(input.sessionID)) return;
      if (input.tool !== "bash") return;
      guardianLog(
        "[NOOP-BASH] session=",
        input.sessionID,
        "reason=/guardian-command-active",
        "original_args=",
        JSON.stringify(output.args ?? {}).slice(0, 200),
      );
      output.args = {
        ...(output.args ?? {}),
        command: ":",
        description: "No-op during guardian command",
      };
    },
  };
}

export const __test_internals = {
  CircuitBreaker,
  actionFromPermission,
  normalizePatterns,
  isGuardianCommandPattern,
  denialMessage,
};
