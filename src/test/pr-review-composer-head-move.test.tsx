import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
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
import type { DiffLineAnchor } from "@/features/diff/DiffSurface";
import { DIFF_ROWS_HELD_REASON } from "@/features/diff/whitespace-mode";
import {
  HEAD_COLD_DIALOG_REASON,
  HEAD_PENDING_DIALOG_REASON,
  HEAD_PENDING_REVIEW_REASON,
  HEAD_UNPROVEN_REVIEW_REASON,
} from "@/features/pulls/head-pending";
import { RemotePrView } from "@/features/pulls/RemotePrView";
import {
  forgeBbPrTasks,
  forgeGlMrMergeState,
  forgePrApprovals,
  forgePrDiff,
  forgePrDiffAt,
  forgePrHeadProof,
  forgePrReviewThreads,
  forgePrThreadCreate,
  forgePrThreadReply,
  forgePrView,
  forgeStatus,
  gitFindRemotePrResolve,
} from "@/lib/git/api";
import {
  PR_DIFF_MOVED_RECHECK_MS,
  prDetailsOptions,
  prDiffOptions,
} from "@/lib/git/queries";
import type {
  ForgeStatus,
  PrDetails,
  PrTask,
  ReviewThreadOut,
} from "@/lib/git/types";
import type { ReviewDraft } from "@/lib/pulls/review-drafts";
import { loadSettings, saveSettingsMerged } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";
import { stubCanvas } from "./canvas-stub";

// The view over a head move: the real composer, its writes counted at their
// seams. Harness shape after pr-files-file-filter.test.tsx, minus its composer.
const seeded = vi.hoisted(() => ({
  drafts: undefined as unknown,
  addDraft: vi.fn(async () => undefined),
  updateDraft: vi.fn(async () => undefined),
}));
vi.mock("@/lib/pulls/review-drafts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pulls/review-drafts")>()),
  useReviewDrafts: () => ({ data: seeded.drafts }),
  useAddReviewDraft: () => ({ mutateAsync: seeded.addDraft, isPending: false }),
  useUpdateReviewDraft: () => ({
    mutateAsync: seeded.updateDraft,
    isPending: false,
  }),
}));

const mergeRemotePr = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>(),
);

// The wire answers a test may install, whether the Files pane is the real
// diff, and how often the stand-in's composer was closed.
const wire = vi.hoisted(() => ({
  answer: undefined as
    | ((cmd: string, args: Record<string, unknown>) => unknown)
    | undefined,
  realPane: false,
  closed: 0,
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
  forgeBbPrTasks: vi.fn(),
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
  forgePrHeadProof: vi.fn(),
  forgePrThreadCreate: vi.fn(async () => ({})),
  forgePrThreadReply: vi.fn(async () => ({})),
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
  gitMergeRemotePr: mergeRemotePr,
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
// The stand-in pane names the diff text it was handed, renders the line widget
// whenever it is handed one (at new line 1) and each line anchor it was handed.
vi.mock("@/features/diff/DiffSurfaceLazy", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/features/diff/DiffSurfaceLazy")>();
  const { useReportPaneSettled } = await import(
    "@/features/diff/diff-pane-hold"
  );
  function StandIn({
    data,
    lineAnchors,
    renderAnchor,
    lineWidget,
  }: {
    data?: { filePath: string; text: string };
    lineAnchors?: DiffLineAnchor[];
    renderAnchor?: (anchor: DiffLineAnchor) => React.ReactNode;
    lineWidget?: {
      render: (args: {
        side: "new" | "old";
        line: number;
        onClose: () => void;
      }) => React.ReactNode;
    };
  }) {
    useReportPaneSettled(true);
    return (
      <div data-diff-text={data?.text}>
        {lineWidget?.render({
          side: "new",
          line: 1,
          onClose: () => {
            wire.closed += 1;
          },
        })}
        {lineAnchors?.map((a) => (
          <div key={`${a.side}:${a.line}`} data-anchor="">
            {renderAnchor?.(a)}
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
// While `hold` is set, every deferred value in src keeps the value it last
// returned, so a test can act in the frames between an urgent render and its
// deferred commit. Inert otherwise; `release` lets the held values catch up.
const lag = vi.hoisted(() => ({
  hold: false,
  listeners: new Set<() => void>(),
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const subscribe = (listener: () => void) => {
    lag.listeners.add(listener);
    return () => {
      lag.listeners.delete(listener);
    };
  };
  const holding = () => lag.hold;
  function useDeferredValue<T>(value: T, initialValue?: T): T {
    const hold = actual.useSyncExternalStore(subscribe, holding);
    const last = actual.useRef(value);
    if (!hold) last.current = value;
    return actual.useDeferredValue(last.current, initialValue as T);
  }
  return { ...actual, useDeferredValue };
});
const releaseLag = () =>
  act(() => {
    lag.hold = false;
    for (const listener of lag.listeners) listener();
  });
vi.mock("@/features/pulls/ResolveRemotePrView", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/pulls/ResolveRemotePrView")
  >()),
  ResolveRemotePrView: () => null,
}));

Element.prototype.scrollIntoView = vi.fn();

const REPO = "C:/repo";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA8 = "89abcdef01".repeat(4);
/** The diff entry of a head under the fixtures' base. */
const diffKey = (head: string) =>
  prDiffOptions(REPO, 7, "origin", { head, baseRef: "main", baseSha: null })
    .queryKey;
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

/** The files the pull request carries, the head its details name, and the
 *  diff reads still to answer in order (then the files' patch, or `text`). */
let files: string[] = [];
let head = SHA;
let diffs: (() => Promise<string>)[] = [];
let text: string | undefined;

const patch = (paths: string[]) =>
  paths
    .map(
      (p) =>
        `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-old ${p}\n+new ${p}\n`,
    )
    .join("");

function pr(): PrDetails {
  return {
    id: "PR_7",
    number: 7,
    title: "Merge request 7",
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
    files: files.map((path) => ({ path, additions: 1, deletions: 1 })),
    reviews: [],
    comments: [],
    checks: [],
    checksUnknown: false,
    checksTruncated: false,
    commentsUnknown: false,
    commentsTruncated: false,
    commitsUnknown: false,
    commitsTruncated: false,
    headSha: head,
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

function thread(id: string, path: string, line: number): ReviewThreadOut {
  return {
    id,
    reviewId: "",
    path,
    line,
    startLine: 0,
    side: "new",
    isResolved: false,
    isOutdated: false,
    diffHunk: "",
    comments: [
      {
        author: "someone",
        authorAvatarUrl: "",
        state: "",
        body: "On line one",
        date: "2026-01-01T00:00:00Z",
        id: `N_${id}`,
        url: "",
        viewerDidAuthor: false,
        isMinimized: false,
        minimizedReason: "",
        reviewId: "",
      },
    ],
  };
}

const clients: QueryClient[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  files = ["src/a.ts"];
  head = SHA;
  diffs = [];
  text = undefined;
  lag.hold = false;
  seeded.drafts = undefined;
  wire.answer = undefined;
  wire.realPane = false;
  wire.closed = 0;
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(saveSettingsMerged).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(forgeStatus).mockResolvedValue(GITLAB);
  vi.mocked(forgePrView).mockImplementation(async () => pr());
  // GitLab's head read is contradiction-only: moved on a readable other head,
  // else unproven, never proven, so only a proven /changes releases a hold.
  vi.mocked(forgePrHeadProof).mockImplementation(async (r, n, l, at) => {
    const named = (await forgePrView(r, n, l)).headSha?.toLowerCase();
    return named && named !== at.head ? "moved" : "unproven";
  });
  // The fixture's capabilities are all on, tasks included; their read fails.
  vi.mocked(forgeBbPrTasks).mockRejectedValue(new Error("tasks unavailable"));
  vi.mocked(forgePrDiff).mockImplementation(async () => {
    const next = diffs.shift();
    return next ? next() : (text ?? patch(files));
  });
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
  vi.mocked(gitFindRemotePrResolve).mockResolvedValue(null);
  mergeRemotePr.mockRejectedValue(new Error("not merged"));
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
  onlineManager.setOnline(true);
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

const NOUN = "merge request";
const openFilesTab = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(await screen.findByRole("button", { name: /^Files \(\d+\)$/ }));
const composerBox = () =>
  screen.getByRole<HTMLTextAreaElement>("textbox", { name: /^Comment on / });
const single = () => screen.getByRole("button", { name: "Add single comment" });
const submitButtons = () => [
  single(),
  screen.getByRole("button", { name: /^(Start a review|Add to review)$/ }),
];
const expectHeld = (reason: string) => {
  for (const button of submitButtons()) {
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription(reason);
  }
};
const expectLifted = () => {
  for (const button of submitButtons())
    expect(button).not.toHaveAttribute("aria-disabled", "true");
};
const settleWrites = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 50)));
/** The clocks a moved check runs on; React's scheduler stays on real ones. */
const DRIVEN = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "performance",
] as const;
/** `waitFor` on the driven clock: steps it until `check` passes, since RTL's
 *  own polling timers are faked there and never fire. */
async function until(
  check: () => void,
  { timeout = 1000 }: { timeout?: number } = {},
) {
  for (let spent = 0; ; spent += 5) {
    try {
      check();
      return;
    } catch (error) {
      if (spent >= timeout) throw error;
    }
    await act(() => vi.advanceTimersByTimeAsync(5));
  }
}

/** The details re-read naming `next`, with the next diff read held. */
async function moveHead(client: QueryClient, next: string) {
  const reads = vi.mocked(forgePrDiff).mock.calls.length;
  head = next;
  await act(() =>
    client.refetchQueries({
      queryKey: prDetailsOptions(REPO, 7, "origin").queryKey,
      exact: true,
    }),
  );
  // The observer re-keyed onto the new head: that render has committed.
  await waitFor(() =>
    expect(vi.mocked(forgePrDiff).mock.calls.length).toBe(reads + 1),
  );
}

describe("the review composer across a head move, in the view (AC-A10)", () => {
  it("keeps its node and text, holds both submits and the chord, and posts once when the new diff lands", async () => {
    const user = userEvent.setup();
    const client = mount();
    await openFilesTab(user);
    const box = await waitFor(composerBox);
    await user.type(box, "kept");
    const held = deferred<string>();
    diffs.push(() => held.promise);
    await moveHead(client, SHA8);
    expect(box.isConnected).toBe(true);
    expect(box).toHaveValue("kept");
    // The older head's diff stays painted.
    expect(
      document
        .querySelector("[data-diff-text]")
        ?.getAttribute("data-diff-text"),
    ).toBe(patch(files));
    await user.click(box);
    await user.keyboard("{Control>}{Enter}{/Control}");
    await user.click(single());
    await settleWrites();
    expect(forgePrThreadCreate).not.toHaveBeenCalled();
    expect(seeded.addDraft).not.toHaveBeenCalled();
    expectHeld(HEAD_PENDING_REVIEW_REASON.loading(NOUN));
    await user.click(screen.getByRole("button", { name: "Add suggestion" }));
    expect(box.value).toContain("```suggestion");
    await act(async () => held.resolve(patch(files)));
    await waitFor(expectLifted);
    expect(composerBox()).toBe(box);
    expect(box.value).toContain("kept");
    await user.click(single());
    await waitFor(() => expect(forgePrThreadCreate).toHaveBeenCalledTimes(1));
    expect(forgePrThreadCreate).toHaveBeenCalledWith(
      REPO,
      expect.objectContaining({
        number: 7,
        path: "src/a.ts",
        line: 1,
        side: "new",
        body: expect.stringContaining("kept"),
      }),
      "origin",
    );
  }, 20_000);

  it("no timer lifts the hold: ten minutes on it is still held, and Cancel still closes", async () => {
    const user = userEvent.setup();
    const client = mount();
    await openFilesTab(user);
    const box = await waitFor(composerBox);
    await user.type(box, "kept");
    diffs.push(() => new Promise<string>(() => undefined));
    await moveHead(client, SHA8);
    expectHeld(HEAD_PENDING_REVIEW_REASON.loading(NOUN));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
    } finally {
      vi.useRealTimers();
    }
    expect(box.isConnected).toBe(true);
    expect(box).toHaveValue("kept");
    expectHeld(HEAD_PENDING_REVIEW_REASON.loading(NOUN));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(wire.closed).toBe(1);
  }, 20_000);
});

describe("what the hold leaves alone (AC-A12)", () => {
  it("a thread Reply posts and a pending draft's Edit saves during the window", async () => {
    vi.mocked(forgePrReviewThreads).mockResolvedValue({
      threads: [thread("T1", "src/a.ts", 1)],
      threadsTruncated: false,
    });
    seeded.drafts = [
      {
        id: "d1",
        path: "src/a.ts",
        line: 1,
        side: "new",
        body: "Draft body",
        createdAt: "2026-01-01T00:00:00Z",
      } satisfies ReviewDraft,
    ];
    const user = userEvent.setup();
    const client = mount();
    await openFilesTab(user);
    await screen.findByText("On line one");
    diffs.push(() => new Promise<string>(() => undefined));
    await moveHead(client, SHA8);
    expectHeld(HEAD_PENDING_REVIEW_REASON.loading(NOUN));
    const anchor = document.querySelector("[data-anchor]") as HTMLElement;
    await user.click(within(anchor).getByRole("button", { name: "Reply…" }));
    await user.type(
      within(anchor).getByRole("textbox", { name: "Reply to review thread" }),
      "a reply",
    );
    await user.click(within(anchor).getByRole("button", { name: "Reply" }));
    await waitFor(() =>
      expect(forgePrThreadReply).toHaveBeenCalledWith(REPO, 7, "T1", "a reply"),
    );
    await user.click(
      within(anchor).getByRole("button", { name: "Edit pending comment" }),
    );
    const edit = within(anchor).getByRole("textbox", {
      name: "Edit pending comment",
    });
    await user.clear(edit);
    await user.type(edit, "Edited body");
    await user.click(within(anchor).getByRole("button", { name: /^Save/ }));
    await waitFor(() =>
      expect(seeded.updateDraft).toHaveBeenCalledWith({
        id: "d1",
        body: "Edited body",
      }),
    );
  }, 20_000);
});

describe("over the real diff (AC-A10's D13 case, AC-A11)", () => {
  const lines = (n: number) =>
    Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join("");
  const OLD = lines(40);
  const NEW = OLD.replace("line 2\n", "line two\n");
  const HUNK =
    "diff --git a/f.txt b/f.txt\nindex 1111111..2222222 100644\n--- a/f.txt\n+++ b/f.txt\n" +
    "@@ -1,3 +1,3 @@\n line 1\n-line 2\n+line two\n line 3\n";
  /** The same file after a push that edited its section again. */
  const PUSHED = HUNK.replace("+line two\n", "+line 2, pushed\n");
  /** The diff pane notice's Retry (the mergeability line carries its own). */
  const DIFF_RETRY = "Retry loading this diff";
  const bytes = (body: string) => ({
    base64: Buffer.from(body).toString("base64"),
    mime: null,
    tooLarge: false,
    size: body.length,
  });

  beforeEach(() => {
    stubCanvas();
    wire.realPane = true;
    files = ["f.txt"];
    text = HUNK;
    wire.answer = (cmd, args) => {
      if (cmd === "forge_pr_content_revs")
        return { oldSha: BASE, newSha: args.headSha };
      if (cmd === "forge_file_at_sha")
        return bytes(args.sha === BASE ? OLD : NEW);
      return undefined;
    };
  });

  async function openComposer(user: ReturnType<typeof userEvent.setup>) {
    await openFilesTab(user);
    return composeOnLine2(user);
  }

  async function composeOnLine2(user: ReturnType<typeof userEvent.setup>) {
    // Content mode is up (its gap rows offer to expand), so the rows are final.
    await waitFor(
      () =>
        expect(
          document.querySelectorAll('[title^="Expand"]').length,
        ).toBeGreaterThan(0),
      { timeout: 10_000 },
    );
    const num = await waitFor(
      () => {
        const cell = document
          .querySelector('span[data-line-new-num="2"]')
          ?.closest(".diff-line-num");
        expect(cell).toBeTruthy();
        return cell as HTMLElement;
      },
      { timeout: 10_000 },
    );
    fireEvent.mouseOver(num);
    fireEvent.mouseDown(
      num.closest("tr")?.querySelector(".diff-add-widget") as HTMLElement,
    );
    const box = await waitFor(composerBox);
    await user.type(box, "kept");
    return box;
  }

  it("keeps the composer when the file's section is unchanged", async () => {
    const user = userEvent.setup();
    const client = mount();
    const box = await openComposer(user);
    const held = deferred<string>();
    diffs.push(() => held.promise);
    await moveHead(client, SHA8);
    expect(box.isConnected).toBe(true);
    expectHeld(HEAD_PENDING_REVIEW_REASON.loading(NOUN));
    await act(async () => held.resolve(HUNK));
    await waitFor(expectLifted);
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(box.isConnected).toBe(true);
    expect(box).toHaveValue("kept");
  }, 30_000);

  const SECOND_HUNK =
    "@@ -9,3 +9,3 @@\n line 9\n-line 10\n+line ten\n line 11\n";
  const FIRST_HUNK = "@@ -1,3 +1,3 @@\n line 1\n-line 2\n+line two\n line 3\n";
  /** A push that edits another line of the section: line 2 and both its
   *  neighbours read as before. */
  const KEPT_LINE = `${HUNK}${SECOND_HUNK}`;

  it("A1-2: a push that kept the line restores the composer on the new rows, and it posts once", async () => {
    const user = userEvent.setup();
    const client = mount();
    const box = await openComposer(user);
    const held = deferred<string>();
    diffs.push(() => held.promise);
    await moveHead(client, SHA8);
    await act(async () => held.resolve(KEPT_LINE));
    await waitFor(
      () => expect(document.body.textContent).toContain("line ten"),
      { timeout: 10_000 },
    );
    const back = await waitFor(() => {
      const next = composerBox();
      expect(next).toHaveValue("kept");
      return next;
    });
    expect(back).not.toBe(box);
    await waitFor(expectLifted);
    await user.click(single());
    await waitFor(() => expect(forgePrThreadCreate).toHaveBeenCalledTimes(1));
    expect(forgePrThreadCreate).toHaveBeenCalledWith(
      REPO,
      expect.objectContaining({ line: 2, side: "new", body: "kept" }),
      "origin",
    );
  }, 30_000);

  for (const [name, next, shows] of [
    ["(i) the line's text changed", PUSHED, "line 2, pushed"],
    [
      "(ii) a line inserted above it",
      HUNK.replace(
        "@@ -1,3 +1,3 @@\n line 1\n",
        "@@ -1,3 +1,4 @@\n line 1\n+inserted\n",
      ),
      "inserted",
    ],
    [
      "(iii) its hunk removed",
      HUNK.replace(FIRST_HUNK, SECOND_HUNK),
      "line ten",
    ],
  ] as const)
    it(`A1-3 ${name}: the composer holds the older rows until it closes`, async () => {
      const user = userEvent.setup();
      const client = mount();
      const box = await openComposer(user);
      const held = deferred<string>();
      diffs.push(() => held.promise);
      await moveHead(client, SHA8);
      await act(async () => held.resolve(next));
      await waitFor(() => expectHeld(DIFF_ROWS_HELD_REASON), {
        timeout: 10_000,
      });
      expect(box.isConnected).toBe(true);
      expect(composerBox()).toBe(box);
      expect(box).toHaveValue("kept");
      expect(document.body.textContent).toContain("line two");
      expect(document.body.textContent).not.toContain(shows);
      const suggest = screen.getByRole("button", { name: "Add suggestion" });
      expect(suggest).toHaveAttribute("aria-disabled", "true");
      expect(suggest).toHaveAccessibleDescription(DIFF_ROWS_HELD_REASON);
      await user.click(suggest);
      expect(box).toHaveValue("kept");
      await user.click(single());
      box.focus();
      await user.keyboard("{Control>}{Enter}{/Control}");
      await settleWrites();
      expect(forgePrThreadCreate).not.toHaveBeenCalled();
      expect(seeded.addDraft).not.toHaveBeenCalled();
      const widget = box.closest("[data-diff-line-widget]") as HTMLElement;
      await user.click(within(widget).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(document.body.textContent).toContain(shows), {
        timeout: 10_000,
      });
      expect(document.activeElement).toBe(
        screen.getByRole("group", { name: "Diff of f.txt" }),
      );
    }, 30_000);

  it("A1-3: a second push while the rows are held shows the pull request's own hold first", async () => {
    const user = userEvent.setup();
    const client = mount();
    const box = await openComposer(user);
    diffs.push(async () => PUSHED);
    await moveHead(client, SHA8);
    await waitFor(() => expectHeld(DIFF_ROWS_HELD_REASON), {
      timeout: 10_000,
    });
    diffs.push(() => Promise.reject(new Error("boom")));
    await moveHead(client, BASE);
    await waitFor(() => expectHeld(HEAD_PENDING_REVIEW_REASON.failed(NOUN)), {
      timeout: 10_000,
    });
    expect(box.isConnected).toBe(true);
  }, 30_000);

  it("holds both submits while the rows on screen are the older text's, until the deferred paint", async () => {
    const pushedNew = OLD.replace("line 2\n", "line 2, pushed\n");
    const answer = wire.answer;
    wire.answer = (cmd, args) =>
      cmd === "forge_file_at_sha" && args.sha === SHA8
        ? bytes(pushedNew)
        : answer?.(cmd, args);
    const user = userEvent.setup();
    const client = mount();
    const box = await openComposer(user);
    lag.hold = true;
    diffs.push(async () => PUSHED);
    await moveHead(client, SHA8);
    // The new head's diff is this pull request's own answer: no older-head
    // placeholder holds the composer any more.
    await waitFor(() =>
      expect(client.getQueryState(diffKey(SHA8))?.status).toBe("success"),
    );
    await settleWrites();
    // The rows under the composer are still the older text's.
    expect(box.isConnected).toBe(true);
    expect(document.body.textContent).toContain("line two");
    expect(document.body.textContent).not.toContain("line 2, pushed");
    expectHeld(HEAD_PENDING_REVIEW_REASON.loading(NOUN));
    await user.click(single());
    await settleWrites();
    expect(forgePrThreadCreate).not.toHaveBeenCalled();
    await releaseLag();
    // The push changed the composer's line, so the older rows stay under it,
    // held with the file's own reason, until it closes; one opened on the new
    // rows then posts, with no kept text.
    await waitFor(() => expectHeld(DIFF_ROWS_HELD_REASON), {
      timeout: 10_000,
    });
    expect(box.isConnected).toBe(true);
    expect(document.body.textContent).not.toContain("line 2, pushed");
    const widget = box.closest("[data-diff-line-widget]") as HTMLElement;
    await user.click(within(widget).getByRole("button", { name: "Cancel" }));
    const again = await composeOnLine2(user);
    expect(again).toHaveValue("kept");
    expect(document.body.textContent).toContain("line 2, pushed");
    expectLifted();
    await user.click(single());
    await waitFor(() => expect(forgePrThreadCreate).toHaveBeenCalledTimes(1));
  }, 30_000);

  it("AC-A11 failed: the pane's notice offers Retry, which re-reads the new head and lifts the hold", async () => {
    const user = userEvent.setup();
    const client = mount();
    const box = await openComposer(user);
    // The diff read keeps its own retry policy: one retry, a second later.
    diffs.push(() => Promise.reject(new Error("boom")));
    diffs.push(() => Promise.reject(new Error("boom")));
    await moveHead(client, SHA8);
    await screen.findByText(
      "Couldn't refresh this diff — showing the last loaded version.",
      undefined,
      { timeout: 5_000 },
    );
    expect(box.isConnected).toBe(true);
    expect(box).toHaveValue("kept");
    expectHeld(HEAD_PENDING_REVIEW_REASON.failed(NOUN));
    const reads = vi.mocked(forgePrDiff).mock.calls.length;
    await user.click(screen.getByRole("button", { name: DIFF_RETRY }));
    await waitFor(expectLifted);
    expect(vi.mocked(forgePrDiff).mock.calls.length).toBe(reads + 1);
    expect(client.getQueryState(diffKey(SHA8))?.status).toBe("success");
    expect(composerBox()).toBe(box);
    await user.click(single());
    await waitFor(() => expect(forgePrThreadCreate).toHaveBeenCalledTimes(1));
    expect(forgePrThreadCreate).toHaveBeenCalledWith(
      REPO,
      expect.objectContaining({ line: 2, side: "new", body: "kept" }),
      "origin",
    );
  }, 30_000);

  it("AC-A11 offline: a parked read holds with the offline reason and no Retry, and lifts back online", async () => {
    const user = userEvent.setup();
    const client = mount();
    const box = await openComposer(user);
    act(() => onlineManager.setOnline(false));
    head = SHA8;
    act(() =>
      client.setQueryData(prDetailsOptions(REPO, 7, "origin").queryKey, pr()),
    );
    await waitFor(() => expectHeld(HEAD_PENDING_REVIEW_REASON.offline(NOUN)));
    expect(box.isConnected).toBe(true);
    screen.getByText(/^You're offline — showing the last opened diff/);
    expect(screen.queryByRole("button", { name: DIFF_RETRY })).toBeNull();
    act(() => onlineManager.setOnline(true));
    await waitFor(expectLifted);
    expect(composerBox()).toBe(box);
    expect(box).toHaveValue("kept");
  }, 30_000);
});

describe("the head holds of every review submit, in the view (F3, F5)", () => {
  type DiffAt = Awaited<ReturnType<typeof forgePrDiffAt>>;
  const unproven = async (): Promise<DiffAt> => ({
    diff: patch(files),
    headProof: "unproven",
  });
  const openConversation = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole("button", { name: /^Conversation/ }));
  const dialogSubmit = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(
      byTitle("Submit a review (verdict, summary, and any pending comments)"),
    );
    const dialog = await screen.findByRole("dialog");
    return within(dialog).getByRole("button", { name: "Submit review" });
  };
  /** A button by its title: a role query over the whole view is slow. */
  const byTitle = (title: string) =>
    document.querySelector<HTMLElement>(
      `button[title="${title}"]`,
    ) as HTMLElement;
  const expectButtonHeld = (button: HTMLElement, reason: string) => {
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription(reason);
  };
  /** The direct verdict toggle, by its label: its title follows the draft. */
  const requestChangesButton = () => {
    const button = [...document.querySelectorAll("button")].find((b) =>
      /^(Request changes|Changes requested)$/.test(b.textContent?.trim() ?? ""),
    );
    expect(button).toBeTruthy();
    return button as HTMLElement;
  };
  /** The first details read answers; every read after it fails, the diff
   *  run's own head read included, so nothing proves the diff. */
  const holdDetailsRereads = () =>
    vi
      .mocked(forgePrView)
      .mockImplementation(() => Promise.reject(new Error("head read failed")))
      .mockImplementationOnce(async () => pr());

  it("(a) an unproven diff holds the composer's submits, Approve, Request changes and Submit review's Submit with its reason", async () => {
    holdDetailsRereads();
    vi.mocked(forgePrDiffAt).mockImplementationOnce(unproven);
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await user.type(await waitFor(composerBox), "kept");
    const reason = HEAD_UNPROVEN_REVIEW_REASON(NOUN);
    await waitFor(() => expectHeld(reason));
    await openConversation(user);
    await waitFor(() =>
      expectButtonHeld(byTitle(`Approve this ${NOUN}`), reason),
    );
    expectButtonHeld(requestChangesButton(), reason);
    expectButtonHeld(await dialogSubmit(user), reason);
  }, 20_000);

  it("E6/G6: a cold diff whose own head read is outstanding holds Approve, Request changes and Submit review's Submit on the cold loading reason", async () => {
    const head = deferred<ReturnType<typeof pr>>();
    vi.mocked(forgePrView)
      .mockImplementationOnce(async () => pr())
      .mockImplementationOnce(() => head.promise);
    vi.mocked(forgePrDiffAt).mockImplementationOnce(unproven);
    const user = userEvent.setup();
    const client = mount();
    await openConversation(user);
    await waitFor(() => expect(forgePrView).toHaveBeenCalledTimes(2));
    const reason = HEAD_COLD_DIALOG_REASON.loading(NOUN);
    expect(document.body.textContent).not.toMatch(/was updated/);
    await waitFor(() =>
      expectButtonHeld(byTitle(`Approve this ${NOUN}`), reason),
    );
    expectButtonHeld(requestChangesButton(), reason);
    expectButtonHeld(await dialogSubmit(user), reason);
    await act(async () => head.resolve(pr()));
    // GitLab's head read answers unproven at best, so it releases nothing: the
    // hold stands until a /changes read proves the head.
    await act(async () => {
      await vi.mocked(forgePrHeadProof).mock.results[0]?.value;
    });
    const unprovenReason = HEAD_UNPROVEN_REVIEW_REASON(NOUN);
    await waitFor(() =>
      expectButtonHeld(byTitle(`Approve this ${NOUN}`), unprovenReason),
    );
    expectButtonHeld(requestChangesButton(), unprovenReason);
    const proven = deferred<DiffAt>();
    vi.mocked(forgePrDiffAt).mockImplementationOnce(() => proven.promise);
    act(() => {
      void client.invalidateQueries({ queryKey: diffKey(SHA), exact: true });
    });
    await waitFor(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(2));
    expectButtonHeld(byTitle(`Approve this ${NOUN}`), unprovenReason);
    await act(async () =>
      proven.resolve({ diff: patch(files), headProof: "proven" }),
    );
    await waitFor(() =>
      expect(byTitle(`Approve this ${NOUN}`)).not.toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    );
  }, 20_000);

  it("(a) revoking an approval stays free under the hold", async () => {
    vi.mocked(forgePrApprovals).mockResolvedValue({
      viewerHasApproved: true,
      approvedBy: ["me"],
      approvalsRequired: 0,
      approvalsLeft: 0,
      viewerRequestedChanges: false,
    });
    holdDetailsRereads();
    vi.mocked(forgePrDiffAt).mockImplementationOnce(unproven);
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await waitFor(composerBox);
    await waitFor(() => expectHeld(HEAD_UNPROVEN_REVIEW_REASON(NOUN)));
    await openConversation(user);
    const approved = await waitFor(() => {
      const button = byTitle("Revoke your approval");
      expect(button).toBeTruthy();
      return button;
    });
    expect(approved).toHaveTextContent("Approved");
    expect(approved).not.toHaveAttribute("aria-disabled", "true");
  }, 20_000);

  it("(a) a change request already made stays free under the hold", async () => {
    vi.mocked(forgePrApprovals).mockResolvedValue({
      viewerHasApproved: false,
      approvedBy: [],
      approvalsRequired: 0,
      approvalsLeft: 0,
      viewerRequestedChanges: true,
    });
    holdDetailsRereads();
    vi.mocked(forgePrDiffAt).mockImplementationOnce(unproven);
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await waitFor(composerBox);
    await waitFor(() => expectHeld(HEAD_UNPROVEN_REVIEW_REASON(NOUN)));
    await openConversation(user);
    // GitLab's requested state is a focusable indicator (its undo is
    // Premium-only); Bitbucket's revoke takes the same free arm.
    const requested = await waitFor(() => {
      const button = requestChangesButton();
      expect(button).toHaveTextContent("Changes requested");
      return button;
    });
    expect(requested).not.toHaveAttribute("aria-disabled", "true");
  }, 20_000);

  it("(d) Request changes is free over a proven head and holds as loading while a moved answer is checked", async () => {
    const user = userEvent.setup();
    const client = mount();
    await openFilesTab(user);
    await user.type(await waitFor(composerBox), "kept");
    await waitFor(expectLifted);
    const early = deferred<DiffAt>();
    const atDeadline = deferred<DiffAt>();
    vi.mocked(forgePrDiffAt)
      .mockImplementationOnce(async () => ({
        diff: patch(files),
        headProof: "moved",
      }))
      .mockImplementationOnce(() => early.promise)
      .mockImplementationOnce(() => atDeadline.promise);
    await openConversation(user);
    await waitFor(() =>
      expect(requestChangesButton()).not.toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    );
    const loading = HEAD_PENDING_DIALOG_REASON.loading(NOUN);
    vi.useFakeTimers({ toFake: [...DRIVEN] });
    try {
      act(() => {
        void client.invalidateQueries({ queryKey: diffKey(SHA), exact: true });
      });
      // Read 2 answers moved; read 3 is its early re-check.
      await until(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(3));
      await until(() => expectButtonHeld(requestChangesButton(), loading));
      await act(async () =>
        early.resolve({ diff: patch(files), headProof: "proven" }),
      );
      // Started before the settle deadline, read 3's proven answer stays
      // moved: the hold stands until the deadline's read.
      await act(() =>
        vi.advanceTimersByTimeAsync(PR_DIFF_MOVED_RECHECK_MS / 2),
      );
      expect(forgePrDiffAt).toHaveBeenCalledTimes(3);
      expectButtonHeld(requestChangesButton(), loading);
      await until(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(4), {
        timeout: PR_DIFF_MOVED_RECHECK_MS,
      });
      expectButtonHeld(requestChangesButton(), loading);
      // Read 4, at the deadline, is the one that releases it.
      await act(async () =>
        atDeadline.resolve({ diff: patch(files), headProof: "proven" }),
      );
      await until(() =>
        expect(requestChangesButton()).not.toHaveAttribute(
          "aria-disabled",
          "true",
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it("(b) a moved answer under check holds as loading, and no reason points at a Retry", async () => {
    const user = userEvent.setup();
    const client = mount();
    await openFilesTab(user);
    await user.type(await waitFor(composerBox), "kept");
    await waitFor(expectLifted);
    const early = deferred<DiffAt>();
    const atDeadline = deferred<DiffAt>();
    vi.mocked(forgePrDiffAt)
      .mockImplementationOnce(async () => ({
        diff: patch(files),
        headProof: "moved",
      }))
      .mockImplementationOnce(() => early.promise)
      .mockImplementationOnce(() => atDeadline.promise);
    const loading = HEAD_PENDING_REVIEW_REASON.loading(NOUN);
    vi.useFakeTimers({ toFake: [...DRIVEN] });
    try {
      act(() => {
        void client.invalidateQueries({ queryKey: diffKey(SHA), exact: true });
      });
      await until(() => expectHeld(loading));
      // Read 2 answers moved; read 3 is its early re-check.
      await until(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(3));
      expect(document.body.textContent).not.toContain("Retry above the diff");
      expect(document.body.textContent).not.toContain(
        HEAD_PENDING_DIALOG_REASON.failed(NOUN),
      );
      await act(async () =>
        early.resolve({ diff: patch(files), headProof: "proven" }),
      );
      // Started before the settle deadline, read 3's proven answer stays
      // moved: the hold stands until the deadline's read.
      await act(() =>
        vi.advanceTimersByTimeAsync(PR_DIFF_MOVED_RECHECK_MS / 2),
      );
      expect(forgePrDiffAt).toHaveBeenCalledTimes(3);
      expectHeld(loading);
      await until(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(4), {
        timeout: PR_DIFF_MOVED_RECHECK_MS,
      });
      expectHeld(loading);
      // Read 4, at the deadline, is the one that releases it.
      await act(async () =>
        atDeadline.resolve({ diff: patch(files), headProof: "proven" }),
      );
      await until(expectLifted);
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it("(c) a base-branch change alone holds as loading in the composer and in Submit review", async () => {
    const user = userEvent.setup();
    const client = mount();
    await openFilesTab(user);
    await user.type(await waitFor(composerBox), "kept");
    await waitFor(expectLifted);
    const reads = vi.mocked(forgePrDiffAt).mock.calls.length;
    vi.mocked(forgePrDiffAt).mockImplementationOnce(
      () => new Promise<DiffAt>(() => undefined),
    );
    vi.mocked(forgePrView).mockImplementation(async () => ({
      ...pr(),
      baseRefName: "release",
    }));
    await act(() =>
      client.refetchQueries({
        queryKey: prDetailsOptions(REPO, 7, "origin").queryKey,
        exact: true,
      }),
    );
    await waitFor(() =>
      expect(vi.mocked(forgePrDiffAt).mock.calls.length).toBe(reads + 1),
    );
    expect(vi.mocked(forgePrDiffAt).mock.calls[reads]?.[3].baseRef).toBe(
      "release",
    );
    await waitFor(() => expectHeld(HEAD_PENDING_REVIEW_REASON.loading(NOUN)));
    await openConversation(user);
    expectButtonHeld(
      await dialogSubmit(user),
      HEAD_PENDING_DIALOG_REASON.loading(NOUN),
    );
  }, 20_000);

  it("N3: a cold moved check holds Approve, Request changes and Submit review's Submit through a failed re-check and its Retry's start", async () => {
    const failed = () => Promise.reject(new Error("diff failed"));
    // The first answer of the key is moved (no text of its own); the read's own
    // retry policy re-runs the failed re-check once.
    vi.mocked(forgePrDiffAt)
      .mockImplementationOnce(async () => ({ diff: "", headProof: "moved" }))
      .mockImplementationOnce(failed)
      .mockImplementationOnce(failed);
    const user = userEvent.setup();
    const client = mount();
    await openConversation(user);
    await waitFor(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(3), {
      timeout: 5_000,
    });
    const expectAllHeld = async (reason: string) => {
      await waitFor(() =>
        expectButtonHeld(byTitle(`Approve this ${NOUN}`), reason),
      );
      expectButtonHeld(requestChangesButton(), reason);
      const submit = await dialogSubmit(user);
      expectButtonHeld(submit, reason);
      return submit;
    };
    await expectAllHeld(HEAD_PENDING_DIALOG_REASON.failed(NOUN));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Retry's start: the pane's Retry is the read's own refetch.
    const held = deferred<DiffAt>();
    vi.mocked(forgePrDiffAt).mockImplementationOnce(() => held.promise);
    act(() => {
      void client.refetchQueries({ queryKey: diffKey(SHA), exact: true });
    });
    await waitFor(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(4));
    const again = await expectAllHeld(HEAD_PENDING_DIALOG_REASON.loading(NOUN));
    await act(async () =>
      held.resolve({ diff: patch(files), headProof: "proven" }),
    );
    await waitFor(() =>
      expect(again).not.toHaveAccessibleDescription(
        HEAD_PENDING_DIALOG_REASON.loading(NOUN),
      ),
    );
  }, 20_000);

  const expectVerdictsHeld = async (
    user: ReturnType<typeof userEvent.setup>,
    reason: string,
  ) => {
    await waitFor(() =>
      expectButtonHeld(byTitle(`Approve this ${NOUN}`), reason),
    );
    expectButtonHeld(requestChangesButton(), reason);
    expectButtonHeld(await dialogSubmit(user), reason);
    // A cold proof knows of no update.
    expect(document.body.textContent).not.toMatch(/was updated/);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  };
  const expectVerdictsFree = () =>
    waitFor(() => {
      expect(byTitle(`Approve this ${NOUN}`)).not.toHaveAttribute(
        "aria-disabled",
        "true",
      );
      expect(requestChangesButton()).not.toHaveAttribute(
        "aria-disabled",
        "true",
      );
    });

  it("G6: a cold open whose first diff read is outstanding holds the verdicts on the cold loading reason", async () => {
    const first = deferred<DiffAt>();
    vi.mocked(forgePrDiffAt).mockImplementationOnce(() => first.promise);
    const user = userEvent.setup();
    mount();
    await openConversation(user);
    await expectVerdictsHeld(user, HEAD_COLD_DIALOG_REASON.loading(NOUN));
    await act(async () =>
      first.resolve({ diff: patch(files), headProof: "proven" }),
    );
    await expectVerdictsFree();
  }, 20_000);

  for (const [rows, list] of [
    ["one file row", () => undefined],
    [
      "no file rows",
      () => {
        files = [];
      },
    ],
    [
      "an unknown file list",
      () => {
        files = [];
        vi.mocked(forgePrView).mockImplementation(
          async () => ({ ...pr(), filesUnknown: true }) as PrDetails,
        );
      },
    ],
  ] as const)
    it(`G5/T17: a failed first diff read holds the verdicts on the cold failed reason until the Files tab's Retry proves it (${rows})`, async () => {
      list();
      const failed = () => Promise.reject(new Error("diff failed"));
      // The read's own retry policy re-runs the failure once.
      vi.mocked(forgePrDiffAt)
        .mockImplementationOnce(failed)
        .mockImplementationOnce(failed);
      const user = userEvent.setup();
      mount();
      await openConversation(user);
      await waitFor(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(2), {
        timeout: 5_000,
      });
      await expectVerdictsHeld(user, HEAD_COLD_DIALOG_REASON.failed(NOUN));
      await user.click(screen.getByRole("button", { name: /^Files/ }));
      // The diff's own notice, never another read's Retry (mergeability's is
      // always on screen): one notice and one Retry for the one failure.
      const notice = await screen.findByText("Could not load this diff");
      expect(screen.getAllByText("Could not load this diff")).toHaveLength(1);
      expect(
        screen.queryByText("Could not load diff for this file"),
      ).not.toBeInTheDocument();
      const box = notice.parentElement as HTMLElement;
      await user.click(within(box).getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(3));
      await openConversation(user);
      await expectVerdictsFree();
    }, 20_000);

  /** Paints the first head's patch, then fails the next head's read (twice:
   *  the read's own retry) with `next` as that head's file list. */
  async function failNextHead(
    user: ReturnType<typeof userEvent.setup>,
    next: string[],
  ) {
    const client = mount();
    await openFilesTab(user);
    await waitFor(
      () =>
        expect(
          document.querySelector(
            wire.realPane ? "span[data-line-new-num]" : "[data-diff-text]",
          ),
        ).not.toBeNull(),
      { timeout: 10_000 },
    );
    const failed = () => Promise.reject(new Error("diff failed"));
    diffs.push(failed, failed);
    files = next;
    await moveHead(client, SHA8);
    await waitFor(() => expect(forgePrDiff).toHaveBeenCalledTimes(3), {
      timeout: 5_000,
    });
    return client;
  }

  const diffRetry = async () =>
    within(
      (await screen.findByText("Could not load this diff"))
        .parentElement as HTMLElement,
    ).getByRole("button", { name: "Retry" });

  it("R2: a failed new head whose older text can't draw the open file shows the diff's Retry", async () => {
    const user = userEvent.setup();
    await failNextHead(user, ["src/b.ts"]);
    const retry = await diffRetry();
    await user.click(retry);
    await waitFor(() =>
      expect(
        document
          .querySelector("[data-diff-text]")
          ?.getAttribute("data-diff-text"),
      ).toBe(patch(["src/b.ts"])),
    );
  }, 20_000);

  it("R2: a failed new head whose older text draws the open file keeps that text", async () => {
    const user = userEvent.setup();
    await failNextHead(user, ["src/a.ts", "src/b.ts"]);
    await waitFor(() =>
      expect(
        document
          .querySelector("[data-diff-text]")
          ?.getAttribute("data-diff-text"),
      ).toContain("+new src/a.ts"),
    );
    expect(
      screen.queryByText("Could not load this diff"),
    ).not.toBeInTheDocument();
  }, 20_000);

  it("R3: a focused diff Retry that moves to the Files tab's own line keeps focus", async () => {
    const user = userEvent.setup();
    const client = await failNextHead(user, ["src/b.ts"]);
    const retry = await diffRetry();
    act(() => retry.focus());
    expect(retry).toHaveFocus();
    // A details-only refresh loses the file list; the diff stays failed.
    vi.mocked(forgePrView).mockImplementation(
      async () => ({ ...pr(), files: [], filesUnknown: true }) as PrDetails,
    );
    await act(() =>
      client.refetchQueries({
        queryKey: prDetailsOptions(REPO, 7, "origin").queryKey,
        exact: true,
      }),
    );
    await waitFor(() => expect(retry.isConnected).toBe(false));
    const moved = await diffRetry();
    expect(moved).not.toBe(retry);
    expect(moved).toHaveFocus();
  }, 20_000);

  /** The real pane's own Retry above the older head's drawable `src/a.ts`:
   *  the stand-in draws no notice, so these tests mount the real diff. */
  async function paneRetryOverRetainedText(
    user: ReturnType<typeof userEvent.setup>,
  ) {
    stubCanvas();
    wire.realPane = true;
    const client = await failNextHead(user, ["src/a.ts", "src/b.ts"]);
    const retry = await screen.findByRole("button", {
      name: "Retry loading this diff",
    });
    expect(
      screen.queryByText("Could not load this diff"),
    ).not.toBeInTheDocument();
    return { client, retry };
  }

  /** A details-only refresh that loses the file list; the diff stays failed. */
  const loseFileList = async (client: QueryClient) => {
    vi.mocked(forgePrView).mockImplementation(
      async () => ({ ...pr(), files: [], filesUnknown: true }) as PrDetails,
    );
    await act(() =>
      client.refetchQueries({
        queryKey: prDetailsOptions(REPO, 7, "origin").queryKey,
        exact: true,
      }),
    );
  };

  it("Q4: a focused Retry above the retained patch hands focus to the Files tab's Retry when the list goes", async () => {
    const user = userEvent.setup();
    const { client, retry } = await paneRetryOverRetainedText(user);
    act(() => retry.focus());
    expect(retry).toHaveFocus();
    await loseFileList(client);
    await waitFor(() => expect(retry.isConnected).toBe(false));
    expect(await diffRetry()).toHaveFocus();
  }, 20_000);

  it("Q4: focus outside the Files section stays where it is when the Files tab's Retry mounts", async () => {
    const user = userEvent.setup();
    const { client } = await paneRetryOverRetainedText(user);
    const files = screen.getByRole("button", { name: /^Files/ });
    act(() => files.focus());
    await loseFileList(client);
    await diffRetry();
    expect(files).toHaveFocus();
  }, 20_000);

  it("G4: a switch to another pull request holds its verdicts on the cold reason while its own diff is outstanding", async () => {
    vi.mocked(forgePrView).mockImplementation(
      async (_r, n) =>
        ({
          ...pr(),
          id: `PR_${n}`,
          number: n,
          title: `Merge request ${n}`,
        }) as PrDetails,
    );
    const other = deferred<DiffAt>();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    clients.push(client);
    const view = (n: number) => (
      <QueryClientProvider client={client}>
        <RemotePrView repoPath={REPO} number={n} />
      </QueryClientProvider>
    );
    const user = userEvent.setup();
    const { rerender } = render(view(7));
    await openConversation(user);
    await expectVerdictsFree();
    vi.mocked(forgePrDiffAt).mockImplementationOnce(() => other.promise);
    act(() => useUiStore.setState({ selectedPr: { kind: "remote", id: "8" } }));
    rerender(view(8));
    await waitFor(() =>
      expect(vi.mocked(forgePrDiffAt).mock.calls.at(-1)?.[1]).toBe(8),
    );
    await waitFor(() =>
      expect(document.body.textContent).toContain("Merge request 8"),
    );
    await expectVerdictsHeld(user, HEAD_COLD_DIALOG_REASON.loading(NOUN));
    await act(async () =>
      other.resolve({ diff: patch(files), headProof: "proven" }),
    );
    await expectVerdictsFree();
  }, 20_000);
});

describe("the Conversation feed over a failing tasks read", () => {
  const tasksReads = () => vi.mocked(forgeBbPrTasks).mock.calls.length;
  const FEED_LOADING = "Loading the conversation";
  const feedLoading = () => screen.queryByText(new RegExp(FEED_LOADING));
  const tasksRetry = () =>
    document.querySelector<HTMLElement>(
      'button[aria-label="Retry loading tasks"]',
    );
  const idle = (ms: number) =>
    act(() => new Promise((resolve) => setTimeout(resolve, ms)));
  /** Whether the feed's loading line was added at any point until the call. */
  const watchFeedLoading = () => {
    let seen = false;
    const observer = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node.textContent?.includes(FEED_LOADING)) seen = true;
    });
    observer.observe(document.body, { subtree: true, childList: true });
    return () => {
      observer.disconnect();
      return seen;
    };
  };
  /** Mounts the view on `first`; the returned call moves the selection. */
  function mountAt(first: number) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    clients.push(client);
    const tree = (n: number) => (
      <QueryClientProvider client={client}>
        <RemotePrView repoPath={REPO} number={n} />
      </QueryClientProvider>
    );
    const view = render(tree(first));
    return (n: number) => {
      act(() =>
        useUiStore.setState({ selectedPr: { kind: "remote", id: String(n) } }),
      );
      view.rerender(tree(n));
    };
  }

  it("stays open with the Tasks error and its Retry, reading tasks once per request", async () => {
    const user = userEvent.setup();
    mount();
    await idle(500);
    // One read: the section's own observer mounting on the failure sends none.
    const reads = tasksReads();
    expect(reads).toBe(1);
    await screen.findByText("Couldn't load tasks.");
    const retry = tasksRetry();
    expect(retry).not.toBeNull();
    const stop = watchFeedLoading();
    await idle(500);
    expect(tasksReads()).toBe(reads);
    // The same node: the section never remounted.
    expect(tasksRetry()).toBe(retry);
    // The retry's answer is held: the feed keeps its node and paints no
    // loading frame while the read is pending.
    const section = document.getElementById("pr-tasks-section");
    expect(section).not.toBeNull();
    let fail: (e: Error) => void = () => undefined;
    vi.mocked(forgeBbPrTasks).mockImplementationOnce(
      () =>
        new Promise<PrTask[]>((_resolve, reject) => {
          fail = reject;
        }),
    );
    await user.click(retry as HTMLElement);
    await idle(300);
    expect(tasksReads()).toBe(reads + 1);
    expect(feedLoading()).toBeNull();
    expect(document.getElementById("pr-tasks-section")).toBe(section);
    await act(async () => fail(new Error("tasks unavailable")));
    await idle(300);
    expect(stop()).toBe(false);
    expect(tasksReads()).toBe(reads + 1);
    expect(screen.getByText("Couldn't load tasks.")).toBeInTheDocument();
    expect(feedLoading()).toBeNull();
    expect(document.getElementById("pr-tasks-section")).toBe(section);
  }, 20_000);

  it("a review notification's reveal waits for a retried read, though the feed stays open", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("Couldn't load tasks.");
    let fail: (e: Error) => void = () => undefined;
    vi.mocked(forgeBbPrTasks).mockImplementationOnce(
      () =>
        new Promise<PrTask[]>((_resolve, reject) => {
          fail = reject;
        }),
    );
    await user.click(tasksRetry() as HTMLElement);
    await idle(100);
    act(() => useUiStore.setState({ pendingReviewId: "R1" }));
    await idle(300);
    expect(document.getElementById("pr-tasks-section")).not.toBeNull();
    expect(useUiStore.getState().pendingReviewId).toBe("R1");
    await act(async () => fail(new Error("tasks unavailable")));
    await waitFor(() =>
      expect(useUiStore.getState().pendingReviewId).toBeNull(),
    );
  }, 20_000);

  it("reopening the pull request after a failed tasks read re-reads it once", async () => {
    const client = mount();
    await screen.findByText("Couldn't load tasks.");
    await idle(300);
    expect(tasksReads()).toBe(1);
    cleanup();
    render(
      <QueryClientProvider client={client}>
        <RemotePrView repoPath={REPO} number={7} />
      </QueryClientProvider>,
    );
    await screen.findByText("Couldn't load tasks.");
    await idle(500);
    expect(tasksReads()).toBe(2);
  }, 20_000);

  it("a PR switch closes it: the next PR's feed waits for that PR's own reads", async () => {
    let answer: (tasks: PrTask[]) => void = () => undefined;
    vi.mocked(forgePrView).mockImplementation(async (_repo, n) => ({
      ...pr(),
      id: `PR_${n}`,
      number: n,
      title: `Merge request ${n}`,
    }));
    vi.mocked(forgeBbPrTasks).mockImplementation((_repo, n) =>
      n === 8
        ? new Promise<PrTask[]>((resolve) => {
            answer = resolve;
          })
        : Promise.reject(new Error("tasks unavailable")),
    );
    const moveTo = mountAt(7);
    await screen.findByText("Couldn't load tasks.");
    expect(feedLoading()).toBeNull();
    moveTo(8);
    await screen.findAllByText("Merge request 8");
    await waitFor(() => expect(feedLoading()).not.toBeNull());
    act(() => answer([]));
    await waitFor(() => expect(feedLoading()).toBeNull());
  }, 20_000);
});
