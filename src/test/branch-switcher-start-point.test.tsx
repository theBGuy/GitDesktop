import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
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
  forgeDetectForkPrForBranch,
  forgeStatus,
  getSecret,
  gitBranchDivergence,
  gitBranches,
  gitBranchRewriteStatus,
  gitDefaultBranch,
  gitRemoteBranches,
  gitRemotePushUrl,
  gitRemotes,
  gitRemoteUrl,
  gitStashCount,
  gitStatus,
  readRepoBranchRules,
} from "@/lib/git/api";
import type { Branch, BranchHead, RemoteBranch } from "@/lib/git/types";
import { listUserWorktrees } from "@/lib/git/worktree";
import { dispatchAction } from "@/lib/hotkeys/hotkeys";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

// The harness of branch-switcher-keep-local.test.tsx, plus the reads a publish
// makes. The push callee is reached only through its spy: publish-hold-routes
// lets no file but its one hook import it by name.
const pushSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitStatus: vi.fn(),
  gitBranches: vi.fn(),
  gitBranchDivergence: vi.fn(),
  gitBranchRewriteStatus: vi.fn(),
  gitRemotes: vi.fn(),
  gitRemoteBranches: vi.fn(),
  gitDefaultBranch: vi.fn(),
  gitStashCount: vi.fn(),
  readRepoBranchRules: vi.fn(),
  forgeStatus: vi.fn(),
  getSecret: vi.fn(),
  // The publish route's reads.
  gitRemoteUrl: vi.fn(),
  gitRemotePushUrl: vi.fn(),
  forgeDetectForkPrForBranch: vi.fn(),
  gitPush: pushSpy,
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

const REPO = "C:/repos/start";

// The virtualized list sizes its viewport from clientWidth/clientHeight, which
// jsdom leaves at 0 (no row would paint).
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

/** A local row tracking `remote/upstreamBranch`; untracked fields default off. */
function trackingRow(
  name: string,
  remote: string,
  upstreamBranch: string,
  overrides: Partial<Branch> = {},
): Branch {
  return {
    name,
    isCurrent: false,
    upstream: `${remote}/${upstreamBranch}`,
    lastCommitDate: "2026-11-01T10:00:00Z",
    archived: false,
    upstreamAhead: 0,
    upstreamBehind: 0,
    upstreamGone: false,
    upstreamRemote: remote,
    upstreamRemoteRef: `refs/heads/${upstreamBranch}`,
    keepLocal: false,
    upstreamIsRemoteDefault: false,
    ...overrides,
  };
}

const HEAD: BranchHead = {
  name: "main",
  detached: false,
  oid: "abcdef0123456789abcdef0123456789abcdef01",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  upstreamGone: false,
  upstreamRemote: "origin",
  upstreamBranch: "main",
  pushNameMismatch: false,
  upstreamIsRemoteDefault: null,
  pushRemote: "origin",
  pushBranch: "main",
};

interface RepoReads {
  branches: Branch[];
  remotes: string[];
  remoteBranches: RemoteBranch[];
}
let reads: RepoReads;
let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
  reads = {
    branches: [
      trackingRow("main", "origin", "main", {
        isCurrent: true,
        upstreamIsRemoteDefault: true,
      }),
    ],
    remotes: ["origin"],
    remoteBranches: [],
  };
  vi.mocked(gitStatus).mockImplementation(async () => ({
    branch: HEAD,
    entries: [],
  }));
  vi.mocked(gitBranches).mockImplementation(async () => reads.branches);
  vi.mocked(gitRemotes).mockImplementation(async () => reads.remotes);
  vi.mocked(gitRemoteBranches).mockImplementation(
    async () => reads.remoteBranches,
  );
  vi.mocked(gitDefaultBranch).mockResolvedValue("main");
  vi.mocked(gitBranchDivergence).mockResolvedValue([]);
  vi.mocked(gitBranchRewriteStatus).mockResolvedValue({
    remoteRewritten: null,
    localOnly: 0,
    remoteOnly: 0,
    patchEqual: 0,
    upstream: null,
    upstreamTip: null,
    localTip: null,
  });
  vi.mocked(gitStashCount).mockResolvedValue(0);
  vi.mocked(readRepoBranchRules).mockResolvedValue(null);
  vi.mocked(getSecret).mockResolvedValue(null);
  vi.mocked(forgeStatus).mockImplementation(() => new Promise(() => undefined));
  vi.mocked(listUserWorktrees).mockResolvedValue([]);
  vi.mocked(gitRemoteUrl).mockResolvedValue("https://example.test/r.git");
  vi.mocked(gitRemotePushUrl).mockResolvedValue("https://example.test/r.git");
  vi.mocked(forgeDetectForkPrForBranch).mockResolvedValue(null);
  pushSpy.mockResolvedValue(undefined);
  info = vi.spyOn(toast, "info");
  useUiStore.setState({ repoPath: REPO });
});
afterEach(() => {
  onlineManager.setOnline(true);
  info.mockRestore();
  if (useConfirm.getState().request) useConfirm.getState().answer(false);
});

type User = ReturnType<typeof userEvent.setup>;

function renderSwitcher() {
  const user = userEvent.setup();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <BranchSwitcher repoPath={REPO} />
    </QueryClientProvider>,
  );
  return { user };
}

async function openList(user: User) {
  await user.click(await screen.findByRole("button", { name: /^main/ }));
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

const START_MARKER =
  /^Not published\. Tracks origin\/main, where it started\. \S+ to publish\.$/;

/** `feat`, created from origin/main and still tracking it. */
const startPointRow = (overrides: Partial<Branch> = {}) =>
  trackingRow("feat", "origin", "main", {
    upstreamIsRemoteDefault: true,
    ...overrides,
  });

describe("a branch tracking the remote's default branch under another name", () => {
  it("reads as not published, and its menu offers Publish as, never a push into the default", async () => {
    reads.branches.push(startPointRow({ upstreamAhead: 2 }));
    const { user } = renderSwitcher();
    await openList(user);
    const row = await rowButton("feat");
    expect(within(row).getByRole("img", { name: START_MARKER })).toBeTruthy();
    expect(within(row).queryByRole("img", { name: /to push/ })).toBeNull();
    const menu = await openRowMenu(user, "feat");
    expect(
      within(menu).queryByRole("menuitem", { name: /^Push to origin\/main/ }),
    ).toBeNull();
    const publish = within(menu).getByRole("menuitem", {
      name: "Publish as origin/feat",
    });
    expect(publish.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("keeps Publish as live while behind", async () => {
    reads.branches.push(startPointRow({ upstreamBehind: 1 }));
    const { user } = renderSwitcher();
    await openList(user);
    const menu = await openRowMenu(user, "feat");
    const publish = within(menu).getByRole("menuitem", {
      name: "Publish as origin/feat",
    });
    expect(publish.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("asks the publish confirm when the remote lacks the name, then pushes with set-upstream", async () => {
    reads.branches.push(startPointRow({ upstreamAhead: 2 }));
    const { user } = renderSwitcher();
    await openList(user);
    const menu = await openRowMenu(user, "feat");
    await user.click(
      within(menu).getByRole("menuitem", { name: "Publish as origin/feat" }),
    );
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
    expect(pushSpy).not.toHaveBeenCalled();
    act(() => useConfirm.getState().answer(true));
    await waitFor(() =>
      expect(pushSpy).toHaveBeenCalledWith(
        REPO,
        true,
        false,
        "feat",
        "origin",
        undefined,
      ),
    );
  });

  it("pushes and tracks unasked when the remote already has the name", async () => {
    reads.branches.push(startPointRow({ upstreamAhead: 2 }));
    reads.remoteBranches = [
      { name: "feat", remote: "origin", lastCommitDate: "2026-11-01" },
    ];
    const { user } = renderSwitcher();
    await openList(user);
    const menu = await openRowMenu(user, "feat");
    await user.click(
      await within(menu).findByRole("menuitem", {
        name: "Push to origin/feat and track it",
      }),
    );
    await waitFor(() =>
      expect(pushSpy).toHaveBeenCalledWith(
        REPO,
        true,
        false,
        "feat",
        "origin",
        undefined,
      ),
    );
    expect(useConfirm.getState().request).toBeNull();
  });
});

describe("a branch tracking another differently named branch", () => {
  it("keeps its arrows naming the upstream, and holds both pushes while diverged", async () => {
    reads.branches.push(
      trackingRow("feat", "origin", "epic/x", {
        upstreamAhead: 2,
        upstreamBehind: 1,
      }),
    );
    const { user } = renderSwitcher();
    await openList(user);
    const row = await rowButton("feat");
    const arrows = within(row).getByRole("img", {
      name: "2 to push, 1 to pull — vs origin/epic/x",
    });
    expect(arrows.textContent).toContain("origin/epic/x");
    const menu = await openRowMenu(user, "feat");
    for (const name of [
      "Push to origin/epic/x (diverged)",
      "Publish as origin/feat (pull first)",
    ])
      expect(
        within(menu)
          .getByRole("menuitem", { name })
          .getAttribute("aria-disabled"),
      ).toBe("true");
  });
});

describe("the push-to-origin hotkey on a start-point row", () => {
  async function pressOn(name: string) {
    const { user } = renderSwitcher();
    await openList(user);
    const row = await rowButton(name);
    act(() => row.focus());
    act(() => {
      dispatchAction("push-to-origin");
    });
    await waitFor(() => expect(info).toHaveBeenCalled());
  }

  it("says to publish it from its context menu", async () => {
    reads.branches.push(startPointRow({ upstreamAhead: 2 }));
    await pressOn("feat");
    expect(info).toHaveBeenCalledWith(
      "feat tracks origin/main, where it started — publish it from its context menu",
    );
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("names the destination for a start point on another remote", async () => {
    reads.remotes = ["origin", "up"];
    reads.branches.push(
      trackingRow("feat", "up", "main", {
        upstreamAhead: 2,
        upstreamIsRemoteDefault: true,
      }),
    );
    await pressOn("feat");
    expect(info).toHaveBeenCalledWith(
      "feat tracks up/main, where it started — publish it as up/feat from its context menu",
    );
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("keeps the push wording for a same-named branch of another remote", async () => {
    reads.remotes = ["origin", "up"];
    reads.branches.push(
      trackingRow("feat", "up", "feat", { upstreamAhead: 2 }),
    );
    await pressOn("feat");
    expect(info).toHaveBeenCalledWith(
      "feat tracks up — push it from its context menu",
    );
    expect(pushSpy).not.toHaveBeenCalled();
  });
});

describe("a start-point row whose own name the remote already has", () => {
  const HAS_BRANCH_MARKER =
    /^Tracks origin\/main, where it started\. origin\/feat exists\. \S+ to track it\.$/;

  /** Opens the list and waits for the remote-branches read to relabel `feat`. */
  async function openWithRemoteFeat(remote = "origin") {
    reads.remoteBranches = [
      { name: "feat", remote, lastCommitDate: "2026-11-01" },
    ];
    const { user } = renderSwitcher();
    await openList(user);
    await waitFor(() =>
      expect(vi.mocked(gitRemoteBranches).mock.calls.length).toBeGreaterThan(0),
    );
    return { user, row: await rowButton("feat") };
  }

  // Control: BranchSwitcher passing `false` keeps the not-published label.
  it("its marker says the remote's branch exists and points to tracking it", async () => {
    reads.branches.push(startPointRow({ upstreamAhead: 2 }));
    const { row } = await openWithRemoteFeat();
    const marker = await waitFor(() =>
      within(row).getByRole("img", { name: HAS_BRANCH_MARKER }),
    );
    expect(marker.getAttribute("title")).toMatch(HAS_BRANCH_MARKER);
    expect(within(row).queryByRole("img", { name: START_MARKER })).toBeNull();
  });

  it("keeps the not-published label when the remote has another branch only", async () => {
    reads.branches.push(startPointRow({ upstreamAhead: 2 }));
    reads.remoteBranches = [
      { name: "other", remote: "origin", lastCommitDate: "2026-11-01" },
    ];
    const { user } = renderSwitcher();
    await openList(user);
    await waitFor(() => expect(gitRemoteBranches).toHaveBeenCalled());
    const row = await rowButton("feat");
    const marker = within(row).getByRole("img", { name: START_MARKER });
    expect(marker.getAttribute("title")).toMatch(START_MARKER);
  });

  it("a kept-local row shows no marker either way", async () => {
    reads.branches.push(startPointRow({ upstreamAhead: 2, keepLocal: true }));
    const { row } = await openWithRemoteFeat();
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(
      within(row).queryByRole("img", { name: HAS_BRANCH_MARKER }),
    ).toBeNull();
    expect(within(row).queryByRole("img", { name: START_MARKER })).toBeNull();
  });

  // Control: drop the has-branch hotkey case; the publish sentence comes back.
  it("the push-to-origin hotkey says to track it from its context menu", async () => {
    reads.branches.push(startPointRow({ upstreamAhead: 2 }));
    const { row } = await openWithRemoteFeat();
    await waitFor(() =>
      within(row).getByRole("img", { name: HAS_BRANCH_MARKER }),
    );
    act(() => row.focus());
    act(() => {
      dispatchAction("push-to-origin");
    });
    await waitFor(() => expect(info).toHaveBeenCalled());
    expect(info).toHaveBeenCalledWith(
      "feat tracks origin/main, where it started. origin/feat exists, so track it from its context menu",
    );
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("names the other remote's branch for a start point there", async () => {
    reads.remotes = ["origin", "up"];
    reads.branches.push(
      trackingRow("feat", "up", "main", {
        upstreamAhead: 2,
        upstreamIsRemoteDefault: true,
      }),
    );
    const { row } = await openWithRemoteFeat("up");
    await waitFor(() =>
      within(row).getByRole("img", {
        name: /^Tracks up\/main, where it started\. up\/feat exists\./,
      }),
    );
    act(() => row.focus());
    act(() => {
      dispatchAction("push-to-origin");
    });
    await waitFor(() => expect(info).toHaveBeenCalled());
    expect(info).toHaveBeenCalledWith(
      "feat tracks up/main, where it started. up/feat exists, so track it from its context menu",
    );
    expect(pushSpy).not.toHaveBeenCalled();
  });
});
