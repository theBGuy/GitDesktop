import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgePrContentRevs,
  forgePrDiff,
  forgePrDiffAt,
  forgePrHeadProof,
  forgePrView,
  type PrDiffAt,
} from "@/lib/git/api";
import {
  PR_DIFF_MOVED_CHECKS,
  PR_DIFF_MOVED_RECHECK_MS,
  PrDiffMovedError,
  type PrDiffRead,
  prDetailsOptions,
  prDiffOptions,
  prDiffText,
  refreshOpenPr,
  usePrContentRevs,
  usePrDetails,
  usePrDiff,
} from "@/lib/git/queries";
import prsSource from "@/lib/git/queries/prs.ts?raw";
import { type PrDetails, prDiffTarget } from "@/lib/git/types";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgePrView: vi.fn(),
  forgePrDiff: vi.fn(),
  forgePrDiffAt: vi.fn(),
  forgePrHeadProof: vi.fn(),
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
  url?: string;
  commits?: { oid: string }[];
  commitsUnknown?: boolean;
  commitsTruncated?: boolean;
};
/** Overrides the next details reads, in order (a held or failing answer). */
let views: (() => Promise<PrDetails>)[] = [];
/** The by-target read's answers, in order; later reads answer proven. */
let answers: (() => Promise<PrDiffAt>)[] = [];
/** The run's own head proofs, in order; later ones judge the details now. */
let proofs: (() => Promise<string>)[] = [];

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

/** Under fake timers this advances them, `performance.now()` included. */
const sleep = (ms: number) =>
  vi.isFakeTimers()
    ? act(() => vi.advanceTimersByTimeAsync(ms))
    : act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/** `waitFor`, except that under fake timers it steps the clock until `check`
 *  passes: RTL's own polling timers are faked there and never fire. */
async function until(
  check: () => void,
  { timeout = 1000 }: { timeout?: number } = {},
) {
  if (!vi.isFakeTimers()) return waitFor(check, { timeout });
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
  proofs = [];
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
  vi.mocked(forgePrHeadProof).mockImplementation(async (_r, _n, _l, at) => {
    const next = proofs.shift();
    if (next) return (await next()) as PrDiffAt["headProof"];
    const live = prDiffTarget(detailsNow());
    return live.head === at.head &&
      live.baseRef === at.baseRef &&
      live.baseSha === at.baseSha
      ? "proven"
      : "moved";
  });
  vi.mocked(forgePrContentRevs).mockImplementation(
    async (_r, _n, _l, head) => ({ oldSha: B1, newSha: head }) as never,
  );
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.useRealTimers();
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
      // The revs read the base the new target names, never a live re-read's.
      expect(vi.mocked(forgePrContentRevs).mock.calls[1]?.slice(3)).toEqual([
        named.headSha,
        named.baseRefName,
        named.baseSha,
      ]);
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

  const GITLAB_URL = "https://gitlab.com/o/r/-/merge_requests/7";
  const BITBUCKET_URL = "https://bitbucket.org/o/r/pull-requests/7";
  for (const [record, headSha, url] of [
    ["a GitHub record with no head", "", "https://github.com/o/r/pull/7"],
    ["a GitLab record with a null head", "", GITLAB_URL],
    ["a GitLab record with an abbreviated head", "abcdef123456", GITLAB_URL],
  ] as const)
    it(`P6: ${record} reads by number and holds as unproven once it answers`, async () => {
      named = { headSha, baseRefName: "main", baseSha: B1, url };
      const text = deferred<string>();
      vi.mocked(forgePrDiff).mockImplementationOnce(() => text.promise);
      const { hook } = mount();
      await waitFor(() => expect(forgePrDiff).toHaveBeenCalledTimes(1));
      // P6b: the target names no full head, so it holds while the read runs.
      expect(hook.result.current.diff.headUnnamed).toBe(true);
      await act(async () => text.resolve("by-number text"));
      await waitFor(() =>
        expect(hook.result.current.diff.data).toBe("by-number text"),
      );
      expect(hook.result.current.diff.headUnproven).toBe(true);
      expect(hook.result.current.diff.headUnnamed).toBe(true);
      expect(hook.result.current.diff.headProving).toBe(false);
      expect(forgePrDiffAt).not.toHaveBeenCalled();
      expect(forgePrHeadProof).not.toHaveBeenCalled();
    });

  it("P6b: a GitLab null-head record holds after a failed first read, and lets go once the details name the full commit", async () => {
    named = { headSha: "", baseRefName: "main", baseSha: B1, url: GITLAB_URL };
    // The read and its one retry both fail.
    vi.mocked(forgePrDiff)
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"));
    const { client, hook } = mount();
    await waitFor(() => expect(hook.result.current.diff.isError).toBe(true), {
      timeout: 3000,
    });
    expect(hook.result.current.diff.headUnnamed).toBe(true);
    expect(hook.result.current.diff.headUnproven).toBe(false);
    named = { headSha: H1, baseRefName: "main", baseSha: B1, url: GITLAB_URL };
    await rereadDetails(client);
    await waitFor(() =>
      expect(hook.result.current.diff.data).toBe(textOf(H1, "main")),
    );
    expect(hook.result.current.diff.headUnnamed).toBe(false);
  });

  it("P6: a Bitbucket record's abbreviated head reads by number and is never held", async () => {
    named = {
      headSha: "abcdef123456",
      baseRefName: "main",
      baseSha: null,
      url: BITBUCKET_URL,
    };
    const text = deferred<string>();
    vi.mocked(forgePrDiff).mockImplementationOnce(() => text.promise);
    const { hook } = mount();
    expect(hook.result.current.diff.headProving).toBe(false);
    await waitFor(() => expect(forgePrDiff).toHaveBeenCalledTimes(1));
    expect(hook.result.current.diff.headUnnamed).toBe(false);
    await act(async () => text.resolve("by-number text"));
    await waitFor(() =>
      expect(hook.result.current.diff.data).toBe("by-number text"),
    );
    expect(forgePrDiffAt).not.toHaveBeenCalled();
    expect(hook.result.current.diff.headUnproven).toBe(false);
    expect(hook.result.current.diff.headUnnamed).toBe(false);
    expect(hook.result.current.diff.headProving).toBe(false);
  });

  for (const [list, flags] of [
    ["a truncated", { commitsUnknown: true, commitsTruncated: true }],
    ["an unknown", { commitsUnknown: true, commitsTruncated: false }],
  ] as const)
    it(`Q1: a GitHub record with no head and ${list} commits list never names the list's tail`, async () => {
      named = {
        headSha: "",
        baseRefName: "main",
        baseSha: B1,
        url: "https://github.com/o/r/pull/7",
        commits: [{ oid: H2 }, { oid: H1 }],
        ...flags,
      };
      const { hook } = mount();
      await waitFor(() =>
        expect(hook.result.current.diff.data).toBe("by-number text"),
      );
      expect(hook.result.current.diff.headUnnamed).toBe(true);
      expect(hook.result.current.diff.headUnproven).toBe(true);
      expect(forgePrDiffAt).not.toHaveBeenCalled();
      expect(forgePrHeadProof).not.toHaveBeenCalled();
    });

  it("Q1: a complete commits list still names its tail as the head", async () => {
    named = {
      headSha: "",
      baseRefName: "main",
      baseSha: B1,
      url: "https://github.com/o/r/pull/7",
      commits: [{ oid: H2 }, { oid: H1 }],
      commitsUnknown: false,
      commitsTruncated: false,
    };
    const { hook } = mount();
    await waitFor(() =>
      expect(hook.result.current.diff.data).toBe(textOf(H1, "main")),
    );
    expect(diffAtTargets()[0]?.head).toBe(H1);
    expect(hook.result.current.diff.headUnnamed).toBe(false);
    expect(hook.result.current.diff.headUnproven).toBe(false);
  });

  it("A4: a details answer differing only in OID case keeps the key, and the commands get lowercase ids", async () => {
    const mixed = "ABCDEF0123".repeat(4);
    named = { headSha: mixed, baseRefName: "Main", baseSha: B1.toUpperCase() };
    const { client, hook } = mount();
    await waitFor(() => expect(hook.result.current.diff.data).toBeDefined());
    expect(diffAtTargets()[0]).toEqual({
      head: mixed.toLowerCase(),
      baseRef: "Main",
      baseSha: B1,
    });
    named = { headSha: mixed.toLowerCase(), baseRefName: "Main", baseSha: B1 };
    await rereadDetails(client);
    await sleep(30);
    expect(forgePrDiffAt).toHaveBeenCalledTimes(1);
    // A branch name stays exact: a case change there is another base.
    named.baseRefName = "main";
    await rereadDetails(client);
    await waitFor(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(2));
  });
});
/** The diff run's own head read fails, so nothing it reads can prove. */
const headReadFails = () =>
  proofs.push(() => Promise.reject(new Error("head read failed")));

const proofOf = (client: QueryClient, target = targetNow()) =>
  client.getQueryData<PrDiffRead>(diffKey(target))?.proof;

/** The entry's moved-check count, 0 when it isn't moved. */
const checksOf = (client: QueryClient, target = targetNow()) => {
  const read = client.getQueryData<PrDiffRead>(diffKey(target));
  return read?.proof === "moved" ? read.checks : 0;
};

/** Long enough for both re-checks of a moved answer. */
const CHECK_SPAN = PR_DIFF_MOVED_RECHECK_MS + 2000;

describe("an unproven answer (AC-U*)", () => {
  it("AC-U1/U2: the run's own head read, naming the same target, proves it before it is filed", async () => {
    answers.push(answer("unproven"));
    const head = deferred<string>();
    proofs.push(() => head.promise);
    const { hook } = mount();
    await waitFor(() => expect(forgePrHeadProof).toHaveBeenCalledTimes(1));
    expect(vi.mocked(forgePrHeadProof).mock.calls[0]?.[3]).toEqual({
      head: H1,
      baseRef: "main",
      baseSha: B1,
    });
    expect(hook.result.current.diff.data).toBeUndefined();
    await act(async () => head.resolve("proven"));
    await waitFor(() =>
      expect(hook.result.current.diff.data).toBe(textOf(H1, "main")),
    );
    expect(hook.result.current.diff.headUnproven).toBe(false);
    expect(hook.result.current.diff.placeholderOf).toBe("none");
    expect(forgePrDiffAt).toHaveBeenCalledTimes(1);
    // The proof never reads the display view: only the details did.
    expect(forgePrView).toHaveBeenCalledTimes(1);
  });

  it("AC-U2: a failed head read files the text unproven and holds", async () => {
    answers.push(answer("unproven"));
    views.push(async () => detailsNow());
    headReadFails();
    const { hook } = mount();
    await waitFor(() =>
      expect(hook.result.current.diff.headUnproven).toBe(true),
    );
    expect(hook.result.current.diff.data).toBe(textOf(H1, "main"));
    expect(hook.result.current.diff.isError).toBe(false);
    expect(hook.result.current.diff.isPlaceholderData).toBe(false);
  });

  it("N1: no cache event proves: a reused data-less details fetch, a cached restart, a queued success and a manual write all leave the entry unproven", async () => {
    const { client } = newClient();
    // A data-less details fetch in flight before the diff read starts.
    const outside = deferred<PrDetails>();
    views.push(() => outside.promise);
    const outsideRun = client.fetchQuery(prDetailsOptions(REPO, 7, "origin"));
    const outsideAnswer = detailsNow();
    await waitFor(() => expect(forgePrView).toHaveBeenCalledTimes(1));
    answers.push(answer("unproven"));
    const read = deferred<PrDiffAt>();
    answers.unshift(() => read.promise);
    headReadFails();
    const run = client.fetchQuery(
      prDiffOptions(REPO, 7, "origin", targetNow()),
    );
    await waitFor(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(1));
    // Queued in the same task as the diff answer.
    await act(async () => {
      read.resolve(await answer("unproven")());
      outside.resolve(outsideAnswer);
    });
    await act(() => run);
    expect(proofOf(client)).toBe("unproven");
    // The outside waiter is never cancelled: it gets its own answer.
    await expect(outsideRun).resolves.toEqual(outsideAnswer);
    // A cached restart, a fresh fetch success and a manual write.
    await act(() =>
      client.refetchQueries({ queryKey: detailsKey, exact: true }),
    );
    await act(() =>
      client.fetchQuery({
        ...prDetailsOptions(REPO, 7, "origin"),
        staleTime: 0,
      }),
    );
    act(() => {
      client.setQueryData(detailsKey, detailsNow());
    });
    await sleep(30);
    expect(proofOf(client)).toBe("unproven");
    expect(forgePrDiffAt).toHaveBeenCalledTimes(1);
  });

  it("N2: the head read starts only after the diff read answered", async () => {
    const log: string[] = [];
    const read = deferred<PrDiffAt>();
    answers.push(() => read.promise);
    proofs.push(async () => {
      log.push("head read");
      return "proven";
    });
    const { client } = newClient();
    const run = client.fetchQuery(
      prDiffOptions(REPO, 7, "origin", targetNow()),
    );
    await waitFor(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(1));
    await sleep(20);
    expect(log).toEqual([]);
    log.push("diff answered");
    await act(async () => read.resolve(await answer("unproven")()));
    await act(() => run);
    expect(log).toEqual(["diff answered", "head read"]);
    expect(proofOf(client)).toBe("proven");
  });

  it("AC-U3: an unproven entry is stale at once, and Refresh's proven answer clears it", async () => {
    answers.push(answer("unproven"));
    views.push(async () => detailsNow());
    headReadFails();
    const { client, hook } = mount();
    await waitFor(() =>
      expect(hook.result.current.diff.headUnproven).toBe(true),
    );
    expect(client.getQueryState(diffKey())?.isInvalidated).toBe(false);
    await act(() => refreshOpenPr(client, REPO, "origin", 7));
    await waitFor(() =>
      expect(hook.result.current.diff.headUnproven).toBe(false),
    );
    // Settled: nothing re-reads a proven entry on its own.
    await sleep(200);
    const calls = vi.mocked(forgePrDiffAt).mock.calls.length;
    // 2 or 3: the details answer's own re-read of the unproven entry can start
    // before Refresh's exact diff invalidation, which cancels it and reads again.
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(calls).toBeLessThanOrEqual(3);
  });

  it("AC-U3: a details answer over an unproven entry reads the diff again", async () => {
    answers.push(answer("unproven"), answer("unproven"));
    views.push(async () => detailsNow());
    headReadFails();
    const { client, hook } = mount();
    await waitFor(() =>
      expect(hook.result.current.diff.headUnproven).toBe(true),
    );
    // The second run's head read answers the same target.
    await rereadDetails(client);
    await waitFor(() =>
      expect(hook.result.current.diff.headUnproven).toBe(false),
    );
    expect(forgePrDiffAt).toHaveBeenCalledTimes(2);
  });

  it("AC-U3: a fetch of an unproven entry reads again at once; a proven entry's is served from the cache", async () => {
    headReadFails();
    answers.push(answer("unproven"));
    const { client } = newClient();
    const options = prDiffOptions(REPO, 7, "origin", targetNow());
    await act(() => client.fetchQuery(options));
    expect(proofOf(client)).toBe("unproven");
    await act(() => client.fetchQuery(options));
    expect(forgePrDiffAt).toHaveBeenCalledTimes(2);
    expect(proofOf(client)).toBe("proven");
    await act(() => client.fetchQuery(options));
    expect(forgePrDiffAt).toHaveBeenCalledTimes(2);
  });

  it("AC-C1: an unknown proof string holds as unproven", async () => {
    answers.push(answer("maybe"));
    views.push(async () => detailsNow());
    headReadFails();
    const { hook } = mount();
    await waitFor(() =>
      expect(hook.result.current.diff.data).toBe(textOf(H1, "main")),
    );
    expect(hook.result.current.diff.headUnproven).toBe(true);
  });

  it("AC-C3: the raw entry's readers get the text, and a moved entry's throws", async () => {
    const { client } = newClient();
    const read = await client.ensureQueryData(
      prDiffOptions(REPO, 7, "origin", targetNow()),
    );
    expect(prDiffText(read)).toBe(textOf(H1, "main"));
    expect(() =>
      prDiffText({ proof: "moved", text: "kept", checks: 1, recheckAt: 0 }),
    ).toThrow(PrDiffMovedError);
  });
});

describe("a moved answer (AC-M*)", () => {
  // The check's clock is the test's: the deadline, the re-checks and
  // `performance.now()` move only when the test advances them.
  beforeEach(() => vi.useFakeTimers());

  /** Mounted over a proven text, then a refetch whose answers are `then`. */
  async function movedOverText(...then: (() => Promise<PrDiffAt>)[]) {
    const ctx = mount();
    await until(() =>
      expect(ctx.hook.result.current.diff.data).toBe(textOf(H1, "main")),
    );
    const earlier = ctx.hook.result.current.diff.data;
    answers.push(answer("moved", "another head's text"), ...then);
    act(() => {
      void ctx.client.refetchQueries({ queryKey: diffKey(), exact: true });
    });
    await until(() =>
      expect(ctx.hook.result.current.diff.headChecking).toBe(true),
    );
    return { ...ctx, earlier };
  }

  it("AC-M1/M3: the check keeps the text own, never files the moved text, and a proven re-check at the deadline clears it", async () => {
    const held = deferred<PrDiffAt>();
    const { hook, client, earlier } = await movedOverText(() => held.promise);
    const shown = hook.result.current;
    expect(shown.diff.data).toBe(earlier);
    expect(client.getQueryData<PrDiffRead>(diffKey())?.text).toBe(earlier);
    expect(shown.diff.isPlaceholderData).toBe(false);
    expect(shown.diff.placeholderOf).toBe("none");
    expect(shown.diff.isError).toBe(false);
    expect(shown.diff.headUnproven).toBe(false);
    await until(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(3));
    expect(hook.result.current.diff.headChecking).toBe(true);
    // The 50 ms re-check (call 3) started before the settle deadline: its
    // proven answer never decides, and the deadline run (call 4) does.
    answers.push(answer("proven", "proven"));
    await act(async () => held.resolve(await answer("proven", "early")()));
    expect(hook.result.current.diff.headChecking).toBe(true);
    expect(hook.result.current.diff.data).toBe(earlier);
    expect(forgePrDiffAt).toHaveBeenCalledTimes(3);
    expect(answers).toHaveLength(1);
    await until(() => expect(hook.result.current.diff.data).toBe("proven"), {
      timeout: CHECK_SPAN,
    });
    expect(forgePrDiffAt).toHaveBeenCalledTimes(4);
    expect(hook.result.current.diff.headChecking).toBe(false);
    expect(hook.result.current.diff.headUnproven).toBe(false);
  });

  it("AC-M1: three moved answers end the check over the text: no failure, held as unproven", async () => {
    const { hook, client, earlier } = await movedOverText(
      answer("moved", "a third text"),
      answer("moved", "a fourth text"),
      answer("moved", "a fifth text"),
    );
    await until(
      () => expect(hook.result.current.diff.headUnproven).toBe(true),
      { timeout: CHECK_SPAN },
    );
    const shown = hook.result.current.diff;
    expect(shown.headChecking).toBe(false);
    expect(shown.data).toBe(earlier);
    expect(shown.isError).toBe(false);
    expect(shown.error).toBeNull();
    expect(shown.placeholderOf).toBe("none");
    expect(client.getQueryData<PrDiffRead>(diffKey())?.text).toBe(earlier);
  });

  it("R14: moved, moved, then a proven answer after the delay shows the proven text", async () => {
    const { hook, client } = await movedOverText(
      answer("moved", "a third text"),
      answer("proven", "the proven text"),
    );
    // Call 2 filed check 1 and the 50 ms re-check (call 3) took the third text.
    await until(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(3));
    await until(() => expect(checksOf(client)).toBe(2));
    expect(answers).toHaveLength(1);
    await sleep(PR_DIFF_MOVED_RECHECK_MS / 2);
    // Still inside the delay: no third check yet, and the hold reads checking.
    expect(forgePrDiffAt).toHaveBeenCalledTimes(3);
    expect(hook.result.current.diff.headChecking).toBe(true);
    expect(hook.result.current.diff.isFetching).toBe(true);
    await until(
      () => expect(hook.result.current.diff.data).toBe("the proven text"),
      { timeout: CHECK_SPAN },
    );
    expect(hook.result.current.diff.headChecking).toBe(false);
    expect(hook.result.current.diff.headUnproven).toBe(false);
    expect(forgePrDiffAt).toHaveBeenCalledTimes(4);
  });

  it("B2: a refetch of a terminal moved entry keeps the hold while it runs, and a proven answer clears it", async () => {
    const { hook, client } = await movedOverText(
      answer("moved", "x"),
      answer("moved", "y"),
      answer("moved", "z"),
    );
    await until(
      () => expect(hook.result.current.diff.headUnproven).toBe(true),
      { timeout: CHECK_SPAN },
    );
    const held = deferred<PrDiffAt>();
    answers.push(() => held.promise);
    act(() => {
      void client.refetchQueries({ queryKey: diffKey(), exact: true });
    });
    await until(() => expect(hook.result.current.diff.isFetching).toBe(true));
    expect(hook.result.current.diff.headUnproven).toBe(true);
    await act(async () => held.resolve(await answer("proven")()));
    await until(() =>
      expect(hook.result.current.diff.headUnproven).toBe(false),
    );
  });

  it("AC-M1: the check's end re-reads the details, and a new target there re-keys the view", async () => {
    const { hook } = await movedOverText(
      answer("moved", "x"),
      answer("moved", "y"),
    );
    named.headSha = H2;
    await until(
      () => expect(hook.result.current.diff.data).toBe(textOf(H2, "main")),
      { timeout: CHECK_SPAN },
    );
    // The mount, the moved refetch, the 50 ms re-check (x) and the deadline run
    // (y) read H1; only the ended check's details re-read re-keys onto H2.
    expect(diffAtTargets().map((t) => t.head)).toEqual([H1, H1, H1, H1, H2]);
    expect(answers).toHaveLength(0);
    expect(hook.result.current.diff.headUnproven).toBe(false);
  });

  it("AC-M2: a cold read moved three times loads through the check, then ends on the failed-read arm with M2", async () => {
    answers.push(
      answer("moved", ""),
      answer("moved", ""),
      answer("moved", ""),
      answer("moved", ""),
    );
    const { hook } = mount();
    await until(() => expect(hook.result.current.diff.headChecking).toBe(true));
    const during = hook.result.current.diff;
    expect(during.data).toBeUndefined();
    expect(during.isPending).toBe(true);
    expect(during.isError).toBe(false);
    await until(() => expect(hook.result.current.diff.isError).toBe(true), {
      timeout: CHECK_SPAN,
    });
    const ended = hook.result.current.diff;
    expect(ended.data).toBeUndefined();
    expect(ended.isPending).toBe(false);
    expect(ended.headChecking).toBe(false);
    expect(ended.error).toBeInstanceOf(PrDiffMovedError);
    expect((ended.error as Error).message).toBe(M2);
    expect(ended.headUnproven).toBe(true);
    const calls = vi.mocked(forgePrDiffAt).mock.calls.length;
    await sleep(PR_DIFF_MOVED_RECHECK_MS + 200);
    expect(forgePrDiffAt).toHaveBeenCalledTimes(calls);
  });

  it("R9: a new head's ended moved check over the older head's retained text keeps the failed-read arm", async () => {
    const { client, hook } = mount();
    await until(() =>
      expect(hook.result.current.diff.data).toBe(textOf(H1, "main")),
    );
    named.headSha = H2;
    answers.push(
      answer("moved", ""),
      answer("moved", ""),
      answer("moved", ""),
      answer("moved", ""),
    );
    await rereadDetails(client);
    await until(() => expect(hook.result.current.diff.headChecking).toBe(true));
    expect(hook.result.current.diff.placeholderOf).toBe("olderHead");
    await until(
      () =>
        expect(hook.result.current.diff.error).toBeInstanceOf(PrDiffMovedError),
      { timeout: CHECK_SPAN },
    );
    const shown = hook.result.current.diff;
    expect(shown.data).toBe(textOf(H1, "main"));
    expect(shown.placeholderOf).toBe("olderHead");
    expect(shown.isError).toBe(true);
    expect(shown.headChecking).toBe(false);
    expect(shown.headUnproven).toBe(false);
  });
});

describe("the moved check's lifetime (N*)", () => {
  // The check's clock is the test's: the deadline, the re-checks and
  // `performance.now()` move only when the test advances them.
  beforeEach(() => vi.useFakeTimers());

  it("N3: a cold moved hold survives a failed re-check and its Retry's start", async () => {
    // The read's own retry policy re-runs a failure once.
    const failed = () => Promise.reject(new Error("diff failed"));
    answers.push(answer("moved", ""), failed, failed);
    const { hook } = mount();
    await until(() => expect(hook.result.current.diff.isError).toBe(true), {
      timeout: CHECK_SPAN,
    });
    expect(hook.result.current.diff.headChecking).toBe(true);
    expect(hook.result.current.diff.isFetching).toBe(false);
    expect(forgePrDiffAt).toHaveBeenCalledTimes(3);
    // The interval stays off over the failure.
    await sleep(200);
    expect(forgePrDiffAt).toHaveBeenCalledTimes(3);
    const held = deferred<PrDiffAt>();
    answers.push(() => held.promise);
    act(() => {
      void hook.result.current.diff.refetch();
    });
    await until(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(4));
    expect(hook.result.current.diff.headChecking).toBe(true);
    await act(async () => held.resolve(await answer("proven")()));
    await until(() =>
      expect(hook.result.current.diff.headChecking).toBe(false),
    );
  });

  it("N4: leaving the pull request stops the check", async () => {
    answers.push(answer("moved", ""), answer("moved", ""), answer("moved", ""));
    const { hook } = mount();
    await until(() => expect(hook.result.current.diff.headChecking).toBe(true));
    const before = vi.mocked(forgePrDiffAt).mock.calls.length;
    const viewsBefore = vi.mocked(forgePrView).mock.calls.length;
    hook.unmount();
    await sleep(PR_DIFF_MOVED_RECHECK_MS + 300);
    expect(forgePrDiffAt).toHaveBeenCalledTimes(before);
    expect(forgePrView).toHaveBeenCalledTimes(viewsBefore);
  });

  it("N5: offline, the check parks with nothing sent, and resumes on reconnect", async () => {
    answers.push(answer("moved", ""), answer("moved", ""));
    const { hook } = mount();
    await until(() => expect(hook.result.current.diff.headChecking).toBe(true));
    let before = 0;
    try {
      act(() => onlineManager.setOnline(false));
      await until(() => expect(hook.result.current.diff.isPaused).toBe(true), {
        timeout: CHECK_SPAN,
      });
      before = vi.mocked(forgePrDiffAt).mock.calls.length;
      await sleep(200);
      expect(forgePrDiffAt).toHaveBeenCalledTimes(before);
      expect(hook.result.current.diff.headChecking).toBe(true);
      expect(hook.result.current.diff.isFetching).toBe(false);
    } finally {
      act(() => onlineManager.setOnline(true));
    }
    await until(() =>
      expect(vi.mocked(forgePrDiffAt).mock.calls.length).toBe(before + 1),
    );
  });

  it("N6: another pull request's placeholder never stands in for a cold moved answer", async () => {
    const { wrapper } = newClient();
    const hook = renderHook(
      ({ number }) => {
        const read = usePrDetails(REPO, number, "origin");
        const target =
          read.data !== undefined && !read.isPlaceholderData
            ? prDiffTarget(read.data)
            : undefined;
        return usePrDiff(REPO, number, "origin", target);
      },
      { wrapper, initialProps: { number: 7 } },
    );
    await until(() =>
      expect(hook.result.current.data).toBe(textOf(H1, "main")),
    );
    answers.push(answer("moved", ""), answer("moved", ""));
    hook.rerender({ number: 8 });
    await until(() => expect(hook.result.current.headChecking).toBe(true));
    expect(hook.result.current.placeholderOf).toBe("none");
    expect(hook.result.current.data).toBeUndefined();
  });

  it("N7: a flapping replica re-reads no details before the check ends, and a proven answer keeps the key", async () => {
    named.headSha = H2;
    const { hook, client } = mount();
    await until(() =>
      expect(hook.result.current.diff.data).toBe(textOf(H2, "main")),
    );
    // Any details re-read now would answer the old replica's head.
    views.push(async () => ({ ...detailsNow(), headSha: H1 }) as PrDetails);
    answers.push(
      answer("moved", "old"),
      answer("moved", "old"),
      answer("moved", "old"),
      answer("proven", "settled"),
    );
    act(() => {
      void hook.result.current.diff.refetch();
    });
    await until(() => expect(checksOf(client)).toBe(2));
    // A focus or refresh read lands inside the delay: it refreshes the second
    // check, never counts as the third, and asks the details nothing.
    await act(() =>
      client.refetchQueries({ queryKey: diffKey(), exact: true }),
    );
    expect(forgePrDiffAt).toHaveBeenCalledTimes(4);
    expect(checksOf(client)).toBe(2);
    expect(hook.result.current.diff.headChecking).toBe(true);
    await until(() => expect(hook.result.current.diff.data).toBe("settled"), {
      timeout: CHECK_SPAN,
    });
    expect(forgePrView).toHaveBeenCalledTimes(1);
    expect(diffAtTargets().every((t) => t.head === H2)).toBe(true);
  });

  it("N8: the diff read subscribes to no cache and writes no diff key", () => {
    const source = prsSource;
    const region = (text: string) => {
      const start = text.indexOf("export type PrDiffRead");
      const end = text.indexOf("export function usePrDetails(");
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return text.slice(start, end);
    };
    // A signal read by member, or by a destructured binding or parameter.
    const offending = (text: string) =>
      /\.subscribe\(|setQueryData|setQueriesData|setTimeout|\.signal\b|\{[^}]*\bsignal\b[^}]*\}\s*[=)]/.test(
        region(text),
      );
    expect(offending(source)).toBe(false);
    for (const [from, to] of [
      [
        "const startedAt = performance.now();",
        "const { signal } = context;\n      const startedAt = performance.now();",
      ],
      [
        "async (context): Promise<PrDiffRead>",
        "async ({ client, signal }): Promise<PrDiffRead>",
      ],
    ]) {
      const destructured = source.replace(from, to);
      expect(destructured).not.toBe(source);
      expect(offending(destructured)).toBe(true);
    }
    // The in-memory control: one subscription in the queryFn is caught.
    const mutated = source.replace(
      "const answer = await api.forgePrDiffAt(",
      "context.client.getQueryCache().subscribe(() => undefined);\n      const answer = await api.forgePrDiffAt(",
    );
    expect(mutated).not.toBe(source);
    expect(offending(mutated)).toBe(true);
  });
});

describe("what a run's own head read can prove (E*, T10)", () => {
  const H3 = "3".repeat(40);
  const run = (client: QueryClient) =>
    client.fetchQuery(prDiffOptions(REPO, 7, "origin", targetNow()));

  for (const [wire, filed] of [
    ["proven", "proven"],
    ["unproven", "unproven"],
    ["maybe", "unproven"],
    ["rejected", "unproven"],
  ] as const)
    it(`E1: a head proof answering ${wire} files ${filed}, and the display view is never read for it`, async () => {
      answers.push(answer("unproven"));
      proofs.push(() =>
        wire === "rejected"
          ? Promise.reject(new Error("down"))
          : Promise.resolve(wire),
      );
      const { client } = newClient();
      await expect(run(client)).resolves.toMatchObject({ proof: filed });
      expect(forgePrHeadProof).toHaveBeenCalledTimes(1);
      expect(forgePrView).not.toHaveBeenCalled();
    });

  for (const [view, change] of [
    ["an empty commits list and no head", () => ({ headSha: "" })],
    ["no base sha", () => ({ baseSha: null })],
  ] as const)
    it(`N3: a details view with ${view} arriving mid-proof never files moved`, async () => {
      answers.push(answer("unproven"));
      const head = deferred<string>();
      proofs.push(() => head.promise);
      const { client } = newClient();
      const target = targetNow();
      const read = client.fetchQuery(prDiffOptions(REPO, 7, "origin", target));
      await waitFor(() => expect(forgePrHeadProof).toHaveBeenCalledTimes(1));
      Object.assign(named, change());
      await act(() =>
        client.fetchQuery({
          ...prDetailsOptions(REPO, 7, "origin"),
          staleTime: 0,
        }),
      );
      await act(async () => head.resolve("proven"));
      await expect(read).resolves.toMatchObject({ proof: "proven" });
    });

  it("T10: a head proof answering moved files no text", async () => {
    answers.push(answer("unproven", "the other target's text"));
    proofs.push(async () => "moved");
    const { client } = newClient();
    const read = await run(client);
    expect(read).toEqual({
      proof: "moved",
      text: null,
      checks: 1,
      recheckAt: expect.any(Number),
    });
    expect(client.getQueryData<PrDiffRead>(diffKey())?.text).toBeNull();
  });

  it("E3: a superseded run's late moved answer never asks the details to re-read", async () => {
    vi.useFakeTimers();
    const ctx = mount();
    await until(() =>
      expect(ctx.hook.result.current.diff.data).toBe(textOf(H1, "main")),
    );
    const late = deferred<PrDiffAt>();
    const replacement = deferred<PrDiffAt>();
    answers.push(
      answer("moved", "x"),
      answer("moved", "y"),
      () => late.promise,
      () => replacement.promise,
    );
    act(() => {
      void ctx.client.refetchQueries({ queryKey: diffKey(), exact: true });
    });
    // The delayed check is in flight; an exact refetch supersedes it.
    await until(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(4), {
      timeout: CHECK_SPAN,
    });
    act(() => {
      void ctx.client.refetchQueries({ queryKey: diffKey(), exact: true });
    });
    await until(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(5));
    await act(async () => late.resolve(await answer("moved", "z")()));
    await sleep(30);
    await act(async () => replacement.resolve(await answer("proven", "ok")()));
    await until(() => expect(ctx.hook.result.current.diff.data).toBe("ok"));
    await sleep(30);
    expect(forgePrView).toHaveBeenCalledTimes(1);
  });

  it("E4: a Retry over an ended textless check re-reads the details, so a real push re-keys", async () => {
    vi.useFakeTimers();
    try {
      // Calls 1-3 run the check; the ended check's details re-read answers
      // anew, so call 4 re-reads the held entry.
      answers.push(
        answer("moved", ""),
        answer("moved", ""),
        answer("moved", ""),
        answer("moved", ""),
      );
      const { hook } = mount();
      await until(() => expect(hook.result.current.diff.isError).toBe(true), {
        timeout: CHECK_SPAN,
      });
      await until(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(4));
      await until(() => expect(forgePrView).toHaveBeenCalledTimes(2));
      expect(answers).toHaveLength(0);
      expect(hook.result.current.diff.isError).toBe(true);
      named.headSha = H2;
      act(() => {
        void hook.result.current.diff.refetch();
      });
      // Later reads answer proven for their own target.
      await until(() =>
        expect(hook.result.current.diff.data).toBe(textOf(H2, "main")),
      );
      expect(forgePrView).toHaveBeenCalledTimes(3);
      expect(diffAtTargets().at(-1)?.head).toBe(H2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("E5: a second re-key over this record's textless entry keeps the last drawable text and its older-head hold", async () => {
    vi.useFakeTimers();
    const { client, hook } = mount();
    await until(() =>
      expect(hook.result.current.diff.data).toBe(textOf(H1, "main")),
    );
    named.headSha = H2;
    answers.push(answer("moved", ""), answer("moved", ""));
    await rereadDetails(client);
    await until(() => expect(checksOf(client)).toBe(2));
    expect(hook.result.current.diff.placeholderOf).toBe("olderHead");
    const held = deferred<PrDiffAt>();
    answers.push(() => held.promise);
    named.headSha = H3;
    await rereadDetails(client);
    await until(() => expect(diffAtTargets().at(-1)?.head).toBe(H3));
    const shown = hook.result.current.diff;
    expect(shown.data).toBe(textOf(H1, "main"));
    expect(shown.placeholderOf).toBe("olderHead");
    expect(shown.isPlaceholderData).toBe(true);
    await act(async () => held.resolve(await answer("proven")()));
    await until(() =>
      expect(hook.result.current.diff.data).toBe(textOf(H3, "main")),
    );
    expect(hook.result.current.diff.placeholderOf).toBe("none");
  });

  it("E6: a cold full head's read reports its proof under way until the run's own head read answers", async () => {
    answers.push(answer("unproven"));
    const head = deferred<string>();
    proofs.push(() => head.promise);
    const { hook } = mount();
    await waitFor(() => expect(forgePrHeadProof).toHaveBeenCalledTimes(1));
    expect(hook.result.current.diff.headProving).toBe(true);
    await act(async () => head.resolve("proven"));
    await waitFor(() =>
      expect(hook.result.current.diff.headProving).toBe(false),
    );
    expect(hook.result.current.diff.data).toBe(textOf(H1, "main"));
  });
});

describe("the settle deadline and the ended check's hint (G*, T13, T14)", () => {
  const H3 = "3".repeat(40);
  const OLD = textOf(H1, "main");
  const readOf = (client: QueryClient, target = targetNow()) =>
    client.getQueryData<PrDiffRead>(diffKey(target));
  const deadlineOf = (client: QueryClient) => {
    const read = readOf(client);
    return read?.proof === "moved" ? read.recheckAt : undefined;
  };
  /** The ended check's hints: exact invalidations of the details. */
  const detailsHints = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter(([f]) => {
      const filters = f as { queryKey?: unknown; exact?: boolean } | undefined;
      return (
        filters?.exact === true &&
        JSON.stringify(filters.queryKey) === JSON.stringify(detailsKey)
      );
    }).length;
  /** What an early run may read off a replica flipping back after a push. */
  const early = {
    proven: answer("proven", "a flipped-back text"),
    unproven: answer("unproven", "a flipped-back text"),
    moved: answer("moved", "another text"),
  } as const;

  /** Over H1's proven text, a moved answer files check 1; its 50 ms re-check
   *  is the held run. Runs on fake timers (`vi.useFakeTimers()`, driven by
   *  the `until` and `sleep` helpers). */
  async function atCheckOne() {
    vi.useFakeTimers();
    const ctx = mount();
    await until(() => expect(ctx.hook.result.current.diff.data).toBe(OLD));
    const hints = vi.spyOn(ctx.client, "invalidateQueries");
    const run = deferred<PrDiffAt>();
    answers.push(answer("moved", "another head's text"), () => run.promise);
    act(() => {
      void ctx.client.refetchQueries({ queryKey: diffKey(), exact: true });
    });
    await until(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(3));
    expect(checksOf(ctx.client)).toBe(1);
    const deadline = deadlineOf(ctx.client) ?? 0;
    expect(deadline).toBeGreaterThan(performance.now());
    return { ...ctx, hints, run, deadline };
  }

  /** Check 2 filed by the 50 ms re-check, then an early refetch held. */
  async function atCheckTwo() {
    const ctx = await atCheckOne();
    await act(async () => ctx.run.resolve(await answer("moved", "x")()));
    await until(() => expect(checksOf(ctx.client)).toBe(2));
    const run = deferred<PrDiffAt>();
    answers.push(() => run.promise);
    act(() => {
      void ctx.client.refetchQueries({ queryKey: diffKey(), exact: true });
    });
    await until(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(4));
    return { ...ctx, run };
  }

  for (const [at, reach] of [
    ["check 1", atCheckOne],
    ["check 2", atCheckTwo],
  ] as const)
    for (const kind of ["proven", "unproven", "moved"] as const)
      it(`G1: at ${at}, an early run answering ${kind} stays moved under the same deadline, with no hint and the controls held`, async () => {
        const ctx = await reach();
        // An unproven answer stays unproven only when the run's head read fails.
        if (kind === "unproven") headReadFails();
        await act(async () => ctx.run.resolve(await early[kind]()));
        await until(() => expect(checksOf(ctx.client)).toBe(2));
        expect(performance.now()).toBeLessThan(ctx.deadline);
        expect(readOf(ctx.client)).toEqual({
          proof: "moved",
          text: OLD,
          checks: PR_DIFF_MOVED_CHECKS - 1,
          recheckAt: ctx.deadline,
        });
        const shown = ctx.hook.result.current.diff;
        expect(shown.headChecking).toBe(true);
        expect(shown.headUnproven).toBe(false);
        expect(shown.data).toBe(OLD);
        expect(detailsHints(ctx.hints)).toBe(0);
      });

  it("G1: the first run started at or after the deadline decides, and a proven answer settles", async () => {
    const ctx = await atCheckOne();
    await act(async () => ctx.run.resolve(await early.proven()));
    await until(() => expect(checksOf(ctx.client)).toBe(2));
    let decidedAt = 0;
    answers.push(() => {
      decidedAt = performance.now();
      return answer("proven", "settled")();
    });
    await until(
      () => expect(ctx.hook.result.current.diff.data).toBe("settled"),
      { timeout: CHECK_SPAN },
    );
    expect(decidedAt).toBeGreaterThanOrEqual(ctx.deadline);
    expect(proofOf(ctx.client)).toBe("proven");
    expect(ctx.hook.result.current.diff.headChecking).toBe(false);
    expect(detailsHints(ctx.hints)).toBe(0);
  });

  it("T14: the second check keeps its deadline across several early reads, flipped-back proven ones included", async () => {
    const ctx = await atCheckOne();
    await act(async () => ctx.run.resolve(await early.moved()));
    await until(() => expect(checksOf(ctx.client)).toBe(2));
    for (const kind of ["proven", "moved", "proven"] as const) {
      answers.push(early[kind]);
      await act(() =>
        ctx.client.refetchQueries({ queryKey: diffKey(), exact: true }),
      );
      expect(checksOf(ctx.client)).toBe(2);
      expect(deadlineOf(ctx.client)).toBe(ctx.deadline);
    }
    expect(performance.now()).toBeLessThan(ctx.deadline);
    expect(ctx.hook.result.current.diff.data).toBe(OLD);
    expect(detailsHints(ctx.hints)).toBe(0);
  });

  it("T18: an early run answering proven after the deadline stays moved until a run started after it settles", async () => {
    const ctx = await atCheckTwo();
    await sleep(ctx.deadline - performance.now() + 30);
    expect(performance.now()).toBeGreaterThan(ctx.deadline);
    const next = deferred<PrDiffAt>();
    answers.push(() => next.promise);
    await act(async () => ctx.run.resolve(await early.proven()));
    await until(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(5));
    expect(readOf(ctx.client)).toEqual({
      proof: "moved",
      text: OLD,
      checks: PR_DIFF_MOVED_CHECKS - 1,
      recheckAt: ctx.deadline,
    });
    expect(ctx.hook.result.current.diff.headChecking).toBe(true);
    expect(ctx.hook.result.current.diff.data).toBe(OLD);
    await act(async () => next.resolve(await answer("proven", "settled")()));
    await until(() =>
      expect(ctx.hook.result.current.diff.data).toBe("settled"),
    );
    expect(proofOf(ctx.client)).toBe("proven");
    expect(detailsHints(ctx.hints)).toBe(0);
  });

  it("Q3: a deadline whose remainder is fractional starts its read at or after it", async () => {
    const ctx = await atCheckOne();
    // The re-check answers 0.2 ms into a millisecond, so the remaining delay
    // is fractional and an integer timer would fire just short of it.
    await sleep(0.2);
    let startedAt = 0;
    answers.push(() => {
      startedAt = performance.now();
      return answer("proven", "settled")();
    });
    await act(async () => ctx.run.resolve(await early.moved()));
    await until(
      () => expect(ctx.hook.result.current.diff.data).toBe("settled"),
      { timeout: CHECK_SPAN },
    );
    expect(startedAt).toBeGreaterThanOrEqual(ctx.deadline);
    expect(forgePrDiffAt).toHaveBeenCalledTimes(4);
  });

  it("H3: a wall-clock step between check 1 and its re-check spends none of the settle delay", async () => {
    vi.useFakeTimers();
    const ctx = mount();
    await until(() => expect(ctx.hook.result.current.diff.data).toBe(OLD));
    const realNow = Date.now.bind(Date);
    let step = 0;
    const clock = vi
      .spyOn(Date, "now")
      .mockImplementation(() => realNow() + step);
    // The step lands as check 1 is filed, before its 50 ms re-check starts.
    const stop = ctx.client.getQueryCache().subscribe((event) => {
      const read = event.query.state.data as PrDiffRead | undefined;
      if (read?.proof === "moved" && read.checks === 1) step = 60_000;
    });
    try {
      answers.push(answer("moved", "another head's text"), early.proven);
      act(() => {
        void ctx.client.refetchQueries({ queryKey: diffKey(), exact: true });
      });
      await until(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(3));
      await until(() => expect(checksOf(ctx.client)).toBe(2));
      expect(step).toBe(60_000);
      const read = readOf(ctx.client);
      expect(read).toMatchObject({ proof: "moved", text: OLD });
      expect(ctx.hook.result.current.diff.headChecking).toBe(true);
      expect(ctx.hook.result.current.diff.data).toBe(OLD);
    } finally {
      stop();
      clock.mockRestore();
    }
  });

  it("G2: a delayed check parked past its deadline schedules no interval while it waits", async () => {
    vi.useFakeTimers();
    const off: (() => void)[] = [];
    try {
      const { client } = newClient();
      answers.push(answer("moved", ""), answer("moved", ""));
      const observer = new QueryObserver(
        client,
        prDiffOptions(REPO, 7, "origin", targetNow()),
      );
      off.push(observer.subscribe(() => undefined));
      await vi.advanceTimersByTimeAsync(100);
      expect(checksOf(client)).toBe(2);
      onlineManager.setOnline(false);
      const query = client
        .getQueryCache()
        .find({ queryKey: diffKey(), exact: true });
      expect(query).toBeDefined();
      const fetches = vi.spyOn(query as NonNullable<typeof query>, "fetch");
      await vi.advanceTimersByTimeAsync(PR_DIFF_MOVED_RECHECK_MS * 4);
      expect(query?.state.fetchStatus).toBe("paused");
      expect(fetches.mock.calls.length).toBeLessThanOrEqual(2);
      expect(forgePrDiffAt).toHaveBeenCalledTimes(2);
    } finally {
      for (const stop of off) stop();
      onlineManager.setOnline(true);
      vi.useRealTimers();
    }
  });

  it("G3: an ended check that landed with no view is claimed once by the first view to mount, after a later moved read", async () => {
    vi.useFakeTimers();
    const shared = newClient();
    const { client } = shared;
    await client.fetchQuery(prDetailsOptions(REPO, 7, "origin"));
    const options = prDiffOptions(REPO, 7, "origin", targetNow());
    answers.push(answer("moved", ""), answer("moved", ""));
    await client.fetchQuery(options);
    await client.fetchQuery(options);
    expect(checksOf(client)).toBe(2);
    await sleep(PR_DIFF_MOVED_RECHECK_MS + 50);
    answers.push(answer("moved", ""));
    await client.fetchQuery(options);
    const ended = readOf(client);
    const endedAt = ended?.proof === "moved" ? ended.endedAt : undefined;
    expect(checksOf(client)).toBe(PR_DIFF_MOVED_CHECKS);
    expect(endedAt).toBeGreaterThan(0);
    // A hover prefetch's later moved read keeps the ended check's id.
    await sleep(10);
    answers.push(answer("moved", ""));
    await client.fetchQuery(options);
    expect(readOf(client)).toMatchObject({
      checks: PR_DIFF_MOVED_CHECKS,
      endedAt,
    });
    const hints = vi.spyOn(client, "invalidateQueries");
    answers.push(answer("moved", ""), answer("moved", ""), answer("moved", ""));
    mount(shared);
    await until(() => expect(detailsHints(hints)).toBe(1));
    await sleep(300);
    expect(detailsHints(hints)).toBe(1);
  });

  it("T13: two views on one ended check ask the details once, and a remount over it asks nothing", async () => {
    vi.useFakeTimers();
    const shared = newClient();
    const first = mount(shared);
    const second = mount(shared);
    await until(() => expect(first.hook.result.current.diff.data).toBe(OLD));
    const hints = vi.spyOn(shared.client, "invalidateQueries");
    answers.push(...Array.from({ length: 8 }, () => answer("moved", "")));
    act(() => {
      void shared.client.refetchQueries({ queryKey: diffKey(), exact: true });
    });
    await until(
      () => expect(checksOf(shared.client)).toBe(PR_DIFF_MOVED_CHECKS),
      { timeout: CHECK_SPAN },
    );
    await until(() => expect(detailsHints(hints)).toBe(1));
    await sleep(100);
    expect(detailsHints(hints)).toBe(1);
    first.hook.unmount();
    second.hook.unmount();
    const third = mount(shared);
    await until(() =>
      expect(third.hook.result.current.diff.headUnproven).toBe(true),
    );
    await sleep(100);
    expect(detailsHints(hints)).toBe(1);
  });

  it("G8: a second check and a re-key landing in one batch keep the older head's text and its hold", async () => {
    // On the driven clock, the 50 ms re-check starts before the deadline.
    vi.useFakeTimers();
    const { client, hook } = mount();
    await until(() => expect(hook.result.current.diff.data).toBe(OLD));
    const two = deferred<PrDiffAt>();
    named.headSha = H2;
    const h2 = targetNow();
    answers.push(answer("moved", ""), () => two.promise);
    await rereadDetails(client);
    await until(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(3));
    expect(checksOf(client, h2)).toBe(1);
    expect(hook.result.current.diff.placeholderOf).toBe("olderHead");
    const held = deferred<PrDiffAt>();
    answers.push(() => held.promise);
    // No render between H2's second check and the details naming H3; the
    // clock stands still, so the check lands before the deadline.
    await act(async () => {
      two.resolve(await answer("moved", "")());
      for (let i = 0; i < 50 && checksOf(client, h2) !== 2; i++)
        await vi.advanceTimersByTimeAsync(0);
      named.headSha = H3;
      client.setQueryData(detailsKey, detailsNow());
    });
    expect(checksOf(client, h2)).toBe(2);
    await until(() => expect(diffAtTargets().at(-1)?.head).toBe(H3));
    const shown = hook.result.current.diff;
    expect(shown.data).toBe(OLD);
    expect(shown.placeholderOf).toBe("olderHead");
    expect(shown.headUnproven).toBe(false);
    await act(async () => held.resolve(await answer("proven")()));
    await until(() =>
      expect(hook.result.current.diff.data).toBe(textOf(H3, "main")),
    );
  });

  it("H2: a retargeted base's own patch and a re-key landing in one batch keep that patch as the older head's", async () => {
    const { client, hook } = mount();
    await waitFor(() => expect(hook.result.current.diff.data).toBe(OLD));
    const retarget = deferred<PrDiffAt>();
    answers.push(() => retarget.promise);
    named.baseRefName = "release";
    named.baseSha = B2;
    await rereadDetails(client);
    await waitFor(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(2));
    const held = deferred<PrDiffAt>();
    answers.push(() => held.promise);
    const patch = textOf(H1, "release");
    // No render between the retarget's own patch and the details naming H3.
    await act(async () => {
      retarget.resolve(await answer("proven", patch)());
      for (let i = 0; i < 50 && proofOf(client, targetNow()) !== "proven"; i++)
        await new Promise((resolve) => setTimeout(resolve, 0));
      named.headSha = H3;
      client.setQueryData(detailsKey, detailsNow());
    });
    await waitFor(() => expect(diffAtTargets().at(-1)?.head).toBe(H3));
    const shown = hook.result.current.diff;
    expect(shown.data).toBe(patch);
    expect(shown.isPlaceholderData).toBe(true);
    expect(shown.placeholderOf).toBe("olderHead");
    await act(async () => held.resolve(await answer("proven")()));
    await waitFor(() =>
      expect(hook.result.current.diff.data).toBe(textOf(H3, "release")),
    );
  });

  it("R1: text shown only as this record's older-head placeholder is kept when the next head's read fails", async () => {
    const { client, hook } = mount();
    await waitFor(() => expect(hook.result.current.diff.data).toBe(OLD));
    const retarget = deferred<PrDiffAt>();
    answers.push(() => retarget.promise);
    named.baseRefName = "release";
    named.baseSha = B2;
    await rereadDetails(client);
    await waitFor(() => expect(forgePrDiffAt).toHaveBeenCalledTimes(2));
    const held = deferred<PrDiffAt>();
    answers.push(() => held.promise);
    const patch = textOf(H1, "release");
    await act(async () => {
      retarget.resolve(await answer("proven", patch)());
      for (let i = 0; i < 50 && proofOf(client, targetNow()) !== "proven"; i++)
        await new Promise((resolve) => setTimeout(resolve, 0));
      named.headSha = H3;
      client.setQueryData(detailsKey, detailsNow());
    });
    await waitFor(() => expect(diffAtTargets().at(-1)?.head).toBe(H3));
    expect(hook.result.current.diff.data).toBe(patch);
    vi.mocked(forgePrDiffAt).mockImplementation(() =>
      Promise.reject(new Error("diff read failed")),
    );
    await act(async () => held.reject(new Error("diff read failed")));
    await waitFor(() => expect(hook.result.current.diff.isError).toBe(true), {
      timeout: 15_000,
    });
    const shown = hook.result.current.diff;
    expect(shown.data).toBe(patch);
    expect(shown.placeholderOf).toBe("olderHead");
    expect(shown.isPlaceholderData).toBe(true);
  });
});
