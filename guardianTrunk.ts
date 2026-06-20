// Guardian review session trunk manager.
//
// A "trunk" is a long-lived opencode session used as a workspace for
// guardian LLM reviews. It is created as a child of the agent session
// (via `session.create({body: {parentID, title: "guardian-review"}})`)
// and is **reused across approvals** for the same parent session.
//
// Discovery is by enumeration, not by a maintained map. To find an
// existing trunk for a parent, the manager calls
// `client.session.children({path: {id: parentID}})`, filters to
// entries whose `title === "guardian-review"`, picks the most recent,
// and verifies it is still alive. There is no persistence layer —
// the opencode server itself is the source of truth, so a plugin
// restart does not invalidate cached trunks and the manager
// reattaches to whatever the server still has.
//
// Each trunk additionally tracks the count of parent-transcript
// entries it has already seen. On the first review of a trunk the
// manager starts the count at 0, so the LLM gets the full transcript
// as a baseline. Subsequent reviews only send the delta
// (transcript.slice(lastCount)) to avoid re-sending the entire
// transcript on every approval. The count is process-local and
// resets to 0 on plugin restart — that is acceptable because the
// reattached trunk already has the previous review turns in its own
// history, so the LLM has cross-restart context either way.
//
// The manager enforces a `maxReviewsPerTrunk` ceiling: when a trunk
// has served that many reviews, the next `getOrCreate` deletes the
// old trunk and creates a fresh one, keeping the per-trunk message
// count bounded.
//
// The manager is intentionally narrow: `getOrCreate`,
// `recordReviewed`, `invalidate`, `invalidateAll`. It does not retry
// on `invalidate` failures — the caller (`guardianCore.ts`) logs and
// moves on. The manager also does not perform the prompt itself;
// that lives in `review.ts`.

import type { GuardianSessionInfo, GuardianSessionMessagesItem, SessionAdminClient } from "./types";

interface SessionCreateIdPayload {
  id?: string;
}

interface SessionCreateDataPayload {
  data?: SessionCreateIdPayload;
}

interface StatusCarrierResponse {
  status?: number;
}

interface StatusCarrier {
  status?: number;
  response?: StatusCarrierResponse;
}

function extractStatus(err: unknown): number | undefined {
  const e = err as StatusCarrier;
  return e?.status ?? e?.response?.status;
}

export interface GuardianTrunkFactory {
  createReviewSession: (parentID: string) => Promise<string>;
  deleteReviewSession: (sessionID: string) => Promise<void>;
  findExistingTrunk: (parentID: string) => Promise<string | undefined>;
}

export interface GuardianTrunkManagerOptions {
  factory: GuardianTrunkFactory;
  title: string;
  maxReviewsPerTrunk: number;
  onWarn?: (message: string) => void;
}

interface TrunkEntry {
  sessionID: string;
  lastReviewedTranscriptCount: number;
  reviewCount: number;
}

export interface AcquiredTrunk {
  sessionID: string;
  deltaStart: number;
}

export class GuardianTrunkManager {
  private readonly trunks = new Map<string, Promise<TrunkEntry>>();
  private readonly factory: GuardianTrunkFactory;
  private readonly title: string;
  private readonly maxReviewsPerTrunk: number;
  private readonly onWarn: (message: string) => void;

  constructor(options: GuardianTrunkManagerOptions) {
    this.factory = options.factory;
    this.title = options.title;
    this.maxReviewsPerTrunk = options.maxReviewsPerTrunk;
    this.onWarn = options.onWarn ?? (() => {});
  }

  // Returns the cached session id if the entry has room for another
  // review; otherwise resolves to a new entry (existing one is
  // deleted in the background). The optional `transcriptLength` is
  // used to decide how much of the next prompt must be sent as
  // delta: an entry that already covers the full transcript has no
  // delta to send.
  async getOrCreate(parentID: string, transcriptLength: number): Promise<AcquiredTrunk> {
    const existing = this.trunks.get(parentID);
    if (existing) {
      const entry = await this.existingEntry(parentID, existing);
      if (entry) {
        // After the ceiling is hit, fall through to create a fresh
        // trunk so the message count stays bounded. The old one is
        // deleted in the background.
        if (entry.reviewCount < this.maxReviewsPerTrunk) {
          return { sessionID: entry.sessionID, deltaStart: entry.lastReviewedTranscriptCount };
        }
        this.trunks.delete(parentID);
        this.factory.deleteReviewSession(entry.sessionID).catch((err) => {
          this.onWarn(
            `failed to recycle over-cap guardian review session ${entry.sessionID}: ${(err as Error).message ?? String(err)}`,
          );
        });
      }
    }

    // Try the server for an existing trunk before creating a new one,
    // so a plugin restart reattaches to the most recent trunk
    // rather than spawning a fresh child. Discovery goes through
    // `client.session.children` and is filtered by title and
    // freshness.
    let resolvedSessionID: string | undefined;
    try {
      resolvedSessionID = await this.factory.findExistingTrunk(parentID);
    } catch (err) {
      this.onWarn(
        `failed to enumerate guardian review children for ${parentID}: ${(err as Error).message ?? String(err)}`,
      );
    }

    if (resolvedSessionID) {
      const entry: TrunkEntry = {
        sessionID: resolvedSessionID,
        // 0 on reattach: the trunk already has its prior review turns
        // in its own history, so the LLM has cross-restart context.
        // Sending the full transcript once on reattach keeps things
        // correct without an extra round-trip.
        lastReviewedTranscriptCount: 0,
        reviewCount: 0,
      };
      this.trunks.set(parentID, Promise.resolve(entry));
      return { sessionID: entry.sessionID, deltaStart: 0 };
    }

    // No reusable trunk on the server — create one. Use the
    // promise-in-map pattern so concurrent getOrCreate calls for
    // the same parent share the create call.
    const init = (async (): Promise<TrunkEntry> => {
      const sessionID = await this.factory.createReviewSession(parentID);
      return { sessionID, lastReviewedTranscriptCount: 0, reviewCount: 0 };
    })();
    this.trunks.set(parentID, init);
    try {
      const entry = await init;
      // The first review of a brand-new trunk sends the full
      // transcript as the LLM's baseline. Only send what is actually
      // present (transcriptLength may be 0 for a brand-new parent).
      const deltaStart = Math.min(0, transcriptLength);
      return { sessionID: entry.sessionID, deltaStart };
    } catch (err) {
      queueMicrotask(() => {
        if (this.trunks.get(parentID) === init) {
          this.trunks.delete(parentID);
        }
      });
      throw err;
    }
  }

  // Record that a review was just run against the trunk for
  // `parentID`, and that the LLM has now seen
  // `transcriptLength` entries from the parent's transcript. Bumps
  // the per-trunk review count toward the ceiling.
  async recordReviewed(parentID: string, transcriptLength: number): Promise<void> {
    const entry = this.trunks.get(parentID);
    if (!entry) return;
    let resolved: TrunkEntry;
    try {
      resolved = await entry;
    } catch {
      return;
    }
    // Mutate the resolved entry; since the entry object is held by
    // the map value (a Promise<TrunkEntry>), future getOrCreate
    // calls see the updated count.
    resolved.lastReviewedTranscriptCount = Math.max(resolved.lastReviewedTranscriptCount, transcriptLength);
    resolved.reviewCount += 1;
  }

  private async existingEntry(parentID: string, promise: Promise<TrunkEntry>): Promise<TrunkEntry | undefined> {
    try {
      return await promise;
    } catch {
      // Init failed; drop the cached promise so the next call can
      // try again.
      if (this.trunks.get(parentID) === promise) {
        this.trunks.delete(parentID);
      }
      return undefined;
    }
  }

  async invalidate(parentID: string): Promise<void> {
    const entry = this.trunks.get(parentID);
    this.trunks.delete(parentID);
    if (!entry) return;
    let resolved: TrunkEntry;
    try {
      resolved = await entry;
    } catch {
      return;
    }
    try {
      await this.factory.deleteReviewSession(resolved.sessionID);
    } catch (err) {
      this.onWarn(
        `failed to delete guardian review session ${resolved.sessionID}: ${(err as Error).message ?? String(err)}`,
      );
    }
  }

  async invalidateAll(): Promise<void> {
    const parentIDs = Array.from(this.trunks.keys());
    await Promise.all(parentIDs.map((id) => this.invalidate(id)));
  }
}

export function createTrunkFactoryFromSdk(
  sdk: SessionAdminClient,
  title: string,
  onWarn?: (message: string) => void,
): GuardianTrunkFactory {
  const warn = onWarn ?? (() => {});
  return {
    createReviewSession: async (parentID) => {
      if (!sdk.session.create) {
        throw new Error("opencode SDK does not expose session.create");
      }
      const res = (await sdk.session.create({ body: { parentID, title } })) as SessionCreateDataPayload;
      const id = res?.data?.id;
      if (!id) throw new Error("session.create returned no id");
      return id;
    },
    deleteReviewSession: async (sessionID) => {
      if (!sdk.session.delete) {
        warn(`session.delete not exposed; guardian review session ${sessionID} leaked`);
        return;
      }
      try {
        await sdk.session.delete({ path: { id: sessionID } });
      } catch (err) {
        const status = extractStatus(err);
        if (status === 404) return;
        throw err;
      }
    },
    findExistingTrunk: async (parentID) => {
      if (!sdk.session.children) {
        warn("session.children not exposed; cannot reattach to existing trunk");
        return undefined;
      }
      let res: unknown;
      try {
        // Must invoke through the session object so the SDK method's
        // `this` binding is preserved.
        res = await sdk.session.children({ path: { id: parentID } });
      } catch (err) {
        // A 404 on `children` means the parent itself is gone, so
        // there cannot be a trunk to find. Propagate so the caller
        // can decide; treat as "no trunk".
        const status = extractStatus(err);
        if (status === 404) return undefined;
        throw err;
      }
      // The SDK response shape is `{ data: [...] }` for the
      // responseStyle="data" case, or the raw array for
      // responseStyle="fields". Both are tolerated.
      const list = extractChildrenList(res);
      if (!list) return undefined;
      const candidates = list.filter((c): c is GuardianSessionInfo => isGuardianSessionInfo(c) && c.title === title);
      if (candidates.length === 0) return undefined;
      // Most recent first; ties broken by id for determinism.
      candidates.sort((a, b) => {
        if (b.time.created !== a.time.created) return b.time.created - a.time.created;
        return a.id < b.id ? 1 : -1;
      });
      const chosen = candidates[0];
      if (!chosen) return undefined;
      // Verify it is still alive: a 404 here means the trunk was
      // removed between the listing and now.
      if (!sdk.session.get) {
        warn("session.get not exposed; trusting children listing");
        return chosen.id;
      }
      try {
        await sdk.session.get({ path: { id: chosen.id } });
      } catch (err) {
        const status = extractStatus(err);
        if (status === 404) return undefined;
        throw err;
      }
      return chosen.id;
    },
  };
}

function extractChildrenList(res: unknown): GuardianSessionInfo[] | undefined {
  if (Array.isArray(res)) return res.filter(isGuardianSessionInfo);
  if (res && typeof res === "object") {
    const data = (res as { data?: unknown }).data;
    if (Array.isArray(data)) return data.filter(isGuardianSessionInfo);
  }
  return undefined;
}

function isGuardianSessionInfo(value: unknown): value is GuardianSessionInfo {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string") return false;
  if (typeof v.title !== "string") return false;
  const time = v.time;
  if (!time || typeof time !== "object") return false;
  const t = time as Record<string, unknown>;
  if (typeof t.created !== "number") return false;
  if (typeof t.updated !== "number") return false;
  return true;
}

// Re-export the message-item type for callers that want to inspect
// trunk message counts (used in tests and future telemetry).
export type { GuardianSessionMessagesItem };
