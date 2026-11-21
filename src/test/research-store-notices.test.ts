import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ResearchRun, useResearchStore } from "@/features/research/store";
import {
  type AgentSessionArgs,
  type ReviewEvent,
  runAgentSession,
} from "@/lib/ai/agent";

vi.mock("@/lib/ai/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/agent")>()),
  runAgentSession: vi.fn(),
  cancelAgentSession: vi.fn(async () => undefined),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  readRepoInstructions: vi.fn(async () => null),
}));
vi.mock("@/features/research/persistence", () => ({
  loadPersistedResearch: vi.fn(async () => []),
  savePersistedResearch: vi.fn(async () => undefined),
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
  vi.mocked(runAgentSession).mockImplementation(
    (args) =>
      new Promise<ReviewEvent | null>((resolve) => {
        runs.push({ args, emit: args.onEvent, settle: () => resolve(null) });
      }),
  );
  useResearchStore.setState({
    runs: [],
    hydrated: true,
    activeResearchId: null,
  });
});

const notice = (code: string, text: string): ReviewEvent => ({
  kind: "notice",
  code,
  text,
});
const native = (id: string): ReviewEvent => ({ kind: "nativeSession", id });
const notes = (id: string) => segmentsOf(id).filter((s) => s.type === "note");

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
});
