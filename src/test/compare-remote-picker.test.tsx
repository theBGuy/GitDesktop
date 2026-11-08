import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComparePanel } from "@/features/compare/ComparePanel";
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
import type {
  Branch,
  ForgeStatus,
  RemoteBranch,
  RepoStatus,
} from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
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
}));
vi.mock("@/lib/git/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/worktree")>()),
  listUserWorktrees: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("@/lib/repo-lens/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/repo-lens/store")>()),
  loadRepoLens: vi.fn(() => new Promise(() => undefined)),
}));

const REPO = "C:/repo";

const GITHUB = {
  provider: "github",
  installed: true,
  authenticated: true,
  repo: "me/project",
  host: "github.com",
  login: "me",
  capabilities: {},
  implemented: {},
} as unknown as ForgeStatus;

const day = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString();

const branch = (name: string, date: string, isCurrent = false) =>
  ({ name, isCurrent, archived: false, lastCommitDate: date }) as Branch;

const remote = (r: string, name: string, date: string): RemoteBranch => ({
  remote: r,
  name,
  lastCommitDate: date,
});

function statusOf(name: string): RepoStatus {
  return {
    branch: {
      name,
      detached: false,
      upstreamRemote: null,
      upstreamBranch: null,
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

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ComparePanel repoPath={REPO} />
    </QueryClientProvider>,
  );
}

const trigger = () =>
  screen.getByRole("combobox", { name: "Compare with branch" });

/** The picker's popup list (the panel's own commit list is a listbox too). */
const findPopup = () =>
  screen
    .queryAllByRole("listbox")
    .find((l) => l.getAttribute("aria-label") !== "Compare selection");

const popup = () =>
  waitFor(() => {
    const list = findPopup();
    if (!list) throw new Error("picker popup not open");
    return list;
  });

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(trigger()).toHaveTextContent("main"));
  await user.click(trigger());
  return popup();
}

const optionTexts = (list: HTMLElement) =>
  within(list)
    .getAllByRole("option")
    .map((o) => o.textContent ?? "");

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ repoPath: REPO, compareBranch: null });
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(gitStatus).mockResolvedValue(statusOf("feat"));
  vi.mocked(gitDefaultBranch).mockResolvedValue("main");
  vi.mocked(gitBranches).mockResolvedValue([
    branch("feat", day(9), true),
    branch("main", day(1)),
    branch("feature-x", day(2)),
    branch("origin/dup", day(3)),
  ]);
  vi.mocked(gitRemoteBranches).mockResolvedValue([
    remote("colleague", "idea", day(8)),
    remote("origin", "feature-x", day(4)),
    remote("origin", "old", day(1)),
    remote("origin", "dup", day(5)),
    remote("origin", "gd/session/abc", day(9)),
    remote("upstream", "main", day(2)),
    remote("upstream", "release", day(6)),
    remote("alpha", "topic", day(7)),
  ]);
  vi.mocked(gitCompareBranches).mockResolvedValue({ ahead: [], behind: [] });
  vi.mocked(gitFetchRemote).mockResolvedValue(undefined);
  vi.mocked(forgeStatus).mockResolvedValue(GITHUB);
  vi.mocked(gitRemotes).mockResolvedValue(["origin", "upstream"]);
});

describe("Compare picker Remote group", () => {
  it("lists upstream, origin, then other remotes, each by recency", async () => {
    const user = userEvent.setup();
    renderPanel();
    const list = await openPicker(user);
    await waitFor(() =>
      expect(optionTexts(list).some((t) => t.startsWith("upstream/"))).toBe(
        true,
      ),
    );
    // Each row's label span (the date sits in a sibling span).
    const labels = within(list)
      .getAllByRole("option")
      .map((o) => o.querySelector("span")?.textContent ?? "");
    const remoteLabels = labels.filter(
      (l) => l.includes("/") && l !== "origin/dup",
    );
    expect(remoteLabels).toEqual([
      "upstream/release",
      "upstream/main",
      "origin/feature-x",
      "origin/old",
      "alpha/topic",
      "colleague/idea",
    ]);
    expect(labels.slice(0, 4)).toEqual([
      "maindefault",
      "origin/dup",
      "feature-x",
      "upstream/release",
    ]);
    // Session branches never show; a same-named local doesn't hide the remote.
    expect(optionTexts(list).join("|")).not.toContain("gd/session");
    expect(
      within(list).getAllByRole("option", { name: /^feature-x/ }),
    ).toHaveLength(1);
    expect(
      within(list).getAllByRole("option", { name: /^origin\/feature-x/ }),
    ).toHaveLength(1);
    // The local literally named origin/dup wins; the remote row is dropped.
    expect(
      within(list).getAllByRole("option", { name: /^origin\/dup/ }),
    ).toHaveLength(1);
  });

  it("stores a local pick bare and never fetches", async () => {
    const user = userEvent.setup();
    renderPanel();
    const list = await openPicker(user);
    await user.click(
      within(list).getByRole("option", { name: /^origin\/dup/ }),
    );
    expect(useUiStore.getState().compareBranch).toBe("origin/dup");
    expect(gitFetchRemote).not.toHaveBeenCalled();
  });

  it("stores a remote pick as its full ref and fetches that remote once", async () => {
    const user = userEvent.setup();
    renderPanel();
    const list = await openPicker(user);
    await user.click(
      await within(list).findByRole("option", { name: /^upstream\/main/ }),
    );
    expect(useUiStore.getState().compareBranch).toBe(
      "refs/remotes/upstream/main",
    );
    expect(gitFetchRemote).toHaveBeenCalledTimes(1);
    expect(gitFetchRemote).toHaveBeenCalledWith(REPO, "upstream");
    expect(trigger()).toHaveTextContent("upstream/main");
    expect(trigger().textContent).not.toContain("refs/");
  });

  it("joins a second pick on a remote whose fetch is in flight", async () => {
    const fetch = deferred<void>();
    vi.mocked(gitFetchRemote).mockReturnValue(fetch.promise);
    const user = userEvent.setup();
    renderPanel();
    let list = await openPicker(user);
    await user.click(
      await within(list).findByRole("option", { name: /^upstream\/main/ }),
    );
    await user.click(trigger());
    list = await popup();
    await user.click(
      await within(list).findByRole("option", { name: /^upstream\/release/ }),
    );
    expect(useUiStore.getState().compareBranch).toBe(
      "refs/remotes/upstream/release",
    );
    expect(gitFetchRemote).toHaveBeenCalledTimes(1);
    fetch.resolve();
  });
});

describe("Compare picker add-upstream action row", () => {
  function forkWithoutUpstream() {
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    vi.mocked(loadSettings).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      recentRepos: [{ path: REPO, isFork: true, forkParent: "octo/project" }],
    } as unknown as typeof DEFAULT_SETTINGS);
  }

  it("adds the remote once from the keyboard, holds the popup open while adding, then fetches it", async () => {
    forkWithoutUpstream();
    const add = deferred<void>();
    vi.mocked(gitRemoteAdd).mockReturnValue(add.promise);
    const user = userEvent.setup();
    renderPanel();
    const list = await openPicker(user);
    const row = await within(list).findByRole("option", {
      name: /^Add upstream remote/,
    });
    expect(row).toHaveTextContent("fork of octo/project");
    // Arrow keys reach the row: it is a real item of the list.
    const input = screen.getByPlaceholderText("Filter branches…");
    await user.type(input, "upstream");
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(row).toHaveAttribute("data-highlighted"));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(gitRemoteAdd).toHaveBeenCalledTimes(1));
    expect(findPopup()).toBeDefined();
    expect(
      await within(list).findByRole("option", {
        name: /^Adding upstream remote…/,
      }),
    ).toBeInTheDocument();
    // A second Enter while the add runs never adds twice.
    await user.keyboard("{Enter}");
    expect(gitRemoteAdd).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().compareBranch).toBe("main");
    vi.mocked(gitRemotes).mockResolvedValue(["origin", "upstream"]);
    add.resolve();
    await waitFor(() =>
      expect(gitFetchRemote).toHaveBeenCalledWith(REPO, "upstream"),
    );
    expect(useUiStore.getState().compareBranch).toBe("main");
  });

  it("closes the popup onto its trigger once the add succeeds", async () => {
    forkWithoutUpstream();
    vi.mocked(gitRemoteAdd).mockImplementation(async () => {
      vi.mocked(gitRemotes).mockResolvedValue(["origin", "upstream"]);
    });
    const user = userEvent.setup();
    renderPanel();
    const list = await openPicker(user);
    await within(list).findByRole("option", { name: /^Add upstream remote/ });
    await user.type(
      screen.getByPlaceholderText("Filter branches…"),
      "upstream",
    );
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() =>
      expect(gitFetchRemote).toHaveBeenCalledWith(REPO, "upstream"),
    );
    await waitFor(() => expect(findPopup()).toBeUndefined());
    expect(document.activeElement).toBe(trigger());
    await user.keyboard("{Enter}");
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(useUiStore.getState().compareBranch).toBe("main");
  });

  it("keeps the popup and the row when the add fails", async () => {
    forkWithoutUpstream();
    vi.mocked(gitRemoteAdd).mockRejectedValue(new Error("add boom"));
    const user = userEvent.setup();
    renderPanel();
    const list = await openPicker(user);
    await user.click(
      await within(list).findByRole("option", { name: /^Add upstream remote/ }),
    );
    await waitFor(() => expect(gitRemoteAdd).toHaveBeenCalledTimes(1));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(findPopup()).toBeDefined();
    expect(
      within(list).getByRole("option", { name: /^Add upstream remote/ }),
    ).toBeInTheDocument();
    expect(gitFetchRemote).not.toHaveBeenCalled();
  });

  it("offers nothing to a signed-out fork that already has the upstream remote", async () => {
    forkWithoutUpstream();
    vi.mocked(gitRemotes).mockResolvedValue(["origin", "upstream"]);
    vi.mocked(forgeStatus).mockResolvedValue({
      ...GITHUB,
      authenticated: false,
    } as ForgeStatus);
    const user = userEvent.setup();
    renderPanel();
    const list = await openPicker(user);
    await within(list).findByRole("option", { name: /^upstream\/main/ });
    expect(
      within(list).queryByRole("option", { name: /Add upstream remote/ }),
    ).toBeNull();
  });
});
