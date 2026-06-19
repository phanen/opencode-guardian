import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { maybeHandleGuardianCommand, statusLineFor } from "./commands";
import type { GuardianAction, GuardianAssessment, GuardianTranscriptEntry } from "./prompt";
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

export type GuardianReply = "once" | "always" | "reject";

export interface GuardianRuntimeDeps {
  readMode: () => Promise<GuardianMode>;
  writeMode: (mode: GuardianMode) => Promise<void>;
  loadTranscript: (sessionID: string, limit: number) => Promise<GuardianTranscriptEntry[]>;
  runReview: (
    action: GuardianAction,
    transcript: GuardianTranscriptEntry[],
    signal?: AbortSignal,
  ) => Promise<GuardianAssessment>;
  /**
   * Reply to a pending permission request. The implementation should swallow
   * "not found" errors (the user may have already responded manually before
   * guardian finished) and surface other failures.
   */
  replyPermission: (
    sessionID: string,
    requestID: string,
    reply: GuardianReply,
    message?: string,
  ) => Promise<void>;
}

/**
 * Shape of the `permission.asked` event published by opencode's
 * Permission.ask service. Mirrors `PermissionV1.Request` in the opencode
 * source — kept as a structural type so this plugin does not depend on the
 * internal SDK package.
 */
export interface PermissionAskedRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata?: Record<string, unknown>;
  always?: string[];
  tool?: { messageID: string; callID: string };
}

export interface Hooks {
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

const GUARDIAN_COMMAND_NAME = "guardian";

function normalizePatterns(patterns: string[] | undefined): string[] {
  const raw = patterns ?? [];
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

function actionFromPermission(req: PermissionAskedRequest): GuardianAction {
  const patterns = normalizePatterns(req.patterns);
  return {
    id: req.id,
    permission: req.permission,
    patterns,
    metadata: req.metadata ?? {},
    always: req.always ?? [],
    sessionID: req.sessionID,
    tool: req.tool,
  };
}

function isGuardianCommandPattern(patterns: string[]): boolean {
  return patterns.some((p) => /(^|\s)\/?guardian(\s|$)/.test(p));
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

  async function handlePermissionAsked(req: PermissionAskedRequest): Promise<void> {
    if (req.permission === "question") return;

    const patterns = normalizePatterns(req.patterns);

    const t0 = Date.now();
    guardianLog(
      "[PERMISSION-EVENT-RECEIVED]",
      "t=",
      new Date(t0).toISOString(),
      "request=",
      req.id,
      "session=",
      req.sessionID,
      "type=",
      req.permission,
      "patterns=",
      JSON.stringify(patterns),
    );

    // Block bash invocations of `guardian` regardless of mode.
    if (isGuardianCommandPattern(patterns) && req.permission === "bash") {
      guardianLog(
        "[DENY-LOCAL] request=",
        req.id,
        "session=",
        req.sessionID,
        "type=bash",
        "reason=bash-invokes-guardian-binary",
        "patterns=",
        JSON.stringify(patterns),
      );
      try {
        await deps.replyPermission(req.sessionID, req.id, "reject", "bash invocation of guardian is not allowed");
      } catch (err) {
        guardianLog("[DENY-LOCAL] reply failed:", req.id, String(err));
      }
      return;
    }

    // Block any tool call during an in-flight /guardian command for this session.
    if (activeGuardianCommandSessions.has(req.sessionID)) {
      guardianLog(
        "[DENY-LOCAL] request=",
        req.id,
        "session=",
        req.sessionID,
        "type=",
        req.permission,
        "reason=tool-blocked-during-/guardian-command",
        "patterns=",
        JSON.stringify(patterns),
      );
      try {
        await deps.replyPermission(
          req.sessionID,
          req.id,
          "reject",
          "tool blocked while /guardian command is in flight",
        );
      } catch (err) {
        guardianLog("[DENY-LOCAL] reply failed:", req.id, String(err));
      }
      return;
    }

    // In `user` mode, do not intercept — let opencode show the dialog.
    if (mode === "user") {
      guardianLog(
        "[ASK-USER] request=",
        req.id,
        "session=",
        req.sessionID,
        "type=",
        req.permission,
        "reason=mode-is-user (guardian bypassed)",
        "patterns=",
        JSON.stringify(patterns),
      );
      return;
    }

    // In `dangerously_skip` mode, immediately reply "once" without LLM.
    // Bypasses risk assessment for commands the user has marked as
    // unconditionally safe (or as an escape hatch when the LLM review
    // path is broken). Keeps the same [SKIP-SYNC] log lines for parity
    // with the LLM-driven branch.
    if (mode === "dangerously_skip") {
      guardianLog(
        "[SKIP-SYNC] request=",
        req.id,
        "session=",
        req.sessionID,
        "type=",
        req.permission,
        "patterns=",
        JSON.stringify(patterns),
        "elapsed_ms=",
        Date.now() - t0,
      );
      try {
        await deps.replyPermission(req.sessionID, req.id, "once");
        guardianLog(
          "[SKIP-SYNC] reply sent request=",
          req.id,
          "elapsed_ms=",
          Date.now() - t0,
        );
      } catch (err) {
        guardianLog("[SKIP-SYNC] reply failed:", req.id, String(err));
      }
      return;
    }

    // Circuit breaker tripped for this session — hand control to the user.
    if (circuitBreaker.isTripped(req.sessionID)) {
      guardianLog(
        "[ASK-USER] request=",
        req.id,
        "session=",
        req.sessionID,
        "type=",
        req.permission,
        "reason=circuit-breaker-tripped (guardian bypassed)",
        "patterns=",
        JSON.stringify(patterns),
      );
      return;
    }

    const transcript = await deps.loadTranscript(req.sessionID, transcriptCacheLimit);
    const action = actionFromPermission(req);
    guardianLog(
      "[REVIEW] request=",
      req.id,
      "session=",
      req.sessionID,
      "type=",
      action.permission,
      "patterns=",
      JSON.stringify(patterns),
      "transcript_entries=",
      transcript.length,
    );

    let assessment: GuardianAssessment;
    try {
      assessment = await deps.runReview(action, transcript);
    } catch (err) {
      // Fail-open: do not reply, leave the dialog to the user.
      const kind = err instanceof GuardianReviewError ? err.kind : "unknown";
      const msg = err instanceof Error ? err.message : String(err);
      guardianLog(
        "[ASK-USER] request=",
        req.id,
        "session=",
        req.sessionID,
        "type=",
        action.permission,
        "reason=guardian-review-failed",
        "error_kind=",
        kind,
        "error=",
        msg,
      );
      return;
    }

    if (assessment.outcome === "allow") {
      circuitBreaker.recordAllow(req.sessionID);
      guardianLog(
        "[ALLOW] request=",
        req.id,
        "session=",
        req.sessionID,
        "type=",
        action.permission,
        "risk=",
        assessment.risk_level,
        "auth=",
        assessment.user_authorization,
        "elapsed_ms=",
        Date.now() - t0,
        "rationale=",
        assessment.rationale.slice(0, 200),
      );
      try {
        await deps.replyPermission(req.sessionID, req.id, "once");
      } catch (err) {
        guardianLog("[ALLOW] reply failed:", req.id, String(err));
      }
      return;
    }

    // Deny path
    const breaker = circuitBreaker.recordDeny(req.sessionID, {
      maxConsecutive: maxConsecutiveDenials,
      maxRecent: maxRecentDenials,
      window: recentDenialWindow,
    });

    if (breaker.tripped && fallbackOnCircuitBreak) {
      guardianLog(
        "[ASK-USER] request=",
        req.id,
        "session=",
        req.sessionID,
        "type=",
        action.permission,
        "risk=",
        assessment.risk_level,
        "auth=",
        assessment.user_authorization,
        "reason=circuit-breaker-tripped",
        "consecutive_denials=",
        breaker.consecutiveDenials,
        "recent_denials=",
        breaker.recentDenials,
        "rationale=",
        assessment.rationale.slice(0, 200),
      );
      // Do not reply — opencode's TUI dialog remains for the user to decide.
      return;
    }

    const denialMessage = `${assessment.rationale.trim()}\n${GUARDIAN_DENIAL_INSTRUCTIONS}`;
    guardianLog(
      "[DENY] request=",
      req.id,
      "session=",
      req.sessionID,
      "type=",
      action.permission,
      "risk=",
      assessment.risk_level,
      "auth=",
      assessment.user_authorization,
      "elapsed_ms=",
      Date.now() - t0,
      "consecutive_denials=",
      breaker.consecutiveDenials,
      "recent_denials=",
      breaker.recentDenials,
      "rationale=",
      assessment.rationale.slice(0, 200),
    );
    try {
      await deps.replyPermission(req.sessionID, req.id, "reject", denialMessage);
    } catch (err) {
      guardianLog("[DENY] reply failed:", req.id, String(err));
    }
  }

  return {
    event: async ({ event }) => {
      const e = event as { type?: string; properties?: any };
      if (!e || typeof e.type !== "string") return;

      if (e.type === "permission.asked") {
        const req = e.properties as PermissionAskedRequest | undefined;
        if (!req || typeof req.id !== "string" || typeof req.sessionID !== "string") return;
        await handlePermissionAsked(req);
        return;
      }

      if (e.type === "session.idle") {
        const sid = e.properties?.sessionID;
        if (typeof sid === "string") {
          const wasActive = activeGuardianCommandSessions.delete(sid);
          circuitBreaker.clearTurn(sid);
          guardianLog(
            "[SESSION-IDLE] session=",
            sid,
            "circuit_breaker_cleared=true",
            "active_command_cleared=",
            wasActive,
          );
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
        // calls in this session are not silently denied.
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
};