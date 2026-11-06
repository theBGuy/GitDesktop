import { readFileSync } from "node:fs";
import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
  useQuery,
} from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
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
import { PR_SWITCH_LOADING_REASON } from "@/features/pulls/PrMergeabilityBanner";
import { ReviewHistory } from "@/features/pulls/ReviewHistory";
import type { RemoteLens } from "@/lib/git/types";
import {
  ACT_PENDING_REASON,
  COMMENT_POST_PENDING_REASON,
} from "@/lib/offline-writes";
import { stampReviewPosted } from "@/lib/pulls/review-posted-stamp";
import {
  markReviewPosted,
  type PersistedReview,
  reviewHistoryKey,
  reviewPartialsKey,
} from "@/lib/pulls/reviews-history";
import { useConfirm } from "@/lib/stores/confirm";
import { resetReview } from "@/lib/stores/reviews";
import { unmockedCommands } from "./setup";

type PrKind = "remote" | "local";

const state = vi.hoisted(() => ({
  done: [] as PersistedReview[],
  partials: [] as PersistedReview[],
  provider: "github" as "github" | "gitlab" | "bitbucket",
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
        queryFn: async () => state[list],
        initialData: () => state[list],
        networkMode: "always",
      });
    };
  return {
    ...(await importOriginal<typeof import("@/lib/pulls/queries")>()),
    useReviewHistory: cached("done", keys.reviewHistoryKey),
    useReviewPartials: cached("partials", keys.reviewPartialsKey),
    useDeleteReview: () => ({ mutateAsync: vi.fn(async () => undefined) }),
    useClearReviews: () => ({ mutateAsync: vi.fn(async () => undefined) }),
    useUpdateReviewText: () => ({ mutateAsync: vi.fn(async () => undefined) }),
  };
});
vi.mock("@/lib/git/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/queries")>()),
  useForgeStatus: () => ({ data: { provider: state.provider } }),
  usePendingRepoWrites: () => [],
}));
vi.mock("@/lib/pulls/reviews-history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pulls/reviews-history")>()),
  markReviewPosted: vi.fn(async () => undefined),
}));
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => undefined) }));
vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sonner")>()),
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }),
}));
// Never imported by ReviewHistory (pinned below); mocked so a call would show.
vi.mock("@/lib/stores/reviews", () => ({ resetReview: vi.fn() }));

const REPO = "C:/repos/demo";
const HOLD = "This conversation is locked, so only collaborators can comment.";
const SCOPE_7 = {
  repo: REPO,
  lens: "origin",
  kind: "remote",
  ref: "7",
} as const;

function rec(
  id: string,
  extra: Partial<PersistedReview> = {},
): PersistedReview {
  return {
    schemaVersion: 1,
    id,
    kind: "remote",
    ref: "7",
    lens: "origin",
    mode: "general",
    model: "model-general",
    title: "A PR",
    text: `Findings of ${id}.`,
    headSha: "abc",
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_100_000,
    ...extra,
  };
}

type PostFn = (body: string, opts?: { asBot?: boolean }) => Promise<void>;
let onPost: Mock<PostFn>;

/** The store's markReviewPosted: stamps the stored record by id. */
function stampStored(id: string, postedAt: number) {
  for (const list of ["done", "partials"] as const)
    state[list] = state[list].map((r) =>
      r.id === id ? { ...r, postedAt } : r,
    );
}

beforeEach(() => {
  state.provider = "github";
  state.partials = [];
  state.done = [];
  onPost = vi.fn<PostFn>(async () => undefined);
  vi.mocked(markReviewPosted).mockImplementation(async (_repo, id, at) =>
    stampStored(id, at),
  );
  useConfirm.setState({ request: null, requestHold: null });
});

afterAll(() => {
  expect(unmockedCommands).toEqual([]);
});

type Props = {
  prKind?: "remote" | "local";
  prRef?: string;
  posting?: boolean;
  stale?: boolean;
  withPost?: boolean;
  conversationHoldReason?: string | null;
};

function tree(client: QueryClient, p: Props) {
  return (
    <QueryClientProvider client={client}>
      <ReviewHistory
        repoPath={REPO}
        lens="origin"
        prKind={p.prKind ?? "remote"}
        prRef={p.prRef ?? "7"}
        onPost={p.withPost === false ? undefined : onPost}
        posting={p.posting}
        stale={p.stale}
        conversationHoldReason={p.conversationHoldReason}
      />
    </QueryClientProvider>
  );
}

/** Renders the disclosure open with the named row expanded. */
async function renderOpen(id: string, p: Props = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const user = userEvent.setup();
  const view = render(tree(client, p));
  await user.click(screen.getByRole("button", { name: /Previous reviews/ }));
  const toggle = view.container.querySelector<HTMLElement>(
    `[data-row="${id}"]`,
  );
  if (!toggle) throw new Error(`no row ${id}`);
  await user.click(toggle);
  return {
    user,
    view,
    toggle,
    client,
    rerender: () => view.rerender(tree(client, p)),
    rerenderWith: (next: Props) => view.rerender(tree(client, next)),
  };
}

// The posting row's Spinner is a labelled status, so its name gains "Loading".
const postButton = () =>
  screen.getByRole("button", {
    name: /^(Loading ?)?(Post as comment|Post again)$/,
  });

function expectHeld(el: HTMLElement, reason: string) {
  expect(el).toHaveAttribute("aria-disabled", "true");
  expect(el).toHaveAccessibleDescription(reason);
}

const expectLive = (el: HTMLElement) =>
  expect(el).not.toHaveAttribute("aria-disabled");

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

async function confirmRequest() {
  await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
  const request = useConfirm.getState().request;
  if (!request) throw new Error("no confirm");
  return request;
}

describe("history row Post", () => {
  it("builds the body from the record's own mode and model", async () => {
    state.done = [
      rec("gen", { finishedAt: 1_700_000_300_000 }),
      rec("sec", {
        mode: "security",
        model: "model-sec",
        finishedAt: 1_700_000_200_000,
      }),
    ];
    const { user } = await renderOpen("sec");
    await user.click(postButton());
    await waitFor(() => expect(onPost).toHaveBeenCalledTimes(1));
    const [body, opts] = onPost.mock.calls[0];
    expect(body).toContain("GitDesktop AI security audit");
    expect(body).toContain("`model-sec`");
    expect(body).toContain("Findings of sec.");
    expect(body).not.toContain("model-general");
    expect(opts).toEqual({ asBot: true });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Security audit posted to the conversation",
      ),
    );
  });

  it("stamps the record and toasts only after a successful post", async () => {
    state.done = [rec("a")];
    const { user } = await renderOpen("a");
    await user.click(postButton());
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Review posted to the conversation",
      ),
    );
    expect(markReviewPosted).toHaveBeenCalledWith(
      REPO,
      "a",
      expect.any(Number),
    );
    expect(resetReview).not.toHaveBeenCalled();
  });

  it("neither stamps nor toasts when the post is refused", async () => {
    state.done = [rec("a")];
    onPost.mockImplementation(async () => {
      throw new Error("refused");
    });
    const { user } = await renderOpen("a");
    await user.click(postButton());
    await waitFor(() => expect(onPost).toHaveBeenCalled());
    await waitFor(() => expectLive(postButton()));
    expect(markReviewPosted).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("still toasts when the stamp itself fails", async () => {
    state.done = [rec("a")];
    vi.mocked(markReviewPosted).mockImplementation(async () => {
      throw new Error("store down");
    });
    const { user } = await renderOpen("a");
    await user.click(postButton());
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("asks before posting a timed-out partial; cancel aborts", async () => {
    state.partials = [
      rec("p", { phase: "error", timedOut: true, error: "timed out" }),
    ];
    const { user } = await renderOpen("p");
    expect(
      screen.queryByRole("button", { name: /Trim before re-running/ }),
    ).toBeNull();
    await user.click(postButton());
    let request = await confirmRequest();
    expect(request.title).toBe("Post partial review?");
    expect(request.body).toBe(
      "This run timed out before it finished, so the text may be incomplete. Post it as a comment anyway?",
    );
    expect(request.confirmLabel).toBe("Post anyway");
    act(() => useConfirm.getState().answer(false));
    await waitFor(() => expect(useConfirm.getState().request).toBeNull());
    expectLive(postButton());
    expect(onPost).not.toHaveBeenCalled();

    await user.click(postButton());
    request = await confirmRequest();
    act(() => useConfirm.getState().answer(true));
    await waitFor(() => expect(onPost).toHaveBeenCalledTimes(1));
  });

  it("names a failed partial's stop in the confirm", async () => {
    state.partials = [rec("p", { phase: "error", error: "boom" })];
    const { user } = await renderOpen("p");
    await user.click(postButton());
    const request = await confirmRequest();
    expect(request.body).toBe(
      "This run failed before completing, so the text may be incomplete. Post it as a comment anyway?",
    );
  });

  it("shows a stamped row as posted and asks before posting again", async () => {
    state.done = [rec("s", { postedAt: 1_700_000_500_000 })];
    const { user } = await renderOpen("s");
    expect(screen.getByText(/Posted to the conversation/)).toBeInTheDocument();
    const button = postButton();
    expect(button).toHaveTextContent("Post again");
    await user.click(button);
    const request = await confirmRequest();
    expect(request.title).toBe("Post this review again?");
    expect(request.body).toBe(
      "This review was already posted to the conversation — posting it again adds a second comment. Post it as a comment anyway?",
    );
    expect(request.confirmLabel).toBe("Post again");
  });

  it.each([
    ["legacy (no stamp)", {}],
    ["string stamp", { postedAt: "123" as unknown as number }],
    ["NaN stamp", { postedAt: Number.NaN }],
  ])("reads a %s row as unposted", async (_label, extra) => {
    state.done = [rec("u", extra)];
    const { user } = await renderOpen("u");
    expect(screen.queryByText(/Posted to the conversation/)).toBeNull();
    expect(postButton()).toHaveTextContent("Post as comment");
    await user.click(postButton());
    await waitFor(() => expect(onPost).toHaveBeenCalled());
    expect(useConfirm.getState().request).toBeNull();
  });

  it("offers no Post on an empty-text record", async () => {
    state.done = [rec("e", { text: "" })];
    await renderOpen("e");
    expect(
      screen.queryByRole("button", { name: /^(Post as comment|Post again)$/ }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: /^Copy$/ })).toBeInTheDocument();
  });

  it("hides Post when the panel has no post route", async () => {
    state.done = [rec("a")];
    await renderOpen("a", { withPost: false });
    expect(
      screen.queryByRole("button", { name: /^(Post as comment|Post again)$/ }),
    ).toBeNull();
  });

  it("holds Post with the loading reason while stale, reachable by Tab", async () => {
    state.done = [rec("a")];
    const { user } = await renderOpen("a", { stale: true });
    const button = postButton();
    expectHeld(button, PR_SWITCH_LOADING_REASON);
    for (let i = 0; i < 20 && document.activeElement !== button; i++)
      await user.tab();
    expect(document.activeElement).toBe(button);
    await user.keyboard("{Enter}");
    await user.click(button);
    expect(onPost).not.toHaveBeenCalled();
  });

  it("holds Post while the PR view's comment write is in flight", async () => {
    state.done = [rec("a")];
    await renderOpen("a", { posting: true });
    expectHeld(postButton(), COMMENT_POST_PENDING_REASON);
  });

  it("names the post in flight over the loading reason", async () => {
    state.done = [rec("a")];
    await renderOpen("a", { posting: true, stale: true });
    expectHeld(postButton(), COMMENT_POST_PENDING_REASON);
  });

  it("holds its own post in flight with focus kept and presses ignored", async () => {
    state.done = [rec("a")];
    const gate = deferPost();
    const { user } = await renderOpen("a");
    const button = postButton();
    await user.click(button);
    await waitFor(() => expectHeld(button, COMMENT_POST_PENDING_REASON));
    expect(document.activeElement).toBe(button);
    await user.click(button);
    await user.keyboard("{Enter}");
    expect(onPost).toHaveBeenCalledTimes(1);
    await act(async () => gate.release());
    await waitFor(() => expectLive(button));
    expect(postButton()).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(onPost).toHaveBeenCalledTimes(1);
  });

  it("holds every row's Post while one row posts", async () => {
    state.done = [
      rec("a", { finishedAt: 1_700_000_300_000 }),
      rec("b", { finishedAt: 1_700_000_200_000 }),
    ];
    let release = () => undefined as void;
    onPost.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { user, view } = await renderOpen("a");
    await user.click(postButton());
    await waitFor(() => expectHeld(postButton(), COMMENT_POST_PENDING_REASON));
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
    // Expanding another row keeps the hold: one token holds every row.
    const other = view.container.querySelector<HTMLElement>('[data-row="b"]');
    if (!other) throw new Error("no row b");
    await user.click(other);
    expectHeld(postButton(), COMMENT_POST_PENDING_REASON);
    act(() => release());
    await waitFor(() => expectLive(postButton()));
  });

  it("keeps focus on the same button across the posted flip", async () => {
    state.done = [rec("a")];
    const { user } = await renderOpen("a");
    const button = postButton();
    await user.click(button);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(document.activeElement).toBe(button);
    // The stamp's patch flips the row in place.
    await waitFor(() =>
      expect(
        screen.getByText(/Posted to the conversation/),
      ).toBeInTheDocument(),
    );
    expect(postButton()).toBe(button);
    expect(button).toHaveTextContent("Post again");
    expect(document.activeElement).toBe(button);
  });

  it("keeps focus on the button when the post fails", async () => {
    state.done = [rec("a")];
    onPost.mockImplementation(async () => {
      throw new Error("refused");
    });
    const { user } = await renderOpen("a");
    const button = postButton();
    await user.click(button);
    await waitFor(() => expect(onPost).toHaveBeenCalled());
    await waitFor(() => expectLive(button));
    expect(document.activeElement).toBe(button);
    expect(postButton()).toBe(button);
  });
});

describe("review-scope switch", () => {
  it("frees the new scope's Post, and the old settle leaves its hold alone", async () => {
    state.done = [rec("a")];
    const first = deferPost();
    const { user, view, rerenderWith } = await renderOpen("a");
    await user.click(postButton());
    await waitFor(() => expectHeld(postButton(), COMMENT_POST_PENDING_REASON));
    // PR 8: RemotePrView's `posting` is per PR, so nothing else holds it here.
    state.done = [rec("b", { ref: "8" })];
    rerenderWith({ prRef: "8" });
    const toggle = view.container.querySelector<HTMLElement>('[data-row="b"]');
    if (!toggle) throw new Error("no row b");
    await user.click(toggle);
    expectLive(postButton());
    const second = deferPost();
    await user.click(postButton());
    await waitFor(() => expectHeld(postButton(), COMMENT_POST_PENDING_REASON));
    await act(async () => first.release());
    await waitFor(() => expect(markReviewPosted).toHaveBeenCalledTimes(1));
    expectHeld(postButton(), COMMENT_POST_PENDING_REASON);
    await act(async () => second.release());
    await waitFor(() => expectLive(postButton()));
    expect(onPost).toHaveBeenCalledTimes(2);
  });
});

describe("live references", () => {
  it("asks before posting a remote review that cites #N", async () => {
    state.done = [rec("r", { text: "See #12 for context." })];
    const { user } = await renderOpen("r");
    await user.click(postButton());
    const request = await confirmRequest();
    expect(request.title).toBe("Post review with live references?");
    expect(request.confirmLabel).toBe("Post anyway");
  });

  it("excuses an escaped ref on GitLab only", async () => {
    state.provider = "gitlab";
    state.done = [rec("g", { text: "See \\#12 for context." })];
    const { user } = await renderOpen("g");
    await user.click(postButton());
    await waitFor(() => expect(onPost).toHaveBeenCalled());
    expect(useConfirm.getState().request).toBeNull();
  });

  it("treats an escaped ref as live on GitHub", async () => {
    state.done = [rec("g", { text: "See \\#12 for context." })];
    const { user } = await renderOpen("g");
    await user.click(postButton());
    const request = await confirmRequest();
    expect(request.title).toBe("Post review with live references?");
  });

  it("runs no refs scan for a local PR", async () => {
    state.done = [rec("l", { kind: "local", text: "See #12 for context." })];
    const { user } = await renderOpen("l", { prKind: "local" });
    await user.click(postButton());
    await waitFor(() => expect(onPost).toHaveBeenCalled());
    expect(useConfirm.getState().request).toBeNull();
  });

  it("posts a pre-lens record (no lens field)", async () => {
    const legacy = rec("old");
    delete legacy.lens;
    state.done = [legacy];
    const { user } = await renderOpen("old");
    await user.click(postButton());
    await waitFor(() => expect(markReviewPosted).toHaveBeenCalled());
  });
});

describe("row layout and isolation", () => {
  it("wraps the row header instead of overlapping Trash", async () => {
    state.done = [rec("a")];
    const { toggle } = await renderOpen("a");
    expect(toggle.className).toContain("flex-wrap");
    expect(toggle.className).toContain("gap-x-2");
    expect(toggle.className).toContain("gap-y-0.5");
    expect(screen.getByText("model-general")).toHaveClass("min-w-0");
  });

  it("puts Post first in the controls row", async () => {
    state.done = [rec("a")];
    await renderOpen("a");
    // DisabledReasonButton wraps the button in its reason span.
    const wrapper = postButton().parentElement;
    expect(wrapper?.parentElement?.firstElementChild).toBe(wrapper);
  });

  it("imports nothing from the live review store", () => {
    const source = readFileSync("src/features/pulls/ReviewHistory.tsx", "utf8");
    expect(source).not.toMatch(/["']@\/lib\/stores\/reviews["']/);
  });
});

describe("optimistic stamp", () => {
  it("asks before posting again after a live-style patch, before the store write", async () => {
    state.done = [rec("a")];
    vi.mocked(markReviewPosted).mockImplementation(
      () => new Promise<void>(() => undefined),
    );
    const { user, client } = await renderOpen("a");
    expect(postButton()).toHaveTextContent("Post as comment");
    // The mount read has settled, so nothing in flight can land over the patch.
    await waitFor(() => expect(client.isFetching()).toBe(0));
    act(() =>
      stampReviewPosted(client, {
        repo: REPO,
        lens: "origin",
        kind: "remote",
        ref: "7",
        id: "a",
      }),
    );
    await waitFor(() => expect(postButton()).toHaveTextContent("Post again"));
    await user.click(postButton());
    const request = await confirmRequest();
    expect(request.title).toBe("Post this review again?");
    expect(onPost).not.toHaveBeenCalled();
  });

  it("patches only the named record and creates no entry", async () => {
    state.done = [
      rec("a", { finishedAt: 1_700_000_300_000 }),
      rec("b", { finishedAt: 1_700_000_200_000 }),
    ];
    const { client } = await renderOpen("a");
    await waitFor(() => expect(client.isFetching()).toBe(0));
    vi.mocked(markReviewPosted).mockImplementation(
      () => new Promise<void>(() => undefined),
    );
    // Another PR's history, holding none of the stamped ids.
    const otherKey = reviewHistoryKey(REPO, "origin", "remote", "99");
    const otherData = [rec("c", { ref: "99" })];
    client.setQueryData(otherKey, otherData);
    const here = reviewHistoryKey(REPO, "origin", "remote", "7");
    const before = client.getQueryCache().getAll().length;
    await act(async () => {
      stampReviewPosted(client, { ...SCOPE_7, id: "b" });
      stampReviewPosted(client, { ...SCOPE_7, id: "zzz" });
      // A scope nothing has read: the stamp must not create its entry.
      stampReviewPosted(client, { ...SCOPE_7, ref: "55", id: "b" });
    });
    await waitFor(() =>
      expect(
        client.getQueryData<PersistedReview[]>(here)?.find((r) => r.id === "b")
          ?.postedAt,
      ).toEqual(expect.any(Number)),
    );
    const posted = (key: readonly unknown[]) =>
      client
        .getQueryData<PersistedReview[]>(key)
        ?.filter((r) => r.postedAt !== undefined)
        .map((r) => r.id);
    expect(posted(here)).toEqual(["b"]);
    expect(client.getQueryData(otherKey)).toBe(otherData);
    expect(client.getQueryCache().getAll().length).toBe(before);
    expect(postButton()).toHaveTextContent("Post as comment");
  });

  it("patches the record in a sibling checkout's caches too", async () => {
    vi.mocked(markReviewPosted).mockImplementation(
      () => new Promise<void>(() => undefined),
    );
    const client = new QueryClient();
    // A sibling worktree reads the same identity-keyed store under its own path.
    const SIB = "C:/repos/demo-wt";
    const sibHistory = reviewHistoryKey(SIB, "origin", "remote", "7");
    const sibPartials = reviewPartialsKey(SIB, "origin", "remote", "7");
    const unrelatedKey = reviewHistoryKey(SIB, "origin", "remote", "8");
    const unrelated = [rec("other", { ref: "8" })];
    client.setQueryData(sibHistory, [rec("a")]);
    client.setQueryData(sibPartials, [rec("a", { phase: "error" })]);
    client.setQueryData(unrelatedKey, unrelated);
    await act(async () => {
      stampReviewPosted(client, { ...SCOPE_7, id: "a" });
    });
    await waitFor(() =>
      expect(
        client.getQueryData<PersistedReview[]>(sibHistory)?.[0].postedAt,
      ).toEqual(expect.any(Number)),
    );
    expect(
      client.getQueryData<PersistedReview[]>(sibPartials)?.[0].postedAt,
    ).toEqual(expect.any(Number));
    expect(client.getQueryData(unrelatedKey)).toBe(unrelated);
  });

  it("stays posted and asks before re-posting when the stamp rejects", async () => {
    state.done = [rec("a")];
    const fail = { reject: (_e: Error) => undefined as void };
    // The store's reads keep a rejected stamp as a session receipt (pinned in
    // reviews-history-posted.test.ts), so the re-read after the rejection says
    // posted while the write itself fails.
    vi.mocked(markReviewPosted).mockImplementation(
      (_repo, id, at) =>
        new Promise<void>((_resolve, reject) => {
          stampStored(id, at);
          fail.reject = reject;
        }),
    );
    const { user, client } = await renderOpen("a");
    await user.click(postButton());
    await waitFor(() => expect(postButton()).toHaveTextContent("Post again"));
    await act(async () => fail.reject(new Error("store down")));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(postButton()).toHaveTextContent("Post again");
    expect(screen.getByText(/Posted to the conversation/)).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledTimes(1);
    await user.click(postButton());
    const request = await confirmRequest();
    expect(request.title).toBe("Post this review again?");
    act(() => useConfirm.getState().answer(false));
    expect(onPost).toHaveBeenCalledTimes(1);
  });

  it("posts nothing when a hold lands while the confirm is open", async () => {
    state.done = [rec("a", { postedAt: 1_700_000_500_000 })];
    const { user, rerenderWith } = await renderOpen("a");
    await user.click(postButton());
    const request = await confirmRequest();
    expect(request.title).toBe("Post this review again?");
    rerenderWith({ conversationHoldReason: HOLD });
    await act(async () => useConfirm.getState().answer(true));
    await waitFor(() => expect(useConfirm.getState().request).toBeNull());
    expect(onPost).not.toHaveBeenCalled();
  });

  it("posts nothing when the disclosure unmounted while the confirm was open", async () => {
    state.done = [rec("a", { postedAt: 1_700_000_500_000 })];
    const { user, view } = await renderOpen("a");
    await user.click(postButton());
    await confirmRequest();
    // The app-level confirm host outlives the history (a swap to an uncached PR).
    view.unmount();
    await act(async () => useConfirm.getState().answer(true));
    await waitFor(() => expect(useConfirm.getState().request).toBeNull());
    expect(onPost).not.toHaveBeenCalled();
  });

  it("holds Post with the conversation's hold reason", async () => {
    state.done = [rec("a")];
    const { user, rerenderWith } = await renderOpen("a", {
      conversationHoldReason: HOLD,
    });
    expectHeld(postButton(), HOLD);
    await user.click(postButton());
    expect(onPost).not.toHaveBeenCalled();
    // Precedence: a post in flight outranks the hold, the hold outranks stale.
    rerenderWith({ conversationHoldReason: HOLD, stale: true });
    expectHeld(postButton(), HOLD);
    rerenderWith({ conversationHoldReason: HOLD, stale: true, posting: true });
    expectHeld(postButton(), COMMENT_POST_PENDING_REASON);
    rerenderWith({ conversationHoldReason: null });
    expectLive(postButton());
  });

  it("releases postingFor once onPost resolves, without waiting on the store", async () => {
    state.done = [rec("a")];
    vi.mocked(markReviewPosted).mockImplementation(
      () => new Promise<void>(() => undefined),
    );
    const gate = deferPost();
    const { user } = await renderOpen("a");
    const button = postButton();
    await user.click(button);
    await waitFor(() => expectHeld(button, COMMENT_POST_PENDING_REASON));
    await act(async () => gate.release());
    await waitFor(() => expectLive(button));
    expect(markReviewPosted).toHaveBeenCalledTimes(1);
    expect(button).toHaveTextContent("Post again");
  });

  it("names any write in flight on a local PR", async () => {
    state.done = [rec("l", { kind: "local" })];
    await renderOpen("l", { prKind: "local", posting: true });
    expectHeld(postButton(), ACT_PENDING_REASON);
  });
});

// One predicate after the confirm: mounted, no live hold, not live-stale, same
// scope. The hold and unmount cells live in the optimistic-stamp block above.
describe("history Post confirm continuation", () => {
  async function openAgainConfirm(p: Props = {}) {
    state.done = [
      rec("a", { postedAt: 1_700_000_500_000, kind: p.prKind ?? "remote" }),
    ];
    const opened = await renderOpen("a", p);
    await opened.user.click(postButton());
    expect((await confirmRequest()).title).toBe("Post this review again?");
    return opened;
  }

  async function accept() {
    await act(async () => useConfirm.getState().answer(true));
    await waitFor(() => expect(useConfirm.getState().request).toBeNull());
  }

  it("posts nothing when the selection moved while the PR stayed painted", async () => {
    const { rerenderWith } = await openAgainConfirm();
    rerenderWith({ stale: true });
    await accept();
    expect(onPost).not.toHaveBeenCalled();
  });

  it("posts nothing when the rendered PR changed", async () => {
    const { rerenderWith } = await openAgainConfirm();
    rerenderWith({ prRef: "8" });
    await accept();
    expect(onPost).not.toHaveBeenCalled();
  });

  it("posts on accept when nothing moved, a local PR included", async () => {
    for (const prKind of ["remote", "local"] as const) {
      onPost.mockClear();
      const { view } = await openAgainConfirm({ prKind });
      await accept();
      await waitFor(() => expect(onPost).toHaveBeenCalledTimes(1));
      view.unmount();
    }
  });
});
