import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  staleUpdateDiscards,
  useCleanupResolveWorktrees,
} from "@/features/pulls/useCleanupResolveWorktrees";
import {
  gitCleanupOrphanedResolveWorktrees,
  gitCloseAbandonedLocalPrUpdates,
  gitDiscardLocalPrUpdate,
  gitMergeLocalPr,
  gitUpdateLocalPrHead,
  type LocalPrMergeOutcome,
  type LocalPrUpdateOutcome,
} from "@/lib/git/api";
import {
  type LocalPrUpdateDiscardVars,
  oplogCheckOptions,
  useMergeLocalPr,
  useStartLocalPrUpdate,
} from "@/lib/git/queries";
import {
  type LocalPr,
  listLocalPrs,
  openPendingUpdate,
  type PendingUpdate,
  reloadLocalPrs,
  updateLocalPr,
} from "@/lib/pulls/local";
import { localPrKey } from "@/lib/pulls/queries";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitCleanupOrphanedResolveWorktrees: vi.fn(),
  gitCloseAbandonedLocalPrUpdates: vi.fn(),
  gitDiscardLocalPrUpdate: vi.fn(),
  gitMergeLocalPr: vi.fn(),
  gitUpdateLocalPrHead: vi.fn(),
}));
vi.mock("@/lib/pulls/local", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pulls/local")>()),
  listLocalPrs: vi.fn(),
  reloadLocalPrs: vi.fn(),
  updateLocalPr: vi.fn(),
}));

const REPO = "C:/repos/demo";
const OTHER_REPO = "C:/repos/elsewhere";
const SIBLING_CHECKOUT = "C:/repos/demo-linked";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const update = (
  n: number,
  over: Partial<PendingUpdate> = {},
): PendingUpdate => ({
  base: "main",
  head: `feat-${n}`,
  worktreePath: `C:/data/wt/gd-resolve-00000000000${n}`,
  worktreeId: `00000000000${n}`,
  opId: `op-${n}`,
  journalRepo: REPO,
  startedAt: "2026-11-02T00:00:00.000Z",
  ...over,
});

const pr = (id: string, over: Partial<LocalPr> = {}): LocalPr => ({
  id,
  title: id,
  body: "",
  base: "main",
  head: `head-${id}`,
  status: "open",
  approved: false,
  labels: [],
  comments: [],
  createdAt: "2026-11-01T00:00:00.000Z",
  ...over,
});

const MERGE_PATH = "C:/data/wt/gd-resolve-aaaaaaaaaaaa";
const merging = (id: string, opId: string | null = null) =>
  pr(id, {
    pendingMerge: {
      base: "main",
      head: `head-${id}`,
      strategy: "merge",
      message: "m",
      worktreePath: MERGE_PATH,
      worktreeId: "aaaaaaaaaaaa",
      opId,
      startedAt: "x",
    },
  });

let qc: QueryClient;
/** Each repo's records; a list read snapshots them when it STARTS. */
let stores: Map<string, Map<string, LocalPr>>;
/** When set, a list read of REPO waits on it after taking its snapshot. */
let listGate: Promise<void> | null;
/** The store's in-memory copy where it differs from disk (`stores`): list reads
 *  serve it until a reload drops it. */
let memory: Map<string, LocalPr[]>;

const storeOf = (repo: string) => {
  let store = stores.get(repo);
  if (!store) {
    store = new Map();
    stores.set(repo, store);
  }
  return store;
};
const setList = (repo: string, prs: LocalPr[]) =>
  stores.set(repo, new Map(prs.map((p) => [p.id, p])));

function mount(initialRepo: string) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(
    ({ repo }: { repo: string }) => useCleanupResolveWorktrees(repo),
    { initialProps: { repo: initialRepo }, wrapper },
  );
}

/** Re-reads the list as a refocus or another write would. */
const relist = (repo = REPO) =>
  act(async () => {
    await qc.invalidateQueries({ queryKey: localPrKey(repo) });
  });

const keepLists = () =>
  vi.mocked(gitCleanupOrphanedResolveWorktrees).mock.calls.map((c) => c[1]);

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  unmockedCommands.length = 0;
  stores = new Map();
  listGate = null;
  memory = new Map();
  vi.mocked(listLocalPrs).mockReset();
  vi.mocked(listLocalPrs).mockImplementation(async (repo) => {
    const snapshot = memory.get(repo) ?? [...storeOf(repo).values()];
    if (listGate && repo === REPO) await listGate;
    return snapshot;
  });
  vi.mocked(reloadLocalPrs).mockReset();
  vi.mocked(reloadLocalPrs).mockImplementation(async () => {
    memory.clear();
  });
  vi.mocked(updateLocalPr).mockReset();
  vi.mocked(updateLocalPr).mockImplementation(async (repo, id, mutate) => {
    // A linked checkout and the main one share one record set (identity keying).
    const store = storeOf(repo === SIBLING_CHECKOUT ? REPO : repo);
    const cur = store.get(id);
    if (!cur) throw new Error(`no local PR with id ${id}`);
    const next = mutate(cur);
    store.set(id, next);
    return next;
  });
  vi.mocked(gitCleanupOrphanedResolveWorktrees).mockReset();
  vi.mocked(gitCleanupOrphanedResolveWorktrees).mockResolvedValue(undefined);
  vi.mocked(gitCloseAbandonedLocalPrUpdates).mockReset();
  vi.mocked(gitCloseAbandonedLocalPrUpdates).mockResolvedValue(0);
  vi.mocked(gitDiscardLocalPrUpdate).mockReset();
  vi.mocked(gitDiscardLocalPrUpdate).mockResolvedValue({ status: "discarded" });
  vi.mocked(gitUpdateLocalPrHead).mockReset();
  vi.mocked(gitMergeLocalPr).mockReset();
});

afterEach(() => {
  qc.clear();
});

afterAll(() => expect(unmockedCommands).toEqual([]));

describe("the worktree sweep", () => {
  it("keeps paused merges and OPEN updates, then closes the rest of the journal", async () => {
    setList(REPO, [
      merging("merge"),
      pr("open", { pendingUpdate: update(1) }),
      pr("closed", { status: "closed", pendingUpdate: update(2) }),
    ]);
    vi.mocked(gitCloseAbandonedLocalPrUpdates).mockResolvedValue(1);
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    mount(REPO);
    await waitFor(() =>
      expect(gitCloseAbandonedLocalPrUpdates).toHaveBeenCalledTimes(1),
    );
    expect(keepLists()).toEqual([[MERGE_PATH, update(1).worktreePath]]);
    expect(gitCloseAbandonedLocalPrUpdates).toHaveBeenCalledWith(REPO, [
      "op-1",
    ]);
    expect(
      vi.mocked(gitCleanupOrphanedResolveWorktrees).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(gitCloseAbandonedLocalPrUpdates).mock.invocationCallOrder[0],
    );
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: oplogCheckOptions(REPO).queryKey,
      }),
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["repo", REPO, "oplog"],
    });
    // Once per repo open: a later list read sweeps nothing more.
    await relist();
    expect(gitCleanupOrphanedResolveWorktrees).toHaveBeenCalledTimes(1);
  });

  it("keeps every record's paused merge op id from the journal closer", async () => {
    setList(REPO, [
      merging("merge", "op-merge-open"),
      pr("open", { pendingUpdate: update(1) }),
      { ...merging("merged-away", "op-merge-closed"), status: "closed" },
    ]);
    mount(REPO);
    await waitFor(() =>
      expect(gitCloseAbandonedLocalPrUpdates).toHaveBeenCalledTimes(1),
    );
    expect(gitCloseAbandonedLocalPrUpdates).toHaveBeenCalledWith(REPO, [
      "op-merge-open",
      "op-1",
      "op-merge-closed",
    ]);
  });

  it("sweeps only from a read it requested, never a list cached before it mounted", async () => {
    // The cached list predates the record of an update now on disk.
    qc.setQueryData(localPrKey(REPO), [pr("open")]);
    setList(REPO, [pr("open", { pendingUpdate: update(1) })]);
    const gate = deferred<void>();
    listGate = gate.promise;
    mount(REPO);
    await waitFor(() => expect(listLocalPrs).toHaveBeenCalledTimes(1));
    expect(gitCleanupOrphanedResolveWorktrees).not.toHaveBeenCalled();
    gate.resolve();
    await waitFor(() =>
      expect(gitCleanupOrphanedResolveWorktrees).toHaveBeenCalledTimes(1),
    );
    expect(keepLists()).toEqual([[update(1).worktreePath]]);
  });

  it("waits out a start under another checkout key, then sweeps from a newer read", async () => {
    setList(REPO, [pr("open")]);
    const start = deferred<LocalPrUpdateOutcome>();
    vi.mocked(gitUpdateLocalPrHead).mockReturnValue(start.promise);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const starter = renderHook(
      () =>
        useStartLocalPrUpdate(SIBLING_CHECKOUT, localPrKey(SIBLING_CHECKOUT)),
      { wrapper },
    );
    let started!: Promise<unknown>;
    act(() => {
      started = starter.result.current.mutateAsync({
        id: "open",
        base: "main",
        head: "head-open",
      });
    });
    mount(REPO);
    await waitFor(() =>
      expect(qc.getQueryState(localPrKey(REPO))?.status).toBe("success"),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(gitCleanupOrphanedResolveWorktrees).not.toHaveBeenCalled();
    const created = update(5, { journalRepo: SIBLING_CHECKOUT });
    await act(async () => {
      start.resolve({
        status: "conflicts",
        conflicts: ["a.txt"],
        headTip: "c".repeat(40),
        worktreePath: created.worktreePath,
        worktreeId: created.worktreeId,
        opId: created.opId,
        journalRepo: SIBLING_CHECKOUT,
      });
      await started;
    });
    await waitFor(() =>
      expect(gitCleanupOrphanedResolveWorktrees).toHaveBeenCalledTimes(1),
    );
    expect(keepLists()[0]).toContain(created.worktreePath);
  });

  it("never sweeps from a read issued before a start's record write", async () => {
    // Cached, so the hook's own refetch is the read in flight when the start begins.
    qc.setQueryData(localPrKey(REPO), [pr("open")]);
    setList(REPO, [pr("open")]);
    const gate = deferred<void>();
    listGate = gate.promise;
    const start = deferred<LocalPrUpdateOutcome>();
    vi.mocked(gitUpdateLocalPrHead).mockReturnValue(start.promise);
    mount(REPO);
    // The hook's own read is in flight with the pre-write snapshot.
    await waitFor(() => expect(listLocalPrs).toHaveBeenCalled());
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const starter = renderHook(
      () =>
        useStartLocalPrUpdate(SIBLING_CHECKOUT, localPrKey(SIBLING_CHECKOUT)),
      { wrapper },
    );
    let started!: Promise<unknown>;
    act(() => {
      started = starter.result.current.mutateAsync({
        id: "open",
        base: "main",
        head: "head-open",
      });
    });
    const created = update(6, { journalRepo: SIBLING_CHECKOUT });
    start.resolve({
      status: "conflicts",
      conflicts: ["a.txt"],
      headTip: "c".repeat(40),
      worktreePath: created.worktreePath,
      worktreeId: created.worktreeId,
      opId: created.opId,
      journalRepo: SIBLING_CHECKOUT,
    });
    // The start waits out the sweep whose read is in flight.
    listGate = null;
    await act(async () => {
      gate.resolve();
      await started;
    });
    await waitFor(() =>
      expect(gitCleanupOrphanedResolveWorktrees).toHaveBeenCalled(),
    );
    for (const keep of keepLists())
      expect(keep).toContain(created.worktreePath);
  });

  it("asks again when its read is cancelled back to the data it had", async () => {
    // The cached list predates the record of an update now on disk.
    qc.setQueryData(localPrKey(REPO), [pr("open")]);
    setList(REPO, [pr("open", { pendingUpdate: update(1) })]);
    const gate = deferred<void>();
    listGate = gate.promise;
    mount(REPO);
    await waitFor(() => expect(listLocalPrs).toHaveBeenCalledTimes(1));
    // A Refresh's cancel reverts the hook's read, which then resolves with the
    // cached pre-request list.
    await act(async () => {
      await qc.cancelQueries({ queryKey: localPrKey(REPO) });
    });
    await waitFor(() => expect(listLocalPrs).toHaveBeenCalledTimes(2));
    expect(gitCleanupOrphanedResolveWorktrees).not.toHaveBeenCalled();
    gate.resolve();
    await waitFor(() =>
      expect(gitCleanupOrphanedResolveWorktrees).toHaveBeenCalledTimes(1),
    );
    expect(keepLists()).toEqual([[update(1).worktreePath]]);
  });

  it("ignores observer events of a start that has already settled", async () => {
    setList(REPO, [pr("open")]);
    vi.mocked(gitUpdateLocalPrHead).mockResolvedValue({
      status: "updated",
      conflicts: [],
      headTip: "c".repeat(40),
      worktreePath: null,
      worktreeId: null,
      opId: "op-9",
      journalRepo: REPO,
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const starter = renderHook(
      () =>
        useStartLocalPrUpdate(SIBLING_CHECKOUT, localPrKey(SIBLING_CHECKOUT)),
      { wrapper },
    );
    await act(async () => {
      await starter.result.current.mutateAsync({
        id: "open",
        base: "main",
        head: "head-open",
      });
    });
    qc.setQueryData(localPrKey(REPO), [pr("open")]);
    vi.mocked(listLocalPrs).mockClear();
    const gate = deferred<void>();
    listGate = gate.promise;
    mount(REPO);
    await waitFor(() => expect(listLocalPrs).toHaveBeenCalledTimes(1));
    // The settled start's observer leaves: its read in flight stays the one.
    starter.unmount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(listLocalPrs).toHaveBeenCalledTimes(1);
    gate.resolve();
    await waitFor(() =>
      expect(gitCleanupOrphanedResolveWorktrees).toHaveBeenCalledTimes(1),
    );
  });

  it("skips the sweep for this open when its own list read fails", async () => {
    qc.setQueryData(localPrKey(REPO), [
      pr("open", { pendingUpdate: update(1) }),
    ]);
    vi.mocked(listLocalPrs).mockRejectedValueOnce(
      new Error("store unreadable"),
    );
    setList(REPO, [pr("open", { pendingUpdate: update(1) })]);
    mount(REPO);
    await waitFor(() => expect(listLocalPrs).toHaveBeenCalledTimes(1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    // A later good read of the same open does not bring the sweep back.
    await relist();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(listLocalPrs).toHaveBeenCalledTimes(2);
    expect(gitCleanupOrphanedResolveWorktrees).not.toHaveBeenCalled();
    expect(gitCloseAbandonedLocalPrUpdates).not.toHaveBeenCalled();
  });

  it("reads the keep-list from disk, not the store's in-memory copy", async () => {
    // Another instance recorded the update; this one's store still holds the older copy.
    setList(REPO, [pr("open", { pendingUpdate: update(1) })]);
    memory.set(REPO, [pr("open")]);
    mount(REPO);
    await waitFor(() =>
      expect(gitCloseAbandonedLocalPrUpdates).toHaveBeenCalledTimes(1),
    );
    expect(reloadLocalPrs).toHaveBeenCalled();
    expect(keepLists()).toEqual([[update(1).worktreePath]]);
    expect(gitCloseAbandonedLocalPrUpdates).toHaveBeenCalledWith(REPO, [
      "op-1",
    ]);
  });

  it("skips the sweep for this open when the store reload fails", async () => {
    setList(REPO, [pr("open", { pendingUpdate: update(1) })]);
    vi.mocked(reloadLocalPrs).mockRejectedValueOnce(
      new Error("store unreadable"),
    );
    mount(REPO);
    await waitFor(() => expect(reloadLocalPrs).toHaveBeenCalledTimes(1));
    await relist();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(reloadLocalPrs).toHaveBeenCalledTimes(1);
    expect(gitCleanupOrphanedResolveWorktrees).not.toHaveBeenCalled();
    expect(gitCloseAbandonedLocalPrUpdates).not.toHaveBeenCalled();
  });

  /** Mounts a start of PR "open" in REPO; `answer` settles its command. */
  function startOpen() {
    const command = deferred<LocalPrUpdateOutcome>();
    vi.mocked(gitUpdateLocalPrHead).mockReturnValue(command.promise);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const starter = renderHook(
      () => useStartLocalPrUpdate(REPO, localPrKey(REPO)),
      { wrapper },
    );
    let started!: Promise<unknown>;
    act(() => {
      started = starter.result.current.mutateAsync({
        id: "open",
        base: "main",
        head: "head-open",
      });
    });
    const created = update(7);
    const answer = () =>
      act(async () => {
        command.resolve({
          status: "conflicts",
          conflicts: ["a.txt"],
          headTip: "c".repeat(40),
          worktreePath: created.worktreePath,
          worktreeId: created.worktreeId,
          opId: created.opId,
          journalRepo: REPO,
        });
        await started;
      });
    return { created, answer };
  }

  it("runs a start dispatched mid-sweep after the pass, which never closes with the old keep-list", async () => {
    setList(REPO, [pr("open")]);
    const cleanup = deferred<void>();
    vi.mocked(gitCleanupOrphanedResolveWorktrees).mockReturnValueOnce(
      cleanup.promise,
    );
    mount(REPO);
    await waitFor(() =>
      expect(gitCleanupOrphanedResolveWorktrees).toHaveBeenCalledTimes(1),
    );
    const { created, answer } = startOpen();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(gitUpdateLocalPrHead).not.toHaveBeenCalled();
    await act(async () => cleanup.resolve());
    await waitFor(() => expect(gitUpdateLocalPrHead).toHaveBeenCalledTimes(1));
    // The pass abandoned before its closer: its keep-list predates the start.
    expect(gitCloseAbandonedLocalPrUpdates).not.toHaveBeenCalled();
    await answer();
    await waitFor(() =>
      expect(gitCloseAbandonedLocalPrUpdates).toHaveBeenCalledTimes(1),
    );
    expect(gitCloseAbandonedLocalPrUpdates).toHaveBeenCalledWith(REPO, [
      created.opId,
    ]);
    expect(keepLists().at(-1)).toEqual([created.worktreePath]);
  });

  it("runs an into-base merge dispatched mid-sweep after the pass, and sweeps again only once it settles", async () => {
    setList(REPO, [pr("open")]);
    const cleanup = deferred<void>();
    vi.mocked(gitCleanupOrphanedResolveWorktrees).mockReturnValueOnce(
      cleanup.promise,
    );
    mount(REPO);
    await waitFor(() =>
      expect(gitCleanupOrphanedResolveWorktrees).toHaveBeenCalledTimes(1),
    );
    const command = deferred<LocalPrMergeOutcome>();
    vi.mocked(gitMergeLocalPr).mockReturnValue(command.promise);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const merger = renderHook(() => useMergeLocalPr(REPO, localPrKey(REPO)), {
      wrapper,
    });
    let started!: Promise<unknown>;
    /** The record as the mutation settles, before any later write could land. */
    let recordAtSettle: LocalPr | undefined;
    act(() => {
      started = merger.result.current
        .mutateAsync({
          id: "open",
          base: "main",
          head: "head-open",
          message: "m",
          strategy: "merge",
        })
        .then((result) => {
          recordAtSettle = storeOf(REPO).get("open");
          return result;
        });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(gitMergeLocalPr).not.toHaveBeenCalled();
    await act(async () => cleanup.resolve());
    await waitFor(() => expect(gitMergeLocalPr).toHaveBeenCalledTimes(1));
    // The pass abandoned before its closer: its keep-list predates the merge.
    expect(gitCloseAbandonedLocalPrUpdates).not.toHaveBeenCalled();
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(gitCleanupOrphanedResolveWorktrees).toHaveBeenCalledTimes(1);
    await act(async () => {
      command.resolve({
        status: "conflicts",
        conflicts: ["a.txt"],
        baseTip: "b".repeat(40),
        worktreePath: MERGE_PATH,
        worktreeId: "aaaaaaaaaaaa",
        opId: "op-m",
      });
      await started;
    });
    await waitFor(() =>
      expect(gitCloseAbandonedLocalPrUpdates).toHaveBeenCalledTimes(1),
    );
    expect(gitCleanupOrphanedResolveWorktrees).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(gitCleanupOrphanedResolveWorktrees).mock.invocationCallOrder[1],
    ).toBeGreaterThan(vi.mocked(gitMergeLocalPr).mock.invocationCallOrder[0]);
    // The merge recorded its worktree before it settled, so the pass that ran
    // once it settled keeps it.
    expect(recordAtSettle?.pendingMerge?.worktreePath).toBe(MERGE_PATH);
    expect(keepLists().at(-1)).toContain(MERGE_PATH);
  });

  it("never cleans up with a keep-list read before a start that began during the read", async () => {
    qc.setQueryData(localPrKey(REPO), [pr("open")]);
    setList(REPO, [pr("open")]);
    const gate = deferred<void>();
    listGate = gate.promise;
    mount(REPO);
    await waitFor(() => expect(listLocalPrs).toHaveBeenCalledTimes(1));
    const { created, answer } = startOpen();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(gitUpdateLocalPrHead).not.toHaveBeenCalled();
    listGate = null;
    await act(async () => gate.resolve());
    await waitFor(() => expect(gitUpdateLocalPrHead).toHaveBeenCalledTimes(1));
    await answer();
    await waitFor(() =>
      expect(gitCloseAbandonedLocalPrUpdates).toHaveBeenCalledTimes(1),
    );
    for (const keep of keepLists())
      expect(keep).toContain(created.worktreePath);
    expect(gitCloseAbandonedLocalPrUpdates).toHaveBeenCalledWith(REPO, [
      created.opId,
    ]);
  });

  it("does nothing while no repository is open", async () => {
    mount("");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(gitCleanupOrphanedResolveWorktrees).not.toHaveBeenCalled();
    expect(gitCloseAbandonedLocalPrUpdates).not.toHaveBeenCalled();
    expect(gitDiscardLocalPrUpdate).not.toHaveBeenCalled();
    expect(updateLocalPr).not.toHaveBeenCalled();
  });
});

describe("abandoned updates", () => {
  it("discards a closed PR's update once across rerenders", async () => {
    setList(REPO, [
      pr("closed", { status: "closed", pendingUpdate: update(2) }),
    ]);
    // The record write fails, so the field survives every later read.
    vi.mocked(updateLocalPr).mockRejectedValue(new Error("store unwritable"));
    const view = mount(REPO);
    await waitFor(() =>
      expect(gitDiscardLocalPrUpdate).toHaveBeenCalledTimes(1),
    );
    const u = update(2);
    // The record's own head, which a branch rename rewrites; the field keeps the old.
    expect(gitDiscardLocalPrUpdate).toHaveBeenCalledWith(
      REPO,
      "head-closed",
      u.worktreePath,
      u.worktreeId,
      u.opId,
      u.journalRepo,
    );
    expect(updateLocalPr).toHaveBeenCalledWith(
      REPO,
      "closed",
      expect.any(Function),
    );
    view.rerender({ repo: REPO });
    await relist();
    view.rerender({ repo: REPO });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(gitDiscardLocalPrUpdate).toHaveBeenCalledTimes(1);
  });

  it("discards an open update whose PR left the list, with no record to clear", async () => {
    setList(REPO, [pr("gone", { pendingUpdate: update(3) })]);
    mount(REPO);
    await waitFor(() =>
      expect(gitCleanupOrphanedResolveWorktrees).toHaveBeenCalled(),
    );
    setList(REPO, []);
    await relist();
    await waitFor(() =>
      expect(gitDiscardLocalPrUpdate).toHaveBeenCalledTimes(1),
    );
    expect(vi.mocked(gitDiscardLocalPrUpdate).mock.calls[0][3]).toBe(
      update(3).worktreeId,
    );
    // No record is left to name a head, so the stored one is sent.
    expect(vi.mocked(gitDiscardLocalPrUpdate).mock.calls[0][1]).toBe(
      update(3).head,
    );
    expect(updateLocalPr).not.toHaveBeenCalled();
  });

  it("leaves an open PR whose field cleared alone", async () => {
    setList(REPO, [pr("done", { pendingUpdate: update(4) })]);
    mount(REPO);
    await waitFor(() =>
      expect(gitCleanupOrphanedResolveWorktrees).toHaveBeenCalled(),
    );
    setList(REPO, [pr("done")]);
    await relist();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(gitDiscardLocalPrUpdate).not.toHaveBeenCalled();
  });

  it("discards nothing when the repository switches to one without the PR", async () => {
    setList(REPO, [pr("here", { pendingUpdate: update(5) })]);
    setList(OTHER_REPO, [pr("there")]);
    const view = mount(REPO);
    await waitFor(() =>
      expect(gitCleanupOrphanedResolveWorktrees).toHaveBeenCalled(),
    );
    view.rerender({ repo: OTHER_REPO });
    await waitFor(() =>
      expect(gitCleanupOrphanedResolveWorktrees).toHaveBeenCalledTimes(2),
    );
    expect(gitDiscardLocalPrUpdate).not.toHaveBeenCalled();
  });

  it("drops a closed PR's malformed field once, then re-reads the list", async () => {
    setList(REPO, [
      pr("bad", {
        status: "closed",
        pendingUpdate: { ...update(7), worktreeId: "" },
      }),
    ]);
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    vi.mocked(updateLocalPr).mockRejectedValue(new Error("store unwritable"));
    mount(REPO);
    await waitFor(() => expect(updateLocalPr).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: localPrKey(REPO) }),
    );
    await relist();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(updateLocalPr).toHaveBeenCalledTimes(1);
    expect(gitDiscardLocalPrUpdate).not.toHaveBeenCalled();
  });
});

describe("staleUpdateDiscards against alternatives", () => {
  const discardIds = (d: { discards: LocalPrUpdateDiscardVars[] }) =>
    d.discards.map((v) => [v.id, v.worktreeId]);

  /** Ignores which repository `seen` came from. */
  function ignoresRepo(
    seen: Parameters<typeof staleUpdateDiscards>[0],
    repoPath: string,
    prs: LocalPr[],
  ) {
    return staleUpdateDiscards(
      seen === null ? null : { ...seen, repo: repoPath },
      repoPath,
      prs,
    );
  }

  /** Treats an open PR whose field cleared as abandoned. */
  function clearedIsAbandoned(
    seen: Parameters<typeof staleUpdateDiscards>[0],
    repoPath: string,
    prs: LocalPr[],
  ) {
    const real = staleUpdateDiscards(seen, repoPath, prs);
    const extra =
      seen?.repo === repoPath
        ? prs.flatMap((p) => {
            const was = seen.updates.get(p.id);
            return was && p.status === "open" && !openPendingUpdate(p)
              ? [{ ...real.discards[0], id: p.id, worktreeId: was.worktreeId }]
              : [];
          })
        : [];
    return { ...real, discards: [...real.discards, ...extra] };
  }

  it("a repository switch: the alternative that ignores seen.repo disagrees", () => {
    const first = staleUpdateDiscards(null, REPO, [
      pr("here", { pendingUpdate: update(1) }),
    ]);
    const after = [pr("there")];
    expect(
      discardIds(staleUpdateDiscards(first.seen, OTHER_REPO, after)),
    ).toEqual([]);
    expect(discardIds(ignoresRepo(first.seen, OTHER_REPO, after))).toEqual([
      [null, update(1).worktreeId],
    ]);
  });

  it("finished by its own flow: the alternative that calls it abandoned disagrees", () => {
    const first = staleUpdateDiscards(null, REPO, [
      pr("done", { pendingUpdate: update(1) }),
    ]);
    const after = [pr("done")];
    expect(discardIds(staleUpdateDiscards(first.seen, REPO, after))).toEqual(
      [],
    );
    expect(discardIds(clearedIsAbandoned(first.seen, REPO, after))).toEqual([
      ["done", update(1).worktreeId],
    ]);
  });
});
