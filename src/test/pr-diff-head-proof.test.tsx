import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgePrContentRevs,
  forgePrDiff,
  forgePrDiffAt,
  forgePrView,
  type PrDiffAt,
} from "@/lib/git/api";
import {
  PrDiffMovedError,
  type PrDiffRead,
  prDetailsOptions,
  prDiffOptions,
  refreshOpenPr,
  usePrContentRevs,
  usePrDetails,
  usePrDiff,
} from "@/lib/git/queries";
import { type PrDetails, prDiffTarget } from "@/lib/git/types";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgePrView: vi.fn(),
  forgePrDiff: vi.fn(),
  forgePrDiffAt: vi.fn(),
  forgePrContentRevs: vi.fn(),
}));

const REPO = "C:/repo";
const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const B1 = "a".repeat(40);
const B2 = "b".repeat(40);
const B256 = "c".repeat(64);
const M2 = "This diff changed on the forge while it was loading.";

/** What the details read names now. */
let named: {
  headSha: string;
  baseRefName: string;
  baseSha?: string | null;
};
/** Overrides the next details reads, in order (a held or failing answer). */
let views: (() => Promise<PrDetails>)[] = [];
/** The by-target read's answers, in order; later reads answer proven. */
let answers: (() => Promise<PrDiffAt>)[] = [];

const textOf = (head: string, base: string) =>
  `diff --git a/f.txt b/f.txt\n@@ -1 +1 @@\n-${base}\n+${head}\n`;

const detailsNow = (): PrDetails =>
  ({
    number: 7,
    state: "OPEN",
    commits: [],
    ...named,
  }) as unknown as PrDetails;

function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sleep = (ms: number) =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const answer =
  (headProof: string, diff = textOf(named.headSha, named.baseRefName)) =>
  () =>
    Promise.resolve({ diff, headProof } as PrDiffAt);

const detailsKey = prDetailsOptions(REPO, 7, "origin").queryKey;
const targetNow = () => prDiffTarget(detailsNow());
const diffKey = (target = targetNow()) =>
  prDiffOptions(REPO, 7, "origin", target).queryKey;

const clients: QueryClient[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  named = { headSha: H1, baseRefName: "main", baseSha: B1 };
  views = [];
  answers = [];
  vi.mocked(forgePrView).mockImplementation(async () => {
    const next = views.shift();
    return next ? next() : detailsNow();
  });
  vi.mocked(forgePrDiff).mockImplementation(async () => "by-number text");
  vi.mocked(forgePrDiffAt).mockImplementation(async (_r, _n, _l, target) => {
    const next = answers.shift();
    return next
      ? next()
      : { diff: textOf(target.head, target.baseRef), headProof: "proven" };
  });
  vi.mocked(forgePrContentRevs).mockImplementation(
    async (_r, _n, _l, head) => ({ oldSha: B1, newSha: head }) as never,
  );
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

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

/** The Files tab's reads, fed the target as RemotePrView feeds them. */
function useShown() {
  const read = usePrDetails(REPO, 7, "origin");
  const target =
    read.data !== undefined && !read.isPlaceholderData
      ? prDiffTarget(read.data)
      : undefined;
  const diff = usePrDiff(REPO, 7, "origin", target);
  const revs = usePrContentRevs(REPO, 7, "origin", target ?? null, true);
  return { read, diff, revs };
}

function mount(existing?: ReturnType<typeof newClient>) {
  const { client, wrapper } = existing ?? newClient();
  const hook = renderHook(() => useShown(), { wrapper });
  return { client, wrapper, hook };
}

/** A details re-read from outside the diff read: an exact invalidation. */
const rereadDetails = (client: QueryClient) =>
  act(() => client.invalidateQueries({ queryKey: detailsKey, exact: true }));

const diffAtTargets = () =>
  vi.mocked(forgePrDiffAt).mock.calls.map((c) => c[3]);

describe("the diff and content-revs keys carry the base (AC-K*)", () => {
  for (const [axis, change] of [
    ["baseRefName", () => (named.baseRefName = "release")],
    ["baseSha", () => (named.baseSha = B2)],
    ["headSha", () => (named.headSha = H2)],
  ] as const)
    it(`a change of ${axis} alone re-keys both reads and paints the older text meanwhile`, async () => {
      const { client, hook } = mount();
      await waitFor(() => expect(hook.result.current.revs.data).toBeDefined());
      const before = hook.result.current.diff.data;
      const held = deferred<PrDiffAt>();
      answers.push(() => held.promise);
      change();
      await rereadDetails(client);
      await waitFor(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(2));
      expect(diffAtTargets()[1]).toEqual({
        head: named.headSha,
        baseRef: named.baseRefName,
        baseSha: named.baseSha,
      });
      expect(hook.result.current.diff.data).toBe(before);
      expect(hook.result.current.diff.placeholderOf).toBe("olderHead");
      expect(hook.result.current.diff.headUnproven).toBe(false);
      // The revs keep no placeholder: the previous base's never serve.
      await waitFor(() => expect(forgePrContentRevs).toHaveBeenCalledTimes(2));
      await act(async () => held.resolve(await answer("proven")()));
      await waitFor(() =>
        expect(hook.result.current.diff.placeholderOf).toBe("none"),
      );
      expect(hook.result.current.diff.data).toBe(
        textOf(named.headSha, named.baseRefName),
      );
    });

  it("a content-revs read under a new base never hands the old base's revs", async () => {
    const { client, hook } = mount();
    await waitFor(() => expect(hook.result.current.revs.data).toBeDefined());
    const held = deferred<never>();
    vi.mocked(forgePrContentRevs).mockImplementationOnce(() => held.promise);
    named.baseRefName = "release";
    await rereadDetails(client);
    await waitFor(() => expect(forgePrContentRevs).toHaveBeenCalledTimes(2));
    expect(hook.result.current.revs.data).toBeUndefined();
  });

  it("a cached entry with no base sha, or an abbreviated one, reaches the command as null", async () => {
    named = { headSha: H1, baseRefName: "main" };
    const first = mount();
    await waitFor(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(1));
    expect(diffAtTargets()[0]?.baseSha).toBeNull();
    named.baseSha = "abc1234";
    await rereadDetails(first.client);
    await sleep(30);
    // An abbreviated sha keys as null too, so the entry stays the same.
    expect(forgePrDiffAt).toHaveBeenCalledTimes(1);
    named.baseSha = B256;
    await rereadDetails(first.client);
    await waitFor(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(2));
    expect(diffAtTargets()[1]?.baseSha).toBe(B256);
  });

  it("AC-C2: a head-less record reads by number and is never held", async () => {
    named = { headSha: "", baseRefName: "main", baseSha: B1 };
    const { hook } = mount();
    await waitFor(() =>
      expect(hook.result.current.diff.data).toBe("by-number text"),
    );
    expect(forgePrDiffAt).not.toHaveBeenCalled();
    expect(hook.result.current.diff.headUnproven).toBe(false);
  });
});

describe("an unproven answer (AC-U*)", () => {
  it("AC-U1/U2: draws at once, starts one details re-read, and a same-target answer proves it in place", async () => {
    answers.push(answer("unproven"));
    const reread = deferred<PrDetails>();
    // The view's own details read answers; the diff read's re-read waits.
    views.push(
      async () => detailsNow(),
      () => reread.promise,
    );
    const { hook } = mount();
    await waitFor(() =>
      expect(hook.result.current.diff.headUnproven).toBe(true),
    );
    expect(hook.result.current.diff.data).toBe(textOf(H1, "main"));
    expect(hook.result.current.diff.placeholderOf).toBe("none");
    expect(hook.result.current.diff.isPlaceholderData).toBe(false);
    expect(forgePrView).toHaveBeenCalledTimes(2);
    await act(async () => reread.resolve(detailsNow()));
    await waitFor(() =>
      expect(hook.result.current.diff.headUnproven).toBe(false),
    );
    expect(forgePrDiffAt).toHaveBeenCalledTimes(1);
    expect(forgePrView).toHaveBeenCalledTimes(2);
  });

  it("AC-U2: two observers on the key start one details re-read", async () => {
    answers.push(answer("unproven"));
    const reread = deferred<PrDetails>();
    views.push(
      async () => detailsNow(),
      () => reread.promise,
    );
    const { wrapper } = newClient();
    const hook = renderHook(() => [useShown(), useShown()], { wrapper });
    await waitFor(() => {
      expect(hook.result.current[0].diff.headUnproven).toBe(true);
      expect(hook.result.current[1].diff.headUnproven).toBe(true);
    });
    await sleep(20);
    expect(forgePrView).toHaveBeenCalledTimes(2);
    await act(async () => reread.resolve(detailsNow()));
    await waitFor(() => {
      expect(hook.result.current[0].diff.headUnproven).toBe(false);
      expect(hook.result.current[1].diff.headUnproven).toBe(false);
    });
    expect(forgePrDiffAt).toHaveBeenCalledTimes(1);
    expect(forgePrView).toHaveBeenCalledTimes(2);
  });

  it("B1 (i): a details fetch success after the answer filed proves it", async () => {
    answers.push(answer("unproven"));
    const { client } = newClient();
    await client.fetchQuery(prDiffOptions(REPO, 7, "origin", targetNow()));
    expect(client.getQueryData(diffKey())?.headProven).toBe(false);
    await act(() => client.fetchQuery(prDetailsOptions(REPO, 7, "origin")));
    expect(client.getQueryData(diffKey())?.headProven).toBe(true);
  });

  it("B1 (ii): an unobserved details fetch already in flight when the diff read starts proves nothing", async () => {
    const { client } = newClient();
    await client.fetchQuery(prDetailsOptions(REPO, 7, "origin"));
    // That fetch predates the diff read; the arming's invalidation restarts
    // it, and the restarted read stays unanswered.
    const outside = deferred<PrDetails>();
    views.push(
      () => outside.promise,
      () => new Promise<PrDetails>(() => undefined),
    );
    void client.refetchQueries({ queryKey: detailsKey, exact: true });
    await waitFor(() => expect(forgePrView).toHaveBeenCalledTimes(2));
    answers.push(answer("unproven"));
    await act(() =>
      client.fetchQuery(prDiffOptions(REPO, 7, "origin", targetNow())),
    );
    await act(async () => outside.resolve(detailsNow()));
    await sleep(20);
    expect(client.getQueryData(diffKey())?.headProven).toBe(false);
    expect(forgePrView).toHaveBeenCalledTimes(3);
  });

  it("B1 latch: a details success landing between the arming and the filing proves the entry once filed", async () => {
    const { client } = newClient();
    await client.fetchQuery(prDetailsOptions(REPO, 7, "origin"));
    answers.push(answer("unproven"));
    // The arming's own re-read stays unanswered, so only the latch can prove.
    views.push(() => new Promise<PrDetails>(() => undefined));
    const hash = client
      .getQueryCache()
      .find({ queryKey: detailsKey, exact: true })?.queryHash;
    let landed = 0;
    // The arming's invalidation lands a non-manual success at once, inside
    // the queryFn and before its answer is filed.
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.query.queryHash !== hash) return;
      if (event.action.type !== "invalidate") return;
      landed += 1;
      event.query.setData(detailsNow());
    });
    await client.fetchQuery(prDiffOptions(REPO, 7, "origin", targetNow()));
    unsubscribe();
    expect(landed).toBe(1);
    expect(client.getQueryData(diffKey())?.headProven).toBe(true);
  });

  it("F1: a cancelled run's late unproven answer leaves the live run's proof armed", async () => {
    const { client } = newClient();
    await client.fetchQuery(prDetailsOptions(REPO, 7, "origin"));
    await client.fetchQuery(prDiffOptions(REPO, 7, "origin", targetNow()));
    // Run A: a moved answer, then a second answer held past run B.
    const lateA = deferred<PrDiffAt>();
    answers.push(answer("moved"), () => lateA.promise);
    void client.refetchQueries({ queryKey: diffKey(), exact: true });
    await waitFor(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(3));
    // Run B: unproven, its details re-read held until the end.
    const rereadB = deferred<PrDetails>();
    views.push(() => rereadB.promise);
    answers.push(answer("unproven"));
    await act(() =>
      client.invalidateQueries({
        queryKey: diffKey(),
        exact: true,
        refetchType: "all",
      }),
    );
    await waitFor(() => expect(forgePrView).toHaveBeenCalledTimes(3));
    expect(client.getQueryData(diffKey())?.headProven).toBe(false);
    await act(async () => lateA.resolve(await answer("unproven")()));
    await sleep(20);
    await act(async () => rereadB.resolve(detailsNow()));
    await sleep(20);
    expect(client.getQueryData(diffKey())?.headProven).toBe(true);
  });

  it("F6: an entry removed while its read resolves leaves no proof listener", async () => {
    const { client } = newClient();
    const held = deferred<PrDiffAt>();
    answers.push(() => held.promise);
    const read = client
      .fetchQuery(prDiffOptions(REPO, 7, "origin", targetNow()))
      .catch(() => undefined);
    await waitFor(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(1));
    client.removeQueries({ queryKey: diffKey(), exact: true });
    await act(async () => held.resolve(await answer("unproven")()));
    await act(() => read);
    await sleep(20);
    expect(client.getQueryCache().hasListeners()).toBe(false);
  });

  it("F7: an abbreviated head (Bitbucket's newest commit) reads by number, never by target", async () => {
    named = {
      headSha: "",
      baseRefName: "main",
      baseSha: B1,
      commits: [{ oid: "abcdef123456" }],
    } as typeof named;
    const { hook } = mount();
    await waitFor(() =>
      expect(hook.result.current.diff.data).toBe("by-number text"),
    );
    expect(forgePrDiffAt).not.toHaveBeenCalled();
    expect(hook.result.current.diff.headUnproven).toBe(false);
  });

  for (const [route, write] of [
    [
      "an outside exact invalidation",
      (client: QueryClient) =>
        client.invalidateQueries({ queryKey: detailsKey, exact: true }),
    ],
    [
      "a details refetch",
      (client: QueryClient) =>
        client.refetchQueries({ queryKey: detailsKey, exact: true }),
    ],
  ] as const)
    it(`AC-U5: ${route} that lands the same target clears the hold`, async () => {
      answers.push(answer("unproven"));
      // The diff read's own re-read fails, so only the later route can prove.
      views.push(
        async () => detailsNow(),
        () => Promise.reject(new Error("details failed")),
      );
      const { client, hook } = mount();
      await waitFor(() =>
        expect(hook.result.current.diff.headUnproven).toBe(true),
      );
      await waitFor(() => expect(hook.result.current.read.isError).toBe(true));
      await sleep(20);
      expect(hook.result.current.diff.headUnproven).toBe(true);
      await act(() => write(client));
      await waitFor(() =>
        expect(hook.result.current.diff.headUnproven).toBe(false),
      );
      expect(forgePrDiffAt).toHaveBeenCalledTimes(1);
    });

  it("AC-U5: a manual details write naming the same target proves nothing", async () => {
    answers.push(answer("unproven"));
    views.push(
      async () => detailsNow(),
      () => Promise.reject(new Error("details failed")),
    );
    const { client, hook } = mount();
    await waitFor(() => expect(hook.result.current.read.data).toBeDefined());
    await waitFor(() => expect(hook.result.current.read.isError).toBe(true));
    act(() => {
      client.setQueryData(detailsKey, { ...detailsNow(), title: "patched" });
    });
    await sleep(20);
    expect(hook.result.current.diff.headUnproven).toBe(true);
    expect(client.getQueryData(diffKey())?.headProven).toBe(false);
  });

  it("AC-U5: a fetch success naming another base leaves the old entry unproven", async () => {
    answers.push(answer("unproven"));
    const { client } = newClient();
    const own = targetNow();
    await client.fetchQuery(prDiffOptions(REPO, 7, "origin", own));
    named.baseSha = B2;
    await act(() => client.fetchQuery(prDetailsOptions(REPO, 7, "origin")));
    expect(client.getQueryData(diffKey(own))?.headProven).toBe(false);
  });

  it("AC-U3: an unproven entry is stale at once, and Refresh's proven answer clears it", async () => {
    answers.push(answer("unproven"));
    views.push(
      async () => detailsNow(),
      () => Promise.reject(new Error("details failed")),
    );
    const { client, hook } = mount();
    await waitFor(() => expect(hook.result.current.read.data).toBeDefined());
    await waitFor(() =>
      expect(hook.result.current.diff.headUnproven).toBe(true),
    );
    expect(client.getQueryState(diffKey())?.isInvalidated).toBe(false);
    await act(() => refreshOpenPr(client, REPO, "origin", 7));
    await waitFor(() =>
      expect(hook.result.current.diff.headUnproven).toBe(false),
    );
    expect(forgePrDiffAt).toHaveBeenCalledTimes(2);
  });

  it("AC-C1: an unknown proof string holds as unproven", async () => {
    answers.push(answer("maybe"));
    views.push(
      async () => detailsNow(),
      () => new Promise(() => undefined),
    );
    const { hook } = mount();
    await waitFor(() =>
      expect(hook.result.current.diff.data).toBe(textOf(H1, "main")),
    );
    expect(hook.result.current.diff.headUnproven).toBe(true);
  });

  it("AC-C3: the raw entry's readers get the text", async () => {
    answers.push(answer("unproven"));
    const { client } = newClient();
    const read: PrDiffRead = await client.ensureQueryData(
      prDiffOptions(REPO, 7, "origin", targetNow()),
    );
    expect(read.text).toBe(textOf(H1, "main"));
  });
});

describe("a moved answer (AC-M*)", () => {
  /** Mounted over a proven text, then a refetch that answers moved. */
  async function movedOverText() {
    const ctx = mount();
    await waitFor(() =>
      expect(ctx.hook.result.current.diff.data).toBe(textOf(H1, "main")),
    );
    await waitFor(() =>
      expect(ctx.hook.result.current.revs.data).toBeDefined(),
    );
    const earlier = ctx.hook.result.current.diff.data;
    const reread = deferred<PrDetails>();
    views.push(() => reread.promise);
    answers.push(answer("moved", "another head's text"));
    act(() => {
      void ctx.client.refetchQueries({ queryKey: diffKey(), exact: true });
    });
    await waitFor(() =>
      expect(ctx.hook.result.current.diff.headChecking).toBe(true),
    );
    return { ...ctx, earlier, reread };
  }

  it("AC-M1/M3: the check keeps the text own, never files the moved text, and a same-target proof clears it", async () => {
    const { hook, client, earlier, reread } = await movedOverText();
    const shown = hook.result.current;
    expect(shown.diff.data).toBe(earlier);
    expect(client.getQueryData(diffKey())?.text).toBe(earlier);
    expect(shown.diff.isPlaceholderData).toBe(false);
    expect(shown.diff.placeholderOf).toBe("none");
    expect(shown.diff.isError).toBe(false);
    expect(shown.diff.headUnproven).toBe(false);
    expect(shown.revs.data).toBeDefined();
    answers.push(answer("proven", "the proven text"));
    await act(async () => reread.resolve(detailsNow()));
    await waitFor(() =>
      expect(hook.result.current.diff.data).toBe("the proven text"),
    );
    expect(hook.result.current.diff.headChecking).toBe(false);
    expect(hook.result.current.diff.headUnproven).toBe(false);
    expect(forgePrDiffAt).toHaveBeenCalledTimes(3);
  });

  for (const [ending, settle] of [
    [
      "moved again",
      async (reread: ReturnType<typeof deferred<PrDetails>>) => {
        answers.push(answer("moved", "a third text"));
        reread.resolve(detailsNow());
      },
    ],
    [
      "a failed details re-read",
      async (reread: ReturnType<typeof deferred<PrDetails>>) =>
        reread.reject(new Error("details failed")),
    ],
  ] as const)
    it(`AC-M1: ${ending} keeps the text, reads no failure and holds as unproven`, async () => {
      const { hook, client, earlier, reread } = await movedOverText();
      await act(() => settle(reread));
      await waitFor(() =>
        expect(hook.result.current.diff.headChecking).toBe(false),
      );
      const shown = hook.result.current.diff;
      expect(shown.data).toBe(earlier);
      expect(shown.isError).toBe(false);
      expect(shown.error).toBeNull();
      expect(shown.headUnproven).toBe(true);
      expect(shown.placeholderOf).toBe("none");
      expect(client.getQueryData(diffKey())?.text).toBe(earlier);
    });

  it("AC-M1: a parked details re-read keeps the text, reads no failure and holds as unproven", async () => {
    const { hook, client } = mount();
    await waitFor(() =>
      expect(hook.result.current.diff.data).toBe(textOf(H1, "main")),
    );
    const earlier = hook.result.current.diff.data;
    // The connection drops while the moved answer is on its way back.
    answers.push(async () => {
      onlineManager.setOnline(false);
      return { diff: "another head's text", headProof: "moved" } as PrDiffAt;
    });
    try {
      act(() => {
        void client.refetchQueries({ queryKey: diffKey(), exact: true });
      });
      await waitFor(() =>
        expect(hook.result.current.diff.headUnproven).toBe(true),
      );
      expect(client.getQueryState(detailsKey)?.fetchStatus).toBe("paused");
      const shown = hook.result.current.diff;
      expect(shown.data).toBe(earlier);
      expect(shown.isError).toBe(false);
      expect(shown.headChecking).toBe(false);
      expect(forgePrDiffAt).toHaveBeenCalledTimes(2);
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it("B4: a manual details write during the check is no fresh answer", async () => {
    const { hook, client, reread } = await movedOverText();
    act(() => {
      client.setQueryData(detailsKey, { ...detailsNow(), title: "patched" });
    });
    await act(async () => reread.reject(new Error("details failed")));
    await waitFor(() =>
      expect(hook.result.current.diff.headChecking).toBe(false),
    );
    expect(forgePrDiffAt).toHaveBeenCalledTimes(2);
    expect(hook.result.current.diff.headUnproven).toBe(true);
  });

  it("B2: a refetch of a terminal moved entry reads as checking while it runs", async () => {
    const { hook, client, reread } = await movedOverText();
    await act(async () => reread.reject(new Error("details failed")));
    await waitFor(() =>
      expect(hook.result.current.diff.headUnproven).toBe(true),
    );
    const held = deferred<PrDiffAt>();
    answers.push(() => held.promise);
    act(() => {
      void client.refetchQueries({ queryKey: diffKey(), exact: true });
    });
    await waitFor(() =>
      expect(hook.result.current.diff.headChecking).toBe(true),
    );
    expect(hook.result.current.diff.headUnproven).toBe(false);
    await act(async () => held.resolve(await answer("proven")()));
    await waitFor(() =>
      expect(hook.result.current.diff.headChecking).toBe(false),
    );
    expect(hook.result.current.diff.headUnproven).toBe(false);
  });

  it("AC-M1: details naming another target re-key the view", async () => {
    const { hook, reread } = await movedOverText();
    named.headSha = H2;
    await act(async () => reread.resolve(detailsNow()));
    await waitFor(() =>
      expect(hook.result.current.diff.data).toBe(textOf(H2, "main")),
    );
    expect(diffAtTargets().at(-1)?.head).toBe(H2);
    expect(hook.result.current.diff.headUnproven).toBe(false);
  });

  it("AC-M2: a first read with no text ends on the failed-read arm with M2, never retried", async () => {
    answers.push(answer("moved", ""));
    views.push(
      async () => detailsNow(),
      () => Promise.reject(new Error("details failed")),
    );
    const { hook } = mount();
    await waitFor(() => expect(hook.result.current.diff.isError).toBe(true), {
      timeout: 3000,
    });
    const shown = hook.result.current.diff;
    expect(shown.data).toBeUndefined();
    expect(shown.error).toBeInstanceOf(PrDiffMovedError);
    expect(shown.error?.message).toBe(M2);
    expect(shown.headUnproven).toBe(true);
    await sleep(1200);
    expect(forgePrDiffAt).toHaveBeenCalledTimes(1);
  });

  it("AC-L1: a removed entry is not re-created by the resolution", async () => {
    const { client } = newClient();
    answers.push(answer("moved", ""));
    const key = diffKey();
    const settled = client
      .fetchQuery(prDiffOptions(REPO, 7, "origin", targetNow()))
      .catch(() => undefined);
    await waitFor(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(1));
    act(() => client.removeQueries({ queryKey: key, exact: true }));
    await settled;
    await sleep(20);
    expect(client.getQueryData(key)).toBeUndefined();
  });
});
