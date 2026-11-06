import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { presentError } from "@/lib/error-summary";
import {
  gitAbortLocalPrMerge,
  gitBranches,
  gitCheckoutBranch,
  gitDefaultBranch,
  gitFinishLocalPrMerge,
  gitMergeLocalPr,
  gitSetBranchArchived,
  gitUpdateBranchFrom,
  validateRepo,
} from "@/lib/git/api";
import {
  useAbortLocalPrMerge,
  useFinishLocalPrMerge,
  useMergeLocalPr,
  useUpdateBranchFrom,
} from "@/lib/git/queries";
import {
  beginPromoteWindow,
  pruneWorktrees,
  removeWorktree,
  type WorktreeRemoveOutcome,
} from "@/lib/git/worktree";
import {
  isWorktreePromoting,
  registerRemovalListener,
  removeWorktreeForCleanup,
  useIsRemovingWorktree,
  useWorktreeRemovalStore,
} from "@/lib/stores/worktree-removal";
import { unmockedCommands } from "./setup";

// The api modules are the seam; everything else in them stays real.
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitAbortLocalPrMerge: vi.fn(),
  gitBranches: vi.fn(),
  gitCheckoutBranch: vi.fn(),
  gitDefaultBranch: vi.fn(),
  gitFinishLocalPrMerge: vi.fn(),
  gitMergeLocalPr: vi.fn(),
  gitSetBranchArchived: vi.fn(),
  gitUpdateBranchFrom: vi.fn(),
  validateRepo: vi.fn(),
}));
vi.mock("@/lib/git/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/worktree")>()),
  beginPromoteWindow: vi.fn(),
  removeWorktree: vi.fn(),
  pruneWorktrees: vi.fn(),
}));
// The cleanup path must stay silent, so every toast method is a spy.
vi.mock("sonner", () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    dismiss: vi.fn(),
  },
}));

const REPO = "C:/repos/demo";
const BRANCH = "feat-a";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const outcome = (
  branchCleanup: WorktreeRemoveOutcome["branchCleanup"],
): WorktreeRemoveOutcome => ({ branchCleanup });

type Branches = Awaited<ReturnType<typeof gitBranches>>;

let qc: QueryClient;

/** Starts a REAL local-PR write against `repo` that stays pending (its api
 *  call never settles), so its identity and variables are the production ones. */
function stageWrite<V>(
  useWrite: (repo: string) => { mutateAsync: (vars: V) => Promise<unknown> },
  repo: string,
  vars: V,
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useWrite(repo), { wrapper });
  act(() => {
    void result.current.mutateAsync(vars);
  });
}

const stageUpdate = (repo: string, branch: string) =>
  stageWrite(useUpdateBranchFrom, repo, { branch, base: "main" });

const stageMerge = (repo: string, base: string, head: string) =>
  stageWrite(useMergeLocalPr, repo, {
    base,
    head,
    message: "Merge",
    strategy: "merge",
  });

const stageFinish = (repo: string, base: string) =>
  stageWrite(useFinishLocalPrMerge, repo, {
    base,
    strategy: "merge",
    message: "Merge",
    worktreePath: "C:/repos/wt/isolated-merge",
    worktreeId: "isolated-merge",
    opId: null,
  });

function expectSilent() {
  for (const fn of Object.values(toast)) expect(fn).not.toHaveBeenCalled();
}

const removals = () => useWorktreeRemovalStore.getState().byRepo;

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  unmockedCommands.length = 0;
  vi.mocked(removeWorktree).mockResolvedValue(outcome("deleted"));
  vi.mocked(pruneWorktrees).mockResolvedValue(undefined);
  vi.mocked(gitDefaultBranch).mockResolvedValue("main");
  vi.mocked(gitBranches).mockResolvedValue([]);
  vi.mocked(gitSetBranchArchived).mockResolvedValue(undefined);
  vi.mocked(gitUpdateBranchFrom).mockReturnValue(new Promise(() => undefined));
  vi.mocked(gitMergeLocalPr).mockReturnValue(new Promise(() => undefined));
  vi.mocked(gitFinishLocalPrMerge).mockReturnValue(
    new Promise(() => undefined),
  );
  vi.mocked(gitAbortLocalPrMerge).mockReturnValue(new Promise(() => undefined));
});

afterEach(() => {
  qc.clear();
  expect(removals()).toEqual({});
  expect(unmockedCommands).toEqual([]);
});

describe("removeWorktreeForCleanup refusals", () => {
  it("refuses a second same-path call in the same tick off the first's mark", async () => {
    const path = "C:/repos/wt/one-tick";
    const held = deferred<WorktreeRemoveOutcome>();
    vi.mocked(removeWorktree).mockReturnValueOnce(held.promise);
    const args = { repoPath: REPO, path, name: BRANCH, branch: BRANCH };
    const first = removeWorktreeForCleanup(qc, { ...args, then: "delete" });
    const second = removeWorktreeForCleanup(qc, { ...args, then: "delete" });
    expect(await second).toEqual({
      ok: false,
      reason: "the worktree is being removed",
    });
    expect(removeWorktree).toHaveBeenCalledTimes(1);
    held.resolve(outcome("deleted"));
    expect(await first).toEqual({ ok: true, branch: "deleted" });
  });

  it("refuses a path a promote has claimed, starting nothing", async () => {
    const path = "C:/repos/wt/promoting";
    const parked = deferred<never>();
    vi.mocked(validateRepo).mockReturnValueOnce(parked.promise);
    const refused = useWorktreeRemovalStore.getState().startPromote({
      mainPath: "C:/repos/main-promote",
      worktreePath: path,
      branch: BRANCH,
      willStash: false,
    });
    expect(refused).toBeNull();
    expect(
      await removeWorktreeForCleanup(qc, {
        repoPath: REPO,
        path,
        name: BRANCH,
        branch: BRANCH,
        then: "archive",
      }),
    ).toEqual({ ok: false, reason: "the worktree is being promoted" });
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(removals()).toEqual({});
    parked.reject(new Error("parked promote released"));
    await waitFor(() => expect(isWorktreePromoting(path)).toBe(false));
  });

  it("refuses while an update runs on the branch", async () => {
    stageUpdate(REPO, BRANCH);
    expect(
      await removeWorktreeForCleanup(qc, {
        repoPath: REPO,
        path: "C:/repos/wt/update-on-branch",
        name: BRANCH,
        branch: BRANCH,
        then: "delete",
      }),
    ).toEqual({ ok: false, reason: "an update is running on this branch" });
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(removals()).toEqual({});
  });

  it("refuses an update on the branch keyed to a third worktree", async () => {
    stageUpdate("C:/repos/wt/third-viewer", BRANCH);
    expect(
      await removeWorktreeForCleanup(qc, {
        repoPath: REPO,
        path: "C:/repos/wt/holder-w3",
        name: BRANCH,
        branch: BRANCH,
        then: "archive",
      }),
    ).toEqual({ ok: false, reason: "an update is running on this branch" });
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("refuses an update keyed to the worktree itself, in either spelling", async () => {
    stageUpdate("C:\\Repos\\WT\\holder-self", "other-branch");
    expect(
      await removeWorktreeForCleanup(qc, {
        repoPath: REPO,
        path: "C:/repos/wt/holder-self",
        name: BRANCH,
        branch: BRANCH,
        then: "delete",
      }),
    ).toEqual({ ok: false, reason: "an update is running in this worktree" });
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("names the branch when one update matches both arms", async () => {
    const path = "C:/repos/wt/both-arms";
    stageUpdate(path, BRANCH);
    expect(
      await removeWorktreeForCleanup(qc, {
        repoPath: REPO,
        path,
        name: BRANCH,
        branch: BRANCH,
        then: "delete",
      }),
    ).toEqual({ ok: false, reason: "an update is running on this branch" });
  });

  it("proceeds past an update on a different branch", async () => {
    stageUpdate(REPO, "other-branch");
    const path = "C:/repos/wt/update-elsewhere";
    expect(
      await removeWorktreeForCleanup(qc, {
        repoPath: REPO,
        path,
        name: BRANCH,
        branch: BRANCH,
        then: "delete",
      }),
    ).toEqual({ ok: true, branch: "deleted" });
    expect(removeWorktree).toHaveBeenCalledWith(REPO, path, BRANCH, false);
  });

  it.each([
    ["a local-PR merge", () => stageMerge("C:/repos/wt/viewer", BRANCH, "pr")],
    ["a finished merge", () => stageFinish("C:/repos/wt/viewer", BRANCH)],
  ])("refuses while %s fast-forwards the branch", async (_write, stage) => {
    stage();
    expect(
      await removeWorktreeForCleanup(qc, {
        repoPath: REPO,
        path: "C:/repos/wt/merge-base-holder",
        name: BRANCH,
        branch: BRANCH,
        then: "archive",
      }),
    ).toEqual({ ok: false, reason: "a merge is running into this branch" });
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(removals()).toEqual({});
  });

  it("refuses a merge keyed to the worktree itself", async () => {
    const path = "C:/repos/wt/merge-self";
    stageMerge(path, "main", "pr");
    expect(
      await removeWorktreeForCleanup(qc, {
        repoPath: REPO,
        path,
        name: BRANCH,
        branch: BRANCH,
        then: "delete",
      }),
    ).toEqual({
      ok: false,
      reason: "a merge started from this worktree is running",
    });
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("names the branch over another write's holder match", async () => {
    const path = "C:/repos/wt/branch-over-holder";
    stageUpdate(path, "other-branch");
    stageMerge("C:/repos/wt/viewer", BRANCH, "pr");
    expect(
      await removeWorktreeForCleanup(qc, {
        repoPath: REPO,
        path,
        name: BRANCH,
        branch: BRANCH,
        then: "delete",
      }),
    ).toEqual({ ok: false, reason: "a merge is running into this branch" });
  });

  it("proceeds past a merge of the branch and an abort in the worktree", async () => {
    const path = "C:/repos/wt/merge-head";
    stageMerge(REPO, "main", BRANCH);
    stageWrite(useAbortLocalPrMerge, path, {
      worktreePath: "C:/repos/wt/isolated-merge",
      opId: null,
    });
    expect(
      await removeWorktreeForCleanup(qc, {
        repoPath: REPO,
        path,
        name: BRANCH,
        branch: BRANCH,
        then: "delete",
      }),
    ).toEqual({ ok: true, branch: "deleted" });
  });
});

describe("removeWorktreeForCleanup git refusals", () => {
  it("reads a dirty worktree's refusal, with the path stripped first", async () => {
    for (const path of ["C:/repos/wt/dirty", "C:/repos/wt/locked-tools"]) {
      vi.mocked(removeWorktree).mockRejectedValueOnce(
        new Error(
          `fatal: '${path}' contains modified or untracked files, use --force to delete it`,
        ),
      );
      expect(
        await removeWorktreeForCleanup(qc, {
          repoPath: REPO,
          path,
          name: BRANCH,
          branch: BRANCH,
          then: "delete",
        }),
      ).toEqual({ ok: false, reason: "the worktree has uncommitted changes" });
      expect(removals()).toEqual({});
    }
    expectSilent();
  });

  it("reads a locked worktree's refusal", async () => {
    vi.mocked(removeWorktree).mockRejectedValueOnce(
      new Error(
        "fatal: cannot remove a locked working tree;\nuse 'remove -f -f' to override or unlock first",
      ),
    );
    expect(
      await removeWorktreeForCleanup(qc, {
        repoPath: REPO,
        path: "C:/repos/wt/locked",
        name: BRANCH,
        branch: BRANCH,
        then: "archive",
      }),
    ).toEqual({ ok: false, reason: "the worktree is locked" });
    expect(removals()).toEqual({});
    expect(gitSetBranchArchived).not.toHaveBeenCalled();
    expectSilent();
  });

  it("reads a locked refusal whose lock reason says modified", async () => {
    vi.mocked(removeWorktree).mockRejectedValueOnce(
      new Error(
        "fatal: cannot remove a locked working tree, lock reason: modified by ci",
      ),
    );
    expect(
      await removeWorktreeForCleanup(qc, {
        repoPath: REPO,
        path: "C:/repos/wt/locked-reason",
        name: BRANCH,
        branch: BRANCH,
        then: "delete",
      }),
    ).toEqual({ ok: false, reason: "the worktree is locked" });
  });

  it("passes any other failure through, case kept and one period dropped", async () => {
    vi.mocked(removeWorktree).mockRejectedValueOnce(
      new Error("Access denied: a file in it is locked by an antivirus scan."),
    );
    expect(
      await removeWorktreeForCleanup(qc, {
        repoPath: REPO,
        path: "C:/repos/wt/scan",
        name: BRANCH,
        branch: BRANCH,
        then: "delete",
      }),
    ).toEqual({
      ok: false,
      reason: "Access denied: a file in it is locked by an antivirus scan",
    });
    expectSilent();
  });

  it("never lets a path that says untracked steer another failure", async () => {
    const path = "C:/repos/wt/fix-untracked-files";
    const denied = new Error(
      `error: failed to delete '${path}': Permission denied.`,
    );
    vi.mocked(removeWorktree).mockRejectedValueOnce(denied);
    expect(
      await removeWorktreeForCleanup(qc, {
        repoPath: REPO,
        path,
        name: BRANCH,
        branch: BRANCH,
        then: "delete",
      }),
    ).toEqual({
      ok: false,
      reason: `failed to delete '${path}': Permission denied`,
    });
    expect(removeWorktree).toHaveBeenCalledTimes(1);
    expectSilent();
  });

  it("retries a folder held for a beat, and reports a lasting hold as-is", async () => {
    const busy = new Error(
      "The folder is in use. Close any program using that folder and try again.",
    );
    const path = "C:/repos/wt/busy";
    const args = { repoPath: REPO, path, name: BRANCH, branch: BRANCH };
    vi.mocked(removeWorktree)
      .mockRejectedValueOnce(busy)
      .mockResolvedValueOnce(outcome("deleted"));
    expect(
      await removeWorktreeForCleanup(qc, { ...args, then: "delete" }),
    ).toEqual({ ok: true, branch: "deleted" });
    expect(removeWorktree).toHaveBeenCalledTimes(2);
    expect(removeWorktree).toHaveBeenLastCalledWith(REPO, path, BRANCH, false);

    vi.mocked(removeWorktree).mockReset();
    vi.mocked(removeWorktree).mockRejectedValue(busy);
    expect(
      await removeWorktreeForCleanup(qc, { ...args, then: "delete" }),
    ).toEqual({
      ok: false,
      reason:
        "The folder is in use. Close any program using that folder and try again",
    });
    expect(removeWorktree).toHaveBeenCalledTimes(2);
    expectSilent();
  });
});

describe("removeWorktreeForCleanup outcomes", () => {
  it.each([
    ["deleted", "deleted"],
    ["notRequested", "deleted"],
    ["sparedMoved", "keptMoved"],
    ["sparedUnreadable", "keptUnreadable"],
  ] as const)("maps a delete's %s to %s", async (cleanup, branch) => {
    const path = `C:/repos/wt/delete-${cleanup}`;
    vi.mocked(removeWorktree).mockResolvedValueOnce(outcome(cleanup));
    expect(
      await removeWorktreeForCleanup(qc, {
        repoPath: REPO,
        path,
        name: BRANCH,
        branch: BRANCH,
        then: "delete",
      }),
    ).toEqual({ ok: true, branch });
    expect(removeWorktree).toHaveBeenCalledWith(REPO, path, BRANCH, false);
    expect(pruneWorktrees).toHaveBeenCalledWith(REPO);
    expect(gitSetBranchArchived).not.toHaveBeenCalled();
    expectSilent();
  });

  it("archives after a removal that kept the branch", async () => {
    const path = "C:/repos/wt/archive";
    vi.mocked(removeWorktree).mockResolvedValueOnce(outcome("notRequested"));
    expect(
      await removeWorktreeForCleanup(qc, {
        repoPath: REPO,
        path,
        name: BRANCH,
        branch: BRANCH,
        then: "archive",
      }),
    ).toEqual({ ok: true, branch: "archived" });
    expect(removeWorktree).toHaveBeenCalledWith(REPO, path, null, false);
    expect(gitSetBranchArchived).toHaveBeenCalledWith(REPO, BRANCH, true);
    expectSilent();
  });

  it("counts an already-archived branch as archived without re-setting it", async () => {
    vi.mocked(gitBranches).mockResolvedValueOnce([
      { name: BRANCH, archived: true },
    ] as Branches);
    expect(
      await removeWorktreeForCleanup(qc, {
        repoPath: REPO,
        path: "C:/repos/wt/already-archived",
        name: BRANCH,
        branch: BRANCH,
        then: "archive",
      }),
    ).toEqual({ ok: true, branch: "archived" });
    expect(gitSetBranchArchived).not.toHaveBeenCalled();
    expectSilent();
  });

  it("leaves the default branch unarchived", async () => {
    vi.mocked(gitDefaultBranch).mockResolvedValueOnce(BRANCH);
    expect(
      await removeWorktreeForCleanup(qc, {
        repoPath: REPO,
        path: "C:/repos/wt/default",
        name: BRANCH,
        branch: BRANCH,
        then: "archive",
      }),
    ).toEqual({
      ok: false,
      reason: "the worktree was removed first (it is the default branch)",
    });
    expect(gitSetBranchArchived).not.toHaveBeenCalled();
    expectSilent();
  });

  it.each([
    ["Permission denied by GitHub.", "Permission denied by GitHub"],
    ["Archive store unreadable", "Archive store unreadable"],
  ])(
    "says the removal happened when the archive fails (%s)",
    async (message, summary) => {
      // The mark must already be gone when the archive step runs.
      vi.mocked(gitSetBranchArchived).mockImplementationOnce(async () => {
        expect(removals()).toEqual({});
        throw new Error(message);
      });
      expect(
        await removeWorktreeForCleanup(qc, {
          repoPath: REPO,
          path: "C:/repos/wt/archive-fails",
          name: BRANCH,
          branch: BRANCH,
          then: "archive",
        }),
      ).toEqual({
        ok: false,
        reason: `the worktree was removed first (${summary})`,
      });
      expect(gitSetBranchArchived).toHaveBeenCalledTimes(1);
      expectSilent();
    },
  );

  it("fails closed when the default branch can't be read", async () => {
    vi.mocked(gitDefaultBranch).mockRejectedValueOnce(
      new Error("No default branch."),
    );
    expect(
      await removeWorktreeForCleanup(qc, {
        repoPath: REPO,
        path: "C:/repos/wt/default-unreadable",
        name: BRANCH,
        branch: BRANCH,
        then: "archive",
      }),
    ).toEqual({
      ok: false,
      reason: "the worktree was removed first (No default branch)",
    });
    expect(gitSetBranchArchived).not.toHaveBeenCalled();
    expectSilent();
  });
});

type DialogArm = [
  name: string,
  arrange: () => void,
  toasts: [method: "success" | "info", text: string][],
];

const DIALOG_ARMS: DialogArm[] = [
  [
    "archived",
    () => undefined,
    [["success", `Worktree removed and ${BRANCH} archived`]],
  ],
  [
    "already archived",
    () => {
      vi.mocked(gitBranches).mockResolvedValueOnce([
        { name: BRANCH, archived: true },
      ] as Branches);
    },
    [
      ["success", "Worktree removed"],
      ["info", `${BRANCH} was already archived.`],
    ],
  ],
  [
    "the default branch",
    () => {
      vi.mocked(gitDefaultBranch).mockResolvedValueOnce(BRANCH);
    },
    [
      ["success", "Worktree removed"],
      ["info", `Left ${BRANCH} unarchived — it's the default branch.`],
    ],
  ],
];

describe("the delete dialog's archive toasts over the shared archive step", () => {
  it.each(DIALOG_ARMS)("toasts %s unchanged", async (_arm, arrange, toasts) => {
    arrange();
    const path = "C:/repos/wt/dialog-archive";
    expect(
      useWorktreeRemovalStore.getState().startRemoval({
        repoPath: REPO,
        path,
        name: BRANCH,
        branch: BRANCH,
        archiveWhenDone: true,
        force: false,
      }),
    ).toBeNull();
    const last = toasts[toasts.length - 1];
    await waitFor(() => expect(toast[last[0]]).toHaveBeenCalledWith(last[1]));
    for (const [method, text] of toasts)
      expect(toast[method]).toHaveBeenCalledWith(text);
    expect(removeWorktree).toHaveBeenCalledWith(REPO, path, null, false);
  });

  it("toasts a refused archive with the branch-menu recovery", async () => {
    vi.mocked(gitSetBranchArchived).mockRejectedValueOnce(
      new Error("Archive store unreadable"),
    );
    useWorktreeRemovalStore.getState().startRemoval({
      repoPath: REPO,
      path: "C:/repos/wt/dialog-archive-fails",
      name: BRANCH,
      branch: BRANCH,
      archiveWhenDone: true,
      force: false,
    });
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(vi.mocked(toast.error).mock.calls[0][0]).toBe(
      `Removed the worktree, but couldn't archive ${BRANCH} — you can archive it from the branch menu.`,
    );
  });

  it("toasts an unreadable default branch with the branch-menu recovery", async () => {
    vi.mocked(gitDefaultBranch).mockRejectedValueOnce(
      new Error("No default branch."),
    );
    useWorktreeRemovalStore.getState().startRemoval({
      repoPath: REPO,
      path: "C:/repos/wt/dialog-default-unreadable",
      name: BRANCH,
      branch: BRANCH,
      archiveWhenDone: true,
      force: false,
    });
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(vi.mocked(toast.error).mock.calls[0][0]).toBe(
      `Removed the worktree, but couldn't archive ${BRANCH} — you can archive it from the branch menu.`,
    );
    expect(gitSetBranchArchived).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe("a promote over the shared removal retry", () => {
  it("keeps the branch: it removes with no branch to delete", async () => {
    const mainPath = "C:/repos/main-for-promote";
    const path = "C:/repos/wt/promoted";
    vi.mocked(validateRepo).mockResolvedValueOnce({
      root: mainPath,
    } as Awaited<ReturnType<typeof validateRepo>>);
    vi.mocked(beginPromoteWindow).mockResolvedValueOnce(null);
    vi.mocked(gitCheckoutBranch).mockResolvedValueOnce(undefined);
    expect(
      useWorktreeRemovalStore.getState().startPromote({
        mainPath,
        worktreePath: path,
        branch: BRANCH,
        willStash: false,
      }),
    ).toBeNull();
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        `Promoted ${BRANCH} to your main workspace`,
      ),
    );
    expect(removeWorktree).toHaveBeenCalledTimes(1);
    expect(removeWorktree).toHaveBeenCalledWith(mainPath, path, null, false);
    expect(gitCheckoutBranch).toHaveBeenCalledWith(mainPath, BRANCH);
    await waitFor(() => expect(isWorktreePromoting(path)).toBe(false));
  });
});

describe("removeWorktreeForCleanup mark and reporting", () => {
  it("holds the mark for the whole removal and clears it on settle", async () => {
    const path = "C:/repos/wt/held";
    const held = deferred<WorktreeRemoveOutcome>();
    vi.mocked(removeWorktree).mockReturnValueOnce(held.promise);
    const { result } = renderHook(() => useIsRemovingWorktree(REPO, path));
    expect(result.current).toBe(false);
    let pending!: ReturnType<typeof removeWorktreeForCleanup>;
    act(() => {
      pending = removeWorktreeForCleanup(qc, {
        repoPath: REPO,
        path,
        name: BRANCH,
        branch: BRANCH,
        then: "archive",
      });
    });
    expect(result.current).toBe(true);
    expect(removals()[REPO][path]).toMatchObject({
      branch: BRANCH,
      archiveWhenDone: true,
    });
    await act(async () => {
      held.resolve(outcome("notRequested"));
      await pending;
    });
    expect(result.current).toBe(false);
  });

  it("reports to no listener and no toast, on success or failure", async () => {
    const path = "C:/repos/wt/listened";
    const listener = { onSuccess: vi.fn(), onError: vi.fn() };
    const dispose = registerRemovalListener(REPO, path, listener);
    const args = { repoPath: REPO, path, name: BRANCH, branch: BRANCH };
    expect(
      await removeWorktreeForCleanup(qc, { ...args, then: "archive" }),
    ).toEqual({ ok: true, branch: "archived" });
    const refusal = new Error("fatal: cannot remove the main worktree");
    vi.mocked(removeWorktree).mockRejectedValueOnce(refusal);
    expect(
      await removeWorktreeForCleanup(qc, { ...args, then: "delete" }),
    ).toEqual({ ok: false, reason: presentError(refusal).summary });
    expect(listener.onSuccess).not.toHaveBeenCalled();
    expect(listener.onError).not.toHaveBeenCalled();
    expectSilent();
    dispose();
  });

  it("marks and settles two paths independently", async () => {
    const pathA = "C:/repos/wt/pair-a";
    const pathB = "C:/repos/wt/pair-b";
    const heldA = deferred<WorktreeRemoveOutcome>();
    const heldB = deferred<WorktreeRemoveOutcome>();
    vi.mocked(removeWorktree)
      .mockReturnValueOnce(heldA.promise)
      .mockReturnValueOnce(heldB.promise);
    const a = removeWorktreeForCleanup(qc, {
      repoPath: REPO,
      path: pathA,
      name: "a",
      branch: "a",
      then: "delete",
    });
    const b = removeWorktreeForCleanup(qc, {
      repoPath: REPO,
      path: pathB,
      name: "b",
      branch: "b",
      then: "delete",
    });
    expect(Object.keys(removals()[REPO]).sort()).toEqual([pathA, pathB]);
    expect(removals()[REPO][pathB].archiveWhenDone).toBe(false);
    heldB.resolve(outcome("sparedMoved"));
    expect(await b).toEqual({ ok: true, branch: "keptMoved" });
    expect(Object.keys(removals()[REPO])).toEqual([pathA]);
    heldA.resolve(outcome("deleted"));
    expect(await a).toEqual({ ok: true, branch: "deleted" });
  });
});
