import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
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
  gitDiscardLocalPrUpdate,
  gitFinishLocalPrUpdate,
  gitOpState,
  gitUpdateLocalPrHead,
  type LocalPrUpdateOutcome,
} from "@/lib/git/api";
import {
  conflictPreviewKey,
  LOCAL_PR_WRITES_KEY,
  type LocalPrUpdateDiscardVars,
  type LocalPrUpdateFinishVars,
  useDiscardLocalPrUpdate,
  useFinishLocalPrUpdate,
  useStartLocalPrUpdate,
} from "@/lib/git/queries";
import type { RepoOpState } from "@/lib/git/types";
import { listUserWorktrees, type UserWorktree } from "@/lib/git/worktree";
import {
  type LocalPr,
  openPendingUpdate,
  type PendingUpdate,
  updateLocalPr,
} from "@/lib/pulls/local";
import { localPrKey } from "@/lib/pulls/queries";
import {
  removeWorktreeForCleanup,
  useWorktreeRemovalStore,
} from "@/lib/stores/worktree-removal";
import { unmockedCommands } from "./setup";

// The api modules are the seam; everything else in them stays real.
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitDiscardLocalPrUpdate: vi.fn(),
  gitFinishLocalPrUpdate: vi.fn(),
  gitOpState: vi.fn(),
  gitUpdateLocalPrHead: vi.fn(),
}));
vi.mock("@/lib/pulls/local", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pulls/local")>()),
  updateLocalPr: vi.fn(),
}));
vi.mock("@/lib/git/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/worktree")>()),
  listUserWorktrees: vi.fn(),
}));

const REPO = "C:/repos/demo";
const RECORD_KEY = localPrKey(REPO);
const WT_ID = "0123456789ab";
const WT_PATH = `C:/data/worktrees/id/gd-resolve-${WT_ID}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const pr = (over: Partial<LocalPr> = {}): LocalPr => ({
  id: "pr-1",
  title: "Feature",
  body: "",
  base: "main",
  head: "feat",
  status: "open",
  approved: false,
  labels: [],
  comments: [],
  createdAt: "2026-11-01T00:00:00.000Z",
  ...over,
});

const update = (over: Partial<PendingUpdate> = {}): PendingUpdate => ({
  base: "main",
  head: "feat",
  worktreePath: WT_PATH,
  worktreeId: WT_ID,
  opId: "op-1",
  journalRepo: REPO,
  startedAt: "2026-11-02T00:00:00.000Z",
  ...over,
});

const conflicts = (
  over: Partial<LocalPrUpdateOutcome> = {},
): LocalPrUpdateOutcome => ({
  status: "conflicts",
  conflicts: ["a.txt"],
  headTip: "a".repeat(40),
  worktreePath: WT_PATH,
  worktreeId: WT_ID,
  opId: "op-7",
  journalRepo: "C:/repos/demo-checkout",
  ...over,
});

const updated: LocalPrUpdateOutcome = {
  status: "updated",
  conflicts: [],
  headTip: "b".repeat(40),
  worktreePath: null,
  worktreeId: null,
  opId: "op-7",
  journalRepo: REPO,
};

const finishVars: LocalPrUpdateFinishVars = {
  id: "pr-1",
  base: "main",
  head: "feat",
  worktreePath: WT_PATH,
  worktreeId: WT_ID,
  opId: "op-1",
  journalRepo: REPO,
};

const discardVars = (
  over: Partial<LocalPrUpdateDiscardVars> = {},
): LocalPrUpdateDiscardVars => ({
  id: "pr-1",
  head: "feat",
  worktreePath: WT_PATH,
  worktreeId: WT_ID,
  opId: "op-1",
  journalRepo: REPO,
  ...over,
});

let qc: QueryClient;
let records: Map<string, LocalPr>;
/** Each `updateLocalPr` call: the record it read and the one its mutate returned. */
let writes: { repo: string; id: string; before: LocalPr; after: LocalPr }[];
/** When set, the list read waits on it: the re-read a write awaits stays open. */
let listGate: Promise<void> | null;
let listReads: number;

async function readList(): Promise<LocalPr[]> {
  listReads += 1;
  if (listGate) await listGate;
  return [...records.values()];
}

/** Renders `useHook` beside an OBSERVED list query under the record key, so an
 *  invalidation of that key refetches it. */
async function mount<T>(useHook: (repo: string, key: typeof RECORD_KEY) => T) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const view = renderHook(
    () => {
      const list = useQuery({
        queryKey: RECORD_KEY,
        queryFn: readList,
        networkMode: "always",
      });
      return { list, hook: useHook(REPO, RECORD_KEY) };
    },
    { wrapper },
  );
  await waitFor(() => expect(view.result.current.list.isSuccess).toBe(true));
  return view;
}

const pendingUpdateWrites = () =>
  qc
    .getMutationCache()
    .findAll({ mutationKey: LOCAL_PR_WRITES_KEY, status: "pending" }).length;

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  unmockedCommands.length = 0;
  records = new Map([["pr-1", pr()]]);
  writes = [];
  listGate = null;
  listReads = 0;
  vi.mocked(updateLocalPr).mockReset();
  vi.mocked(updateLocalPr).mockImplementation(async (repo, id, mutate) => {
    const before = records.get(id);
    if (!before) throw new Error(`no local PR with id ${id}`);
    const after = mutate(before);
    writes.push({ repo, id, before, after });
    records.set(id, after);
    return after;
  });
  vi.mocked(gitUpdateLocalPrHead).mockReset();
  vi.mocked(gitFinishLocalPrUpdate).mockReset();
  vi.mocked(gitDiscardLocalPrUpdate).mockReset();
  vi.mocked(gitDiscardLocalPrUpdate).mockResolvedValue({ status: "discarded" });
});

afterEach(() => {
  qc.clear();
});

afterAll(() => expect(unmockedCommands).toEqual([]));

describe("openPendingUpdate", () => {
  it("reads an open PR's well-formed field", () => {
    expect(openPendingUpdate(pr({ pendingUpdate: update() }))).toEqual(
      update(),
    );
  });

  it("is undefined for a closed PR, a missing field and a malformed member", () => {
    expect(
      openPendingUpdate(pr({ status: "closed", pendingUpdate: update() })),
    ).toBeUndefined();
    expect(openPendingUpdate(pr())).toBeUndefined();
    expect(openPendingUpdate(undefined)).toBeUndefined();
    const { opId: _dropped, ...missing } = update();
    expect(
      openPendingUpdate(pr({ pendingUpdate: missing as PendingUpdate })),
    ).toBeUndefined();
    expect(
      openPendingUpdate(
        pr({
          pendingUpdate: { ...update(), opId: 7 } as unknown as PendingUpdate,
        }),
      ),
    ).toBeUndefined();
    expect(
      openPendingUpdate(pr({ pendingUpdate: update({ journalRepo: "" }) })),
    ).toBeUndefined();
  });
});

describe("useStartLocalPrUpdate", () => {
  it("records a conflicted start with the outcome's ids and nothing else", async () => {
    const merge = {
      base: "main",
      head: "feat",
      strategy: "merge" as const,
      message: "m",
      worktreePath: "C:/wt/merge",
      worktreeId: "merge",
      opId: null,
      startedAt: "x",
    };
    records.set("pr-1", pr({ approved: true, pendingMerge: merge }));
    vi.mocked(gitUpdateLocalPrHead).mockResolvedValue(conflicts());
    const view = await mount(useStartLocalPrUpdate);
    let result: unknown;
    await act(async () => {
      result = await view.result.current.hook.mutateAsync({
        id: "pr-1",
        base: "main",
        head: "feat",
      });
    });
    expect(result).toEqual({ status: "conflicts", worktreeId: WT_ID });
    expect(gitUpdateLocalPrHead).toHaveBeenCalledWith(REPO, "main", "feat");
    const written = records.get("pr-1");
    expect(written?.pendingUpdate).toEqual({
      base: "main",
      head: "feat",
      worktreePath: WT_PATH,
      worktreeId: WT_ID,
      opId: "op-7",
      journalRepo: "C:/repos/demo-checkout",
      startedAt: expect.any(String),
    });
    expect(written?.pendingMerge).toEqual(merge);
    expect(written?.status).toBe("open");
    expect(written?.approved).toBe(true);
    expect(gitDiscardLocalPrUpdate).not.toHaveBeenCalled();
  });

  it.each([
    [
      "is no longer open",
      pr({ status: "closed" }),
      "This pull request is no longer open, so the update was discarded.",
    ],
    [
      "already has an unfinished update",
      pr({ pendingUpdate: update({ worktreeId: "fedcba987654" }) }),
      "This pull request already has an unfinished conflict resolution, so the new one was discarded.",
    ],
  ])(
    "discards its own worktree when the fresh record %s",
    async (_name, fresh, sentence) => {
      records.set("pr-1", fresh);
      vi.mocked(gitUpdateLocalPrHead).mockResolvedValue(conflicts());
      const view = await mount(useStartLocalPrUpdate);
      await act(async () => {
        await expect(
          view.result.current.hook.mutateAsync({
            id: "pr-1",
            base: "main",
            head: "feat",
          }),
        ).rejects.toThrow(sentence);
      });
      expect(records.get("pr-1")).toBe(fresh);
      expect(writes.every((w) => w.after === w.before)).toBe(true);
      expect(gitDiscardLocalPrUpdate).toHaveBeenCalledTimes(1);
      expect(gitDiscardLocalPrUpdate).toHaveBeenCalledWith(
        REPO,
        "feat",
        WT_PATH,
        WT_ID,
        "op-7",
        "C:/repos/demo-checkout",
      );
    },
  );

  it("overwrites a malformed stored field, which is inert", async () => {
    const malformed = { ...update(), opId: "" };
    records.set("pr-1", pr({ pendingUpdate: malformed }));
    vi.mocked(gitUpdateLocalPrHead).mockResolvedValue(conflicts());
    const view = await mount(useStartLocalPrUpdate);
    await act(async () => {
      await view.result.current.hook.mutateAsync({
        id: "pr-1",
        base: "main",
        head: "feat",
      });
    });
    expect(records.get("pr-1")?.pendingUpdate?.opId).toBe("op-7");
    expect(gitDiscardLocalPrUpdate).not.toHaveBeenCalled();
  });

  it("discards its worktree and rethrows when the record write rejects", async () => {
    const failure = new Error("store unwritable");
    vi.mocked(updateLocalPr).mockRejectedValue(failure);
    vi.mocked(gitUpdateLocalPrHead).mockResolvedValue(conflicts());
    const view = await mount(useStartLocalPrUpdate);
    await act(async () => {
      await expect(
        view.result.current.hook.mutateAsync({
          id: "pr-1",
          base: "main",
          head: "feat",
        }),
      ).rejects.toBe(failure);
    });
    expect(gitDiscardLocalPrUpdate).toHaveBeenCalledTimes(1);
  });

  it("clears the approval of an approved record on a clean start", async () => {
    records.set("pr-1", pr({ approved: true }));
    vi.mocked(gitUpdateLocalPrHead).mockResolvedValue(updated);
    const view = await mount(useStartLocalPrUpdate);
    let result: unknown;
    await act(async () => {
      result = await view.result.current.hook.mutateAsync({
        id: "pr-1",
        base: "main",
        head: "feat",
      });
    });
    expect(result).toEqual({
      status: "updated",
      approvalCleared: true,
      recordError: null,
    });
    expect(records.get("pr-1")?.approved).toBe(false);
    expect(records.get("pr-1")?.pendingUpdate).toBeUndefined();
  });

  it("leaves an unapproved record as the same object on a clean start", async () => {
    vi.mocked(gitUpdateLocalPrHead).mockResolvedValue(updated);
    const view = await mount(useStartLocalPrUpdate);
    let result: unknown;
    await act(async () => {
      result = await view.result.current.hook.mutateAsync({
        id: "pr-1",
        base: "main",
        head: "feat",
      });
    });
    expect(result).toEqual({
      status: "updated",
      approvalCleared: false,
      recordError: null,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].after).toBe(writes[0].before);
  });

  it("reports a failed approval write beside the moved branch", async () => {
    vi.mocked(updateLocalPr).mockRejectedValue(new Error("store unwritable"));
    vi.mocked(gitUpdateLocalPrHead).mockResolvedValue(updated);
    const view = await mount(useStartLocalPrUpdate);
    let result: unknown;
    await act(async () => {
      result = await view.result.current.hook.mutateAsync({
        id: "pr-1",
        base: "main",
        head: "feat",
      });
    });
    expect(result).toEqual({
      status: "updated",
      approvalCleared: false,
      recordError: "store unwritable",
    });
  });

  it("reports a plain AppError from the approval write by its message", async () => {
    vi.mocked(updateLocalPr).mockRejectedValue({
      kind: "io",
      message: "store locked by another window",
    });
    vi.mocked(gitUpdateLocalPrHead).mockResolvedValue(updated);
    const view = await mount(useStartLocalPrUpdate);
    let result: unknown;
    await act(async () => {
      result = await view.result.current.hook.mutateAsync({
        id: "pr-1",
        base: "main",
        head: "feat",
      });
    });
    expect(result).toMatchObject({
      recordError: "store locked by another window",
    });
  });
});

describe("useFinishLocalPrUpdate", () => {
  it("clears its own field and the approval, leaving the PR open", async () => {
    records.set("pr-1", pr({ approved: true, pendingUpdate: update() }));
    vi.mocked(gitFinishLocalPrUpdate).mockResolvedValue(updated);
    const view = await mount(useFinishLocalPrUpdate);
    let result: unknown;
    await act(async () => {
      result = await view.result.current.hook.mutateAsync(finishVars);
    });
    expect(result).toEqual({ status: "updated", approvalCleared: true });
    expect(gitFinishLocalPrUpdate).toHaveBeenCalledWith(
      REPO,
      "main",
      "feat",
      WT_PATH,
      WT_ID,
      "op-1",
      REPO,
    );
    const written = records.get("pr-1");
    expect(written?.pendingUpdate).toBeUndefined();
    expect(written?.approved).toBe(false);
    expect(written?.status).toBe("open");
    expect(written).not.toHaveProperty("mergedAt");
  });

  it("keeps a field that names another worktree", async () => {
    const other = update({ worktreeId: "fedcba987654" });
    records.set("pr-1", pr({ pendingUpdate: other }));
    vi.mocked(gitFinishLocalPrUpdate).mockResolvedValue(updated);
    const view = await mount(useFinishLocalPrUpdate);
    let result: unknown;
    await act(async () => {
      result = await view.result.current.hook.mutateAsync(finishVars);
    });
    expect(result).toEqual({ status: "updated", approvalCleared: false });
    expect(records.get("pr-1")?.pendingUpdate).toEqual(other);
  });

  it("writes nothing when the command rejects", async () => {
    records.set("pr-1", pr({ pendingUpdate: update() }));
    vi.mocked(gitFinishLocalPrUpdate).mockRejectedValue({
      kind: "command",
      message: "Resolve every conflict first",
    });
    const view = await mount(useFinishLocalPrUpdate);
    await act(async () => {
      await expect(
        view.result.current.hook.mutateAsync(finishVars),
      ).rejects.toMatchObject({ message: "Resolve every conflict first" });
    });
    expect(updateLocalPr).not.toHaveBeenCalled();
  });

  it("rejects an answer other than updated in plain words, writing nothing", async () => {
    records.set("pr-1", pr({ pendingUpdate: update() }));
    vi.mocked(gitFinishLocalPrUpdate).mockResolvedValue(conflicts());
    const view = await mount(useFinishLocalPrUpdate);
    await act(async () => {
      await expect(
        view.result.current.hook.mutateAsync(finishVars),
      ).rejects.toThrow("Couldn't finish this update; feat was not updated.");
    });
    expect(updateLocalPr).not.toHaveBeenCalled();
  });

  it("rejects when the record write fails, after the list re-read", async () => {
    records.set("pr-1", pr({ pendingUpdate: update() }));
    vi.mocked(updateLocalPr).mockRejectedValue(new Error("store unwritable"));
    vi.mocked(gitFinishLocalPrUpdate).mockResolvedValue(updated);
    const view = await mount(useFinishLocalPrUpdate);
    const before = listReads;
    await act(async () => {
      await expect(
        view.result.current.hook.mutateAsync(finishVars),
      ).rejects.toThrow("store unwritable");
    });
    expect(listReads).toBeGreaterThan(before);
  });
});

describe("useDiscardLocalPrUpdate", () => {
  it("writes no record for a deleted pull request", async () => {
    const view = await mount(useDiscardLocalPrUpdate);
    let result: unknown;
    await act(async () => {
      result = await view.result.current.hook.mutateAsync(
        discardVars({ id: null }),
      );
    });
    expect(result).toEqual({ status: "discarded" });
    expect(updateLocalPr).not.toHaveBeenCalled();
    expect(gitDiscardLocalPrUpdate).toHaveBeenCalledWith(
      REPO,
      "feat",
      WT_PATH,
      WT_ID,
      "op-1",
      REPO,
    );
  });

  it("clears the field and keeps the approval on a plain discard", async () => {
    records.set("pr-1", pr({ approved: true, pendingUpdate: update() }));
    const view = await mount(useDiscardLocalPrUpdate);
    await act(async () => {
      await view.result.current.hook.mutateAsync(discardVars());
    });
    expect(records.get("pr-1")?.pendingUpdate).toBeUndefined();
    expect(records.get("pr-1")?.approved).toBe(true);
  });

  it("clears the approval when the update had in fact landed", async () => {
    records.set("pr-1", pr({ approved: true, pendingUpdate: update() }));
    vi.mocked(gitDiscardLocalPrUpdate).mockResolvedValue({ status: "updated" });
    const view = await mount(useDiscardLocalPrUpdate);
    let result: unknown;
    await act(async () => {
      result = await view.result.current.hook.mutateAsync(discardVars());
    });
    expect(result).toEqual({ status: "updated", approvalCleared: true });
    expect(records.get("pr-1")?.approved).toBe(false);
    expect(records.get("pr-1")?.pendingUpdate).toBeUndefined();
  });

  it("reports no cleared approval for a landed update on an unapproved PR", async () => {
    records.set("pr-1", pr({ pendingUpdate: update() }));
    vi.mocked(gitDiscardLocalPrUpdate).mockResolvedValue({ status: "updated" });
    const view = await mount(useDiscardLocalPrUpdate);
    let result: unknown;
    await act(async () => {
      result = await view.result.current.hook.mutateAsync(discardVars());
    });
    expect(result).toEqual({ status: "updated", approvalCleared: false });
  });
});

describe("the list rule", () => {
  /** Starts `run` with the list re-read held open, and proves the mutation stays
   *  pending in the cache until that re-read lands. */
  async function holdsUntilListLands(run: () => Promise<unknown>) {
    const gate = deferred<void>();
    listGate = gate.promise;
    const readsBefore = listReads;
    let settled = false;
    let promise!: Promise<unknown>;
    act(() => {
      promise = run().finally(() => {
        settled = true;
      });
    });
    await waitFor(() => expect(listReads).toBeGreaterThan(readsBefore));
    // Let every microtask the mutationFn could finish on run out first.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(settled).toBe(false);
    expect(pendingUpdateWrites()).toBe(1);
    gate.resolve();
    await act(async () => {
      await promise;
    });
    expect(settled).toBe(true);
    expect(pendingUpdateWrites()).toBe(0);
  }

  it("holds a conflicted start until the list re-read lands", async () => {
    vi.mocked(gitUpdateLocalPrHead).mockResolvedValue(conflicts());
    const view = await mount(useStartLocalPrUpdate);
    await holdsUntilListLands(() =>
      view.result.current.hook.mutateAsync({
        id: "pr-1",
        base: "main",
        head: "feat",
      }),
    );
  });

  it("holds a clean start until the list re-read lands", async () => {
    vi.mocked(gitUpdateLocalPrHead).mockResolvedValue(updated);
    const view = await mount(useStartLocalPrUpdate);
    await holdsUntilListLands(() =>
      view.result.current.hook.mutateAsync({
        id: "pr-1",
        base: "main",
        head: "feat",
      }),
    );
  });

  it("holds a finish until the list re-read lands", async () => {
    records.set("pr-1", pr({ pendingUpdate: update() }));
    vi.mocked(gitFinishLocalPrUpdate).mockResolvedValue(updated);
    const view = await mount(useFinishLocalPrUpdate);
    await holdsUntilListLands(() =>
      view.result.current.hook.mutateAsync(finishVars),
    );
  });

  it("holds a discard until the list re-read lands", async () => {
    records.set("pr-1", pr({ pendingUpdate: update() }));
    const view = await mount(useDiscardLocalPrUpdate);
    await holdsUntilListLands(() =>
      view.result.current.hook.mutateAsync(discardVars()),
    );
  });

  it("holds a finish until the conflict prediction re-read lands too", async () => {
    records.set("pr-1", pr({ pendingUpdate: update() }));
    vi.mocked(gitFinishLocalPrUpdate).mockResolvedValue(updated);
    const preview = { gate: null as Promise<void> | null, reads: 0 };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const view = renderHook(
      () => {
        useQuery({
          queryKey: RECORD_KEY,
          queryFn: readList,
          networkMode: "always",
        });
        const predicted = useQuery({
          queryKey: [...conflictPreviewKey(REPO), "main", "feat"],
          queryFn: async () => {
            preview.reads += 1;
            if (preview.gate) await preview.gate;
            return preview.reads;
          },
          networkMode: "always",
        });
        return { predicted, hook: useFinishLocalPrUpdate(REPO, RECORD_KEY) };
      },
      { wrapper },
    );
    await waitFor(() =>
      expect(view.result.current.predicted.isSuccess).toBe(true),
    );
    const gate = deferred<void>();
    preview.gate = gate.promise;
    let settled = false;
    let promise!: Promise<unknown>;
    act(() => {
      promise = view.result.current.hook.mutateAsync(finishVars).finally(() => {
        settled = true;
      });
    });
    await waitFor(() => expect(preview.reads).toBe(2));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(settled).toBe(false);
    gate.resolve();
    await act(async () => {
      await promise;
    });
    expect(settled).toBe(true);
  });
});

describe("Clean up branches holds on a pending update write", () => {
  const BRANCH = "feat";
  const HOLDER = "C:/repos/wt/holder";
  const QUIET: RepoOpState = {
    merging: false,
    rebasing: false,
    cherryPicking: false,
    reverting: false,
    editPaused: false,
    rebaseStop: null,
  };
  const worktree = (path: string, branch: string): UserWorktree => ({
    path,
    branch,
    head: "0".repeat(64),
    isMain: false,
    isDetached: false,
    isLocked: false,
    lockReason: "",
    lastActivityMs: null,
  });

  /** Starts a REAL update write that never settles, so its key and variables are
   *  the production ones. */
  function stage<V>(
    useWrite: (
      repo: string,
      key: typeof RECORD_KEY,
    ) => { mutateAsync: (vars: V) => Promise<unknown> },
    vars: V,
  ) {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useWrite(REPO, RECORD_KEY), {
      wrapper,
    });
    act(() => {
      void result.current.mutateAsync(vars).catch(() => undefined);
    });
  }

  const cleanup = () =>
    removeWorktreeForCleanup(qc, {
      repoPath: REPO,
      path: HOLDER,
      name: BRANCH,
      branch: BRANCH,
      then: "delete",
    });

  beforeEach(() => {
    vi.mocked(gitOpState).mockResolvedValue(QUIET);
    // The holder now has another branch checked out, so a call that gets past
    // the write check ends at the branch-changed refusal before any removal.
    vi.mocked(listUserWorktrees).mockResolvedValue([worktree(HOLDER, "other")]);
  });

  afterEach(() => {
    useWorktreeRemovalStore.setState({ byRepo: {} });
  });

  it("refuses while a start names the branch as its head", async () => {
    vi.mocked(gitUpdateLocalPrHead).mockReturnValue(
      new Promise(() => undefined),
    );
    stage(useStartLocalPrUpdate, { id: "pr-1", base: "main", head: BRANCH });
    expect(await cleanup()).toEqual({
      ok: false,
      reason: "an update is running on this branch",
    });
    expect(listUserWorktrees).not.toHaveBeenCalled();
  });

  it("refuses while a finish names the branch as its head", async () => {
    vi.mocked(gitFinishLocalPrUpdate).mockReturnValue(
      new Promise(() => undefined),
    );
    stage(useFinishLocalPrUpdate, { ...finishVars, head: BRANCH });
    expect(await cleanup()).toEqual({
      ok: false,
      reason: "an update is running on this branch",
    });
  });

  it("does not hold on a discard, which moves no branch", async () => {
    vi.mocked(gitDiscardLocalPrUpdate).mockReturnValue(
      new Promise(() => undefined),
    );
    stage(useDiscardLocalPrUpdate, discardVars({ head: BRANCH }));
    const outcome = await cleanup();
    expect(outcome).not.toEqual({
      ok: false,
      reason: "an update is running on this branch",
    });
    expect(outcome).toEqual({
      ok: false,
      reason: "the worktree no longer has this branch checked out",
    });
  });
});
