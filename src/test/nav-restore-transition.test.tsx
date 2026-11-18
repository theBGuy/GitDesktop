import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteLens } from "@/lib/git/types";
import {
  __resetNavHistoryForTests,
  registerNavLensReader,
} from "@/lib/stores/nav-history";
import { useUiStore } from "@/lib/stores/ui";

// The transition callback runs in a later task wherever View Transitions exist, and
// jsdom has none: this queue holds each callback until the test flushes it, so a
// change made between the press and its landing is visible to the landing.
const transitions = vi.hoisted(() => {
  const queue: (() => void)[] = [];
  return {
    queue,
    flush: () => {
      for (const update of queue.splice(0)) update();
    },
  };
});
vi.mock("@/lib/view-transition", () => ({
  startViewTransition: (update: () => void) => {
    transitions.queue.push(update);
  },
}));

const REPO = "C:/repos/alpha";

const st = () => useUiStore.getState();
const issue = (n: number) => ({ kind: "remote" as const, id: String(n) });

let lensOf: Record<string, RemoteLens | null> = {};

beforeEach(() => {
  useUiStore.setState(useUiStore.getInitialState(), true);
  __resetNavHistoryForTests();
  transitions.queue.length = 0;
  lensOf = { [REPO]: "origin" };
  registerNavLensReader((repoPath) => lensOf[repoPath] ?? null);
});
afterEach(() => {
  useUiStore.setState(useUiStore.getInitialState(), true);
  __resetNavHistoryForTests();
});

describe("a restore's landing re-checks its currency inside the transition", () => {
  it("a selection between a same-repository lens crossing and its landing lands nothing", () => {
    st().openRepo({ root: REPO, name: "alpha" });
    transitions.flush();
    st().openIssue({
      repoPath: REPO,
      repoName: "alpha",
      number: 2,
      carryHistory: true,
      beforeSelect: () => {
        lensOf[REPO] = "upstream";
      },
    });
    transitions.flush();
    expect(st().navHistory.segments.map((s) => s.lens)).toEqual([
      "origin",
      "upstream",
    ]);
    expect(st().selectedIssue).toEqual(issue(2));
    const applyLens = vi.fn();
    st().goBack({ applyLens });
    // No hold on this path: the landing is queued at once.
    expect(transitions.queue).toHaveLength(1);
    // An in-place selection bumps the epoch yet leaves the step still crossing into
    // the origin segment (a tab change would push and make it an in-segment step), so
    // only the epoch check inside the transition can refuse it.
    st().selectIssue(issue(9));
    const before = st();
    transitions.flush();
    expect(applyLens).not.toHaveBeenCalled();
    expect(st()).toBe(before);
    expect(st()).toMatchObject({ repoPath: REPO, selectedIssue: issue(9) });
    expect(st().navHistory.segment).toBe(1);
  });
});
