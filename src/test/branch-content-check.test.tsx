import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { Activity, createElement, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BranchContentMerged,
  type ContentCheckBase,
  type ContentCheckBaseRead,
  type ContentVerdict,
  gitBranchContentMerged,
  gitContentCheckBase,
} from "@/lib/git/api";
import {
  type BranchContentCheck,
  useBranchContentCheck,
} from "@/lib/git/queries";
import { unmockedCommands } from "./setup";

// The api module is the seam; the hook, its limiter and react-query stay real.
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitContentCheckBase: vi.fn(),
  gitBranchContentMerged: vi.fn(),
}));

// The limiter is module state shared by every test here, so each test uses its
// own repo path and branch names and settles every check it started.

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const baseFor = (n: string): ContentCheckBase => ({
  refName: "origin/main",
  sha: n.repeat(40),
  tree: "e".repeat(40),
});

/** What gitContentCheckBase answers when a base resolves. */
const readFor = (n: string): ContentCheckBaseRead => ({
  base: baseFor(n),
  offReason: null,
});

interface CheckCall {
  repo: string;
  baseSha: string;
  baseTree: string;
  branch: string;
  prHead: string | null;
  settled: boolean;
  settle: (
    verdict?: ContentVerdict,
    detail?: Partial<Pick<BranchContentMerged, "landedIn" | "viaPrHead">>,
  ) => void;
  fail: () => void;
}

let calls: CheckCall[] = [];
let inFlight = 0;
let maxInFlight = 0;

interface Props {
  repoPath: string;
  defaultBranch: string | null | undefined;
  branches: readonly string[];
  enabled: boolean;
  prHeads?: ReadonlyMap<string, string>;
}

/** One entry per COMMITTED render: render-time adjusts never commit. */
const commits: BranchContentCheck[] = [];

function Probe({ repoPath, defaultBranch, branches, enabled, prHeads }: Props) {
  const check = useBranchContentCheck(
    repoPath,
    defaultBranch,
    branches,
    enabled,
    prHeads,
  );
  useLayoutEffect(() => {
    commits.push({ ...check, verdicts: new Map(check.verdicts) });
  });
  return null;
}

type MountProps = Props & { hidden?: boolean };

function mount(props: MountProps) {
  const client = new QueryClient();
  // A bare Activity stands in for a hidden tab: the hook's own contract is the
  // subject here, not the tab panel's portal pairing. Spelled with
  // createElement on purpose: the lone-activity-boundary guard targets JSX
  // tab-panel boundaries, and this one is no tab panel.
  const tree = ({ hidden, ...p }: MountProps) => (
    <QueryClientProvider client={client}>
      {createElement(Activity, {
        mode: hidden ? "hidden" : "visible",
        children: <Probe {...p} />,
      })}
    </QueryClientProvider>
  );
  const view = render(tree(props));
  return {
    client,
    unmount: view.unmount,
    update: (next: MountProps) => view.rerender(tree(next)),
    latest: () => commits[commits.length - 1],
    entries: (repo: string) =>
      client.getQueryCache().findAll({ queryKey: ["content-merged", repo] }),
  };
}

/** Lets react-query's batched notifications and the limiter's handoffs run. */
const flush = () =>
  act(async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  });

const names = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

beforeEach(() => {
  calls = [];
  inFlight = 0;
  maxInFlight = 0;
  commits.length = 0;
  vi.mocked(gitContentCheckBase).mockReset();
  vi.mocked(gitBranchContentMerged)
    .mockReset()
    .mockImplementation((repo, baseSha, baseTree, branch, prHead) => {
      const d = deferred<BranchContentMerged>();
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const call: CheckCall = {
        repo,
        baseSha,
        baseTree,
        branch,
        prHead,
        settled: false,
        settle: (verdict = "clean", detail = {}) => {
          call.settled = true;
          d.resolve({
            branch,
            verdict,
            headSha: "f".repeat(40),
            landedIn: null,
            viaPrHead: false,
            ...detail,
          });
        },
        fail: () => {
          call.settled = true;
          d.reject(new Error("check failed"));
        },
      };
      calls.push(call);
      return d.promise.finally(() => {
        inFlight--;
      });
    });
});

afterEach(async () => {
  // Drain anything a failing assertion left running, so the shared limiter
  // starts the next test empty.
  for (const call of calls) if (!call.settled) call.settle();
  await flush();
  expect(unmockedCommands).toEqual([]);
});

describe("useBranchContentCheck", () => {
  it("never runs more than four checks at once, then settles every branch", async () => {
    const repo = "C:/repos/cc-bound";
    const branches = names("bound", 10);
    vi.mocked(gitContentCheckBase).mockResolvedValue(readFor("a"));
    const view = mount({
      repoPath: repo,
      defaultBranch: "main",
      branches,
      enabled: true,
    });

    await waitFor(() => expect(calls).toHaveLength(4));
    await flush();
    expect(calls).toHaveLength(4);
    expect(view.latest().pendingCount).toBe(10);

    while (calls.some((c) => !c.settled)) {
      calls.find((c) => !c.settled)?.settle();
      await flush();
      expect(inFlight).toBeLessThanOrEqual(4);
    }
    expect(calls.map((c) => c.branch)).toEqual(branches);
    expect(maxInFlight).toBe(4);
    expect(
      calls.every(
        (c) =>
          c.repo === repo &&
          c.baseSha === "a".repeat(40) &&
          c.baseTree === "e".repeat(40),
      ),
    ).toBe(true);
    await waitFor(() => expect(view.latest().status).toBe("settled"));
    expect(view.latest().verdicts.size).toBe(10);
    expect(view.latest().pendingCount).toBe(0);
  });

  it("two hook instances share the four-check limit", async () => {
    const repoA = "C:/repos/cc-shared-a";
    const repoB = "C:/repos/cc-shared-b";
    const branchesA = names("shared-a", 6);
    const branchesB = names("shared-b", 6);
    vi.mocked(gitContentCheckBase).mockResolvedValue(readFor("b"));
    const a = mount({
      repoPath: repoA,
      defaultBranch: "main",
      branches: branchesA,
      enabled: true,
    });
    const b = mount({
      repoPath: repoB,
      defaultBranch: "main",
      branches: branchesB,
      enabled: true,
    });
    await waitFor(() => expect(gitContentCheckBase).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(calls).toHaveLength(4));
    await flush();
    expect(calls).toHaveLength(4);
    expect(maxInFlight).toBe(4);

    while (calls.some((c) => !c.settled)) {
      calls.find((c) => !c.settled)?.settle();
      await flush();
      expect(inFlight).toBeLessThanOrEqual(4);
    }
    expect(maxInFlight).toBe(4);
    expect(calls.filter((c) => c.repo === repoA).map((c) => c.branch)).toEqual(
      branchesA,
    );
    expect(calls.filter((c) => c.repo === repoB).map((c) => c.branch)).toEqual(
      branchesB,
    );
    a.unmount();
    b.unmount();
  });

  it("closing stops queued checks and drops the open's cache entries", async () => {
    const repo = "C:/repos/cc-close";
    const branches = names("close", 6);
    vi.mocked(gitContentCheckBase).mockResolvedValue(readFor("b"));
    const view = mount({
      repoPath: repo,
      defaultBranch: "main",
      branches,
      enabled: true,
    });
    await waitFor(() => expect(calls).toHaveLength(4));

    view.update({
      repoPath: repo,
      defaultBranch: "main",
      branches,
      enabled: false,
    });
    expect(view.entries(repo)).toEqual([]);

    for (const call of calls) call.settle();
    await flush();
    expect(calls.map((c) => c.branch)).toEqual(branches.slice(0, 4));
    expect(gitContentCheckBase).toHaveBeenCalledTimes(1);
    expect(view.entries(repo)).toEqual([]);
  });

  it("a name that leaves the list never has its queued check started", async () => {
    const repo = "C:/repos/cc-depart";
    const branches = names("depart", 5);
    vi.mocked(gitContentCheckBase).mockResolvedValue(readFor("c"));
    const view = mount({
      repoPath: repo,
      defaultBranch: "main",
      branches,
      enabled: true,
    });
    await waitFor(() => expect(calls).toHaveLength(4));

    const kept = branches.slice(0, 4);
    view.update({
      repoPath: repo,
      defaultBranch: "main",
      branches: kept,
      enabled: true,
    });
    for (const call of calls) call.settle("changes");
    await flush();

    expect(calls.map((c) => c.branch)).toEqual(kept);
    await waitFor(() => expect(view.latest().status).toBe("settled"));
    expect([...view.latest().verdicts.keys()]).toEqual(kept);
  });

  it("each open fetches once: a reopen's first commit shows nothing landed", async () => {
    const repo = "C:/repos/cc-reopen";
    const branches = names("reopen", 2);
    const props = { repoPath: repo, defaultBranch: "main", branches };
    vi.mocked(gitContentCheckBase).mockResolvedValueOnce(readFor("d"));
    const view = mount({ ...props, enabled: true });
    await waitFor(() => expect(calls).toHaveLength(2));
    for (const call of calls) call.settle();
    await waitFor(() => expect(view.latest().status).toBe("settled"));
    expect(view.latest().base).toEqual(baseFor("d"));

    // Repo invalidations and the focus bridge match the ["repo", …] subtree.
    await act(async () => {
      await view.client.invalidateQueries({ queryKey: ["repo", repo] });
      await view.client.invalidateQueries({ queryKey: ["repo"] });
    });
    await flush();
    expect(gitContentCheckBase).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);

    view.update({ ...props, enabled: false });
    expect(view.entries(repo)).toEqual([]);

    const nextBase = deferred<ContentCheckBaseRead>();
    vi.mocked(gitContentCheckBase).mockReturnValueOnce(nextBase.promise);
    const mark = commits.length;
    view.update({ ...props, enabled: true });
    const first = commits[mark];
    expect(first.verdicts.size).toBe(0);
    expect(first.base).toBeNull();
    expect(first.status).toBe("pending");
    expect(first.pendingCount).toBe(2);

    await flush();
    expect(view.latest().verdicts.size).toBe(0);
    expect(gitContentCheckBase).toHaveBeenCalledTimes(2);
    await act(async () => nextBase.resolve(readFor("d")));
    await waitFor(() => expect(calls).toHaveLength(4));
    expect(view.latest().verdicts.size).toBe(0);
    expect(view.latest().pendingCount).toBe(2);
    for (const call of calls.slice(2)) call.settle();
    await waitFor(() => expect(view.latest().status).toBe("settled"));
  });

  it("a repo switch while open starts a fresh open for the new repo", async () => {
    const repoA = "C:/repos/cc-switch-a";
    const repoB = "C:/repos/cc-switch-b";
    vi.mocked(gitContentCheckBase).mockResolvedValueOnce(readFor("1"));
    const view = mount({
      repoPath: repoA,
      defaultBranch: "main",
      branches: ["switch-shared", "switch-a"],
      enabled: true,
    });
    await waitFor(() => expect(calls).toHaveLength(2));
    calls[0].settle();
    await waitFor(() => expect(view.latest().verdicts.size).toBe(1));

    const baseB = deferred<ContentCheckBaseRead>();
    vi.mocked(gitContentCheckBase).mockReturnValueOnce(baseB.promise);
    const mark = commits.length;
    view.update({
      repoPath: repoB,
      defaultBranch: "trunk",
      branches: ["switch-shared"],
      enabled: true,
    });
    const first = commits[mark];
    expect(first.verdicts.size).toBe(0);
    expect(first.base).toBeNull();
    expect(first.status).toBe("pending");
    expect(gitContentCheckBase).toHaveBeenLastCalledWith(repoB, "trunk");

    // The old repo's in-flight check lands nowhere in the new open.
    calls[1].settle();
    await flush();
    expect(view.latest().verdicts.size).toBe(0);
    expect(view.entries(repoA)).toEqual([]);

    await act(async () => baseB.resolve(readFor("2")));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]).toMatchObject({
      repo: repoB,
      baseSha: "2".repeat(40),
      branch: "switch-shared",
    });
    calls[2].settle("changes");
    await waitFor(() => expect(view.latest().status).toBe("settled"));
    expect(view.latest().verdicts).toEqual(
      new Map([["switch-shared", "changes"]]),
    );
  });

  it("waits while the default branch loads, then checks against it", async () => {
    const repo = "C:/repos/cc-loading";
    const branches = names("loading", 2);
    vi.mocked(gitContentCheckBase).mockResolvedValue(readFor("3"));
    const view = mount({
      repoPath: repo,
      defaultBranch: undefined,
      branches,
      enabled: true,
    });
    await flush();
    expect(view.latest()).toMatchObject({
      status: "pending",
      base: null,
      offReason: null,
    });
    expect(view.latest().pendingCount).toBe(2);
    expect(gitContentCheckBase).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);

    view.update({
      repoPath: repo,
      defaultBranch: "main",
      branches,
      enabled: true,
    });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(gitContentCheckBase).toHaveBeenCalledWith(repo, "main");
    for (const call of calls) call.settle();
    await waitFor(() => expect(view.latest().status).toBe("settled"));
  });

  it("no default branch is unsupported, and stays so for the open", async () => {
    const none = mount({
      repoPath: "C:/repos/cc-none",
      defaultBranch: null,
      branches: ["none-0"],
      enabled: true,
    });
    await flush();
    expect(none.latest()).toMatchObject({
      status: "unsupported",
      base: null,
      offReason: "noDefaultBranch",
      pendingCount: 0,
    });
    none.unmount();

    const repo = "C:/repos/cc-latch";
    const branches = ["latch-0"];
    const view = mount({
      repoPath: repo,
      defaultBranch: undefined,
      branches,
      enabled: true,
    });
    view.update({
      repoPath: repo,
      defaultBranch: null,
      branches,
      enabled: true,
    });
    await flush();
    expect(view.latest().status).toBe("unsupported");
    view.update({
      repoPath: repo,
      defaultBranch: "main",
      branches,
      enabled: true,
    });
    await flush();
    expect(view.latest().status).toBe("unsupported");
    expect(gitContentCheckBase).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("an unresolvable or failed base is unsupported; a failed check is unknown", async () => {
    vi.mocked(gitContentCheckBase).mockResolvedValueOnce({
      base: null,
      offReason: "mergeRenormalize",
    });
    const noBase = mount({
      repoPath: "C:/repos/cc-nobase",
      defaultBranch: "main",
      branches: ["nobase-0"],
      enabled: true,
    });
    await waitFor(() => expect(noBase.latest().status).toBe("unsupported"));
    expect(noBase.latest().offReason).toBe("mergeRenormalize");
    noBase.unmount();

    vi.mocked(gitContentCheckBase).mockRejectedValueOnce(new Error("spawn"));
    const badBase = mount({
      repoPath: "C:/repos/cc-badbase",
      defaultBranch: "main",
      branches: ["badbase-0"],
      enabled: true,
    });
    await waitFor(() => expect(badBase.latest().status).toBe("unsupported"));
    expect(badBase.latest().offReason).toBe("baseFailed");
    expect(calls).toHaveLength(0);
    badBase.unmount();

    vi.mocked(gitContentCheckBase).mockResolvedValueOnce(readFor("4"));
    const view = mount({
      repoPath: "C:/repos/cc-unknown",
      defaultBranch: "main",
      branches: ["unknown-ok", "unknown-bad"],
      enabled: true,
    });
    await waitFor(() => expect(calls).toHaveLength(2));
    calls[0].settle();
    calls[1].fail();
    await waitFor(() => expect(view.latest().status).toBe("settled"));
    expect(view.latest().offReason).toBeNull();
    expect(view.latest().verdicts).toEqual(
      new Map([
        ["unknown-ok", "clean"],
        ["unknown-bad", "unknown"],
      ]),
    );
  });

  it("keeps its first base through a filterless refetch that fails or moves", async () => {
    const repo = "C:/repos/cc-rebase";
    const branches = names("rebase", 2);
    const props = { repoPath: repo, defaultBranch: "main", branches };
    vi.mocked(gitContentCheckBase).mockResolvedValueOnce(readFor("5"));
    const view = mount({ ...props, enabled: true });
    await waitFor(() => expect(calls).toHaveLength(2));
    for (const call of calls) call.settle();
    await waitFor(() => expect(view.latest().status).toBe("settled"));

    // An account switch invalidates every query, this open's included. The
    // landed verdicts answer from the latch, so the refetch settles on its own.
    vi.mocked(gitContentCheckBase).mockRejectedValueOnce(new Error("spawn"));
    await act(async () => {
      await view.client.invalidateQueries();
    });
    await flush();
    expect(gitContentCheckBase).toHaveBeenCalledTimes(2);
    expect(view.latest().status).toBe("settled");
    expect(view.latest().base).toEqual(baseFor("5"));

    vi.mocked(gitContentCheckBase).mockResolvedValueOnce(readFor("6"));
    await act(async () => {
      await view.client.invalidateQueries();
    });
    await flush();
    expect(gitContentCheckBase).toHaveBeenCalledTimes(3);
    expect(view.latest().base).toEqual(baseFor("5"));
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.baseSha === "5".repeat(40))).toBe(true);
    expect(view.latest().status).toBe("settled");
    expect(view.latest().verdicts).toEqual(
      new Map(branches.map((b) => [b, "clean"])),
    );
  });

  it("keeps each first verdict through a filterless refetch, without re-running git", async () => {
    const repo = "C:/repos/cc-latch-verdicts";
    const branches = ["vlatch-changes", "vlatch-clean", "vlatch-failed"];
    vi.mocked(gitContentCheckBase).mockResolvedValue(readFor("a"));
    const view = mount({
      repoPath: repo,
      defaultBranch: "main",
      branches,
      enabled: true,
    });
    await waitFor(() => expect(calls).toHaveLength(3));
    calls[0].settle("changes");
    calls[1].settle("clean");
    calls[2].fail();
    const landed = new Map<string, ContentVerdict>([
      ["vlatch-changes", "changes"],
      ["vlatch-clean", "clean"],
      ["vlatch-failed", "unknown"],
    ]);
    await waitFor(() => expect(view.latest().status).toBe("settled"));
    expect(view.latest().verdicts).toEqual(landed);

    // The backend would now answer every branch differently.
    const later: Record<string, ContentVerdict> = {
      "vlatch-changes": "unknown",
      "vlatch-clean": "changes",
      "vlatch-failed": "clean",
    };
    vi.mocked(gitBranchContentMerged).mockImplementation(
      async (_repo, _sha, _tree, branch) => ({
        branch,
        verdict: later[branch],
        headSha: "f".repeat(40),
        landedIn: null,
        viaPrHead: false,
      }),
    );
    const mark = commits.length;
    await act(async () => {
      await view.client.invalidateQueries();
    });
    await flush();

    expect(gitContentCheckBase).toHaveBeenCalledTimes(2);
    expect(gitBranchContentMerged).toHaveBeenCalledTimes(3);
    expect(commits.length).toBeGreaterThan(mark);
    for (const commit of commits.slice(mark)) {
      expect(commit.status).toBe("settled");
      expect(commit.verdicts).toEqual(landed);
    }
  });

  it("keeps a verdict whose row leaves and returns within the open", async () => {
    const repo = "C:/repos/cc-return";
    const branches = names("return", 2);
    vi.mocked(gitContentCheckBase).mockResolvedValue(readFor("7"));
    const view = mount({
      repoPath: repo,
      defaultBranch: "main",
      branches,
      enabled: true,
    });
    await waitFor(() => expect(calls).toHaveLength(2));
    for (const call of calls) call.settle();
    await waitFor(() => expect(view.latest().status).toBe("settled"));

    view.update({
      repoPath: repo,
      defaultBranch: "main",
      branches: branches.slice(0, 1),
      enabled: true,
    });
    await flush();
    const mark = commits.length;
    view.update({
      repoPath: repo,
      defaultBranch: "main",
      branches,
      enabled: true,
    });
    expect(commits[mark].verdicts.size).toBe(2);
    await flush();
    expect(calls).toHaveLength(2);
    expect(view.latest().status).toBe("settled");
  });

  it("an Activity hide keeps the open's landed verdicts", async () => {
    const repo = "C:/repos/cc-hide";
    const branches = names("hide", 2);
    const props = { repoPath: repo, defaultBranch: "main", branches };
    vi.mocked(gitContentCheckBase).mockResolvedValue(readFor("8"));
    const view = mount({ ...props, enabled: true });
    await waitFor(() => expect(calls).toHaveLength(2));
    for (const call of calls) call.settle();
    await waitFor(() => expect(view.latest().status).toBe("settled"));

    view.update({ ...props, enabled: true, hidden: true });
    await flush();
    expect(view.entries(repo)).toHaveLength(3);
    view.update({ ...props, enabled: true });
    await flush();
    expect(gitContentCheckBase).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(view.latest().status).toBe("settled");
    expect(view.latest().verdicts.size).toBe(2);
  });

  it("a check cancelled as its slot is granted never starts", async () => {
    const repo = "C:/repos/cc-grant";
    const branches = names("grant", 6);
    vi.mocked(gitContentCheckBase).mockResolvedValue(readFor("9"));
    const view = mount({
      repoPath: repo,
      defaultBranch: "main",
      branches,
      enabled: true,
    });
    await waitFor(() => expect(calls).toHaveLength(4));

    // The grant detaches the waiter's abort listener; cancel right there, before
    // the waiter's continuation runs.
    let owner: object = AbortSignal.prototype;
    while (!Object.hasOwn(owner, "removeEventListener"))
      owner = Object.getPrototypeOf(owner);
    const target = owner as EventTarget;
    const original = target.removeEventListener;
    let armed = true;
    const spy = vi
      .spyOn(target, "removeEventListener")
      .mockImplementation(function (this: EventTarget, type, listener, opts) {
        original.call(this, type, listener, opts);
        if (!armed || type !== "abort") return;
        armed = false;
        void view.client.cancelQueries({
          predicate: (q) =>
            q.queryKey[3] === "verdict" && q.queryKey[5] === branches[4],
        });
      });
    try {
      calls[0].settle();
      await flush();
    } finally {
      spy.mockRestore();
    }
    expect(armed).toBe(false);
    expect(calls.map((c) => c.branch)).toEqual([
      ...branches.slice(0, 4),
      branches[5],
    ]);
    expect(maxInFlight).toBe(4);
  });
});

describe("useBranchContentCheck's merged-PR heads", () => {
  /** Settles every check in flight, oldest first, as each takes a slot. */
  async function drain(verdict: ContentVerdict) {
    while (calls.some((c) => !c.settled)) {
      calls.find((c) => !c.settled)?.settle(verdict);
      await flush();
    }
  }

  it("sends each head lowercased, and null for an absent, empty or non-hex one", async () => {
    const repo = "C:/repos/cc-heads";
    const hex40 = "1a2b3c4d5e".repeat(4);
    const hex64 = "abcdef0123456789".repeat(4);
    const short = "0a1b2c3d4e5f";
    const heads = new Map([
      ["heads-40", hex40],
      ["heads-64", hex64],
      ["heads-12", short],
      ["heads-upper", hex40.toUpperCase()],
      ["heads-empty", ""],
      ["heads-garbage", "not-a-sha"],
    ]);
    const branches = [...heads.keys(), "heads-absent"];
    vi.mocked(gitContentCheckBase).mockResolvedValue(readFor("a"));
    const view = mount({
      repoPath: repo,
      defaultBranch: "main",
      branches,
      enabled: true,
      prHeads: heads,
    });
    await waitFor(() => expect(calls).toHaveLength(4));
    await drain("changes");
    expect(Object.fromEntries(calls.map((c) => [c.branch, c.prHead]))).toEqual({
      "heads-40": hex40,
      "heads-64": hex64,
      "heads-12": short,
      "heads-upper": hex40,
      "heads-empty": null,
      "heads-garbage": null,
      "heads-absent": null,
    });
    // A run that already sent its head, or had none to send, never re-runs.
    expect(calls).toHaveLength(branches.length);
    await waitFor(() => expect(view.latest().status).toBe("settled"));
    expect(view.latest().verdicts.size).toBe(branches.length);
  });

  it("a head arriving mid-check never re-keys it; its upgrade waits for a changes verdict", async () => {
    const repo = "C:/repos/cc-late-head";
    const branches = names("late", 6);
    const head = "b".repeat(40);
    const props = { repoPath: repo, defaultBranch: "main", branches };
    vi.mocked(gitContentCheckBase).mockResolvedValue(readFor("b"));
    const view = mount({ ...props, enabled: true });
    await waitFor(() => expect(calls).toHaveLength(4));

    // late-0 and late-1 are running and late-5 is queued when the heads land.
    view.update({
      ...props,
      enabled: true,
      prHeads: new Map([
        ["late-0", head],
        ["late-1", head],
        ["late-5", head],
      ]),
    });
    await flush();
    expect(calls).toHaveLength(4);
    expect(view.latest().pendingCount).toBe(6);

    calls[0].settle("clean");
    calls[1].settle("changes");
    await flush();
    expect(view.latest().verdicts.get("late-0")).toBe("clean");
    expect(view.latest().verdicts.get("late-1")).toBe("changes");

    await drain("changes");
    expect(calls.map((c) => [c.branch, c.prHead])).toEqual([
      ...branches.map((b) => [b, null]),
      ["late-1", head],
      ["late-5", head],
    ]);
    await waitFor(() => expect(view.latest().status).toBe("settled"));
  });

  it("an upgrade reaches git, serves the latched verdict meanwhile, and replaces it when clean", async () => {
    const repo = "C:/repos/cc-upgrade";
    const props = {
      repoPath: repo,
      defaultBranch: "main",
      branches: ["up-row"],
    };
    vi.mocked(gitContentCheckBase).mockResolvedValue(readFor("c"));
    const view = mount({ ...props, enabled: true });
    await waitFor(() => expect(calls).toHaveLength(1));
    calls[0].settle("changes");
    await waitFor(() => expect(view.latest().status).toBe("settled"));

    const mark = commits.length;
    view.update({
      ...props,
      enabled: true,
      prHeads: new Map([["up-row", "C".repeat(40)]]),
    });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].prHead).toBe("c".repeat(40));
    await flush();
    expect(commits.length).toBeGreaterThan(mark);
    for (const commit of commits.slice(mark)) {
      expect(commit.status).toBe("settled");
      expect(commit.pendingCount).toBe(0);
      expect(commit.verdicts.get("up-row")).toBe("changes");
    }

    calls[1].settle("clean", { landedIn: "d".repeat(40), viaPrHead: true });
    await waitFor(() =>
      expect(view.latest().verdicts.get("up-row")).toBe("clean"),
    );
    expect(view.latest().results.get("up-row")).toMatchObject({
      landedIn: "d".repeat(40),
      viaPrHead: true,
    });

    // The head is spent: neither another head nor a refetch runs it again.
    view.update({
      ...props,
      enabled: true,
      prHeads: new Map([["up-row", "e".repeat(40)]]),
    });
    await act(async () => {
      await view.client.invalidateQueries();
    });
    await flush();
    expect(calls).toHaveLength(2);
    expect(view.latest().verdicts.get("up-row")).toBe("clean");
  });

  it("an upgrade that doesn't land clean keeps the latched changes and never runs again", async () => {
    const repo = "C:/repos/cc-upgrade-keep";
    const branches = ["keep-unknown", "keep-failed", "keep-changes"];
    const props = { repoPath: repo, defaultBranch: "main", branches };
    vi.mocked(gitContentCheckBase).mockResolvedValue(readFor("d"));
    const view = mount({ ...props, enabled: true });
    await waitFor(() => expect(calls).toHaveLength(3));
    for (const call of calls) call.settle("changes");
    await waitFor(() => expect(view.latest().status).toBe("settled"));

    view.update({
      ...props,
      enabled: true,
      prHeads: new Map(branches.map((b) => [b, "f".repeat(40)])),
    });
    await waitFor(() => expect(calls).toHaveLength(6));
    const upgrade = (name: string) =>
      calls.find((c, i) => i >= 3 && c.branch === name);
    upgrade("keep-unknown")?.settle("unknown");
    upgrade("keep-failed")?.fail();
    upgrade("keep-changes")?.settle("changes");
    await flush();

    const latched = new Map(branches.map((b) => [b, "changes"]));
    expect(view.latest().verdicts).toEqual(latched);
    expect(view.latest().results.get("keep-unknown")?.verdict).toBe("changes");
    await act(async () => {
      await view.client.invalidateQueries();
    });
    await flush();
    expect(calls).toHaveLength(6);
    expect(view.latest().verdicts).toEqual(latched);
  });

  it("clean, unknown and failed rows never upgrade", async () => {
    const repo = "C:/repos/cc-no-upgrade";
    const branches = ["nu-clean", "nu-unknown", "nu-failed"];
    const props = { repoPath: repo, defaultBranch: "main", branches };
    vi.mocked(gitContentCheckBase).mockResolvedValue(readFor("e"));
    const view = mount({ ...props, enabled: true });
    await waitFor(() => expect(calls).toHaveLength(3));
    calls[0].settle("clean");
    calls[1].settle("unknown");
    calls[2].fail();
    await waitFor(() => expect(view.latest().status).toBe("settled"));

    view.update({
      ...props,
      enabled: true,
      prHeads: new Map(branches.map((b) => [b, "1".repeat(40)])),
    });
    await flush();
    expect(calls).toHaveLength(3);
    expect(view.latest().verdicts).toEqual(
      new Map([
        ["nu-clean", "clean"],
        ["nu-unknown", "unknown"],
        ["nu-failed", "unknown"],
      ]),
    );
  });

  it("an upgrade landing after a repo switch lands nowhere", async () => {
    const repoA = "C:/repos/cc-upgrade-switch-a";
    const repoB = "C:/repos/cc-upgrade-switch-b";
    vi.mocked(gitContentCheckBase).mockResolvedValueOnce(readFor("1"));
    const view = mount({
      repoPath: repoA,
      defaultBranch: "main",
      branches: ["us-shared"],
      enabled: true,
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    calls[0].settle("changes");
    await waitFor(() => expect(view.latest().status).toBe("settled"));
    view.update({
      repoPath: repoA,
      defaultBranch: "main",
      branches: ["us-shared"],
      enabled: true,
      prHeads: new Map([["us-shared", "2".repeat(40)]]),
    });
    await waitFor(() => expect(calls).toHaveLength(2));

    const baseB = deferred<ContentCheckBaseRead>();
    vi.mocked(gitContentCheckBase).mockReturnValueOnce(baseB.promise);
    view.update({
      repoPath: repoB,
      defaultBranch: "trunk",
      branches: ["us-shared"],
      enabled: true,
    });
    calls[1].settle("clean", { viaPrHead: true });
    await flush();
    expect(view.latest().verdicts.size).toBe(0);
    expect(view.entries(repoA)).toEqual([]);

    await act(async () => baseB.resolve(readFor("3")));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]).toMatchObject({
      repo: repoB,
      branch: "us-shared",
      prHead: null,
    });
    calls[2].settle("changes");
    await waitFor(() => expect(view.latest().status).toBe("settled"));
    expect(view.latest().verdicts).toEqual(new Map([["us-shared", "changes"]]));
  });
});
