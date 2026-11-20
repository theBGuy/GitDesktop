import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgeGlMrMergeState, forgePrView, gitFetch } from "@/lib/git/api";
import {
  glMrMergeStateOptions,
  LANDED_MERGE_TTL_MS,
  markMergeLanded,
  prDetailsOptions,
  useGlArmAutoMerge,
  useGlMergingWatch,
  useMergePr,
  usePrDetails,
  WATCH_POLL_MS,
  WATCH_POLLS,
} from "@/lib/git/queries";
import type { GitLabMrMergeState, PrDetails } from "@/lib/git/types";
import { invoke } from "@/lib/tauri/invoke";

// The merge and arm writes run through the real hooks and api functions and are
// answered at the wire (a test may not name them); every read is mocked by name.
vi.mock("@/lib/tauri/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri/invoke")>()),
  invoke: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgePrView: vi.fn(),
  forgeGlMrMergeState: vi.fn(),
  gitFetch: vi.fn(async () => undefined),
}));

/** One repo path per test: the delayed re-reads are per-repo module state. */
let repoSeq = 0;
let REPO = "";
let OTHER = "";
const clients: QueryClient[] = [];

/** The next details answers, oldest first; the last one repeats. */
let views: unknown[] = [];
let slims: unknown[] = [];

const LANDED = { queued: false, cleanupWarning: null, stacked: false };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  repoSeq += 1;
  REPO = `C:/repos/landed-${repoSeq}`;
  OTHER = `C:/repos/other-${repoSeq}`;
  views = [details("OPEN")];
  slims = [{ locked: true, state: "MERGING" }];
  answerWire(LANDED);
  vi.mocked(forgePrView).mockImplementation(async (_repo, number) => {
    const next = views.length > 1 ? views.shift() : views[0];
    const answer = await next;
    return (
      answer && typeof answer === "object" ? { ...answer, number } : answer
    ) as PrDetails;
  });
  vi.mocked(forgeGlMrMergeState).mockImplementation(async () => {
    const next = slims.length > 1 ? slims.shift() : slims[0];
    if (next instanceof Error) throw next;
    return mergeState(next as Partial<GitLabMrMergeState>);
  });
  vi.mocked(gitFetch).mockImplementation(async () => undefined);
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.useRealTimers();
});

function details(state: unknown, extra: Record<string, unknown> = {}) {
  return {
    number: 7,
    state,
    stack: null,
    stackMembers: [],
    ...extra,
  } as unknown as PrDetails;
}

function mergeState(fields: Partial<GitLabMrMergeState>): GitLabMrMergeState {
  return {
    autoMergeEnabled: false,
    detailedMergeStatus: "",
    pipelineStatus: "",
    pipelineUrl: "",
    ...fields,
  };
}

/** Answers every wire call (the merge or the arm) with `outcome`. */
function answerWire(outcome: unknown, reject = false, wait?: Promise<void>) {
  vi.mocked(invoke).mockImplementation(async () => {
    await wait;
    if (reject) throw outcome;
    return outcome;
  });
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function newClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  return client;
}

const K = (number = 7, lens: "origin" | "upstream" = "origin", repo = REPO) =>
  prDetailsOptions(repo, number, lens).queryKey;
const stateOf = (client: QueryClient, key = K()) =>
  (client.getQueryData(key) as { state?: unknown } | undefined)?.state;
const viewCalls = () => vi.mocked(forgePrView).mock.calls.length;
const slimCalls = () => vi.mocked(forgeGlMrMergeState).mock.calls.length;

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const flush = (ms = 100) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** Mounts the merge hooks beside an observed details read of #7 (origin). */
function mount(client = newClient(), observe = true) {
  const hook = renderHook(
    ({ repo }) => ({
      merge: useMergePr(repo),
      arm: useGlArmAutoMerge(repo),
      details: usePrDetails(REPO, observe ? 7 : null, "origin"),
    }),
    { wrapper: wrapper(client), initialProps: { repo: REPO } },
  );
  return { client, hook };
}

type Hook = ReturnType<typeof mount>["hook"];

/** Fires the merge and reports what the cache held when mutateAsync resolved. */
async function merge(
  hook: Hook,
  client: QueryClient,
  { stack = null as number | null, which = "merge" as "merge" | "arm" } = {},
) {
  let atResolve: unknown = "unresolved";
  let error: unknown;
  await act(async () => {
    const vars = {
      number: 7,
      lens: "origin" as const,
      stack,
      strategy: "squash" as const,
      deleteBranch: false,
    };
    const run =
      which === "merge"
        ? hook.result.current.merge.mutateAsync(vars)
        : hook.result.current.arm.mutateAsync(vars);
    run.then(
      () => {
        atResolve = stateOf(client);
      },
      (e) => {
        error = e;
      },
    );
  });
  await flush();
  return { atResolve, error };
}

const refetch = (client: QueryClient, key = K()) =>
  act(async () => {
    await client.refetchQueries({ queryKey: key, exact: true });
  });

async function landed() {
  const { client, hook } = mount();
  await flush();
  expect(stateOf(client)).toBe("OPEN");
  const { atResolve } = await merge(hook, client);
  expect(atResolve).toBe("MERGED");
  return { client, hook };
}

describe("a landed merge keeps the details merged", () => {
  it("reads MERGED once mutateAsync resolves and after every later read (AC1)", async () => {
    const before = viewCalls();
    const { client } = await landed();
    // The settle invalidation and the post-fetch re-read both answered OPEN.
    expect(viewCalls()).toBeGreaterThanOrEqual(before + 2);
    expect(stateOf(client)).toBe("MERGED");
    await refetch(client);
    expect(stateOf(client)).toBe("MERGED");
  });

  it("an observed read started before the mark resolves MERGED (AC2)", async () => {
    // The merge's own settle cancels a read in flight, so the read that survives
    // a mark is one the watch's mint leaves running: minted here directly.
    const { client } = mount();
    await flush();
    const read = deferred<unknown>();
    views = [read.promise, details("OPEN")];
    // The read's own resolved value pins the overlay's after-await sampling: the
    // listener can repair the cache, never the value a caller awaited.
    let resolved: unknown = "unresolved";
    void client
      .fetchQuery({ ...prDetailsOptions(REPO, 7, "origin"), staleTime: 0 })
      .then((d) => {
        resolved = d;
      });
    await flush(10);
    act(() => markMergeLanded(client, REPO, "origin", 7));
    const afterMerge = viewCalls();
    await act(async () => read.resolve(details("OPEN", { title: "read A" })));
    await flush();
    // Read A's own answer is the one stored, with no later read behind it.
    expect(resolved).toMatchObject({ state: "MERGED", title: "read A" });
    expect(viewCalls()).toBe(afterMerge);
    expect(client.getQueryData(K())).toMatchObject({
      state: "MERGED",
      title: "read A",
    });
  });

  it("the entry's first read in flight at landing resolves MERGED (AC2b)", async () => {
    vi.mocked(gitFetch).mockImplementation(() => new Promise(() => undefined));
    const read = deferred<unknown>();
    views = [read.promise];
    const { client, hook } = mount();
    await flush();
    expect(client.getQueryData(K())).toBeUndefined();
    await merge(hook, client);
    expect(client.getQueryData(K())).toBeUndefined();
    await act(async () => read.resolve(details("OPEN")));
    expect(stateOf(client)).toBe("MERGED");
  });

  it("an unobserved prefetch in flight at landing is stored MERGED (AC2c)", async () => {
    vi.mocked(gitFetch).mockImplementation(() => new Promise(() => undefined));
    const { client, hook } = mount(undefined, false);
    const read = deferred<unknown>();
    views = [read.promise];
    void client.prefetchQuery(prDetailsOptions(REPO, 7, "origin"));
    await merge(hook, client);
    await act(async () => read.resolve(details("OPEN")));
    await flush();
    expect(stateOf(client)).toBe("MERGED");
  });

  it("a MERGING answer while live reads MERGED (AC3)", async () => {
    const { client } = await landed();
    views = [details("MERGING")];
    await refetch(client);
    expect(stateOf(client)).toBe("MERGED");
  });

  it("MERGED then OPEN keeps the record (AC4)", async () => {
    const { client } = await landed();
    views = [details("MERGED"), details("OPEN")];
    await refetch(client);
    expect(stateOf(client)).toBe("MERGED");
    await refetch(client);
    expect(stateOf(client)).toBe("MERGED");
  });

  it("CLOSED shows and retires the record (AC4b)", async () => {
    const { client } = await landed();
    views = [details("CLOSED"), details("OPEN")];
    await refetch(client);
    expect(stateOf(client)).toBe("CLOSED");
    await refetch(client);
    expect(stateOf(client)).toBe("OPEN");
  });

  it("a cancelled CLOSED read leaves the record to the newer read (AC4b)", async () => {
    const { client } = await landed();
    const stale = deferred<unknown>();
    const fresh = deferred<unknown>();
    views = [stale.promise, fresh.promise];
    void client.refetchQueries({ queryKey: K(), exact: true });
    await flush(10);
    // The newer read cancels the one in flight, whose answer is then discarded.
    void client.refetchQueries({ queryKey: K(), exact: true });
    await flush(10);
    await act(async () => stale.resolve(details("CLOSED")));
    await flush(10);
    await act(async () => fresh.resolve(details("OPEN")));
    await flush();
    expect(stateOf(client)).toBe("MERGED");
    // The record is still live: a later write of OPEN reads MERGED too.
    act(() => {
      client.setQueryData(K(), details("OPEN"));
    });
    expect(stateOf(client)).toBe("MERGED");
  });

  it("a whole-snapshot rollback to OPEN reads MERGED and keeps its fields", async () => {
    const { client } = await landed();
    act(() => {
      client.setQueryData(K(), details("OPEN", { comments: ["kept"] }));
    });
    expect(client.getQueryData(K())).toMatchObject({
      state: "MERGED",
      comments: ["kept"],
    });
  });

  it("a read in flight at the mint that stores OPEN after it reads MERGED", async () => {
    const client = newClient();
    client.setQueryData(K(), details("OPEN"));
    // A read whose answer was produced before the mark: no overlay runs on it.
    const read = deferred<PrDetails>();
    let stored = false;
    void client
      .fetchQuery({ queryKey: K(), queryFn: () => read.promise, staleTime: 0 })
      .then(() => {
        stored = true;
      });
    await flush(10);
    act(() => markMergeLanded(client, REPO, "origin", 7));
    await act(async () => read.resolve(details("OPEN", { title: "late" })));
    await flush(10);
    expect(stored).toBe(true);
    expect(client.getQueryData(K())).toMatchObject({
      state: "MERGED",
      title: "late",
    });
  });

  it("a manual write of CLOSED never retires the record", async () => {
    const { client } = await landed();
    act(() => {
      client.setQueryData(K(), details("CLOSED"));
    });
    expect(stateOf(client)).toBe("CLOSED");
    views = [details("OPEN")];
    await refetch(client);
    expect(stateOf(client)).toBe("MERGED");
  });

  it("an accepted CLOSED fetch retires it: a later OPEN write stays OPEN", async () => {
    const { client } = await landed();
    views = [details("CLOSED")];
    await refetch(client);
    expect(stateOf(client)).toBe("CLOSED");
    act(() => {
      client.setQueryData(K(), details("OPEN"));
    });
    expect(stateOf(client)).toBe("OPEN");
  });

  it("the details read never reads its abort signal", async () => {
    const client = newClient();
    let signalReads = 0;
    const context = {
      client,
      queryKey: K(),
      meta: undefined,
      get signal() {
        signalReads += 1;
        return new AbortController().signal;
      },
    };
    const { queryFn } = prDetailsOptions(REPO, 7, "origin");
    act(() => markMergeLanded(client, REPO, "origin", 7));
    const answer = await (queryFn as (c: unknown) => Promise<PrDetails>)(
      context,
    );
    expect(answer.state).toBe("MERGED");
    expect(signalReads).toBe(0);
  });

  it("an unmount while a replacing read is pending keeps that read's answer", async () => {
    const { client, hook } = await landed();
    const replaced = deferred<unknown>();
    const replacing = deferred<unknown>();
    views = [replaced.promise, replacing.promise];
    void client.refetchQueries({ queryKey: K(), exact: true });
    await flush(10);
    void client.refetchQueries({ queryKey: K(), exact: true });
    await flush(10);
    await act(async () => replaced.resolve(details("OPEN")));
    hook.unmount();
    await flush(10);
    await act(async () =>
      replacing.resolve(details("OPEN", { title: "replacing" })),
    );
    await flush(10);
    expect(client.getQueryData(K())).toMatchObject({
      state: "MERGED",
      title: "replacing",
    });
  });

  it("past the deadline with the timer late, a write of OPEN stays OPEN", async () => {
    const { client } = await landed();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    // The clock passes the deadline without firing the timer (sleep/resume).
    vi.setSystemTime(Date.now() + LANDED_MERGE_TTL_MS + 1_000);
    act(() => {
      client.setQueryData(K(), details("OPEN", { title: "late clock" }));
    });
    expect(stateOf(client)).toBe("OPEN");
    expect(invalidate).not.toHaveBeenCalled();
    await flush(LANDED_MERGE_TTL_MS);
    const exact = invalidate.mock.calls.filter(
      ([filters]) => filters?.exact === true,
    );
    expect(exact).toHaveLength(1);
    expect(exact[0]?.[0]?.queryKey).toEqual(K());
  });

  it("leaves one listener per live mark and none once it is gone", async () => {
    const client = newClient();
    const listeners = () =>
      (client.getQueryCache() as unknown as { listeners: Set<unknown> })
        .listeners.size;
    client.setQueryData(K(), details("OPEN"));
    expect(listeners()).toBe(0);
    act(() => markMergeLanded(client, REPO, "origin", 7));
    expect(listeners()).toBe(1);
    act(() => markMergeLanded(client, REPO, "origin", 7));
    expect(listeners()).toBe(1);
    await flush(LANDED_MERGE_TTL_MS + 100);
    expect(listeners()).toBe(0);
    act(() => markMergeLanded(client, REPO, "origin", 7));
    expect(listeners()).toBe(1);
    views = [details("CLOSED")];
    await act(async () => {
      await client.fetchQuery({
        ...prDetailsOptions(REPO, 7, "origin"),
        staleTime: 0,
      });
    });
    expect(stateOf(client)).toBe("CLOSED");
    expect(listeners()).toBe(0);
  });

  it("a CLOSED fetch of a sibling request leaves the mark alone", async () => {
    const { client } = await landed();
    views = [details("CLOSED")];
    await act(async () => {
      await client.fetchQuery({
        ...prDetailsOptions(REPO, 8, "origin"),
        staleTime: 0,
      });
    });
    expect(stateOf(client, K(8))).toBe("CLOSED");
    act(() => {
      client.setQueryData(K(), details("OPEN"));
    });
    expect(stateOf(client)).toBe("MERGED");
  });

  it("after expiry a manual OPEN write stays OPEN", async () => {
    const { client } = await landed();
    await flush(LANDED_MERGE_TTL_MS + 100);
    act(() => {
      client.setQueryData(K(), details("OPEN", { title: "after" }));
    });
    expect(stateOf(client)).toBe("OPEN");
  });

  it("an empty state is stored as answered and keeps the record (AC4c)", async () => {
    const { client } = await landed();
    views = [details(""), details("OPEN")];
    await refetch(client);
    expect(stateOf(client)).toBe("");
    await refetch(client);
    expect(stateOf(client)).toBe("MERGED");
  });

  it("a malformed state is stored as answered and keeps the record (AC4d)", async () => {
    const { client } = await landed();
    const absent = { number: 7, stack: null, stackMembers: [] };
    views = [details(5), absent, details("OPEN")];
    await refetch(client);
    expect(stateOf(client)).toBe(5);
    await refetch(client);
    expect(client.getQueryData(K())).not.toHaveProperty("state");
    await refetch(client);
    expect(stateOf(client)).toBe("MERGED");
  });

  it("expires once with one re-read, and a re-mint extends it (AC5)", async () => {
    const { client } = await landed();
    await flush(LANDED_MERGE_TTL_MS - 200);
    await refetch(client);
    expect(stateOf(client)).toBe("MERGED");
    const before = viewCalls();
    await flush(200);
    expect(viewCalls()).toBe(before + 1);
    expect(stateOf(client)).toBe("OPEN");
    await flush(LANDED_MERGE_TTL_MS);
    expect(viewCalls()).toBe(before + 1);
  });

  it("a re-mint before expiry keeps MERGED past the first expiry (AC5)", async () => {
    const { client } = await landed();
    await flush(LANDED_MERGE_TTL_MS / 2);
    act(() => markMergeLanded(client, REPO, "origin", 7));
    const before = viewCalls();
    await flush(LANDED_MERGE_TTL_MS / 2 + 100);
    expect(viewCalls()).toBe(before);
    await refetch(client);
    expect(stateOf(client)).toBe("MERGED");
    await flush(LANDED_MERGE_TTL_MS / 2);
    expect(viewCalls()).toBe(before + 2);
    expect(stateOf(client)).toBe("OPEN");
  });
});

describe("a merge that did not land marks nothing (AC6)", () => {
  it("a queued merge stays OPEN", async () => {
    answerWire({ queued: true, cleanupWarning: "queued", stacked: true });
    const { client, hook } = mount();
    await flush();
    const { atResolve } = await merge(hook, client);
    expect(atResolve).toBe("OPEN");
    await refetch(client);
    expect(stateOf(client)).toBe("OPEN");
  });

  it("arming auto-merge stays OPEN", async () => {
    answerWire(null);
    const { client, hook } = mount();
    await flush();
    const armed = await merge(hook, client, { which: "arm" });
    expect(armed.error).toBeUndefined();
    expect(armed.atResolve).toBe("OPEN");
    await refetch(client);
    expect(stateOf(client)).toBe("OPEN");
  });

  it("a rejected merge stays OPEN", async () => {
    answerWire({ kind: "gh", message: "refused" }, true);
    const { client, hook } = mount();
    await flush();
    const { error } = await merge(hook, client);
    expect(error).toBeDefined();
    await refetch(client);
    expect(stateOf(client)).toBe("OPEN");
  });
});

describe("the record's scope", () => {
  it("marks only its own key in its own client (AC7)", async () => {
    const { client } = await landed();
    const second = newClient();
    for (const [c, key] of [
      [client, K(8)],
      [client, K(7, "upstream")],
      [client, K(7, "origin", OTHER)],
      [second, K(7)],
    ] as const) {
      const [repo, , lens, number] = key.slice(1) as [
        string,
        string,
        "origin" | "upstream",
        number,
      ];
      await act(async () => {
        await c.fetchQuery(prDetailsOptions(repo, number, lens));
      });
      expect(stateOf(c, key)).toBe("OPEN");
    }
  });

  it("marks only the merged request, never the stack layers merged with it (AC8)", async () => {
    const client = newClient();
    const stackOf = (position: number) => ({
      stack: { id: "5", position },
      stackMembers: [
        { number: 5, position: 1, state: "open" },
        { number: 7, position: 2, state: "open" },
      ],
    });
    views = [details("OPEN", stackOf(2))];
    client.setQueryData(K(5), details("OPEN", { number: 5, ...stackOf(1) }));
    answerWire({ ...LANDED, stacked: true });
    const { hook } = mount(client);
    await flush();
    await merge(hook, client, { stack: 5 });
    expect(stateOf(client)).toBe("MERGED");
    expect(stateOf(client, K(5))).toBe("OPEN");
    await act(async () => {
      await client.fetchQuery({
        ...prDetailsOptions(REPO, 5, "origin"),
        staleTime: 0,
      });
    });
    expect(vi.mocked(forgePrView).mock.calls.at(-1)?.[1]).toBe(5);
    expect(stateOf(client, K(5))).toBe("OPEN");
  });

  it("writes the started repo's key when the host re-renders mid-merge (AC8)", async () => {
    const wire = deferred<void>();
    answerWire(LANDED, false, wire.promise);
    const { client, hook } = mount();
    await flush();
    client.setQueryData(K(7, "origin", OTHER), details("OPEN"));
    let resolved = false;
    await act(async () => {
      void hook.result.current.merge
        .mutateAsync({
          number: 7,
          lens: "origin",
          stack: null,
          strategy: "squash",
          deleteBranch: false,
        })
        .then(() => {
          resolved = true;
        });
    });
    hook.rerender({ repo: OTHER });
    await act(async () => wire.resolve());
    await flush();
    expect(resolved).toBe(true);
    expect(stateOf(client)).toBe("MERGED");
    expect(stateOf(client, K(7, "origin", OTHER))).toBe("OPEN");
    await act(async () => {
      await client.fetchQuery({
        ...prDetailsOptions(OTHER, 7, "origin"),
        staleTime: 0,
      });
    });
    expect(stateOf(client, K(7, "origin", OTHER))).toBe("OPEN");
  });
});

describe("a failed merge re-reads the details (AC9)", () => {
  for (const which of ["merge", "arm"] as const)
    it(`${which}: the rejection is followed by a details read`, async () => {
      answerWire({ kind: "gh", message: "refused" }, true);
      const { client, hook } = mount();
      await flush();
      views = [details("CLOSED")];
      const before = viewCalls();
      const { error } = await merge(hook, client, { which });
      expect(error).toBeDefined();
      expect(viewCalls()).toBeGreaterThan(before);
      expect(hook.result.current.details.data?.state).toBe("CLOSED");
    });
});

describe("the MERGING watch (AC14)", () => {
  /** The view's gate: the shown details read MERGING. */
  function mountWatch(client = newClient()) {
    const hook = renderHook(
      () => {
        const d = usePrDetails(REPO, 7, "origin");
        const merging = d.data?.state === "MERGING" && !d.isPlaceholderData;
        useGlMergingWatch(REPO, merging ? 7 : null);
        return d;
      },
      { wrapper: wrapper(client) },
    );
    return { client, hook };
  }
  const alignEntries = (client: QueryClient) =>
    client
      .getQueryCache()
      .findAll({ queryKey: glMrMergeStateOptions(REPO, 7).queryKey })
      .filter((q) => q.queryKey.includes("align")).length;

  it("polls every two seconds while locked, then stops after its budget", async () => {
    views = [details("MERGING")];
    const { client } = mountWatch();
    await flush();
    expect(slimCalls()).toBe(1);
    await flush(WATCH_POLL_MS - 200);
    expect(slimCalls()).toBe(1);
    await flush(200);
    expect(slimCalls()).toBe(2);
    await flush(WATCH_POLL_MS * (WATCH_POLLS + 5));
    expect(slimCalls()).toBe(WATCH_POLLS);
    expect(viewCalls()).toBe(1);
    expect(stateOf(client)).toBe("MERGING");
    expect(alignEntries(client)).toBe(0);
  });

  it("reads nothing while the details are not MERGING", async () => {
    mountWatch();
    await flush(WATCH_POLL_MS * 5);
    expect(slimCalls()).toBe(0);
  });

  it("ignores an unlocked answer cached before the episode", async () => {
    views = [details("MERGING")];
    const client = newClient();
    client.setQueryData(
      glMrMergeStateOptions(REPO, 7).queryKey,
      mergeState({ locked: false, state: "MERGED" }),
    );
    await flush(10);
    mountWatch(client);
    await flush(WATCH_POLL_MS * 2);
    expect(slimCalls()).toBeGreaterThan(0);
    expect(viewCalls()).toBe(1);
    expect(stateOf(client)).toBe("MERGING");
  });

  it("a MERGED slim answer marks the merge landed over a lagging details read (AC14a)", async () => {
    views = [details("MERGING")];
    slims = [{ locked: false, state: "MERGED" }];
    const { client } = mountWatch();
    await flush();
    expect(viewCalls()).toBe(2);
    expect(stateOf(client)).toBe("MERGED");
    await refetch(client);
    expect(stateOf(client)).toBe("MERGED");
    await flush(WATCH_POLL_MS * 5);
    expect(slimCalls()).toBe(1);
  });

  it("counts the first answer after a reset of the slim read", async () => {
    views = [details("MERGING")];
    const { client } = mountWatch();
    await flush();
    await flush(WATCH_POLL_MS);
    await flush(WATCH_POLL_MS);
    expect(slimCalls()).toBe(3);
    expect(viewCalls()).toBe(1);
    slims = [{ locked: false, state: "MERGED" }];
    await act(async () => {
      await client.resetQueries({
        queryKey: glMrMergeStateOptions(REPO, 7).queryKey,
        exact: true,
      });
    });
    await flush();
    expect(slimCalls()).toBe(4);
    expect(viewCalls()).toBe(2);
    expect(stateOf(client)).toBe("MERGED");
  });

  it("counts failures after a reset toward its budget", async () => {
    views = [details("MERGING")];
    slims = [new Error("down")];
    const { client } = mountWatch();
    await flush();
    await flush(WATCH_POLL_MS);
    await flush(WATCH_POLL_MS);
    expect(slimCalls()).toBe(3);
    await act(async () => {
      await client.resetQueries({
        queryKey: glMrMergeStateOptions(REPO, 7).queryKey,
        exact: true,
      });
    });
    await flush(WATCH_POLL_MS * (WATCH_POLLS + 5));
    expect(slimCalls()).toBe(WATCH_POLLS);
    expect(viewCalls()).toBe(1);
  });

  it("lets a details read slower than its cadence land (AC14c)", async () => {
    slims = [{ locked: false, state: "OPEN" }];
    const slow = async () => {
      await new Promise((r) => setTimeout(r, WATCH_POLL_MS + 1_000));
      return details("OPEN");
    };
    let calls = 0;
    vi.mocked(forgePrView).mockImplementation(async (_repo, number) => {
      calls += 1;
      return { ...(calls === 1 ? details("MERGING") : await slow()), number };
    });
    const { client } = mountWatch();
    await flush(WATCH_POLL_MS * 4);
    expect(viewCalls()).toBe(2);
    expect(stateOf(client)).toBe("OPEN");
  });

  it("re-reads the details on each unlocked answer while they read MERGING (AC14b)", async () => {
    views = [
      details("MERGING"),
      details("MERGING"),
      details("MERGING"),
      details("OPEN"),
    ];
    slims = [{ locked: false, state: "OPEN" }];
    const { client } = mountWatch();
    await flush();
    for (let i = 0; i < 4; i++) await flush(WATCH_POLL_MS);
    expect(viewCalls()).toBe(4);
    expect(stateOf(client)).toBe("OPEN");
    expect(slimCalls()).toBe(3);
    await refetch(client);
    expect(stateOf(client)).toBe("OPEN");
  });
});
