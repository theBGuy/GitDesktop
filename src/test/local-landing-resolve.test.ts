import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgePrHeadRef, repoOriginPath, validateRepo } from "@/lib/git/api";
import type { PrHeadRef, RepoInfo, RepoOrigin } from "@/lib/git/types";
import { listUserWorktrees, type UserWorktree } from "@/lib/git/worktree";
import {
  type LocalLandingTarget,
  openableMatches,
} from "@/lib/local-landing/match";
import {
  LOCAL_LANDING_BUDGET_MS,
  type LocalLanding,
  resolveLocalLanding,
} from "@/lib/local-landing/resolve";
import type { RecentRepo } from "@/lib/settings/api";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  validateRepo: vi.fn(),
  repoOriginPath: vi.fn(),
  forgePrHeadRef: vi.fn(),
}));
vi.mock("@/lib/git/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/worktree")>()),
  listUserWorktrees: vi.fn(),
}));

const validate = vi.mocked(validateRepo);
const origin = vi.mocked(repoOriginPath);
const headRef = vi.mocked(forgePrHeadRef);
const worktrees = vi.mocked(listUserWorktrees);

const PR: LocalLandingTarget = {
  provider: "github",
  host: "github.com",
  authority: "github.com",
  repoOwner: "acme",
  repoName: "widgets",
  repoFullName: "acme/widgets",
  number: 12,
  isPullRequest: true,
};
const ISSUE: LocalLandingTarget = { ...PR, isPullRequest: false };

const PROVEN_ORIGIN: RepoOrigin = {
  host: "github.com",
  authority: "github.com",
  path: "acme/widgets",
  provider: "github",
};

const recent = (path: string, extra: Partial<RecentRepo> = {}): RecentRepo => ({
  path,
  name: path.split("/").at(-1) ?? path,
  lastOpenedAt: "2026-01-01T00:00:00Z",
  host: "github.com",
  owner: "acme",
  repoName: "widgets",
  ...extra,
});

const tree = (path: string, branch: string, isMain = false): UserWorktree => ({
  path,
  branch,
  // The resolver never reads the head sha.
  head: "",
  isMain,
  isDetached: branch === "",
  isLocked: false,
  lockReason: "",
  lastActivityMs: null,
});

/** validate_repo's canonical spelling of a path, so a landing that went through
 *  it is distinguishable from one that kept the recents path. */
const canonical = (path: string): RepoInfo => ({
  root: path.replace(/\//g, "\\"),
  name: `${path.split("/").at(-1)}-validated`,
});

const never = <T>() => new Promise<T>(() => undefined);

/** Every IPC answers at once: each path validates, every origin proves, no
 *  linked worktrees, no head. Cases override what they exercise. */
beforeEach(() => {
  vi.useFakeTimers();
  validate.mockReset().mockImplementation(async (p) => canonical(p));
  origin.mockReset().mockResolvedValue(PROVEN_ORIGIN);
  headRef.mockReset().mockResolvedValue(null as unknown as PrHeadRef);
  worktrees.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Starts a resolve and records when it settles, so a case can step the clock
 *  and read whether it has answered yet. */
function start(
  target: LocalLandingTarget,
  candidates: RecentRepo[],
  opts: { preferWorktree?: boolean; superseded?: () => boolean } = {},
) {
  const state: { result?: LocalLanding; rejected?: unknown } = {};
  resolveLocalLanding(target, candidates, {
    preferWorktree: opts.preferWorktree ?? true,
    superseded: opts.superseded ?? (() => false),
  }).then(
    (r) => {
      state.result = r;
    },
    (e: unknown) => {
      state.rejected = e;
    },
  );
  return state;
}

async function settle(
  target: LocalLandingTarget,
  candidates: RecentRepo[],
  opts: { preferWorktree?: boolean; superseded?: () => boolean } = {},
) {
  const state = start(target, candidates, opts);
  await vi.advanceTimersByTimeAsync(LOCAL_LANDING_BUDGET_MS);
  expect(state.rejected).toBeUndefined();
  return state.result;
}

const ipcCalls = () =>
  validate.mock.calls.length +
  origin.mock.calls.length +
  headRef.mock.calls.length +
  worktrees.mock.calls.length;

describe("resolveLocalLanding", () => {
  it("R1: no candidates opens the browser without an IPC", async () => {
    expect(await settle(PR, [])).toEqual({
      kind: "browser",
      reason: "no-candidate",
    });
    expect(ipcCalls()).toBe(0);
  });

  it("R2: a first folder check that never settles ends at the budget", async () => {
    validate.mockImplementation(() => never());
    const state = start(PR, [recent("C:/a")]);
    await vi.advanceTimersByTimeAsync(LOCAL_LANDING_BUDGET_MS - 1);
    expect(state.result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.result).toEqual({ kind: "browser", reason: "unproven" });
    expect(origin).not.toHaveBeenCalled();
    expect(worktrees).not.toHaveBeenCalled();
  });

  it("R2: a first-check timeout never tries the next candidate", async () => {
    validate.mockImplementation(() => never());
    expect(await settle(PR, [recent("C:/a"), recent("C:/b")])).toEqual({
      kind: "browser",
      reason: "unproven",
    });
    expect(validate).toHaveBeenCalledTimes(1);
    expect(origin).not.toHaveBeenCalled();
  });

  it("R3: one stale candidate reports its path and error", async () => {
    const error = { kind: "notARepo", message: "gone" };
    validate.mockRejectedValue(error);
    expect(await settle(PR, [recent("C:/gone")])).toEqual({
      kind: "browser",
      reason: "stale",
      path: "C:/gone",
      error,
    });
    expect(ipcCalls()).toBe(1);
  });

  it("R4: a stale first candidate falls through to a second that proves", async () => {
    validate.mockRejectedValueOnce({ kind: "notARepo", message: "gone" });
    origin.mockImplementation(async (p) =>
      p === "C:/b" ? PROVEN_ORIGIN : Promise.reject(new Error("no repo")),
    );
    expect(await settle(PR, [recent("C:/a"), recent("C:/b")])).toEqual({
      kind: "local",
      path: "C:/b",
      name: "b",
    });
    expect(origin.mock.calls.map((c) => c[0])).toEqual(["C:/a", "C:/b"]);
  });

  it("R4: two clones that both prove land on the first, with no second origin read", async () => {
    expect(await settle(ISSUE, [recent("C:/a"), recent("C:/b")])).toEqual({
      kind: "local",
      path: "C:/a",
      name: "a",
    });
    expect(origin.mock.calls.map((c) => c[0])).toEqual(["C:/a"]);
  });

  it("R4: the GitLab ambiguous key proves only the second clone", async () => {
    const gl: LocalLandingTarget = {
      ...PR,
      provider: "gitlab",
      host: "gitlab.com",
      authority: "gitlab.com",
      repoOwner: "sub",
      repoFullName: "team-b/sub/widgets",
    };
    origin.mockImplementation(async (p) => ({
      host: "gitlab.com",
      authority: "gitlab.com",
      path: p === "C:/a" ? "team-a/sub/widgets" : "team-b/sub/widgets",
      provider: "gitlab",
    }));
    // The app keys a subgroup project by its immediate parent, so both clones match.
    const glRecent = { host: "gitlab.com", owner: "sub", provider: "gitlab" };
    const candidates = openableMatches(gl, [
      recent("C:/a", glRecent),
      recent("C:/b", glRecent),
    ]);
    expect(candidates.map((r) => r.path)).toEqual(["C:/a", "C:/b"]);
    expect(await settle(gl, candidates)).toEqual({
      kind: "local",
      path: "C:/b",
      name: "b",
    });
  });

  it.each<[string, Partial<RepoOrigin> | null, Partial<LocalLandingTarget>]>([
    ["path", { path: "acme/gadgets" }, {}],
    ["host", { host: "github.example.com" }, {}],
    ["provider", { provider: "gitlab" }, {}],
    ["empty host", { host: "" }, {}],
    ["empty authority", { authority: "" }, {}],
    ["empty path", { path: "" }, {}],
    ["empty provider", { provider: "" }, {}],
    ["no origin", null, {}],
    ["unknown target authority", {}, { authority: null }],
    [
      "ported authority",
      { host: "git.example.com", authority: "git.example.com" },
      { host: "git.example.com", authority: "git.example.com:8443" },
    ],
  ])("R5: the proof refuses on %s", async (_axis, over, targetOver) => {
    origin.mockResolvedValue(
      over === null
        ? (null as unknown as RepoOrigin)
        : { ...PROVEN_ORIGIN, ...over },
    );
    expect(await settle({ ...PR, ...targetOver }, [recent("C:/a")])).toEqual({
      kind: "browser",
      reason: "unproven",
    });
    expect(worktrees).not.toHaveBeenCalled();
  });

  it("R6: the worktree list never prunes", async () => {
    await settle(PR, [recent("C:/a")]);
    expect(worktrees).toHaveBeenCalledTimes(1);
    expect(worktrees).toHaveBeenCalledWith("C:/a", { prune: false });
  });

  it("R7: a matched linked worktree lands on the main workspace", async () => {
    worktrees.mockResolvedValue([
      tree("C:/main", "master", true),
      tree("C:/wt", "feat"),
    ]);
    for (const target of [ISSUE, PR]) {
      expect(await settle(target, [recent("C:/wt")])).toEqual({
        kind: "local",
        path: "C:\\main",
        name: "main-validated",
      });
    }
    expect(validate).toHaveBeenLastCalledWith("C:/main");
  });

  it("R8: a PR whose head is in another worktree lands there, unless the main workspace is asked for", async () => {
    worktrees.mockResolvedValue([
      tree("C:/main", "master", true),
      tree("C:/feat", "feat"),
    ]);
    headRef.mockResolvedValue({
      headRefName: "feat",
      headRepoFullName: "ACME/widgets",
    });
    expect(await settle(PR, [recent("C:/main")])).toEqual({
      kind: "local",
      path: "C:\\feat",
      name: "feat-validated",
    });
    expect(headRef).toHaveBeenCalledWith("github", "C:/main", 12);

    headRef.mockClear();
    expect(
      await settle(PR, [recent("C:/main")], { preferWorktree: false }),
    ).toEqual({ kind: "local", path: "C:/main", name: "main" });
    expect(headRef).not.toHaveBeenCalled();

    expect(await settle(ISSUE, [recent("C:/main")])).toEqual({
      kind: "local",
      path: "C:/main",
      name: "main",
    });
    expect(headRef).not.toHaveBeenCalled();
  });

  it("R9: a head checked out in the matched checkout stays there", async () => {
    worktrees.mockResolvedValue([
      tree("C:/main", "master", true),
      tree("C:/wt", "feat"),
    ]);
    headRef.mockResolvedValue({
      headRefName: "feat",
      headRepoFullName: "acme/widgets",
    });
    expect(await settle(PR, [recent("C:/wt")])).toEqual({
      kind: "local",
      path: "C:/wt",
      name: "wt",
    });
  });

  it("R10: a head from a foreign repository lands on the main workspace", async () => {
    worktrees.mockResolvedValue([
      tree("C:/main", "master", true),
      tree("C:/wt", "feat"),
    ]);
    headRef.mockResolvedValue({
      headRefName: "feat",
      headRepoFullName: "fork/widgets",
    });
    expect(await settle(PR, [recent("C:/wt")])).toEqual({
      kind: "local",
      path: "C:\\main",
      name: "main-validated",
    });
  });

  it("R10: a worktree list that times out keeps the proven checkout", async () => {
    worktrees.mockImplementation(() => never());
    expect(await settle(PR, [recent("C:/wt")])).toEqual({
      kind: "local",
      path: "C:/wt",
      name: "wt",
    });
    expect(headRef).not.toHaveBeenCalled();
  });

  describe("R11: supersession after each leg stops the resolve", () => {
    beforeEach(() => {
      worktrees.mockResolvedValue([
        tree("C:/main", "master", true),
        tree("C:/feat", "feat"),
      ]);
      headRef.mockResolvedValue({
        headRefName: "feat",
        headRepoFullName: "acme/widgets",
      });
    });

    it("after the folder check", async () => {
      let gone = false;
      validate.mockImplementation(async (p) => {
        gone = true;
        return canonical(p);
      });
      expect(
        await settle(PR, [recent("C:/main")], { superseded: () => gone }),
      ).toEqual({ kind: "superseded" });
      expect(origin).not.toHaveBeenCalled();
    });

    it("after the proof", async () => {
      let gone = false;
      origin.mockImplementation(async () => {
        gone = true;
        return PROVEN_ORIGIN;
      });
      expect(
        await settle(PR, [recent("C:/main")], { superseded: () => gone }),
      ).toEqual({ kind: "superseded" });
      expect(worktrees).not.toHaveBeenCalled();
    });

    it("after the worktree list", async () => {
      let gone = false;
      worktrees.mockImplementation(async () => {
        gone = true;
        return [tree("C:/main", "master", true), tree("C:/wt", "feat")];
      });
      expect(
        await settle(PR, [recent("C:/wt")], { superseded: () => gone }),
      ).toEqual({ kind: "superseded" });
      expect(validate).toHaveBeenCalledTimes(1);
      expect(headRef).not.toHaveBeenCalled();
    });

    it("after the main-worktree validation", async () => {
      worktrees.mockResolvedValue([
        tree("C:/main", "master", true),
        tree("C:/wt", "feat"),
      ]);
      let gone = false;
      validate.mockImplementation(async (p) => {
        if (p === "C:/main") gone = true;
        return canonical(p);
      });
      expect(
        await settle(PR, [recent("C:/wt")], { superseded: () => gone }),
      ).toEqual({ kind: "superseded" });
      expect(validate).toHaveBeenCalledTimes(2);
      expect(headRef).not.toHaveBeenCalled();
    });

    it("after the head-ref read", async () => {
      let gone = false;
      headRef.mockImplementation(async () => {
        gone = true;
        return { headRefName: "feat", headRepoFullName: "acme/widgets" };
      });
      expect(
        await settle(PR, [recent("C:/main")], { superseded: () => gone }),
      ).toEqual({ kind: "superseded" });
      expect(validate).toHaveBeenCalledTimes(1);
    });

    it("after the branch-worktree validation", async () => {
      let gone = false;
      validate.mockImplementation(async (p) => {
        if (p === "C:/feat") gone = true;
        return canonical(p);
      });
      expect(
        await settle(PR, [recent("C:/main")], { superseded: () => gone }),
      ).toEqual({ kind: "superseded" });
      expect(validate).toHaveBeenCalledTimes(2);
      expect(ipcCalls()).toBe(5);
    });
  });

  it("R12: every IPC rejecting still resolves, to the browser", async () => {
    validate.mockRejectedValue(new Error("ipc"));
    origin.mockRejectedValue(new Error("ipc"));
    headRef.mockRejectedValue(new Error("ipc"));
    worktrees.mockRejectedValue(new Error("ipc"));
    expect(await settle(PR, [recent("C:/a")])).toMatchObject({
      kind: "browser",
      reason: "stale",
    });
    expect(await settle(PR, [recent("C:/a"), recent("C:/b")])).toEqual({
      kind: "browser",
      reason: "unproven",
    });
  });

  it("R13: an unknown stored provider reads the head through the target's", async () => {
    const gl: LocalLandingTarget = {
      ...PR,
      provider: "gitlab",
      host: "gitlab.com",
      authority: "gitlab.com",
    };
    origin.mockResolvedValue({
      ...PROVEN_ORIGIN,
      host: "gitlab.com",
      authority: "gitlab.com",
      provider: "gitlab",
    });
    worktrees.mockResolvedValue([
      tree("C:/main", "master", true),
      tree("C:/feat", "feat"),
    ]);
    await settle(gl, [recent("C:/main", { provider: "forgejo" })]);
    expect(headRef).toHaveBeenCalledWith("gitlab", "C:/main", 12);
  });

  it("F1: the proof gets only what the folder check left of the one budget", async () => {
    validate.mockImplementation(
      (p) =>
        new Promise<RepoInfo>((resolve) => {
          setTimeout(() => resolve(canonical(p)), 1000);
        }),
    );
    origin.mockImplementation(() => never());
    const state = start(PR, [recent("C:/a")]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(origin).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LOCAL_LANDING_BUDGET_MS - 1 - 1000);
    expect(state.result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.result).toEqual({ kind: "browser", reason: "unproven" });
  });

  it("F6: a retired open starts no further origin read", async () => {
    let gone = false;
    origin.mockImplementation(async () => {
      gone = true;
      return { ...PROVEN_ORIGIN, path: "acme/gadgets" };
    });
    expect(
      await settle(PR, [recent("C:/a"), recent("C:/b")], {
        superseded: () => gone,
      }),
    ).toEqual({ kind: "superseded" });
    expect(origin).toHaveBeenCalledTimes(1);
  });

  it("F7: an IPC answer of an unexpected shape resolves to the browser", async () => {
    origin.mockResolvedValue({
      ...PROVEN_ORIGIN,
      path: null,
    } as unknown as RepoOrigin);
    expect(await settle(PR, [recent("C:/a")])).toEqual({
      kind: "browser",
      reason: "unproven",
    });
  });

  it("N1: a leg that throws after the open was retired resolves to superseded", async () => {
    let gone = false;
    origin.mockImplementation(async () => {
      gone = true;
      return { ...PROVEN_ORIGIN, path: null } as unknown as RepoOrigin;
    });
    expect(
      await settle(PR, [recent("C:/a")], { superseded: () => gone }),
    ).toEqual({ kind: "superseded" });
  });
});
