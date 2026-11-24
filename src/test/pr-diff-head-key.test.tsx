import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgePrDiff, forgePrView } from "@/lib/git/api";
import {
  prContentRevsOptions,
  prDetailsOptions,
  prDiffOptions,
  usePrDetails,
  usePrDiff,
  usePrefetchPr,
} from "@/lib/git/queries";
import { type PrDetails, prHeadSha } from "@/lib/git/types";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgePrView: vi.fn(),
  forgePrDiff: vi.fn(),
}));

const REPO = "C:/repo";
const H0 = "9".repeat(40);
const H1 = "1".repeat(40);
const H2 = "2".repeat(40);

/** The head each pull request's details name now ("" = none). */
let heads: Record<number, string> = {};
/** Per-number overrides of the details read (a held or failing answer). */
let views: Record<number, () => Promise<PrDetails>> = {};

/** The forge serves its current head, so the diff text follows `heads`. */
const textOf = (number: number, head: string | undefined) =>
  `diff --git a/f.txt b/f.txt\n@@ -1 +1 @@\n-old\n+${number}@${head}\n`;

const details = (number: number, headSha: string): PrDetails =>
  ({ number, state: "OPEN", headSha, commits: [] }) as unknown as PrDetails;

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

const detailsKey = (number: number) =>
  prDetailsOptions(REPO, number, "origin").queryKey;
const diffKey = (number: number, head: string | null) =>
  prDiffOptions(REPO, number, "origin", head).queryKey;

const clients: QueryClient[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  heads = { 7: H1, 8: H1 };
  views = {};
  vi.mocked(forgePrView).mockImplementation(async (_repo, number) =>
    views[number] ? views[number]() : details(number, heads[number] ?? ""),
  );
  vi.mocked(forgePrDiff).mockImplementation(async (_repo, number) =>
    textOf(number, heads[number]),
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

/** The pane's diff read, fed the head as RemotePrView feeds it. */
function useShownDiff(number: number | null) {
  const read = usePrDetails(REPO, number, "origin");
  const head =
    read.data !== undefined && !read.isPlaceholderData
      ? (prHeadSha(read.data) ?? null)
      : undefined;
  return usePrDiff(REPO, number, "origin", head);
}

function mount(number = 7, existing?: ReturnType<typeof newClient>) {
  const { client, wrapper } = existing ?? newClient();
  const hook = renderHook(({ n }) => useShownDiff(n), {
    wrapper,
    initialProps: { n: number as number | null },
  });
  return { client, wrapper, hook };
}

/** The details answer the head `heads` now holds (an exact re-read). */
const moveHead = (client: QueryClient, number: number, head: string) => {
  heads[number] = head;
  return act(() =>
    client.invalidateQueries({ queryKey: detailsKey(number), exact: true }),
  );
};

describe("the head-keyed pull request diff", () => {
  it("AC-A2: a head move re-reads, painting the older head's diff meanwhile", async () => {
    const { client, hook } = mount();
    await waitFor(() => expect(hook.result.current.data).toBe(textOf(7, H1)));
    expect(forgePrDiff).toHaveBeenCalledTimes(1);
    expect(hook.result.current.placeholderOf).toBe("none");
    const next = deferred<string>();
    vi.mocked(forgePrDiff).mockImplementationOnce(() => next.promise);
    await moveHead(client, 7, H2);
    await waitFor(() => expect(forgePrDiff).toHaveBeenCalledTimes(2));
    expect(hook.result.current.data).toBe(textOf(7, H1));
    expect(hook.result.current.isPlaceholderData).toBe(true);
    expect(hook.result.current.placeholderOf).toBe("olderHead");
    await act(async () => next.resolve(textOf(7, H2)));
    await waitFor(() => expect(hook.result.current.data).toBe(textOf(7, H2)));
    expect(hook.result.current.isPlaceholderData).toBe(false);
    expect(hook.result.current.placeholderOf).toBe("none");
  });

  it("AC-A3: no diff read starts before the details answer", async () => {
    const answer = deferred<PrDetails>();
    views[7] = () => answer.promise;
    const { client, hook } = mount();
    await sleep(30);
    expect(forgePrDiff).not.toHaveBeenCalled();
    expect(hook.result.current.data).toBeUndefined();
    await act(async () => answer.resolve(details(7, H1)));
    await waitFor(() => expect(forgePrDiff).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(client.getQueryData(diffKey(7, H1))).toBe(textOf(7, H1)),
    );
  });

  it("AC-A3: details that name no head read once under null", async () => {
    heads[7] = "";
    const { client, hook } = mount();
    await waitFor(() => expect(hook.result.current.data).toBe(textOf(7, "")));
    expect(forgePrDiff).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(diffKey(7, null))).toBe(textOf(7, ""));
  });

  it("AC-A3: the unanswered phase never paints a head-less entry as its own", async () => {
    const { client, wrapper } = newClient();
    client.setQueryData(diffKey(7, null), "T0");
    views[7] = () => new Promise<PrDetails>(() => undefined);
    const { hook } = mount(7, { client, wrapper });
    await sleep(30);
    expect(
      hook.result.current.isPlaceholderData ||
        hook.result.current.data === undefined,
    ).toBe(true);
    expect(forgePrDiff).not.toHaveBeenCalled();
  });

  it("AC-A3 / AC-A8: a switch serves the record it left as another record's, and waits for the target's details", async () => {
    const { hook } = mount();
    await waitFor(() => expect(hook.result.current.data).toBe(textOf(7, H1)));
    const answer = deferred<PrDetails>();
    views[8] = () => answer.promise;
    hook.rerender({ n: 8 });
    await sleep(30);
    expect(forgePrDiff).toHaveBeenCalledTimes(1);
    expect(hook.result.current.data).toBe(textOf(7, H1));
    expect(hook.result.current.isPlaceholderData).toBe(true);
    expect(hook.result.current.placeholderOf).toBe("otherRecord");
    await act(async () => answer.resolve(details(8, H1)));
    await waitFor(() => expect(hook.result.current.data).toBe(textOf(8, H1)));
    expect(hook.result.current.placeholderOf).toBe("none");
  });

  it("AC-A4: the AI sites resolve from the view's entry without another read", async () => {
    const { client, hook } = mount();
    await waitFor(() => expect(hook.result.current.data).toBe(textOf(7, H1)));
    await expect(
      client.ensureQueryData(prDiffOptions(REPO, 7, "origin", H1)),
    ).resolves.toBe(textOf(7, H1));
    expect(forgePrDiff).toHaveBeenCalledTimes(1);
  });

  it("AC-A5: a failed first read of a new head keeps this pull request's last diff, and Retry reads the new head", async () => {
    const { client, hook } = mount();
    await waitFor(() => expect(hook.result.current.data).toBe(textOf(7, H1)));
    vi.mocked(forgePrDiff).mockRejectedValueOnce(new Error("offline blip"));
    await moveHead(client, 7, H2);
    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    expect(hook.result.current.data).toBe(textOf(7, H1));
    expect(hook.result.current.isPlaceholderData).toBe(true);
    expect(hook.result.current.placeholderOf).toBe("olderHead");
    await act(async () => {
      await hook.result.current.refetch();
    });
    await waitFor(() => expect(hook.result.current.data).toBe(textOf(7, H2)));
    expect(hook.result.current.isError).toBe(false);
    expect(client.getQueryData(diffKey(7, H2))).toBe(textOf(7, H2));
  });

  it("AC-A5: another pull request's diff is never retained", async () => {
    const { hook } = mount();
    await waitFor(() => expect(hook.result.current.data).toBe(textOf(7, H1)));
    vi.mocked(forgePrDiff).mockRejectedValueOnce(new Error("failed"));
    hook.rerender({ n: 8 });
    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    expect(hook.result.current.data).toBeUndefined();
    expect(hook.result.current.placeholderOf).not.toBe("olderHead");
  });

  it("AC-A6: hover prefetch reads the details, then the diff under their head", async () => {
    const { client, wrapper } = newClient();
    const { result } = renderHook(() => usePrefetchPr(REPO, "origin"), {
      wrapper,
    });
    act(() => result.current(7));
    await waitFor(() =>
      expect(client.getQueryData(diffKey(7, H1))).toBe(textOf(7, H1)),
    );
    expect(forgePrView).toHaveBeenCalledTimes(1);
    expect(forgePrDiff).toHaveBeenCalledTimes(1);
    // A warm row costs nothing more.
    act(() => result.current(7));
    await sleep(30);
    expect(forgePrView).toHaveBeenCalledTimes(1);
    expect(forgePrDiff).toHaveBeenCalledTimes(1);
    // A failed details read prefetches no diff and rejects nothing unhandled.
    views[9] = () => Promise.reject(new Error("no such pull request"));
    act(() => result.current(9));
    await sleep(30);
    expect(forgePrView).toHaveBeenCalledTimes(2);
    expect(forgePrDiff).toHaveBeenCalledTimes(1);
  });
});

describe("the sweep of other heads' diff entries", () => {
  it("AC-A9: after the new head lands, unobserved older-head entries go; others stay", async () => {
    const { client, wrapper, hook } = mount();
    await waitFor(() => expect(hook.result.current.data).toBe(textOf(7, H1)));
    // Seeded beside the view: another pull request, the other lens, the revs.
    const otherPr = diffKey(8, H1);
    const otherLens = prDiffOptions(REPO, 7, "upstream", H1).queryKey;
    const revs = prContentRevsOptions(REPO, 7, "origin", H1).queryKey;
    client.setQueryData(otherPr, "other pr");
    client.setQueryData(otherLens, "other lens");
    client.setQueryData(revs, { oldSha: H0, newSha: H1 });
    client.setQueryData(diffKey(7, H0), "unobserved H0");
    const next = deferred<string>();
    vi.mocked(forgePrDiff).mockImplementationOnce(() => next.promise);
    await moveHead(client, 7, H2);
    await waitFor(() => expect(forgePrDiff).toHaveBeenCalledTimes(2));
    // Serving a placeholder: no sweep yet.
    await sleep(20);
    expect(client.getQueryData(diffKey(7, H0))).toBe("unobserved H0");
    await act(async () => next.resolve(textOf(7, H2)));
    await waitFor(() => expect(hook.result.current.placeholderOf).toBe("none"));
    await waitFor(() =>
      expect(
        client.getQueryCache().find({ queryKey: diffKey(7, H1), exact: true }),
      ).toBeUndefined(),
    );
    expect(
      client.getQueryCache().find({ queryKey: diffKey(7, H0), exact: true }),
    ).toBeUndefined();
    expect(client.getQueryData(diffKey(7, H2))).toBe(textOf(7, H2));
    expect(client.getQueryData(otherPr)).toBe("other pr");
    expect(client.getQueryData(otherLens)).toBe("other lens");
    expect(client.getQueryData(revs)).toEqual({ oldSha: H0, newSha: H1 });
    // An observed older-head entry stays.
    const observer = renderHook(
      () => useQuery(prDiffOptions(REPO, 7, "origin", H1)),
      { wrapper },
    );
    await waitFor(() =>
      expect(observer.result.current.data).toBe(textOf(7, H2)),
    );
    await moveHead(client, 7, H0);
    await waitFor(() => expect(hook.result.current.data).toBe(textOf(7, H0)));
    await waitFor(() =>
      expect(
        client.getQueryCache().find({ queryKey: diffKey(7, H2), exact: true }),
      ).toBeUndefined(),
    );
    expect(
      client.getQueryCache().find({ queryKey: diffKey(7, H1), exact: true }),
    ).toBeDefined();
  });

  it("AC-A9: a retained failure does not sweep", async () => {
    const { client, hook } = mount();
    await waitFor(() => expect(hook.result.current.data).toBe(textOf(7, H1)));
    client.setQueryData(diffKey(7, H0), "unobserved H0");
    vi.mocked(forgePrDiff).mockRejectedValueOnce(new Error("failed"));
    await moveHead(client, 7, H2);
    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    await sleep(20);
    expect(client.getQueryData(diffKey(7, H0))).toBe("unobserved H0");
    expect(client.getQueryData(diffKey(7, H1))).toBe(textOf(7, H1));
  });

  it("AC-A9: a cold load in flight is spared and its waiter resolves; a refetch over data is removed", async () => {
    const coldH1 = deferred<string>();
    vi.mocked(forgePrDiff).mockImplementationOnce(() => coldH1.promise);
    const { client, hook } = mount();
    await waitFor(() => expect(forgePrDiff).toHaveBeenCalledTimes(1));
    const waiter = client.ensureQueryData(prDiffOptions(REPO, 7, "origin", H1));
    await moveHead(client, 7, H2);
    await waitFor(() => expect(hook.result.current.data).toBe(textOf(7, H2)));
    await sleep(20);
    expect(client.getQueryState(diffKey(7, H1))?.fetchStatus).toBe("fetching");
    await act(async () => coldH1.resolve("H1 text"));
    await expect(waiter).resolves.toBe("H1 text");
    // A refetch over data on an unobserved older head goes with the next landing.
    const hang = new Promise<string>(() => undefined);
    vi.mocked(forgePrDiff).mockImplementationOnce(() => hang);
    const refetch = client.refetchQueries({
      queryKey: diffKey(7, H1),
      exact: true,
      type: "all",
    });
    await moveHead(client, 7, H0);
    await waitFor(() => expect(hook.result.current.data).toBe(textOf(7, H0)));
    await waitFor(() =>
      expect(
        client.getQueryCache().find({ queryKey: diffKey(7, H1), exact: true }),
      ).toBeUndefined(),
    );
    await expect(refetch).resolves.toBeUndefined();
  });

  it("AC-A9: H1 -> H2 -> H1 after a repo-wide refetch reads H1 again", async () => {
    const { client, hook } = mount();
    await waitFor(() => expect(hook.result.current.data).toBe(textOf(7, H1)));
    // A whole-repo settle while the details still name H1: H1's active entry
    // is refetched beside the details and receives the forge's H2 text.
    heads[7] = H2;
    await act(() => client.invalidateQueries({ queryKey: ["repo", REPO] }));
    await waitFor(() => {
      expect(hook.result.current.data).toBe(textOf(7, H2));
      expect(hook.result.current.placeholderOf).toBe("none");
    });
    await sleep(20);
    const n = vi.mocked(forgePrDiff).mock.calls.length;
    await moveHead(client, 7, H1);
    await waitFor(() => expect(forgePrDiff).toHaveBeenCalledTimes(n + 1));
    await waitFor(() => expect(hook.result.current.data).toBe(textOf(7, H1)));
  });
});
