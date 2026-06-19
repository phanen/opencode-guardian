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
    postSessionIdPermissionsPermissionId?: (opts: {
      body: { response: "once" | "always" | "reject"; message?: string };
      path: { id: string; permissionID: string };
      query?: { directory?: string };
    }) => Promise<unknown>;
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
  const { appendFileSync } = await import("node:fs");
  const log = (msg: string) => {
    try {
      appendFileSync(
        "/tmp/guardian-debug.log",
        `${new Date().toISOString()} [GUARDIAN-REPLY] ${msg}\n`,
      );
    } catch {}
  };

  log(`request_id=${requestID} session_id=${sessionID} reply=${reply} transport=sdk_client`);

  // MUST use the SDK client, not Node `fetch`. The plugin runs inside the
  // TUI/server process and ctx.client is created with `fetch: app.fetch`
  // (Server.Default().app.fetch) so the POST hits the in-process server
  // that owns the pending map. Plain Node fetch would go to the URL the
  // server is listening on, which (when running standalone TUI) is a
  // different process's server with an empty pending map — returning 404.
  const sdkMethod = ctx.client.postSessionIdPermissionsPermissionId;
  if (!sdkMethod) {
    log(`request_id=${requestID} outcome=missing_sdk_method`);
    throw new Error("opencode SDK does not expose postSessionIdPermissionsPermissionId");
  }

  const body: { response: GuardianReply; message?: string } = { response: reply };
  if (message) body.message = message;

  const t0 = Date.now();
  try {
    const result = await sdkMethod({
      body,
      path: { id: sessionID, permissionID: requestID },
      query: ctx.directory ? { directory: ctx.directory } : undefined,
    });
    const elapsed = Date.now() - t0;
    const status = (result as { response?: Response; status?: number })?.status
      ?? (result as { response?: Response })?.response?.status
      ?? "(unknown)";
    log(`request_id=${requestID} response status=${status} elapsed_ms=${elapsed}`);
    log(`request_id=${requestID} outcome=success status=${status}`);
  } catch (err) {
    const status = (err as { response?: Response; status?: number })?.status
      ?? (err as { response?: Response })?.response?.status
      ?? "(none)";
    const body = await (err as { response?: Response })?.response?.text?.().catch(() => "(unreadable)") ?? "";
    log(`request_id=${requestID} sdk_error status=${status} body=${body.slice(0, 500)} message=${(err as Error).message}`);
    if (status === 404) {
      log(`request_id=${requestID} outcome=404_benign (request already gone from pending)`);
      return;
    }
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