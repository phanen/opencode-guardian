import type { Hooks } from "@opencode-ai/plugin";
import type { Part, TextPart } from "@opencode-ai/sdk";
import { maybeHandleGuardianCommand, statusLineFor } from "./commands";
import type { GuardianAction, GuardianAssessment, GuardianTranscriptEntry } from "./prompt";
import { GuardianReviewError, type GuardianQuestionDecision } from "./review";
import type { GuardianMode } from "./state";
import type { ModelRef, PermissionAskedRequest, QuestionAskedRequest, RawEvent } from "./types";
// `debugLog` is the runtime target of the $log! macro below; it is
// referenced by the expanded output and must stay imported.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { debugLog } from "./utils";
import { $log } from "./debugLog.macro";

// Re-export for plugin consumers.
export type { PermissionAskedRequest, QuestionAskedRequest } from "./types";

const PROCESS_CWD = process.cwd();

export interface GuardianOptions {
  mode?: GuardianMode;
  guardianModel?: ModelRef;
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
  replyPermission: (sessionID: string, requestID: string, reply: GuardianReply, message?: string) => Promise<void>;
  /**
   * Submit answers to a pending question request. Swallow 404s like
   * `replyPermission` does. The plugin implementation should route through
   * the in-process SDK client, not Node fetch.
   */
  replyQuestion: (sessionID: string, requestID: string, answers: string[][]) => Promise<void>;
  /**
   * Reject a pending question request — dismisses the dialog and signals
   * the tool that the user declined to answer. Swallow 404s.
   */
  rejectQuestion: (sessionID: string, requestID: string) => Promise<void>;
  /**
   * Run an LLM review of a question. Returns either an `answer` decision
   * (one answer-array per question) or `reject` to dismiss the request.
   * On failure (timeout, parse error, transport), throw a `GuardianReviewError`
   * so the caller can fall back to the user.
   */
  runQuestionReview: (
    request: QuestionAskedRequest,
    transcript: GuardianTranscriptEntry[],
    signal?: AbortSignal,
  ) => Promise<GuardianQuestionDecision>;
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

interface CircuitBreakerOptions {
  maxConsecutive: number;
  maxRecent: number;
  window: number;
}

interface CircuitBreakerResult {
  tripped: boolean;
  consecutiveDenials: number;
  recentDenials: number;
}

class CircuitBreaker {
  private turns = new Map<string, CircuitBreakerTurn>();

  isTripped(turnID: string): boolean {
    return this.turns.get(turnID)?.interrupted === true;
  }

  recordDeny(turnID: string, opts: CircuitBreakerOptions): CircuitBreakerResult {
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
      !turn.interrupted && (turn.consecutiveDenials >= opts.maxConsecutive || recentCount >= opts.maxRecent);
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

export async function createGuardianHooks(options: GuardianOptions, deps: GuardianRuntimeDeps): Promise<Hooks> {
  let mode = await deps.readMode();
  const guardianModel = options.guardianModel
    ? `${options.guardianModel.providerID}/${options.guardianModel.modelID}`
    : "(default)";
  const timeoutMs = options.timeoutMs ?? 90_000;
  const maxConsecutiveDenials = options.maxConsecutiveDenials ?? DEFAULT_MAX_CONSECUTIVE_DENIALS;
  const maxRecentDenials = options.maxRecentDenials ?? DEFAULT_MAX_RECENT_DENIALS;
  $log!("PLUGIN-LOAD", mode, PROCESS_CWD, guardianModel, timeoutMs, maxConsecutiveDenials, maxRecentDenials);

  const transcriptCacheLimit = options.transcriptCacheLimit ?? DEFAULT_TRANSCRIPT_CACHE_LIMIT;
  const recentDenialWindow = options.recentDenialWindow ?? DEFAULT_RECENT_DENIAL_WINDOW;
  const fallbackOnCircuitBreak = options.fallbackOnCircuitBreak ?? DEFAULT_FALLBACK_ON_CIRCUIT_BREAK;

  const circuitBreaker = new CircuitBreaker();
  const activeGuardianCommandSessions = new Set<string>();

  async function handlePermissionAsked(req: PermissionAskedRequest): Promise<void> {
    if (req.permission === "question") return;

    const patterns = normalizePatterns(req.patterns);

    const t0 = Date.now();
    const t = new Date(t0).toISOString();
    $log!("PERMISSION-EVENT-RECEIVED", t, req.id, req.sessionID, req.permission, patterns);

    // Block bash invocations of `guardian` regardless of mode.
    if (isGuardianCommandPattern(patterns) && req.permission === "bash") {
      $log!("DENY-LOCAL", req.id, req.sessionID, "bash", "bash-invokes-guardian-binary", patterns);
      try {
        await deps.replyPermission(req.sessionID, req.id, "reject", "bash invocation of guardian is not allowed");
      } catch (err) {
        const error = String(err);
        $log!("DENY-LOCAL", req.id, error);
      }
      return;
    }

    // Block any tool call during an in-flight /guardian command for this session.
    if (activeGuardianCommandSessions.has(req.sessionID)) {
      $log!("DENY-LOCAL", req.id, req.sessionID, req.permission, "tool-blocked-during-/guardian-command", patterns);
      try {
        await deps.replyPermission(
          req.sessionID,
          req.id,
          "reject",
          "tool blocked while /guardian command is in flight",
        );
      } catch (err) {
        const error = String(err);
        $log!("DENY-LOCAL", req.id, error);
      }
      return;
    }

    // In `user` mode, do not intercept — let opencode show the dialog.
    if (mode === "user") {
      $log!("ASK-USER", req.id, req.sessionID, req.permission, "mode-is-user (guardian bypassed)", patterns);
      return;
    }

    // In `dangerously_skip` mode, immediately reply "once" without LLM.
    // Bypasses risk assessment for commands the user has marked as
    // unconditionally safe (or as an escape hatch when the LLM review
    // path is broken). Keeps the same [SKIP-SYNC] log lines for parity
    // with the LLM-driven branch.
    if (mode === "dangerously_skip") {
      const patternsJson = JSON.stringify(patterns);
      const elapsedMs = Date.now() - t0;
      $log!("SKIP-SYNC", req.id, req.sessionID, req.permission, patternsJson, elapsedMs);
      try {
        await deps.replyPermission(req.sessionID, req.id, "once");
        $log!("SKIP-SYNC", req.id, elapsedMs);
      } catch (err) {
        const error = String(err);
        $log!("SKIP-SYNC", req.id, error);
      }
      return;
    }

    // Circuit breaker tripped for this session — hand control to the user.
    if (circuitBreaker.isTripped(req.sessionID)) {
      const patternsJson = JSON.stringify(patterns);
      $log!(
        "ASK-USER",
        req.id,
        req.sessionID,
        req.permission,
        "circuit-breaker-tripped (guardian bypassed)",
        patternsJson,
      );
      return;
    }

    const transcript = await deps.loadTranscript(req.sessionID, transcriptCacheLimit);
    const action = actionFromPermission(req);
    const patternsJson = JSON.stringify(patterns);
    const transcriptEntries = transcript.length;
    $log!("REVIEW", req.id, req.sessionID, action.permission, patternsJson, transcriptEntries);

    let assessment: GuardianAssessment;
    try {
      assessment = await deps.runReview(action, transcript);
    } catch (err) {
      // Fail-open: do not reply, leave the dialog to the user.
      const errorKind = err instanceof GuardianReviewError ? err.kind : "unknown";
      const error = err instanceof Error ? err.message : String(err);
      $log!("ASK-USER", req.id, req.sessionID, action.permission, "guardian-review-failed", errorKind, error);
      return;
    }

    if (assessment.outcome === "allow") {
      circuitBreaker.recordAllow(req.sessionID);
      const elapsedMs = Date.now() - t0;
      const rationale = assessment.rationale.slice(0, 200);
      $log!(
        "ALLOW",
        req.id,
        req.sessionID,
        action.permission,
        assessment.risk_level,
        assessment.user_authorization,
        elapsedMs,
        rationale,
      );
      try {
        await deps.replyPermission(req.sessionID, req.id, "once");
      } catch (err) {
        const error = String(err);
        $log!("ALLOW", "reply failed:", req.id, error);
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
      const rationale = assessment.rationale.slice(0, 200);
      $log!(
        "ASK-USER",
        req.id,
        req.sessionID,
        action.permission,
        assessment.risk_level,
        assessment.user_authorization,
        "circuit-breaker-tripped",
        breaker.consecutiveDenials,
        breaker.recentDenials,
        rationale,
      );
      // Do not reply — opencode's TUI dialog remains for the user to decide.
      return;
    }

    const denialMessage = `${assessment.rationale.trim()}\n${GUARDIAN_DENIAL_INSTRUCTIONS}`;
    const elapsedMs = Date.now() - t0;
    const rationale = assessment.rationale.slice(0, 200);
    $log!(
      "DENY",
      req.id,
      req.sessionID,
      action.permission,
      assessment.risk_level,
      assessment.user_authorization,
      elapsedMs,
      breaker.consecutiveDenials,
      breaker.recentDenials,
      rationale,
    );
    try {
      await deps.replyPermission(req.sessionID, req.id, "reject", denialMessage);
    } catch (err) {
      const error = String(err);
      $log!("DENY", "reply failed:", req.id, error);
    }
  }

  async function handleQuestionAsked(req: QuestionAskedRequest): Promise<void> {
    const t0 = Date.now();
    const t = new Date(t0).toISOString();
    $log!(
      "QUESTION-EVENT-RECEIVED",
      t,
      req.id,
      req.sessionID,
      req.questions.length,
      req.questions.map((q) => q.options.length),
    );

    // In `user` mode, do not intercept — let opencode show the question dialog.
    if (mode === "user") {
      $log!("ASK-USER", req.id, req.sessionID, "question", "mode-bypass", mode);
      return;
    }

    // In `dangerously_skip` mode, pick the first option of each question.
    // Mirrors the permission flow's escape-hatch semantics.
    if (mode === "dangerously_skip") {
      const answers = req.questions.map((q) => {
        const first = q.options[0]?.label;
        if (!first) return [] as string[];
        return [first];
      });
      const elapsedMs = Date.now() - t0;
      $log!("SKIP-SYNC", req.id, req.sessionID, "question", answers.length, elapsedMs);
      try {
        await deps.replyQuestion(req.sessionID, req.id, answers);
        $log!("SKIP-SYNC", req.id, elapsedMs);
      } catch (err) {
        const error = String(err);
        $log!("SKIP-SYNC", req.id, error);
      }
      return;
    }

    let decision: GuardianQuestionDecision;
    try {
      const transcript = await deps.loadTranscript(req.sessionID, transcriptCacheLimit);
      decision = await deps.runQuestionReview(req, transcript);
    } catch (err) {
      const errorKind = err instanceof GuardianReviewError ? err.kind : "unknown";
      const error = err instanceof Error ? err.message : String(err);
      $log!("ASK-USER", req.id, req.sessionID, "question", "guardian-question-review-failed", errorKind, error);
      return;
    }

    if (decision.action === "reject") {
      const elapsedMs = Date.now() - t0;
      $log!("REJECT", req.id, req.sessionID, "question", elapsedMs);
      try {
        await deps.rejectQuestion(req.sessionID, req.id);
      } catch (err) {
        const error = String(err);
        $log!("REJECT", "reply failed:", req.id, error);
      }
      return;
    }

    const elapsedMs = Date.now() - t0;
    $log!(
      "ANSWER",
      req.id,
      req.sessionID,
      "question",
      decision.answers.length,
      decision.answers.flat().length,
      elapsedMs,
    );
    try {
      await deps.replyQuestion(req.sessionID, req.id, decision.answers);
    } catch (err) {
      const error = String(err);
      $log!("ANSWER", "reply failed:", req.id, error);
    }
  }

  return {
    event: async ({ event }) => {
      const e = event as RawEvent;
      if (!e || typeof e.type !== "string") return;

      if (e.type === "permission.asked") {
        const req = e.properties as PermissionAskedRequest | undefined;
        if (!req) return;
        await handlePermissionAsked(req);
        return;
      }

      if (e.type === "question.asked") {
        const req = e.properties as QuestionAskedRequest | undefined;
        if (!req) return;
        await handleQuestionAsked(req);
        return;
      }

      if (e.type === "session.idle") {
        const sid = e.properties?.sessionID;
        if (typeof sid === "string") {
          const wasActive = activeGuardianCommandSessions.delete(sid);
          circuitBreaker.clearTurn(sid);
          $log!("SESSION-IDLE", sid, true, wasActive);
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
            const argsJson = JSON.stringify(input.arguments);
            $log!("MODE-CHANGE", input.sessionID, "via=command", result.mode, argsJson);
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
        // Synthetic TextPart for the command response — id/sessionID/messageID
        // are not meaningful for the LLM-facing command echo, so we cast.
        output.parts.push({ type: "text", text } as Part);
        const argsJson = JSON.stringify(input.arguments);
        const responseText = text.slice(0, 120);
        $log!("CMD", input.sessionID, "/guardian", argsJson, responseText);
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
        .filter((p): p is TextPart => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text.trim())
        .filter(Boolean)
        .join("\n");
      if (!text) return;
      const result = await maybeHandleGuardianCommand(text, {
        readMode: deps.readMode,
        writeMode: deps.writeMode,
      });
      if (result.handled && result.mode) {
        mode = result.mode;
        const triggerJson = JSON.stringify(text.slice(0, 80));
        $log!("[MODE-CHANGE]", output.message?.sessionID ?? "(unknown)", "via=chat", result.mode, triggerJson);
      }
    },

    "tool.execute.before": async (input, output) => {
      if (!activeGuardianCommandSessions.has(input.sessionID)) return;
      if (input.tool !== "bash") return;
      const originalArgs = JSON.stringify(output.args ?? {}).slice(0, 200);
      $log!("[NOOP-BASH]", input.sessionID, "/guardian-command-active", originalArgs);
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
