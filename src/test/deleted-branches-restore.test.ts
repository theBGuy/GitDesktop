import { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deletedToastOptions,
  readTipState,
  readTipStates,
  restoreAllAndReport,
  restoreAndReport,
  restoreDeletedBranch,
} from "@/lib/deleted-branches/restore";
import {
  type DeletedBranchEntry,
  forgetDeletedBranch,
} from "@/lib/deleted-branches/store";
import {
  gitBranches,
  gitBranchTips,
  gitCreateBranch,
  gitFindCommitsByPrefix,
  gitObjectsPresent,
  gitSetBranchKeepLocal,
} from "@/lib/git/api";
import type { Branch, CommitPrefixMatch } from "@/lib/git/types";
import { useUiStore } from "@/lib/stores/ui";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitBranches: vi.fn(),
  gitBranchTips: vi.fn(),
  gitCreateBranch: vi.fn(),
  gitFindCommitsByPrefix: vi.fn(),
  gitObjectsPresent: vi.fn(),
  gitSetBranchKeepLocal: vi.fn(),
}));
vi.mock("@/lib/deleted-branches/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/deleted-branches/store")>()),
  forgetDeletedBranch: vi.fn(),
}));

const REPO = "C:/repos/demo";
const TIP = "abcdef0123456789abcdef0123456789abcdef01";
// A commit git has pruned.
const GONE = "9".repeat(40);
// Another branch's commit.
const OTHER = "c".repeat(40);

const localBranch = (name: string) => ({ name }) as Branch;

function entry(
  overrides: Partial<DeletedBranchEntry> = {},
): DeletedBranchEntry {
  return {
    id: "id-1",
    name: "feat/x",
    tip: TIP,
    deletedAt: 1_000,
    keptLocal: false,
    upstream: null,
    ...overrides,
  };
}

const match = (hash: string): CommitPrefixMatch =>
  ({ commit: { hash }, onBranch: false }) as CommitPrefixMatch;

/** `feat/x` listed at `tip`, or not listed at all for null. */
function nameAt(tip: string | null) {
  vi.mocked(gitBranches).mockResolvedValue(
    tip === null ? [] : [localBranch("feat/x")],
  );
  vi.mocked(gitBranchTips).mockResolvedValue(
    tip === null ? {} : { "feat/x": tip },
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(gitBranchTips).mockResolvedValue({});
  vi.mocked(gitBranches).mockResolvedValue([]);
  vi.mocked(gitObjectsPresent).mockResolvedValue(true);
  vi.mocked(gitFindCommitsByPrefix).mockResolvedValue([]);
  vi.mocked(gitSetBranchKeepLocal).mockResolvedValue(undefined);
  vi.mocked(gitCreateBranch).mockResolvedValue(undefined);
  vi.mocked(forgetDeletedBranch).mockResolvedValue(true);
});

describe("readTipState", () => {
  it("is present on the first read's yes, without the second read", async () => {
    await expect(readTipState(REPO, TIP)).resolves.toBe("present");
    expect(gitObjectsPresent).toHaveBeenCalledWith(REPO, [TIP]);
    expect(gitFindCommitsByPrefix).not.toHaveBeenCalled();
  });

  it("is pruned only when the prefix read confirms the first read's no", async () => {
    vi.mocked(gitObjectsPresent).mockResolvedValue(false);
    await expect(readTipState(REPO, TIP)).resolves.toBe("pruned");
    expect(gitFindCommitsByPrefix).toHaveBeenCalledWith(REPO, TIP);
  });

  it("is present when the prefix read finds the commit after a false no", async () => {
    vi.mocked(gitObjectsPresent).mockResolvedValue(false);
    vi.mocked(gitFindCommitsByPrefix).mockResolvedValue([
      match(TIP.toUpperCase()),
    ]);
    await expect(readTipState(REPO, TIP)).resolves.toBe("present");
  });

  it("is unknown when either read fails", async () => {
    vi.mocked(gitObjectsPresent).mockRejectedValueOnce(new Error("spawn"));
    await expect(readTipState(REPO, TIP)).resolves.toBe("unknown");
    vi.mocked(gitObjectsPresent).mockResolvedValue(false);
    vi.mocked(gitFindCommitsByPrefix).mockRejectedValue(new Error("spawn"));
    await expect(readTipState(REPO, TIP)).resolves.toBe("unknown");
  });
});

describe("readTipStates", () => {
  const OTHER = "0".repeat(39) + "1";

  it("is one IPC when every tip is present", async () => {
    const states = await readTipStates(REPO, [TIP, OTHER, TIP]);
    expect(gitObjectsPresent).toHaveBeenCalledTimes(1);
    expect(gitObjectsPresent).toHaveBeenCalledWith(REPO, [TIP, OTHER]);
    expect([...states]).toEqual([
      [TIP, "present"],
      [OTHER, "present"],
    ]);
  });

  it("never calls a false pruned without the confirming read", async () => {
    vi.mocked(gitObjectsPresent).mockImplementation(
      async (_r, oids) => oids.length === 1 && oids[0] === TIP,
    );
    vi.mocked(gitFindCommitsByPrefix).mockRejectedValue(new Error("spawn"));
    const states = await readTipStates(REPO, [TIP, OTHER]);
    expect(states.get(TIP)).toBe("present");
    expect(states.get(OTHER)).toBe("unknown");
    vi.mocked(gitFindCommitsByPrefix).mockResolvedValue([]);
    expect((await readTipStates(REPO, [OTHER])).get(OTHER)).toBe("pruned");
  });

  it("reads nothing for no tips", async () => {
    expect((await readTipStates(REPO, [])).size).toBe(0);
    expect(gitObjectsPresent).not.toHaveBeenCalled();
  });
});

describe("restoreDeletedBranch", () => {
  it("re-creates the branch at its tip without checking it out, then forgets it", async () => {
    const e = entry();
    await expect(restoreDeletedBranch(REPO, e)).resolves.toEqual({
      status: "restored",
    });
    expect(gitBranches).toHaveBeenCalledWith(REPO);
    expect(gitBranchTips).not.toHaveBeenCalled();
    expect(gitCreateBranch).toHaveBeenCalledWith(
      REPO,
      "feat/x",
      false,
      TIP,
      true,
    );
    expect(gitSetBranchKeepLocal).not.toHaveBeenCalled();
    expect(forgetDeletedBranch).toHaveBeenCalledWith(REPO, "id-1");
    // Name check, then tip state, then the create, then the forget.
    const order = [
      vi.mocked(gitBranches).mock.invocationCallOrder[0],
      vi.mocked(gitObjectsPresent).mock.invocationCallOrder[0],
      vi.mocked(gitCreateBranch).mock.invocationCallOrder[0],
      vi.mocked(forgetDeletedBranch).mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("refuses a name that exists again at another commit and creates nothing", async () => {
    nameAt(OTHER);
    await expect(
      restoreDeletedBranch(REPO, entry({ keptLocal: true })),
    ).resolves.toEqual({ status: "nameExists" });
    expect(gitObjectsPresent).not.toHaveBeenCalled();
    expect(gitCreateBranch).not.toHaveBeenCalled();
    expect(gitSetBranchKeepLocal).not.toHaveBeenCalled();
    expect(forgetDeletedBranch).not.toHaveBeenCalled();
  });

  it("counts a name already back at the recorded tip as restored, marking it Keep local before the forget", async () => {
    nameAt(TIP.toUpperCase());
    await expect(
      restoreDeletedBranch(REPO, entry({ keptLocal: true })),
    ).resolves.toEqual({ status: "restored", alreadyBack: true });
    expect(forgetDeletedBranch).toHaveBeenCalledWith(REPO, "id-1");
    expect(gitCreateBranch).not.toHaveBeenCalled();
    expect(vi.mocked(gitSetBranchKeepLocal).mock.calls).toEqual([
      [REPO, "feat/x", true],
    ]);
    expect(
      vi.mocked(gitSetBranchKeepLocal).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(forgetDeletedBranch).mock.invocationCallOrder[0]);
  });

  it("leaves an unmarked entry's name at the recorded tip unmarked", async () => {
    nameAt(TIP);
    await expect(restoreDeletedBranch(REPO, entry())).resolves.toEqual({
      status: "restored",
      alreadyBack: true,
    });
    expect(forgetDeletedBranch).toHaveBeenCalledWith(REPO, "id-1");
    expect(gitSetBranchKeepLocal).not.toHaveBeenCalled();
  });

  it("refuses a pruned commit and creates nothing", async () => {
    vi.mocked(gitObjectsPresent).mockResolvedValue(false);
    await expect(
      restoreDeletedBranch(REPO, entry({ keptLocal: true })),
    ).resolves.toEqual({ status: "pruned" });
    expect(gitCreateBranch).not.toHaveBeenCalled();
    expect(gitSetBranchKeepLocal).not.toHaveBeenCalled();
    expect(forgetDeletedBranch).not.toHaveBeenCalled();
  });

  it("proceeds on an unknown tip state, letting git decide", async () => {
    vi.mocked(gitObjectsPresent).mockRejectedValue(new Error("spawn"));
    await expect(restoreDeletedBranch(REPO, entry())).resolves.toEqual({
      status: "restored",
    });
    expect(gitCreateBranch).toHaveBeenCalledTimes(1);
  });

  it("marks a kept entry Keep local BEFORE the create", async () => {
    await restoreDeletedBranch(REPO, entry({ keptLocal: true }));
    expect(gitSetBranchKeepLocal).toHaveBeenCalledTimes(1);
    expect(gitSetBranchKeepLocal).toHaveBeenCalledWith(REPO, "feat/x", true);
    expect(
      vi.mocked(gitSetBranchKeepLocal).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(gitCreateBranch).mock.invocationCallOrder[0]);
  });

  it("creates nothing when the mark fails", async () => {
    const error = new Error("config locked");
    vi.mocked(gitSetBranchKeepLocal).mockRejectedValue(error);
    await expect(
      restoreDeletedBranch(REPO, entry({ keptLocal: true })),
    ).resolves.toEqual({ status: "failed", error });
    expect(gitCreateBranch).not.toHaveBeenCalled();
    expect(forgetDeletedBranch).not.toHaveBeenCalled();
  });

  it("leaves the mark after a failed create when git confirms the name absent", async () => {
    const error = new Error("bad object");
    vi.mocked(gitCreateBranch).mockRejectedValue(error);
    await expect(
      restoreDeletedBranch(REPO, entry({ keptLocal: true })),
    ).resolves.toEqual({ status: "failed", error });
    expect(gitBranches).toHaveBeenCalledWith(REPO);
    expect(vi.mocked(gitSetBranchKeepLocal).mock.calls).toEqual([
      [REPO, "feat/x", true],
    ]);
    expect(forgetDeletedBranch).not.toHaveBeenCalled();
  });

  it("leaves the mark on a branch someone created at another commit", async () => {
    vi.mocked(gitCreateBranch).mockRejectedValue(
      new Error("a branch named 'feat/x' already exists"),
    );
    // Absent at the pre-check, created at another commit before the create.
    nameAt(OTHER);
    vi.mocked(gitBranches).mockResolvedValueOnce([]);
    await expect(
      restoreDeletedBranch(REPO, entry({ keptLocal: true })),
    ).resolves.toEqual({ status: "nameExists" });
    expect(gitSetBranchKeepLocal).not.toHaveBeenCalledWith(
      REPO,
      "feat/x",
      false,
    );
    expect(forgetDeletedBranch).not.toHaveBeenCalled();
  });

  it("counts a create that landed despite rejecting as restored, keeping the mark", async () => {
    const error = new Error("ipc timeout");
    vi.mocked(gitCreateBranch).mockRejectedValue(error);
    nameAt(TIP);
    vi.mocked(gitBranches).mockResolvedValueOnce([]);
    await expect(
      restoreDeletedBranch(REPO, entry({ keptLocal: true })),
    ).resolves.toEqual({ status: "restored" });
    expect(forgetDeletedBranch).toHaveBeenCalledWith(REPO, "id-1");
    expect(gitSetBranchKeepLocal).not.toHaveBeenCalledWith(
      REPO,
      "feat/x",
      false,
    );
  });

  it("leaves the mark when the checked branch read fails, even if the tips read answers absent", async () => {
    const error = new Error("bad object");
    vi.mocked(gitCreateBranch).mockRejectedValue(error);
    // git_branch_tips ignores git's exit code: a failed run reads as "absent".
    vi.mocked(gitBranchTips).mockResolvedValue({});
    vi.mocked(gitBranches)
      .mockResolvedValueOnce([])
      .mockRejectedValue(new Error("for-each-ref failed"));
    await expect(
      restoreDeletedBranch(REPO, entry({ keptLocal: true })),
    ).resolves.toEqual({ status: "failed", error });
    expect(gitSetBranchKeepLocal).not.toHaveBeenCalledWith(
      REPO,
      "feat/x",
      false,
    );
    expect(forgetDeletedBranch).not.toHaveBeenCalled();
  });

  it("refuses a recorded tip that isn't a full object id before any git call", async () => {
    const outcome = await restoreDeletedBranch(
      REPO,
      entry({ tip: "main", keptLocal: true }),
    );
    expect(outcome.status).toBe("failed");
    expect(gitBranchTips).not.toHaveBeenCalled();
    expect(gitObjectsPresent).not.toHaveBeenCalled();
    expect(gitSetBranchKeepLocal).not.toHaveBeenCalled();
    expect(gitCreateBranch).not.toHaveBeenCalled();
  });

  it("an unmarked entry's failed create never touches Keep local", async () => {
    vi.mocked(gitCreateBranch).mockRejectedValue(new Error("bad object"));
    await restoreDeletedBranch(REPO, entry());
    expect(gitSetBranchKeepLocal).not.toHaveBeenCalled();
  });

  it("maps a failed checked name read to failed before any mark, even if the tips read answers absent", async () => {
    const error = new Error("for-each-ref failed");
    vi.mocked(gitBranches).mockRejectedValue(error);
    vi.mocked(gitBranchTips).mockResolvedValue({});
    await expect(
      restoreDeletedBranch(REPO, entry({ keptLocal: true })),
    ).resolves.toEqual({ status: "failed", error });
    expect(gitSetBranchKeepLocal).not.toHaveBeenCalled();
    expect(gitCreateBranch).not.toHaveBeenCalled();
  });
});

describe("restoreAllAndReport", () => {
  let success: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    success = vi.spyOn(toast, "success");
    error = vi.spyOn(toast, "error");
    useUiStore.setState({ repoPath: REPO });
  });
  afterEach(() => {
    success.mockRestore();
    error.mockRestore();
  });

  it("restores in order and reports every one restored", async () => {
    const client = new QueryClient();
    await restoreAllAndReport(client, REPO, [
      entry({ id: "a", name: "feat/a" }),
      entry({ id: "b", name: "feat/b", upstream: "origin/feat/b" }),
    ]);
    expect(vi.mocked(gitCreateBranch).mock.calls.map((c) => c[1])).toEqual([
      "feat/a",
      "feat/b",
    ]);
    expect(success).toHaveBeenCalledWith("Restored 2 branches", {
      description: "Upstream links weren't restored.",
    });
  });

  it("drops the upstream sentence for a name already back, keeping Keep local", async () => {
    nameAt(TIP);
    const client = new QueryClient();
    await restoreAndReport(
      client,
      REPO,
      entry({ keptLocal: true, upstream: "origin/feat/x" }),
    );
    expect(gitCreateBranch).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledWith("Restored feat/x", {
      description: "Keep local is on again.",
    });
  });

  it("keeps the upstream sentence for a restore that created the branch", async () => {
    const client = new QueryClient();
    await restoreAndReport(
      client,
      REPO,
      entry({ keptLocal: true, upstream: "origin/feat/x" }),
    );
    expect(gitCreateBranch).toHaveBeenCalledTimes(1);
    expect(success).toHaveBeenCalledWith("Restored feat/x", {
      description:
        "Keep local is on again. Its upstream link to origin/feat/x wasn't restored.",
    });
  });

  it("raises no upstream note for a batch whose only upstream is already back", async () => {
    vi.mocked(gitBranches).mockResolvedValue([localBranch("feat/b")]);
    vi.mocked(gitBranchTips).mockResolvedValue({ "feat/b": TIP });
    const client = new QueryClient();
    await restoreAllAndReport(client, REPO, [
      entry({ id: "a", name: "feat/a" }),
      entry({ id: "b", name: "feat/b", upstream: "origin/feat/b" }),
    ]);
    expect(vi.mocked(gitCreateBranch).mock.calls.map((c) => c[1])).toEqual([
      "feat/a",
    ]);
    expect(success).toHaveBeenCalledWith("Restored 2 branches", undefined);
  });

  it("names how many couldn't be restored and why", async () => {
    vi.mocked(gitBranches).mockResolvedValue([localBranch("feat/b")]);
    vi.mocked(gitBranchTips).mockResolvedValue({ "feat/b": OTHER });
    vi.mocked(gitObjectsPresent).mockImplementation(
      async (_r, oids) => oids[0] !== GONE,
    );
    const client = new QueryClient();
    await restoreAllAndReport(client, REPO, [
      entry({ id: "a", name: "feat/a" }),
      entry({ id: "b", name: "feat/b" }),
      entry({ id: "c", name: "feat/c", tip: GONE }),
    ]);
    expect(error).toHaveBeenCalledWith("Restored 1 of 3 branches", {
      duration: 15_000,
      description:
        "2 couldn't be restored: a branch with that name exists again (1); Git has removed the commit (1). They're still listed in Recover lost work.",
    });
  });
});

describe("deletedToastOptions", () => {
  let success: ReturnType<typeof vi.spyOn>;
  let info: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  let dismiss: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    success = vi.spyOn(toast, "success");
    info = vi.spyOn(toast, "info");
    error = vi.spyOn(toast, "error");
    dismiss = vi.spyOn(toast, "dismiss");
    useUiStore.setState({ repoPath: REPO });
  });
  afterEach(() => {
    for (const spy of [success, info, error, dismiss]) spy.mockRestore();
  });

  /** A press on the toast's action, as sonner hands it the click event. */
  function press(options: ReturnType<typeof deletedToastOptions>) {
    const event = {
      currentTarget: { blur: vi.fn() } as unknown as HTMLElement,
      preventDefault: vi.fn(),
    };
    options.action?.onClick(event);
    return event;
  }

  it("keeps an unrecorded entry's notice open through a refused restore, then dismisses it once restored", async () => {
    const e = entry();
    const options = deletedToastOptions(
      new QueryClient(),
      REPO,
      [e],
      new Set([e.id]),
      true,
    );
    expect(options.id).toEqual(expect.any(String));
    expect(options.duration).toBe(Number.POSITIVE_INFINITY);
    nameAt(OTHER);
    expect(press(options).preventDefault).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(info).toHaveBeenCalledWith("Couldn't restore feat/x", {
        description:
          "A branch with that name exists again, and nothing was overwritten. Rename or delete it, then press Restore on the delete notice, which stays open.",
      }),
    );
    expect(dismiss).not.toHaveBeenCalled();
    expect(gitCreateBranch).not.toHaveBeenCalled();
    nameAt(null);
    press(options);
    await vi.waitFor(() =>
      expect(success).toHaveBeenCalledWith("Restored feat/x", undefined),
    );
    expect(dismiss).toHaveBeenCalledWith(options.id);
  });

  it("ignores a press while its restore runs", async () => {
    const e = entry();
    const options = deletedToastOptions(
      new QueryClient(),
      REPO,
      [e],
      new Set([e.id]),
      true,
    );
    const read = deferred<Branch[]>();
    vi.mocked(gitBranches).mockImplementationOnce(() => read.promise);
    press(options);
    expect(press(options).preventDefault).toHaveBeenCalledTimes(1);
    expect(gitBranches).toHaveBeenCalledTimes(1);
    read.resolve([]);
    await vi.waitFor(() => expect(dismiss).toHaveBeenCalledWith(options.id));
    expect(gitCreateBranch).toHaveBeenCalledTimes(1);
    expect(success).toHaveBeenCalledTimes(1);
  });

  it("retries only the entries a batch press left unsettled, pointing at the open notice", async () => {
    const a = entry({ id: "a", name: "feat/a" });
    const b = entry({ id: "b", name: "feat/b" });
    const options = deletedToastOptions(
      new QueryClient(),
      REPO,
      [a, b],
      new Set(["b"]),
    );
    expect(options.description).toBe(
      "Couldn't add 1 of them to Recover lost work. Restore them from this notice.",
    );
    vi.mocked(gitCreateBranch).mockImplementation(async (_r, name) => {
      if (name === "feat/b") throw new Error("config locked");
    });
    press(options);
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith("Restored 1 of 2 branches", {
        duration: 15_000,
        description:
          "1 couldn't be restored: Git refused (1). The delete notice stays open so you can retry.",
      }),
    );
    expect(dismiss).not.toHaveBeenCalled();
    vi.mocked(gitCreateBranch).mockClear();
    vi.mocked(gitCreateBranch).mockResolvedValue(undefined);
    press(options);
    await vi.waitFor(() => expect(dismiss).toHaveBeenCalledWith(options.id));
    expect(vi.mocked(gitCreateBranch).mock.calls.map((c) => c[1])).toEqual([
      "feat/b",
    ]);
    expect(success).toHaveBeenCalledWith("Restored 1 branch", undefined);
  });

  it("keeps sonner's close-on-press and the Recover lost work copy when every entry was recorded", async () => {
    const e = entry();
    const options = deletedToastOptions(
      new QueryClient(),
      REPO,
      [e],
      new Set(),
      true,
    );
    expect(options.id).toBeUndefined();
    expect(options.duration).toBe(15_000);
    expect(options.description).toBeUndefined();
    nameAt(OTHER);
    expect(press(options).preventDefault).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(info).toHaveBeenCalledWith("Couldn't restore feat/x", {
        description:
          "A branch with that name exists again, and nothing was overwritten. Rename or delete it, then restore from Recover lost work.",
      }),
    );
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("starts one restore when a recorded single-entry toast is pressed twice", async () => {
    const e = entry();
    const options = deletedToastOptions(
      new QueryClient(),
      REPO,
      [e],
      new Set(),
      true,
    );
    press(options);
    press(options);
    await vi.waitFor(() =>
      expect(success).toHaveBeenCalledWith("Restored feat/x", undefined),
    );
    await vi.waitFor(() => expect(forgetDeletedBranch).toHaveBeenCalled());
    expect(gitCreateBranch).toHaveBeenCalledTimes(1);
    expect(success).toHaveBeenCalledTimes(1);
  });

  it("restores each entry once when a recorded batch toast is pressed twice", async () => {
    const options = deletedToastOptions(
      new QueryClient(),
      REPO,
      [entry({ id: "a", name: "feat/a" }), entry({ id: "b", name: "feat/b" })],
      new Set(),
    );
    press(options);
    press(options);
    await vi.waitFor(() =>
      expect(success).toHaveBeenCalledWith("Restored 2 branches", undefined),
    );
    expect(vi.mocked(gitCreateBranch).mock.calls.map((c) => c[1])).toEqual([
      "feat/a",
      "feat/b",
    ]);
    expect(success).toHaveBeenCalledTimes(1);
  });
});
