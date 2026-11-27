import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
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
import {
  mergeNotOpenReason,
  RemotePrView,
} from "@/features/pulls/RemotePrView";
import {
  forgeGlMrMergeState,
  forgePrApprovals,
  forgePrMergeMessageDefaults,
  forgePrReviewThreads,
  forgePrView,
  forgeStatus,
  readRepoBranchRules,
} from "@/lib/git/api";
import type {
  ForgeStatus,
  GitLabMrMergeState,
  MergeMessageDefaults,
  PrDetails,
} from "@/lib/git/types";
import { getAvailableSnapshot } from "@/lib/hotkeys/handler-registry";
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
// The details read's exact key, refetched alone to move the view's head.
const DETAILS_KEY = ["repo", REPO, "pr", "origin", 7] as const;
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

const LOCKED_SLIM = {
  autoMergeEnabled: false,
  detailedMergeStatus: "",
  pipelineStatus: "",
  pipelineUrl: "",
  locked: true,
  state: "MERGING",
} as GitLabMrMergeState;

const LANDED = { queued: false, cleanupWarning: null, stacked: false };

const withState = (state: string) =>
  vi.mocked(forgePrView).mockImplementation(async (_repo, number) => ({
    ...pr(number),
    state,
  }));

const refetchDetails = (client: QueryClient) =>
  act(() => client.invalidateQueries({ queryKey: DETAILS_KEY, exact: true }));

/** The buttons of the request's state footer, by their accessible names. */
const footerButtons = () =>
  ["Merge", "Close", "Close with comment", "Reopen"].flatMap((name) =>
    screen.queryAllByRole("button", { name }),
  );

describe("RemotePrView after a landed merge", () => {
  it("shows the request merged right after the success toast (AC10, AC16)", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await openMerge(user, "Squash and merge");
    await within(dialog).findByText("Squash 7");
    vi.mocked(invoke).mockResolvedValueOnce(LANDED);
    // The forge's own details read keeps answering OPEN, as GitLab's lags.
    await user.click(confirmIn(dialog));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Merged #7"),
    );
    expect(screen.getAllByText("merged").length).toBeGreaterThan(0);
    expect(screen.queryByText("open")).toBeNull();
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    await settle();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText("open")).toBeNull();
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    // The Merge trigger is gone, so the close lands on the framed view itself,
    // never on a control inside it (Enter there would act).
    const focused = document.activeElement;
    expect(focused).toHaveAttribute("tabindex", "-1");
    expect(focused?.parentElement?.closest('[tabindex="-1"]')).toBeNull();
    expect(focused).toHaveTextContent("Merge request 7");
  });
});

describe("RemotePrView on a merge request GitLab is still merging", () => {
  beforeEach(() => {
    vi.mocked(forgeGlMrMergeState).mockResolvedValue(LOCKED_SLIM);
  });

  it("reads merging, with no Reopen and no Merge or Close (AC11)", async () => {
    withState("MERGING");
    mount();
    await waitFor(() =>
      expect(screen.getAllByText("merging").length).toBeGreaterThan(0),
    );
    await settle();
    expect(footerButtons()).toEqual([]);
    expect(screen.queryByText("closed")).toBeNull();
  });

  it("watches the slim read and leaves merging once it unlocks (AC14)", async () => {
    const slim = deferred<GitLabMrMergeState>();
    vi.mocked(forgeGlMrMergeState).mockImplementation(() => slim.promise);
    withState("MERGING");
    mount();
    await waitFor(() =>
      expect(screen.getAllByText("merging").length).toBeGreaterThan(0),
    );
    await waitFor(() =>
      expect(vi.mocked(forgeGlMrMergeState)).toHaveBeenCalledWith(REPO, 7),
    );
    withState("OPEN");
    await act(async () =>
      slim.resolve({ ...LOCKED_SLIM, locked: false, state: "OPEN" }),
    );
    await waitFor(() => expect(screen.queryByText("merging")).toBeNull());
    expect(screen.getAllByText("open").length).toBeGreaterThan(0);
  });

  it("holds the open dialog's confirm with its own reason (AC11)", async () => {
    const user = userEvent.setup();
    const { client } = mount();
    const dialog = await openMerge(user, "Squash and merge");
    await within(dialog).findByText("Squash 7");
    withState("MERGING");
    await refetchDetails(client);
    await waitFor(() =>
      expect(confirmIn(dialog)).toHaveAccessibleDescription(
        "This merge request is already being merged.",
      ),
    );
    expect(wireCommands()).toEqual([]);
  });

  it("keeps the not-open reason for a closed request (AC11)", async () => {
    const user = userEvent.setup();
    const { client } = mount();
    const dialog = await openMerge(user, "Squash and merge");
    await within(dialog).findByText("Squash 7");
    withState("CLOSED");
    await refetchDetails(client);
    await waitFor(() =>
      expect(confirmIn(dialog)).toHaveAccessibleDescription(
        "This merge request is no longer open.",
      ),
    );
  });

  it("an edited failure whose refresh answers merged keeps the dialog and holds it (AC11)", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await openMerge(user, "Squash and merge");
    await editTitle(user, dialog, "Edited squash");
    const run = deferred<unknown>();
    vi.mocked(invoke).mockImplementationOnce(() => run.promise);
    await user.click(confirmIn(dialog));
    await waitFor(() => expect(wireCommands()).toHaveLength(1));
    const reads = vi.mocked(forgePrView).mock.calls.length;
    withState("MERGED");
    await act(async () =>
      run.reject({ kind: "glab", message: "405 Method Not Allowed" }),
    );
    const alert = await within(dialog).findByRole("alert");
    await settle();
    expect(vi.mocked(forgePrView).mock.calls.length).toBeGreaterThan(reads);
    expect(alert).toHaveTextContent(STILL_HERE);
    expect(screen.getByRole("dialog")).toBe(dialog);
    await waitFor(() =>
      expect(confirmIn(dialog)).toHaveAccessibleDescription(
        "This merge request is no longer open.",
      ),
    );
  });
});

describe("the detail header's state badge", () => {
  it("never reads Draft over a request that is no longer open", async () => {
    vi.mocked(forgePrView).mockImplementation(async (_repo, number) => ({
      ...pr(number),
      state: "MERGED",
      isDraft: true,
    }));
    mount();
    await waitFor(() =>
      expect(screen.getAllByText("merged").length).toBeGreaterThan(0),
    );
    await settle();
    expect(screen.queryByText("Draft")).toBeNull();
  });
});

describe("the merge dialog's not-open reason", () => {
  it("names MERGING, and gives the default for any other key", () => {
    expect(mergeNotOpenReason("MERGING", "merge request")).toBe(
      "This merge request is already being merged.",
    );
    for (const state of ["CLOSED", "toString", "__proto__", "constructor"])
      expect(mergeNotOpenReason(state, "merge request")).toBe(
        "This merge request is no longer open.",
      );
  });
});

describe("the palette's Ready for review", () => {
  /** A GitLab draft MR whose draft toggle is implemented, in `state`. */
  async function readyEnabledIn(state: string) {
    vi.mocked(forgeStatus).mockResolvedValue({
      ...GITLAB,
      implemented: { ...GITLAB.implemented, mrDraftToggle: true },
    } as ForgeStatus);
    vi.mocked(forgePrView).mockImplementation(async (_repo, number) => ({
      ...pr(number),
      state,
      isDraft: true,
    }));
    const { client } = mount();
    await waitFor(() =>
      expect(
        (client.getQueryData(DETAILS_KEY) as PrDetails | undefined)?.state,
      ).toBe(state),
    );
    await settle();
    return getAvailableSnapshot().has("pr-ready-for-review");
  }

  it("is enabled on an open draft", async () => {
    expect(await readyEnabledIn("OPEN")).toBe(true);
  });

  for (const state of ["MERGED", "MERGING", "CLOSED"])
    it(`is not enabled on a ${state} draft`, async () => {
      vi.mocked(forgeGlMrMergeState).mockResolvedValue(LOCKED_SLIM);
      expect(await readyEnabledIn(state)).toBe(false);
    });
});
