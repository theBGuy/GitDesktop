import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNavLensSync } from "@/features/repository/use-nav-lens-sync";
import type { RemoteLens } from "@/lib/git/types";
import { useLensState } from "@/lib/repo-lens/queries";
import { __resetNavHistoryForTests } from "@/lib/stores/nav-history";
import { useUiStore } from "@/lib/stores/ui";

// The history's lens stamp follows the live lens, compared with the stamp
// (never a previous render) and only once the lens reads have answered.

vi.mock("@/lib/repo-lens/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/repo-lens/queries")>()),
  useLensState: vi.fn(),
}));

const REPO = "C:/repos/alpha";
const OTHER = "C:/repos/beta";

const st = () => useUiStore.getState();
const hist = () => st().navHistory;
const issue = (n: number) => ({ kind: "remote" as const, id: String(n) });

let live: { lens: RemoteLens; answered: boolean };

function setLens(lens: RemoteLens, answered = true) {
  live = { lens, answered };
}

/** Opens `root` and records a three-entry trail ending on the Issues tab. */
function trailIn(root: string) {
  st().openRepo({ root, name: root.split("/").pop() ?? root });
  st().setRepoTab("pulls");
  st().setRepoTab("issues");
  st().selectIssue(issue(4));
}

function mount(repoPath: string | null = REPO) {
  return renderHook(({ repo }) => useNavLensSync(repo), {
    initialProps: { repo: repoPath },
  });
}

beforeEach(() => {
  useUiStore.setState(useUiStore.getInitialState(), true);
  __resetNavHistoryForTests();
  setLens("origin", false);
  vi.mocked(useLensState).mockImplementation(() => ({
    gate: live.lens === "upstream",
    lens: live.lens,
    settled: live.answered,
    answered: live.answered,
    waiting: false,
    storedLens: live.lens,
  }));
});

afterEach(() => {
  useUiStore.setState(useUiStore.getInitialState(), true);
  __resetNavHistoryForTests();
});

describe("useNavLensSync", () => {
  it("stamps and re-seeds nothing until the lens reads answer", () => {
    trailIn(REPO);
    const before = hist();
    setLens("upstream", false);
    mount();
    expect(hist()).toBe(before);
    expect(hist().lens).toBeNull();
  });

  it("stamps an origin answer over a null stamp and keeps every entry", () => {
    trailIn(REPO);
    const { entries, index } = hist();
    setLens("origin");
    mount();
    expect(hist().lens).toBe("origin");
    expect(hist().entries).toBe(entries);
    expect(hist().index).toBe(index);
  });

  it("re-seeds at the current location when a cold fork answers upstream", () => {
    trailIn(REPO);
    expect(hist().entries.length).toBeGreaterThan(1);
    setLens("upstream");
    mount();
    expect(hist().lens).toBe("upstream");
    expect(hist().entries).toHaveLength(1);
    expect(hist().index).toBe(0);
    expect(hist().entries[0]).toMatchObject({
      tab: "issues",
      selection: { selectedIssue: issue(4) },
    });
  });

  it("re-seeds in the commit that renders a flip made while mounted", () => {
    trailIn(REPO);
    setLens("origin");
    const hook = mount();
    expect(hist().entries.length).toBeGreaterThan(1);
    setLens("upstream");
    act(() => hook.rerender({ repo: REPO }));
    expect(hist().lens).toBe("upstream");
    expect(hist().entries).toHaveLength(1);
  });

  it("keeps the trail across an unmount and remount under an unchanged lens", () => {
    trailIn(REPO);
    setLens("origin");
    mount().unmount();
    st().setRepoTab("tags");
    const kept = hist();
    expect(kept.entries.length).toBeGreaterThan(1);
    mount();
    expect(hist()).toBe(kept);
  });

  it("re-seeds on remount when the lens changed while unmounted", () => {
    trailIn(REPO);
    setLens("origin");
    mount().unmount();
    setLens("upstream");
    mount();
    expect(hist().lens).toBe("upstream");
    expect(hist().entries).toHaveLength(1);
  });

  it("keeps a switched-to repo's entries recorded before its lens answers origin", () => {
    trailIn(REPO);
    setLens("origin");
    const hook = mount();
    expect(hist().lens).toBe("origin");
    setLens("origin", false);
    act(() => trailIn(OTHER));
    act(() => hook.rerender({ repo: OTHER }));
    expect(hist().lens).toBeNull();
    const { entries, index } = hist();
    expect(entries.length).toBeGreaterThan(1);
    setLens("origin");
    act(() => hook.rerender({ repo: OTHER }));
    expect(hist().lens).toBe("origin");
    expect(hist().entries).toBe(entries);
    expect(hist().index).toBe(index);
  });

  it("writes nothing without an open repository", () => {
    trailIn(REPO);
    const before = hist();
    setLens("upstream");
    mount(null);
    expect(hist()).toBe(before);
  });
});
