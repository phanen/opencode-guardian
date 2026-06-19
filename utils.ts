// Small helpers shared across the plugin runtime.

import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { ContentPart } from "./types";

export const DEBUG_LOG_PATH = "/tmp/guardian-debug.log";

const PROCESS_PID = process.pid;
// Stable per-process prefix so concurrent opencode sessions are easy to
// distinguish when they all append to the same shared log file.
const INSTANCE_ID = randomBytes(3).toString("hex");

export function debugLog(tag: string, ...args: unknown[]): void {
  try {
    const line =
      `${new Date().toISOString()} [GUARDIAN pid=${PROCESS_PID} inst=${INSTANCE_ID}] [${tag}] ` +
      formatArgs(args) +
      "\n";
    appendFileSync(DEBUG_LOG_PATH, line);
  } catch {
    // never throw from logging
  }
}

// Walk args: a string ending in `=` is a label, paired with the
// following value (rendered as `key=<value>`). Any other string is
// an orphan and prints as-is. Bare values get auto-expanded when
// they are objects.
function formatArgs(args: unknown[]): string {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a === "string" && a.endsWith("=") && i + 1 < args.length) {
      out.push(`${a}${formatScalar(args[i + 1])}`);
      i++;
    } else {
      out.push(formatArg(a));
    }
  }
  return out.join(" ");
}

function formatArg(arg: unknown): string {
  if (arg === null || arg === undefined) return String(arg);
  if (typeof arg === "string") return arg;
  if (typeof arg === "object") {
    return Reflect.ownKeys(arg as object)
      .filter((k) => typeof k === "string")
      .map((k) => [k, Reflect.get(arg as object, k)] as const)
      .map(([k, v]) => `${k}=${formatScalar(v)}`)
      .join(" ");
  }
  return formatScalar(arg);
}

function formatScalar(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function textFromParts(parts: ContentPart[] = []): string {
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => (p.text ?? "").trim())
    .filter(Boolean)
    .join("\n");
}
