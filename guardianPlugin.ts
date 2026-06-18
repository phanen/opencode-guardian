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
  project?: { workspaceID?: string };
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
  sessionID: string,
  requestID: string,
  reply: GuardianReply,
  message?: string,
): Promise<void> {
  const base = resolveServerUrl(ctx);
  const params = new URLSearchParams();
  if (ctx.directory) params.set("directory", ctx.directory);
  if (ctx.project?.workspaceID) params.set("workspace", ctx.project.workspaceID);
  const qs = params.toString();

  // Use the deprecated session-scoped endpoint that opencode.nvim hits.
  // Same server-side handler (Permission.reply) as the v2
  // /permission/{requestID}/reply endpoint, just a different URL
  // shape with sessionID in the path and `response` in the body.
  const url =
    `${base}/session/${encodeURIComponent(sessionID)}` +
    `/permissions/${encodeURIComponent(requestID)}` +
    `${qs ? `?${qs}` : ""}`;
  const body: { response: GuardianReply; message?: string } = { response: reply };
  if (message) body.message = message;

  // Verbose diagnostic logging — full URL, full body, full response
  // status and body so we can compare against opencode.nvim's behavior.
  const { appendFileSync } = await import("node:fs");
  const log = (msg: string) => {
    try {
      appendFileSync(
        "/tmp/guardian-debug.log",
        `${new Date().toISOString()} [GUARDIAN-REPLY] ${msg}\n`,
      );
    } catch {}
  };

  log(`request_id=${requestID} session_id=${sessionID} reply=${reply}`);
  log(`request_id=${requestID} url=${url}`);
  log(`request_id=${requestID} body=${JSON.stringify(body)}`);

  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const elapsed = Date.now() - t0;
    const text = await res.text();
    log(
      `request_id=${requestID} response status=${res.status} ok=${res.ok} ` +
        `elapsed_ms=${elapsed} content-type=${res.headers.get("content-type") ?? "(none)"} ` +
        `body=${text.slice(0, 500)}`,
    );
    log(
      `request_id=${requestID} response_headers=${JSON.stringify(
        Object.fromEntries(res.headers.entries()),
      )}`,
    );
    if (res.status === 404) {
      // request already resolved by the user, or the parent fiber was
      // interrupted and the Effect.ensuring cleanup cleared it from
      // pending without firing permission.replied. The TUI's local
      // store still has the request, so the dialog stays. Benign from
      // the plugin's perspective — we tried.
      log(`request_id=${requestID} outcome=404_benign (request already gone from pending)`);
      return;
    }
    if (!res.ok) {
      log(`request_id=${requestID} outcome=http_error status=${res.status}`);
      throw new Error(`permission.reply failed: ${res.status} ${text}`);
    }
    log(`request_id=${requestID} outcome=success status=${res.status}`);
  } catch (err) {
    log(`request_id=${requestID} fetch_error=${(err as Error).message}`);
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
    replyPermission: (sessionID, requestID, reply, message) =>
      replyPermission(ctx, sessionID, requestID, reply, message),
  };

  return createGuardianHooks(options, deps);
}