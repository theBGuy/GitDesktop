import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComparePanel } from "@/features/compare/ComparePanel";
import {
  clearPickRemotesForTests,
  recordPickRemote,
  remoteCompareRows,
  resolvePick,
  usePickRemote,
} from "@/features/compare/compare-remote-ref";
import { TabPanel } from "@/features/repository/TabPanel";
import {
  forgePrsForBranch,
  forgeStatus,
  gitBranches,
  gitCompareBranches,
  gitDefaultBranch,
  gitFetchRemote,
  gitRemoteAdd,
  gitRemoteBranches,
  gitRemotes,
  gitStatus,
} from "@/lib/git/api";
import { remoteBranchesOptions, repoKeys } from "@/lib/git/queries";
import type {
  Branch,
  CommitSummary,
  ForgeStatus,
  RemoteBranch,
  RepoStatus,
} from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { usePrCreateStore } from "@/lib/stores/pr-create";
import { useUiStore } from "@/lib/stores/ui";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitStatus: vi.fn(),
  gitBranches: vi.fn(),
  gitDefaultBranch: vi.fn(),
  gitRemotes: vi.fn(),
  gitRemoteBranches: vi.fn(),
  gitRemoteAdd: vi.fn(),
  gitFetchRemote: vi.fn(),
  gitCompareBranches: vi.fn(),
  forgeStatus: vi.fn(),
  forgePrsForBranch: vi.fn(),
  gitBranchDivergence: vi.fn(() => new Promise(() => undefined)),
  gitBranchAhead: vi.fn(async () => [{ hash: "a".repeat(40) }]),
  gitBranchDiff: vi.fn(() => new Promise(() => undefined)),
  gitRemoteDefaultBranch: vi.fn(async () => "main"),
  readRepoInstructions: vi.fn(async () => null),
  gitRemoteUrl: vi.fn(() => new Promise(() => undefined)),
  forgeRepoLabels: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("@/lib/ai/ignore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/ignore")>()),
  aiExcludePatterns: vi.fn(async () => []),
}));
vi.mock("@/lib/git/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/worktree")>()),
  listUserWorktrees: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("@/lib/repo-lens/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/repo-lens/store")>()),
  loadRepoLens: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("@/lib/jira/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jira/store")>()),
  getJiraLink: vi.fn(async () => null),
}));
vi.mock("@/lib/review-notes/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/review-notes/store")>()),
  getReviewNote: vi.fn(async () => null),
  deleteReviewNote: vi.fn(async () => undefined),
}));

const REPO = "C:/repo";
const FEATURE_REF = "refs/remotes/origin/feature-x";
const UPDATING = "Updating the comparison…";

const GITHUB = {
  provider: "github",
  installed: true,
  authenticated: true,
  repo: "me/project",
  host: "github.com",
  login: "me",
  capabilities: {},
  implemented: { mrCreate: true, pullRequests: true },
} as unknown as ForgeStatus;

const COMMIT = {
  hash: "b".repeat(40),
  shortHash: "bbbbbbb",
  subject: "ahead work",
  author: "me",
  date: new Date(Date.UTC(2026, 9, 1)).toISOString(),
  tags: [],
  isMerge: false,
} as unknown as CommitSummary;

const branch = (name: string, isCurrent = false) =>
  ({ name, isCurrent, archived: false, lastCommitDate: "" }) as Branch;

const remote = (r: string, name: string): RemoteBranch => ({
  remote: r,
  name,
  lastCommitDate: "",
});

const statusOf = (name: string) =>
  ({
    branch: {
      name,
      detached: false,
      upstreamRemote: null,
      upstreamBranch: null,
    },
    files: [],
  }) as unknown as RepoStatus;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The panel under a TabPanel the test can hide, rendering the store's repo
 *  as RepositoryView does. */
function renderPanelView() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Live() {
    const repo = useUiStore((s) => s.repoPath) ?? REPO;
    return <ComparePanel repoPath={repo} />;
  }
  const ui = (active: boolean) => (
    <QueryClientProvider client={client}>
      <TabPanel active={active}>
        <Live />
      </TabPanel>
    </QueryClientProvider>
  );
  const view = render(ui(true));
  return { client, setActive: (active: boolean) => view.rerender(ui(active)) };
}

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TabPanel active>
        <ComparePanel repoPath={REPO} />
      </TabPanel>
    </QueryClientProvider>,
  );
  return client;
}

const trigger = () =>
  screen.findByRole("combobox", { name: "Compare with branch" });

const popup = () =>
  waitFor(() => {
    const list = screen
      .queryAllByRole("listbox")
      .find((l) => l.getAttribute("aria-label") !== "Compare selection");
    if (!list) throw new Error("picker popup not open");
    return list;
  });

const statusLine = (text: string) =>
  screen.findByText(text, { selector: "p[role=status]" });

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

const FORK_SETTINGS = {
  ...DEFAULT_SETTINGS,
  recentRepos: [{ path: REPO, isFork: true, forkParent: "octo/project" }],
} as unknown as typeof DEFAULT_SETTINGS;

function forkWithoutUpstream() {
  vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
  vi.mocked(loadSettings).mockResolvedValue(FORK_SETTINGS);
}

async function pickOption(
  user: ReturnType<typeof userEvent.setup>,
  name: RegExp,
) {
  await user.click(await trigger());
  await user.click(await within(await popup()).findByRole("option", { name }));
}

const fetchedRemotes = () =>
  vi.mocked(gitFetchRemote).mock.calls.map(([, r]) => r);

const createButton = () =>
  screen.getByRole("button", { name: /^Create pull request/ });

beforeEach(() => {
  vi.clearAllMocks();
  clearPickRemotesForTests();
  onlineManager.setOnline(true);
  useUiStore.setState({ repoPath: REPO, compareBranch: null });
  usePrCreateStore.setState({ byRepo: {} });
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(gitStatus).mockResolvedValue(statusOf("feat"));
  vi.mocked(gitDefaultBranch).mockResolvedValue("main");
  vi.mocked(gitBranches).mockResolvedValue([
    branch("feat", true),
    branch("main"),
    branch("dev"),
  ]);
  vi.mocked(gitRemoteBranches).mockResolvedValue([
    remote("upstream", "main"),
    remote("origin", "feature-x"),
  ]);
  vi.mocked(gitCompareBranches).mockResolvedValue({
    ahead: [COMMIT],
    behind: [],
  });
  vi.mocked(gitFetchRemote).mockResolvedValue(undefined);
  vi.mocked(gitRemoteAdd).mockResolvedValue(undefined);
  vi.mocked(forgeStatus).mockResolvedValue(GITHUB);
  vi.mocked(forgePrsForBranch).mockResolvedValue([]);
  vi.mocked(gitRemotes).mockResolvedValue(["origin", "upstream"]);
});

afterEach(() => {
  onlineManager.setOnline(true);
});

describe("Compare follow-up that failed beside a running pick", () => {
  it("shows the follow-up's failed line once the pick settles", async () => {
    forkWithoutUpstream();
    // Settled before the end: the single-flight map is module state.
    const originFetch = deferred<void>();
    vi.mocked(gitFetchRemote).mockImplementation((_repo, r) =>
      r === "origin"
        ? originFetch.promise
        : Promise.reject(new Error("upstream boom")),
    );
    const user = userEvent.setup();
    renderPanel();
    await pickOption(user, /^origin\/feature-x/);
    await statusLine("Fetching origin…");
    await pickOption(user, /^Add upstream remote/);
    await waitFor(() => expect(fetchedRemotes()).toContain("upstream"));
    await settle();
    // The live pick keeps its line and hold.
    expect(
      screen.getByText("Fetching origin…", { selector: "p[role=status]" }),
    ).toBeInTheDocument();
    expect(createButton()).toHaveAccessibleDescription("Fetching origin…");
    await act(async () => originFetch.resolve());
    expect(await statusLine("Couldn't fetch upstream.")).toBeInTheDocument();
    vi.mocked(gitFetchRemote).mockResolvedValue(undefined);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(fetchedRemotes().filter((r) => r === "upstream")).toHaveLength(2),
    );
    await waitFor(() =>
      expect(screen.queryByText("Couldn't fetch upstream.")).toBeNull(),
    );
  });

  it("shows a hidden follow-up's reconnect failure once the pick settles", async () => {
    forkWithoutUpstream();
    const user = userEvent.setup();
    renderPanel();
    await trigger();
    act(() => onlineManager.setOnline(false));
    await pickOption(user, /^origin\/feature-x/);
    await statusLine(
      "You're offline, so this compares against origin's last fetch.",
    );
    await pickOption(user, /^Add upstream remote/);
    await waitFor(() => expect(gitRemoteAdd).toHaveBeenCalled());
    await settle();
    vi.mocked(gitFetchRemote).mockImplementation((_repo, r) =>
      r === "origin"
        ? Promise.resolve()
        : Promise.reject(new Error("upstream boom")),
    );
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(fetchedRemotes()).toContain("upstream"));
    expect(await statusLine("Couldn't fetch upstream.")).toBeInTheDocument();
  });

  it("drops a waiting failure when another pick replaces the running one", async () => {
    forkWithoutUpstream();
    const originFetch = deferred<void>();
    vi.mocked(gitFetchRemote).mockImplementation((_repo, r) =>
      r === "origin"
        ? originFetch.promise
        : Promise.reject(new Error("upstream boom")),
    );
    const user = userEvent.setup();
    renderPanel();
    await pickOption(user, /^origin\/feature-x/);
    await statusLine("Fetching origin…");
    await pickOption(user, /^Add upstream remote/);
    await waitFor(() => expect(fetchedRemotes()).toContain("upstream"));
    await settle();
    await pickOption(user, /^dev/);
    await act(async () => originFetch.resolve());
    await settle();
    expect(screen.queryByText("Couldn't fetch upstream.")).toBeNull();
  });

  it("drops a follow-up failure that lands after another pick", async () => {
    forkWithoutUpstream();
    const originFetch = deferred<void>();
    const upstreamFetch = deferred<void>();
    vi.mocked(gitFetchRemote).mockImplementation((_repo, r) =>
      r === "origin" ? originFetch.promise : upstreamFetch.promise,
    );
    const user = userEvent.setup();
    renderPanel();
    await pickOption(user, /^origin\/feature-x/);
    await statusLine("Fetching origin…");
    await pickOption(user, /^Add upstream remote/);
    await waitFor(() => expect(fetchedRemotes()).toContain("upstream"));
    await pickOption(user, /^dev/);
    await act(async () => upstreamFetch.reject(new Error("upstream boom")));
    await act(async () => originFetch.resolve());
    await settle();
    expect(screen.queryByText("Couldn't fetch upstream.")).toBeNull();
  });

  it("keeps a failed pick's own line and Retry over a waiting failure", async () => {
    forkWithoutUpstream();
    const originFetch = deferred<void>();
    vi.mocked(gitFetchRemote).mockImplementation((_repo, r) =>
      r === "origin"
        ? originFetch.promise
        : Promise.reject(new Error("upstream boom")),
    );
    const user = userEvent.setup();
    renderPanel();
    await pickOption(user, /^origin\/feature-x/);
    await statusLine("Fetching origin…");
    await pickOption(user, /^Add upstream remote/);
    await waitFor(() => expect(fetchedRemotes()).toContain("upstream"));
    await settle();
    await act(async () => originFetch.reject(new Error("origin boom")));
    const pickLine =
      "Couldn't fetch origin, so this compares against its last fetch.";
    expect(await statusLine(pickLine)).toBeInTheDocument();
    await settle();
    expect(screen.queryByText("Couldn't fetch upstream.")).toBeNull();
    // A successful retry frees the slot for the waiting failure.
    vi.mocked(gitFetchRemote).mockImplementation((_repo, r) =>
      r === "origin"
        ? Promise.resolve()
        : Promise.reject(new Error("upstream boom")),
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await statusLine("Couldn't fetch upstream.")).toBeInTheDocument();
    expect(screen.queryByText(pickLine)).toBeNull();
  });

  it("shows a re-parked follow-up's online failure after a pick", async () => {
    forkWithoutUpstream();
    const originFetch = deferred<void>();
    const firstUpstream = deferred<void>();
    let upstreamCalls = 0;
    vi.mocked(gitFetchRemote).mockImplementation((_repo, r) => {
      if (r === "origin") return originFetch.promise;
      upstreamCalls += 1;
      return upstreamCalls === 1
        ? firstUpstream.promise
        : Promise.reject(new Error("upstream auth"));
    });
    const user = userEvent.setup();
    renderPanel();
    await pickOption(user, /^origin\/feature-x/);
    await statusLine("Fetching origin…");
    await pickOption(user, /^Add upstream remote/);
    await waitFor(() => expect(upstreamCalls).toBe(1));
    await pickOption(user, /^dev/);
    // A blip: the unseen fetch fails offline and re-parks.
    act(() => onlineManager.setOnline(false));
    await act(async () => firstUpstream.reject(new Error("offline")));
    await settle();
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(upstreamCalls).toBe(2));
    expect(await statusLine("Couldn't fetch upstream.")).toBeInTheDocument();
    await act(async () => originFetch.resolve());
  });

  it("keeps a failed pick's line when the follow-up starts after the failure", async () => {
    forkWithoutUpstream();
    vi.mocked(gitFetchRemote).mockImplementation((_repo, r) =>
      r === "origin"
        ? Promise.reject(new Error("origin boom"))
        : Promise.resolve(),
    );
    const user = userEvent.setup();
    renderPanel();
    await pickOption(user, /^origin\/feature-x/);
    const pickLine =
      "Couldn't fetch origin, so this compares against its last fetch.";
    await statusLine(pickLine);
    await pickOption(user, /^Add upstream remote/);
    await waitFor(() => expect(fetchedRemotes()).toContain("upstream"));
    await settle();
    expect(
      screen.getByText(pickLine, { selector: "p[role=status]" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("drops a follow-up failure after a repo round trip made while hidden", async () => {
    forkWithoutUpstream();
    const originFetch = deferred<void>();
    const upstreamFetch = deferred<void>();
    vi.mocked(gitFetchRemote).mockImplementation((_repo, r) =>
      r === "origin" ? originFetch.promise : upstreamFetch.promise,
    );
    const user = userEvent.setup();
    const view = renderPanelView();
    await pickOption(user, /^origin\/feature-x/);
    await statusLine("Fetching origin…");
    await pickOption(user, /^Add upstream remote/);
    await waitFor(() => expect(fetchedRemotes()).toContain("upstream"));
    view.setActive(false);
    await settle();
    act(() => useUiStore.setState({ repoPath: "C:/other" }));
    await settle();
    act(() => useUiStore.setState({ repoPath: REPO }));
    await settle();
    await act(async () => upstreamFetch.reject(new Error("upstream boom")));
    await act(async () => originFetch.resolve());
    view.setActive(true);
    await settle();
    expect(screen.queryByText("Couldn't fetch upstream.")).toBeNull();
  });

  it("re-parks a hidden follow-up that fails offline again after a pick", async () => {
    forkWithoutUpstream();
    let upstreamCalls = 0;
    vi.mocked(gitFetchRemote).mockImplementation((_repo, r) => {
      if (r !== "upstream") return Promise.resolve();
      upstreamCalls += 1;
      if (upstreamCalls > 1) return Promise.resolve();
      // The reconnect blips: offline again before the fetch fails.
      onlineManager.setOnline(false);
      return Promise.reject(new Error("offline"));
    });
    const user = userEvent.setup();
    renderPanel();
    await trigger();
    act(() => onlineManager.setOnline(false));
    await pickOption(user, /^origin\/feature-x/);
    await statusLine(
      "You're offline, so this compares against origin's last fetch.",
    );
    await pickOption(user, /^Add upstream remote/);
    await waitFor(() => expect(gitRemoteAdd).toHaveBeenCalled());
    await settle();
    await pickOption(user, /^dev/);
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(upstreamCalls).toBe(1));
    await settle();
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(upstreamCalls).toBe(2));
  });
});

describe("Compare fetch stamp over the post-fetch comparison", () => {
  it("keeps the fetch line and Create's hold until the comparison re-reads", async () => {
    const fetch = deferred<void>();
    vi.mocked(gitFetchRemote).mockReturnValue(fetch.promise);
    const reread = deferred<{ ahead: CommitSummary[]; behind: [] }>();
    let pickReads = 0;
    vi.mocked(gitCompareBranches).mockImplementation(
      async (_repo, base, compare) => {
        if (base !== FEATURE_REF && compare !== FEATURE_REF)
          return { ahead: [COMMIT], behind: [] };
        pickReads += 1;
        return pickReads === 1
          ? { ahead: [COMMIT], behind: [] }
          : reread.promise;
      },
    );
    const user = userEvent.setup();
    renderPanel();
    await pickOption(user, /^origin\/feature-x/);
    await statusLine("Fetching origin…");
    await waitFor(() => expect(pickReads).toBe(1));
    await act(async () => fetch.resolve());
    await waitFor(() => expect(pickReads).toBe(2));
    await settle();
    // The fetch is done; the line and Create's reason say what still runs.
    expect(
      screen.getByText(UPDATING, { selector: "p[role=status]" }),
    ).toBeInTheDocument();
    expect(createButton()).toHaveAccessibleDescription(UPDATING);
    await act(async () => reread.resolve({ ahead: [], behind: [] }));
    await waitFor(() =>
      expect(createButton()).toHaveAccessibleDescription(
        "feat has no commits to propose onto origin/feature-x",
      ),
    );
    expect(screen.queryByText("Fetching origin…")).toBeNull();
  });

  it("re-reads a comparison whose first read straddled the fetch", async () => {
    const fetch = deferred<void>();
    vi.mocked(gitFetchRemote).mockReturnValue(fetch.promise);
    const first = deferred<{ ahead: CommitSummary[]; behind: [] }>();
    const reread = deferred<{ ahead: CommitSummary[]; behind: [] }>();
    let pickReads = 0;
    vi.mocked(gitCompareBranches).mockImplementation(
      async (_repo, base, compare) => {
        if (base !== FEATURE_REF && compare !== FEATURE_REF)
          return { ahead: [COMMIT], behind: [] };
        pickReads += 1;
        return pickReads === 1 ? first.promise : reread.promise;
      },
    );
    const user = userEvent.setup();
    renderPanel();
    await pickOption(user, /^origin\/feature-x/);
    await statusLine("Fetching origin…");
    await waitFor(() => expect(pickReads).toBe(1));
    // The fetch settles while the first read, begun before it, still runs.
    await act(async () => fetch.resolve());
    await settle();
    await act(async () => first.resolve({ ahead: [COMMIT], behind: [] }));
    await waitFor(() => expect(pickReads).toBe(2));
    await settle();
    expect(createButton()).toHaveAccessibleDescription(UPDATING);
    await act(async () => reread.resolve({ ahead: [], behind: [] }));
    await waitFor(() =>
      expect(createButton()).toHaveAccessibleDescription(
        "feat has no commits to propose onto origin/feature-x",
      ),
    );
  });

  it("never holds the stamp on an unrelated read of the fetched remote", async () => {
    const user = userEvent.setup();
    const client = renderPanel();
    // An open file diff of the comparison: same remote, never answers.
    const stalled = new QueryObserver(client, {
      queryKey: [
        ...repoKeys.compare(REPO, FEATURE_REF, "feat"),
        "file",
        "a.ts",
      ],
      queryFn: () => new Promise(() => undefined),
      networkMode: "always",
    });
    const unsubscribe = stalled.subscribe(() => undefined);
    await pickOption(user, /^origin\/feature-x/);
    await waitFor(() => {
      expect(screen.queryByText("Fetching origin…")).toBeNull();
      expect(screen.queryByText(UPDATING)).toBeNull();
    });
    expect(createButton()).not.toHaveAccessibleDescription("Fetching origin…");
    expect(createButton()).not.toHaveAccessibleDescription(UPDATING);
    unsubscribe();
  });

  it("re-reads the remote list beside a disabled observer while hidden", async () => {
    const fetch = deferred<void>();
    vi.mocked(gitFetchRemote).mockReturnValue(fetch.promise);
    const listReread = deferred<RemoteBranch[]>();
    let listReads = 0;
    vi.mocked(gitRemoteBranches).mockImplementation(async () => {
      listReads += 1;
      return listReads === 1
        ? [remote("upstream", "main"), remote("origin", "feature-x")]
        : listReread.promise;
    });
    const user = userEvent.setup();
    const view = renderPanelView();
    // The header's branch menu: a closed menu holds a disabled observer.
    const menu = new QueryObserver(view.client, {
      ...remoteBranchesOptions(REPO),
      enabled: false,
    });
    const unsubscribe = menu.subscribe(() => undefined);
    await pickOption(user, /^origin\/feature-x/);
    await statusLine("Fetching origin…");
    view.setActive(false);
    await settle();
    const before = listReads;
    await act(async () => fetch.resolve());
    await waitFor(() => expect(listReads).toBe(before + 1));
    view.setActive(true);
    await settle();
    expect(createButton()).toHaveAccessibleDescription(UPDATING);
    await act(async () =>
      listReread.resolve([
        remote("upstream", "main"),
        remote("origin", "feature-x"),
      ]),
    );
    await waitFor(() =>
      expect(createButton()).not.toHaveAccessibleDescription(UPDATING),
    );
    unsubscribe();
  });

  it("skips the settle reads of a fire a newer pick superseded", async () => {
    const originFetch = deferred<void>();
    vi.mocked(gitFetchRemote).mockImplementation((_repo, r) =>
      r === "origin" ? originFetch.promise : Promise.resolve(),
    );
    const user = userEvent.setup();
    renderPanel();
    await pickOption(user, /^origin\/feature-x/);
    await statusLine("Fetching origin…");
    await pickOption(user, /^upstream\/main/);
    await settle();
    const featureReads = () =>
      vi
        .mocked(gitCompareBranches)
        .mock.calls.filter(([, base]) => base === FEATURE_REF).length;
    const before = featureReads();
    await act(async () => originFetch.resolve());
    await settle();
    expect(featureReads()).toBe(before);
  });

  it("reads the comparison after a fetch that settled while Compare was hidden", async () => {
    const fetch = deferred<void>();
    vi.mocked(gitFetchRemote).mockReturnValue(fetch.promise);
    const reread = deferred<{ ahead: CommitSummary[]; behind: [] }>();
    let pickReads = 0;
    vi.mocked(gitCompareBranches).mockImplementation(
      async (_repo, base, compare) => {
        if (base !== FEATURE_REF && compare !== FEATURE_REF)
          return { ahead: [COMMIT], behind: [] };
        pickReads += 1;
        return pickReads === 1
          ? { ahead: [COMMIT], behind: [] }
          : reread.promise;
      },
    );
    const user = userEvent.setup();
    const view = renderPanelView();
    await pickOption(user, /^origin\/feature-x/);
    await statusLine("Fetching origin…");
    await waitFor(() => expect(pickReads).toBe(1));
    view.setActive(false);
    await settle();
    await act(async () => fetch.resolve());
    // Hidden, the invalidation only marks it stale: the read runs anyway.
    await waitFor(() => expect(pickReads).toBe(2));
    view.setActive(true);
    await settle();
    expect(createButton()).toHaveAccessibleDescription(UPDATING);
    await act(async () => reread.resolve({ ahead: [], behind: [] }));
    await waitFor(() =>
      expect(createButton()).toHaveAccessibleDescription(
        "feat has no commits to propose onto origin/feature-x",
      ),
    );
  });
});

describe("Compare pick remote records", () => {
  const VALUE = "refs/remotes/team/fork/x";

  it("never records a first-slash guess no listed remote names", () => {
    expect(recordPickRemote(REPO, VALUE, ["origin"])?.remote).toBe("team");
    const { result } = renderHook(() => usePickRemote(REPO, VALUE));
    expect(result.current).toBeNull();
    // Control: a listed remote is recorded.
    act(() => {
      recordPickRemote(REPO, VALUE, ["origin", "team"]);
    });
    expect(result.current).toBe("team");
  });

  it("lets a longer listed remote win over a shorter record", () => {
    expect(resolvePick(VALUE, ["origin", "team", "team/fork"], "team")).toEqual(
      { remote: "team/fork", name: "x", display: "team/fork/x" },
    );
    // A removed slash remote keeps its record over the shorter re-split.
    expect(resolvePick(VALUE, ["origin", "team"], "team/fork")).toEqual({
      remote: "team/fork",
      name: "x",
      display: "team/fork/x",
    });
  });
});

describe("Compare pick corrected to a longer remote", () => {
  it("keeps the longer remote's identity after that remote is removed", async () => {
    vi.mocked(gitRemotes).mockResolvedValue(["origin", "team"]);
    vi.mocked(gitRemoteBranches).mockResolvedValue([
      remote("origin", "feature-x"),
      remote("team", "fork/x"),
    ]);
    const user = userEvent.setup();
    const client = renderPanel();
    await pickOption(user, /^team\/fork\/x/);
    await settle();
    vi.mocked(gitRemotes).mockResolvedValue(["origin", "team", "team/fork"]);
    await act(() =>
      client.refetchQueries({ queryKey: ["repo", REPO, "remotes"] }),
    );
    await settle();
    vi.mocked(gitRemotes).mockResolvedValue(["origin", "team"]);
    await act(() =>
      client.refetchQueries({ queryKey: ["repo", REPO, "remotes"] }),
    );
    expect(
      await statusLine("team/fork is no longer a remote."),
    ).toBeInTheDocument();
  });
});

describe("Compare remote rows for a slash remote", () => {
  it("drops the slash remote's own HEAD row", () => {
    const rows = remoteCompareRows(
      [remote("team", "fork/HEAD"), remote("team", "fork/main")],
      new Set(),
      ["team/fork"],
    );
    expect(rows.map((r) => r.display)).toEqual(["team/fork/main"]);
  });
});

describe("Compare picker empty copy", () => {
  it("speaks for every branch when cached remote rows were searched", async () => {
    const user = userEvent.setup();
    const client = renderPanel();
    await user.click(await trigger());
    await within(await popup()).findByRole("option", {
      name: /^origin\/feature-x/,
    });
    vi.mocked(gitRemoteBranches).mockRejectedValue(new Error("list boom"));
    await act(() =>
      client
        .refetchQueries({ queryKey: remoteBranchesOptions(REPO).queryKey })
        .catch(() => undefined),
    );
    await user.type(screen.getByPlaceholderText("Filter branches…"), "zzz");
    expect(await screen.findByText("No branches match")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Remote: Couldn't refresh remote branches — showing the last loaded results.",
      ),
    ).toBeInTheDocument();
  });

  it("speaks for the local branches while remote rows are unknown", async () => {
    vi.mocked(gitRemoteBranches).mockReturnValue(new Promise(() => undefined));
    const user = userEvent.setup();
    renderPanel();
    await user.click(await trigger());
    await within(await popup()).findByRole("option", { name: /^dev/ });
    await user.type(screen.getByPlaceholderText("Filter branches…"), "zzz");
    expect(
      await screen.findByText("No local branches match"),
    ).toBeInTheDocument();
  });
});

describe("Compare add-upstream row over a failed remotes refresh", () => {
  it("withdraws the row when the remotes refresh fails over a cached list", async () => {
    forkWithoutUpstream();
    const user = userEvent.setup();
    const client = renderPanel();
    await user.click(await trigger());
    await within(await popup()).findByRole("option", {
      name: /^Add upstream remote/,
    });
    await user.keyboard("{Escape}");
    vi.mocked(gitRemotes).mockRejectedValue(new Error("remotes boom"));
    await act(() =>
      client
        .refetchQueries({ queryKey: ["repo", REPO, "remotes"] })
        .catch(() => undefined),
    );
    await user.click(await trigger());
    const list = await popup();
    await within(list).findByRole("option", { name: /^origin\/feature-x/ });
    expect(
      within(list).queryByRole("option", { name: /Add upstream remote/ }),
    ).toBeNull();
  });
});
