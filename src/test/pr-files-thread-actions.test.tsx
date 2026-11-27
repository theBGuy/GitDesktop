import {
  QueryClient,
  QueryClientProvider,
  type QueryClient as QueryClientType,
} from "@tanstack/react-query";
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  lineComposerOpen,
  whitespaceComposerOpen,
} from "@/features/diff/whitespace-mode";
import { RemotePrView } from "@/features/pulls/RemotePrView";
import {
  forgeGlMrMergeState,
  forgePrApprovals,
  forgePrDeleteReviewComment,
  forgePrDiff,
  forgePrEditReviewComment,
  forgePrReviewThreads,
  forgePrView,
  forgeStatus,
  gitFindRemotePrResolve,
} from "@/lib/git/api";
import {
  type ForgeStatus,
  PR_ARCHIVED_READONLY_MESSAGE,
  type PrDetails,
  type ReviewThreadOut,
} from "@/lib/git/types";
import { loadSettings, saveSettingsMerged } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";
import { stubCanvas } from "./canvas-stub";

// The Files tab's review-thread cards, wired as the Conversation tab's: Edit
// and Delete on the viewer's own comments. Harness from
// pr-files-file-filter.test.tsx: a stand-in pane that renders each line
// anchor, and `wire.realPane` for the real diff.

vi.mock("@/lib/pulls/review-drafts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pulls/review-drafts")>()),
  useReviewDrafts: () => ({ data: undefined }),
}));

const wire = vi.hoisted(() => ({
  answer: undefined as
    | ((cmd: string, args: Record<string, unknown>) => unknown)
    | undefined,
  realPane: false,
  /** Set: the Files pane receives this as its edit hold reason. */
  editHeldReason: undefined as string | undefined,
}));

vi.mock("@/lib/tauri/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri/invoke")>()),
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    const answer = wire.answer?.(cmd, args);
    if (answer !== undefined) return answer;
    throw new Error(`unanswered read: ${cmd}`);
  }),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
  saveSettingsMerged: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(),
  forgePrView: vi.fn(),
  forgePrApprovals: vi.fn(),
  forgePrReviewThreads: vi.fn(),
  forgeGlMrMergeState: vi.fn(),
  forgePrDiff: vi.fn(),
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
  forgePrEditReviewComment: vi.fn(),
  forgePrDeleteReviewComment: vi.fn(),
  forgePrMergeMessageDefaults: vi.fn(async () => ({
    commits: [],
    reason: null,
  })),
  forgePrTimeline: vi.fn(async () => []),
  forgePrMergeability: vi.fn(async () => {
    throw new Error("not read");
  }),
  gitConflictPreview: vi.fn(async () => {
    throw new Error("not read");
  }),
  gitFindRemotePrResolve: vi.fn(),
  gitFetch: vi.fn(async () => undefined),
  gitObjectsPresent: vi.fn(async () => false),
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
vi.mock("@/lib/use-container-width", () => ({
  useContainerWidth: () => [() => undefined, 900],
}));
vi.mock("@/features/diff/DiffSurfaceLazy", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/features/diff/DiffSurfaceLazy")>();
  const { useReportPaneSettled } = await import(
    "@/features/diff/diff-pane-hold"
  );
  function StandIn({
    lineAnchors,
    renderAnchor,
  }: {
    lineAnchors?: {
      side: "new" | "old";
      line: number;
      items: readonly string[];
    }[];
    renderAnchor?: (anchor: never) => React.ReactNode;
  }) {
    useReportPaneSettled(true);
    return (
      <div>
        {lineAnchors?.map((a) => (
          <div key={`${a.side}:${a.line}`} data-anchor="">
            {renderAnchor?.(a as never)}
          </div>
        ))}
      </div>
    );
  }
  function DiffContent(props: React.ComponentProps<typeof real.DiffContent>) {
    return wire.realPane ? (
      <real.DiffContent {...props} />
    ) : (
      <StandIn {...props} />
    );
  }
  return { ...real, DiffSurface: DiffContent, DiffContent };
});

// An archived pull request has no read signal (a refused post latches it), so
// the archived case hands the real Files pane the reason directly.
vi.mock("@/features/pulls/RemotePrViewParts", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/features/pulls/RemotePrViewParts")>();
  function PrFilesPane(props: React.ComponentProps<typeof real.PrFilesPane>) {
    return (
      <real.PrFilesPane
        {...props}
        editHeldReason={wire.editHeldReason ?? props.editHeldReason}
      />
    );
  }
  return { ...real, PrFilesPane };
});

Element.prototype.scrollIntoView = vi.fn();

const REPO = "C:/repo";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const BASE = "fedcba9876".repeat(4);
const ALL_ON = new Proxy({}, { get: () => true });
const GITLAB = {
  provider: "gitlab",
  installed: true,
  authenticated: true,
  repo: "owner/repo",
  host: "gitlab.com",
  login: "me",
  capabilities: {},
  implemented: ALL_ON,
} as unknown as ForgeStatus;

const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join("");
/** A 40-line file edited at line 2. */
const OLD = lines(40);
const NEW = OLD.replace("line 2\n", "line two\n");
const TEXT =
  "diff --git a/f.txt b/f.txt\nindex 1111111..2222222 100644\n--- a/f.txt\n+++ b/f.txt\n" +
  "@@ -1,3 +1,3 @@\n line 1\n-line 2\n+line two\n line 3\n";

function pr(): PrDetails {
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
    additions: 1,
    deletions: 1,
    url: "https://gitlab.com/owner/repo/-/merge_requests/7",
    commits: [],
    files: [{ path: "f.txt", additions: 1, deletions: 1 }],
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

const comment = (id: string, body: string, viewerDidAuthor: boolean) => ({
  author: viewerDidAuthor ? "me" : "someone",
  authorAvatarUrl: "",
  state: "",
  body,
  date: "2026-01-01T00:00:00Z",
  id,
  url: "",
  viewerDidAuthor,
  isMinimized: false,
  minimizedReason: "",
  reviewId: "",
});

function thread(
  id: string,
  comments: ReturnType<typeof comment>[],
  isResolved = false,
): ReviewThreadOut {
  return {
    id,
    reviewId: "",
    path: "f.txt",
    line: 2,
    startLine: 0,
    side: "new",
    isResolved,
    isOutdated: false,
    diffHunk: "",
    comments,
  };
}

/** Two threads on one side+line (one stacked anchor): the viewer's comment
 *  under another author's, and a thread whose only comment is the viewer's. */
const THREADS = (other = "Their note") => [
  thread("T1", [
    comment("N_other", other, false),
    comment("N_own", "My note", true),
  ]),
  thread("T2", [comment("N_only", "My lone note", true)]),
];

const clients: QueryClientType[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  wire.answer = undefined;
  wire.realPane = false;
  wire.editHeldReason = undefined;
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(saveSettingsMerged).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(forgeStatus).mockResolvedValue(GITLAB);
  vi.mocked(forgePrView).mockImplementation(async () => pr());
  vi.mocked(forgePrDiff).mockResolvedValue(TEXT);
  vi.mocked(forgePrApprovals).mockResolvedValue({
    viewerHasApproved: false,
    approvedBy: [],
    approvalsRequired: 0,
    approvalsLeft: 0,
    viewerRequestedChanges: false,
  });
  vi.mocked(forgePrReviewThreads).mockResolvedValue({
    threads: THREADS(),
    threadsTruncated: false,
  });
  vi.mocked(forgePrEditReviewComment).mockResolvedValue(undefined);
  vi.mocked(forgePrDeleteReviewComment).mockResolvedValue(undefined);
  vi.mocked(gitFindRemotePrResolve).mockResolvedValue(null);
  vi.mocked(forgeGlMrMergeState).mockResolvedValue({
    autoMergeEnabled: false,
    detailedMergeStatus: "mergeable",
    pipelineStatus: null,
  } as never);
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

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <RemotePrView repoPath={REPO} number={7} />
    </QueryClientProvider>,
  );
  return client;
}

const openFilesTab = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(await screen.findByRole("button", { name: /^Files \(\d+\)$/ }));
/** The Thread root holding `text`, inside a line anchor. */
const commentRoot = async (text: string) =>
  (await screen.findByText(text)).closest(".group") as HTMLElement;
/** Opens a comment's menu by a keyboard-style click (no pointer type), as
 *  pr-readonly-riders.test.tsx does: a pointer click there can be swallowed
 *  after a press that ended elsewhere. */
async function openMenu(text: string) {
  fireEvent.click(
    within(await commentRoot(text)).getByRole("button", {
      name: "Comment actions",
    }),
  );
  return screen.findAllByRole("menuitem");
}
/** The names of the menu rows a comment offers, menu closed after. */
async function menuRows(text: string) {
  const rows = (await openMenu(text)).map((row) => ({
    name: row.textContent,
    disabled: row.getAttribute("aria-disabled"),
  }));
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
  });
  await waitFor(() => expect(screen.queryByRole("menuitem")).toBeNull());
  return rows;
}
async function pick(text: string, row: "Edit" | "Delete") {
  await openMenu(text);
  fireEvent.click(await screen.findByRole("menuitem", { name: row }));
}
const editor = () =>
  screen.queryByRole<HTMLTextAreaElement>("textbox", { name: "Edit comment" });
/** Where focus sits: the element's tag and accessible label or text. */
const focusAt = () => {
  const el = document.activeElement;
  if (el === null || el === document.body) return "body";
  return `${el.tagName.toLowerCase()}:${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40)}`;
};

describe("a Files-tab review thread's comment menu", () => {
  it("C3-1: offers Edit and Delete on the viewer's own comments only", async () => {
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    const own = (await menuRows("My note")).map((r) => r.name);
    expect(own).toEqual(expect.arrayContaining(["Edit", "Delete"]));
    const other = (await menuRows("Their note")).map((r) => r.name);
    expect(other).not.toContain("Edit");
    expect(other).not.toContain("Delete");
  });

  it("C3-1: a resolved thread's own comment offers them once expanded", async () => {
    vi.mocked(forgePrReviewThreads).mockResolvedValue({
      threads: [thread("T9", [comment("N_res", "Resolved note", true)], true)],
      threadsTruncated: false,
    });
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    const toggle = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(
        '[data-anchor] [aria-expanded="false"]',
      );
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    await user.click(toggle);
    const rows = (await menuRows("Resolved note")).map((r) => r.name);
    expect(rows).toEqual(expect.arrayContaining(["Edit", "Delete"]));
  });

  it("C3-2: Edit opens inline in the anchor and Save sends the trimmed body once", async () => {
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await pick("My note", "Edit");
    const box = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Edit comment",
    });
    expect(box.closest("[data-anchor]")).not.toBeNull();
    expect(box).toHaveValue("My note");
    await user.clear(box);
    await user.type(box, "  My edited note  ");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(forgePrEditReviewComment).toHaveBeenCalledTimes(1),
    );
    expect(forgePrEditReviewComment).toHaveBeenCalledWith(
      REPO,
      7,
      "N_own",
      "My edited note",
    );
    expect(editor()).toBeNull();
  });

  it("C3-2: Delete asks first, and its confirm deletes that comment once", async () => {
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await pick("My note", "Delete");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Delete comment?")).toBeTruthy();
    expect(forgePrDeleteReviewComment).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(forgePrDeleteReviewComment).toHaveBeenCalledTimes(1),
    );
    expect(forgePrDeleteReviewComment).toHaveBeenCalledWith(REPO, 7, "N_own");
  });

  it("C3-1: an archived pull request holds Edit and Delete with its reason, as the Conversation tab does", async () => {
    wire.editHeldReason = PR_ARCHIVED_READONLY_MESSAGE;
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    const rows = await menuRows("My note");
    expect(rows).toContainEqual({
      name: `Edit — ${PR_ARCHIVED_READONLY_MESSAGE}`,
      disabled: "true",
    });
    expect(rows).toContainEqual({
      name: `Delete — ${PR_ARCHIVED_READONLY_MESSAGE}`,
      disabled: "true",
    });
  });

  it("C3-8: a confirmed Delete returns focus to the control focused before the menu opened", async () => {
    // Where Cancel and Save leave focus is a known Thread.tsx gap, tracked in the backlog.
    vi.mocked(forgePrReviewThreads).mockResolvedValue({
      threads: [THREADS()[1]],
      threadsTruncated: false,
    });
    vi.mocked(forgePrDeleteReviewComment).mockImplementation(async () => {
      vi.mocked(forgePrReviewThreads).mockResolvedValue({
        threads: [],
        threadsTruncated: false,
      });
    });
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await pick("My lone note", "Delete");
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByText("My lone note")).toBeNull());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(focusAt()).toBe("button:Files (1)");
  });
});

describe("a Files-tab comment edit over the real diff", () => {
  const bytes = (text: string) => ({
    base64: Buffer.from(text).toString("base64"),
    mime: null,
    tooLarge: false,
    size: text.length,
  });

  beforeEach(() => {
    stubCanvas();
    wire.realPane = true;
    wire.answer = (cmd, args) => {
      if (cmd === "forge_pr_content_revs")
        return { oldSha: BASE, newSha: args.headSha };
      if (cmd === "forge_file_at_sha")
        return bytes(args.sha === BASE ? OLD : NEW);
      return undefined;
    };
  });

  it("C3-3: an open edit raises both probes, and C3-6: survives a threads refetch", async () => {
    const user = userEvent.setup();
    const client = mount();
    await openFilesTab(user);
    await screen.findByText("My note", undefined, { timeout: 10_000 });
    // Content mode is up (it rebuilds the rows) once the gap offers to expand.
    await waitFor(
      () =>
        expect(
          document.querySelectorAll('[title^="Expand"]').length,
        ).toBeGreaterThan(0),
      { timeout: 10_000 },
    );
    expect(lineComposerOpen()).toBe(false);
    expect(whitespaceComposerOpen()).toBe(false);
    await pick("My note", "Edit");
    const box = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Edit comment",
    });
    // The real row wrapper's mark, on a text file's Files host.
    expect(
      box.closest("[data-diff-anchor]")?.getAttribute("data-diff-anchor"),
    ).toBe("whitespace");
    await user.type(box, " kept");
    expect(lineComposerOpen()).toBe(true);
    expect(whitespaceComposerOpen()).toBe(true);

    // A refetch whose answer edits another comment gives the anchors a new
    // identity; the open editor keeps its text.
    vi.mocked(forgePrReviewThreads).mockResolvedValue({
      threads: THREADS("Their note, edited"),
      threadsTruncated: false,
    });
    await act(() => client.invalidateQueries());
    await screen.findByText("Their note, edited");
    expect(editor()).toHaveValue("My note kept");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(editor()).toBeNull());
    expect(lineComposerOpen()).toBe(false);
    expect(whitespaceComposerOpen()).toBe(false);
  }, 30_000);
});
