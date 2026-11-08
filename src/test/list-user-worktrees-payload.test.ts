import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  userWorktreesOptions,
  userWorktreesPeekOptions,
  worktreeKey,
} from "@/lib/git/queries";
import { listUserWorktrees } from "@/lib/git/worktree";
import { invoke } from "@/lib/tauri/invoke";

vi.mock("@/lib/tauri/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri/invoke")>()),
  invoke: vi.fn(async () => []),
}));

const REPO = "C:/repos/demo";
const COMMAND = "git_worktree_list_user";

beforeEach(() => {
  vi.mocked(invoke).mockClear();
});

describe("listUserWorktrees payload", () => {
  it.each<[string, Parameters<typeof listUserWorktrees>[1]]>([
    ["no options", undefined],
    ["empty options", {}],
    ["prune: true", { prune: true }],
  ])("sends no prune key with %s", async (_name, opts) => {
    await listUserWorktrees(REPO, opts);
    expect(vi.mocked(invoke).mock.calls).toStrictEqual([
      [COMMAND, { repoPath: REPO }],
    ]);
  });

  it("sends prune: false only when asked to skip the prune", async () => {
    await listUserWorktrees(REPO, { prune: false });
    expect(vi.mocked(invoke).mock.calls).toStrictEqual([
      [COMMAND, { repoPath: REPO, prune: false }],
    ]);
  });
});

describe("user worktree query options", () => {
  it("keeps the pruning read for the shared options and skips it for the peek", async () => {
    await userWorktreesOptions(REPO).queryFn();
    await userWorktreesPeekOptions(REPO).queryFn();
    expect(vi.mocked(invoke).mock.calls).toStrictEqual([
      [COMMAND, { repoPath: REPO }],
      [COMMAND, { repoPath: REPO, prune: false }],
    ]);
  });

  it("files the peek under the pruned list's key, so its invalidations reach it", async () => {
    const client = new QueryClient();
    const peekKey = userWorktreesPeekOptions(REPO).queryKey;
    client.setQueryData(peekKey, []);
    client.setQueryData(userWorktreesOptions(REPO).queryKey, []);
    expect(peekKey).not.toEqual(worktreeKey(REPO));
    await client.invalidateQueries({ queryKey: worktreeKey(REPO) });
    expect(client.getQueryState(peekKey)?.isInvalidated).toBe(true);
    expect(
      client.getQueryState(userWorktreesOptions(REPO).queryKey)?.isInvalidated,
    ).toBe(true);
  });
});
