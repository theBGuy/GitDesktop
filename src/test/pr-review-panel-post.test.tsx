import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
  useQuery,
} from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { create } from "zustand";
import { PR_SWITCH_LOADING_REASON } from "@/features/pulls/PrMergeabilityBanner";
import { PrReviewPanel } from "@/features/pulls/PrReviewPanel";
import { useArchivedLatch } from "@/features/pulls/RemotePrView";
import type { ReviewMode } from "@/lib/ai/types";
import {
  PR_ARCHIVED_READONLY_MESSAGE,
  type PrDetails,
  prConversationHold,
  type RemoteLens,
} from "@/lib/git/types";
import {
  ACT_PENDING_REASON,
  COMMENT_POST_PENDING_REASON,
} from "@/lib/offline-writes";
import { stampReviewPosted } from "@/lib/pulls/review-posted-stamp";
import {
  markReviewPosted,
  type PersistedReview,
  reviewHistoryKey,
} from "@/lib/pulls/reviews-history";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useConfirm } from "@/lib/stores/confirm";
import {
  type ReviewContext,
  type ReviewPhase,
  reviewRunSeq,
  useReviewRun,
} from "@/lib/stores/reviews";
import { unmockedCommands } from "./setup";

type PrKind = "remote" | "local";

const run = vi.hoisted(() => ({
  recordId: "rec-1" as string | undefined,
  timedOut: false,
  generating: false,
  phase: undefined as ReviewPhase | undefined,
  mode: "general" as ReviewMode,
}));
const stored = vi.hoisted(() => ({
  done: [] as PersistedReview[],
  partials: [] as PersistedReview[],
  /** While set, list reads wait on it before answering. */
  gate: null as Promise<void> | null,
}));
const reset = vi.hoisted(() => vi.fn());
const generate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/stores/reviews", () => ({
  useReviewRun: vi.fn(),
  reviewRunSeq: vi.fn(),
}));
vi.mock("@/lib/settings/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/queries")>()),
  useSettings: () => ({ data: DEFAULT_SETTINGS }),
  useSecretPreview: () => ({ data: { length: 8, masked: "sk…0000" } }),
}));
vi.mock("@/lib/pulls/queries", async (importOriginal) => {
  const keys = await vi.importActual<
    typeof import("@/lib/pulls/reviews-history")
  >("@/lib/pulls/reviews-history");
  // Cache-backed on the real keys, so a stamp's patch and re-read reach the rows.
  const cached = (
    list: "done" | "partials",
    key: (
      repo: string,
      lens: RemoteLens,
      kind: PrKind,
      ref: string,
    ) => QueryKey,
  ) =>
    function useCachedList(
      repo: string,
      lens: RemoteLens,
      kind: PrKind,
      ref: string,
    ) {
      return useQuery({
        queryKey: key(repo, lens, kind, ref),
        queryFn: async () => {
          // A read answers with the store as it stood when the read started.
          const snapshot = stored[list];
          if (stored.gate) await stored.gate;
          return snapshot;
        },
        initialData: () => stored[list],
        networkMode: "always",
      });
    };
  return {
    ...(await importOriginal<typeof import("@/lib/pulls/queries")>()),
    useReviewHistory: cached("done", keys.reviewHistoryKey),
    useReviewPartials: cached("partials", keys.reviewPartialsKey),
    useExternalReviews: () => ({ data: undefined }),
    useReviewerNotes: () => ({ data: undefined }),
    useDeleteReview: () => ({ mutateAsync: vi.fn() }),
    useClearReviews: () => ({ mutateAsync: vi.fn() }),
    useUpdateReviewText: () => ({ mutateAsync: vi.fn() }),
  };
});
vi.mock("@/lib/git/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/queries")>()),
  useForgeStatus: () => ({ data: { provider: "github" } }),
  usePendingRepoWrites: () => [],
}));
vi.mock("@/lib/ai/models", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/models")>()),
  useAvailableModels: () => ({ data: { models: [] }, isFetching: false }),
}));
vi.mock("@/lib/ai/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/agent")>()),
  detectAgentCli: vi.fn(async () => ({ found: true, authed: "authed" })),
}));
vi.mock("@/lib/pulls/reviews-history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pulls/reviews-history")>()),
  getLatestPartialReview: vi.fn(async () => undefined),
  markReviewPosted: vi.fn(async () => undefined),
}));
vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sonner")>()),
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }),
}));

const REPO = "C:/repos/demo";
const TEXT = "Findings without references.";
const context = { repoPath: REPO, lens: "origin" } as ReviewContext;

/** The live slot: its text and its run (`seq`), removed by `reset()` like the
 *  real store's entry; a fresh run takes a new seq. */
const live = create<{ text: string; seq: number | undefined }>(() => ({
  text: TEXT,
  seq: 1,
}));

/** The store's markReviewPosted: stamps the stored record by id. */
function stampStored(id: string, postedAt: number) {
  for (const list of ["done", "partials"] as const)
    stored[list] = stored[list].map((r) =>
      r.id === id ? { ...r, postedAt } : r,
    );
}

type PostFn = (body: string, opts?: { asBot?: boolean }) => Promise<void>;
let onPost: Mock<PostFn>;

function rec(id: string, extra: Partial<PersistedReview> = {}) {
  return {
    schemaVersion: 1,
    id,
    kind: "remote",
    ref: "7",
    lens: "origin",
    mode: "general",
    model: "model-a",
    title: "A PR",
    text: TEXT,
    headSha: "abc",
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_060_000,
    ...extra,
  } satisfies PersistedReview;
}

beforeEach(() => {
  run.recordId = "rec-1";
  run.timedOut = false;
  run.generating = false;
  run.phase = undefined;
  run.mode = "general";
  stored.done = [];
  stored.partials = [];
  stored.gate = null;
  live.setState({ text: TEXT, seq: 1 });
  reset.mockImplementation(() => live.setState({ text: "", seq: undefined }));
  generate.mockImplementation(() =>
    live.setState({ text: "Second run.", seq: 2 }),
  );
  vi.mocked(reviewRunSeq).mockImplementation(() => live.getState().seq);
  useConfirm.setState({ request: null, requestHold: null });
  onPost = vi.fn<PostFn>(async () => undefined);
  vi.mocked(markReviewPosted).mockImplementation(async (_repo, id, at) =>
    stampStored(id, at),
  );
  vi.mocked(useReviewRun).mockImplementation(() => ({
    generate,
    cancel: vi.fn(),
    reset,
    dismissQueued: vi.fn(),
    queuedMode: undefined,
    generating: run.generating,
    text: live((s) => s.text),
    status: "",
    mode: run.mode,
    model: "model-a",
    deltaState: undefined,
    truncatedCoverage: undefined,
    phase: run.phase ?? (run.generating ? "running" : "done"),
    error: "",
    thoughts: "",
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_060_000,
    recordId: run.recordId,
    timedOut: run.timedOut,
  }));
});

afterAll(() => {
  expect(unmockedCommands).toEqual([]);
});

type PanelProps = {
  posting?: boolean;
  stale?: boolean;
  kind?: PrKind;
  prRef?: string;
};

function renderPanel(p: PanelProps = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = (q: PanelProps) => (
    <QueryClientProvider client={client}>
      <PrReviewPanel
        context={context}
        prKind={q.kind ?? "remote"}
        prRef={q.prRef ?? "7"}
        onPost={onPost}
        posting={q.posting}
        stale={q.stale}
      />
    </QueryClientProvider>
  );
  const view = render(tree(p));
  return Object.assign(userEvent.setup(), {
    client,
    rerenderWith: (q: PanelProps) => view.rerender(tree(q)),
    unmount: () => view.unmount(),
  });
}

// A posting button's Spinner is a labelled status, so its name gains "Loading".
const postButton = () =>
  screen.getByRole("button", {
    name: /^(Loading ?)?(Post as comment|Post again)$/,
  });

async function confirmRequest() {
  await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
  const request = useConfirm.getState().request;
  if (!request) throw new Error("no confirm");
  return request;
}

function expectHeld(el: HTMLElement, reason: string) {
  expect(el).toHaveAttribute("aria-disabled", "true");
  expect(el).toHaveAccessibleDescription(reason);
}

describe("live post stamp", () => {
  it("posts, resets and toasts, then stamps the run's record", async () => {
    const user = renderPanel();
    await user.click(postButton());
    await waitFor(() => expect(markReviewPosted).toHaveBeenCalled());
    expect(markReviewPosted).toHaveBeenCalledWith(
      REPO,
      "rec-1",
      expect.any(Number),
    );
    const order = [
      onPost.mock.invocationCallOrder[0],
      reset.mock.invocationCallOrder[0],
      vi.mocked(toast.success).mock.invocationCallOrder[0],
      vi.mocked(markReviewPosted).mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("clears the text and toasts before a slow stamp lands", async () => {
    let land = () => undefined as void;
    vi.mocked(markReviewPosted).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          land = resolve;
        }),
    );
    const user = renderPanel();
    await user.click(postButton());
    await waitFor(() => expect(markReviewPosted).toHaveBeenCalled());
    expect(reset).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledTimes(1);
    // The stamp is still pending, and there is no Post left to click twice.
    expect(screen.queryByRole("button", { name: /Post/ })).toBeNull();
    expect(onPost).toHaveBeenCalledTimes(1);
    await act(async () => land());
    expect(onPost).toHaveBeenCalledTimes(1);
  });

  it("stamps nothing and keeps the text when the post is refused", async () => {
    onPost.mockImplementation(async () => {
      throw new Error("refused");
    });
    const user = renderPanel();
    await user.click(postButton());
    await waitFor(() => expect(onPost).toHaveBeenCalled());
    expect(markReviewPosted).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(live.getState().text).toBe(TEXT);
    expect(screen.getByText(TEXT)).toBeInTheDocument();
    expect(postButton()).toBeInTheDocument();
  });

  it("posts without stamping when the run saved no record", async () => {
    run.recordId = undefined;
    const user = renderPanel();
    await user.click(postButton());
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(markReviewPosted).not.toHaveBeenCalled();
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("still resets and toasts when the stamp fails", async () => {
    vi.mocked(markReviewPosted).mockImplementation(async () => {
      throw new Error("store down");
    });
    const user = renderPanel();
    await user.click(postButton());
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(reset).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /Post/ })).toBeNull();
  });
});

describe("live post of an already-posted record", () => {
  it.each([
    ["completed list", "done"],
    ["partials list", "partials"],
  ] as const)("reads the %s's stamp and asks first", async (_label, list) => {
    stored[list] = [rec("rec-1", { postedAt: 1_700_000_500_000 })];
    const user = renderPanel();
    const button = postButton();
    expect(button).toHaveTextContent("Post again");
    await user.click(button);
    const request = await confirmRequest();
    expect(request.title).toBe("Post this review again?");
    expect(request.confirmLabel).toBe("Post again");
    act(() => useConfirm.getState().answer(false));
    await waitFor(() => expect(useConfirm.getState().request).toBeNull());
    expect(onPost).not.toHaveBeenCalled();
    expect(postButton()).toBe(button);
  });

  it("ignores another record's stamp and an unreadable one", async () => {
    stored.done = [
      rec("rec-other", { postedAt: 1_700_000_500_000 }),
      rec("rec-1", { postedAt: "soon" as unknown as number }),
    ];
    const user = renderPanel();
    expect(postButton()).toHaveTextContent("Post as comment");
    await user.click(postButton());
    await waitFor(() => expect(onPost).toHaveBeenCalledTimes(1));
    expect(useConfirm.getState().request).toBeNull();
  });
});

describe("held controls", () => {
  it("holds Review, Security audit and Post with the loading reason while stale", async () => {
    const user = renderPanel({ stale: true });
    const review = screen.getByRole("button", { name: "Review" });
    for (const el of [
      review,
      screen.getByRole("button", { name: "Security audit" }),
      postButton(),
    ])
      expectHeld(el, PR_SWITCH_LOADING_REASON);
    // Held, not removed: the keyboard still reaches it, and activation does nothing.
    review.focus();
    expect(document.activeElement).toBe(review);
    await user.keyboard("{Enter}");
    await user.click(postButton());
    expect(generate).not.toHaveBeenCalled();
    expect(onPost).not.toHaveBeenCalled();
  });

  it("holds Queue with the loading reason while stale", async () => {
    run.generating = true;
    const user = renderPanel({ stale: true });
    const queue = screen.getByRole("button", { name: /Queue security audit/ });
    expectHeld(queue, PR_SWITCH_LOADING_REASON);
    await user.click(queue);
    expect(generate).not.toHaveBeenCalled();
  });

  it("names the post in flight over the loading reason", () => {
    renderPanel({ posting: true, stale: true });
    expectHeld(postButton(), COMMENT_POST_PENDING_REASON);
  });
});

/** An onPost that settles only when the returned release runs. */
function deferPost() {
  const gate = { release: () => undefined as void };
  onPost.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        gate.release = resolve;
      }),
  );
  return gate;
}

describe("optimistic stamp and post holds", () => {
  it("reads a stamped history cache as posted before the store write lands", async () => {
    stored.done = [rec("rec-1")];
    vi.mocked(markReviewPosted).mockImplementation(
      () => new Promise<void>(() => undefined),
    );
    const user = renderPanel();
    expect(postButton()).toHaveTextContent("Post as comment");
    // The mount read has settled, so nothing in flight can land over the patch.
    await waitFor(() => expect(user.client.isFetching()).toBe(0));
    act(() =>
      stampReviewPosted(user.client, {
        repo: REPO,
        lens: "origin",
        kind: "remote",
        ref: "7",
        id: "rec-1",
      }),
    );
    await waitFor(() => expect(postButton()).toHaveTextContent("Post again"));
    await user.click(postButton());
    const request = await confirmRequest();
    expect(request.title).toBe("Post this review again?");
    expect(onPost).not.toHaveBeenCalled();
  });

  it("calls onPost zero times while held for a post in flight", async () => {
    const user = renderPanel({ posting: true });
    const button = postButton();
    await user.click(button);
    button.focus();
    await user.keyboard("{Enter}");
    expect(onPost).toHaveBeenCalledTimes(0);
  });

  it("asks with the timed-out sentence for a timed-out partial live record", async () => {
    run.phase = "error";
    stored.partials = [rec("rec-1", { phase: "error", timedOut: true })];
    const user = renderPanel();
    await user.click(postButton());
    const request = await confirmRequest();
    expect(request.title).toBe("Post partial review?");
    expect(request.body).toBe(
      "This run timed out before it finished, so the text may be incomplete. Post it as a comment anyway?",
    );
  });

  it("falls back to the phase when the live record isn't loaded", async () => {
    run.phase = "error";
    const user = renderPanel();
    await user.click(postButton());
    const request = await confirmRequest();
    expect(request.body).toMatch(/^This run failed before completing/);
  });

  it("names a timeout from the live run before its record loads", async () => {
    run.phase = "error";
    run.timedOut = true;
    const user = renderPanel();
    await user.click(postButton());
    const request = await confirmRequest();
    expect(request.body).toBe(
      "This run timed out before it finished, so the text may be incomplete. Post it as a comment anyway?",
    );
  });

  it("names any write in flight on a local PR", () => {
    renderPanel({ posting: true, kind: "local" });
    expectHeld(postButton(), ACT_PENDING_REASON);
  });
});

describe("a run started during the post", () => {
  it("survives the post's settle; the toast and stamp still run", async () => {
    const gate = deferPost();
    const user = renderPanel();
    await user.click(postButton());
    await waitFor(() => expect(onPost).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(live.getState()).toEqual({ text: "Second run.", seq: 2 });
    await act(async () => gate.release());
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(reset).not.toHaveBeenCalled();
    expect(live.getState()).toEqual({ text: "Second run.", seq: 2 });
    await waitFor(() =>
      expect(markReviewPosted).toHaveBeenCalledWith(
        REPO,
        "rec-1",
        expect.any(Number),
      ),
    );
  });
});

describe("after a live post settles", () => {
  it("lands focus on the provider picker, never body", async () => {
    const user = renderPanel();
    await user.click(postButton());
    await waitFor(() => expect(reset).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: /Post/ })).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute(
        "data-slot",
        "select-trigger",
      ),
    );
    expect(document.activeElement).not.toBe(document.body);
  });

  it("leaves focus on a control that survives the reset", async () => {
    const gate = deferPost();
    const user = renderPanel();
    await user.click(postButton());
    await waitFor(() => expect(onPost).toHaveBeenCalledTimes(1));
    const review = screen.getByRole("button", { name: "Review" });
    review.focus();
    await act(async () => gate.release());
    await waitFor(() => expect(reset).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: /Post/ })).toBeNull();
    expect(document.activeElement).toBe(review);
  });

  it("lands focus on the provider picker when Copy held it at the settle", async () => {
    const gate = deferPost();
    const user = renderPanel();
    await user.click(postButton());
    await waitFor(() => expect(onPost).toHaveBeenCalledTimes(1));
    screen.getByRole("button", { name: "Copy" }).focus();
    await act(async () => gate.release());
    await waitFor(() => expect(reset).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute(
        "data-slot",
        "select-trigger",
      ),
    );
    expect(document.activeElement).not.toBe(document.body);
  });

  it("arms nothing when the panel switched PRs before the post settled", async () => {
    const gate = deferPost();
    const user = renderPanel();
    await user.click(postButton());
    await waitFor(() => expect(onPost).toHaveBeenCalledTimes(1));
    user.rerenderWith({ prRef: "8" });
    // The reset clears the posted run's output, which this test store shows on
    // every target, so PR 8's Post leaves and focus falls to <body>.
    await act(async () => gate.release());
    await waitFor(() => expect(reset).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: /Post/ })).toBeNull();
    await act(async () => undefined);
    expect(document.activeElement).not.toHaveAttribute(
      "data-slot",
      "select-trigger",
    );
    // A later Post flip in PR 8 still leaves focus alone.
    act(() => live.setState({ text: TEXT, seq: 3 }));
    act(() => live.setState({ text: "", seq: undefined }));
    await act(async () => undefined);
    expect(document.activeElement).not.toHaveAttribute(
      "data-slot",
      "select-trigger",
    );
  });

  it.each([
    ["general", "Review posted to the conversation"],
    ["security", "Security audit posted to the conversation"],
  ] as const)("names a %s run in the toast", async (mode, copy) => {
    run.mode = mode;
    const user = renderPanel();
    await user.click(postButton());
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(copy));
  });
});
describe("a history read in flight when the post resolves", () => {
  it("doesn't land the pre-stamp copy over the patch", async () => {
    stored.done = [rec("rec-1")];
    vi.mocked(markReviewPosted).mockImplementation(
      () => new Promise<void>(() => undefined),
    );
    const user = renderPanel();
    await waitFor(() => expect(user.client.isFetching()).toBe(0));
    await user.click(screen.getByRole("button", { name: /Previous reviews/ }));
    const toggle = document.querySelector<HTMLElement>('[data-row="rec-1"]');
    if (!toggle) throw new Error("no row");
    await user.click(toggle);
    // A history read starts before the post and answers only after it.
    let release = () => undefined as void;
    stored.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    void user.client.invalidateQueries({
      queryKey: reviewHistoryKey(REPO, "origin", "remote", "7"),
    });
    await waitFor(() => expect(user.client.isFetching()).toBeGreaterThan(0));
    await user.click(
      within(screen.getByRole("listitem")).getByRole("button", {
        name: /^Post as comment$/,
      }),
    );
    await waitFor(() => expect(markReviewPosted).toHaveBeenCalledTimes(1));
    stored.gate = null;
    await act(async () => release());
    await waitFor(() => expect(user.client.isFetching()).toBe(0));
    const cached = user.client.getQueryData<PersistedReview[]>(
      reviewHistoryKey(REPO, "origin", "remote", "7"),
    );
    expect(cached?.[0]?.postedAt).toEqual(expect.any(Number));
    expect(
      within(screen.getByRole("listitem")).getByText(
        /Posted to the conversation/,
      ),
    ).toBeInTheDocument();
    // The live Post (outside the history list) still asks first.
    const live = screen
      .getAllByRole("button", { name: /^(Post as comment|Post again)$/ })
      .find((b) => !b.closest('[role="listitem"]'));
    if (!live) throw new Error("no live Post");
    expect(live).toHaveTextContent("Post again");
    await user.click(live);
    const request = await confirmRequest();
    expect(request.title).toBe("Post this review again?");
    expect(onPost).toHaveBeenCalledTimes(1);
  });
});

/** RemotePrView's hold wiring around the panel: the archived latch, the hold read
 *  off the details, and the onPost catch that latches for the PR it started on. */
function HeldPanel({
  entityKey,
  details,
  post,
}: {
  entityKey: string;
  details?: Pick<PrDetails, "locked" | "viewerCanComment" | "viewerCanReact">;
  post: PostFn;
}) {
  const { archived, latchIfArchived } = useArchivedLatch(entityKey);
  const hold = prConversationHold(details, archived, "github");
  return (
    <>
      <output data-testid="composer-hold">{hold.composer ?? ""}</output>
      <PrReviewPanel
        context={context}
        prKind="remote"
        prRef="7"
        conversationHoldReason={hold.composer}
        onPost={(body, opts) => {
          const postedFor = entityKey;
          return post(body, opts).catch((e) => {
            latchIfArchived(postedFor, e);
            throw e;
          });
        }}
      />
    </>
  );
}

const ARCHIVED_ERROR = { kind: "gh", message: PR_ARCHIVED_READONLY_MESSAGE };
const LOCKED =
  "This conversation is locked, so only collaborators can comment.";

function renderHeld(props: Omit<Parameters<typeof HeldPanel>[0], "post">) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = (p: typeof props) => (
    <QueryClientProvider client={client}>
      <HeldPanel {...p} post={onPost} />
    </QueryClientProvider>
  );
  const view = render(tree(props));
  return Object.assign(userEvent.setup(), {
    rerenderWith: (p: typeof props) => view.rerender(tree(p)),
  });
}

/** Opens the history row and returns its Post: the one that isn't `live`. */
async function historyPost(
  user: ReturnType<typeof userEvent.setup>,
  live: HTMLElement,
) {
  await user.click(screen.getByRole("button", { name: /Previous reviews/ }));
  const toggle = document.querySelector<HTMLElement>('[data-row="old"]');
  if (!toggle) throw new Error("no history row");
  await user.click(toggle);
  const others = screen
    .getAllByRole("button", { name: /^(Post as comment|Post again)$/ })
    .filter((b) => b !== live);
  expect(others).toHaveLength(1);
  return others[0];
}

describe("conversation hold on the AI review Posts", () => {
  it("an archived refusal from the live Post latches read-only and holds both Posts", async () => {
    stored.done = [rec("old", { text: "Older findings." })];
    onPost.mockImplementation(async () => {
      throw ARCHIVED_ERROR;
    });
    const user = renderHeld({ entityKey: "A" });
    await user.click(postButton());
    await waitFor(() =>
      expect(screen.getByTestId("composer-hold")).toHaveTextContent(
        PR_ARCHIVED_READONLY_MESSAGE,
      ),
    );
    const live = postButton();
    expectHeld(live, PR_ARCHIVED_READONLY_MESSAGE);
    await user.click(live);
    expect(onPost).toHaveBeenCalledTimes(1);
    expectHeld(await historyPost(user, live), PR_ARCHIVED_READONLY_MESSAGE);
  });

  it("holds both Posts with the lock reason when the viewer can't comment", async () => {
    stored.done = [rec("old", { text: "Older findings." })];
    // The lock answer arrives after mount; unknown keeps the Post live.
    const user = renderHeld({ entityKey: "A" });
    expect(postButton()).not.toHaveAttribute("aria-disabled");
    user.rerenderWith({
      entityKey: "A",
      details: { locked: true, viewerCanComment: false },
    });
    const live = postButton();
    expectHeld(live, LOCKED);
    expectHeld(await historyPost(user, live), LOCKED);
    expect(onPost).not.toHaveBeenCalled();
  });

  it("latches nothing on the new PR when the refusal settles after a switch", async () => {
    const fail = { reject: (_e: unknown) => undefined as void };
    onPost.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail.reject = reject;
        }),
    );
    const user = renderHeld({ entityKey: "A" });
    await user.click(postButton());
    await waitFor(() => expect(onPost).toHaveBeenCalled());
    user.rerenderWith({ entityKey: "B" });
    await act(async () => fail.reject(ARCHIVED_ERROR));
    expect(screen.getByTestId("composer-hold")).toHaveTextContent("");
    expect(postButton()).not.toHaveAttribute("aria-disabled");
  });

  it("posts nothing when a hold lands while the confirm is open", async () => {
    stored.done = [rec("rec-1", { postedAt: 1_700_000_500_000 })];
    const user = renderHeld({ entityKey: "A" });
    await user.click(postButton());
    const request = await confirmRequest();
    expect(request.title).toBe("Post this review again?");
    user.rerenderWith({
      entityKey: "A",
      details: { locked: true, viewerCanComment: false },
    });
    await act(async () => useConfirm.getState().answer(true));
    await waitFor(() => expect(useConfirm.getState().request).toBeNull());
    expect(onPost).not.toHaveBeenCalled();
  });

  it("posts nothing when the panel unmounted while the confirm was open", async () => {
    stored.done = [rec("rec-1", { postedAt: 1_700_000_500_000 })];
    const user = renderPanel();
    await user.click(postButton());
    await confirmRequest();
    // The app-level confirm host outlives the panel (a swap to an uncached PR).
    user.unmount();
    await act(async () => useConfirm.getState().answer(true));
    await waitFor(() => expect(useConfirm.getState().request).toBeNull());
    expect(onPost).not.toHaveBeenCalled();
  });

  it("leaves a local PR's Post live: local PRs pass no hold", async () => {
    const user = renderPanel({ kind: "local" });
    expect(postButton()).not.toHaveAttribute("aria-disabled");
    await user.click(postButton());
    await waitFor(() => expect(onPost).toHaveBeenCalledTimes(1));
  });
});

describe("useArchivedLatch", () => {
  function Latch({
    entityKey,
    onLatch,
  }: {
    entityKey: string;
    onLatch: (latch: (sentOn: string, e: unknown) => void) => void;
  }) {
    const { archived, latchIfArchived } = useArchivedLatch(entityKey);
    onLatch(latchIfArchived);
    return <output data-testid="archived">{String(archived)}</output>;
  }

  it("a late refusal from the PR left behind keeps the shown PR's latch", () => {
    let latch: (sentOn: string, e: unknown) => void = () => undefined;
    const tree = (key: string) => (
      <Latch
        entityKey={key}
        onLatch={(l) => {
          latch = l;
        }}
      />
    );
    const view = render(tree("A"));
    view.rerender(tree("B"));
    act(() => latch("B", ARCHIVED_ERROR));
    expect(screen.getByTestId("archived")).toHaveTextContent("true");
    act(() => latch("A", ARCHIVED_ERROR));
    expect(screen.getByTestId("archived")).toHaveTextContent("true");
    view.rerender(tree("A"));
    expect(screen.getByTestId("archived")).toHaveTextContent("false");
  });

  it("latches only on an archived refusal", () => {
    let latch: (sentOn: string, e: unknown) => void = () => undefined;
    render(
      <Latch
        entityKey="A"
        onLatch={(l) => {
          latch = l;
        }}
      />,
    );
    act(() => latch("A", { kind: "gh", message: "rate limited" }));
    expect(screen.getByTestId("archived")).toHaveTextContent("false");
    act(() => latch("A", ARCHIVED_ERROR));
    expect(screen.getByTestId("archived")).toHaveTextContent("true");
  });
});

// One predicate after the confirm: mounted, no live hold, not live-stale, same
// scope. The hold and unmount cells live in the conversation-hold block above.
describe("live Post confirm continuation", () => {
  async function openAgainConfirm(p: PanelProps = {}) {
    stored.done = [rec("rec-1", { postedAt: 1_700_000_500_000 })];
    const user = renderPanel(p);
    await user.click(postButton());
    expect((await confirmRequest()).title).toBe("Post this review again?");
    return user;
  }

  async function accept() {
    await act(async () => useConfirm.getState().answer(true));
    await waitFor(() => expect(useConfirm.getState().request).toBeNull());
  }

  it("posts nothing when the selection moved while the PR stayed painted", async () => {
    const user = await openAgainConfirm();
    // RemotePrView's selection hold: the rendered PR is unchanged, stale is on.
    user.rerenderWith({ stale: true });
    await accept();
    expect(onPost).not.toHaveBeenCalled();
  });

  it("posts nothing when the rendered PR changed", async () => {
    const user = await openAgainConfirm();
    user.rerenderWith({ prRef: "8" });
    await accept();
    expect(onPost).not.toHaveBeenCalled();
  });

  it("posts on accept when nothing moved, a local PR included", async () => {
    for (const kind of ["remote", "local"] as const) {
      onPost.mockClear();
      // The first round's post reset the run; each round starts from its output.
      live.setState({ text: TEXT, seq: 1 });
      const user = await openAgainConfirm({ kind });
      await accept();
      await waitFor(() => expect(onPost).toHaveBeenCalledTimes(1));
      user.unmount();
    }
  });
});
