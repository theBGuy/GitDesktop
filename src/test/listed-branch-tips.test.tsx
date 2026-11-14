import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitBranchTips } from "@/lib/git/api";
import { type ListedBranchTips, useListedBranchTips } from "@/lib/git/queries";
import { unmockedCommands } from "./setup";

// The api module is the seam; the hook and react-query stay real.
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitBranchTips: vi.fn(),
}));

interface Read {
  repo: string;
  names: string[];
  settled: boolean;
  resolve: (tips: Record<string, string>) => void;
  reject: () => void;
}

let reads: Read[] = [];
let latest: ListedBranchTips | null = null;

/** A full object id per digit, distinct per test value. */
const oid = (d: string) => d.repeat(40);

interface Props {
  repoPath: string;
  names: readonly string[];
  enabled: boolean;
}

function Probe({ repoPath, names, enabled }: Props) {
  const tips = useListedBranchTips(repoPath, names, enabled);
  useLayoutEffect(() => {
    latest = tips;
  });
  return null;
}

function mount(props: Props) {
  const client = new QueryClient();
  const tree = (p: Props) => (
    <QueryClientProvider client={client}>
      <Probe {...p} />
    </QueryClientProvider>
  );
  const view = render(tree(props));
  return {
    client,
    update: (next: Props) => view.rerender(tree(next)),
  };
}

/** Lets react-query's batched notifications and the latch's re-render run. */
const flush = () =>
  act(async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  });

/** What the latest commit served, as plain data. */
function state() {
  if (latest === null) throw new Error("nothing committed");
  return {
    tips: Object.fromEntries(latest.tips),
    waiting: [...latest.waiting].sort(),
    failed: [...latest.failed].sort(),
  };
}

const answer = async (i: number, tips: Record<string, string>) => {
  await act(async () => reads[i].resolve(tips));
  await flush();
};

beforeEach(() => {
  reads = [];
  latest = null;
  vi.mocked(gitBranchTips)
    .mockReset()
    .mockImplementation((repo, names) => {
      let resolve!: (tips: Record<string, string>) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<Record<string, string>>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const read: Read = {
        repo,
        names: [...names],
        settled: false,
        resolve: (tips) => {
          read.settled = true;
          resolve(tips);
        },
        reject: () => {
          read.settled = true;
          reject(new Error("tips read failed"));
        },
      };
      reads.push(read);
      return promise;
    });
});

afterEach(async () => {
  for (const read of reads) if (!read.settled) read.resolve({});
  await flush();
  expect(unmockedCommands).toEqual([]);
});

describe("useListedBranchTips", () => {
  it("reads nothing while closed or with no names, then reads the names as they arrive", async () => {
    const repoPath = "C:/repos/lt-cold";
    const view = mount({ repoPath, names: ["c-a"], enabled: false });
    await flush();
    expect(reads).toHaveLength(0);
    // The palette route: the open starts over a cold branch list.
    view.update({ repoPath, names: [], enabled: true });
    await flush();
    expect(reads).toHaveLength(0);
    expect(state()).toEqual({ tips: {}, waiting: [], failed: [] });

    view.update({ repoPath, names: ["c-b", "c-a"], enabled: true });
    await waitFor(() => expect(reads).toHaveLength(1));
    expect(reads[0]).toMatchObject({ repo: repoPath, names: ["c-a", "c-b"] });
    expect(state()).toEqual({ tips: {}, waiting: ["c-a", "c-b"], failed: [] });
    await answer(0, { "c-a": oid("1"), "c-b": oid("2") });
    expect(state()).toEqual({
      tips: { "c-a": oid("1"), "c-b": oid("2") },
      waiting: [],
      failed: [],
    });

    // A name added mid-open is read alone; the earlier tips stay as first read.
    view.update({ repoPath, names: ["c-b", "c-a", "c-new"], enabled: true });
    await waitFor(() => expect(reads).toHaveLength(2));
    expect(reads[1].names).toEqual(["c-new"]);
    expect(state().waiting).toEqual(["c-new"]);
    await answer(1, { "c-new": oid("3"), "c-a": oid("9") });
    expect(state()).toEqual({
      tips: { "c-a": oid("1"), "c-b": oid("2"), "c-new": oid("3") },
      waiting: [],
      failed: [],
    });
    expect(reads).toHaveLength(2);
  });

  it("keeps its first read through a filterless invalidation, relists, and re-reads on a reopen or a repo switch", async () => {
    const repoPath = "C:/repos/lt-latch";
    const other = "C:/repos/lt-latch-other";
    const view = mount({ repoPath, names: ["l-a"], enabled: true });
    await waitFor(() => expect(reads).toHaveLength(1));
    await answer(0, { "l-a": oid("1") });
    expect(state().tips).toEqual({ "l-a": oid("1") });

    await act(() => view.client.invalidateQueries());
    await flush();
    expect(reads).toHaveLength(1);
    expect(state().tips).toEqual({ "l-a": oid("1") });

    act(() => latest?.relist("l-a", oid("5")));
    await flush();
    expect(state()).toEqual({
      tips: { "l-a": oid("5") },
      waiting: [],
      failed: [],
    });
    expect(reads).toHaveLength(1);

    view.update({ repoPath, names: ["l-a"], enabled: false });
    await flush();
    view.update({ repoPath, names: ["l-a"], enabled: true });
    await waitFor(() => expect(reads).toHaveLength(2));
    expect(state()).toEqual({ tips: {}, waiting: ["l-a"], failed: [] });
    await answer(1, { "l-a": oid("2") });
    expect(state().tips).toEqual({ "l-a": oid("2") });

    // A switch never serves the old repo's tips, and drops its cache entries.
    view.update({ repoPath: other, names: ["l-a"], enabled: true });
    await waitFor(() => expect(reads).toHaveLength(3));
    expect(reads[2]).toMatchObject({ repo: other, names: ["l-a"] });
    expect(state()).toEqual({ tips: {}, waiting: ["l-a"], failed: [] });
    await answer(2, { "l-a": oid("3") });
    expect(state().tips).toEqual({ "l-a": oid("3") });
    // Epoch 0 is the closed hook's disabled key, which never fetches.
    const opens = view.client
      .getQueryCache()
      .findAll({ queryKey: ["listed-tips", repoPath] })
      .filter((q) => q.queryKey[2] !== 0 || q.state.data !== undefined);
    expect(opens).toHaveLength(0);
  });

  it("reads a name that appears while a read is in flight with the next read, latching only the current key's answer", async () => {
    const repoPath = "C:/repos/lt-midflight";
    const view = mount({ repoPath, names: ["m-a"], enabled: true });
    await waitFor(() => expect(reads).toHaveLength(1));
    await answer(0, { "m-a": oid("1") });

    view.update({ repoPath, names: ["m-a", "m-b"], enabled: true });
    await waitFor(() => expect(reads).toHaveLength(2));
    expect(reads[1].names).toEqual(["m-b"]);
    expect(state().waiting).toEqual(["m-b"]);

    // m-c arrives while m-b's read runs: the next read asks for both.
    view.update({ repoPath, names: ["m-a", "m-b", "m-c"], enabled: true });
    await waitFor(() => expect(reads).toHaveLength(3));
    expect(reads[2].names).toEqual(["m-b", "m-c"]);
    expect(state().waiting).toEqual(["m-b", "m-c"]);

    // The superseded read's answer latches nothing.
    await answer(1, { "m-b": oid("7") });
    expect(state()).toEqual({
      tips: { "m-a": oid("1") },
      waiting: ["m-b", "m-c"],
      failed: [],
    });

    await answer(2, { "m-b": oid("2"), "m-c": oid("3") });
    expect(state()).toEqual({
      tips: { "m-a": oid("1"), "m-b": oid("2"), "m-c": oid("3") },
      waiting: [],
      failed: [],
    });
    expect(reads).toHaveLength(3);
  });

  it("a reorder of the names never restarts an in-flight read", async () => {
    const repoPath = "C:/repos/lt-reorder";
    const view = mount({ repoPath, names: ["r-b", "r-a"], enabled: true });
    await waitFor(() => expect(reads).toHaveLength(1));
    view.update({ repoPath, names: ["r-a", "r-b"], enabled: true });
    await flush();
    view.update({ repoPath, names: ["r-b", "r-a", "r-b"], enabled: true });
    await flush();
    expect(reads).toHaveLength(1);
    expect(reads[0].names).toEqual(["r-a", "r-b"]);
    await answer(0, { "r-a": oid("1"), "r-b": oid("2") });
    expect(state()).toEqual({
      tips: { "r-a": oid("1"), "r-b": oid("2") },
      waiting: [],
      failed: [],
    });
  });

  it("a failed read latches nothing and is re-read by retry or a new name", async () => {
    const repoPath = "C:/repos/lt-failed";
    const view = mount({ repoPath, names: ["f-a", "f-b"], enabled: true });
    await waitFor(() => expect(reads).toHaveLength(1));
    // Nothing failed yet: retry does nothing.
    act(() => latest?.retry());
    await flush();
    expect(reads).toHaveLength(1);

    await act(async () => reads[0].reject());
    await flush();
    expect(state()).toEqual({ tips: {}, waiting: [], failed: ["f-a", "f-b"] });

    act(() => latest?.retry());
    await waitFor(() => expect(reads).toHaveLength(2));
    expect(reads[1].names).toEqual(["f-a", "f-b"]);
    expect(state()).toEqual({ tips: {}, waiting: ["f-a", "f-b"], failed: [] });
    await act(async () => reads[1].reject());
    await flush();
    expect(state().failed).toEqual(["f-a", "f-b"]);

    // A new name changes the key, so the failed names are read with it.
    view.update({ repoPath, names: ["f-a", "f-b", "f-c"], enabled: true });
    await waitFor(() => expect(reads).toHaveLength(3));
    expect(reads[2].names).toEqual(["f-a", "f-b", "f-c"]);
    expect(state()).toEqual({
      tips: {},
      waiting: ["f-a", "f-b", "f-c"],
      failed: [],
    });
    await answer(2, { "f-a": oid("1"), "f-b": oid("2"), "f-c": oid("3") });
    expect(state()).toEqual({
      tips: { "f-a": oid("1"), "f-b": oid("2"), "f-c": oid("3") },
      waiting: [],
      failed: [],
    });
  });

  it("a name the read answers without is asked, has no tip and is in neither set", async () => {
    const repoPath = "C:/repos/lt-gone";
    mount({ repoPath, names: ["g-a", "g-gone"], enabled: true });
    await waitFor(() => expect(reads).toHaveLength(1));
    await answer(0, { "g-a": oid("1") });
    expect(state()).toEqual({
      tips: { "g-a": oid("1") },
      waiting: [],
      failed: [],
    });
    await flush();
    expect(reads).toHaveLength(1);
  });
});
