import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ActivityDock } from "@/features/activity/ActivityDock";
import { openAutomationResult } from "@/lib/automations/results";
import { pathIsDir, validateRepo } from "@/lib/git/api";
import { remotesOptions } from "@/lib/git/queries";
import { repoIdentity } from "@/lib/git/repo-identity";
import type { RepoInfo } from "@/lib/git/types";
import { emitNotification } from "@/lib/notifications/emit";
import { applyRepoLens, cachedRepoLens } from "@/lib/repo-lens/queries";
import {
  loadSettings,
  type NotificationOutcome,
  type NotificationSource,
} from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { __resetNavHistoryForTests, canGoBack } from "@/lib/stores/nav-history";
import {
  clearAllNotifications,
  type NotificationKind,
  type NotificationTarget,
} from "@/lib/stores/notifications";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

// The dock's resolve ladder validates the captured checkout first; a row with no
// identity stamp lands there, so validateRepo is its only git read. pathIsDir
// answering false keeps emit from stamping an identity on the row; the stamped
// cases flip it and answer repoIdentity (mocked below) themselves.
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  pathIsDir: vi.fn(async () => false),
  validateRepo: vi.fn(),
}));
// Echoes the path, the resolver's own stand-in, so an identity reads "unknown"
// unless a case answers otherwise; the real read would reach an unmocked command.
vi.mock("@/lib/git/repo-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/repo-identity")>()),
  repoIdentity: vi.fn(async (path: string) => path),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
// The notification and review stores open plugin stores at module load.
vi.mock("@/lib/plugin-store", async (importOriginal) => {
  const store = {
    get: async () => undefined,
    set: async () => undefined,
    save: async () => undefined,
  };
  return {
    ...(await importOriginal<typeof import("@/lib/plugin-store")>()),
    memoizedStoreLoader: () => async () => store,
  };
});
// A call-through spy: the lens write still lands, and the test reads which ones ran.
vi.mock("@/lib/repo-lens/queries", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/repo-lens/queries")>();
  return { ...real, applyRepoLens: vi.fn(real.applyRepoLens) };
});
vi.mock("@/lib/automations/results", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/automations/results")>()),
  openAutomationResult: vi.fn(),
}));
// The real module registers the app's repo-shell warm-up on import, which would
// hold every cross-repo landing on prefetches; the dock needs only its claim.
vi.mock("@/features/repository/useOpenRepoByPath", async () => {
  const { createOpenClaims } = await import(
    "@/features/repository/open-claims"
  );
  const { useUiStore: store } = await import("@/lib/stores/ui");
  return {
    claimRepoOpen: createOpenClaims(() => store.getState().interactionEpoch)
      .claim,
  };
});

const REPO = "C:/repos/alpha";
const OTHER = "C:/repos/beta";
const st = () => useUiStore.getState();

function resetStore() {
  useUiStore.setState(useUiStore.getInitialState(), true);
  __resetNavHistoryForTests();
}

beforeEach(() => {
  resetStore();
  clearAllNotifications();
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
  vi.mocked(validateRepo).mockReset();
  vi.mocked(validateRepo).mockImplementation(
    async (path: string) =>
      ({ root: path, name: path.split("/").pop() }) as RepoInfo,
  );
  vi.mocked(pathIsDir).mockImplementation(async () => false);
  vi.mocked(repoIdentity).mockImplementation(async (path: string) => path);
  vi.mocked(openAutomationResult).mockReset();
  vi.mocked(applyRepoLens).mockClear();
});

afterEach(() => {
  act(() => {
    resetStore();
    clearAllNotifications();
  });
});

afterAll(() => expect(unmockedCommands).toEqual([]));

// The source that delivers each kind; DEFAULT_SETTINGS has every source on in-app,
// and both outcome filters at "all".
const ROUTE: Partial<
  Record<
    NotificationKind,
    { source: NotificationSource; outcome?: NotificationOutcome }
  >
> = {
  "pr-opened": { source: "prActivity" },
  "ci-run": { source: "actionRuns", outcome: "success" },
  "agent-done": { source: "agents" },
  "checks-passed": { source: "prChecks", outcome: "success" },
  "checks-failed": { source: "prChecks", outcome: "failure" },
  "review-posted": { source: "reviews" },
};

/** Alpha open on History, the dock open over one row for beta, rendered
 *  under `client`. */
async function mountWithRow(
  kind: NotificationKind,
  target?: NotificationTarget,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const route = ROUTE[kind];
  if (!route) throw new Error(`no source routed for ${kind}`);
  await act(async () => {
    st().openRepo({ root: REPO, name: "alpha" });
    st().setRepoTab("history");
    emitNotification({
      ...route,
      row: {
        kind,
        tone: "info",
        title: "the beta event",
        repoPath: OTHER,
        repoName: "beta",
        target,
      },
    } as Parameters<typeof emitNotification>[0]);
    st().setActivityOpen(true);
    // emit delivers after its settings and override reads settle.
    await new Promise((r) => setTimeout(r, 0));
  });
  render(
    <QueryClientProvider client={client}>
      <ActivityDock />
    </QueryClientProvider>,
  );
  return screen.findByRole("button", { name: /^the beta event/ });
}

describe("a notification click into another repository keeps the history", () => {
  const NONE = { selectedPr: null, selectedRunId: null };
  it.each<[string, NotificationKind, NotificationTarget, string, object]>([
    [
      "pr (openPr)",
      "pr-opened",
      { type: "pr", kind: "remote", ref: "7" },
      "pulls",
      { selectedPr: { kind: "remote", id: "7" } },
    ],
    [
      "run (openRun)",
      "ci-run",
      { type: "run", runId: 42 },
      "actions",
      { selectedRunId: 42 },
    ],
    ["agent (openAgentTab)", "agent-done", { type: "agent" }, "agent", NONE],
    [
      "repo (openRepoView)",
      "checks-passed",
      { type: "repo", tab: "issues" },
      "issues",
      NONE,
    ],
  ])(
    "%s lands in beta with alpha behind it, and Back returns",
    async (_n, kind, target, tab, selection) => {
      fireEvent.click(await mountWithRow(kind, target));
      await waitFor(() => expect(st().repoPath).toBe(OTHER));
      expect(validateRepo).toHaveBeenCalledWith(OTHER);
      expect(st().repoTab).toBe(tab);
      expect(st()).toMatchObject(selection);
      expect(st().navHistory.segments.map((s) => s.repoPath)).toEqual([
        REPO,
        OTHER,
      ]);
      expect(canGoBack(st())).toBe(true);
      act(() => st().goBack());
      await waitFor(() => expect(st().repoPath).toBe(REPO));
      expect(st().repoTab).toBe("history");
    },
  );
});

describe("dock clicks that open nothing leave the history alone", () => {
  it.each<
    [string, NotificationKind, NotificationTarget | undefined, unknown[][]]
  >([
    [
      "an automation result",
      "review-posted",
      { type: "automation-result", id: "r1" },
      // The row carries no identity stamp (pathIsDir answers false).
      [[OTHER, "r1", undefined]],
    ],
    ["a row with no route", "checks-failed", undefined, []],
  ])("%s", async (_n, kind, target, resultOpens) => {
    const row = await mountWithRow(kind, target);
    const before = st().navHistory;
    fireEvent.click(row);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(st().repoPath).toBe(REPO);
    expect(st().navHistory).toBe(before);
    expect(validateRepo).not.toHaveBeenCalled();
    expect(vi.mocked(openAutomationResult).mock.calls).toEqual(resultOpens);
  });
});

describe("an unstamped row opens only the folder it names", () => {
  // No identity stamp, so git's top level for the stored folder is the only
  // evidence; a walk-up to an enclosing repository is someone else's repo.
  it("refuses an enclosing repository and says nothing was opened", async () => {
    const info = vi.spyOn(toast, "info");
    vi.mocked(validateRepo).mockImplementation(
      async () => ({ root: "C:/repos", name: "repos" }) as RepoInfo,
    );
    const row = await mountWithRow("pr-opened", {
      type: "pr",
      kind: "remote",
      ref: "7",
    });
    const before = st().navHistory;
    fireEvent.click(row);
    await waitFor(() => expect(info).toHaveBeenCalledTimes(1));
    expect(info.mock.calls[0][0]).toMatch(/no longer exists/);
    expect(validateRepo).toHaveBeenCalledWith(OTHER);
    expect(st().repoPath).toBe(REPO);
    expect(st().selectedPr).toBeNull();
    expect(st().navHistory).toBe(before);
    info.mockRestore();
  });

  it("opens the same folder in another slash and case spelling", async () => {
    const root = String.raw`C:\Repos\Beta`;
    vi.mocked(validateRepo).mockImplementation(
      async () => ({ root, name: "beta" }) as RepoInfo,
    );
    fireEvent.click(
      await mountWithRow("pr-opened", { type: "pr", kind: "remote", ref: "7" }),
    );
    await waitFor(() => expect(st().repoPath).toBe(root));
    expect(st().selectedPr).toEqual({ kind: "remote", id: "7" });
  });
});

describe("a stamped row opens its stored folder only as that repository", () => {
  const STAMP = "C:/repos/beta/.git";
  /** A row emitted with an identity stamp, whose identity then reads "unknown"
   *  (the resolver's path stand-in) at the click. */
  async function stampedRow(stamp = STAMP) {
    vi.mocked(pathIsDir).mockImplementation(async () => true);
    vi.mocked(repoIdentity).mockImplementation(async (path: string) =>
      path === OTHER ? stamp : path,
    );
    const row = await mountWithRow("pr-opened", {
      type: "pr",
      kind: "remote",
      ref: "7",
    });
    vi.mocked(repoIdentity).mockImplementation(async (path: string) => path);
    // emit itself reads the identity; only the click's reads are asserted.
    vi.mocked(repoIdentity).mockClear();
    return row;
  }

  it("refuses an enclosing repository whose identity is unknown", async () => {
    const info = vi.spyOn(toast, "info");
    const row = await stampedRow();
    // git's walk-up answers the enclosing repository for every candidate.
    vi.mocked(validateRepo).mockImplementation(
      async () => ({ root: "C:/repos", name: "repos" }) as RepoInfo,
    );
    const before = st().navHistory;
    fireEvent.click(row);
    await waitFor(() => expect(info).toHaveBeenCalledTimes(1));
    expect(info.mock.calls[0][0]).toMatch(/no longer exists/);
    expect(validateRepo).toHaveBeenCalledWith(OTHER);
    // The stamped arm ran: the unstamped one never reads an identity.
    expect(repoIdentity).toHaveBeenCalledWith("C:/repos");
    expect(st().repoPath).toBe(REPO);
    expect(st().selectedPr).toBeNull();
    expect(st().navHistory).toBe(before);
    info.mockRestore();
  });

  it("opens the stored folder itself when its identity is unknown", async () => {
    fireEvent.click(await stampedRow());
    await waitFor(() => expect(st().repoPath).toBe(OTHER));
    expect(repoIdentity).toHaveBeenCalledWith(OTHER);
    expect(st().selectedPr).toEqual({ kind: "remote", id: "7" });
  });

  it("refuses the repo on screen when it validates to an enclosing repository", async () => {
    const info = vi.spyOn(toast, "info");
    const row = await stampedRow();
    // The child on screen lost its git metadata: every candidate validates to
    // the enclosing repo, while the memo still answers the stamp for the child.
    act(() => st().openRepo({ root: OTHER, name: "beta" }));
    vi.mocked(validateRepo).mockImplementation(
      async () => ({ root: "C:/repos", name: "repos" }) as RepoInfo,
    );
    vi.mocked(repoIdentity).mockImplementation(async (path: string) =>
      path === OTHER ? STAMP : "C:/repos/.git",
    );
    fireEvent.click(row);
    await waitFor(() => expect(info).toHaveBeenCalledTimes(1));
    expect(info.mock.calls[0][0]).toMatch(/no longer exists/);
    expect(validateRepo).toHaveBeenCalledWith(OTHER);
    expect(st().repoPath).toBe(OTHER);
    expect(st().selectedPr).toBeNull();
    info.mockRestore();
  });

  it("keeps another live checkout of the repository on screen", async () => {
    const info = vi.spyOn(toast, "info");
    const row = await stampedRow();
    const wt = "C:/wt/beta";
    act(() => st().openRepo({ root: wt, name: "beta" }));
    // The stored folder is a stale child of another repository, while the
    // linked worktree on screen is live and carries the stamp. Exactly OTHER
    // maps to the enclosing root, so the stored folder is not the one on screen.
    // Validate answers Windows' backslashed spelling: the rung lands on the
    // store's own spelling, never validate's.
    vi.mocked(validateRepo).mockImplementation(async (path: string) => {
      if (path === OTHER) {
        return { root: "C:/repos", name: "repos" } as RepoInfo;
      }
      if (path === wt) {
        return { root: String.raw`C:\wt\beta`, name: "beta" } as RepoInfo;
      }
      throw new Error("not a repository");
    });
    vi.mocked(repoIdentity).mockImplementation(async (path: string) => {
      if (path === wt) return STAMP;
      return path === "C:/repos" ? "C:/repos/.git" : path;
    });
    fireEvent.click(row);
    await waitFor(() =>
      expect(st().selectedPr).toEqual({ kind: "remote", id: "7" }),
    );
    expect(st().repoPath).toBe(wt);
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("lands a stale nested repository at the enclosing main checkout", async () => {
    const stamp = "C:/main/.git";
    const row = await stampedRow(stamp);
    act(() => {
      st().openRepo({ root: "C:/main/sub", name: "sub" });
      useUiStore.setState({ selectedIssue: { kind: "remote", id: "3" } });
    });
    vi.mocked(validateRepo).mockImplementation(async (path: string) => {
      if (path === "C:/main/sub" || path === "C:/main") {
        return { root: "C:/main", name: "main" } as RepoInfo;
      }
      throw new Error("not a repository");
    });
    // The nested folder's memo still answers its own, different repository.
    vi.mocked(repoIdentity).mockImplementation(async (path: string) => {
      if (path === "C:/main") return stamp;
      return path === "C:/main/sub" ? "C:/main/sub/.git" : path;
    });
    fireEvent.click(row);
    await waitFor(() => expect(st().repoPath).toBe("C:/main"));
    expect(st().selectedPr).toEqual({ kind: "remote", id: "7" });
  });
});

describe("a pull request row lands under the lens it happened under", () => {
  const landed = async (
    target: NotificationTarget,
    kind: string,
    client?: QueryClient,
  ) => {
    fireEvent.click(await mountWithRow("pr-opened", target, client));
    await waitFor(() => expect(st().repoPath).toBe(OTHER));
    expect(st().selectedPr).toEqual({ kind, id: "7" });
  };

  it("a remote row stamped upstream applies upstream, session-only", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // Beta's gate is open (an authenticated GitHub fork) with no lens stored,
    // so only the landing's apply can make the effective lens upstream.
    client.setQueryData(["repo", OTHER, "forge-status"], {
      provider: "github",
      authenticated: true,
    });
    client.setQueryData(remotesOptions(OTHER).queryKey, ["origin", "upstream"]);
    expect(cachedRepoLens(client, OTHER)).toBe("origin");
    await landed(
      { type: "pr", kind: "remote", ref: "7", lens: "upstream" },
      "remote",
      client,
    );
    expect(cachedRepoLens(client, OTHER)).toBe("upstream");
    expect(vi.mocked(applyRepoLens).mock.calls).toEqual([
      [
        expect.any(QueryClient),
        OTHER,
        "upstream",
        { clearSelections: true, persist: false },
      ],
    ]);
  });

  it("a remote row with no lens leaves the lens alone", async () => {
    await landed({ type: "pr", kind: "remote", ref: "7" }, "remote");
    expect(applyRepoLens).not.toHaveBeenCalled();
  });

  it("a local row never applies a lens, even one it carries", async () => {
    await landed(
      { type: "pr", kind: "local", ref: "7", lens: "upstream" },
      "local",
    );
    expect(applyRepoLens).not.toHaveBeenCalled();
  });
});
