import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getLatestPartialReview,
  type PersistedReview,
  reviewPartialKey,
} from "@/lib/pulls/reviews-history";

// One in-memory store behind every seam the review store reads through: the
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

const completed: PersistedReview = {
  schemaVersion: 1,
  id: "done",
  kind: "remote",
  ref: "7",
  lens: "origin",
  mode: "general",
  model: "model-a",
  title: "A PR",
  text: "findings",
  headSha: "abc",
  startedAt: 1_000,
  finishedAt: 2_000,
};

afterEach(() => data.clear());

describe("getLatestPartialReview as a query", () => {
  // react-query v5 fails a query whose queryFn resolves undefined, so "no partial
  // kept" must answer null for the panel's read to settle as a success.
  it.each([
    ["an empty store", [] as PersistedReview[]],
    ["a store holding only a completed review", [completed]],
  ])("settles with null data for %s", async (_label, records) => {
    data.set(REPO, records);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const queryKey = reviewPartialKey(REPO, "origin", "remote", "7");
    await client
      .fetchQuery({
        queryKey,
        queryFn: () => getLatestPartialReview(REPO, "origin", "remote", "7"),
        networkMode: "always",
      })
      .catch(() => undefined);
    const state = client.getQueryState(queryKey);
    expect(state?.status).toBe("success");
    expect(state?.data).toBeNull();
    client.clear();
  });
});
