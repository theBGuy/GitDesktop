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
import { toast } from "sonner";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { BranchSwitcher } from "@/features/repository/BranchSwitcher";
import {
  forgePrsOnRemoteBranch,
  forgeStatus,
  getSecret,
  gitBranchDivergence,
  gitBranches,
  gitBranchTips,
  gitDefaultBranch,
  gitKeepLocalHookStatus,
  gitRemoteBranches,
  gitRemoteRenameCheck,
  gitRemotes,
  gitStashCount,
  gitStatus,
  readRepoBranchRules,
} from "@/lib/git/api";
import {
  BRANCH_PUSH_ELSEWHERE_MESSAGE,
  branchPushHoldReason,
  type DeleteRemoteBranchArgs,
  remoteBranchesOptions,
  usePush,
  useRenameBranchOnRemote,
} from "@/lib/git/queries";
import { repoIdentityQueryOptions } from "@/lib/git/repo-identity-query";
import type {
  Branch,
  BranchHead,
  RemoteBranch,
  RemoteBranchPulls,
  RemoteRenameCheck,
  RemoteRenameOutcome,
} from "@/lib/git/types";
import { listUserWorktrees } from "@/lib/git/worktree";
import { dispatchAction } from "@/lib/hotkeys/hotkeys";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

// The remote rename callee is reached only through its spy: publish-hold-routes
// lets no file but its one hook import it by name.
const renameRemoteSpy = vi.hoisted(() => vi.fn());
const pushSpy = vi.hoisted(() => vi.fn());
const deleteRemoteSpy = vi.hoisted(() => vi.fn());
const localRenameSpy = vi.hoisted(() => vi.fn());
const createSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  // Reads the mounted switcher makes.
  gitStatus: vi.fn(),
  gitBranches: vi.fn(),
  gitBranchDivergence: vi.fn(),
  gitRemotes: vi.fn(),
  gitRemoteBranches: vi.fn(),
  gitDefaultBranch: vi.fn(),
  gitStashCount: vi.fn(),
  readRepoBranchRules: vi.fn(),
  forgeStatus: vi.fn(),
  getSecret: vi.fn(),
  gitKeepLocalHookStatus: vi.fn(),
  gitBranchTips: vi.fn(),
  // The rename dialog's remote-step reads.
  gitRemoteRenameCheck: vi.fn(),
  forgePrsOnRemoteBranch: vi.fn(),
  // The remote rename, held open until a test lands it.
  gitRenameBranchRemote: renameRemoteSpy,
  // Another worktree's push, held open.
  gitPush: pushSpy,
  // The Remote group's Delete, and a local-only rename.
  gitDeleteRemoteBranch: deleteRemoteSpy,
  gitRenameBranch: localRenameSpy,
  // The New branch dialog's create.
  gitCreateBranch: createSpy,
}));
vi.mock("@/lib/git/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/worktree")>()),
  listUserWorktrees: vi.fn(),
}));

// A type query, not a named import: publish-hold-routes fails any named
// import of a push callee outside the api package.
type DeleteRemoteParams = Parameters<
  typeof import("@/lib/git/api")["gitDeleteRemoteBranch"]
>;

const REPO = "C:/repos/ren-row";
// Another checkout of the same repository: both resolve to one identity.
const SIBLING = "C:/repos/ren-row-wt";
const IDENTITY = `${REPO}/.git`;
vi.mock("@/lib/git/repo-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/repo-identity")>()),
  peekRepoIdentity: () => IDENTITY,
  repoIdentityStrict: () => Promise.resolve(IDENTITY),
}));

const TIP = "a".repeat(40);

// jsdom lays nothing out: the virtualized branch list needs a viewport, and
// row arrow-nav scrolls the focused row into view.
Element.prototype.scrollIntoView ??= () => undefined;
const CLIENT_SIZE = { clientWidth: 800, clientHeight: 600 } as const;
beforeAll(() => {
  for (const [k, v] of Object.entries(CLIENT_SIZE)) {
    Object.defineProperty(HTMLElement.prototype, k, {
      configurable: true,
      get: () => v,
    });
  }
});
afterAll(() => {
  for (const k of Object.keys(CLIENT_SIZE)) {
    Reflect.deleteProperty(HTMLElement.prototype, k);
  }
  expect(unmockedCommands).toEqual([]);
});

// ---- Fixtures.

function branchRow(overrides: Partial<Branch> & { name: string }): Branch {
  return {
    isCurrent: false,
    upstream: null,
    lastCommitDate: "2026-11-01T10:00:00Z",
    archived: false,
    upstreamAhead: 0,
    upstreamBehind: 0,
    upstreamGone: false,
    upstreamRemote: null,
    upstreamRemoteRef: null,
    keepLocal: false,
    upstreamIsRemoteDefault: false,
    ...overrides,
  };
}

/** A row tracking `origin/<branch>` (its own name by default), one ahead. */
const trackedRow = (
  name: string,
  overrides: Partial<Branch> = {},
  branch = name,
) =>
  branchRow({
    name,
    upstream: `origin/${branch}`,
    upstreamRemote: "origin",
    upstreamRemoteRef: `refs/heads/${branch}`,
    upstreamAhead: 1,
    ...overrides,
  });

function headOn(name: string): BranchHead {
  return {
    name,
    detached: false,
    oid: "abcdef0123456789abcdef0123456789abcdef01",
    upstream: `origin/${name}`,
    ahead: 0,
    behind: 0,
    upstreamGone: false,
    upstreamRemote: "origin",
    upstreamBranch: name,
    pushNameMismatch: false,
    upstreamIsRemoteDefault: null,
    pushRemote: "origin",
    pushBranch: name,
  };
}

const remoteBranch = (name: string): RemoteBranch => ({
  name,
  remote: "origin",
  lastCommitDate: "2026-11-01T10:00:00Z",
});

const clearCheck: RemoteRenameCheck = { status: "clear", oldTip: TIP };
const noPulls: RemoteBranchPulls = {
  status: "checked",
  provider: "github",
  items: [],
  unchecked: [],
};

let reads: {
  head: BranchHead;
  branches: Branch[];
  remoteBranches: RemoteBranch[];
};
let info: ReturnType<typeof vi.spyOn>;
let landRename: ((outcome: RemoteRenameOutcome) => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
  // HEAD on feat; main is the default; old is the branch being renamed.
  reads = {
    head: headOn("feat"),
    branches: [
      trackedRow("main", { upstreamAhead: 0 }),
      trackedRow("feat", { isCurrent: true, upstreamAhead: 0 }),
      trackedRow("old"),
    ],
    remoteBranches: [remoteBranch("main"), remoteBranch("old")],
  };
  vi.mocked(gitStatus).mockImplementation(async () => ({
    branch: reads.head,
    entries: [],
  }));
  vi.mocked(gitBranches).mockImplementation(async () => reads.branches);
  vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
  vi.mocked(gitRemoteBranches).mockImplementation(
    async () => reads.remoteBranches,
  );
  vi.mocked(gitDefaultBranch).mockResolvedValue("main");
  vi.mocked(gitBranchDivergence).mockResolvedValue([]);
  vi.mocked(gitStashCount).mockResolvedValue(0);
  vi.mocked(readRepoBranchRules).mockResolvedValue(null);
  vi.mocked(getSecret).mockResolvedValue(null);
  // The forge read stays pending: no PR chips, no forge-gated items.
  vi.mocked(forgeStatus).mockImplementation(() => new Promise(() => undefined));
  vi.mocked(listUserWorktrees).mockResolvedValue([]);
  vi.mocked(gitKeepLocalHookStatus).mockResolvedValue({
    state: "absent",
    blocked: null,
    manager: null,
    managedHookPresent: false,
    hooksDirRedirected: false,
    hooksPath: "C:/repos/ren-row/.git/hooks",
    snippet: "exit 1",
  });
  vi.mocked(gitBranchTips).mockImplementation(async (_repo, names) =>
    Object.fromEntries(names.map((n) => [n, TIP])),
  );
  vi.mocked(gitRemoteRenameCheck).mockResolvedValue(clearCheck);
  vi.mocked(forgePrsOnRemoteBranch).mockResolvedValue(noPulls);
  landRename = null;
  renameRemoteSpy.mockImplementation(
    () =>
      new Promise<RemoteRenameOutcome>((resolve) => {
        landRename = resolve;
      }),
  );
  pushSpy.mockImplementation(() => new Promise(() => undefined));
  deleteRemoteSpy.mockResolvedValue(undefined);
  localRenameSpy.mockResolvedValue(undefined);
  info = vi.spyOn(toast, "info");
  useUiStore.setState({ repoPath: REPO });
});
afterEach(() => {
  info.mockRestore();
});

// ---- A remote rename in flight, started through its hook; its backend call
// stays open until the test lands it.

function RenameHarness(props: { path: string; oldName: string }) {
  const rename = useRenameBranchOnRemote(props.path);
  return (
    <button
      type="button"
      onClick={() =>
        void rename
          .mutateAsync({
            oldName: props.oldName,
            newName: "new",
            remote: "origin",
            expectedOldTip: TIP,
          })
          .catch(() => undefined)
      }
    >
      start rename in {props.path}
    </button>
  );
}

function PushHarness(props: { branch: string }) {
  const push = usePush(SIBLING);
  return (
    <button
      type="button"
      // The spy never settles, so nothing rejects.
      onClick={() =>
        void push.mutateAsync({ setUpstream: false, branch: props.branch })
      }
    >
      start push in {SIBLING}
    </button>
  );
}

/** Starts another worktree's push of `branch` in the switcher's client. */
async function startSiblingPush(queryClient: QueryClient, branch: string) {
  render(
    <QueryClientProvider client={queryClient}>
      <PushHarness branch={branch} />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(
      queryClient.getQueryData(repoIdentityQueryOptions(SIBLING).queryKey),
    ).toBeDefined(),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: `start push in ${SIBLING}`,
      hidden: true,
    }),
  );
  await waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(1));
}

function renderSwitcher(opts: { from?: string; oldName?: string } = {}) {
  const from = opts.from ?? REPO;
  const user = userEvent.setup();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = (path: string) => (
    <QueryClientProvider client={queryClient}>
      <BranchSwitcher repoPath={path} />
      <RenameHarness path={from} oldName={opts.oldName ?? "old"} />
    </QueryClientProvider>
  );
  const view = render(tree(REPO));
  /** Switches the open repository under the mounted switcher. */
  const switchRepo = (path: string) =>
    act(async () => {
      useUiStore.setState({ repoPath: path });
      view.rerender(tree(path));
      await new Promise((r) => setTimeout(r, 20));
    });
  /** Starts the rename. Not user-event: an open list or prompt hides the page
   *  behind it. */
  const startRename = async () => {
    for (const path of new Set([REPO, from]))
      await waitFor(() =>
        expect(
          queryClient.getQueryData(repoIdentityQueryOptions(path).queryKey),
        ).toBeDefined(),
      );
    fireEvent.click(
      screen.getByRole("button", {
        name: `start rename in ${from}`,
        hidden: true,
      }),
    );
    await waitFor(() => expect(landRename).not.toBeNull());
  };
  const settleRename = () =>
    act(async () => {
      landRename?.({ status: "renamed", warning: null });
      landRename = null;
      await new Promise((r) => setTimeout(r, 20));
    });
  /** The local rename landed: the list re-reads with `new` tracking
   *  `origin/old`. */
  const relist = () =>
    act(async () => {
      reads.branches = [
        trackedRow("main", { upstreamAhead: 0 }),
        trackedRow("feat", { isCurrent: true, upstreamAhead: 0 }),
        trackedRow("new", {}, "old"),
      ];
      // Not awaited: the forge read never settles.
      void queryClient.invalidateQueries({ queryKey: ["repo", REPO] });
      await new Promise((r) => setTimeout(r, 20));
    });
  return { user, queryClient, startRename, settleRename, relist, switchRepo };
}

type User = ReturnType<typeof userEvent.setup>;

async function openList(user: User) {
  await user.click(await screen.findByRole("button", { name: /^feat/ }));
  await screen.findByPlaceholderText("Filter branches");
}

const rowButton = (name: string) =>
  waitFor(() => {
    const row = document.querySelector<HTMLElement>(`[data-row="${name}"]`);
    if (!row) throw new Error(`no row ${name}`);
    return row;
  });

async function openRowMenu(user: User, name: string) {
  await user.pointer({ keys: "[MouseRight]", target: await rowButton(name) });
  return screen.findByRole("menu");
}

/** The row's spinner, by its label; null when the row paints none. */
const spinner = (row: string, label: string) =>
  document.querySelector(`[data-row="${row}"] [aria-label="${label}"]`);
const anySpinner = (row: string) =>
  document.querySelector(`[data-row="${row}"] .animate-spin`);

const menuItem = (menu: HTMLElement, name: string | RegExp) =>
  within(menu).getByRole("menuitem", { name });

const held = (el: HTMLElement) =>
  expect(el).toHaveAttribute("aria-disabled", "true");
const live = (el: HTMLElement) => {
  expect(el).not.toHaveAttribute("aria-disabled", "true");
  expect(el).not.toBeDisabled();
};

const footerRow = (name: string) => screen.getByRole("button", { name });

const RUNNING_LINE = "Renaming old to new on origin…";
/** The rename's entries filed under the branch-push family's prefix. */
const pendingFamily = (queryClient: QueryClient) =>
  queryClient
    .getMutationCache()
    .findAll({ mutationKey: ["branch-push", REPO], status: "pending" }).length;

describe("a remote rename on the branch rows", () => {
  it("before the local rename lands: labels the old row, holds its push and delete, and leaves Rename open", async () => {
    const { user, queryClient, startRename } = renderSwitcher();
    await startRename();
    await openList(user);
    expect(pendingFamily(queryClient)).toBe(1);
    await waitFor(() =>
      expect(spinner("old", "Renaming on origin")).not.toBeNull(),
    );
    const menu = await openRowMenu(user, "old");
    held(menuItem(menu, "Push to origin/old (pushing…)"));
    held(menuItem(menu, "Delete branch… (pushing…)"));
    const rename = menuItem(menu, "Rename branch…");
    live(rename);
    await user.click(rename);
    expect(await screen.findByLabelText("New name")).toBeInTheDocument();
    expect(await screen.findByText(RUNNING_LINE)).toBeInTheDocument();
  });

  it("after the local rename lands: labels the new row, holds its publish, delete and the old remote row's delete, then frees them", async () => {
    const { user, startRename, relist, settleRename } = renderSwitcher();
    await startRename();
    await openList(user);
    await relist();
    await waitFor(() =>
      expect(spinner("new", "Renaming on origin")).not.toBeNull(),
    );
    let menu = await openRowMenu(user, "new");
    held(menuItem(menu, /^Publish as origin\/new.* \(pushing…\)$/));
    held(menuItem(menu, "Delete branch… (pushing…)"));
    live(menuItem(menu, "Rename branch…"));
    await user.keyboard("{Escape}");
    menu = await openRowMenu(user, "old");
    held(menuItem(menu, "Delete on origin… (a push is running)"));
    await user.keyboard("{Escape}");

    await settleRename();
    await waitFor(() => expect(anySpinner("new")).toBeNull());
    menu = await openRowMenu(user, "new");
    await waitFor(() => {
      live(menuItem(menu, /^Publish as origin\/new[^(]*$/));
      live(menuItem(menu, "Delete branch…"));
      live(menuItem(menu, "Rename branch…"));
    });
    await user.keyboard("{Escape}");
    menu = await openRowMenu(user, "old");
    live(menuItem(menu, "Delete on origin…"));
  });

  it("on the current branch: the footer row and the hotkey still open Rename, while its delete holds", async () => {
    const { user, startRename } = renderSwitcher({ oldName: "feat" });
    await startRename();
    await openList(user);
    await waitFor(() =>
      expect(spinner("feat", "Renaming on origin")).not.toBeNull(),
    );
    await waitFor(() => {
      expect(footerRow("Delete current branch…")).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      expect(footerRow("Delete current branch…")).toHaveAccessibleDescription(
        branchPushHoldReason(false),
      );
    });
    live(footerRow("Rename current branch…"));
    await user.click(footerRow("Rename current branch…"));
    expect(await screen.findByLabelText("New name")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByLabelText("New name")).toBeNull());
    act(() => {
      dispatchAction("rename-branch");
    });
    expect(await screen.findByLabelText("New name")).toBeInTheDocument();
    expect(info).not.toHaveBeenCalled();
  });

  it("from another worktree: paints the row as foreign and holds its Rename", async () => {
    const { user, startRename } = renderSwitcher({ from: SIBLING });
    await startRename();
    await openList(user);
    await waitFor(() =>
      expect(spinner("old", "Pushing from another worktree")).not.toBeNull(),
    );
    const menu = await openRowMenu(user, "old");
    held(menuItem(menu, "Rename branch… (another worktree is pushing)"));
  });

  it("its own rename plus another worktree's push: the row's Rename names the other worktree", async () => {
    const { user, queryClient, startRename } = renderSwitcher();
    await startRename();
    await startSiblingPush(queryClient, "old");
    await openList(user);
    await waitFor(() =>
      expect(spinner("old", "Renaming on origin")).not.toBeNull(),
    );
    const menu = await openRowMenu(user, "old");
    held(menuItem(menu, "Rename branch… (another worktree is pushing)"));
  });
});

describe("the rename offer's push routing", () => {
  it.each([
    ["to another remote", { namedPushRemote: "fork", namedPushBranch: "old" }],
    ["to its upstream", { namedPushRemote: "origin", namedPushBranch: "old" }],
    ["unknown", {}],
  ] as const)(
    "a row whose push goes %s",
    async (kind, routing: Partial<Branch>) => {
      vi.mocked(gitRemotes).mockResolvedValue(["origin", "fork"]);
      reads.branches = [
        trackedRow("main", { upstreamAhead: 0 }),
        trackedRow("feat", { isCurrent: true, upstreamAhead: 0 }),
        trackedRow("old", routing),
      ];
      const { user } = renderSwitcher();
      await openList(user);
      const menu = await openRowMenu(user, "old");
      await user.click(menuItem(menu, "Rename branch…"));
      const box = await screen.findByRole("checkbox", {
        name: "Also rename on origin",
      });
      if (kind === "to another remote") {
        expect(box).toHaveAttribute("aria-disabled", "true");
        expect(box).toHaveAccessibleDescription(
          "old pushes to fork, not origin",
        );
      } else {
        expect(box).not.toHaveAttribute("aria-disabled", "true");
        expect(box).not.toHaveAccessibleDescription(/pushes to/);
      }
    },
  );
});

describe("another worktree holding the current branch", () => {
  it.each(["rename", "push"] as const)(
    "a sibling's %s: the hotkey and the footer row say another worktree holds it",
    async (kind) => {
      const { user, queryClient, startRename } = renderSwitcher({
        from: SIBLING,
        oldName: "feat",
      });
      if (kind === "rename") await startRename();
      else await startSiblingPush(queryClient, "feat");
      act(() => {
        dispatchAction("rename-branch");
      });
      expect(info).toHaveBeenCalledWith(BRANCH_PUSH_ELSEWHERE_MESSAGE);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(screen.queryByLabelText("New name")).toBeNull();
      await openList(user);
      await waitFor(() =>
        expect(spinner("feat", "Pushing from another worktree")).not.toBeNull(),
      );
      await waitFor(() => {
        held(footerRow("Rename current branch…"));
        expect(footerRow("Rename current branch…")).toHaveAccessibleDescription(
          BRANCH_PUSH_ELSEWHERE_MESSAGE,
        );
      });
    },
  );
});

// Another repository whose list reads the same rows, so it has a same-named
// branch for a carried-over dialog to rename.
const OTHER = "C:/repos/ren-other";

describe("a repository switch under an open Rename dialog", () => {
  async function openRename(user: User) {
    await openList(user);
    const menu = await openRowMenu(user, "old");
    await user.click(menuItem(menu, "Rename branch…"));
    const field = await screen.findByLabelText("New name");
    await user.clear(field);
    await user.type(field, "new");
    return field;
  }

  it("closes the dialog, so its name renames nothing in the new repository", async () => {
    const { user, switchRepo } = renderSwitcher();
    await openRename(user);
    await switchRepo(OTHER);
    await waitFor(() => expect(screen.queryByLabelText("New name")).toBeNull());
    expect(localRenameSpy).not.toHaveBeenCalled();
    expect(renameRemoteSpy).not.toHaveBeenCalled();
  });

  it("with a remote rename running for the old repository: closes, and the rename's settle still toasts", async () => {
    const success = vi.spyOn(toast, "success");
    const { user, switchRepo } = renderSwitcher();
    await openRename(user);
    await user.click(
      screen.getByRole("checkbox", { name: "Also rename on origin" }),
    );
    await screen.findByText(
      /^Pushes new to origin, then deletes origin\//,
      undefined,
      { timeout: 2000 },
    );
    await user.click(screen.getByRole("button", { name: /Rename$/ }));
    await waitFor(() => expect(landRename).not.toBeNull());
    await switchRepo(OTHER);
    await waitFor(() => expect(screen.queryByLabelText("New name")).toBeNull());
    await act(async () => {
      landRename?.({ status: "renamed", warning: null });
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(success).toHaveBeenCalledWith(
      "Renamed to new in ren-row and on origin",
      expect.anything(),
    );
    expect(renameRemoteSpy).toHaveBeenCalledTimes(1);
    expect(localRenameSpy).not.toHaveBeenCalled();
    success.mockRestore();
  });

  it("closes an open New branch dialog too, which reopens empty in the new repository and creates nothing", async () => {
    const { user, switchRepo } = renderSwitcher();
    await openList(user);
    await user.click(await screen.findByText("New branch…"));
    const field = await screen.findByLabelText("Branch name");
    await user.clear(field);
    await user.type(field, "fresh");
    await switchRepo(OTHER);
    await waitFor(() =>
      expect(screen.queryByLabelText("Branch name")).toBeNull(),
    );
    await openList(user);
    await user.click(await screen.findByText("New branch…"));
    expect(await screen.findByLabelText("Branch name")).toHaveValue("");
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe("the Remote group's Delete", () => {
  const MOVED = "b".repeat(40);
  const remoteOnly = (tip?: string): RemoteBranch => ({
    ...remoteBranch("gone"),
    ...(tip === undefined ? {} : { tip }),
  });

  /** Opens the confirm on the remote-only row; returns its Delete button. */
  async function openDelete(user: User) {
    await openList(user);
    const menu = await openRowMenu(user, "gone");
    await user.click(menuItem(menu, "Delete on origin…"));
    return screen.findByRole("button", { name: "Delete" });
  }

  it("leases on the tip the confirm opened on, even after the row's tip moves", async () => {
    reads.remoteBranches = [remoteBranch("main"), remoteOnly(TIP)];
    const { user, queryClient } = renderSwitcher();
    const confirm = await openDelete(user);
    // Every live source now answers the moved tip: the list read, the tips
    // read and the rendered list's own cache entry.
    reads.remoteBranches = [remoteBranch("main"), remoteOnly(MOVED)];
    vi.mocked(gitBranchTips).mockImplementation(async (_repo, names) =>
      Object.fromEntries(names.map((n) => [n, MOVED])),
    );
    const listKey = remoteBranchesOptions(REPO).queryKey;
    act(() => {
      queryClient.setQueryData<RemoteBranch[]>(listKey, (rows) =>
        rows?.map((b) => (b.name === "gone" ? { ...b, tip: MOVED } : b)),
      );
    });
    expect(
      queryClient
        .getQueryData<RemoteBranch[]>(listKey)
        ?.find((b) => b.remote === "origin" && b.name === "gone")?.tip,
    ).toBe(MOVED);
    await user.click(confirm);
    await waitFor(() => expect(deleteRemoteSpy).toHaveBeenCalledTimes(1));
    expect(deleteRemoteSpy).toHaveBeenCalledWith(REPO, "origin", "gone", TIP);
  });

  for (const [what, tip] of [
    ["no known tip", undefined],
    ["an empty tip", ""],
  ] as const) {
    it(`a row with ${what} sends that tip as is, and the refusal reaches the error toast`, async () => {
      // The backend's refusal sentence, as fixture data.
      const refusal =
        "Couldn't read which commit origin/gone is at, so it wasn't deleted. Fetch, then try again.";
      deleteRemoteSpy.mockRejectedValue({ kind: "command", message: refusal });
      const error = vi.spyOn(toast, "error");
      const success = vi.spyOn(toast, "success");
      reads.remoteBranches = [remoteBranch("main"), remoteOnly(tip)];
      const { user } = renderSwitcher();
      await user.click(await openDelete(user));
      await waitFor(() => expect(error).toHaveBeenCalledTimes(1));
      expect(deleteRemoteSpy).toHaveBeenCalledTimes(1);
      expect(deleteRemoteSpy).toHaveBeenCalledWith(REPO, "origin", "gone", tip);
      expect(String(error.mock.calls[0][0])).toContain(refusal);
      expect(success).not.toHaveBeenCalled();
      error.mockRestore();
      success.mockRestore();
    });
  }

  it("a refused lease's sentence reaches the error toast, and nothing reads as deleted", async () => {
    // The backend's refusal sentence, as fixture data.
    const refusal =
      "origin/gone isn't at the commit this delete was confirmed for, so it wasn't deleted. Fetch, then check it before you delete it.";
    deleteRemoteSpy.mockRejectedValue({ kind: "command", message: refusal });
    const error = vi.spyOn(toast, "error");
    const success = vi.spyOn(toast, "success");
    reads.remoteBranches = [remoteBranch("main"), remoteOnly(TIP)];
    const { user } = renderSwitcher();
    await user.click(await openDelete(user));
    await waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(String(error.mock.calls[0][0])).toContain(refusal);
    expect(success).not.toHaveBeenCalled();
    expect(deleteRemoteSpy).toHaveBeenCalledWith(REPO, "origin", "gone", TIP);
    error.mockRestore();
    success.mockRestore();
  });

  it("types the remote delete's tip as a required key", () => {
    // @ts-expect-error the api call can't leave the lease's tip out
    const apiOmits: DeleteRemoteParams = [REPO, "origin", "gone"];
    const apiUndefined: DeleteRemoteParams = [
      REPO,
      "origin",
      "gone",
      undefined,
    ];
    // @ts-expect-error the hook's args can't leave the lease's tip out
    const hookOmits: DeleteRemoteBranchArgs = {
      remote: "origin",
      name: "gone",
    };
    const hookUndefined: DeleteRemoteBranchArgs = {
      remote: "origin",
      name: "gone",
      expectedTip: undefined,
    };
    expect([
      apiOmits.length,
      apiUndefined.length,
      hookOmits.name,
      hookUndefined.expectedTip,
    ]).toEqual([3, 4, "gone", undefined]);
  });
});
