import path from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import {
  createGuardianHooks,
  type GuardianOptions,
  type GuardianReply,
  type GuardianRuntimeDeps,
} from "./guardianCore";
import type { GuardianAction, GuardianTranscriptEntry } from "./prompt";
import type { GuardianReviewOptions } from "./review";
import { runGuardianReview } from "./review";
import { type GuardianMode, readMode, writeMode } from "./state";
import type {
  LoggedError,
  PermissionReplyBody,
  RequestResult,
  SessionCreateResponse,
  SessionMessagesResponse,
  SessionPromptResponse,
  SdkClientWithPermissionReply,
} from "./types";
// `debugLog` is the runtime target of the $log! macro below.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { debugLog, textFromParts } from "./utils";
import { $log } from "./debugLog.macro";

type SdkClient = PluginInput["client"];
type ExtendedSdkClient = SdkClient & SdkClientWithPermissionReply;

export type GuardianPluginOptions = GuardianOptions & {
  mode?: GuardianMode;
};

function resolveStatePath(ctx: PluginInput): string {
  const root = ctx.directory || ctx.worktree;
  return path.join(root, ".guardian.json");
}

async function loadTranscript(ctx: PluginInput, sessionID: string, limit: number): Promise<GuardianTranscriptEntry[]> {
  try {
    const result = (await ctx.client.session.messages({
      path: { id: sessionID },
    })) as SessionMessagesResponse;
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

function extractStatus(target: unknown): number | string {
  const t = target as RequestResult;
  return t?.status ?? t?.response?.status ?? "(unknown)";
}

async function replyPermission(
  ctx: PluginInput,
  sessionID: string,
  requestID: string,
  reply: GuardianReply,
  message?: string,
): Promise<void> {
  $log!("REPLY", requestID, sessionID, reply, "transport=sdk_client");

  // MUST use the SDK client, not Node `fetch`. The plugin runs inside the
  // TUI/server process and ctx.client is created with `fetch: app.fetch`
  // (Server.Default().app.fetch) so the POST hits the in-process server
  // that owns the pending map. Plain Node fetch would go to the URL the
  // server is listening on, which (when running standalone TUI) is a
  // different process's server with an empty pending map — returning 404.
  //
  // Must invoke through ctx.client.<method>(...) — NOT a hoisted reference
  // like `const m = ctx.client.post...; m(...)` — because the SDK method
  // reads `this._client` internally and the binding is lost on extraction.
  const sdkClient = ctx.client as ExtendedSdkClient;
  if (!sdkClient.postSessionIdPermissionsPermissionId) {
    $log!("REPLY", requestID, "missing_sdk_method");
    throw new Error("opencode SDK does not expose postSessionIdPermissionsPermissionId");
  }

  const body: PermissionReplyBody = { response: reply };
  if (message) body.message = message;

  const t0 = Date.now();
  try {
    // Must call through the client object so the SDK method's `this`
    // binding is preserved; hoisting it to a local breaks the call.
    const result = await sdkClient.postSessionIdPermissionsPermissionId({
      body,
      path: { id: sessionID, permissionID: requestID },
      query: ctx.directory ? { directory: ctx.directory } : undefined,
    });
    const elapsed = Date.now() - t0;
    const status = extractStatus(result);
    $log!("REPLY", requestID, status, elapsed);
    $log!("REPLY", requestID, "success", status);
  } catch (err) {
    const loggedErr = err as LoggedError;
    const status = extractStatus(loggedErr);
    const responseBody = loggedErr.response ? await loggedErr.response.text().catch(() => "(unreadable)") : "";

    const sdkError = true;
    const body = responseBody.slice(0, 500);
    const message = loggedErr.message;
    $log!("REPLY", requestID, sdkError, status, body, message);
    if (status === 404) {
      $log!("REPLY", requestID, "404_benign");
      return;
    }
    throw err;
  }
}

export default async function GuardianPlugin(
  ctx: PluginInput,
  options: GuardianPluginOptions = {},
): Promise<ReturnType<typeof createGuardianHooks>> {
  const statePath = resolveStatePath(ctx);

  const reviewOptions: GuardianReviewOptions = {
    guardianModel: options.guardianModel,
    timeoutMs: options.timeoutMs ?? 90_000,
    maxAttempts: options.maxAttempts ?? 3,
    baseBackoffMs: options.baseBackoffMs ?? 500,
  };

  const sdkClient = ctx.client as ExtendedSdkClient;

  const deps: GuardianRuntimeDeps = {
    readMode: () => readMode(options.mode ?? "user", statePath),
    writeMode: (mode) => writeMode(mode, statePath),
    loadTranscript: (sessionID, limit) => loadTranscript(ctx, sessionID, limit),
    runReview: async (action: GuardianAction, transcript: GuardianTranscriptEntry[]) => {
      const assessment = await runGuardianReview(action, transcript, reviewOptions, {
        createSession: async () => {
          const res = (await sdkClient.session.create({})) as SessionCreateResponse;
          const id = res?.data?.id;
          if (!id) throw new Error("createSession returned no id");
          return { id };
        },
        prompt: async (sessionID, body) => {
          const res = (await sdkClient.session.prompt({
            path: { id: sessionID },
            body: {
              system: body.system,
              parts: body.parts,
              model: body.model,
              noReply: body.noReply,
            },
          })) as SessionPromptResponse;
          const data = res?.data;
          return {
            info: data?.info ?? { id: "", sessionID, role: "assistant" },
            parts: data?.parts ?? [],
          };
        },
        abortSession: async (sessionID) => {
          try {
            await sdkClient.session.abort?.({ path: { id: sessionID } });
          } catch {
            // ignore
          }
        },
      });
      return assessment;
    },
    replyPermission: async (sessionID, requestID, reply, message) =>
      replyPermission(ctx, sessionID, requestID, reply, message),
  };

  return createGuardianHooks(options, deps);
}
