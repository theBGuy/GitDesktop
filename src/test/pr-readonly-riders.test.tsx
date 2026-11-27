import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
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
import { Thread } from "@/features/conversations/Thread";
import {
  PrActivityFeed,
  usePrThreadClaims,
} from "@/features/pulls/PrActivityFeed";
import {
  closeWithheldMessage,
  isPrReactionRefusal,
  PR_REACTION_REFUSED_MESSAGE,
  RemotePrView,
  requestedWithoutCommentMessage,
  useLiveConversationHold,
} from "@/features/pulls/RemotePrView";
import {
  ReviewThreadCard,
  ThreadReplyHoldContext,
} from "@/features/pulls/ReviewThreads";
import { TabPanel } from "@/features/repository/TabPanel";
import { attachmentDiscard, attachmentStage } from "@/lib/attachments/api";
import {
  forgeAddReaction,
  forgePrApprovals,
  forgePrComment,
  forgePrRequestChanges,
  forgePrReviewThreads,
  forgePrUnrequestChanges,
  forgePrView,
  forgeStatus,
  gitRemotes,
} from "@/lib/git/api";
import {
  type ForgeStatus,
  PR_ARCHIVED_READONLY_MESSAGE,
  type PrDetails,
  type PrThreadOut,
  type ReviewThreadOut,
} from "@/lib/git/types";
import { lensKey } from "@/lib/repo-lens/queries";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

afterAll(() => expect(unmockedCommands).toEqual([]));

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(),
  forgePrView: vi.fn(),
  forgePrApprovals: vi.fn(),
  forgePrComment: vi.fn(),
  forgePrRequestChanges: vi.fn(async () => undefined),
  forgePrUnrequestChanges: vi.fn(async () => undefined),
  forgeAddReaction: vi.fn(),
  forgeRemoveReaction: vi.fn(),
  forgePrReviewThreads: vi.fn(),
  forgePrTimeline: vi.fn(async () => []),
  // The view's other reads, answered quietly so the transport records none.
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
  // The resolve worktree holds one conflicted file; every other tree is clean.
  gitStatus: vi.fn(async (repoPath: string) => ({
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
    entries:
      repoPath === "C:/wt/resolve-7"
        ? [{ path: "src/a.ts", staged: null, unstaged: "conflicted" }]
        : [],
  })),
  readRepoBranchRules: vi.fn(async () => null),
  // The GitHub fork's extra reads (the landing-focus frame cases).
  forgeRepoLabels: vi.fn(async () => []),
  ghTokenScopes: vi.fn(async () => ({ scopes: [], classic: false })),
  ghItemProjects: vi.fn(async () => ({ items: [], truncated: false })),
  gitRemoteUrl: vi.fn(async () => "https://github.com/owner/repo.git"),
  forgePrListPage: vi.fn(async () => ({ rows: [], capped: false })),
  // The conflict-resolution cases; read only on the Pull requests tab.
  forgePrMergeability: vi.fn(async () => ({
    state: "conflicting",
    detail: null,
  })),
  gitConflictPreview: vi.fn(async () => ({ status: "unknown", conflicts: [] })),
  gitFindRemotePrResolve: vi.fn(async () => null),
  gitMergeRemotePr: vi.fn(async () => ({
    status: "conflicts",
    conflicts: ["src/a.ts"],
    worktreePath: "C:/wt/resolve-7",
    worktreeId: "wt-7",
    pushedSha: null,
  })),
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
// The close is observed at its hook, as in attachment-pr-view.test.tsx.
const closePr = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/git/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/queries")>()),
  useClosePr: () => ({ mutateAsync: closePr, isPending: false }),
}));
vi.mock("@/lib/attachments/use-attachment-support", () => ({
  useAttachmentSupport: () => null,
}));
vi.mock("@/lib/attachments/api", () => ({
  attachmentStage: vi.fn(),
  attachmentDiscard: vi.fn(async () => undefined),
}));
// The view's lens, which a test flips to re-render the same number on another
// lens. With `real` set the real gate answers instead, for the cases that
// serve a signed-in GitHub fork and flip the lens through its cache.
const lensNow = vi.hoisted(() => ({
  value: "origin" as "origin" | "upstream",
  real: false,
}));
vi.mock("@/lib/repo-lens/queries", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/repo-lens/queries")>();
  return {
    ...actual,
    useRepoLens: (repo: string) =>
      // biome-ignore lint/correctness/useHookAtTopLevel: `real` is set before a test renders, so one mount always takes the same arm
      lensNow.real ? actual.useRepoLens(repo) : lensNow.value,
  };
});
vi.mock("@/lib/jira/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jira/store")>()),
  getJiraLink: vi.fn(async () => null),
}));
// The resolve worktree's one conflicted file, as its editor reads it.
vi.mock("@/lib/git/conflict", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/conflict")>()),
  conflictSides: vi.fn(async () => ({
    working: "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\n",
    base: "base\n",
    ours: "ours\n",
    theirs: "theirs\n",
    aiIgnored: { ignored: false, unreadable: false },
    workingExists: true,
    workingUndecodable: false,
    undecodable: false,
    workingHash: "deadbeef",
    workingMatchesSurvivor: null,
  })),
}));

const REPO = "C:/repo";
const GITLAB_LOCKED =
  "This conversation is locked, so only project members can comment.";
/** The lock's copy for a forge with no wording of its own (Bitbucket). */
const LOCKED_FALLBACK =
  "This conversation is locked, so you can't comment on it.";
const S4 = " Your reply is kept; Cancel discards it.";
const S5 = " Your edit is kept; Cancel discards it.";
const S6 = `Edit — ${PR_ARCHIVED_READONLY_MESSAGE}`;
const S7 = `Delete — ${PR_ARCHIVED_READONLY_MESSAGE}`;

const GITLAB = {
  provider: "gitlab",
  installed: true,
  authenticated: true,
  repo: "owner/repo",
  host: "gitlab.com",
  login: "me",
  capabilities: {},
  implemented: {
    mrComment: true,
    mrState: true,
    mrApprove: true,
    mrRequestChanges: true,
    mrThreadReply: true,
    mrCommentEdit: true,
  },
} as unknown as ForgeStatus;

/** A signed-in GitHub fork: with an `upstream` remote, the lens gate passes. */
const GITHUB_FORK = {
  ...GITLAB,
  provider: "github",
  host: "github.com",
  capabilities: {
    pullRequests: true,
    draftPrs: true,
    issues: true,
    labels: true,
    milestones: true,
    reactions: true,
    discussions: true,
    stars: true,
    ci: true,
    webhooks: true,
    approvals: true,
    securityFindings: true,
  },
  // Every flag GitHub's `Implemented::for_provider` turns on (forge/model.rs).
  implemented: {
    pullRequests: true,
    issues: true,
    ci: true,
    releases: true,
    insights: true,
    repoActions: true,
    publish: true,
    repoSettings: true,
    issueComment: true,
    issueState: true,
    mrComment: true,
    mrState: true,
    mrCommentEdit: true,
    issueCommentEdit: true,
    mrMerge: true,
    issueLabels: true,
    mrLabels: true,
    issueAssignees: true,
    issueCreate: true,
    mrCreate: true,
    ciRerun: true,
    ciJobRerun: true,
    ciCancel: true,
    ciDispatch: true,
    releaseCreate: true,
    releaseEdit: true,
    mrAssignees: true,
    mrReviewers: true,
    issueEdit: true,
    mrEdit: true,
    issueMilestone: true,
    issueReactions: true,
    mrReactions: true,
    issueLock: true,
    issueTransfer: true,
    issueDelete: true,
    mrReviewThreads: true,
    mrThreadReply: true,
    mrThreadResolve: true,
    mrThreadCommentEdit: true,
    commitComments: true,
    mrThreadCreate: true,
    mrReviewSubmit: true,
    repoSearch: true,
    repoForkByName: true,
    repoStar: true,
    repoReadme: true,
    forkActivity: true,
    forkCompare: true,
    listFilterMine: true,
    listFilterAuthor: true,
    listFilterTeam: true,
    reviewGrouping: true,
  },
} as unknown as ForgeStatus;

const row = (over: Partial<PrThreadOut>): PrThreadOut => ({
  author: "someone",
  authorAvatarUrl: "",
  state: "",
  body: "",
  date: "2026-01-01T00:00:00Z",
  id: "",
  url: "",
  viewerDidAuthor: false,
  isMinimized: false,
  minimizedReason: "",
  reviewId: "",
  ...over,
});

const thread = (over: Partial<ReviewThreadOut> = {}): ReviewThreadOut => ({
  id: "T_1",
  reviewId: "",
  path: "src/a.ts",
  line: 3,
  startLine: 0,
  side: "new",
  isResolved: false,
  isOutdated: false,
  diffHunk: "",
  comments: [row({ id: "N_1", body: "Look at this line" })],
  ...over,
});

function pr(over: Partial<PrDetails> = {}): PrDetails {
  return {
    id: "PR_7",
    number: 7,
    title: "Merge request seven",
    body: "",
    author: "someone",
    authorAvatarUrl: "",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feat",
    additions: 0,
    deletions: 0,
    url: "https://gitlab.com/owner/repo/-/merge_requests/7",
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
    // A full head: a GitLab record naming none holds its review actions.
    headSha: "0123456789abcdef0123456789abcdef01234567",
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
    ...over,
  } as unknown as PrDetails;
}

const locked = (over: Partial<PrDetails> = {}) =>
  pr({ locked: true, viewerCanComment: false, ...over } as Partial<PrDetails>);

beforeEach(() => {
  // jsdom has no scrollIntoView; the edit editor calls it when it opens.
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(forgeStatus).mockResolvedValue(GITLAB);
  vi.mocked(forgePrView).mockImplementation(async () => pr());
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
  vi.mocked(forgePrComment).mockReset();
  vi.mocked(forgePrComment).mockResolvedValue({ failedAttachments: [] });
  vi.mocked(forgePrRequestChanges).mockClear();
  closePr.mockClear();
  lensNow.value = "origin";
  lensNow.real = false;
  useConfirm.setState({ request: null, requestHold: null });
  useUiStore.setState({ repoPath: REPO });
  spies = [
    vi.spyOn(toast, "success"),
    vi.spyOn(toast, "error"),
    vi.spyOn(toast, "warning"),
  ];
});

let spies: { mockRestore: () => void }[] = [];
afterEach(() => {
  cleanup();
  for (const s of spies) s.mockRestore();
});

const liveRegions = () =>
  Array.from(
    document.querySelectorAll<HTMLElement>('span.sr-only[aria-live="polite"]'),
  );
const lockLine = (text: string) =>
  screen.getByText((_, el) => el?.tagName === "P" && el.textContent === text);

describe("review-thread replies hold on a read-only conversation", () => {
  function Card({
    hold,
    onReply,
    client,
  }: {
    hold: string | null;
    onReply: (threadId: string, body: string) => Promise<void>;
    client: QueryClient;
  }) {
    return (
      <QueryClientProvider client={client}>
        <ThreadReplyHoldContext value={hold}>
          <ReviewThreadCard
            thread={thread()}
            expanded
            onToggleExpand={() => undefined}
            onReply={onReply}
          />
        </ThreadReplyHoldContext>
      </QueryClientProvider>
    );
  }

  it("holds the opener and the send with the reason, keeping the editor and its text", async () => {
    const client = new QueryClient();
    const onReply = vi.fn(async () => undefined);
    const ui = (hold: string | null): ReactNode => (
      <Card hold={hold} onReply={onReply} client={client} />
    );
    const { rerender } = render(ui(null));
    const opener = screen.getByRole("button", { name: "Reply…" });
    expect(opener).not.toHaveAttribute("aria-disabled");
    act(() => opener.focus());
    rerender(ui(PR_ARCHIVED_READONLY_MESSAGE));
    expect(opener).toHaveAttribute("aria-disabled", "true");
    expect(opener).toHaveAccessibleDescription(PR_ARCHIVED_READONLY_MESSAGE);
    expect(document.activeElement).toBe(opener);

    rerender(ui(null));
    fireEvent.click(screen.getByRole("button", { name: "Reply…" }));
    const editor = screen.getByRole("textbox", {
      name: "Reply to review thread",
    });
    fireEvent.change(editor, { target: { value: "My reply" } });
    rerender(ui(GITLAB_LOCKED));
    expect(editor).toBeInTheDocument();
    expect(editor).toHaveValue("My reply");
    const reply = screen.getByRole("button", { name: "Reply" });
    expect(reply).toHaveAttribute("aria-disabled", "true");
    expect(reply).toHaveAccessibleDescription(GITLAB_LOCKED);
    fireEvent.click(reply);
    act(() => editor.focus());
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await act(async () => undefined);
    expect(onReply).not.toHaveBeenCalled();
    expect(lockLine(GITLAB_LOCKED + S4)).toBeInTheDocument();
    const live = liveRegions().find((el) => el.textContent === GITLAB_LOCKED);
    expect(live).toBeDefined();

    rerender(ui(null));
    expect(reply).not.toHaveAttribute("aria-disabled", "true");
    expect(live?.isConnected).toBe(true);
    expect(live?.textContent).toBe("");
    fireEvent.click(reply);
    await waitFor(() =>
      expect(onReply).toHaveBeenCalledWith("T_1", "My reply"),
    );
  });

  it("names the hold, not the empty body, as the Reply button's reason", () => {
    const client = new QueryClient();
    const onReply = vi.fn(async () => undefined);
    const { rerender } = render(
      <Card hold={null} onReply={onReply} client={client} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reply…" }));
    const reply = () => screen.getByRole("button", { name: "Reply" });
    expect(reply()).toHaveAccessibleDescription("Write a reply first");
    rerender(<Card hold={GITLAB_LOCKED} onReply={onReply} client={client} />);
    expect(reply()).toHaveAccessibleDescription(GITLAB_LOCKED);
  });
});

describe("own-comment edits hold on a proven archive", () => {
  const own = row({ id: "C_1", body: "Original words", viewerDidAuthor: true });

  it("disables the Edit row with the reason, and holds an open editor's Save", async () => {
    const client = new QueryClient();
    const onSaveEdit = vi.fn(() => true);
    const ui = (reason: string | null) => (
      <QueryClientProvider client={client}>
        <Thread thread={own} onSaveEdit={onSaveEdit} editHeldReason={reason} />
      </QueryClientProvider>
    );
    const { rerender } = render(ui(PR_ARCHIVED_READONLY_MESSAGE));
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    const heldRow = await screen.findByRole("menuitem", { name: S6 });
    expect(heldRow).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(heldRow);
    expect(screen.queryByRole("textbox", { name: "Edit comment" })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await waitFor(() =>
      expect(screen.queryByRole("menuitem", { name: S6 })).toBeNull(),
    );

    rerender(ui(null));
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const editor = await screen.findByRole("textbox", { name: "Edit comment" });
    // The edit box's own region, mounted empty before any hold lands.
    expect(liveRegions()).toHaveLength(1);
    const [live] = liveRegions();
    expect(live?.textContent).toBe("");
    fireEvent.change(editor, { target: { value: "Changed words" } });
    rerender(ui(PR_ARCHIVED_READONLY_MESSAGE));
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    act(() => editor.focus());
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(onSaveEdit).not.toHaveBeenCalled();
    expect(editor).toBeInTheDocument();
    expect(editor).toHaveValue("Changed words");
    expect(lockLine(PR_ARCHIVED_READONLY_MESSAGE + S5)).toBeInTheDocument();
    expect(live?.textContent).toBe(PR_ARCHIVED_READONLY_MESSAGE);

    rerender(ui(null));
    expect(live?.isConnected).toBe(true);
    expect(live?.textContent).toBe("");
  });

  it("disables the Delete row with the reason, and leaves it live without one", async () => {
    const client = new QueryClient();
    const onDelete = vi.fn();
    const ui = (reason: string | null) => (
      <QueryClientProvider client={client}>
        <Thread
          thread={own}
          onSaveEdit={() => true}
          onDelete={onDelete}
          editHeldReason={reason}
        />
      </QueryClientProvider>
    );
    const { rerender } = render(ui(PR_ARCHIVED_READONLY_MESSAGE));
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    const heldRow = await screen.findByRole("menuitem", { name: S7 });
    expect(heldRow).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(heldRow);
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await waitFor(() =>
      expect(screen.queryByRole("menuitem", { name: S7 })).toBeNull(),
    );

    rerender(ui(null));
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    const liveRow = await screen.findByRole("menuitem", { name: "Delete" });
    expect(liveRow).not.toHaveAttribute("aria-disabled");
    fireEvent.click(liveRow);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});

describe("the feed forwards the edit hold to both comment kinds", () => {
  const FEED_PR = {
    number: 3,
    comments: [
      row({ id: "C_1", body: "My comment", viewerDidAuthor: true }),
      row({ id: "C_2", body: "Their comment" }),
    ],
    reviews: [
      row({
        id: "PRR_1",
        state: "COMMENTED",
        body: "Review body",
        date: "2026-01-01T00:00:00Z",
      }),
    ],
    commits: [],
    commitsUnknown: false,
  } as unknown as PrDetails;
  const THREADS = [
    thread({
      reviewId: "PRR_1",
      comments: [
        row({ id: "RC_1", body: "My thread comment", viewerDidAuthor: true }),
        row({ id: "RC_2", body: "Their thread comment" }),
      ],
    }),
  ];

  function Feed() {
    const claims = usePrThreadClaims(FEED_PR, THREADS);
    return (
      <PrActivityFeed
        pr={FEED_PR}
        timeline={{
          data: [],
          isError: false,
          isPaused: false,
          isFetching: false,
          refetch: vi.fn(),
        }}
        stale={false}
        reactions={undefined}
        claims={claims}
        providerKey="github"
        suggestionApply={{} as never}
        fileDiffLookup={() => undefined}
        disabledReason={undefined}
        revealThreadId={null}
        setRevealThreadId={() => undefined}
        setSection={() => undefined}
        onSelectCommit={() => undefined}
        canWrite
        canThreadReply={false}
        canThreadResolve={false}
        canEditOwnThreadComments
        canEditOwnComments
        canReact={false}
        onThreadReply={async () => undefined}
        onThreadResolve={async () => undefined}
        onEditComment={() => true}
        onEditThreadComment={() => true}
        onDeleteComment={() => undefined}
        onDeleteThreadComment={() => undefined}
        editHeldReason={PR_ARCHIVED_READONLY_MESSAGE}
        onHideComment={() => undefined}
        onUnhideComment={() => undefined}
        onToggleReaction={() => undefined}
      />
    );
  }

  async function rowIn(text: string, label: RegExp) {
    const host = screen.getByText(text).closest(".group") as HTMLElement;
    fireEvent.click(
      within(host).getByRole("button", { name: "Comment actions" }),
    );
    const item = await screen.findByRole("menuitem", { name: label });
    const name = item.textContent;
    const disabled = item.getAttribute("aria-disabled");
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await waitFor(() =>
      expect(screen.queryByRole("menuitem", { name: label })).toBeNull(),
    );
    return { name, disabled };
  }
  const editRowIn = (text: string) => rowIn(text, /^Edit/);

  it("holds the conversation comment's Delete and the review thread comment's Delete", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Feed />
      </QueryClientProvider>,
    );
    expect(await rowIn("My comment", /^Delete/)).toEqual({
      name: S7,
      disabled: "true",
    });
    expect(await rowIn("My thread comment", /^Delete/)).toEqual({
      name: S7,
      disabled: "true",
    });
  });

  it("holds the conversation comment's Edit and the review thread comment's Edit", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Feed />
      </QueryClientProvider>,
    );
    expect(await editRowIn("My comment")).toEqual({
      name: S6,
      disabled: "true",
    });
    expect(await editRowIn("My thread comment")).toEqual({
      name: S6,
      disabled: "true",
    });
  });

  it.each(["Their comment", "Their thread comment"])(
    "offers no Edit row on someone else's comment (%s)",
    async (text) => {
      render(
        <QueryClientProvider client={new QueryClient()}>
          <Feed />
        </QueryClientProvider>,
      );
      const host = screen.getByText(text).closest(".group") as HTMLElement;
      fireEvent.click(
        within(host).getByRole("button", { name: "Comment actions" }),
      );
      await screen.findByRole("menuitem", { name: "Copy markdown" });
      expect(screen.queryByRole("menuitem", { name: /^Edit/ })).toBeNull();
    },
  );
});

describe("useLiveConversationHold", () => {
  const NONE: { composer: string | null; reactions: string | null } = {
    composer: null,
    reactions: null,
  };
  const HELD = {
    composer: PR_ARCHIVED_READONLY_MESSAGE,
    reactions: PR_ARCHIVED_READONLY_MESSAGE,
  };

  it("answers the latest render's hold, for the PR it was sent on, fresh", () => {
    const { result, rerender } = renderHook(
      ({ k, stale, hold }) => useLiveConversationHold(k, stale, hold),
      { initialProps: { k: "a", stale: false, hold: NONE } },
    );
    const first = result.current;
    rerender({ k: "a", stale: false, hold: HELD });
    expect(first.read("a")).toEqual(HELD);
    expect(first.read("b")).toBeNull();
    rerender({ k: "a", stale: true, hold: HELD });
    expect(first.read("a")).toBeNull();
  });
});

describe("isPrReactionRefusal", () => {
  const ADD =
    "GraphQL: me does not have the correct permissions to execute `AddReaction` (addReaction)";
  const REMOVE =
    "GraphQL: me does not have the correct permissions to execute `RemoveReaction` (removeReaction)";
  it.each([
    ["a gh AddReaction refusal", { kind: "gh", message: ADD }, true],
    [
      "the refusal inside a multi-line message",
      { kind: "gh", message: `gh: request failed\n${ADD}\nexit 1` },
      true,
    ],
    ["a gh RemoveReaction refusal", { kind: "gh", message: REMOVE }, true],
    ["the same text from glab", { kind: "glab", message: ADD }, false],
    [
      "the same text from bitbucket",
      { kind: "bitbucket", message: ADD },
      false,
    ],
    [
      "the archived refusal",
      { kind: "gh", message: PR_ARCHIVED_READONLY_MESSAGE },
      false,
    ],
    ["an unrelated gh error", { kind: "gh", message: "HTTP 502" }, false],
    ["a non-object", ADD, false],
    ["a timeout", { kind: "timeout" }, false],
  ])("%s", (_, error, expected) => {
    expect(isPrReactionRefusal(error)).toBe(expected);
  });
});

describe("withheld-comment copy", () => {
  it("says an archived pull request wasn't closed, with no retry to offer", () => {
    expect(closeWithheldMessage(7, PR_ARCHIVED_READONLY_MESSAGE)).toBe(
      "#7 wasn't closed. This pull request is archived, so its conversation is read-only. Your draft is kept.",
    );
  });
  it("says the change request went without the comment", () => {
    expect(requestedWithoutCommentMessage(GITLAB_LOCKED)).toBe(
      "Requested changes without your comment. This conversation is locked, so only project members can comment. Your draft is kept.",
    );
  });
  // GitHub's lock reason and the provider-less fallback, spelled out: the
  // fallback constant is private to prs.ts.
  it.each([
    [
      "This conversation is locked, so only collaborators can comment.",
      "#7 wasn't closed. This conversation is locked, so only collaborators can comment. Choose Close again to close it without your comment. Your draft is kept.",
      "Requested changes without your comment. This conversation is locked, so only collaborators can comment. Your draft is kept.",
    ],
    [
      "This conversation is locked, so you can't comment on it.",
      "#7 wasn't closed. This conversation is locked, so you can't comment on it. Choose Close again to close it without your comment. Your draft is kept.",
      "Requested changes without your comment. This conversation is locked, so you can't comment on it. Your draft is kept.",
    ],
  ])("carries the lock reason %s", (reason, close, request) => {
    expect(closeWithheldMessage(7, reason)).toBe(close);
    expect(requestedWithoutCommentMessage(reason)).toBe(request);
  });
  it("names both causes of a refused reaction", () => {
    expect(PR_REACTION_REFUSED_MESSAGE).toBe(
      "GitHub refused the reaction. This pull request may be archived, or you may not have permission to react to it.",
    );
  });
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <RemotePrView repoPath={REPO} number={7} />
    </QueryClientProvider>,
  );
  return client;
}

const box = () =>
  screen.getByRole("textbox", {
    name: "Leave a comment",
  }) as HTMLTextAreaElement;
const button = (name: string | RegExp) => screen.getByRole("button", { name });

async function mounted() {
  const client = mount();
  await screen.findByText("Merge request seven", undefined, { timeout: 3000 });
  await waitFor(() => expect(box()).toBeInTheDocument());
  return client;
}

/** `mounted`, with a re-render of the same view onto another number;
 *  `seed` fills the client's cache before the first render. */
async function mountedWith(seed?: (client: QueryClient) => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  seed?.(client);
  const view = (number: number) => (
    <QueryClientProvider client={client}>
      <RemotePrView repoPath={REPO} number={number} />
    </QueryClientProvider>
  );
  const { rerender } = render(view(7));
  await screen.findByText("Merge request seven", undefined, { timeout: 3000 });
  await waitFor(() => expect(box()).toBeInTheDocument());
  return { client, rerender: (number: number) => rerender(view(number)) };
}

let sessionSeq = 0x300;
/** A staged image of a fresh 32-hex session, as the stage command answers. */
function staged(n: number) {
  sessionSeq += 1;
  return {
    session: sessionSeq.toString(16).padStart(32, "0"),
    name: `image-${n}.png`,
    mime: "image/png",
    size: 2,
    width: 1,
    height: 1,
  };
}

async function lockUnder(client: QueryClient) {
  vi.mocked(forgePrView).mockImplementation(async () => locked());
  await act(() => client.refetchQueries());
  await waitFor(() =>
    expect(screen.getAllByText(GITLAB_LOCKED).length).toBeGreaterThan(0),
  );
}

describe("Close re-reads the hold at the send", () => {
  it("Close refuses when the conversation locks under its confirm, then closes plainly", async () => {
    const client = await mounted();
    fireEvent.change(box(), { target: { value: "Riding note" } });
    fireEvent.click(button("Close with comment"));
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
    await lockUnder(client);
    await act(async () => useConfirm.getState().answer(true));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        closeWithheldMessage(7, GITLAB_LOCKED),
      ),
    );
    expect(closePr).not.toHaveBeenCalled();
    expect(forgePrComment).not.toHaveBeenCalled();
    expect(box()).toHaveValue("Riding note");

    await waitFor(() => expect(useConfirm.getState().request).toBeNull());
    fireEvent.click(button("Close"));
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
    expect(JSON.stringify(useConfirm.getState().request)).not.toContain(
      "Your draft posts as a comment first.",
    );
    await act(async () => useConfirm.getState().answer(true));
    await waitFor(() => expect(closePr).toHaveBeenCalledTimes(1));
    expect(forgePrComment).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Closed #7"),
    );
    expect(box()).toHaveValue("Riding note");
  });

  it("Close with no hold posts the draft, then closes", async () => {
    await mounted();
    fireEvent.change(box(), { target: { value: "Riding note" } });
    fireEvent.click(button("Close with comment"));
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
    await act(async () => useConfirm.getState().answer(true));
    await waitFor(() => expect(closePr).toHaveBeenCalledTimes(1));
    expect(forgePrComment).toHaveBeenCalledTimes(1);
    expect(vi.mocked(forgePrComment).mock.invocationCallOrder[0]).toBeLessThan(
      closePr.mock.invocationCallOrder[0],
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Closed #7 and posted your comment",
      ),
    );
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("Close with comment refuses when another merge request was opened under its confirm", async () => {
    const { rerender } = await mountedWith();
    fireEvent.change(box(), { target: { value: "Riding note" } });
    fireEvent.click(button("Close with comment"));
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
    rerender(8);
    await act(async () => useConfirm.getState().answer(true));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        "#7 wasn't closed because another merge request was opened while the prompt was up. Nothing was posted. Your draft is kept.",
      ),
    );
    expect(forgePrComment).not.toHaveBeenCalled();
    expect(closePr).not.toHaveBeenCalled();
    rerender(7);
    await waitFor(() => expect(box()).toHaveValue("Riding note"));
  });

  it("Close with comment refuses when the same number was opened on another lens under its confirm", async () => {
    const { rerender } = await mountedWith();
    fireEvent.change(box(), { target: { value: "Riding note" } });
    fireEvent.click(button("Close with comment"));
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
    lensNow.value = "upstream";
    rerender(7);
    await act(async () => useConfirm.getState().answer(true));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        "#7 wasn't closed because another merge request was opened while the prompt was up. Nothing was posted. Your draft is kept.",
      ),
    );
    expect(forgePrComment).not.toHaveBeenCalled();
    expect(closePr).not.toHaveBeenCalled();
    lensNow.value = "origin";
    rerender(7);
    await waitFor(() => expect(box()).toHaveValue("Riding note"));
  });

  it("Close with comment goes through when the same merge request refetches under its confirm", async () => {
    const client = await mounted();
    fireEvent.change(box(), { target: { value: "Riding note" } });
    fireEvent.click(button("Close with comment"));
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
    await act(() => client.refetchQueries());
    await act(async () => useConfirm.getState().answer(true));
    await waitFor(() => expect(closePr).toHaveBeenCalledTimes(1));
    expect(forgePrComment).toHaveBeenCalledTimes(1);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

// The locked case locks before the click, so it pins the hold known at click
// time; the lifted case opens the re-read's window inside the approvals cancel.
describe("Request changes withholds the draft on a conversation held at the click", () => {
  it.each([
    [
      "a Bitbucket change request offers the revoke",
      "bitbucket",
      true,
      "",
      "Revoke your change request",
    ],
    [
      "a GitLab change request explains the manual clear",
      "gitlab",
      true,
      "",
      "You've requested changes — approve, or remove yourself as a reviewer on GitLab, to clear",
    ],
    [
      "a draft on an open conversation rides the request",
      "gitlab",
      false,
      "Please change",
      "Request changes, posting your draft as a comment",
    ],
    [
      "no draft requests changes alone",
      "gitlab",
      false,
      "",
      "Request changes on this merge request (adds you as a reviewer)",
    ],
  ] as const)(
    "titles the button: %s",
    async (_, provider, requested, draft, title) => {
      vi.mocked(forgeStatus).mockResolvedValue({
        ...GITLAB,
        provider,
      } as ForgeStatus);
      vi.mocked(forgePrApprovals).mockResolvedValue({
        viewerHasApproved: false,
        approvedBy: [],
        approvalsRequired: 0,
        approvalsLeft: 0,
        viewerRequestedChanges: requested,
      });
      await mounted();
      if (draft) fireEvent.change(box(), { target: { value: draft } });
      const name = requested ? "Changes requested" : "Request changes";
      await waitFor(() => expect(button(name)).toHaveAttribute("title", title));
    },
  );

  it("Request changes on a locked conversation goes ahead without the draft and keeps it", async () => {
    const client = await mounted();
    fireEvent.change(box(), { target: { value: "Please change" } });
    await lockUnder(client);
    await waitFor(() =>
      expect(button("Request changes")).toHaveAttribute(
        "title",
        "Request changes on this merge request (adds you as a reviewer)",
      ),
    );
    fireEvent.click(button("Request changes"));
    await waitFor(() => expect(forgePrRequestChanges).toHaveBeenCalled());
    expect(vi.mocked(forgePrRequestChanges).mock.calls[0]?.[2]).toBe("");
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        requestedWithoutCommentMessage(GITLAB_LOCKED),
      ),
    );
    expect(toast.success).not.toHaveBeenCalledWith("Requested changes");
    expect(box()).toHaveValue("Please change");
  });

  it("Request changes held at the click keeps the draft out when the hold lifts before the send", async () => {
    const client = await mounted();
    fireEvent.change(box(), { target: { value: "Please change" } });
    await lockUnder(client);
    const cancel = client.cancelQueries.bind(client);
    let lifted = false;
    vi.spyOn(client, "cancelQueries").mockImplementation(
      async (filters, options) => {
        if (!lifted && filters?.queryKey?.at(-1) === "approvals") {
          lifted = true;
          vi.mocked(forgePrView).mockImplementation(async () => pr());
          await client.refetchQueries();
          await waitFor(() =>
            expect(screen.queryAllByText(GITLAB_LOCKED)).toHaveLength(0),
          );
        }
        return cancel(filters, options);
      },
    );
    fireEvent.click(button("Request changes"));
    await waitFor(() => expect(forgePrRequestChanges).toHaveBeenCalled());
    expect(lifted).toBe(true);
    expect(vi.mocked(forgePrRequestChanges).mock.calls[0]?.[2]).toBe("");
    // The hold has lifted, so the press-time reason is the one that applied.
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        requestedWithoutCommentMessage(GITLAB_LOCKED),
      ),
    );
    expect(toast.success).not.toHaveBeenCalledWith("Requested changes");
    await act(async () => undefined);
    expect(box()).toHaveValue("Please change");
  });

  it("Request changes on a locked merge request goes ahead past a staged image, keeping the draft and the image", async () => {
    vi.mocked(attachmentStage).mockImplementation(async () => staged(1));
    const client = await mounted();
    fireEvent.paste(box(), {
      clipboardData: {
        files: [
          new File([new Uint8Array([1])], "a.png", { type: "image/png" }),
        ],
        types: ["Files"],
        getData: () => "",
      },
    });
    await waitFor(() => expect(box().value).toContain("](image-1.png)"));
    const draft = box().value;
    await lockUnder(client);
    await waitFor(() =>
      expect(button("Request changes")).not.toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    );
    expect(button("Request changes")).toHaveAttribute(
      "title",
      "Request changes on this merge request (adds you as a reviewer)",
    );
    fireEvent.click(button("Request changes"));
    await waitFor(() => expect(forgePrRequestChanges).toHaveBeenCalled());
    expect(vi.mocked(forgePrRequestChanges).mock.calls[0]?.[2]).toBe("");
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        requestedWithoutCommentMessage(GITLAB_LOCKED),
      ),
    );
    await act(async () => undefined);
    expect(box()).toHaveValue(draft);
    expect(attachmentDiscard).not.toHaveBeenCalled();
  });

  it("Request changes refuses when another merge request was opened during its wait", async () => {
    const { client, rerender } = await mountedWith();
    fireEvent.change(box(), { target: { value: "Please change" } });
    const cancel = client.cancelQueries.bind(client);
    let moved = false;
    vi.spyOn(client, "cancelQueries").mockImplementation(
      async (filters, options) => {
        if (!moved && filters?.queryKey?.at(-1) === "approvals") {
          moved = true;
          rerender(8);
        }
        return cancel(filters, options);
      },
    );
    fireEvent.click(button("Request changes"));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        "Changes weren't requested on #7 because another merge request was opened meanwhile. Your draft is kept.",
      ),
    );
    expect(moved).toBe(true);
    expect(forgePrRequestChanges).not.toHaveBeenCalled();
    rerender(7);
    await waitFor(() => expect(box()).toHaveValue("Please change"));
  });

  it("Request changes free at the click but locked during its wait goes without the draft", async () => {
    const client = await mounted();
    fireEvent.change(box(), { target: { value: "Please change" } });
    const cancel = client.cancelQueries.bind(client);
    let lockedInWait = false;
    vi.spyOn(client, "cancelQueries").mockImplementation(
      async (filters, options) => {
        if (!lockedInWait && filters?.queryKey?.at(-1) === "approvals") {
          lockedInWait = true;
          vi.mocked(forgePrView).mockImplementation(async () => locked());
          await client.refetchQueries();
          await waitFor(() =>
            expect(screen.getAllByText(GITLAB_LOCKED).length).toBeGreaterThan(
              0,
            ),
          );
        }
        return cancel(filters, options);
      },
    );
    fireEvent.click(button("Request changes"));
    await waitFor(() => expect(forgePrRequestChanges).toHaveBeenCalled());
    expect(lockedInWait).toBe(true);
    expect(vi.mocked(forgePrRequestChanges).mock.calls[0]?.[2]).toBe("");
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        requestedWithoutCommentMessage(GITLAB_LOCKED),
      ),
    );
    await act(async () => undefined);
    expect(box()).toHaveValue("Please change");
  });

  it("Request changes held at the click and held otherwise at the send names the send's reason", async () => {
    const client = await mounted();
    fireEvent.change(box(), { target: { value: "Please change" } });
    await lockUnder(client);
    const cancel = client.cancelQueries.bind(client);
    let moved = false;
    // The provider's own lock copy at the click, the generic copy at the send:
    // two distinct reasons, so the toast shows which one it read.
    vi.spyOn(client, "cancelQueries").mockImplementation(
      async (filters, options) => {
        if (!moved && filters?.queryKey?.at(-1) === "approvals") {
          moved = true;
          vi.mocked(forgeStatus).mockResolvedValue({
            ...GITLAB,
            provider: "bitbucket",
          } as ForgeStatus);
          await client.refetchQueries();
          await waitFor(() =>
            expect(screen.getAllByText(LOCKED_FALLBACK).length).toBeGreaterThan(
              0,
            ),
          );
        }
        return cancel(filters, options);
      },
    );
    fireEvent.click(button("Request changes"));
    await waitFor(() => expect(forgePrRequestChanges).toHaveBeenCalled());
    expect(moved).toBe(true);
    expect(vi.mocked(forgePrRequestChanges).mock.calls[0]?.[2]).toBe("");
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        requestedWithoutCommentMessage(LOCKED_FALLBACK),
      ),
    );
    expect(toast.warning).not.toHaveBeenCalledWith(
      requestedWithoutCommentMessage(GITLAB_LOCKED),
    );
    await act(async () => undefined);
    expect(box()).toHaveValue("Please change");
  });

  it("Request changes under a hold leaves an image still staging into an empty box", async () => {
    let finishStage: (v: ReturnType<typeof staged>) => void = () => undefined;
    vi.mocked(attachmentStage).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishStage = resolve;
        }),
    );
    const client = await mounted();
    fireEvent.paste(box(), {
      clipboardData: {
        files: [
          new File([new Uint8Array([1])], "a.png", { type: "image/png" }),
        ],
        types: ["Files"],
        getData: () => "",
      },
    });
    await waitFor(() => expect(attachmentStage).toHaveBeenCalled());
    expect(box()).toHaveValue("");
    await lockUnder(client);
    await waitFor(() =>
      expect(button("Request changes")).not.toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    );
    fireEvent.click(button("Request changes"));
    await waitFor(() => expect(forgePrRequestChanges).toHaveBeenCalled());
    expect(vi.mocked(forgePrRequestChanges).mock.calls[0]?.[2]).toBe("");
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Requested changes"),
    );
    await act(async () => finishStage(staged(1)));
    await waitFor(() => expect(box().value).toContain("](image-1.png)"));
    expect(attachmentDiscard).not.toHaveBeenCalled();
  });

  it("Changes requested withdraws nothing when another pull request was opened during its wait", async () => {
    vi.mocked(forgeStatus).mockResolvedValue({
      ...GITLAB,
      provider: "bitbucket",
    } as ForgeStatus);
    vi.mocked(forgePrApprovals).mockResolvedValue({
      viewerHasApproved: false,
      approvedBy: [],
      approvalsRequired: 0,
      approvalsLeft: 0,
      viewerRequestedChanges: true,
    });
    const { client, rerender } = await mountedWith();
    await waitFor(() =>
      expect(button("Changes requested")).not.toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    );
    const cancel = client.cancelQueries.bind(client);
    let moved = false;
    vi.spyOn(client, "cancelQueries").mockImplementation(
      async (filters, options) => {
        if (!moved && filters?.queryKey?.at(-1) === "approvals") {
          moved = true;
          rerender(8);
        }
        return cancel(filters, options);
      },
    );
    fireEvent.click(button("Changes requested"));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        "The change request on #7 wasn't withdrawn because another pull request was opened meanwhile.",
      ),
    );
    expect(moved).toBe(true);
    expect(forgePrUnrequestChanges).not.toHaveBeenCalled();
  });

  it("Request changes goes through when the same merge request refetches during its wait", async () => {
    const client = await mounted();
    fireEvent.change(box(), { target: { value: "Please change" } });
    const cancel = client.cancelQueries.bind(client);
    let refetched = false;
    vi.spyOn(client, "cancelQueries").mockImplementation(
      async (filters, options) => {
        if (!refetched && filters?.queryKey?.at(-1) === "approvals") {
          refetched = true;
          await client.refetchQueries();
        }
        return cancel(filters, options);
      },
    );
    fireEvent.click(button("Request changes"));
    await waitFor(() => expect(forgePrRequestChanges).toHaveBeenCalled());
    expect(refetched).toBe(true);
    expect(vi.mocked(forgePrRequestChanges).mock.calls[0]?.[2]).toBe(
      "Please change",
    );
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("Request changes on an open conversation sends the draft and clears it", async () => {
    await mounted();
    fireEvent.change(box(), { target: { value: "  Please change  " } });
    expect(button("Request changes")).toHaveAttribute(
      "title",
      "Request changes, posting your draft as a comment",
    );
    fireEvent.click(button("Request changes"));
    await waitFor(() => expect(forgePrRequestChanges).toHaveBeenCalled());
    expect(vi.mocked(forgePrRequestChanges).mock.calls[0]?.[2]).toBe(
      "Please change",
    );
    await waitFor(() => expect(box()).toHaveValue(""));
  });
});

describe("the view wires the edit and reply holds", () => {
  const OWN = row({ id: "N_9", body: "My own note", viewerDidAuthor: true });

  async function editRow() {
    const host = (await screen.findByText("My own note")).closest(
      "[data-comment-id]",
    ) as HTMLElement;
    fireEvent.click(
      within(host).getByRole("button", { name: "Comment actions" }),
    );
    const item = await screen.findByRole("menuitem", { name: /^Edit/ });
    const out = {
      name: item.textContent,
      disabled: item.getAttribute("aria-disabled"),
    };
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await waitFor(() =>
      expect(screen.queryByRole("menuitem", { name: /^Edit/ })).toBeNull(),
    );
    return out;
  }

  it("leaves Edit live on a locked conversation", async () => {
    vi.mocked(forgePrView).mockImplementation(async () =>
      locked({ comments: [OWN] }),
    );
    await mounted();
    expect(await editRow()).toEqual({ name: "Edit", disabled: null });
  });

  it("holds Edit once a refused post proves the archive", async () => {
    vi.mocked(forgePrView).mockImplementation(async () =>
      pr({ comments: [OWN] }),
    );
    vi.mocked(forgePrComment).mockRejectedValue({
      kind: "gh",
      message: PR_ARCHIVED_READONLY_MESSAGE,
    });
    await mounted();
    fireEvent.change(box(), { target: { value: "One more" } });
    fireEvent.click(button("Comment"));
    await waitFor(() => expect(forgePrComment).toHaveBeenCalled());
    await waitFor(async () =>
      expect(await editRow()).toEqual({ name: S6, disabled: "true" }),
    );
  });

  it("holds a GitLab thread's Reply… opener on a locked merge request", async () => {
    vi.mocked(forgePrReviewThreads).mockResolvedValue({
      threads: [thread()],
      threadsTruncated: false,
    });
    vi.mocked(forgePrView).mockImplementation(async () => locked());
    await mounted();
    const opener = await screen.findByRole("button", { name: "Reply…" });
    expect(opener).toHaveAttribute("aria-disabled", "true");
    expect(opener).toHaveAccessibleDescription(GITLAB_LOCKED);
  });

  it("leaves a GitLab thread's Reply… opener live on an open merge request", async () => {
    vi.mocked(forgePrReviewThreads).mockResolvedValue({
      threads: [thread()],
      threadsTruncated: false,
    });
    await mounted();
    const opener = await screen.findByRole("button", { name: "Reply…" });
    expect(opener).not.toHaveAttribute("aria-disabled");
  });
});

describe("the loading frame names the forge's noun", () => {
  it.each([
    ["gitlab", "Loading this merge request…"],
    ["github", "Loading this pull request…"],
  ] as const)("on %s it announces %s", async (provider, text) => {
    vi.mocked(forgeStatus).mockResolvedValue({
      ...GITLAB,
      provider,
    } as ForgeStatus);
    vi.mocked(forgePrView).mockImplementation(
      () => new Promise<never>(() => undefined),
    );
    mount();
    await waitFor(() =>
      expect(
        screen.getAllByRole("status").some((el) => el.textContent === text),
      ).toBe(true),
    );
    const other =
      provider === "gitlab"
        ? "Loading this pull request…"
        : "Loading this merge request…";
    expect(
      screen.getAllByRole("status").some((el) => el.textContent === other),
    ).toBe(false);
  });
});

describe("a refused reaction on the pull request body", () => {
  const ADD =
    "GraphQL: me does not have the correct permissions to execute `AddReaction` (addReaction)";

  async function react(error: unknown) {
    vi.mocked(forgeStatus).mockResolvedValue({
      ...GITLAB,
      implemented: { ...GITLAB.implemented, mrReactions: true },
    } as ForgeStatus);
    vi.mocked(forgeAddReaction).mockReset().mockRejectedValue(error);
    // The picker opens only while this view owns the selection.
    useUiStore.setState({ selectedPr: { kind: "remote", id: "7" } });
    const user = userEvent.setup();
    await mounted();
    await user.click(
      await screen.findByRole("button", { name: "Add reaction" }),
    );
    const [pick] = await screen.findAllByRole("button", {
      name: /^React with /,
    });
    await user.click(pick);
    await waitFor(() => expect(forgeAddReaction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  }

  it("names both causes instead of GitHub's raw permission text", async () => {
    await react({ kind: "gh", message: ADD });
    expect(toast.error).toHaveBeenCalledWith(PR_REACTION_REFUSED_MESSAGE);
    expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).not.toContain(
      "AddReaction",
    );
  });

  it("reports any other failure through the plain error path", async () => {
    await react({ kind: "gh", message: "HTTP 502" });
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalledWith(PR_REACTION_REFUSED_MESSAGE);
    // The error summary reads a gateway failure as a network one.
    expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toMatch(
      /^Couldn't reach GitHub/,
    );
  });
});

describe("RemotePrView landing focus", () => {
  /** The view's tabIndex -1 host: the root its wrapper renders. */
  const host = () => screen.getByTestId("view").firstElementChild;
  const outsideInput = () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    return input;
  };
  afterEach(() => document.body.replaceChildren());

  /** A board card in one tab, the PR view in another, one tab shown. */
  function Tabs({ viewShown, qc }: { viewShown: boolean; qc: QueryClient }) {
    return (
      <QueryClientProvider client={qc}>
        <TabPanel active={!viewShown}>
          <button type="button">card</button>
        </TabPanel>
        <TabPanel active={viewShown}>
          <div data-testid="view">
            <RemotePrView repoPath={REPO} number={7} />
          </div>
        </TabPanel>
      </QueryClientProvider>
    );
  }
  const client = () =>
    new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const visibleView = () => (
    <QueryClientProvider client={client()}>
      <div data-testid="view">
        <RemotePrView repoPath={REPO} number={7} />
      </div>
    </QueryClientProvider>
  );

  // The landing assertions read the commit that landed the view, before the
  // details answer and an arm change could run the frame rescue.
  it("takes focus a reveal leaves on the hidden tab's card", () => {
    const qc = client();
    const { rerender } = render(<Tabs viewShown={false} qc={qc} />);
    expect(host()).toHaveAttribute("tabindex", "-1");
    screen.getByRole("button", { name: "card" }).focus();
    rerender(<Tabs viewShown qc={qc} />);
    expect(document.activeElement).toBe(host());
  });

  it("takes it again on a second visit to the same instance", () => {
    const qc = client();
    const { rerender } = render(<Tabs viewShown qc={qc} />);
    expect(document.activeElement).toBe(host());
    rerender(<Tabs viewShown={false} qc={qc} />);
    const card = screen.getByRole("button", { name: "card" });
    card.focus();
    expect(document.activeElement).toBe(card);
    rerender(<Tabs viewShown qc={qc} />);
    expect(document.activeElement).toBe(host());
  });

  it("leaves focus on a visible element outside through a reveal", () => {
    const qc = client();
    const { rerender } = render(<Tabs viewShown={false} qc={qc} />);
    const input = outsideInput();
    rerender(<Tabs viewShown qc={qc} />);
    expect(document.activeElement).toBe(input);
  });

  it("takes focus on mount while focus is on <body>", () => {
    expect(document.activeElement).toBe(document.body);
    render(visibleView());
    expect(document.activeElement).toBe(host());
  });

  it("leaves a focused visible input alone on mount", () => {
    const input = outsideInput();
    render(visibleView());
    expect(document.activeElement).toBe(input);
  });

  /** A signed-in GitHub fork, so the real gate offers the upstream lens; the
   *  upstream read never answers. */
  function forkWithPendingUpstream() {
    lensNow.real = true;
    vi.mocked(forgeStatus).mockResolvedValue(GITHUB_FORK);
    vi.mocked(gitRemotes).mockResolvedValueOnce(["origin", "upstream"]);
    vi.mocked(forgePrView).mockImplementation(async (_repo, _number, lens) =>
      lens === "upstream"
        ? new Promise<PrDetails>(() => undefined)
        : pr({ url: "https://github.com/owner/repo/pull/7" }),
    );
  }
  const seedOrigin = (qc: QueryClient) =>
    qc.setQueryData(lensKey(REPO), "origin");
  const toUpstream = (qc: QueryClient) =>
    act(() => {
      qc.setQueryData(lensKey(REPO), "upstream");
    });

  it("lands on the host when a frame change unmounts the focused control", async () => {
    // The upstream lens never answers and has no placeholder to keep (the lens
    // is an identity axis), so its loading frame replaces origin's content.
    forkWithPendingUpstream();
    const { client, rerender } = await mountedWith(seedOrigin);
    const focused = box();
    focused.focus();
    expect(document.activeElement).toBe(focused);
    toUpstream(client);
    rerender(7);
    // The loading frame's composer is another node: the content arm's left.
    expect(focused.isConnected).toBe(false);
    // The host is the root of render()'s container.
    expect(document.activeElement).toHaveAttribute("tabindex", "-1");
    expect(document.activeElement?.parentElement?.parentElement).toBe(
      document.body,
    );
  });

  it("leaves focus on a visible element outside through a frame change", async () => {
    forkWithPendingUpstream();
    const { client, rerender } = await mountedWith(seedOrigin);
    const focused = box();
    const input = outsideInput();
    toUpstream(client);
    rerender(7);
    // The loading frame's composer is another node: the content arm's left.
    expect(focused.isConnected).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  describe("the conflict-resolution view", () => {
    // The view owns the live selection on the Pull requests tab, as when opened.
    beforeEach(() =>
      useUiStore.setState({
        repoTab: "pulls",
        selectedPr: { kind: "remote", id: "7" },
      }),
    );
    afterEach(() =>
      useUiStore.setState({ repoTab: "changes", selectedPr: null }),
    );

    /** Presses the banner's Resolve and waits for the resolve view. */
    async function resolveFrom(qc: QueryClient) {
      const { rerender } = render(<Tabs viewShown qc={qc} />);
      const press = await screen.findByRole(
        "button",
        { name: "Resolve conflicts" },
        { timeout: 3000 },
      );
      await waitFor(() => expect(press).not.toHaveAttribute("aria-disabled"));
      press.focus();
      fireEvent.click(press);
      await screen.findByRole("option", { name: /a\.ts/ });
      expect(press.isConnected).toBe(false);
      return rerender;
    }
    /** The resolve view's root: the host, holding the PR's title row and no
     *  comment box (the content arm's). */
    const expectOnResolveRoot = () => {
      const root = host();
      expect(document.activeElement).toBe(root);
      expect(root).toHaveAttribute("tabindex", "-1");
      expect(root).toContainElement(
        screen.getByRole("heading", { name: /Merge request seven/ }),
      );
      expect(screen.queryByRole("textbox", { name: "Leave a comment" })).toBe(
        null,
      );
    };

    it("lands the focus the unmounted Resolve button dropped on the resolve root", async () => {
      await resolveFrom(client());
      expectOnResolveRoot();
    });

    it("takes focus on <body> back to the resolve root when its tab is shown again", async () => {
      const qc = client();
      const rerender = await resolveFrom(qc);
      rerender(<Tabs viewShown={false} qc={qc} />);
      // jsdom keeps focus on the hidden host through blur(); a removed focused
      // node is what drops it to <body>.
      outsideInput().remove();
      expect(document.activeElement).toBe(document.body);
      rerender(<Tabs viewShown qc={qc} />);
      expectOnResolveRoot();
    });
  });
});
