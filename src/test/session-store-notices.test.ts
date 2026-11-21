import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendNativeSession } from "@/features/sessions/persistence";
import { type AgentSession, useSessionsStore } from "@/features/sessions/store";
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
vi.mock("@/features/sessions/persistence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/sessions/persistence")>()),
  loadPersistedSessions: vi.fn(async () => []),
  appendTurn: vi.fn(async () => undefined),
  appendResult: vi.fn(async () => undefined),
  appendNativeSession: vi.fn(async () => undefined),
}));
vi.mock("@/lib/git/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/worktree")>()),
  commitWorktreeAll: vi.fn(async () => null),
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
  finish: () => Promise<void>;
  fail: (message: string) => Promise<void>;
}

let runs: Run[] = [];

function session(id: string, nativeSessionId?: string): AgentSession {
  return {
    id,
    repoPath: "C:/repo",
    worktreePath: `C:/wt/${id}`,
    branch: `gd-${id}`,
    base: "base",
    headHash: "base",
    claudeSessionId: `cs-${id}`,
    model: "",
    effort: "",
    isolation: "worktree",
    agent: "opencode",
    ...(nativeSessionId ? { nativeSessionId } : {}),
    running: false,
    kept: false,
    turns: [],
  };
}

const find = (id: string) =>
  useSessionsStore.getState().sessions.find((s) => s.id === id);
const stored = (id: string) => find(id)?.nativeSessionId;
const segmentsOf = (id: string, turn: number) =>
  find(id)?.turns[turn]?.segments ?? [];

/** Starts one turn through the public `send` and returns its captured run. */
function startTurn(id: string): Run {
  const done = useSessionsStore.getState().send(id, "Do the thing");
  const run = runs[runs.length - 1];
  if (!run) throw new Error("runAgentSession was not called");
  return {
    ...run,
    finish: async () => {
      await run.finish();
      await done;
    },
    fail: async (message) => {
      await run.fail(message);
      await done;
    },
  };
}

beforeEach(() => {
  runs = [];
  vi.mocked(appendNativeSession).mockClear();
  vi.mocked(runAgentSession).mockImplementation(
    (args) =>
      new Promise<ReviewEvent | null>((resolve) => {
        runs.push({
          args,
          emit: args.onEvent,
          finish: async () => resolve(null),
          fail: async (message) => {
            args.onEvent({
              kind: "error",
              message,
              partialText: null,
              timedOut: false,
            });
            resolve(null);
          },
        });
      }),
  );
  useSessionsStore.setState({ sessions: [], hydrated: true, activeId: null });
});

const notice = (code: string, text: string): ReviewEvent => ({
  kind: "notice",
  code,
  text,
});
const native = (id: string): ReviewEvent => ({ kind: "nativeSession", id });

describe("sessions store: notices and the stored conversation id", () => {
  it("(1) a re-key replaces the stored id once and adds no note", async () => {
    useSessionsStore.setState({ sessions: [session("a", "ses_abc")] });
    const run = startTurn("a");
    run.emit(notice("nativeSessionRekey", ""));
    run.emit(native("oc2:w:ses_abc"));
    run.emit({ kind: "delta", text: "Working." });
    run.emit(native("oc2:w:ses_abc"));
    await run.finish();
    expect(stored("a")).toBe("oc2:w:ses_abc");
    expect(segmentsOf("a", 0).some((s) => s.type === "note")).toBe(false);
    expect(vi.mocked(appendNativeSession).mock.calls).toEqual([
      ["a", "oc2:w:ses_abc"],
    ]);
  });

  it("(2) a token already stored is left untouched", async () => {
    useSessionsStore.setState({ sessions: [session("a", "oc2:p:ses_abc")] });
    const run = startTurn("a");
    expect(run.args.nativeSessionId).toBe("oc2:p:ses_abc");
    run.emit(native("oc2:p:ses_abc"));
    await run.finish();
    expect(stored("a")).toBe("oc2:p:ses_abc");
    expect(appendNativeSession).not.toHaveBeenCalled();
  });

  it("(3) a reset shows its note and the first new id replaces the stored one", async () => {
    useSessionsStore.setState({ sessions: [session("a", "oc2:w:ses_old")] });
    const run = startTurn("a");
    run.emit(notice("nativeSessionReset", RESET));
    run.emit(native("ses_new"));
    run.emit({ kind: "delta", text: "Working." });
    run.emit(native("ses_other"));
    await run.finish();
    expect(stored("a")).toBe("ses_new");
    const segs = segmentsOf("a", 0);
    expect(segs[0]).toEqual({ type: "note", text: RESET });
    const turn = find("a")?.turns[0];
    expect(turn?.narration).toBe("Working.");
    expect(turn?.narration).not.toContain(RESET);
    expect(turn?.statusText).not.toContain(RESET);
    expect(turn?.error ?? "").not.toContain(RESET);
  });

  it("(4) a reset turn that fails before any id keeps the stored id", async () => {
    useSessionsStore.setState({ sessions: [session("a", "oc2:w:ses_old")] });
    const run = startTurn("a");
    run.emit(notice("nativeSessionReset", RESET));
    await run.fail("bad model");
    expect(stored("a")).toBe("oc2:w:ses_old");
    expect(segmentsOf("a", 0)).toContainEqual({ type: "note", text: RESET });
    expect(appendNativeSession).not.toHaveBeenCalled();
  });

  it("(4a) the next turn sends the same id, resets again and is replaced", async () => {
    useSessionsStore.setState({ sessions: [session("a", "oc2:w:ses_old")] });
    const first = startTurn("a");
    first.emit(notice("nativeSessionReset", RESET));
    await first.fail("bad model");

    const second = startTurn("a");
    expect(second.args.nativeSessionId).toBe("oc2:w:ses_old");
    second.emit(notice("nativeSessionReset", RESET));
    second.emit(native("ses_new"));
    await second.finish();
    expect(stored("a")).toBe("ses_new");
    expect(segmentsOf("a", 1)).toContainEqual({ type: "note", text: RESET });
  });

  it("(4b) the armed flag dies with its run", async () => {
    useSessionsStore.setState({ sessions: [session("a", "oc2:w:ses_old")] });
    const first = startTurn("a");
    first.emit(notice("nativeSessionReset", RESET));
    await first.fail("bad model");

    const second = startTurn("a");
    second.emit(native("ses_x"));
    await second.finish();
    expect(stored("a")).toBe("oc2:w:ses_old");
  });

  it("(4c) one session's notice never arms another session's run", async () => {
    useSessionsStore.setState({
      sessions: [session("a"), session("b", "ses_b")],
    });
    const runA = startTurn("a");
    const runB = startTurn("b");
    runA.emit(notice("nativeSessionRekey", ""));
    runB.emit(native("ses_y"));
    await runA.finish();
    await runB.finish();
    expect(stored("b")).toBe("ses_b");
  });

  it("(5) with none stored the first id is kept and later ones ignored", async () => {
    useSessionsStore.setState({ sessions: [session("a")] });
    const run = startTurn("a");
    run.emit(native("ses_first"));
    run.emit(native("ses_second"));
    await run.finish();
    expect(stored("a")).toBe("ses_first");
  });

  it("(6) sign-in notes: copied is silent, the others show, none touches the id", async () => {
    useSessionsStore.setState({ sessions: [session("a", "ses_abc")] });
    const run = startTurn("a");
    run.emit(notice("signInsCopied", "Copied this computer's sign-ins."));
    expect(segmentsOf("a", 0)).toEqual([]);
    run.emit(notice("signInsNotCopied", "Could not copy the sign-ins."));
    run.emit(notice("noSignIns", "There were no sign-ins to copy."));
    run.emit(notice("futureCode", "Something new."));
    run.emit(notice("futureCode", ""));
    await run.finish();
    expect(segmentsOf("a", 0)).toEqual([
      { type: "note", text: "Could not copy the sign-ins." },
      { type: "note", text: "There were no sign-ins to copy." },
      { type: "note", text: "Something new." },
    ]);
    expect(stored("a")).toBe("ses_abc");
  });

  it("(6) a sign-in or unknown notice never arms the replacement", async () => {
    useSessionsStore.setState({ sessions: [session("a", "ses_abc")] });
    const first = startTurn("a");
    first.emit(notice("signInsNotCopied", "Could not copy the sign-ins."));
    first.emit(native("ses_x"));
    await first.finish();
    expect(stored("a")).toBe("ses_abc");

    const second = startTurn("a");
    second.emit(notice("futureCode", "Something new."));
    second.emit(native("ses_x"));
    await second.finish();
    expect(stored("a")).toBe("ses_abc");
  });

  it("(7) a run that lost the last turn never rebinds, and its note stays in its own turn", async () => {
    useSessionsStore.setState({ sessions: [session("a", "ses_abc")] });
    const run = startTurn("a");
    // A cancel + a fresh prompt appends a newer last turn while this run is live.
    useSessionsStore.setState({
      sessions: useSessionsStore.getState().sessions.map((s) => ({
        ...s,
        turns: [
          ...s.turns,
          {
            prompt: "Newer",
            narration: "",
            status: "running",
            statusText: "",
            segments: [],
            commitHash: null,
            costUsd: null,
            error: null,
          },
        ],
      })),
    });
    run.emit(notice("nativeSessionRekey", ""));
    run.emit(native("x"));
    run.emit(notice("signInsNotCopied", "Could not copy the sign-ins."));
    await run.finish();
    expect(stored("a")).toBe("ses_abc");
    expect(appendNativeSession).not.toHaveBeenCalled();
    expect(segmentsOf("a", 0)).toEqual([
      { type: "note", text: "Could not copy the sign-ins." },
    ]);
    expect(segmentsOf("a", 1)).toEqual([]);
  });

  it("(8) a session removed mid-run takes no notice or id", async () => {
    useSessionsStore.setState({ sessions: [session("a", "ses_abc")] });
    const run = startTurn("a");
    useSessionsStore.setState({ sessions: [] });
    expect(() => {
      run.emit(notice("nativeSessionReset", RESET));
      run.emit(native("ses_new"));
    }).not.toThrow();
    await run.finish();
    expect(useSessionsStore.getState().sessions).toEqual([]);
    expect(appendNativeSession).not.toHaveBeenCalled();
  });
});
