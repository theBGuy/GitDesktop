import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DIFF_PANE_ROOT_CLASS } from "@/features/diff/DiffPathRow";
import { RemotePrView } from "@/features/pulls/RemotePrView";
import {
  forgeGlMrMergeState,
  forgePrApprovals,
  forgePrDiff,
  forgePrReviewThreads,
  forgePrView,
  forgeStatus,
  gitFindRemotePrResolve,
} from "@/lib/git/api";
import { prDetailsOptions } from "@/lib/git/queries";
import type { ForgeStatus, PrDetails } from "@/lib/git/types";
import { loadSettings, saveSettingsMerged } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";
import { stubCanvas } from "./canvas-stub";

// The Files tab after a push that added a file, over the real diff pane: the
// rail lists the new head's files while the diff on screen is still the older
// head's. Harness shape after pr-review-composer-head-move.test.tsx.
vi.mock("@/lib/tauri/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri/invoke")>()),
  invoke: vi.fn(async (cmd: string) => {
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
vi.mock("@/features/pulls/ResolveRemotePrView", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/pulls/ResolveRemotePrView")
  >()),
  ResolveRemotePrView: () => null,
}));

Element.prototype.scrollIntoView = vi.fn();

const REPO = "C:/repo";
const H1 = "0123456789abcdef0123456789abcdef01234567";
const H2 = "89abcdef01".repeat(4);
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
const EMPTY = "No changes to show";
const FAILED = "Could not load diff for this file";

/** The files the pull request carries, the head its details name, and the
 *  diff reads still to answer in order (then the files' patch). */
let files: string[] = [];
let head = H1;
let diffs: (() => Promise<string>)[] = [];

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

const clients: QueryClient[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  stubCanvas();
  files = ["src/a.ts"];
  head = H1;
  diffs = [];
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(saveSettingsMerged).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(forgeStatus).mockResolvedValue(GITLAB);
  vi.mocked(forgePrView).mockImplementation(async () => pr());
  vi.mocked(forgePrDiff).mockImplementation(async () => {
    const next = diffs.shift();
    return next ? next() : patch(files);
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

/** The details re-read naming H2 with `next` files, the next diff read held. */
async function push(client: QueryClient, next: string[]) {
  const reads = vi.mocked(forgePrDiff).mock.calls.length;
  head = H2;
  files = next;
  await act(() =>
    client.refetchQueries({
      queryKey: prDetailsOptions(REPO, 7, "origin").queryKey,
      exact: true,
    }),
  );
  await waitFor(() =>
    expect(vi.mocked(forgePrDiff).mock.calls.length).toBe(reads + 1),
  );
}

const row = (path: string) =>
  waitFor(() => {
    const el = document.querySelector(`button[data-path="${path}"]`);
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
/** The diff library splits a row into token spans, so read the pane text. */
const painted = (line: string) =>
  waitFor(() => expect(document.body.textContent).toContain(line), {
    timeout: 10_000,
  });
/** The diff pane of the slot on screen (held and preparing slots are inert),
 *  once it names `path`. */
const shownPane = (path: string) =>
  waitFor(
    () => {
      const panes = [...document.querySelectorAll<HTMLElement>("div")].filter(
        (el) => el.className === DIFF_PANE_ROOT_CLASS && !el.closest("[inert]"),
      );
      expect(panes).toHaveLength(1);
      expect(panes[0]?.textContent).toContain(path);
      return panes[0] as HTMLElement;
    },
    { timeout: 10_000 },
  );

describe("a file only the new head carries, before its diff lands", () => {
  it("waits on the read instead of claiming the file has no changes, then shows it", async () => {
    const user = userEvent.setup();
    const client = mount();
    await user.click(
      await screen.findByRole("button", { name: /^Files \(\d+\)$/ }),
    );
    await painted("new src/a.ts");
    const held = deferred<string>();
    diffs.push(() => held.promise);
    await push(client, ["src/a.ts", "src/b.ts"]);
    await user.click(await row("src/b.ts"));
    // The shown slot is the new file's, its body the blank busy landing of a
    // read in flight, and nothing of the old file's rows is left on screen.
    const pane = await shownPane("src/b.ts");
    const body = pane.lastElementChild;
    expect(body).toHaveAttribute("aria-busy", "true");
    expect(body?.childElementCount).toBe(0);
    expect(document.body.textContent).not.toContain("new src/a.ts");
    expect(screen.queryByText(EMPTY)).toBeNull();
    expect(screen.queryByText(FAILED)).toBeNull();
    await act(async () => held.resolve(patch(["src/a.ts", "src/b.ts"])));
    await painted("new src/b.ts");
    expect(screen.queryByText(EMPTY)).toBeNull();
  }, 30_000);

  it("says it will load once back online while that read is parked", async () => {
    const user = userEvent.setup();
    const client = mount();
    await user.click(
      await screen.findByRole("button", { name: /^Files \(\d+\)$/ }),
    );
    await painted("new src/a.ts");
    act(() => onlineManager.setOnline(false));
    head = H2;
    files = ["src/a.ts", "src/b.ts"];
    act(() =>
      client.setQueryData(prDetailsOptions(REPO, 7, "origin").queryKey, pr()),
    );
    await user.click(await row("src/b.ts"));
    await screen.findByText(
      "You're offline — this diff will load once you're back online.",
      undefined,
      { timeout: 10_000 },
    );
    expect(screen.queryByText(EMPTY)).toBeNull();
    act(() => onlineManager.setOnline(true));
    await painted("new src/b.ts");
  }, 30_000);

  it("says the diff couldn't load when that read fails, never that it is empty", async () => {
    const user = userEvent.setup();
    const client = mount();
    await user.click(
      await screen.findByRole("button", { name: /^Files \(\d+\)$/ }),
    );
    await painted("new src/a.ts");
    diffs.push(() => Promise.reject(new Error("boom")));
    await push(client, ["src/a.ts", "src/b.ts"]);
    await user.click(await row("src/b.ts"));
    await screen.findByText(FAILED, undefined, { timeout: 10_000 });
    expect(screen.queryByText(EMPTY)).toBeNull();
    // A file the retained patch carries still shows it, under the notice.
    await user.click(await row("src/a.ts"));
    await painted("new src/a.ts");
    await screen.findByText(
      "Couldn't refresh this diff — showing the last loaded version.",
    );
  }, 30_000);
});
