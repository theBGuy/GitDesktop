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
  PUBLISH_HOLD_ITEM_REASON,
  PUBLISH_HOLD_REASON,
  publishRunningMessage,
} from "@/features/repository/PublishPendingBanner";
import { switchedAndKept } from "@/lib/deleted-branches/copy";
import {
  forgePrsOnRemoteBranch,
  forgeStatus,
  getSecret,
  gitBranchDivergence,
  gitBranches,
  gitBranchTips,
  gitCheckoutBranch,
  gitDefaultBranch,
  gitDeleteBranch,
  gitKeepLocalHookStatus,
  gitRemoteBranches,
  gitRemoteRenameCheck,
  gitRemotes,
  gitStashCount,
  gitStatus,
  readRepoBranchRules,
} from "@/lib/git/api";
import { usePendingPublishes, usePublishRepo } from "@/lib/git/queries";
import { repoIdentityQueryOptions } from "@/lib/git/repo-identity-query";
import type {
  Branch,
  BranchHead,
  RemoteBranchPulls,
  RemoteRenameCheck,
} from "@/lib/git/types";
import { listUserWorktrees } from "@/lib/git/worktree";
import { dispatchAction } from "@/lib/hotkeys/hotkeys";
import { OFFLINE_ITEM_REASON } from "@/lib/offline-writes";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

// The publish callee is reached only through its spy: publish-hold-routes lets
// no file but its one hook import it by name.
const publishSpy = vi.hoisted(() => vi.fn());
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
  // The delete confirm's tip read, and the current-branch delete's writes.
  gitBranchTips: vi.fn(),
  gitCheckoutBranch: vi.fn(),
  gitDeleteBranch: vi.fn(),
  // The rename dialog's remote-step reads.
  gitRemoteRenameCheck: vi.fn(),
  forgePrsOnRemoteBranch: vi.fn(),
  // The publish, held open until a test lands it.
  forgePublishRepo: publishSpy,
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

const REPO = "C:/repos/hold";
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

/** A row tracking `remote/branch` (its own name on origin by default). */
const trackedRow = (
  name: string,
  overrides: Partial<Branch> = {},
  remote = "origin",
  branch = name,
) =>
  branchRow({
    name,
    upstream: `${remote}/${branch}`,
    upstreamRemote: remote,
    upstreamRemoteRef: `refs/heads/${branch}`,
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

const clearCheck: RemoteRenameCheck = { status: "clear", oldTip: TIP };
const noPulls: RemoteBranchPulls = {
  status: "checked",
  provider: "github",
  items: [],
  unchecked: [],
};

let reads: { head: BranchHead; branches: Branch[]; remotes: string[] };
let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
  // HEAD on feat; main is the default; topic is another tracked branch.
  reads = {
    head: headOn("feat"),
    branches: [
      trackedRow("main"),
      trackedRow("feat", { isCurrent: true }),
      trackedRow("topic"),
    ],
    remotes: ["origin"],
  };
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
  vi.mocked(gitKeepLocalHookStatus).mockResolvedValue({
    state: "absent",
    blocked: null,
    manager: null,
    managedHookPresent: false,
    hooksDirRedirected: false,
    hooksPath: "C:/repos/hold/.git/hooks",
    snippet: "exit 1",
  });
  vi.mocked(gitBranchTips).mockImplementation(async (_repo, names) =>
    Object.fromEntries(names.map((n) => [n, TIP])),
  );
  vi.mocked(gitRemoteRenameCheck).mockResolvedValue(clearCheck);
  vi.mocked(forgePrsOnRemoteBranch).mockResolvedValue(noPulls);
  landPublish = null;
  publishSpy.mockImplementation(
    () =>
      new Promise((resolve) => {
        landPublish = () => resolve(undefined);
      }),
  );
  info = vi.spyOn(toast, "info");
  useUiStore.setState({ repoPath: REPO });
});
afterEach(() => {
  onlineManager.setOnline(true);
  info.mockRestore();
});

// ---- A publish in flight, started through the publish hook itself; its
// backend call stays open until the test lands it.

let landPublish: (() => void) | null = null;

function PublishHarness() {
  const publish = usePublishRepo(REPO);
  const pending = usePendingPublishes(REPO).length;
  return (
    <>
      {/* What the switcher reads for its render holds, shown where a test
          can wait on it under an open prompt. */}
      <output data-testid="pending-publishes">{pending}</output>
      <button
        type="button"
        onClick={() =>
          void publish.mutateAsync({
            provider: "github",
            name: "hold",
            isPrivate: true,
            description: "",
            homepage: "",
            topics: [],
          })
        }
      >
        start publish
      </button>
    </>
  );
}

function renderSwitcher() {
  const user = userEvent.setup();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <BranchSwitcher repoPath={REPO} />
      <PublishHarness />
    </QueryClientProvider>,
  );
  /** Starts the publish. Not user-event: an open list or prompt hides the
   *  page behind it. */
  const startPublish = async () => {
    await waitFor(() =>
      expect(
        queryClient.getQueryData(repoIdentityQueryOptions(REPO).queryKey),
      ).toBeDefined(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "start publish", hidden: true }),
    );
    await waitFor(() => expect(landPublish).not.toBeNull());
  };
  const settlePublish = () =>
    act(async () => {
      landPublish?.();
      landPublish = null;
      await new Promise((r) => setTimeout(r, 20));
    });
  return { user, queryClient, startPublish, settlePublish };
}

type User = ReturnType<typeof userEvent.setup>;

async function openList(user: User, headLabel = "feat") {
  await user.click(
    await screen.findByRole("button", { name: new RegExp(`^${headLabel}`) }),
  );
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

const menuItem = (menu: HTMLElement, name: string | RegExp) =>
  within(menu).getByRole("menuitem", { name });

const footerRow = (name: string) => screen.getByRole("button", { name });

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });

const HELD_RENAME = `Rename branch… (${PUBLISH_HOLD_ITEM_REASON})`;
const HELD_DELETE = `Delete branch… (${PUBLISH_HOLD_ITEM_REASON})`;
const RUNNING = publishRunningMessage({
  provider: "github",
  name: "hold",
  branch: null,
});

// ---- Render holds.

describe("a repository publish holds the current branch", () => {
  it("holds the row's Rename and Delete items, and frees them when it settles", async () => {
    const { user, startPublish, settlePublish } = renderSwitcher();
    await startPublish();
    await openList(user);
    const menu = await openRowMenu(user, "feat");
    for (const name of [HELD_RENAME, HELD_DELETE])
      await waitFor(() =>
        expect(menuItem(menu, name)).toHaveAttribute("aria-disabled", "true"),
      );
    // The app never archives the checked-out branch, publish or not.
    expect(menuItem(menu, "Archive (current branch)")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await settlePublish();
    for (const name of ["Rename branch…", "Delete branch…"])
      await waitFor(() =>
        expect(menuItem(menu, name)).not.toHaveAttribute(
          "aria-disabled",
          "true",
        ),
      );
  });

  it("holds nothing on another branch's row", async () => {
    const { user, startPublish } = renderSwitcher();
    await startPublish();
    await openList(user);
    // The current row reads held first, so the publish has reached the list.
    let menu = await openRowMenu(user, "feat");
    await waitFor(() => menuItem(menu, HELD_RENAME));
    await user.keyboard("{Escape}");
    menu = await openRowMenu(user, "topic");
    for (const name of ["Rename branch…", "Delete branch…", "Archive"])
      expect(menuItem(menu, name)).not.toHaveAttribute("aria-disabled", "true");
  });

  it("keeps holding the published branch after a checkout moves HEAD off it", async () => {
    const { user, queryClient, startPublish } = renderSwitcher();
    // The publish records the branch its checkout's status names at the press.
    await waitFor(() =>
      expect(queryClient.getQueryData(["repo", REPO, "status"])).toBeDefined(),
    );
    await startPublish();
    await act(async () => {
      reads.head = headOn("topic");
      reads.branches = reads.branches.map((b) => ({
        ...b,
        isCurrent: b.name === "topic",
      }));
      void queryClient.invalidateQueries({ queryKey: ["repo", REPO] });
      await new Promise((r) => setTimeout(r, 20));
    });
    await openList(user, "topic");
    let menu = await openRowMenu(user, "feat");
    for (const name of [
      HELD_RENAME,
      HELD_DELETE,
      `Archive (${PUBLISH_HOLD_ITEM_REASON})`,
    ])
      await waitFor(() =>
        expect(menuItem(menu, name)).toHaveAttribute("aria-disabled", "true"),
      );
    await user.keyboard("{Escape}");
    menu = await openRowMenu(user, "topic");
    for (const name of ["Rename branch…", "Delete branch…"])
      expect(menuItem(menu, name)).not.toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    for (const name of ["Rename current branch…", "Delete current branch…"])
      expect(footerRow(name)).not.toHaveAttribute("aria-disabled", "true");
  });

  it("holds both footer rows with the publish reason, and frees them", async () => {
    const { user, startPublish, settlePublish } = renderSwitcher();
    await startPublish();
    await openList(user);
    for (const name of ["Rename current branch…", "Delete current branch…"])
      await waitFor(() => {
        expect(footerRow(name)).toHaveAttribute("aria-disabled", "true");
        expect(footerRow(name)).toHaveAccessibleDescription(
          PUBLISH_HOLD_REASON,
        );
      });
    await settlePublish();
    for (const name of ["Rename current branch…", "Delete current branch…"])
      await waitFor(() =>
        expect(footerRow(name)).not.toHaveAttribute("aria-disabled", "true"),
      );
  });

  it("holds the open delete confirm of the current branch, and frees it", async () => {
    const { user, startPublish, settlePublish } = renderSwitcher();
    await openList(user);
    const menu = await openRowMenu(user, "feat");
    await user.click(menuItem(menu, "Delete branch…"));
    const confirm = () => screen.getByRole("button", { name: "Delete" });
    await waitFor(() =>
      expect(confirm()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await startPublish();
    await waitFor(() => {
      expect(confirm()).toHaveAttribute("aria-disabled", "true");
      expect(confirm()).toHaveAccessibleDescription(PUBLISH_HOLD_REASON);
    });
    await settlePublish();
    await waitFor(() =>
      expect(confirm()).not.toHaveAttribute("aria-disabled", "true"),
    );
  });

  it("leaves another branch's delete confirm free", async () => {
    const { user, startPublish } = renderSwitcher();
    await openList(user);
    const menu = await openRowMenu(user, "topic");
    await user.click(menuItem(menu, "Delete branch…"));
    const confirm = () => screen.getByRole("button", { name: "Delete" });
    await waitFor(() =>
      expect(confirm()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await startPublish();
    await waitFor(() =>
      expect(screen.getByTestId("pending-publishes")).toHaveTextContent("1"),
    );
    await settle();
    expect(confirm()).not.toHaveAttribute("aria-disabled", "true");
  });
});

// ---- Fire-time refusals.

describe("the rename and delete hotkeys while a publish runs", () => {
  it("refuse with the publish sentence and open nothing, then work once it settles", async () => {
    const { startPublish, settlePublish } = renderSwitcher();
    await screen.findByRole("button", { name: /^feat/ });
    await startPublish();
    act(() => {
      dispatchAction("rename-branch");
    });
    expect(info).toHaveBeenCalledWith(RUNNING);
    act(() => {
      dispatchAction("delete-branch");
    });
    expect(info).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenNthCalledWith(2, RUNNING);
    await settle();
    expect(screen.queryByLabelText("New name")).toBe(null);
    expect(useConfirm.getState().request).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBe(null);
    await settlePublish();
    act(() => {
      dispatchAction("rename-branch");
    });
    expect(await screen.findByLabelText("New name")).toBeInTheDocument();
    expect(info).toHaveBeenCalledTimes(2);
  });
});

describe("a current-branch delete that a publish overtakes", () => {
  /** Presses Delete on feat's confirm. */
  async function pressDelete(user: User) {
    await openList(user);
    const menu = await openRowMenu(user, "feat");
    await user.click(menuItem(menu, "Delete branch…"));
    const confirm = screen.getByRole("button", { name: "Delete" });
    await waitFor(() =>
      expect(confirm).not.toHaveAttribute("aria-disabled", "true"),
    );
    await user.click(confirm);
  }

  it("re-checks the publish after the worktree read, before the fallback checkout", async () => {
    const { user, startPublish } = renderSwitcher();
    let answer: (() => void) | null = null;
    await screen.findByRole("button", { name: /^feat/ });
    vi.mocked(listUserWorktrees).mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = () => resolve([]);
        }),
    );
    await pressDelete(user);
    await waitFor(() => expect(answer).not.toBeNull());
    await startPublish();
    await act(async () => {
      answer?.();
      await new Promise((r) => setTimeout(r, 20));
    });
    await waitFor(() => expect(info).toHaveBeenCalledWith(RUNNING));
    expect(gitCheckoutBranch).not.toHaveBeenCalled();
    expect(gitDeleteBranch).not.toHaveBeenCalled();
  });

  it("after the fallback checkout, a publish shows the hold notice and deletes nothing", async () => {
    const { user, startPublish } = renderSwitcher();
    let land: (() => void) | null = null;
    vi.mocked(gitCheckoutBranch).mockImplementation(
      () =>
        new Promise((resolve) => {
          land = () => resolve(undefined);
        }),
    );
    await pressDelete(user);
    await waitFor(() => expect(gitCheckoutBranch).toHaveBeenCalledTimes(1));
    expect(vi.mocked(gitCheckoutBranch).mock.calls[0][1]).toBe("main");
    await startPublish();
    await act(async () => {
      land?.();
      await new Promise((r) => setTimeout(r, 20));
    });
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith(PUBLISH_HOLD_REASON, {
        description: switchedAndKept("main", "feat"),
      }),
    );
    expect(gitDeleteBranch).not.toHaveBeenCalled();
  });

  it("after the fallback checkout, a publish that recorded no branch holds the fallback and the delete proceeds", async () => {
    const { user, queryClient, startPublish } = renderSwitcher();
    let land: (() => void) | null = null;
    vi.mocked(gitCheckoutBranch).mockImplementation(
      () =>
        new Promise((resolve) => {
          land = () => resolve(undefined);
        }),
    );
    await pressDelete(user);
    await waitFor(() => expect(gitCheckoutBranch).toHaveBeenCalledTimes(1));
    // Mid-checkout the status reads detached, so the publish records no branch.
    act(() => {
      queryClient.setQueryData(["repo", REPO, "status"], {
        branch: { ...headOn("feat"), detached: true },
        entries: [],
      });
    });
    await startPublish();
    await act(async () => {
      land?.();
      await new Promise((r) => setTimeout(r, 20));
    });
    await waitFor(() => expect(gitDeleteBranch).toHaveBeenCalledTimes(1));
    expect(vi.mocked(gitDeleteBranch).mock.calls[0][1]).toBe("feat");
    expect(JSON.stringify(info.mock.calls)).not.toContain(PUBLISH_HOLD_REASON);
  });
});

// ---- The dialog: the publish predicate is `remoteStep || target === current`.

const box = () => screen.getByRole("checkbox", { name: /Also rename on/ });
const submit = () => screen.getByRole("button", { name: /Rename( anyway)?$/ });

async function openRenameOf(user: User, name: string) {
  await openList(user);
  const menu = await openRowMenu(user, name);
  await user.click(menuItem(menu, "Rename branch…"));
  return screen.findByLabelText("New name");
}

describe("the rename dialog while a publish runs", () => {
  it("holds another branch's rename only once its remote step is ticked", async () => {
    const { user, startPublish } = renderSwitcher();
    await startPublish();
    const field = await openRenameOf(user, "topic");
    await user.clear(field);
    await user.type(field, "topic2");
    await waitFor(() =>
      expect(submit()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await user.click(box());
    await waitFor(() => {
      expect(submit()).toHaveAttribute("aria-disabled", "true");
      expect(submit()).toHaveAccessibleDescription(PUBLISH_HOLD_REASON);
    });
    await user.click(box());
    await waitFor(() =>
      expect(submit()).not.toHaveAttribute("aria-disabled", "true"),
    );
  });

  it("holds the current branch's local rename, and frees it when the publish settles", async () => {
    const { user, startPublish, settlePublish } = renderSwitcher();
    const field = await openRenameOf(user, "feat");
    await user.clear(field);
    await user.type(field, "feat2");
    await startPublish();
    await waitFor(() => {
      expect(submit()).toHaveAttribute("aria-disabled", "true");
      expect(submit()).toHaveAccessibleDescription(PUBLISH_HOLD_REASON);
    });
    await settlePublish();
    await waitFor(() =>
      expect(submit()).not.toHaveAttribute("aria-disabled", "true"),
    );
  });
});

// ---- When the rename dialog is offered the remote step.

describe("the remote step's offer", () => {
  it("is offered for a live upstream of the same name on a listed remote", async () => {
    const { user } = renderSwitcher();
    await openRenameOf(user, "topic");
    expect(box()).not.toBeChecked();
    expect(box()).not.toHaveAttribute("aria-disabled", "true");
    expect(within(box().closest("label") as HTMLElement).getByText("origin"));
  });

  it.each([
    ["an untracked branch", branchRow({ name: "spike" })],
    ["a gone upstream", trackedRow("spike", { upstreamGone: true })],
    ["a local upstream", trackedRow("spike", {}, ".", "main")],
    ["a cross-name upstream", trackedRow("spike", {}, "origin", "other")],
    ["a remote that isn't listed", trackedRow("spike", {}, "fork")],
  ])("is not offered for %s", async (_, row) => {
    reads.branches.push(row);
    const { user } = renderSwitcher();
    await openRenameOf(user, "spike");
    await settle();
    expect(screen.queryByRole("checkbox")).toBe(null);
  });

  it.each([
    [
      "the remote's default branch",
      { upstreamIsRemoteDefault: true },
      "spike is the default branch on origin",
    ],
    ["a Keep local branch", { keepLocal: true }, "spike is marked Keep local"],
  ])("is offered but can't be ticked for %s", async (_, overrides, reason) => {
    reads.branches.push(trackedRow("spike", overrides));
    const { user } = renderSwitcher();
    await openRenameOf(user, "spike");
    expect(box()).toHaveAttribute("aria-disabled", "true");
    // The dash before the reason is visual only.
    expect(box()).toHaveAccessibleDescription(reason);
    await user.click(box());
    expect(box()).not.toBeChecked();
    expect(gitRemoteRenameCheck).not.toHaveBeenCalled();
  });

  it("is offered but can't be ticked while offline", async () => {
    const { user } = renderSwitcher();
    await openRenameOf(user, "topic");
    await act(async () => {
      onlineManager.setOnline(false);
      await new Promise((r) => setTimeout(r, 20));
    });
    await waitFor(() => expect(box()).toHaveAttribute("aria-disabled", "true"));
    expect(box()).toHaveAccessibleDescription(OFFLINE_ITEM_REASON);
    await user.click(box());
    expect(box()).not.toBeChecked();
    expect(gitRemoteRenameCheck).not.toHaveBeenCalled();
  });
});
