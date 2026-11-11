import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
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
  forgeStatus,
  getSecret,
  gitBranchDivergence,
  gitBranches,
  gitCheckoutBranch,
  gitDefaultBranch,
  gitDeleteBranch,
  gitKeepLocalHookInstall,
  gitKeepLocalHookStatus,
  gitRemoteBranches,
  gitRemotes,
  gitSetBranchKeepLocal,
  gitStashCount,
  gitStatus,
  readRepoBranchRules,
} from "@/lib/git/api";
import { usePush } from "@/lib/git/queries";
import { repoIdentityQueryOptions } from "@/lib/git/repo-identity-query";
import type { Branch, BranchHead, KeepLocalHookStatus } from "@/lib/git/types";
import { listUserWorktrees } from "@/lib/git/worktree";
import { dispatchAction } from "@/lib/hotkeys/hotkeys";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

// ---- Mocks, grouped by seam. A later step adds its commands to the group it
// belongs to (the hook-status reads and writes join the git api group).

// The push callee is reached only through its spy: publish-hold-routes lets no
// file but its one hook import it by name.
const pushSpy = vi.hoisted(() => vi.fn());
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
  // Writes.
  gitSetBranchKeepLocal: vi.fn(),
  gitKeepLocalHookInstall: vi.fn(),
  gitKeepLocalHookRemove: vi.fn(),
  gitCheckoutBranch: vi.fn(),
  gitDeleteBranch: vi.fn(),
  gitPush: pushSpy,
}));
vi.mock("@/lib/git/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/worktree")>()),
  listUserWorktrees: vi.fn(),
}));
// One table answers both identity reads, so they can never disagree: SIBLING
// is another worktree of REPO's repository, every other path its own.
const identityOf = (path: string) =>
  path === "C:/repos/keep-wt" ? "C:/repos/keep/.git" : `${path}/.git`;
vi.mock("@/lib/git/repo-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/repo-identity")>()),
  peekRepoIdentity: (path: string) => identityOf(path),
  repoIdentityStrict: (path: string) => Promise.resolve(identityOf(path)),
}));

const REPO = "C:/repos/keep";
const SIBLING = "C:/repos/keep-wt";
const OTHER_REPO = "C:/repos/other";
const CHIP_LABEL = "Kept local. GitDesktop won't push or publish this branch.";
const ON_DESCRIPTION =
  "GitDesktop and its MCP server won't push or publish it.";
const ON_DESCRIPTION_NO_AI = "GitDesktop won't push or publish it.";

// jsdom lays nothing out, so the virtualized branch list (@tanstack/virtual-core
// sizes its viewport from the scroll element's clientWidth/clientHeight) paints
// no row, pinned rows included; a fixed client size gives it a viewport.
// Row arrow-nav scrolls the focused row into view, and jsdom implements none.
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

/** A branch-list row: local, untracked, unmarked unless overridden. */
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

/** A row tracking its same-named branch on origin. */
const trackedRow = (name: string, overrides: Partial<Branch> = {}) =>
  branchRow({
    name,
    upstream: `origin/${name}`,
    upstreamRemote: "origin",
    upstreamRemoteRef: `refs/heads/${name}`,
    ...overrides,
  });

/** HEAD on `name`, tracking its same-named origin branch; null = detached. */
function headOn(name: string | null): BranchHead {
  return {
    name,
    detached: name === null,
    oid: "abcdef0123456789abcdef0123456789abcdef01",
    upstream: name === null ? null : `origin/${name}`,
    ahead: 0,
    behind: 0,
    upstreamGone: false,
    upstreamRemote: name === null ? null : "origin",
    upstreamBranch: name,
    pushNameMismatch: false,
    upstreamIsRemoteDefault: null,
    pushRemote: name === null ? null : "origin",
    pushBranch: name,
  };
}

/** The terminal push guard's status, as the hook commands answer it. */
function hookStatus(
  state: KeepLocalHookStatus["state"],
  blocked: KeepLocalHookStatus["blocked"] = null,
): KeepLocalHookStatus {
  return {
    state,
    blocked,
    manager: null,
    managedHookPresent: state === "installed",
    hooksDirRedirected: false,
    hooksPath: "C:/repos/keep/.git/hooks",
    snippet: "exit 1",
  };
}

/** What the mocked backend answers; each test edits it before rendering. */
interface RepoReads {
  head: BranchHead;
  branches: Branch[];
  remotes: string[];
  hook: KeepLocalHookStatus;
}
let reads: RepoReads;

function answerReads() {
  vi.mocked(gitStatus).mockImplementation(async () => ({
    branch: reads.head,
    entries: [],
  }));
  vi.mocked(gitBranches).mockImplementation(async () => reads.branches);
  vi.mocked(gitRemotes).mockImplementation(async () => reads.remotes);
  vi.mocked(gitRemoteBranches).mockResolvedValue([]);
  vi.mocked(gitDefaultBranch).mockResolvedValue("main");
  vi.mocked(gitBranchDivergence).mockResolvedValue([]);
  vi.mocked(gitStashCount).mockResolvedValue(0);
  vi.mocked(readRepoBranchRules).mockResolvedValue(null);
  vi.mocked(getSecret).mockResolvedValue(null);
  // The forge read stays pending: no PR chips, no forge-gated items.
  vi.mocked(forgeStatus).mockImplementation(() => new Promise(() => undefined));
  vi.mocked(listUserWorktrees).mockResolvedValue([]);
  vi.mocked(gitSetBranchKeepLocal).mockResolvedValue(undefined);
  vi.mocked(gitKeepLocalHookStatus).mockImplementation(async () => reads.hook);
  // A push never settles: a row that starts one stays pushing.
  pushSpy.mockImplementation(() => new Promise(() => undefined));
}

let success: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
  reads = {
    head: headOn("main"),
    branches: [trackedRow("main", { isCurrent: true })],
    remotes: ["origin"],
    hook: hookStatus("absent"),
  };
  answerReads();
  success = vi.spyOn(toast, "success");
  info = vi.spyOn(toast, "info");
  error = vi.spyOn(toast, "error");
  useUiStore.setState({ repoPath: REPO });
});
afterEach(() => {
  onlineManager.setOnline(true);
  success.mockRestore();
  info.mockRestore();
  error.mockRestore();
});

// ---- Render helper and the gestures later steps reuse.

/** Mounts the switcher on REPO under a fresh client; the list stays closed. */
function renderSwitcher() {
  const user = userEvent.setup();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = (repo: string) => (
    <QueryClientProvider client={queryClient}>
      <BranchSwitcher repoPath={repo} />
    </QueryClientProvider>
  );
  const { rerender } = render(view(REPO));
  /** Switches the open repository: the store and the prop together. */
  const switchTo = (repo: string) =>
    act(() => {
      useUiStore.setState({ repoPath: repo });
      rerender(view(repo));
    });
  return { user, queryClient, switchTo };
}

type User = ReturnType<typeof userEvent.setup>;

/** Opens the branch list from its trigger, which reads HEAD's name. */
async function openList(user: User, headLabel = "main") {
  await user.click(
    await screen.findByRole("button", { name: new RegExp(`^${headLabel}`) }),
  );
  await screen.findByPlaceholderText("Filter branches");
}

/** The list row for `name`: the button the switcher stamps `data-row` on. */
const rowButton = (name: string) =>
  waitFor(() => {
    const row = document.querySelector<HTMLElement>(`[data-row="${name}"]`);
    if (!row) throw new Error(`no row ${name}`);
    return row;
  });

/** Opens the row's context menu with a right-click. */
async function openRowMenu(user: User, name: string) {
  await user.pointer({ keys: "[MouseRight]", target: await rowButton(name) });
  return screen.findByRole("menu");
}

const menuItem = (name: string | RegExp) =>
  screen.getByRole("menuitem", { name });
const keepLocalItem = () =>
  screen.getByRole("menuitemcheckbox", { name: /^Keep local/ });

// react-query notifies observers on a later timer; flush it so a negative
// assertion reads the settled render.
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });

// ---- Rows.

describe("the kept-local row", () => {
  it("carries the chip inside the row's accessible name", async () => {
    reads.branches.push(branchRow({ name: "spike/x", keepLocal: true }));
    const { user } = renderSwitcher();
    await openList(user);
    expect(await rowButton("spike/x")).toHaveAccessibleName(
      expect.stringContaining(CHIP_LABEL),
    );
    expect(await rowButton("main")).not.toHaveAccessibleName(
      expect.stringContaining(CHIP_LABEL),
    );
  });

  it("drops the never-published marker and rewords the gone one", async () => {
    reads.branches.push(
      branchRow({ name: "spike/x", keepLocal: true }),
      branchRow({ name: "draft/y" }),
      trackedRow("old/z", { keepLocal: true, upstreamGone: true }),
    );
    const { user } = renderSwitcher();
    await openList(user);
    const kept = await rowButton("spike/x");
    expect(within(kept).queryByRole("img", { name: /never published/ })).toBe(
      null,
    );
    // The unmarked twin still shows it, so the check above is not vacuous.
    expect(
      within(await rowButton("draft/y")).getByRole("img", {
        name: /never published/,
      }),
    ).toBeInTheDocument();
    const gone = within(await rowButton("old/z")).getByRole("img", {
      name: /was deleted on the remote/,
    });
    expect(gone).toHaveAccessibleName(
      "Upstream origin/old/z was deleted on the remote — likely merged.",
    );
  });

  it("shows the chip on a repository with no remotes", async () => {
    reads.remotes = [];
    reads.branches.push(branchRow({ name: "spike/x", keepLocal: true }));
    const { user } = renderSwitcher();
    await openList(user);
    expect(await rowButton("spike/x")).toHaveAccessibleName(
      expect.stringContaining(CHIP_LABEL),
    );
  });

  it("keeps the chip on a long branch name", async () => {
    const long = "feature/payments/2026/q4/checkout-form-validation-refactor-x";
    reads.branches.push(branchRow({ name: long, keepLocal: true }));
    const { user } = renderSwitcher();
    await openList(user);
    expect(await rowButton(long)).toHaveAccessibleName(
      expect.stringContaining(CHIP_LABEL),
    );
  });
});

describe("the row menu of a kept-local row", () => {
  it("holds Publish with the suffix, outranking offline, and checks Keep local after Archive", async () => {
    reads.branches.push(
      branchRow({ name: "spike/x", keepLocal: true }),
      branchRow({ name: "draft/y" }),
    );
    onlineManager.setOnline(false);
    const { user } = renderSwitcher();
    await openList(user);
    await openRowMenu(user, "spike/x");
    const publish = menuItem("Publish branch (kept local)");
    expect(publish).toHaveAttribute("aria-disabled", "true");
    const toggle = keepLocalItem();
    expect(toggle).toHaveAccessibleName("Keep local");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    // Placed directly after Archive.
    const items = [
      ...screen.getByRole("menu").querySelectorAll("[role^=menuitem]"),
    ].map((el) => el.textContent ?? "");
    expect(items[items.indexOf("Archive") + 1]).toBe("Keep local");

    // The transient hold is live: an unmarked row shows the offline reason.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBe(null));
    await openRowMenu(user, "draft/y");
    expect(menuItem("Publish branch (you're offline)")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(keepLocalItem()).toHaveAttribute("aria-checked", "false");
  });

  it("holds Push to the upstream on a published, ahead row", async () => {
    reads.branches.push(
      trackedRow("feat/b", { keepLocal: true, upstreamAhead: 2 }),
    );
    const { user } = renderSwitcher();
    await openList(user);
    await openRowMenu(user, "feat/b");
    expect(menuItem("Push to origin/feat/b (kept local)")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});

describe("the Keep local toggle", () => {
  it("turning it on writes the mark, closes the menu and toasts", async () => {
    reads.branches.push(branchRow({ name: "feat/a" }));
    const { user } = renderSwitcher();
    await openList(user);
    await openRowMenu(user, "feat/a");
    await user.click(keepLocalItem());
    expect(gitSetBranchKeepLocal).toHaveBeenCalledWith(REPO, "feat/a", true);
    await waitFor(() => expect(screen.queryByRole("menu")).toBe(null));
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("feat/a is kept local", {
        description: ON_DESCRIPTION,
      }),
    );
  });

  it("Hide AI features drops the MCP server from the description", async () => {
    vi.mocked(loadSettings).mockImplementation(async () => ({
      ...structuredClone(DEFAULT_SETTINGS),
      hideAi: true,
    }));
    reads.branches.push(branchRow({ name: "feat/a" }));
    const { user } = renderSwitcher();
    await openList(user);
    await openRowMenu(user, "feat/a");
    await user.click(keepLocalItem());
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("feat/a is kept local", {
        description: ON_DESCRIPTION_NO_AI,
      }),
    );
  });

  it("turning it off toasts that the branch can be pushed again", async () => {
    reads.branches.push(branchRow({ name: "spike/x", keepLocal: true }));
    const { user } = renderSwitcher();
    await openList(user);
    await openRowMenu(user, "spike/x");
    await user.click(keepLocalItem());
    expect(gitSetBranchKeepLocal).toHaveBeenCalledWith(REPO, "spike/x", false);
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("spike/x can be pushed again"),
    );
  });

  it("a toggle settling after a repo switch names its repo", async () => {
    reads.branches.push(branchRow({ name: "feat/a" }));
    let land: () => void = () => undefined;
    vi.mocked(gitSetBranchKeepLocal).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          land = resolve;
        }),
    );
    const { user } = renderSwitcher();
    await openList(user);
    await openRowMenu(user, "feat/a");
    await user.click(keepLocalItem());
    expect(gitSetBranchKeepLocal).toHaveBeenCalledTimes(1);
    act(() => useUiStore.setState({ repoPath: OTHER_REPO }));
    await act(async () => land());
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("feat/a is kept local in keep", {
        description: ON_DESCRIPTION,
      }),
    );
  });

  it("the settled write re-reads the branch list, so the chip appears unprompted", async () => {
    reads.branches.push(branchRow({ name: "feat/a" }));
    vi.mocked(gitSetBranchKeepLocal).mockImplementation(
      async (_r, name, on) => {
        reads.branches = reads.branches.map((b) =>
          b.name === name ? { ...b, keepLocal: on } : b,
        );
      },
    );
    const { user } = renderSwitcher();
    await openList(user);
    expect(await rowButton("feat/a")).not.toHaveAccessibleName(
      expect.stringContaining(CHIP_LABEL),
    );
    await settle();
    const readsBefore = vi.mocked(gitBranches).mock.calls.length;
    await openRowMenu(user, "feat/a");
    await user.click(keepLocalItem());
    await waitFor(async () =>
      expect(await rowButton("feat/a")).toHaveAccessibleName(
        expect.stringContaining(CHIP_LABEL),
      ),
    );
    expect(vi.mocked(gitBranches).mock.calls.length).toBeGreaterThan(
      readsBefore,
    );
    // The list stayed open throughout: no remount brought the chip.
    expect(screen.getByPlaceholderText("Filter branches")).toBeInTheDocument();
  });

  it("opens from the keyboard and activates with Enter", async () => {
    reads.branches.push(branchRow({ name: "feat/a" }));
    const { user } = renderSwitcher();
    await openList(user);
    const row = await rowButton("feat/a");
    row.focus();
    // Gap: jsdom turns neither Shift+F10 nor the Menu key into the contextmenu
    // event a browser fires, so that event is sent by hand; the live drive owns the keys.
    fireEvent.contextMenu(row, { button: 0, clientX: 0, clientY: 0 });
    await screen.findByRole("menu");
    for (let i = 0; i < 10 && document.activeElement !== keepLocalItem(); i++)
      await user.keyboard("{ArrowDown}");
    expect(keepLocalItem()).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(gitSetBranchKeepLocal).toHaveBeenCalledWith(REPO, "feat/a", true);
  });
});

describe("the toggle-keep-local palette action", () => {
  it("toggles the current branch", async () => {
    reads.branches = [trackedRow("main", { isCurrent: true, keepLocal: true })];
    renderSwitcher();
    await waitFor(() => expect(gitBranches).toHaveBeenCalled());
    await settle();
    act(() => {
      dispatchAction("toggle-keep-local");
    });
    await waitFor(() =>
      expect(gitSetBranchKeepLocal).toHaveBeenCalledWith(REPO, "main", false),
    );
  });

  it("refuses on a detached HEAD without re-reading the list", async () => {
    reads.head = headOn(null);
    reads.branches = [trackedRow("main")];
    renderSwitcher();
    await waitFor(() => expect(gitBranches).toHaveBeenCalled());
    await settle();
    const readsBefore = vi.mocked(gitBranches).mock.calls.length;
    act(() => {
      dispatchAction("toggle-keep-local");
    });
    await settle();
    expect(info).toHaveBeenCalledWith(
      "There's no current branch to keep local (detached HEAD).",
    );
    expect(gitSetBranchKeepLocal).not.toHaveBeenCalled();
    expect(vi.mocked(gitBranches).mock.calls.length).toBe(readsBefore);
  });

  it("refuses on a gd/session branch without re-reading the list", async () => {
    reads.head = headOn("gd/session/abc");
    reads.branches = [
      trackedRow("main"),
      branchRow({ name: "gd/session/abc", isCurrent: true }),
    ];
    renderSwitcher();
    await waitFor(() => expect(gitBranches).toHaveBeenCalled());
    await settle();
    const readsBefore = vi.mocked(gitBranches).mock.calls.length;
    act(() => {
      dispatchAction("toggle-keep-local");
    });
    await settle();
    expect(info).toHaveBeenCalledWith(
      "gd/session branches are never pushed, so there is nothing to keep local.",
    );
    expect(gitSetBranchKeepLocal).not.toHaveBeenCalled();
    expect(vi.mocked(gitBranches).mock.calls.length).toBe(readsBefore);
  });
});

describe("Keep local toggle and publish holds", () => {
  it("the palette action waits for a list with no row for HEAD yet", async () => {
    reads.head = headOn("feat/new");
    reads.branches = [trackedRow("main")];
    renderSwitcher();
    await waitFor(() => expect(gitBranches).toHaveBeenCalled());
    await settle();
    act(() => {
      dispatchAction("toggle-keep-local");
    });
    await settle();
    expect(info).toHaveBeenCalledWith(
      "The branch list is catching up — try again in a moment.",
    );
    expect(gitSetBranchKeepLocal).not.toHaveBeenCalled();
  });

  it("holds each per-remote Publish item on a kept-local row", async () => {
    reads.remotes = ["origin", "fork"];
    reads.branches.push(branchRow({ name: "spike/x", keepLocal: true }));
    const { user } = renderSwitcher();
    await openList(user);
    await openRowMenu(user, "spike/x");
    for (const name of [
      "Publish to origin (kept local)",
      "Publish to fork (kept local)",
    ])
      expect(menuItem(name)).toHaveAttribute("aria-disabled", "true");
  });

  it("a failed toggle settling after a repo switch names its repo", async () => {
    reads.branches.push(branchRow({ name: "feat/a" }));
    let fail: (e: Error) => void = () => undefined;
    vi.mocked(gitSetBranchKeepLocal).mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const { user } = renderSwitcher();
    await openList(user);
    await openRowMenu(user, "feat/a");
    await user.click(keepLocalItem());
    act(() => useUiStore.setState({ repoPath: OTHER_REPO }));
    await act(async () => fail(new Error("config locked")));
    await waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(error.mock.calls[0][1]).toMatchObject({ description: "In keep" });
    expect(success).not.toHaveBeenCalled();
  });

  it("holds the toggle while its row pushes, in the menu and from the palette", async () => {
    reads.branches = [
      trackedRow("main", { isCurrent: true, upstreamAhead: 1 }),
    ];
    const { user } = renderSwitcher();
    await openList(user);
    await openRowMenu(user, "main");
    await user.click(menuItem("Push to origin/main"));
    await waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("menu")).toBe(null));
    await openRowMenu(user, "main");
    const toggle = keepLocalItem();
    expect(toggle).toHaveAccessibleName("Keep local (pushing…)");
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    act(() => {
      dispatchAction("toggle-keep-local");
    });
    await settle();
    expect(info).toHaveBeenCalledWith(
      "A push is already running — wait for it to finish.",
    );
    expect(gitSetBranchKeepLocal).not.toHaveBeenCalled();
  });
});

/** One usePush binding per file. Not named `push`: the usePush scan reads the
 *  word inside this file's `/terminal push/` regex as a use of the binding.
 *  Every other push this file starts goes through the switcher's own menu. */
function PushHarness({ path }: { path: string }) {
  const harnessPush = usePush(path);
  return (
    <button
      type="button"
      onClick={() =>
        void harnessPush.mutateAsync({ setUpstream: false, branch: "feat" })
      }
    >
      start feat in {path}
    </button>
  );
}

describe("deleting the checked-out branch while it pushes", () => {
  for (const [where, path, sentence] of [
    [
      "another worktree",
      SIBLING,
      "Another worktree is pushing this branch — main is checked out and feat was kept.",
    ],
    [
      "this checkout",
      REPO,
      "A push is already running — main is checked out and feat was kept.",
    ],
  ] as const)
    it(`a push from ${where} starting under the fallback checkout keeps the branch`, async () => {
      reads.head = headOn("feat");
      reads.branches = [
        trackedRow("feat", { isCurrent: true }),
        trackedRow("main"),
      ];
      let landCheckout: () => void = () => undefined;
      vi.mocked(gitCheckoutBranch).mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            landCheckout = resolve;
          }),
      );
      vi.mocked(gitDeleteBranch).mockResolvedValue(undefined);
      const { user, queryClient } = renderSwitcher();
      render(
        <QueryClientProvider client={queryClient}>
          <PushHarness path={path} />
        </QueryClientProvider>,
      );
      // The identity must land first: a push filed without it is path-keyed.
      await waitFor(() =>
        expect(
          queryClient.getQueryData(repoIdentityQueryOptions(path).queryKey),
        ).toBeDefined(),
      );
      await openList(user, "feat");
      await openRowMenu(user, "feat");
      await user.click(menuItem("Delete branch…"));
      await user.click(await screen.findByRole("button", { name: "Delete" }));
      await waitFor(() =>
        expect(gitCheckoutBranch).toHaveBeenCalledWith(REPO, "main"),
      );
      // Not user-event: the open modal confirm hides the page behind it.
      fireEvent.click(
        screen.getByRole("button", {
          name: `start feat in ${path}`,
          hidden: true,
        }),
      );
      await waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(1));
      await act(async () => landCheckout());
      await waitFor(() => expect(info).toHaveBeenCalledWith(sentence));
      expect(info).toHaveBeenCalledTimes(1);
      expect(gitDeleteBranch).not.toHaveBeenCalled();
    });
});

describe("the push-to-origin action on a kept-local branch", () => {
  const readCounts = () => [
    vi.mocked(gitStatus).mock.calls.length,
    vi.mocked(gitBranches).mock.calls.length,
  ];

  it("refuses the current branch before any read", async () => {
    reads.branches = [
      trackedRow("main", {
        isCurrent: true,
        keepLocal: true,
        upstreamAhead: 1,
      }),
    ];
    renderSwitcher();
    await waitFor(() => expect(gitBranches).toHaveBeenCalled());
    await settle();
    const before = readCounts();
    act(() => {
      dispatchAction("push-to-origin");
    });
    await settle();
    expect(info).toHaveBeenCalledWith(
      "main is kept local. Turn off Keep local in the branch menu to push it.",
    );
    expect(readCounts()).toEqual(before);
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("refuses the highlighted row before any read", async () => {
    reads.branches.push(
      trackedRow("spike/x", { keepLocal: true, upstreamAhead: 1 }),
    );
    const { user } = renderSwitcher();
    await openList(user);
    const row = await rowButton("spike/x");
    act(() => row.focus());
    await settle();
    const before = readCounts();
    act(() => {
      dispatchAction("push-to-origin");
    });
    await settle();
    expect(info).toHaveBeenCalledWith(
      "spike/x is kept local. Turn off Keep local in the branch menu to push it.",
    );
    expect(readCounts()).toEqual(before);
    expect(pushSpy).not.toHaveBeenCalled();
  });
});

/** The guard dialog by its title; the branch list popover is a dialog too. */
const guardDialog = () =>
  screen.queryByRole("dialog", { name: /terminal push/i });

describe("the terminal push guard item", () => {
  const items = () =>
    [...screen.getByRole("menu").querySelectorAll("[role^=menuitem]")].map(
      (el) => el.textContent ?? "",
    );

  it("sits directly under the toggle on a kept-local row only", async () => {
    reads.branches.push(
      branchRow({ name: "spike/x", keepLocal: true }),
      branchRow({ name: "draft/y" }),
    );
    const { user } = renderSwitcher();
    await openList(user);
    await openRowMenu(user, "spike/x");
    const block = await screen.findByRole("menuitem", {
      name: "Block terminal pushes too…",
    });
    expect(block).not.toHaveAttribute("aria-disabled", "true");
    expect(items()[items().indexOf("Keep local") + 1]).toBe(
      "Block terminal pushes too…",
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBe(null));
    await openRowMenu(user, "draft/y");
    expect(items().some((s) => /terminal push/i.test(s))).toBe(false);
  });

  it("reads Block terminal pushes too… on a blocked clone", async () => {
    reads.hook = hookStatus("blocked", "foreignHook");
    reads.branches.push(branchRow({ name: "spike/x", keepLocal: true }));
    const { user } = renderSwitcher();
    await openList(user);
    await openRowMenu(user, "spike/x");
    expect(
      await screen.findByRole("menuitem", {
        name: "Block terminal pushes too…",
      }),
    ).toBeInTheDocument();
  });

  it("reads Terminal push guard (on)… once installed", async () => {
    reads.hook = hookStatus("installed");
    reads.branches.push(branchRow({ name: "spike/x", keepLocal: true }));
    const { user } = renderSwitcher();
    await openList(user);
    await openRowMenu(user, "spike/x");
    expect(
      await screen.findByRole("menuitem", {
        name: "Terminal push guard (on)…",
      }),
    ).toBeInTheDocument();
  });

  it("waits disabled while the status read is in flight", async () => {
    vi.mocked(gitKeepLocalHookStatus).mockImplementation(
      () => new Promise(() => undefined),
    );
    reads.branches.push(branchRow({ name: "spike/x", keepLocal: true }));
    const { user } = renderSwitcher();
    await openList(user);
    await openRowMenu(user, "spike/x");
    const checking = menuItem("Terminal push guard (checking…)");
    expect(checking).toHaveAttribute("aria-disabled", "true");
    await user.click(checking);
    await settle();
    expect(guardDialog()).toBe(null);
  });

  it("after a failed read, opens the dialog in its failed state", async () => {
    vi.mocked(gitKeepLocalHookStatus).mockRejectedValue({
      kind: "io",
      message: "boom",
    });
    reads.branches.push(branchRow({ name: "spike/x", keepLocal: true }));
    const { user } = renderSwitcher();
    await openList(user);
    await openRowMenu(user, "spike/x");
    const unknown = await screen.findByRole("menuitem", {
      name: "Terminal push guard…",
    });
    expect(unknown).not.toHaveAttribute("aria-disabled", "true");
    await user.click(unknown);
    const d = await screen.findByRole("dialog", {
      name: "Terminal push guard",
    });
    await within(d).findByText("Couldn't check this clone's hooks.");
    expect(within(d).queryByText("Block terminal pushes too?")).toBe(null);
  });
});

describe("the terminal push guard dialog across a repo switch", () => {
  /** Opens the dialog from a kept-local row and presses Install, which waits. */
  async function pressInstall() {
    reads.branches.push(branchRow({ name: "spike/x", keepLocal: true }));
    let settleInstall: {
      resolve: (s: KeepLocalHookStatus) => void;
      reject: (e: unknown) => void;
    } = { resolve: () => undefined, reject: () => undefined };
    vi.mocked(gitKeepLocalHookInstall).mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          settleInstall = { resolve, reject };
        }),
    );
    const rendered = renderSwitcher();
    const { user } = rendered;
    await openList(user);
    await openRowMenu(user, "spike/x");
    await user.click(
      await screen.findByRole("menuitem", {
        name: "Block terminal pushes too…",
      }),
    );
    const d = await screen.findByRole("dialog", {
      name: "Block terminal pushes too?",
    });
    const footer = d.querySelector<HTMLElement>('[data-slot="dialog-footer"]');
    if (!footer) throw new Error("no footer");
    await waitFor(() =>
      expect(
        within(footer).getByRole("button", { name: "Cancel" }),
      ).toHaveFocus(),
    );
    await user.click(
      within(footer).getByRole("button", { name: "Install hook" }),
    );
    expect(gitKeepLocalHookInstall).toHaveBeenCalledWith(REPO);
    return { ...rendered, settleInstall: () => settleInstall };
  }

  it("unmounts on the switch, stays gone on the way back, and the settle only toasts", async () => {
    const { switchTo, settleInstall } = await pressInstall();
    await switchTo(OTHER_REPO);
    await waitFor(() => expect(guardDialog()).toBe(null));
    await switchTo(REPO);
    await settle();
    expect(guardDialog()).toBe(null);
    await act(async () => settleInstall().resolve(hookStatus("installed")));
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("Terminal push guard installed"),
    );
    expect(success).toHaveBeenCalledTimes(1);
    expect(guardDialog()).toBe(null);
  });

  it("a failure settling after the switch back toasts once and opens nothing", async () => {
    const { switchTo, settleInstall } = await pressInstall();
    await switchTo(OTHER_REPO);
    await switchTo(REPO);
    await act(async () =>
      settleInstall().reject({ kind: "io", message: "disk full" }),
    );
    await waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(success).not.toHaveBeenCalled();
    expect(guardDialog()).toBe(null);
    expect(screen.queryByRole("alert")).toBe(null);
  });

  it("settled while away, the success title names the repo", async () => {
    const { switchTo, settleInstall, queryClient } = await pressInstall();
    await switchTo(OTHER_REPO);
    await act(async () => settleInstall().resolve(hookStatus("installed")));
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith(
        "Terminal push guard installed in keep",
      ),
    );
    expect(guardDialog()).toBe(null);
    // The returned status seeds the repo the write started in, never the live one.
    expect(queryClient.getQueryData(["repo", REPO, "keep-local-hook"])).toEqual(
      hookStatus("installed"),
    );
    expect(
      queryClient.getQueryData(["repo", OTHER_REPO, "keep-local-hook"]),
    ).toBeUndefined();
  });
});
