import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetNavHistoryForTests,
  armLinkHop,
  type BoardAnchor,
  canGoBack,
  canGoForward,
  EMPTY_NAV_HISTORY,
  NAV_HISTORY_CAP,
  NAV_SELECTION_FIELDS,
  type NavEntry,
  type NavHistory,
  type NavSelection,
  pruneHiddenTabs,
  readNavAnchor,
  recordNavigation,
  registerNavAnchorProvider,
  restoreStep,
  sameLocation,
  seedHistory,
  selectionOf,
  syncLens,
  takeLinkHop,
} from "@/lib/stores/nav-history";
import type { RepoTab, UiState } from "@/lib/stores/ui";

// The pure rules over plain state objects. `Session` plays the ui store: each write is
// one committed change the recorder observes (taking the hop mark on every change, as
// the store wiring does), and the recorder's own write re-enters it the way a nested
// zustand setState does.

type NavState = Parameters<typeof recordNavigation>[0];
type Sim = NavState & Partial<UiState>;

const REPO = "C:/repos/alpha";

function baseState(over: Partial<Sim> = {}): Sim {
  return {
    view: "repo",
    repoPath: REPO,
    repoTab: "changes",
    selectedFile: null,
    selectedCommitHash: null,
    compareBranch: null,
    compareCommitHash: null,
    selectedPr: null,
    selectedIssue: null,
    selectedDiscussion: null,
    selectedRunId: null,
    selectedFinding: null,
    selectedTag: null,
    selectedTodo: null,
    navHistory: EMPTY_NAV_HISTORY,
    navHiddenTabs: [],
    ...over,
  };
}

const issue = (n: number) => ({ kind: "remote" as const, id: String(n) });
const pr = (n: number) => ({ kind: "remote" as const, id: String(n) });
const anchor = (itemId: string | null, projectId = "P1"): BoardAnchor => ({
  projectId,
  viewId: "V1",
  itemId,
  showArchived: false,
});
const entry = (
  tab: RepoTab,
  selection: NavSelection = {},
  a: BoardAnchor | null = null,
): NavEntry => ({
  tab,
  selection: { ...selectionOf(tab, baseState()), ...selection },
  anchor: a,
});

function locationOf(s: Sim) {
  return { tab: s.repoTab, selection: selectionOf(s.repoTab, s) };
}

function expectInvariants(s: Sim) {
  const { entries, index } = s.navHistory;
  expect(entries.length).toBeLessThanOrEqual(NAV_HISTORY_CAP);
  if (entries.length === 0) {
    expect(index).toBe(-1);
  } else {
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(entries.length);
  }
  for (let i = 1; i < entries.length; i++) {
    expect(sameLocation(entries[i - 1], entries[i])).toBe(false);
  }
  entries.forEach((e, i) => {
    if (i !== index) expect(s.navHiddenTabs).not.toContain(e.tab);
  });
  // canGo* are true exactly when a press would change the location.
  for (const delta of [-1, 1] as const) {
    const can = delta < 0 ? canGoBack(s) : canGoForward(s);
    const step = restoreStep(s, delta, () => undefined);
    expect(step !== null).toBe(can);
    if (step) {
      expect(
        sameLocation(locationOf({ ...s, ...step.patch }), locationOf(s)),
      ).toBe(false);
    }
  }
}

class Session {
  s: Sim;
  checkInvariants = false;

  constructor(over: Partial<Sim> = {}) {
    const start = baseState(over);
    this.s = { ...start, navHistory: seedHistory(start) };
  }

  get history(): NavHistory {
    return this.s.navHistory;
  }

  /** One committed store change; `hop` arms the mark on the line before, as callers do. */
  write(patch: Partial<Sim>, hop = false) {
    if (hop) armLinkHop();
    const prev = this.s;
    this.s = { ...prev, ...patch };
    this.record(prev);
  }

  step(delta: -1 | 1) {
    const step = restoreStep(this.s, delta, readNavAnchor);
    if (!step) return null;
    const prev = this.s;
    this.s = { ...prev, ...step.patch, navHistory: step.navHistory };
    this.record(prev);
    return step;
  }

  hide(tabs: readonly RepoTab[]) {
    const prev = this.s;
    this.s = {
      ...prev,
      navHiddenTabs: tabs,
      navHistory: pruneHiddenTabs(prev.navHistory, tabs),
    };
    this.record(prev);
  }

  private record(prev: Sim) {
    const navHistory = recordNavigation(
      this.s,
      prev,
      takeLinkHop(),
      readNavAnchor,
    );
    if (navHistory !== this.s.navHistory) {
      const before = this.s;
      this.s = { ...before, navHistory };
      // The recorder's own write re-enters the recorder and must record nothing.
      expect(
        recordNavigation(this.s, before, takeLinkHop(), readNavAnchor),
      ).toBe(this.s.navHistory);
    }
    if (this.checkInvariants) expectInvariants(this.s);
  }
}

beforeEach(() => {
  __resetNavHistoryForTests();
});
afterEach(() => {
  __resetNavHistoryForTests();
});

describe("NAV_SELECTION_FIELDS", () => {
  it("lists exactly the eleven selection fields, each once", () => {
    const flat = Object.values(NAV_SELECTION_FIELDS).flat();
    expect(new Set(flat).size).toBe(flat.length);
    expect([...flat].sort()).toEqual(
      [
        "selectedFile",
        "selectedCommitHash",
        "compareBranch",
        "compareCommitHash",
        "selectedPr",
        "selectedIssue",
        "selectedDiscussion",
        "selectedRunId",
        "selectedFinding",
        "selectedTag",
        "selectedTodo",
      ].sort(),
    );
  });
});

describe("selectionOf / sameLocation", () => {
  it("takes exactly the tab's listed keys, null when unset", () => {
    const s = baseState({ compareBranch: "main", selectedIssue: issue(1) });
    expect(selectionOf("compare", s)).toEqual({
      compareBranch: "main",
      compareCommitHash: null,
    });
    expect(selectionOf("projects", s)).toEqual({});
  });

  it("compares flat object values structurally and ignores the anchor", () => {
    const alert = { type: "alert" as const, number: 1 };
    expect(
      sameLocation(
        entry("findings", { selectedFinding: alert }, anchor("a")),
        entry("findings", { selectedFinding: { ...alert } }, anchor("b")),
      ),
    ).toBe(true);
    expect(
      sameLocation(
        entry("findings", { selectedFinding: alert }),
        entry("findings", {
          selectedFinding: { type: "codeScanning", number: 1 },
        }),
      ),
    ).toBe(false);
    const todo = { path: "a.ts", line: 3, marker: "TODO", text: "x" };
    expect(
      sameLocation(
        entry("code-todos", { selectedTodo: todo }),
        entry("code-todos", { selectedTodo: { ...todo, line: 4 } }),
      ),
    ).toBe(false);
    const file = { path: "a.ts", staged: false, untracked: false };
    expect(
      sameLocation(
        entry("changes", { selectedFile: file }),
        entry("changes", { selectedFile: { ...file } }),
      ),
    ).toBe(true);
    expect(
      sameLocation(
        entry("changes", { selectedFile: file }),
        entry("changes", { selectedFile: { ...file, staged: true } }),
      ),
    ).toBe(false);
    expect(sameLocation(entry("issues"), entry("pulls"))).toBe(false);
  });
});

describe("recordNavigation", () => {
  it("seeds one entry at the landing on an empty history and on a repo switch", () => {
    const s = baseState({ repoTab: "issues", selectedIssue: issue(4) });
    const seeded = recordNavigation(
      s,
      { ...s, repoPath: null },
      false,
      readNavAnchor,
    );
    expect(seeded).toEqual({
      entries: [
        { tab: "issues", selection: { selectedIssue: issue(4) }, anchor: null },
      ],
      index: 0,
      lens: null,
    });

    const session = new Session();
    session.write({ repoTab: "issues" });
    session.write({ repoTab: "pulls" });
    session.write({ repoPath: "C:/repos/beta", repoTab: "history" });
    expect(session.history.entries).toHaveLength(1);
    expect(session.history.entries[0].tab).toBe("history");
    expect(session.history.index).toBe(0);
    expect(session.history.lens).toBeNull();
  });

  it("pushes exactly one entry per tab change and drops forward entries", () => {
    const session = new Session();
    session.write({ repoTab: "issues" });
    expect(session.history.entries.map((e) => e.tab)).toEqual([
      "changes",
      "issues",
    ]);
    expect(session.history.index).toBe(1);
    session.write({ repoTab: "pulls" });
    session.step(-1);
    session.step(-1);
    expect(session.history.index).toBe(0);
    session.write({ repoTab: "tags" });
    expect(session.history.entries.map((e) => e.tab)).toEqual([
      "changes",
      "tags",
    ]);
    expect(session.history.index).toBe(1);
  });

  it("records a tab written under an overlay as ONE push when the view returns", () => {
    const session = new Session({ repoTab: "issues" });
    const before = session.history;
    session.write({ view: "settings" });
    session.write({ repoTab: "pulls", selectedPr: pr(2) });
    expect(session.history).toBe(before);
    session.write({ view: "repo" });
    expect(session.history.entries.map((e) => e.tab)).toEqual([
      "issues",
      "pulls",
    ]);
    expect(session.history.entries[1].selection).toEqual({ selectedPr: pr(2) });
  });

  it("updates the current entry in place for an unmarked same-tab pick", () => {
    const session = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    session.write({ repoTab: "pulls" });
    session.write({ repoTab: "tags" });
    session.step(-1);
    const { length } = session.history.entries;
    session.write({ selectedPr: pr(9) });
    expect(session.history.entries).toHaveLength(length);
    expect(session.history.index).toBe(1);
    expect(session.history.entries[1].selection).toEqual({ selectedPr: pr(9) });
    expect(session.history.entries[2].tab).toBe("tags");
    // A deselect is an in-place rewrite too.
    session.write({ selectedPr: null });
    expect(session.history.entries).toHaveLength(length);
    expect(session.history.entries[1].selection).toEqual({ selectedPr: null });
  });

  it("pushes a marked same-tab change and drops forward entries", () => {
    const session = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    session.write({ selectedIssue: issue(2) }, true);
    expect(
      session.history.entries.map((e) => e.selection.selectedIssue),
    ).toEqual([issue(1), issue(2)]);
    session.write({ selectedIssue: issue(3) }, true);
    session.step(-1);
    session.step(-1);
    // Back twice, a list pick keeps the forward entries, a hop drops them.
    session.write({ selectedIssue: issue(7) });
    expect(session.history.entries).toHaveLength(3);
    session.write({ selectedIssue: issue(8) }, true);
    expect(
      session.history.entries.map((e) => e.selection.selectedIssue),
    ).toEqual([issue(7), issue(8)]);
    expect(session.history.index).toBe(1);

    // openCommit: a marked commit pick on the tab already showing.
    const history = new Session({
      repoTab: "history",
      selectedCommitHash: "aaa",
    });
    history.write({ selectedCommitHash: "bbb" }, true);
    expect(history.history.entries).toHaveLength(2);
  });

  it("pushes nothing for a marked change that leaves the location equal", () => {
    const session = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    const before = session.history;
    session.write({ selectedIssue: issue(1) }, true);
    expect(session.history).toBe(before);
  });

  it("never pushes on a stale mark", async () => {
    const session = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    armLinkHop();
    await Promise.resolve();
    session.write({ selectedIssue: issue(2) });
    expect(session.history.entries).toHaveLength(1);

    armLinkHop();
    session.write({}); // an unrelated store write takes the mark
    session.write({ selectedIssue: issue(3) });
    expect(session.history.entries).toHaveLength(1);
    expect(session.history.entries[0].selection).toEqual({
      selectedIssue: issue(3),
    });
  });

  it("ignores a write to another tab's selection field", () => {
    const session = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    const before = session.history;
    session.write({ selectedPr: pr(5) }, true);
    session.write({ selectedCommitHash: "abc" });
    expect(session.history).toBe(before);
  });

  it("records nothing for a change that carries a new history", () => {
    const prev = baseState({ repoTab: "issues", selectedIssue: issue(1) });
    const prevState = { ...prev, navHistory: seedHistory(prev) };
    const written: NavHistory = { ...prevState.navHistory };
    const next = {
      ...prevState,
      repoTab: "pulls" as const,
      selectedPr: pr(3),
      navHistory: written,
    };
    expect(recordNavigation(next, prevState, true, readNavAnchor)).toBe(
      written,
    );
  });

  it("leaves the history alone under an overlay and folds a write there in on return", () => {
    const session = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    const before = session.history;
    for (const view of ["settings", "help", "explore", "mywork"] as const) {
      session.write({ view });
      session.write({ view: "repo" });
    }
    expect(session.history).toBe(before);

    session.write({ view: "settings" });
    session.write({ selectedIssue: issue(2) });
    expect(session.history).toBe(before);
    session.write({ view: "repo" });
    expect(session.history.entries).toHaveLength(1);
    expect(session.history.entries[0].selection).toEqual({
      selectedIssue: issue(2),
    });
  });

  it("pushes a same-repo landing from My Work on top of the location it opened over", () => {
    const session = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    session.write({ view: "mywork" });
    session.write({ view: "repo", repoTab: "pulls", selectedPr: pr(4) });
    expect(session.history.entries.map((e) => e.tab)).toEqual([
      "issues",
      "pulls",
    ]);
    expect(session.history.index).toBe(1);
  });

  it("stores the current tab's anchor as the view leaves for an overlay, and nothing else", () => {
    const old = anchor("card-0");
    const s = baseState({ repoTab: "projects", selectedIssue: issue(3) });
    const prev = {
      ...s,
      navHistory: {
        entries: [
          entry("issues", { selectedIssue: issue(1) }),
          entry("projects", {}, old),
        ],
        index: 1,
        lens: "upstream" as const,
      },
    };
    const next = { ...prev, view: "mywork" as const };
    const a = anchor("card-1");
    const provider = vi.fn((_tab: RepoTab) => a);
    const out = recordNavigation(next, prev, false, provider);
    expect(provider).toHaveBeenCalledWith("projects");
    expect(out).not.toBe(prev.navHistory);
    expect(out.entries).toHaveLength(2);
    expect(out.index).toBe(1);
    expect(out.lens).toBe("upstream");
    expect(out.entries[0]).toBe(prev.navHistory.entries[0]);
    expect(out.entries[1]).toEqual({
      ...prev.navHistory.entries[1],
      anchor: a,
    });
  });

  it("returns the same history when the leaving read has nothing new", () => {
    const s = baseState({ repoTab: "projects" });
    const kept = anchor("card-0");
    for (const stored of [null, kept]) {
      const prev = {
        ...s,
        navHistory: {
          entries: [entry("projects", {}, stored)],
          index: 0,
          lens: null,
        },
      };
      const next = { ...prev, view: "settings" as const };
      expect(recordNavigation(next, prev, false, () => undefined)).toBe(
        prev.navHistory,
      );
      // Equal by value, a fresh object.
      const same = stored === null ? null : { ...stored };
      expect(recordNavigation(next, prev, false, () => same)).toBe(
        prev.navHistory,
      );
    }
  });

  it("reads no anchor on a leave that switches repo, carries a new history, has none, or starts under an overlay", () => {
    const s = baseState({ repoTab: "projects" });
    const prev = { ...s, navHistory: seedHistory(s) };
    const provider = vi.fn(() => anchor("card-1"));
    const cases = [
      [{ ...prev, view: "mywork" as const, repoPath: "C:/repos/beta" }, prev],
      [
        {
          ...prev,
          view: "mywork" as const,
          navHistory: { ...prev.navHistory },
        },
        prev,
      ],
      [
        { ...prev, view: "mywork" as const, navHistory: EMPTY_NAV_HISTORY },
        { ...prev, navHistory: EMPTY_NAV_HISTORY },
      ],
      [
        { ...prev, view: "help" as const },
        { ...prev, view: "mywork" as const },
      ],
    ] as const;
    for (const [next, before] of cases) {
      expect(recordNavigation(next, before, false, provider)).toBe(
        next.navHistory,
      );
    }
    expect(provider).not.toHaveBeenCalled();
  });

  it("never exceeds the cap and keeps index on the current location", () => {
    const session = new Session({ repoTab: "issues", selectedIssue: issue(0) });
    for (let n = 1; n <= NAV_HISTORY_CAP + 10; n++) {
      session.write({ selectedIssue: issue(n) }, true);
    }
    const { entries, index } = session.history;
    expect(entries).toHaveLength(NAV_HISTORY_CAP);
    expect(index).toBe(NAV_HISTORY_CAP - 1);
    expect(entries[index].selection).toEqual({
      selectedIssue: issue(NAV_HISTORY_CAP + 10),
    });
    expect(entries[0].selection).toEqual({ selectedIssue: issue(11) });
  });

  it("stores the provider's answer on the departing entry, else keeps its anchor", () => {
    const a = anchor("card-1");
    const provider = vi.fn(() => a);
    registerNavAnchorProvider("projects", provider);
    const session = new Session({ repoTab: "projects" });
    session.write({ repoTab: "issues" });
    expect(session.history.entries[0].anchor).toBe(a);
    expect(provider).toHaveBeenCalledWith();

    const kept = anchor("card-0");
    const s = baseState({ repoTab: "projects" });
    const prev = {
      ...s,
      navHistory: { ...seedHistory(s), entries: [entry("projects", {}, kept)] },
    };
    const next = { ...prev, repoTab: "issues" as const };
    expect(
      recordNavigation(next, prev, false, () => undefined).entries[0].anchor,
    ).toBe(kept);
    expect(
      recordNavigation(next, prev, false, () => null).entries[0].anchor,
    ).toBeNull();
  });
});

describe("restoreStep", () => {
  it("moves one step, pushes nothing, drops no forward entry, and never writes the view", () => {
    const session = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    session.write({ repoTab: "pulls", selectedPr: pr(2) });
    session.write({ repoTab: "tags", selectedTag: { tag: "v1" } });
    const there = locationOf(session.s);
    const back = session.step(-1);
    expect(back).not.toBeNull();
    expect(session.history.entries).toHaveLength(3);
    expect(session.history.index).toBe(1);
    expect(session.s.repoTab).toBe("pulls");
    expect(session.s.selectedPr).toEqual(pr(2));
    for (const key of ["view", "repoPath", "repoName", "previousView"]) {
      expect(back?.patch).not.toHaveProperty(key);
    }
    session.step(-1);
    expect(session.history.index).toBe(0);
    session.step(1);
    session.step(1);
    expect(session.history.entries).toHaveLength(3);
    expect(sameLocation(locationOf(session.s), there)).toBe(true);
  });

  it("rewrites the departing entry from live state", () => {
    const s = baseState({ repoTab: "issues", selectedIssue: issue(9) });
    const navHistory: NavHistory = {
      entries: [
        entry("pulls", { selectedPr: pr(1) }),
        entry("issues", { selectedIssue: issue(1) }),
      ],
      index: 1,
      lens: null,
    };
    const step = restoreStep({ ...s, navHistory }, -1, () => undefined);
    expect(step?.navHistory.entries[1].selection).toEqual({
      selectedIssue: issue(9),
    });
    expect(step?.navHistory.index).toBe(0);
  });

  it("returns null and reads no anchor when the direction is empty", () => {
    const provider = vi.fn(() => anchor("x"));
    registerNavAnchorProvider("projects", provider);
    const s = baseState({ repoTab: "projects" });
    const one = { ...s, navHistory: seedHistory(s) };
    expect(restoreStep(one, -1, readNavAnchor)).toBeNull();
    expect(restoreStep(one, 1, readNavAnchor)).toBeNull();
    expect(
      restoreStep({ ...s, navHistory: EMPTY_NAV_HISTORY }, -1, readNavAnchor),
    ).toBeNull();
    expect(provider).not.toHaveBeenCalled();
    expect(canGoBack(one)).toBe(false);
    expect(canGoForward(one)).toBe(false);
  });

  it("arms the Pulls align on a PR restore and leaves other tabs' one-shots alone", () => {
    const session = new Session({ repoTab: "pulls", selectedPr: pr(5) });
    session.write({ repoTab: "issues" });
    session.write({
      pendingPrAlign: false,
      pendingPrSection: "files",
      pendingReviewId: "r1",
    });
    const back = session.step(-1);
    expect(back?.patch).toMatchObject({
      repoTab: "pulls",
      selectedPr: pr(5),
      pendingPrAlign: true,
      pendingPrSection: null,
      pendingReviewId: null,
    });
    expect(session.s.pendingPrSection).toBeNull();

    const forward = session.step(1);
    for (const key of [
      "pendingPrAlign",
      "pendingPrSection",
      "pendingReviewId",
    ]) {
      expect(forward?.patch).not.toHaveProperty(key);
    }

    const empty = new Session({ repoTab: "pulls" });
    empty.write({ repoTab: "issues" });
    expect(empty.step(-1)?.patch).toMatchObject({ pendingPrAlign: false });
  });

  it("stores the anchor on departure and returns a projects target's anchor", () => {
    const a = anchor("card-7");
    registerNavAnchorProvider("projects", () => a);
    const session = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    session.write({ repoTab: "projects" });
    session.write({ repoTab: "pulls" });
    session.step(-1);
    // From projects: restoreStep itself asks the provider for the departing entry.
    const b = anchor("card-8");
    registerNavAnchorProvider("projects", () => b);
    const back = session.step(-1);
    expect(session.history.entries[1].anchor).toBe(b);
    expect(back?.anchor).toBeNull();
    expect(session.step(1)?.anchor).toBe(b);

    __resetNavHistoryForTests();
    const unanchored = new Session({ repoTab: "projects" });
    unanchored.write({ repoTab: "issues" });
    expect(unanchored.step(-1)?.anchor).toBeNull();
  });

  it("writes the snapshot as stored, unvalidated", () => {
    const stored = issue(404);
    const s = baseState({ repoTab: "pulls" });
    const navHistory: NavHistory = {
      entries: [entry("issues", { selectedIssue: stored }), entry("pulls")],
      index: 1,
      lens: null,
    };
    expect(
      restoreStep({ ...s, navHistory }, -1, () => undefined)?.patch
        .selectedIssue,
    ).toBe(stored);
  });
});

describe("syncLens", () => {
  function several(lens: NavHistory["lens"]) {
    const session = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    session.write({ repoTab: "pulls", selectedPr: pr(2) });
    session.write({ repoTab: "tags" });
    session.step(-1);
    return { ...session.s, navHistory: { ...session.history, lens } };
  }

  it("stamps a null stamp against the provisional lens and keeps every entry", () => {
    const s = several(null);
    const synced = syncLens(s, "origin");
    expect(synced.lens).toBe("origin");
    expect(synced.entries).toBe(s.navHistory.entries);
    expect(synced.index).toBe(s.navHistory.index);
  });

  it("re-seeds a null stamp against another answered lens", () => {
    const s = several(null);
    expect(syncLens(s, "upstream")).toEqual({
      entries: [
        { tab: "pulls", selection: { selectedPr: pr(2) }, anchor: null },
      ],
      index: 0,
      lens: "upstream",
    });
  });

  it("re-seeds on a flip and returns the same history on an equal stamp", () => {
    const s = several("origin");
    expect(syncLens(s, "upstream")).toEqual({
      entries: [
        { tab: "pulls", selection: { selectedPr: pr(2) }, anchor: null },
      ],
      index: 0,
      lens: "upstream",
    });
    const up = several("upstream");
    expect(syncLens(up, "upstream")).toBe(up.navHistory);
    expect(syncLens(s, "origin")).toBe(s.navHistory);
  });
});

describe("hidden tabs", () => {
  it("keeps a hidden current entry, then drops it at the next tab change", () => {
    const session = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    session.checkInvariants = true;
    session.write({ repoTab: "agent" });
    const before = session.history;
    session.hide(["agent"]);
    expect(session.history).toBe(before);
    session.write({ repoTab: "changes" });
    expect(session.history.entries.map((e) => e.tab)).toEqual([
      "issues",
      "changes",
    ]);
    session.step(-1);
    expect(session.s.repoTab).toBe("issues");
    session.step(1);
    expect(session.s.repoTab).toBe("changes");
    expect(canGoForward(session.s)).toBe(false);
  });

  it("drops a hidden current entry on a restore", () => {
    const session = new Session({ repoTab: "issues" });
    session.write({ repoTab: "agent" });
    session.hide(["agent"]);
    session.step(-1);
    expect(session.history.entries.map((e) => e.tab)).toEqual(["issues"]);
    expect(canGoForward(session.s)).toBe(false);
  });

  it("drops non-current hidden entries and merges the neighbours they part", () => {
    const a1 = anchor("one");
    const a2 = anchor("two");
    const trail = (index: number): NavHistory => ({
      entries: [
        entry("projects", {}, a1),
        entry("agent"),
        entry("projects", {}, a2),
      ],
      index,
      lens: "origin",
    });
    expect(pruneHiddenTabs(trail(2), ["agent"])).toEqual({
      entries: [entry("projects", {}, a2)],
      index: 0,
      lens: "origin",
    });
    const fromFirst = pruneHiddenTabs(trail(0), ["agent"]);
    expect(fromFirst.entries).toHaveLength(1);
    expect(fromFirst.entries[0].anchor).toBe(a1);
    const onAgent = pruneHiddenTabs(trail(1), ["agent"]);
    expect(onAgent.entries.map((e) => e.tab)).toEqual([
      "projects",
      "agent",
      "projects",
    ]);
  });

  it("records an agent landing made while hidden and drops it on leaving", () => {
    const session = new Session({
      repoTab: "issues",
      navHiddenTabs: ["agent"],
    });
    session.checkInvariants = true;
    session.write({ repoTab: "agent" });
    expect(session.history.entries.map((e) => e.tab)).toEqual([
      "issues",
      "agent",
    ]);
    session.write({ repoTab: "tags" });
    expect(session.history.entries.map((e) => e.tab)).toEqual([
      "issues",
      "tags",
    ]);
  });

  it("prunes nothing on un-hiding", () => {
    const history: NavHistory = {
      entries: [entry("issues"), entry("agent")],
      index: 1,
      lens: null,
    };
    expect(pruneHiddenTabs(history, [])).toBe(history);
  });
});

describe("invariants", () => {
  it("merges a list pick back onto the entry the hop left", () => {
    const session = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    session.checkInvariants = true;
    session.write({ selectedIssue: issue(2) }, true);
    session.write({ selectedIssue: issue(1) });
    expect(session.history.entries).toHaveLength(1);
    expect(canGoBack(session.s)).toBe(false);
  });

  it("merges a list pick equal to the forward entry", () => {
    const session = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    session.checkInvariants = true;
    session.write({ selectedIssue: issue(2) }, true);
    session.step(-1);
    session.write({ selectedIssue: issue(2) });
    expect(session.history.entries).toHaveLength(1);
    expect(canGoForward(session.s)).toBe(false);
  });

  it("leaves one entry for a rewrite equal to both neighbours", () => {
    const s = baseState({ repoTab: "issues", selectedIssue: issue(1) });
    const prev = {
      ...s,
      selectedIssue: issue(2),
      navHistory: {
        entries: [
          entry("issues", { selectedIssue: issue(1) }),
          entry("issues", { selectedIssue: issue(2) }),
          entry("issues", { selectedIssue: issue(1) }),
        ],
        index: 1,
        lens: null,
      },
    };
    const next = { ...prev, selectedIssue: issue(1) };
    const out = recordNavigation(next, prev, false, readNavAnchor);
    expect(out.entries).toHaveLength(1);
    expect(out.index).toBe(0);
  });

  it("hold after every change of a mixed session", () => {
    const a = anchor("card");
    registerNavAnchorProvider("projects", () => a);
    const session = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    session.checkInvariants = true;
    session.write({ selectedIssue: issue(2) }, true);
    session.write({ selectedIssue: issue(3) }, true);
    session.write({ repoTab: "projects" });
    session.write({ repoTab: "agent" });
    session.write({ repoTab: "pulls", selectedPr: pr(1) });
    session.write({ selectedPr: pr(2) }, true);
    session.step(-1);
    session.step(-1);
    session.write({ selectedPr: null });
    session.step(-1);
    session.hide(["agent"]);
    session.step(1);
    session.step(1);
    session.write({ repoTab: "issues", selectedIssue: issue(3) });
    session.write({ selectedIssue: null });
    session.hide([]);
    session.write({ repoTab: "agent" });
    for (let n = 10; n < 10 + NAV_HISTORY_CAP + 5; n++) {
      session.write({
        repoTab: n % 2 ? "issues" : "tags",
        selectedIssue: issue(n),
      });
    }
    session.step(-1);
    session.write({ selectedIssue: issue(1) }, true);
    expect(session.history.entries.length).toBeLessThanOrEqual(NAV_HISTORY_CAP);
  });
});

describe("anchor providers", () => {
  it("answers undefined with none registered, and an unregister removes only its own", () => {
    expect(readNavAnchor("projects")).toBeUndefined();
    const first = registerNavAnchorProvider("projects", () => anchor("first"));
    const second = registerNavAnchorProvider("projects", () =>
      anchor("second"),
    );
    first();
    expect(readNavAnchor("projects")?.itemId).toBe("second");
    second();
    expect(readNavAnchor("projects")).toBeUndefined();
    registerNavAnchorProvider("projects", () => null);
    expect(readNavAnchor("projects")).toBeNull();
    __resetNavHistoryForTests();
    expect(readNavAnchor("projects")).toBeUndefined();
  });

  it("keeps the entry's anchor when a registered provider answers undefined", () => {
    const a = anchor("card-1");
    let answer: BoardAnchor | null | undefined = a;
    registerNavAnchorProvider("projects", () => answer);
    const session = new Session({ repoTab: "projects" });
    session.write({ repoTab: "issues" });
    session.step(-1);
    answer = undefined;
    expect(readNavAnchor("projects")).toBeUndefined();
    session.write({ repoTab: "tags" });
    expect(session.history.entries[0].tab).toBe("projects");
    expect(session.history.entries[0].anchor).toBe(a);
  });
});

describe("link-hop mark", () => {
  it("is taken once and retired by the microtask that armed it", async () => {
    expect(takeLinkHop()).toBe(false);
    armLinkHop();
    expect(takeLinkHop()).toBe(true);
    expect(takeLinkHop()).toBe(false);

    armLinkHop();
    await Promise.resolve();
    expect(takeLinkHop()).toBe(false);

    // An earlier arm's clear retires only its own mark: a later arm survives it.
    armLinkHop();
    takeLinkHop();
    let seen: boolean | undefined;
    queueMicrotask(() => {
      seen = takeLinkHop();
    });
    armLinkHop();
    await Promise.resolve();
    expect(seen).toBe(true);
  });
});
