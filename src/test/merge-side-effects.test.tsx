import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgeIssueList,
  forgeIssueView,
  forgePrView,
  gitFetch,
} from "@/lib/git/api";
import {
  repoKeys,
  useIssueDetails,
  useIssueList,
  useMergePr,
  usePrDetails,
} from "@/lib/git/queries";
import { LIST_RECHECK_MS } from "@/lib/git/queries/push-writes";
import type {
  IssueDetails,
  IssueInfo,
  PrDetails,
  PrInfo,
} from "@/lib/git/types";
import { invoke } from "@/lib/tauri/invoke";

// The merge write runs through the real hook and the real api function and is
// answered at the wire: a test may not name it (scripts/
// remote-row-state-wiring.test.mjs), so it is recognised as the ONLY call that
// reaches the transport. Every read the hook can start is mocked by name below.
vi.mock("@/lib/tauri/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri/invoke")>()),
  invoke: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeIssueList: vi.fn(),
  forgeIssueView: vi.fn(),
  forgePrView: vi.fn(),
  // A landed merge fetches unawaited, then re-reads the whole repo once more.
  gitFetch: vi.fn(async () => undefined),
}));

/** One repo path per test: the delayed list re-read is per-repo module state. */
let repoSeq = 0;
let REPO = "";

const clients: QueryClient[] = [];

/** A stacked enqueue, one of the queued outcomes the backend returns; every
 *  queued result carries its cleanup warning. */
const QUEUED_OUTCOME = {
  queued: true,
  cleanupWarning:
    "Merging #13 was queued on GitHub and will land when the queue completes.",
  stacked: true,
};

/** A plain merge GitHub accepted but hadn't reported merged within the confirm
 *  wait: queued too, since it may be waiting in a merge queue. */
const UNCONFIRMED_OUTCOME = {
  queued: true,
  cleanupWarning:
    "GitHub accepted the merge of #13 but hasn't reported it merged yet, so the remote branch was left in place. It may be waiting in a merge queue.",
  stacked: false,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  repoSeq += 1;
  REPO = `C:/repos/merge-${repoSeq}`;
  vi.mocked(invoke).mockReset();
  answerMerge({ queued: false, cleanupWarning: null, stacked: true });
  vi.mocked(forgeIssueList).mockImplementation(async () => [issueRow(3)]);
  vi.mocked(forgeIssueView).mockImplementation(
    async (_repo, number) => ({ number }) as unknown as IssueDetails,
  );
  vi.mocked(forgePrView).mockImplementation(
    async (_repo, number) =>
      ({
        number,
        state: "OPEN",
        stack: null,
        stackMembers: [],
        membersUnknown: false,
      }) as unknown as PrDetails,
  );
  vi.mocked(gitFetch).mockImplementation(async () => undefined);
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.useRealTimers();
});

/** Answers the first wire call with `outcome` (or rejects with it), running
 *  `before` first, and rejects every later call: the merge is the only call
 *  that may reach the wire, and each case also asserts the count. */
function answerMerge(outcome: unknown, reject = false, before?: () => void) {
  let answered = false;
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    if (answered) throw new Error(`unexpected command: ${cmd}`);
    answered = true;
    before?.();
    if (reject) throw outcome;
    return outcome;
  });
}

const wireCalls = () => vi.mocked(invoke).mock.calls;

function issueRow(number: number): IssueInfo {
  return { number, state: "OPEN" } as unknown as IssueInfo;
}

const prRow = (number: number, state = "OPEN") =>
  ({ number, state }) as unknown as PrInfo;

/** A stack of three, bottom-first: #11 at 1, #12 at 2, #13 at 3. */
const STACK_ID = 5;
function members(states: [string, string, string] = ["open", "OPEN", "open"]) {
  return [
    { number: 11, position: 1, state: states[0] },
    { number: 12, position: 2, state: states[1] },
    { number: 13, position: 3, state: states[2] },
  ];
}

const detailsKey = (number: number, lens = "origin") =>
  ["repo", REPO, "pr", lens, number] as const;
const arrayPageKey = (lens: string) =>
  [...repoKeys.prList(REPO), lens, "open", 30, ""] as const;
const structPageKey = (lens: string) =>
  [...repoKeys.prList(REPO), lens, "open", 100, "", "page"] as const;

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const rows = () => [prRow(11), prRow(12), prRow(13), prRow(20)];
  client.setQueryData(arrayPageKey("origin"), rows());
  client.setQueryData(structPageKey("origin"), {
    rows: rows(),
    capped: false,
  });
  client.setQueryData(arrayPageKey("upstream"), rows());
  return client;
}

function seedDetails(
  client: QueryClient,
  number: number,
  stack: { id: string; position: number } | null,
  stackMembers: unknown,
  lens = "origin",
) {
  client.setQueryData(detailsKey(number, lens), {
    number,
    state: "OPEN",
    stack,
    stackMembers,
    membersUnknown: false,
  });
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function mountMerge(client: QueryClient) {
  return renderHook(() => useMergePr(REPO), { wrapper: wrapper(client) });
}

/** Lets every settle, the unawaited fetch's re-read included, land. */
const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });

async function merge(
  mergeHook: () => ReturnType<typeof useMergePr>,
  number: number,
  stack: number | null,
  lens: "origin" | "upstream" = "origin",
) {
  let result: unknown;
  let error: unknown;
  await act(async () => {
    mergeHook()
      .mutateAsync({
        number,
        lens,
        stack,
        strategy: "squash",
        deleteBranch: false,
      })
      .then(
        (r) => {
          result = r;
        },
        (e) => {
          error = e;
        },
      );
  });
  await flush();
  return { result, error };
}

/** The states the cached page holds for each number, in row order. */
function statesOf(page: unknown): Record<number, string> {
  const rows = Array.isArray(page)
    ? page
    : (page as { rows: PrInfo[] } | undefined)?.rows;
  return Object.fromEntries((rows ?? []).map((r) => [r.number, r.state]));
}

describe("a merge re-files the stack layers it took with it", () => {
  it("re-files the two lower layers in both page shapes of the lens, not another lens", async () => {
    const client = setup();
    seedDetails(client, 13, { id: String(STACK_ID), position: 3 }, members());
    const hook = mountMerge(client).result;
    const { result } = await merge(() => hook.current, 13, STACK_ID);
    expect(wireCalls()).toHaveLength(1);
    expect(wireCalls()[0][1]).toMatchObject({ number: 13, lens: "origin" });
    expect(result).toStrictEqual({
      queued: false,
      cleanupWarning: null,
      stacked: true,
      cascaded: [11, 12],
    });
    const merged = { 11: "MERGED", 12: "MERGED", 13: "MERGED", 20: "OPEN" };
    expect(statesOf(client.getQueryData(arrayPageKey("origin")))).toEqual(
      merged,
    );
    expect(statesOf(client.getQueryData(structPageKey("origin")))).toEqual(
      merged,
    );
    expect(statesOf(client.getQueryData(arrayPageKey("upstream")))).toEqual({
      11: "OPEN",
      12: "OPEN",
      13: "OPEN",
      20: "OPEN",
    });
  });

  it("merging the middle layer leaves the top open", async () => {
    const client = setup();
    seedDetails(client, 12, { id: String(STACK_ID), position: 2 }, members());
    const hook = mountMerge(client).result;
    await merge(() => hook.current, 12, STACK_ID);
    expect(wireCalls()).toHaveLength(1);
    expect(statesOf(client.getQueryData(structPageKey("origin")))).toEqual({
      11: "MERGED",
      12: "MERGED",
      13: "OPEN",
      20: "OPEN",
    });
  });

  it("a lower layer that is already closed is not re-filed", async () => {
    const client = setup();
    seedDetails(
      client,
      13,
      { id: String(STACK_ID), position: 3 },
      members(["closed", "open", "open"]),
    );
    const hook = mountMerge(client).result;
    const { result } = await merge(() => hook.current, 13, STACK_ID);
    expect(wireCalls()).toHaveLength(1);
    expect(result).toMatchObject({ cascaded: [12] });
    expect(statesOf(client.getQueryData(arrayPageKey("origin")))).toEqual({
      11: "OPEN",
      12: "MERGED",
      13: "MERGED",
      20: "OPEN",
    });
  });

  it("a malformed member is skipped and the merge still goes out", async () => {
    const client = setup();
    seedDetails(client, 13, { id: String(STACK_ID), position: 3 }, [
      null,
      { number: 7, position: "1", state: null },
      { number: 11, position: 1 },
      { number: 12, position: 2, state: "open" },
    ]);
    const hook = mountMerge(client).result;
    const { result, error } = await merge(() => hook.current, 13, STACK_ID);
    expect(error).toBeUndefined();
    expect(wireCalls()).toHaveLength(1);
    expect(wireCalls()[0][1]).toMatchObject({ number: 13 });
    expect(result).toMatchObject({ queued: false, cascaded: [12] });
    expect(statesOf(client.getQueryData(arrayPageKey("origin")))).toEqual({
      11: "OPEN",
      12: "MERGED",
      13: "MERGED",
      20: "OPEN",
    });
  });

  it.each([
    ["an unstacked merge", null, { id: String(STACK_ID), position: 3 }],
    ["details of another stack", STACK_ID, { id: "99", position: 3 }],
    ["no details entry", STACK_ID, undefined],
  ] as const)("%s re-files only the merged PR", async (_, stack, seeded) => {
    // Only a merge sent with a stack goes through the stack path.
    if (stack === null)
      answerMerge({ queued: false, cleanupWarning: null, stacked: false });
    const client = setup();
    if (seeded) seedDetails(client, 13, seeded, members());
    const hook = mountMerge(client).result;
    const { result } = await merge(() => hook.current, 13, stack);
    expect(wireCalls()).toHaveLength(1);
    expect(result).toMatchObject({ cascaded: [] });
    expect(statesOf(client.getQueryData(structPageKey("origin")))).toEqual({
      11: "OPEN",
      12: "OPEN",
      13: "MERGED",
      20: "OPEN",
    });
  });

  it("a queued merge re-files nothing", async () => {
    answerMerge(QUEUED_OUTCOME);
    const client = setup();
    seedDetails(client, 13, { id: String(STACK_ID), position: 3 }, members());
    const hook = mountMerge(client).result;
    const { result } = await merge(() => hook.current, 13, STACK_ID);
    expect(wireCalls()).toHaveLength(1);
    expect(result).toMatchObject({ queued: true, cascaded: [11, 12] });
    expect(statesOf(client.getQueryData(arrayPageKey("origin")))).toEqual({
      11: "OPEN",
      12: "OPEN",
      13: "OPEN",
      20: "OPEN",
    });
  });

  it("a stacked PR merged off the stack path re-files only itself", async () => {
    answerMerge({ queued: false, cleanupWarning: null, stacked: false });
    const client = setup();
    seedDetails(client, 13, { id: String(STACK_ID), position: 3 }, members());
    const hook = mountMerge(client).result;
    const { result } = await merge(() => hook.current, 13, STACK_ID);
    expect(wireCalls()).toHaveLength(1);
    expect(result).toStrictEqual({
      queued: false,
      cleanupWarning: null,
      stacked: false,
      cascaded: [],
    });
    expect(statesOf(client.getQueryData(arrayPageKey("origin")))).toEqual({
      11: "OPEN",
      12: "OPEN",
      13: "MERGED",
      20: "OPEN",
    });
  });

  it("a rejected merge re-files nothing", async () => {
    answerMerge({ kind: "gh", message: "refused" }, true);
    const client = setup();
    seedDetails(client, 13, { id: String(STACK_ID), position: 3 }, members());
    const hook = mountMerge(client).result;
    const { error } = await merge(() => hook.current, 13, STACK_ID);
    expect(wireCalls()).toHaveLength(1);
    expect(error).toBeDefined();
    expect(statesOf(client.getQueryData(arrayPageKey("origin")))).toEqual({
      11: "OPEN",
      12: "OPEN",
      13: "OPEN",
      20: "OPEN",
    });
  });

  it("re-files the layers the details listed before the merge, whatever they say after", async () => {
    const client = setup();
    seedDetails(client, 13, { id: String(STACK_ID), position: 3 }, members());
    // A details refetch landing mid-merge already reports the layers merged.
    answerMerge(
      { queued: false, cleanupWarning: null, stacked: true },
      false,
      () =>
        seedDetails(
          client,
          13,
          { id: String(STACK_ID), position: 3 },
          members(["merged", "merged", "merged"]),
        ),
    );
    const hook = mountMerge(client).result;
    const { result } = await merge(() => hook.current, 13, STACK_ID);
    expect(wireCalls()).toHaveLength(1);
    expect(result).toMatchObject({ cascaded: [11, 12] });
    expect(statesOf(client.getQueryData(structPageKey("origin")))).toEqual({
      11: "MERGED",
      12: "MERGED",
      13: "MERGED",
      20: "OPEN",
    });
  });

  it("reads the stack from the merge's own lens", async () => {
    const client = setup();
    // Only the origin lens holds details; a fork numbers its PRs on its own.
    seedDetails(client, 13, { id: String(STACK_ID), position: 3 }, members());
    const hook = mountMerge(client).result;
    const { result } = await merge(
      () => hook.current,
      13,
      STACK_ID,
      "upstream",
    );
    expect(wireCalls()).toHaveLength(1);
    expect(result).toMatchObject({ cascaded: [] });
    expect(statesOf(client.getQueryData(arrayPageKey("upstream")))).toEqual({
      11: "OPEN",
      12: "OPEN",
      13: "MERGED",
      20: "OPEN",
    });
    expect(statesOf(client.getQueryData(arrayPageKey("origin")))).toEqual({
      11: "OPEN",
      12: "OPEN",
      13: "OPEN",
      20: "OPEN",
    });
  });
});

describe("a merge re-reads the lens's issues once more after a delay", () => {
  /** The merge hook beside a mounted open-issue list of the origin lens and a
   *  mounted issue view in each lens. */
  async function mountWithIssues(client: QueryClient) {
    const hook = renderHook(
      () => ({
        merge: useMergePr(REPO),
        list: useIssueList(REPO, true, "open", 100, "origin"),
        origin: useIssueDetails(REPO, 3, "origin"),
        upstream: useIssueDetails(REPO, 3, "upstream"),
      }),
      { wrapper: wrapper(client) },
    );
    await flush();
    return () => hook.result.current.merge;
  }

  const listReads = () => vi.mocked(forgeIssueList).mock.calls.length;
  const viewReads = (lens: string) =>
    vi.mocked(forgeIssueView).mock.calls.filter(([, , l]) => l === lens).length;

  /** Each read's count once the merge's own settle re-reads have landed, then
   *  again after the delayed re-read's window. */
  async function countAcrossDelay(outcome: unknown, reject = false) {
    answerMerge(outcome, reject);
    const client = setup();
    const mergeHook = await mountWithIssues(client);
    expect(listReads()).toBe(1);
    const { result, error } = await merge(mergeHook, 13, null);
    expect(wireCalls()).toHaveLength(1);
    const before = {
      list: listReads(),
      origin: viewReads("origin"),
      upstream: viewReads("upstream"),
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIST_RECHECK_MS + 100);
    });
    expect(wireCalls()).toHaveLength(1);
    return {
      result,
      error,
      list: listReads() - before.list,
      origin: viewReads("origin") - before.origin,
      upstream: viewReads("upstream") - before.upstream,
    };
  }

  it("a landed merge re-reads the issue list and the lens's issue view once", async () => {
    expect(
      await countAcrossDelay({
        queued: false,
        cleanupWarning: null,
        stacked: false,
      }),
    ).toEqual({
      result: {
        queued: false,
        cleanupWarning: null,
        stacked: false,
        cascaded: [],
      },
      error: undefined,
      list: 1,
      origin: 1,
      upstream: 0,
    });
  });

  it.each([
    ["a queued", QUEUED_OUTCOME],
    ["an unconfirmed", UNCONFIRMED_OUTCOME],
  ] as const)(
    "%s merge re-reads the issue list and the lens's issue view once, like a landed one",
    async (_, outcome) => {
      expect(await countAcrossDelay(outcome)).toEqual({
        result: { ...outcome, cascaded: [] },
        error: undefined,
        list: 1,
        origin: 1,
        upstream: 0,
      });
    },
  );

  it("a rejected merge owes no issue re-read", async () => {
    const counts = await countAcrossDelay(
      { kind: "gh", message: "refused" },
      true,
    );
    expect(counts.error).toBeDefined();
    expect(counts).toEqual({
      result: undefined,
      error: counts.error,
      list: 0,
      origin: 0,
      upstream: 0,
    });
  });
});

describe("a queued merge re-reads the PR's details once more after a delay", () => {
  /** The merge hook beside a mounted details view of the merged PR. */
  async function mountWithDetails(
    client: QueryClient,
    lens: "origin" | "upstream",
  ) {
    const hook = renderHook(
      () => ({
        merge: useMergePr(REPO),
        details: usePrDetails(REPO, 13, lens),
      }),
      { wrapper: wrapper(client) },
    );
    await flush();
    return () => hook.result.current.merge;
  }

  const detailReads = () => vi.mocked(forgePrView).mock.calls.length;

  /** The details reads inside the delayed window, split at its edge, and the
   *  lens's rows once it has passed. */
  async function readsAcrossDelay(
    outcome: unknown,
    lens: "origin" | "upstream" = "origin",
  ) {
    answerMerge(outcome);
    const client = setup();
    const mergeHook = await mountWithDetails(client, lens);
    expect(detailReads()).toBe(1);
    const { result } = await merge(mergeHook, 13, null, lens);
    expect(wireCalls()).toHaveLength(1);
    const settled = detailReads();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIST_RECHECK_MS - 300);
    });
    const beforeEdge = detailReads() - settled;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(wireCalls()).toHaveLength(1);
    return {
      result,
      beforeEdge,
      atEdge: detailReads() - settled - beforeEdge,
      rows: statesOf(client.getQueryData(arrayPageKey(lens))),
    };
  }

  it.each([
    ["a queued", QUEUED_OUTCOME],
    ["an unconfirmed", UNCONFIRMED_OUTCOME],
  ] as const)(
    "%s merge re-reads them once at the delay and files no row as merged",
    async (_, outcome) => {
      expect(await readsAcrossDelay(outcome)).toEqual({
        result: { ...outcome, cascaded: [] },
        beforeEdge: 0,
        atEdge: 1,
        rows: { 11: "OPEN", 12: "OPEN", 13: "OPEN", 20: "OPEN" },
      });
    },
  );

  // Upstream, where no run recheck re-reads the checks rollup at the same delay.
  it("a landed merge leaves its details to the landed mark", async () => {
    const landed = { queued: false, cleanupWarning: null, stacked: false };
    expect(await readsAcrossDelay(landed, "upstream")).toEqual({
      result: { ...landed, cascaded: [] },
      beforeEdge: 0,
      atEdge: 0,
      rows: { 11: "OPEN", 12: "OPEN", 13: "MERGED", 20: "OPEN" },
    });
  });
});
