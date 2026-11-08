import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComparePanel } from "@/features/compare/ComparePanel";
import { comparePrTarget } from "@/features/compare/compare-pr-target";
import { TabPanel } from "@/features/repository/TabPanel";
import {
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
import { repoKeys } from "@/lib/git/queries";
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
  forgePrsForBranch: vi.fn(async () => []),
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
const OTHER = "C:/other";
const NO_PICK = "Pick a branch to compare against";

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

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = (r: string): ReactNode => (
    <QueryClientProvider client={client}>
      <TabPanel active>
        <ComparePanel repoPath={r} />
      </TabPanel>
    </QueryClientProvider>
  );
  const view = render(ui(REPO));
  return {
    client,
    switchTo: (r: string) => {
      useUiStore.setState({ repoPath: r, compareBranch: null });
      view.rerender(ui(r));
    },
  };
}

const trigger = () =>
  screen.findByRole("combobox", { name: "Compare with branch" });

/** The picker's popup list (the panel's own commit list is a listbox too). */
const popup = () =>
  waitFor(() => {
    const list = screen
      .queryAllByRole("listbox")
      .find((l) => l.getAttribute("aria-label") !== "Compare selection");
    if (!list) throw new Error("picker popup not open");
    return list;
  });

/** The fetch status line's text, never the Create button's held reason. */
const statusLine = (text: string) =>
  screen.findByText(text, { selector: "p[role=status]" });

function forkWithoutUpstream(paths = [REPO]) {
  vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
  vi.mocked(loadSettings).mockResolvedValue({
    ...DEFAULT_SETTINGS,
    recentRepos: paths.map((path) => ({
      path,
      isFork: true,
      forkParent: "octo/project",
    })),
  } as unknown as typeof DEFAULT_SETTINGS);
}

async function addUpstreamFromPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await trigger());
  const list = await popup();
  await user.click(
    await within(list).findByRole("option", { name: /^Add upstream remote/ }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
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
  vi.mocked(gitRemotes).mockResolvedValue(["origin", "upstream"]);
});

afterEach(() => {
  onlineManager.setOnline(true);
});

describe("Compare with no local branch to default to", () => {
  it("rests on a prompt instead of a skeleton that never loads", async () => {
    vi.mocked(gitBranches).mockResolvedValue([branch("feat", true)]);
    renderPanel();
    expect(await trigger()).toHaveTextContent(NO_PICK);
    expect(screen.getByText(NO_PICK, { selector: "p" })).toBeInTheDocument();
    expect(screen.queryByText("Loading commits…")).toBeNull();
  });

  it("waits for the add-upstream offer's inputs before saying there is nothing", async () => {
    vi.mocked(gitBranches).mockResolvedValue([branch("feat", true)]);
    vi.mocked(gitRemoteBranches).mockResolvedValue([]);
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    const settings = deferred<typeof DEFAULT_SETTINGS>();
    vi.mocked(loadSettings).mockReturnValue(settings.promise);
    renderPanel();
    await waitFor(() => expect(gitRemoteBranches).toHaveBeenCalled());
    await waitFor(() => expect(gitRemotes).toHaveBeenCalled());
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.queryByText("No other branches")).toBeNull();
    await act(async () =>
      settings.resolve({
        ...DEFAULT_SETTINGS,
        recentRepos: [{ path: REPO, isFork: true, forkParent: "octo/project" }],
      } as unknown as typeof DEFAULT_SETTINGS),
    );
    expect(await trigger()).toHaveTextContent(NO_PICK);
  });

  it("keeps focus on the panel when an empty-state Retry succeeds", async () => {
    vi.mocked(gitBranches).mockResolvedValue([branch("feat", true)]);
    vi.mocked(gitRemoteBranches)
      .mockRejectedValueOnce(new Error("remote read failed"))
      .mockResolvedValue([]);
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No other branches")).toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe("Compare add-upstream follow-up line", () => {
  it("claims nothing about the comparison and retires on the next pick", async () => {
    forkWithoutUpstream();
    vi.mocked(gitFetchRemote).mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    renderPanel();
    await addUpstreamFromPicker(user);
    expect(await statusLine("Couldn't fetch upstream.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(await trigger());
    await user.click(
      await within(await popup()).findByRole("option", { name: /^dev/ }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Couldn't fetch upstream.")).toBeNull(),
    );
  });

  it("drops a parked follow-up when the repo changes", async () => {
    forkWithoutUpstream();
    const user = userEvent.setup();
    const view = renderPanel();
    await trigger();
    act(() => onlineManager.setOnline(false));
    await addUpstreamFromPicker(user);
    const offline =
      "You're offline. upstream will be fetched when you reconnect.";
    expect(await statusLine(offline)).toBeInTheDocument();
    await user.keyboard("{Escape}");
    view.switchTo(OTHER);
    await trigger();
    view.switchTo(REPO);
    await waitFor(() => expect(screen.queryByText(offline)).toBeNull());
  });

  it("still fetches a parked follow-up once on reconnect after a pick hides it", async () => {
    forkWithoutUpstream();
    const user = userEvent.setup();
    renderPanel();
    await trigger();
    act(() => onlineManager.setOnline(false));
    await addUpstreamFromPicker(user);
    const offline =
      "You're offline. upstream will be fetched when you reconnect.";
    expect(await statusLine(offline)).toBeInTheDocument();
    await user.click(await trigger());
    await user.click(
      await within(await popup()).findByRole("option", {
        name: /^origin\/feature-x/,
      }),
    );
    await waitFor(() => expect(screen.queryByText(offline)).toBeNull());
    expect(gitFetchRemote).not.toHaveBeenCalled();
    act(() => onlineManager.setOnline(true));
    await waitFor(() =>
      expect(gitFetchRemote).toHaveBeenCalledWith(REPO, "origin"),
    );
    await waitFor(() =>
      expect(gitFetchRemote).toHaveBeenCalledWith(REPO, "upstream"),
    );
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(
      vi.mocked(gitFetchRemote).mock.calls.filter(([, r]) => r === "upstream"),
    ).toHaveLength(1);
    expect(screen.queryByText("Fetching upstream…")).toBeNull();
    expect(screen.queryByText(offline)).toBeNull();
  });

  it("drops a hidden parked follow-up when the repo changes", async () => {
    forkWithoutUpstream();
    const user = userEvent.setup();
    const view = renderPanel();
    await trigger();
    act(() => onlineManager.setOnline(false));
    await addUpstreamFromPicker(user);
    await statusLine(
      "You're offline. upstream will be fetched when you reconnect.",
    );
    await user.click(await trigger());
    await user.click(
      await within(await popup()).findByRole("option", { name: /^dev/ }),
    );
    view.switchTo(OTHER);
    await trigger();
    view.switchTo(REPO);
    await trigger();
    act(() => onlineManager.setOnline(true));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(gitFetchRemote).not.toHaveBeenCalledWith(REPO, "upstream");
  });

  it("never holds another repo's add-upstream offer busy", async () => {
    forkWithoutUpstream([REPO, OTHER]);
    // Settled at the end: the in-flight repo set is module state.
    const addA = deferred<void>();
    vi.mocked(gitRemoteAdd).mockReturnValueOnce(addA.promise);
    const user = userEvent.setup();
    const view = renderPanel();
    await addUpstreamFromPicker(user);
    await waitFor(() => expect(gitRemoteAdd).toHaveBeenCalledTimes(1));
    await user.keyboard("{Escape}");
    view.switchTo(OTHER);
    await addUpstreamFromPicker(user);
    await waitFor(() => expect(gitRemoteAdd).toHaveBeenCalledTimes(2));
    await act(async () => addA.resolve());
  });

  it("keeps a repo's own add busy after another repo's add starts", async () => {
    forkWithoutUpstream([REPO, OTHER]);
    const addA = deferred<void>();
    const addB = deferred<void>();
    vi.mocked(gitRemoteAdd)
      .mockReturnValueOnce(addA.promise)
      .mockReturnValueOnce(addB.promise);
    const user = userEvent.setup();
    const view = renderPanel();
    await addUpstreamFromPicker(user);
    await waitFor(() => expect(gitRemoteAdd).toHaveBeenCalledTimes(1));
    await user.keyboard("{Escape}");
    view.switchTo(OTHER);
    await addUpstreamFromPicker(user);
    await waitFor(() => expect(gitRemoteAdd).toHaveBeenCalledTimes(2));
    await user.keyboard("{Escape}");
    view.switchTo(REPO);
    await user.click(await trigger());
    const busy = await within(await popup()).findByRole("option", {
      name: /^Adding upstream remote…/,
    });
    await user.click(busy);
    expect(gitRemoteAdd).toHaveBeenCalledTimes(2);
    await act(async () => {
      addA.resolve();
      addB.resolve();
    });
  });
});

describe("Compare Create PR hold", () => {
  const parentButton = () =>
    screen.findByRole("button", { name: /Create pull request in parent…/ });

  it("holds while the pick's fetch runs", async () => {
    // Settled at the end: the single-flight map is module state.
    const fetch = deferred<void>();
    vi.mocked(gitFetchRemote).mockReturnValue(fetch.promise);
    const user = userEvent.setup();
    renderPanel();
    await user.click(await trigger());
    await user.click(
      await within(await popup()).findByRole("option", {
        name: /^upstream\/main/,
      }),
    );
    await statusLine("Fetching upstream…");
    await waitFor(async () =>
      expect(await parentButton()).toHaveAccessibleDescription(
        "Fetching upstream…",
      ),
    );
    await act(async () => fetch.resolve());
  });

  it("says it couldn't compare instead of claiming nothing to propose", async () => {
    vi.mocked(gitCompareBranches).mockRejectedValue(new Error("boom"));
    useUiStore.setState({ compareBranch: "refs/remotes/upstream/main" });
    renderPanel();
    await waitFor(async () =>
      expect(await parentButton()).toHaveAccessibleDescription(
        "Couldn't compare with upstream/main",
      ),
    );
  });

  it("says comparing while the comparison is pending", async () => {
    vi.mocked(gitCompareBranches).mockReturnValue(new Promise(() => undefined));
    useUiStore.setState({ compareBranch: "refs/remotes/upstream/main" });
    renderPanel();
    await waitFor(async () =>
      expect(await parentButton()).toHaveAccessibleDescription("Comparing…"),
    );
  });

  it("closes on a repo switch and stays closed in the next repo", async () => {
    useUiStore.setState({ compareBranch: "refs/remotes/upstream/main" });
    const user = userEvent.setup();
    const view = renderPanel();
    await user.click(await parentButton());
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    view.switchTo(OTHER);
    await waitFor(() =>
      expect(useUiStore.getState().compareBranch).toBe("main"),
    );
    await screen.findByRole("button", { name: /^Create pull request…/ });
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps an open dialog when the lens gate flips", async () => {
    useUiStore.setState({ compareBranch: "refs/remotes/upstream/main" });
    const user = userEvent.setup();
    const view = renderPanel();
    await user.click(await parentButton());
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    await act(() =>
      view.client.refetchQueries({ queryKey: ["repo", REPO, "remotes"] }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", {
          name: /Create pull request in parent…/,
          hidden: true,
        }),
      ).toBeNull(),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("Compare fetch invalidation", () => {
  it("refreshes comparisons and rewrite verdicts spelled against the remote", async () => {
    const user = userEvent.setup();
    const { client } = renderPanel();
    const ahead = repoKeys.branchAhead(
      REPO,
      "refs/remotes/upstream/main",
      "refs/heads/feat",
    );
    const rewrite = [...repoKeys.rewriteStatus(REPO), "feat"];
    const unrelated = repoKeys.branchAhead(
      REPO,
      "refs/remotes/origin/main",
      "refs/heads/feat",
    );
    for (const key of [ahead, rewrite, unrelated]) client.setQueryData(key, []);
    await user.click(await trigger());
    await user.click(
      await within(await popup()).findByRole("option", {
        name: /^upstream\/main/,
      }),
    );
    await waitFor(() =>
      expect(client.getQueryState(ahead)?.isInvalidated).toBe(true),
    );
    expect(client.getQueryState(rewrite)?.isInvalidated).toBe(true);
    expect(client.getQueryState(unrelated)?.isInvalidated).toBe(false);
  });
});

describe("Compare pruned and gone picks", () => {
  it("shows only the pruned line over a failed refresh", async () => {
    useUiStore.setState({ compareBranch: "refs/remotes/origin/gone" });
    const { client } = renderPanel();
    expect(
      await statusLine("origin/gone was deleted on origin."),
    ).toBeInTheDocument();
    await screen.findByText("ahead work");
    vi.mocked(gitCompareBranches).mockRejectedValue(new Error("boom"));
    await act(() =>
      client.refetchQueries({ queryKey: ["repo", REPO, "compare"] }),
    );
    expect(
      client
        .getQueryCache()
        .findAll({ queryKey: ["repo", REPO, "compare"] })
        .some((q) => q.state.status === "error"),
    ).toBe(true);
    // Lets the batched observer notification render the failed refresh.
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.queryByText(/Couldn't refresh this comparison/)).toBeNull();
    expect(screen.getByText("ahead work")).toBeInTheDocument();
  });

  it("lets the pruned line outrank a failed fetch's line, naming Create's hold", async () => {
    vi.mocked(gitFetchRemote).mockRejectedValue(new Error("fetch boom"));
    vi.mocked(gitCompareBranches).mockRejectedValue(new Error("compare boom"));
    const user = userEvent.setup();
    const { client } = renderPanel();
    await user.click(await trigger());
    await user.click(
      await within(await popup()).findByRole("option", {
        name: /^upstream\/main/,
      }),
    );
    const failedLine =
      "Couldn't fetch upstream, so this compares against its last fetch.";
    expect(await statusLine(failedLine)).toBeInTheDocument();
    vi.mocked(gitRemoteBranches).mockResolvedValue([]);
    await act(() =>
      client.refetchQueries({ queryKey: ["repo", REPO, "remote-branches"] }),
    );
    // Its "last fetch" is gone, so the line names the cause Create's hold does.
    const pruned = "upstream/main was deleted on upstream.";
    expect(await statusLine(pruned)).toBeInTheDocument();
    expect(screen.queryByText(failedLine)).toBeNull();
    expect(
      await screen.findByRole("button", {
        name: /Create pull request in parent…/,
      }),
    ).toHaveAccessibleDescription(pruned);
  });

  it("says why the comparison failed while a follow-up line outranks the pruned one", async () => {
    forkWithoutUpstream();
    useUiStore.setState({ compareBranch: "refs/remotes/origin/gone" });
    vi.mocked(gitCompareBranches).mockRejectedValue(new Error("compare boom"));
    // Settled at the end: the single-flight map is module state.
    const upstreamFetch = deferred<void>();
    vi.mocked(gitFetchRemote).mockReturnValue(upstreamFetch.promise);
    const user = userEvent.setup();
    renderPanel();
    await statusLine("origin/gone was deleted on origin.");
    await addUpstreamFromPicker(user);
    expect(await statusLine("Fetching upstream…")).toBeInTheDocument();
    // The follow-up line names no cause for the comparison, so its error shows.
    expect(await screen.findByText(/compare boom/)).toBeInTheDocument();
    await act(async () => upstreamFetch.resolve());
  });

  it("names a removed remote", async () => {
    useUiStore.setState({ compareBranch: "refs/remotes/gone/x" });
    renderPanel();
    expect(await statusLine("gone is no longer a remote.")).toBeInTheDocument();
  });
});

describe("Compare picker remote read", () => {
  it("says the remote branches are loading and claims no miss for them", async () => {
    vi.mocked(gitRemoteBranches).mockReturnValue(new Promise(() => undefined));
    const user = userEvent.setup();
    renderPanel();
    await user.click(await trigger());
    expect(
      await screen.findByText("Remote: Loading remote branches…"),
    ).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("Filter branches…"), "zzz");
    expect(
      await screen.findByText("No local branches match"),
    ).toBeInTheDocument();
    expect(screen.queryByText("No branches match")).toBeNull();
  });

  it("says when the remote branches couldn't load", async () => {
    vi.mocked(gitRemoteBranches).mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    renderPanel();
    await user.click(await trigger());
    expect(
      await screen.findByText("Remote: Couldn't load remote branches."),
    ).toBeInTheDocument();
  });
});

describe("Compare status line layout", () => {
  it("keeps the idle status host out of the header's spacing flow", async () => {
    renderPanel();
    await trigger();
    const idle = document.querySelector("div.sr-only > p[role=status]");
    expect(idle).not.toBeNull();
    expect(idle?.parentElement?.parentElement?.className ?? "").not.toContain(
      "space-y",
    );
  });
});

describe("comparePrTarget for a parent pick", () => {
  const input = {
    pick: { remote: "upstream", name: "release" },
    value: "refs/remotes/upstream/release",
    currentName: "feat",
    lensGate: true,
    upstreamRemote: null,
    upstreamBranch: null,
  };

  it("leaves the fork-side base to the dialog and diffs the upstream ref", () => {
    const target = comparePrTarget(input);
    expect(target.defaultBase).toBeUndefined();
    expect(target.preset).toEqual({
      target: "upstream",
      base: "release",
      baseRef: "refs/remotes/upstream/release",
    });
  });

  it("keeps the bare base for a fork pick", () => {
    const target = comparePrTarget({
      ...input,
      pick: { remote: "origin", name: "feature-x" },
      value: "refs/remotes/origin/feature-x",
    });
    expect(target.defaultBase).toBe("feature-x");
  });
});
