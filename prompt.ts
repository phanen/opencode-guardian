import { TENANT_POLICY } from "./policyConfig";
import { POLICY_TEMPLATE } from "./policyTemplate";
import type { ToolRef } from "./types";

export type GuardianRiskLevel = "low" | "medium" | "high" | "critical";
export type GuardianUserAuthorization = "unknown" | "low" | "medium" | "high";
export type GuardianOutcome = "allow" | "deny";

export interface GuardianAssessment {
  risk_level: GuardianRiskLevel;
  user_authorization: GuardianUserAuthorization;
  outcome: GuardianOutcome;
  rationale: string;
}

export interface GuardianAction {
  id: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  sessionID: string;
  tool?: ToolRef;
}

export interface GuardianTranscriptEntry {
  role: "user" | "assistant" | "tool";
  text: string;
}

const TRUNCATION_TAG = "truncated";
const RECENT_ENTRY_LIMIT = 40;
const TRANSCRIPT_TOKEN_BUDGET = 10_000;
const TRANSCRIPT_ENTRY_TOKEN_BUDGET = 2_000;
const ACTION_STRING_TOKEN_BUDGET = 4_000;

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncate(text: string, maxTokens: number): string {
  if (approxTokens(text) <= maxTokens) return text;
  const maxChars = maxTokens * 4;
  return `${text.slice(0, maxChars)}\n<${TRUNCATION_TAG} />`;
}

function formatMetadata(metadata: Record<string, unknown>): string {
  if (!metadata || Object.keys(metadata).length === 0) return "(none)";
  try {
    return JSON.stringify(metadata, null, 2);
  } catch {
    return String(metadata);
  }
}

function formatActionPretty(action: GuardianAction): string {
  return [
    "```json",
    JSON.stringify(
      {
        id: action.id,
        permission: action.permission,
        patterns: action.patterns,
        always: action.always,
        metadata: action.metadata,
        tool: action.tool ?? null,
        sessionID: action.sessionID,
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

function renderTranscript(entries: GuardianTranscriptEntry[]): string {
  const kept: GuardianTranscriptEntry[] = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const truncated: GuardianTranscriptEntry = {
      ...entry,
      text: truncate(entry.text, TRANSCRIPT_ENTRY_TOKEN_BUDGET),
    };
    const tokens = approxTokens(truncated.text);
    if (used + tokens > TRANSCRIPT_TOKEN_BUDGET) break;
    kept.unshift(truncated);
    used += tokens;
    if (kept.length >= RECENT_ENTRY_LIMIT) break;
  }

  if (kept.length === 0) {
    return ">>> TRANSCRIPT START\n(empty)\n>>> TRANSCRIPT END\n";
  }

  const lines = ["", ">>> TRANSCRIPT START", ""];
  for (const entry of kept) {
    const tag = entry.role === "user" ? "[USER]" : entry.role === "assistant" ? "[ASSISTANT]" : "[TOOL]";
    lines.push(`${tag} ${entry.text}`, "");
  }
  lines.push(">>> TRANSCRIPT END", "");
  return lines.join("\n");
}

export interface GuardianSystemPromptParts {
  system: string;
  transcript: string;
  action: string;
}

export function buildGuardianPromptParts(
  action: GuardianAction,
  transcript: GuardianTranscriptEntry[],
): GuardianSystemPromptParts {
  const system = POLICY_TEMPLATE.replace("{tenant_policy_config}", TENANT_POLICY);
  const transcriptBlock = renderTranscript(transcript);
  const actionText = truncate(formatActionPretty(action), ACTION_STRING_TOKEN_BUDGET);
  const actionBlock = [
    "The OpenCode agent has requested the following approval:",
    "",
    actionText,
    "",
    "The `metadata` field above contains the tool-specific arguments (e.g. shell command, file paths, MCP tool args).",
    `Permission type: \`${action.permission}\`.`,
    `Patterns: \`${JSON.stringify(action.patterns)}\`.`,
    `Always-list (patterns the user can pre-approve as a rule): \`${JSON.stringify(action.always)}\`.`,
    "",
    "Respond with the JSON object described in the Output Format section above. Do not write anything else.",
  ].join("\n");
  return {
    system,
    transcript: transcriptBlock,
    action: actionBlock,
  };
}

export function buildGuardianUserContent(action: GuardianAction, transcript: GuardianTranscriptEntry[]): string {
  const parts = buildGuardianPromptParts(action, transcript);
  return [parts.transcript, ">>> ACTION START", parts.action, ">>> ACTION END", ""].join("\n");
}

const RISK_LEVELS: GuardianRiskLevel[] = ["low", "medium", "high", "critical"];
const AUTH_LEVELS: GuardianUserAuthorization[] = ["unknown", "low", "medium", "high"];
const OUTCOMES: GuardianOutcome[] = ["allow", "deny"];

function isRiskLevel(v: unknown): v is GuardianRiskLevel {
  return typeof v === "string" && (RISK_LEVELS as string[]).includes(v);
}

function isAuthLevel(v: unknown): v is GuardianUserAuthorization {
  return typeof v === "string" && (AUTH_LEVELS as string[]).includes(v);
}

function isOutcome(v: unknown): v is GuardianOutcome {
  return typeof v === "string" && (OUTCOMES as string[]).includes(v);
}

function extractJsonCandidate(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fenced) return fenced[1].trim();

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

export function parseGuardianAssessment(text: string): GuardianAssessment {
  const candidate = extractJsonCandidate(text);
  if (!candidate) {
    throw new Error("guardian response contained no JSON object");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    throw new Error(`guardian response JSON parse failed: ${(err as Error).message}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("guardian response JSON is not an object");
  }

  const obj = parsed as Record<string, unknown>;
  if (!isRiskLevel(obj.risk_level)) {
    throw new Error(`guardian response missing or invalid risk_level: ${String(obj.risk_level)}`);
  }
  if (!isAuthLevel(obj.user_authorization)) {
    throw new Error(`guardian response missing or invalid user_authorization: ${String(obj.user_authorization)}`);
  }
  if (!isOutcome(obj.outcome)) {
    throw new Error(`guardian response missing or invalid outcome: ${String(obj.outcome)}`);
  }
  const rationale = typeof obj.rationale === "string" ? obj.rationale.trim() : "";
  if (!rationale) {
    throw new Error("guardian response missing rationale");
  }

  return {
    risk_level: obj.risk_level,
    user_authorization: obj.user_authorization,
    outcome: obj.outcome,
    rationale,
  };
}

export function formatActionSummary(action: GuardianAction): string {
  const parts: string[] = [];
  parts.push(`${action.permission}(${action.patterns.join(", ") || "?"})`);
  const metaStr = formatMetadata(action.metadata).replace(/\s+/g, " ").trim();
  if (metaStr && metaStr !== "(none)") {
    parts.push(metaStr.slice(0, 200));
  }
  return parts.join(" — ");
}
