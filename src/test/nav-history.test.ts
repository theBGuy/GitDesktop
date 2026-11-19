import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteLens } from "@/lib/git/types";
import {
  __resetNavHistoryForTests,
  armCarry,
  armLinkHop,
  type BoardAnchor,
  canGoBack,
  canGoForward,
  currentEntry,
  currentSegment,
  dropRepository,
  EMPTY_NAV_HISTORY,
  NAV_HISTORY_CAP,
  NAV_SELECTION_FIELDS,
  type NavCarry,
  type NavEntry,
  type NavHistory,
  type NavSegment,
  type NavSelection,
  pruneHiddenTabs,
  readNavAnchor,
  readNavLens,
  recordNavigation,
  registerNavAnchorProvider,
  registerNavLensReader,
  restoreStep,
  restoreTarget,
  sameLocation,
  seedHistory,
  selectionOf,
  syncLens,
  takeCarry,
  takeLinkHop,
} from "@/lib/stores/nav-history";
import type { RepoTab, UiState } from "@/lib/stores/ui";

// The pure rules over plain state objects. `Session` plays the ui store: each write is
// one committed change the recorder observes (taking the hop and carry marks on every
// change, as the store wiring does), and the recorder's own write re-enters it the way
// a nested zustand setState does.

type NavState = Parameters<typeof recordNavigation>[0];
type Sim = NavState & Partial<UiState>;

const REPO = "C:/repos/alpha";
const BETA = "C:/repos/beta";
const GAMMA = "C:/repos/gamma";

function baseState(over: Partial<Sim> = {}): Sim {
  return {
    view: "repo",
    repoPath: REPO,
    repoName: "alpha",
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

const segOf = (
  repoPath: string,
  lens: RemoteLens | null,
  entries: readonly NavEntry[],
  repoName: string | null = repoPath.split("/").pop() ?? null,
): NavSegment => ({ repoPath, repoName, lens, entries });
const historyOf = (
  segments: readonly NavSegment[],
  segment: number,
  index: number,
): NavHistory => ({ segments, segment, index });
/** The current segment's entries, as the one-repository cases read them. */
const entriesOf = (h: NavHistory): readonly NavEntry[] =>
  currentSegment(h)?.entries ?? [];
const carryOf = (over: Partial<NavCarry> = {}): NavCarry => ({
  lensFrom: null,
  lens: null,
  live: baseState(),
  ...over,
});

function expectInvariants(s: Sim) {
  const { segments, segment, index } = s.navHistory;
  // I3: the cap counts every segment's entries.
  expect(
    segments.reduce((n, seg) => n + seg.entries.length, 0),
  ).toBeLessThanOrEqual(NAV_HISTORY_CAP);
  if (segments.length === 0) {
    expect(segment).toBe(-1);
    expect(index).toBe(-1);
  } else {
    // I6
    expect(segment).toBeGreaterThanOrEqual(0);
    expect(segment).toBeLessThan(segments.length);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(segments[segment].entries.length);
  }
  segments.forEach((seg, n) => {
    // I4
    expect(seg.entries.length).toBeGreaterThan(0);
    // I5
    if (n > 0) {
      const prev = segments[n - 1];
      expect(prev.repoPath === seg.repoPath && prev.lens === seg.lens).toBe(
        false,
      );
    }
    // I1
    for (let i = 1; i < seg.entries.length; i++) {
      expect(sameLocation(seg.entries[i - 1], seg.entries[i])).toBe(false);
    }
    // I2
    seg.entries.forEach((e, i) => {
      if (n !== segment || i !== index)
        expect(s.navHiddenTabs).not.toContain(e.tab);
    });
  });
  // canGo* are true exactly when a press would change the location, a repository or
  // lens change counting as one.
  for (const delta of [-1, 1] as const) {
    const can = delta < 0 ? canGoBack(s) : canGoForward(s);
    const step = restoreStep(s, delta, () => undefined);
    expect(step !== null).toBe(can);
    if (step && step.crossing === null) {
      expect(
        sameLocation(locationOf({ ...s, ...step.patch }), locationOf(s)),
      ).toBe(false);
    }
    if (step?.crossing) {
      const here = currentSegment(s.navHistory);
      expect(
        step.crossing.repoPath === here?.repoPath &&
          step.crossing.lens === here?.lens,
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

  /** The current segment's entries. */
  get entries(): readonly NavEntry[] {
    return entriesOf(this.s.navHistory);
  }

  /** The current segment's stamp. */
  get lens(): RemoteLens | null {
    return currentSegment(this.s.navHistory)?.lens ?? null;
  }

  /** One committed store change; `hop` arms the mark on the line before, as callers do. */
  write(patch: Partial<Sim>, hop = false) {
    if (hop) armLinkHop();
    const prev = this.s;
    this.s = { ...prev, ...patch };
    this.record(prev);
  }

  /** The lens sync's write. */
  sync(lens: RemoteLens) {
    const prev = this.s;
    this.s = { ...prev, navHistory: syncLens(prev, lens).navHistory };
    this.record(prev);
  }

  /** A landing that keeps the history: the carry mark armed just before its write. */
  carry(patch: Partial<Sim>, carry: Partial<NavCarry> = {}, hop = false) {
    if (hop) armLinkHop();
    armCarry(carryOf({ live: this.s, ...carry }));
    this.write(patch);
  }

  /** One restore step; a crossing applies its repository the way the landing does. */
  step(delta: -1 | 1) {
    const step = restoreStep(this.s, delta, readNavAnchor);
    if (!step) return null;
    const prev = this.s;
    this.s = {
      ...prev,
      ...(step.crossing
        ? {
            repoPath: step.crossing.repoPath,
            repoName: step.crossing.repoName,
          }
        : {}),
      ...step.patch,
      navHistory: step.navHistory,
    };
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
      takeCarry(),
    );
    if (navHistory !== this.s.navHistory) {
      const before = this.s;
      this.s = { ...before, navHistory };
      // The recorder's own write re-enters the recorder and must record nothing.
      expect(
        recordNavigation(
          this.s,
          before,
          takeLinkHop(),
          readNavAnchor,
          takeCarry(),
        ),
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
      null,
    );
    expect(seeded).toEqual(
      historyOf(
        [
          segOf(REPO, null, [
            {
              tab: "issues",
              selection: { selectedIssue: issue(4) },
              anchor: null,
            },
          ]),
        ],
        0,
        0,
      ),
    );

    const session = new Session();
    session.write({ repoTab: "issues" });
    session.write({ repoTab: "pulls" });
    session.write({ repoPath: BETA, repoName: "beta", repoTab: "history" });
    expect(session.history.segments).toHaveLength(1);
    expect(currentSegment(session.history)).toMatchObject({
      repoPath: BETA,
      repoName: "beta",
    });
    expect(session.entries).toHaveLength(1);
    expect(session.entries[0].tab).toBe("history");
    expect(session.history.index).toBe(0);
    expect(session.lens).toBeNull();
  });

  it("pushes exactly one entry per tab change and drops forward entries", () => {
    const session = new Session();
    session.write({ repoTab: "issues" });
    expect(session.entries.map((e) => e.tab)).toEqual(["changes", "issues"]);
    expect(session.history.index).toBe(1);
    session.write({ repoTab: "pulls" });
    session.step(-1);
    session.step(-1);
    expect(session.history.index).toBe(0);
    session.write({ repoTab: "tags" });
    expect(session.entries.map((e) => e.tab)).toEqual(["changes", "tags"]);
    expect(session.history.index).toBe(1);
  });

  it("records a tab written under an overlay as ONE push when the view returns", () => {
    const session = new Session({ repoTab: "issues" });
    const before = session.history;
    session.write({ view: "settings" });
    session.write({ repoTab: "pulls", selectedPr: pr(2) });
    expect(session.history).toBe(before);
    session.write({ view: "repo" });
    expect(session.entries.map((e) => e.tab)).toEqual(["issues", "pulls"]);
    expect(session.entries[1].selection).toEqual({ selectedPr: pr(2) });
  });

  it("updates the current entry in place for an unmarked same-tab pick", () => {
    const session = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    session.write({ repoTab: "pulls" });
    session.write({ repoTab: "tags" });
    session.step(-1);
    const { length } = session.entries;
    session.write({ selectedPr: pr(9) });
    expect(session.entries).toHaveLength(length);
    expect(session.history.index).toBe(1);
    expect(session.entries[1].selection).toEqual({ selectedPr: pr(9) });
    expect(session.entries[2].tab).toBe("tags");
    // A deselect is an in-place rewrite too.
    session.write({ selectedPr: null });
    expect(session.entries).toHaveLength(length);
    expect(session.entries[1].selection).toEqual({ selectedPr: null });
  });

  it("pushes a marked same-tab change and drops forward entries", () => {
    const session = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    session.write({ selectedIssue: issue(2) }, true);
    expect(session.entries.map((e) => e.selection.selectedIssue)).toEqual([
      issue(1),
      issue(2),
    ]);
    session.write({ selectedIssue: issue(3) }, true);
    session.step(-1);
    session.step(-1);
    // Back twice, a list pick keeps the forward entries, a hop drops them.
    session.write({ selectedIssue: issue(7) });
    expect(session.entries).toHaveLength(3);
    session.write({ selectedIssue: issue(8) }, true);
    expect(session.entries.map((e) => e.selection.selectedIssue)).toEqual([
      issue(7),
      issue(8),
    ]);
    expect(session.history.index).toBe(1);

    // openCommit: a marked commit pick on the tab already showing.
    const history = new Session({
      repoTab: "history",
      selectedCommitHash: "aaa",
    });
    history.write({ selectedCommitHash: "bbb" }, true);
    expect(history.entries).toHaveLength(2);
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
    expect(session.entries).toHaveLength(1);

    armLinkHop();
    session.write({}); // an unrelated store write takes the mark
    session.write({ selectedIssue: issue(3) });
    expect(session.entries).toHaveLength(1);
    expect(session.entries[0].selection).toEqual({
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
    expect(recordNavigation(next, prevState, true, readNavAnchor, null)).toBe(
      written,
    );
  });

  it("keeps an authored history naming the new repository, and seeds over one naming another", () => {
    const prev = baseState({ repoTab: "issues", selectedIssue: issue(1) });
    const prevState = { ...prev, navHistory: seedHistory(prev) };
    const written = historyOf(
      [
        ...prevState.navHistory.segments,
        segOf(BETA, "origin", [entry("pulls", { selectedPr: pr(3) })]),
      ],
      1,
      0,
    );
    const next = {
      ...prevState,
      repoPath: BETA,
      repoName: "beta",
      repoTab: "pulls" as const,
      selectedPr: pr(3),
      navHistory: written,
    };
    // N3 runs ahead of N2b: a restore that changes the repository keeps its history.
    expect(recordNavigation(next, prevState, false, readNavAnchor, null)).toBe(
      written,
    );
    const elsewhere = { ...next, repoPath: GAMMA, repoName: "gamma" };
    const seeded = recordNavigation(
      elsewhere,
      prevState,
      false,
      readNavAnchor,
      null,
    );
    expect(seeded.segments).toHaveLength(1);
    expect(currentSegment(seeded)?.repoPath).toBe(GAMMA);
    expect(currentEntry(seeded)?.tab).toBe("pulls");
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
    expect(session.entries).toHaveLength(1);
    expect(session.entries[0].selection).toEqual({
      selectedIssue: issue(2),
    });
  });

  it("pushes a same-repo landing from My Work on top of the location it opened over", () => {
    const session = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    session.write({ view: "mywork" });
    session.write({ view: "repo", repoTab: "pulls", selectedPr: pr(4) });
    expect(session.entries.map((e) => e.tab)).toEqual(["issues", "pulls"]);
    expect(session.history.index).toBe(1);
  });

  it("stores the current tab's anchor as the view leaves for an overlay, and nothing else", () => {
    const old = anchor("card-0");
    const s = baseState({ repoTab: "projects", selectedIssue: issue(3) });
    const before = segOf(BETA, null, [entry("tags")]);
    const prev = {
      ...s,
      navHistory: historyOf(
        [
          before,
          segOf(REPO, "upstream", [
            entry("issues", { selectedIssue: issue(1) }),
            entry("projects", {}, old),
          ]),
        ],
        1,
        1,
      ),
    };
    const next = { ...prev, view: "mywork" as const };
    const a = anchor("card-1");
    const provider = vi.fn((_tab: RepoTab) => a);
    const out = recordNavigation(next, prev, false, provider, null);
    expect(provider).toHaveBeenCalledWith("projects");
    expect(out).not.toBe(prev.navHistory);
    expect(out.segments).toHaveLength(2);
    expect(out.segments[0]).toBe(before);
    expect(entriesOf(out)).toHaveLength(2);
    expect(out.segment).toBe(1);
    expect(out.index).toBe(1);
    expect(currentSegment(out)?.lens).toBe("upstream");
    const prevEntries = entriesOf(prev.navHistory);
    expect(entriesOf(out)[0]).toBe(prevEntries[0]);
    expect(entriesOf(out)[1]).toEqual({ ...prevEntries[1], anchor: a });
  });

  it("returns the same history when the leaving read has nothing new", () => {
    const s = baseState({ repoTab: "projects" });
    const kept = anchor("card-0");
    for (const stored of [null, kept]) {
      const prev = {
        ...s,
        navHistory: historyOf(
          [segOf(REPO, null, [entry("projects", {}, stored)])],
          0,
          0,
        ),
      };
      const next = { ...prev, view: "settings" as const };
      expect(recordNavigation(next, prev, false, () => undefined, null)).toBe(
        prev.navHistory,
      );
      // Equal by value, a fresh object.
      const same = stored === null ? null : { ...stored };
      expect(recordNavigation(next, prev, false, () => same, null)).toBe(
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
      expect(recordNavigation(next, before, false, provider, null)).toBe(
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
    const { entries } = session;
    const { index } = session.history;
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
    expect(session.entries[0].anchor).toBe(a);
    expect(provider).toHaveBeenCalledWith();

    const kept = anchor("card-0");
    const s = baseState({ repoTab: "projects" });
    const prev = {
      ...s,
      navHistory: historyOf(
        [segOf(REPO, null, [entry("projects", {}, kept)])],
        0,
        0,
      ),
    };
    const next = { ...prev, repoTab: "issues" as const };
    expect(
      entriesOf(recordNavigation(next, prev, false, () => undefined, null))[0]
        .anchor,
    ).toBe(kept);
    expect(
      entriesOf(recordNavigation(next, prev, false, () => null, null))[0]
        .anchor,
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
    expect(session.entries).toHaveLength(3);
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
    expect(session.entries).toHaveLength(3);
    expect(sameLocation(locationOf(session.s), there)).toBe(true);
  });

  it("rewrites the departing entry from live state", () => {
    const s = baseState({ repoTab: "issues", selectedIssue: issue(9) });
    const navHistory = historyOf(
      [
        segOf(REPO, null, [
          entry("pulls", { selectedPr: pr(1) }),
          entry("issues", { selectedIssue: issue(1) }),
        ]),
      ],
      0,
      1,
    );
    const step = restoreStep({ ...s, navHistory }, -1, () => undefined);
    expect(
      entriesOf(step?.navHistory ?? EMPTY_NAV_HISTORY)[1].selection,
    ).toEqual({
      selectedIssue: issue(9),
    });
    expect(step?.navHistory.index).toBe(0);
    expect(step?.crossing).toBeNull();
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
    expect(session.entries[1].anchor).toBe(b);
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
    const navHistory = historyOf(
      [
        segOf(REPO, null, [
          entry("issues", { selectedIssue: stored }),
          entry("pulls"),
        ]),
      ],
      0,
      1,
    );
    expect(
      restoreStep({ ...s, navHistory }, -1, () => undefined)?.patch
        .selectedIssue,
    ).toBe(stored);
  });
});

describe("syncLens", () => {
  function several(lens: RemoteLens | null) {
    const session = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    session.write({ repoTab: "pulls", selectedPr: pr(2) });
    session.write({ repoTab: "tags" });
    session.step(-1);
    const seg = currentSegment(session.history) as NavSegment;
    return {
      ...session.s,
      navHistory: historyOf([{ ...seg, lens }], 0, session.history.index),
    };
  }
  const pulled = segOf(REPO, "upstream", [
    { tab: "pulls", selection: { selectedPr: pr(2) }, anchor: null },
  ]);

  it("stamps a null stamp against the provisional lens and keeps every entry", () => {
    const s = several(null);
    const synced = syncLens(s, "origin");
    expect(synced.reseeded).toBe(false);
    expect(currentSegment(synced.navHistory)?.lens).toBe("origin");
    expect(entriesOf(synced.navHistory)).toBe(entriesOf(s.navHistory));
    expect(synced.navHistory.index).toBe(s.navHistory.index);
  });

  it("re-seeds a null stamp against another answered lens", () => {
    const s = several(null);
    expect(syncLens(s, "upstream")).toEqual({
      navHistory: historyOf([pulled], 0, 0),
      reseeded: true,
    });
  });

  it("re-seeds on a flip and returns the same history on an equal stamp", () => {
    const s = several("origin");
    expect(syncLens(s, "upstream")).toEqual({
      navHistory: historyOf([pulled], 0, 0),
      reseeded: true,
    });
    const up = several("upstream");
    expect(syncLens(up, "upstream")).toEqual({
      navHistory: up.navHistory,
      reseeded: false,
    });
    expect(syncLens(up, "upstream").navHistory).toBe(up.navHistory);
    expect(syncLens(s, "origin").navHistory).toBe(s.navHistory);
  });

  it("acts on the current segment alone and keeps the others as they are", () => {
    const before = segOf(BETA, "origin", [entry("tags")]);
    const after = segOf(GAMMA, null, [entry("history")]);
    const s = several(null);
    const seg = currentSegment(s.navHistory) as NavSegment;
    const middle = { ...s, navHistory: historyOf([before, seg, after], 1, 1) };
    const stamped = syncLens(middle, "origin");
    expect(stamped.reseeded).toBe(false);
    expect(stamped.navHistory.segments[0]).toBe(before);
    expect(stamped.navHistory.segments[2]).toBe(after);
    expect(stamped.navHistory.segments[1].entries).toBe(seg.entries);
    expect(stamped.navHistory.segments[1].lens).toBe("origin");

    const reseeded = syncLens(middle, "upstream");
    expect(reseeded.reseeded).toBe(true);
    expect(reseeded.navHistory).toEqual(
      historyOf([before, pulled, after], 1, 0),
    );
    expect(reseeded.navHistory.segments[0]).toBe(before);
    expect(reseeded.navHistory.segments[2]).toBe(after);
  });

  it("merges a stamped segment with an equal neighbour", () => {
    const s = several(null);
    const seg = currentSegment(s.navHistory) as NavSegment;
    const earlier = segOf(REPO, "origin", [entry("history"), entry("tags")]);
    const merged = syncLens(
      { ...s, navHistory: historyOf([earlier, seg], 1, s.navHistory.index) },
      "origin",
    );
    expect(merged.reseeded).toBe(false);
    expect(merged.navHistory.segments).toHaveLength(1);
    expect(merged.navHistory.segment).toBe(0);
    // The join keeps I1: earlier's "tags" and seg's first entry are not equal.
    expect(entriesOf(merged.navHistory).map((e) => e.tab)).toEqual([
      "history",
      "tags",
      "issues",
      "pulls",
      "tags",
    ]);
    expect(currentEntry(merged.navHistory)?.tab).toBe("pulls");
    expect(merged.navHistory.index).toBe(3);
  });

  it("re-seeds into an equal neighbour, and returns an empty history as is", () => {
    const s = several("origin");
    const seg = currentSegment(s.navHistory) as NavSegment;
    const later = segOf(REPO, "upstream", [entry("history")]);
    const out = syncLens(
      { ...s, navHistory: historyOf([seg, later], 0, s.navHistory.index) },
      "upstream",
    );
    expect(out.reseeded).toBe(true);
    expect(out.navHistory).toEqual(
      historyOf(
        [segOf(REPO, "upstream", [...pulled.entries, entry("history")])],
        0,
        0,
      ),
    );
    const empty = { ...s, navHistory: EMPTY_NAV_HISTORY };
    expect(syncLens(empty, "upstream").navHistory).toBe(EMPTY_NAV_HISTORY);
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
    expect(session.entries.map((e) => e.tab)).toEqual(["issues", "changes"]);
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
    expect(session.entries.map((e) => e.tab)).toEqual(["issues"]);
    expect(canGoForward(session.s)).toBe(false);
  });

  it("drops non-current hidden entries and merges the neighbours they part", () => {
    const a1 = anchor("one");
    const a2 = anchor("two");
    const trail = (index: number): NavHistory =>
      historyOf(
        [
          segOf(REPO, "origin", [
            entry("projects", {}, a1),
            entry("agent"),
            entry("projects", {}, a2),
          ]),
        ],
        0,
        index,
      );
    expect(pruneHiddenTabs(trail(2), ["agent"])).toEqual(
      historyOf([segOf(REPO, "origin", [entry("projects", {}, a2)])], 0, 0),
    );
    const fromFirst = pruneHiddenTabs(trail(0), ["agent"]);
    expect(entriesOf(fromFirst)).toHaveLength(1);
    expect(entriesOf(fromFirst)[0].anchor).toBe(a1);
    const onAgent = pruneHiddenTabs(trail(1), ["agent"]);
    expect(entriesOf(onAgent).map((e) => e.tab)).toEqual([
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
    expect(session.entries.map((e) => e.tab)).toEqual(["issues", "agent"]);
    session.write({ repoTab: "tags" });
    expect(session.entries.map((e) => e.tab)).toEqual(["issues", "tags"]);
  });

  it("prunes nothing on un-hiding", () => {
    const history = historyOf(
      [segOf(REPO, null, [entry("issues"), entry("agent")])],
      0,
      1,
    );
    expect(pruneHiddenTabs(history, [])).toBe(history);
  });

  it("drops a segment a prune empties and merges the equal segments it parted", () => {
    const first = segOf(REPO, "origin", [entry("issues"), entry("tags")]);
    const agentOnly = segOf(BETA, null, [entry("agent")]);
    const last = segOf(REPO, "origin", [entry("history"), entry("pulls")]);
    const history = historyOf([first, agentOnly, last], 2, 1);
    const pruned = pruneHiddenTabs(history, ["agent"]);
    expect(pruned).toEqual(
      historyOf(
        [
          segOf(REPO, "origin", [
            entry("issues"),
            entry("tags"),
            entry("history"),
            entry("pulls"),
          ]),
        ],
        0,
        3,
      ),
    );
    // An equal location at the join collapses (I1), the current one surviving
    // whether it is the later of the pair or the earlier; the anchor, which is
    // no part of a location, tells which one did.
    const early = segOf(REPO, "origin", [
      entry("issues"),
      entry("tags", {}, anchor("early")),
    ]);
    const late = segOf(REPO, "origin", [
      entry("tags", {}, anchor("late")),
      entry("pulls"),
    ]);
    const joined = pruneHiddenTabs(historyOf([early, agentOnly, late], 2, 0), [
      "agent",
    ]);
    expect(entriesOf(joined).map((e) => e.tab)).toEqual([
      "issues",
      "tags",
      "pulls",
    ]);
    expect(joined.index).toBe(1);
    expect(currentEntry(joined)?.anchor?.itemId).toBe("late");
    const joinedEarly = pruneHiddenTabs(
      historyOf([early, agentOnly, late], 0, 1),
      ["agent"],
    );
    expect(entriesOf(joinedEarly).map((e) => e.tab)).toEqual([
      "issues",
      "tags",
      "pulls",
    ]);
    expect(joinedEarly.index).toBe(1);
    expect(currentEntry(joinedEarly)?.anchor?.itemId).toBe("early");
    // A hidden CURRENT entry keeps its segment.
    const kept = historyOf([first, agentOnly, last], 1, 0);
    expect(pruneHiddenTabs(kept, ["agent"])).toBe(kept);
  });

  it("drops hidden non-current entries in every segment and keeps untouched segments", () => {
    const first = segOf(REPO, "origin", [entry("agent"), entry("tags")]);
    const middle = segOf(BETA, null, [entry("issues")]);
    const last = segOf(GAMMA, null, [entry("history"), entry("agent")]);
    const pruned = pruneHiddenTabs(historyOf([first, middle, last], 1, 0), [
      "agent",
    ]);
    expect(pruned.segments.map((x) => x.entries.map((e) => e.tab))).toEqual([
      ["tags"],
      ["issues"],
      ["history"],
    ]);
    expect(pruned.segments[1]).toBe(middle);
    expect(pruned.segment).toBe(1);
    expect(pruned.index).toBe(0);
  });
});

describe("invariants", () => {
  it("merges a list pick back onto the entry the hop left", () => {
    const session = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    session.checkInvariants = true;
    session.write({ selectedIssue: issue(2) }, true);
    session.write({ selectedIssue: issue(1) });
    expect(session.entries).toHaveLength(1);
    expect(canGoBack(session.s)).toBe(false);
  });

  it("merges a list pick equal to the forward entry", () => {
    const session = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    session.checkInvariants = true;
    session.write({ selectedIssue: issue(2) }, true);
    session.step(-1);
    session.write({ selectedIssue: issue(2) });
    expect(session.entries).toHaveLength(1);
    expect(canGoForward(session.s)).toBe(false);
  });

  it("leaves one entry for a rewrite equal to both neighbours", () => {
    const s = baseState({ repoTab: "issues", selectedIssue: issue(1) });
    const prev = {
      ...s,
      selectedIssue: issue(2),
      navHistory: historyOf(
        [
          segOf(REPO, null, [
            entry("issues", { selectedIssue: issue(1) }),
            entry("issues", { selectedIssue: issue(2) }),
            entry("issues", { selectedIssue: issue(1) }),
          ]),
        ],
        0,
        1,
      ),
    };
    const next = { ...prev, selectedIssue: issue(1) };
    const out = recordNavigation(next, prev, false, readNavAnchor, null);
    expect(entriesOf(out)).toHaveLength(1);
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
    expect(session.entries.length).toBeLessThanOrEqual(NAV_HISTORY_CAP);
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
    expect(session.entries[0].tab).toBe("projects");
    expect(session.entries[0].anchor).toBe(a);
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

describe("carried hops", () => {
  it("starts a segment on a cross-repo hop, storing the departing anchor once", () => {
    const a = anchor("card-1");
    const provider = vi.fn(() => a);
    registerNavAnchorProvider("projects", provider);
    const session = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    session.checkInvariants = true;
    session.write({ repoTab: "projects" });
    session.write({ repoTab: "pulls", selectedPr: pr(2) });
    session.step(-1);
    provider.mockClear();
    session.carry(
      {
        repoPath: BETA,
        repoName: "beta",
        repoTab: "issues",
        selectedIssue: issue(9),
      },
      { lens: "origin" },
    );
    expect(provider).toHaveBeenCalledTimes(1);
    // The forward Pulls entry is dropped; a null stamp stays null across repositories.
    expect(session.history).toEqual(
      historyOf(
        [
          segOf(REPO, null, [
            entry("issues", { selectedIssue: issue(1) }),
            entry("projects", {}, a),
          ]),
          segOf(BETA, "origin", [entry("issues", { selectedIssue: issue(9) })]),
        ],
        1,
        0,
      ),
    );
    expect(canGoBack(session.s)).toBe(true);
    expect(canGoForward(session.s)).toBe(false);
  });

  it("drops every segment after the departing one, and accepts only an unchanged or reset history", () => {
    const s = baseState({ repoTab: "issues", selectedIssue: issue(1) });
    const prev = {
      ...s,
      navHistory: historyOf(
        [
          segOf(REPO, "origin", [
            entry("issues", { selectedIssue: issue(1) }),
            entry("pulls"),
          ]),
          segOf(GAMMA, null, [entry("tags")]),
        ],
        0,
        0,
      ),
    };
    const next = {
      ...prev,
      repoPath: BETA,
      repoName: "beta",
      repoTab: "pulls" as const,
      selectedPr: pr(5),
      navHistory: EMPTY_NAV_HISTORY,
    };
    const carry = carryOf({ live: prev });
    expect(recordNavigation(next, prev, false, () => undefined, carry)).toEqual(
      historyOf(
        [
          segOf(REPO, "origin", [entry("issues", { selectedIssue: issue(1) })]),
          segOf(BETA, null, [entry("pulls", { selectedPr: pr(5) })]),
        ],
        1,
        0,
      ),
    );
    // A history another writer authored is that writer's (N3), carry or not.
    const written = historyOf([segOf(BETA, null, [entry("tags")])], 0, 0);
    expect(
      recordNavigation(
        { ...next, navHistory: written },
        prev,
        false,
        () => undefined,
        carry,
      ),
    ).toBe(written);
  });

  // `shown` is the trail before beforeSelect, `now` the one the landing found. The
  // live state selects #2. Where `now` names another place, its pulls stop already
  // holds #2, so those cases pin only which trail the departing segment is built
  // from, never a selection carried into a segment it wasn't captured in.
  const shownTrail = historyOf(
    [segOf(REPO, null, [entry("changes"), entry("pulls")])],
    0,
    1,
  );
  const pr2 = { selectedPr: pr(2) };
  it.each([
    [
      "the same segment: the trail before beforeSelect",
      shownTrail,
      historyOf([segOf(REPO, null, [entry("pulls")])], 0, 0),
      REPO,
      [
        segOf(REPO, null, [
          entry("changes"),
          entry("pulls", { selectedPr: pr(2) }),
        ]),
      ],
    ],
    [
      "another segment count: the trail the landing found",
      shownTrail,
      historyOf(
        [
          segOf(REPO, null, [entry("pulls", pr2)]),
          segOf(GAMMA, null, [entry("tags")]),
        ],
        0,
        0,
      ),
      REPO,
      [segOf(REPO, null, [entry("pulls", pr2)])],
    ],
    [
      "another current segment: the trail the landing found",
      historyOf(
        [
          segOf(REPO, null, [entry("changes"), entry("pulls")]),
          segOf(GAMMA, null, [entry("tags")]),
        ],
        0,
        1,
      ),
      historyOf(
        [
          segOf(GAMMA, null, [entry("tags")]),
          segOf(REPO, null, [entry("pulls", pr2)]),
        ],
        1,
        0,
      ),
      REPO,
      [
        segOf(GAMMA, null, [entry("tags")]),
        segOf(REPO, null, [entry("pulls", pr2)]),
      ],
    ],
    [
      "another repository: the trail the landing found",
      shownTrail,
      historyOf([segOf(GAMMA, null, [entry("pulls", pr2)])], 0, 0),
      GAMMA,
      [segOf(GAMMA, null, [entry("pulls", pr2)])],
    ],
  ] as const)(
    "builds the departing trail from %s",
    (_name, shown, now, repoPath, departed) => {
      const prev = baseState({
        repoPath,
        repoName: repoPath.split("/").pop() ?? null,
        repoTab: "pulls",
        navHistory: now,
      });
      const next = {
        ...prev,
        repoPath: BETA,
        repoName: "beta",
        repoTab: "issues" as const,
        selectedIssue: issue(9),
        navHistory: EMPTY_NAV_HISTORY,
      };
      // Production takes the carry's path and trail from one snapshot, so the
      // live state stands where `shown` does.
      const from = currentSegment(shown) as NavSegment;
      const at = { ...prev, repoPath: from.repoPath, repoName: from.repoName };
      const carry = carryOf({
        live: { ...at, ...pr2, navHistory: shown },
      });
      expect(
        recordNavigation(next, prev, false, () => undefined, carry),
      ).toEqual(
        historyOf(
          [
            ...departed,
            segOf(BETA, null, [entry("issues", { selectedIssue: issue(9) })]),
          ],
          departed.length,
          0,
        ),
      );
    },
  );

  it("splits a same-repository hop under another lens, a null stamp counting as origin", () => {
    const session = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    session.checkInvariants = true;
    session.write({ repoTab: "pulls", selectedPr: pr(2) });
    session.carry(
      { repoTab: "issues", selectedIssue: issue(3) },
      { lens: "upstream" },
    );
    expect(session.history).toEqual(
      historyOf(
        [
          segOf(REPO, "origin", [
            entry("issues", { selectedIssue: issue(1) }),
            entry("pulls", { selectedPr: pr(2) }),
          ]),
          segOf(REPO, "upstream", [
            entry("issues", { selectedIssue: issue(3) }),
          ]),
        ],
        1,
        0,
      ),
    );
  });

  it("brings a null stamp in step with the live lens before splitting", () => {
    // Upstream already live: the stops recorded under the null stamp go, the departing
    // one stays and is stamped upstream.
    const up = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    up.checkInvariants = true;
    up.write({ repoTab: "pulls", selectedPr: pr(2) });
    up.carry(
      { repoTab: "issues", selectedIssue: issue(3) },
      { lensFrom: "upstream", lens: "origin" },
    );
    expect(up.history).toEqual(
      historyOf(
        [
          segOf(REPO, "upstream", [entry("pulls", { selectedPr: pr(2) })]),
          segOf(REPO, "origin", [entry("issues", { selectedIssue: issue(3) })]),
        ],
        1,
        0,
      ),
    );
    // Origin live: a null stamp is only stamped, and every stop stays.
    const origin = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    origin.write({ repoTab: "pulls", selectedPr: pr(2) });
    origin.carry(
      { repoTab: "issues", selectedIssue: issue(3) },
      { lensFrom: "origin", lens: "upstream" },
    );
    expect(origin.history.segments.map((x) => x.lens)).toEqual([
      "origin",
      "upstream",
    ]);
    expect(origin.history.segments[0].entries.map((e) => e.tab)).toEqual([
      "issues",
      "pulls",
    ]);
  });

  it("re-seeds a stale stamp the live lens contradicts before splitting", () => {
    const session = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    session.sync("origin");
    session.write({ repoTab: "pulls", selectedPr: pr(2) });
    session.carry(
      { repoTab: "issues", selectedIssue: issue(3) },
      { lensFrom: "upstream", lens: "origin" },
    );
    expect(session.history).toEqual(
      historyOf(
        [
          segOf(REPO, "upstream", [entry("pulls", { selectedPr: pr(2) })]),
          segOf(REPO, "origin", [entry("issues", { selectedIssue: issue(3) })]),
        ],
        1,
        0,
      ),
    );
  });

  it("starts no segment when the arrival lens equals the live one, whatever the stale stamp", () => {
    const session = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    session.sync("origin");
    session.carry(
      { repoTab: "pulls", selectedPr: pr(2) },
      { lensFrom: "upstream", lens: "upstream" },
    );
    expect(session.history.segments).toHaveLength(1);
    expect(session.lens).toBe("origin");
    expect(session.entries.map((e) => e.tab)).toEqual(["issues", "pulls"]);
  });

  it("stamps a cross-repository departure with the live lens when the reader could tell", () => {
    const session = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    session.write({ repoTab: "pulls", selectedPr: pr(2) });
    session.carry(
      { repoPath: BETA, repoName: "beta", repoTab: "tags" },
      { lensFrom: "upstream", lens: null },
    );
    expect(session.history).toEqual(
      historyOf(
        [
          segOf(REPO, "upstream", [entry("pulls", { selectedPr: pr(2) })]),
          segOf(BETA, null, [entry("tags")]),
        ],
        1,
        0,
      ),
    );
    const origin = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    origin.write({ repoTab: "pulls", selectedPr: pr(2) });
    origin.carry(
      { repoPath: BETA, repoName: "beta", repoTab: "tags" },
      { lensFrom: "origin", lens: null },
    );
    expect(origin.history.segments[0].lens).toBe("origin");
    expect(origin.history.segments[0].entries).toHaveLength(2);
  });

  it("records a carried landing that changes neither repository nor lens as an ordinary one", () => {
    const session = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    session.checkInvariants = true;
    session.carry({ repoTab: "pulls", selectedPr: pr(2) }, { lens: null });
    expect(session.entries.map((e) => e.tab)).toEqual(["issues", "pulls"]);
    session.carry({ selectedPr: pr(3) }, { lens: "origin" }, true);
    expect(session.entries).toHaveLength(3);
    session.carry(
      { selectedPr: pr(4) },
      { lensFrom: "origin", lens: "origin" },
    );
    expect(session.history.segments).toHaveLength(1);
    expect(session.entries).toHaveLength(3);
    expect(session.entries[2].selection).toEqual({ selectedPr: pr(4) });
  });

  it("keeps the departing entry as stored for a hop made from an overlay, unread", () => {
    const a = anchor("card-1");
    let answer: BoardAnchor | null | undefined = a;
    const provider = vi.fn(() => answer);
    registerNavAnchorProvider("projects", provider);
    const session = new Session({ repoTab: "projects" });
    session.write({ view: "mywork" });
    const stored = session.entries[0];
    expect(stored.anchor).toBe(a);
    provider.mockClear();
    answer = anchor("other");
    session.carry(
      {
        view: "repo",
        repoPath: BETA,
        repoName: "beta",
        repoTab: "issues",
        selectedIssue: issue(2),
      },
      { lens: "origin" },
    );
    expect(provider).not.toHaveBeenCalled();
    expect(session.history.segments).toHaveLength(2);
    expect(session.history.segments[0].entries[0]).toBe(stored);
  });

  it("seeds when no repository was open, and is spent unused under an overlay", () => {
    const closed = new Session({
      view: "welcome",
      repoPath: null,
      repoName: null,
    });
    expect(closed.history).toBe(EMPTY_NAV_HISTORY);
    closed.carry(
      { view: "repo", repoPath: BETA, repoName: "beta", repoTab: "tags" },
      { lens: "origin" },
    );
    expect(closed.history).toEqual(
      historyOf([segOf(BETA, null, [entry("tags")])], 0, 0),
    );

    const session = new Session({ repoTab: "issues" });
    const before = session.history;
    session.carry({ view: "settings" }, { lens: "upstream" });
    expect(session.history).toBe(before);
    session.write({ view: "repo", repoPath: BETA, repoName: "beta" });
    expect(session.history.segments).toHaveLength(1);
    expect(currentSegment(session.history)?.repoPath).toBe(BETA);
  });

  it("takes the departing selection from the carry, not from the cleared state", () => {
    const session = new Session({ repoTab: "pulls", selectedPr: pr(2) });
    const live = session.s;
    // The lens apply's selection clear, recorded in place before the landing.
    session.write({ selectedPr: null });
    expect(session.entries[0].selection).toEqual({ selectedPr: null });
    session.carry(
      {
        repoPath: BETA,
        repoName: "beta",
        repoTab: "issues",
        selectedIssue: issue(9),
      },
      { live, lens: "origin" },
    );
    expect(session.history.segments[0].entries[0].selection).toEqual({
      selectedPr: pr(2),
    });
  });
});

describe("pushes and rewrites beside other segments", () => {
  const later = segOf(BETA, null, [entry("tags")]);
  const prev = baseState({
    repoTab: "issues",
    selectedIssue: issue(1),
    navHistory: historyOf(
      [
        segOf(REPO, null, [entry("issues", { selectedIssue: issue(1) })]),
        later,
      ],
      0,
      0,
    ),
  });

  it("a push drops every later segment; an in-place rewrite keeps them", () => {
    const pushed = recordNavigation(
      { ...prev, repoTab: "pulls" },
      prev,
      false,
      () => undefined,
      null,
    );
    expect(pushed.segments).toHaveLength(1);
    expect(entriesOf(pushed).map((e) => e.tab)).toEqual(["issues", "pulls"]);
    const hopped = recordNavigation(
      { ...prev, selectedIssue: issue(2) },
      prev,
      true,
      () => undefined,
      null,
    );
    expect(hopped.segments).toHaveLength(1);
    expect(entriesOf(hopped)).toHaveLength(2);
    const rewritten = recordNavigation(
      { ...prev, selectedIssue: issue(2) },
      prev,
      false,
      () => undefined,
      null,
    );
    expect(rewritten.segments).toHaveLength(2);
    expect(rewritten.segments[1]).toBe(later);
    expect(currentEntry(rewritten)?.selection).toEqual({
      selectedIssue: issue(2),
    });
  });

  it("seeds when the current segment names another repository", () => {
    const stray = {
      ...prev,
      navHistory: historyOf([later], 0, 0),
    };
    const out = recordNavigation(
      { ...stray, repoTab: "pulls" },
      stray,
      false,
      () => undefined,
      null,
    );
    expect(out).toEqual(historyOf([segOf(REPO, null, [entry("pulls")])], 0, 0));
  });

  it("caps the total across segments, evicting the oldest first and never the current entry", () => {
    const run = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) =>
        entry("issues", { selectedIssue: issue(from + i) }),
      );
    const second = segOf(BETA, null, run(100, 15));
    const state = baseState({
      repoPath: GAMMA,
      repoName: "gamma",
      repoTab: "issues",
      selectedIssue: issue(214),
      navHistory: historyOf(
        [
          segOf(REPO, null, run(0, 20)),
          second,
          segOf(GAMMA, null, run(200, 15)),
        ],
        2,
        14,
      ),
    });
    const out = recordNavigation(
      { ...state, selectedIssue: issue(999) },
      state,
      true,
      () => undefined,
      null,
    );
    expect(out.segments.reduce((n, seg) => n + seg.entries.length, 0)).toBe(
      NAV_HISTORY_CAP,
    );
    expect(out.segments[0].entries).toHaveLength(19);
    expect(out.segments[0].entries[0].selection).toEqual({
      selectedIssue: issue(1),
    });
    expect(out.segments[1]).toBe(second);
    expect(out.segment).toBe(2);
    expect(currentEntry(out)?.selection).toEqual({ selectedIssue: issue(999) });

    // A first segment of one entry is evicted whole.
    const whole = baseState({
      repoPath: GAMMA,
      repoName: "gamma",
      repoTab: "issues",
      selectedIssue: issue(224),
      navHistory: historyOf(
        [
          segOf(REPO, null, [entry("tags")]),
          segOf(BETA, null, run(100, 24)),
          segOf(GAMMA, null, run(200, 25)),
        ],
        2,
        24,
      ),
    });
    const evicted = recordNavigation(
      { ...whole, selectedIssue: issue(999) },
      whole,
      true,
      () => undefined,
      null,
    );
    expect(evicted.segments.map((x) => x.repoPath)).toEqual([BETA, GAMMA]);
    expect(evicted.segment).toBe(1);
    expect(evicted.index).toBe(25);
  });
});

describe("restore across segments", () => {
  const three = (segment: number, index: number) =>
    historyOf(
      [
        segOf(REPO, null, [
          entry("issues", { selectedIssue: issue(1) }),
          entry("pulls", { selectedPr: pr(2) }),
        ]),
        segOf(BETA, "upstream", [
          entry("tags"),
          entry("projects", {}, anchor("card-3")),
        ]),
        segOf(GAMMA, "origin", [
          entry("history", { selectedCommitHash: "abc" }),
          entry("changes"),
        ]),
      ],
      segment,
      index,
    );
  const PLACES = [
    { repoPath: REPO, repoName: "alpha" },
    { repoPath: BETA, repoName: "beta" },
    { repoPath: GAMMA, repoName: "gamma" },
  ];
  const at = (segment: number, index: number, over: Partial<Sim> = {}) => {
    const navHistory = three(segment, index);
    const here = navHistory.segments[segment].entries[index];
    return baseState({
      ...PLACES[segment],
      repoTab: here.tab,
      ...here.selection,
      navHistory,
      ...over,
    });
  };

  it("names the neighbouring segment without reading an anchor", () => {
    const provider = vi.fn(() => anchor("x"));
    registerNavAnchorProvider("tags", provider);
    registerNavAnchorProvider("projects", provider);
    expect(restoreTarget(at(1, 0), -1)).toEqual({
      kind: "segment",
      repoPath: REPO,
      repoName: "alpha",
      lens: null,
    });
    expect(restoreTarget(at(1, 0), 1)).toEqual({ kind: "entry" });
    expect(restoreTarget(at(1, 1), 1)).toEqual({
      kind: "segment",
      repoPath: GAMMA,
      repoName: "gamma",
      lens: "origin",
    });
    expect(restoreTarget(at(0, 0), -1)).toBeNull();
    expect(restoreTarget(at(2, 1), 1)).toBeNull();
    expect(
      restoreTarget(baseState({ navHistory: EMPTY_NAV_HISTORY }), -1),
    ).toBeNull();
    expect(provider).not.toHaveBeenCalled();
  });

  it("steps into the previous segment's last entry and the next segment's first", () => {
    const provider = vi.fn((_tab: RepoTab) => undefined);
    const back = restoreStep(
      at(1, 0, { selectedTag: { tag: "v2" } }),
      -1,
      provider,
    );
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledWith("tags");
    expect(back?.crossing).toEqual({
      repoPath: REPO,
      repoName: "alpha",
      lens: null,
    });
    expect(back?.navHistory.segment).toBe(0);
    expect(back?.navHistory.index).toBe(1);
    expect(back?.navHistory.segments[1].entries[0].selection).toEqual({
      selectedTag: { tag: "v2" },
    });
    expect(back?.patch).toMatchObject({
      repoTab: "pulls",
      selectedPr: pr(2),
      pendingPrAlign: true,
    });
    for (const key of ["view", "repoPath", "repoName", "previousView"]) {
      expect(back?.patch).not.toHaveProperty(key);
    }
    expect(back?.anchor).toBeNull();

    const forward = restoreStep(at(1, 1), 1, () => undefined);
    expect(forward?.crossing).toEqual({
      repoPath: GAMMA,
      repoName: "gamma",
      lens: "origin",
    });
    expect(forward?.navHistory.segment).toBe(2);
    expect(forward?.navHistory.index).toBe(0);
    expect(forward?.patch).toMatchObject({
      repoTab: "history",
      selectedCommitHash: "abc",
    });

    // Into a projects entry: its stored anchor is the board return's.
    const toBoard = restoreStep(at(2, 0), -1, () => undefined);
    expect(toBoard?.anchor).toEqual(anchor("card-3"));
    expect(toBoard?.crossing?.repoPath).toBe(BETA);
    // Inside a segment nothing crosses.
    expect(restoreStep(at(1, 1), -1, () => undefined)?.crossing).toBeNull();
  });

  it("can go back at index 0 of a later segment, and forward from a segment's last entry", () => {
    expect(canGoBack(at(1, 0))).toBe(true);
    expect(canGoForward(at(1, 1))).toBe(true);
    expect(canGoBack(at(0, 0))).toBe(false);
    expect(canGoForward(at(2, 1))).toBe(false);
    expect(canGoBack(at(1, 0, { view: "settings" }))).toBe(false);
    expect(canGoForward(at(1, 1, { view: "settings" }))).toBe(false);
  });

  it("walks Back and Forward across a carried hop", () => {
    const session = new Session({ repoTab: "issues", selectedIssue: issue(1) });
    session.checkInvariants = true;
    session.carry(
      { repoPath: BETA, repoName: "beta", repoTab: "tags" },
      { lens: "upstream" },
    );
    session.write({ repoTab: "history" });
    session.step(-1);
    const back = session.step(-1);
    expect(back?.crossing?.repoPath).toBe(REPO);
    expect(session.s.repoPath).toBe(REPO);
    expect(session.s.repoName).toBe("alpha");
    expect(session.s.repoTab).toBe("issues");
    expect(session.s.selectedIssue).toEqual(issue(1));
    expect(session.history.segment).toBe(0);
    session.step(1);
    expect(session.s.repoPath).toBe(BETA);
    expect(session.s.repoTab).toBe("tags");
    session.step(1);
    expect(session.s.repoTab).toBe("history");
    expect(canGoForward(session.s)).toBe(false);
  });
});

describe("dropRepository", () => {
  const A = (...tabs: RepoTab[]) =>
    segOf(
      REPO,
      null,
      tabs.map((t) => entry(t)),
    );
  const B = (lens: RemoteLens | null = null) =>
    segOf(BETA, lens, [entry("tags")]);
  const C = () => segOf(GAMMA, null, [entry("history")]);

  it("removes the dead repository behind only and ahead only", () => {
    const behind = dropRepository(
      historyOf([B(), C(), A("issues")], 2, 0),
      BETA,
      [],
    );
    expect(behind.segments.map((x) => x.repoPath)).toEqual([GAMMA, REPO]);
    expect(behind.segment).toBe(1);
    expect(behind.index).toBe(0);
    const ahead = dropRepository(
      historyOf([A("issues"), B(), C()], 0, 0),
      BETA,
      [],
    );
    expect(ahead.segments.map((x) => x.repoPath)).toEqual([REPO, GAMMA]);
    expect(ahead.segment).toBe(0);
  });

  it("removes it on both sides in one call and merges what it parted", () => {
    const history = historyOf(
      [
        segOf(REPO, null, [
          entry("issues"),
          entry("pulls", {}, anchor("early")),
        ]),
        B(),
        segOf(REPO, null, [
          entry("pulls", {}, anchor("late")),
          entry("history"),
        ]),
        B("upstream"),
        A("changes"),
      ],
      2,
      1,
    );
    const out = dropRepository(history, BETA, []);
    // The join's equal Pulls entries collapse (I1): neither is current, so the
    // later one survives, told apart by its anchor.
    expect(out.segments).toHaveLength(1);
    expect(entriesOf(out).map((e) => e.tab)).toEqual([
      "issues",
      "pulls",
      "history",
      "changes",
    ]);
    expect(entriesOf(out)[1].anchor?.itemId).toBe("late");
    expect(out.segment).toBe(0);
    expect(currentEntry(out)?.tab).toBe("history");
    expect(out.index).toBe(2);
    expect(canGoBack({ view: "repo", navHistory: out })).toBe(true);
    expect(canGoForward({ view: "repo", navHistory: out })).toBe(true);
  });

  it("removes every lens of the repository, and the segment falls by the count removed before it", () => {
    const out = dropRepository(
      historyOf([B("origin"), C(), B("upstream"), A("issues")], 3, 0),
      BETA,
      [],
    );
    expect(out.segments.map((x) => x.repoPath)).toEqual([GAMMA, REPO]);
    expect(out.segment).toBe(1);
    const alone = dropRepository(
      historyOf([B("origin"), A("issues", "pulls"), B("upstream")], 1, 1),
      BETA,
      [],
    );
    expect(alone).toEqual(historyOf([A("issues", "pulls")], 0, 1));
    expect(canGoBack({ view: "repo", navHistory: alone })).toBe(true);
    const single = dropRepository(
      historyOf([B(), A("issues"), B("upstream")], 1, 0),
      BETA,
      [],
    );
    expect(canGoBack({ view: "repo", navHistory: single })).toBe(false);
    expect(canGoForward({ view: "repo", navHistory: single })).toBe(false);
  });

  it("returns the history itself when no segment names the path, or the current one does", () => {
    const history = historyOf([B(), A("issues"), C()], 1, 0);
    expect(dropRepository(history, "C:/repos/delta", [])).toBe(history);
    expect(dropRepository(history, REPO, [])).toBe(history);
    expect(dropRepository(EMPTY_NAV_HISTORY, BETA, [])).toBe(EMPTY_NAV_HISTORY);
    // Strict equality: another spelling of the same folder is another repository.
    expect(dropRepository(history, "C:\\repos\\beta", [])).toBe(history);
  });

  it("prunes hidden entries in the same pass", () => {
    const out = dropRepository(
      historyOf(
        [segOf(GAMMA, null, [entry("agent"), entry("tags")]), B(), A("issues")],
        2,
        0,
      ),
      BETA,
      ["agent"],
    );
    expect(out.segments[0].entries.map((e) => e.tab)).toEqual(["tags"]);
  });
});

describe("lens reader", () => {
  it("answers null with none registered, and an unregister removes only its own", () => {
    expect(readNavLens(REPO)).toBeNull();
    const first = registerNavLensReader(() => "upstream");
    const second = registerNavLensReader((path) =>
      path === REPO ? "origin" : null,
    );
    first();
    expect(readNavLens(REPO)).toBe("origin");
    expect(readNavLens(BETA)).toBeNull();
    second();
    expect(readNavLens(REPO)).toBeNull();
    registerNavLensReader(() => "upstream");
    __resetNavHistoryForTests();
    expect(readNavLens(REPO)).toBeNull();
  });
});

describe("carry mark", () => {
  it("is taken once and retired by the microtask that armed it", async () => {
    expect(takeCarry()).toBeNull();
    const carry = carryOf({ lens: "upstream" });
    armCarry(carry);
    expect(takeCarry()).toBe(carry);
    expect(takeCarry()).toBeNull();

    armCarry(carry);
    await Promise.resolve();
    expect(takeCarry()).toBeNull();

    // An earlier arm's clear retires only its own mark: a later arm survives it.
    armCarry(carryOf());
    takeCarry();
    let seen: NavCarry | null = null;
    queueMicrotask(() => {
      seen = takeCarry();
    });
    armCarry(carry);
    await Promise.resolve();
    expect(seen).toBe(carry);

    armCarry(carry);
    __resetNavHistoryForTests();
    expect(takeCarry()).toBeNull();
  });
});
