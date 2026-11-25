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
import { toast } from "sonner";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import {
  WHITESPACE_COMPOSER_HELD,
  WHITESPACE_ONLY_MESSAGE,
} from "@/features/diff/whitespace-mode";
import { RemotePrView } from "@/features/pulls/RemotePrView";
import { OFF_PATCH_REVIEW_REASON } from "@/features/pulls/ReviewComposer";
import {
  forgeGlMrMergeState,
  forgePrApprovals,
  forgePrDiff,
  forgePrReviewThreads,
  forgePrView,
  forgeStatus,
  gitFindRemotePrResolve,
} from "@/lib/git/api";
import { prDiffOptions } from "@/lib/git/queries";
import type { ForgeStatus, PrDetails, ReviewThreadOut } from "@/lib/git/types";
import { dispatchAction } from "@/lib/hotkeys/hotkeys";
import type { ReviewDraft } from "@/lib/pulls/review-drafts";
import type { AppSettings } from "@/lib/settings/api";
import { saveSettingsPatch } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { invoke } from "@/lib/tauri/invoke";
import { stubCanvas } from "./canvas-stub";

// The pending-review drafts the view reads; none unless a test seeds them.
const seeded = vi.hoisted(() => ({ drafts: undefined as unknown }));
vi.mock("@/lib/pulls/review-drafts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pulls/review-drafts")>()),
  useReviewDrafts: () => ({ data: seeded.drafts }),
}));

// The wire answers the test installs (undefined = unanswered).
const wire = vi.hoisted(() => ({
  answer: undefined as
    | ((cmd: string, args: Record<string, unknown>) => unknown)
    | undefined,
}));
vi.mock("@/lib/tauri/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri/invoke")>()),
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    const answer = wire.answer?.(cmd, args);
    if (answer !== undefined) return answer;
    throw new Error(`unanswered read: ${cmd}`);
  }),
}));
// The one persisted setting: a save merges its patch into what loads next.
const store = vi.hoisted(() => ({ settings: undefined as unknown }));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(async () => store.settings),
  saveSettingsMerged: vi.fn(async () => store.settings),
  saveSettingsPatch: vi.fn(async (patch: object) => {
    store.settings = { ...(store.settings as object), ...patch };
    return store.settings;
  }),
}));
vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sonner")>()),
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}));
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
// A wide row, so the rail is expanded.
vi.mock("@/lib/use-container-width", () => ({
  useContainerWidth: () => [() => undefined, 900],
}));
// A controlled draft field and a way out, so a test can tell whether the
// composer kept its text and close it. A test may ask for the real composer
// instead, with a drag range's start handed in at its seam.
const composer = vi.hoisted(() => ({
  real: false,
  fromLine: undefined as number | undefined,
}));
vi.mock("@/features/pulls/ReviewComposer", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/pulls/ReviewComposer")>();
  const { useState } = await import("react");
  function Stub({ path, onClose }: { path: string; onClose?: () => void }) {
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
  function ReviewComposer(props: Parameters<typeof actual.ReviewComposer>[0]) {
    return composer.real ? (
      <actual.ReviewComposer
        {...props}
        fromLine={composer.fromLine ?? props.fromLine}
      />
    ) : (
      <Stub path={props.path} onClose={props.onClose} />
    );
  }
  return { ...actual, ReviewComposer };
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

// A re-indent of f() plus a content edit in g(), and the whitespace-only
// re-indent alone. Sections and `-w` hunks are `git diff` output (git 2.51.1).
const OLD =
  "function f() {\n  line 1\n  line 2\n  line 3\n  line 4\n  line 5\n  line 6\n}\nfunction g() {\n  line 7\n  line 8\n  line 9\n  line 10\n  line 11\n  line 12\n  line 13\n  line 14\n}\n";
const NEW =
  "function f() {\n    line 1\n    line 2\n    line 3\n    line 4\n    line 5\n    line 6\n}\nfunction g() {\n  line 7\n  line 8\n  line 9\n  line 10\n  line ELEVEN\n  line 12\n  line 13\n  line 14\n}\n";
const WSONLY = OLD.replace(/ {2}line ([1-6])\n/g, "    line $1\n");
const EDIT_BODY =
  "@@ -1,17 +1,17 @@\n function f() {\n" +
  "-  line 1\n-  line 2\n-  line 3\n-  line 4\n-  line 5\n-  line 6\n" +
  "+    line 1\n+    line 2\n+    line 3\n+    line 4\n+    line 5\n+    line 6\n" +
  " }\n function g() {\n   line 7\n   line 8\n   line 9\n   line 10\n" +
  "-  line 11\n+  line ELEVEN\n   line 12\n   line 13\n   line 14\n";
const WS_ONLY_BODY =
  "@@ -1,10 +1,10 @@\n function f() {\n" +
  "-  line 1\n-  line 2\n-  line 3\n-  line 4\n-  line 5\n-  line 6\n" +
  "+    line 1\n+    line 2\n+    line 3\n+    line 4\n+    line 5\n+    line 6\n" +
  " }\n function g() {\n   line 7\n";
const EDIT_W_HUNKS =
  "@@ -11,7 +11,7 @@ function g() {\n   line 8\n   line 9\n   line 10\n-  line 11\n+  line ELEVEN\n   line 12\n   line 13\n   line 14\n";
/** Two hunks over a gap, for the exact guard (the -w command refused). */
const lines40 = Array.from({ length: 40 }, (_, i) => `line ${i + 1}\n`).join(
  "",
);
const NEW40 = lines40
  .replace("line 2\n", "line two\n")
  .replace("line 32\n", "line thirty-two\n");
const GAP_BODY =
  "@@ -1,3 +1,3 @@\n line 1\n-line 2\n+line two\n line 3\n" +
  "@@ -31,3 +31,3 @@\n line 31\n-line 32\n+line thirty-two\n line 33\n";
/** GAP_BODY's sides with a re-indent in the gap the section skips: the exact
 *  guard refuses them, the whitespace one would not. */
const NEW40_WS = NEW40.replace("line 15\n", "  line 15\n");
/** f.txt as later heads and another pull request have it: line 11 reads XI. */
const NEW_XI = NEW.replace("line ELEVEN", "line XI");
const EDIT_BODY_XI = EDIT_BODY.replace("+  line ELEVEN", "+  line XI");
const EDIT_W_HUNKS_XI = EDIT_W_HUNKS.replace("+  line ELEVEN", "+  line XI");
// A block duplicated above itself and re-indented: the `-w` hunk draws new
// line 24, which no forge hunk holds (`git diff` / `git diff -w`, git 2.51.1).
const rows = (a: number, b: number) =>
  Array.from({ length: b - a + 1 }, (_, i) => `row ${a + i}\n`).join("");
const DUP_OLD = `${rows(1, 12)}start\nif (a) {\n  b();\n  c();\n  d();\n  e();\n}\nend\n${rows(13, 24)}`;
const DUP_NEW = `${rows(1, 12)}start\nif (z) {\n  if (a) {\n    b();\n    c();\n    d();\n    e();\n  }\n}\nend\n${rows(13, 24)}`;
const DUP_BODY =
  "@@ -11,11 +11,13 @@ row 10\n row 11\n row 12\n start\n" +
  "-if (a) {\n-  b();\n-  c();\n-  d();\n-  e();\n" +
  "+if (z) {\n+  if (a) {\n+    b();\n+    c();\n+    d();\n+    e();\n+  }\n" +
  " }\n end\n row 13\n";
const DUP_W_HUNKS =
  "@@ -11,12 +11,14 @@ row 10\n row 11\n row 12\n start\n+if (z) {\n" +
  "   if (a) {\n     b();\n     c();\n     d();\n     e();\n   }\n+}\n" +
  " end\n row 13\n row 14\n";
/** Later heads of PR 7 (XI; f.txt unchanged; f.txt unreadable) and PR 8's. */
const SHA2 = "2345678901".repeat(4);
const SHA3 = "3456789012".repeat(4);
const SHA4 = "4567890123".repeat(4);
const SHA8 = "8901234567".repeat(4);

const plainSection = (path: string, body: string) =>
  `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n${body}`;
const SECTIONS: Record<string, string> = {
  "f.txt": plainSection("f.txt", EDIT_BODY),
  "w.txt": plainSection("w.txt", WS_ONLY_BODY),
  "g.txt": plainSection("g.txt", EDIT_BODY),
  "gap.txt": plainSection("gap.txt", GAP_BODY),
  "r-new.txt":
    "diff --git a/r-old.txt b/r-new.txt\nsimilarity index 70%\nrename from r-old.txt\nrename to r-new.txt\nindex 1111111..2222222 100644\n--- a/r-old.txt\n+++ b/r-new.txt\n" +
    WS_ONLY_BODY,
  "moved.txt":
    "diff --git a/m-old.txt b/moved.txt\nsimilarity index 100%\nrename from m-old.txt\nrename to moved.txt\n",
  "bin.dat":
    "diff --git a/bin.dat b/bin.dat\nindex 1111111..2222222 100644\nBinary files a/bin.dat and b/bin.dat differ\n",
  // A symlink replaced by a binary file: git's two sections, joined.
  "t.dat":
    "diff --git a/t.dat b/t.dat\ndeleted file mode 120000\nindex 1111111..0000000\n--- a/t.dat\n+++ /dev/null\n@@ -1 +0,0 @@\n-target.dat\n\\ No newline at end of file\n" +
    "diff --git a/t.dat b/t.dat\nnew file mode 100644\nindex 0000000..2222222\nBinary files /dev/null and b/t.dat differ\n",
  "empty.txt":
    "diff --git a/empty.txt b/empty.txt\nnew file mode 100644\nindex 0000000..e69de29\n",
  "dup.txt": plainSection("dup.txt", DUP_BODY),
  "gapws.txt": plainSection("gapws.txt", GAP_BODY),
  "pic.png":
    "diff --git a/pic.png b/pic.png\nindex 1111111..2222222 100644\nBinary files a/pic.png and b/pic.png differ\n",
};
/** A head's own sections where they differ from SECTIONS. */
const SECTIONS_AT: Record<string, Record<string, string>> = {
  [SHA2]: { "f.txt": plainSection("f.txt", EDIT_BODY_XI) },
  [SHA8]: { "f.txt": plainSection("f.txt", EDIT_BODY_XI) },
};
/** Each path's whole file by the sha it is read at. g.txt's old side differs
 *  from its section in a context line, so its sides can't be proven. */
const FILES: Record<string, Record<string, string>> = {
  "f.txt": {
    [BASE]: OLD,
    [SHA]: NEW,
    [SHA2]: NEW_XI,
    [SHA3]: NEW,
    [SHA8]: NEW_XI,
  },
  "dup.txt": { [BASE]: DUP_OLD, [SHA]: DUP_NEW },
  "gapws.txt": { [BASE]: lines40, [SHA]: NEW40_WS },
  "w.txt": { [BASE]: OLD, [SHA]: WSONLY },
  "g.txt": { [BASE]: OLD.replace("  line 8\n", "  line 8x\n"), [SHA]: NEW },
  "gap.txt": { [BASE]: lines40, [SHA]: NEW40 },
  "r-old.txt": { [BASE]: OLD },
  "r-new.txt": { [SHA]: WSONLY },
  "pic.png": { [BASE]: "old picture", [SHA]: "new picture" },
};
const bytes = (text: string) => ({
  base64: Buffer.from(text).toString("base64"),
  mime: null,
  tooLarge: false,
  size: text.length,
});
const decode = (b64: unknown) =>
  typeof b64 === "string" ? Buffer.from(b64, "base64").toString() : "";
/** The real `-w` output for each fixture pair, by its new side. */
const wHunks = (args: Record<string, unknown>) => {
  const next = decode(args.newBase64);
  if (next === NEW && decode(args.oldBase64) === OLD)
    return { hunks: EDIT_W_HUNKS, isBinary: false };
  if (next === NEW_XI && decode(args.oldBase64) === OLD)
    return { hunks: EDIT_W_HUNKS_XI, isBinary: false };
  if (next === DUP_NEW && decode(args.oldBase64) === DUP_OLD)
    return { hunks: DUP_W_HUNKS, isBinary: false };
  if (next === WSONLY && decode(args.oldBase64) === OLD)
    return { hunks: "", isBinary: false };
  throw new Error("no -w fixture for this pair");
};

let lists: Record<number, string[]> = {};
/** Each pull request's head, as its details and the forge's diff serve it. */
let heads: Record<number, string> = {};
/** Holds every forge diff read while set. */
let diffGate: Promise<void> | undefined;
/** Holds every whole-file read while set. */
let sideGate: Promise<void> | undefined;
/** The `-w` command's answer; a test may hold or refuse it. */
let wCommand: (args: Record<string, unknown>) => unknown = wHunks;
/** The revs read's answer; a test may hold it. */
let revsAnswer: (args: Record<string, unknown>) => unknown = () => undefined;

function pr(number: number): PrDetails {
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
      additions: 1,
      deletions: 1,
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
    headSha: heads[number] ?? SHA,
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
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const thread = (path: string, line: number, body: string): ReviewThreadOut => ({
  id: `T_${line}`,
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
      id: `N_${line}`,
      url: "",
      viewerDidAuthor: false,
      isMinimized: false,
      minimizedReason: "",
      reviewId: "",
    },
  ],
});

const clients: QueryClient[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  stubCanvas();
  lists = {};
  heads = {};
  diffGate = undefined;
  sideGate = undefined;
  composer.real = false;
  composer.fromLine = undefined;
  seeded.drafts = undefined;
  wCommand = wHunks;
  revsAnswer = (args) => ({ oldSha: BASE, newSha: args.headSha });
  store.settings = { ...DEFAULT_SETTINGS, diffHideWhitespace: true };
  wire.answer = (cmd, args) => {
    if (cmd === "forge_pr_content_revs") return revsAnswer(args);
    if (cmd === "forge_file_at_sha") {
      if (args.sha === SHA4) return Promise.reject(new Error("read failed"));
      const text = FILES[String(args.filePath)]?.[String(args.sha)];
      const answer = text === undefined ? null : bytes(text);
      return sideGate === undefined ? answer : sideGate.then(() => answer);
    }
    if (cmd === "git_diff_bytes_ignoring_whitespace") return wCommand(args);
    return undefined;
  };
  vi.mocked(forgeStatus).mockResolvedValue(GITLAB);
  vi.mocked(forgePrView).mockImplementation(async (_repo, number) =>
    pr(number),
  );
  // The forge serves the head current when it is asked.
  vi.mocked(forgePrDiff).mockImplementation(async (_repo, number) => {
    const head = heads[number] ?? SHA;
    const text = (lists[number] ?? [])
      .map((p) => SECTIONS_AT[head]?.[p] ?? SECTIONS[p] ?? "")
      .join("");
    if (diffGate !== undefined) await diffGate;
    return text;
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
  onlineManager.setOnline(true);
  for (const client of clients.splice(0)) client.clear();
});

/** Shows another pull request in the mounted view, as a selection does. */
let showPr: (number: number) => void = () => undefined;

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const view = (number: number) => (
    <QueryClientProvider client={client}>
      <RemotePrView repoPath={REPO} number={number} />
    </QueryClientProvider>
  );
  const { rerender } = render(view(7));
  showPr = (number) =>
    act(() => {
      useUiStore.setState({
        selectedPr: { kind: "remote", id: String(number) },
      });
      rerender(view(number));
    });
  return client;
}

const openFilesTab = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(await screen.findByRole("button", { name: /^Files \(\d+\)$/ }));
const rail = () => screen.getByRole("complementary", { name: "Changed files" });
const pick = (user: ReturnType<typeof userEvent.setup>, path: string) =>
  user.click(
    rail().querySelector<HTMLElement>(`[data-path="${path}"]`) as HTMLElement,
  );
/** A drawn new-side line number outside any held (inert) slot. */
const newLine = (n: number) =>
  Array.from(document.querySelectorAll(`span[data-line-new-num="${n}"]`)).find(
    (el) => el.closest("[inert]") === null,
  ) ?? null;
const calls = (cmd: string, path?: string) =>
  vi
    .mocked(invoke)
    .mock.calls.filter(
      ([c, args]) =>
        c === cmd &&
        (path === undefined ||
          (args as Record<string, unknown> | undefined)?.filePath === path),
    ).length;
const note = (reason: string) =>
  screen.queryByText(`Whitespace changes are shown in this file: ${reason}.`);
const anyNote = () => screen.queryByText(/^Whitespace changes are shown/);
const expands = () =>
  document.querySelectorAll<HTMLElement>('[title^="Expand"]');
const saved = () =>
  vi.mocked(saveSettingsPatch).mock.calls.map(([p]) => p.diffHideWhitespace);
const gear = (name: string) => screen.getByRole("button", { name });
/** Every drawing of `text`, and how many sit in a whitespace-marked anchor. */
const drawn = (text: string) => {
  const all = screen.queryAllByText(text);
  return {
    count: all.length,
    inline: all.filter((el) => el.closest('[data-diff-anchor="whitespace"]'))
      .length,
  };
};
/** Opens the line composer on a drawn new-side line. */
const openComposerAt = (n: number) => {
  const num = newLine(n)?.closest(".diff-line-num") as HTMLElement;
  fireEvent.mouseOver(num);
  fireEvent.mouseDown(
    num.closest("tr")?.querySelector(".diff-add-widget") as HTMLElement,
  );
};
/** Runs the palette action once the pane answers it (its slot interactive). */
const press = () =>
  waitFor(() => {
    let ran = false;
    act(() => {
      ran = dispatchAction("toggle-hide-whitespace");
    });
    expect(ran).toBe(true);
  });
const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => undefined);
};
const setSetting = (client: QueryClient, hide: boolean) =>
  act(() => {
    client.setQueryData(settingsKeys.settings, {
      ...(client.getQueryData(settingsKeys.settings) as AppSettings),
      diffHideWhitespace: hide,
    });
  });
/** Drawn diff rows outside any held (inert) slot whose text holds `text`. */
const rowsWith = (text: string) =>
  Array.from(document.querySelectorAll("tr")).filter(
    (tr) => tr.closest("[inert]") === null && tr.textContent?.includes(text),
  ).length;
/** Whole-file reads at one sha. */
const readsAt = (sha: string) =>
  vi
    .mocked(invoke)
    .mock.calls.filter(
      ([c, args]) =>
        c === "forge_file_at_sha" &&
        (args as Record<string, unknown> | undefined)?.sha === sha,
    ).length;
/** The diff pane's blank busy body (its pending arm), outside held slots. */
const pendingArm = () =>
  Array.from(
    document.querySelectorAll<HTMLElement>(
      'div[tabindex="-1"][aria-busy="true"]',
    ),
  ).some((el) => el.closest("[inert]") === null && el.childElementCount === 0);
/** Runs `check` on every DOM change until the returned stop is called. */
const watchFrames = (check: () => void) => {
  const observer = new MutationObserver(check);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });
  return () => observer.disconnect();
};
/** What the unheld pane draws: f.txt's view and which line 11 it holds. */
const frame = () => {
  const text = rowsWith("line XI") > 0 ? "XI" : null;
  const old = rowsWith("line ELEVEN") > 0 ? "ELEVEN" : null;
  const which = text ?? old;
  if (which === null) return "none";
  return `${newLine(2) !== null ? "forge" : "-w"} ${which}`;
};
/** Every distinct frame the pane draws from now on, in order; "none" only
 *  under `withNone`, so a view that leaves and returns records twice. */
const record = (withNone = false) => {
  const seen: string[] = [];
  const stop = watchFrames(() => {
    const f = frame();
    if ((withNone || f !== "none") && seen.at(-1) !== f) seen.push(f);
  });
  onTestFinished(stop);
  return seen;
};
/** The details now name `head`; the view re-reads them. */
const moveHead = async (client: QueryClient, head: string) => {
  heads[7] = head;
  // Not awaited: a held diff read would hold the refetch's promise.
  await act(async () => {
    void client.invalidateQueries({
      queryKey: ["repo", REPO, "pr", "origin", 7],
    });
  });
};
const GITHUB = {
  ...GITLAB,
  provider: "github",
  host: "github.com",
} as unknown as ForgeStatus;
/** The real composer's two submit buttons, held with `reason`. */
const expectComposerHeld = (reason: string) => {
  for (const name of ["Add single comment", "Start a review"]) {
    const button = screen.getByRole("button", { name });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button).toHaveAccessibleDescription(reason);
  }
};

describe("Pull request Files tab under Hide whitespace", () => {
  it("AC-W1, AC-N2: a first open never paints the forge text, then draws the -w view for two side reads and one command", async () => {
    lists[7] = ["f.txt", "bin.dat"];
    const gate = deferred<void>();
    wCommand = (args) => gate.promise.then(() => wHunks(args));
    // Every frame is watched for the forge diff's first changed line.
    let forgePainted = false;
    const watcher = new MutationObserver(() => {
      if (newLine(2) !== null) forgePainted = true;
    });
    watcher.observe(document.body, { childList: true, subtree: true });
    try {
      const user = userEvent.setup();
      mount();
      await openFilesTab(user);
      await waitFor(
        () => expect(calls("git_diff_bytes_ignoring_whitespace")).toBe(1),
        { timeout: 10_000 },
      );
      // Past the hold bound (400 ms), so a slot that settled on the forge
      // text would have been promoted onto the screen.
      await act(() => new Promise((r) => setTimeout(r, 600)));
      expect(newLine(14)).toBeNull();
      // The promoted slot waits on its blank busy body (the pending arm the
      // flip tests watch for).
      expect(pendingArm()).toBe(true);
      gate.resolve();
      await waitFor(() => expect(newLine(14)).not.toBeNull(), {
        timeout: 10_000,
      });
      // Content mode builds over the -w text: its gap rows offer to expand.
      await waitFor(() => expect(expands().length).toBeGreaterThan(0), {
        timeout: 10_000,
      });
      expect(forgePainted).toBe(false);
      expect(anyNote()).toBeNull();
      // Revisiting reads nothing more.
      await pick(user, "bin.dat");
      await screen.findByText(/Binary file/);
      await pick(user, "f.txt");
      await waitFor(() => expect(newLine(14)).not.toBeNull());
      await settle();
      expect(calls("forge_file_at_sha", "f.txt")).toBe(2);
      expect(calls("git_diff_bytes_ignoring_whitespace")).toBe(1);
    } finally {
      watcher.disconnect();
    }
  }, 30_000);

  it("AC-W4: a whitespace-only file says so, and Show whitespace turns the setting off to draw the forge diff", async () => {
    lists[7] = ["w.txt"];
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    expect(
      await screen.findByText(WHITESPACE_ONLY_MESSAGE, undefined, {
        timeout: 10_000,
      }),
    ).toBeTruthy();
    expect(newLine(2)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show whitespace" }));
    expect(saved()).toEqual([false]);
    await waitFor(() => expect(newLine(2)).not.toBeNull(), {
      timeout: 10_000,
    });
    expect(screen.queryByText(WHITESPACE_ONLY_MESSAGE)).toBeNull();
  }, 30_000);

  it("AC-W4: a rename whose only edits are whitespace keeps its From / To detail", async () => {
    lists[7] = ["r-new.txt"];
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await screen.findByText(WHITESPACE_ONLY_MESSAGE, undefined, {
      timeout: 10_000,
    });
    expect(screen.getByText("From")).toBeTruthy();
    expect(screen.getByText("To")).toBeTruthy();
    expect(screen.getAllByText("r-old.txt").length).toBeGreaterThan(0);
  }, 30_000);

  it("AC-W5: binary and header-only sections run no side read and no command", async () => {
    lists[7] = ["bin.dat", "moved.txt"];
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await screen.findByText(/Binary file/, undefined, { timeout: 10_000 });
    await pick(user, "moved.txt");
    await screen.findByText("From", undefined, { timeout: 10_000 });
    await settle();
    expect(calls("forge_file_at_sha", "bin.dat")).toBe(0);
    expect(calls("forge_file_at_sha", "moved.txt")).toBe(0);
    expect(calls("git_diff_bytes_ignoring_whitespace")).toBe(0);
    expect(anyNote()).toBeNull();
    expect(screen.queryByText(WHITESPACE_ONLY_MESSAGE)).toBeNull();
  }, 30_000);

  it("AC-F1: a revs read parked offline on the first open paints the forge diff under the offline note, then the -w view", async () => {
    lists[7] = ["f.txt"];
    const user = userEvent.setup();
    const client = mount();
    await screen.findByRole("button", { name: /^Files \(\d+\)$/ });
    // The diff is already read; only the revs read parks.
    await client.prefetchQuery(prDiffOptions(REPO, 7, "origin", SHA));
    act(() => onlineManager.setOnline(false));
    await openFilesTab(user);
    // The forge diff's first changed line is on screen.
    await waitFor(() => expect(newLine(2)).not.toBeNull(), {
      timeout: 10_000,
    });
    expect(note("you're offline")).not.toBeNull();
    expect(calls("forge_pr_content_revs")).toBe(0);
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(newLine(14)).not.toBeNull(), {
      timeout: 10_000,
    });
    await waitFor(() => expect(newLine(2)).toBeNull());
    expect(anyNote()).toBeNull();
  }, 30_000);

  it("AC-F1: a side read parked offline paints the forge diff under the offline note, then the -w view", async () => {
    lists[7] = ["f.txt"];
    const revs = deferred<void>();
    revsAnswer = (args) =>
      revs.promise.then(() => ({ oldSha: BASE, newSha: args.headSha }));
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await waitFor(() => expect(calls("forge_pr_content_revs")).toBe(1), {
      timeout: 10_000,
    });
    act(() => onlineManager.setOnline(false));
    await act(async () => revs.resolve());
    await waitFor(() => expect(newLine(2)).not.toBeNull(), {
      timeout: 10_000,
    });
    expect(note("you're offline")).not.toBeNull();
    expect(calls("forge_file_at_sha", "f.txt")).toBe(0);
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(newLine(14)).not.toBeNull(), {
      timeout: 10_000,
    });
    await waitFor(() => expect(newLine(2)).toBeNull());
    expect(anyNote()).toBeNull();
  }, 30_000);

  it("AC-F2: a mismatch note belongs to its file; the next file draws its own view and the setting holds", async () => {
    lists[7] = ["g.txt", "f.txt"];
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    expect(
      await screen.findByText(
        "Whitespace changes are shown in this file: its two versions don't match this diff.",
        undefined,
        { timeout: 10_000 },
      ),
    ).toBeTruthy();
    expect(newLine(2)).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Show whitespace" }),
    ).toBeNull();
    expect(gear("Diff options, whitespace changes hidden")).toBeTruthy();
    await pick(user, "f.txt");
    await waitFor(() => expect(newLine(14)).not.toBeNull(), {
      timeout: 10_000,
    });
    expect(newLine(2)).toBeNull();
    expect(anyNote()).toBeNull();
    expect(gear("Diff options, whitespace changes hidden")).toBeTruthy();
    expect(saveSettingsPatch).not.toHaveBeenCalled();
  }, 30_000);

  it("AC-F4: a refused -w command keeps the forge diff exact: its gaps expand and an off-patch thread draws once, inline", async () => {
    lists[7] = ["gap.txt"];
    wCommand = () => Promise.reject(new Error("git diff -w failed"));
    vi.mocked(forgePrReviewThreads).mockResolvedValue({
      threads: [thread("gap.txt", 16, "On a gap line")],
      threadsTruncated: false,
    });
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await waitFor(() => expect(expands().length).toBeGreaterThan(0), {
      timeout: 10_000,
    });
    expect(note("its two versions couldn't be compared")).not.toBeNull();
    expect(drawn("On a gap line").count).toBe(0);
    for (let i = 0; i < 20 && expands().length > 0; i++)
      await user.click(expands()[0]);
    await waitFor(() =>
      expect(drawn("On a gap line")).toEqual({ count: 1, inline: 1 }),
    );
  }, 30_000);

  it("AC-C1: a thread and a draft on a re-indented line stay off the -w view and draw once, inline, when their gap opens", async () => {
    lists[7] = ["f.txt"];
    vi.mocked(forgePrReviewThreads).mockResolvedValue({
      threads: [thread("f.txt", 4, "On a re-indented line")],
      threadsTruncated: false,
    });
    seeded.drafts = [
      {
        id: "d1",
        path: "f.txt",
        line: 5,
        side: "new",
        body: "Draft on a re-indented line",
        createdAt: "2026-01-01T00:00:00Z",
      } satisfies ReviewDraft,
    ];
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await waitFor(() => expect(expands().length).toBeGreaterThan(0), {
      timeout: 10_000,
    });
    expect(newLine(14)).not.toBeNull();
    expect(drawn("On a re-indented line").count).toBe(0);
    expect(drawn("Draft on a re-indented line").count).toBe(0);
    expect(anyNote()).toBeNull();
    for (let i = 0; i < 20 && expands().length > 0; i++)
      await user.click(expands()[0]);
    await waitFor(() =>
      expect(drawn("On a re-indented line")).toEqual({ count: 1, inline: 1 }),
    );
    expect(drawn("Draft on a re-indented line")).toEqual({
      count: 1,
      inline: 1,
    });
  }, 30_000);
});

describe("Pull request Files tab: flipping Hide whitespace", () => {
  it("AC-P2, AC-P4, AC-U1: the sheet's checkbox flips the one setting both ways and keeps the sheet and focus, with no announcement", async () => {
    store.settings = { ...DEFAULT_SETTINGS, diffHideWhitespace: false };
    lists[7] = ["f.txt"];
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await waitFor(() => expect(newLine(2)).not.toBeNull(), {
      timeout: 10_000,
    });
    expect(calls("git_diff_bytes_ignoring_whitespace")).toBe(0);
    await settle();
    // Every frame is watched for the blank busy body and for any line a
    // status region gains.
    const statusText = () =>
      screen
        .queryAllByRole("status")
        .map((r) => r.textContent ?? "")
        .join("|");
    const quiet = statusText();
    let blank = false;
    const announced: string[] = [];
    const stop = watchFrames(() => {
      if (pendingArm()) blank = true;
      const now = statusText();
      if (now !== quiet && !announced.includes(now)) announced.push(now);
    });
    onTestFinished(stop);
    await user.click(gear("Diff options"));
    const box = await screen.findByRole("checkbox", {
      name: "Hide whitespace changes",
    });
    await user.click(box);
    expect(saved()).toEqual([true]);
    await waitFor(() => expect(newLine(14)).not.toBeNull(), {
      timeout: 10_000,
    });
    await waitFor(() => expect(newLine(2)).toBeNull());
    expect(announced).toEqual([]);
    const after = screen.getByRole("checkbox", {
      name: "Hide whitespace changes",
    });
    expect(document.activeElement).toBe(after);
    expect(after.getAttribute("aria-checked")).toBe("true");
    await user.click(after);
    expect(saved()).toEqual([true, false]);
    await waitFor(() => expect(newLine(2)).not.toBeNull());
    expect(document.activeElement).toBe(
      screen.getByRole("checkbox", { name: "Hide whitespace changes" }),
    );
    expect(announced).toEqual([]);
    expect(screen.queryByText(/Hunk and line actions are off/)).toBeNull();
    // The pane never fell back to its blank busy body for either flip.
    expect(blank).toBe(false);
  }, 30_000);

  it("AC-P2, AC-P3: the palette action answers in the text, whitespace-only and binary arms; a write elsewhere re-keys the open diff", async () => {
    lists[7] = ["f.txt", "w.txt", "bin.dat"];
    const user = userEvent.setup();
    const client = mount();
    await openFilesTab(user);
    await waitFor(() => expect(newLine(14)).not.toBeNull(), {
      timeout: 10_000,
    });
    await press();
    expect(saved()).toEqual([false]);
    await waitFor(() => expect(newLine(2)).not.toBeNull());
    // The setting written from another diff host reaches this one.
    await setSetting(client, true);
    await waitFor(() => expect(newLine(2)).toBeNull());
    await pick(user, "w.txt");
    await screen.findByText(WHITESPACE_ONLY_MESSAGE, undefined, {
      timeout: 10_000,
    });
    await press();
    expect(saved()).toEqual([false, false]);
    await waitFor(() => expect(newLine(2)).not.toBeNull());
    await pick(user, "bin.dat");
    await screen.findByText(/Binary file/);
    await press();
    expect(saved()).toEqual([false, false, true]);
  }, 30_000);

  it("AC-H3: an open line composer holds the checkbox, the palette action and Show whitespace until it closes", async () => {
    lists[7] = ["f.txt", "w.txt"];
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await waitFor(() => expect(newLine(14)).not.toBeNull(), {
      timeout: 10_000,
    });
    openComposerAt(14);
    await screen.findByRole("textbox", { name: "Review comment" });
    await user.click(gear("Diff options, whitespace changes hidden"));
    const box = await screen.findByRole("checkbox", {
      name: "Hide whitespace changes",
    });
    expect(box.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(WHITESPACE_COMPOSER_HELD)).toBeTruthy();
    await user.click(box);
    await press();
    expect(toast.info).toHaveBeenCalledWith(WHITESPACE_COMPOSER_HELD);
    expect(saveSettingsPatch).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Close composer" }));
    await user.click(gear("Diff options, whitespace changes hidden"));
    expect(
      (
        await screen.findByRole("checkbox", { name: "Hide whitespace changes" })
      ).getAttribute("aria-disabled"),
    ).toBeNull();
    await user.keyboard("{Escape}");
    // The whitespace-only arm's button refuses while a composer is open in
    // another diff, and acts once it closes.
    await pick(user, "w.txt");
    const show = await screen.findByRole(
      "button",
      { name: "Show whitespace" },
      { timeout: 10_000 },
    );
    const other = document.createElement("div");
    other.setAttribute("data-diff-line-widget", "whitespace");
    document.body.append(other);
    onTestFinished(() => other.remove());
    await user.click(show);
    expect(saveSettingsPatch).not.toHaveBeenCalled();
    other.remove();
    await user.click(screen.getByRole("button", { name: "Show whitespace" }));
    expect(saved()).toEqual([false]);
  }, 30_000);

  it("AC-L1: a -w answer landing after the setting flipped back off changes nothing", async () => {
    lists[7] = ["f.txt"];
    const gate = deferred<void>();
    wCommand = (args) => gate.promise.then(() => wHunks(args));
    store.settings = { ...DEFAULT_SETTINGS, diffHideWhitespace: false };
    const user = userEvent.setup();
    const client = mount();
    await openFilesTab(user);
    await waitFor(() => expect(newLine(2)).not.toBeNull(), {
      timeout: 10_000,
    });
    await setSetting(client, true);
    await waitFor(() =>
      expect(calls("git_diff_bytes_ignoring_whitespace")).toBe(1),
    );
    await setSetting(client, false);
    const seen = record();
    await act(async () => gate.resolve());
    await settle();
    expect(newLine(2)).not.toBeNull();
    expect(anyNote()).toBeNull();
    // Not even for a frame: the late answer never drew its filtered view.
    expect(seen.filter((f) => f.startsWith("-w"))).toEqual([]);
  }, 30_000);

  it("AC-U2: an editor opened after a flip that bypassed the probe keeps its text; the -w view lands once it closes", async () => {
    lists[7] = ["f.txt"];
    const gate = deferred<void>();
    wCommand = (args) => gate.promise.then(() => wHunks(args));
    store.settings = { ...DEFAULT_SETTINGS, diffHideWhitespace: false };
    const user = userEvent.setup();
    const client = mount();
    await openFilesTab(user);
    await waitFor(() => expect(newLine(2)).not.toBeNull(), {
      timeout: 10_000,
    });
    // Written straight into the settings cache: no probe ran.
    await setSetting(client, true);
    await waitFor(() =>
      expect(calls("git_diff_bytes_ignoring_whitespace")).toBe(1),
    );
    openComposerAt(14);
    await user.type(
      await screen.findByRole("textbox", { name: "Review comment" }),
      "keep me",
    );
    await act(async () => gate.resolve());
    await settle();
    expect(newLine(2)).not.toBeNull();
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: "Review comment",
      }).value,
    ).toBe("keep me");
    await user.click(screen.getByRole("button", { name: "Close composer" }));
    await waitFor(() => expect(newLine(2)).toBeNull());
    expect(newLine(14)).not.toBeNull();
  }, 30_000);

  it("AC-U2: an editor open in another diff does not hold the replacement", async () => {
    lists[7] = ["f.txt"];
    store.settings = { ...DEFAULT_SETTINGS, diffHideWhitespace: false };
    const user = userEvent.setup();
    const client = mount();
    await openFilesTab(user);
    await waitFor(() => expect(newLine(2)).not.toBeNull(), {
      timeout: 10_000,
    });
    const other = document.createElement("div");
    other.setAttribute("data-diff-line-widget", "whitespace");
    other.append(document.createElement("textarea"));
    document.body.append(other);
    onTestFinished(() => other.remove());
    await setSetting(client, true);
    await waitFor(() => expect(newLine(2)).toBeNull(), { timeout: 10_000 });
    expect(newLine(14)).not.toBeNull();
  }, 30_000);

  it("AC-U2 (D33): new revs under an unchanged forge text that settle to a fallback wait for the open editor", async () => {
    lists[7] = ["f.txt"];
    const user = userEvent.setup();
    const client = mount();
    await openFilesTab(user);
    await waitFor(() => expect(newLine(14)).not.toBeNull(), {
      timeout: 10_000,
    });
    await settle();
    openComposerAt(14);
    await user.type(
      await screen.findByRole("textbox", { name: "Review comment" }),
      "keep me",
    );
    // A head move that left f.txt alone; its new side can't be read.
    await moveHead(client, SHA4);
    await waitFor(() => expect(readsAt(SHA4)).toBeGreaterThan(0), {
      timeout: 10_000,
    });
    // The read fails for good (its retries spent) with the editor still open,
    // so the fallback is settled behind the hold.
    await waitFor(
      () =>
        expect(
          client
            .getQueryCache()
            .findAll({ queryKey: ["forge-file-at-sha"] })
            .some(
              (q) => q.queryKey.includes(SHA4) && q.state.status === "error",
            ),
        ).toBe(true),
      { timeout: 15_000 },
    );
    await settle();
    expect(newLine(2)).toBeNull();
    expect(newLine(14)).not.toBeNull();
    expect(anyNote()).toBeNull();
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: "Review comment",
      }).value,
    ).toBe("keep me");
    await user.click(screen.getByRole("button", { name: "Close composer" }));
    await waitFor(() => expect(newLine(2)).not.toBeNull(), {
      timeout: 10_000,
    });
    expect(note("its two versions couldn't be compared")).not.toBeNull();
  }, 30_000);

  it("AC-U1: the sheet keeps focus on its checkbox through a settle onto the whitespace-only arm and onto a fallback", async () => {
    store.settings = { ...DEFAULT_SETTINGS, diffHideWhitespace: false };
    lists[7] = ["w.txt", "g.txt"];
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await waitFor(() => expect(newLine(2)).not.toBeNull(), {
      timeout: 10_000,
    });
    await settle();
    let blank = false;
    const stop = watchFrames(() => {
      if (pendingArm()) blank = true;
    });
    onTestFinished(stop);
    const box = () =>
      screen.getByRole("checkbox", { name: "Hide whitespace changes" });
    await user.click(gear("Diff options"));
    await user.click(
      await screen.findByRole("checkbox", { name: "Hide whitespace changes" }),
    );
    await screen.findByText(WHITESPACE_ONLY_MESSAGE, undefined, {
      timeout: 10_000,
    });
    expect(document.activeElement).toBe(box());
    await user.click(box());
    await waitFor(() => expect(newLine(2)).not.toBeNull());
    expect(document.activeElement).toBe(box());
    await user.keyboard("{Escape}");
    await pick(user, "g.txt");
    await waitFor(() => expect(newLine(2)).not.toBeNull(), {
      timeout: 10_000,
    });
    await settle();
    await user.click(gear("Diff options"));
    await user.click(
      await screen.findByRole("checkbox", { name: "Hide whitespace changes" }),
    );
    await waitFor(() =>
      expect(note("its two versions don't match this diff")).not.toBeNull(),
    );
    expect(document.activeElement).toBe(box());
    await user.click(box());
    await waitFor(() => expect(anyNote()).toBeNull());
    expect(document.activeElement).toBe(box());
    expect(saved()).toEqual([true, false, true, false]);
    expect(blank).toBe(false);
  }, 30_000);

  it("AC-U3: the toolbar and the whitespace-only arm hand held focus across their swap, never to <body>", async () => {
    store.settings = { ...DEFAULT_SETTINGS, diffHideWhitespace: false };
    lists[7] = ["w.txt"];
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await waitFor(() => expect(newLine(2)).not.toBeNull(), {
      timeout: 10_000,
    });
    await settle();
    // The language picker: a toolbar control the whitespace-only arm drops.
    const picker = document.querySelector<HTMLElement>(
      'span[class*="@md/diff-pane:flex"] button',
    );
    expect(picker).not.toBeNull();
    act(() => picker?.focus());
    expect(document.activeElement).toBe(picker);
    await press();
    expect(saved()).toEqual([true]);
    await screen.findByText(WHITESPACE_ONLY_MESSAGE, undefined, {
      timeout: 10_000,
    });
    expect(picker?.isConnected).toBe(false);
    expect(document.activeElement).not.toBe(document.body);
    const show = screen.getByRole("button", { name: "Show whitespace" });
    expect(
      document.activeElement?.contains(show) || document.activeElement === show,
    ).toBe(true);
    await user.click(show);
    expect(saved()).toEqual([true, false]);
    await waitFor(() => expect(newLine(2)).not.toBeNull(), {
      timeout: 10_000,
    });
    expect(show.isConnected).toBe(false);
    expect(document.activeElement).not.toBe(document.body);
  }, 30_000);

  it("AC-P3: neither the held slot nor the preparing one answers the palette action", async () => {
    lists[7] = ["f.txt", "w.txt"];
    const gate = deferred<void>();
    wCommand = (args) =>
      decode(args.newBase64) === WSONLY
        ? gate.promise.then(() => wHunks(args))
        : wHunks(args);
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await waitFor(() => expect(newLine(14)).not.toBeNull(), {
      timeout: 10_000,
    });
    await settle();
    await pick(user, "w.txt");
    // Inside the hold: f.txt is held, w.txt prepares behind it.
    let ran = true;
    act(() => {
      ran = dispatchAction("toggle-hide-whitespace");
    });
    expect(ran).toBe(false);
    expect(saveSettingsPatch).not.toHaveBeenCalled();
    await act(async () => gate.resolve());
    await screen.findByText(WHITESPACE_ONLY_MESSAGE, undefined, {
      timeout: 10_000,
    });
    await press();
    expect(saved()).toEqual([false]);
  }, 30_000);
});

describe("Pull request Files tab: reads that land late or for another record", () => {
  it("AC-L2: a slot re-targeted to another pull request's same-named file starts pending, never drawing the first one's view", async () => {
    lists[7] = ["f.txt"];
    lists[8] = ["f.txt"];
    heads[8] = SHA8;
    const gate = deferred<void>();
    wCommand = (args) =>
      decode(args.newBase64) === NEW_XI
        ? gate.promise.then(() => wHunks(args))
        : wHunks(args);
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await waitFor(() => expect(frame()).toBe("-w ELEVEN"), {
      timeout: 10_000,
    });
    await settle();
    const seen = record(true);
    showPr(8);
    await openFilesTab(user);
    await waitFor(() => expect(readsAt(SHA8)).toBeGreaterThan(0), {
      timeout: 10_000,
    });
    await settle();
    // PR 8's file waits for its own -w view: no forge text, no PR 7 view.
    expect(frame()).toBe("none");
    await act(async () => gate.resolve());
    await waitFor(() => expect(frame()).toBe("-w XI"), { timeout: 10_000 });
    const drawn = seen.filter((f) => f !== "none");
    expect(drawn.filter((f) => f !== "-w ELEVEN")).toEqual(["-w XI"]);
    expect(drawn.slice(drawn.indexOf("-w XI"))).toEqual(["-w XI"]);
    // Once PR 7's view left the pane, it never came back.
    expect(seen).toContain("none");
    expect(seen.slice(seen.indexOf("none"))).not.toContain("-w ELEVEN");
  }, 30_000);

  it("AC-L2, AC-W5: a head move that changed the file paints the new forge text, then its -w view; the placeholder paint reads nothing", async () => {
    lists[7] = ["f.txt"];
    const user = userEvent.setup();
    const client = mount();
    await openFilesTab(user);
    await waitFor(() => expect(frame()).toBe("-w ELEVEN"), {
      timeout: 10_000,
    });
    await settle();
    const commands = calls("git_diff_bytes_ignoring_whitespace");
    const diff = deferred<void>();
    diffGate = diff.promise;
    const w = deferred<void>();
    wCommand = (args) =>
      decode(args.newBase64) === NEW_XI
        ? w.promise.then(() => wHunks(args))
        : wHunks(args);
    const seen = record();
    await moveHead(client, SHA2);
    await waitFor(
      () =>
        expect(
          vi
            .mocked(invoke)
            .mock.calls.some(
              ([c, a]) =>
                c === "forge_pr_content_revs" &&
                (a as Record<string, unknown>).headSha === SHA2,
            ),
        ).toBe(true),
      { timeout: 10_000 },
    );
    await settle();
    // The old head's diff paints as a placeholder: no read, no command.
    expect(readsAt(SHA2)).toBe(0);
    expect(calls("git_diff_bytes_ignoring_whitespace")).toBe(commands);
    expect(frame()).toBe("-w ELEVEN");
    diffGate = undefined;
    await act(async () => diff.resolve());
    await waitFor(() => expect(frame()).toBe("forge XI"), {
      timeout: 10_000,
    });
    await act(async () => w.resolve());
    await waitFor(() => expect(frame()).toBe("-w XI"), { timeout: 10_000 });
    expect(seen).toEqual(["-w ELEVEN", "forge XI", "-w XI"]);
  }, 30_000);

  it("AC-L2: a head move that left the file alone keeps the -w view on screen throughout", async () => {
    lists[7] = ["f.txt"];
    const user = userEvent.setup();
    const client = mount();
    await openFilesTab(user);
    await waitFor(() => expect(frame()).toBe("-w ELEVEN"), {
      timeout: 10_000,
    });
    await settle();
    const seen = record();
    let blank = false;
    const stop = watchFrames(() => {
      if (frame() === "none" || pendingArm()) blank = true;
    });
    onTestFinished(stop);
    const commands = calls("git_diff_bytes_ignoring_whitespace");
    await moveHead(client, SHA3);
    await waitFor(
      () =>
        expect(calls("git_diff_bytes_ignoring_whitespace")).toBe(commands + 1),
      { timeout: 10_000 },
    );
    await settle();
    expect(readsAt(SHA3)).toBeGreaterThan(0);
    expect(seen).toEqual(["-w ELEVEN"]);
    expect(blank).toBe(false);
  }, 30_000);

  it("AC-L3: a flip while the forge text's content upgrade is pending lands the -w view with its own guard verdict", async () => {
    store.settings = { ...DEFAULT_SETTINGS, diffHideWhitespace: false };
    lists[7] = ["f.txt"];
    const sides = deferred<void>();
    sideGate = sides.promise;
    const user = userEvent.setup();
    const client = mount();
    await openFilesTab(user);
    await waitFor(() => expect(newLine(2)).not.toBeNull(), {
      timeout: 10_000,
    });
    await waitFor(() => expect(readsAt(SHA)).toBeGreaterThan(0));
    expect(expands().length).toBe(0);
    await setSetting(client, true);
    await settle();
    sideGate = undefined;
    await act(async () => sides.resolve());
    await waitFor(() => expect(newLine(2)).toBeNull(), { timeout: 10_000 });
    // Built over the -w text: its gap rows offer to expand, and no row the
    // forge text drew in its single hunk is left on screen.
    await waitFor(() => expect(expands().length).toBeGreaterThan(0), {
      timeout: 10_000,
    });
    expect(newLine(14)).not.toBeNull();
    expect(newLine(5)).toBeNull();
    expect(newLine(3)).toBeNull();
  }, 30_000);
});

describe("Pull request Files tab: what the setting leaves alone", () => {
  it("AC-W5: a typechange's joined section, an empty file and a file with no section run no side read and no command", async () => {
    lists[7] = ["t.dat", "empty.txt", "e.txt"];
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await waitFor(
      () => expect(document.body.textContent).toContain("target.dat"),
      { timeout: 10_000 },
    );
    // Each pick reaches its own display arm, alone in the pane, before the
    // reads are counted.
    const shown = () => document.querySelector("main")?.textContent;
    await pick(user, "empty.txt");
    await waitFor(() => expect(shown()).toBe("empty.txtNew empty file"), {
      timeout: 10_000,
    });
    await pick(user, "e.txt");
    await waitFor(() => expect(shown()).toBe("e.txtNo changes to show"), {
      timeout: 10_000,
    });
    await settle();
    expect(calls("forge_file_at_sha")).toBe(0);
    expect(calls("git_diff_bytes_ignoring_whitespace")).toBe(0);
    expect(anyNote()).toBeNull();
    expect(screen.queryByText(WHITESPACE_ONLY_MESSAGE)).toBeNull();
  }, 30_000);

  it("AC-W5, AC-P3: an image file draws its comparison with no side read and no command, and the palette action answers there", async () => {
    lists[7] = ["pic.png"];
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await screen.findAllByRole(
      "button",
      { name: /^View .* image fullscreen$/ },
      { timeout: 10_000 },
    );
    await settle();
    // The image panes read whole files under the image cap (no byte budget);
    // a side read would carry one.
    const sideReads = () =>
      vi
        .mocked(invoke)
        .mock.calls.filter(
          ([c, args]) =>
            c === "forge_file_at_sha" &&
            (args as Record<string, unknown>).maxBytes !== null,
        ).length;
    expect(readsAt(SHA)).toBeGreaterThan(0);
    expect(sideReads()).toBe(0);
    expect(calls("git_diff_bytes_ignoring_whitespace")).toBe(0);
    expect(anyNote()).toBeNull();
    await press();
    expect(saved()).toEqual([false]);
    await settle();
    await press();
    expect(saved()).toEqual([false, true]);
    await settle();
    expect(
      screen.getAllByRole("button", { name: /^View .* image fullscreen$/ })
        .length,
    ).toBeGreaterThan(0);
    expect(sideReads()).toBe(0);
    expect(calls("git_diff_bytes_ignoring_whitespace")).toBe(0);
    expect(anyNote()).toBeNull();
  }, 30_000);

  it("AC-F4: a mismatch fallback lays content out under the exact guard, as with the setting off", async () => {
    lists[7] = ["gapws.txt"];
    const user = userEvent.setup();
    const client = mount();
    await openFilesTab(user);
    await waitFor(
      () =>
        expect(note("its two versions don't match this diff")).not.toBeNull(),
      { timeout: 10_000 },
    );
    await waitFor(() => expect(readsAt(SHA)).toBeGreaterThan(0));
    await settle();
    expect(newLine(2)).not.toBeNull();
    expect(expands().length).toBe(0);
    await setSetting(client, false);
    await waitFor(() => expect(anyNote()).toBeNull());
    await settle();
    expect(newLine(2)).not.toBeNull();
    expect(expands().length).toBe(0);
  }, 30_000);
});

describe("Pull request Files tab: the real review composer over a -w view", () => {
  it("AC-C4: a line only the -w text draws holds the composer with the off-patch line reason", async () => {
    composer.real = true;
    lists[7] = ["dup.txt"];
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await waitFor(() => expect(newLine(24)).not.toBeNull(), {
      timeout: 10_000,
    });
    expect(anyNote()).toBeNull();
    openComposerAt(24);
    await screen.findByRole("button", { name: "Add single comment" });
    expectComposerHeld(OFF_PATCH_REVIEW_REASON.line);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    // A forge patch line on the same view takes only the empty-body reason.
    openComposerAt(23);
    await screen.findByRole("button", { name: "Add single comment" });
    expectComposerHeld("Write a comment first");
  }, 30_000);

  it("AC-C4: a GitHub range across -w rows is judged line by line against the forge patch", async () => {
    vi.mocked(forgeStatus).mockResolvedValue(GITHUB);
    composer.real = true;
    lists[7] = ["dup.txt"];
    const user = userEvent.setup();
    mount();
    await openFilesTab(user);
    await waitFor(() => expect(newLine(24)).not.toBeNull(), {
      timeout: 10_000,
    });
    composer.fromLine = 22;
    openComposerAt(24);
    expect(await screen.findByText(/^Lines 22–24/)).toBeTruthy();
    expectComposerHeld(OFF_PATCH_REVIEW_REASON.range);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    composer.fromLine = 20;
    openComposerAt(23);
    expect(await screen.findByText(/^Lines 20–23/)).toBeTruthy();
    expectComposerHeld("Write a comment first");
  }, 30_000);
});
