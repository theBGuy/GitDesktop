import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComparePanel } from "@/features/compare/ComparePanel";
import { clearPickRemotesForTests } from "@/features/compare/compare-remote-ref";
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
import type {
  Branch,
  CommitSummary,
  ForgeStatus,
  RemoteBranch,
  RepoStatus,
} from "@/lib/git/types";
import { dispatchAction } from "@/lib/hotkeys/hotkeys";
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

const S10 = "origin/feature-x was deleted on origin.";
const S11 = "origin/feature-x is no longer in your remote branches.";
const OFFLINE =
  "You're offline — this will be available once you're back online.";
const LISTED = () => [
  remote("upstream", "main"),
  remote("origin", "feature-x"),
];
const UNLISTED = () => [remote("upstream", "main")];

const fetchButton = (r = "origin") =>
  screen.getByRole("button", { name: `Fetch ${r}` });
const pickAnotherButton = () =>
  screen.getByRole("button", { name: "Pick another branch" });
const fetchCount = () => vi.mocked(gitFetchRemote).mock.calls.length;
const refetchList = (client: QueryClient) =>
  act(() =>
    client.refetchQueries({ queryKey: ["repo", REPO, "remote-branches"] }),
  );
const statusText = () =>
  document.querySelector("p[role=status]")?.textContent ?? "";
/** The line's one icon, told apart by the classes each renders: the warning
 *  icon's `text-warning`, the spinner's `animate-spin`. */
const lineIcon = (line: HTMLElement) => {
  const icons = line.parentElement?.querySelectorAll("svg") ?? [];
  if (icons.length !== 1) return `${icons.length} icons`;
  if (icons[0].classList.contains("animate-spin")) return "spinner";
  if (icons[0].classList.contains("text-warning")) return "warning";
  return "unknown";
};

/** Picks origin/feature-x with its fetch held, then lets the fetch land over a
 *  list that no longer holds the ref: this pick's own fetch proved it gone. */
async function reachS10(user: ReturnType<typeof userEvent.setup>) {
  const fetch = deferred<void>();
  vi.mocked(gitFetchRemote).mockReturnValueOnce(fetch.promise);
  await pickOption(user, /^origin\/feature-x/);
  await statusLine("Fetching origin…");
  vi.mocked(gitRemoteBranches).mockResolvedValue(UNLISTED());
  await act(async () => fetch.resolve());
  return statusLine(S10);
}

/** A settled pick whose ref then leaves the list through a plain refetch. */
async function reachS11(
  user: ReturnType<typeof userEvent.setup>,
  client: QueryClient,
) {
  await pickOption(user, /^origin\/feature-x/);
  await waitFor(() =>
    expect(createButton()).not.toHaveAttribute("aria-disabled", "true"),
  );
  vi.mocked(gitRemoteBranches).mockResolvedValue(UNLISTED());
  await refetchList(client);
  return statusLine(S11);
}

describe("Compare picker open re-reads (arm a)", () => {
  it("re-reads both lists on every open, so a removed remote's rows leave", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await trigger());
    expect(
      await within(await popup()).findByRole("option", {
        name: /^upstream\/main/,
      }),
    ).toBeInTheDocument();
    await settle();
    const remotesBefore = vi.mocked(gitRemotes).mock.calls.length;
    const listBefore = vi.mocked(gitRemoteBranches).mock.calls.length;
    await user.keyboard("{Escape}");
    await settle();
    // Closing reads nothing.
    expect(vi.mocked(gitRemotes).mock.calls.length).toBe(remotesBefore);
    expect(vi.mocked(gitRemoteBranches).mock.calls.length).toBe(listBefore);
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    vi.mocked(gitRemoteBranches).mockResolvedValue([
      remote("origin", "feature-x"),
    ]);
    await user.click(await trigger());
    await waitFor(() => {
      expect(vi.mocked(gitRemotes).mock.calls.length).toBe(remotesBefore + 1);
      expect(vi.mocked(gitRemoteBranches).mock.calls.length).toBe(
        listBefore + 1,
      );
    });
    const list = await popup();
    await waitFor(() =>
      expect(
        within(list).queryByRole("option", { name: /^upstream\/main/ }),
      ).toBeNull(),
    );
    expect(
      within(list).getByRole("option", { name: /^origin\/feature-x/ }),
    ).toBeInTheDocument();
  });

  it("keeps the known rows on screen while the open's re-read runs", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await trigger());
    await within(await popup()).findByRole("option", {
      name: /^upstream\/main/,
    });
    await user.keyboard("{Escape}");
    await settle();
    const held = deferred<RemoteBranch[]>();
    const before = vi.mocked(gitRemoteBranches).mock.calls.length;
    // Armed now, so only the next open's read is held.
    vi.mocked(gitRemoteBranches).mockReturnValueOnce(held.promise);
    await user.click(await trigger());
    await waitFor(() =>
      expect(vi.mocked(gitRemoteBranches).mock.calls.length).toBe(before + 1),
    );
    await settle();
    const list = await popup();
    expect(
      within(list).getByRole("option", { name: /^upstream\/main/ }),
    ).toBeInTheDocument();
    expect(
      within(list).getByRole("option", { name: /^origin\/feature-x/ }),
    ).toBeInTheDocument();
    expect(within(list).queryByText(/Loading/)).toBeNull();
    await act(async () => held.resolve(LISTED()));
    await settle();
  });

  it("keeps the missing line and Create's hold through a re-read", async () => {
    vi.mocked(gitRemoteBranches).mockResolvedValue(UNLISTED());
    useUiStore.setState({ compareBranch: FEATURE_REF });
    const user = userEvent.setup();
    renderPanel();
    const line = await statusLine(S11);
    await waitFor(() =>
      expect(createButton()).toHaveAccessibleDescription(S11),
    );
    const held = deferred<RemoteBranch[]>();
    const before = vi.mocked(gitRemoteBranches).mock.calls.length;
    vi.mocked(gitRemoteBranches).mockReturnValueOnce(held.promise);
    const changes: MutationRecord[] = [];
    const observer = new MutationObserver((m) => changes.push(...m));
    observer.observe(line, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    await user.click(await trigger());
    await waitFor(() =>
      expect(vi.mocked(gitRemoteBranches).mock.calls.length).toBe(before + 1),
    );
    await settle();
    expect(line).toHaveTextContent(S11);
    expect(createButton()).toHaveAttribute("aria-disabled", "true");
    expect(createButton()).toHaveAccessibleDescription(S11);
    expect(changes).toEqual([]);
    await act(async () => held.resolve(UNLISTED()));
    await settle();
    expect(changes).toEqual([]);
    observer.disconnect();
  });

  it("releases the hold when the re-read lists the ref", async () => {
    vi.mocked(gitRemoteBranches).mockResolvedValue(UNLISTED());
    useUiStore.setState({ compareBranch: FEATURE_REF });
    const user = userEvent.setup();
    renderPanel();
    await statusLine(S11);
    const held = deferred<RemoteBranch[]>();
    vi.mocked(gitRemoteBranches).mockReturnValueOnce(held.promise);
    vi.mocked(gitRemoteBranches).mockResolvedValue(LISTED());
    await user.click(await trigger());
    await settle();
    expect(statusText()).toBe(S11);
    await act(async () => held.resolve(LISTED()));
    await waitFor(() => expect(statusText()).toBe(""));
    expect(createButton()).not.toHaveAccessibleDescription(S11);
    await waitFor(() =>
      expect(createButton()).not.toHaveAttribute("aria-disabled", "true"),
    );
  });

  it("keeps the missing line and Create's hold through a FAILED re-read", async () => {
    vi.mocked(gitRemoteBranches).mockResolvedValue(UNLISTED());
    useUiStore.setState({ compareBranch: FEATURE_REF });
    const user = userEvent.setup();
    renderPanel();
    await statusLine(S11);
    await waitFor(() =>
      expect(createButton()).toHaveAccessibleDescription(S11),
    );
    vi.mocked(gitRemoteBranches).mockRejectedValue(new Error("list boom"));
    await user.click(await trigger());
    expect(
      await screen.findByText(
        /Couldn't refresh remote branches — showing the last loaded results\./,
      ),
    ).toBeInTheDocument();
    expect(statusText()).toBe(S11);
    expect(createButton()).toHaveAttribute("aria-disabled", "true");
    expect(createButton()).toHaveAccessibleDescription(S11);
    await user.keyboard("{Escape}");
    await settle();
    vi.mocked(gitRemoteBranches).mockResolvedValue(LISTED());
    await user.click(await trigger());
    await waitFor(() => expect(statusText()).toBe(""));
    expect(createButton()).not.toHaveAccessibleDescription(S11);
    await waitFor(() =>
      expect(createButton()).not.toHaveAttribute("aria-disabled", "true"),
    );
  });
});

describe("Compare displaced follow-up failure (arm b)", () => {
  async function displacedFollowUp(offline: boolean) {
    forkWithoutUpstream();
    const upstream = deferred<void>();
    let upstreamCalls = 0;
    vi.mocked(gitFetchRemote).mockImplementation((_repo, r) => {
      if (r !== "upstream") return Promise.resolve();
      upstreamCalls += 1;
      return upstreamCalls === 1 ? upstream.promise : Promise.resolve();
    });
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(useUiStore.getState().compareBranch).toBe("main"),
    );
    await pickOption(user, /^Add upstream remote/);
    expect(await statusLine("Fetching upstream…")).toBeInTheDocument();
    await pickOption(user, /^dev/);
    if (offline) act(() => onlineManager.setOnline(false));
    await act(async () => upstream.reject(new Error("upstream boom")));
    await settle();
    if (offline) act(() => onlineManager.setOnline(true));
    await settle();
    return () => upstreamCalls;
  }

  it("re-parks an offline failure, so reconnect fetches the remote once", async () => {
    const calls = await displacedFollowUp(true);
    await waitFor(() => expect(calls()).toBe(2));
  });

  it("drops an online failure a pick retired", async () => {
    const calls = await displacedFollowUp(false);
    expect(screen.queryByText("Couldn't fetch upstream.")).toBeNull();
    expect(calls()).toBe(1);
  });
});

describe("Compare remote pick over a failed comparison (arms d, h)", () => {
  const COMPARE_FAILED = "Couldn't compare with origin/feature-x";

  it("holds Create over retained data while the refresh is in error", async () => {
    const user = userEvent.setup();
    const client = renderPanel();
    await pickOption(user, /^origin\/feature-x/);
    await waitFor(() =>
      expect(createButton()).not.toHaveAttribute("aria-disabled", "true"),
    );
    vi.mocked(gitCompareBranches).mockRejectedValue(new Error("compare boom"));
    await act(() =>
      client.refetchQueries({ queryKey: ["repo", REPO, "compare"] }),
    );
    await waitFor(() =>
      expect(createButton()).toHaveAccessibleDescription(COMPARE_FAILED),
    );
    expect(createButton()).toHaveAttribute("aria-disabled", "true");
    await act(() => new Promise((r) => setTimeout(r, 20)));
    act(() => {
      expect(dispatchAction("create-pr")).toBe(false);
    });
    vi.mocked(gitCompareBranches).mockResolvedValue({
      ahead: [COMMIT],
      behind: [],
    });
    await user.click(screen.getByRole("button", { name: /^Retry/ }));
    await waitFor(() =>
      expect(createButton()).not.toHaveAttribute("aria-disabled", "true"),
    );
  });

  it("never says nothing to propose from an empty list in error", async () => {
    vi.mocked(gitCompareBranches).mockResolvedValue({ ahead: [], behind: [] });
    const user = userEvent.setup();
    const client = renderPanel();
    await pickOption(user, /^origin\/feature-x/);
    await waitFor(() =>
      expect(createButton()).toHaveAccessibleDescription(
        /has no commits to propose/,
      ),
    );
    vi.mocked(gitCompareBranches).mockRejectedValue(new Error("compare boom"));
    await act(() =>
      client.refetchQueries({ queryKey: ["repo", REPO, "compare"] }),
    );
    await waitFor(() =>
      expect(createButton()).toHaveAccessibleDescription(COMPARE_FAILED),
    );
    expect(screen.queryByText(/has no commits to propose/)).toBeNull();
  });

  async function xyx(offlineRepick: boolean) {
    // X answers once, then every comparison read fails.
    let xReads = 0;
    vi.mocked(gitCompareBranches).mockImplementation(async (_repo, base) => {
      if (base === FEATURE_REF && xReads++ === 0)
        return { ahead: [COMMIT], behind: [] };
      throw new Error("compare boom");
    });
    const user = userEvent.setup();
    renderPanel();
    await pickOption(user, /^origin\/feature-x/);
    await waitFor(() =>
      expect(createButton()).toHaveAccessibleDescription(COMPARE_FAILED),
    );
    await pickOption(user, /^upstream\/main/);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Create pull request in parent…/ }),
      ).toHaveAccessibleDescription("Couldn't compare with upstream/main"),
    );
    vi.mocked(gitFetchRemote).mockRejectedValue(new Error("fetch boom"));
    if (offlineRepick) act(() => onlineManager.setOnline(false));
    await pickOption(user, /^origin\/feature-x/);
    await settle();
    await waitFor(() =>
      expect(createButton()).toHaveAccessibleDescription(COMPARE_FAILED),
    );
    expect(createButton()).toHaveAttribute("aria-disabled", "true");
  }

  it("keeps the hold across X, Y, X with the re-pick's fetch failing", async () => {
    await xyx(false);
  });

  it("keeps the hold across X, Y, X with the re-pick parked offline", async () => {
    await xyx(true);
    // Reconnects here, under act, so the parked refire ends with the test.
    await act(async () => onlineManager.setOnline(true));
    await settle();
  });
});

describe("Compare gone pick and its Fetch action (arm g)", () => {
  it("says deleted only after this pick's own fetch, with both actions", async () => {
    const user = userEvent.setup();
    renderPanel();
    await reachS10(user);
    const actions = [fetchButton(), pickAnotherButton()];
    expect(actions[0].compareDocumentPosition(actions[1])).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    await waitFor(() =>
      expect(createButton()).toHaveAccessibleDescription(S10),
    );
  });

  it("names no cause when a plain list refetch drops the ref", async () => {
    const user = userEvent.setup();
    const client = renderPanel();
    await reachS11(user, client);
    expect(fetchButton()).toBeInTheDocument();
    expect(pickAnotherButton()).toBeInTheDocument();
    expect(screen.queryByText(/was deleted on/)).toBeNull();
  });

  it("frees Create and hands focus to the picker when Fetch restores the ref", async () => {
    const user = userEvent.setup();
    const client = renderPanel();
    await reachS11(user, client);
    vi.mocked(gitRemoteBranches).mockResolvedValue(LISTED());
    await user.click(fetchButton());
    await waitFor(() => expect(statusText()).toBe(""));
    await waitFor(() =>
      expect(createButton()).not.toHaveAttribute("aria-disabled", "true"),
    );
    expect(document.activeElement).toBe(await trigger());
  });

  it("says deleted once Fetch succeeds and the ref is still unlisted", async () => {
    const user = userEvent.setup();
    const client = renderPanel();
    await reachS11(user, client);
    await user.click(fetchButton());
    expect(await statusLine(S10)).toBeInTheDocument();
  });

  it("leads the missing line with a failed Fetch, Create keeping the plain reason", async () => {
    const user = userEvent.setup();
    const client = renderPanel();
    await reachS11(user, client);
    vi.mocked(gitFetchRemote).mockRejectedValue(new Error("fetch boom"));
    await user.click(fetchButton());
    const line = await statusLine(`Couldn't fetch origin. ${S11}`);
    expect(lineIcon(line)).toBe("warning");
    expect(createButton()).toHaveAccessibleDescription(S11);
  });

  it("leads the deleted line with a failed Fetch, Create keeping the plain reason", async () => {
    const user = userEvent.setup();
    renderPanel();
    await reachS10(user);
    vi.mocked(gitFetchRemote).mockRejectedValue(new Error("fetch boom"));
    await user.click(fetchButton());
    const line = await statusLine(`Couldn't fetch origin. ${S10}`);
    expect(lineIcon(line)).toBe("warning");
    expect(createButton()).toHaveAccessibleDescription(S10);
  });

  it("holds Fetch offline with a reason and fetches nothing", async () => {
    const user = userEvent.setup();
    const client = renderPanel();
    await reachS11(user, client);
    act(() => onlineManager.setOnline(false));
    const button = fetchButton();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription(OFFLINE);
    const before = fetchCount();
    await user.click(button);
    button.focus();
    await user.keyboard("{Enter}");
    await settle();
    expect(fetchCount()).toBe(before);
    expect(statusText()).toBe(S11);
    // A held press must not park a fetch that runs on reconnect.
    await act(async () => onlineManager.setOnline(true));
    await settle();
    expect(fetchCount()).toBe(before);
  });

  it("records nothing when the list read after a successful Fetch fails", async () => {
    const user = userEvent.setup();
    const client = renderPanel();
    await reachS11(user, client);
    const fetches = fetchCount();
    const reads = vi.mocked(gitRemoteBranches).mock.calls.length;
    vi.mocked(gitRemoteBranches).mockRejectedValue(new Error("list boom"));
    await user.click(fetchButton());
    await waitFor(() => {
      expect(fetchCount()).toBe(fetches + 1);
      expect(vi.mocked(gitRemoteBranches).mock.calls.length).toBeGreaterThan(
        reads,
      );
    });
    await settle();
    await settle();
    expect(statusText()).toBe(S11);
    expect(screen.queryByText(/was deleted on/)).toBeNull();
  });

  it("keeps the deleted line once the add-upstream follow-up's line is gone", async () => {
    forkWithoutUpstream();
    const user = userEvent.setup();
    renderPanel();
    await reachS10(user);
    const upstream = deferred<void>();
    vi.mocked(gitFetchRemote).mockReturnValueOnce(upstream.promise);
    await pickOption(user, /^Add upstream remote/);
    expect(await statusLine("Fetching upstream…")).toBeInTheDocument();
    await act(async () => upstream.resolve());
    expect(await statusLine(S10)).toBeInTheDocument();
  });

  it("drops the record when another value becomes current and the first returns", async () => {
    const user = userEvent.setup();
    renderPanel();
    await reachS10(user);
    // Another pick on the same remote, so only the record's pick test can
    // retire it (a local value would also fail its remote test).
    act(() =>
      useUiStore.setState({ compareBranch: "refs/remotes/origin/other" }),
    );
    await statusLine("origin/other is no longer in your remote branches.");
    act(() => useUiStore.setState({ compareBranch: FEATURE_REF }));
    expect(await statusLine(S11)).toBeInTheDocument();
    expect(screen.queryByText(/was deleted on/)).toBeNull();
  });

  it("(W3) drops the record once a list read lists the ref", async () => {
    const user = userEvent.setup();
    const client = renderPanel();
    await reachS10(user);
    vi.mocked(gitRemoteBranches).mockResolvedValue(LISTED());
    await refetchList(client);
    await waitFor(() => expect(statusText()).toBe(""));
    vi.mocked(gitRemoteBranches).mockResolvedValue(UNLISTED());
    await refetchList(client);
    expect(await statusLine(S11)).toBeInTheDocument();
    expect(screen.queryByText(/was deleted on/)).toBeNull();
  });

  it("(Identity, remote) drops the record when the pick resolves to another remote", async () => {
    vi.mocked(gitRemotes).mockRejectedValue(new Error("remotes boom"));
    vi.mocked(gitRemoteBranches).mockResolvedValue([
      remote("team", "fork/main"),
    ]);
    const fetch = deferred<void>();
    vi.mocked(gitFetchRemote).mockReturnValueOnce(fetch.promise);
    const user = userEvent.setup();
    const client = renderPanel();
    await waitFor(() => expect(gitRemotes).toHaveBeenCalled());
    await pickOption(user, /^team\/fork\/main/);
    await waitFor(() =>
      expect(gitFetchRemote).toHaveBeenCalledWith(REPO, "team"),
    );
    vi.mocked(gitRemoteBranches).mockResolvedValue([]);
    await act(async () => fetch.resolve());
    await settle();
    vi.mocked(gitRemotes).mockResolvedValue(["origin", "team/fork"]);
    await act(() =>
      client.refetchQueries({ queryKey: ["repo", REPO, "remotes"] }),
    );
    expect(
      await statusLine("team/fork/main is no longer in your remote branches."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/was deleted on/)).toBeNull();
  });

  it("(G4, remote) leads with the failed fetch only while it named the pick's remote", async () => {
    vi.mocked(gitRemotes).mockRejectedValue(new Error("remotes boom"));
    vi.mocked(gitRemoteBranches).mockResolvedValue([
      remote("team", "fork/main"),
    ]);
    vi.mocked(gitFetchRemote).mockRejectedValue(new Error("fetch boom"));
    const user = userEvent.setup();
    const client = renderPanel();
    await waitFor(() => expect(gitRemotes).toHaveBeenCalled());
    await pickOption(user, /^team\/fork\/main/);
    await statusLine(
      "Couldn't fetch team, so this compares against its last fetch.",
    );
    vi.mocked(gitRemoteBranches).mockResolvedValue([]);
    await refetchList(client);
    const plain = "team/fork/main is no longer in your remote branches.";
    expect(
      await statusLine(`Couldn't fetch team. ${plain}`),
    ).toBeInTheDocument();
    vi.mocked(gitRemotes).mockResolvedValue(["origin", "team/fork"]);
    await act(() =>
      client.refetchQueries({ queryKey: ["repo", REPO, "remotes"] }),
    );
    expect(await statusLine(plain)).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't fetch/)).toBeNull();
    // The button fetches the remote its label names, the pick's, never the
    // failed stamp's `team`.
    const fetches = fetchCount();
    await user.click(fetchButton("team/fork"));
    await waitFor(() => expect(fetchCount()).toBe(fetches + 1));
    expect(gitFetchRemote).toHaveBeenLastCalledWith(REPO, "team/fork");
    await settle();
  });

  it("(W1, picks) records nothing when a pick was made during the fetch", async () => {
    const fetch = deferred<void>();
    vi.mocked(gitFetchRemote).mockReturnValueOnce(fetch.promise);
    const user = userEvent.setup();
    renderPanel();
    await pickOption(user, /^origin\/feature-x/);
    await statusLine("Fetching origin…");
    await pickOption(user, /^dev/);
    act(() => useUiStore.setState({ compareBranch: FEATURE_REF }));
    vi.mocked(gitRemoteBranches).mockResolvedValue(UNLISTED());
    await act(async () => fetch.resolve());
    expect(await statusLine(S11)).toBeInTheDocument();
    await settle();
    expect(screen.queryByText(/was deleted on/)).toBeNull();
  });
});

describe("Compare status actions keep focus off the body (G6)", () => {
  it("(1) lands on the box when Fetch and Pick another replace a focused Retry", async () => {
    vi.mocked(gitFetchRemote).mockRejectedValue(new Error("fetch boom"));
    const user = userEvent.setup();
    const client = renderPanel();
    await pickOption(user, /^origin\/feature-x/);
    const line = await statusLine(
      "Couldn't fetch origin, so this compares against its last fetch.",
    );
    const box = line.parentElement;
    screen.getByRole("button", { name: "Retry" }).focus();
    vi.mocked(gitRemoteBranches).mockResolvedValue(UNLISTED());
    await refetchList(client);
    await statusLine(`Couldn't fetch origin. ${S11}`);
    expect(document.activeElement).toBe(box);
  });

  it("(2) lands on the box when a keyboard Fetch starts fetching", async () => {
    const user = userEvent.setup();
    const client = renderPanel();
    const box = (await reachS11(user, client)).parentElement;
    const fetch = deferred<void>();
    vi.mocked(gitFetchRemote).mockReturnValueOnce(fetch.promise);
    fetchButton().focus();
    await user.keyboard("{Enter}");
    await statusLine("Fetching origin…");
    expect(document.activeElement).toBe(box);
    await act(async () => fetch.resolve());
  });

  it("(3) lands on the box when the remote leaves under a focused Fetch", async () => {
    const user = userEvent.setup();
    const client = renderPanel();
    const box = (await reachS11(user, client)).parentElement;
    fetchButton().focus();
    vi.mocked(gitRemotes).mockResolvedValue(["upstream"]);
    await act(() =>
      client.refetchQueries({ queryKey: ["repo", REPO, "remotes"] }),
    );
    await statusLine("origin is no longer a remote.");
    expect(document.activeElement).toBe(box);
  });

  it("(4) keeps a focused Pick another when the line turns remote-gone", async () => {
    const user = userEvent.setup();
    const client = renderPanel();
    await reachS11(user, client);
    const button = pickAnotherButton();
    button.focus();
    vi.mocked(gitRemotes).mockResolvedValue(["upstream"]);
    await act(() =>
      client.refetchQueries({ queryKey: ["repo", REPO, "remotes"] }),
    );
    await statusLine("origin is no longer a remote.");
    expect(document.activeElement).toBe(button);
    expect(pickAnotherButton()).toBe(button);
  });

  it("(5) hands a focused Pick another's focus to the picker when the line goes idle", async () => {
    const user = userEvent.setup();
    const client = renderPanel();
    await reachS11(user, client);
    pickAnotherButton().focus();
    act(() => useUiStore.setState({ compareBranch: "main" }));
    await waitFor(() => expect(statusText()).toBe(""));
    expect(document.activeElement).toBe(await trigger());
  });

  it("(6) hands a focused Fetch's focus to the picker when the ref is listed again", async () => {
    const user = userEvent.setup();
    const client = renderPanel();
    await reachS11(user, client);
    fetchButton().focus();
    vi.mocked(gitRemoteBranches).mockResolvedValue(LISTED());
    await refetchList(client);
    await waitFor(() => expect(statusText()).toBe(""));
    expect(document.activeElement).toBe(await trigger());
  });
});
