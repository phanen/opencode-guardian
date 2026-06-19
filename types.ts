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

export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

export interface QuestionTool {
  messageID: string;
  callID: string;
}

export interface QuestionAskedRequest {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: QuestionTool;
}

export interface RawEvent {
  type?: string;
  properties?: PermissionAskedRequest | QuestionAskedRequest | { sessionID?: string } | undefined;
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

// The hey-api client used inside @opencode-ai/sdk. We need a way to make
// raw HTTP calls (e.g. POST /question/:requestID/reply) when the SDK does
// not expose a typed method. The SDK stores the underlying client on a
// protected `_client` field; at runtime it is a normal property, so we
// reach it through a structural type assertion. The configured `fetch`
// option is what routes requests to the in-process server when no
// listening URL is available.
export interface SdkRawPostCall {
  post: (options: SdkRawPostOptions) => Promise<unknown>;
}

export interface SdkRawPostOptions {
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface SdkClientWithRawPost {
  _client: SdkRawPostCall;
}

// Minimal shape the trunk manager needs from the SDK. Mirrors
// `client.session.create / .delete` so the manager can be tested without
// the full OpencodeClient.
export interface SessionCreateBody {
  parentID?: string;
  title?: string;
}

export interface SessionCreateArgs {
  body?: SessionCreateBody;
}

export interface SessionDeletePath {
  id: string;
}

export interface SessionDeleteArgs {
  path: SessionDeletePath;
}

export interface SessionAdminSession {
  create?: (args: SessionCreateArgs) => Promise<unknown>;
  delete?: (args: SessionDeleteArgs) => Promise<unknown>;
}

export interface SessionAdminClient {
  session: SessionAdminSession;
}
