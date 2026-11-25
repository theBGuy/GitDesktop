import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
  QueryObserver,
  useQuery,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPEN_PR_REFRESH_HELD } from "@/features/diff/whitespace-mode";
import { PullRequestsPanel } from "@/features/pulls/PullRequestsPanel";
import {
  forgePrContentRevs,
  forgePrDiff,
  forgePrListPage,
  forgePrView,
  forgeStatus,
  gitBranches,
  gitFetch,
  gitRemotes,
} from "@/lib/git/api";
import {
  branchesOptions,
  forgeFileAtShaOptions,
  prBaseDivergencePrefix,
  prContentRevsOptions,
  prDetailsOptions,
  prDiffOptions,
  refreshOpenPr,
  useFetchRemote,
  usePrContentRevs,
  usePrDetails,
  usePrDiff,
} from "@/lib/git/queries";
import {
  type ForgeImplemented,
  type ForgeStatus,
  type PrDetails,
  prDiffTarget,
} from "@/lib/git/types";
import { dispatchAction } from "@/lib/hotkeys/hotkeys";
import { listLocalPrs, reloadLocalPrs } from "@/lib/pulls/local";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";

/** The diff target the details fixtures name (base "main", no base sha). */
const diffTarget = <H extends string | null>(head: H) => ({
  head,
  baseRef: "main",
  baseSha: null as string | null,
});

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgePrView: vi.fn(),
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
  forgePrContentRevs: vi.fn(),
  forgeStatus: vi.fn(),
  forgePrListPage: vi.fn(),
  gitRemotes: vi.fn(),
  gitFetch: vi.fn(),
  gitBranches: vi.fn(),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/pulls/local", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pulls/local")>()),
  listLocalPrs: vi.fn(),
  reloadLocalPrs: vi.fn(),
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

const REPO = "C:/repo";
const H0 = "9".repeat(40);
const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const D = prDetailsOptions(REPO, 7, "origin").queryKey;

let head = H1;
let detailsFail = false;
/** What the forge was asked, in order ("details" when its answer settles). */
let log: string[] = [];

const textOf = (h: string) => `diff --git a/f b/f\n@@ -1 +1 @@\n-a\n+${h}\n`;
const details = (number: number, headSha: string): PrDetails =>
  ({
    number,
    state: "OPEN",
    headSha,
    baseRefName: "main",
    commits: [],
  }) as unknown as PrDetails;

const sleep = (ms: number) =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const clients: QueryClient[] = [];
function newClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

/** An open view's details observer, so a press re-reads them (over fresh
 *  seeded data, subscribing reads nothing). */
const observeDetails = (client: QueryClient) =>
  new QueryObserver(client, {
    ...prDetailsOptions(REPO, 7, "origin"),
    staleTime: Number.POSITIVE_INFINITY,
  }).subscribe(() => undefined);

beforeEach(() => {
  vi.clearAllMocks();
  head = H1;
  detailsFail = false;
  log = [];
  vi.mocked(forgePrView).mockImplementation(async (_repo, number) => {
    log.push("details");
    if (detailsFail) throw new Error("details failed");
    return details(number, head);
  });
  vi.mocked(forgePrDiff).mockImplementation(async () => {
    log.push("diff");
    return textOf(head);
  });
  vi.mocked(forgePrContentRevs).mockImplementation(
    async (_repo, _number, _lens, headSha) => {
      log.push("revs");
      return { oldSha: H0, newSha: headSha } as never;
    },
  );
});

afterEach(() => {
  cleanup();
  onlineManager.setOnline(true);
  for (const client of clients.splice(0)) client.clear();
  useUiStore.setState({ selectedPr: null, pendingPrAlign: false });
});

describe("refreshOpenPr's key set (AC-RF1)", () => {
  const child = (...rest: unknown[]) => [...D, ...rest];
  const YES = [
    child("review-threads"),
    child("timeline"),
    child("mergeability"),
    child("reactions"),
    child("approvals"),
    child("gl-merge-state"),
    child("tasks"),
    child("time-stats"),
    child("reviewer-candidates"),
    child("merge-message-defaults", "squash"),
    child("future-child"),
    [...prBaseDivergencePrefix(REPO, 7), "origin"],
  ];
  const NO = [
    child("commit-diff", "abc"),
    child("review-drafts"),
    child("resolve-worktree"),
    forgeFileAtShaOptions(REPO, "origin", H1, "f", 300_000).queryKey,
    ["pr-whitespace-hunks", REPO, "local", H0, "f", H1, "f"],
    prDetailsOptions(REPO, 8, "origin").queryKey,
    prDiffOptions(REPO, 8, "origin", diffTarget(H1)).queryKey,
    prDetailsOptions(REPO, 7, "upstream").queryKey,
    prDiffOptions(REPO, 7, "upstream", diffTarget(H1)).queryKey,
    // The other lens's divergence read at the same number.
    [...prBaseDivergencePrefix(REPO, 7), "upstream"],
    ["repo", REPO, "prs", "origin", "open"],
    ["repo", REPO, "local-prs"],
  ];
  const invalidated = (client: QueryClient, key: readonly unknown[]) =>
    client.getQueryState(key)?.isInvalidated;

  it("re-reads every forge child, the details and the divergence sibling; skips the rest", async () => {
    const { client } = newClient();
    client.setQueryData(D, details(7, H1));
    observeDetails(client);
    for (const key of [...YES, ...NO]) client.setQueryData(key, "seeded");
    const ownDiff = prDiffOptions(REPO, 7, "origin", diffTarget(H1)).queryKey;
    const ownRevs = prContentRevsOptions(
      REPO,
      7,
      "origin",
      diffTarget(H1),
    ).queryKey;
    const otherHead = [
      prDiffOptions(REPO, 7, "origin", diffTarget(H0)).queryKey,
      prContentRevsOptions(REPO, 7, "origin", diffTarget(H0)).queryKey,
      child("diff", "(unanswered)"),
    ];
    for (const key of [ownDiff, ownRevs, ...otherHead])
      client.setQueryData(key, "seeded");
    await refreshOpenPr(client, REPO, "origin", 7);
    expect(forgePrView).toHaveBeenCalledTimes(1);
    for (const key of [...YES, ownDiff, ownRevs])
      expect([key, invalidated(client, key)]).toEqual([key, true]);
    for (const key of [...NO, ...otherHead])
      expect([key, invalidated(client, key)]).toEqual([key, false]);
  });

  it("with details naming no head, re-reads the null diff and no revs", async () => {
    const { client } = newClient();
    head = "";
    client.setQueryData(D, details(7, ""));
    observeDetails(client);
    const nullDiff = prDiffOptions(
      REPO,
      7,
      "origin",
      diffTarget(null),
    ).queryKey;
    const revs = prContentRevsOptions(
      REPO,
      7,
      "origin",
      diffTarget(H1),
    ).queryKey;
    client.setQueryData(nullDiff, { text: "seeded", headProven: true });
    client.setQueryData(revs, { oldSha: H0, newSha: H1 });
    await refreshOpenPr(client, REPO, "origin", 7);
    expect(client.getQueryState(nullDiff)?.isInvalidated).toBe(true);
    expect(client.getQueryState(revs)?.isInvalidated).toBe(false);
  });
});

/** The Files tab's three reads, fed the head as RemotePrView feeds them. */
function useOpenPr() {
  const read = usePrDetails(REPO, 7, "origin");
  const named =
    read.data !== undefined && !read.isPlaceholderData
      ? prDiffTarget(read.data)
      : undefined;
  const diff = usePrDiff(REPO, 7, "origin", named);
  const revs = usePrContentRevs(REPO, 7, "origin", named ?? null, true);
  return { read, diff, revs };
}

async function mountOpen() {
  const { client, wrapper } = newClient();
  const view = renderHook(() => useOpenPr(), { wrapper });
  await waitFor(() => {
    expect(view.result.current.diff.data).toBe(textOf(H1));
    expect(view.result.current.revs.data).toBeDefined();
  });
  vi.mocked(forgePrDiff).mockClear();
  vi.mocked(forgePrContentRevs).mockClear();
  log = [];
  return { client, wrapper, view };
}

const diffCalls = () => vi.mocked(forgePrDiff).mock.calls.length;
const revsHeads = () =>
  vi.mocked(forgePrContentRevs).mock.calls.map((c) => c[3]);

describe("refreshOpenPr's order and count (AC-RF2)", () => {
  it("head moved: one diff read, after the observer moved; the old head's entry is not refetched", async () => {
    const { client, wrapper, view } = await mountOpen();
    // A second observer keeps the old head's entry (the sweep spares it).
    const old = renderHook(
      () => useQuery(prDiffOptions(REPO, 7, "origin", diffTarget(H1))),
      { wrapper },
    );
    await waitFor(() => expect(old.result.current.data?.text).toBe(textOf(H1)));
    head = H2;
    await act(() => refreshOpenPr(client, REPO, "origin", 7));
    await waitFor(() => expect(view.result.current.diff.data).toBe(textOf(H2)));
    await sleep(30);
    expect(forgePrDiff).toHaveBeenCalledTimes(1);
    expect(log.indexOf("details")).toBeLessThan(log.indexOf("diff"));
    expect(
      client.getQueryData(
        prDiffOptions(REPO, 7, "origin", diffTarget(H1)).queryKey,
      )?.text,
    ).toBe(textOf(H1));
    expect(revsHeads()).toEqual([H2]);
  });

  it("head unchanged: one diff read and one revs read", async () => {
    const { client, view } = await mountOpen();
    await act(() => refreshOpenPr(client, REPO, "origin", 7));
    await waitFor(() => expect(diffCalls()).toBe(1));
    await sleep(30);
    expect(diffCalls()).toBe(1);
    expect(revsHeads()).toEqual([H1]);
    expect(log.indexOf("details")).toBeLessThan(log.indexOf("diff"));
    expect(view.result.current.diff.data).toBe(textOf(H1));
  });

  it("a failed details read leaves the head-keyed reads alone, though the forge moved", async () => {
    const { client, view } = await mountOpen();
    const diffKeyH1 = prDiffOptions(REPO, 7, "origin", diffTarget(H1)).queryKey;
    const revsKeyH1 = prContentRevsOptions(
      REPO,
      7,
      "origin",
      diffTarget(H1),
    ).queryKey;
    head = H2;
    detailsFail = true;
    await act(() => refreshOpenPr(client, REPO, "origin", 7));
    await sleep(30);
    expect(client.getQueryState(D)?.status).toBe("error");
    expect(forgePrDiff).not.toHaveBeenCalled();
    expect(forgePrContentRevs).not.toHaveBeenCalled();
    expect(client.getQueryState(diffKeyH1)?.isInvalidated).toBe(false);
    expect(client.getQueryState(revsKeyH1)?.isInvalidated).toBe(false);
    // H2's text never lands under H1 as H1's own answer.
    expect(client.getQueryData(diffKeyH1)?.text).toBe(textOf(H1));
    expect(view.result.current.diff.placeholderOf).toBe("none");
  });

  it("details that answer after a failed press name the head, and one read follows it", async () => {
    const { client, view } = await mountOpen();
    head = H2;
    detailsFail = true;
    await act(() => refreshOpenPr(client, REPO, "origin", 7));
    detailsFail = false;
    await act(() => refreshOpenPr(client, REPO, "origin", 7));
    await waitFor(() => expect(view.result.current.diff.data).toBe(textOf(H2)));
    await sleep(30);
    expect(forgePrDiff).toHaveBeenCalledTimes(1);
    expect(revsHeads()).toEqual([H2]);
  });

  it("details with no data at all: no diff read", async () => {
    detailsFail = true;
    const { client, wrapper } = newClient();
    const view = renderHook(() => useOpenPr(), { wrapper });
    await waitFor(() => expect(view.result.current.read.isError).toBe(true));
    await act(() => refreshOpenPr(client, REPO, "origin", 7));
    await sleep(30);
    expect(forgePrDiff).not.toHaveBeenCalled();
  });

  it("offline: the press issues no diff or revs read; back online one read follows the new head", async () => {
    const { client, view } = await mountOpen();
    const diffKeyH1 = prDiffOptions(REPO, 7, "origin", diffTarget(H1)).queryKey;
    onlineManager.setOnline(false);
    head = H2;
    await act(() => refreshOpenPr(client, REPO, "origin", 7));
    expect(client.getQueryState(D)?.fetchStatus).toBe("paused");
    await sleep(30);
    expect(client.getQueryState(diffKeyH1)?.isInvalidated).toBe(false);
    expect(forgePrDiff).not.toHaveBeenCalled();
    expect(forgePrContentRevs).not.toHaveBeenCalled();
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(view.result.current.diff.data).toBe(textOf(H2)));
    await sleep(30);
    expect(forgePrDiff).toHaveBeenCalledTimes(1);
  });
});

describe("refreshOpenPr never cancels (AC-RF5)", () => {
  it("a cold ensureQueryData load in flight across a press resolves with its text", async () => {
    const { client } = newClient();
    client.setQueryData(D, details(7, H1));
    observeDetails(client);
    let release: (text: string) => void = () => undefined;
    vi.mocked(forgePrDiff).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const load = client.ensureQueryData(
      prDiffOptions(REPO, 7, "origin", diffTarget(H1)),
    );
    await waitFor(() => expect(forgePrDiff).toHaveBeenCalledTimes(1));
    await refreshOpenPr(client, REPO, "origin", 7);
    release("cold text");
    await expect(load).resolves.toEqual({
      text: "cold text",
      headProven: true,
    });
  });
});

const READY_GITHUB: ForgeStatus = {
  provider: "github",
  installed: true,
  authenticated: true,
  repo: "owner/repo",
  host: "github.com",
  login: "me",
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
  // Only the list read is built, so the list and details calls are the ones to watch.
  implemented: { pullRequests: true } as ForgeImplemented,
};
const READY_GITLAB: ForgeStatus = {
  ...READY_GITHUB,
  provider: "gitlab",
  host: "gitlab.com",
};

const listRow = (number: number) =>
  ({
    number,
    url: `https://github.com/owner/repo/pull/${number}`,
    title: `Row ${number}`,
    baseRefName: "main",
    headRefName: `feat-${number}`,
    isDraft: false,
    state: "OPEN",
    author: null,
    labels: [],
    createdAt: "",
    headSha: "",
    stack: null,
    stackUnknown: false,
    crossRepository: false,
  }) as never;

/** The open pull request's details read, as RemotePrView keeps it observed. */
function DetailsWatcher({ number }: { number: number }) {
  useQuery(prDetailsOptions(REPO, number, "origin"));
  return null;
}

/** A thread Reply box open inside a diff row, marked as ReviewThreads marks it. */
const REPLY_IN_DIFF = (
  <div data-diff-anchor="whitespace">
    <div data-diff-editor="">
      <textarea aria-label="Reply" defaultValue="my reply" />
    </div>
  </div>
);

const viewCalls = (number: number) =>
  vi.mocked(forgePrView).mock.calls.filter((c) => c[1] === number);
const infoToast = () => vi.mocked(toast.info);

async function mountPanel(opts: {
  selected: { kind: "local" | "remote"; id: string } | null;
  forge?: ForgeStatus;
  extra?: ReactNode;
}) {
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(forgeStatus).mockResolvedValue(opts.forge ?? READY_GITHUB);
  vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
  vi.mocked(forgePrListPage).mockResolvedValue({ rows: [], capped: false });
  vi.mocked(listLocalPrs).mockResolvedValue([]);
  vi.mocked(reloadLocalPrs).mockResolvedValue();
  vi.mocked(gitBranches).mockResolvedValue([] as never);
  useUiStore.setState({
    repoPath: REPO,
    repoTab: "pulls",
    selectedPr: opts.selected,
    pendingPrAlign: false,
  });
  const { client } = newClient();
  const ui = (extra: ReactNode) => (
    <QueryClientProvider client={client}>
      <PullRequestsPanel repoPath={REPO} />
      <DetailsWatcher number={7} />
      <DetailsWatcher number={8} />
      {extra}
    </QueryClientProvider>
  );
  const view = render(ui(opts.extra));
  const refresh = await screen.findByRole("button", {
    name: /^Refresh (pull|merge) requests$/,
  });
  await waitFor(() => {
    expect(forgePrListPage).toHaveBeenCalled();
    expect(client.getQueryData(D)).toBeDefined();
    expect(
      client.getQueryData(prDetailsOptions(REPO, 8, "origin").queryKey),
    ).toBeDefined();
  });
  await sleep(30);
  vi.mocked(forgePrListPage).mockClear();
  vi.mocked(forgePrView).mockClear();
  vi.mocked(reloadLocalPrs).mockClear();
  infoToast().mockClear();
  return {
    client,
    refresh,
    close: () => view.rerender(ui(null)),
  };
}

/** The list half of a press: the remote list and the local records re-read. */
async function listRefreshed() {
  await waitFor(() => {
    expect(forgePrListPage).toHaveBeenCalled();
    expect(reloadLocalPrs).toHaveBeenCalledTimes(1);
  });
}

describe("the list's Refresh with no remote pull request open (AC-RF3)", () => {
  it.each([
    ["nothing selected", null],
    ["a local pull request selected", { kind: "local" as const, id: "7" }],
  ])(
    "%s: refreshes the list and reads no pull request",
    async (_, selected) => {
      const { refresh } = await mountPanel({ selected, extra: REPLY_IN_DIFF });
      fireEvent.click(refresh);
      await listRefreshed();
      await sleep(30);
      expect(forgePrView).not.toHaveBeenCalled();
      expect(infoToast()).not.toHaveBeenCalled();
    },
  );
});

describe("the list's Refresh re-reads the open pull request", () => {
  it("re-reads the selected one under the panel's lens", async () => {
    const { refresh } = await mountPanel({
      selected: { kind: "remote", id: "7" },
    });
    fireEvent.click(refresh);
    await listRefreshed();
    await waitFor(() => expect(viewCalls(7)).toHaveLength(1));
    await sleep(30);
    expect(viewCalls(7)).toEqual([[REPO, 7, "origin"]]);
    expect(viewCalls(8)).toHaveLength(0);
    expect(infoToast()).not.toHaveBeenCalled();
  });
});

describe("an editor open inside a diff holds the open pull request (AC-RF4)", () => {
  it("refreshes the list, reads no pull request, toasts once; the next press after it closes re-reads", async () => {
    const { refresh, close } = await mountPanel({
      selected: { kind: "remote", id: "7" },
      extra: REPLY_IN_DIFF,
    });
    fireEvent.click(refresh);
    await listRefreshed();
    await sleep(30);
    expect(forgePrView).not.toHaveBeenCalled();
    expect(infoToast()).toHaveBeenCalledTimes(1);
    const text = infoToast().mock.calls[0]?.[0];
    expect(text).toBe(OPEN_PR_REFRESH_HELD("pull request"));
    expect(text).toContain("the comment you're writing in a diff");
    expect(text).not.toContain("line comment");
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue(
      "my reply",
    );
    close();
    infoToast().mockClear();
    fireEvent.click(refresh);
    await waitFor(() => expect(viewCalls(7)).toHaveLength(1));
    await sleep(30);
    expect(infoToast()).not.toHaveBeenCalled();
  });

  it("names a merge request on GitLab", async () => {
    const { refresh } = await mountPanel({
      selected: { kind: "remote", id: "7" },
      forge: READY_GITLAB,
      extra: REPLY_IN_DIFF,
    });
    fireEvent.click(refresh);
    await waitFor(() => expect(infoToast()).toHaveBeenCalledTimes(1));
    expect(infoToast().mock.calls[0]?.[0]).toBe(
      OPEN_PR_REFRESH_HELD("merge request"),
    );
    expect(forgePrView).not.toHaveBeenCalled();
  });

  it("an editor outside any diff does not hold it and keeps its text", async () => {
    const { refresh } = await mountPanel({
      selected: { kind: "remote", id: "7" },
      extra: <textarea aria-label="Comment" defaultValue="draft" />,
    });
    fireEvent.click(refresh);
    await waitFor(() => expect(viewCalls(7)).toHaveLength(1));
    await sleep(30);
    expect(infoToast()).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue(
      "draft",
    );
  });

  it("an editor in a layout diff anywhere in the document holds it too (accepted over-hold)", async () => {
    const { refresh } = await mountPanel({
      selected: { kind: "remote", id: "7" },
      extra: (
        <div data-diff-line-widget="layout">
          <textarea aria-label="Line comment" defaultValue="elsewhere" />
        </div>
      ),
    });
    fireEvent.click(refresh);
    await listRefreshed();
    await sleep(30);
    expect(forgePrView).not.toHaveBeenCalled();
    expect(infoToast()).toHaveBeenCalledTimes(1);
  });
});

describe("every route into the list's Refresh re-reads the open pull request (AC-RF6)", () => {
  const selected = { kind: "remote" as const, id: "7" };

  it("the refresh-pr-list action", async () => {
    await mountPanel({ selected });
    act(() => {
      dispatchAction("refresh-pr-list");
    });
    await listRefreshed();
    await waitFor(() => expect(viewCalls(7)).toHaveLength(1));
  });

  it("the Retry of a list that failed to load", async () => {
    const { refresh } = await mountPanel({ selected });
    vi.mocked(forgePrListPage).mockRejectedValue(new Error("boom"));
    fireEvent.click(refresh);
    // One automatic retry, a second apart, runs before the error shows.
    const retry = await screen.findByRole(
      "button",
      { name: "Retry" },
      { timeout: 5_000 },
    );
    await waitFor(() => expect(viewCalls(7)).toHaveLength(1));
    await sleep(30);
    vi.mocked(forgePrView).mockClear();
    fireEvent.click(retry);
    await waitFor(() => expect(viewCalls(7)).toHaveLength(1));
  });

  it("the Retry of a refresh that failed over loaded rows", async () => {
    const { refresh } = await mountPanel({ selected });
    vi.mocked(forgePrListPage).mockResolvedValue({
      rows: [listRow(7)],
      capped: false,
    });
    fireEvent.click(refresh);
    await screen.findByText("Row 7");
    vi.mocked(forgePrListPage).mockRejectedValue(new Error("boom"));
    fireEvent.click(refresh);
    const retry = await screen.findByRole(
      "button",
      {
        name: "Retry loading pull requests",
      },
      { timeout: 5_000 },
    );
    await sleep(30);
    vi.mocked(forgePrView).mockClear();
    fireEvent.click(retry);
    await waitFor(() => expect(viewCalls(7)).toHaveLength(1));
  });

  it("refreshOpenPr is called from refreshPrList alone, which has the four routes", () => {
    const calls: { path: string; at: number }[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (path !== join("src", "test")) walk(path);
        } else if (/\.tsx?$/.test(name)) {
          const source = readFileSync(path, "utf8");
          for (const m of source.matchAll(/(?<!function )refreshOpenPr\(/g))
            calls.push({ path, at: m.index });
        }
      }
    };
    walk("src");
    const panelPath = join("src", "features", "pulls", "PullRequestsPanel.tsx");
    expect(calls.map((c) => c.path)).toEqual([panelPath]);
    const panel = readFileSync(panelPath, "utf8");
    const start = panel.indexOf("function refreshPrList()");
    const end = panel.indexOf('useHotkeyAction("focus-filter"');
    expect(start).toBeGreaterThan(-1);
    expect(calls[0].at > start && calls[0].at < end).toBe(true);
    const routes = panel.match(
      /=> refreshPrList\(\)|onClick=\{refreshPrList\}|remoteRetry=\{refreshPrList\}/g,
    );
    expect(routes).toHaveLength(4);
  });
});

describe("Fetch stays local-only (AC-RF7)", () => {
  it("a fetch settle re-reads local queries and leaves the open pull request alone", async () => {
    vi.mocked(gitFetch).mockResolvedValue();
    vi.mocked(gitBranches).mockResolvedValue([] as never);
    const { client, wrapper } = newClient();
    const view = renderHook(
      () => ({
        details: useQuery(prDetailsOptions(REPO, 7, "origin")),
        branches: useQuery(branchesOptions(REPO)),
        fetch: useFetchRemote(REPO),
      }),
      { wrapper },
    );
    await waitFor(() => {
      expect(view.result.current.details.data).toBeDefined();
      expect(view.result.current.branches.data).toBeDefined();
    });
    vi.mocked(forgePrView).mockClear();
    vi.mocked(gitBranches).mockClear();
    await act(() => view.result.current.fetch.mutateAsync());
    // The settle ran: a local read was re-read.
    await waitFor(() => expect(gitBranches).toHaveBeenCalledTimes(1));
    await sleep(30);
    expect(forgePrView).not.toHaveBeenCalled();
    expect(client.getQueryState(D)?.isInvalidated).toBe(false);
  });
});

describe("the open pull request is read at the press (AC-RF8)", () => {
  it("a selection moved just before the press is the one re-read", async () => {
    const { refresh } = await mountPanel({
      selected: { kind: "remote", id: "7" },
    });
    useUiStore.setState({ selectedPr: { kind: "remote", id: "8" } });
    fireEvent.click(refresh);
    await waitFor(() => expect(viewCalls(8)).toHaveLength(1));
    await sleep(30);
    expect(viewCalls(8)).toEqual([[REPO, 8, "origin"]]);
    expect(viewCalls(7)).toHaveLength(0);
  });

  it.each(["abc", "0", "-7", "7.5", ""])(
    "an id of %j re-reads nothing",
    async (id) => {
      const { refresh } = await mountPanel({
        selected: { kind: "remote", id },
      });
      fireEvent.click(refresh);
      await listRefreshed();
      await sleep(30);
      expect(forgePrView).not.toHaveBeenCalled();
    },
  );
});
