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
  type DeletedBranchEntry,
  forgetDeletedBranch,
  recordDeletedBranches,
} from "@/lib/deleted-branches/store";
import {
  forgeStatus,
  getSecret,
  gitBranchDivergence,
  gitBranches,
  gitBranchTips,
  gitCheckoutBranch,
  gitCreateBranch,
  gitDefaultBranch,
  gitDeleteBranch,
  gitKeepLocalHookStatus,
  gitObjectsPresent,
  gitRemoteBranches,
  gitRemotes,
  gitSetBranchKeepLocal,
  gitStashCount,
  gitStatus,
  readRepoBranchRules,
} from "@/lib/git/api";
import type { Branch, BranchHead, KeepLocalHookStatus } from "@/lib/git/types";
import { listUserWorktrees } from "@/lib/git/worktree";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

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
  // The delete, and the reads and writes a Restore makes.
  gitCheckoutBranch: vi.fn(),
  gitDeleteBranch: vi.fn(),
  gitBranchTips: vi.fn(),
  gitObjectsPresent: vi.fn(),
  gitFindCommitsByPrefix: vi.fn(),
  gitSetBranchKeepLocal: vi.fn(),
  gitCreateBranch: vi.fn(),
}));
vi.mock("@/lib/git/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/worktree")>()),
  listUserWorktrees: vi.fn(),
}));
vi.mock("@/lib/git/repo-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/repo-identity")>()),
  peekRepoIdentity: (path: string) => `${path}/.git`,
  repoIdentityStrict: (path: string) => Promise.resolve(`${path}/.git`),
}));
// The real promotion check unless a test flags a promote.
const promote = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/stores/worktree-removal", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/stores/worktree-removal")>();
  return {
    ...actual,
    promotionBlocksCheckout: (repoPath: string) =>
      promote.on || actual.promotionBlocksCheckout(repoPath),
  };
});
// The record's own suite covers its store; here only what reaches it matters.
vi.mock("@/lib/deleted-branches/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/deleted-branches/store")>()),
  recordDeletedBranches: vi.fn(),
  forgetDeletedBranch: vi.fn(),
}));

const REPO = "C:/repos/keep";
const OTHER_REPO = "C:/repos/other";
const TIP = "abcdef0123456789abcdef0123456789abcdef01";

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

const trackedRow = (name: string, overrides: Partial<Branch> = {}) =>
  branchRow({
    name,
    upstream: `origin/${name}`,
    upstreamRemote: "origin",
    upstreamRemoteRef: `refs/heads/${name}`,
    ...overrides,
  });

function headOn(name: string): BranchHead {
  return {
    name,
    detached: false,
    oid: TIP,
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

const HOOK: KeepLocalHookStatus = {
  state: "absent",
  blocked: null,
  manager: null,
  managedHookPresent: false,
  hooksDirRedirected: false,
  hooksPath: "C:/repos/keep/.git/hooks",
  snippet: "exit 1",
};

let reads: { head: BranchHead; branches: Branch[] };
let success: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  promote.on = false;
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
  reads = {
    head: headOn("main"),
    branches: [trackedRow("main", { isCurrent: true })],
  };
  vi.mocked(gitStatus).mockImplementation(async () => ({
    branch: reads.head,
    entries: [],
  }));
  vi.mocked(gitBranches).mockImplementation(async () => reads.branches);
  vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
  vi.mocked(gitRemoteBranches).mockResolvedValue([]);
  vi.mocked(gitDefaultBranch).mockResolvedValue("main");
  vi.mocked(gitBranchDivergence).mockResolvedValue([]);
  vi.mocked(gitStashCount).mockResolvedValue(0);
  vi.mocked(readRepoBranchRules).mockResolvedValue(null);
  vi.mocked(getSecret).mockResolvedValue(null);
  vi.mocked(forgeStatus).mockImplementation(() => new Promise(() => undefined));
  vi.mocked(listUserWorktrees).mockResolvedValue([]);
  vi.mocked(gitKeepLocalHookStatus).mockResolvedValue(HOOK);
  vi.mocked(gitCheckoutBranch).mockResolvedValue(undefined);
  vi.mocked(gitDeleteBranch).mockResolvedValue({
    status: "deleted",
    tip: TIP,
    keptLocal: false,
    upstream: null,
  });
  // Every listed branch reads at TIP, the tip the delete answers with.
  vi.mocked(gitBranchTips).mockImplementation(async (_repo, names) =>
    Object.fromEntries(
      names
        .filter((n) => reads.branches.some((b) => b.name === n))
        .map((n) => [n, TIP]),
    ),
  );
  vi.mocked(gitObjectsPresent).mockResolvedValue(true);
  vi.mocked(gitSetBranchKeepLocal).mockResolvedValue(undefined);
  vi.mocked(gitCreateBranch).mockResolvedValue(undefined);
  vi.mocked(recordDeletedBranches).mockResolvedValue(true);
  vi.mocked(forgetDeletedBranch).mockResolvedValue(true);
  success = vi.spyOn(toast, "success");
  info = vi.spyOn(toast, "info");
  useUiStore.setState({ repoPath: REPO });
});
afterEach(() => {
  success.mockRestore();
  info.mockRestore();
});

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
  const { rerender, unmount } = render(view(REPO));
  const switchTo = (repo: string) =>
    act(() => {
      useUiStore.setState({ repoPath: repo });
      rerender(view(repo));
    });
  return { user, switchTo, unmount };
}

type User = ReturnType<typeof userEvent.setup>;

const rowButton = (name: string) =>
  waitFor(() => {
    const row = document.querySelector<HTMLElement>(`[data-row="${name}"]`);
    if (!row) throw new Error(`no row ${name}`);
    return row;
  });

/** Opens the branch list, the row's menu and its delete confirm. */
async function openDeleteConfirm(user: User, name: string, head = "main") {
  await user.click(
    await screen.findByRole("button", { name: new RegExp(`^${head}`) }),
  );
  await screen.findByPlaceholderText("Filter branches");
  await user.pointer({ keys: "[MouseRight]", target: await rowButton(name) });
  await screen.findByRole("menu");
  await user.click(screen.getByRole("menuitem", { name: "Delete branch…" }));
  return screen.findByRole("dialog", { name: "Delete branch?" });
}

const confirmButton = (confirm: HTMLElement) =>
  within(confirm).getByRole("button", { name: "Delete" });

/** Waits until the confirm's tip read answered: a held button stays focusable,
 *  so it carries aria-disabled rather than disabled. */
async function pressable(confirm: HTMLElement) {
  await waitFor(() =>
    expect(confirmButton(confirm)).not.toHaveAttribute("aria-disabled", "true"),
  );
  return confirmButton(confirm);
}

async function pressDelete(user: User, confirm: HTMLElement) {
  await user.click(await pressable(confirm));
}

async function deleteBranch(user: User, name: string, head = "main") {
  const confirm = await openDeleteConfirm(user, name, head);
  await pressDelete(user, confirm);
  await waitFor(() => expect(success).toHaveBeenCalled());
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const BUSY = {
  kind: "busy",
  message: "A worktree removal is still running — try again when it finishes.",
  holder: "a worktree removal",
} as const;

type ToastOptions = {
  duration: number;
  description?: string;
  action?: {
    label: string;
    onClick: (e: {
      currentTarget: HTMLElement;
      preventDefault: () => void;
    }) => void;
  };
};
const deleteToast = () => {
  const [title, options] = success.mock.calls[0] as [string, ToastOptions];
  return { title, options };
};
const recorded = () =>
  vi.mocked(recordDeletedBranches).mock.calls[0] as [
    string,
    DeletedBranchEntry[],
  ];

describe("deleting a branch from the branch menu", () => {
  it("pins the delete to the tip its confirm read, records the tip and offers Restore for 15 s", async () => {
    reads.branches.push(branchRow({ name: "feat/a" }));
    const { user } = renderSwitcher();
    await deleteBranch(user, "feat/a");
    expect(vi.mocked(gitDeleteBranch).mock.calls).toEqual([
      [REPO, "feat/a", TIP],
    ]);
    const [repo, [entry]] = recorded();
    expect(repo).toBe(REPO);
    expect(entry).toMatchObject({
      name: "feat/a",
      tip: TIP,
      keptLocal: false,
      upstream: null,
    });
    const { title, options } = deleteToast();
    expect(title).toBe("Deleted feat/a (was abcdef0)");
    expect(options.duration).toBe(15_000);
    expect(options.description).toBeUndefined();
    expect(options.action?.label).toBe("Restore");
    // The confirm closed.
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Delete branch?" })).toBe(
        null,
      ),
    );
  });

  it("records Keep local and the upstream from the delete's outcome, over the listed row", async () => {
    reads.branches.push(branchRow({ name: "feat/b", keepLocal: false }));
    vi.mocked(gitDeleteBranch).mockResolvedValue({
      status: "deleted",
      tip: TIP,
      keptLocal: true,
      upstream: "origin/x",
    });
    const { user } = renderSwitcher();
    await deleteBranch(user, "feat/b");
    expect(recorded()[1][0]).toMatchObject({
      name: "feat/b",
      keptLocal: true,
      upstream: "origin/x",
    });
  });

  it("reads no branch list between the press and the delete", async () => {
    reads.branches.push(branchRow({ name: "feat/c" }));
    const { user } = renderSwitcher();
    const confirm = await openDeleteConfirm(user, "feat/c");
    const button = await pressable(confirm);
    const readsBefore = vi.mocked(gitBranches).mock.calls.length;
    await user.click(button);
    await waitFor(() => expect(success).toHaveBeenCalled());
    const deleted = vi.mocked(gitDeleteBranch).mock.invocationCallOrder[0];
    for (const order of vi
      .mocked(gitBranches)
      .mock.invocationCallOrder.slice(readsBefore))
      expect(order).toBeGreaterThan(deleted);
  });

  it("records an unmarked outcome unmarked, whatever the listed row says", async () => {
    reads.branches.push(trackedRow("feat/d", { keepLocal: true }));
    const { user } = renderSwitcher();
    await deleteBranch(user, "feat/d");
    expect(recorded()[1][0]).toMatchObject({
      name: "feat/d",
      keptLocal: false,
      upstream: null,
    });
  });

  it("switches off the current branch first, then deletes and records it", async () => {
    reads.head = headOn("feat");
    reads.branches = [
      trackedRow("feat", { isCurrent: true }),
      trackedRow("main"),
    ];
    const { user } = renderSwitcher();
    const confirm = await openDeleteConfirm(user, "feat", "feat");
    expect(confirm).toHaveTextContent(
      "Deletes feat locally, including commits that exist only on it. You'll be switched to another branch first. The branch can be restored from Recover lost work.",
    );
    await pressDelete(user, confirm);
    await waitFor(() => expect(success).toHaveBeenCalled());
    expect(gitCheckoutBranch).toHaveBeenCalledWith(REPO, "main");
    expect(vi.mocked(gitDeleteBranch).mock.calls).toEqual([
      [REPO, "feat", TIP],
    ]);
    expect(
      vi.mocked(gitCheckoutBranch).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(gitDeleteBranch).mock.invocationCallOrder[0]);
    expect(deleteToast().title).toBe("Deleted feat (was abcdef0)");
  });

  it("says the branch can be restored in the confirm", async () => {
    reads.branches.push(branchRow({ name: "feat/a" }));
    const { user } = renderSwitcher();
    const confirm = await openDeleteConfirm(user, "feat/a");
    expect(confirm).toHaveTextContent(
      "Deletes feat/a locally, including commits that exist only on it. The branch can be restored from Recover lost work.",
    );
  });

  it("keeps the toast until closed, with a note, when the record write fails", async () => {
    vi.mocked(recordDeletedBranches).mockResolvedValue(false);
    reads.branches.push(branchRow({ name: "feat/a" }));
    const { user } = renderSwitcher();
    await deleteBranch(user, "feat/a");
    const { options } = deleteToast();
    expect(options.duration).toBe(Number.POSITIVE_INFINITY);
    expect(options.description).toBe(
      "Couldn't add it to Recover lost work. Restore it from this notice, or re-create it from the commit above.",
    );
    expect(options.action?.label).toBe("Restore");
  });

  it("records nothing when the delete fails", async () => {
    vi.mocked(gitDeleteBranch).mockRejectedValue({
      kind: "git",
      message: "branch moved",
    });
    reads.branches.push(branchRow({ name: "feat/a" }));
    const { user } = renderSwitcher();
    const error = vi.spyOn(toast, "error");
    const confirm = await openDeleteConfirm(user, "feat/a");
    await pressDelete(user, confirm);
    // The failure's own toast ends the handler's path.
    await waitFor(() => expect(error).toHaveBeenCalled());
    error.mockRestore();
    expect(recordDeletedBranches).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
  });

  it("deletes once when a second press lands while the delete runs", async () => {
    reads.branches.push(branchRow({ name: "feat/a" }));
    const { user } = renderSwitcher();
    const confirm = await openDeleteConfirm(user, "feat/a");
    const held = deferred<void>();
    vi.mocked(gitDeleteBranch).mockImplementation(async () => {
      await held.promise;
      return { status: "deleted", tip: TIP, keptLocal: false, upstream: null };
    });
    const error = vi.spyOn(toast, "error");
    const button = await pressable(confirm);
    // Both presses land before a re-render.
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await waitFor(() => expect(gitDeleteBranch).toHaveBeenCalledTimes(1));
    await act(async () => held.resolve());
    await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Delete branch?" })).toBe(
        null,
      ),
    );
    expect(gitDeleteBranch).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("says where HEAD went when a promote stops a current-branch delete after its switch", async () => {
    reads.head = headOn("feat");
    reads.branches = [
      trackedRow("feat", { isCurrent: true }),
      trackedRow("main"),
    ];
    const { user } = renderSwitcher();
    const confirm = await openDeleteConfirm(user, "feat", "feat");
    const held = deferred<void>();
    vi.mocked(gitCheckoutBranch).mockImplementation(() => held.promise);
    await pressDelete(user, confirm);
    await waitFor(() =>
      expect(gitCheckoutBranch).toHaveBeenCalledWith(REPO, "main"),
    );
    promote.on = true;
    await act(async () => held.resolve());
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith(
        "A worktree is being promoted to your main workspace. Try again once it finishes.",
        { description: "Switched to main; feat was kept." },
      ),
    );
    expect(gitDeleteBranch).not.toHaveBeenCalled();
  });

  it("keeps a branch that moved since its confirm opened and records nothing", async () => {
    vi.mocked(gitDeleteBranch).mockResolvedValue({
      status: "tipMoved",
      expected: TIP,
      actual: "1".repeat(40),
    });
    reads.branches.push(branchRow({ name: "feat/a" }));
    const { user } = renderSwitcher();
    const confirm = await openDeleteConfirm(user, "feat/a");
    await pressDelete(user, confirm);
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith(
        "feat/a changed before it could be deleted, so it was kept.",
        undefined,
      ),
    );
    expect(recordDeletedBranches).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Delete branch?" })).toBe(
        null,
      ),
    );
  });

  it("says where HEAD went when the current branch moved before its delete", async () => {
    reads.head = headOn("feat");
    reads.branches = [
      trackedRow("feat", { isCurrent: true }),
      trackedRow("main"),
    ];
    vi.mocked(gitDeleteBranch).mockResolvedValue({
      status: "tipMoved",
      expected: TIP,
      actual: "1".repeat(40),
    });
    const { user } = renderSwitcher();
    const confirm = await openDeleteConfirm(user, "feat", "feat");
    await pressDelete(user, confirm);
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith(
        "feat changed before it could be deleted, so it was kept.",
        { description: "Switched to main; feat was kept." },
      ),
    );
    expect(vi.mocked(gitDeleteBranch).mock.calls).toEqual([
      [REPO, "feat", TIP],
    ]);
    expect(recordDeletedBranches).not.toHaveBeenCalled();
  });
});

describe("the delete confirm's pin", () => {
  it.each([
    [
      "while the branch's commit is read",
      () => new Promise<Record<string, string>>(() => undefined),
      "Checking the branch's commit…",
    ],
    [
      "when that read failed",
      () => Promise.reject({ kind: "git", message: "not a git repository" }),
      "Couldn't read this branch's commit. Close this and open Delete again to retry.",
    ],
    [
      "when Git no longer lists the branch",
      () => Promise.resolve({}),
      "Git no longer lists this branch.",
    ],
    [
      "when the listed tip isn't a full commit id",
      () => Promise.resolve({ "feat/a": "abc" }),
      "Couldn't read this branch's commit. Close this and open Delete again to retry.",
    ],
  ])("holds Delete %s and never deletes", async (_label, answer, reason) => {
    reads.branches.push(branchRow({ name: "feat/a" }));
    vi.mocked(gitBranchTips).mockImplementation(answer);
    const { user } = renderSwitcher();
    const confirm = await openDeleteConfirm(user, "feat/a");
    const button = confirmButton(confirm);
    await waitFor(() => expect(button).toHaveAccessibleDescription(reason));
    expect(button).toHaveAttribute("aria-disabled", "true");
    act(() => fireEvent.click(button));
    // A press that got through reaches the IPC only after the mutation's own
    // awaits.
    await act(() => Promise.resolve());
    expect(gitDeleteBranch).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Delete branch?" })).toBe(
      confirm,
    );
  });

  it("reads the tip again when the confirm is reopened after a failed read", async () => {
    reads.branches.push(branchRow({ name: "feat/a" }));
    vi.mocked(gitBranchTips).mockRejectedValueOnce({
      kind: "git",
      message: "not a git repository",
    });
    const { user } = renderSwitcher();
    const first = await openDeleteConfirm(user, "feat/a");
    await waitFor(() =>
      expect(confirmButton(first)).toHaveAccessibleDescription(
        "Couldn't read this branch's commit. Close this and open Delete again to retry.",
      ),
    );
    await user.click(within(first).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Delete branch?" })).toBe(
        null,
      ),
    );
    const tipsBefore = vi.mocked(gitBranchTips).mock.calls.length;
    const again = await openDeleteConfirm(user, "feat/a");
    await pressDelete(user, again);
    await waitFor(() => expect(success).toHaveBeenCalled());
    expect(vi.mocked(gitBranchTips).mock.calls.length).toBeGreaterThan(
      tipsBefore,
    );
    expect(vi.mocked(gitDeleteBranch).mock.calls).toEqual([
      [REPO, "feat/a", TIP],
    ]);
  });

  it("closes a confirm left open across a switch, so a return never pins a fresh read", async () => {
    reads.branches.push(branchRow({ name: "feat/a" }));
    const { user, switchTo } = renderSwitcher();
    const confirm = await openDeleteConfirm(user, "feat/a");
    await pressable(confirm);
    await switchTo(OTHER_REPO);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Delete branch?" })).toBe(
        null,
      ),
    );
    // Back in the repo the confirm opened in, where the branch has moved since.
    const MOVED = "1".repeat(40);
    vi.mocked(gitBranchTips).mockResolvedValue({ "feat/a": MOVED });
    await switchTo(REPO);
    await act(() => Promise.resolve());
    expect(screen.queryByRole("dialog", { name: "Delete branch?" })).toBe(null);
    expect(gitDeleteBranch).not.toHaveBeenCalled();
    // Only a reopen reads and pins the tip again.
    const again = await openDeleteConfirm(user, "feat/a");
    await pressDelete(user, again);
    await waitFor(() =>
      expect(vi.mocked(gitDeleteBranch).mock.calls).toEqual([
        [REPO, "feat/a", MOVED],
      ]),
    );
  });
});

describe("dismissing a current-branch delete's confirm", () => {
  const onFeat = () => {
    reads.head = headOn("feat");
    reads.branches = [
      trackedRow("feat", { isCurrent: true }),
      trackedRow("main"),
    ];
  };

  it("starts nothing when dismissed during the worktree read", async () => {
    onFeat();
    const held = deferred<Awaited<ReturnType<typeof listUserWorktrees>>>();
    vi.mocked(listUserWorktrees).mockImplementation(() => held.promise);
    const { user } = renderSwitcher();
    const confirm = await openDeleteConfirm(user, "feat", "feat");
    await pressDelete(user, confirm);
    await waitFor(() => expect(listUserWorktrees).toHaveBeenCalled());
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Delete branch?" })).toBe(
        null,
      ),
    );
    await act(async () => held.resolve([]));
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith(
        "You closed the confirmation before the delete started — feat was kept.",
      ),
    );
    expect(gitCheckoutBranch).not.toHaveBeenCalled();
    expect(gitDeleteBranch).not.toHaveBeenCalled();
  });

  it("lands the switch but sends no delete when dismissed during the checkout", async () => {
    onFeat();
    const held = deferred<void>();
    vi.mocked(gitCheckoutBranch).mockImplementation(() => held.promise);
    const { user } = renderSwitcher();
    const confirm = await openDeleteConfirm(user, "feat", "feat");
    await pressDelete(user, confirm);
    await waitFor(() =>
      expect(gitCheckoutBranch).toHaveBeenCalledWith(REPO, "main"),
    );
    await user.keyboard("{Escape}");
    await act(async () => held.resolve());
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith(
        "You closed the confirmation before feat was deleted — main is checked out and feat was kept.",
      ),
    );
    expect(gitDeleteBranch).not.toHaveBeenCalled();
  });

  // Leaving the repository view (Help, Settings, My work) unmounts the switcher
  // without changing the open repository, so only the unmount ends the session.
  it("starts nothing when the switcher unmounts during the worktree read", async () => {
    onFeat();
    const held = deferred<Awaited<ReturnType<typeof listUserWorktrees>>>();
    vi.mocked(listUserWorktrees).mockImplementation(() => held.promise);
    const { user, unmount } = renderSwitcher();
    const confirm = await openDeleteConfirm(user, "feat", "feat");
    await pressDelete(user, confirm);
    await waitFor(() => expect(listUserWorktrees).toHaveBeenCalled());
    unmount();
    await act(async () => held.resolve([]));
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith(
        "You closed the confirmation before the delete started — feat was kept.",
      ),
    );
    expect(gitCheckoutBranch).not.toHaveBeenCalled();
    expect(gitDeleteBranch).not.toHaveBeenCalled();
  });

  it("lands the switch but sends no delete when the switcher unmounts during the checkout", async () => {
    onFeat();
    const held = deferred<void>();
    vi.mocked(gitCheckoutBranch).mockImplementation(() => held.promise);
    const { user, unmount } = renderSwitcher();
    const confirm = await openDeleteConfirm(user, "feat", "feat");
    await pressDelete(user, confirm);
    await waitFor(() =>
      expect(gitCheckoutBranch).toHaveBeenCalledWith(REPO, "main"),
    );
    unmount();
    await act(async () => held.resolve());
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith(
        "You closed the confirmation before feat was deleted — main is checked out and feat was kept.",
      ),
    );
    expect(gitCheckoutBranch).toHaveBeenCalledTimes(1);
    expect(gitDeleteBranch).not.toHaveBeenCalled();
  });

  /** Away to another repository and back, waiting for the confirm to close. */
  async function roundTrip(
    switchTo: ReturnType<typeof renderSwitcher>["switchTo"],
  ) {
    await switchTo(OTHER_REPO);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Delete branch?" })).toBe(
        null,
      ),
    );
    await switchTo(REPO);
  }

  it("starts nothing after a switch away and back during the worktree read", async () => {
    onFeat();
    const held = deferred<Awaited<ReturnType<typeof listUserWorktrees>>>();
    vi.mocked(listUserWorktrees).mockImplementation(() => held.promise);
    const { user, switchTo } = renderSwitcher();
    const confirm = await openDeleteConfirm(user, "feat", "feat");
    await pressDelete(user, confirm);
    await waitFor(() => expect(listUserWorktrees).toHaveBeenCalled());
    await roundTrip(switchTo);
    await act(async () => held.resolve([]));
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith(
        "You switched repositories before the delete started — nothing was deleted.",
      ),
    );
    expect(gitCheckoutBranch).not.toHaveBeenCalled();
    expect(gitDeleteBranch).not.toHaveBeenCalled();
  });

  it("lands the switch but sends no delete after a switch away and back during the checkout", async () => {
    onFeat();
    const held = deferred<void>();
    vi.mocked(gitCheckoutBranch).mockImplementation(() => held.promise);
    const { user, switchTo } = renderSwitcher();
    const confirm = await openDeleteConfirm(user, "feat", "feat");
    await pressDelete(user, confirm);
    await waitFor(() =>
      expect(gitCheckoutBranch).toHaveBeenCalledWith(REPO, "main"),
    );
    await roundTrip(switchTo);
    await act(async () => held.resolve());
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith(
        "You switched repositories before feat was deleted — main is checked out and feat was kept.",
      ),
    );
    expect(gitCheckoutBranch).toHaveBeenCalledTimes(1);
    expect(gitDeleteBranch).not.toHaveBeenCalled();
  });

  it("lets a delete already sent finish and report", async () => {
    onFeat();
    const held = deferred<void>();
    vi.mocked(gitDeleteBranch).mockImplementation(async () => {
      await held.promise;
      return { status: "deleted", tip: TIP, keptLocal: false, upstream: null };
    });
    const { user } = renderSwitcher();
    const confirm = await openDeleteConfirm(user, "feat", "feat");
    await pressDelete(user, confirm);
    await waitFor(() => expect(gitDeleteBranch).toHaveBeenCalledTimes(1));
    await user.keyboard("{Escape}");
    await act(async () => held.resolve());
    await waitFor(() => expect(success).toHaveBeenCalled());
    expect(deleteToast().title).toBe("Deleted feat (was abcdef0)");
    expect(recordDeletedBranches).toHaveBeenCalledTimes(1);
  });
});

describe("a delete that waited out a held repository", () => {
  it("shows the held operation's sentence and records nothing", async () => {
    vi.mocked(gitDeleteBranch).mockRejectedValue(BUSY);
    reads.branches.push(branchRow({ name: "feat/a" }));
    const error = vi.spyOn(toast, "error");
    const { user } = renderSwitcher();
    const confirm = await openDeleteConfirm(user, "feat/a");
    await pressDelete(user, confirm);
    await waitFor(() => expect(error).toHaveBeenCalled());
    const [title, options] = error.mock.calls[0] as [string, ToastOptions];
    expect(title).toBe(BUSY.message);
    expect(options.description).toBeUndefined();
    error.mockRestore();
    expect(recordDeletedBranches).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Delete branch?" })).toBe(
        null,
      ),
    );
  });

  it("says where HEAD went when it fails after the switch landed", async () => {
    reads.head = headOn("feat");
    reads.branches = [
      trackedRow("feat", { isCurrent: true }),
      trackedRow("main"),
    ];
    vi.mocked(gitDeleteBranch).mockRejectedValue(BUSY);
    const error = vi.spyOn(toast, "error");
    const { user } = renderSwitcher();
    const confirm = await openDeleteConfirm(user, "feat", "feat");
    await pressDelete(user, confirm);
    await waitFor(() => expect(error).toHaveBeenCalled());
    const [title, options] = error.mock.calls[0] as [string, ToastOptions];
    error.mockRestore();
    expect(title).toBe(BUSY.message);
    expect(options.description).toBe("Switched to main; feat was kept.");
  });

  it("claims no switch when the checkout itself failed", async () => {
    reads.head = headOn("feat");
    reads.branches = [
      trackedRow("feat", { isCurrent: true }),
      trackedRow("main"),
    ];
    vi.mocked(gitCheckoutBranch).mockRejectedValue(BUSY);
    const error = vi.spyOn(toast, "error");
    const { user } = renderSwitcher();
    const confirm = await openDeleteConfirm(user, "feat", "feat");
    await pressDelete(user, confirm);
    await waitFor(() => expect(error).toHaveBeenCalled());
    const [title, options] = error.mock.calls[0] as [string, ToastOptions];
    error.mockRestore();
    expect(title).toBe(BUSY.message);
    expect(options?.description).toBeUndefined();
    expect(gitDeleteBranch).not.toHaveBeenCalled();
  });
});

describe("the delete toast's Restore", () => {
  it("blurs its button first, then restores into the delete's repository after a switch", async () => {
    reads.branches.push(trackedRow("feat/b", { keepLocal: true }));
    vi.mocked(gitDeleteBranch).mockResolvedValue({
      status: "deleted",
      tip: TIP,
      keptLocal: true,
      upstream: "origin/feat/b",
    });
    const { user, switchTo } = renderSwitcher();
    await deleteBranch(user, "feat/b");
    reads.branches = reads.branches.filter((b) => b.name !== "feat/b");
    const { options } = deleteToast();
    await switchTo(OTHER_REPO);
    const blur = vi.fn();
    const tipsBefore = vi.mocked(gitBranchTips).mock.calls.length;
    act(() => {
      options.action?.onClick({
        currentTarget: { blur } as never,
        preventDefault: () => undefined,
      });
    });
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("Restored feat/b in keep", {
        description:
          "Keep local is on again. Its upstream link to origin/feat/b wasn't restored.",
      }),
    );
    expect(blur).toHaveBeenCalledTimes(1);
    // The press's own name check is the first tips read after it.
    expect(blur.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(gitBranchTips).mock.invocationCallOrder[tipsBefore],
    );
    expect(vi.mocked(gitBranchTips).mock.calls[tipsBefore]).toEqual([
      REPO,
      ["feat/b"],
    ]);
    expect(gitSetBranchKeepLocal).toHaveBeenCalledWith(REPO, "feat/b", true);
    expect(gitCreateBranch).toHaveBeenCalledWith(
      REPO,
      "feat/b",
      false,
      TIP,
      true,
    );
    expect(forgetDeletedBranch).toHaveBeenCalledWith(REPO, recorded()[1][0].id);
  });

  it("refuses a name that exists again and overwrites nothing", async () => {
    reads.branches.push(branchRow({ name: "feat/a" }));
    const { user } = renderSwitcher();
    await deleteBranch(user, "feat/a");
    vi.mocked(gitBranchTips).mockResolvedValue({ "feat/a": "1".repeat(40) });
    act(() => {
      deleteToast().options.action?.onClick({
        currentTarget: { blur: () => undefined } as never,
        preventDefault: () => undefined,
      });
    });
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith("Couldn't restore feat/a", {
        description:
          "A branch with that name exists again, and nothing was overwritten. Rename or delete it, then restore from Recover lost work.",
      }),
    );
    expect(gitCreateBranch).not.toHaveBeenCalled();
  });
});
