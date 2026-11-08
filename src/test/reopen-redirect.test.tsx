import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOpenRepoByPath } from "@/features/repository/useOpenRepoByPath";
import { track } from "@/lib/analytics";
import type { RepoInfo } from "@/lib/git/types";
import type { UserWorktree } from "@/lib/git/worktree";
import type { LastCheckoutEntry } from "@/lib/last-checkout/store";
import { useUiStore } from "@/lib/stores/ui";

// A recents click on a repo's main row reopens the worktree the repo was left
// in. Every seam the open crosses is mocked: validate, the worktree list, the
// identity resolver, the record snapshot, recents, the shell warm-up and the
// navigator itself (swapped into the ui store).
//
// Reasoned exclusion: an in-app worktree removal racing the click can't target
// a DIFFERENT repo's row, since removal acts on the open repo, whose own row is
// same-identity and never redirects; an external removal between the fresh list
// and the validate is the validate-fail arm below.
const h = vi.hoisted(() => ({
  records: [] as readonly LastCheckoutEntry[],
  ready: vi.fn<() => Promise<void>>(),
  refresh: vi.fn<() => Promise<void>>(),
  validate: vi.fn<(path: string) => Promise<RepoInfo>>(),
  list: vi.fn<(repo: string) => Promise<UserWorktree[]>>(),
  identity: vi.fn<(repo: string) => Promise<string>>(),
  addRecent: vi.fn<(row: { path: string; name: string }) => Promise<void>>(),
  warm: vi.fn<(client: unknown, root: string) => Promise<void>>(),
  openRepo:
    vi.fn<(info: RepoInfo, opts?: { onApplied?: () => void }) => void>(),
}));

vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sonner")>()),
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));
vi.mock("@/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics")>()),
  track: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  validateRepo: (path: string) => h.validate(path),
}));
vi.mock("@/lib/git/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/worktree")>()),
  listUserWorktrees: (repo: string) => h.list(repo),
}));
vi.mock("@/lib/git/repo-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/repo-identity")>()),
  repoIdentityStrict: (repo: string) => h.identity(repo),
}));
vi.mock("@/lib/last-checkout/store", () => ({
  getLastCheckoutSnapshot: () => h.records,
  lastCheckoutReady: () => h.ready(),
  refreshLastCheckout: () => h.refresh(),
  subscribeLastCheckout: () => () => undefined,
}));
vi.mock("@/lib/settings/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/queries")>()),
  useAddRecentRepo: () => ({ mutateAsync: h.addRecent }),
  useRemoveRecentRepo: () => ({ mutateAsync: vi.fn() }),
  useRelocateRecentRepo: () => ({ mutateAsync: vi.fn() }),
  useSettings: () => ({ data: undefined }),
}));
vi.mock(
  "@/features/repository/repo-shell-prefetch",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/features/repository/repo-shell-prefetch")
    >()),
    warmRepoShell: (client: unknown, root: string) => h.warm(client, root),
  }),
);

const MAIN: RepoInfo = { root: "C:\\repos\\demo", name: "demo" };
const WT: RepoInfo = { root: "C:\\repos\\demo-wt", name: "demo-wt" };
const OTHER: RepoInfo = { root: "C:\\repos\\other", name: "other" };
// The record's spelling of the worktree, which the redirect validates.
const WT_RECORDED = "C:/repos/demo-wt";
const ID = "C:/repos/demo/.git";
const OTHER_ID = "C:/repos/other/.git";
const REPOS = [MAIN, WT, OTHER];

function wt(path: string, isMain = false): UserWorktree {
  return {
    path,
    branch: "b",
    head: "a".repeat(40),
    isMain,
    isDetached: false,
    isLocked: false,
    lockReason: "",
    lastActivityMs: null,
  };
}

const fold = (p: string) => p.replace(/\\/g, "/").toLowerCase();

function deferred<T>() {
  const gate: { resolve?: (value: T) => void } = {};
  const promise = new Promise<T>((resolve) => {
    gate.resolve = resolve;
  });
  return { promise, resolve: (value: T) => gate.resolve?.(value) };
}

function renderOpen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useOpenRepoByPath(), { wrapper }).result.current;
}

const opened = () => h.openRepo.mock.calls.map(([info]) => info.root);
const listedFor = () => h.list.mock.calls.map(([repo]) => repo);

beforeEach(() => {
  h.records = [
    {
      identity: ID,
      path: "C:/repos/demo-wt",
      mainPath: "C:/repos/demo",
      at: 1,
    },
  ];
  h.ready.mockReset();
  h.ready.mockResolvedValue(undefined);
  h.refresh.mockReset();
  h.refresh.mockResolvedValue(undefined);
  h.validate.mockReset();
  h.validate.mockImplementation(async (path) => {
    const hit = REPOS.find((r) => fold(r.root) === fold(path));
    if (!hit) throw { kind: "notARepo", message: `${path} is not a repo` };
    return hit;
  });
  h.list.mockReset();
  h.list.mockResolvedValue([wt("C:/repos/demo", true), wt("C:/repos/demo-wt")]);
  h.identity.mockReset();
  h.identity.mockImplementation(async (repo) =>
    fold(repo).startsWith("c:/repos/demo") ? ID : OTHER_ID,
  );
  h.addRecent.mockReset();
  h.addRecent.mockResolvedValue(undefined);
  h.warm.mockReset();
  h.warm.mockResolvedValue(undefined);
  h.openRepo.mockReset();
  vi.mocked(track).mockClear();
  vi.mocked(toast.error).mockClear();
  useUiStore.setState({ repoPath: null, openRepo: h.openRepo });
});

describe("recents redirect", () => {
  it("reopens the remembered worktree from the welcome screen", async () => {
    const open = renderOpen();
    await expect(open(MAIN.root)).resolves.toBe(true);
    expect(opened()).toEqual([WT.root]);
    expect(h.addRecent).toHaveBeenCalledExactlyOnceWith({
      path: MAIN.root,
      name: "demo",
    });
    expect(h.warm.mock.calls.map(([, root]) => root)).toEqual([WT.root]);
    // Only the remembered worktree's identity: no repo was open to compare.
    expect(h.identity.mock.calls.map(([p]) => p)).toEqual([WT_RECORDED]);
    h.openRepo.mock.calls[0]?.[1]?.onApplied?.();
    expect(track).toHaveBeenCalledExactlyOnceWith({
      name: "repo_opened",
      properties: { source: "recent" },
    });
  });

  it("reopens it from another open repo", async () => {
    useUiStore.setState({ repoPath: OTHER.root });
    const open = renderOpen();
    await open(MAIN.root);
    expect(opened()).toEqual([WT.root]);
  });

  it("opens main from inside another worktree of the same repo", async () => {
    useUiStore.setState({ repoPath: "C:\\repos\\demo-hotfix" });
    const open = renderOpen();
    await open(MAIN.root);
    expect(opened()).toEqual([MAIN.root]);
  });

  it("opens main with no extra reads from inside the remembered worktree", async () => {
    useUiStore.setState({ repoPath: WT.root });
    const open = renderOpen();
    await open(MAIN.root);
    expect(opened()).toEqual([MAIN.root]);
    expect(h.identity).not.toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
  });

  it("compares against the repo that was open at the click", async () => {
    useUiStore.setState({ repoPath: WT.root });
    const validated = deferred<RepoInfo>();
    h.validate.mockImplementationOnce(() => validated.promise);
    const open = renderOpen();
    const pending = open(MAIN.root);
    useUiStore.setState({ repoPath: OTHER.root });
    validated.resolve(MAIN);
    await pending;
    expect(opened()).toEqual([MAIN.root]);
  });

  it("reads no worktree list or identity for a row without a record", async () => {
    h.records = [];
    const open = renderOpen();
    await open(MAIN.root);
    expect(opened()).toEqual([MAIN.root]);
    expect(h.validate).toHaveBeenCalledOnce();
    expect(h.refresh).toHaveBeenCalledOnce();
    expect(h.identity).not.toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
  });

  it("a newer click retires a redirect still waiting on readiness, which records and re-reads nothing", async () => {
    const loaded = deferred<void>();
    h.ready.mockImplementationOnce(() => loaded.promise);
    const open = renderOpen();
    const first = open(MAIN.root);
    await vi.waitFor(() => expect(h.ready).toHaveBeenCalledOnce());
    await expect(open(OTHER.root)).resolves.toBe(true);
    const refreshesBefore = h.refresh.mock.calls.length;
    loaded.resolve();
    await expect(first).resolves.toBe(false);
    expect(h.refresh).toHaveBeenCalledTimes(refreshesBefore);
    expect(opened()).toEqual([OTHER.root]);
    expect(h.addRecent.mock.calls.map(([row]) => row.path)).toEqual([
      OTHER.root,
    ]);
  });

  it("never redirects a preferMain click or a picked folder", async () => {
    const open = renderOpen();
    await open(MAIN.root, "recent", undefined, { preferMain: true });
    await open(MAIN.root, "picker");
    expect(opened()).toEqual([MAIN.root, MAIN.root]);
    expect(h.list).not.toHaveBeenCalled();
    // Neither waits on the record store, which only a redirect reads.
    expect(h.ready).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
    // Control: a plain recents click does wait on both.
    await open(MAIN.root);
    expect(h.ready).toHaveBeenCalledOnce();
    expect(h.refresh).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "the fresh list no longer holds it",
      () => {
        h.list.mockResolvedValue([wt("C:/repos/demo", true)]);
      },
    ],
    [
      "the fresh list read fails",
      () => {
        h.list.mockRejectedValue(new Error("git failed"));
      },
    ],
    [
      "the open repo's identity can't be resolved",
      () => {
        useUiStore.setState({ repoPath: OTHER.root });
        h.identity.mockRejectedValue(new Error("ipc down"));
      },
    ],
    [
      "the remembered folder no longer validates",
      () => {
        h.validate.mockImplementation(async (path) => {
          if (fold(path) === fold(MAIN.root)) return MAIN;
          throw { kind: "notARepo", message: `${path} is not a repo` };
        });
      },
    ],
  ])("opens main silently when %s", async (_name, arrange) => {
    arrange();
    const open = renderOpen();
    await expect(open(MAIN.root)).resolves.toBe(true);
    expect(opened()).toEqual([MAIN.root]);
    expect(h.addRecent).toHaveBeenCalledExactlyOnceWith({
      path: MAIN.root,
      name: "demo",
    });
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("a newer click retires a redirect still reading the worktree, which records nothing", async () => {
    const listed = deferred<UserWorktree[]>();
    h.list.mockImplementationOnce(() => listed.promise);
    const open = renderOpen();
    const first = open(MAIN.root);
    await vi.waitFor(() => expect(listedFor()).toEqual([MAIN.root]));
    await expect(open(OTHER.root)).resolves.toBe(true);
    listed.resolve([wt("C:/repos/demo", true), wt("C:/repos/demo-wt")]);
    await expect(first).resolves.toBe(false);
    expect(opened()).toEqual([OTHER.root]);
    expect(h.validate.mock.calls.map(([p]) => p)).toEqual([
      MAIN.root,
      OTHER.root,
    ]);
    expect(h.addRecent.mock.calls.map(([row]) => row.path)).toEqual([
      OTHER.root,
    ]);
  });

  it("a newer click retires a redirect still re-reading the record, which records nothing", async () => {
    const refreshed = deferred<void>();
    let refreshes = 0;
    h.refresh.mockImplementation(() =>
      refreshes++ === 0 ? refreshed.promise : Promise.resolve(),
    );
    const open = renderOpen();
    const first = open(MAIN.root);
    await vi.waitFor(() => expect(refreshes).toBe(1));
    await expect(open(OTHER.root)).resolves.toBe(true);
    refreshed.resolve();
    await expect(first).resolves.toBe(false);
    expect(opened()).toEqual([OTHER.root]);
    expect(h.list).not.toHaveBeenCalled();
    expect(h.addRecent.mock.calls.map(([row]) => row.path)).toEqual([
      OTHER.root,
    ]);
  });

  it.each([
    ["a redirecting click", undefined],
    ["a Shift-escape click", { preferMain: true }],
  ])("%s retired while it validates records nothing", async (_name, opts) => {
    const validated = deferred<RepoInfo>();
    h.validate.mockImplementationOnce(() => validated.promise);
    const open = renderOpen();
    const first = open(MAIN.root, "recent", undefined, opts);
    await expect(open(OTHER.root)).resolves.toBe(true);
    validated.resolve(MAIN);
    await expect(first).resolves.toBe(false);
    expect(opened()).toEqual([OTHER.root]);
    expect(h.addRecent.mock.calls.map(([row]) => row.path)).toEqual([
      OTHER.root,
    ]);
  });

  it("a superseded plain open still records its repo, after the newer one", async () => {
    const validated = deferred<RepoInfo>();
    h.validate.mockImplementationOnce(() => validated.promise);
    const open = renderOpen();
    const first = open(MAIN.root, "picker");
    await expect(open(OTHER.root, "picker")).resolves.toBe(true);
    validated.resolve(MAIN);
    await expect(first).resolves.toBe(false);
    expect(opened()).toEqual([OTHER.root]);
    expect(h.addRecent.mock.calls.map(([row]) => row.path)).toEqual([
      OTHER.root,
      MAIN.root,
    ]);
  });
});

describe("recents redirect fix-round arms", () => {
  it("opens main when an ancestor repo answers for the remembered path", async () => {
    const ancestor: RepoInfo = { root: "C:/repos", name: "repos" };
    h.validate.mockImplementation(async (path) => {
      if (fold(path) === fold(MAIN.root)) return MAIN;
      if (fold(path) === fold(WT.root)) return ancestor;
      throw { kind: "notARepo", message: "not a repo" };
    });
    const open = renderOpen();
    await open(MAIN.root);
    expect(opened()).toEqual([MAIN.root]);
    expect(h.identity).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("opens main when a different repo now lives at the remembered path", async () => {
    h.identity.mockImplementation(async (repo) =>
      fold(repo) === fold(WT.root) ? "C:/elsewhere/foreign/.git" : OTHER_ID,
    );
    const open = renderOpen();
    await open(MAIN.root);
    expect(opened()).toEqual([MAIN.root]);
    expect(h.identity.mock.calls.map(([p]) => p)).toEqual([WT_RECORDED]);
  });

  it("reopens it when the landed identity differs only in case and slashes", async () => {
    h.identity.mockImplementation(async (repo) =>
      fold(repo) === fold(WT.root) ? "c:\\REPOS\\Demo\\.git" : OTHER_ID,
    );
    const open = renderOpen();
    await open(MAIN.root);
    expect(opened()).toEqual([WT.root]);
  });

  it("reads the remembered worktree's identity only once it validates", async () => {
    const validated = deferred<RepoInfo>();
    h.validate.mockImplementation(async (path) => {
      if (fold(path) === fold(MAIN.root)) return MAIN;
      return validated.promise;
    });
    const open = renderOpen();
    const pending = open(MAIN.root);
    await vi.waitFor(() => expect(h.validate).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.identity).not.toHaveBeenCalled();
    validated.resolve(WT);
    await pending;
    expect(h.identity.mock.calls.map(([p]) => p)).toEqual([WT_RECORDED]);
    expect(opened()).toEqual([WT.root]);
  });

  it("never resolves the identity of a remembered folder that fails to validate", async () => {
    h.validate.mockImplementation(async (path) => {
      if (fold(path) === fold(MAIN.root)) return MAIN;
      throw { kind: "notARepo", message: `${path} is not a repo` };
    });
    const open = renderOpen();
    await open(MAIN.root);
    expect(opened()).toEqual([MAIN.root]);
    expect(h.identity).not.toHaveBeenCalled();
  });

  it("waits for the record re-read before looking up the row's record", async () => {
    h.records = [];
    const loaded = deferred<void>();
    h.refresh.mockImplementation(() => loaded.promise);
    const open = renderOpen();
    const pending = open(MAIN.root);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.openRepo).not.toHaveBeenCalled();
    h.records = [
      {
        identity: ID,
        path: "C:/repos/demo-wt",
        mainPath: "C:/repos/demo",
        at: 1,
      },
    ];
    loaded.resolve();
    await pending;
    expect(opened()).toEqual([WT.root]);
  });

  it("reads the open repo's identity and the fresh list in parallel", async () => {
    useUiStore.setState({ repoPath: OTHER.root });
    const identity = deferred<string>();
    h.identity.mockImplementationOnce(() => identity.promise);
    const open = renderOpen();
    const pending = open(MAIN.root);
    await vi.waitFor(() => expect(listedFor()).toEqual([MAIN.root]));
    identity.resolve(OTHER_ID);
    await pending;
    expect(opened()).toEqual([WT.root]);
  });

  it("starts the open repo's identity read while the fresh list is still reading", async () => {
    useUiStore.setState({ repoPath: OTHER.root });
    const listed = deferred<UserWorktree[]>();
    h.list.mockImplementationOnce(() => listed.promise);
    const open = renderOpen();
    const pending = open(MAIN.root);
    await vi.waitFor(() =>
      expect(h.identity.mock.calls.map(([p]) => p)).toEqual([OTHER.root]),
    );
    listed.resolve([wt("C:/repos/demo", true), wt("C:/repos/demo-wt")]);
    await pending;
    expect(opened()).toEqual([WT.root]);
  });

  it("waits out a startup load slower than the re-read's bound", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      h.records = [];
      const loaded = deferred<void>();
      // The re-read queues behind the startup load on the store's chain.
      h.ready.mockImplementation(() => loaded.promise);
      h.refresh.mockImplementation(() => loaded.promise);
      const open = renderOpen();
      let settled = false;
      const pending = open(MAIN.root).then((ok) => {
        settled = true;
        return ok;
      });
      await vi.advanceTimersByTimeAsync(3000);
      expect(settled).toBe(false);
      expect(h.openRepo).not.toHaveBeenCalled();
      h.records = [
        {
          identity: ID,
          path: "C:/repos/demo-wt",
          mainPath: "C:/repos/demo",
          at: 1,
        },
      ];
      loaded.resolve();
      for (let i = 0; i < 20 && !settled; i++)
        await vi.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toBe(true);
      expect(opened()).toEqual([WT.root]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes on with the snapshot it has once the re-read outlasts its bound", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      h.refresh.mockImplementation(() => new Promise<void>(() => undefined));
      const open = renderOpen();
      let settled = false;
      const pending = open(MAIN.root).then((ok) => {
        settled = true;
        return ok;
      });
      await vi.advanceTimersByTimeAsync(1499);
      expect(h.list).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      for (let i = 0; i < 20 && !settled; i++)
        await vi.advanceTimersByTimeAsync(10);
      expect(settled).toBe(true);
      await expect(pending).resolves.toBe(true);
      expect(opened()).toEqual([WT.root]);
    } finally {
      vi.useRealTimers();
    }
  });
});
