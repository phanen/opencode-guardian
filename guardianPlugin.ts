import path from "node:path";
import {
  createGuardianHooks,
  type GuardianOptions,
  type GuardianReply,
  type GuardianRuntimeDeps,
} from "./guardianCore";
import type { GuardianAction, GuardianAssessment, GuardianTranscriptEntry } from "./prompt";
import { runGuardianReview } from "./review";
import { type GuardianMode, readMode, writeMode } from "./state";

interface PluginCtx {
  client: {
    session: {
      create: (opts: any) => Promise<{ data?: { id: string } }>;
      prompt: (opts: any) => Promise<{ data?: { info: any; parts: any[] } }>;
      messages: (opts: any) => Promise<{ data?: Array<{ info: any; parts: any[] }> }>;
      abort?: (opts: any) => Promise<unknown>;
    };
  };
  directory: string;
  worktree: string;
  serverUrl?: string | URL;
}

export type GuardianPluginOptions = GuardianOptions & {
  mode?: GuardianMode;
};

function resolveStatePath(ctx: PluginCtx): string {
  const root = ctx.directory || ctx.worktree;
  return path.join(root, ".guardian.json");
}

function resolveServerUrl(ctx: PluginCtx): string {
  if (!ctx.serverUrl) return "http://localhost:4096";
  if (typeof ctx.serverUrl === "string") return ctx.serverUrl;
  return ctx.serverUrl.toString().replace(/\/+$/, "");
}

function textFromParts(parts: Array<{ type?: string; text?: string }> = []): string {
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => (p.text ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

async function loadTranscript(
  ctx: PluginCtx,
  sessionID: string,
  limit: number,
): Promise<GuardianTranscriptEntry[]> {
  try {
    const result = await ctx.client.session.messages({
      path: { id: sessionID },
    });
    const messages = result?.data ?? [];
    const out: GuardianTranscriptEntry[] = [];
    for (const m of messages) {
      const info = m.info;
      if (!info) continue;
      const text = textFromParts(m.parts);
      if (!text) continue;
      if (info.role === "user") {
        out.push({ role: "user", text });
      } else if (info.role === "assistant") {
        out.push({ role: "assistant", text });
      } else {
        out.push({ role: "tool", text });
      }
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return [];
  }
}

async function replyPermission(
  ctx: PluginCtx,
  requestID: string,
  reply: GuardianReply,
  message?: string,
): Promise<void> {
  const base = resolveServerUrl(ctx);
  const url = `${base}/permission/${encodeURIComponent(requestID)}/reply`;
  const body: { reply: GuardianReply; message?: string } = { reply };
  if (message) body.message = message;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // 404 means the user already responded manually — that's fine, swallow it.
    if (!res.ok && res.status !== 404) {
      throw new Error(`permission.reply failed: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    // Network errors and unexpected status codes are surfaced to the caller
    // so they can be logged by the hook.
    throw err;
  }
}

export default async function GuardianPlugin(
  ctx: PluginCtx,
  options: GuardianPluginOptions = {},
): Promise<ReturnType<typeof createGuardianHooks>> {
  const statePath = resolveStatePath(ctx);

  const reviewOptions: import("./review").GuardianReviewOptions = {
    guardianModel: options.guardianModel,
    timeoutMs: options.timeoutMs ?? 90_000,
    maxAttempts: options.maxAttempts ?? 3,
    baseBackoffMs: options.baseBackoffMs ?? 500,
  };

  const deps: GuardianRuntimeDeps = {
    readMode: () => readMode(options.mode ?? "user", statePath),
    writeMode: (mode) => writeMode(mode, statePath),
    loadTranscript: (sessionID, limit) => loadTranscript(ctx, sessionID, limit),
    runReview: async (action: GuardianAction, transcript: GuardianTranscriptEntry[]) => {
      const assessment = await runGuardianReview(action, transcript, reviewOptions, {
        createSession: async () => {
          const res = await ctx.client.session.create({});
          const id = res?.data?.id;
          if (!id) throw new Error("createSession returned no id");
          return { id };
        },
        prompt: async (sessionID, body) => {
          const res = await ctx.client.session.prompt({
            path: { id: sessionID },
            body: {
              system: body.system,
              parts: body.parts,
              model: body.model,
              noReply: body.noReply,
            },
          });
          const data = res?.data;
          return {
            info: data?.info ?? { id: "", sessionID, role: "assistant" },
            parts: data?.parts ?? [],
          };
        },
        abortSession: async (sessionID) => {
          try {
            await ctx.client.session.abort?.({ path: { id: sessionID } });
          } catch {
            // ignore
          }
        },
      });
      return assessment;
    },
    replyPermission: (requestID, reply, message) => replyPermission(ctx, requestID, reply, message),
  };

  return createGuardianHooks(options, deps);
}