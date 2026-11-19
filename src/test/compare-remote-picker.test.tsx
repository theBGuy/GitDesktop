import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComparePanel } from "@/features/compare/ComparePanel";
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
    // Each Remote row's label span (the date sits in a sibling span).
    const remoteLabels = within(
      within(list).getByRole("group", { name: "Remote" }),
    )
      .getAllByRole("option")
      .map((o) => o.querySelector("span")?.textContent ?? "");
    expect(remoteLabels).toEqual([
      "upstream/release",
      "upstream/main",
      "origin/dup",
      "origin/feature-x",
      "origin/old",
      "alpha/topic",
      "colleague/idea",
    ]);
    const firstFour = within(list).getAllByRole("option").slice(0, 4);
    // Each name is the branch, then one separator and one comma-free part (the
    // relative date; `main` carries `default` first), so a row named
    // feature-xyz, feature-x/ or a label continuing after a comma can't pass.
    expect(firstFour[0]).toHaveAccessibleName(
      /^main\s*,\s*default\s*,\s*[^,]+$/,
    );
    expect(firstFour[1]).toHaveAccessibleName(/^origin\/dup\s*,\s*[^,]+$/);
    expect(firstFour[2]).toHaveAccessibleName(/^feature-x\s*,\s*[^,]+$/);
    expect(firstFour[3]).toHaveAccessibleName(
      /^upstream\/release\s*,\s*[^,]+$/,
    );
    // Session branches never show; a same-named local doesn't hide the remote.
    expect(optionTexts(list).join("|")).not.toContain("gd/session");
    expect(
      within(list).getAllByRole("option", { name: /^feature-x/ }),
    ).toHaveLength(1);
    expect(
      within(list).getAllByRole("option", { name: /^origin\/feature-x/ }),
    ).toHaveLength(1);
    // A local literally named origin/dup and the remote row both list, one in
    // each group.
    expect(
      within(list).getAllByRole("option", { name: /^origin\/dup/ }),
    ).toHaveLength(2);
    for (const group of ["Local", "Remote"])
      expect(
        within(within(list).getByRole("group", { name: group })).getAllByRole(
          "option",
          { name: /^origin\/dup/ },
        ),
      ).toHaveLength(1);
  });

  it("stores a local pick bare and never fetches", async () => {
    const user = userEvent.setup();
    renderPanel();
    const list = await openPicker(user);
    await user.click(
      within(within(list).getByRole("group", { name: "Local" })).getByRole(
        "option",
        { name: /^origin\/dup/ },
      ),
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

describe("Compare main arm swap keeps focus off the body", () => {
  const PROMPT = "Pick a branch to compare against";
  const EMPTY_TITLE = "No other branches";
  const filterInput = () => screen.getByPlaceholderText("Filter branches…");
  const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

  function renderWithOutside() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <button type="button">Outside</button>
        <ComparePanel repoPath={REPO} />
      </QueryClientProvider>,
    );
    return client;
  }

  /** Only the current branch locally and one remote row, so emptying the
   *  remote list swaps the main arm out; the next read (the open's) is held. */
  async function oneRemoteRow() {
    vi.mocked(gitBranches).mockResolvedValue([branch("feat", day(9), true)]);
    vi.mocked(gitRemoteBranches).mockResolvedValue([
      remote("origin", "x", day(4)),
    ]);
    const client = renderWithOutside();
    await waitFor(() => expect(trigger()).toHaveTextContent(PROMPT));
    await settle();
    const held = deferred<RemoteBranch[]>();
    vi.mocked(gitRemoteBranches).mockReturnValueOnce(held.promise);
    const shell = trigger().closest<HTMLElement>('[tabindex="-1"]');
    expect(shell).not.toBeNull();
    return { client, held, shell };
  }

  async function openToFilter(user: ReturnType<typeof userEvent.setup>) {
    await user.click(trigger());
    await popup();
    await waitFor(() => expect(filterInput()).toHaveFocus());
  }

  async function openThenEscape(user: ReturnType<typeof userEvent.setup>) {
    await openToFilter(user);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(findPopup()).toBeUndefined());
    await waitFor(() => expect(trigger()).toHaveFocus());
  }

  it("lands the open picker's filter focus on the shell when the list empties", async () => {
    const user = userEvent.setup();
    const { held, shell } = await oneRemoteRow();
    await openToFilter(user);
    await act(async () => held.resolve([]));
    expect(await screen.findByText(EMPTY_TITLE)).toBeInTheDocument();
    expect(document.activeElement).toBe(shell);
    await settle();
    expect(document.activeElement).toBe(shell);
  });

  it("lands a focused closed trigger on the shell when the list empties", async () => {
    const user = userEvent.setup();
    const { held, shell } = await oneRemoteRow();
    await openThenEscape(user);
    await act(async () => held.resolve([]));
    expect(await screen.findByText(EMPTY_TITLE)).toBeInTheDocument();
    expect(document.activeElement).toBe(shell);
  });

  it("moves nothing when focus sits outside the panel", async () => {
    const user = userEvent.setup();
    const { held } = await oneRemoteRow();
    await openThenEscape(user);
    const outside = screen.getByRole("button", { name: "Outside" });
    act(() => outside.focus());
    await act(async () => held.resolve([]));
    expect(await screen.findByText(EMPTY_TITLE)).toBeInTheDocument();
    expect(document.activeElement).toBe(outside);
  });

  it("leaves focus on the body when the picker had let it go before the swap", async () => {
    const user = userEvent.setup();
    const { held } = await oneRemoteRow();
    await openThenEscape(user);
    act(() => (document.activeElement as HTMLElement).blur());
    expect(document.activeElement).toBe(document.body);
    await act(async () => held.resolve([]));
    expect(await screen.findByText(EMPTY_TITLE)).toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
  });

  it("returns an ordinary close to the trigger, never the shell", async () => {
    const user = userEvent.setup();
    renderPanel();
    await openPicker(user);
    const shell = trigger().closest('[tabindex="-1"]');
    await user.keyboard("{Escape}");
    await waitFor(() => expect(findPopup()).toBeUndefined());
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
    expect(document.activeElement).not.toBe(shell);
    const list = await openPicker(user);
    await user.click(
      within(within(list).getByRole("group", { name: "Local" })).getByRole(
        "option",
        { name: /^feature-x/ },
      ),
    );
    await waitFor(() => expect(findPopup()).toBeUndefined());
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
    expect(document.activeElement).not.toBe(shell);
  });

  it("lands on the shell when the swap reaches a skeleton arm", async () => {
    // An unsettled add-upstream offer keeps the emptied list on the waiting
    // skeleton, an arm that also starts with a div.
    vi.mocked(forgeStatus).mockReturnValue(new Promise(() => undefined));
    vi.mocked(loadSettings).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      recentRepos: [{ path: REPO, isFork: true, forkParent: "octo/project" }],
    } as unknown as typeof DEFAULT_SETTINGS);
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    const user = userEvent.setup();
    const { held, shell } = await oneRemoteRow();
    await openToFilter(user);
    await act(async () => held.resolve([]));
    await waitFor(() =>
      expect(
        screen.queryByRole("combobox", { name: "Compare with branch" }),
      ).toBeNull(),
    );
    expect(findPopup()).toBeUndefined();
    expect(screen.queryByText(EMPTY_TITLE)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(shell?.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(document.activeElement).toBe(shell);
  });

  it("brings the arm back closed after a swap made with the picker open", async () => {
    const user = userEvent.setup();
    const { client, held, shell } = await oneRemoteRow();
    await openToFilter(user);
    await act(async () => held.resolve([]));
    await screen.findByText(EMPTY_TITLE);
    expect(document.activeElement).toBe(shell);
    vi.mocked(gitRemoteBranches).mockResolvedValue([
      remote("origin", "x", day(4)),
    ]);
    await act(() =>
      client.refetchQueries({ queryKey: ["repo", REPO, "remote-branches"] }),
    );
    await waitFor(() => expect(trigger()).toHaveTextContent(PROMPT));
    await settle();
    expect(
      screen.queryByRole("listbox", { name: "Branches to compare with" }),
    ).toBeNull();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(shell);
    const lists = vi.mocked(gitRemoteBranches).mock.calls.length;
    const remotes = vi.mocked(gitRemotes).mock.calls.length;
    await user.click(trigger());
    await waitFor(() => {
      expect(vi.mocked(gitRemoteBranches).mock.calls.length).toBe(lists + 1);
      expect(vi.mocked(gitRemotes).mock.calls.length).toBe(remotes + 1);
    });
  });

  it("re-reads on the next open after the arm swapped out and back while the tab was hidden", async () => {
    // A hidden tab runs no layout effects, so the swap's reset of the open
    // flag must come from the reveal, not from the hidden edge.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = (active: boolean, repoPath: string) => (
      <QueryClientProvider client={client}>
        <TabPanel active={active}>
          <ComparePanel repoPath={repoPath} />
        </TabPanel>
      </QueryClientProvider>
    );
    const user = userEvent.setup();
    const { rerender } = render(view(true, REPO));
    await openPicker(user);
    await settle();
    rerender(view(false, REPO));
    await settle();
    // An uncached repo paints the loading arm; the way back paints the main arm.
    rerender(view(false, "C:/other"));
    await settle();
    rerender(view(false, REPO));
    await settle();
    rerender(view(true, REPO));
    await settle();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    const lists = vi.mocked(gitRemoteBranches).mock.calls.length;
    const remotes = vi.mocked(gitRemotes).mock.calls.length;
    await user.click(trigger());
    await popup();
    await waitFor(() => {
      expect(vi.mocked(gitRemoteBranches).mock.calls.length).toBe(lists + 1);
      expect(vi.mocked(gitRemotes).mock.calls.length).toBe(remotes + 1);
    });
  });
});

describe("Compare picker open joining a read in flight", () => {
  const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));
  const reads = () => ({
    lists: vi.mocked(gitRemoteBranches).mock.calls.length,
    remotes: vi.mocked(gitRemotes).mock.calls.length,
  });

  async function closePicker(user: ReturnType<typeof userEvent.setup>) {
    await user.keyboard("{Escape}");
    await waitFor(() => expect(findPopup()).toBeUndefined());
  }

  /** One client across rerenders, so a later repo or tab change keeps the
   *  first repo's reads cached. */
  function mount(repo = REPO) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const ui = (shown: string, active: boolean) => (
      <QueryClientProvider client={client}>
        <TabPanel active={active}>
          <ComparePanel repoPath={shown} />
        </TabPanel>
      </QueryClientProvider>
    );
    const view = render(ui(repo, true));
    return {
      unmount: view.unmount,
      // Moves the store too, as the app's repo switch does.
      show: (shown: string, active = true) =>
        act(async () => {
          useUiStore.setState({ repoPath: shown });
          view.rerender(ui(shown, active));
        }),
    };
  }

  /** The first opening's reads of both lists are held; a second opening made
   *  while they are in flight joins them. `warmFrom` is read first, so a later
   *  switch back to it keeps the main arm (and the picker) mounted. */
  async function joinHeldReads(
    user: ReturnType<typeof userEvent.setup>,
    warmFrom?: string,
  ) {
    const app = mount(warmFrom ?? REPO);
    if (warmFrom !== undefined) {
      await waitFor(() => expect(trigger()).toHaveTextContent("main"));
      await settle();
      await app.show(REPO);
    }
    await waitFor(() => expect(trigger()).toHaveTextContent("main"));
    await settle();
    const heldLists = deferred<RemoteBranch[]>();
    const heldRemotes = deferred<string[]>();
    vi.mocked(gitRemoteBranches).mockReturnValueOnce(heldLists.promise);
    vi.mocked(gitRemotes).mockReturnValueOnce(heldRemotes.promise);
    const before = reads();
    await openPicker(user);
    await waitFor(() =>
      expect(reads()).toEqual({
        lists: before.lists + 1,
        remotes: before.remotes + 1,
      }),
    );
    await closePicker(user);
    await openPicker(user);
    await settle();
    expect(reads()).toEqual({
      lists: before.lists + 1,
      remotes: before.remotes + 1,
    });
    return { app, before, heldLists, heldRemotes };
  }

  async function settleHeld(
    heldLists: ReturnType<typeof deferred<RemoteBranch[]>>,
    heldRemotes: ReturnType<typeof deferred<string[]>>,
  ) {
    await act(async () => {
      heldRemotes.resolve(["origin", "upstream"]);
      heldLists.resolve([]);
    });
    await settle();
  }

  it("reads both lists once more after the joined reads settle", async () => {
    const user = userEvent.setup();
    const { before, heldLists, heldRemotes } = await joinHeldReads(user);
    // The held read began before `colleague` was removed outside the app.
    const stale = [
      remote("colleague", "idea", day(8)),
      remote("origin", "feature-x", day(4)),
      remote("upstream", "main", day(2)),
    ];
    vi.mocked(gitRemoteBranches).mockResolvedValueOnce(
      stale.filter((b) => b.remote !== "colleague"),
    );
    await act(async () => {
      heldRemotes.resolve(["origin", "upstream"]);
      heldLists.resolve(stale);
    });
    await waitFor(() =>
      expect(reads()).toEqual({
        lists: before.lists + 2,
        remotes: before.remotes + 2,
      }),
    );
    const list = await popup();
    const listsColleague = () =>
      optionTexts(list).some((t) => t.startsWith("colleague/"));
    await waitFor(() => expect(listsColleague()).toBe(false));
    await settle();
    expect(reads()).toEqual({
      lists: before.lists + 2,
      remotes: before.remotes + 2,
    });
  });

  it("follows a joined read that failed", async () => {
    const user = userEvent.setup();
    const { before, heldLists, heldRemotes } = await joinHeldReads(user);
    await act(async () => {
      heldRemotes.reject(new Error("remotes boom"));
      heldLists.reject(new Error("list boom"));
    });
    await waitFor(() =>
      expect(reads()).toEqual({
        lists: before.lists + 2,
        remotes: before.remotes + 2,
      }),
    );
  });

  it("reads each list once when the opening joins nothing", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(trigger()).toHaveTextContent("main"));
    await settle();
    const before = reads();
    await openPicker(user);
    await settle();
    expect(reads()).toEqual({
      lists: before.lists + 1,
      remotes: before.remotes + 1,
    });
  });

  it("reads nothing more when the picker closed before the joined reads settle", async () => {
    const user = userEvent.setup();
    const { before, heldLists, heldRemotes } = await joinHeldReads(user);
    await closePicker(user);
    await settleHeld(heldLists, heldRemotes);
    expect(reads()).toEqual({
      lists: before.lists + 1,
      remotes: before.remotes + 1,
    });
  });

  it("reads nothing more when the panel unmounted before the joined reads settle", async () => {
    const user = userEvent.setup();
    const { app, before, heldLists, heldRemotes } = await joinHeldReads(user);
    app.unmount();
    await settleHeld(heldLists, heldRemotes);
    expect(reads()).toEqual({
      lists: before.lists + 1,
      remotes: before.remotes + 1,
    });
  });

  it("reads nothing more when the tab was hidden before the joined reads settle", async () => {
    const user = userEvent.setup();
    const { app, before, heldLists, heldRemotes } = await joinHeldReads(user);
    await app.show(REPO, false);
    await settleHeld(heldLists, heldRemotes);
    expect(reads()).toEqual({
      lists: before.lists + 1,
      remotes: before.remotes + 1,
    });
  });

  // After a switch the hook's refetch reads the new repo's key, so a follow-up
  // would show in the totals, never in the first repo's own count. The switch
  // is to a cached repo, so the arm edge never closes the picker.
  it("reads nothing more when the repo switched before the joined reads settle", async () => {
    const user = userEvent.setup();
    const { app, heldLists, heldRemotes } = await joinHeldReads(
      user,
      "C:/other",
    );
    await app.show("C:/other");
    expect(trigger()).toBeInTheDocument();
    await settle();
    const switched = reads();
    await settleHeld(heldLists, heldRemotes);
    expect(reads()).toEqual(switched);
  });
});

describe("Compare picker across a repo switch", () => {
  const OTHER = "C:/other";
  const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

  it("closes on a switch to a cached repo and re-reads on the next open", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const ui = (shown: string) => (
      <QueryClientProvider client={client}>
        <ComparePanel repoPath={shown} />
      </QueryClientProvider>
    );
    // OTHER is read first, so the switch back to it keeps the main arm.
    useUiStore.setState({ repoPath: OTHER });
    const view = render(ui(OTHER));
    await waitFor(() => expect(trigger()).toHaveTextContent("main"));
    act(() => {
      useUiStore.setState({ repoPath: REPO });
      view.rerender(ui(REPO));
    });
    const user = userEvent.setup();
    await openPicker(user);
    await settle();
    act(() => {
      useUiStore.setState({ repoPath: OTHER });
      view.rerender(ui(OTHER));
    });
    expect(trigger()).toHaveTextContent("main");
    await waitFor(() => expect(findPopup()).toBeUndefined());
    await settle();
    const lists = vi.mocked(gitRemoteBranches).mock.calls.length;
    const remotes = vi.mocked(gitRemotes).mock.calls.length;
    await openPicker(user);
    await settle();
    expect(vi.mocked(gitRemoteBranches).mock.calls.length).toBe(lists + 1);
    expect(vi.mocked(gitRemotes).mock.calls.length).toBe(remotes + 1);
  });
});
