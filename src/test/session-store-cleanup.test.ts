import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadPersistedSessions } from "@/features/sessions/persistence";
import { type AgentSession, useSessionsStore } from "@/features/sessions/store";
import {
  type AgentSessionArgs,
  type ReviewEvent,
  runAgentSession,
} from "@/lib/ai/agent";
import { cleanupContainerSandbox } from "@/lib/ai/sandbox";

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
  // The repository is reachable but holds no session worktree: every
  // non-kept session in it is an orphan.
  listWorktrees: vi.fn(async () => []),
  // "deleted" has no KEPT_BRANCH_NOTES entry, so the discard raises no toast.
  removeWorktree: vi.fn(async () => ({ branchCleanup: "deleted" })),
}));
vi.mock("@/lib/notifications/emit", () => ({ emitNotification: vi.fn() }));
vi.mock("@/features/sessions/watching", () => ({
  isWatchingAgentSurface: () => true,
}));

const REPO = "C:/repo";

interface Run {
  args: AgentSessionArgs;
  finish: () => void;
}

let runs: Run[] = [];

const find = (id: string) =>
  useSessionsStore.getState().sessions.find((s) => s.id === id);

/** Starts a session through the public `start` and lets its first turn finish. */
async function startAndFinish(isolation: "container" | "worktree") {
  const id = await useSessionsStore
    .getState()
    .start(REPO, "Do it", "", "opencode", "", undefined, undefined, isolation);
  expect(id).toBe("wt-1");
  const run = runs[0];
  if (!run) throw new Error("runAgentSession was not called");
  run.finish();
  await vi.waitFor(() => expect(find("wt-1")?.running).toBe(false));
  return run;
}

beforeEach(() => {
  runs = [];
  vi.mocked(cleanupContainerSandbox).mockClear();
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

describe("sessions store: container sandbox cleanup", () => {
  it("discard cleans the sandbox under the id the run was started with", async () => {
    const run = await startAndFinish("container");
    await useSessionsStore.getState().discard("wt-1");
    expect(find("wt-1")).toBeUndefined();
    expect(vi.mocked(cleanupContainerSandbox).mock.calls).toEqual([
      [run.args.sessionId],
    ]);
    expect(run.args.sessionId).not.toBe("wt-1");
    expect(run.args.sessionId).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("deleting a kept session cleans under the run's id", async () => {
    const run = await startAndFinish("container");
    useSessionsStore.setState((st) => ({
      sessions: st.sessions.map((s) =>
        s.id === "wt-1" ? { ...s, kept: true } : s,
      ),
    }));
    useSessionsStore.getState().deleteSession("wt-1");
    expect(find("wt-1")).toBeUndefined();
    expect(vi.mocked(cleanupContainerSandbox).mock.calls).toEqual([
      [run.args.sessionId],
    ]);
  });

  it("a worktree session's discard cleans nothing", async () => {
    await startAndFinish("worktree");
    await useSessionsStore.getState().discard("wt-1");
    expect(find("wt-1")).toBeUndefined();
    expect(cleanupContainerSandbox).not.toHaveBeenCalled();
  });

  it("hydrate cleans an orphaned container session under its run id only", async () => {
    const orphan = (id: string, isolation: "container" | "worktree") =>
      ({
        id,
        repoPath: REPO,
        worktreePath: `C:/wt/${id}`,
        branch: `gd/session/${id}`,
        base: "base",
        headHash: "base",
        claudeSessionId: `cs-${id}`,
        model: "",
        effort: "",
        isolation,
        agent: "opencode",
        running: false,
        kept: false,
        turns: [],
      }) satisfies AgentSession;
    vi.mocked(loadPersistedSessions).mockResolvedValueOnce([
      orphan("box", "container"),
      orphan("tree", "worktree"),
    ]);
    useSessionsStore.setState({ hydrated: false });
    await useSessionsStore.getState().hydrate();
    expect(useSessionsStore.getState().sessions).toEqual([]);
    expect(vi.mocked(cleanupContainerSandbox).mock.calls).toEqual([["cs-box"]]);
  });
});
