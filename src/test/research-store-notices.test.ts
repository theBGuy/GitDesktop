import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  distillPhase,
  type ResearchGenerateArgs,
  type ResearchRun,
  useResearchStore,
} from "@/features/research/store";
import {
  type AgentSessionArgs,
  cancelAgentSession,
  type ReviewEvent,
  runAgentSession,
} from "@/lib/ai/agent";
import { readRepoInstructions } from "@/lib/git/api";
import { toastError } from "@/lib/toast";

vi.mock("@/lib/ai/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/agent")>()),
  runAgentSession: vi.fn(),
  cancelAgentSession: vi.fn(async () => undefined),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  readRepoInstructions: vi.fn(async () => null),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(async () => ({ globalInstructions: "" })),
}));
vi.mock("@/features/research/persistence", () => ({
  loadPersistedResearch: vi.fn(async () => []),
  savePersistedResearch: vi.fn(async () => undefined),
}));
vi.mock("@/lib/notifications/emit", () => ({ emitNotification: vi.fn() }));
vi.mock("@/lib/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/toast")>()),
  toastError: vi.fn(),
}));
vi.mock("@/features/sessions/watching", () => ({
  isWatchingAgentSurface: () => true,
}));

const RESET =
  "GitDesktop could not continue the earlier opencode conversation, so this turn started a new one. The agent does not remember the earlier turns.";

interface Run {
  args: AgentSessionArgs;
  emit: (ev: ReviewEvent) => void;
  settle: (v?: ReviewEvent | null) => void;
}

let runs: Run[] = [];

function research(
  id: string,
  nativeSessionId: string | null = null,
): ResearchRun {
  return {
    id,
    repoPath: "C:/repo",
    agent: "opencode",
    model: "",
    effort: "",
    depth: "deep",
    sessionId: `sid-${id}`,
    nativeSessionId,
    origin: { topic: "Topic", depth: "deep" },
    seed: null,
    generating: false,
    stopped: false,
    text: "",
    status: "",
    segments: [],
    report: null,
    costUsd: null,
    reportPath: null,
    error: null,
  };
}

const find = (id: string) =>
  useResearchStore.getState().runs.find((r) => r.id === id);
const stored = (id: string) => find(id)?.nativeSessionId;
const segmentsOf = (id: string) => find(id)?.segments ?? [];
const patchRun = (id: string, p: Partial<ResearchRun>) =>
  useResearchStore.setState({
    runs: useResearchStore
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
  useResearchStore.getState().sendFollowUp(id, "Go deeper", "deep", "");
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
        runs.push({
          args,
          emit: args.onEvent,
          settle: (v: ReviewEvent | null = null) => resolve(v),
        });
      }),
  );
  // Reset, so a held read a failed test queued never leaks into the next.
  vi.mocked(readRepoInstructions).mockReset();
  vi.mocked(readRepoInstructions).mockResolvedValue(null);
  useResearchStore.setState({
    runs: [],
    hydrated: true,
    activeResearchId: null,
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const ARGS: ResearchGenerateArgs = {
  repoPath: "C:/repo",
  agent: "opencode",
  model: "",
  effort: "",
  topic: "Topic",
  depth: "deep",
};

const notice = (code: string, text: string): ReviewEvent => ({
  kind: "notice",
  code,
  text,
});
const native = (id: string): ReviewEvent => ({ kind: "nativeSession", id });
const notes = (id: string) => segmentsOf(id).filter((s) => s.type === "note");
const BODY = "# Findings\n\nThe cache is per repository.";

describe("research store: notices and the stored conversation id", () => {
  it("(1) a re-key replaces the stored id once and adds no note", async () => {
    useResearchStore.setState({ runs: [research("a", "ses_abc")] });
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
    useResearchStore.setState({ runs: [research("a", "oc2:p:ses_abc")] });
    const run = await startTurn("a");
    expect(run.args.nativeSessionId).toBe("oc2:p:ses_abc");
    run.emit(native("oc2:p:ses_abc"));
    await run.finish();
    expect(stored("a")).toBe("oc2:p:ses_abc");
  });

  it("(3) a reset shows its note and the first new id replaces the stored one", async () => {
    useResearchStore.setState({ runs: [research("a", "oc2:w:ses_old")] });
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
    useResearchStore.setState({ runs: [research("a", "oc2:w:ses_old")] });
    const run = await startTurn("a");
    run.emit(notice("nativeSessionReset", RESET));
    await run.fail("bad model");
    expect(stored("a")).toBe("oc2:w:ses_old");
    expect(notes("a")).toEqual([{ type: "note", text: RESET }]);
  });

  it("(4a) the next turn sends the same id, resets again and is replaced", async () => {
    useResearchStore.setState({ runs: [research("a", "oc2:w:ses_old")] });
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
    useResearchStore.setState({ runs: [research("a", "oc2:w:ses_old")] });
    const first = await startTurn("a");
    first.emit(notice("nativeSessionReset", RESET));
    await first.fail("bad model");

    const second = await startTurn("a");
    second.emit(native("ses_x"));
    await second.finish();
    expect(stored("a")).toBe("oc2:w:ses_old");
  });

  it("(4c) one research run's notice never arms another's", async () => {
    useResearchStore.setState({
      runs: [research("a"), research("b", "ses_b")],
    });
    const runA = await startTurn("a");
    const runB = await startTurn("b");
    runA.emit(notice("nativeSessionRekey", ""));
    runB.emit(native("ses_y"));
    await runA.finish();
    await runB.finish();
    expect(stored("b")).toBe("ses_b");
  });

  it("(5) with none stored the first id is kept and later ones ignored", async () => {
    useResearchStore.setState({ runs: [research("a")] });
    const run = await startTurn("a");
    run.emit(native("ses_first"));
    run.emit(native("ses_second"));
    await run.finish();
    expect(stored("a")).toBe("ses_first");
  });

  it("(6) sign-in notes: copied is silent, the others show, none touches the id", async () => {
    useResearchStore.setState({ runs: [research("a", "ses_abc")] });
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
    useResearchStore.setState({ runs: [research("a", "ses_abc")] });
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
      useResearchStore.setState({ runs: [research("a", "ses_abc")] });
      const run = await startTurn("a");
      patchRun("a", { sessionId: "sid-restarted", nativeSessionId: live });
      run.emit(notice("nativeSessionReset", RESET));
      run.emit(native("x"));
      await run.settleStale();
      expect(notes("a")).toEqual([]);
      expect(stored("a")).toBe(live);
    });
  }

  it("(8) a research run removed mid-run takes no notice or id", async () => {
    useResearchStore.setState({ runs: [research("a", "ses_abc")] });
    const run = await startTurn("a");
    useResearchStore.getState().remove("a");
    expect(() => {
      run.emit(notice("nativeSessionReset", RESET));
      run.emit(native("ses_new"));
    }).not.toThrow();
    await run.finish();
    expect(useResearchStore.getState().runs).toEqual([]);
  });
  it("(9) a cancelled armed turn's late id never replaces the next turn's", async () => {
    useResearchStore.setState({ runs: [research("a", "oc2:w:ses_old")] });
    const a = await startTurn("a");
    a.emit(notice("nativeSessionReset", RESET));
    useResearchStore.getState().cancel("a");
    const b = await startTurn("a");
    b.emit(notice("nativeSessionReset", RESET));
    b.emit(native("ses_B"));
    a.emit(native("ses_A"));
    await b.finish();
    await a.settleStale();
    expect(stored("a")).toBe("ses_B");
  });

  it("(10) a cancelled turn's late output never reaches the next turn", async () => {
    useResearchStore.setState({ runs: [research("a")] });
    const a = await startTurn("a");
    a.emit({ kind: "delta", text: "A1" });
    useResearchStore.getState().cancel("a");
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
    useResearchStore.setState({ runs: [research("a")] });
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
    expect(find("a")?.report).not.toBeNull();
  });

  it("(12) a run removed and re-added under its id refuses the old turn", async () => {
    useResearchStore.setState({ runs: [research("a")] });
    const a = await startTurn("a");
    useResearchStore.getState().remove("a");
    useResearchStore.setState({ runs: [research("a")] });
    a.emit({ kind: "delta", text: "A-late" });
    a.emit(notice("nativeSessionReset", RESET));
    a.emit(native("ses_A"));
    await a.settleStale();
    expect(find("a")?.text).toBe("");
    expect(find("a")?.report).toBeNull();
    expect(stored("a")).toBeNull();
  });
  it("(13) a stopped turn still records its late id when no newer turn exists", async () => {
    useResearchStore.setState({ runs: [research("a")] });
    const a = await startTurn("a");
    useResearchStore.getState().cancel("a");
    a.emit(native("ses_late"));
    a.emit({ kind: "delta", text: "late" });
    await a.settleStale();
    expect(stored("a")).toBe("ses_late");
    expect(find("a")?.text).toBe("");
    expect(find("a")?.generating).toBe(false);
  });

  it("(14) a stopped turn's reset still replaces the stored id, without its note", async () => {
    useResearchStore.setState({ runs: [research("a", "oc2:w:ses_old")] });
    const a = await startTurn("a");
    useResearchStore.getState().cancel("a");
    a.emit(notice("nativeSessionReset", RESET));
    a.emit(native("ses_new"));
    await a.settleStale();
    expect(stored("a")).toBe("ses_new");
    expect(notes("a")).toEqual([]);
  });
  it("(15) a turn a later cancelled turn replaced never overwrites its id", async () => {
    useResearchStore.setState({ runs: [research("a", "oc2:w:ses_old")] });
    const a = await startTurn("a");
    a.emit(notice("nativeSessionReset", RESET));
    useResearchStore.getState().cancel("a");
    const b = await startTurn("a");
    b.emit(notice("nativeSessionReset", RESET));
    b.emit(native("ses_B"));
    useResearchStore.getState().cancel("a");
    a.emit(native("ses_A"));
    await b.settleStale();
    await a.settleStale();
    expect(stored("a")).toBe("ses_B");
  });

  it("(16) of two cancelled turns only the last records its late id", async () => {
    useResearchStore.setState({ runs: [research("a")] });
    const a = await startTurn("a");
    useResearchStore.getState().cancel("a");
    const b = await startTurn("a");
    useResearchStore.getState().cancel("a");
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
      const id = useResearchStore.getState().start(ARGS);
      const s1 = find(id)?.sessionId;
      useResearchStore.getState().cancel(id);
      useResearchStore.getState().restart(id);
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
      expect(find(id)?.report).not.toBeNull();
    },
  );

  const PARTIAL = {
    text: "Partial.",
    segments: [{ type: "text", text: "Partial." }],
    costUsd: 0.2,
  } satisfies Partial<ResearchRun>;
  it.each([
    {
      route: "start",
      begin: () => useResearchStore.getState().start(ARGS),
      kept: { text: "" },
    },
    {
      route: "restart",
      begin: () => {
        useResearchStore.setState({
          runs: [{ ...research("a"), stopped: true, ...PARTIAL }],
        });
        useResearchStore.getState().restart("a");
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
      useResearchStore.getState().cancel(id);
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
    const id = useResearchStore.getState().start(ARGS);
    useResearchStore.getState().cancel(id);
    useResearchStore.getState().sendFollowUp(id, "Go deeper", "deep", "");
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
    const id = useResearchStore.getState().start(ARGS);
    useResearchStore.getState().remove(id);
    useResearchStore.setState({ runs: [research(id)] });
    held.resolve(null);
    await flush();
    expect(runs).toEqual([]);
    expect(find(id)?.generating).toBe(false);
  });
});

describe("research store: every Stop and Dismiss cancels its own run id", () => {
  const cancelCalls = () => vi.mocked(cancelAgentSession).mock.calls;

  it("(21) [T4] a follow-up after a Stop during setup runs under a new run id", async () => {
    const held = deferred<string | null>();
    vi.mocked(readRepoInstructions).mockImplementationOnce(() => held.promise);
    const id = useResearchStore.getState().start(ARGS);
    useResearchStore.getState().cancel(id);
    expect(cancelCalls()).toHaveLength(1);
    const stoppedId = cancelCalls()[0][0];
    expect(stoppedId).not.toBe(find(id)?.sessionId);
    useResearchStore.getState().sendFollowUp(id, "Go deeper", "deep", "");
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0].args.runId).not.toBe(stoppedId);
    held.resolve(null);
    await flush();
    runs[0].settle();
  });

  it("(22) [T5] Dismiss cancels the generating turn by its run id", async () => {
    useResearchStore.setState({ runs: [research("a")] });
    const turn = await startTurn("a");
    useResearchStore.getState().remove("a");
    expect(cancelCalls()).toEqual([[runs[0].args.runId]]);
    expect(runs[0].args.runId).not.toBe("sid-a");
    await turn.settleStale();
  });

  it("(23) [T7] Restart then Stop targets the new run", async () => {
    useResearchStore.setState({ runs: [research("a")] });
    const first = await startTurn("a");
    useResearchStore.getState().cancel("a");
    await first.settleStale();
    useResearchStore.getState().restart("a");
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    useResearchStore.getState().cancel("a");
    expect(cancelCalls()).toEqual([[runs[0].args.runId], [runs[1].args.runId]]);
    expect(runs[1].args.runId).not.toBe(runs[0].args.runId);
    expect(runs[1].args.sessionId).not.toBe("sid-a");
    expect(runs[1].args.sessionId).toBe(find("a")?.sessionId);
    runs[1].settle();
    await flush();
  });

  it("(24) [T6] a distill cancels by its own run id, and the next turn gets another", async () => {
    useResearchStore.setState({
      runs: [
        {
          ...research("a"),
          agent: "claude",
          report: { title: "T", report: BODY },
        },
      ],
    });
    const p = useResearchStore.getState().distillPlanBrief("a");
    expect(runs).toHaveLength(1);
    useResearchStore.getState().cancel("a");
    expect(cancelCalls()).toEqual([[runs[0].args.runId]]);
    expect(runs[0].args.runId).not.toBe("sid-a");
    runs[0].settle();
    await p;
    await startTurn("a");
    expect(runs[1].args.runId).not.toBe(runs[0].args.runId);
    useResearchStore.getState().cancel("a");
    expect(cancelAgentSession).toHaveBeenLastCalledWith(runs[1].args.runId);
    runs[1].settle();
    await flush();
  });
});

describe("distill", () => {
  const claudeRun: ResearchRun = {
    ...research("a"),
    agent: "claude",
    report: { title: "T", report: BODY },
  };
  const store = () => useResearchStore.getState();
  const cancelCalls = () => vi.mocked(cancelAgentSession).mock.calls;
  const flags = () => ({
    distilling: find("a")?.distilling,
    distillStopping: find("a")?.distillStopping,
  });
  const IDLE = { distilling: false, distillStopping: false };
  const done = (text: string, costUsd: number | null): ReviewEvent => ({
    kind: "done",
    text,
    costUsd,
    isError: false,
  });

  beforeEach(() => {
    vi.mocked(cancelAgentSession).mockClear();
    vi.mocked(toastError).mockClear();
    useResearchStore.setState({ runs: [claudeRun] });
  });

  it("D1 a Stop holds the run until the stopped distill settles; a re-click starts nothing", async () => {
    const p1 = store().distillPlanBrief("a");
    runs[0].emit({ kind: "delta", text: "narr" });
    store().cancel("a");
    expect(flags()).toEqual({ distilling: true, distillStopping: true });
    expect(cancelCalls()).toEqual([[runs[0].args.runId]]);
    const p2 = store().distillPlanBrief("a");
    expect(await p2).toBeNull();
    expect(runs).toHaveLength(1);
    runs[0].settle();
    expect(await p1).toBeNull();
    expect(flags()).toEqual(IDLE);
  });

  it("D2a a stopped distill that still returns a terminal event hands off raw", async () => {
    const p = store().distillPlanBrief("a");
    store().cancel("a");
    const ev = done("BRIEF", 0.3);
    runs[0].emit(ev);
    runs[0].settle(ev);
    expect(await p).toBeNull();
    expect(find("a")?.costUsd).toBeNull();
    expect(flags()).toEqual(IDLE);
  });

  it("D2b a distill whose command returns null with no Stop hands off raw", async () => {
    const p = store().distillPlanBrief("a");
    runs[0].emit({ kind: "delta", text: "narr" });
    runs[0].settle(null);
    expect(await p).toBeNull();
    expect(flags()).toEqual(IDLE);
  });

  it("D3 a finished distill returns its brief", async () => {
    const p = store().distillPlanBrief("a");
    runs[0].emit({ kind: "delta", text: "narr" });
    const ev = done("## Brief\n\nDo X.", 0.2);
    runs[0].emit(ev);
    runs[0].settle(ev);
    expect(await p).toBe("## Brief\n\nDo X.");
    expect(flags()).toEqual(IDLE);
    expect(find("a")?.costUsd).toBe(0.2);
  });

  it("D3b an error event or a rejected invoke returns null without throwing", async () => {
    const p1 = store().distillPlanBrief("a");
    runs[0].emit({
      kind: "error",
      message: "boom",
      partialText: null,
      timedOut: false,
    });
    runs[0].settle(null);
    expect(await p1).toBeNull();
    expect(flags()).toEqual(IDLE);

    vi.mocked(runAgentSession).mockImplementationOnce(() =>
      Promise.reject(new Error("x")),
    );
    const p2 = store().distillPlanBrief("a");
    expect(await p2).toBeNull();
    expect(flags()).toEqual(IDLE);
  });

  it("D4 a follow-up during stopping starts nothing, and nothing is queued", async () => {
    const p = store().distillPlanBrief("a");
    store().cancel("a");
    store().sendFollowUp("a", "more", "deep", "");
    await flush();
    expect(runs).toHaveLength(1);
    runs[0].settle();
    await p;
    await flush();
    expect(runs).toHaveLength(1);
    store().sendFollowUp("a", "more", "deep", "");
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    await flush();
    expect(runs).toHaveLength(2);
    runs[1].settle();
    await flush();
  });

  it("D5a Dismiss stops a running distill", async () => {
    const p = store().distillPlanBrief("a");
    store().remove("a");
    expect(cancelCalls()).toEqual([[runs[0].args.runId]]);
    runs[0].settle();
    expect(await p).toBeNull();
    expect(find("a")).toBeUndefined();
  });

  it("D5b Dismiss after a Stop re-sends the cancel and the late settle writes nothing", async () => {
    const p = store().distillPlanBrief("a");
    store().cancel("a");
    store().remove("a");
    expect(cancelCalls()).toEqual([[runs[0].args.runId], [runs[0].args.runId]]);
    runs[0].settle();
    expect(await p).toBeNull();
    expect(find("a")).toBeUndefined();
  });

  it("D6 a new distill after a stopped one settled works", async () => {
    const p1 = store().distillPlanBrief("a");
    store().cancel("a");
    runs[0].settle();
    await p1;
    const p2 = store().distillPlanBrief("a");
    expect(runs).toHaveLength(2);
    expect(runs[1].args.runId).not.toBe(runs[0].args.runId);
    expect(flags()).toEqual({ distilling: true, distillStopping: false });
    const ev = done("BRIEF", null);
    runs[1].emit(ev);
    runs[1].settle(ev);
    expect(await p2).toBe("BRIEF");
    expect(flags()).toEqual(IDLE);
  });

  it("D9 a stuck distill flag with no owner clears on Stop", () => {
    useResearchStore.setState({ runs: [{ ...claudeRun, distilling: true }] });
    store().cancel("a");
    expect(flags()).toEqual(IDLE);
    expect(cancelCalls()).toEqual([]);
  });

  it("D10a a Stop whose cancel fails gives the Stop back", async () => {
    const err = new Error("ipc down");
    vi.mocked(cancelAgentSession).mockRejectedValueOnce(err);
    const p = store().distillPlanBrief("a");
    store().cancel("a");
    expect(find("a")?.distillStopping).toBe(true);
    await flush();
    expect(flags()).toEqual({ distilling: true, distillStopping: false });
    expect(distillPhase(find("a") ?? {})).toBe("distilling");
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(err);
    store().cancel("a");
    expect(cancelCalls()).toEqual([[runs[0].args.runId], [runs[0].args.runId]]);
    expect(find("a")?.distillStopping).toBe(true);
    await flush();
    const ev = done("BRIEF", null);
    runs[0].emit(ev);
    runs[0].settle(ev);
    expect(await p).toBeNull();
    expect(flags()).toEqual(IDLE);
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("D10b a reverted Stop lets the distill return its brief", async () => {
    vi.mocked(cancelAgentSession).mockRejectedValueOnce(new Error("ipc down"));
    const p = store().distillPlanBrief("a");
    store().cancel("a");
    await flush();
    const ev = done("BRIEF", null);
    runs[0].emit(ev);
    runs[0].settle(ev);
    expect(await p).toBe("BRIEF");
    expect(flags()).toEqual(IDLE);
  });

  it("D10c a cancel that fails after the distill settled changes nothing", async () => {
    let reject!: (e: Error) => void;
    const held = new Promise<void>((_, rej) => {
      reject = rej;
    });
    vi.mocked(cancelAgentSession).mockImplementationOnce(() => held);
    const p = store().distillPlanBrief("a");
    store().cancel("a");
    runs[0].settle();
    expect(await p).toBeNull();
    expect(flags()).toEqual(IDLE);
    reject(new Error("late"));
    await flush();
    expect(flags()).toEqual(IDLE);
    expect(toastError).not.toHaveBeenCalled();
  });
});
