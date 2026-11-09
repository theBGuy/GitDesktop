import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusLogSync } from "@/features/history/HistoryPanel";
import {
  gitBranches,
  gitLog,
  gitOpState,
  gitRefsStamp,
  gitStatus,
  gitUnpushedCount,
  type UnpushedCount,
} from "@/lib/git/api";
import {
  remoteBranchesOptions,
  repoKeys,
  useBranches,
  useLog,
  useOpState,
  useRefsStamp,
  useRepoStatus,
} from "@/lib/git/queries";
import type {
  BranchHead,
  CommitSummary,
  FileEntry,
  RepoOpState,
} from "@/lib/git/types";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitBranches: vi.fn(),
  gitBranchRewriteStatus: vi.fn(),
  gitLog: vi.fn(),
  gitOpState: vi.fn(),
  gitRefsStamp: vi.fn(),
  gitRemoteBranches: vi.fn(),
  gitStatus: vi.fn(),
  gitUnpushedCount: vi.fn(),
}));

const REPO = "/repo";
/** Non-zero hex, so the oid-width guard never reads a zero run. */
const HASH_HEAD = "abcdef0123".repeat(4);
const HASH_PARENT = `b${HASH_HEAD.slice(1)}`;
/** A commit status has not reported yet. */
const HASH_NEW = `c${HASH_HEAD.slice(1)}`;

const STATUS = repoKeys.status(REPO);
const LOG = repoKeys.log(REPO);
const STAMP = repoKeys.refsStamp(REPO);
const OP = repoKeys.opState(REPO);
const BRANCHES = repoKeys.branches(REPO);
const COUNT = repoKeys.unpushedCount(REPO);

const IDLE: RepoOpState = {
  merging: false,
  rebasing: false,
  cherryPicking: false,
  reverting: false,
  editPaused: false,
  rebaseStop: null,
};

const UPSTREAM: BranchHead = {
  name: "main",
  detached: false,
  oid: HASH_HEAD,
  upstream: "origin/main",
  ahead: 1,
  behind: 0,
  upstreamGone: false,
  upstreamRemote: "origin",
  upstreamBranch: "main",
  pushNameMismatch: false,
  upstreamIsRemoteDefault: true,
  pushRemote: null,
  pushBranch: null,
};

/** A branch with no upstream, so the sync reads git_unpushed_count. */
const NO_UPSTREAM: Partial<BranchHead> = {
  name: "feature",
  upstream: null,
  ahead: 0,
  upstreamRemote: null,
  upstreamBranch: null,
  upstreamIsRemoteDefault: false,
};

const EDITED: FileEntry = { path: "a.txt", staged: null, unstaged: "modified" };
const ADDED: FileEntry = { path: "b.txt", staged: "added", unstaged: null };

const summary = (hash: string, subject: string): CommitSummary => ({
  hash,
  subject,
  author: "Ada",
  authorEmail: "",
  date: "2026-11-01T10:00:00Z",
  tags: [],
  isMerge: false,
});

const counted = (headOid: string | null): UnpushedCount => ({
  count: 1,
  basis: "remotes",
  defaultBranch: null,
  headOid,
});

function serveStatus(over: Partial<BranchHead>, entries: FileEntry[] = []) {
  vi.mocked(gitStatus).mockResolvedValue({
    branch: { ...UPSTREAM, ...over },
    entries,
  });
}

function serveLog(head: string) {
  vi.mocked(gitLog).mockResolvedValue([
    summary(head, "Tip"),
    summary(HASH_PARENT, "Base"),
  ]);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// The last landing of each sync input the probe's effect has seen. The probe
// renders after StatusLogSync, so its effect runs after the sync's in the same
// commit: once it has seen a landing, the sync has acted on it.
const seen = { status: -1, log: -1, stamp: -1 };

function Probe() {
  useOpState(REPO);
  useBranches(REPO);
  const status = useRepoStatus(REPO).dataUpdatedAt;
  const log = useLog(REPO).dataUpdatedAt;
  const stamp = useRefsStamp(REPO).dataUpdatedAt;
  useEffect(() => {
    seen.status = status;
    seen.log = log;
    seen.stamp = stamp;
  }, [status, log, stamp]);
  return null;
}

let client: QueryClient;

const calls = (fn: (...args: never[]) => unknown) =>
  vi.mocked(fn).mock.calls.length;

/** Waits until the sync has run on the current landing of every input. */
async function synced() {
  await waitFor(() =>
    expect(seen).toEqual({
      status: client.getQueryState(STATUS)?.dataUpdatedAt,
      log: client.getQueryState(LOG)?.dataUpdatedAt,
      stamp: client.getQueryState(STAMP)?.dataUpdatedAt,
    }),
  );
}

async function settle(key: readonly unknown[]) {
  await waitFor(() =>
    expect(client.getQueryState(key)?.fetchStatus).toBe("idle"),
  );
}

/** One poll of the given reads, a second after the last one. Readings are
 *  milliseconds of the faked Date, so "older than" never rests on timing. */
async function reading(...keys: (readonly unknown[])[]) {
  vi.setSystemTime(Date.now() + 1000);
  await Promise.all(
    keys.map((queryKey) => client.refetchQueries({ queryKey, exact: true })),
  );
  await synced();
}

async function mount(opts: { count?: boolean } = {}) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <StatusLogSync repoPath={REPO} />
      <Probe />
    </QueryClientProvider>,
  );
  await waitFor(() => {
    for (const key of [STATUS, LOG]) {
      expect(client.getQueryState(key)?.status).toBe("success");
    }
    for (const key of [STAMP, OP, BRANCHES]) {
      expect(client.getQueryState(key)?.status).not.toBe("pending");
    }
  });
  if (opts.count) {
    await waitFor(() =>
      expect(client.getQueryState(COUNT)?.status).not.toBe("pending"),
    );
    await settle(COUNT);
  }
  await settle(OP);
  await settle(BRANCHES);
  await synced();
}

/** Ref-derived reads no observer holds, seeded older than any reading. */
const REF_READS = [
  COUNT,
  [...repoKeys.rewriteStatus(REPO), "main"],
  remoteBranchesOptions(REPO).queryKey,
  repoKeys.compare(REPO, "main", "feature"),
  ["repo", REPO, "divergence", "main"],
  ["repo", REPO, "merge-preview", "feature", "merge"],
  ["repo", REPO, "local-pr-merge-states", []],
  ["repo", REPO, "commit", HASH_PARENT, "on-remote"],
] as const;

/** A commit read beside the on-remote verdict that no ref move changes. */
const COMMIT_READ = ["repo", REPO, "commit", HASH_PARENT, "details"] as const;

function seedRefReads() {
  for (const key of [...REF_READS, COMMIT_READ])
    client.setQueryData(key, {}, { updatedAt: 1 });
}

function invalidated(key: readonly unknown[]) {
  return client.getQueryState(key)?.isInvalidated;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset drops a failed case's unconsumed once-implementations as well.
  for (const fn of [
    gitStatus,
    gitLog,
    gitOpState,
    gitBranches,
    gitRefsStamp,
    gitUnpushedCount,
  ]) {
    vi.mocked(fn).mockReset();
  }
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
  // Readings are driven by hand: an unfocused window runs no 5 s poll.
  focusManager.setFocused(false);
  seen.status = -1;
  seen.log = -1;
  seen.stamp = -1;
  serveStatus({});
  serveLog(HASH_HEAD);
  vi.mocked(gitOpState).mockResolvedValue(IDLE);
  vi.mocked(gitBranches).mockResolvedValue([]);
  vi.mocked(gitRefsStamp).mockResolvedValue("f1:a");
  vi.mocked(gitUnpushedCount).mockResolvedValue(counted(HASH_HEAD));
});

afterEach(() => {
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

describe("op state follows status content with HEAD held", () => {
  it("re-reads once per changed signature, never on the seed or an unchanged reading", async () => {
    await mount();
    // The probe's own mount read: the first status reading only seeds.
    expect(gitOpState).toHaveBeenCalledTimes(1);

    await reading(STATUS);
    expect(gitOpState).toHaveBeenCalledTimes(1);

    serveStatus({}, [EDITED, ADDED]);
    await reading(STATUS);
    await waitFor(() => expect(gitOpState).toHaveBeenCalledTimes(2));
    await settle(OP);

    // The same entries in another order sign the same.
    serveStatus({}, [ADDED, EDITED]);
    await reading(STATUS);
    expect(gitOpState).toHaveBeenCalledTimes(2);

    serveStatus({}, [{ ...EDITED, staged: "modified" }, ADDED]);
    await reading(STATUS);
    await waitFor(() => expect(gitOpState).toHaveBeenCalledTimes(3));
  });

  it("restarts a read in flight when the entries change, so the later answer lands", async () => {
    // A stopped merge, then an abort from a terminal: no HEAD move.
    vi.mocked(gitOpState).mockResolvedValue({ ...IDLE, merging: true });
    await mount();
    const beforeAbort = deferred<RepoOpState>();
    const afterAbort = deferred<RepoOpState>();
    vi.mocked(gitOpState)
      .mockImplementationOnce(() => beforeAbort.promise)
      .mockImplementationOnce(() => afterAbort.promise);
    void client.refetchQueries({ queryKey: OP, exact: true });
    await waitFor(() => expect(gitOpState).toHaveBeenCalledTimes(2));

    serveStatus({}, [EDITED]);
    await reading(STATUS);
    expect(gitOpState).toHaveBeenCalledTimes(3);

    afterAbort.resolve(IDLE);
    beforeAbort.resolve({ ...IDLE, merging: true });
    await waitFor(() => expect(client.getQueryData(OP)).toEqual(IDLE));
    await settle(OP);
    expect(client.getQueryData(OP)).toEqual(IDLE);
  });

  // Control: drop `refsChanged` from the op-state arm of statusLogAction; the
  // stopped pick is never re-read.
  it("re-reads once when only the refs stamp moves, never again on the same stamp", async () => {
    await mount();
    expect(gitOpState).toHaveBeenCalledTimes(1);
    // A pick stopped on a commit that became empty: no entry changes, no HEAD
    // move, but its sentinel moves the stamp.
    vi.mocked(gitOpState).mockResolvedValue({ ...IDLE, cherryPicking: true });
    vi.mocked(gitRefsStamp).mockResolvedValue("f1:b");
    await reading(STAMP);
    await waitFor(() => expect(gitOpState).toHaveBeenCalledTimes(2));
    await settle(OP);
    expect(client.getQueryData(OP)).toEqual({ ...IDLE, cherryPicking: true });

    await reading(STAMP);
    await reading(STATUS);
    await reading(STAMP);
    expect(gitOpState).toHaveBeenCalledTimes(2);
  });
});

describe("the ref-derived reads follow the refs stamp", () => {
  it("re-reads the set once when the stamp moves, never on the seed or an unchanged stamp", async () => {
    await mount();
    // The first stamp only seeds.
    expect(gitBranches).toHaveBeenCalledTimes(1);
    seedRefReads();

    await reading(STAMP);
    expect(gitBranches).toHaveBeenCalledTimes(1);
    for (const key of REF_READS) expect(invalidated(key)).toBe(false);

    vi.mocked(gitRefsStamp).mockResolvedValue("f1:b");
    await reading(STAMP);
    await waitFor(() => expect(gitBranches).toHaveBeenCalledTimes(2));
    for (const key of REF_READS) expect(invalidated(key)).toBe(true);
    expect(invalidated(COMMIT_READ)).toBe(false);
    await settle(BRANCHES);

    await reading(STAMP);
    expect(gitBranches).toHaveBeenCalledTimes(2);
  });

  it("fetches a ref-derived read once when HEAD and the stamp move in the same tick", async () => {
    await mount();
    serveStatus({ oid: HASH_NEW });
    serveLog(HASH_NEW);
    vi.mocked(gitRefsStamp).mockResolvedValue("f1:b");
    await reading(STATUS, STAMP);
    await waitFor(() => expect(gitBranches).toHaveBeenCalledTimes(2));
    await settle(BRANCHES);
    await settle(LOG);
    await synced();
    expect(gitBranches).toHaveBeenCalledTimes(2);
  });

  // Control: feed the ref set the previous stamp reading's time; the count
  // refreshed between the two readings keeps its pre-push answer.
  it("re-reads a count refreshed between the previous stamp reading and the move", async () => {
    serveStatus(NO_UPSTREAM);
    await mount({ count: true });
    // The count's own recheck after the previous stamp reading, then a push
    // from a terminal moves refs/remotes.
    vi.setSystemTime(Date.now() + 1000);
    await client.refetchQueries({ queryKey: COUNT, exact: true });
    const base = calls(gitUnpushedCount);

    vi.mocked(gitRefsStamp).mockResolvedValue("f1:b");
    await reading(STAMP);
    await waitFor(() => expect(calls(gitUnpushedCount)).toBe(base + 1));
    await settle(COUNT);
    expect(calls(gitUnpushedCount)).toBe(base + 1);
  });

  it("leaves a count still fetching when the stamp moves to land on its own", async () => {
    serveStatus(NO_UPSTREAM);
    await mount({ count: true });
    const inFlight = deferred<UnpushedCount>();
    vi.mocked(gitUnpushedCount).mockImplementationOnce(() => inFlight.promise);
    vi.setSystemTime(Date.now() + 1000);
    void client.refetchQueries({ queryKey: COUNT, exact: true });
    await waitFor(() =>
      expect(client.getQueryState(COUNT)?.fetchStatus).toBe("fetching"),
    );
    const base = calls(gitUnpushedCount);

    vi.mocked(gitRefsStamp).mockResolvedValue("f1:b");
    await reading(STAMP);
    expect(calls(gitUnpushedCount)).toBe(base);
    inFlight.resolve(counted(HASH_HEAD));
    await settle(COUNT);
    expect(calls(gitUnpushedCount)).toBe(base);
  });

  it("an errored stamp fires nothing and throws nothing", async () => {
    vi.mocked(gitRefsStamp).mockRejectedValue(new Error("over the cap"));
    // Never loaded, so only the seed rule keeps the first stamp from re-reading it.
    vi.mocked(gitBranches).mockRejectedValue(new Error("for-each-ref failed"));
    await mount();
    seedRefReads();
    expect(client.getQueryState(STAMP)?.status).toBe("error");
    expect(client.getQueryState(BRANCHES)?.status).toBe("error");

    await reading(STAMP);
    await reading(STATUS);
    expect(gitBranches).toHaveBeenCalledTimes(1);
    for (const key of REF_READS) expect(invalidated(key)).toBe(false);

    // The first answer after the failures seeds; a failure after it keeps it.
    vi.mocked(gitRefsStamp).mockResolvedValue("f1:a");
    await reading(STAMP);
    vi.mocked(gitRefsStamp).mockRejectedValue(new Error("over the cap"));
    await reading(STAMP);
    vi.mocked(gitRefsStamp).mockResolvedValue("f1:a");
    await reading(STAMP);
    expect(gitBranches).toHaveBeenCalledTimes(1);
    for (const key of REF_READS) expect(invalidated(key)).toBe(false);

    vi.mocked(gitRefsStamp).mockResolvedValue("f1:b");
    await reading(STAMP);
    await waitFor(() => expect(gitBranches).toHaveBeenCalledTimes(2));
  });
});

describe("the no-upstream count agrees by identity", () => {
  it("a same-head log refetch re-reads no count", async () => {
    serveStatus(NO_UPSTREAM);
    await mount({ count: true });
    const base = calls(gitUnpushedCount);

    // A status reading newer than the count, so the count's gate is open.
    await reading(STATUS);
    expect(calls(gitUnpushedCount)).toBe(base);

    await reading(LOG);
    expect(calls(gitUnpushedCount)).toBe(base);
  });

  it("a count on a newer head than status fires nothing until the next status reading, then once", async () => {
    serveStatus(NO_UPSTREAM);
    vi.mocked(gitUnpushedCount).mockResolvedValue(counted(HASH_NEW));
    await mount({ count: true });
    vi.setSystemTime(Date.now() + 1000);
    await client.refetchQueries({ queryKey: COUNT, exact: true });
    const base = calls(gitUnpushedCount);

    // The count's own landing runs no sync; a stamp landing does.
    await reading(STAMP);
    expect(calls(gitUnpushedCount)).toBe(base);

    await reading(STATUS);
    await waitFor(() => expect(calls(gitUnpushedCount)).toBe(base + 1));
    await settle(COUNT);

    await reading(STAMP);
    expect(calls(gitUnpushedCount)).toBe(base + 1);
  });

  it("a count failing from its first read is retried at most once per status reading", async () => {
    serveStatus(NO_UPSTREAM);
    vi.mocked(gitUnpushedCount).mockRejectedValue(new Error("rev-list failed"));
    await mount({ count: true });
    expect(client.getQueryState(COUNT)?.status).toBe("error");
    const base = calls(gitUnpushedCount);

    await reading(STAMP);
    expect(calls(gitUnpushedCount)).toBe(base);

    await reading(STATUS);
    await waitFor(() => expect(calls(gitUnpushedCount)).toBe(base + 1));
    await settle(COUNT);

    await reading(STAMP);
    expect(calls(gitUnpushedCount)).toBe(base + 1);

    await reading(STATUS);
    await waitFor(() => expect(calls(gitUnpushedCount)).toBe(base + 2));
  });
});

describe("a failed log refetch", () => {
  it("is retried on the next status reading, not on a stamp landing", async () => {
    await mount();
    serveStatus({ oid: HASH_NEW });
    vi.mocked(gitLog).mockRejectedValue(new Error("log failed"));
    await reading(STATUS);
    await settle(LOG);
    await waitFor(() =>
      expect(client.getQueryState(LOG)?.status).toBe("error"),
    );
    const base = calls(gitLog);

    await reading(STAMP);
    expect(calls(gitLog)).toBe(base);

    await reading(STATUS);
    await waitFor(() => expect(calls(gitLog)).toBe(base + 1));
    await settle(LOG);

    await reading(STAMP);
    expect(calls(gitLog)).toBe(base + 1);
  });
});
