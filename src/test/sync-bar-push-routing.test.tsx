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
import { PUBLISH_FORK_CHECK_REASON } from "@/features/repository/publish-confirm";
import { SyncControls } from "@/features/repository/SyncControls";
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
import {
  branchPushHoldReason,
  endHeaderDetection,
  headerDetectionFor,
  repoStatusOptions,
  useRenameBranchOnRemote,
} from "@/lib/git/queries";
import { repoIdentityQueryOptions } from "@/lib/git/repo-identity-query";
import type {
  Branch,
  BranchHead,
  ForkPrMatch,
  RemoteBranch,
} from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

// The push and remote rename callees are reached only through their spies:
// publish-hold-routes lets no file but each one's hook import it by name.
const pushSpy = vi.hoisted(() => vi.fn());
const renameRemoteSpy = vi.hoisted(() => vi.fn());
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
  gitRenameBranchRemote: renameRemoteSpy,
}));
const REPO = "C:/repos/routing";
const OTHER_REPO = "C:/repos/routing-other";
vi.mock("@/lib/git/repo-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/repo-identity")>()),
  peekRepoIdentity: (path: string) => `${path}/.git`,
  repoIdentityStrict: (path: string) => Promise.resolve(`${path}/.git`),
}));

afterAll(() => expect(unmockedCommands).toEqual([]));

const ORIGIN_URL = "https://example.test/routing.git";
// Forge-shaped, so the fork guard's condition can read its slug.
const FORK_URL = "https://github.com/someone/routing.git";
const OID = "abcdef0123456789abcdef0123456789abcdef01";
const MOVED_OID = "0123456789abcdef0123456789abcdef01234567";
const GUARD_TEXT = "This branch belongs to a pull request from a fork";

function headOn(name: string, over: Partial<BranchHead> = {}): BranchHead {
  return {
    name,
    detached: false,
    oid: OID,
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

/** The backend routes a named push of `name` to `fork/<name>`. */
const routedToFork = (name: string) =>
  branchRow(name, { namedPushRemote: "fork", namedPushBranch: name });

const remoteHas = (remote: string, name: string) =>
  ({ remote, name }) as unknown as RemoteBranch;

function forkMatch(
  owner: string,
  name: string,
  ref: string,
  host = "github.com",
): ForkPrMatch {
  return {
    number: 7,
    title: "Fork work",
    url: "https://github.com/acme/routing/pull/7",
    headRefName: ref,
    headRepoOwner: owner,
    headRepoName: name,
    headRepoHost: host,
    maintainerCanModify: true,
    aheadCount: 1,
  };
}

function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface Reads {
  head: BranchHead;
  branches: Branch[];
  remotes: string[];
  remoteBranches: RemoteBranch[];
}
let reads: Reads;
let info: ReturnType<typeof vi.spyOn>;
let success: ReturnType<typeof vi.spyOn>;

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
  vi.mocked(gitBranchRewriteStatus).mockImplementation(
    () => new Promise(() => undefined),
  );
  vi.mocked(gitFetch).mockResolvedValue(undefined);
  vi.mocked(forgeStatus).mockImplementation(() => new Promise(() => undefined));
  const urlOf = async (_repo: string, remote: string) =>
    remote === "fork" ? FORK_URL : ORIGIN_URL;
  vi.mocked(gitRemoteUrl).mockImplementation(urlOf);
  vi.mocked(gitRemotePushUrl).mockImplementation(urlOf);
  vi.mocked(forgeDetectForkPrForBranch).mockResolvedValue(null);
  pushSpy.mockResolvedValue("leaseAndIncludes");
  info = vi.spyOn(toast, "info");
  success = vi.spyOn(toast, "success");
  useUiStore.setState({ repoPath: REPO });
});

afterEach(() => {
  onlineManager.setOnline(true);
  const pending = useConfirm.getState().request;
  if (pending) act(() => useConfirm.getState().answer(false));
  info.mockRestore();
  success.mockRestore();
  // A test that failed mid-check leaves its entry, which would hold Push later.
  for (const repo of [REPO, OTHER_REPO]) {
    const left = headerDetectionFor(repo);
    if (left) endHeaderDetection(left.token);
  }
  // Drops once-queues a failed test left unconsumed; beforeEach re-arms them.
  for (const spy of [gitBranches, gitRemotePushUrl, forgeDetectForkPrForBranch])
    vi.mocked(spy).mockReset();
});

function Bar({ client, repo }: { client: QueryClient; repo: string }) {
  return (
    <QueryClientProvider client={client}>
      <SyncControls repoPath={repo} />
    </QueryClientProvider>
  );
}

async function renderBar(client?: QueryClient) {
  const user = userEvent.setup();
  const queryClient =
    client ??
    new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<Bar client={queryClient} repo={REPO} />);
  await waitFor(() => expect(gitBranches).toHaveBeenCalled());
  await waitFor(() => expect(pushButton()).toBeInTheDocument());
  return { user, queryClient, view };
}

const pushButton = () =>
  screen.getByRole("button", { name: /^(Push|Publish branch|Force push)/ });

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

/** The gitPush arguments of call `i`, by name. */
function pushCall(i = 0) {
  const [repo, setUpstream, force, branch, remote, remoteBranch, pins] =
    pushSpy.mock.calls[i] ?? [];
  return { repo, setUpstream, force, branch, remote, remoteBranch, pins };
}

/** The open confirm's body as text. */
function confirmBody(): string {
  const req = useConfirm.getState().request;
  if (!req) throw new Error("no confirm is open");
  const { container, unmount } = render(<div>{req.body}</div>);
  const text = container.textContent ?? "";
  unmount();
  return text;
}

describe("Publish names its remote", () => {
  it("a row routed to fork reads, asks and publishes on fork", async () => {
    reads.head = unpublished("feat");
    reads.branches = [routedToFork("feat")];
    reads.remotes = ["origin", "fork"];
    // origin has feat, fork doesn't: presence read on origin would not ask.
    reads.remoteBranches = [remoteHas("origin", "feat")];
    const { user } = await renderBar();
    await user.click(pushButton());
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
    expect(gitRemoteUrl).toHaveBeenCalledWith(REPO, "fork");
    expect(gitRemotePushUrl).toHaveBeenCalledWith(REPO, "fork");
    expect(gitRemotePushUrl).not.toHaveBeenCalledWith(REPO, "origin");
    const body = confirmBody();
    expect(body).toContain("fork");
    expect(body).not.toContain("origin");
    act(() => useConfirm.getState().answer(true));
    await waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(1));
    expect(pushCall()).toMatchObject({
      branch: "feat",
      remote: "fork",
      pins: { creates: true },
    });
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("Published feat to fork", {
        description: undefined,
      }),
    );
  });

  it("a refused row asks nothing, opens no guard and pushes with no remote", async () => {
    reads.head = unpublished("feat");
    reads.branches = [branchRow("feat", { namedPushRefused: true })];
    reads.remotes = ["origin", "fork"];
    vi.mocked(forgeDetectForkPrForBranch).mockResolvedValue(
      forkMatch("other", "routing", "feat"),
    );
    const { user } = await renderBar();
    await user.click(pushButton());
    await waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(1));
    await settle();
    expect(useConfirm.getState().request).toBeNull();
    expect(screen.queryByText(GUARD_TEXT)).not.toBeInTheDocument();
    expect(gitRemotePushUrl).not.toHaveBeenCalled();
    expect(pushCall()).toMatchObject({
      branch: "feat",
      remote: undefined,
      pins: { creates: false },
    });
  });

  for (const [what, arrange] of [
    [
      "a row missing from the list",
      () => {
        reads.branches = [branchRow("other")];
      },
    ],
    [
      "a failed list read",
      () => {
        vi.mocked(gitBranches).mockRejectedValueOnce(new Error("boom"));
      },
    ],
    [
      // An upstream set out of app since the status the press read.
      "a row that now tracks a remote branch",
      () => {
        reads.branches = [
          branchRow("feat", {
            upstream: "origin/release",
            upstreamRemote: "origin",
            upstreamRemoteRef: "refs/heads/release",
          }),
        ];
      },
    ],
  ] as const)
    it(`${what} publishes nothing`, async () => {
      reads.head = unpublished("feat");
      const { user } = await renderBar();
      arrange();
      await user.click(pushButton());
      await waitFor(() =>
        expect(info).toHaveBeenCalledWith(
          "Couldn't confirm where feat publishes — nothing was published.",
        ),
      );
      await settle();
      expect(useConfirm.getState().request).toBeNull();
      expect(pushSpy).not.toHaveBeenCalled();
      expect(headerDetectionFor(REPO)).toBeNull();
    });

  // branch.<b>.remote never picks a first publish's destination: the backend
  // predicts the push remote, else origin, and the bar sends that prediction.
  it("a first publish goes where the backend predicts, never to another listed remote", async () => {
    reads.head = unpublished("feat");
    reads.branches = [
      branchRow("feat", { namedPushRemote: "origin", namedPushBranch: "feat" }),
    ];
    reads.remotes = ["origin", "fork"];
    const { user } = await renderBar();
    await user.click(pushButton());
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
    expect(gitRemotePushUrl).toHaveBeenCalledWith(REPO, "origin");
    expect(gitRemotePushUrl).not.toHaveBeenCalledWith(REPO, "fork");
    expect(confirmBody()).not.toContain("fork");
    act(() => useConfirm.getState().answer(true));
    await waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(1));
    expect(pushCall()).toMatchObject({ branch: "feat", remote: "origin" });
  });

  it("an unlisted branch.<name>.remote reaches the user as the backend's refusal", async () => {
    const error = vi.spyOn(toast, "error");
    reads.head = unpublished("feat");
    reads.branches = [branchRow("feat", { namedPushRefused: true })];
    reads.remotes = ["origin", "fork"];
    pushSpy.mockRejectedValue({
      kind: "invalidArgument",
      message: "invalid argument: unknown remote: ghost",
    });
    try {
      const { user } = await renderBar();
      await user.click(pushButton());
      await waitFor(() =>
        expect(error).toHaveBeenCalledWith(
          "Unknown remote: ghost",
          expect.anything(),
        ),
      );
      expect(pushSpy).toHaveBeenCalledTimes(1);
      expect(pushCall()).toMatchObject({ branch: "feat", remote: undefined });
      expect(useConfirm.getState().request).toBeNull();
      expect(success).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("a row routed to fork publishes to fork while the remotes list is stale", async () => {
    reads.head = unpublished("feat");
    reads.branches = [routedToFork("feat")];
    // `fork` was just added: the cached remotes list predates it.
    reads.remotes = ["origin"];
    const { user } = await renderBar();
    await user.click(pushButton());
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
    expect(gitRemotePushUrl).toHaveBeenCalledWith(REPO, "fork");
    expect(confirmBody()).toContain("fork");
    act(() => useConfirm.getState().answer(true));
    await waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(1));
    expect(pushCall()).toMatchObject({ branch: "feat", remote: "fork" });
  });
});

describe("pins and creates the bar sends", () => {
  it("the bare push pins the status's branch", async () => {
    const { user } = await renderBar();
    await user.click(pushButton());
    await waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(1));
    expect(pushCall()).toMatchObject({
      repo: REPO,
      force: false,
      branch: undefined,
      remote: undefined,
      pins: { expectedBranch: "feat", expectedHead: undefined, creates: false },
    });
  });

  async function openForce() {
    reads.head = headOn("feat", { behind: 1 });
    const bar = await renderBar();
    await bar.user.click(pushButton());
    const dialog = await screen.findByRole("dialog", { name: "Force push?" });
    return {
      ...bar,
      force: within(dialog).getByRole("button", { name: "Force push" }),
    };
  }

  it("the force push pins the branch and the tip the confirm showed", async () => {
    const { user, force } = await openForce();
    await user.click(force);
    await waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(1));
    expect(pushCall()).toMatchObject({
      force: true,
      branch: undefined,
      pins: { expectedBranch: "feat", expectedHead: OID, creates: false },
    });
  });

  it("a tip that moved under the open confirm pushes nothing", async () => {
    const { user, force } = await openForce();
    // The poll hasn't seen it; the confirm's fresh read does.
    reads.head = headOn("feat", { behind: 1, oid: MOVED_OID });
    await user.click(force);
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith(
        "feat changed while the dialog was open — nothing was pushed.",
      ),
    );
    await settle();
    expect(pushSpy).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("dialog", { name: "Force push?" }),
    ).not.toBeInTheDocument();
  });

  it("a tip move the poll saw before the click pushes nothing", async () => {
    const { user, force, queryClient } = await openForce();
    reads.head = headOn("feat", { behind: 1, oid: MOVED_OID });
    await act(() =>
      queryClient.refetchQueries({
        queryKey: repoStatusOptions(REPO).queryKey,
      }),
    );
    await settle();
    expect(
      screen.getByRole("dialog", { name: "Force push?" }),
    ).toBeInTheDocument();
    const statusReads = vi.mocked(gitStatus).mock.calls.length;
    await user.click(force);
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith(
        "feat changed while the dialog was open — nothing was pushed.",
      ),
    );
    await settle();
    expect(pushSpy).not.toHaveBeenCalled();
    // Refused at the click, before the direct read.
    expect(vi.mocked(gitStatus).mock.calls.length).toBe(statusReads);
    expect(
      screen.queryByRole("dialog", { name: "Force push?" }),
    ).not.toBeInTheDocument();
  });

  it("a force push on the tracking-reflog-less lease says so", async () => {
    pushSpy.mockResolvedValue("leasePinnedNoTrackingReflog");
    const { user, force } = await openForce();
    await user.click(force);
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("Force pushed", {
        description:
          "Protected by a lease on the remote tip from your last fetch: this clone has no fetch history for --force-if-includes to check.",
      }),
    );
  });

  it("the bare-create stand-in names its destination and leases on the create", async () => {
    reads.head = headOn("feat", { pushRemote: "fork", pushBranch: "feat" });
    reads.remotes = ["origin", "fork"];
    const { user } = await renderBar();
    await user.click(pushButton());
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
    act(() => useConfirm.getState().answer(true));
    await waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(1));
    expect(pushCall()).toMatchObject({
      setUpstream: false,
      branch: "feat",
      remote: "fork",
      remoteBranch: "feat",
      pins: { creates: true },
    });
  });

  it("the bare-create stand-in claims no create while its push URL points elsewhere", async () => {
    reads.head = headOn("feat", { pushRemote: "fork", pushBranch: "feat" });
    reads.remotes = ["origin", "fork"];
    // The fetch side can't vouch for the push side: `feat` may be there unread.
    vi.mocked(gitRemotePushUrl).mockImplementation(async (_repo, remote) =>
      remote === "fork"
        ? "https://push.example.test/elsewhere.git"
        : ORIGIN_URL,
    );
    const { user } = await renderBar();
    await user.click(pushButton());
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
    act(() => useConfirm.getState().answer(true));
    await waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(1));
    expect(pushCall()).toMatchObject({
      setUpstream: false,
      branch: "feat",
      remote: "fork",
      remoteBranch: "feat",
      pins: { creates: false },
    });
  });

  const mismatched = () =>
    headOn("feat", {
      upstream: "origin/feat-x",
      upstreamBranch: "feat-x",
      pushNameMismatch: true,
      pushBranch: "feat-x",
    });

  it("the mismatch menu's tracked push pins the menu's branch", async () => {
    reads.head = mismatched();
    const { user } = await renderBar();
    await user.click(pushButton());
    await user.click(
      await screen.findByRole("menuitem", { name: /^Push to origin\/feat-x/ }),
    );
    await waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(1));
    expect(pushCall()).toMatchObject({
      setUpstream: false,
      branch: "feat",
      remote: "origin",
      remoteBranch: "feat-x",
      // The live upstream exists: no create, so no create lease.
      pins: { expectedBranch: "feat", creates: undefined },
    });
  });

  it("the mismatch menu's publish pins the menu's branch and leases on the create", async () => {
    reads.head = mismatched();
    const { user } = await renderBar();
    await user.click(pushButton());
    await user.click(
      await screen.findByRole("menuitem", {
        name: /^Publish as origin\/feat/,
      }),
    );
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
    act(() => useConfirm.getState().answer(true));
    await waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(1));
    expect(pushCall()).toMatchObject({
      setUpstream: true,
      branch: "feat",
      remote: "origin",
      pins: { expectedBranch: "feat", creates: true },
    });
  });
});

describe("the header detection store", () => {
  it("is written at the press, gains the remote, and clears at the ask", async () => {
    reads.head = unpublished("feat");
    reads.branches = [routedToFork("feat")];
    reads.remotes = ["origin", "fork"];
    vi.mocked(forgeDetectForkPrForBranch).mockImplementation(
      () => new Promise(() => undefined),
    );
    const { user } = await renderBar();
    const rowsRead = deferred<Branch[]>();
    const urlRead = deferred<string>();
    vi.mocked(gitBranches).mockImplementationOnce(() => rowsRead.promise);
    vi.mocked(gitRemotePushUrl).mockImplementationOnce(() => urlRead.promise);
    expect(headerDetectionFor(REPO)).toBeNull();
    await user.click(pushButton());
    expect(headerDetectionFor(REPO)).toMatchObject({
      branch: "feat",
      remote: null,
    });
    await act(async () => rowsRead.resolve(reads.branches));
    await waitFor(() =>
      expect(headerDetectionFor(REPO)).toMatchObject({
        branch: "feat",
        remote: "fork",
      }),
    );
    await act(async () => urlRead.resolve(FORK_URL));
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
    expect(headerDetectionFor(REPO)).toBeNull();
  });

  /** A publish onto a branch fork already has: it waits on the check alone. */
  async function pressAwaitingCheck(client?: QueryClient) {
    reads.head = unpublished("feat");
    reads.branches = [routedToFork("feat")];
    reads.remotes = ["origin", "fork"];
    reads.remoteBranches = [remoteHas("fork", "feat")];
    const check = deferred<ForkPrMatch | null>();
    vi.mocked(forgeDetectForkPrForBranch).mockImplementationOnce(
      () => check.promise,
    );
    const bar = await renderBar(client);
    await bar.user.click(pushButton());
    await waitFor(() =>
      expect(headerDetectionFor(REPO)).toMatchObject({ remote: "fork" }),
    );
    await settle();
    return { ...bar, check };
  }

  it("clears when the check settles", async () => {
    const { check } = await pressAwaitingCheck();
    expect(headerDetectionFor(REPO)).not.toBeNull();
    await act(async () => check.resolve(null));
    await waitFor(() => expect(headerDetectionFor(REPO)).toBeNull());
    await waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(1));
  });

  it("outlives a sync bar unmount and still clears when the check settles", async () => {
    const { check, view } = await pressAwaitingCheck();
    view.unmount();
    expect(headerDetectionFor(REPO)).toMatchObject({
      branch: "feat",
      remote: "fork",
    });
    await act(async () => check.resolve(null));
    await waitFor(() => expect(headerDetectionFor(REPO)).toBeNull());
  });

  it("clears after a repository switch mid-check", async () => {
    const { check, view, queryClient } = await pressAwaitingCheck();
    act(() => useUiStore.setState({ repoPath: OTHER_REPO }));
    view.rerender(<Bar client={queryClient} repo={OTHER_REPO} />);
    expect(headerDetectionFor(REPO)).not.toBeNull();
    expect(headerDetectionFor(OTHER_REPO)).toBeNull();
    await act(async () => check.resolve(null));
    await waitFor(() => expect(headerDetectionFor(REPO)).toBeNull());
    await settle();
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("a remounted bar holds Push while an earlier mount's press checks, and a press starts nothing", async () => {
    const first = await pressAwaitingCheck();
    const entry = headerDetectionFor(REPO);
    first.view.unmount();
    const user = userEvent.setup();
    render(<Bar client={first.queryClient} repo={REPO} />);
    await waitFor(() =>
      expect(pushButton()).toHaveAttribute("aria-disabled", "true"),
    );
    expect(pushButton()).toHaveAccessibleDescription(PUBLISH_FORK_CHECK_REASON);
    const branchReads = vi.mocked(gitBranches).mock.calls.length;
    await user.click(pushButton());
    await settle();
    expect(headerDetectionFor(REPO)).toBe(entry);
    expect(forgeDetectForkPrForBranch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gitBranches).mock.calls.length).toBe(branchReads);
    await act(async () => first.check.resolve(null));
    await waitFor(() => expect(headerDetectionFor(REPO)).toBeNull());
    await waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(1));
    await settle();
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });
});

describe("a fork match that IS the destination opens no guard", () => {
  const updates = () => forkMatch("someone", "routing", "feat");

  function routeToFork() {
    reads.head = unpublished("feat");
    reads.branches = [routedToFork("feat")];
    reads.remotes = ["origin", "fork"];
  }

  for (const [what, match, guards] of [
    ["the destination's own pull request", updates, false],
    [
      "another repository's pull request",
      () => forkMatch("other", "routing", "feat"),
      true,
    ],
    [
      "the same owner and repository name on another host",
      () => forkMatch("someone", "routing", "feat", "gitlab.com"),
      true,
    ],
  ] as const)
    it(`decided after the reads: ${what} ${guards ? "opens" : "opens no"} guard`, async () => {
      routeToFork();
      vi.mocked(forgeDetectForkPrForBranch).mockResolvedValue(match());
      const { user } = await renderBar();
      const urlRead = deferred<string>();
      vi.mocked(gitRemotePushUrl).mockImplementationOnce(() => urlRead.promise);
      await user.click(pushButton());
      await waitFor(() => expect(gitRemotePushUrl).toHaveBeenCalled());
      // The check has settled before the decision reads it.
      await settle();
      await act(async () => urlRead.resolve(FORK_URL));
      await settle();
      if (guards) {
        expect(await screen.findByText(GUARD_TEXT)).toBeInTheDocument();
        expect(useConfirm.getState().request).toBeNull();
      } else {
        expect(screen.queryByText(GUARD_TEXT)).not.toBeInTheDocument();
        expect(useConfirm.getState().request).not.toBeNull();
        expect(confirmBody()).toContain("fork");
      }
    });

  it("settling under the prompt: frees Publish and keeps the prompt", async () => {
    routeToFork();
    const check = deferred<ForkPrMatch | null>();
    vi.mocked(forgeDetectForkPrForBranch).mockImplementationOnce(
      () => check.promise,
    );
    const { user } = await renderBar();
    await user.click(pushButton());
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
    const asked = useConfirm.getState().request;
    expect(useConfirm.getState().requestHold?.reason).toBeDefined();
    await act(async () => check.resolve(updates()));
    await settle();
    expect(screen.queryByText(GUARD_TEXT)).not.toBeInTheDocument();
    expect(useConfirm.getState().request).toBe(asked);
    expect(useConfirm.getState().requestHold?.reason).toBeUndefined();
  });

  it("with no prompt: publishes to fork without a guard", async () => {
    routeToFork();
    reads.remoteBranches = [remoteHas("fork", "feat")];
    vi.mocked(forgeDetectForkPrForBranch).mockResolvedValue(updates());
    const { user } = await renderBar();
    await user.click(pushButton());
    await waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(GUARD_TEXT)).not.toBeInTheDocument();
    expect(pushCall()).toMatchObject({ branch: "feat", remote: "fork" });
  });
});

// A remote rename pushes too, so it holds the bar like a push from the list.
function RenameHarness() {
  const rename = useRenameBranchOnRemote(REPO);
  return (
    <button
      type="button"
      onClick={() =>
        void rename
          .mutateAsync({
            oldName: "topic",
            newName: "topic2",
            remote: "origin",
            expectedOldTip: OID,
          })
          .catch(() => undefined)
      }
    >
      start rename
    </button>
  );
}

describe("a remote rename in flight", () => {
  it("holds Push with the push reason, and a press sends no push", async () => {
    renameRemoteSpy.mockImplementation(() => new Promise(() => undefined));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RenameHarness />
      </QueryClientProvider>,
    );
    const { user } = await renderBar(queryClient);
    await waitFor(() =>
      expect(pushButton()).not.toHaveAttribute("aria-disabled"),
    );
    await waitFor(() =>
      expect(
        queryClient.getQueryData(repoIdentityQueryOptions(REPO).queryKey),
      ).toBeDefined(),
    );
    fireEvent.click(screen.getByRole("button", { name: "start rename" }));
    await waitFor(() => expect(renameRemoteSpy).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(pushButton()).toHaveAttribute("aria-disabled", "true"),
    );
    expect(pushButton()).toHaveAccessibleDescription(
      branchPushHoldReason(false),
    );
    await user.click(pushButton());
    await settle();
    expect(pushSpy).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });
});
