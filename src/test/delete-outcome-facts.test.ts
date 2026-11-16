import { beforeEach, describe, expect, it, vi } from "vitest";
import { gitDeleteBranch } from "@/lib/git/api/branches";
import { removeWorktree } from "@/lib/git/worktree";
import { invoke } from "@/lib/tauri/invoke";

vi.mock("@/lib/tauri/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri/invoke")>()),
  invoke: vi.fn(),
}));

const REPO = "C:/repos/demo";
const TIP = "a".repeat(40);

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("gitDeleteBranch's outcome facts", () => {
  it.each([
    ["a string", "yes"],
    ["undefined", undefined],
    ["null", null],
    ["a number", 1],
  ])("reads a Keep local mark that is %s as marked", async (_label, wire) => {
    vi.mocked(invoke).mockResolvedValueOnce({
      status: "deleted",
      tip: TIP,
      keptLocal: wire,
      upstream: "origin/x",
    });
    expect(await gitDeleteBranch(REPO, "feat", TIP)).toEqual({
      status: "deleted",
      tip: TIP,
      keptLocal: true,
      upstream: "origin/x",
    });
  });

  it("passes an unmarked branch through and drops an upstream that isn't a string", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      status: "deleted",
      tip: TIP,
      keptLocal: false,
      upstream: 42,
    });
    expect(await gitDeleteBranch(REPO, "feat", TIP)).toEqual({
      status: "deleted",
      tip: TIP,
      keptLocal: false,
      upstream: null,
    });
  });

  it("leaves a tip-moved answer as it came", async () => {
    const moved = { status: "tipMoved", expected: TIP, actual: "b".repeat(40) };
    vi.mocked(invoke).mockResolvedValueOnce(moved);
    expect(await gitDeleteBranch(REPO, "feat", TIP)).toEqual(moved);
  });
});

describe("removeWorktree's outcome facts", () => {
  it("reads a deleted branch's mark that isn't a boolean as marked", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      branchCleanup: "deleted",
      branchTip: TIP,
      branchKeptLocal: "yes",
      branchUpstream: 42,
      tipMoved: null,
    });
    expect(await removeWorktree(REPO, "C:/wt", "feat", false, TIP)).toEqual({
      branchCleanup: "deleted",
      branchTip: TIP,
      branchKeptLocal: true,
      branchUpstream: null,
      tipMoved: null,
    });
  });

  it("passes a deleted branch's facts through", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      branchCleanup: "deleted",
      branchTip: TIP,
      branchKeptLocal: false,
      branchUpstream: "origin/feat",
      tipMoved: null,
    });
    expect(await removeWorktree(REPO, "C:/wt", "feat", false, TIP)).toEqual({
      branchCleanup: "deleted",
      branchTip: TIP,
      branchKeptLocal: false,
      branchUpstream: "origin/feat",
      tipMoved: null,
    });
  });

  it("carries no mark for a branch it spared", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      branchCleanup: "sparedMoved",
      branchTip: null,
      branchKeptLocal: true,
      branchUpstream: null,
      tipMoved: { expected: TIP, actual: "b".repeat(40) },
    });
    expect(
      (await removeWorktree(REPO, "C:/wt", "feat", false, TIP)).branchKeptLocal,
    ).toBeNull();
  });
});
