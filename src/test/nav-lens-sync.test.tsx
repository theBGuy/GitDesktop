import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNavLensSync } from "@/features/repository/use-nav-lens-sync";
import type { RemoteLens } from "@/lib/git/types";
import { useLensState, useUpstreamRemoteGone } from "@/lib/repo-lens/queries";
import {
  __resetNavHistoryForTests,
  currentSegment,
} from "@/lib/stores/nav-history";
import { useUiStore } from "@/lib/stores/ui";

// The history's lens stamp follows the live lens, compared with the stamp
// (never a previous render) and only once the lens reads have answered; a
// remote selection recorded under Upstream drops once the remote is gone.

vi.mock("@/lib/repo-lens/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/repo-lens/queries")>()),
  useLensState: vi.fn(),
  useUpstreamRemoteGone: vi.fn(),
}));

const REPO = "C:/repos/alpha";
const OTHER = "C:/repos/beta";

const st = () => useUiStore.getState();
const hist = () => st().navHistory;
const entries = () => currentSegment(hist())?.entries ?? [];
const lens = () => currentSegment(hist())?.lens ?? null;
const issue = (n: number) => ({ kind: "remote" as const, id: String(n) });

let live: {
  lens: RemoteLens;
  answered: boolean;
  stored: RemoteLens;
  upstreamGone: boolean;
};

/** The live lens, with the stored choice equal to it and the remote present. */
function setLens(lens: RemoteLens, answered = true) {
  live = { lens, answered, stored: lens, upstreamGone: false };
}

/** The reads after `git remote remove upstream`: the list answered without the
 *  remote, the stored choice still Upstream, the gated lens on the fork. */
function setRemoteGone(over: Partial<typeof live> = {}) {
  live = {
    lens: "origin",
    answered: true,
    stored: "upstream",
    upstreamGone: true,
    ...over,
  };
}

/** Mounts over a trail whose segment a cold fork re-seeded as "upstream", then
 *  selects remote issue 7 under that stamp. */
function mountOnUpstream(repoPath = REPO) {
  setLens("upstream");
  const hook = mount(repoPath);
  expect(lens()).toBe("upstream");
  act(() => st().selectIssue(issue(7)));
  return hook;
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
    storedLens: live.stored,
  }));
  vi.mocked(useUpstreamRemoteGone).mockImplementation(() => live.upstreamGone);
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
    expect(lens()).toBeNull();
  });

  it("stamps an origin answer over a null stamp and keeps every entry", () => {
    trailIn(REPO);
    const { index } = hist();
    const kept = entries();
    setLens("origin");
    mount();
    expect(lens()).toBe("origin");
    expect(entries()).toBe(kept);
    expect(hist().index).toBe(index);
  });

  it("re-seeds at the current location when a cold fork answers upstream", () => {
    trailIn(REPO);
    expect(entries().length).toBeGreaterThan(1);
    setLens("upstream");
    mount();
    expect(lens()).toBe("upstream");
    expect(entries()).toHaveLength(1);
    expect(hist().index).toBe(0);
    expect(entries()[0]).toMatchObject({
      tab: "issues",
      selection: { selectedIssue: issue(4) },
    });
  });

  it("re-seeds on a flip made while mounted", () => {
    trailIn(REPO);
    setLens("origin");
    const hook = mount();
    expect(entries().length).toBeGreaterThan(1);
    setLens("upstream");
    act(() => hook.rerender({ repo: REPO }));
    expect(lens()).toBe("upstream");
    expect(entries()).toHaveLength(1);
  });

  it("keeps the trail across an unmount and remount under an unchanged lens", () => {
    trailIn(REPO);
    setLens("origin");
    mount().unmount();
    st().setRepoTab("tags");
    const kept = hist();
    expect(currentSegment(kept)?.entries.length).toBeGreaterThan(1);
    mount();
    expect(hist()).toBe(kept);
  });

  it("re-seeds on remount when the lens changed while unmounted", () => {
    trailIn(REPO);
    setLens("origin");
    mount().unmount();
    setLens("upstream");
    mount();
    expect(lens()).toBe("upstream");
    expect(entries()).toHaveLength(1);
  });

  it("keeps a switched-to repo's entries recorded before its lens answers origin", () => {
    trailIn(REPO);
    setLens("origin");
    const hook = mount();
    expect(lens()).toBe("origin");
    setLens("origin", false);
    act(() => trailIn(OTHER));
    act(() => hook.rerender({ repo: OTHER }));
    expect(lens()).toBeNull();
    const { index } = hist();
    const kept = entries();
    expect(kept.length).toBeGreaterThan(1);
    setLens("origin");
    act(() => hook.rerender({ repo: OTHER }));
    expect(lens()).toBe("origin");
    expect(entries()).toBe(kept);
    expect(hist().index).toBe(index);
  });

  it("after a carried cross-repo landing, syncs only the landing's segment", () => {
    trailIn(REPO);
    setLens("origin");
    const hook = mount();
    const departed = hist().segments[0];
    expect(departed.lens).toBe("origin");
    act(() =>
      st().openIssue({
        repoPath: OTHER,
        repoName: "beta",
        number: 9,
        carryHistory: true,
      }),
    );
    setLens("origin");
    act(() => hook.rerender({ repo: OTHER }));
    expect(hist().segments).toHaveLength(2);
    expect(hist().segments[0].entries).toEqual(departed.entries);
    expect(currentSegment(hist())?.repoPath).toBe(OTHER);
    expect(lens()).toBe("origin");
    act(() => st().setRepoTab("tags"));
    const trail = hist().segments[0];
    expect(entries()).toHaveLength(2);
    setLens("upstream");
    act(() => hook.rerender({ repo: OTHER }));
    expect(hist().segments).toHaveLength(2);
    expect(hist().segments[0]).toBe(trail);
    expect(lens()).toBe("upstream");
    expect(entries()).toEqual([
      { tab: "tags", selection: { selectedTag: null }, anchor: null },
    ]);
    expect(hist()).toMatchObject({ segment: 1, index: 0 });
  });

  it("a null repo prop writes nothing", () => {
    trailIn(REPO);
    const before = hist();
    // The store's own repo check would refuse too; the spy sees the hook's guard.
    const syncNavLens = vi.fn(st().syncNavLens);
    useUiStore.setState({ syncNavLens });
    setLens("upstream");
    mount(null);
    expect(syncNavLens).not.toHaveBeenCalled();
    expect(hist()).toBe(before);
  });
});

describe("useNavLensSync when the upstream remote is gone", () => {
  it("drops a remote issue recorded under Upstream and re-seeds as origin", () => {
    trailIn(REPO);
    const hook = mountOnUpstream();
    setRemoteGone();
    act(() => hook.rerender({ repo: REPO }));
    expect(st().selectedIssue).toBeNull();
    expect(lens()).toBe("origin");
    expect(entries()).toHaveLength(1);
    expect(entries()[0].selection.selectedIssue ?? null).toBeNull();
  });

  it("drops a remote pull request with its pending review and align", () => {
    trailIn(REPO);
    const hook = mountOnUpstream();
    act(() => {
      st().setRepoTab("pulls");
      st().selectPr({ kind: "remote", id: "12" });
      useUiStore.setState({ pendingReviewId: "r1", pendingPrAlign: true });
    });
    setRemoteGone();
    act(() => hook.rerender({ repo: REPO }));
    expect(st()).toMatchObject({
      selectedPr: null,
      pendingReviewId: null,
      pendingPrAlign: false,
    });
    expect(lens()).toBe("origin");
  });

  it("keeps a local pull request under the same reads", () => {
    trailIn(REPO);
    const hook = mountOnUpstream();
    const local = { kind: "local" as const, id: "draft-1" };
    act(() => {
      st().setRepoTab("pulls");
      st().selectPr(local);
    });
    setRemoteGone();
    act(() => hook.rerender({ repo: REPO }));
    expect(st().selectedPr).toEqual(local);
    expect(lens()).toBe("origin");
  });

  it("keeps the issue while the list still offers the remote", () => {
    trailIn(REPO);
    const hook = mountOnUpstream();
    setRemoteGone({ upstreamGone: false });
    act(() => hook.rerender({ repo: REPO }));
    expect(st().selectedIssue).toEqual(issue(7));
    expect(lens()).toBe("origin");
    expect(entries()).toHaveLength(1);
    expect(entries()[0].selection).toMatchObject({ selectedIssue: issue(7) });
  });

  it("keeps the issue when the stored lens is origin", () => {
    trailIn(REPO);
    const hook = mountOnUpstream();
    setRemoteGone({ stored: "origin" });
    act(() => hook.rerender({ repo: REPO }));
    expect(st().selectedIssue).toEqual(issue(7));
    expect(lens()).toBe("origin");
  });

  it("keeps the issue and every entry under a null stamp", () => {
    trailIn(REPO);
    const { index } = hist();
    const kept = entries();
    setRemoteGone();
    mount();
    expect(st().selectedIssue).toEqual(issue(4));
    expect(lens()).toBe("origin");
    expect(entries()).toBe(kept);
    expect(hist().index).toBe(index);
  });

  it("drops it before the forge status answers, and never again after", () => {
    trailIn(REPO);
    const hook = mountOnUpstream();
    setRemoteGone({ answered: false });
    act(() => hook.rerender({ repo: REPO }));
    expect(st().selectedIssue).toBeNull();
    expect(lens()).toBe("origin");
    act(() => st().selectIssue(issue(8)));
    const before = hist();
    setRemoteGone();
    act(() => hook.rerender({ repo: REPO }));
    expect(st().selectedIssue).toEqual(issue(8));
    expect(hist()).toBe(before);
  });

  it("drops it when only the remotes answer changes", () => {
    trailIn(REPO);
    const hook = mountOnUpstream();
    // Unanswered, so the stamp holds "upstream" across the live "origin".
    setRemoteGone({ answered: false, upstreamGone: false });
    act(() => hook.rerender({ repo: REPO }));
    expect(st().selectedIssue).toEqual(issue(7));
    expect(lens()).toBe("upstream");
    setRemoteGone({ answered: false });
    act(() => hook.rerender({ repo: REPO }));
    expect(st().selectedIssue).toBeNull();
    expect(lens()).toBe("origin");
  });

  it("drops it when only the stored lens changes back to Upstream", () => {
    trailIn(REPO);
    const hook = mountOnUpstream();
    // The remote reads gone, but the stored choice is Fork: nothing drops.
    setRemoteGone({ answered: false, stored: "origin" });
    act(() => hook.rerender({ repo: REPO }));
    expect(st().selectedIssue).toEqual(issue(7));
    expect(lens()).toBe("upstream");
    setRemoteGone({ answered: false });
    act(() => hook.rerender({ repo: REPO }));
    expect(st().selectedIssue).toBeNull();
    expect(lens()).toBe("origin");
  });

  it("clears once when Strict Mode replays the mount", () => {
    trailIn(REPO);
    act(() => {
      st().syncNavLens(REPO, "upstream");
      st().selectIssue(issue(7));
    });
    expect(lens()).toBe("upstream");
    const clearRemoteSelections = vi.fn(st().clearRemoteSelections);
    useUiStore.setState({ clearRemoteSelections });
    setRemoteGone();
    renderHook(({ repo }) => useNavLensSync(repo), {
      initialProps: { repo: REPO },
      wrapper: StrictMode,
    });
    expect(clearRemoteSelections).toHaveBeenCalledTimes(1);
    expect(st().selectedIssue).toBeNull();
    expect(lens()).toBe("origin");
    expect(entries()).toHaveLength(1);
    expect(entries()[0].selection.selectedIssue ?? null).toBeNull();
  });

  it("touches nothing while another repository is open", () => {
    trailIn(OTHER);
    const hook = mountOnUpstream(OTHER);
    const before = hist();
    setRemoteGone();
    act(() => hook.rerender({ repo: REPO }));
    expect(st().selectedIssue).toEqual(issue(7));
    expect(hist()).toBe(before);
  });
});
