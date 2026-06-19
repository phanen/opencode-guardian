// Shared shapes used in 2+ files or representing an SDK response.
// Upstream plugin hook I/O types live in @opencode-ai/plugin.

export interface ContentPart {
  type?: string;
  text?: string;
}

export interface ModelRef {
  providerID: string;
  modelID: string;
}

export interface ToolRef {
  messageID: string;
  callID: string;
}

export interface MessageInfo {
  id: string;
  sessionID: string;
  role: string;
}

export interface SessionId {
  id: string;
}

export interface SessionMessage extends ContentPart {
  info?: MessageInfo;
  parts: ContentPart[];
}

export interface SessionMessagesResponse {
  data?: SessionMessage[];
}

export interface SessionCreateResponseData {
  id?: string;
}

export interface SessionCreateResponse {
  data?: SessionCreateResponseData;
}

export interface SessionPromptResponseData {
  info?: MessageInfo;
  parts?: ContentPart[];
}

export interface SessionPromptResponse {
  data?: SessionPromptResponseData;
}

export interface PermissionReplyBody {
  response: string;
  message?: string;
}

export interface PermissionReplyPath {
  id: string;
  permissionID: string;
}

export interface PermissionReplyQuery {
  directory?: string;
}

export interface PermissionReplyOptions {
  body: PermissionReplyBody;
  path: PermissionReplyPath;
  query?: PermissionReplyQuery;
}

export interface PermissionAskedRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata?: Record<string, unknown>;
  always?: string[];
  tool?: ToolRef;
}

export interface RawEvent {
  type?: string;
  properties?: PermissionAskedRequest | { sessionID?: string } | undefined;
}

export interface RequestResult {
  response?: Response;
  status?: number;
}

export interface LoggedError extends Error {
  response?: Response;
  status?: number;
}

export interface SdkClientWithPermissionReply {
  postSessionIdPermissionsPermissionId?: (options: PermissionReplyOptions) => Promise<unknown>;
}
