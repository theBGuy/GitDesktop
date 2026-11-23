import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendEffort,
  appendModel,
  appendResult,
  appendTurn,
  createTranscript,
} from "@/features/sessions/persistence";
import {
  type AgentSession,
  transcriptWritesSettled,
  useSessionsStore,
} from "@/features/sessions/store";
import { isWatchingAgentSurface } from "@/features/sessions/watching";
import {
  type AgentSessionArgs,
  cancelAgentSession,
  type ReviewEvent,
  runAgentSession,
} from "@/lib/ai/agent";
import { presentError } from "@/lib/error-summary";
import { repoIdentity } from "@/lib/git/repo-identity";
import { commitWorktreeAll, removeWorktree } from "@/lib/git/worktree";
import { emitNotification } from "@/lib/notifications/emit";
import { loadSettings } from "@/lib/settings/api";
import { invoke } from "@/lib/tauri/invoke";
import { unmockedCommands } from "./setup";

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage: (message: unknown) => void = () => undefined;
  },
}));
vi.mock("@/lib/tauri/invoke", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/tauri/invoke")>();
  return { ...original, invoke: vi.fn(original.invoke) };
});
vi.mock("@/lib/ai/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/agent")>()),
  runAgentSession: vi.fn(),
  cancelAgentSession: vi.fn(async () => undefined),
}));
vi.mock("@/lib/ai/sandbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/sandbox")>()),
  cleanupContainerSandbox: vi.fn(async () => undefined),
  stopTestContainer: vi.fn(async () => undefined),
}));
vi.mock("@/features/sessions/persistence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/sessions/persistence")>()),
  loadPersistedSessions: vi.fn(async () => []),
  createTranscript: vi.fn(async () => undefined),
  appendTurn: vi.fn(async () => undefined),
  appendResult: vi.fn(async () => undefined),
  appendNativeSession: vi.fn(async () => undefined),
  appendModel: vi.fn(async () => undefined),
  appendEffort: vi.fn(async () => undefined),
  removeTranscript: vi.fn(async () => undefined),
  setKept: vi.fn(async () => undefined),
}));
vi.mock("@/lib/git/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/worktree")>()),
  createWorktree: vi.fn(async () => ({
    id: "wt-1",
    path: "C:/wt/wt-1",
    branch: "gd/session/wt-1",
    base: "base",
  })),
  commitWorktreeAll: vi.fn(async () => null),
  pruneWorktrees: vi.fn(async () => undefined),
  listWorktrees: vi.fn(async () => []),
  removeWorktree: vi.fn(async () => ({ branchCleanup: "deleted" })),
  squashWorktree: vi.fn(async () => undefined),
  resumeWorktree: vi.fn(async () => undefined),
}));
vi.mock("@/lib/git/repo-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/repo-identity")>()),
  repoIdentity: vi.fn(async (path: string) => path),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(async () => ({ mcpServers: [] })),
}));
vi.mock("@/lib/notifications/emit", () => ({ emitNotification: vi.fn() }));
vi.mock("@/features/sessions/watching", () => ({
  isWatchingAgentSurface: vi.fn(() => true),
}));
vi.mock("@/lib/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/toast")>()),
  toastError: vi.fn(),
}));

interface Run {
  args: AgentSessionArgs;
  finish: () => void;
}

let runs: Run[] = [];

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function session(id: string, mcpServers?: string[]): AgentSession {
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
    agent: "claude",
    ...(mcpServers ? { mcpServers } : {}),
    running: false,
    kept: false,
    turns: [],
  };
}

const store = () => useSessionsStore.getState();
const find = (id: string) => store().sessions.find((s) => s.id === id);
const cancelCalls = () => vi.mocked(cancelAgentSession).mock.calls;

/** Holds the next `repoIdentity` read until the returned release is called. */
function holdRepoIdentity() {
  const d = deferred<string>();
  vi.mocked(repoIdentity).mockImplementationOnce(() => d.promise);
  return () => d.resolve("C:/repo");
}

afterAll(() => expect(unmockedCommands).toEqual([]));

beforeEach(async () => {
  // A write queued by the previous test lands before this one's mocks reset.
  await transcriptWritesSettled();
  const transport =
    await vi.importActual<typeof import("@/lib/tauri/invoke")>(
      "@/lib/tauri/invoke",
    );
  vi.mocked(invoke).mockClear();
  vi.mocked(invoke).mockImplementation(transport.invoke);
  runs = [];
  vi.mocked(cancelAgentSession).mockClear();
  vi.mocked(cancelAgentSession).mockImplementation(async () => undefined);
  vi.mocked(appendResult).mockClear();
  vi.mocked(removeWorktree).mockClear();
  vi.mocked(commitWorktreeAll).mockClear();
  vi.mocked(emitNotification).mockClear();
  vi.mocked(isWatchingAgentSurface).mockReturnValue(true);
  vi.mocked(runAgentSession).mockImplementation(
    (args) =>
      new Promise<ReviewEvent | null>((resolve) => {
        runs.push({ args, finish: () => resolve(null) });
      }),
  );
  useSessionsStore.setState({
    sessions: [],
    hydrated: true,
    activeId: null,
    busyId: null,
    creating: false,
  });
});

describe("sessions store: every Stop cancels its own turn's run id", () => {
  it("[T1] send, Stop, send, Stop cancels each turn by its own run id", async () => {
    useSessionsStore.setState({ sessions: [session("a")] });
    void store().send("a", "one");
    await store().cancel("a");
    void store().send("a", "two");
    await store().cancel("a");
    expect(runs).toHaveLength(2);
    expect(cancelCalls()).toEqual([[runs[0].args.runId], [runs[1].args.runId]]);
    expect(runs[0].args.runId).not.toBe(runs[1].args.runId);
    expect(runs[0].args.runId).not.toBe("cs-a");
    expect(runs[1].args.runId).not.toBe("cs-a");
    expect(runs[0].args.sessionId).toBe("cs-a");
    expect(runs[1].args.sessionId).toBe("cs-a");
    for (const r of runs) r.finish();
  });

  it("[T2] a Stop during Committing never reaches the next turn", async () => {
    useSessionsStore.setState({ sessions: [session("a")] });
    const commit = deferred<string | null>();
    vi.mocked(commitWorktreeAll).mockImplementationOnce(() => commit.promise);
    const first = store().send("a", "one");
    runs[0].finish();
    await vi.waitFor(() =>
      expect(find("a")?.turns[0]?.status).toBe("committing"),
    );
    await store().cancel("a");
    commit.resolve(null);
    await first;
    void store().send("a", "two");
    expect(runs).toHaveLength(2);
    expect(cancelCalls()).toEqual([[runs[0].args.runId]]);
    expect(cancelCalls()[0][0]).not.toBe(runs[1].args.runId);
    runs[1].finish();
  });

  it("[T3] send then Stop with no await between cancels the new run", async () => {
    useSessionsStore.setState({ sessions: [session("a")] });
    void store().send("a", "one");
    const c = store().cancel("a");
    expect(cancelCalls()).toEqual([[runs[0].args.runId]]);
    await c;
    runs[0].finish();
  });

  it("[F2] a late Stop never cancels the turn sent after it", async () => {
    useSessionsStore.setState({ sessions: [session("a")] });
    const ipc = deferred<void>();
    vi.mocked(cancelAgentSession).mockImplementationOnce(() => ipc.promise);
    void store().send("a", "A");
    const runA = runs[0];
    const c1 = store().cancel("a");
    expect(find("a")?.turns[0]?.error).toBe("Cancelled.");
    expect(find("a")?.running).toBe(false);
    // A second Stop while the first is unanswered finds nothing to stop.
    await store().cancel("a");
    void store().send("a", "B");
    expect(runs).toHaveLength(2);
    ipc.resolve();
    await c1;
    expect(find("a")?.turns[1]?.status).toBe("running");
    expect(find("a")?.running).toBe(true);
    expect(cancelCalls()).toEqual([[runA.args.runId]]);
    for (const r of runs) r.finish();
  });

  it("[A1] Stop marks the turn and frees the session before the cancel answers", async () => {
    useSessionsStore.setState({ sessions: [session("a")] });
    const ipc = deferred<void>();
    vi.mocked(cancelAgentSession).mockImplementation(() => ipc.promise);
    const first = store().send("a", "one");
    const c1 = store().cancel("a");
    expect(find("a")?.turns[0]).toMatchObject({
      status: "error",
      error: "Cancelled.",
    });
    expect(find("a")?.running).toBe(false);
    runs[0].finish();
    await first;
    const commit = deferred<string | null>();
    vi.mocked(commitWorktreeAll).mockImplementationOnce(() => commit.promise);
    const second = store().send("a", "two");
    runs[1].finish();
    await vi.waitFor(() =>
      expect(find("a")?.turns[1]?.status).toBe("committing"),
    );
    const c2 = store().cancel("a");
    expect(find("a")?.turns[1]).toMatchObject({
      status: "error",
      error: "Cancelled.",
    });
    expect(find("a")?.running).toBe(false);
    commit.resolve(null);
    await second;
    ipc.resolve();
    await Promise.all([c1, c2]);
  });

  it("[F1] a Stop while a resume miss is held never commits the turn", async () => {
    const actual =
      await vi.importActual<typeof import("@/lib/ai/agent")>("@/lib/ai/agent");
    vi.mocked(runAgentSession).mockImplementationOnce(actual.runAgentSession);
    vi.mocked(cancelAgentSession).mockImplementationOnce(
      actual.cancelAgentSession,
    );
    vi.mocked(isWatchingAgentSurface).mockReturnValue(false);
    const miss: ReviewEvent = {
      kind: "done",
      text: "No conversation found with session ID: cs-a",
      isError: true,
      costUsd: 0,
    };
    // Attempt 1 delivers the miss at once, then stays pending until released.
    const release = deferred<void>();
    let missDelivered = false;
    vi.mocked(invoke).mockImplementation((async (
      cmd: string,
      args: Record<string, unknown> = {},
    ) => {
      if (cmd === "agent_review_cancel") return new Promise(() => undefined);
      if (cmd !== "agent_session") throw new Error(`unexpected ${cmd}`);
      const channel = args.onEvent as {
        onmessage: (event: ReviewEvent) => void;
      };
      channel.onmessage(miss);
      missDelivered = true;
      await release.promise;
      return miss;
    }) as never);
    const invoked = (cmd: string) =>
      vi.mocked(invoke).mock.calls.filter((c) => c[0] === cmd);
    useSessionsStore.setState({ sessions: [session("a")] });
    const sent = store().send("a", "one");
    await vi.waitFor(() => expect(missDelivered).toBe(true));
    const first = invoked("agent_session")[0][1] as {
      runId: string;
      resume: boolean;
    };
    expect(first.resume).toBe(true);
    const runId = first.runId;
    // The miss is held now; Stop lands while attempt 1 is still pending.
    void store().cancel("a");
    release.resolve();
    await sent;
    expect(invoked("agent_session")).toHaveLength(1);
    expect(invoked("agent_review_cancel")).toEqual([
      ["agent_review_cancel", { reviewId: runId }],
    ]);
    expect(commitWorktreeAll).not.toHaveBeenCalled();
    expect(find("a")?.turns[0]).toMatchObject({
      status: "error",
      error: "Cancelled.",
    });
    expect(find("a")?.running).toBe(false);
    expect(emitNotification).not.toHaveBeenCalled();
    await transcriptWritesSettled();
    expect(vi.mocked(appendResult).mock.calls).toHaveLength(1);
  });

  it("[A4a] a setup read that throws ends the turn as an error", async () => {
    vi.mocked(loadSettings).mockResolvedValueOnce({
      mcpServers: [{ id: "srv", scope: 7 }],
    } as never);
    useSessionsStore.setState({ sessions: [session("a", ["srv"])] });
    await store().send("a", "one");
    const turn = find("a")?.turns[0];
    expect(turn?.status).toBe("error");
    expect(turn?.error).toBeTypeOf("string");
    expect(turn?.error).not.toBe("Cancelled.");
    expect(find("a")?.running).toBe(false);
    expect(runs).toHaveLength(0);
    await transcriptWritesSettled();
    expect(vi.mocked(appendResult).mock.calls).toHaveLength(1);
    expect(vi.mocked(appendResult).mock.calls[0].slice(0, 3)).toEqual([
      "a",
      0,
      "error",
    ]);
  });

  it("[A4b] a repo identity read that throws ends the turn with its reason", async () => {
    const failure = new Error("identity unreadable");
    vi.mocked(repoIdentity).mockRejectedValueOnce(failure);
    useSessionsStore.setState({ sessions: [session("a", ["srv"])] });
    await store().send("a", "one");
    expect(find("a")?.turns[0]).toMatchObject({
      status: "error",
      error: presentError(failure).summary,
    });
    expect(find("a")?.running).toBe(false);
    expect(runs).toHaveLength(0);
    await transcriptWritesSettled();
    expect(vi.mocked(appendResult).mock.calls).toHaveLength(1);
  });

  it("[A4c] a Stop during setup keeps Cancelled. over a setup failure", async () => {
    vi.mocked(loadSettings).mockResolvedValueOnce({
      mcpServers: [{ id: "srv", scope: 7 }],
    } as never);
    useSessionsStore.setState({ sessions: [session("a", ["srv"])] });
    const release = holdRepoIdentity();
    const sent = store().send("a", "one");
    await store().cancel("a");
    release();
    await sent;
    expect(find("a")?.turns[0]).toMatchObject({
      status: "error",
      error: "Cancelled.",
    });
    expect(find("a")?.running).toBe(false);
    expect(runs).toHaveLength(0);
    await transcriptWritesSettled();
    expect(vi.mocked(appendResult).mock.calls).toHaveLength(1);
  });

  it("[T8] a re-send while the stopped run is unsettled starts its own run", async () => {
    useSessionsStore.setState({ sessions: [session("a")] });
    void store().send("a", "one");
    await store().cancel("a");
    void store().send("a", "two");
    expect(runs).toHaveLength(2);
    expect(runs[0].args.runId).not.toBe(runs[1].args.runId);
    for (const r of runs) r.finish();
  });

  it("[E1a] a turn with MCP servers is running from Send", async () => {
    useSessionsStore.setState({ sessions: [session("a", ["srv"])] });
    const release = holdRepoIdentity();
    const sent = store().send("a", "one");
    expect(find("a")?.running).toBe(true);
    await store().send("a", "again");
    expect(find("a")?.turns).toHaveLength(1);
    await store().keep("a", false);
    await store().discard("a");
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(store().busyId).toBeNull();
    expect(find("a")).toBeDefined();
    release();
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    await store().cancel("a");
    expect(cancelCalls()).toEqual([[runs[0].args.runId]]);
    runs[0].finish();
    await sent;
  });

  it("[E1b] a Stop during MCP setup ends the turn without a spawn", async () => {
    useSessionsStore.setState({ sessions: [session("a", ["srv"])] });
    const release = holdRepoIdentity();
    const sent = store().send("a", "one");
    await store().cancel("a");
    expect(find("a")?.turns[0]?.error).toBe("Cancelled.");
    expect(find("a")?.running).toBe(false);
    const cancelled = cancelCalls()[0]?.[0];
    expect(cancelled).toBeTypeOf("string");
    release();
    await sent;
    expect(runs).toHaveLength(0);
    await transcriptWritesSettled();
    expect(vi.mocked(appendResult).mock.calls).toHaveLength(1);
    expect(vi.mocked(appendResult).mock.calls[0].slice(0, 3)).toEqual([
      "a",
      0,
      "error",
    ]);
    const next = store().send("a", "two");
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0].args.runId).not.toBe(cancelled);
    runs[0].finish();
    await next;
  });

  it("[E1c] a first turn started by `start` is running from creation", async () => {
    const release = holdRepoIdentity();
    const id = await store().start(
      "C:/repo",
      "Do it",
      "",
      "claude",
      "",
      undefined,
      ["srv"],
      "worktree",
    );
    expect(id).toBe("wt-1");
    expect(find("wt-1")?.mcpServers).toEqual(["srv"]);
    expect(find("wt-1")?.running).toBe(true);
    release();
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    runs[0].finish();
    await vi.waitFor(() => expect(find("wt-1")?.running).toBe(false));
  });
});

describe("sessions store: transcript writes and busy sessions", () => {
  it("[W1] a session's first turn line waits for its transcript header", async () => {
    const header = deferred<void>();
    vi.mocked(createTranscript).mockImplementationOnce(() => header.promise);
    vi.mocked(appendTurn).mockClear();
    const id = await store().start(
      "C:/repo",
      "Do it",
      "",
      "claude",
      "",
      undefined,
      undefined,
      "worktree",
    );
    expect(id).toBe("wt-1");
    await vi.waitFor(() => expect(createTranscript).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(appendTurn).not.toHaveBeenCalled();
    header.resolve();
    await transcriptWritesSettled();
    expect(vi.mocked(appendTurn).mock.calls[0].slice(0, 2)).toEqual([
      "wt-1",
      0,
    ]);
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    runs[0].finish();
    await vi.waitFor(() => expect(find("wt-1")?.running).toBe(false));
  });

  it("[W2] a failed write never stops the next one", async () => {
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.mocked(appendModel).mockRejectedValueOnce(new Error("disk full"));
    vi.mocked(appendEffort).mockClear();
    useSessionsStore.setState({ sessions: [session("a")] });
    store().setModel("a", "opus");
    store().setEffort("a", "high");
    await transcriptWritesSettled();
    expect(appendEffort).toHaveBeenCalledWith("a", "high");
    expect(logged).toHaveBeenCalledWith(
      "[sessions] persist failed",
      expect.any(Error),
    );
    logged.mockRestore();
  });

  it("[C1] Send while a Keep, Discard or Resume is in flight starts nothing", async () => {
    vi.mocked(appendTurn).mockClear();
    useSessionsStore.setState({ sessions: [session("a")], busyId: "a" });
    await store().send("a", "one");
    await transcriptWritesSettled();
    expect(find("a")?.turns).toHaveLength(0);
    expect(find("a")?.running).toBe(false);
    expect(runs).toHaveLength(0);
    expect(appendTurn).not.toHaveBeenCalled();
  });

  it("[C2] removing another session keeps a busy session's mark", async () => {
    vi.mocked(appendTurn).mockClear();
    const kept = (id: string) => ({ ...session(id), kept: true });
    useSessionsStore.setState({
      sessions: [session("a"), kept("b"), kept("c")],
      busyId: "a",
    });
    store().deleteSession("b");
    expect(store().busyId).toBe("a");
    await store().send("a", "one");
    await transcriptWritesSettled();
    expect(find("a")?.turns).toHaveLength(0);
    expect(runs).toHaveLength(0);
    expect(appendTurn).not.toHaveBeenCalled();
    useSessionsStore.setState({ busyId: "c" });
    store().deleteSession("c");
    expect(store().busyId).toBeNull();
  });
});
