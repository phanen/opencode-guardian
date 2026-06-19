import {
  buildGuardianPromptParts,
  buildGuardianUserContent,
  buildQuestionPromptParts,
  buildQuestionUserContent,
  type GuardianAction,
  type GuardianAssessment,
  type GuardianTranscriptEntry,
  parseGuardianAssessment,
  parseQuestionDecision,
} from "./prompt";
import type { ContentPart, MessageInfo, ModelRef, QuestionAskedRequest, SessionId } from "./types";
import { textFromParts } from "./utils";

interface PromptTextPart {
  type: "text";
  text: string;
}

type AssistantPart = ContentPart;
type AssistantInfo = MessageInfo;

export interface GuardianReviewOptions {
  guardianModel?: ModelRef;
  timeoutMs: number;
  maxAttempts: number;
  baseBackoffMs: number;
}

export interface GuardianReviewerDeps {
  createSession: () => Promise<SessionId>;
  prompt: (sessionID: string, body: PromptBody) => Promise<AssistantMessageWithParts>;
  abortSession?: (sessionID: string) => Promise<void>;
}

export interface PromptBody {
  system?: string;
  parts: PromptTextPart[];
  model?: ModelRef;
  noReply?: boolean;
}

export interface AssistantMessageWithParts {
  info: AssistantInfo;
  parts: AssistantPart[];
}

export type GuardianDecision = GuardianAssessment;

export type GuardianReviewErrorKind =
  | "session_create_failed"
  | "prompt_failed"
  | "no_response"
  | "parse_failed"
  | "timeout"
  | "cancelled";

export class GuardianReviewError extends Error {
  kind: GuardianReviewErrorKind;
  constructor(kind: GuardianReviewErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = "GuardianReviewError";
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function backoff(attempt: number, base: number): number {
  return base * 2 ** Math.max(0, attempt - 1);
}

function isRetryableErrorKind(kind: GuardianReviewErrorKind): boolean {
  return kind === "prompt_failed" || kind === "parse_failed" || kind === "no_response";
}

export async function runGuardianReview(
  action: GuardianAction,
  transcript: GuardianTranscriptEntry[],
  options: GuardianReviewOptions,
  deps: GuardianReviewerDeps,
  signal?: AbortSignal,
): Promise<GuardianDecision> {
  const userContent = buildGuardianUserContent(action, transcript);
  const parts = buildGuardianPromptParts(action, transcript);
  const systemPrompt = parts.system;
  const deadline = Date.now() + options.timeoutMs;

  let sessionID: string | undefined;
  let lastError: GuardianReviewError | undefined;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new GuardianReviewError("cancelled", "guardian review cancelled");
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new GuardianReviewError(
        "timeout",
        lastError
          ? `guardian review timed out after retries: ${lastError.message}`
          : `guardian review timed out after ${options.timeoutMs}ms`,
      );
    }

    try {
      if (!sessionID) {
        try {
          const created = await deps.createSession();
          sessionID = created.id;
        } catch (err) {
          throw new GuardianReviewError(
            "session_create_failed",
            `failed to create guardian session: ${(err as Error).message}`,
          );
        }
      }

      const timeoutPromise = new Promise<never>((_, reject) => {
        const t = setTimeout(() => {
          reject(
            new GuardianReviewError("timeout", `guardian review exceeded ${remaining}ms budget on attempt ${attempt}`),
          );
        }, remaining);
        if (signal) {
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new GuardianReviewError("cancelled", "guardian review cancelled by signal"));
          });
        }
      });

      const result = await Promise.race([
        deps.prompt(sessionID, {
          system: systemPrompt,
          parts: [{ type: "text", text: userContent }],
          model: options.guardianModel,
          noReply: false,
        }),
        timeoutPromise,
      ]);

      const text = textFromParts(result.parts);
      if (!text) {
        throw new GuardianReviewError("no_response", "guardian returned no text parts");
      }

      const assessment = parseGuardianAssessment(text);
      return assessment;
    } catch (err) {
      if (err instanceof GuardianReviewError) {
        lastError = err;
        if (err.kind === "timeout" || err.kind === "cancelled" || err.kind === "session_create_failed") {
          throw err;
        }
        if (!isRetryableErrorKind(err.kind) || attempt === options.maxAttempts) {
          throw err;
        }
      } else {
        lastError = new GuardianReviewError("prompt_failed", `guardian prompt failed: ${(err as Error).message}`);
        if (attempt === options.maxAttempts) {
          throw lastError;
        }
      }

      const wait = backoff(attempt, options.baseBackoffMs);
      const sleepUntilDeadline = Math.min(wait, deadline - Date.now());
      if (sleepUntilDeadline > 0) {
        await sleep(sleepUntilDeadline);
      }
    }
  }

  throw lastError ?? new GuardianReviewError("prompt_failed", "guardian review failed without explicit error");
}

export type GuardianQuestionDecision = { action: "answer"; answers: string[][] } | { action: "reject" };

export async function runGuardianQuestionReview(
  request: QuestionAskedRequest,
  transcript: GuardianTranscriptEntry[],
  options: GuardianReviewOptions,
  deps: GuardianReviewerDeps,
  signal?: AbortSignal,
): Promise<GuardianQuestionDecision> {
  const userContent = buildQuestionUserContent(request, transcript);
  const parts = buildQuestionPromptParts(request, transcript);
  const systemPrompt = parts.system;
  const deadline = Date.now() + options.timeoutMs;

  let sessionID: string | undefined;
  let lastError: GuardianReviewError | undefined;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new GuardianReviewError("cancelled", "guardian question review cancelled");
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new GuardianReviewError(
        "timeout",
        lastError
          ? `guardian question review timed out after retries: ${lastError.message}`
          : `guardian question review timed out after ${options.timeoutMs}ms`,
      );
    }

    try {
      if (!sessionID) {
        try {
          const created = await deps.createSession();
          sessionID = created.id;
        } catch (err) {
          throw new GuardianReviewError(
            "session_create_failed",
            `failed to create guardian session: ${(err as Error).message}`,
          );
        }
      }

      const timeoutPromise = new Promise<never>((_, reject) => {
        const t = setTimeout(() => {
          reject(
            new GuardianReviewError(
              "timeout",
              `guardian question review exceeded ${remaining}ms budget on attempt ${attempt}`,
            ),
          );
        }, remaining);
        if (signal) {
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new GuardianReviewError("cancelled", "guardian question review cancelled by signal"));
          });
        }
      });

      const result = await Promise.race([
        deps.prompt(sessionID, {
          system: systemPrompt,
          parts: [{ type: "text", text: userContent }],
          model: options.guardianModel,
          noReply: false,
        }),
        timeoutPromise,
      ]);

      const text = textFromParts(result.parts);
      if (!text) {
        throw new GuardianReviewError("no_response", "guardian question review returned no text parts");
      }

      return parseQuestionDecision(text, request);
    } catch (err) {
      if (err instanceof GuardianReviewError) {
        lastError = err;
        if (err.kind === "timeout" || err.kind === "cancelled" || err.kind === "session_create_failed") {
          throw err;
        }
        if (!isRetryableErrorKind(err.kind) || attempt === options.maxAttempts) {
          throw err;
        }
      } else {
        lastError = new GuardianReviewError(
          "prompt_failed",
          `guardian question prompt failed: ${(err as Error).message}`,
        );
        if (attempt === options.maxAttempts) {
          throw lastError;
        }
      }

      const wait = backoff(attempt, options.baseBackoffMs);
      const sleepUntilDeadline = Math.min(wait, deadline - Date.now());
      if (sleepUntilDeadline > 0) {
        await sleep(sleepUntilDeadline);
      }
    }
  }

  throw lastError ?? new GuardianReviewError("prompt_failed", "guardian question review failed without explicit error");
}
