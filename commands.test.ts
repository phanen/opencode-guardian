import { maybeHandleGuardianCommand, statusLineFor } from "./commands";

function makeDeps(initial: "user" | "auto_review" = "user") {
  let mode: "user" | "auto_review" = initial;
  const writes: Array<"user" | "auto_review"> = [];
  return {
    get mode() {
      return mode;
    },
    writes,
    deps: {
      readMode: async () => mode,
      writeMode: async (m: "user" | "auto_review") => {
        mode = m;
        writes.push(m);
      },
    },
  };
}

describe("commands", () => {
  test("/guardian toggles from user to auto_review", async () => {
    const t = makeDeps("user");
    const r = await maybeHandleGuardianCommand("/guardian", t.deps);
    expect(r.handled).toBe(true);
    expect(r.mode).toBe("auto_review");
    expect(t.mode).toBe("auto_review");
    expect(t.writes).toEqual(["auto_review"]);
  });

  test("/guardian toggles from auto_review to user", async () => {
    const t = makeDeps("auto_review");
    const r = await maybeHandleGuardianCommand("/guardian", t.deps);
    expect(r.handled).toBe(true);
    expect(r.mode).toBe("user");
  });

  test("/guardian on enables auto_review", async () => {
    const t = makeDeps("user");
    const r = await maybeHandleGuardianCommand("/guardian on", t.deps);
    expect(r.handled).toBe(true);
    expect(r.mode).toBe("auto_review");
  });

  test("/guardian auto_review is an alias for on", async () => {
    const t = makeDeps("user");
    const r = await maybeHandleGuardianCommand("/guardian auto_review", t.deps);
    expect(r.handled).toBe(true);
    expect(r.mode).toBe("auto_review");
  });

  test("/guardian off disables", async () => {
    const t = makeDeps("auto_review");
    const r = await maybeHandleGuardianCommand("/guardian off", t.deps);
    expect(r.handled).toBe(true);
    expect(r.mode).toBe("user");
  });

  test("/guardian user is an alias for off", async () => {
    const t = makeDeps("auto_review");
    const r = await maybeHandleGuardianCommand("/guardian user", t.deps);
    expect(r.handled).toBe(true);
    expect(r.mode).toBe("user");
  });

  test("/guardian status returns current mode", async () => {
    const t = makeDeps("auto_review");
    const r = await maybeHandleGuardianCommand("/guardian status", t.deps);
    expect(r.handled).toBe(true);
    expect(r.mode).toBe("auto_review");
  });

  test("non-guardian text is unhandled", async () => {
    const t = makeDeps("user");
    const r = await maybeHandleGuardianCommand("hello world", t.deps);
    expect(r.handled).toBe(false);
    expect(t.writes).toEqual([]);
  });

  test("unknown /guardian argument is unhandled", async () => {
    const t = makeDeps("user");
    const r = await maybeHandleGuardianCommand("/guardian nonsense", t.deps);
    expect(r.handled).toBe(false);
  });

  test("case-insensitive /GUARDIAN", async () => {
    const t = makeDeps("user");
    const r = await maybeHandleGuardianCommand("/GUARDIAN ON", t.deps);
    expect(r.handled).toBe(true);
    expect(r.mode).toBe("auto_review");
  });

  test("statusLineFor reflects mode", () => {
    expect(statusLineFor("user")).toMatch(/user/);
    expect(statusLineFor("auto_review")).toMatch(/auto_review/);
  });
});
