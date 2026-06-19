// Guardian review session trunk manager.
//
// A "trunk" is a long-lived opencode session used as a workspace for
// guardian LLM reviews. It is created as a child of the agent session
// (via `session.create({body: {parentID}})`) and is **reused across
// approvals** for the same parent session. Trunks persist for the
// lifetime of the parent session; they are only explicitly torn down
// on mode change.
//
// The manager is intentionally narrow: one method to obtain a session
// id (`getOrCreate`), one to invalidate a single trunk
// (`invalidate`), and one to tear them all down on mode switch
// (`invalidateAll`). It does not retry on `invalidate` failures — the
// caller (`guardianCore.ts`) logs and moves on. The manager also does
// not perform the prompt itself; that lives in `review.ts`.

import type { SessionAdminClient } from "./types";

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
}

export interface GuardianTrunkManagerOptions {
  factory: GuardianTrunkFactory;
  title: string;
  onWarn?: (message: string) => void;
}

interface TrunkEntry {
  sessionID: string;
}

export class GuardianTrunkManager {
  private readonly trunks = new Map<string, Promise<TrunkEntry>>();
  private readonly factory: GuardianTrunkFactory;
  private readonly title: string;
  private readonly onWarn: (message: string) => void;

  constructor(options: GuardianTrunkManagerOptions) {
    this.factory = options.factory;
    this.title = options.title;
    this.onWarn = options.onWarn ?? (() => {});
  }

  async getOrCreate(parentID: string): Promise<string> {
    const existing = this.trunks.get(parentID);
    if (existing) {
      return (await existing).sessionID;
    }
    const init = (async (): Promise<TrunkEntry> => {
      const sessionID = await this.factory.createReviewSession(parentID);
      return { sessionID };
    })();
    this.trunks.set(parentID, init);
    try {
      return (await init).sessionID;
    } catch (err) {
      // Factory failed — do not cache a broken promise so a future call
      // can retry. Use a microtask to evict (avoid mutating the map
      // while it is mid-iteration elsewhere).
      queueMicrotask(() => {
        if (this.trunks.get(parentID) === init) {
          this.trunks.delete(parentID);
        }
      });
      throw err;
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
      // Init failed; nothing to delete.
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
      const create = sdk.session.create;
      if (!create) {
        throw new Error("opencode SDK does not expose session.create");
      }
      const res = (await create({ body: { parentID, title } })) as SessionCreateDataPayload;
      const id = res?.data?.id;
      if (!id) throw new Error("session.create returned no id");
      return id;
    },
    deleteReviewSession: async (sessionID) => {
      const del = sdk.session.delete;
      if (!del) {
        warn(`session.delete not exposed; guardian review session ${sessionID} leaked`);
        return;
      }
      try {
        await del({ path: { id: sessionID } });
      } catch (err) {
        const status = extractStatus(err);
        if (status === 404) return;
        throw err;
      }
    },
  };
}
