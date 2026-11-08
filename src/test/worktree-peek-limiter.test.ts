import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { userWorktreesPeekOptions } from "@/lib/git/queries";
import type { UserWorktree } from "@/lib/git/worktree";

// The recents hint's no-prune worktree read runs through a module-level limiter,
// so a list painting many hinted rows spawns at most three git reads at once.
const h = vi.hoisted(() => ({
  started: [] as string[],
  gates: new Map<
    string,
    { resolve: (rows: UserWorktree[]) => void; reject: (e: unknown) => void }
  >(),
}));

vi.mock("@/lib/git/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/worktree")>()),
  listUserWorktrees: (repo: string) => {
    h.started.push(repo);
    return new Promise<UserWorktree[]>((resolve, reject) => {
      h.gates.set(repo, { resolve, reject });
    });
  },
}));

const REPOS = ["r1", "r2", "r3", "r4", "r5", "r6"].map((r) => `C:/repos/${r}`);

/** Lets the limiter's hand-over continuations run. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const running = () => h.started.filter((repo) => h.gates.has(repo)).length;

describe("worktree peek read limiter", () => {
  it("runs three reads at once and starts the next as each settles or fails", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const reads = REPOS.map((repo) =>
      client
        .fetchQuery(userWorktreesPeekOptions(repo))
        .then(() => "ok" as const)
        .catch(() => "failed" as const),
    );
    await flush();
    expect(h.started).toEqual(REPOS.slice(0, 3));

    const settle = async (repo: string, fail = false) => {
      const gate = h.gates.get(repo);
      h.gates.delete(repo);
      if (fail) gate?.reject(new Error("git failed"));
      else gate?.resolve([]);
      await flush();
    };

    await settle(REPOS[1] as string, true);
    expect(h.started).toEqual(REPOS.slice(0, 4));
    expect(running()).toBe(3);

    await settle(REPOS[0] as string);
    expect(h.started).toEqual(REPOS.slice(0, 5));
    expect(running()).toBe(3);

    await settle(REPOS[2] as string);
    expect(h.started).toEqual(REPOS);
    expect(running()).toBe(3);

    for (const repo of REPOS.slice(3)) await settle(repo);
    expect(running()).toBe(0);
    await expect(Promise.all(reads)).resolves.toEqual([
      "ok",
      "failed",
      "ok",
      "ok",
      "ok",
      "ok",
    ]);
  });

  it("passes a cancelled read's slot on without spawning its git read", async () => {
    h.started.length = 0;
    const repos = ["c1", "c2", "c3", "c4", "c5"].map((r) => `C:/repos/${r}`);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const reads = repos.map((repo) =>
      client
        .fetchQuery(userWorktreesPeekOptions(repo))
        .then(() => "ok" as const)
        .catch(() => "failed" as const),
    );
    await flush();
    expect(h.started).toEqual(repos.slice(0, 3));

    await client.cancelQueries({
      queryKey: userWorktreesPeekOptions(repos[3] as string).queryKey,
    });
    const release = async (repo: string) => {
      h.gates.get(repo)?.resolve([]);
      h.gates.delete(repo);
      await flush();
    };
    await release(repos[0] as string);
    expect(h.started).toEqual([repos[0], repos[1], repos[2], repos[4]]);
    expect(running()).toBe(3);

    for (const repo of [repos[1], repos[2], repos[4]])
      await release(repo as string);
    expect(running()).toBe(0);
    await expect(Promise.all(reads)).resolves.toEqual([
      "ok",
      "ok",
      "ok",
      "failed",
      "ok",
    ]);
  });

  it("lets a read that started at once finish after its last observer leaves", async () => {
    h.started.length = 0;
    const repo = "C:/repos/m1";
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const observer = new QueryObserver(client, userWorktreesPeekOptions(repo));
    const unsubscribe = observer.subscribe(() => undefined);
    await flush();
    expect(h.started).toEqual([repo]);

    unsubscribe();
    await flush();
    h.gates.get(repo)?.resolve([]);
    h.gates.delete(repo);
    await flush();
    expect(
      client.getQueryData(userWorktreesPeekOptions(repo).queryKey),
    ).toEqual([]);
    expect(running()).toBe(0);
  });

  it("still spawns and caches a queued read whose observer leaves before its slot", async () => {
    h.started.length = 0;
    const repos = ["q1", "q2", "q3", "q4"].map((r) => `C:/repos/${r}`);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const fetches = repos
      .slice(0, 3)
      .map((repo) =>
        client.fetchQuery(userWorktreesPeekOptions(repo)).catch(() => null),
      );
    const queued = repos[3] as string;
    const observer = new QueryObserver(
      client,
      userWorktreesPeekOptions(queued),
    );
    const unsubscribe = observer.subscribe(() => undefined);
    await flush();
    expect(h.started).toEqual(repos.slice(0, 3));
    unsubscribe();
    await flush();

    const release = async (repo: string) => {
      h.gates.get(repo)?.resolve([]);
      h.gates.delete(repo);
      await flush();
    };
    await release(repos[0] as string);
    expect(h.started).toEqual(repos);
    await release(queued);
    expect(
      client.getQueryData(userWorktreesPeekOptions(queued).queryKey),
    ).toEqual([]);
    for (const repo of repos.slice(1, 3)) await release(repo as string);
    expect(running()).toBe(0);
    await Promise.all(fetches);
  });

  it("reads the signal only for a read that waited, once its slot arrives", async () => {
    h.started.length = 0;
    const repos = ["s1", "s2", "s3", "s4"].map((r) => `C:/repos/${r}`);
    const contexts = repos.map(() => {
      const ctx = {
        reads: 0,
        get signal() {
          ctx.reads++;
          return new AbortController().signal;
        },
      };
      return ctx;
    });
    const reads = repos.map((repo, i) =>
      userWorktreesPeekOptions(repo).queryFn(contexts[i]),
    );
    await flush();
    expect(h.started).toEqual(repos.slice(0, 3));
    expect(contexts.map((c) => c.reads)).toEqual([0, 0, 0, 0]);

    const release = async (repo: string) => {
      h.gates.get(repo)?.resolve([]);
      h.gates.delete(repo);
      await flush();
    };
    await release(repos[0] as string);
    expect(h.started).toEqual(repos);
    expect(contexts.map((c) => c.reads)).toEqual([0, 0, 0, 1]);
    for (const repo of repos.slice(1)) await release(repo as string);
    expect(running()).toBe(0);
    await Promise.all(reads);
  });
});
