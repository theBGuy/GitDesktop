import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
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
  vi.mocked(gitDeleteBranch).mockResolvedValue({ status: "deleted", tip: TIP });
  vi.mocked(gitBranchTips).mockResolvedValue({});
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
  const { rerender } = render(view(REPO));
  const switchTo = (repo: string) =>
    act(() => {
      useUiStore.setState({ repoPath: repo });
      rerender(view(repo));
    });
  return { user, switchTo };
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

async function deleteBranch(user: User, name: string, head = "main") {
  const confirm = await openDeleteConfirm(user, name, head);
  await user.click(within(confirm).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(success).toHaveBeenCalled());
}

type ToastOptions = {
  duration: number;
  description?: string;
  action?: {
    label: string;
    onClick: (e: { currentTarget: HTMLElement }) => void;
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
  it("sends no expected tip, records the tip and offers Restore for 15 s", async () => {
    reads.branches.push(branchRow({ name: "feat/a" }));
    const { user } = renderSwitcher();
    await deleteBranch(user, "feat/a");
    expect(vi.mocked(gitDeleteBranch).mock.calls).toEqual([[REPO, "feat/a"]]);
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

  it("records Keep local and the upstream from the row read before the delete", async () => {
    reads.branches.push(trackedRow("feat/b", { keepLocal: true }));
    const { user } = renderSwitcher();
    await deleteBranch(user, "feat/b");
    expect(recorded()[1][0]).toMatchObject({
      name: "feat/b",
      keptLocal: true,
      upstream: "origin/feat/b",
    });
  });

  it("reads Keep local fresh before the delete, over a stale cached row", async () => {
    reads.branches.push(branchRow({ name: "feat/c", keepLocal: false }));
    const { user } = renderSwitcher();
    const confirm = await openDeleteConfirm(user, "feat/c");
    // Marked in another window since the list was read.
    reads.branches = reads.branches.map((b) =>
      b.name === "feat/c" ? { ...b, keepLocal: true } : b,
    );
    const readsBefore = vi.mocked(gitBranches).mock.calls.length;
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(success).toHaveBeenCalled());
    expect(recorded()[1][0]).toMatchObject({ name: "feat/c", keptLocal: true });
    const fresh = vi.mocked(gitBranches).mock.invocationCallOrder[readsBefore];
    expect(fresh).toBeLessThan(
      vi.mocked(gitDeleteBranch).mock.invocationCallOrder[0],
    );
  });

  it("records Keep local when the fresh branch read fails", async () => {
    reads.branches.push(branchRow({ name: "feat/d", keepLocal: false }));
    const { user } = renderSwitcher();
    const confirm = await openDeleteConfirm(user, "feat/d");
    vi.mocked(gitBranches).mockRejectedValueOnce(new Error("spawn failed"));
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(success).toHaveBeenCalled());
    expect(recorded()[1][0]).toMatchObject({ name: "feat/d", keptLocal: true });
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
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(success).toHaveBeenCalled());
    expect(gitCheckoutBranch).toHaveBeenCalledWith(REPO, "main");
    expect(vi.mocked(gitDeleteBranch).mock.calls).toEqual([[REPO, "feat"]]);
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
    const confirm = await openDeleteConfirm(user, "feat/a");
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(gitDeleteBranch).toHaveBeenCalled());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(recordDeletedBranches).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
  });

  it("treats a tip-moved answer as not deleted", async () => {
    vi.mocked(gitDeleteBranch).mockResolvedValue({
      status: "tipMoved",
      expected: TIP,
      actual: "1".repeat(40),
    });
    reads.branches.push(branchRow({ name: "feat/a" }));
    const { user } = renderSwitcher();
    const confirm = await openDeleteConfirm(user, "feat/a");
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith(
        "feat/a changed while it was being deleted — nothing was deleted.",
      ),
    );
    expect(recordDeletedBranches).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
  });
});

describe("the delete toast's Restore", () => {
  it("blurs its button first, then restores into the delete's repository after a switch", async () => {
    reads.branches.push(trackedRow("feat/b", { keepLocal: true }));
    const { user, switchTo } = renderSwitcher();
    await deleteBranch(user, "feat/b");
    const { options } = deleteToast();
    await switchTo(OTHER_REPO);
    const blur = vi.fn();
    act(() => {
      options.action?.onClick({ currentTarget: { blur } as never });
    });
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("Restored feat/b in keep", {
        description:
          "Keep local is on again. Its upstream link to origin/feat/b wasn't restored.",
      }),
    );
    expect(blur).toHaveBeenCalledTimes(1);
    expect(blur.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(gitBranchTips).mock.invocationCallOrder[0],
    );
    expect(gitBranchTips).toHaveBeenCalledWith(REPO, ["feat/b"]);
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
