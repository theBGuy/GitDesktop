import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
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
import { RemotePrView } from "@/features/pulls/RemotePrView";
import { sharedBranchRulesOptions } from "@/lib/branch-rules/queries";
import {
  loadBranchRules,
  loadSharedBranchRules,
  normalizeBranchRules,
} from "@/lib/branch-rules/store";
import {
  type BranchRulesConfig,
  EMPTY_BRANCH_RULES,
} from "@/lib/branch-rules/types";
import {
  forgeGlMrMergeState,
  forgePrApprovals,
  forgePrMergeMessageDefaults,
  forgePrReviewThreads,
  forgePrView,
  forgeStatus,
  gitDefaultBranch,
} from "@/lib/git/api";
import type {
  ForgeStatus,
  GitLabMrMergeState,
  MergeMessageDefaults,
  PrDetails,
} from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";
import { invoke } from "@/lib/tauri/invoke";
import { unmockedCommands } from "./setup";

// The merge write is answered at the wire, under the real hook and api function.
vi.mock("@/lib/tauri/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri/invoke")>()),
  invoke: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  },
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(),
  forgePrView: vi.fn(),
  forgePrApprovals: vi.fn(),
  forgePrReviewThreads: vi.fn(),
  forgePrMergeMessageDefaults: vi.fn(),
  forgeGlMrMergeState: vi.fn(),
  forgePrTimeline: vi.fn(async () => []),
  forgePrMergeability: vi.fn(async () => {
    throw new Error("not read");
  }),
  gitConflictPreview: vi.fn(async () => {
    throw new Error("not read");
  }),
  // Side reads the view makes that no test here asserts on.
  forgePrListPage: vi.fn(async () => {
    throw new Error("not read");
  }),
  forgeRepoLabels: vi.fn(async () => {
    throw new Error("not read");
  }),
  ghItemProjects: vi.fn(async () => {
    throw new Error("not read");
  }),
  ghPrBaseDivergence: vi.fn(async () => {
    throw new Error("not read");
  }),
  ghTokenScopes: vi.fn(async () => {
    throw new Error("not read");
  }),
  gitRemoteUrl: vi.fn(async () => {
    throw new Error("not read");
  }),
  gitFindRemotePrResolve: vi.fn(async () => null),
  gitFetch: vi.fn(async () => undefined),
  forgePrDiff: vi.fn(async () => ""),
  // The proven by-target read, delegating to the by-number mock's text.
  forgePrDiffAt: vi.fn(
    async (
      repo: string,
      number: number,
      lens: import("@/lib/git/types").RemoteLens,
    ) => ({
      diff: await (await import("@/lib/git/api")).forgePrDiff(
        repo,
        number,
        lens,
      ),
      headProof: "proven" as const,
    }),
  ),
  forgePrReactions: vi.fn(async () => ({ body: [], comments: {} })),
  forgeRepoWriteAccess: vi.fn(async () => ({
    canPush: null,
    canTriage: null,
    role: null,
    repo: null,
    unknownReason: null,
  })),
  getSecret: vi.fn(async () => null),
  gitBranches: vi.fn(async () => []),
  gitDefaultBranch: vi.fn(),
  gitRemotes: vi.fn(async () => ["origin"]),
  gitStatus: vi.fn(async () => ({
    branch: {
      name: "main",
      detached: false,
      oid: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      upstreamGone: false,
      upstreamRemote: null,
    },
    entries: [],
  })),
  readRepoBranchRules: vi.fn(async () => null),
}));
vi.mock("@/lib/branch-rules/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/branch-rules/store")>()),
  loadBranchRules: vi.fn(),
  loadSharedBranchRules: vi.fn(),
}));
vi.mock("@/lib/git/repo-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/repo-identity")>()),
  repoIdentity: async (p: string) => p,
  repoIdentityStrict: async (p: string) => p,
  repoIdentityUnmemoized: async (p: string) => p,
}));
vi.mock("@/features/pulls/useGeneratePrDescription", () => ({
  useGeneratePrDescription: () => ({
    generate: vi.fn(),
    generateFromDiff: vi.fn(),
    cancel: vi.fn(),
    generating: false,
    pickingLabels: false,
  }),
}));
vi.mock("@/lib/attachments/use-attachment-support", () => ({
  useAttachmentSupport: () => null,
}));
vi.mock("@/lib/jira/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jira/store")>()),
  getJiraLink: vi.fn(async () => null),
}));

const REPO = "C:/repo";
const SHA = "0123456789abcdef0123456789abcdef01234567";

const GITLAB = {
  provider: "gitlab",
  installed: true,
  authenticated: true,
  repo: "owner/repo",
  host: "gitlab.com",
  login: "me",
  capabilities: {},
  implemented: { mrMerge: true, mrAutoMerge: true, mrState: true },
} as unknown as ForgeStatus;

const GITHUB = {
  ...GITLAB,
  provider: "github",
  host: "github.com",
  implemented: {},
} as unknown as ForgeStatus;

// The head pipeline is running, so GitLab's Merge menu offers auto-merge too.
const PIPELINE_RUNNING = {
  autoMergeEnabled: false,
  detailedMergeStatus: "ci_still_running",
  pipelineStatus: "running",
} as unknown as GitLabMrMergeState;

const DEFAULTS: MergeMessageDefaults = {
  commits: [
    { kind: "squash", message: { title: "Squash it", body: "" }, exact: true },
  ],
  reason: null,
};

const PREF_ON: BranchRulesConfig = {
  ...EMPTY_BRANCH_RULES,
  deleteHeadAfterMerge: true,
};

// A shared rule that blocks deleting the head.
const BLOCKED_FEAT = normalizeBranchRules({
  protections: [{ id: "feat", pattern: "feat", blockDeletion: true }],
});

/** Overrides every details read applies, per test. */
let prOver: Partial<PrDetails> = {};

function pr(number = 7): PrDetails {
  return {
    id: `PR_${number}`,
    number,
    title: `Change ${number}`,
    body: "",
    author: "someone",
    authorAvatarUrl: "",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feat",
    additions: 0,
    deletions: 0,
    url: `https://example.com/owner/repo/pull/${number}`,
    commits: [],
    files: [],
    reviews: [],
    comments: [],
    checks: [],
    checksUnknown: false,
    checksTruncated: false,
    commentsUnknown: false,
    commentsTruncated: false,
    commitsUnknown: false,
    commitsTruncated: false,
    headSha: SHA,
    filesUnknown: false,
    filesTruncated: false,
    reviewersUnknown: false,
    labels: [],
    assignees: [],
    reviewers: [],
    completedReviewers: [],
    mergeCommitAllowed: null,
    squashMergeAllowed: null,
    rebaseMergeAllowed: null,
    stackMembers: [],
    stackUnknown: false,
    membersUnknown: false,
    ...prOver,
  } as unknown as PrDetails;
}

function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const clients: QueryClient[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  prOver = {};
  vi.mocked(invoke).mockReset();
  // Recorded as well as thrown: React Query swallows the rejection of a read,
  // so only the afterAll check would see an unexpected one.
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    unmockedCommands.push(cmd);
    throw new Error(`unexpected wire call: ${cmd}`);
  });
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(forgeStatus).mockResolvedValue(GITHUB);
  vi.mocked(forgePrView).mockImplementation(async (_repo, number) =>
    pr(number),
  );
  vi.mocked(forgePrApprovals).mockResolvedValue({
    viewerHasApproved: false,
    approvedBy: [],
    approvalsRequired: 0,
    approvalsLeft: 0,
    viewerRequestedChanges: false,
  });
  vi.mocked(forgePrReviewThreads).mockResolvedValue({
    threads: [],
    threadsTruncated: false,
  });
  vi.mocked(forgePrMergeMessageDefaults).mockReset();
  vi.mocked(forgePrMergeMessageDefaults).mockResolvedValue(DEFAULTS);
  vi.mocked(forgeGlMrMergeState).mockResolvedValue(PIPELINE_RUNNING);
  vi.mocked(gitDefaultBranch).mockReset().mockResolvedValue("main");
  vi.mocked(loadBranchRules).mockReset().mockResolvedValue(EMPTY_BRANCH_RULES);
  vi.mocked(loadSharedBranchRules)
    .mockReset()
    .mockResolvedValue(EMPTY_BRANCH_RULES);
  useConfirm.setState({ request: null, requestHold: null });
  useUiStore.setState({
    repoPath: REPO,
    repoTab: "pulls",
    selectedPr: { kind: "remote", id: "7" },
  });
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

afterAll(() => expect(unmockedCommands).toEqual([]));

function mount(number = 7) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const ui = (n: number) => (
    <QueryClientProvider client={client}>
      <RemotePrView repoPath={REPO} number={n} />
    </QueryClientProvider>
  );
  const view = render(ui(number));
  return {
    client,
    show: (n: number) => {
      act(() =>
        useUiStore.setState({ selectedPr: { kind: "remote", id: String(n) } }),
      );
      view.rerender(ui(n));
    },
  };
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));

const wireCalls = () => vi.mocked(invoke).mock.calls;

// Only the immediate merge and the auto-merge arm carry a strategy, so "not the
// arm" pins the immediate merge without naming its state-write command here.
const AUTO_MERGE_ARM = "forge_gl_mr_auto_merge";

/** The first payload the wire saw carrying a strategy (a merge or an arm). */
const strategyCall = () =>
  wireCalls().find(
    ([, args]) =>
      typeof args === "object" && args !== null && "strategy" in args,
  );

/** Opens the merge dialog through the footer's Merge menu `item`. */
async function openMerge(
  user: ReturnType<typeof userEvent.setup>,
  item = "Squash and merge",
) {
  const trigger = await screen.findByRole(
    "button",
    { name: "Merge" },
    { timeout: 3000 },
  );
  await waitFor(() =>
    expect(trigger).not.toHaveAttribute("aria-disabled", "true"),
  );
  await user.click(trigger);
  await user.click(await screen.findByRole("menuitem", { name: item }));
  return screen.findByRole("dialog");
}

const box = (dialog: HTMLElement, head = "feat") =>
  within(dialog).getByRole("checkbox", {
    name: new RegExp(`Delete ${head} on the remote after merging`),
  });

async function cancel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

/** Confirms the merge and waits for the wire to see it. */
async function confirmMerge(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  label = "Squash and merge",
) {
  vi.mocked(invoke).mockResolvedValueOnce({
    queued: false,
    cleanupWarning: null,
    stacked: false,
  });
  await user.click(within(dialog).getByRole("button", { name: label }));
  await waitFor(() => expect(strategyCall()).toBeDefined());
  // The command too: an auto-merge arm carries the same payload.
  expect(strategyCall()?.[0]).not.toBe(AUTO_MERGE_ARM);
  return strategyCall()?.[1] as Record<string, unknown>;
}

describe("merge dialog: the delete checkbox's start", () => {
  it("A5/A18 the setting ticks a same-repository GitHub head, and the merge deletes it", async () => {
    vi.mocked(loadBranchRules).mockResolvedValue(PREF_ON);
    prOver = { crossRepository: false };
    const user = userEvent.setup();
    mount();
    const dialog = await openMerge(user);
    expect(box(dialog)).toBeChecked();
    const args = await confirmMerge(user, dialog);
    expect(args.deleteBranch).toBe(true);
  });

  // A9: GitHub sends no per-PR flag (null), so the forge arm never ticks it.
  it("A9 without the setting a GitHub pull request starts unticked", async () => {
    prOver = { crossRepository: false, deleteSourceBranch: null };
    const user = userEvent.setup();
    mount();
    const dialog = await openMerge(user);
    expect(box(dialog)).not.toBeChecked();
    const args = await confirmMerge(user, dialog);
    expect(args.deleteBranch).toBe(false);
  });

  it("the setting never ticks a configured promotion branch", async () => {
    vi.mocked(loadBranchRules).mockResolvedValue({
      ...PREF_ON,
      promotionBranches: ["feat"],
    });
    prOver = { crossRepository: false, deleteSourceBranch: null };
    const user = userEvent.setup();
    mount();
    const dialog = await openMerge(user);
    expect(box(dialog)).not.toBeChecked();
    const args = await confirmMerge(user, dialog);
    expect(args.deleteBranch).toBe(false);
  });

  it("A6 a GitLab fork takes the merge request's own flag, not the setting", async () => {
    vi.mocked(forgeStatus).mockResolvedValue(GITLAB);
    vi.mocked(loadBranchRules).mockResolvedValue(PREF_ON);
    prOver = { crossRepository: true, deleteSourceBranch: false };
    const user = userEvent.setup();
    const view = mount();
    let dialog = await openMerge(user);
    expect(box(dialog)).not.toBeChecked();
    await cancel(user);

    prOver = { crossRepository: true, deleteSourceBranch: true };
    await act(() =>
      view.client.refetchQueries({
        queryKey: ["repo", REPO, "pr", "origin", 7],
        exact: true,
      }),
    );
    dialog = await openMerge(user);
    expect(box(dialog)).toBeChecked();
  });

  it("A8/A18 with the setting off a GitLab merge request starts from its own flag, and the merge deletes it", async () => {
    vi.mocked(forgeStatus).mockResolvedValue(GITLAB);
    prOver = { crossRepository: false, deleteSourceBranch: true };
    const user = userEvent.setup();
    mount();
    const dialog = await openMerge(user);
    expect(box(dialog)).toBeChecked();
    const args = await confirmMerge(user, dialog);
    expect(args.deleteBranch).toBe(true);
  });

  it("A18 GitLab auto-merge carries the ticked start to the arm", async () => {
    vi.mocked(forgeStatus).mockResolvedValue(GITLAB);
    prOver = { deleteSourceBranch: true };
    const user = userEvent.setup();
    mount();
    const dialog = await openMerge(user, "Auto-merge: Squash and merge");
    expect(box(dialog)).toBeChecked();
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await user.click(
      within(dialog).getByRole("button", { name: "Enable auto-merge" }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Auto-merge enabled for #7 — merges when the pipeline passes",
      ),
    );
    const [cmd, args] = strategyCall() ?? [];
    expect(cmd).toBe("forge_gl_mr_auto_merge");
    expect((args as Record<string, unknown>).deleteBranch).toBe(true);
  });

  it("A1 a pending shared read keeps the setting from ticking; a reopen after it settles ticks", async () => {
    vi.mocked(loadBranchRules).mockResolvedValue(PREF_ON);
    const shared = deferred<BranchRulesConfig>();
    vi.mocked(loadSharedBranchRules).mockReturnValue(shared.promise);
    prOver = { crossRepository: false, deleteSourceBranch: null };
    const user = userEvent.setup();
    mount();
    const dialog = await openMerge(user);
    expect(box(dialog)).not.toBeChecked();
    await act(async () => shared.resolve(EMPTY_BRANCH_RULES));
    await settle();
    expect(box(dialog)).not.toBeChecked();
    await cancel(user);
    expect(box(await openMerge(user))).toBeChecked();
  });

  it("A14 a setting that answers after the open doesn't tick the open dialog; the next open does", async () => {
    const personal = deferred<BranchRulesConfig>();
    vi.mocked(loadBranchRules).mockReturnValue(personal.promise);
    prOver = { crossRepository: false, deleteSourceBranch: null };
    const user = userEvent.setup();
    mount();
    const dialog = await openMerge(user);
    expect(box(dialog)).not.toBeChecked();
    await act(async () => personal.resolve(PREF_ON));
    await settle();
    expect(box(dialog)).not.toBeChecked();
    await cancel(user);
    expect(box(await openMerge(user))).toBeChecked();
  });

  it("A14b a forge-ticked start under pending rules drops when a rule then blocks the head", async () => {
    vi.mocked(forgeStatus).mockResolvedValue(GITLAB);
    const shared = deferred<BranchRulesConfig>();
    vi.mocked(loadSharedBranchRules).mockReturnValue(shared.promise);
    prOver = { deleteSourceBranch: true };
    const user = userEvent.setup();
    mount();
    const dialog = await openMerge(user);
    expect(box(dialog)).toBeChecked();
    await act(async () => shared.resolve(BLOCKED_FEAT));
    await waitFor(() => expect(box(dialog)).not.toBeChecked());
    expect(box(dialog)).toHaveAttribute("aria-disabled", "true");
    const args = await confirmMerge(user, dialog);
    expect(args.deleteBranch).toBe(false);
  });

  it("A15 a default branch that answers after the open doesn't tick the open dialog; the next open does", async () => {
    vi.mocked(loadBranchRules).mockResolvedValue(PREF_ON);
    const def = deferred<string | null>();
    vi.mocked(gitDefaultBranch).mockReturnValue(def.promise);
    prOver = { crossRepository: false, deleteSourceBranch: null };
    const user = userEvent.setup();
    mount();
    const dialog = await openMerge(user);
    expect(box(dialog)).not.toBeChecked();
    await act(async () => def.resolve("main"));
    await settle();
    expect(box(dialog)).not.toBeChecked();
    await cancel(user);
    expect(box(await openMerge(user))).toBeChecked();
  });

  it("A15b a forge-ticked default head under a pending default read is hidden and sent false once it answers", async () => {
    vi.mocked(forgeStatus).mockResolvedValue(GITLAB);
    const def = deferred<string | null>();
    vi.mocked(gitDefaultBranch).mockReturnValue(def.promise);
    prOver = {
      headRefName: "main",
      baseRefName: "release",
      deleteSourceBranch: true,
    };
    const user = userEvent.setup();
    mount();
    const dialog = await openMerge(user);
    expect(box(dialog, "main")).toBeChecked();
    await act(async () => def.resolve("main"));
    await waitFor(() =>
      expect(
        within(dialog).queryByRole("checkbox", { name: /Delete main/ }),
      ).toBeNull(),
    );
    const args = await confirmMerge(user, dialog);
    expect(args.deleteBranch).toBe(false);
  });

  it("A16 a kept failure's reopen keeps the user's untick", async () => {
    vi.mocked(loadBranchRules).mockResolvedValue(PREF_ON);
    prOver = { crossRepository: false };
    const user = userEvent.setup();
    mount();
    const dialog = await openMerge(user);
    expect(box(dialog)).toBeChecked();
    await user.click(box(dialog));
    expect(box(dialog)).not.toBeChecked();
    await user.click(
      await within(dialog).findByRole("button", {
        name: "Edit commit message",
      }),
    );
    const title = within(dialog).getByRole("textbox", { name: "Commit title" });
    await user.clear(title);
    await user.type(title, "Edited squash");
    vi.mocked(invoke).mockRejectedValueOnce({
      kind: "gh",
      message: "Pull request is not mergeable.",
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Squash and merge" }),
    );
    await within(dialog).findByRole("alert");
    await settle();
    expect(strategyCall()?.[0]).not.toBe(AUTO_MERGE_ARM);
    expect(strategyCall()?.[1]).toMatchObject({ deleteBranch: false });
    await cancel(user);
    const reopened = await openMerge(user);
    expect(within(reopened).getByRole("alert")).toBeInTheDocument();
    expect(box(reopened)).not.toBeChecked();
  });

  it("A17 a ticked start drops when a shared rule then blocks the head", async () => {
    vi.mocked(loadBranchRules).mockResolvedValue(PREF_ON);
    prOver = { crossRepository: false };
    const user = userEvent.setup();
    const view = mount();
    const dialog = await openMerge(user);
    expect(box(dialog)).toBeChecked();
    vi.mocked(loadSharedBranchRules).mockResolvedValue(BLOCKED_FEAT);
    await act(() =>
      view.client.invalidateQueries({
        queryKey: sharedBranchRulesOptions(REPO).queryKey,
      }),
    );
    await waitFor(() => expect(box(dialog)).not.toBeChecked());
    expect(box(dialog)).toHaveAttribute("aria-disabled", "true");
    const args = await confirmMerge(user, dialog);
    expect(args.deleteBranch).toBe(false);
  });

  it("A17b a head a rule blocked after the open stays unticked once the rule is removed", async () => {
    vi.mocked(loadBranchRules).mockResolvedValue(PREF_ON);
    prOver = { crossRepository: false };
    const user = userEvent.setup();
    const view = mount();
    const dialog = await openMerge(user);
    expect(box(dialog)).toBeChecked();
    const reread = () =>
      act(() =>
        view.client.invalidateQueries({
          queryKey: sharedBranchRulesOptions(REPO).queryKey,
        }),
      );
    vi.mocked(loadSharedBranchRules).mockResolvedValue(BLOCKED_FEAT);
    await reread();
    await waitFor(() =>
      expect(box(dialog)).toHaveAttribute("aria-disabled", "true"),
    );
    vi.mocked(loadSharedBranchRules).mockResolvedValue(EMPTY_BRANCH_RULES);
    await reread();
    await waitFor(() =>
      expect(box(dialog)).not.toHaveAttribute("aria-disabled", "true"),
    );
    expect(box(dialog)).not.toBeChecked();
    const args = await confirmMerge(user, dialog);
    expect(args.deleteBranch).toBe(false);
  });

  it("A15c a forge-ticked head the default read hides stays unticked when the default moves to another branch", async () => {
    vi.mocked(forgeStatus).mockResolvedValue(GITLAB);
    const def = deferred<string | null>();
    vi.mocked(gitDefaultBranch).mockReturnValue(def.promise);
    prOver = { deleteSourceBranch: true };
    const user = userEvent.setup();
    const view = mount();
    const dialog = await openMerge(user);
    expect(box(dialog)).toBeChecked();
    await act(async () => def.resolve("feat"));
    await waitFor(() =>
      expect(
        within(dialog).queryByRole("checkbox", { name: /Delete feat/ }),
      ).toBeNull(),
    );
    vi.mocked(gitDefaultBranch).mockResolvedValue("main");
    await act(() =>
      view.client.invalidateQueries({
        queryKey: ["repo", REPO, "default-branch"],
        exact: true,
      }),
    );
    expect(await within(dialog).findByRole("checkbox")).not.toBeChecked();
    const args = await confirmMerge(user, dialog);
    expect(args.deleteBranch).toBe(false);
  });

  it("an agent-session head is held unticked with its reason, whatever the setting and the forge's flag", async () => {
    vi.mocked(forgeStatus).mockResolvedValue(GITLAB);
    vi.mocked(loadBranchRules).mockResolvedValue(PREF_ON);
    const head = "gd/session/x";
    prOver = {
      headRefName: head,
      crossRepository: false,
      deleteSourceBranch: true,
    };
    const user = userEvent.setup();
    mount();
    const dialog = await openMerge(user);
    const held = box(dialog, head);
    expect(held).not.toBeChecked();
    expect(held).toHaveAttribute("aria-disabled", "true");
    expect(held).toHaveAccessibleName(/— reserved for agent sessions$/);
    const args = await confirmMerge(user, dialog);
    expect(args.deleteBranch).toBe(false);
  });

  // A19: the switch's own reset (closePerPrDialogs) is not what this pins: each
  // open after a switch seeds from the pull request it opens on, never from the
  // previous one's details or the box's last state.
  it("A19 the first open after a pull request switch re-seeds the box for the new pull request", async () => {
    vi.mocked(forgeStatus).mockResolvedValue(GITLAB);
    vi.mocked(forgePrView).mockImplementation(async (_repo, number) => ({
      ...pr(number),
      deleteSourceBranch: number === 7,
    }));
    const user = userEvent.setup();
    const view = mount();
    const dialog = await openMerge(user);
    expect(box(dialog)).toBeChecked();
    await user.click(box(dialog));
    expect(box(dialog)).not.toBeChecked();
    view.show(8);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(box(await openMerge(user))).not.toBeChecked();
    await cancel(user);
    view.show(7);
    expect(box(await openMerge(user))).toBeChecked();
  });

  it("Enter on the focused ticked box at open neither unticks it nor merges", async () => {
    vi.mocked(loadBranchRules).mockResolvedValue(PREF_ON);
    prOver = { crossRepository: false };
    // The defaults stay loading, as on the first open the drive measured.
    vi.mocked(forgePrMergeMessageDefaults).mockReturnValue(
      new Promise(() => undefined),
    );
    const user = userEvent.setup();
    mount();
    const dialog = await openMerge(user);
    const ticked = box(dialog);
    expect(ticked).toBeChecked();
    await waitFor(() => expect(ticked).toHaveFocus());
    await user.keyboard("{Enter}");
    await settle();
    expect(box(dialog)).toBeChecked();
    expect(strategyCall()).toBeUndefined();
    expect(screen.getByRole("dialog")).toBe(dialog);
  });

  // The menu item activates on the Space keydown; its keyup lands on the box
  // the dialog focused, which Base UI would read as a press of the box.
  for (const ticked of [true, false]) {
    it(`the Space that picks the menu item leaves a ${ticked ? "ticked" : "unticked"} box as it started; a Space pressed on the box toggles it`, async () => {
      if (ticked) vi.mocked(loadBranchRules).mockResolvedValue(PREF_ON);
      prOver = { crossRepository: false, deleteSourceBranch: null };
      // The defaults stay loading, so the box is the dialog's first stop.
      vi.mocked(forgePrMergeMessageDefaults).mockReturnValue(
        new Promise(() => undefined),
      );
      const user = userEvent.setup();
      mount();
      const trigger = await screen.findByRole(
        "button",
        { name: "Merge" },
        { timeout: 3000 },
      );
      await waitFor(() =>
        expect(trigger).not.toHaveAttribute("aria-disabled", "true"),
      );
      await user.click(trigger);
      const item = await screen.findByRole("menuitem", {
        name: "Squash and merge",
      });
      act(() => item.focus());
      await user.keyboard("[Space>]");
      const dialog = await screen.findByRole("dialog");
      await waitFor(() => expect(box(dialog)).toHaveFocus());
      expect(box(dialog).getAttribute("aria-checked")).toBe(String(ticked));
      // The held key's auto-repeat now lands on the box.
      fireEvent.keyDown(box(dialog), { key: " ", code: "Space", repeat: true });
      await user.keyboard("[/Space]");
      await settle();
      expect(box(dialog).getAttribute("aria-checked")).toBe(String(ticked));
      await user.keyboard(" ");
      expect(box(dialog).getAttribute("aria-checked")).toBe(String(!ticked));
    });
  }
});
