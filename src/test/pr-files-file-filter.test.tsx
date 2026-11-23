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
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { useFileFilterStore } from "@/components/use-file-list-filter";
import { RemotePrView } from "@/features/pulls/RemotePrView";
import { ENTITY_HOLD_BOUND_MS } from "@/lib/entity-hold";
import {
  forgeGlMrMergeState,
  forgePrApprovals,
  forgePrDiff,
  forgePrReviewThreads,
  forgePrView,
  forgeStatus,
  gitFindRemotePrResolve,
} from "@/lib/git/api";
import { prContentRevsOptions } from "@/lib/git/queries";
import type { ForgeStatus, PrDetails, ReviewThreadOut } from "@/lib/git/types";
import type { ReviewDraft } from "@/lib/pulls/review-drafts";
import { loadSettings, saveSettingsMerged } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";
import { invoke } from "@/lib/tauri/invoke";
import { stubCanvas } from "./canvas-stub";

// The pending-review drafts the view reads; none unless a test seeds them.
const seeded = vi.hoisted(() => ({ drafts: undefined as unknown }));
vi.mock("@/lib/pulls/review-drafts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pulls/review-drafts")>()),
  useReviewDrafts: () => ({ data: seeded.drafts }),
}));

// The resolve merge, held here: only its roster hook may name it from the api
// package (scripts/publish-hold-routes.test.mjs).
const mergeRemotePr = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>(),
);

// The wire answers a test may install (undefined = unanswered), and whether
// the Files pane is the real diff instead of the stand-in.
const wire = vi.hoisted(() => ({
  answer: undefined as
    | ((cmd: string, args: Record<string, unknown>) => unknown)
    | undefined,
  realPane: false,
}));

// Reads this file does not answer fail at the wire, as in the merge-message
// harness, so a leaked read cannot reach the shared transport.
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
// Every read the view makes is answered here.
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(),
  forgePrView: vi.fn(),
  forgePrApprovals: vi.fn(),
  forgePrReviewThreads: vi.fn(),
  forgeGlMrMergeState: vi.fn(),
  forgePrDiff: vi.fn(),
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
// A wide row, so the rail is expanded and its field rendered.
vi.mock("@/lib/use-container-width", () => ({
  useContainerWidth: () => [() => undefined, 900],
}));
// The stand-in pane names the file it shows and the diff text it was handed,
// renders the line composer once, so the composer's path is observable, and
// renders each line anchor it was handed (the drafts' cards among them), and
// names the whole-file revs it was handed. `wire.realPane` swaps in the real
// diff.
vi.mock("@/features/diff/DiffSurfaceLazy", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/features/diff/DiffSurfaceLazy")>();
  const { useReportPaneSettled } = await import(
    "@/features/diff/diff-pane-hold"
  );
  function StandIn({
    filePath,
    data,
    contentRevs,
    lineAnchors,
    lineWidget,
  }: {
    filePath: string;
    data?: { filePath: string; text: string };
    contentRevs?: { oldRev?: string | null; newRev?: string | null };
    lineAnchors?: {
      side: "new" | "old";
      line: number;
      render: () => React.ReactNode;
    }[];
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
      <div
        data-open-file={filePath}
        data-diff-path={data?.filePath}
        data-diff-text={data?.text}
        data-content-revs={
          contentRevs ? `${contentRevs.oldRev}..${contentRevs.newRev}` : "none"
        }
      >
        {lineWidget?.render({ side: "new", line: 1, onClose: () => undefined })}
        {lineAnchors?.map((a) => (
          <div key={`${a.side}:${a.line}`} data-anchor="">
            {a.render()}
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
// The takeover's stand-in only offers its way out.
vi.mock("@/features/pulls/ResolveRemotePrView", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/pulls/ResolveRemotePrView")
  >()),
  ResolveRemotePrView: ({ onDone }: { onDone: () => void }) => (
    <button type="button" onClick={onDone}>
      Leave resolve
    </button>
  ),
}));
// A controlled draft field and a way out, so a test can tell whether the
// composer kept its text and close it.
vi.mock("@/features/pulls/ReviewComposer", async () => {
  const { useState } = await import("react");
  function ReviewComposer({
    path,
    onClose,
  }: {
    path: string;
    onClose?: () => void;
  }) {
    const [text, setText] = useState("");
    return (
      <div data-composer-path={path}>
        <textarea
          aria-label="Review comment"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="button" onClick={onClose}>
          Close composer
        </button>
      </div>
    );
  }
  return { ReviewComposer };
});

Element.prototype.scrollIntoView = vi.fn();

const REPO = "C:/repo";
const SHA = "0123456789abcdef0123456789abcdef01234567";
/** Another head, and the merge base the revs read answers. */
const SHA8 = "89abcdef01".repeat(4);
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
const LONG = Array.from(
  { length: 42 },
  (_, i) => `src/file-${String(i).padStart(2, "0")}.ts`,
);

/** The files each pull request carries, by number. */
let lists: Record<number, string[]> = {};
/** Per-number overrides of the details read (a held answer, a capped list). */
let views: Record<number, () => Promise<PrDetails>> = {};

/** Paths whose patch section is binary (and whose counts are 0/0). */
let binaries = new Set<string>();

const patch = (paths: string[]) =>
  paths
    .map((p) =>
      binaries.has(p)
        ? `diff --git a/${p} b/${p}\nindex 1111111..2222222 100644\nBinary files a/${p} and b/${p} differ\n`
        : `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-old ${p}\n+new ${p}\n`,
    )
    .join("");

function pr(number: number, over: Partial<PrDetails> = {}): PrDetails {
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
    files: (lists[number] ?? []).map((path) => ({
      path,
      additions: binaries.has(path) ? 0 : 1,
      deletions: binaries.has(path) ? 0 : 1,
    })),
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
    ...over,
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
  lists = {};
  views = {};
  binaries = new Set();
  seeded.drafts = undefined;
  wire.answer = undefined;
  wire.realPane = false;
  useFileFilterStore.setState({ texts: {} });
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(saveSettingsMerged).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(forgeStatus).mockResolvedValue(GITLAB);
  vi.mocked(forgePrView).mockImplementation(async (_repo, number) =>
    views[number] ? views[number]() : pr(number),
  );
  vi.mocked(forgePrDiff).mockImplementation(async (_repo, number) =>
    patch(lists[number] ?? []),
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
  vi.mocked(gitFindRemotePrResolve).mockResolvedValue(null);
  mergeRemotePr.mockRejectedValue(new Error("not merged"));
  vi.mocked(forgeGlMrMergeState).mockResolvedValue({
    autoMergeEnabled: false,
    detailedMergeStatus: "mergeable",
    pipelineStatus: null,
  } as never);
  // The pulls tab shows this PR, so the view reveals it and its holds run.
  useUiStore.setState({
    repoPath: REPO,
    repoTab: "pulls",
    selectedPr: { kind: "remote", id: "7" },
  });
});

// No unmockedCommands check: the invoke mock rejects unanswered reads first.
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

afterAll(() => useFileFilterStore.setState({ texts: {} }));

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

const openFilesTab = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(await screen.findByRole("button", { name: /^Files \(\d+\)$/ }));
const field = () =>
  screen.getByRole<HTMLInputElement>("textbox", {
    name: "Filter changed files",
  });
const fieldGroup = () =>
  field().closest('[data-slot="input-group"]') as HTMLElement;
const rail = () => screen.getByRole("complementary", { name: "Changed files" });
const rendered = () =>
  Array.from(
    rail().querySelectorAll<HTMLElement>("[data-path]"),
    (el) => el.dataset.path,
  );
const live = (attr: string) =>
  Array.from(document.querySelectorAll(`[${attr}]`))
    .find((el) => el.closest("[inert]") === null)
    ?.getAttribute(attr);
const openFile = () => live("data-open-file");
const composerPath = () => live("data-composer-path");
/** The diff text the shown pane was handed: each fixture file's is its own. */
const diffText = () => live("data-diff-text");
const expectShown = (path: string) => {
  expect(openFile()).toBe(path);
  expect(composerPath()).toBe(path);
  // Exactly the file's own section of the pull request's patch.
  expect(diffText()).toBe(patch([path]));
};
const expectOpen = (path: string) => waitFor(() => expectShown(path));
const status = () =>
  document.querySelector<HTMLElement>("[data-file-filter-status]");
/** The draft bodies the shown pane's line anchors render. */
const shownAnchors = () =>
  Array.from(document.querySelectorAll("[data-anchor]"))
    .filter((el) => el.closest("[inert]") === null)
    .flatMap((el) => el.textContent?.match(/draft on [a-z/.]+/g) ?? []);
const draft = (id: string, path: string): ReviewDraft => ({
  id,
  path,
  line: 1,
  side: "new",
  body: `draft on ${path}`,
  createdAt: "2026-01-01T00:00:00Z",
});
const statusCount = () =>
  document.querySelectorAll("[data-file-filter-status]").length;
/** The view's host: the status's parent, busy only during a hold. */
const host = () => status()?.parentElement as HTMLElement;
const epoch = () => useUiStore.getState().interactionEpoch;

describe("Pull request Files tab file filter", () => {
  // No timer to fake: first in the file, it renders the view cold, and
  // dev-build React render time sets its length.
  it("T1: the count lives in the field; typing filters the rows and keeps the open diff", async () => {
    lists[7] = ["src/index.ts", "lib/index.ts", "docs/index.md", "src/a.ts"];
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await expectOpen("src/index.ts");
    expect(fieldGroup().textContent).toContain("4 files");
    await user.type(field(), "index");
    expect(rendered()).toEqual([
      "src/index.ts",
      "lib/index.ts",
      "docs/index.md",
    ]);
    await user.clear(field());
    await user.type(field(), "lib/");
    expect(rendered()).toEqual(["lib/index.ts"]);
    expect(fieldGroup().textContent).toContain("1 of 4");
    await act(() => Promise.resolve());
    expectShown("src/index.ts");
    expect(rail().querySelector("[aria-current]")).toBeNull();
    expect(status()?.textContent).toBe("Showing 1 of 4 files");
  }, 10_000);

  it("A9: a capped list keeps its notice above the rail and counts loaded rows", async () => {
    lists[7] = ["src/a.ts", "lib/b.ts"];
    views[7] = async () => pr(7, { filesUnknown: true, filesTruncated: true });
    const user = userEvent.setup();
    mount();
    // The loading frame offers a bare "Files" too: wait for the loaded view.
    await screen.findByRole("button", { name: "Conversation (0)" });
    await user.click(screen.getByRole("button", { name: "Files" }));
    await expectOpen("src/a.ts");
    const notice = screen.getByText(/may be incomplete/);
    expect(
      notice.compareDocumentPosition(rail()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(fieldGroup().textContent).toContain("2 files");
    await user.type(field(), "lib");
    expect(fieldGroup().querySelector(".tabular-nums")?.textContent).toBe(
      "1 of 2",
    );
  });

  it("T10: the open file's drafts stay under the filter; Enter shows the match's", async () => {
    lists[7] = ["src/a.ts", "lib/b.ts", "lib/c.ts"];
    seeded.drafts = [draft("d-a", "src/a.ts"), draft("d-b", "lib/b.ts")];
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await expectOpen("src/a.ts");
    await waitFor(() => expect(shownAnchors()).toEqual(["draft on src/a.ts"]));
    await user.type(field(), "lib");
    expect(rendered()).toEqual(["lib/b.ts", "lib/c.ts"]);
    await act(() => Promise.resolve());
    expectShown("src/a.ts");
    expect(shownAnchors()).toEqual(["draft on src/a.ts"]);
    await user.keyboard("{Enter}");
    await expectOpen("lib/b.ts");
    await waitFor(() => expect(shownAnchors()).toEqual(["draft on lib/b.ts"]));
  });

  it("T2: typing keeps the open file and composer; Enter opens the first match", async () => {
    lists[7] = ["src/a.ts", "src/b.ts", "lib/c.ts", "lib/d.ts"];
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await expectOpen("src/a.ts");
    await user.type(field(), "lib");
    expect(rendered()).toEqual(["lib/c.ts", "lib/d.ts"]);
    await act(() => Promise.resolve());
    expectShown("src/a.ts");
    await user.keyboard("{Enter}");
    await expectOpen("lib/c.ts");
  });

  it("T3: ArrowDown moves into the list and further arrows walk the matches only", async () => {
    lists[7] = LONG;
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await expectOpen("src/file-00.ts");
    await user.type(field(), "5.ts");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.getAttribute("data-path")).toBe(
      "src/file-05.ts",
    );
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.getAttribute("data-path")).toBe(
      "src/file-15.ts",
    );
    await expectOpen("src/file-15.ts");
  });

  it("T4: a picked file the filter hides keeps its diff and composer", async () => {
    lists[7] = ["src/a.ts", "src/b.ts", "lib/c.ts"];
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await expectOpen("src/a.ts");
    await user.click(
      rail().querySelector<HTMLElement>(
        '[data-path="src/b.ts"]',
      ) as HTMLElement,
    );
    await expectOpen("src/b.ts");
    await user.type(field(), "lib");
    expect(rendered()).toEqual(["lib/c.ts"]);
    await act(() => Promise.resolve());
    expectShown("src/b.ts");
    expect(rail().querySelector("[aria-current]")).toBeNull();
    await user.keyboard("{ArrowDown}");
    await expectOpen("lib/c.ts");
  });

  it("T5: another pull request keeps the text and opens its first match", async () => {
    lists[7] = ["src/a.ts", "lib/b.ts"];
    // Typing pins src/a.ts, which PR 8 also carries: only the PR change's pick
    // reset lets PR 8 open its first match instead.
    lists[8] = ["src/x.ts", "src/a.ts", "lib/y.ts", "lib/z.ts"];
    const user = userEvent.setup();
    const { show } = mount();
    await openFilesTab(user);
    await expectOpen("src/a.ts");
    await user.type(field(), "lib");
    show(8);
    await waitFor(() => expect(rendered()).toEqual(["lib/y.ts", "lib/z.ts"]));
    expect(field().value).toBe("lib");
    await expectOpen("lib/y.ts");
  });

  it("T6: a keystroke's pin moves no epoch; a pick that moves the open file and a row click do", async () => {
    lists[7] = ["src/a.ts", "src/b.ts", "lib/c.ts"];
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await expectOpen("src/a.ts");
    await user.click(field());
    const before = epoch();
    await user.keyboard("lib");
    expect(rendered()).toEqual(["lib/c.ts"]);
    expect(epoch()).toBe(before);
    await user.keyboard("{Enter}");
    expect(epoch()).toBeGreaterThan(before);
    await expectOpen("lib/c.ts");
    await user.clear(field());
    const afterEnter = epoch();
    await user.click(
      rail().querySelector<HTMLElement>(
        '[data-path="src/b.ts"]',
      ) as HTMLElement,
    );
    expect(epoch()).toBeGreaterThan(afterEnter);
    await expectOpen("src/b.ts");
  });

  // The hold's bound is faked below; what remains is dev-build React render
  // time over two pull requests' views and the loading frame between them.
  it("T7: one status node survives the loading frame and is blank off the Files rail", async () => {
    lists[7] = ["src/a.ts", "lib/b.ts"];
    lists[8] = ["src/x.ts", "lib/y.ts", "lib/z.ts"];
    const held = deferred<PrDetails>();
    const user = userEvent.setup();
    const { show } = mount();
    await openFilesTab(user);
    await expectOpen("src/a.ts");
    await user.type(field(), "lib");
    const node = status() as HTMLElement;
    expect(node.textContent).toBe("Showing 1 of 2 files");
    expect(statusCount()).toBe(1);
    views[8] = () => held.promise;
    // Both of the hold's clocks, its bound's timer and its performance.now()
    // reads, so only the advances below move it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      show(8);
      // Past the hold's bound the view paints its loading frame.
      await act(() => vi.advanceTimersByTimeAsync(ENTITY_HOLD_BOUND_MS));
      expect(
        screen.queryByRole("textbox", { name: "Filter changed files" }),
      ).toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(450));
      expect(node.isConnected).toBe(true);
      expect(status()).toBe(node);
      expect(statusCount()).toBe(1);
      expect(node.textContent).toBe("");
    } finally {
      vi.useRealTimers();
    }
    await act(async () => held.resolve(pr(8)));
    await expectOpen("lib/y.ts");
    expect(status()).toBe(node);
    expect(statusCount()).toBe(1);
    await waitFor(() => expect(node.textContent).toBe("Showing 2 of 3 files"));
    await user.click(screen.getByRole("button", { name: /^Conversation/ }));
    await waitFor(() => expect(node.textContent).toBe(""));
    expect(status()).toBe(node);
    expect(statusCount()).toBe(1);
  }, 10_000);

  it("T9: leaving the conflict-resolve takeover keeps the one status node", async () => {
    lists[7] = ["src/a.ts", "lib/b.ts"];
    const handle = { worktreePath: "C:/wt/resolve-7", worktreeId: "wt-7" };
    vi.mocked(gitFindRemotePrResolve).mockResolvedValue(handle);
    mergeRemotePr.mockResolvedValue({
      status: "conflicts",
      conflicts: [],
      pushedSha: null,
      ...handle,
    });
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await expectOpen("src/a.ts");
    await user.type(field(), "lib");
    const node = status() as HTMLElement;
    expect(node.textContent).toBe("Showing 1 of 2 files");
    await user.click(
      await screen.findByRole("button", { name: "Continue resolving" }),
    );
    const leave = await screen.findByRole("button", { name: "Leave resolve" });
    expect(status()).toBe(node);
    expect(statusCount()).toBe(1);
    expect(node.textContent).toBe("");
    await user.click(leave);
    await expectOpen("src/a.ts");
    expect(status()).toBe(node);
    expect(statusCount()).toBe(1);
    await waitFor(() => expect(node.textContent).toBe("Showing 1 of 2 files"));
  }, 10_000);

  it("T8: during a hold the held pull request's rail and open file stay put", async () => {
    useFileFilterStore.setState({ texts: { "pr-files": "lib" } });
    lists[7] = ["src/a.ts", "lib/b.ts"];
    lists[8] = ["src/x.ts", "lib/y.ts"];
    const held = deferred<PrDetails>();
    const user = userEvent.setup();
    const { show } = mount();
    await openFilesTab(user);
    await expectOpen("lib/b.ts");
    views[8] = () => held.promise;
    // Both of the hold's clocks are faked, so a slow render can't end it
    // before the checks below.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      show(8);
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(host().getAttribute("aria-busy")).toBe("true");
      const current = host().querySelector("aside [aria-current]");
      expect(current?.getAttribute("data-path")).toBe("lib/b.ts");
      const shown = Array.from(
        host().querySelectorAll("[data-open-file]"),
        (el) => el.getAttribute("data-open-file"),
      );
      expect(shown).toEqual(["lib/b.ts"]);
    } finally {
      await act(() => vi.advanceTimersByTimeAsync(0));
      vi.useRealTimers();
    }
    await act(async () => held.resolve(pr(8)));
    await expectOpen("lib/y.ts");
  });

  it("P1: a filter matching nothing says so and keeps the open diff and composer", async () => {
    lists[7] = ["src/a.ts", "lib/b.ts"];
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await expectOpen("src/a.ts");
    await user.type(field(), "zzz");
    expect(rendered()).toEqual([]);
    expect(screen.getByText("No files match the filter")).toBeTruthy();
    await act(() => Promise.resolve());
    expectShown("src/a.ts");
    const clears = screen.getAllByRole("button", { name: "Clear filter" });
    await user.click(clears[clears.length - 1]);
    expect(rendered()).toEqual(["src/a.ts", "lib/b.ts"]);
  });

  it("P2: a one-file pull request counts one file; an empty one counts none", async () => {
    lists[7] = ["src/only.ts"];
    const user = userEvent.setup();
    const { show } = mount();
    await openFilesTab(user);
    await expectOpen("src/only.ts");
    expect(fieldGroup().textContent).toContain("1 file");
    expect(fieldGroup().textContent).not.toContain("1 files");
    show(9);
    await waitFor(() => expect(fieldGroup().textContent).toContain("0 files"));
    expect(rendered()).toEqual([]);
  });

  it("P3: a binary row keeps its bin stat under the filter", async () => {
    lists[7] = ["src/a.ts", "img/logo.png"];
    binaries = new Set(["img/logo.png"]);
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await expectOpen("src/a.ts");
    await user.type(field(), "png");
    expect(rendered()).toEqual(["img/logo.png"]);
    await waitFor(() =>
      expect(
        rail().querySelector('[data-path="img/logo.png"]')?.textContent,
      ).toContain("bin"),
    );
  });

  // No timer to fake: it renders the whole view's error arm, then loading,
  // then loaded, and dev-build React render time sets its length.
  it("P4: the error arm's status is blank and is the loaded arm's node", async () => {
    useFileFilterStore.setState({ texts: { "pr-files": "lib" } });
    lists[7] = ["src/a.ts", "lib/b.ts"];
    views[7] = async () => {
      throw new Error("boom");
    };
    const user = userEvent.setup();
    mount();
    const retry = await screen.findByRole("button", { name: "Retry" });
    const node = status() as HTMLElement;
    expect(node.textContent).toBe("");
    delete views[7];
    await user.click(retry);
    await openFilesTab(user);
    await expectOpen("lib/b.ts");
    expect(status()).toBe(node);
    await waitFor(() => expect(node.textContent).toBe("Showing 1 of 2 files"));
  }, 10_000);

  // Its bound is faked; what remains is dev-build React render time over the
  // held view and the error arm.
  it("P4b: a pull request that fails during the hold blanks the held status", async () => {
    lists[7] = ["src/a.ts", "lib/b.ts"];
    const failing = deferred<PrDetails>();
    const user = userEvent.setup();
    const { show } = mount();
    await openFilesTab(user);
    await expectOpen("src/a.ts");
    await user.type(field(), "lib");
    const node = status() as HTMLElement;
    expect(node.textContent).toBe("Showing 1 of 2 files");
    views[8] = () => failing.promise;
    // Both of the hold's clocks are faked, so its bound can't expire: the
    // status holds its text during the hold and is blank once the error arm
    // shows.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      show(8);
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(host().getAttribute("aria-busy")).toBe("true");
      expect(node.textContent).toBe("Showing 1 of 2 files");
      await act(async () => failing.reject(new Error("boom")));
      // Well inside the bound; flushes the queries' batched notifications.
      await act(() => vi.advanceTimersByTimeAsync(100));
      // The error arm itself (other sections may offer a Retry of their own).
      screen.getByText(/^Couldn.t load this merge request/);
      expect(status()).toBe(node);
      expect(node.textContent).toBe("");
    } finally {
      await act(() => vi.advanceTimersByTimeAsync(0));
      vi.useRealTimers();
    }
  }, 10_000);

  // No timer to fake: it renders the whole view offline, then loaded, and
  // dev-build React render time sets its length.
  it("P5: the offline arm's status is blank and is the loaded arm's node", async () => {
    useFileFilterStore.setState({ texts: { "pr-files": "lib" } });
    lists[7] = ["src/a.ts", "lib/b.ts"];
    onlineManager.setOnline(false);
    try {
      const user = userEvent.setup();
      mount();
      await waitFor(() => expect(status()).not.toBeNull());
      await screen.findByText(/offline/i);
      const node = status() as HTMLElement;
      expect(node.textContent).toBe("");
      act(() => onlineManager.setOnline(true));
      await openFilesTab(user);
      await expectOpen("lib/b.ts");
      expect(status()).toBe(node);
      await waitFor(() =>
        expect(node.textContent).toBe("Showing 1 of 2 files"),
      );
    } finally {
      onlineManager.setOnline(true);
    }
  }, 10_000);
});

describe("Pull request Files tab whole-file reads", () => {
  const sent = () => vi.mocked(invoke).mock.calls.map(([cmd]) => cmd);
  const revsReads = () =>
    vi
      .mocked(invoke)
      .mock.calls.filter(([cmd]) => cmd === "forge_pr_content_revs");

  it("reads nothing new on the Conversation tab, and the head's revs on Files", async () => {
    lists[7] = ["src/a.ts"];
    const user = userEvent.setup();
    mount();
    await screen.findByRole("button", { name: /^Files \(\d+\)$/ });
    await act(async () => undefined);
    for (const cmd of [
      "forge_pr_content_revs",
      "forge_commit_first_parent",
      "forge_file_at_sha",
    ])
      expect(sent()).not.toContain(cmd);
    await openFilesTab(user);
    await waitFor(() => expect(revsReads().length).toBeGreaterThan(0));
    expect(revsReads()[0]?.[1]).toMatchObject({
      repoPath: REPO,
      number: 7,
      headSha: SHA,
    });
    // A cold mount of the whole view: dev-build render time sets its length.
  }, 30_000);

  /** The revs the shown pane was handed, as `old..new`, or "none". */
  const paneRevs = () => live("data-content-revs");
  const revsFor = (n: number) =>
    revsReads()
      .map(([, args]) => args as { number: number; headSha: string })
      .filter((a) => a.number === n)
      .map((a) => a.headSha);
  const answerRevs = () => {
    wire.answer = (cmd, args) =>
      cmd === "forge_pr_content_revs"
        ? { oldSha: BASE, newSha: args.headSha }
        : undefined;
  };
  /** Long enough for a read answered at once to reach its observers and the
   *  pane's presence read after it. */
  const settle = () =>
    act(() => new Promise((resolve) => setTimeout(resolve, 50)));

  it("AC-L1: hands the pane no revs while its diff is another pull request's", async () => {
    lists[7] = ["src/a.ts"];
    lists[8] = ["src/a.ts"];
    views[8] = async () => pr(8, { headSha: SHA8 });
    const diff8 = deferred<string>();
    vi.mocked(forgePrDiff).mockImplementation(async (_repo, number) =>
      number === 8 ? diff8.promise : patch(lists[number] ?? []),
    );
    answerRevs();
    const user = userEvent.setup();
    const { client, show } = mount();
    await openFilesTab(user);
    await waitFor(() => expect(paneRevs()).toBe(`${BASE}..${SHA}`));
    // Switched from Conversation, the hold settles on the details alone, so
    // Files opens on PR 8's own details over PR 7's placeholder diff.
    await user.click(screen.getByRole("button", { name: /^Conversation/ }));
    show(8);
    await screen.findByText("Merge request 8");
    await openFilesTab(user);
    const key = prContentRevsOptions(REPO, 8, "origin", SHA8).queryKey;
    await waitFor(() => expect(client.getQueryData(key)).toBeDefined());
    await settle();
    expect(openFile()).toBe("src/a.ts");
    expect(paneRevs()).toBe("none");
    await act(async () => diff8.resolve(patch(lists[8])));
    await waitFor(() => expect(paneRevs()).toBe(`${BASE}..${SHA8}`));
  }, 30_000);

  it("AC-L1: keeps the revs it has through a failed refetch", async () => {
    lists[7] = ["src/a.ts"];
    let refuse = false;
    wire.answer = (cmd, args) => {
      if (cmd !== "forge_pr_content_revs") return undefined;
      // A refusal is never retried, so the refetch settles at once.
      return refuse
        ? Promise.reject({ kind: "invalidArgument", message: "refused" })
        : { oldSha: BASE, newSha: args.headSha };
    };
    const user = userEvent.setup();
    const { client } = mount();
    await openFilesTab(user);
    await waitFor(() => expect(paneRevs()).toBe(`${BASE}..${SHA}`));
    refuse = true;
    const key = prContentRevsOptions(REPO, 7, "origin", SHA).queryKey;
    await act(() => client.refetchQueries({ queryKey: key }));
    expect(client.getQueryState(key)?.status).toBe("error");
    await settle();
    expect(paneRevs()).toBe(`${BASE}..${SHA}`);
  }, 30_000);

  it("AC-L2: never reads revs under a placeholder's head", async () => {
    lists[7] = ["src/a.ts"];
    lists[8] = ["src/a.ts"];
    const held = deferred<PrDetails>();
    views[8] = () => held.promise;
    answerRevs();
    const user = userEvent.setup();
    const { show } = mount();
    await openFilesTab(user);
    await waitFor(() => expect(paneRevs()).toBe(`${BASE}..${SHA}`));
    show(8);
    // Past the hold's bound the view moves to PR 8 over PR 7's placeholder
    // details, whose head is PR 7's.
    await act(
      () =>
        new Promise((resolve) =>
          setTimeout(resolve, ENTITY_HOLD_BOUND_MS + 200),
        ),
    );
    await settle();
    expect(revsFor(8)).toEqual([]);
    await act(async () => held.resolve(pr(8, { headSha: SHA8 })));
    await waitFor(() => expect(revsFor(8)).toEqual([SHA8]));
    await waitFor(() => expect(paneRevs()).toBe(`${BASE}..${SHA8}`));
  }, 30_000);
});

describe("Pull request Files tab drawn by the real diff", () => {
  const lines = (n: number) =>
    Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join("");
  /** A 40-line file edited at lines 2 and 32: two hunks over a gap. */
  const OLD = lines(40);
  const NEW = OLD.replace("line 2\n", "line two\n").replace(
    "line 32\n",
    "line thirty-two\n",
  );
  const TEXT =
    "diff --git a/f.txt b/f.txt\nindex 1111111..2222222 100644\n--- a/f.txt\n+++ b/f.txt\n" +
    "@@ -1,3 +1,3 @@\n line 1\n-line 2\n+line two\n line 3\n" +
    "@@ -31,3 +31,3 @@\n line 31\n-line 32\n+line thirty-two\n line 33\n";
  /** git's order for a binary file turned into a symbolic link. */
  const TYPECHANGE =
    "diff --git a/link b/link\ndeleted file mode 100644\nindex 1111111..0000000\nBinary files a/link and /dev/null differ\n" +
    "diff --git a/link b/link\nnew file mode 120000\nindex 0000000..2222222\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+target/path\n\\ No newline at end of file\n";
  const thread = (
    id: string,
    path: string,
    line: number,
    body: string,
  ): ReviewThreadOut => ({
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
        body,
        date: "2026-01-01T00:00:00Z",
        id: `N_${id}`,
        url: "",
        viewerDidAuthor: false,
        isMinimized: false,
        minimizedReason: "",
        reviewId: "",
      },
    ],
  });
  const bytes = (text: string) => ({
    base64: Buffer.from(text).toString("base64"),
    mime: null,
    tooLarge: false,
    size: text.length,
  });
  const expands = () =>
    document.querySelectorAll<HTMLElement>('[title^="Expand"]');
  /** Every drawing of `text`, and how many sit in an inline diff anchor. */
  const drawn = (text: string) => {
    const all = screen.queryAllByText(text);
    return {
      count: all.length,
      inline: all.filter((el) => el.closest('[data-diff-anchor="layout"]'))
        .length,
    };
  };

  beforeEach(() => {
    stubCanvas();
    wire.realPane = true;
    // The pull request's revs, and each side's whole file by its sha.
    wire.answer = (cmd, args) => {
      if (cmd === "forge_pr_content_revs")
        return { oldSha: BASE, newSha: args.headSha };
      if (cmd === "forge_file_at_sha")
        return bytes(args.sha === BASE ? OLD : NEW);
      return undefined;
    };
  });

  it("AC-R3: an off-patch thread and draft draw once, inline, when their gap opens", async () => {
    lists[7] = ["f.txt"];
    vi.mocked(forgePrDiff).mockResolvedValue(TEXT);
    vi.mocked(forgePrReviewThreads).mockResolvedValue({
      threads: [thread("T1", "f.txt", 16, "On a gap line")],
      threadsTruncated: false,
    });
    seeded.drafts = [
      {
        id: "d1",
        path: "f.txt",
        line: 20,
        side: "new",
        body: "Draft on a gap line",
        createdAt: "2026-01-01T00:00:00Z",
      } satisfies ReviewDraft,
    ];
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    // Content mode is up once the gap rows offer to expand.
    await waitFor(() => expect(expands().length).toBeGreaterThan(0), {
      timeout: 10_000,
    });
    expect(drawn("On a gap line").count).toBe(0);
    expect(drawn("Draft on a gap line").count).toBe(0);
    for (let i = 0; i < 20 && expands().length > 0; i++)
      await user.click(expands()[0]);
    await waitFor(() =>
      expect(drawn("On a gap line")).toEqual({ count: 1, inline: 1 }),
    );
    expect(drawn("Draft on a gap line")).toEqual({ count: 1, inline: 1 });
  }, 30_000);

  it("AC-T2: a binary-to-link typechange draws its link half, the thread once inline, and the composer there", async () => {
    lists[7] = ["link"];
    vi.mocked(forgePrDiff).mockResolvedValue(TYPECHANGE);
    vi.mocked(forgePrReviewThreads).mockResolvedValue({
      threads: [thread("T2", "link", 1, "On the link")],
      threadsTruncated: false,
    });
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    expect(
      await screen.findByText("Binary file removed", undefined, {
        timeout: 10_000,
      }),
    ).toBeTruthy();
    const linkLine = () =>
      document.querySelector('span[data-line-new-num="1"]');
    await waitFor(() => expect(linkLine()).not.toBeNull());
    await waitFor(() =>
      expect(drawn("On the link")).toEqual({ count: 1, inline: 1 }),
    );
    const num = linkLine()?.closest(".diff-line-num") as HTMLElement;
    fireEvent.mouseOver(num);
    fireEvent.mouseDown(
      num.closest("tr")?.querySelector(".diff-add-widget") as HTMLElement,
    );
    await waitFor(() =>
      expect(
        document
          .querySelector('[data-composer-path="link"]')
          ?.closest('[data-diff-line-widget="layout"]'),
      ).not.toBeNull(),
    );
  }, 30_000);

  it("keeps a composer's text through a failed first revs read and its retry, upgrading once it closes", async () => {
    lists[7] = ["f.txt"];
    vi.mocked(forgePrDiff).mockResolvedValue(TEXT);
    let refuse = true;
    wire.answer = (cmd, args) => {
      if (cmd === "forge_pr_content_revs")
        return refuse
          ? Promise.reject({ kind: "invalidArgument", message: "refused" })
          : { oldSha: BASE, newSha: args.headSha };
      if (cmd === "forge_file_at_sha")
        return bytes(args.sha === BASE ? OLD : NEW);
      return undefined;
    };
    const fileReads = () =>
      vi
        .mocked(invoke)
        .mock.calls.filter(([cmd]) => cmd === "forge_file_at_sha").length;
    const user = userEvent.setup();
    const { client } = mount();
    await openFilesTab(user);
    const key = prContentRevsOptions(REPO, 7, "origin", SHA).queryKey;
    await waitFor(
      () => expect(client.getQueryState(key)?.status).toBe("error"),
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
    const draft = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Review comment",
    });
    await user.type(draft, "kept");
    // The retry answers: the presence read, then the forge reads follow.
    refuse = false;
    await act(() => client.refetchQueries({ queryKey: key }));
    await waitFor(() => expect(fileReads()).toBe(2));
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(draft.isConnected).toBe(true);
    expect(draft.value).toBe("kept");
    expect(expands().length).toBe(0);
    await user.click(screen.getByRole("button", { name: "Close composer" }));
    await waitFor(() => expect(expands().length).toBeGreaterThan(0));
  }, 30_000);

  it("drops an image's old-head pair once a push's revs read is refused, never while it reads", async () => {
    binaries.add("img.png");
    lists[7] = ["img.png"];
    const newRevs = deferred<unknown>();
    wire.answer = (cmd, args) => {
      if (cmd === "forge_pr_content_revs")
        return args.headSha === SHA8
          ? newRevs.promise
          : { oldSha: BASE, newSha: args.headSha };
      if (cmd === "forge_file_at_sha")
        return {
          base64: "iVBORw0KGgo=",
          mime: "image/png",
          tooLarge: false,
          size: 8,
        };
      return undefined;
    };
    const user = userEvent.setup();
    const { client } = mount();
    await openFilesTab(user);
    const figures = () => document.querySelectorAll("figure");
    await waitFor(() => expect(figures()).toHaveLength(2), { timeout: 10_000 });
    const nodes = [...figures()];
    // A push moves the head; its revs read is in flight.
    views[7] = async () => pr(7, { headSha: SHA8 });
    await act(() => client.invalidateQueries());
    const key = prContentRevsOptions(REPO, 7, "origin", SHA8).queryKey;
    await waitFor(() =>
      expect(client.getQueryState(key)?.fetchStatus).toBe("fetching"),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect([...figures()]).toEqual(nodes);
    // Refused, so never retried: it settles at once.
    await act(async () =>
      newRevs.reject({ kind: "invalidArgument", message: "refused" }),
    );
    await waitFor(() =>
      expect(client.getQueryState(key)?.status).toBe("error"),
    );
    await waitFor(() => expect(figures()).toHaveLength(0));
    expect(nodes.some((n) => n.isConnected)).toBe(false);
    expect(screen.getAllByText(/^Binary file/).length).toBeGreaterThan(0);
  }, 30_000);
});
