import { GuardianTrunkManager, createTrunkFactoryFromSdk } from "./guardianTrunk";
import type { GuardianSessionInfo, SessionAdminClient } from "./types";

interface FactoryCall {
  kind: "create" | "delete" | "children" | "get";
  parentID?: string;
  sessionID?: string;
}

interface FakeErrorOptions {
  status?: number;
  message?: string;
}

interface FakeTrunkOpts {
  existingTrunks?: GuardianSessionInfo[];
  childrenError?: FakeErrorOptions;
  getError?: FakeErrorOptions;
  createId?: string;
}

interface FakeSdkHandle {
  sdk: SessionAdminClient;
  calls: FactoryCall[];
}

const MAX_REVIEWS = 3;

function makeFakeSdk(opts: FakeTrunkOpts = {}): FakeSdkHandle {
  const calls: FactoryCall[] = [];
  let nextCreateId = 1;
  const sdk: SessionAdminClient = {
    session: {
      create: async (args) => {
        calls.push({ kind: "create", parentID: args.body?.parentID });
        return { data: { id: opts.createId ?? `ses_grd_${nextCreateId++}` } };
      },
      delete: async (args) => {
        calls.push({ kind: "delete", sessionID: args.path.id });
      },
      children: async (args) => {
        calls.push({ kind: "children", parentID: args.path.id });
        if (opts.childrenError) {
          const err = new Error(opts.childrenError.message ?? "children failed") as Error & { status?: number };
          err.status = opts.childrenError.status;
          throw err;
        }
        const trunks = (opts.existingTrunks ?? []).filter((t) => t.parentID === args.path.id);
        return { data: trunks };
      },
      get: async (args) => {
        calls.push({ kind: "get", sessionID: args.path.id });
        if (opts.getError) {
          const err = new Error(opts.getError.message ?? "get failed") as Error & { status?: number };
          err.status = opts.getError.status;
          throw err;
        }
        return { data: { id: args.path.id, title: "guardian-review" } };
      },
    },
  };
  return { sdk, calls };
}

interface MakeTrunkOpts {
  parentID?: string;
  title?: string;
  created?: number;
  updated?: number;
}

function makeTrunk(id: string, opts: MakeTrunkOpts = {}): GuardianSessionInfo {
  const t = opts.created ?? 1_000;
  return {
    id,
    parentID: opts.parentID ?? "ses_parent_1",
    title: opts.title ?? "guardian-review",
    time: { created: t, updated: opts.updated ?? t },
  };
}

describe("GuardianTrunkManager — getOrCreate with children-based discovery", () => {
  test("creates a new trunk when no children exist", async () => {
    const { sdk, calls } = makeFakeSdk({ existingTrunks: [] });
    const mgr = new GuardianTrunkManager({
      factory: createTrunkFactoryFromSdk(sdk, "guardian-review"),
      title: "guardian-review",
      maxReviewsPerTrunk: MAX_REVIEWS,
    });
    const r = await mgr.getOrCreate("ses_parent_1", 10);
    expect(r).toEqual({ sessionID: "ses_grd_1", deltaStart: 0 });
    const kinds = calls.map((c) => c.kind);
    expect(kinds).toContain("children");
    expect(kinds).toContain("create");
  });

  test("reattaches to the most recent existing child on first call", async () => {
    const trunks = [makeTrunk("ses_grd_old", { created: 1_000 }), makeTrunk("ses_grd_new", { created: 2_000 })];
    const { sdk, calls } = makeFakeSdk({ existingTrunks: trunks });
    const mgr = new GuardianTrunkManager({
      factory: createTrunkFactoryFromSdk(sdk, "guardian-review"),
      title: "guardian-review",
      maxReviewsPerTrunk: MAX_REVIEWS,
    });
    const r = await mgr.getOrCreate("ses_parent_1", 10);
    expect(r.sessionID).toBe("ses_grd_new");
    expect(r.deltaStart).toBe(0);
    expect(calls.filter((c) => c.kind === "create")).toHaveLength(0);
    expect(calls.filter((c) => c.kind === "get")).toHaveLength(1);
  });

  test("ignores children with mismatched title", async () => {
    const trunks = [makeTrunk("ses_grd_other", { title: "other" })];
    const { sdk, calls } = makeFakeSdk({ existingTrunks: trunks });
    const mgr = new GuardianTrunkManager({
      factory: createTrunkFactoryFromSdk(sdk, "guardian-review"),
      title: "guardian-review",
      maxReviewsPerTrunk: MAX_REVIEWS,
    });
    const r = await mgr.getOrCreate("ses_parent_1", 10);
    expect(r.sessionID).toBe("ses_grd_1");
    expect(calls.filter((c) => c.kind === "create")).toHaveLength(1);
  });

  test("falls back to create when get on the chosen child returns 404", async () => {
    const trunks = [makeTrunk("ses_grd_stale", { created: 1_000 })];
    const { sdk, calls } = makeFakeSdk({ existingTrunks: trunks, getError: { status: 404 } });
    const mgr = new GuardianTrunkManager({
      factory: createTrunkFactoryFromSdk(sdk, "guardian-review"),
      title: "guardian-review",
      maxReviewsPerTrunk: MAX_REVIEWS,
    });
    const r = await mgr.getOrCreate("ses_parent_1", 10);
    expect(r.sessionID).toBe("ses_grd_1");
    expect(calls.filter((c) => c.kind === "create")).toHaveLength(1);
  });

  test("propagates non-404 children errors but still creates a new trunk", async () => {
    const { sdk, calls } = makeFakeSdk({ childrenError: { status: 500, message: "boom" } });
    const warns: string[] = [];
    const mgr = new GuardianTrunkManager({
      factory: createTrunkFactoryFromSdk(sdk, "guardian-review", (m) => warns.push(m)),
      title: "guardian-review",
      maxReviewsPerTrunk: MAX_REVIEWS,
      onWarn: (m) => warns.push(m),
    });
    const r = await mgr.getOrCreate("ses_parent_1", 10);
    expect(r.sessionID).toBe("ses_grd_1");
    expect(calls.filter((c) => c.kind === "create")).toHaveLength(1);
    expect(warns.some((w) => w.includes("boom"))).toBe(true);
  });
});

describe("GuardianTrunkManager — recordReviewed delta tracking", () => {
  test("second getOrCreate returns the previously recorded delta start", async () => {
    const { sdk } = makeFakeSdk({ existingTrunks: [] });
    const mgr = new GuardianTrunkManager({
      factory: createTrunkFactoryFromSdk(sdk, "guardian-review"),
      title: "guardian-review",
      maxReviewsPerTrunk: MAX_REVIEWS,
    });
    const first = await mgr.getOrCreate("ses_parent_1", 10);
    await mgr.recordReviewed("ses_parent_1", 10);
    const second = await mgr.getOrCreate("ses_parent_1", 15);
    expect(second.sessionID).toBe(first.sessionID);
    expect(second.deltaStart).toBe(10);
  });

  test("recordReviewed is a no-op for unknown parents", async () => {
    const { sdk } = makeFakeSdk();
    const mgr = new GuardianTrunkManager({
      factory: createTrunkFactoryFromSdk(sdk, "guardian-review"),
      title: "guardian-review",
      maxReviewsPerTrunk: MAX_REVIEWS,
    });
    await expect(mgr.recordReviewed("ses_unknown", 5)).resolves.toBeUndefined();
  });

  test("recycles trunk after maxReviewsPerTrunk reviews", async () => {
    const { sdk, calls } = makeFakeSdk({ existingTrunks: [] });
    const mgr = new GuardianTrunkManager({
      factory: createTrunkFactoryFromSdk(sdk, "guardian-review"),
      title: "guardian-review",
      maxReviewsPerTrunk: MAX_REVIEWS,
    });
    const first = await mgr.getOrCreate("ses_parent_1", 10);
    for (let i = 0; i < MAX_REVIEWS; i += 1) {
      await mgr.recordReviewed("ses_parent_1", 10);
    }
    const second = await mgr.getOrCreate("ses_parent_1", 10);
    expect(second.sessionID).not.toBe(first.sessionID);
    expect(second.deltaStart).toBe(0);
    expect(calls.some((c) => c.kind === "delete")).toBe(true);
  });
});

describe("GuardianTrunkManager — invalidate", () => {
  test("invalidate deletes the trunk and removes it from the cache", async () => {
    const { sdk, calls } = makeFakeSdk();
    const mgr = new GuardianTrunkManager({
      factory: createTrunkFactoryFromSdk(sdk, "guardian-review"),
      title: "guardian-review",
      maxReviewsPerTrunk: MAX_REVIEWS,
    });
    await mgr.getOrCreate("ses_parent_1", 10);
    await mgr.invalidate("ses_parent_1");
    expect(calls.filter((c) => c.kind === "delete")).toHaveLength(1);
    const next = await mgr.getOrCreate("ses_parent_1", 10);
    expect(next.sessionID).toBe("ses_grd_2");
  });

  test("invalidateAll tears down every cached parent", async () => {
    const { sdk, calls } = makeFakeSdk();
    const mgr = new GuardianTrunkManager({
      factory: createTrunkFactoryFromSdk(sdk, "guardian-review"),
      title: "guardian-review",
      maxReviewsPerTrunk: MAX_REVIEWS,
    });
    await mgr.getOrCreate("ses_parent_1", 0);
    await mgr.getOrCreate("ses_parent_2", 0);
    await mgr.getOrCreate("ses_parent_3", 0);
    await mgr.invalidateAll();
    expect(calls.filter((c) => c.kind === "delete")).toHaveLength(3);
  });
});

describe("createTrunkFactoryFromSdk", () => {
  test("findExistingTrunk returns undefined on 404 children response", async () => {
    const sdk: SessionAdminClient = {
      session: {
        children: async () => {
          const err = new Error("not found") as Error & { status?: number };
          err.status = 404;
          throw err;
        },
      },
    };
    const factory = createTrunkFactoryFromSdk(sdk, "guardian-review");
    await expect(factory.findExistingTrunk("ses_parent_1")).resolves.toBeUndefined();
  });

  test("findExistingTrunk rethrows non-404 errors", async () => {
    const sdk: SessionAdminClient = {
      session: {
        children: async () => {
          const err = new Error("server error") as Error & { status?: number };
          err.status = 500;
          throw err;
        },
      },
    };
    const factory = createTrunkFactoryFromSdk(sdk, "guardian-review");
    await expect(factory.findExistingTrunk("ses_parent_1")).rejects.toThrow(/server error/);
  });

  test("findExistingTrunk tolerates raw-array response shape", async () => {
    const trunks: GuardianSessionInfo[] = [makeTrunk("ses_grd_1", { parentID: "ses_parent_1", created: 1_000 })];
    const sdk: SessionAdminClient = {
      session: {
        children: async () => trunks,
        get: async () => ({ data: { id: "ses_grd_1", title: "guardian-review" } }),
      },
    };
    const factory = createTrunkFactoryFromSdk(sdk, "guardian-review");
    await expect(factory.findExistingTrunk("ses_parent_1")).resolves.toBe("ses_grd_1");
  });

  test("findExistingTrunk falls back to create when get returns 404", async () => {
    const trunks: GuardianSessionInfo[] = [makeTrunk("ses_grd_x")];
    const sdk: SessionAdminClient = {
      session: {
        children: async () => ({ data: trunks }),
        get: async () => {
          const err = new Error("not found") as Error & { status?: number };
          err.status = 404;
          throw err;
        },
      },
    };
    const factory = createTrunkFactoryFromSdk(sdk, "guardian-review");
    await expect(factory.findExistingTrunk("ses_parent_1")).resolves.toBeUndefined();
  });

  test("createReviewSession preserves SDK method `this` binding", async () => {
    const sdk = makeFakeSdk().sdk;
    const factory = createTrunkFactoryFromSdk(sdk, "guardian-review");
    const id = await factory.createReviewSession("ses_parent_1");
    expect(typeof id).toBe("string");
  });
});

// Regression for "this._client is undefined" — when a method that
// reads `this._client` is hoisted out of its receiver and called
// as a free function, `this` becomes undefined. The factory must
// always invoke through the session object so the SDK method's
// `this` binding is preserved.
describe("createTrunkFactoryFromSdk — `this` binding regression", () => {
  interface FakePostOptions {
    url: string;
  }

  interface FakeClientPost {
    post: (opts: FakePostOptions) => Promise<unknown>;
  }

  interface FakeCreateId {
    id: string;
  }

  interface FakeCreateResponse {
    data: FakeCreateId;
  }

  interface FakeClientSession {
    _client: FakeClientPost;
    create: (this: FakeClientSession, args: unknown) => Promise<FakeCreateResponse>;
    delete: (this: FakeClientSession, args: unknown) => Promise<unknown>;
    children: (this: FakeClientSession, args: unknown) => Promise<unknown>;
    get: (this: FakeClientSession, args: unknown) => Promise<unknown>;
  }

  interface FakeClient {
    session: FakeClientSession;
  }

  interface MakeFakeClientOverrides {
    createResponse?: FakeCreateResponse;
  }

  function makeFakeClient(overrides: MakeFakeClientOverrides = {}): FakeClient {
    const fallback: FakeCreateResponse = overrides.createResponse ?? { data: { id: "ses_grd_x" } };
    return {
      session: {
        _client: {
          post: async (_opts: FakePostOptions) => fallback,
        },
        create(this: FakeClientSession, _args: unknown) {
          if (!this) throw new Error("create() called without `this`");
          if (!this._client) throw new Error("this._client is undefined");
          return this._client.post({ url: "/session" }).then(() => fallback);
        },
        delete(this: FakeClientSession, _args: unknown) {
          if (!this) throw new Error("delete() called without `this`");
          if (!this._client) throw new Error("this._client is undefined");
          return this._client.post({ url: "/session/ses_grd_x" });
        },
        children(this: FakeClientSession, _args: unknown) {
          if (!this) throw new Error("children() called without `this`");
          if (!this._client) throw new Error("this._client is undefined");
          return this._client.post({ url: "/session/.../children" }).then(() => ({ data: [] }));
        },
        get(this: FakeClientSession, _args: unknown) {
          if (!this) throw new Error("get() called without `this`");
          if (!this._client) throw new Error("this._client is undefined");
          return this._client.post({ url: "/session/ses_grd_x" }).then(() => ({ data: { id: "ses_grd_x" } }));
        },
      },
    };
  }

  test("createReviewSession preserves SDK method `this` binding", async () => {
    const sdk: SessionAdminClient = makeFakeClient();
    const factory = createTrunkFactoryFromSdk(sdk, "guardian-review");
    const id = await factory.createReviewSession("ses_parent_1");
    expect(id).toBe("ses_grd_x");
  });

  test("deleteReviewSession preserves SDK method `this` binding", async () => {
    const sdk: SessionAdminClient = makeFakeClient();
    const factory = createTrunkFactoryFromSdk(sdk, "guardian-review");
    await expect(factory.deleteReviewSession("ses_grd_x")).resolves.toBeUndefined();
  });

  test("findExistingTrunk preserves SDK method `this` binding", async () => {
    const sdk: SessionAdminClient = makeFakeClient();
    const factory = createTrunkFactoryFromSdk(sdk, "guardian-review");
    await expect(factory.findExistingTrunk("ses_parent_1")).resolves.toBeUndefined();
  });
});
