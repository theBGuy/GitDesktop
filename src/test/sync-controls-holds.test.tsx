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
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { SyncControls } from "@/features/repository/SyncControls";
import {
  keptLocalReason,
  SESSION_PULL_REASON,
  sessionBranchPushReason,
} from "@/features/repository/sync-controls-state";
import {
  forgeDetectForkPrForBranch,
  forgeStatus,
  gitBranches,
  gitBranchRewriteStatus,
  gitFetch,
  gitRemoteBranches,
  gitRemotePushUrl,
  gitRemotes,
  gitRemoteUrl,
  gitStatus,
} from "@/lib/git/api";
import { BRANCH_PUSH_ELSEWHERE_MESSAGE, usePush } from "@/lib/git/queries";
import { repoIdentityQueryOptions } from "@/lib/git/repo-identity-query";
import type {
  Branch,
  BranchHead,
  ForkPrMatch,
  RemoteBranch,
} from "@/lib/git/types";
import { dispatchAction } from "@/lib/hotkeys/hotkeys";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

// The push callee is reached only through its spy: publish-hold-routes lets no
// file but its one hook import it by name.
const pushSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitStatus: vi.fn(),
  gitFetch: vi.fn(),
  forgeStatus: vi.fn(),
  gitBranches: vi.fn(),
  gitRemotes: vi.fn(),
  gitRemoteBranches: vi.fn(),
  gitBranchRewriteStatus: vi.fn(),
  gitRemoteUrl: vi.fn(),
  gitRemotePushUrl: vi.fn(),
  forgeDetectForkPrForBranch: vi.fn(),
  gitPush: pushSpy,
}));
// One table answers both identity reads, so they can never disagree: SIBLING is
// another worktree of REPO's repository, every other path its own.
const REPO = "C:/repos/sync";
const SIBLING = "C:/repos/sync-wt";
const OTHER_REPO = "C:/repos/other";
const identityOf = (path: string) =>
  path === SIBLING ? `${REPO}/.git` : `${path}/.git`;
vi.mock("@/lib/git/repo-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/repo-identity")>()),
  peekRepoIdentity: (path: string) => identityOf(path),
  repoIdentityStrict: (path: string) => Promise.resolve(identityOf(path)),
}));

afterAll(() => expect(unmockedCommands).toEqual([]));

const URL_ = "https://example.test/sync.git";

/** HEAD on `name`, tracking `origin/<upstreamBranch>` unless `upstream` is null. */
function headOn(name: string, over: Partial<BranchHead> = {}): BranchHead {
  return {
    name,
    detached: false,
    oid: "abcdef0123456789abcdef0123456789abcdef01",
    upstream: `origin/${name}`,
    ahead: 1,
    behind: 0,
    upstreamGone: false,
    upstreamRemote: "origin",
    upstreamBranch: name,
    pushNameMismatch: false,
    upstreamIsRemoteDefault: false,
    pushRemote: "origin",
    pushBranch: name,
    ...over,
  };
}

/** HEAD on `name` with no upstream (a branch never published). */
const unpublished = (name: string) =>
  headOn(name, {
    upstream: null,
    upstreamRemote: null,
    upstreamBranch: null,
    pushRemote: null,
    pushBranch: null,
    ahead: 0,
  });

function branchRow(name: string, over: Partial<Branch> = {}): Branch {
  return {
    name,
    isCurrent: true,
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
    ...over,
  };
}

interface Reads {
  head: BranchHead;
  branches: Branch[];
  remotes: string[];
  remoteBranches: RemoteBranch[];
}
let reads: Reads;
let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
  reads = {
    head: headOn("feat"),
    branches: [branchRow("feat")],
    remotes: ["origin"],
    remoteBranches: [],
  };
  vi.mocked(gitStatus).mockImplementation(async () => ({
    branch: reads.head,
    entries: [],
  }));
  vi.mocked(gitBranches).mockImplementation(async () => reads.branches);
  vi.mocked(gitRemotes).mockImplementation(async () => reads.remotes);
  vi.mocked(gitRemoteBranches).mockImplementation(
    async () => reads.remoteBranches,
  );
  // The rewrite probe stays unresolved: its verdicts read as false.
  vi.mocked(gitBranchRewriteStatus).mockImplementation(
    () => new Promise(() => undefined),
  );
  // The mount auto-fetch lands at once; the forge read stays pending.
  vi.mocked(gitFetch).mockResolvedValue(undefined);
  vi.mocked(forgeStatus).mockImplementation(() => new Promise(() => undefined));
  vi.mocked(gitRemoteUrl).mockResolvedValue(URL_);
  vi.mocked(gitRemotePushUrl).mockResolvedValue(URL_);
  vi.mocked(forgeDetectForkPrForBranch).mockResolvedValue(null);
  // A push never settles: one started stays pending.
  pushSpy.mockImplementation(() => new Promise(() => undefined));
  info = vi.spyOn(toast, "info");
  useUiStore.setState({ repoPath: REPO });
});

afterEach(() => {
  onlineManager.setOnline(true);
  const pending = useConfirm.getState().request;
  if (pending) act(() => useConfirm.getState().answer(false));
  info.mockRestore();
});

/** One usePush binding per file, not named `push`: a sibling worktree's push. */
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

async function renderBar() {
  const user = userEvent.setup();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <SyncControls repoPath={REPO} />
    </QueryClientProvider>,
  );
  // The status and branch list have landed once Push names HEAD's state.
  await waitFor(() => expect(gitBranches).toHaveBeenCalled());
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /^(Push|Publish branch|Force push)/ }),
    ).toBeInTheDocument(),
  );
  return { user, queryClient };
}

/** Starts `branch`'s push from `path` once its identity has resolved. */
async function startSiblingPush(
  queryClient: QueryClient,
  path: string,
  branch: string,
) {
  render(
    <QueryClientProvider client={queryClient}>
      <PushHarness path={path} name={branch} />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(
      queryClient.getQueryData(repoIdentityQueryOptions(path).queryKey),
    ).toBe(identityOf(path)),
  );
  const calls = pushSpy.mock.calls.length;
  // Not user-event: an open modal confirm hides the page behind it.
  fireEvent.click(
    screen.getByRole("button", {
      name: `start ${branch} in ${path}`,
      hidden: true,
    }),
  );
  await waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(calls + 1));
}

const pushButton = () =>
  screen.getByRole("button", { name: /^(Push|Publish branch|Force push)/ });

/** Lets every pending microtask and the reads they start settle. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

describe("a session HEAD holds Push", () => {
  for (const name of ["gd/session/abc", "GD/Session/Mixed"])
    it(`${name}: Publish branch is held with the session reason and starts nothing`, async () => {
      reads.head = unpublished(name);
      reads.branches = [branchRow(name)];
      const { user } = await renderBar();
      const reason = sessionBranchPushReason(name);
      const control = await screen.findByRole("button", {
        name: `Publish branch — ${reason}`,
      });
      expect(control).toHaveAttribute("aria-disabled", "true");
      expect(control).toHaveAccessibleDescription(reason);
      await user.click(control);
      await settle();
      expect(useConfirm.getState().request).toBeNull();
      expect(pushSpy).not.toHaveBeenCalled();
      expect(forgeDetectForkPrForBranch).not.toHaveBeenCalled();
    });

  it("the session reason outranks a Keep local mark", async () => {
    const name = "gd/session/abc";
    reads.head = unpublished(name);
    reads.branches = [branchRow(name, { keepLocal: true })];
    await renderBar();
    const reason = sessionBranchPushReason(name);
    await screen.findByRole("button", { name: `Publish branch — ${reason}` });
  });

  it("the push hotkey toasts the session reason and asks nothing", async () => {
    const name = "gd/session/abc";
    reads.head = unpublished(name);
    reads.branches = [branchRow(name)];
    await renderBar();
    const reason = sessionBranchPushReason(name);
    await screen.findByRole("button", { name: `Publish branch — ${reason}` });
    act(() => {
      expect(dispatchAction("push")).toBe(true);
    });
    await waitFor(() => expect(info).toHaveBeenCalledWith(reason));
    expect(useConfirm.getState().request).toBeNull();
    expect(pushSpy).not.toHaveBeenCalled();
    expect(forgeDetectForkPrForBranch).not.toHaveBeenCalled();
  });

  it("Pull and its caret name the session, never publishing", async () => {
    const name = "gd/session/abc";
    reads.head = unpublished(name);
    reads.branches = [branchRow(name)];
    await renderBar();
    const reason = SESSION_PULL_REASON.untracked(name, "");
    const pull = await screen.findByRole("button", { name: reason });
    expect(pull).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("button", { name: "Pull options" }),
    ).toHaveAccessibleDescription(reason);
    expect(screen.queryByText(/publish the branch/i)).toBeNull();
  });

  it("offline, the session reason still holds Push and the hotkey still says it", async () => {
    const name = "gd/session/abc";
    reads.head = headOn(name);
    reads.branches = [branchRow(name)];
    await renderBar();
    const reason = sessionBranchPushReason(name);
    await screen.findByRole("button", { name: `Push — ${reason}` });
    act(() => onlineManager.setOnline(false));
    expect(pushButton()).toHaveAccessibleDescription(reason);
    act(() => {
      expect(dispatchAction("push")).toBe(true);
    });
    expect(info).toHaveBeenCalledWith(reason);
    expect(pushSpy).not.toHaveBeenCalled();
  });
});

describe("Keep local and an ordinary HEAD", () => {
  it("the push hotkey on a kept-local HEAD toasts its reason and pushes nothing", async () => {
    reads.branches = [branchRow("feat", { keepLocal: true })];
    await renderBar();
    const reason = keptLocalReason("feat", "push");
    await screen.findByRole("button", { name: `Push — ${reason}` });
    act(() => {
      expect(dispatchAction("push")).toBe(true);
    });
    await waitFor(() => expect(info).toHaveBeenCalledWith(reason));
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("an ordinary tracked HEAD pushes once", async () => {
    const { user } = await renderBar();
    await user.click(pushButton());
    await waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(1));
    expect(info).not.toHaveBeenCalled();
  });

  // The offline row above trusts that the flip reaches the bar; this shows it.
  it("offline, an ordinary tracked HEAD's Push holds with the offline reason", async () => {
    await renderBar();
    expect(pushButton()).not.toHaveAttribute("aria-disabled");
    act(() => onlineManager.setOnline(false));
    await waitFor(() =>
      expect(pushButton()).toHaveAttribute("aria-disabled", "true"),
    );
    expect(pushButton()).toHaveAccessibleDescription(/offline/i);
  });
});

describe("the force-push confirm", () => {
  it("holds its Force push with the session reason once HEAD is on a session branch", async () => {
    reads.head = headOn("feat", { behind: 1 });
    const { user, queryClient } = await renderBar();
    await user.click(pushButton());
    const dialog = await screen.findByRole("dialog", { name: "Force push?" });
    const force = within(dialog).getByRole("button", { name: "Force push" });
    expect(force).not.toHaveAttribute("aria-disabled");
    const name = "gd/session/abc";
    reads.head = headOn(name, { behind: 1 });
    reads.branches = [branchRow(name, { keepLocal: true })];
    // Not awaited: the forge and rewrite reads it also restarts never settle.
    act(() => void queryClient.invalidateQueries());
    const reason = sessionBranchPushReason(name);
    await waitFor(() => expect(force).toHaveAccessibleDescription(reason));
    expect(force).toHaveAttribute("aria-disabled", "true");
    await user.click(force);
    await settle();
    expect(pushSpy).not.toHaveBeenCalled();
  });
});

describe("a sibling worktree pushing the same branch", () => {
  it("Push on HEAD refuses with the elsewhere message", async () => {
    const { user, queryClient } = await renderBar();
    await startSiblingPush(queryClient, SIBLING, "feat");
    await user.click(pushButton());
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith(BRANCH_PUSH_ELSEWHERE_MESSAGE),
    );
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  for (const [what, path, branch] of [
    ["the sibling pushing another branch", SIBLING, "other"],
    ["a different repository pushing feat", OTHER_REPO, "feat"],
  ] as const)
    it(`${what} lets Push start`, async () => {
      const { user, queryClient } = await renderBar();
      await startSiblingPush(queryClient, path, branch);
      await user.click(pushButton());
      await waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(2));
      expect(info).not.toHaveBeenCalledWith(BRANCH_PUSH_ELSEWHERE_MESSAGE);
    });

  it("the mismatch menu's tracked item refuses", async () => {
    reads.head = headOn("feat", {
      upstream: "origin/feat-x",
      upstreamBranch: "feat-x",
      pushNameMismatch: true,
      pushBranch: "feat-x",
    });
    const { user, queryClient } = await renderBar();
    await startSiblingPush(queryClient, SIBLING, "feat");
    await user.click(pushButton());
    await user.click(
      await screen.findByRole("menuitem", { name: /^Push to origin\/feat-x/ }),
    );
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith(BRANCH_PUSH_ELSEWHERE_MESSAGE),
    );
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it("Publish branch refuses before its prompt", async () => {
    reads.head = unpublished("feat");
    const { user, queryClient } = await renderBar();
    await startSiblingPush(queryClient, SIBLING, "feat");
    await user.click(pushButton());
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith(BRANCH_PUSH_ELSEWHERE_MESSAGE),
    );
    expect(useConfirm.getState().request).toBeNull();
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it("Publish branch onto a branch the remote has refuses with no prompt", async () => {
    reads.head = unpublished("feat");
    reads.remoteBranches = [
      { remote: "origin", name: "feat" } as unknown as RemoteBranch,
    ];
    const { user, queryClient } = await renderBar();
    await startSiblingPush(queryClient, SIBLING, "feat");
    await user.click(pushButton());
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith(BRANCH_PUSH_ELSEWHERE_MESSAGE),
    );
    expect(forgeDetectForkPrForBranch).toHaveBeenCalled();
    expect(useConfirm.getState().request).toBeNull();
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it("a fork-PR match landing while a sibling pushes refuses instead of opening the guard", async () => {
    reads.head = unpublished("feat");
    // The remote has feat: no prompt, so the check decides before the push.
    reads.remoteBranches = [
      { remote: "origin", name: "feat" } as unknown as RemoteBranch,
    ];
    let landMatch: (m: ForkPrMatch | null) => void = () => undefined;
    vi.mocked(forgeDetectForkPrForBranch).mockImplementation(
      () =>
        new Promise<ForkPrMatch | null>((resolve) => {
          landMatch = resolve;
        }),
    );
    const { user, queryClient } = await renderBar();
    await user.click(pushButton());
    await waitFor(() => expect(forgeDetectForkPrForBranch).toHaveBeenCalled());
    // Past the pre-check refusals, waiting on the check alone.
    await settle();
    await startSiblingPush(queryClient, SIBLING, "feat");
    await act(async () =>
      landMatch({
        number: 7,
        title: "Fork work",
        url: "https://example.test/pull/7",
        headRefName: "feat",
        headRepoOwner: "someone",
        headRepoName: "sync",
        maintainerCanModify: true,
        aheadCount: 1,
      }),
    );
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith(BRANCH_PUSH_ELSEWHERE_MESSAGE),
    );
    await settle();
    expect(
      screen.queryByText("This branch belongs to a pull request from a fork"),
    ).not.toBeInTheDocument();
    expect(useConfirm.getState().request).toBeNull();
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it("a bare push to a new destination refuses before its prompt", async () => {
    reads.head = headOn("feat", { pushRemote: "fork", pushBranch: "feat" });
    reads.remotes = ["origin", "fork"];
    const { user, queryClient } = await renderBar();
    await startSiblingPush(queryClient, SIBLING, "feat");
    await user.click(pushButton());
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith(BRANCH_PUSH_ELSEWHERE_MESSAGE),
    );
    expect(useConfirm.getState().request).toBeNull();
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it("a bare push whose sibling starts under its prompt refuses after it", async () => {
    reads.head = headOn("feat", { pushRemote: "fork", pushBranch: "feat" });
    reads.remotes = ["origin", "fork"];
    const { user, queryClient } = await renderBar();
    await user.click(pushButton());
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
    await startSiblingPush(queryClient, SIBLING, "feat");
    act(() => useConfirm.getState().answer(true));
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith(BRANCH_PUSH_ELSEWHERE_MESSAGE),
    );
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it("the mismatch menu's publish item refuses after its prompt", async () => {
    reads.head = headOn("feat", {
      upstream: "origin/feat-x",
      upstreamBranch: "feat-x",
      pushNameMismatch: true,
      pushBranch: "feat-x",
    });
    const { user, queryClient } = await renderBar();
    await user.click(pushButton());
    await user.click(
      await screen.findByRole("menuitem", {
        name: /^Publish as origin\/feat/,
      }),
    );
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
    await startSiblingPush(queryClient, SIBLING, "feat");
    act(() => useConfirm.getState().answer(true));
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith(BRANCH_PUSH_ELSEWHERE_MESSAGE),
    );
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });
});
