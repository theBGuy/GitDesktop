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
  gitOpState,
  gitSetBranchArchived,
  gitUpdateBranchFrom,
  validateRepo,
} from "@/lib/git/api";
import { normPath } from "@/lib/git/path";
import {
  useAbortLocalPrMerge,
  useFinishLocalPrMerge,
  useMergeLocalPr,
  useUpdateBranchFrom,
} from "@/lib/git/queries";
import type { RepoOpState } from "@/lib/git/types";
import {
  beginPromoteWindow,
  listUserWorktrees,
  listWorktrees,
  pruneWorktrees,
  removeWorktree,
  type UserWorktree,
  type WorktreeRemoveOutcome,
} from "@/lib/git/worktree";
import {
  isBranchPromoting,
  isWorktreePromoting,
  plainRemovalPaths,
  registerRemovalListener,
  removeWorktreeForCleanup,
  useIsRemovingWorktree,
  useWorktreeRemovalStore,
  type WorktreeRemoval,
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
  gitOpState: vi.fn(),
  gitSetBranchArchived: vi.fn(),
  gitUpdateBranchFrom: vi.fn(),
  validateRepo: vi.fn(),
}));
vi.mock("@/lib/git/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/worktree")>()),
  beginPromoteWindow: vi.fn(),
  listUserWorktrees: vi.fn(),
  listWorktrees: vi.fn(),
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
    id: "pr-1",
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

const worktree = (path: string, branch: string): UserWorktree => ({
  path,
  branch,
  head: "0".repeat(64),
  isMain: false,
  isDetached: branch === "",
  isLocked: false,
  lockReason: "",
  lastActivityMs: null,
});

/** The default worktree list: every worktree still marked for removal, holding
 *  the branch it was marked with, so each call's fire-time re-read finds its own
 *  row unchanged and the archive step (after the mark settles) finds it gone. */
async function listMarkedWorktrees(): Promise<UserWorktree[]> {
  return Object.values(removals()).flatMap((entries) =>
    Object.values(entries).map((r) => worktree(r.path, r.branch ?? "")),
  );
}

const QUIET_OP_STATE: RepoOpState = {
  merging: false,
  rebasing: false,
  cherryPicking: false,
  reverting: false,
  editPaused: false,
  rebaseStop: null,
};

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  unmockedCommands.length = 0;
  vi.mocked(removeWorktree).mockResolvedValue(outcome("deleted"));
  vi.mocked(pruneWorktrees).mockResolvedValue(undefined);
  vi.mocked(listUserWorktrees).mockImplementation(listMarkedWorktrees);
  // The archive step's unfiltered list: by then the removed worktree is gone.
  vi.mocked(listWorktrees).mockResolvedValue([]);
  vi.mocked(gitOpState).mockResolvedValue(QUIET_OP_STATE);
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
    // The first call reaches the removal only after its fire-time re-read.
    await waitFor(() => expect(removeWorktree).toHaveBeenCalledTimes(1));
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

describe("removeWorktreeForCleanup fire-time re-check", () => {
  const cleanup = (path: string, then: "archive" | "delete" = "delete") =>
    removeWorktreeForCleanup(qc, {
      repoPath: REPO,
      path,
      name: BRANCH,
      branch: BRANCH,
      then,
    });

  it.each([
    ["holds another branch", "other-branch"],
    ["is detached", ""],
  ])("refuses when the worktree now %s", async (_state, holds) => {
    const path = "C:/repos/wt/switched";
    vi.mocked(listUserWorktrees).mockResolvedValueOnce([worktree(path, holds)]);
    expect(await cleanup(path)).toEqual({
      ok: false,
      reason: "the worktree no longer has this branch checked out",
    });
    expect(removeWorktree).not.toHaveBeenCalled();
    expectSilent();
  });

  it("refuses when the path left the list", async () => {
    vi.mocked(listUserWorktrees).mockResolvedValueOnce([
      worktree("C:/repos/wt/elsewhere", BRANCH),
    ]);
    expect(await cleanup("C:/repos/wt/gone")).toEqual({
      ok: false,
      reason: "the worktree was moved or removed",
    });
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("fails safe when the list can't be read", async () => {
    vi.mocked(listUserWorktrees).mockRejectedValueOnce(
      new Error("git worktree list failed"),
    );
    expect(await cleanup("C:/repos/wt/unlisted", "archive")).toEqual({
      ok: false,
      reason: "the worktree list was unreadable",
    });
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(gitOpState).not.toHaveBeenCalled();
    expect(gitSetBranchArchived).not.toHaveBeenCalled();
  });

  it("matches a backslash path against the list's forward slashes", async () => {
    const path = "C:\\Repos\\WT\\back-slashed";
    vi.mocked(listUserWorktrees).mockResolvedValueOnce([
      worktree("C:/repos/wt/back-slashed", BRANCH),
    ]);
    expect(await cleanup(path)).toEqual({ ok: true, branch: "deleted" });
    expect(listUserWorktrees).toHaveBeenCalledWith(REPO);
    expect(gitOpState).toHaveBeenCalledWith(path);
    expect(removeWorktree).toHaveBeenCalledWith(REPO, path, BRANCH, false);
  });

  it.each([
    ["merging", "merge"],
    ["rebasing", "rebase"],
    ["cherryPicking", "cherry-pick"],
    ["reverting", "revert"],
  ] as const)("refuses while %s", async (flag, op) => {
    vi.mocked(gitOpState).mockResolvedValueOnce({
      ...QUIET_OP_STATE,
      [flag]: true,
    });
    expect(await cleanup(`C:/repos/wt/op-${op}`)).toEqual({
      ok: false,
      reason: `the worktree is in the middle of a ${op}`,
    });
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("names the rebase when a rebase stopped inside a merge", async () => {
    vi.mocked(gitOpState).mockResolvedValueOnce({
      ...QUIET_OP_STATE,
      merging: true,
      rebasing: true,
    });
    expect(await cleanup("C:/repos/wt/op-both")).toEqual({
      ok: false,
      reason: "the worktree is in the middle of a rebase",
    });
  });

  it("refuses with the read's error when the op state can't be read", async () => {
    vi.mocked(gitOpState).mockRejectedValueOnce(
      new Error("Not a git repository."),
    );
    expect(await cleanup("C:/repos/wt/op-unreadable")).toEqual({
      ok: false,
      reason: "Not a git repository",
    });
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("refuses a local-PR write that started during the re-read", async () => {
    const path = "C:/repos/wt/late-write";
    const list = deferred<UserWorktree[]>();
    vi.mocked(listUserWorktrees).mockReturnValueOnce(list.promise);
    const pending = cleanup(path);
    stageUpdate(REPO, BRANCH);
    list.resolve([worktree(path, BRANCH)]);
    expect(await pending).toEqual({
      ok: false,
      reason: "an update is running on this branch",
    });
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("refuses a local-PR write that started during the op-state read", async () => {
    const path = "C:/repos/wt/late-write-op";
    const op = deferred<RepoOpState>();
    vi.mocked(gitOpState).mockReturnValueOnce(op.promise);
    const pending = cleanup(path);
    await waitFor(() => expect(gitOpState).toHaveBeenCalledWith(path));
    stageUpdate(REPO, BRANCH);
    op.resolve(QUIET_OP_STATE);
    expect(await pending).toEqual({
      ok: false,
      reason: "an update is running on this branch",
    });
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("settles the mark on a refusal, so the next call isn't refused as removing", async () => {
    const path = "C:/repos/wt/retry-after-refusal";
    vi.mocked(listUserWorktrees).mockResolvedValueOnce([]);
    expect(await cleanup(path)).toEqual({
      ok: false,
      reason: "the worktree was moved or removed",
    });
    expect(removals()).toEqual({});
    expect(await cleanup(path)).toEqual({ ok: true, branch: "deleted" });
    expect(removeWorktree).toHaveBeenCalledTimes(1);
  });
});

describe("a removal marked under another viewer's repo key", () => {
  it("refuses both starters for the same folder in another spelling", async () => {
    const marked = "C:/repos/wt/cross-viewer";
    const respelled = "C:\\Repos\\WT\\cross-viewer";
    const held = deferred<WorktreeRemoveOutcome>();
    vi.mocked(removeWorktree).mockReturnValueOnce(held.promise);
    const first = removeWorktreeForCleanup(qc, {
      repoPath: "C:/repos/viewer-a",
      path: marked,
      name: BRANCH,
      branch: BRANCH,
      then: "delete",
    });
    expect(
      await removeWorktreeForCleanup(qc, {
        repoPath: REPO,
        path: respelled,
        name: BRANCH,
        branch: BRANCH,
        then: "delete",
      }),
    ).toEqual({ ok: false, reason: "the worktree is being removed" });
    expect(
      useWorktreeRemovalStore.getState().startRemoval({
        repoPath: "C:/repos/viewer-b",
        path: respelled,
        name: BRANCH,
        branch: BRANCH,
        archiveWhenDone: false,
        force: false,
      }),
    ).toBe("This worktree is already being removed.");
    expect(Object.keys(removals())).toEqual(["C:/repos/viewer-a"]);
    held.resolve(outcome("deleted"));
    expect(await first).toEqual({ ok: true, branch: "deleted" });
    expect(removeWorktree).toHaveBeenCalledTimes(1);
  });

  it("refuses a promote of the same folder in another spelling", async () => {
    const held = deferred<WorktreeRemoveOutcome>();
    vi.mocked(removeWorktree).mockReturnValueOnce(held.promise);
    const first = removeWorktreeForCleanup(qc, {
      repoPath: "C:/repos/viewer-a",
      path: "C:/repos/wt/cross-promote",
      name: BRANCH,
      branch: BRANCH,
      then: "delete",
    });
    const respelled = "C:\\Repos\\WT\\cross-promote";
    expect(
      useWorktreeRemovalStore.getState().startPromote({
        mainPath: "C:/repos/main-cross",
        worktreePath: respelled,
        branch: BRANCH,
        willStash: false,
      }),
    ).toBe("This worktree is already being removed.");
    expect(isWorktreePromoting(respelled)).toBe(false);
    expect(validateRepo).not.toHaveBeenCalled();
    held.resolve(outcome("deleted"));
    expect(await first).toEqual({ ok: true, branch: "deleted" });
  });
});

describe("the in-flight readers", () => {
  const entry = (
    path: string,
    promotePhase?: WorktreeRemoval["promotePhase"],
  ): WorktreeRemoval => ({
    path,
    name: BRANCH,
    branch: BRANCH,
    archiveWhenDone: false,
    startedAt: 0,
    promotePhase,
  });

  it("lists plain removals under every repo key in normalized spelling, never a promote's", () => {
    const plain = "C:\\Repos\\WT\\plain-in-flight";
    const promoted = "C:/repos/wt/promote-in-flight";
    useWorktreeRemovalStore.setState({
      byRepo: {
        "C:/repos/viewer-a": { [plain]: entry(plain) },
        "C:/repos/viewer-b": { [promoted]: entry(promoted, "removing") },
      },
    });
    try {
      const paths = plainRemovalPaths();
      expect(paths.has(normPath("C:/repos/wt/plain-in-flight"))).toBe(true);
      expect(paths.has(normPath(promoted))).toBe(false);
      expect(paths.size).toBe(1);
    } finally {
      useWorktreeRemovalStore.setState({ byRepo: {} });
    }
  });

  it.each(["removing", "stashing", "checking-out"] as const)(
    "names a branch a promote holds under any repo key while %s",
    (phase) => {
      const path = "C:/repos/wt/promote-tail";
      useWorktreeRemovalStore.setState({
        byRepo: {
          "C:/repos/viewer-b": { [path]: entry(path, phase) },
          "C:/repos/viewer-a": {
            "C:/repos/wt/plain-other": {
              ...entry("C:/repos/wt/plain-other"),
              branch: "plain-branch",
            },
          },
        },
      });
      try {
        expect(isBranchPromoting(BRANCH)).toBe(true);
        expect(isBranchPromoting("plain-branch")).toBe(false);
        expect(isBranchPromoting("unmarked")).toBe(false);
      } finally {
        useWorktreeRemovalStore.setState({ byRepo: {} });
      }
    },
  );
});

describe("the archive step leaves a branch checked out again unarchived", () => {
  const OTHER_HOLDER = "C:/repos/wt/other-holder";
  const SESSION_HOLDER = "C:/appdata/worktrees/sess1";
  const IN_USE_ARMS: [name: string, arrange: () => void][] = [
    [
      "current in this checkout",
      () => {
        vi.mocked(gitBranches).mockResolvedValueOnce([
          { name: BRANCH, archived: false, isCurrent: true },
        ] as Branches);
      },
    ],
    [
      "held by a linked worktree",
      () => {
        vi.mocked(listUserWorktrees).mockImplementation(async () => [
          ...(await listMarkedWorktrees()),
          worktree(OTHER_HOLDER, BRANCH),
        ]);
        vi.mocked(listWorktrees).mockResolvedValue([
          { id: "other-holder", path: OTHER_HOLDER, branch: BRANCH, base: "" },
        ]);
      },
    ],
    [
      // The user list leaves agent-session folders out whatever they hold.
      "held by a session-owned worktree",
      () => {
        vi.mocked(listWorktrees).mockResolvedValue([
          { id: "main", path: REPO, branch: "main", base: "" },
          { id: "sess1", path: SESSION_HOLDER, branch: BRANCH, base: "" },
        ]);
      },
    ],
  ];

  it.each(IN_USE_ARMS)("cleanup keeps it when %s", async (_arm, arrange) => {
    arrange();
    expect(
      await removeWorktreeForCleanup(qc, {
        repoPath: REPO,
        path: "C:/repos/wt/in-use",
        name: BRANCH,
        branch: BRANCH,
        then: "archive",
      }),
    ).toEqual({ ok: true, branch: "keptInUse" });
    expect(removeWorktree).toHaveBeenCalledTimes(1);
    expect(gitSetBranchArchived).not.toHaveBeenCalled();
    expectSilent();
  });

  it.each(IN_USE_ARMS)(
    "the delete dialog toasts it when %s",
    async (_arm, arrange) => {
      arrange();
      useWorktreeRemovalStore.getState().startRemoval({
        repoPath: REPO,
        path: "C:/repos/wt/dialog-in-use",
        name: BRANCH,
        branch: BRANCH,
        archiveWhenDone: true,
        force: false,
      });
      await waitFor(() =>
        expect(toast.info).toHaveBeenCalledWith(
          `Left ${BRANCH} unarchived — it's checked out again.`,
        ),
      );
      expect(toast.success).toHaveBeenCalledWith("Worktree removed");
      expect(gitSetBranchArchived).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "the branch list",
      () => {
        vi.mocked(gitBranches).mockRejectedValueOnce(new Error("no list"));
      },
    ],
    [
      "the worktree list",
      () => {
        vi.mocked(listWorktrees).mockRejectedValueOnce(new Error("no list"));
      },
    ],
  ])("archives anyway when %s can't be read", async (_read, arrange) => {
    arrange();
    expect(
      await removeWorktreeForCleanup(qc, {
        repoPath: REPO,
        path: "C:/repos/wt/in-use-unreadable",
        name: BRANCH,
        branch: BRANCH,
        then: "archive",
      }),
    ).toEqual({ ok: true, branch: "archived" });
    expect(gitSetBranchArchived).toHaveBeenCalledWith(REPO, BRANCH, true);
  });
});
