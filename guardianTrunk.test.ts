import { GuardianTrunkManager, createTrunkFactoryFromSdk } from "./guardianTrunk";
import type { GuardianTrunkFactory, SessionAdminClient, SessionCreateArgs, SessionDeleteArgs } from "./types";

interface FactoryCall {
  kind: "create" | "delete";
  parentID?: string;
  sessionID?: string;
}

interface StatusError extends Error {
  status?: number;
}

interface RecordingFactoryFails {
  create?: string;
  delete?: string;
}

interface RecordingFactoryOpts {
  idsByParent?: Record<string, string>;
  fails?: RecordingFactoryFails;
}

interface RecordingFactoryHandle {
  factory: GuardianTrunkFactory;
  calls: FactoryCall[];
  createCount: () => number;
  deleteCount: () => number;
}

function makeRecordingFactory(opts: RecordingFactoryOpts = {}): RecordingFactoryHandle {
  const calls: FactoryCall[] = [];
  let nextId = 0;
  const factory: GuardianTrunkFactory = {
    createReviewSession: async (parentID) => {
      calls.push({ kind: "create", parentID });
      if (opts.fails?.create) throw new Error(opts.fails.create);
      const fixed = opts.idsByParent?.[parentID];
      const id = fixed ?? `ses_guardian_${++nextId}`;
      return id;
    },
    deleteReviewSession: async (sessionID) => {
      calls.push({ kind: "delete", sessionID });
      if (opts.fails?.delete) throw new Error(opts.fails.delete);
    },
  };
  return {
    factory,
    calls,
    createCount: () => calls.filter((c) => c.kind === "create").length,
    deleteCount: () => calls.filter((c) => c.kind === "delete").length,
  };
}

describe("GuardianTrunkManager", () => {
  test("getOrCreate creates exactly one session per parent", async () => {
    const { factory, createCount } = makeRecordingFactory();
    const mgr = new GuardianTrunkManager({ factory, title: "guardian-review" });

    const a = await mgr.getOrCreate("ses_parent_1");
    const b = await mgr.getOrCreate("ses_parent_1");
    const c = await mgr.getOrCreate("ses_parent_1");

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(createCount()).toBe(1);
  });

  test("different parents get different trunks", async () => {
    const { factory, createCount } = makeRecordingFactory({
      idsByParent: { ses_parent_1: "ses_grd_1", ses_parent_2: "ses_grd_2" },
    });
    const mgr = new GuardianTrunkManager({ factory, title: "guardian-review" });

    const id1 = await mgr.getOrCreate("ses_parent_1");
    const id2 = await mgr.getOrCreate("ses_parent_2");
    const id1Again = await mgr.getOrCreate("ses_parent_1");

    expect(id1).toBe("ses_grd_1");
    expect(id2).toBe("ses_grd_2");
    expect(id1Again).toBe("ses_grd_1");
    expect(createCount()).toBe(2);
  });

  test("concurrent getOrCreate shares a single create call", async () => {
    let creates = 0;
    const factory: GuardianTrunkFactory = {
      createReviewSession: async () => {
        creates += 1;
        await new Promise((r) => setTimeout(r, 5));
        return "ses_grd_42";
      },
      deleteReviewSession: async () => {},
    };
    const mgr = new GuardianTrunkManager({ factory, title: "guardian-review" });

    const results = await Promise.all([
      mgr.getOrCreate("ses_parent_1"),
      mgr.getOrCreate("ses_parent_1"),
      mgr.getOrCreate("ses_parent_1"),
    ]);
    expect(creates).toBe(1);
    expect(results.every((id) => id === "ses_grd_42")).toBe(true);
  });

  test("create failure does not poison the cache", async () => {
    let shouldFail = true;
    const factory: GuardianTrunkFactory = {
      createReviewSession: async () => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("transient create error");
        }
        return "ses_grd_recovered";
      },
      deleteReviewSession: async () => {},
    };
    const mgr = new GuardianTrunkManager({ factory, title: "guardian-review" });

    await expect(mgr.getOrCreate("ses_parent_1")).rejects.toThrow("transient create error");
    const recovered = await mgr.getOrCreate("ses_parent_1");
    expect(recovered).toBe("ses_grd_recovered");
  });

  test("invalidate deletes the session and removes it from cache", async () => {
    const { factory, createCount, deleteCount } = makeRecordingFactory();
    const mgr = new GuardianTrunkManager({ factory, title: "guardian-review" });

    const id = await mgr.getOrCreate("ses_parent_1");
    expect(createCount()).toBe(1);
    await mgr.invalidate("ses_parent_1");
    expect(deleteCount()).toBe(1);

    // Next call should create a new session.
    const id2 = await mgr.getOrCreate("ses_parent_1");
    expect(createCount()).toBe(2);
    expect(id2).not.toBe(id);
  });

  test("invalidate is idempotent (no entry, no-op)", async () => {
    const { factory, deleteCount } = makeRecordingFactory();
    const mgr = new GuardianTrunkManager({ factory, title: "guardian-review" });
    await mgr.invalidate("never_created");
    expect(deleteCount()).toBe(0);
  });

  test("delete failure during invalidate is logged, not thrown", async () => {
    const warns: string[] = [];
    const { factory, deleteCount } = makeRecordingFactory({ fails: { delete: "boom" } });
    const mgr = new GuardianTrunkManager({
      factory,
      title: "guardian-review",
      onWarn: (m) => warns.push(m),
    });

    await mgr.getOrCreate("ses_parent_1");
    await expect(mgr.invalidate("ses_parent_1")).resolves.toBeUndefined();
    expect(deleteCount()).toBe(1);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/ses_guardian_1/);
  });

  test("invalidateAll tears down every cached parent", async () => {
    const { factory, createCount, deleteCount } = makeRecordingFactory();
    const mgr = new GuardianTrunkManager({ factory, title: "guardian-review" });

    await mgr.getOrCreate("ses_parent_1");
    await mgr.getOrCreate("ses_parent_2");
    await mgr.getOrCreate("ses_parent_3");
    expect(createCount()).toBe(3);

    await mgr.invalidateAll();
    expect(deleteCount()).toBe(3);

    // After invalidateAll, every parent needs a fresh create.
    await mgr.getOrCreate("ses_parent_1");
    expect(createCount()).toBe(4);
  });
});

describe("createTrunkFactoryFromSdk", () => {
  test("createReviewSession returns data.id from session.create", async () => {
    const sdk: SessionAdminClient = {
      session: {
        create: async (args: SessionCreateArgs) => ({
          data: { id: `ses_for_${args.body?.parentID ?? ""}` },
        }),
        delete: async () => ({}),
      },
    };
    const factory = createTrunkFactoryFromSdk(sdk, "guardian-review");
    const id = await factory.createReviewSession("ses_parent_1");
    expect(id).toBe("ses_for_ses_parent_1");
  });

  test("createReviewSession throws when SDK does not expose session.create", async () => {
    const sdk: SessionAdminClient = { session: {} };
    const factory = createTrunkFactoryFromSdk(sdk, "guardian-review");
    await expect(factory.createReviewSession("ses_parent_1")).rejects.toThrow(/session\.create/);
  });

  test("createReviewSession throws when create returns no id", async () => {
    const sdk: SessionAdminClient = {
      session: { create: async () => ({ data: {} }), delete: async () => ({}) },
    };
    const factory = createTrunkFactoryFromSdk(sdk, "guardian-review");
    await expect(factory.createReviewSession("ses_parent_1")).rejects.toThrow(/no id/);
  });

  test("deleteReviewSession swallows 404 responses", async () => {
    const calls: SessionDeleteArgs[] = [];
    const sdk: SessionAdminClient = {
      session: {
        create: async () => ({ data: { id: "ses_grd" } }),
        delete: async (args: SessionDeleteArgs) => {
          calls.push(args);
          const err = new Error("not found") as StatusError;
          err.status = 404;
          throw err;
        },
      },
    };
    const factory = createTrunkFactoryFromSdk(sdk, "guardian-review");
    await expect(factory.deleteReviewSession("ses_grd")).resolves.toBeUndefined();
    expect(calls).toEqual([{ path: { id: "ses_grd" } }]);
  });

  test("deleteReviewSession rethrows non-404 errors", async () => {
    const sdk: SessionAdminClient = {
      session: {
        create: async () => ({ data: { id: "ses_grd" } }),
        delete: async () => {
          const err = new Error("server error") as StatusError;
          err.status = 500;
          throw err;
        },
      },
    };
    const factory = createTrunkFactoryFromSdk(sdk, "guardian-review");
    await expect(factory.deleteReviewSession("ses_grd")).rejects.toThrow(/server error/);
  });

  test("deleteReviewSession warns and resolves when SDK does not expose session.delete", async () => {
    const warns: string[] = [];
    const sdk = { session: { create: async () => ({ data: { id: "ses_grd" } }) } };
    const factory = createTrunkFactoryFromSdk(sdk, "guardian-review", (m) => warns.push(m));
    await expect(factory.deleteReviewSession("ses_grd")).resolves.toBeUndefined();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/leaked/);
  });
});
