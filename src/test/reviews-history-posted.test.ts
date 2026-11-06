import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listReviews,
  markReviewPosted,
  type PersistedReview,
  reviewPostedAt,
  saveReview,
  updateReviewText,
} from "@/lib/pulls/reviews-history";

// One in-memory store behind every seam the review store writes through: the
// identity key is the raw repo path, and the lock and rollback just run.
const data = vi.hoisted(() => new Map<string, unknown>());
// The next store write waits on (and settles with) this promise when set.
const writeGate = vi.hoisted(() => ({
  next: null as Promise<void> | null,
}));
// The next store read takes its value at call time, then waits on this promise.
const readGate = vi.hoisted(() => ({
  next: null as Promise<void> | null,
}));

vi.mock("@/lib/plugin-store", () => {
  const store = {
    get: async (key: string) => {
      const value = data.get(key);
      const gate = readGate.next;
      readGate.next = null;
      if (gate) await gate;
      return value;
    },
    set: async (key: string, value: unknown) => {
      const gate = writeGate.next;
      writeGate.next = null;
      if (gate) await gate;
      data.set(key, structuredClone(value));
    },
    save: async () => undefined,
  };
  return {
    memoizedStoreLoader: () => async () => store,
    reloadToleratingEmptyStore: async () => undefined,
  };
});
vi.mock("@/lib/app-store-lock", () => ({
  withAppStoreLock: (_file: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("@/lib/plugin-store-rollback", () => ({
  writeWithRollback: (_store: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("@/lib/git/repo-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/repo-identity")>()),
  repoIdentity: async (repo: string) => repo,
  foldIdentityKey: async (
    _store: unknown,
    _tag: string,
    _repo: string,
    identity: string,
  ) => identity,
}));

const REPO = "C:/repos/demo";

function record(
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
    model: "model-a",
    title: "A PR",
    text: `findings ${id}`,
    headSha: "abc",
    startedAt: 1_000,
    finishedAt: 2_000,
    ...extra,
  };
}

const stored = () => (data.get(REPO) ?? []) as PersistedReview[];

beforeEach(() => {
  data.clear();
});

describe("markReviewPosted", () => {
  it("stamps the named record and only it", async () => {
    await saveReview(REPO, record("a", { finishedAt: 2_000 }));
    await saveReview(REPO, record("b", { finishedAt: 3_000 }));
    await markReviewPosted(REPO, "a", 5_000);
    const byId = Object.fromEntries(stored().map((r) => [r.id, r]));
    expect(byId.a.postedAt).toBe(5_000);
    expect(byId.b.postedAt).toBeUndefined();
  });

  it("is a no-op for an id the store no longer holds", async () => {
    await saveReview(REPO, record("a"));
    const before = structuredClone(stored());
    await markReviewPosted(REPO, "gone", 5_000);
    expect(stored()).toEqual(before);
  });

  it("round-trips through listReviews without reordering", async () => {
    await saveReview(REPO, record("old", { finishedAt: 2_000 }));
    await saveReview(REPO, record("new", { finishedAt: 3_000 }));
    await markReviewPosted(REPO, "old", 9_000);
    const list = await listReviews(REPO, "origin", "remote", "7");
    expect(list.map((r) => r.id)).toEqual(["new", "old"]);
    expect(list[1].postedAt).toBe(9_000);
  });

  it("survives a trim: updateReviewText keeps the stamp", async () => {
    await saveReview(REPO, record("a", { postedAt: 4_000 }));
    await updateReviewText(REPO, "a", "trimmed");
    expect(stored()[0]).toMatchObject({ text: "trimmed", postedAt: 4_000 });
  });

  // Ids are unique per test: the pending-stamp overlay is module state.
  it("reads a record posted while its stamp's write is still pending", async () => {
    await saveReview(REPO, record("held"));
    let release!: () => void;
    writeGate.next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stamp = markReviewPosted(REPO, "held", 7_000);
    // A read that starts after the request, before the write persists.
    const during = await listReviews(REPO, "origin", "remote", "7");
    expect(stored()[0].postedAt).toBeUndefined();
    expect(during[0].postedAt).toBe(7_000);
    release();
    await stamp;
    const after = await listReviews(REPO, "origin", "remote", "7");
    expect(after[0].postedAt).toBe(7_000);
  });

  it("reads a record posted when the read spans the stamp's successful write", async () => {
    await saveReview(REPO, record("span"));
    let releaseWrite!: () => void;
    writeGate.next = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const stamp = markReviewPosted(REPO, "span", 9_500);
    // Let the write reach its gated `set`, past its own store read.
    await new Promise((resolve) => setTimeout(resolve, 0));
    let releaseRead!: () => void;
    readGate.next = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    // Starts after the request and holds the pre-write store copy.
    const reading = listReviews(REPO, "origin", "remote", "7");
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseWrite();
    await stamp;
    releaseRead();
    expect((await reading)[0].postedAt).toBe(9_500);
  });

  it("reads a record posted when the stamp's whole write runs inside the read", async () => {
    await saveReview(REPO, record("inside"));
    let releaseRead!: () => void;
    readGate.next = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    // Starts before the request and holds the unposted store copy.
    const reading = listReviews(REPO, "origin", "remote", "7");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await markReviewPosted(REPO, "inside", 9_700);
    releaseRead();
    expect((await reading)[0].postedAt).toBe(9_700);
  });

  it("keeps a successful stamp as a session receipt", async () => {
    await saveReview(REPO, record("kept"));
    await markReviewPosted(REPO, "kept", 9_900);
    // A store copy that lacks the stamp (another path's stale read, say).
    data.set(REPO, [record("kept")]);
    const list = await listReviews(REPO, "origin", "remote", "7");
    expect(list[0].postedAt).toBe(9_900);
  });

  it("keeps a record posted for the session after its stamp's write rejects", async () => {
    await saveReview(REPO, record("receipt"));
    writeGate.next = Promise.reject(new Error("store down"));
    await expect(markReviewPosted(REPO, "receipt", 8_000)).rejects.toThrow(
      "store down",
    );
    // Store truth is unposted; the comment landed, so reads still say posted.
    expect(stored()[0].postedAt).toBeUndefined();
    const list = await listReviews(REPO, "origin", "remote", "7");
    expect(list[0].postedAt).toBe(8_000);
    expect(
      (await listReviews(REPO, "origin", "remote", "7", { fresh: true }))[0]
        .postedAt,
    ).toBe(8_000);
  });

  it("orders after a save it follows in the queue", async () => {
    const save = saveReview(REPO, record("late"));
    const stamp = markReviewPosted(REPO, "late", 6_000);
    await Promise.all([save, stamp]);
    expect(stored()[0].postedAt).toBe(6_000);
  });
});

describe("reviewPostedAt", () => {
  it("reads a valid epoch through", () => {
    expect(reviewPostedAt({ postedAt: 1_700_000_000_000 })).toBe(
      1_700_000_000_000,
    );
  });

  it("reads absent and hostile stamps as unposted", () => {
    expect(reviewPostedAt({})).toBeUndefined();
    expect(
      reviewPostedAt({ postedAt: "123" as unknown as number }),
    ).toBeUndefined();
    expect(reviewPostedAt({ postedAt: Number.NaN })).toBeUndefined();
    expect(reviewPostedAt({ postedAt: 1e20 })).toBeUndefined();
  });
});
