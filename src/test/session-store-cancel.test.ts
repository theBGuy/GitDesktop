import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { appendResult } from "@/features/sessions/persistence";
import { type AgentSession, useSessionsStore } from "@/features/sessions/store";
import {
  type AgentSessionArgs,
  cancelAgentSession,
  type ReviewEvent,
  runAgentSession,
} from "@/lib/ai/agent";
import { repoIdentity } from "@/lib/git/repo-identity";
import { commitWorktreeAll, removeWorktree } from "@/lib/git/worktree";
import { unmockedCommands } from "./setup";

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
  isWatchingAgentSurface: () => true,
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

beforeEach(() => {
  runs = [];
  vi.mocked(cancelAgentSession).mockClear();
  vi.mocked(cancelAgentSession).mockImplementation(async () => undefined);
  vi.mocked(appendResult).mockClear();
  vi.mocked(removeWorktree).mockClear();
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
    const ipc = [deferred<void>(), deferred<void>()];
    let call = 0;
    vi.mocked(cancelAgentSession).mockImplementation(() => ipc[call++].promise);
    void store().send("a", "A");
    const runA = runs[0];
    const c1 = store().cancel("a");
    const c2 = store().cancel("a");
    ipc[0].resolve();
    await c1;
    expect(find("a")?.turns[0]?.error).toBe("Cancelled.");
    expect(find("a")?.running).toBe(false);
    void store().send("a", "B");
    expect(runs).toHaveLength(2);
    ipc[1].resolve();
    await c2;
    expect(find("a")?.turns[1]?.status).toBe("running");
    expect(find("a")?.running).toBe(true);
    expect(cancelCalls()).toEqual([[runA.args.runId], [runA.args.runId]]);
    for (const r of runs) r.finish();
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
