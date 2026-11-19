import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComparePanel } from "@/features/compare/ComparePanel";
import {
  clearPickRemotesForTests,
  collidesWithRemoteRefs,
  compareItemLabel,
  compareItemOf,
  compareItemStored,
  localCompareItem,
} from "@/features/compare/compare-remote-ref";
import {
  forgeStatus,
  gitBranchDivergence,
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
  ForgeStatus,
  RemoteBranch,
  RepoStatus,
} from "@/lib/git/types";
import { listUserWorktrees, type UserWorktree } from "@/lib/git/worktree";
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
  gitBranchDivergence: vi.fn(),
}));
vi.mock("@/lib/git/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/worktree")>()),
  listUserWorktrees: vi.fn(),
}));
vi.mock("@/lib/repo-lens/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/repo-lens/store")>()),
  loadRepoLens: vi.fn(() => new Promise(() => undefined)),
}));

const REPO = "C:/repo";
const REASON = "Can't be picked: Compare reads this name as a remote branch.";

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

const worktree = (path: string, name: string) =>
  ({
    path,
    branch: name,
    head: "c".repeat(40),
    isMain: false,
    isDetached: false,
    isLocked: false,
    lockReason: "",
  }) as UserWorktree;

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

async function openPicker(
  user: ReturnType<typeof userEvent.setup>,
  shown = "main",
) {
  await waitFor(() => expect(trigger()).toHaveTextContent(shown));
  await user.click(trigger());
  const list = await screen.findByRole("listbox", {
    name: "Branches to compare with",
  });
  // The Remote group lands with the remote read the open turns on.
  await within(list).findByRole("group", { name: "Remote" });
  return list;
}

const group = (list: HTMLElement, name: "Local" | "Remote") =>
  within(list).getByRole("group", { name });

const optionIn = (list: HTMLElement, name: "Local" | "Remote", row: RegExp) =>
  within(group(list, name)).getByRole("option", { name: row });

const filterInput = () => screen.getByPlaceholderText("Filter branches…");

beforeEach(() => {
  vi.clearAllMocks();
  clearPickRemotesForTests();
  useUiStore.setState({ repoPath: REPO, compareBranch: null });
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(gitStatus).mockResolvedValue(statusOf("feat"));
  vi.mocked(gitDefaultBranch).mockResolvedValue("main");
  vi.mocked(gitBranches).mockResolvedValue([
    branch("feat", day(9), true),
    branch("main", day(8)),
    branch("origin/x", day(7)),
    branch("refs/remotes/origin/x", day(6)),
    branch("refs/remotes/x", day(5)),
  ]);
  vi.mocked(gitRemoteBranches).mockResolvedValue([
    remote("origin", "x", day(4)),
    remote("origin", "y", day(3)),
  ]);
  vi.mocked(gitBranchDivergence).mockResolvedValue([
    { name: "main", ahead: 2, behind: 1 },
  ]);
  vi.mocked(listUserWorktrees).mockResolvedValue([
    worktree("C:/wt/main", "main"),
  ]);
  vi.mocked(gitCompareBranches).mockResolvedValue({ ahead: [], behind: [] });
  vi.mocked(gitFetchRemote).mockResolvedValue(undefined);
  vi.mocked(forgeStatus).mockResolvedValue(GITHUB);
  vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
});

describe("Compare picker item helpers", () => {
  it("prefixes a local item with its kind and maps it back to the bare name", () => {
    expect(localCompareItem("main")).toBe("refs/heads/main");
    expect(compareItemOf("main")).toBe("refs/heads/main");
    expect(compareItemStored("refs/heads/main")).toBe("main");
    expect(compareItemLabel("refs/heads/main")).toBe("main");
  });

  it("keeps a remote item as the stored full ref, labelled remote/name", () => {
    expect(compareItemOf("refs/remotes/origin/x")).toBe(
      "refs/remotes/origin/x",
    );
    expect(compareItemStored("refs/remotes/origin/x")).toBe(
      "refs/remotes/origin/x",
    );
    expect(compareItemLabel("refs/remotes/origin/x")).toBe("origin/x");
  });

  it("tells a local named like a remote ref from the remote row", () => {
    const local = localCompareItem("refs/remotes/origin/x");
    expect(local).toBe("refs/heads/refs/remotes/origin/x");
    expect(compareItemStored(local)).toBe("refs/remotes/origin/x");
    expect(compareItemLabel(local)).toBe("refs/remotes/origin/x");
    expect(collidesWithRemoteRefs("refs/remotes/origin/x")).toBe(true);
    // A stored value with no further slash passes through as a remote item,
    // never the disabled local row's item.
    expect(compareItemOf("refs/remotes/x")).toBe("refs/remotes/x");
    expect(collidesWithRemoteRefs("refs/remotes/x")).toBe(true);
  });

  it("round-trips a local named refs/heads/x and leaves it pickable", () => {
    const local = localCompareItem("refs/heads/x");
    expect(local).toBe("refs/heads/refs/heads/x");
    expect(compareItemOf("refs/heads/x")).toBe(local);
    expect(compareItemStored(local)).toBe("refs/heads/x");
    expect(compareItemLabel(local)).toBe("refs/heads/x");
    expect(collidesWithRemoteRefs("refs/heads/x")).toBe(false);
    expect(collidesWithRemoteRefs("origin/x")).toBe(false);
  });
});

describe("Compare picker identity (local and remote twins)", () => {
  it("lists a local origin/x and the remote origin/x, each in its group", async () => {
    const user = userEvent.setup();
    renderPanel();
    const list = await openPicker(user);
    await within(group(list, "Remote")).findByRole("option", {
      name: /^origin\/x/,
    });
    expect(optionIn(list, "Local", /^origin\/x/)).toBeInTheDocument();
    expect(
      within(list).getAllByRole("option", { name: /^origin\/x/ }),
    ).toHaveLength(2);
  });

  it("stores the Local twin bare and fetches nothing", async () => {
    const user = userEvent.setup();
    renderPanel();
    const list = await openPicker(user);
    await user.click(optionIn(list, "Local", /^origin\/x/));
    expect(useUiStore.getState().compareBranch).toBe("origin/x");
    expect(gitFetchRemote).not.toHaveBeenCalled();
  });

  it("stores the Remote twin as its full ref and fetches origin once", async () => {
    const user = userEvent.setup();
    renderPanel();
    const list = await openPicker(user);
    await user.click(
      await within(group(list, "Remote")).findByRole("option", {
        name: /^origin\/x/,
      }),
    );
    expect(useUiStore.getState().compareBranch).toBe("refs/remotes/origin/x");
    expect(gitFetchRemote).toHaveBeenCalledTimes(1);
    expect(gitFetchRemote).toHaveBeenCalledWith(REPO, "origin");
    expect(trigger()).toHaveTextContent("origin/x");
    expect(trigger().textContent).not.toContain("refs/");
  });

  it("marks the Local twin selected for a stored local pick", async () => {
    useUiStore.setState({ compareBranch: "origin/x" });
    const user = userEvent.setup();
    renderPanel();
    const list = await openPicker(user, "origin/x");
    await within(group(list, "Remote")).findByRole("option", {
      name: /^origin\/x/,
    });
    expect(optionIn(list, "Local", /^origin\/x/)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(optionIn(list, "Remote", /^origin\/x/)).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("marks only the Remote twin selected for a stored remote pick", async () => {
    useUiStore.setState({ compareBranch: "refs/remotes/origin/x" });
    const user = userEvent.setup();
    renderPanel();
    const list = await openPicker(user, "origin/x");
    const remoteRow = await within(group(list, "Remote")).findByRole("option", {
      name: /^origin\/x/,
    });
    expect(remoteRow).toHaveAttribute("aria-selected", "true");
    const selected = within(list)
      .getAllByRole("option")
      .filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected).toEqual([remoteRow]);
  });

  it.each([
    { stored: "origin/x", twin: "Local" as const },
    { stored: "refs/remotes/origin/x", twin: "Remote" as const },
  ])("highlights the selected $twin twin on open", async ({ stored, twin }) => {
    useUiStore.setState({ compareBranch: stored });
    const user = userEvent.setup();
    renderPanel();
    const list = await openPicker(user, "origin/x");
    const row = await within(group(list, twin)).findByRole("option", {
      name: /^origin\/x/,
    });
    expect(row).toHaveAttribute("aria-selected", "true");
    await waitFor(() =>
      expect(
        within(list)
          .getAllByRole("option")
          .filter((o) => o.hasAttribute("data-highlighted")),
      ).toEqual([row]),
    );
  });

  it("filters on what each row shows", async () => {
    const user = userEvent.setup();
    renderPanel();
    const list = await openPicker(user);
    await within(group(list, "Remote")).findByRole("option", {
      name: /^origin\/x/,
    });
    await user.type(filterInput(), "refs/");
    await waitFor(() =>
      expect(within(list).getAllByRole("option")).toHaveLength(2),
    );
    const [first, second] = within(list).getAllByRole("option");
    expect(first).toHaveAccessibleName(`refs/remotes/origin/x, ${REASON}`);
    expect(second).toHaveAccessibleName(`refs/remotes/x, ${REASON}`);
    await user.clear(filterInput());
    await user.type(filterInput(), "origin/x");
    await waitFor(() =>
      expect(
        within(list).getAllByRole("option", { name: /^origin\/x/ }),
      ).toHaveLength(2),
    );
  });

  it("shows a local row's bare name with its chips, never a refs/heads/ spelling", async () => {
    const user = userEvent.setup();
    renderPanel();
    const list = await openPicker(user);
    const row = optionIn(list, "Local", /^main/);
    expect(within(row).getByText("main")).toBeInTheDocument();
    await waitFor(() =>
      expect(row).toHaveAccessibleName(
        /^main, default, worktree, 2 commits ahead of feat, 1 commit behind, /,
      ),
    );
    for (const option of within(list).getAllByRole("option"))
      expect(option.textContent).not.toContain("refs/heads/");
  });
});

describe("Compare picker colliding local row", () => {
  it("lists it disabled, named by its full name and the reason", async () => {
    const user = userEvent.setup();
    renderPanel();
    const list = await openPicker(user);
    const row = within(group(list, "Local")).getByRole("option", {
      name: `refs/remotes/origin/x, ${REASON}`,
    });
    expect(row).toHaveAttribute("aria-disabled", "true");
    // Both parts are visible text, the reason undimmed.
    const reason = within(row).getByText(REASON);
    expect(reason).not.toHaveClass("sr-only");
    expect(within(row).getByText("refs/remotes/origin/x")).toHaveClass(
      "opacity-50",
    );
    // The merged class keeps the override and drops the vendored fade.
    expect(row).toHaveClass("data-disabled:opacity-100");
    expect(row).not.toHaveClass("data-disabled:opacity-50");
  });

  it("keeps its sorted place among the pickable rows", async () => {
    vi.mocked(gitBranches).mockResolvedValue([
      branch("feat", day(9), true),
      branch("main", day(8)),
      branch("newer", day(7)),
      branch("refs/remotes/origin/x", day(6)),
      branch("older", day(5)),
    ]);
    const user = userEvent.setup();
    renderPanel();
    const list = await openPicker(user);
    const local = group(list, "Local");
    expect(within(local).getAllByRole("option")).toEqual([
      within(local).getByRole("option", { name: /^main,/ }),
      within(local).getByRole("option", { name: /^newer,/ }),
      within(local).getByRole("option", {
        name: `refs/remotes/origin/x, ${REASON}`,
      }),
      within(local).getByRole("option", { name: /^older,/ }),
    ]);
  });

  it("refuses a click: the store, the fetch count and the popup stay", async () => {
    const user = userEvent.setup();
    renderPanel();
    const list = await openPicker(user);
    await user.click(
      within(group(list, "Local")).getByRole("option", {
        name: `refs/remotes/origin/x, ${REASON}`,
      }),
    );
    expect(useUiStore.getState().compareBranch).toBe("main");
    expect(gitFetchRemote).not.toHaveBeenCalled();
    expect(
      screen.getByRole("listbox", { name: "Branches to compare with" }),
    ).toBeInTheDocument();
  });

  it("lets arrows land on it and refuses Enter", async () => {
    const user = userEvent.setup();
    renderPanel();
    const list = await openPicker(user);
    await user.type(filterInput(), "refs/remotes/origin/x");
    const row = await within(list).findByRole("option", {
      name: `refs/remotes/origin/x, ${REASON}`,
    });
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(row).toHaveAttribute("data-highlighted"));
    await user.keyboard("{Enter}");
    expect(useUiStore.getState().compareBranch).toBe("main");
    expect(gitFetchRemote).not.toHaveBeenCalled();
    expect(
      screen.getByRole("listbox", { name: "Branches to compare with" }),
    ).toBeInTheDocument();
  });

  // Base UI's closed-trigger typeahead commits the matched item through the
  // root's onValueChange, disabled rows included; its labels are filled when
  // the trigger takes focus.
  async function typeOnClosedTrigger(
    user: ReturnType<typeof userEvent.setup>,
    keys: string,
  ) {
    vi.mocked(gitBranches).mockResolvedValue([
      branch("feat", day(9), true),
      branch("main", day(8)),
      branch("next", day(7)),
      branch("refs/remotes/origin/x", day(6)),
    ]);
    renderPanel();
    await waitFor(() => expect(trigger()).toHaveTextContent("main"));
    await act(async () => {
      trigger().focus();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await user.keyboard(keys);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("picks an ordinary branch typed on the closed trigger", async () => {
    const user = userEvent.setup();
    await typeOnClosedTrigger(user, "n");
    expect(useUiStore.getState().compareBranch).toBe("next");
    expect(gitFetchRemote).not.toHaveBeenCalled();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("refuses it when typed on the closed trigger", async () => {
    const user = userEvent.setup();
    await typeOnClosedTrigger(user, "r");
    expect(useUiStore.getState().compareBranch).toBe("main");
    expect(trigger()).toHaveTextContent("main");
    expect(gitFetchRemote).not.toHaveBeenCalled();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("listbox", { name: "Branches to compare with" }),
    ).toBeNull();
  });

  it("rests on the prompt when it is the only other local branch", async () => {
    vi.mocked(gitBranches).mockResolvedValue([
      branch("feat", day(9), true),
      branch("refs/remotes/origin/x", day(8)),
    ]);
    const user = userEvent.setup();
    renderPanel();
    const list = await openPicker(user, "Pick a branch to compare against");
    expect(
      await within(list).findByRole("option", {
        name: `refs/remotes/origin/x, ${REASON}`,
      }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(trigger()).toHaveTextContent("Pick a branch to compare against");
    expect(useUiStore.getState().compareBranch).toBeNull();
    expect(gitCompareBranches).not.toHaveBeenCalled();
  });

  it("auto-picks the next branch when the most recent other one collides", async () => {
    vi.mocked(gitBranches).mockResolvedValue([
      branch("feat", day(9), true),
      branch("refs/remotes/origin/x", day(8)),
      branch("next", day(7)),
      branch("older", day(6)),
    ]);
    renderPanel();
    await waitFor(() =>
      expect(useUiStore.getState().compareBranch).toBe("next"),
    );
  });

  it("never auto-picks a colliding default branch", async () => {
    vi.mocked(gitDefaultBranch).mockResolvedValue("refs/remotes/origin/x");
    vi.mocked(gitBranches).mockResolvedValue([
      branch("feat", day(9), true),
      branch("refs/remotes/origin/x", day(8)),
      branch("next", day(7)),
    ]);
    renderPanel();
    await waitFor(() =>
      expect(useUiStore.getState().compareBranch).toBe("next"),
    );
  });

  it("corrects a stored refs/remotes/x no remote splits to a pickable branch", async () => {
    useUiStore.setState({ compareBranch: "refs/remotes/x" });
    vi.mocked(gitBranches).mockResolvedValue([
      branch("feat", day(9), true),
      branch("refs/remotes/x", day(8)),
      branch("next", day(7)),
    ]);
    renderPanel();
    await waitFor(() =>
      expect(useUiStore.getState().compareBranch).toBe("next"),
    );
  });
});

describe("Compare picker twin cue (closed trigger)", () => {
  async function pickTwin(
    user: ReturnType<typeof userEvent.setup>,
    kind: "Local" | "Remote",
    row: RegExp = /^origin\/x/,
    shown = "main",
  ) {
    const list = await openPicker(user, shown);
    await user.click(
      await within(group(list, kind)).findByRole("option", { name: row }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("listbox", { name: "Branches to compare with" }),
      ).toBeNull(),
    );
  }

  it("says remote after the Remote twin", async () => {
    const user = userEvent.setup();
    renderPanel();
    await pickTwin(user, "Remote");
    await waitFor(() =>
      expect(trigger()).toHaveTextContent(/^origin\/x\s*,\s*remote$/),
    );
  });

  it("says local after the Local twin", async () => {
    const user = userEvent.setup();
    renderPanel();
    await pickTwin(user, "Local");
    await waitFor(() =>
      expect(trigger()).toHaveTextContent(/^origin\/x\s*,\s*local$/),
    );
  });

  it("tells the two twin picks apart", async () => {
    const user = userEvent.setup();
    renderPanel();
    await pickTwin(user, "Local");
    await waitFor(() =>
      expect(useUiStore.getState().compareBranch).toBe("origin/x"),
    );
    const local = trigger().textContent;
    await pickTwin(user, "Remote", /^origin\/x/, "origin/x");
    await waitFor(() =>
      expect(useUiStore.getState().compareBranch).toBe("refs/remotes/origin/x"),
    );
    const remote = trigger().textContent;
    expect(local).not.toBe(remote);
  });

  it("keeps a pick with no twin to its bare name span", async () => {
    const user = userEvent.setup();
    renderPanel();
    await pickTwin(user, "Remote", /^origin\/y/);
    await waitFor(() =>
      expect(useUiStore.getState().compareBranch).toBe("refs/remotes/origin/y"),
    );
    expect(trigger().textContent).toBe("origin/y");
    expect(trigger().firstElementChild?.childElementCount).toBe(0);
    await pickTwin(user, "Local", /^main/, "origin/y");
    expect(trigger().textContent).toBe("main");
    expect(trigger().firstElementChild?.childElementCount).toBe(0);
  });

  it("puts the word right after the name, in one box with it", async () => {
    const user = userEvent.setup();
    renderPanel();
    await pickTwin(user, "Remote");
    const word = await within(trigger()).findByText("remote");
    const box = trigger().firstElementChild;
    expect(word.parentElement).toBe(box);
    const name = within(trigger()).getByText("origin/x");
    expect(name.parentElement).toBe(box);
    expect(
      name.compareDocumentPosition(word) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The comma is for AT only and the word never gives way to the name.
    expect(within(box as HTMLElement).getByText(",")).toHaveClass("sr-only");
    expect(word).toHaveClass("shrink-0");
    expect(word).not.toHaveClass("sr-only");
    expect(word.closest('[aria-hidden="true"]')).toBeNull();
  });

  it("drops a clipped name's tooltip when the pick changes under the pointer", async () => {
    renderPanel();
    await waitFor(() => expect(trigger()).toHaveTextContent("main"));
    const plain = trigger().firstElementChild as HTMLElement;
    Object.defineProperty(plain, "scrollWidth", { value: 200 });
    Object.defineProperty(plain, "clientWidth", { value: 100 });
    fireEvent.mouseEnter(plain);
    expect(plain).toHaveAttribute("title", "main");
    // No new mouseenter: the pointer rests while the value changes.
    act(() => useUiStore.setState({ compareBranch: "refs/remotes/origin/y" }));
    await waitFor(() => expect(trigger().textContent).toBe("origin/y"));
    expect(trigger().firstElementChild).not.toHaveAttribute("title");
  });

  it("marks a remote twin with no remote rows read", async () => {
    useUiStore.setState({ compareBranch: "refs/remotes/origin/x" });
    vi.mocked(gitRemoteBranches).mockResolvedValue([]);
    renderPanel();
    await screen.findByText("origin/x is no longer in your remote branches.", {
      selector: "p[role=status]",
    });
    expect(trigger()).toHaveTextContent(/^origin\/x\s*,\s*remote$/);
  });

  it("drops a clipped name's tooltip when the twin box replaces the span", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(trigger()).toHaveTextContent("main"));
    const plain = trigger().firstElementChild as HTMLElement;
    Object.defineProperty(plain, "scrollWidth", { value: 200 });
    Object.defineProperty(plain, "clientWidth", { value: 100 });
    fireEvent.mouseEnter(plain);
    expect(plain).toHaveAttribute("title", "main");
    await pickTwin(user, "Remote");
    await waitFor(() => expect(trigger()).toHaveTextContent(/remote$/));
    expect(trigger().firstElementChild).not.toHaveAttribute("title");
  });

  it("drops a clipped name's tooltip when one twin pick replaces another", async () => {
    vi.mocked(gitBranches).mockResolvedValue([
      branch("feat", day(9), true),
      branch("main", day(8)),
      branch("origin/x", day(7)),
      branch("origin/y", day(6)),
    ]);
    useUiStore.setState({ compareBranch: "refs/remotes/origin/x" });
    renderPanel();
    await waitFor(() =>
      expect(trigger()).toHaveTextContent(/^origin\/x\s*,\s*remote$/),
    );
    const name = within(trigger()).getByText("origin/x");
    Object.defineProperty(name, "scrollWidth", { value: 200 });
    Object.defineProperty(name, "clientWidth", { value: 100 });
    fireEvent.mouseEnter(name);
    expect(name).toHaveAttribute("title", "origin/x");
    // No new mouseenter: the pointer rests while the value changes.
    act(() => useUiStore.setState({ compareBranch: "refs/remotes/origin/y" }));
    await waitFor(() =>
      expect(trigger()).toHaveTextContent(/^origin\/y\s*,\s*remote$/),
    );
    expect(within(trigger()).getByText("origin/y")).not.toHaveAttribute(
      "title",
    );
  });

  it("never turns the remote read on for a stored local twin", async () => {
    // The gate's no-local-branch arm holds while the branch list loads, so a
    // cold mount reads once; after that only an enabled read is refetched.
    useUiStore.setState({ compareBranch: "origin/x" });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client}>
        <ComparePanel repoPath={REPO} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(trigger()).toHaveTextContent("origin/x"));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    const reads = vi.mocked(gitRemoteBranches).mock.calls.length;
    await act(() =>
      client.invalidateQueries({ queryKey: ["repo", REPO, "remote-branches"] }),
    );
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(vi.mocked(gitRemoteBranches).mock.calls.length).toBe(reads);
    await openPicker(user, "origin/x");
    await waitFor(() =>
      expect(vi.mocked(gitRemoteBranches).mock.calls.length).toBe(reads + 1),
    );
    await waitFor(() =>
      expect(trigger()).toHaveTextContent(/^origin\/x\s*,\s*local$/),
    );
  });

  it("marks a remote pick named like the current branch", async () => {
    vi.mocked(gitStatus).mockResolvedValue(statusOf("origin/x"));
    vi.mocked(gitBranches).mockResolvedValue([
      branch("origin/x", day(9), true),
      branch("main", day(8)),
    ]);
    const user = userEvent.setup();
    renderPanel();
    await pickTwin(user, "Remote");
    await waitFor(() =>
      expect(trigger()).toHaveTextContent(/^origin\/x\s*,\s*remote$/),
    );
  });

  it("drops the local word once the remote twin leaves the list", async () => {
    useUiStore.setState({ compareBranch: "origin/x" });
    const user = userEvent.setup();
    renderPanel();
    await openPicker(user, "origin/x");
    await waitFor(() =>
      expect(trigger()).toHaveTextContent(/^origin\/x\s*,\s*local$/),
    );
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("listbox", { name: "Branches to compare with" }),
      ).toBeNull(),
    );
    vi.mocked(gitRemoteBranches).mockResolvedValue([
      remote("origin", "y", day(3)),
    ]);
    await user.click(trigger());
    await waitFor(() => expect(trigger().textContent).toBe("origin/x"));
  });
});
