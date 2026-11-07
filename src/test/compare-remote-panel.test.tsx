import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComparePanel } from "@/features/compare/ComparePanel";
import { TabPanel } from "@/features/repository/TabPanel";
import {
  forgePrsForBranch,
  forgeStatus,
  gitBranches,
  gitCompareBranches,
  gitDefaultBranch,
  gitFetchRemote,
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
  // The Create PR dialog's reads, for the case that opens it.
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

function statusOf(
  name: string,
  upstream: [string, string] | null = null,
): RepoStatus {
  return {
    branch: {
      name,
      detached: false,
      upstreamRemote: upstream?.[0] ?? null,
      upstreamBranch: upstream?.[1] ?? null,
    },
    files: [],
  } as unknown as RepoStatus;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderPanel(repo = REPO) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = (r: string, mode: "visible" | "hidden" = "visible"): ReactNode => (
    <QueryClientProvider client={client}>
      <TabPanel active={mode === "visible"}>
        <ComparePanel repoPath={r} />
      </TabPanel>
    </QueryClientProvider>
  );
  const view = render(ui(repo));
  return {
    client,
    switchTo: (r: string) => {
      useUiStore.setState({ repoPath: r, compareBranch: null });
      view.rerender(ui(r));
    },
    hide: () => view.rerender(ui(repo, "hidden")),
    show: () => view.rerender(ui(repo)),
  };
}

const trigger = () =>
  screen.findByRole("combobox", { name: "Compare with branch" });

async function pickRemote(
  user: ReturnType<typeof userEvent.setup>,
  label: RegExp,
) {
  await user.click(await trigger());
  await user.click(await screen.findByRole("option", { name: label }));
}

/** Seeds a stored pick without driving the picker (no fetch). */
function storedPick(value: string) {
  useUiStore.setState({ repoPath: REPO, compareBranch: value });
}

/** The fetch status line's text, never the Create button's held reason. */
const STATUS = { selector: "p[role=status]" };

const FAILED =
  "Couldn't fetch upstream, so this compares against its last fetch.";

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
  ]);
  vi.mocked(gitRemoteBranches).mockResolvedValue([
    remote("upstream", "main"),
    remote("origin", "feature-x"),
    remote("origin", "feat"),
    remote("colleague", "idea"),
  ]);
  vi.mocked(gitCompareBranches).mockResolvedValue({
    ahead: [COMMIT],
    behind: [],
  });
  vi.mocked(gitFetchRemote).mockResolvedValue(undefined);
  vi.mocked(forgeStatus).mockResolvedValue(GITHUB);
  vi.mocked(gitRemotes).mockResolvedValue(["origin", "upstream"]);
});

afterEach(() => {
  onlineManager.setOnline(true);
});

describe("Compare fetch status line", () => {
  it("dims the lists while fetching, then fails into Retry without a toast", async () => {
    const error = vi.spyOn(toast, "error");
    const first = deferred<void>();
    vi.mocked(gitFetchRemote).mockReturnValueOnce(first.promise);
    const user = userEvent.setup();
    renderPanel();
    await pickRemote(user, /^upstream\/main/);
    expect(
      await screen.findByText("Fetching upstream…", STATUS),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("listbox", { name: "Compare selection" }),
    ).toHaveAttribute("aria-busy", "true");
    first.reject({ kind: "busy", message: "a fetch is running" });
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    expect(
      screen.getByRole("listbox", { name: "Compare selection" }),
    ).toHaveAttribute("aria-busy", "false");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(gitFetchRemote).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(FAILED)).toBeNull());
    // Focus never falls to <body> when Retry unmounts under it, nor stays on
    // the line once it goes idle.
    await waitFor(async () =>
      expect(document.activeElement).toBe(await trigger()),
    );
    expect(error).not.toHaveBeenCalled();
  });

  it("paints nothing in the repo the user switched to before the settle", async () => {
    const first = deferred<void>();
    vi.mocked(gitFetchRemote).mockReturnValueOnce(first.promise);
    const user = userEvent.setup();
    const view = renderPanel();
    await pickRemote(user, /^upstream\/main/);
    await screen.findByText("Fetching upstream…", STATUS);
    view.switchTo(OTHER);
    // The same stored pick in the new repo: only the stamp's repo hides it.
    act(() =>
      useUiStore.setState({ compareBranch: "refs/remotes/upstream/main" }),
    );
    await act(async () => first.reject(new Error("boom")));
    await screen.findByRole("combobox", { name: "Compare with branch" });
    expect(screen.queryByText(FAILED)).toBeNull();
    expect(screen.queryByText("Fetching upstream…")).toBeNull();
  });

  it("never paints a superseded pick's failure", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    vi.mocked(gitFetchRemote)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const user = userEvent.setup();
    renderPanel();
    await pickRemote(user, /^upstream\/main/);
    await pickRemote(user, /^origin\/feature-x/);
    await act(async () => first.reject(new Error("boom")));
    expect(screen.getByText("Fetching origin…", STATUS)).toBeInTheDocument();
    expect(screen.queryByText(FAILED)).toBeNull();
    second.resolve();
  });

  it("parks an offline pick and re-fires it once on reconnect", async () => {
    const user = userEvent.setup();
    const view = renderPanel();
    await trigger();
    act(() => onlineManager.setOnline(false));
    await pickRemote(user, /^upstream\/main/);
    expect(
      await screen.findByText(
        "You're offline, so this compares against upstream's last fetch.",
      ),
    ).toBeInTheDocument();
    expect(gitFetchRemote).not.toHaveBeenCalled();
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(gitFetchRemote).toHaveBeenCalledTimes(1));
    // An <Activity> hide/show replays effects; the consumed park fires nothing.
    view.hide();
    view.show();
    await screen.findByRole("combobox", { name: "Compare with branch" });
    expect(gitFetchRemote).toHaveBeenCalledTimes(1);
  });

  it("keeps a pruned pick, says so, and opens the picker on request", async () => {
    vi.mocked(gitCompareBranches).mockRejectedValue({
      kind: "git",
      message: "unknown revision",
    });
    storedPick("refs/remotes/origin/gone");
    const user = userEvent.setup();
    renderPanel();
    expect(
      await screen.findByText("origin/gone was deleted on origin.", STATUS),
    ).toBeInTheDocument();
    expect(useUiStore.getState().compareBranch).toBe(
      "refs/remotes/origin/gone",
    );
    expect(screen.queryByText("These branches are even.")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Pick another branch" }),
    );
    expect(
      await screen.findByRole("option", { name: /^upstream\/main/ }),
    ).toBeInTheDocument();
  });
});

describe("Compare comparison read", () => {
  it("keeps loaded lists under a notice when a refresh fails", async () => {
    const view = renderPanel();
    expect(await screen.findByText("ahead work")).toBeInTheDocument();
    vi.mocked(gitCompareBranches).mockRejectedValue(new Error("boom"));
    await act(() =>
      view.client.refetchQueries({ queryKey: ["repo", REPO, "compare"] }),
    );
    expect(
      await screen.findByText(
        "Couldn't refresh this comparison — showing the last loaded results.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("ahead work")).toBeInTheDocument();
    expect(screen.queryByText("These branches are even.")).toBeNull();
  });

  it("never says even over a failed read", async () => {
    vi.mocked(gitCompareBranches).mockRejectedValue(new Error("boom"));
    renderPanel();
    await screen.findByText("boom");
    expect(screen.queryByText("These branches are even.")).toBeNull();
  });
});

describe("Compare Create PR mapping", () => {
  it("targets the parent from upstream/<b> and the fork from origin/<b>", async () => {
    storedPick("refs/remotes/upstream/main");
    renderPanel();
    expect(
      await screen.findByRole("button", {
        name: /Create pull request in parent…/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Create local PR/ }),
    ).toBeNull();
    await waitFor(() =>
      expect(forgePrsForBranch).toHaveBeenCalledWith(REPO, "feat", "upstream"),
    );
    act(() => storedPick("refs/remotes/origin/feature-x"));
    expect(
      await screen.findByRole("button", {
        name: /Create pull request in your fork…/,
      }),
    ).toBeInTheDocument();
  });

  /** Settles the forge-dependent reads on a local pick (its Create shows),
   *  then moves to `value`: an absence after that is the mapping's answer. */
  async function settledThenPick(value: string, display: string) {
    storedPick("main");
    renderPanel();
    await screen.findByRole("button", { name: /^Create pull request…/ });
    act(() => storedPick(value));
    await waitFor(async () =>
      expect(await trigger()).toHaveTextContent(display),
    );
  }

  it("hides Create PR for any other remote", async () => {
    await settledThenPick("refs/remotes/colleague/idea", "colleague/idea");
    expect(screen.queryByRole("button", { name: /Create pull/ })).toBeNull();
  });

  it("keeps the plain label without the fork lens and hides upstream there", async () => {
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    storedPick("refs/remotes/origin/feature-x");
    renderPanel();
    expect(
      await screen.findByRole("button", { name: /^Create pull request…/ }),
    ).toBeInTheDocument();
    act(() => storedPick("refs/remotes/upstream/main"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Create pull/ })).toBeNull(),
    );
  });

  it("names merge requests on GitLab", async () => {
    vi.mocked(forgeStatus).mockResolvedValue({
      ...GITHUB,
      provider: "gitlab",
    } as ForgeStatus);
    storedPick("refs/remotes/origin/feature-x");
    renderPanel();
    expect(
      await screen.findByRole("button", { name: /^Create merge request…/ }),
    ).toBeInTheDocument();
  });

  it("opens the dialog on the bare base name", async () => {
    storedPick("refs/remotes/origin/feature-x");
    const user = userEvent.setup();
    renderPanel();
    await user.click(
      await screen.findByRole("button", {
        name: /Create pull request in your fork…/,
      }),
    );
    const base = await screen.findByRole("combobox", { name: "Base" });
    await waitFor(() => expect(base).toHaveTextContent("feature-x"));
    expect(base.textContent).not.toContain("refs/");
  });
});

describe("Compare own remote copy", () => {
  async function settledThenPick(value: string, display: string) {
    storedPick("main");
    renderPanel();
    await screen.findByRole("button", { name: /^Create pull request…/ });
    act(() => storedPick(value));
    await waitFor(async () =>
      expect(await trigger()).toHaveTextContent(display),
    );
  }

  it("hides the PR buttons and explains push/pull when it is the upstream", async () => {
    vi.mocked(gitStatus).mockResolvedValue(
      statusOf("feat", ["origin", "feat"]),
    );
    await settledThenPick("refs/remotes/origin/feat", "origin/feat");
    expect(
      await screen.findByText(
        "Comparing with your branch on origin: ahead = not pushed, behind = not pulled.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Create/ })).toBeNull();
  });

  it("hides the buttons but says nothing for an untracked branch", async () => {
    await settledThenPick("refs/remotes/origin/feat", "origin/feat");
    expect(screen.queryByRole("button", { name: /Create/ })).toBeNull();
    expect(screen.queryByText(/Comparing with your branch/)).toBeNull();
  });

  it("keeps the parent PR for a branch tracking upstream/main", async () => {
    vi.mocked(gitStatus).mockResolvedValue(
      statusOf("feat", ["upstream", "main"]),
    );
    storedPick("refs/remotes/upstream/main");
    renderPanel();
    expect(
      await screen.findByRole("button", {
        name: /Create pull request in parent…/,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Comparing with your branch/)).toBeNull();
  });
});
