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

vi.mock("@/lib/plugin-store", () => {
  const store = {
    get: async (key: string) => data.get(key),
    set: async (key: string, value: unknown) => {
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
