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
import {
  BRANCH_PUSH_ACTIVE_MESSAGE,
  beginHeaderDetection,
  endHeaderDetection,
  setHeaderDetectionRemote,
  usePush,
} from "@/lib/git/queries";
import { repoIdentityQueryOptions } from "@/lib/git/repo-identity-query";
import type {
  Branch,
  BranchHead,
  ForkPrMatch,
  RemoteBranch,
} from "@/lib/git/types";
import { listUserWorktrees } from "@/lib/git/worktree";
import { dispatchAction } from "@/lib/hotkeys/hotkeys";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

// The harness of branch-switcher-start-point.test.tsx. The push callee is
// reached only through its spy: publish-hold-routes lets no file but its one
// hook import it by name.
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
  // The push and publish routes' reads.
  gitRemoteUrl: vi.fn(),
  gitRemotePushUrl: vi.fn(),
  forgeDetectForkPrForBranch: vi.fn(),
  gitPush: pushSpy,
}));
vi.mock("@/lib/git/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/worktree")>()),
  listUserWorktrees: vi.fn(),
}));

const REPO = "C:/repos/route";
/** Another worktree of REPO's repository. */
const SIBLING = "C:/repos/route-wt";
/** One table answers both identity reads, so they never disagree; a path absent
 *  from it peeks undefined and its strict read never settles. */
const IDENTITIES = new Map<string, string>();
vi.mock("@/lib/git/repo-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/repo-identity")>()),
  peekRepoIdentity: (path: string) => IDENTITIES.get(path),
  repoIdentityStrict: (path: string) => {
    const id = IDENTITIES.get(path);
    return id === undefined
      ? new Promise<string>(() => undefined)
      : Promise.resolve(id);
  },
}));

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

/** `name` tracking origin/<name>, its named push routed to `fork/<name>`. */
const routedRow = (name: string, overrides: Partial<Branch> = {}) =>
  trackingRow(name, "origin", name, {
    upstreamAhead: 1,
    namedPushRemote: "fork",
    namedPushBranch: name,
    ...overrides,
  });

/** A local row with no upstream. */
const untrackedRow = (name: string): Branch => ({
  ...trackingRow(name, "origin", name),
  upstream: null,
  upstreamRemote: null,
  upstreamRemoteRef: null,
});

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

const URL_ = "https://example.test/r.git";
/** The pins object a row push sends: rows pin nothing, `creates` per outcome. */
const pins = (creates: boolean) => ({
  expectedBranch: undefined,
  expectedHead: undefined,
  creates,
});

interface RepoReads {
  branches: Branch[];
  remotes: string[];
  remoteBranches: RemoteBranch[];
}
let reads: RepoReads;
let info: ReturnType<typeof vi.spyOn>;
let success: ReturnType<typeof vi.spyOn>;
/** Header detections a test began, ended after it (the store is a module). */
let headerTokens: object[];

beforeEach(() => {
  vi.clearAllMocks();
  IDENTITIES.clear();
  IDENTITIES.set(REPO, `${REPO}/.git`);
  IDENTITIES.set(SIBLING, `${REPO}/.git`);
  headerTokens = [];
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
    remotes: ["origin", "fork"],
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
  vi.mocked(gitRemoteUrl).mockResolvedValue(URL_);
  vi.mocked(gitRemotePushUrl).mockResolvedValue(URL_);
  vi.mocked(forgeDetectForkPrForBranch).mockResolvedValue(null);
  pushSpy.mockResolvedValue(undefined);
  info = vi.spyOn(toast, "info");
  success = vi.spyOn(toast, "success");
  useUiStore.setState({ repoPath: REPO });
});
afterEach(() => {
  onlineManager.setOnline(true);
  info.mockRestore();
  success.mockRestore();
  for (const t of headerTokens) endHeaderDetection(t);
  if (useConfirm.getState().request)
    act(() => useConfirm.getState().answer(false));
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
  return { user, queryClient };
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

/** The row's spinner, by its label; null when the row paints none. */
const spinner = (row: string, label: string) =>
  document.querySelector(`[data-row="${row}"] [aria-label="${label}"]`);
const anySpinner = (row: string) =>
  document.querySelector(`[data-row="${row}"] .animate-spin`);

const menuItem = (menu: HTMLElement, name: string | RegExp) =>
  within(menu).getByRole("menuitem", { name });

// react-query notifies observers on a later timer; flush it so a negative
// assertion reads the settled render.
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });

/** The push-to-origin hotkey on `name`'s row of the open list. */
async function hotkeyOnRow(name: string) {
  const row = await rowButton(name);
  act(() => row.focus());
  act(() => {
    dispatchAction("push-to-origin");
  });
}

const successTexts = () => JSON.stringify(success.mock.calls);

/** The open confirm's body as text. */
function confirmBody(): string {
  const req = useConfirm.getState().request;
  if (!req) throw new Error("no confirm is open");
  const { container, unmount } = render(<div>{req.body}</div>);
  const text = container.textContent ?? "";
  unmount();
  return text;
}

describe("a row whose push routes to another remote", () => {
  it("names that destination on its Push item", async () => {
    reads.branches.push(routedRow("feat"));
    const { user } = renderSwitcher();
    await openList(user);
    const menu = await openRowMenu(user, "feat");
    const item = menuItem(menu, "Push to fork/feat");
    expect(item.getAttribute("aria-disabled")).not.toBe("true");
    expect(
      within(menu).queryByRole("menuitem", { name: /^Push to origin\/feat/ }),
    ).toBeNull();
  });

  it("holds while diverged, naming the upstream it was measured against", async () => {
    reads.branches.push(routedRow("feat", { upstreamBehind: 1 }));
    const { user } = renderSwitcher();
    await openList(user);
    const menu = await openRowMenu(user, "feat");
    expect(
      menuItem(
        menu,
        "Push to fork/feat (diverged from origin/feat)",
      ).getAttribute("aria-disabled"),
    ).toBe("true");
  });

  // Sending the upstream's remote here would push to origin.
  it("pushes unasked to the destination it already has, naming it in the toast", async () => {
    reads.branches.push(routedRow("feat"));
    reads.remoteBranches = [
      { name: "feat", remote: "fork", lastCommitDate: "2026-11-01" },
    ];
    const { user } = renderSwitcher();
    await openList(user);
    const menu = await openRowMenu(user, "feat");
    await user.click(menuItem(menu, "Push to fork/feat"));
    await waitFor(() =>
      expect(pushSpy).toHaveBeenCalledWith(
        REPO,
        false,
        false,
        "feat",
        "fork",
        undefined,
        pins(false),
      ),
    );
    expect(useConfirm.getState().request).toBeNull();
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("Pushed feat to fork/feat"),
    );
  });

  it("keeps the routed destination while the remotes list is stale", async () => {
    // `fork` was just added: the cached remotes list predates it.
    reads.remotes = ["origin"];
    reads.branches.push(routedRow("feat"));
    reads.remoteBranches = [
      { name: "feat", remote: "fork", lastCommitDate: "2026-11-01" },
    ];
    const { user } = renderSwitcher();
    await openList(user);
    const menu = await openRowMenu(user, "feat");
    await user.click(menuItem(menu, "Push to fork/feat"));
    await waitFor(() =>
      expect(pushSpy).toHaveBeenCalledWith(
        REPO,
        false,
        false,
        "feat",
        "fork",
        undefined,
        pins(false),
      ),
    );
  });

  it("asks before creating it there, then sends creates with no tracking claim", async () => {
    reads.branches.push(routedRow("feat"));
    reads.remoteBranches = [
      { name: "feat", remote: "origin", lastCommitDate: "2026-11-01" },
    ];
    const { user } = renderSwitcher();
    await openList(user);
    const menu = await openRowMenu(user, "feat");
    await user.click(menuItem(menu, "Push to fork/feat"));
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
    expect(confirmBody()).toContain("fork");
    expect(pushSpy).not.toHaveBeenCalled();
    act(() => useConfirm.getState().answer(true));
    await waitFor(() =>
      expect(pushSpy).toHaveBeenCalledWith(
        REPO,
        false,
        false,
        "feat",
        "fork",
        undefined,
        pins(true),
      ),
    );
    await waitFor(() => expect(success).toHaveBeenCalled());
    expect(successTexts()).toContain("Published feat to fork");
    expect(successTexts()).not.toContain("tracks");
  });

  // The push sets no upstream, so the toast never says the branch tracks it.
  it("a push URL the fetch side can't vouch for asks, and never claims tracking", async () => {
    reads.branches.push(routedRow("feat"));
    reads.remoteBranches = [
      { name: "feat", remote: "fork", lastCommitDate: "2026-11-01" },
    ];
    vi.mocked(gitRemotePushUrl).mockImplementation(async (_repo, remote) =>
      remote === "fork" ? "https://push.example.test/elsewhere.git" : URL_,
    );
    const { user } = renderSwitcher();
    await openList(user);
    const menu = await openRowMenu(user, "feat");
    await user.click(menuItem(menu, "Push to fork/feat"));
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
    act(() => useConfirm.getState().answer(true));
    await waitFor(() =>
      expect(pushSpy).toHaveBeenCalledWith(
        REPO,
        false,
        false,
        "feat",
        "fork",
        undefined,
        pins(false),
      ),
    );
    await waitFor(() => expect(success).toHaveBeenCalled());
    expect(success).toHaveBeenCalledWith("Pushed feat to fork/feat", {
      description: undefined,
    });
    expect(successTexts()).not.toContain("tracks");
  });

  it("holds a second press at once while its reads run", async () => {
    reads.branches.push(
      routedRow("feat"),
      trackingRow("dev", "origin", "dev", { upstreamAhead: 1 }),
    );
    reads.remoteBranches = [
      { name: "feat", remote: "fork", lastCommitDate: "2026-11-01" },
    ];
    let landUrl: (url: string) => void = () => undefined;
    vi.mocked(gitRemoteUrl).mockImplementation((_repo, remote) =>
      remote === "fork"
        ? new Promise<string>((resolve) => {
            landUrl = resolve;
          })
        : Promise.resolve(URL_),
    );
    const { user } = renderSwitcher();
    await openList(user);
    await user.click(
      menuItem(await openRowMenu(user, "feat"), "Push to fork/feat"),
    );
    await waitFor(() =>
      expect(spinner("feat", "Preparing to push to fork")).not.toBeNull(),
    );
    await hotkeyOnRow("dev");
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith(BRANCH_PUSH_ACTIVE_MESSAGE),
    );
    const menu = await openRowMenu(user, "feat");
    expect(
      menuItem(menu, "Push to fork/feat (pushing…)").getAttribute(
        "aria-disabled",
      ),
    ).toBe("true");
    expect(pushSpy).not.toHaveBeenCalled();
    act(() => landUrl(URL_));
    await waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(1));
    expect(pushSpy.mock.calls[0][4]).toBe("fork");
  });

  it("a refused route names no destination and sends no remote", async () => {
    reads.branches.push(
      trackingRow("feat", "origin", "feat", {
        upstreamAhead: 1,
        namedPushRefused: true,
      }),
    );
    const { user } = renderSwitcher();
    await openList(user);
    const menu = await openRowMenu(user, "feat");
    await user.click(menuItem(menu, "Push"));
    await waitFor(() =>
      expect(pushSpy).toHaveBeenCalledWith(
        REPO,
        false,
        false,
        "feat",
        undefined,
        undefined,
        pins(false),
      ),
    );
  });

  it("an unknown route keeps the upstream's label and sends its remote", async () => {
    reads.remotes = ["origin", "up"];
    reads.branches.push(
      trackingRow("feat", "up", "feat", { upstreamAhead: 1 }),
    );
    const { user } = renderSwitcher();
    await openList(user);
    const menu = await openRowMenu(user, "feat");
    await user.click(menuItem(menu, "Push to up/feat"));
    await waitFor(() =>
      expect(pushSpy).toHaveBeenCalledWith(
        REPO,
        false,
        false,
        "feat",
        "up",
        undefined,
        pins(false),
      ),
    );
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("Pushed feat to up/feat"),
    );
  });
});

// Each of these would push to origin, untoasted, if the hotkey ignored the route.
describe("the push-to-origin hotkey on a branch routed elsewhere", () => {
  it("from the list, routed by its push config with a live Push item, points to its context menu", async () => {
    reads.branches.push(routedRow("feat"));
    const { user } = renderSwitcher();
    await openList(user);
    await hotkeyOnRow("feat");
    await waitFor(() => expect(info).toHaveBeenCalled());
    expect(info).toHaveBeenCalledWith(
      "feat pushes to fork/feat, not origin — push it from its context menu",
    );
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("from the list, with nothing to push, names only where it goes", async () => {
    reads.branches.push(routedRow("feat", { upstreamAhead: 0 }));
    const { user } = renderSwitcher();
    await openList(user);
    await hotkeyOnRow("feat");
    await waitFor(() => expect(info).toHaveBeenCalled());
    expect(info).toHaveBeenCalledWith("feat pushes to fork/feat, not origin");
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("on the current branch, points to the sync bar", async () => {
    reads.branches = [
      trackingRow("main", "origin", "main", {
        isCurrent: true,
        upstreamIsRemoteDefault: true,
        namedPushRemote: "fork",
        namedPushBranch: "main",
      }),
    ];
    const { user } = renderSwitcher();
    await openList(user);
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Filter branches")).toBeNull(),
    );
    act(() => {
      dispatchAction("push-to-origin");
    });
    await waitFor(() => expect(info).toHaveBeenCalled());
    expect(info).toHaveBeenCalledWith(
      "main pushes to fork/main, not origin — use the sync bar's Push instead",
    );
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("from the list, a route to a start point on the remote's default leaves it to the tracking toast", async () => {
    // feat started from fork/main, fork's default: its row offers only the
    // publish, so the toast must not point at a Push item.
    reads.branches.push(
      trackingRow("feat", "fork", "main", {
        upstreamAhead: 1,
        upstreamIsRemoteDefault: true,
        namedPushRemote: "fork",
        namedPushBranch: "main",
      }),
    );
    const { user } = renderSwitcher();
    await openList(user);
    await hotkeyOnRow("feat");
    await waitFor(() => expect(info).toHaveBeenCalled());
    expect(info).toHaveBeenCalledWith(
      "feat tracks fork/main, where it started — publish it as fork/feat from its context menu",
    );
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("a refused route falls through to the plain push, sending no remote", async () => {
    reads.branches.push(
      trackingRow("feat", "origin", "feat", {
        upstreamAhead: 1,
        namedPushRefused: true,
      }),
    );
    const { user } = renderSwitcher();
    await openList(user);
    await hotkeyOnRow("feat");
    await waitFor(() =>
      expect(pushSpy).toHaveBeenCalledWith(
        REPO,
        false,
        false,
        "feat",
        undefined,
        undefined,
        pins(false),
      ),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain("not origin");
  });
});

// The list reads the bar's check from the shared store: the bar may be another
// mount, or none.
describe("the sync bar's publish check, seen from the list", () => {
  function beginHeader(branch: string) {
    let token: object = {};
    act(() => {
      token = beginHeaderDetection(REPO, branch);
    });
    headerTokens.push(token);
    return token;
  }

  it("paints the row Preparing and holds its Push, Publish and Rename items", async () => {
    reads.remotes = ["origin"];
    reads.branches.push(
      trackingRow("feat", "origin", "feat", { upstreamAhead: 1 }),
      untrackedRow("solo"),
      trackingRow("dev", "origin", "dev", { upstreamAhead: 1 }),
    );
    const { user } = renderSwitcher();
    await openList(user);
    await rowButton("feat");
    const token = beginHeader("feat");
    await waitFor(() =>
      expect(spinner("feat", "Preparing to push")).not.toBeNull(),
    );
    act(() => setHeaderDetectionRemote(token, "origin"));
    await waitFor(() =>
      expect(spinner("feat", "Preparing to push to origin")).not.toBeNull(),
    );
    const menu = await openRowMenu(user, "feat");
    for (const name of [
      "Push to origin/feat (pushing…)",
      "Rename branch… (pushing…)",
    ])
      expect(menuItem(menu, name).getAttribute("aria-disabled")).toBe("true");
    const soloMenu = await openRowMenu(user, "solo");
    expect(
      menuItem(soloMenu, "Publish branch (a push is running)").getAttribute(
        "aria-disabled",
      ),
    ).toBe("true");
    await hotkeyOnRow("dev");
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith(BRANCH_PUSH_ACTIVE_MESSAGE),
    );
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("frees the row when the check settles", async () => {
    reads.remotes = ["origin"];
    reads.branches.push(
      trackingRow("feat", "origin", "feat", { upstreamAhead: 1 }),
    );
    const { user } = renderSwitcher();
    await openList(user);
    await rowButton("feat");
    const token = beginHeader("feat");
    await waitFor(() =>
      expect(spinner("feat", "Preparing to push")).not.toBeNull(),
    );
    act(() => endHeaderDetection(token));
    await waitFor(() => expect(anySpinner("feat")).toBeNull());
    const menu = await openRowMenu(user, "feat");
    expect(
      menuItem(menu, "Push to origin/feat").getAttribute("aria-disabled"),
    ).not.toBe("true");
  });

  it("an older press's late settle leaves a newer press's entry", async () => {
    reads.remotes = ["origin"];
    reads.branches.push(
      trackingRow("feat", "origin", "feat", { upstreamAhead: 1 }),
      trackingRow("dev", "origin", "dev", { upstreamAhead: 1 }),
    );
    const { user } = renderSwitcher();
    await openList(user);
    await rowButton("feat");
    const older = beginHeader("feat");
    const newer = beginHeader("dev");
    act(() => setHeaderDetectionRemote(older, "origin"));
    act(() => endHeaderDetection(older));
    await waitFor(() =>
      expect(spinner("dev", "Preparing to push")).not.toBeNull(),
    );
    expect(anySpinner("feat")).toBeNull();
    act(() => endHeaderDetection(newer));
    await waitFor(() => expect(anySpinner("dev")).toBeNull());
  });
});

/** Starts a push of branch `name` from another checkout; it never settles. */
function PushHarness(props: { path: string; name: string }) {
  const harnessPush = usePush(props.path);
  return (
    <button
      type="button"
      onClick={() =>
        void harnessPush.mutateAsync({ setUpstream: false, branch: props.name })
      }
    >
      start {props.name} in {props.path}
    </button>
  );
}

// The list opts into pushes another checkout of the repository files.
describe("another worktree's push, seen from the list", () => {
  async function pushFromSibling(branch: string, waitIdentity = true) {
    pushSpy.mockImplementation(() => new Promise(() => undefined));
    const { user, queryClient } = renderSwitcher();
    render(
      <QueryClientProvider client={queryClient}>
        <PushHarness path={SIBLING} name={branch} />
      </QueryClientProvider>,
    );
    // A push filed before its own checkout's identity is path-keyed.
    await waitFor(() =>
      expect(
        queryClient.getQueryData(repoIdentityQueryOptions(SIBLING).queryKey),
      ).toBeDefined(),
    );
    if (waitIdentity)
      await waitFor(() =>
        expect(
          queryClient.getQueryData(repoIdentityQueryOptions(REPO).queryKey),
        ).toBeDefined(),
      );
    // Not user-event: an open list hides the page behind it.
    fireEvent.click(
      screen.getByRole("button", {
        name: `start ${branch} in ${SIBLING}`,
        hidden: true,
      }),
    );
    await waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(1));
    return { user };
  }

  it("paints its row and holds its Push item", async () => {
    reads.branches.push(
      trackingRow("feat", "origin", "feat", { upstreamAhead: 1 }),
      trackingRow("dev", "origin", "dev", { upstreamAhead: 1 }),
    );
    const { user } = await pushFromSibling("feat");
    await openList(user);
    await waitFor(() =>
      expect(spinner("feat", "Pushing from another worktree")).not.toBeNull(),
    );
    expect(anySpinner("dev")).toBeNull();
    const menu = await openRowMenu(user, "feat");
    expect(
      menuItem(
        menu,
        "Push to origin/feat (another worktree is pushing)",
      ).getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("paints nothing while this checkout's identity is unresolved", async () => {
    IDENTITIES.delete(REPO);
    reads.branches.push(
      trackingRow("feat", "origin", "feat", { upstreamAhead: 1 }),
    );
    const { user } = await pushFromSibling("feat", false);
    await openList(user);
    await rowButton("feat");
    await settle();
    expect(anySpinner("feat")).toBeNull();
    const menu = await openRowMenu(user, "feat");
    expect(
      menuItem(menu, "Push to origin/feat").getAttribute("aria-disabled"),
    ).not.toBe("true");
  });

  it("a branch named like an Object.prototype member paints only its own row", async () => {
    reads.branches.push(
      trackingRow("constructor", "origin", "constructor", { upstreamAhead: 1 }),
      trackingRow("toString", "origin", "toString", { upstreamAhead: 1 }),
      trackingRow("feat", "origin", "feat", { upstreamAhead: 1 }),
    );
    const { user } = await pushFromSibling("constructor");
    await openList(user);
    await waitFor(() =>
      expect(
        spinner("constructor", "Pushing from another worktree"),
      ).not.toBeNull(),
    );
    expect(anySpinner("toString")).toBeNull();
    expect(anySpinner("feat")).toBeNull();
    const own = await openRowMenu(user, "constructor");
    expect(
      menuItem(
        own,
        "Push to origin/constructor (another worktree is pushing)",
      ).getAttribute("aria-disabled"),
    ).toBe("true");
    const menu = await openRowMenu(user, "feat");
    expect(
      menuItem(menu, "Push to origin/feat").getAttribute("aria-disabled"),
    ).not.toBe("true");
  });
});

const FORK_URL = "https://github.com/alice/r.git";
const GUARD_TITLE = "This branch belongs to a pull request from a fork";
const forkMatch = (overrides: Partial<ForkPrMatch> = {}): ForkPrMatch => ({
  number: 7,
  title: "Add feat",
  url: "https://github.com/acme/r/pull/7",
  headRefName: "feat",
  headRepoOwner: "alice",
  headRepoName: "r",
  maintainerCanModify: true,
  aheadCount: 1,
  ...overrides,
});

describe("publishing to the fork pull request's own head", () => {
  beforeEach(() => {
    reads.branches.push(untrackedRow("feat"));
    vi.mocked(gitRemoteUrl).mockImplementation(async (_repo, remote) =>
      remote === "fork" ? FORK_URL : URL_,
    );
    vi.mocked(gitRemotePushUrl).mockImplementation(async (_repo, remote) =>
      remote === "fork" ? FORK_URL : URL_,
    );
  });

  async function publishToFork() {
    const { user } = renderSwitcher();
    await openList(user);
    const menu = await openRowMenu(user, "feat");
    await user.click(menuItem(menu, "Publish to fork"));
  }

  it("a match that IS the destination opens no guard and asks to publish", async () => {
    vi.mocked(forgeDetectForkPrForBranch).mockResolvedValue(forkMatch());
    await publishToFork();
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
    expect(screen.queryByText(GUARD_TITLE)).toBeNull();
    act(() => useConfirm.getState().answer(true));
    await waitFor(() =>
      expect(pushSpy).toHaveBeenCalledWith(
        REPO,
        false,
        false,
        "feat",
        "fork",
        undefined,
        pins(true),
      ),
    );
    expect(screen.queryByText(GUARD_TITLE)).toBeNull();
  });

  it("with the destination's branch already there, it pushes with no guard", async () => {
    reads.remoteBranches = [
      { name: "feat", remote: "fork", lastCommitDate: "2026-11-01" },
    ];
    vi.mocked(forgeDetectForkPrForBranch).mockResolvedValue(forkMatch());
    await publishToFork();
    await waitFor(() => expect(pushSpy).toHaveBeenCalled());
    expect(pushSpy.mock.calls[0][4]).toBe("fork");
    expect(screen.queryByText(GUARD_TITLE)).toBeNull();
    expect(useConfirm.getState().request).toBeNull();
  });

  for (const [what, match] of [
    ["another repository", forkMatch({ headRepoOwner: "bob" })],
    ["another branch name", forkMatch({ headRefName: "feat-2" })],
  ] as const)
    it(`a match on ${what} still opens the guard`, async () => {
      vi.mocked(forgeDetectForkPrForBranch).mockResolvedValue(match);
      await publishToFork();
      expect(await screen.findByText(GUARD_TITLE)).toBeTruthy();
      expect(pushSpy).not.toHaveBeenCalled();
    });
});
