import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useBranchPickerOptions } from "@/features/pulls/useBranchPickerOptions";
import type { Branch } from "@/lib/git/types";

const branch = (name: string): Branch =>
  ({ name, archived: false, keepLocal: false }) as unknown as Branch;

const h = vi.hoisted(() => ({ branches: [] as Branch[] }));

vi.mock("@/lib/git/queries", () => ({
  useBranches: () => ({ data: h.branches }),
  useUserWorktrees: () => ({ data: [] }),
}));

describe("useBranchPickerOptions", () => {
  it("drops agent-session branches whatever their letter case", () => {
    h.branches = [
      branch("GD/Session/x"),
      branch("gd/session/y"),
      branch("feature"),
    ];
    const { result } = renderHook(() => useBranchPickerOptions("/r", true));
    expect(result.current.names).toEqual(["feature"]);
    expect(Object.keys(result.current.items)).toEqual(["feature"]);
  });
});
