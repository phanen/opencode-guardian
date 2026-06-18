import { appendFileSync } from "node:fs";
import { maybeHandleGuardianCommand, statusLineFor } from "./commands";
import type { GuardianAction, GuardianTranscriptEntry } from "./prompt";
import { GuardianReviewError } from "./review";
import type { GuardianMode } from "./state";

const YOLO_DEBUG_LOG = "/tmp/guardian-debug.log";

function guardianLog(...args: unknown[]) {
  try {
    const line =
      `${new Date().toISOString()} [GUARDIAN] ` +
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
  guardianLog("plugin loaded, mode:", mode);

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
        guardianLog("permission.ask: deny tool while /guardian command active", input.type);
        return;
      }
      if (isYoloLike && input.type === "bash") {
        output.status = "deny";
        guardianLog("permission.ask: deny bash guardian", patterns.join(","));
        return;
      }

      if (mode === "user") return;
      if (input.type === "question") return;

      const action = actionFromPermission(input);
      // key the circuit breaker by session — a "turn" in OpenCode is the
      // whole user-prompt + agent-response cycle, so consecutive denials
      // across tool calls in the same response should trip together.
      const turnID = action.sessionID;

      // If this session is already in tripped state, hand control back to
      // the user without spending a guardian review.
      if (circuitBreaker.isTripped(turnID)) {
        guardianLog("permission.ask: session already tripped, falling back to user");
        return;
      }

      const transcript = await deps.loadTranscript(input.sessionID, transcriptCacheLimit);
      guardianLog(
        "permission.ask: reviewing",
        action.permission,
        "patterns=",
        JSON.stringify(patterns),
        "turn=",
        turnID,
      );

      try {
        const result = await deps.runReview(action, transcript);
        const decision = (
          result as GuardianAction & { __decision: import("./prompt").GuardianAssessment }
        ).__decision;

        guardianLog(
          "guardian decision:",
          decision.outcome,
          "risk=",
          decision.risk_level,
          "auth=",
          decision.user_authorization,
          "rationale=",
          decision.rationale.slice(0, 120),
        );

        if (decision.outcome === "allow") {
          circuitBreaker.recordAllow(turnID);
          output.status = "allow";
        } else {
          const breaker = circuitBreaker.recordDeny(turnID, {
            maxConsecutive: maxConsecutiveDenials,
            maxRecent: maxRecentDenials,
            window: recentDenialWindow,
          });
          if (breaker.tripped && fallbackOnCircuitBreak) {
            guardianLog(
              "circuit breaker tripped:",
              breaker.consecutiveDenials,
              "consecutive,",
              breaker.recentDenials,
              "recent — falling back to user",
            );
            // leave output.status as-is (i.e. "ask") so the user decides
            return;
          }
          output.status = "deny";
        }
      } catch (err) {
        if (err instanceof GuardianReviewError) {
          guardianLog("guardian review error:", err.kind, err.message, "— falling back to user");
        } else {
          guardianLog("guardian review error (unknown):", String(err), "— falling back to user");
        }
        // fail-open to user: don't override output.status, let the user decide
      }
    },

    event: async ({ event }) => {
      const e = event as { type?: string; properties?: any };
      if (!e || typeof e.type !== "string") return;
      if (e.type === "session.idle") {
        const sid = e.properties?.sessionID;
        if (typeof sid === "string") recordSessionIdle(sid);
      }
    },

    "command.execute.before": async (input, output) => {
      guardianLog(
        "command.execute.before fired:",
        input.command,
        "args=",
        JSON.stringify(input.arguments),
      );
      if (input.command !== GUARDIAN_COMMAND_NAME) {
        guardianLog("command.execute.before: ignoring non-guardian command");
        return;
      }
      activeGuardianCommandSessions.add(input.sessionID);

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
      guardianLog("command.execute.before: wrote parts text:", text.slice(0, 80));
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
        guardianLog("chat.message updated mode to:", mode);
      }
    },

    "tool.execute.before": async (input, output) => {
      if (!activeGuardianCommandSessions.has(input.sessionID)) return;
      if (input.tool !== "bash") return;
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
