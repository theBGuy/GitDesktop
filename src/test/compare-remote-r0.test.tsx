import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComparePanel } from "@/features/compare/ComparePanel";
import {
  clearPickRemotesForTests,
  parseRemoteCompareValue,
  remoteCompareRows,
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

describe("Compare add-upstream follow-up over a live pick", () => {
  it("keeps the running pick's line and hold while the follow-up fetches unseen", async () => {
    forkWithoutUpstream();
    // Settled at the end: the single-flight map is module state.
    const originFetch = deferred<void>();
    vi.mocked(gitFetchRemote).mockImplementation((_repo, r) =>
      r === "origin" ? originFetch.promise : Promise.resolve(),
    );
    const user = userEvent.setup();
    renderPanel();
    await pickOption(user, /^origin\/feature-x/);
    await statusLine("Fetching origin…");
    await pickOption(user, /^Add upstream remote/);
    await waitFor(() => expect(fetchedRemotes()).toContain("upstream"));
    await settle();
    expect(
      screen.getByText("Fetching origin…", { selector: "p[role=status]" }),
    ).toBeInTheDocument();
    const create = screen.getByRole("button", { name: /^Create pull request/ });
    expect(create).toHaveAccessibleDescription("Fetching origin…");
    await act(async () => originFetch.resolve());
    await waitFor(() =>
      expect(screen.queryByText("Fetching origin…")).toBeNull(),
    );
  });

  it("fetches both the parked pick and the follow-up on reconnect", async () => {
    forkWithoutUpstream();
    const user = userEvent.setup();
    renderPanel();
    await trigger();
    act(() => onlineManager.setOnline(false));
    await pickOption(user, /^origin\/feature-x/);
    const parked =
      "You're offline, so this compares against origin's last fetch.";
    expect(await statusLine(parked)).toBeInTheDocument();
    await pickOption(user, /^Add upstream remote/);
    await waitFor(() => expect(gitRemoteAdd).toHaveBeenCalled());
    await settle();
    expect(
      screen.getByText(parked, { selector: "p[role=status]" }),
    ).toBeInTheDocument();
    expect(gitFetchRemote).not.toHaveBeenCalled();
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(fetchedRemotes()).toContain("origin"));
    await waitFor(() => expect(fetchedRemotes()).toContain("upstream"));
  });

  it("shows the follow-up's own line once the running pick was superseded", async () => {
    forkWithoutUpstream();
    // Settled at the end: the single-flight map is module state.
    const originFetch = deferred<void>();
    vi.mocked(gitFetchRemote).mockImplementation((_repo, r) =>
      r === "origin" ? originFetch.promise : Promise.reject(new Error("boom")),
    );
    const user = userEvent.setup();
    renderPanel();
    await pickOption(user, /^origin\/feature-x/);
    await statusLine("Fetching origin…");
    await pickOption(user, /^dev/);
    await pickOption(user, /^Add upstream remote/);
    expect(await statusLine("Couldn't fetch upstream.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    await act(async () => originFetch.resolve());
  });

  it("parks the follow-up with its own line over a superseded parked pick", async () => {
    forkWithoutUpstream();
    const user = userEvent.setup();
    renderPanel();
    await trigger();
    act(() => onlineManager.setOnline(false));
    await pickOption(user, /^origin\/feature-x/);
    await statusLine(
      "You're offline, so this compares against origin's last fetch.",
    );
    await pickOption(user, /^dev/);
    await pickOption(user, /^Add upstream remote/);
    expect(
      await statusLine(
        "You're offline. upstream will be fetched when you reconnect.",
      ),
    ).toBeInTheDocument();
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(fetchedRemotes()).toContain("upstream"));
  });
});

describe("Compare gone remote over a failed branch list", () => {
  it("holds Create and names the removed remote", async () => {
    useUiStore.setState({ compareBranch: "refs/remotes/origin/x" });
    vi.mocked(gitRemotes).mockResolvedValue(["upstream"]);
    vi.mocked(gitRemoteBranches).mockRejectedValue(new Error("list boom"));
    renderPanel();
    const gone = "origin is no longer a remote.";
    expect(await statusLine(gone)).toBeInTheDocument();
    await waitFor(() => {
      const creates = screen.getAllByRole("button", { name: /^Create/ });
      expect(creates.length).toBeGreaterThan(0);
      for (const b of creates) expect(b).toHaveAccessibleDescription(gone);
    });
  });

  it("claims nothing while the remotes read has no answer", async () => {
    useUiStore.setState({ compareBranch: "refs/remotes/origin/x" });
    vi.mocked(gitRemotes).mockRejectedValue(new Error("remotes boom"));
    vi.mocked(gitRemoteBranches).mockRejectedValue(new Error("list boom"));
    renderPanel();
    await trigger();
    await settle();
    expect(screen.queryByText("origin is no longer a remote.")).toBeNull();
  });

  it("withdraws the claim when a remotes refresh fails over the cached list", async () => {
    useUiStore.setState({ compareBranch: "refs/remotes/origin/x" });
    vi.mocked(gitRemotes).mockResolvedValue(["upstream"]);
    vi.mocked(gitRemoteBranches).mockRejectedValue(new Error("list boom"));
    const client = renderPanel();
    const gone = "origin is no longer a remote.";
    expect(await statusLine(gone)).toBeInTheDocument();
    vi.mocked(gitRemotes).mockRejectedValue(new Error("remotes boom"));
    await act(() =>
      client.refetchQueries({ queryKey: ["repo", REPO, "remotes"] }),
    );
    await settle();
    expect(screen.queryByText(gone)).toBeNull();
    for (const b of screen.queryAllByRole("button", { name: /^Create/ }))
      expect(b).not.toHaveAccessibleDescription(gone);
  });
});

describe("Compare retained remote pick over an emptied list", () => {
  it("keeps the picker and the pruned line instead of the empty state", async () => {
    vi.mocked(gitBranches).mockResolvedValue([branch("feat", true)]);
    vi.mocked(gitRemoteBranches).mockResolvedValue([]);
    useUiStore.setState({ compareBranch: "refs/remotes/origin/gone" });
    renderPanel();
    expect(
      await statusLine("origin/gone was deleted on origin."),
    ).toBeInTheDocument();
    expect(await trigger()).toBeInTheDocument();
    expect(screen.queryByText("No other branches")).toBeNull();
  });
});

describe("Compare fetch refresh of the picked pair", () => {
  it("refetches the picked comparison once after the fetch", async () => {
    const fetch = deferred<void>();
    vi.mocked(gitFetchRemote).mockReturnValue(fetch.promise);
    const user = userEvent.setup();
    const client = renderPanel();
    const picked = "refs/remotes/upstream/main";
    client.setQueryData(repoKeys.compare(REPO, picked, "feat"), {
      ahead: [COMMIT],
      behind: [],
    });
    await pickOption(user, /^upstream\/main/);
    await statusLine("Fetching upstream…");
    await settle();
    const pickedCalls = () =>
      vi.mocked(gitCompareBranches).mock.calls.filter((c) => c.includes(picked))
        .length;
    const before = pickedCalls();
    await act(async () => fetch.resolve());
    await waitFor(() => expect(pickedCalls()).toBe(before + 1));
    await settle();
    expect(pickedCalls()).toBe(before + 1);
  });
});

describe("Compare empty state over a failed offer read", () => {
  it("offers Retry instead of claiming no branches, then shows the offer", async () => {
    vi.mocked(gitBranches).mockResolvedValue([branch("feat", true)]);
    vi.mocked(gitRemoteBranches).mockResolvedValue([]);
    forkWithoutUpstream();
    vi.mocked(forgeStatus).mockRejectedValueOnce(new Error("gh down"));
    const user = userEvent.setup();
    renderPanel();
    expect(
      await screen.findByText(
        "Couldn't check whether an upstream remote can be added.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("No other branches")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await trigger()).toHaveTextContent(NO_PICK);
    expect(document.activeElement).not.toBe(document.body);
    await user.click(await trigger());
    expect(
      await within(await popup()).findByRole("option", {
        name: /^Add upstream remote/,
      }),
    ).toBeInTheDocument();
  });

  it("keeps the failed arm and focus on Retry while the failed read retries", async () => {
    vi.mocked(gitBranches).mockResolvedValue([branch("feat", true)]);
    vi.mocked(gitRemoteBranches).mockResolvedValue([]);
    forkWithoutUpstream();
    vi.mocked(gitRemotes).mockRejectedValue(new Error("remotes boom"));
    const user = userEvent.setup();
    renderPanel();
    const retry = await screen.findByRole("button", { name: "Retry" });
    const before = vi.mocked(gitRemotes).mock.calls.length;
    // The retry (a press here, the error poll alike) never answers.
    vi.mocked(gitRemotes).mockReturnValue(new Promise(() => undefined));
    await user.click(retry);
    await waitFor(() =>
      expect(vi.mocked(gitRemotes).mock.calls.length).toBeGreaterThan(before),
    );
    await settle();
    expect(screen.getByRole("button", { name: "Retry" })).toBe(retry);
    expect(document.activeElement).toBe(retry);
  });

  it("says there is nothing when an answered read already rules the offer out", async () => {
    vi.mocked(gitBranches).mockResolvedValue([branch("feat", true)]);
    vi.mocked(gitRemoteBranches).mockResolvedValue([]);
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    // Not a fork, so the failed forge read decides nothing.
    vi.mocked(forgeStatus).mockRejectedValue(new Error("gh down"));
    renderPanel();
    expect(await screen.findByText("No other branches")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /New branch…/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

describe("Compare closing copy", () => {
  it("names no cause for a missing pick while the remotes read has no answer", async () => {
    useUiStore.setState({ compareBranch: "refs/remotes/origin/x" });
    vi.mocked(gitRemotes).mockRejectedValue(new Error("remotes boom"));
    vi.mocked(gitRemoteBranches).mockResolvedValue([]);
    renderPanel();
    const missing = "origin/x is no longer in your remote branches.";
    expect(await statusLine(missing)).toBeInTheDocument();
    expect(screen.queryByText(/was deleted on/)).toBeNull();
    await waitFor(() => {
      const creates = screen.getAllByRole("button", { name: /^Create/ });
      expect(creates.length).toBeGreaterThan(0);
      for (const b of creates) expect(b).toHaveAccessibleDescription(missing);
    });
  });

  it("lets the missing line outrank a failed fetch's line, naming Create's hold", async () => {
    vi.mocked(gitRemotes).mockRejectedValue(new Error("remotes boom"));
    vi.mocked(gitFetchRemote).mockRejectedValue(new Error("fetch boom"));
    const user = userEvent.setup();
    const client = renderPanel();
    await waitFor(() => expect(gitRemotes).toHaveBeenCalled());
    await pickOption(user, /^origin\/feature-x/);
    await statusLine(
      "Couldn't fetch origin, so this compares against its last fetch.",
    );
    vi.mocked(gitRemoteBranches).mockResolvedValue([
      remote("upstream", "main"),
    ]);
    await act(() =>
      client.refetchQueries({ queryKey: ["repo", REPO, "remote-branches"] }),
    );
    const missing = "origin/feature-x is no longer in your remote branches.";
    expect(await statusLine(missing)).toBeInTheDocument();
    await waitFor(() => {
      const creates = screen.getAllByRole("button", { name: /^Create/ });
      expect(creates.length).toBeGreaterThan(0);
      for (const b of creates) expect(b).toHaveAccessibleDescription(missing);
    });
  });

  it("waits offline for the offer read instead of offering a Retry", async () => {
    vi.mocked(gitBranches).mockResolvedValue([branch("feat", true)]);
    vi.mocked(gitRemoteBranches).mockResolvedValue([]);
    forkWithoutUpstream();
    vi.mocked(forgeStatus).mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    renderPanel();
    const retry = await screen.findByRole("button", { name: "Retry" });
    retry.focus();
    act(() => onlineManager.setOnline(false));
    expect(
      await screen.findByText(
        "You're offline — whether an upstream remote can be added is checked once you're back online.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    act(() => onlineManager.setOnline(true));
    expect(await trigger()).toHaveTextContent(NO_PICK);
    await user.click(await trigger());
    expect(
      await within(await popup()).findByRole("option", {
        name: /^Add upstream remote/,
      }),
    ).toBeInTheDocument();
  });

  it("keeps Retry offline when the failed offer read is a local one", async () => {
    vi.mocked(gitBranches).mockResolvedValue([branch("feat", true)]);
    vi.mocked(gitRemoteBranches).mockResolvedValue([]);
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    vi.mocked(loadSettings).mockRejectedValue(new Error("settings boom"));
    renderPanel();
    expect(
      await screen.findByText(
        "Couldn't check whether an upstream remote can be added.",
      ),
    ).toBeInTheDocument();
    act(() => onlineManager.setOnline(false));
    await settle();
    expect(
      screen.getByText(
        "Couldn't check whether an upstream remote can be added.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText(/^You're offline/)).toBeNull();
  });

  it("calls a failure over cached remote rows a failed refresh", async () => {
    const user = userEvent.setup();
    const client = renderPanel();
    await user.click(await trigger());
    await within(await popup()).findByRole("option", {
      name: /^origin\/feature-x/,
    });
    vi.mocked(gitRemoteBranches).mockRejectedValue(new Error("list boom"));
    await act(() =>
      client.refetchQueries({ queryKey: ["repo", REPO, "remote-branches"] }),
    );
    expect(
      await screen.findByText(
        /Couldn't refresh remote branches — showing the last loaded results\./,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load remote branches/)).toBeNull();
  });
});

describe("Compare remote names holding a slash", () => {
  it("parses against the known remotes, longest first", () => {
    expect(
      parseRemoteCompareValue("refs/remotes/team/fork/main", [
        "origin",
        "team",
        "team/fork",
      ]),
    ).toEqual({
      remote: "team/fork",
      name: "main",
      display: "team/fork/main",
    });
    // Unknown remotes keep the backend's first-slash split.
    expect(parseRemoteCompareValue("refs/remotes/team/fork/main")).toEqual({
      remote: "team",
      name: "fork/main",
      display: "team/fork/main",
    });
    expect(
      remoteCompareRows(
        [remote("team", "fork/gd/session/x"), remote("team", "fork/main")],
        new Set(),
        ["team/fork"],
      ).map((r) => r.display),
    ).toEqual(["team/fork/main"]);
  });

  it("fetches the whole remote name and hides its session branches", async () => {
    vi.mocked(gitRemotes).mockResolvedValue(["origin", "team/fork"]);
    vi.mocked(gitRemoteBranches).mockResolvedValue([
      remote("team", "fork/main"),
      remote("team", "fork/gd/session/x"),
    ]);
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(gitRemotes).toHaveBeenCalled());
    await user.click(await trigger());
    const list = await popup();
    await within(list).findByRole("option", { name: /^team\/fork\/main/ });
    expect(
      within(list).queryByRole("option", { name: /gd\/session/ }),
    ).toBeNull();
    await user.click(
      within(list).getByRole("option", { name: /^team\/fork\/main/ }),
    );
    await waitFor(() =>
      expect(gitFetchRemote).toHaveBeenCalledWith(REPO, "team/fork"),
    );
    expect(fetchedRemotes()).not.toContain("team");
    // The pick is still listed, so nothing calls it deleted.
    await settle();
    expect(screen.queryByText(/was deleted on/)).toBeNull();
  });

  it("offers remote rows only once the remotes list is known", async () => {
    const remotesRead = deferred<string[]>();
    vi.mocked(gitRemotes).mockReturnValue(remotesRead.promise);
    vi.mocked(gitRemoteBranches).mockResolvedValue([
      remote("team", "fork/main"),
    ]);
    const user = userEvent.setup();
    renderPanel();
    await user.click(await trigger());
    const list = await popup();
    expect(
      await screen.findByText("Remote: Loading remote branches…"),
    ).toBeInTheDocument();
    expect(within(list).queryByRole("option", { name: /^team\// })).toBeNull();
    await act(async () => remotesRead.resolve(["origin", "team/fork"]));
    await user.click(
      await within(await popup()).findByRole("option", {
        name: /^team\/fork\/main/,
      }),
    );
    await waitFor(() =>
      expect(gitFetchRemote).toHaveBeenCalledWith(REPO, "team/fork"),
    );
  });

  it("falls back to the backend split when the remotes read fails", async () => {
    vi.mocked(gitRemotes).mockRejectedValue(new Error("remotes boom"));
    vi.mocked(gitRemoteBranches).mockResolvedValue([
      remote("team", "fork/main"),
    ]);
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(gitRemotes).toHaveBeenCalled());
    await user.click(await trigger());
    expect(
      await within(await popup()).findByRole("option", {
        name: /^team\/fork\/main/,
      }),
    ).toBeInTheDocument();
  });

  it("keeps the fallback rows while a failed remotes read retries", async () => {
    vi.mocked(gitRemotes).mockRejectedValue(new Error("remotes boom"));
    vi.mocked(gitRemoteBranches).mockResolvedValue([
      remote("team", "fork/main"),
    ]);
    const user = userEvent.setup();
    const client = renderPanel();
    await waitFor(() => expect(gitRemotes).toHaveBeenCalled());
    await user.click(await trigger());
    await within(await popup()).findByRole("option", {
      name: /^team\/fork\/main/,
    });
    vi.mocked(gitRemotes).mockReturnValue(new Promise(() => undefined));
    act(() => {
      void client.refetchQueries({ queryKey: ["repo", REPO, "remotes"] });
    });
    await settle();
    expect(
      within(await popup()).getByRole("option", { name: /^team\/fork\/main/ }),
    ).toBeInTheDocument();
  });

  it("names the removed remote after a follow-up replaced the pick's stamp", async () => {
    forkWithoutUpstream();
    vi.mocked(gitRemotes).mockResolvedValue(["origin", "origin/team"]);
    vi.mocked(gitRemoteBranches).mockResolvedValue([
      remote("origin", "team/main"),
    ]);
    const user = userEvent.setup();
    const client = renderPanel();
    await waitFor(() => expect(gitRemotes).toHaveBeenCalled());
    await pickOption(user, /^origin\/team\/main/);
    await waitFor(() =>
      expect(gitFetchRemote).toHaveBeenCalledWith(REPO, "origin/team"),
    );
    await settle();
    await pickOption(user, /^Add upstream remote/);
    await waitFor(() => expect(fetchedRemotes()).toContain("upstream"));
    await settle();
    vi.mocked(gitRemotes).mockResolvedValue(["origin", "upstream"]);
    vi.mocked(gitRemoteBranches).mockRejectedValue(new Error("list boom"));
    await act(() =>
      client.refetchQueries({ queryKey: ["repo", REPO, "remotes"] }),
    );
    await act(() =>
      client.refetchQueries({ queryKey: ["repo", REPO, "remote-branches"] }),
    );
    const gone = "origin/team is no longer a remote.";
    expect(await statusLine(gone)).toBeInTheDocument();
    // The recorded origin/team pick routes nowhere, so no Create offers one.
    expect(screen.queryAllByRole("button", { name: /^Create/ })).toEqual([]);
  });

  it("records no remote for a pick made before the remotes list answered", async () => {
    vi.mocked(gitRemotes).mockRejectedValue(new Error("remotes boom"));
    vi.mocked(gitRemoteBranches).mockResolvedValue([
      remote("team", "fork/main"),
    ]);
    const user = userEvent.setup();
    const client = renderPanel();
    await waitFor(() => expect(gitRemotes).toHaveBeenCalled());
    await pickOption(user, /^team\/fork\/main/);
    // Nothing recorded: the pick fetched by the only split there was.
    await waitFor(() =>
      expect(gitFetchRemote).toHaveBeenCalledWith(REPO, "team"),
    );
    vi.mocked(gitRemotes).mockResolvedValue(["origin", "team/fork"]);
    await act(() =>
      client.refetchQueries({ queryKey: ["repo", REPO, "remotes"] }),
    );
    await settle();
    expect(screen.queryByText(/no longer a remote/)).toBeNull();
    expect(screen.queryByText(/was deleted on/)).toBeNull();
  });

  it("reconnects a pick parked under the fallback split to its real remote", async () => {
    vi.mocked(gitRemotes).mockRejectedValue(new Error("remotes boom"));
    vi.mocked(gitRemoteBranches).mockResolvedValue([
      remote("team", "fork/main"),
    ]);
    const user = userEvent.setup();
    const client = renderPanel();
    await waitFor(() => expect(gitRemotes).toHaveBeenCalled());
    act(() => onlineManager.setOnline(false));
    await pickOption(user, /^team\/fork\/main/);
    await statusLine(
      "You're offline, so this compares against team's last fetch.",
    );
    vi.mocked(gitRemotes).mockResolvedValue(["origin", "team/fork"]);
    await act(() =>
      client.refetchQueries({ queryKey: ["repo", REPO, "remotes"] }),
    );
    await settle();
    expect(gitFetchRemote).not.toHaveBeenCalled();
    // The parked line names the remote its reconnect will fetch.
    expect(
      await statusLine(
        "You're offline, so this compares against team/fork's last fetch.",
      ),
    ).toBeInTheDocument();
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(fetchedRemotes()).toContain("team/fork"));
    expect(fetchedRemotes()).not.toContain("team");
  });

  it("routes Create by the recorded pick after its remote's removal", async () => {
    vi.mocked(gitRemotes).mockResolvedValue([
      "origin",
      "origin/team",
      "upstream",
    ]);
    vi.mocked(gitRemoteBranches).mockResolvedValue([
      remote("origin", "team/main"),
    ]);
    const user = userEvent.setup();
    const client = renderPanel();
    await waitFor(() => expect(gitRemotes).toHaveBeenCalled());
    await pickOption(user, /^origin\/team\/main/);
    await waitFor(() =>
      expect(gitFetchRemote).toHaveBeenCalledWith(REPO, "origin/team"),
    );
    await settle();
    expect(
      screen.queryByRole("button", { name: /^Create pull request/ }),
    ).toBeNull();
    vi.mocked(gitRemotes).mockResolvedValue(["origin", "upstream"]);
    vi.mocked(gitRemoteBranches).mockRejectedValue(new Error("list boom"));
    await act(() =>
      client.refetchQueries({ queryKey: ["repo", REPO, "remote-branches"] }),
    );
    await act(() =>
      client.refetchQueries({ queryKey: ["repo", REPO, "remotes"] }),
    );
    // A failed refresh withdraws the gone hold; the routing must not move.
    vi.mocked(gitRemotes).mockRejectedValue(new Error("remotes boom"));
    await act(() =>
      client.refetchQueries({ queryKey: ["repo", REPO, "remotes"] }),
    );
    await settle();
    expect(screen.queryByText("origin/team is no longer a remote.")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^Create pull request/ }),
    ).toBeNull();
  });

  it("names the removed slash remote, not a shorter one still present", async () => {
    vi.mocked(gitRemotes).mockResolvedValue(["origin", "team", "team/fork"]);
    vi.mocked(gitRemoteBranches).mockResolvedValue([
      remote("team", "fork/main"),
    ]);
    const user = userEvent.setup();
    const client = renderPanel();
    await waitFor(() => expect(gitRemotes).toHaveBeenCalled());
    await pickOption(user, /^team\/fork\/main/);
    await waitFor(() =>
      expect(gitFetchRemote).toHaveBeenCalledWith(REPO, "team/fork"),
    );
    vi.mocked(gitRemotes).mockResolvedValue(["origin", "team"]);
    vi.mocked(gitRemoteBranches).mockResolvedValue([]);
    await act(() =>
      client.refetchQueries({ queryKey: ["repo", REPO, "remotes"] }),
    );
    await act(() =>
      client.refetchQueries({ queryKey: ["repo", REPO, "remote-branches"] }),
    );
    expect(
      await statusLine("team/fork is no longer a remote."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/deleted on team/)).toBeNull();
  });
});

describe("Compare duplicate PR probe", () => {
  const pr = (baseRefName: string, crossRepository: boolean) => ({
    number: 12,
    url: "https://github.com/octo/project/pull/12",
    title: "Existing",
    isDraft: false,
    baseRefName,
    crossRepository,
  });

  it("views the parent's open PR instead of creating another", async () => {
    vi.mocked(forgePrsForBranch).mockImplementation(async (_r, _h, lens) =>
      lens === "upstream"
        ? ([pr("main", true)] as unknown as Awaited<
            ReturnType<typeof forgePrsForBranch>
          >)
        : [],
    );
    useUiStore.setState({ compareBranch: "refs/remotes/upstream/main" });
    renderPanel();
    expect(
      await screen.findByRole("button", { name: /View pull request #12/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Create pull request in parent…/ }),
    ).toBeNull();
  });

  it("lets a cross-repository PR on the fork pick keep Create", async () => {
    vi.mocked(forgePrsForBranch).mockResolvedValue([
      pr("feature-x", true),
    ] as unknown as Awaited<ReturnType<typeof forgePrsForBranch>>);
    useUiStore.setState({ compareBranch: "refs/remotes/origin/feature-x" });
    renderPanel();
    await waitFor(() =>
      expect(forgePrsForBranch).toHaveBeenCalledWith(REPO, "feat", "origin"),
    );
    expect(
      await screen.findByRole("button", { name: /^Create pull request/ }),
    ).toBeInTheDocument();
    await settle();
    expect(
      screen.queryByRole("button", { name: /View pull request/ }),
    ).toBeNull();
  });
});
