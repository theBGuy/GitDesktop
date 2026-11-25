import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type GenerateArgs,
  type PlanRun,
  usePlanStore,
} from "@/features/plan/store";
import {
  type AgentSessionArgs,
  cancelAgentSession,
  type ReviewEvent,
  runAgentSession,
} from "@/lib/ai/agent";
import { gitListTracked, readRepoInstructions } from "@/lib/git/api";

vi.mock("@/lib/ai/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/agent")>()),
  runAgentSession: vi.fn(),
  cancelAgentSession: vi.fn(async () => undefined),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitListTracked: vi.fn(async () => []),
  readRepoInstructions: vi.fn(async () => null),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(async () => ({ globalInstructions: "" })),
}));
vi.mock("@/features/plan/persistence", () => ({
  loadPersistedPlans: vi.fn(async () => []),
  savePersistedPlans: vi.fn(async () => undefined),
}));
vi.mock("@/lib/notifications/emit", () => ({ emitNotification: vi.fn() }));
vi.mock("@/features/sessions/watching", () => ({
  isWatchingAgentSurface: () => true,
}));

const RESET =
  "GitDesktop could not continue the earlier opencode conversation, so this turn started a new one. The agent does not remember the earlier turns.";

interface Run {
  args: AgentSessionArgs;
  emit: (ev: ReviewEvent) => void;
  settle: () => void;
}

let runs: Run[] = [];

function plan(id: string, nativeSessionId: string | null = null): PlanRun {
  return {
    id,
    repoPath: "C:/repo",
    agent: "opencode",
    model: "",
    effort: "",
    sessionId: `sid-${id}`,
    nativeSessionId,
    origin: { goal: "Goal", issueTitle: null },
    seed: null,
    generating: false,
    stopped: false,
    text: "",
    status: "",
    segments: [],
    draft: null,
    costUsd: null,
    implementedSessionId: null,
    error: null,
  };
}

const find = (id: string) =>
  usePlanStore.getState().runs.find((r) => r.id === id);
const stored = (id: string) => find(id)?.nativeSessionId;
const segmentsOf = (id: string) => find(id)?.segments ?? [];
const patchRun = (id: string, p: Partial<PlanRun>) =>
  usePlanStore.setState({
    runs: usePlanStore
      .getState()
      .runs.map((r) => (r.id === id ? { ...r, ...p } : r)),
  });

interface Turn {
  args: AgentSessionArgs;
  emit: (ev: ReviewEvent) => void;
  finish: () => Promise<void>;
  fail: (message: string) => Promise<void>;
  /** Settles a superseded turn, which never clears `generating` itself. */
  settleStale: () => Promise<void>;
}

/** Starts one follow-up through the public `sendFollowUp` and returns its run. */
async function startTurn(id: string): Promise<Turn> {
  const before = runs.length;
  usePlanStore.getState().sendFollowUp(id, "Tighten step 2");
  await vi.waitFor(() => expect(runs.length).toBe(before + 1));
  const run = runs[before];
  const settled = async () =>
    vi.waitFor(() => expect(find(id)?.generating ?? false).toBe(false));
  return {
    args: run.args,
    emit: run.emit,
    finish: async () => {
      run.settle();
      await settled();
    },
    fail: async (message) => {
      run.emit({ kind: "error", message, partialText: null, timedOut: false });
      run.settle();
      await settled();
    },
    settleStale: async () => {
      run.settle();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

beforeEach(() => {
  runs = [];
  vi.mocked(cancelAgentSession).mockClear();
  vi.mocked(runAgentSession).mockImplementation(
    (args) =>
      new Promise<ReviewEvent | null>((resolve) => {
        runs.push({ args, emit: args.onEvent, settle: () => resolve(null) });
      }),
  );
  // Reset, so a held read a failed test queued never leaks into the next.
  vi.mocked(readRepoInstructions).mockReset();
  vi.mocked(readRepoInstructions).mockResolvedValue(null);
  vi.mocked(gitListTracked).mockReset();
  vi.mocked(gitListTracked).mockResolvedValue([]);
  usePlanStore.setState({ runs: [], hydrated: true, activePlanId: null });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const ARGS: GenerateArgs = {
  repoPath: "C:/repo",
  agent: "opencode",
  model: "",
  effort: "",
  goal: "Goal",
};

const notice = (code: string, text: string): ReviewEvent => ({
  kind: "notice",
  code,
  text,
});
const native = (id: string): ReviewEvent => ({ kind: "nativeSession", id });
const notes = (id: string) => segmentsOf(id).filter((s) => s.type === "note");
const BODY = "# Plan\n\nRead the config first.";

describe("plan store: notices and the stored conversation id", () => {
  it("(1) a re-key replaces the stored id once and adds no note", async () => {
    usePlanStore.setState({ runs: [plan("a", "ses_abc")] });
    const run = await startTurn("a");
    run.emit(notice("nativeSessionRekey", ""));
    run.emit(native("oc2:w:ses_abc"));
    run.emit({ kind: "delta", text: "Working." });
    run.emit(native("oc2:w:ses_other"));
    await run.finish();
    expect(stored("a")).toBe("oc2:w:ses_abc");
    expect(notes("a")).toEqual([]);
  });

  it("(2) a token already stored is left untouched", async () => {
    usePlanStore.setState({ runs: [plan("a", "oc2:p:ses_abc")] });
    const run = await startTurn("a");
    expect(run.args.nativeSessionId).toBe("oc2:p:ses_abc");
    run.emit(native("oc2:p:ses_abc"));
    await run.finish();
    expect(stored("a")).toBe("oc2:p:ses_abc");
  });

  it("(3) a reset shows its note and the first new id replaces the stored one", async () => {
    usePlanStore.setState({ runs: [plan("a", "oc2:w:ses_old")] });
    const run = await startTurn("a");
    run.emit(notice("nativeSessionReset", RESET));
    run.emit(native("ses_new"));
    run.emit({ kind: "delta", text: "Working." });
    run.emit(native("ses_other"));
    expect(segmentsOf("a")[0]).toEqual({ type: "note", text: RESET });
    expect(find("a")?.text).toBe("Working.");
    expect(find("a")?.status).not.toContain(RESET);
    await run.finish();
    expect(stored("a")).toBe("ses_new");
  });

  it("(4) a reset turn that fails before any id keeps the stored id", async () => {
    usePlanStore.setState({ runs: [plan("a", "oc2:w:ses_old")] });
    const run = await startTurn("a");
    run.emit(notice("nativeSessionReset", RESET));
    await run.fail("bad model");
    expect(stored("a")).toBe("oc2:w:ses_old");
    expect(notes("a")).toEqual([{ type: "note", text: RESET }]);
  });

  it("(4a) the next turn sends the same id, resets again and is replaced", async () => {
    usePlanStore.setState({ runs: [plan("a", "oc2:w:ses_old")] });
    const first = await startTurn("a");
    first.emit(notice("nativeSessionReset", RESET));
    await first.fail("bad model");

    const second = await startTurn("a");
    expect(second.args.nativeSessionId).toBe("oc2:w:ses_old");
    second.emit(notice("nativeSessionReset", RESET));
    second.emit(native("ses_new"));
    expect(notes("a")).toEqual([{ type: "note", text: RESET }]);
    await second.finish();
    expect(stored("a")).toBe("ses_new");
  });

  it("(4b) the armed flag dies with its run", async () => {
    usePlanStore.setState({ runs: [plan("a", "oc2:w:ses_old")] });
    const first = await startTurn("a");
    first.emit(notice("nativeSessionReset", RESET));
    await first.fail("bad model");

    const second = await startTurn("a");
    second.emit(native("ses_x"));
    await second.finish();
    expect(stored("a")).toBe("oc2:w:ses_old");
  });

  it("(4c) one plan's notice never arms another plan's run", async () => {
    usePlanStore.setState({ runs: [plan("a"), plan("b", "ses_b")] });
    const runA = await startTurn("a");
    const runB = await startTurn("b");
    runA.emit(notice("nativeSessionRekey", ""));
    runB.emit(native("ses_y"));
    await runA.finish();
    await runB.finish();
    expect(stored("b")).toBe("ses_b");
  });

  it("(5) with none stored the first id is kept and later ones ignored", async () => {
    usePlanStore.setState({ runs: [plan("a")] });
    const run = await startTurn("a");
    run.emit(native("ses_first"));
    run.emit(native("ses_second"));
    await run.finish();
    expect(stored("a")).toBe("ses_first");
  });

  it("(6) sign-in notes: copied is silent, the others show, none touches the id", async () => {
    usePlanStore.setState({ runs: [plan("a", "ses_abc")] });
    const run = await startTurn("a");
    run.emit(notice("signInsCopied", "Copied this computer's sign-ins."));
    expect(segmentsOf("a")).toEqual([]);
    run.emit(notice("signInsNotCopied", "Could not copy the sign-ins."));
    run.emit(notice("noSignIns", "There were no sign-ins to copy."));
    run.emit(notice("futureCode", "Something new."));
    run.emit(notice("futureCode", ""));
    expect(segmentsOf("a")).toEqual([
      { type: "note", text: "Could not copy the sign-ins." },
      { type: "note", text: "There were no sign-ins to copy." },
      { type: "note", text: "Something new." },
    ]);
    await run.finish();
    expect(stored("a")).toBe("ses_abc");
  });

  it("(6) a sign-in or unknown notice never arms the replacement", async () => {
    usePlanStore.setState({ runs: [plan("a", "ses_abc")] });
    const first = await startTurn("a");
    first.emit(notice("signInsNotCopied", "Could not copy the sign-ins."));
    first.emit(native("ses_x"));
    await first.finish();
    expect(stored("a")).toBe("ses_abc");

    const second = await startTurn("a");
    second.emit(notice("futureCode", "Something new."));
    second.emit(native("ses_x"));
    await second.finish();
    expect(stored("a")).toBe("ses_abc");
  });

  for (const live of [null, "ses_live"]) {
    it(`(7) a turn a Restart replaced adds no note and stores no id (live id ${live})`, async () => {
      usePlanStore.setState({ runs: [plan("a", "ses_abc")] });
      const run = await startTurn("a");
      patchRun("a", { sessionId: "sid-restarted", nativeSessionId: live });
      run.emit(notice("nativeSessionReset", RESET));
      run.emit(native("x"));
      await run.settleStale();
      expect(notes("a")).toEqual([]);
      expect(stored("a")).toBe(live);
    });
  }

  it("(8) a plan removed mid-run takes no notice or id", async () => {
    usePlanStore.setState({ runs: [plan("a", "ses_abc")] });
    const run = await startTurn("a");
    usePlanStore.getState().remove("a");
    expect(() => {
      run.emit(notice("nativeSessionReset", RESET));
      run.emit(native("ses_new"));
    }).not.toThrow();
    await run.finish();
    expect(usePlanStore.getState().runs).toEqual([]);
  });
  it("(9) a cancelled armed turn's late id never replaces the next turn's", async () => {
    usePlanStore.setState({ runs: [plan("a", "oc2:w:ses_old")] });
    const a = await startTurn("a");
    a.emit(notice("nativeSessionReset", RESET));
    usePlanStore.getState().cancel("a");
    const b = await startTurn("a");
    b.emit(notice("nativeSessionReset", RESET));
    b.emit(native("ses_B"));
    a.emit(native("ses_A"));
    await b.finish();
    await a.settleStale();
    expect(stored("a")).toBe("ses_B");
  });

  it("(10) a cancelled turn's late output never reaches the next turn", async () => {
    usePlanStore.setState({ runs: [plan("a")] });
    const a = await startTurn("a");
    a.emit({ kind: "delta", text: "A1" });
    usePlanStore.getState().cancel("a");
    const b = await startTurn("a");
    b.emit({ kind: "delta", text: "B1" });
    a.emit({ kind: "delta", text: "A-late" });
    a.emit({ kind: "tool", tool: "read", target: "a.ts" });
    a.emit({ kind: "done", text: "A-late", costUsd: 9, isError: false });
    expect(find("a")?.text).toBe("B1");
    expect(segmentsOf("a")).toEqual([{ type: "text", text: "B1" }]);
    expect(find("a")?.costUsd).toBeNull();
    await a.settleStale();
    expect(find("a")?.generating).toBe(true);
    expect(find("a")?.error).toBeNull();
    await b.finish();
    expect(find("a")?.generating).toBe(false);
  });

  it("(11) a single turn is unaffected", async () => {
    usePlanStore.setState({ runs: [plan("a")] });
    const a = await startTurn("a");
    a.emit({ kind: "delta", text: BODY });
    a.emit({ kind: "tool", tool: "read", target: "a.ts" });
    a.emit({ kind: "done", text: BODY, costUsd: 0.5, isError: false });
    await a.finish();
    expect(find("a")?.text).toBe(BODY);
    expect(segmentsOf("a")).toEqual([
      { type: "text", text: BODY },
      { type: "tool", tool: "read", target: "a.ts" },
    ]);
    expect(find("a")?.costUsd).toBe(0.5);
    expect(find("a")?.generating).toBe(false);
    expect(find("a")?.draft).not.toBeNull();
  });

  it("(12) a run removed and re-added under its id refuses the old turn", async () => {
    usePlanStore.setState({ runs: [plan("a")] });
    const a = await startTurn("a");
    usePlanStore.getState().remove("a");
    usePlanStore.setState({ runs: [plan("a")] });
    a.emit({ kind: "delta", text: "A-late" });
    a.emit(notice("nativeSessionReset", RESET));
    a.emit(native("ses_A"));
    await a.settleStale();
    expect(find("a")?.text).toBe("");
    expect(find("a")?.draft).toBeNull();
    expect(stored("a")).toBeNull();
  });
  it("(13) a stopped turn still records its late id when no newer turn exists", async () => {
    usePlanStore.setState({ runs: [plan("a")] });
    const a = await startTurn("a");
    usePlanStore.getState().cancel("a");
    a.emit(native("ses_late"));
    a.emit({ kind: "delta", text: "late" });
    await a.settleStale();
    expect(stored("a")).toBe("ses_late");
    expect(find("a")?.text).toBe("");
    expect(find("a")?.generating).toBe(false);
  });

  it("(14) a stopped turn's reset still replaces the stored id, without its note", async () => {
    usePlanStore.setState({ runs: [plan("a", "oc2:w:ses_old")] });
    const a = await startTurn("a");
    usePlanStore.getState().cancel("a");
    a.emit(notice("nativeSessionReset", RESET));
    a.emit(native("ses_new"));
    await a.settleStale();
    expect(stored("a")).toBe("ses_new");
    expect(notes("a")).toEqual([]);
  });
  it("(15) a turn a later cancelled turn replaced never overwrites its id", async () => {
    usePlanStore.setState({ runs: [plan("a", "oc2:w:ses_old")] });
    const a = await startTurn("a");
    a.emit(notice("nativeSessionReset", RESET));
    usePlanStore.getState().cancel("a");
    const b = await startTurn("a");
    b.emit(notice("nativeSessionReset", RESET));
    b.emit(native("ses_B"));
    usePlanStore.getState().cancel("a");
    a.emit(native("ses_A"));
    await b.settleStale();
    await a.settleStale();
    expect(stored("a")).toBe("ses_B");
  });

  it("(16) of two cancelled turns only the last records its late id", async () => {
    usePlanStore.setState({ runs: [plan("a")] });
    const a = await startTurn("a");
    usePlanStore.getState().cancel("a");
    const b = await startTurn("a");
    usePlanStore.getState().cancel("a");
    a.emit(native("ses_A"));
    b.emit(native("ses_B"));
    await b.settleStale();
    await a.settleStale();
    expect(stored("a")).toBe("ses_B");
  });

  it.each(["old", "new"] as const)(
    "(17) Stop then Restart during turn-1 setup starts one turn, on the restart's session id (%s setup settles first)",
    async (first) => {
      const one = deferred<string | null>();
      const two = deferred<string | null>();
      vi.mocked(readRepoInstructions)
        .mockImplementationOnce(() => one.promise)
        .mockImplementationOnce(() => two.promise);
      const id = usePlanStore.getState().start(ARGS);
      const s1 = find(id)?.sessionId;
      usePlanStore.getState().cancel(id);
      usePlanStore.getState().restart(id);
      const s2 = find(id)?.sessionId;
      expect(s2).not.toBe(s1);
      for (const held of first === "old" ? [one, two] : [two, one]) {
        held.resolve(null);
        await flush();
      }
      expect(runs).toHaveLength(1);
      expect(runs[0].args.sessionId).toBe(s2);
      expect(runs[0].args.resume).toBe(false);
      runs[0].emit({ kind: "delta", text: BODY });
      expect(find(id)?.text).toBe(BODY);
      expect(find(id)?.generating).toBe(true);
      expect(find(id)?.stopped).toBe(false);
      runs[0].emit({ kind: "done", text: BODY, costUsd: 0.1, isError: false });
      runs[0].settle();
      await vi.waitFor(() => expect(find(id)?.generating).toBe(false));
      expect(find(id)?.draft).not.toBeNull();
    },
  );

  const PARTIAL = {
    text: "Partial.",
    segments: [{ type: "text", text: "Partial." }],
    costUsd: 0.2,
  } satisfies Partial<PlanRun>;
  it.each([
    {
      route: "start",
      begin: () => usePlanStore.getState().start(ARGS),
      kept: { text: "" },
    },
    {
      route: "restart",
      begin: () => {
        usePlanStore.setState({
          runs: [{ ...plan("a"), stopped: true, ...PARTIAL }],
        });
        usePlanStore.getState().restart("a");
        return "a";
      },
      kept: PARTIAL,
    },
  ])(
    "(18) a Stop during a turn's setup starts nothing and stays stopped ($route route)",
    async ({ begin, kept }) => {
      const held = deferred<string | null>();
      vi.mocked(readRepoInstructions).mockImplementationOnce(
        () => held.promise,
      );
      const id = begin();
      expect(find(id)?.generating).toBe(true);
      usePlanStore.getState().cancel(id);
      held.resolve(null);
      await flush();
      expect(runs).toEqual([]);
      expect(find(id)).toMatchObject({
        stopped: true,
        generating: false,
        error: null,
        ...kept,
      });
    },
  );

  it("(19) a follow-up sent after a Stop during setup keeps its turn", async () => {
    const held = deferred<string | null>();
    vi.mocked(readRepoInstructions).mockImplementationOnce(() => held.promise);
    const id = usePlanStore.getState().start(ARGS);
    usePlanStore.getState().cancel(id);
    usePlanStore.getState().sendFollowUp(id, "Tighten step 2");
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0].args.resume).toBe(true);
    held.resolve(null);
    await flush();
    expect(runs).toHaveLength(1);
    runs[0].emit({ kind: "delta", text: "B1" });
    expect(find(id)?.text).toBe("B1");
    expect(find(id)?.generating).toBe(true);
  });

  it("(20) a run dismissed during setup and re-added under its id starts nothing", async () => {
    const held = deferred<string | null>();
    vi.mocked(readRepoInstructions).mockImplementationOnce(() => held.promise);
    const id = usePlanStore.getState().start(ARGS);
    usePlanStore.getState().remove(id);
    usePlanStore.setState({ runs: [plan(id)] });
    held.resolve(null);
    await flush();
    expect(runs).toEqual([]);
    expect(find(id)?.generating).toBe(false);
  });

  it.each([
    {
      how: "Stop",
      leave: (id: string): string[] => {
        usePlanStore.getState().cancel(id);
        return [];
      },
      row: expect.objectContaining({
        stopped: true,
        generating: false,
        error: null,
      }),
    },
    {
      how: "Dismiss",
      leave: (id: string): string[] => {
        usePlanStore.getState().remove(id);
        return [];
      },
      row: undefined,
    },
    {
      how: "Stop then Restart",
      leave: (id: string): string[] => {
        usePlanStore.getState().cancel(id);
        usePlanStore.getState().restart(id);
        return [find(id)?.sessionId ?? ""];
      },
      row: expect.objectContaining({ generating: true, stopped: false }),
    },
    {
      how: "Stop then follow-up",
      leave: (id: string): string[] => {
        usePlanStore.getState().cancel(id);
        usePlanStore.getState().sendFollowUp(id, "Tighten step 3");
        return [`sid-${id}`];
      },
      row: expect.objectContaining({ generating: true, stopped: false }),
    },
  ])(
    "(21) a turn stopped during its tracked-files read starts nothing ($how)",
    async ({ leave, row }) => {
      usePlanStore.setState({ runs: [plan("a")] });
      const held = deferred<Awaited<ReturnType<typeof gitListTracked>>>();
      vi.mocked(gitListTracked).mockImplementationOnce(() => held.promise);
      usePlanStore.getState().sendFollowUp("a", "Tighten step 2");
      expect(find("a")?.generating).toBe(true);
      // The session ids of the turns that may start: only a newer turn's.
      const spawned = leave("a");
      held.resolve([]);
      await flush();
      expect(runs.map((r) => r.args.sessionId)).toEqual(spawned);
      expect(find("a")).toEqual(row);
    },
  );
});

describe("plan store: every Stop and Dismiss cancels its own turn's run id", () => {
  const cancelCalls = () => vi.mocked(cancelAgentSession).mock.calls;

  it("(22) [T4] a follow-up after a Stop during setup runs under a new run id", async () => {
    const held = deferred<string | null>();
    vi.mocked(readRepoInstructions).mockImplementationOnce(() => held.promise);
    const id = usePlanStore.getState().start(ARGS);
    usePlanStore.getState().cancel(id);
    expect(cancelCalls()).toHaveLength(1);
    const stoppedId = cancelCalls()[0][0];
    expect(stoppedId).not.toBe(find(id)?.sessionId);
    usePlanStore.getState().sendFollowUp(id, "Tighten step 2");
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0].args.runId).not.toBe(stoppedId);
    held.resolve(null);
    await flush();
    runs[0].settle();
  });

  it("(23) [T5] Dismiss cancels the generating turn by its run id", async () => {
    usePlanStore.setState({ runs: [plan("a")] });
    const turn = await startTurn("a");
    usePlanStore.getState().remove("a");
    expect(cancelCalls()).toEqual([[runs[0].args.runId]]);
    expect(runs[0].args.runId).not.toBe("sid-a");
    await turn.settleStale();
  });

  it("(24) [T7] Restart then Stop targets the new run", async () => {
    usePlanStore.setState({ runs: [plan("a")] });
    const first = await startTurn("a");
    usePlanStore.getState().cancel("a");
    await first.settleStale();
    usePlanStore.getState().restart("a");
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    usePlanStore.getState().cancel("a");
    expect(cancelCalls()).toEqual([[runs[0].args.runId], [runs[1].args.runId]]);
    expect(runs[1].args.runId).not.toBe(runs[0].args.runId);
    expect(runs[1].args.sessionId).not.toBe("sid-a");
    expect(runs[1].args.sessionId).toBe(find("a")?.sessionId);
    runs[1].settle();
    await flush();
  });
});
