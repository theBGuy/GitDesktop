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
import { EMPTY_BRANCH_RULES } from "@/lib/branch-rules/types";
import {
  forgeGlMrMergeState,
  forgePrApprovals,
  forgePrMergeMessageDefaults,
  forgePrReviewThreads,
  forgePrView,
  forgeStatus,
  gitFetch,
  readRepoBranchRules,
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

// The merge write is answered at the wire, under the real hook and the real api
// function: a test may not name it (scripts/remote-row-state-wiring.test.mjs), and
// the wire is the only place its payload keys can be checked.
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
// Every read the view makes is answered here, so the merge write is the only
// call that can reach the wire.
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(),
  forgePrView: vi.fn(),
  forgePrApprovals: vi.fn(),
  forgePrReviewThreads: vi.fn(),
  forgePrMergeMessageDefaults: vi.fn(),
  forgeGlMrMergeState: vi.fn(),
  forgePrTimeline: vi.fn(async () => []),
  // The merge strip's predictions, unanswered as a failed read: Merge stays offered.
  forgePrMergeability: vi.fn(async () => {
    throw new Error("not read");
  }),
  gitConflictPreview: vi.fn(async () => {
    throw new Error("not read");
  }),
  gitFindRemotePrResolve: vi.fn(async () => null),
  // The fetch a landed merge runs so the local base catches up.
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
  gitDefaultBranch: vi.fn(async () => "main"),
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
// The raw path is the resolver's own "no identity" answer.
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
// The heads a defaults read can report, distinct from the view's own.
const READ_SHA = "1111111111111111111111111111111111111111";
const MOVED_SHA = "2222222222222222222222222222222222222222";
// The details read's exact key, refetched alone to move the view's head.
const DETAILS_KEY = ["repo", REPO, "pr", "origin", 7] as const;
const DEFAULTS_KEY = [...DETAILS_KEY, "merge-message-defaults", "squash"];
const STILL_HERE = "Your edited message is still here.";

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

// The head pipeline is running and auto-merge is not armed, so the Merge menu
// offers the auto-merge items.
const PIPELINE_RUNNING = {
  autoMergeEnabled: false,
  detailedMergeStatus: "ci_still_running",
  pipelineStatus: "running",
} as unknown as GitLabMrMergeState;

const one = (
  kind: "squash" | "merge",
  title: string,
  body = "",
): MergeMessageDefaults => ({
  commits: [{ kind, message: { title, body }, exact: true }],
  reason: null,
});
const TWO_COMMITS: MergeMessageDefaults = {
  commits: [
    { kind: "squash", message: { title: "Squash it", body: "" }, exact: true },
    {
      kind: "merge",
      message: { title: "Merge branch 'feat' into 'main'", body: "" },
      exact: true,
    },
  ],
  reason: null,
};

function pr(number = 7): PrDetails {
  return {
    id: `PR_${number}`,
    number,
    title: `Merge request ${number}`,
    body: "",
    author: "someone",
    authorAvatarUrl: "",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feat",
    additions: 0,
    deletions: 0,
    url: `https://gitlab.com/owner/repo/-/merge_requests/${number}`,
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
  } as unknown as PrDetails;
}

function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const clients: QueryClient[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    throw new Error(`unexpected wire call: ${cmd}`);
  });
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(forgeStatus).mockResolvedValue(GITLAB);
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
  vi.mocked(forgePrMergeMessageDefaults).mockImplementation(
    async (_repo, number, strategy) =>
      strategy === "merge"
        ? one("merge", `Merge branch 'feat' into 'main' (!${number})`)
        : one("squash", `Squash ${number}`, "Body line"),
  );
  vi.mocked(forgeGlMrMergeState).mockResolvedValue(PIPELINE_RUNNING);
  vi.mocked(readRepoBranchRules).mockResolvedValue(null);
  useConfirm.setState({ request: null, requestHold: null });
  // The pulls tab shows this PR, so the view reveals it and runs its tab reads.
  useUiStore.setState({
    repoPath: REPO,
    repoTab: "pulls",
    selectedPr: { kind: "remote", id: "7" },
  });
});

// The real merge hook arms delayed list and run re-reads on success; they fire
// into the test's own client, which is unmounted and emptied here, so a later
// test's wire never sees them.
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

/** The commands the wire saw, printed only so a leaked read names itself. */
const wireCommands = () => vi.mocked(invoke).mock.calls.map(([cmd]) => cmd);
const wireCalls = () => vi.mocked(invoke).mock.calls;

/** The merge's wire payload for PR 7, with `over` applied. */
const mergeArgs = (over: Record<string, unknown> = {}) => ({
  repoPath: REPO,
  number: 7,
  strategy: "squash",
  deleteBranch: false,
  sha: SHA,
  lens: "origin",
  squashMessage: null,
  mergeMessage: null,
  ...over,
});

/** Opens the merge dialog through the footer's Merge menu `item`. */
async function openMerge(
  user: ReturnType<typeof userEvent.setup>,
  item: string,
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

/** Opens the row `edit` names and replaces the title `field` names. */
async function editTitle(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  title: string,
  edit = "Edit commit message",
  field = "Commit title",
) {
  await user.click(await within(dialog).findByRole("button", { name: edit }));
  const input = within(dialog).getByRole("textbox", { name: field });
  await user.clear(input);
  await user.type(input, title);
}

const confirmIn = (dialog: HTMLElement, label = "Squash and merge") =>
  within(dialog).getByRole("button", { name: label });

describe("RemotePrView: the merge message", () => {
  it("reads the defaults only once the dialog opens, and never at the wire", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("button", { name: "Merge" }, { timeout: 3000 });
    await settle();
    expect(forgePrMergeMessageDefaults).not.toHaveBeenCalled();
    expect(wireCommands()).toEqual([]);
    const dialog = await openMerge(user, "Squash and merge");
    await within(dialog).findByText("Squash 7");
    expect(forgePrMergeMessageDefaults).toHaveBeenCalledTimes(1);
    expect(forgePrMergeMessageDefaults).toHaveBeenCalledWith(
      REPO,
      7,
      "squash",
      "origin",
    );
    expect(wireCommands()).toEqual([]);
  });

  it("an untouched confirm sends no message", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await openMerge(user, "Squash and merge");
    await within(dialog).findByText("Squash 7");
    expect(wireCommands()).toEqual([]);
    // Answered only after the pending merge has rendered, as a real IPC merge is.
    const run = deferred<unknown>();
    vi.mocked(invoke).mockImplementationOnce(() => run.promise);
    await user.click(confirmIn(dialog));
    await waitFor(() => expect(wireCommands()).toHaveLength(1));
    await settle();
    await act(async () =>
      run.resolve({ queued: false, cleanupWarning: null, stacked: false }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Merged #7"),
    );
    expect(wireCommands()).toHaveLength(1);
    expect(wireCalls()[0][1]).toStrictEqual(mergeArgs());
    await settle();
    expect(wireCommands()).toHaveLength(1);
    expect(gitFetch).toHaveBeenCalledTimes(1);
    expect(gitFetch).toHaveBeenCalledWith(REPO);
    // The merge's own settle never re-reads the defaults of the PR it merged.
    expect(forgePrMergeMessageDefaults).toHaveBeenCalledTimes(1);
  });

  it("an edited confirm sends the edited text in its row's slot", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await openMerge(user, "Squash and merge");
    await editTitle(user, dialog, "Edited squash");
    expect(wireCommands()).toEqual([]);
    vi.mocked(invoke).mockResolvedValueOnce({
      queued: false,
      cleanupWarning: null,
      stacked: false,
    });
    await user.click(confirmIn(dialog));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Merged #7"),
    );
    expect(wireCommands()).toHaveLength(1);
    expect(wireCalls()[0][1]).toStrictEqual(
      mergeArgs({
        squashMessage: { title: "Edited squash", body: "Body line" },
      }),
    );
    await settle();
    expect(wireCommands()).toHaveLength(1);
    expect(gitFetch).toHaveBeenCalledTimes(1);
    expect(gitFetch).toHaveBeenCalledWith(REPO);
  });

  it("a two-commit merge sends each row's text in its own slot", async () => {
    const user = userEvent.setup();
    vi.mocked(forgePrMergeMessageDefaults).mockResolvedValue(TWO_COMMITS);
    mount();
    const dialog = await openMerge(user, "Squash and merge");
    await editTitle(
      user,
      dialog,
      "Squash words",
      "Edit squash commit message",
      "Squash commit title",
    );
    await editTitle(
      user,
      dialog,
      "Merge words",
      "Edit merge commit message",
      "Merge commit title",
    );
    expect(wireCommands()).toEqual([]);
    vi.mocked(invoke).mockResolvedValueOnce({
      queued: false,
      cleanupWarning: null,
      stacked: false,
    });
    await user.click(confirmIn(dialog));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Merged #7"),
    );
    expect(wireCommands()).toHaveLength(1);
    expect(wireCalls()[0][1]).toStrictEqual(
      mergeArgs({
        squashMessage: { title: "Squash words", body: "" },
        mergeMessage: { title: "Merge words", body: "" },
      }),
    );
    await settle();
    expect(wireCommands()).toHaveLength(1);
    expect(gitFetch).toHaveBeenCalledTimes(1);
    expect(gitFetch).toHaveBeenCalledWith(REPO);
  });

  it("GitLab auto-merge carries both messages to the wire", async () => {
    const user = userEvent.setup();
    vi.mocked(forgePrMergeMessageDefaults).mockResolvedValue(TWO_COMMITS);
    mount();
    const dialog = await openMerge(user, "Auto-merge: Squash and merge");
    await editTitle(
      user,
      dialog,
      "Squash words",
      "Edit squash commit message",
      "Squash commit title",
    );
    await editTitle(
      user,
      dialog,
      "Merge words",
      "Edit merge commit message",
      "Merge commit title",
    );
    expect(wireCommands()).toEqual([]);
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await user.click(confirmIn(dialog, "Enable auto-merge"));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Auto-merge enabled for #7 — merges when the pipeline passes",
      ),
    );
    expect(wireCommands()).toEqual(["forge_gl_mr_auto_merge"]);
    expect(wireCalls()[0][1]).toStrictEqual({
      repoPath: REPO,
      number: 7,
      strategy: "squash",
      deleteBranch: false,
      sha: SHA,
      squashMessage: { title: "Squash words", body: "" },
      mergeMessage: { title: "Merge words", body: "" },
    });
    await settle();
    expect(wireCommands()).toEqual(["forge_gl_mr_auto_merge"]);
    expect(gitFetch).not.toHaveBeenCalled();
  });

  it("a failed auto-merge arm after an edit keeps the dialog, the text and the failure", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await openMerge(user, "Auto-merge: Squash and merge");
    await editTitle(user, dialog, "Edited squash");
    expect(wireCommands()).toEqual([]);
    vi.mocked(invoke).mockRejectedValueOnce({
      kind: "glab",
      message: "405 Method Not Allowed",
    });
    await user.click(confirmIn(dialog, "Enable auto-merge"));
    const alert = await within(dialog).findByRole("alert");
    await settle();
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(dialog).toHaveAttribute("data-open");
    expect(alert).toHaveTextContent("405 Method Not Allowed");
    expect(alert).toHaveTextContent(STILL_HERE);
    expect(
      within(dialog).getByRole("textbox", { name: "Commit title" }),
    ).toHaveValue("Edited squash");
    expect(wireCommands()).toEqual(["forge_gl_mr_auto_merge"]);
    expect(wireCalls()[0][1]).toStrictEqual({
      repoPath: REPO,
      number: 7,
      strategy: "squash",
      deleteBranch: false,
      sha: SHA,
      squashMessage: { title: "Edited squash", body: "Body line" },
      mergeMessage: null,
    });
    expect(gitFetch).not.toHaveBeenCalled();
  });

  it("a merge that fails after an edit keeps the dialog, the text and the failure", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await openMerge(user, "Squash and merge");
    await editTitle(user, dialog, "Edited squash");
    expect(wireCommands()).toEqual([]);
    const run = deferred<unknown>();
    vi.mocked(invoke).mockImplementationOnce(() => run.promise);
    await user.click(confirmIn(dialog));
    await waitFor(() => expect(wireCommands()).toHaveLength(1));
    await act(async () =>
      run.reject({ kind: "glab", message: "405 Method Not Allowed" }),
    );
    const alert = await within(dialog).findByRole("alert");
    // Past the close transition: a dialog closing in the same commit would be gone.
    await settle();
    expect(alert).toHaveTextContent("405 Method Not Allowed");
    expect(alert).toHaveTextContent(STILL_HERE);
    expect(
      within(dialog).getByRole("textbox", { name: "Commit title" }),
    ).toHaveValue("Edited squash");
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(dialog).toHaveAttribute("data-open");
    expect(wireCalls()[0][1]).toStrictEqual(
      mergeArgs({
        squashMessage: { title: "Edited squash", body: "Body line" },
      }),
    );
    await settle();
    expect(wireCommands()).toHaveLength(1);
    expect(gitFetch).not.toHaveBeenCalled();
    // Once the merge is no longer pending, the open dialog reads its defaults again.
    await waitFor(() =>
      expect(forgePrMergeMessageDefaults).toHaveBeenCalledTimes(2),
    );
  });

  it("an edited merge's refusal reads without the error kind's lead", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await openMerge(user, "Squash and merge");
    await editTitle(user, dialog, "Edited squash");
    vi.mocked(invoke).mockRejectedValueOnce({
      kind: "invalidArgument",
      message:
        "invalid argument: The commit title is too long (1,100 characters; the limit is 1,024).",
    });
    await user.click(confirmIn(dialog));
    const alert = await within(dialog).findByRole("alert");
    await settle();
    expect(
      within(alert).getByText(
        "The commit title is too long (1,100 characters; the limit is 1,024).",
      ),
    ).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent(/invalid argument/i);
  });

  it("an edited merge's failure of another kind reads as the forge wrote it", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await openMerge(user, "Squash and merge");
    await editTitle(user, dialog, "Edited squash");
    vi.mocked(invoke).mockRejectedValueOnce({
      kind: "gh",
      message:
        "Pull request is not mergeable: the base branch policy prohibits the merge.",
    });
    await user.click(confirmIn(dialog));
    const alert = await within(dialog).findByRole("alert");
    await settle();
    expect(
      within(alert).getByText(
        "Pull request is not mergeable: the base branch policy prohibits the merge.",
      ),
    ).toBeInTheDocument();
  });

  it("a second confirm after an edited failure clears the alert and sends the same args", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await openMerge(user, "Squash and merge");
    await editTitle(user, dialog, "Edited squash");
    expect(wireCommands()).toEqual([]);
    vi.mocked(invoke).mockRejectedValueOnce({
      kind: "glab",
      message: "405 Method Not Allowed",
    });
    await user.click(confirmIn(dialog));
    await within(dialog).findByRole("alert");
    expect(wireCommands()).toHaveLength(1);
    const run = deferred<unknown>();
    vi.mocked(invoke).mockImplementationOnce(() => run.promise);
    await user.click(confirmIn(dialog));
    await waitFor(() => expect(wireCommands()).toHaveLength(2));
    expect(within(dialog).queryByRole("alert")).toBeNull();
    await act(async () =>
      run.resolve({ queued: false, cleanupWarning: null, stacked: false }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Merged #7"),
    );
    const sent = mergeArgs({
      squashMessage: { title: "Edited squash", body: "Body line" },
    });
    expect(wireCalls()[0][1]).toStrictEqual(sent);
    expect(wireCalls()[1][1]).toStrictEqual(sent);
    await settle();
    expect(wireCommands()).toHaveLength(2);
    expect(gitFetch).toHaveBeenCalledTimes(1);
    expect(gitFetch).toHaveBeenCalledWith(REPO);
  });

  it("a merge that fails with no edit closes the dialog", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await openMerge(user, "Squash and merge");
    await within(dialog).findByText("Squash 7");
    expect(wireCommands()).toEqual([]);
    vi.mocked(invoke).mockRejectedValueOnce({
      kind: "glab",
      message: "405 Method Not Allowed",
    });
    await user.click(confirmIn(dialog));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(wireCommands()).toHaveLength(1);
    expect(wireCalls()[0][1]).toStrictEqual(mergeArgs());
    await settle();
    expect(wireCommands()).toHaveLength(1);
    expect(gitFetch).not.toHaveBeenCalled();
  });

  it("a close with no failure reopens at rest", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await openMerge(user, "Squash and merge");
    await editTitle(user, dialog, "Edited squash");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const again = await openMerge(user, "Squash and merge");
    await within(again).findByText("Squash 7");
    expect(
      within(again).queryByRole("textbox", { name: "Commit title" }),
    ).toBeNull();
    expect(wireCommands()).toEqual([]);
  });

  it("a press on the closing dialog after a switch to another PR merges nothing", async () => {
    const user = userEvent.setup();
    const view = mount();
    const dialog = await openMerge(user, "Squash and merge");
    await within(dialog).findByText("Squash 7");
    const button = confirmIn(dialog);
    view.show(8);
    // The press must land while the popup is still mounted, mid-exit.
    expect(button.isConnected).toBe(true);
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await settle();
    expect(wireCommands()).toEqual([]);
  });

  it("another PR closes the dialog and opens at rest, with no kept failure", async () => {
    const user = userEvent.setup();
    const view = mount();
    // The failure and the reopen share one menu item, so a failure kept across
    // the switch would come back on the reopen.
    const item = "Create a merge commit";
    const dialog = await openMerge(user, item);
    await editTitle(user, dialog, "Edited merge");
    expect(wireCommands()).toEqual([]);
    vi.mocked(invoke).mockRejectedValueOnce({
      kind: "glab",
      message: "405 Method Not Allowed",
    });
    await user.click(confirmIn(dialog, item));
    await within(dialog).findByRole("alert");
    expect(wireCalls()[0][1]).toStrictEqual(
      mergeArgs({
        strategy: "merge",
        mergeMessage: { title: "Edited merge", body: "" },
      }),
    );
    view.show(8);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const next = await openMerge(user, item);
    // Checked before the default lands: a kept row would replace its text.
    expect(within(next).queryByRole("alert")).toBeNull();
    expect(
      within(next).queryByRole("textbox", { name: "Commit title" }),
    ).toBeNull();
    await within(next).findByText("Merge branch 'feat' into 'main' (!8)");
    expect(
      within(next).queryByRole("textbox", { name: "Commit title" }),
    ).toBeNull();
    expect(wireCommands()).toHaveLength(1);
  });

  it("a failure after a mid-flight close comes back only with the same strategy", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await openMerge(user, "Squash and merge");
    await editTitle(user, dialog, "Edited squash");
    expect(wireCommands()).toEqual([]);
    const run = deferred<unknown>();
    vi.mocked(invoke).mockImplementationOnce(() => run.promise);
    await user.click(confirmIn(dialog));
    await waitFor(() => expect(wireCommands()).toHaveLength(1));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // While the merge is pending the Merge trigger is held, so no second open
    // request can start a newer session.
    expect(screen.getByRole("button", { name: "Merge" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await act(async () =>
      run.reject({ kind: "glab", message: "405 Method Not Allowed" }),
    );
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(wireCalls()[0][1]).toStrictEqual(
      mergeArgs({
        squashMessage: { title: "Edited squash", body: "Body line" },
      }),
    );
    const kept = await openMerge(user, "Squash and merge");
    expect(
      within(kept).getByRole("textbox", { name: "Commit title" }),
    ).toHaveValue("Edited squash");
    expect(within(kept).getByRole("alert")).toHaveTextContent(STILL_HERE);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const other = await openMerge(user, "Create a merge commit");
    await within(other).findByText("Merge branch 'feat' into 'main' (!7)");
    expect(within(other).queryByRole("alert")).toBeNull();
    expect(
      within(other).queryByRole("textbox", { name: "Commit title" }),
    ).toBeNull();
    expect(wireCommands()).toHaveLength(1);
  });

  it("a failed defaults read offers Retry, which reads again", async () => {
    const user = userEvent.setup();
    vi.mocked(forgePrMergeMessageDefaults)
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValue(one("squash", "Squash 7"));
    mount();
    const dialog = await openMerge(user, "Squash and merge");
    // The sr-only status repeats the line, so the visible paragraph is named.
    await within(dialog).findByText(
      "Couldn't load GitLab's default message. Without it, GitLab writes its own default.",
      { selector: "p" },
    );
    await user.click(within(dialog).getByRole("button", { name: "Retry" }));
    await within(dialog).findByText("Squash 7");
    expect(forgePrMergeMessageDefaults).toHaveBeenCalledTimes(2);
    expect(wireCommands()).toEqual([]);
  });
});

const GITHUB = {
  ...GITLAB,
  provider: "github",
  host: "github.com",
  implemented: {},
} as unknown as ForgeStatus;

const withHead = (
  defaults: MergeMessageDefaults,
  headSha: string | null,
): MergeMessageDefaults => ({ ...defaults, headSha });

/** The first merge payload the wire saw (the one wire call carrying a
 *  strategy), or undefined. */
const mergeCall = () =>
  wireCalls().find(
    ([, args]) =>
      typeof args === "object" && args !== null && "strategy" in args,
  )?.[1];

/** Moves the view's head to `sha` by refetching only the exact details read. */
async function moveHead(client: QueryClient, sha: string) {
  vi.mocked(forgePrView).mockImplementation(async (_repo, number) => ({
    ...pr(number),
    headSha: sha,
  }));
  await act(() =>
    client.refetchQueries({ queryKey: DETAILS_KEY, exact: true }),
  );
}

describe("RemotePrView: an edited merge binds to its defaults' head", () => {
  it("an edited confirm sends the head the defaults were read at", async () => {
    const user = userEvent.setup();
    vi.mocked(forgePrMergeMessageDefaults).mockResolvedValue(
      withHead(one("squash", "Squash 7", "Body line"), READ_SHA),
    );
    mount();
    const dialog = await openMerge(user, "Squash and merge");
    await editTitle(user, dialog, "Edited squash");
    vi.mocked(invoke).mockResolvedValueOnce({
      queued: false,
      cleanupWarning: null,
      stacked: false,
    });
    await user.click(confirmIn(dialog));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Merged #7"),
    );
    expect(mergeCall()).toStrictEqual(
      mergeArgs({
        sha: READ_SHA,
        squashMessage: { title: "Edited squash", body: "Body line" },
      }),
    );
  });

  it("an untouched confirm sends the view's head whatever the defaults read", async () => {
    const user = userEvent.setup();
    vi.mocked(forgePrMergeMessageDefaults).mockResolvedValue(
      withHead(one("squash", "Squash 7", "Body line"), READ_SHA),
    );
    mount();
    const dialog = await openMerge(user, "Squash and merge");
    await within(dialog).findByText("Squash 7");
    vi.mocked(invoke).mockResolvedValueOnce({
      queued: false,
      cleanupWarning: null,
      stacked: false,
    });
    await user.click(confirmIn(dialog));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Merged #7"),
    );
    expect(mergeCall()).toStrictEqual(mergeArgs());
  });

  it("an edited confirm whose defaults name no head sends the view's", async () => {
    const user = userEvent.setup();
    vi.mocked(forgePrMergeMessageDefaults).mockResolvedValue(
      withHead(one("squash", "Squash 7", "Body line"), null),
    );
    mount();
    const dialog = await openMerge(user, "Squash and merge");
    await editTitle(user, dialog, "Edited squash");
    vi.mocked(invoke).mockResolvedValueOnce({
      queued: false,
      cleanupWarning: null,
      stacked: false,
    });
    await user.click(confirmIn(dialog));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Merged #7"),
    );
    expect(mergeCall()).toStrictEqual(
      mergeArgs({
        squashMessage: { title: "Edited squash", body: "Body line" },
      }),
    );
  });

  it("a moved head re-reads the defaults: the untouched field follows, the typed one stays", async () => {
    const user = userEvent.setup();
    vi.mocked(forgePrMergeMessageDefaults).mockResolvedValue(
      withHead(one("squash", "Squash 7", "Body line"), SHA),
    );
    const view = mount();
    const dialog = await openMerge(user, "Squash and merge");
    await editTitle(user, dialog, "Edited squash");
    expect(forgePrMergeMessageDefaults).toHaveBeenCalledTimes(1);
    vi.mocked(forgePrMergeMessageDefaults).mockResolvedValue(
      withHead(one("squash", "Squash 7 moved", "Body moved"), MOVED_SHA),
    );
    await moveHead(view.client, MOVED_SHA);
    const body = within(dialog).getByRole("textbox", {
      name: "Commit description",
    });
    await waitFor(() => expect(body).toHaveValue("Body moved"));
    expect(forgePrMergeMessageDefaults).toHaveBeenCalledTimes(2);
    expect(
      within(dialog).getByRole("textbox", { name: "Commit title" }),
    ).toHaveValue("Edited squash");
    vi.mocked(invoke).mockResolvedValueOnce({
      queued: false,
      cleanupWarning: null,
      stacked: false,
    });
    await user.click(confirmIn(dialog));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Merged #7"),
    );
    expect(mergeCall()).toStrictEqual(
      mergeArgs({
        sha: MOVED_SHA,
        squashMessage: { title: "Edited squash", body: "Body moved" },
      }),
    );
  });

  it("a re-read that moves only the head still moves the head an edit binds to", async () => {
    const user = userEvent.setup();
    const text = one("squash", "Squash 7", "Body line");
    vi.mocked(forgePrMergeMessageDefaults).mockResolvedValue(
      withHead(text, READ_SHA),
    );
    const view = mount();
    const dialog = await openMerge(user, "Squash and merge");
    await editTitle(user, dialog, "Edited squash");
    vi.mocked(forgePrMergeMessageDefaults).mockResolvedValue(
      withHead(text, MOVED_SHA),
    );
    await moveHead(view.client, MOVED_SHA);
    await waitFor(() =>
      expect(forgePrMergeMessageDefaults).toHaveBeenCalledTimes(2),
    );
    await settle();
    // A reset whose re-read never answers: the dialog falls back to the last
    // ready plan it saw, which must be the re-read at the moved head.
    vi.mocked(forgePrMergeMessageDefaults).mockReturnValue(
      new Promise(() => undefined),
    );
    act(() => {
      void view.client.resetQueries({ queryKey: DEFAULTS_KEY, exact: true });
    });
    await settle();
    vi.mocked(invoke).mockResolvedValueOnce({
      queued: false,
      cleanupWarning: null,
      stacked: false,
    });
    await user.click(confirmIn(dialog));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Merged #7"),
    );
    expect(mergeCall()).toStrictEqual(
      mergeArgs({
        sha: MOVED_SHA,
        squashMessage: { title: "Edited squash", body: "Body line" },
      }),
    );
  });

  it("an edited GitLab auto-merge arm sends the head the defaults were read at", async () => {
    const user = userEvent.setup();
    vi.mocked(forgePrMergeMessageDefaults).mockResolvedValue(
      withHead(one("squash", "Squash 7", "Body line"), READ_SHA),
    );
    mount();
    const dialog = await openMerge(user, "Auto-merge: Squash and merge");
    await editTitle(user, dialog, "Edited squash");
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await user.click(confirmIn(dialog, "Enable auto-merge"));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Auto-merge enabled for #7 — merges when the pipeline passes",
      ),
    );
    expect(wireCommands()).toEqual(["forge_gl_mr_auto_merge"]);
    expect(wireCalls()[0][1]).toStrictEqual({
      repoPath: REPO,
      number: 7,
      strategy: "squash",
      deleteBranch: false,
      sha: READ_SHA,
      squashMessage: { title: "Edited squash", body: "Body line" },
      mergeMessage: null,
    });
  });

  it("a failed edited merge re-reads the defaults", async () => {
    const user = userEvent.setup();
    vi.mocked(forgePrMergeMessageDefaults).mockResolvedValue(
      withHead(one("squash", "Squash 7", "Body line"), READ_SHA),
    );
    mount();
    const dialog = await openMerge(user, "Squash and merge");
    await editTitle(user, dialog, "Edited squash");
    expect(forgePrMergeMessageDefaults).toHaveBeenCalledTimes(1);
    vi.mocked(forgePrMergeMessageDefaults).mockResolvedValue(
      withHead(one("squash", "Squash 7 again", "Body again"), MOVED_SHA),
    );
    vi.mocked(invoke).mockRejectedValueOnce({
      kind: "glab",
      message: "405 Method Not Allowed",
    });
    await user.click(confirmIn(dialog));
    await within(dialog).findByRole("alert");
    await waitFor(() =>
      expect(forgePrMergeMessageDefaults).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(
        within(dialog).getByRole("textbox", { name: "Commit description" }),
      ).toHaveValue("Body again"),
    );
    vi.mocked(invoke).mockResolvedValueOnce({
      queued: false,
      cleanupWarning: null,
      stacked: false,
    });
    await user.click(confirmIn(dialog));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Merged #7"),
    );
    const merges = wireCalls().filter(
      ([, args]) =>
        typeof args === "object" && args !== null && "strategy" in args,
    );
    expect(merges).toHaveLength(2);
    expect(merges[1][1]).toStrictEqual(
      mergeArgs({
        sha: MOVED_SHA,
        squashMessage: { title: "Edited squash", body: "Body again" },
      }),
    );
  });
});

describe("RemotePrView: an open dialog obeys its method's restrictions", () => {
  it("a branch rule that arrives while the dialog is open holds its confirm", async () => {
    const user = userEvent.setup();
    vi.mocked(forgeStatus).mockResolvedValue(GITHUB);
    const view = mount();
    const dialog = await openMerge(user, "Squash and merge");
    await within(dialog).findByText("Squash 7");
    const confirm = confirmIn(dialog);
    expect(confirm).not.toHaveAttribute("aria-disabled");
    vi.mocked(readRepoBranchRules).mockResolvedValue(
      JSON.stringify({
        ...EMPTY_BRANCH_RULES,
        protections: [
          {
            id: "main",
            pattern: "main",
            blockDeletion: false,
            blockForcePush: false,
            requirePr: false,
            allowedMergeMethods: ["merge", "rebase"],
          },
        ],
      }),
    );
    await act(() =>
      view.client.invalidateQueries({
        queryKey: sharedBranchRulesOptions(REPO).queryKey,
      }),
    );
    await waitFor(() =>
      expect(confirm).toHaveAccessibleDescription(
        "A branch rule blocks this merge method.",
      ),
    );
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    await user.click(confirm);
    await settle();
    expect(mergeCall()).toBeUndefined();
    expect(screen.getByRole("dialog")).toHaveAttribute("data-open");
  });

  it("a repository setting that disables the method while open holds its confirm", async () => {
    const user = userEvent.setup();
    vi.mocked(forgeStatus).mockResolvedValue(GITHUB);
    const view = mount();
    const dialog = await openMerge(user, "Squash and merge");
    await within(dialog).findByText("Squash 7");
    const confirm = confirmIn(dialog);
    expect(confirm).not.toHaveAttribute("aria-disabled");
    vi.mocked(forgePrView).mockImplementation(async (_repo, number) => ({
      ...pr(number),
      squashMergeAllowed: false,
    }));
    await act(() =>
      view.client.refetchQueries({ queryKey: DETAILS_KEY, exact: true }),
    );
    await waitFor(() =>
      expect(confirm).toHaveAccessibleDescription(
        "This merge method is disabled in repository settings.",
      ),
    );
    await user.click(confirm);
    await settle();
    expect(mergeCall()).toBeUndefined();
  });

  it("a head guard lost while the dialog is open holds its confirm", async () => {
    const user = userEvent.setup();
    const view = mount();
    const dialog = await openMerge(user, "Squash and merge");
    await within(dialog).findByText("Squash 7");
    const confirm = confirmIn(dialog);
    await moveHead(view.client, "");
    await waitFor(() =>
      expect(confirm).toHaveAccessibleDescription(
        "Reload to merge — couldn't load the head commit to guard the merge",
      ),
    );
    await user.click(confirm);
    await settle();
    expect(mergeCall()).toBeUndefined();
  });
});

/** Answers the view's details with `state` by refetching only the exact read. */
async function answerState(client: QueryClient, state: string) {
  vi.mocked(forgePrView).mockImplementation(async (_repo, number) => ({
    ...pr(number),
    state,
  }));
  await act(() =>
    client.refetchQueries({ queryKey: DETAILS_KEY, exact: true }),
  );
}

/** The merge writes the wire saw: the calls carrying a strategy. */
const mergeWrites = () =>
  wireCalls().filter(
    ([, args]) =>
      typeof args === "object" && args !== null && "strategy" in args,
  ).length;

describe("RemotePrView: a pull request no longer open holds the merge", () => {
  it.each([
    ["GitLab", "MERGED", "This merge request is no longer open."],
    ["GitLab", "CLOSED", "This merge request is no longer open."],
    ["GitHub", "MERGED", "This pull request is no longer open."],
  ] as const)(
    "%s, answered %s after an edited failure",
    async (host, state, reason) => {
      const user = userEvent.setup();
      if (host === "GitHub") vi.mocked(forgeStatus).mockResolvedValue(GITHUB);
      const view = mount();
      const dialog = await openMerge(user, "Squash and merge");
      await editTitle(user, dialog, "Edited squash");
      // Keyed on the merge's payload: GitHub's view can reach the wire with
      // another call first, which a once-only answer would go to.
      vi.mocked(invoke).mockImplementation(async (cmd, args) => {
        if (typeof args === "object" && args !== null && "strategy" in args)
          throw {
            kind: host === "GitHub" ? "gh" : "glab",
            message: "405 Method Not Allowed",
          };
        throw new Error(`unexpected wire call: ${cmd}`);
      });
      await user.click(confirmIn(dialog));
      const alert = await within(dialog).findByRole("alert");
      await settle();
      expect(mergeWrites()).toBe(1);
      const confirm = confirmIn(dialog);
      await answerState(view.client, state);
      await waitFor(() => expect(confirm).toHaveAccessibleDescription(reason));
      expect(confirm).toHaveAttribute("aria-disabled", "true");
      await user.click(confirm);
      await settle();
      expect(mergeWrites()).toBe(1);
      expect(alert).toHaveTextContent("405 Method Not Allowed");
      expect(alert).toHaveTextContent(STILL_HERE);
      expect(
        within(dialog).getByRole("textbox", { name: "Commit title" }),
      ).toHaveValue("Edited squash");
      expect(screen.getByRole("dialog")).toHaveAttribute("data-open");
    },
  );
});

describe("RemotePrView: an edited merge's failure line matches its toast", () => {
  it.each([
    ["network", "proxyconnect tcp: connection refused"],
    ["rate limit", "HTTP 429: too many requests, connection refused"],
  ])("%s", async (_name, message) => {
    const user = userEvent.setup();
    mount();
    const dialog = await openMerge(user, "Squash and merge");
    await editTitle(user, dialog, "Edited squash");
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "glab", message });
    await user.click(confirmIn(dialog));
    const alert = await within(dialog).findByRole("alert");
    await settle();
    const title = vi.mocked(toast.error).mock.calls.at(-1)?.[0];
    expect(typeof title).toBe("string");
    expect(title).not.toBe(message);
    expect(alert.querySelector("p")?.textContent).toBe(title);
    expect(alert).not.toHaveTextContent(message);
  });
});
