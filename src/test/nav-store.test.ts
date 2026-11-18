import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteLens } from "@/lib/git/types";
import {
  __resetNavHistoryForTests,
  type BoardAnchor,
  canGoBack,
  canGoForward,
  currentSegment,
  NAV_HISTORY_CAP,
  NAV_SELECTION_FIELDS,
  type NavEntry,
  type NavSegment,
  readNavAnchor,
  registerNavAnchorProvider,
  registerNavLensReader,
  restoreStep,
  sameLocation,
  selectionOf,
} from "@/lib/stores/nav-history";
import {
  type RepoTab,
  registerRepoShellWarmup,
  type UiState,
  useUiStore,
} from "@/lib/stores/ui";

// The store wiring: the recorder's subscribe, goBack/goForward, the three
// non-bumping writers and the navigator hop marks, driven through useUiStore.
// jsdom has no View Transitions API, so every navigator applies synchronously.

const REPO = "C:/repos/alpha";
const OTHER = "C:/repos/beta";

const st = () => useUiStore.getState();
const hist = () => st().navHistory;
/** The current segment's entries and stamp; `segmentTabs` reads every segment. */
const entries = (): readonly NavEntry[] =>
  currentSegment(hist())?.entries ?? [];
const lens = () => currentSegment(hist())?.lens ?? null;
const tabs = () => entries().map((e) => e.tab);
const current = (): NavEntry => entries()[hist().index];

const issue = (n: number) => ({ kind: "remote" as const, id: String(n) });
const pr = (n: number) => ({ kind: "remote" as const, id: String(n) });
const file = (path: string) => ({ path, staged: false, untracked: false });
const anchor = (projectId: string): BoardAnchor => ({
  projectId,
  viewId: "v1",
  itemId: "card-1",
  showArchived: false,
});

function enterRepo(root = REPO) {
  st().openRepo({ root, name: root.split("/").pop() ?? root });
}

/** Counts store notifications from now on; the returned function stops counting. */
function countNotifications() {
  let count = 0;
  const unsubscribe = useUiStore.subscribe(() => {
    count += 1;
  });
  return {
    get count() {
      return count;
    },
    stop: unsubscribe,
  };
}

/** The history invariants (per segment: no two adjacent equal locations, no non-current
 *  entry on a hidden tab, never empty; across segments: the cap, no two equal neighbours,
 *  `segment` and `index` on an entry) and "canGo* true exactly when a press changes
 *  location", a repository or lens change counting as one, checked after every store
 *  change until the returned function runs. */
function watchInvariants(): () => string[] {
  const problems: string[] = [];
  const unsubscribe = useUiStore.subscribe((s) => {
    const { segments, segment, index } = s.navHistory;
    if (s.view !== "repo") return;
    const total = segments.reduce((n, seg) => n + seg.entries.length, 0);
    if (total > NAV_HISTORY_CAP) problems.push("over the cap");
    const seg: NavSegment | undefined = segments[segment];
    if (segments.length > 0 && (seg === undefined || !seg.entries[index]))
      problems.push(`segment ${segment} index ${index} names no entry`);
    segments.forEach((x, n) => {
      if (x.entries.length === 0) problems.push(`segment ${n} is empty`);
      const prev = segments[n - 1];
      if (prev && prev.repoPath === x.repoPath && prev.lens === x.lens)
        problems.push(`segments ${n - 1} and ${n} are one place`);
      x.entries.forEach((e, i) => {
        if (i > 0 && sameLocation(x.entries[i - 1], e))
          problems.push(`entries ${n}:${i - 1} and ${n}:${i} are one location`);
        if ((n !== segment || i !== index) && s.navHiddenTabs.includes(e.tab))
          problems.push(`entry ${n}:${i} is on hidden tab ${e.tab}`);
      });
    });
    if (seg === undefined) return;
    const here = { tab: s.repoTab, selection: selectionOf(s.repoTab, s) };
    const back = seg.entries[index - 1];
    const fwd = seg.entries[index + 1];
    const backMoves =
      back !== undefined ? !sameLocation(back, here) : segment > 0;
    const fwdMoves =
      fwd !== undefined
        ? !sameLocation(fwd, here)
        : segment < segments.length - 1;
    if (canGoBack(s) !== backMoves)
      problems.push("canGoBack disagrees with the trail");
    if (canGoForward(s) !== fwdMoves)
      problems.push("canGoForward disagrees with the trail");
  });
  return () => {
    unsubscribe();
    return problems;
  };
}

beforeEach(() => {
  useUiStore.setState(useUiStore.getInitialState(), true);
  __resetNavHistoryForTests();
});
afterEach(() => {
  useUiStore.setState(useUiStore.getInitialState(), true);
  __resetNavHistoryForTests();
});

describe("repo switch and close", () => {
  it("opening a repo leaves one entry at the landing, index 0, stamp null", () => {
    enterRepo();
    expect(hist()).toEqual({
      segments: [
        {
          repoPath: REPO,
          repoName: "alpha",
          lens: null,
          entries: [
            { tab: "changes", selection: { selectedFile: null }, anchor: null },
          ],
        },
      ],
      segment: 0,
      index: 0,
    });
  });

  it("re-opening and switching repos start over; closing leaves nothing", () => {
    enterRepo();
    st().setRepoTab("issues");
    st().setRepoTab("history");
    enterRepo();
    expect(tabs()).toEqual(["changes"]);
    st().setRepoTab("issues");
    useUiStore.setState({
      boardReturn: { anchor: anchor("p"), epoch: st().interactionEpoch },
    });
    enterRepo(OTHER);
    expect(tabs()).toEqual(["changes"]);
    expect(st().boardReturn).toBeNull();
    st().setRepoTab("tags");
    useUiStore.setState({
      boardReturn: { anchor: anchor("p"), epoch: st().interactionEpoch },
    });
    st().closeRepo();
    expect(st().view).toBe("welcome");
    expect(hist().segments).toEqual([]);
    expect(hist().segment).toBe(-1);
    expect(hist().index).toBe(-1);
    expect(st().boardReturn).toBeNull();
  });

  it.each([
    [
      "openPr",
      () =>
        st().openPr({
          kind: "remote",
          repoPath: OTHER,
          repoName: "beta",
          ref: "7",
          section: null,
        }),
      "pulls",
    ],
    [
      "openIssue",
      () => st().openIssue({ repoPath: OTHER, repoName: "beta", number: 7 }),
      "issues",
    ],
    [
      "openRun",
      () => st().openRun({ repoPath: OTHER, repoName: "beta", runId: 7 }),
      "actions",
    ],
    [
      "openAgentTab",
      () => st().openAgentTab({ repoPath: OTHER, repoName: "beta" }),
      "agent",
    ],
    [
      "openRepoView",
      () =>
        st().openRepoView({ repoPath: OTHER, repoName: "beta", tab: "tags" }),
      "tags",
    ],
  ] as const)(
    "a cross-repo %s landing re-seeds at the landing",
    (_n, land, tab) => {
      enterRepo();
      st().setRepoTab("issues");
      st().setRepoTab("history");
      land();
      expect(st().repoPath).toBe(OTHER);
      expect(hist().segments).toHaveLength(1);
      expect(currentSegment(hist())?.repoPath).toBe(OTHER);
      expect(tabs()).toEqual([tab]);
      expect(hist().index).toBe(0);
      expect(lens()).toBeNull();
    },
  );
});

describe("same-repo tab changes push", () => {
  it.each([
    ["setRepoTab", () => st().setRepoTab("pulls"), "pulls"],
    ["openCommit", () => st().openCommit("abc"), "history"],
    ["requestCreate", () => st().requestCreate("issue"), "issues"],
    ["landAmend", () => st().landAmend("abc", null, "t", "b"), "changes"],
    [
      "openPr",
      () =>
        st().openPr({
          kind: "remote",
          repoPath: REPO,
          repoName: "alpha",
          ref: "3",
          section: null,
        }),
      "pulls",
    ],
    [
      "openIssue",
      () => st().openIssue({ repoPath: REPO, repoName: "alpha", number: 3 }),
      "issues",
    ],
    [
      "openRun",
      () => st().openRun({ repoPath: REPO, repoName: "alpha", runId: 3 }),
      "actions",
    ],
    [
      "openAgentTab",
      () => st().openAgentTab({ repoPath: REPO, repoName: "alpha" }),
      "agent",
    ],
    [
      "openRepoView",
      () =>
        st().openRepoView({
          repoPath: REPO,
          repoName: "alpha",
          tab: "findings",
        }),
      "findings",
    ],
  ] as const)(
    "%s pushes one entry and drops forward entries",
    (name, write, tab) => {
      enterRepo();
      st().setRepoTab("tags");
      st().setRepoTab("insights");
      st().goBack();
      expect(tabs()).toEqual(["changes", "tags", "insights"]);
      const epoch = st().interactionEpoch;
      write();
      expect(st().repoTab).toBe(tab);
      expect(tabs()).toEqual(["changes", "tags", tab]);
      expect(hist().index).toBe(2);
      expect(st().interactionEpoch).toBe(
        name === "landAmend" ? epoch : epoch + 1,
      );
    },
  );

  it("records a tab written under an overlay as one push when the repo returns", () => {
    enterRepo();
    st().openSettings();
    const before = hist();
    st().setRepoTab("history");
    expect(hist()).toBe(before);
    st().closeSettings();
    expect(tabs()).toEqual(["changes", "history"]);
    expect(hist().index).toBe(1);
  });
});

describe("unmarked same-tab selections update in place", () => {
  const cases: [string, RepoTab, Partial<UiState>, () => void][] = [
    [
      "selectFile",
      "changes",
      { selectedFile: file("a") },
      () => st().selectFile(file("b")),
    ],
    [
      "clearSelectedFile",
      "changes",
      { selectedFile: file("a") },
      () => st().clearSelectedFile(),
    ],
    [
      "advanceSelectedFile",
      "changes",
      { selectedFile: file("a") },
      () => st().advanceSelectedFile(file("b")),
    ],
    [
      "selectCommit",
      "history",
      { selectedCommitHash: "a" },
      () => st().selectCommit("b"),
    ],
    [
      "clearSelectedCommit",
      "history",
      { selectedCommitHash: "a" },
      () => st().clearSelectedCommit(),
    ],
    [
      "landSelectedCommit",
      "history",
      { selectedCommitHash: "a" },
      () => st().landSelectedCommit("b"),
    ],
    [
      "setCompareBranch",
      "compare",
      { compareBranch: "main" },
      () => st().setCompareBranch("dev"),
    ],
    [
      "defaultCompareBranch",
      "compare",
      { compareBranch: "main" },
      () => st().defaultCompareBranch("dev"),
    ],
    [
      "selectCompareCommit",
      "compare",
      { compareBranch: "main" },
      () => st().selectCompareCommit("c"),
    ],
    ["selectPr", "pulls", { selectedPr: pr(1) }, () => st().selectPr(pr(2))],
    [
      "selectPrWithAlign",
      "pulls",
      { selectedPr: pr(1) },
      () => st().selectPrWithAlign(pr(2)),
    ],
    [
      "clearRemoteSelections",
      "pulls",
      { selectedPr: pr(1) },
      () => st().clearRemoteSelections(),
    ],
    [
      "selectIssue",
      "issues",
      { selectedIssue: issue(1) },
      () => st().selectIssue(issue(2)),
    ],
    [
      "selectDiscussion",
      "discussions",
      { selectedDiscussion: { number: 1 } },
      () => st().selectDiscussion({ number: 2 }),
    ],
    ["selectRun", "actions", { selectedRunId: 1 }, () => st().selectRun(2)],
    [
      "selectFinding",
      "findings",
      { selectedFinding: { type: "alert", number: 1 } },
      () => st().selectFinding({ type: "advisory", ghsaId: "GHSA-1" }),
    ],
    [
      "selectTag",
      "tags",
      { selectedTag: { tag: "v1" } },
      () => st().selectTag({ tag: "v2" }),
    ],
    [
      "setSelectedTodo",
      "code-todos",
      { selectedTodo: { path: "a.ts", line: 1, marker: "TODO", text: "x" } },
      () =>
        st().setSelectedTodo({
          path: "a.ts",
          line: 2,
          marker: "TODO",
          text: "x",
        }),
    ],
  ];

  it.each(cases)(
    "%s rewrites the current entry and keeps forward entries",
    (_n, tab, pre, write) => {
      enterRepo();
      useUiStore.setState(pre);
      st().setRepoTab("insights");
      st().setRepoTab(tab);
      st().setRepoTab("tasks");
      st().goBack();
      expect(tabs()).toEqual(["changes", "insights", tab, "tasks"]);
      const before = current();
      write();
      expect(tabs()).toEqual(["changes", "insights", tab, "tasks"]);
      expect(hist().index).toBe(2);
      expect(current().selection).not.toEqual(before.selection);
      expect(current().selection).toEqual(selectionOf(tab, st()));
    },
  );
});

describe("marked selections", () => {
  function onIssues() {
    enterRepo();
    st().setRepoTab("issues");
    st().selectIssue(issue(1));
    st().setRepoTab("tags");
    st().goBack();
  }

  it("a marked change pushes and drops forward entries; an equal one pushes nothing", () => {
    onIssues();
    st().markLinkHop();
    st().selectIssue(issue(2));
    expect(entries().map((e) => e.selection)).toEqual([
      { selectedFile: null },
      { selectedIssue: issue(1) },
      { selectedIssue: issue(2) },
    ]);
    expect(hist().index).toBe(2);
    const before = hist();
    st().markLinkHop();
    st().selectIssue(issue(2));
    expect(hist()).toBe(before);
  });

  it("selectPrWithAlign pushes when marked", () => {
    enterRepo();
    st().setRepoTab("pulls");
    st().markLinkHop();
    st().selectPrWithAlign(pr(4));
    expect(tabs()).toEqual(["changes", "pulls", "pulls"]);
  });

  it("a mark retired by its microtask never pushes", async () => {
    onIssues();
    st().markLinkHop();
    await Promise.resolve();
    st().selectIssue(issue(2));
    expect(tabs()).toEqual(["changes", "issues", "tags"]);
    expect(current().selection).toEqual({ selectedIssue: issue(2) });
  });

  it("a mark spent by an unrelated store write never pushes", () => {
    onIssues();
    st().markLinkHop();
    st().setActivityOpen(true);
    st().selectIssue(issue(2));
    expect(tabs()).toEqual(["changes", "issues", "tags"]);
    expect(current().selection).toEqual({ selectedIssue: issue(2) });
  });

  it("a write to another tab's selection changes nothing", () => {
    onIssues();
    st().setRepoTab("pulls");
    const before = hist();
    st().selectIssue(issue(9));
    st().markLinkHop();
    st().selectCommit("abc");
    expect(hist()).toBe(before);
  });
});

describe("goBack / goForward", () => {
  function trail() {
    enterRepo();
    st().setRepoTab("issues");
    st().selectIssue(issue(1));
    st().markLinkHop();
    st().selectIssue(issue(2));
    st().setRepoTab("pulls");
    st().selectPr(pr(3));
  }

  it("applies in one notification, bumps once, pushes nothing", () => {
    trail();
    // The current entry goes stale without the recorder seeing it: the restore
    // must rewrite the departing entry from live state.
    useUiStore.setState({ selectedPr: pr(4), navHistory: { ...hist() } });
    const epoch = st().interactionEpoch;
    const notes = countNotifications();
    st().goBack();
    notes.stop();
    expect(notes.count).toBe(1);
    expect(st().interactionEpoch).toBe(epoch + 1);
    expect(st().repoTab).toBe("issues");
    expect(st().selectedIssue).toEqual(issue(2));
    expect(tabs()).toEqual(["changes", "issues", "issues", "pulls"]);
    expect(hist().index).toBe(2);
    expect(entries()[3].selection).toEqual({ selectedPr: pr(4) });
    st().goBack();
    expect(st().selectedIssue).toEqual(issue(1));
    st().goForward();
    st().goForward();
    expect(st().repoTab).toBe("pulls");
    expect(st().selectedPr).toEqual(pr(4));
    expect(entries()).toHaveLength(4);
    expect(hist().index).toBe(3);
  });

  it("builds a patch with no view, repoPath, repoName or previousView key", () => {
    trail();
    const step = restoreStep(st(), -1, readNavAnchor);
    expect(step).not.toBeNull();
    for (const key of ["view", "repoPath", "repoName", "previousView"])
      expect(Object.hasOwn(step?.patch ?? {}, key)).toBe(false);
  });

  it("writes the stored item unvalidated, and a later prune folds in place", () => {
    trail();
    st().goBack();
    expect(st().selectedIssue).toEqual(issue(2));
    st().clearRemoteSelections();
    expect(current().selection).toEqual({ selectedIssue: null });
    expect(tabs()).toEqual(["changes", "issues", "issues", "pulls"]);
  });

  it("an empty direction sets nothing and reads no anchor", () => {
    enterRepo();
    const provider = vi.fn(() => anchor("p"));
    registerNavAnchorProvider("changes", provider);
    const before = st();
    st().goBack();
    st().goForward();
    expect(st()).toBe(before);
    expect(provider).not.toHaveBeenCalled();
  });

  it("reads the anchor once on the open, then sets nothing and reads none under the overlay", () => {
    enterRepo();
    st().setRepoTab("issues");
    st().goBack();
    const provider = vi.fn(() => anchor("p"));
    registerNavAnchorProvider("changes", provider);
    st().openHelp();
    expect(provider).toHaveBeenCalledTimes(1);
    const before = st();
    st().goBack();
    st().goForward();
    expect(st()).toBe(before);
    expect(provider).toHaveBeenCalledTimes(1);
  });
});

describe("overlays", () => {
  it.each([
    ["Settings", () => st().openSettings(), () => st().closeSettings()],
    ["Help", () => st().openHelp(), () => st().closeHelp()],
    ["Explore", () => st().openExplore(), () => st().closeExplore()],
    ["My Work", () => st().openMyWork(), () => st().closeMyWork()],
  ] as const)(
    "opening and closing %s leaves the history identical when no provider has a new answer",
    (_n, open, close) => {
      enterRepo();
      st().setRepoTab("issues");
      const before = hist();
      open();
      expect(hist()).toBe(before);
      close();
      expect(st().view).toBe("repo");
      expect(hist()).toBe(before);
    },
  );

  it("a location written under an overlay is folded in place when it closes", () => {
    enterRepo();
    st().setRepoTab("issues");
    st().openSettings();
    const before = hist();
    st().selectIssue(issue(5));
    expect(hist()).toBe(before);
    st().closeSettings();
    expect(tabs()).toEqual(["changes", "issues"]);
    expect(current().selection).toEqual({ selectedIssue: issue(5) });
  });

  it("a My Work landing into the same repo pushes on top of the overlaid location", () => {
    enterRepo();
    st().setRepoTab("issues");
    st().openMyWork();
    st().openPr({
      kind: "remote",
      repoPath: REPO,
      repoName: "alpha",
      ref: "7",
      section: null,
    });
    expect(st().view).toBe("repo");
    expect(tabs()).toEqual(["changes", "issues", "pulls"]);
    expect(current().selection).toEqual({ selectedPr: pr(7) });
  });
});

describe("PR restore align", () => {
  it("arms the align and clears the reveal one-shots for a PR entry", () => {
    enterRepo();
    st().setRepoTab("pulls");
    st().selectPr(pr(1));
    st().setRepoTab("issues");
    useUiStore.setState({
      pendingPrAlign: false,
      pendingPrSection: "files",
      pendingReviewId: "r1",
    });
    st().goBack();
    expect(st().selectedPr).toEqual(pr(1));
    expect(st().pendingPrAlign).toBe(true);
    expect(st().pendingPrSection).toBeNull();
    expect(st().pendingReviewId).toBeNull();
  });

  it("leaves the align off for a PR-less entry, and the three alone off Pulls", () => {
    enterRepo();
    st().setRepoTab("pulls");
    st().setRepoTab("issues");
    useUiStore.setState({ pendingPrAlign: true });
    st().goBack();
    expect(st().pendingPrAlign).toBe(false);
    useUiStore.setState({
      pendingPrAlign: true,
      pendingPrSection: "files",
      pendingReviewId: "r1",
    });
    st().goForward();
    expect(st().repoTab).toBe("issues");
    expect(st().pendingPrAlign).toBe(true);
    expect(st().pendingPrSection).toBe("files");
    expect(st().pendingReviewId).toBe("r1");
  });
});

describe("cap and field map", () => {
  it("never exceeds the cap, and index stays on the current location", () => {
    enterRepo();
    for (let i = 0; i < NAV_HISTORY_CAP + 10; i++)
      st().setRepoTab(i % 2 === 0 ? "issues" : "tags");
    expect(entries()).toHaveLength(NAV_HISTORY_CAP);
    expect(hist().index).toBe(NAV_HISTORY_CAP - 1);
    expect(current().tab).toBe(st().repoTab);
  });

  it("covers every selection field of the store's initial state", () => {
    const fromStore = Object.keys(useUiStore.getInitialState())
      .filter((k) => /^(selected[A-Z]|compare(Branch|CommitHash)$)/.test(k))
      .sort();
    const fromMap = [...new Set(Object.values(NAV_SELECTION_FIELDS).flat())];
    expect(fromMap.sort()).toEqual(fromStore);
  });
});

describe("board anchors", () => {
  it("stores the provider's answer on departure and arms the return on restore", () => {
    enterRepo();
    const unregisterA = registerNavAnchorProvider("projects", () =>
      anchor("A"),
    );
    st().setRepoTab("projects");
    st().setRepoTab("issues");
    expect(entries()[1].anchor).toEqual(anchor("A"));
    unregisterA();
    st().goBack();
    expect(st().repoTab).toBe("projects");
    expect(st().boardReturn).toEqual({
      anchor: anchor("A"),
      epoch: st().interactionEpoch,
    });
    const unregisterB = registerNavAnchorProvider("projects", () =>
      anchor("B"),
    );
    st().goForward();
    expect(st().boardReturn).toBeNull();
    expect(entries()[1].anchor).toEqual(anchor("B"));
    unregisterB();
    st().goBack();
    expect(entries()[1].anchor).toEqual(anchor("B"));
    expect(st().boardReturn?.anchor).toEqual(anchor("B"));
    st().clearBoardReturn();
    expect(st().boardReturn).toBeNull();
  });

  it("keeps the board's place across My Work and a landing on a pull request", () => {
    enterRepo();
    const unregister = registerNavAnchorProvider("projects", () => anchor("A"));
    st().setRepoTab("projects");
    st().openMyWork();
    // The overlay unmounts the repository view, and the panel's provider with it.
    unregister();
    st().openPr({
      kind: "remote",
      repoPath: REPO,
      repoName: "alpha",
      ref: "7",
      section: null,
    });
    expect(st().view).toBe("repo");
    expect(st().repoTab).toBe("pulls");
    st().goBack();
    expect(st().repoTab).toBe("projects");
    expect(st().boardReturn?.anchor).toEqual(anchor("A"));
  });

  it("stores a null answer, and arms no return for a projects entry without one", () => {
    enterRepo();
    registerNavAnchorProvider("projects", () => null);
    st().setRepoTab("projects");
    st().setRepoTab("issues");
    expect(entries()[1].anchor).toBeNull();
    st().goBack();
    expect(st().boardReturn).toBeNull();
  });
});

describe("in-store hop marks", () => {
  it("openCommit on the History tab pushes when the commit changes", () => {
    enterRepo();
    st().setRepoTab("history");
    st().selectCommit("a");
    st().openCommit("b");
    expect(entries().map((e) => e.selection)).toEqual([
      { selectedFile: null },
      { selectedCommitHash: "a" },
      { selectedCommitHash: "b" },
    ]);
  });

  it.each([
    [
      "openPr",
      "pulls",
      { selectedPr: pr(1) },
      () =>
        st().openPr({
          kind: "remote",
          repoPath: REPO,
          repoName: "alpha",
          ref: "2",
          section: null,
        }),
    ],
    [
      "openIssue",
      "issues",
      { selectedIssue: issue(1) },
      () => st().openIssue({ repoPath: REPO, repoName: "alpha", number: 2 }),
    ],
    [
      "openRun",
      "actions",
      { selectedRunId: 1 },
      () => st().openRun({ repoPath: REPO, repoName: "alpha", runId: 2 }),
    ],
  ] as const)("%s on the tab already showing pushes", (_n, tab, pre, land) => {
    enterRepo();
    st().setRepoTab(tab);
    useUiStore.setState(pre);
    land();
    expect(tabs()).toEqual(["changes", tab, tab]);
    expect(hist().index).toBe(2);
  });

  it("a mark armed before a beforeSelect write still lands on the selection", () => {
    enterRepo();
    st().setRepoTab("issues");
    st().selectIssue(issue(1));
    st().openIssue({
      repoPath: REPO,
      repoName: "alpha",
      number: 2,
      beforeSelect: () => st().setActivityOpen(true),
    });
    expect(tabs()).toEqual(["changes", "issues", "issues"]);
  });

  it("openPr: a beforeSelect store write does not spend the navigator's link-hop mark", () => {
    enterRepo();
    st().setRepoTab("pulls");
    useUiStore.setState({ selectedPr: pr(1) });
    st().openPr({
      kind: "remote",
      repoPath: REPO,
      repoName: "alpha",
      ref: "2",
      section: null,
      beforeSelect: () => st().setActivityOpen(true),
    });
    expect(tabs()).toEqual(["changes", "pulls", "pulls"]);
  });

  it("openAgentTab and openRepoView push only through a tab change", () => {
    enterRepo();
    st().setRepoTab("agent");
    const before = hist();
    st().openAgentTab({ repoPath: REPO, repoName: "alpha" });
    st().openRepoView({ repoPath: REPO, repoName: "alpha" });
    expect(hist()).toBe(before);
  });

  it("a landing that flips the lens ends as one entry once the sync runs", () => {
    enterRepo();
    st().syncNavLens(REPO, "origin");
    st().setRepoTab("issues");
    st().openPr({
      kind: "remote",
      repoPath: REPO,
      repoName: "alpha",
      ref: "2",
      section: null,
    });
    expect(tabs()).toEqual(["changes", "issues", "pulls"]);
    st().syncNavLens(REPO, "upstream");
    expect(hist()).toEqual({
      segments: [
        {
          repoPath: REPO,
          repoName: "alpha",
          lens: "upstream",
          entries: [
            { tab: "pulls", selection: { selectedPr: pr(2) }, anchor: null },
          ],
        },
      ],
      segment: 0,
      index: 0,
    });
  });
});

describe("syncNavLens", () => {
  function several() {
    enterRepo();
    st().setRepoTab("issues");
    st().setRepoTab("tags");
    useUiStore.setState({
      boardReturn: { anchor: anchor("p"), epoch: st().interactionEpoch },
    });
  }

  it("stamps a null stamp against origin and keeps every entry", () => {
    several();
    const before = hist();
    const epoch = st().interactionEpoch;
    const notes = countNotifications();
    st().syncNavLens(REPO, "origin");
    notes.stop();
    expect(notes.count).toBe(1);
    expect(entries()).toBe(currentSegment(before)?.entries);
    expect(hist().index).toBe(2);
    expect(lens()).toBe("origin");
    expect(st().boardReturn).not.toBeNull();
    expect(st().interactionEpoch).toBe(epoch);
  });

  it("re-seeds a null stamp against upstream and nulls the board return", () => {
    several();
    const epoch = st().interactionEpoch;
    st().syncNavLens(REPO, "upstream");
    expect(hist()).toEqual({
      segments: [
        {
          repoPath: REPO,
          repoName: "alpha",
          lens: "upstream",
          entries: [
            { tab: "tags", selection: { selectedTag: null }, anchor: null },
          ],
        },
      ],
      segment: 0,
      index: 0,
    });
    expect(st().boardReturn).toBeNull();
    expect(st().interactionEpoch).toBe(epoch);
  });

  it("re-seeds on a flip of a real stamp and nulls the board return", () => {
    several();
    st().syncNavLens(REPO, "origin");
    st().syncNavLens(REPO, "upstream");
    expect(tabs()).toEqual(["tags"]);
    expect(lens()).toBe("upstream");
    expect(st().boardReturn).toBeNull();
  });

  it("sets nothing for an equal stamp, an overlay, or another repo's lens", () => {
    several();
    st().syncNavLens(REPO, "origin");
    let before = st();
    st().syncNavLens(REPO, "origin");
    st().syncNavLens(OTHER, "upstream");
    expect(st()).toBe(before);
    st().openSettings();
    before = st();
    st().syncNavLens(REPO, "upstream");
    expect(st()).toBe(before);
  });

  it("a repo switch leaves the stamp null", () => {
    several();
    st().syncNavLens(REPO, "upstream");
    enterRepo(OTHER);
    expect(lens()).toBeNull();
  });
});

describe("invariants over a scripted session", () => {
  function landOnIssue(n: number) {
    enterRepo();
    st().openIssue({ repoPath: OTHER, repoName: "beta", number: n });
  }

  it("issue #1, hop to #2, list pick of #1 leaves one entry", () => {
    const stop = watchInvariants();
    landOnIssue(1);
    st().markLinkHop();
    st().selectIssue(issue(2));
    st().selectIssue(issue(1));
    expect(entries()).toHaveLength(1);
    expect(canGoBack(st())).toBe(false);
    expect(stop()).toEqual([]);
  });

  it("Back from #2 to #1, then a list pick of #2, leaves one entry", () => {
    const stop = watchInvariants();
    landOnIssue(1);
    st().markLinkHop();
    st().selectIssue(issue(2));
    st().goBack();
    st().selectIssue(issue(2));
    expect(entries()).toHaveLength(1);
    expect(canGoForward(st())).toBe(false);
    expect(stop()).toEqual([]);
  });

  it("a rewrite equal to both neighbours leaves one entry", () => {
    const stop = watchInvariants();
    landOnIssue(1);
    st().markLinkHop();
    st().selectIssue(issue(2));
    st().markLinkHop();
    st().selectIssue(issue(1));
    st().goBack();
    st().selectIssue(issue(1));
    expect(entries()).toHaveLength(1);
    expect(stop()).toEqual([]);
  });

  it("holds through tabs, hops, picks, deselects, restores, a hide and the cap", () => {
    const stop = watchInvariants();
    enterRepo();
    st().setRepoTab("issues");
    st().selectIssue(issue(1));
    st().markLinkHop();
    st().selectIssue(issue(2));
    st().selectIssue(null);
    st().setRepoTab("agent");
    st().setRepoTab("pulls");
    st().selectPr(pr(1));
    st().goBack();
    st().goBack();
    st().setNavHiddenTabs(["agent"]);
    st().goForward();
    st().selectPr(null);
    st().goBack();
    st().setRepoTab("agent");
    for (let i = 0; i < NAV_HISTORY_CAP + 5; i++) {
      st().markLinkHop();
      st().selectCommit(`c${i}`);
      st().setRepoTab(i % 2 === 0 ? "history" : "tags");
    }
    st().goBack();
    st().goBack();
    st().goForward();
    expect(entries().length).toBeLessThanOrEqual(NAV_HISTORY_CAP);
    expect(stop()).toEqual([]);
  });
});

describe("hidden tabs", () => {
  it("prunes non-current entries in one set that bumps nothing, and merges neighbours", () => {
    enterRepo();
    const unregisterA = registerNavAnchorProvider("projects", () =>
      anchor("A"),
    );
    st().setRepoTab("projects");
    st().setRepoTab("agent");
    unregisterA();
    st().setRepoTab("projects");
    registerNavAnchorProvider("projects", () => anchor("B"));
    st().setRepoTab("issues");
    expect(tabs()).toEqual([
      "changes",
      "projects",
      "agent",
      "projects",
      "issues",
    ]);
    const epoch = st().interactionEpoch;
    const notes = countNotifications();
    st().setNavHiddenTabs(["agent"]);
    notes.stop();
    expect(notes.count).toBe(1);
    expect(st().interactionEpoch).toBe(epoch);
    expect(tabs()).toEqual(["changes", "projects", "issues"]);
    expect(entries()[1].anchor).toEqual(anchor("B"));
    expect(hist().index).toBe(2);
    const before = st();
    st().setNavHiddenTabs(["agent"]);
    expect(st()).toBe(before);
  });

  it("keeps a hidden current entry until a tab change leaves it", () => {
    enterRepo();
    st().setRepoTab("issues");
    st().setRepoTab("agent");
    st().setNavHiddenTabs(["agent"]);
    expect(tabs()).toEqual(["changes", "issues", "agent"]);
    expect(canGoBack(st())).toBe(true);
    st().setRepoTab("history");
    expect(tabs()).toEqual(["changes", "issues", "history"]);
    st().goBack();
    expect(st().repoTab).toBe("issues");
  });

  it("drops a hidden current entry on a restore, so Forward cannot reach it", () => {
    enterRepo();
    st().setRepoTab("issues");
    st().setRepoTab("agent");
    st().setNavHiddenTabs(["agent"]);
    st().goBack();
    expect(tabs()).toEqual(["changes", "issues"]);
    expect(canGoForward(st())).toBe(false);
  });

  it("an agent landing while hidden is current until left; un-hiding prunes nothing", () => {
    enterRepo();
    st().setNavHiddenTabs(["agent"]);
    st().setRepoTab("issues");
    st().openAgentTab({ repoPath: REPO, repoName: "alpha" });
    expect(tabs()).toEqual(["changes", "issues", "agent"]);
    st().setRepoTab("tags");
    expect(tabs()).toEqual(["changes", "issues", "tags"]);
    const before = hist();
    st().setNavHiddenTabs([]);
    expect(hist()).toBe(before);
  });
});

/** The lens the registered reader reports per repository; unlisted = cannot tell. */
let lensOf: Record<string, RemoteLens | null> = {};
function readLenses(initial: Record<string, RemoteLens | null> = {}) {
  lensOf = { ...initial };
  registerNavLensReader((repoPath) => lensOf[repoPath] ?? null);
}

/** A Projects provider shaped like the panel's: it answers the opener card once as
 *  `itemId`, then the cursor's (none). */
function boardProvider() {
  const board = { opener: null as string | null };
  const read = vi.fn((): BoardAnchor => {
    const itemId = board.opener;
    board.opener = null;
    return { projectId: "P", viewId: "v1", itemId, showArchived: false };
  });
  registerNavAnchorProvider("projects", read);
  return { board, read };
}

const segmentTabs = () =>
  hist().segments.map((s) => [s.repoPath, s.lens, s.entries.map((e) => e.tab)]);

describe("carried hops", () => {
  it.each([
    [
      "openPr",
      () =>
        st().openPr({
          kind: "remote",
          repoPath: OTHER,
          repoName: "beta",
          ref: "7",
          section: null,
          carryHistory: true,
        }),
      "pulls",
    ],
    [
      "openIssue",
      () =>
        st().openIssue({
          repoPath: OTHER,
          repoName: "beta",
          number: 7,
          carryHistory: true,
        }),
      "issues",
    ],
    [
      "openRun",
      () =>
        st().openRun({
          repoPath: OTHER,
          repoName: "beta",
          runId: 7,
          carryHistory: true,
        }),
      "actions",
    ],
    [
      "openAgentTab",
      () =>
        st().openAgentTab({
          repoPath: OTHER,
          repoName: "beta",
          carryHistory: true,
        }),
      "agent",
    ],
    [
      "openRepoView",
      () =>
        st().openRepoView({
          repoPath: OTHER,
          repoName: "beta",
          tab: "tags",
          carryHistory: true,
        }),
      "tags",
    ],
  ] as const)(
    "a flagged cross-repo %s keeps the history as a second segment",
    (_n, land, tab) => {
      const check = watchInvariants();
      enterRepo();
      st().setRepoTab("issues");
      st().setRepoTab("history");
      useUiStore.setState({
        boardReturn: { anchor: anchor("p"), epoch: st().interactionEpoch },
      });
      land();
      expect(st().repoPath).toBe(OTHER);
      expect(segmentTabs()).toEqual([
        [REPO, null, ["changes", "issues", "history"]],
        [OTHER, null, [tab]],
      ]);
      expect(hist().segments[1].repoName).toBe("beta");
      expect(hist()).toMatchObject({ segment: 1, index: 0 });
      expect(canGoBack(st())).toBe(true);
      expect(canGoForward(st())).toBe(false);
      expect(st().boardReturn).toBeNull();
      // Back crosses the boundary: the departing repository, tab and trail return.
      const epoch = st().interactionEpoch;
      st().goBack();
      expect(st()).toMatchObject({
        repoPath: REPO,
        repoName: "alpha",
        repoTab: "history",
        interactionEpoch: epoch + 1,
        boardReturn: null,
      });
      expect(hist()).toMatchObject({ segment: 0, index: 2 });
      expect(canGoForward(st())).toBe(true);
      expect(check()).toEqual([]);
    },
  );

  it("cuts the departing segment after its current entry", () => {
    enterRepo();
    st().setRepoTab("issues");
    st().setRepoTab("history");
    st().goBack();
    st().openIssue({
      repoPath: OTHER,
      repoName: "beta",
      number: 2,
      carryHistory: true,
    });
    expect(segmentTabs()).toEqual([
      [REPO, null, ["changes", "issues"]],
      [OTHER, null, ["issues"]],
    ]);
  });

  it("records the departing selection as it was before beforeSelect cleared it", () => {
    enterRepo();
    st().setRepoTab("pulls");
    st().selectPr(pr(1));
    st().openIssue({
      repoPath: OTHER,
      repoName: "beta",
      number: 2,
      carryHistory: true,
      beforeSelect: () => st().clearRemoteSelections(),
    });
    expect(hist().segments[0].entries.at(-1)).toEqual({
      tab: "pulls",
      selection: { selectedPr: pr(1) },
      anchor: null,
    });
  });

  it.each([
    [
      "pulls",
      "selectedPr",
      () =>
        st().openPr({
          kind: "remote",
          repoPath: REPO,
          repoName: "alpha",
          ref: "12",
          section: null,
        }),
      pr(12),
    ],
    [
      "issues",
      "selectedIssue",
      () => st().openIssue({ repoPath: REPO, repoName: "alpha", number: 12 }),
      issue(12),
    ],
  ] as const)(
    "a carried hop whose beforeSelect clears the selection keeps the bare %s list behind it",
    (tab, key, jump, item) => {
      const check = watchInvariants();
      enterRepo();
      st().setRepoTab(tab);
      jump();
      expect(entries().map((e) => e.selection)).toEqual([
        { selectedFile: null },
        { [key]: null },
        { [key]: item },
      ]);
      st().openPr({
        kind: "remote",
        repoPath: OTHER,
        repoName: "beta",
        ref: "3",
        section: null,
        carryHistory: true,
        beforeSelect: () => st().clearRemoteSelections(),
      });
      expect(segmentTabs()).toEqual([
        [REPO, null, ["changes", tab, tab]],
        [OTHER, null, ["pulls"]],
      ]);
      st().goBack();
      expect(st()).toMatchObject({ repoPath: REPO, repoTab: tab, [key]: item });
      st().goBack();
      expect(st()).toMatchObject({ repoPath: REPO, repoTab: tab, [key]: null });
      expect(hist()).toMatchObject({ segment: 0, index: 1 });
      expect(check()).toEqual([]);
    },
  );

  it("a flagged same-repo landing whose beforeSelect flips the lens starts a segment", () => {
    readLenses({ [REPO]: "origin" });
    enterRepo();
    st().syncNavLens(REPO, "origin");
    st().setRepoTab("issues");
    st().selectIssue(issue(1));
    st().openPr({
      kind: "remote",
      repoPath: REPO,
      repoName: "alpha",
      ref: "2",
      section: null,
      carryHistory: true,
      beforeSelect: () => {
        lensOf[REPO] = "upstream";
        st().clearRemoteSelections();
      },
    });
    expect(segmentTabs()).toEqual([
      [REPO, "origin", ["changes", "issues"]],
      [REPO, "upstream", ["pulls"]],
    ]);
    expect(hist().segments[0].entries[1].selection).toEqual({
      selectedIssue: issue(1),
    });
    expect(hist()).toMatchObject({ segment: 1, index: 0 });
    // The lens sync then finds the new segment already in step.
    const before = hist();
    st().syncNavLens(REPO, "upstream");
    expect(hist()).toBe(before);
  });

  it("with no lens reader a flagged lens flip starts no segment", () => {
    enterRepo();
    st().setRepoTab("issues");
    st().openPr({
      kind: "remote",
      repoPath: REPO,
      repoName: "alpha",
      ref: "2",
      section: null,
      carryHistory: true,
      beforeSelect: () => st().clearRemoteSelections(),
    });
    expect(segmentTabs()).toEqual([
      [REPO, null, ["changes", "issues", "pulls"]],
    ]);
  });

  it("a flagged landing that changes neither repository nor lens records as unflagged", () => {
    readLenses({ [REPO]: "origin" });
    enterRepo();
    st().setRepoTab("issues");
    st().selectIssue(issue(1));
    st().openIssue({
      repoPath: REPO,
      repoName: "alpha",
      number: 2,
      carryHistory: true,
    });
    st().openAgentTab({
      repoPath: REPO,
      repoName: "alpha",
      carryHistory: true,
    });
    expect(segmentTabs()).toEqual([
      [REPO, null, ["changes", "issues", "issues", "agent"]],
    ]);
    expect(hist().index).toBe(3);
  });

  it("a landing Settings held keeps its flag when resumed", () => {
    enterRepo();
    st().setRepoTab("issues");
    st().openSettings();
    const held: { resume?: () => void } = {};
    st().setSettingsLeaveGuard((resume) => {
      held.resume = resume;
    });
    st().openIssue({
      repoPath: OTHER,
      repoName: "beta",
      number: 2,
      carryHistory: true,
    });
    expect(st().view).toBe("settings");
    st().setSettingsLeaveGuard(null);
    held.resume?.();
    expect(st().repoPath).toBe(OTHER);
    expect(segmentTabs()).toEqual([
      [REPO, null, ["changes", "issues"]],
      [OTHER, null, ["issues"]],
    ]);
  });

  it("an outer landing records its own departure, not a nested navigator's", () => {
    readLenses({ [REPO]: "origin" });
    enterRepo();
    st().setRepoTab("pulls");
    st().selectPr(pr(7));
    st().openIssue({
      repoPath: OTHER,
      repoName: "beta",
      number: 3,
      carryHistory: true,
      beforeSelect: () => {
        lensOf[REPO] = "upstream";
        st().clearRemoteSelections();
        st().openPr({
          kind: "remote",
          repoPath: REPO,
          repoName: "alpha",
          ref: "9",
          section: null,
        });
      },
    });
    // The trail as shown before beforeSelect: its clear and the nested landing never
    // painted, so neither leaves a stop of its own.
    const [departed] = hist().segments;
    expect(departed.lens).toBe("origin");
    expect(departed.entries.map((e) => e.selection)).toEqual([
      { selectedFile: null },
      { selectedPr: pr(7) },
    ]);
    expect(currentSegment(hist())?.repoPath).toBe(OTHER);
  });

  it("the null-stamp window: a fork hop away from a live upstream starts a segment", () => {
    readLenses({ [REPO]: "upstream" });
    enterRepo();
    st().setRepoTab("issues");
    st().setRepoTab("pulls");
    st().selectPr(pr(1));
    expect(lens()).toBeNull();
    st().openPr({
      kind: "remote",
      repoPath: REPO,
      repoName: "alpha",
      ref: "2",
      section: null,
      carryHistory: true,
      beforeSelect: () => {
        lensOf[REPO] = "origin";
        st().clearRemoteSelections();
      },
    });
    expect(hist()).toEqual({
      segments: [
        {
          repoPath: REPO,
          repoName: "alpha",
          lens: "upstream",
          entries: [
            { tab: "pulls", selection: { selectedPr: pr(1) }, anchor: null },
          ],
        },
        {
          repoPath: REPO,
          repoName: "alpha",
          lens: "origin",
          entries: [
            { tab: "pulls", selection: { selectedPr: pr(2) }, anchor: null },
          ],
        },
      ],
      segment: 1,
      index: 0,
    });
    // Back re-applies the departing lens and lands on the departing stop, with no
    // validation: the repository is the open one.
    const validate = vi.fn(async () => true);
    const applyLens = vi.fn((repoPath: string, l: RemoteLens) => {
      lensOf[repoPath] = l;
      st().clearRemoteSelections();
    });
    st().goBack({ validate, applyLens });
    expect(validate).not.toHaveBeenCalled();
    expect(applyLens).toHaveBeenCalledExactlyOnceWith(REPO, "upstream");
    expect(st()).toMatchObject({ repoTab: "pulls", selectedPr: pr(1) });
    expect(hist()).toMatchObject({ segment: 0, index: 0 });
  });
});

const GAMMA = "C:/repos/gamma";

/** A carried issue landing in `repoPath`, named after its folder. */
const carriedIssue = (
  repoPath: string,
  number: number,
  beforeSelect?: () => void,
) =>
  st().openIssue({
    repoPath,
    repoName: repoPath.split("/").pop() ?? repoPath,
    number,
    carryHistory: true,
    beforeSelect,
  });

/** A `validate` whose answers are given by hand, every pending call at once. */
function deferredValidate() {
  const pending: ((ok: boolean) => void)[] = [];
  const validate = vi.fn(
    (_target: unknown) =>
      new Promise<boolean>((resolve) => {
        pending.push(resolve);
      }),
  );
  const answer = (ok: boolean) => {
    for (const resolve of pending.splice(0)) resolve(ok);
  };
  return { validate, answer };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("cross-segment restore", () => {
  it("Back and Forward land the other repository's stop, the board return on Projects", () => {
    const check = watchInvariants();
    enterRepo();
    const { board, read } = boardProvider();
    st().setRepoTab("projects");
    carriedIssue(OTHER, 2, () => {
      board.opener = "card-9";
    });
    const landed = { tab: st().repoTab, issue: st().selectedIssue };
    const applyLens = vi.fn();
    read.mockClear();
    const epoch = st().interactionEpoch;
    st().goBack({ applyLens });
    expect(st()).toMatchObject({
      repoPath: REPO,
      repoName: "alpha",
      repoTab: "projects",
      interactionEpoch: epoch + 1,
      boardReturn: {
        anchor: { projectId: "P", itemId: "card-9" },
        epoch: epoch + 1,
      },
    });
    expect(read).not.toHaveBeenCalled();
    st().goForward({ applyLens });
    expect(st()).toMatchObject({
      repoPath: OTHER,
      repoName: "beta",
      repoTab: landed.tab,
      selectedIssue: landed.issue,
      boardReturn: null,
    });
    // The departing Projects stop read its anchor once, at the landing.
    expect(read).toHaveBeenCalledTimes(1);
    expect(applyLens).not.toHaveBeenCalled();
    expect(hist()).toMatchObject({ segment: 1, index: 0 });
    expect(check()).toEqual([]);
  });

  it("applies the target's lens inside the landing, ahead of the set that restores its selection", () => {
    readLenses({ [REPO]: "upstream", [OTHER]: "origin" });
    enterRepo();
    st().setRepoTab("pulls");
    st().selectPr(pr(1));
    carriedIssue(OTHER, 2, () => st().clearRemoteSelections());
    expect(hist().segments.map((s) => s.lens)).toEqual(["upstream", "origin"]);
    const calls: unknown[] = [];
    const applyLens = vi.fn((repoPath: string, l: RemoteLens) => {
      calls.push([repoPath, l, st().repoPath]);
      lensOf[repoPath] = l;
      st().clearRemoteSelections();
    });
    const epoch = st().interactionEpoch;
    st().goBack({ applyLens });
    expect(calls).toEqual([[REPO, "upstream", OTHER]]);
    expect(st()).toMatchObject({
      repoPath: REPO,
      repoTab: "pulls",
      selectedPr: pr(1),
      interactionEpoch: epoch + 1,
    });
    st().goForward({ applyLens });
    expect(calls.at(-1)).toEqual([OTHER, "origin", REPO]);
    expect(st()).toMatchObject({ repoPath: OTHER, selectedIssue: issue(2) });
    // The departing stop was recorded before the lens apply cleared its selection.
    st().goBack({ applyLens });
    expect(st()).toMatchObject({ repoPath: REPO, selectedPr: pr(1) });
  });

  it("stamps the board return with the press's own epoch, both true at the set", async () => {
    enterRepo();
    const { board, read } = boardProvider();
    st().setRepoTab("projects");
    carriedIssue(OTHER, 2, () => {
      board.opener = "card-9";
    });
    const { validate, answer } = deferredValidate();
    const seen: unknown[] = [];
    const stop = useUiStore.subscribe((s, prev) => {
      if (s.boardReturn && s.boardReturn !== prev.boardReturn)
        seen.push([s.interactionEpoch, s.boardReturn.epoch, s.repoPath]);
    });
    st().goBack({ validate });
    const pressed = st().interactionEpoch;
    expect(validate).toHaveBeenCalledExactlyOnceWith({
      repoPath: REPO,
      repoName: "alpha",
      lens: null,
    });
    expect(st().repoPath).toBe(OTHER);
    answer(true);
    await flush();
    stop();
    expect(seen).toEqual([[pressed, pressed, REPO]]);
    expect(st().interactionEpoch).toBe(pressed);
    // Forward from Projects reads the departing anchor at the landing, not the press.
    read.mockClear();
    st().goForward({ validate });
    expect(read).not.toHaveBeenCalled();
    answer(true);
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(st().repoPath).toBe(OTHER);
  });

  it("a dead target loses every stop of its repository, behind and ahead, in one non-bumping set", async () => {
    const check = watchInvariants();
    readLenses({ [OTHER]: "origin" });
    enterRepo();
    carriedIssue(OTHER, 1);
    carriedIssue(REPO, 2);
    lensOf[OTHER] = "upstream";
    carriedIssue(OTHER, 3);
    carriedIssue(REPO, 4);
    st().goBack();
    st().goBack();
    expect(hist().segments.map((s) => [s.repoPath, s.lens])).toEqual([
      [REPO, null],
      [OTHER, "origin"],
      [REPO, null],
      [OTHER, "upstream"],
      [REPO, null],
    ]);
    expect(hist().segment).toBe(2);
    const { validate, answer } = deferredValidate();
    const onDead = vi.fn();
    st().goBack({ validate, onDead });
    const pressed = st();
    const n = countNotifications();
    answer(false);
    await flush();
    n.stop();
    expect(n.count).toBe(1);
    expect(onDead).toHaveBeenCalledExactlyOnceWith(
      { repoPath: OTHER, repoName: "beta", lens: "origin" },
      -1,
    );
    expect(st()).toMatchObject({
      repoPath: REPO,
      repoTab: pressed.repoTab,
      selectedIssue: pressed.selectedIssue,
      boardReturn: pressed.boardReturn,
      interactionEpoch: pressed.interactionEpoch,
    });
    expect(segmentTabs()).toEqual([
      [REPO, null, ["changes", "issues", "issues"]],
    ]);
    expect(hist()).toMatchObject({ segment: 0, index: 1 });
    expect(current().selection).toEqual({ selectedIssue: issue(2) });
    // The next Back is a plain step inside the merged segment.
    validate.mockClear();
    st().goBack({ validate, onDead });
    expect(validate).not.toHaveBeenCalled();
    expect(st().repoTab).toBe("changes");
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(check()).toEqual([]);
  });

  it("a dead target on Forward removes its repository's stops behind as well", async () => {
    enterRepo();
    carriedIssue(OTHER, 1);
    carriedIssue(REPO, 2);
    carriedIssue(OTHER, 3);
    st().goBack();
    const { validate, answer } = deferredValidate();
    const onDead = vi.fn();
    st().goForward({ validate, onDead });
    answer(false);
    await flush();
    expect(onDead).toHaveBeenCalledExactlyOnceWith(
      { repoPath: OTHER, repoName: "beta", lens: null },
      1,
    );
    expect(segmentTabs()).toEqual([[REPO, null, ["changes", "issues"]]]);
    expect(st()).toMatchObject({ repoPath: REPO, repoTab: "issues" });
    expect(canGoForward(st())).toBe(false);
  });

  it("a press retired while it validates lands nothing, removes nothing and calls nothing", async () => {
    enterRepo();
    carriedIssue(OTHER, 1);
    const { validate, answer } = deferredValidate();
    const onDead = vi.fn();
    const applyLens = vi.fn();
    st().goBack({ validate, onDead, applyLens });
    st().setRepoTab("history");
    const after = st();
    answer(false);
    await flush();
    expect(onDead).not.toHaveBeenCalled();
    expect(st()).toBe(after);
    // A plain step back to the boundary, then a crossing a tab change retires.
    st().goBack();
    st().goBack({ validate, onDead, applyLens });
    st().setRepoTab("tags");
    answer(true);
    await flush();
    expect(st()).toMatchObject({ repoPath: OTHER, repoTab: "tags" });
    // Retired even when the step it named is back in place by the settle: an
    // overlay opened and closed, or a selection rewritten in place.
    st().goBack();
    st().goBack({ validate });
    st().openMyWork();
    st().closeMyWork();
    answer(true);
    await flush();
    expect(st().repoPath).toBe(OTHER);
    st().goBack({ validate });
    st().selectIssue(issue(9));
    answer(true);
    await flush();
    expect(st()).toMatchObject({ repoPath: OTHER, selectedIssue: issue(9) });
  });

  it("a second Back while one validates supersedes it: one step", async () => {
    enterRepo();
    st().setRepoTab("issues");
    st().setRepoTab("history");
    carriedIssue(OTHER, 1);
    // One resolver per request, so the older press's answer can come first.
    const answers: ((ok: boolean) => void)[] = [];
    const validate = vi.fn(
      (_target: unknown) =>
        new Promise<boolean>((resolve) => {
          answers.push(resolve);
        }),
    );
    const onDead = vi.fn();
    st().goBack({ validate, onDead });
    st().goBack({ validate, onDead });
    expect(validate).toHaveBeenCalledTimes(2);
    const [older, newer] = answers;
    const pressed = st();
    // The retired press's dead answer drops no repository and reports nothing.
    older(false);
    await flush();
    expect(onDead).not.toHaveBeenCalled();
    expect(st()).toBe(pressed);
    expect(segmentTabs()).toEqual([
      [REPO, null, ["changes", "issues", "history"]],
      [OTHER, null, ["issues"]],
    ]);
    const n = countNotifications();
    newer(true);
    await flush();
    n.stop();
    expect(n.count).toBe(1);
    expect(st()).toMatchObject({ repoPath: REPO, repoTab: "history" });
    expect(hist()).toMatchObject({ segment: 0, index: 2 });
    expect(onDead).not.toHaveBeenCalled();
  });

  it("a prune while it validates that removes the target lands nothing", async () => {
    enterRepo();
    st().openAgentTab({
      repoPath: OTHER,
      repoName: "beta",
      carryHistory: true,
    });
    carriedIssue(REPO, 2);
    expect(segmentTabs()).toEqual([
      [REPO, null, ["changes"]],
      [OTHER, null, ["agent"]],
      [REPO, null, ["issues"]],
    ]);
    const { validate, answer } = deferredValidate();
    const onDead = vi.fn();
    st().goBack({ validate, onDead });
    st().setNavHiddenTabs(["agent"]);
    expect(segmentTabs()).toEqual([[REPO, null, ["changes", "issues"]]]);
    answer(false);
    await flush();
    expect(onDead).not.toHaveBeenCalled();
    expect(st()).toMatchObject({ repoPath: REPO, repoTab: "issues" });
    expect(hist()).toMatchObject({ segment: 0, index: 1 });
  });

  it("validates each other repository in its turn", async () => {
    enterRepo();
    carriedIssue(OTHER, 1);
    carriedIssue(GAMMA, 2);
    const { validate, answer } = deferredValidate();
    st().goBack({ validate });
    answer(true);
    await flush();
    expect(st().repoPath).toBe(OTHER);
    st().goBack({ validate });
    expect(validate).toHaveBeenLastCalledWith({
      repoPath: REPO,
      repoName: "alpha",
      lens: null,
    });
    answer(true);
    await flush();
    expect(st().repoPath).toBe(REPO);
    expect(validate).toHaveBeenCalledTimes(2);
  });
});

describe("carried hops read the board's anchor once, at the landing set", () => {
  it("a cross-repo hop from Projects stores the opener set in beforeSelect", () => {
    enterRepo();
    const { board, read } = boardProvider();
    st().setRepoTab("projects");
    read.mockClear();
    st().openIssue({
      repoPath: OTHER,
      repoName: "beta",
      number: 2,
      carryHistory: true,
      beforeSelect: () => {
        board.opener = "card-9";
      },
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(hist().segments[0].entries.at(-1)?.anchor?.itemId).toBe("card-9");
    expect(hist().segments).toHaveLength(2);
  });

  it("a fork hop from Projects stores the opener and splits on the lens", () => {
    readLenses({ [REPO]: "origin" });
    enterRepo();
    const { board, read } = boardProvider();
    st().setRepoTab("projects");
    read.mockClear();
    st().openIssue({
      repoPath: REPO,
      repoName: "alpha",
      number: 5,
      carryHistory: true,
      beforeSelect: () => {
        board.opener = "card-9";
        lensOf[REPO] = "upstream";
        st().clearRemoteSelections();
      },
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(segmentTabs()).toEqual([
      [REPO, "origin", ["changes", "projects"]],
      [REPO, "upstream", ["issues"]],
    ]);
    expect(hist().segments[0].entries[1].anchor?.itemId).toBe("card-9");
  });

  it("an opener set before the navigator call is still read once, at the landing", () => {
    enterRepo();
    const { board, read } = boardProvider();
    st().setRepoTab("projects");
    read.mockClear();
    board.opener = "card-9";
    st().openIssue({
      repoPath: OTHER,
      repoName: "beta",
      number: 2,
      carryHistory: true,
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(hist().segments[0].entries.at(-1)?.anchor?.itemId).toBe("card-9");
  });

  it("a hop made under an overlay keeps the stored anchor and reads no provider", () => {
    enterRepo();
    const { board, read } = boardProvider();
    st().setRepoTab("projects");
    st().openMyWork();
    const stored = currentSegment(hist())?.entries.at(-1)?.anchor;
    expect(stored?.itemId).toBeNull();
    read.mockClear();
    st().openIssue({
      repoPath: OTHER,
      repoName: "beta",
      number: 2,
      carryHistory: true,
      beforeSelect: () => {
        board.opener = "card-9";
      },
    });
    expect(read).not.toHaveBeenCalled();
    expect(st().view).toBe("repo");
    expect(hist().segments[0].entries.at(-1)?.anchor).toEqual(stored);
    expect(hist().segments).toHaveLength(2);
  });

  it("a flagged landing that starts no segment reads as today", () => {
    enterRepo();
    const { read } = boardProvider();
    st().setRepoTab("projects");
    read.mockClear();
    st().openIssue({
      repoPath: REPO,
      repoName: "alpha",
      number: 1,
      carryHistory: true,
    });
    expect(read).toHaveBeenCalledTimes(1);
    read.mockClear();
    st().openIssue({
      repoPath: REPO,
      repoName: "alpha",
      number: 2,
      carryHistory: true,
    });
    expect(read).not.toHaveBeenCalled();
    expect(hist().segments).toHaveLength(1);
  });
});

// Registers a warm-up, which is module state with no reset: keep this describe LAST.
describe("held carried landings", () => {
  const gates: (() => void)[] = [];
  const settle = async () => {
    for (const open of gates.splice(0)) open();
    await new Promise((r) => setTimeout(r, 0));
  };

  it("build from the state, reader and history at the landing, not the request", async () => {
    registerRepoShellWarmup(() => ({
      settled: new Promise<void>((r) => gates.push(r)),
      stillCurrent: () => true,
    }));
    readLenses({ [REPO]: "origin" });
    enterRepo();
    st().setRepoTab("pulls");
    st().selectPr(pr(1));
    st().openIssue({
      repoPath: OTHER,
      repoName: "beta",
      number: 2,
      carryHistory: true,
      beforeSelect: () => st().clearRemoteSelections(),
    });
    expect(st().repoPath).toBe(REPO);
    st().selectPr(pr(2));
    lensOf[OTHER] = "upstream";
    await settle();
    expect(st().repoPath).toBe(OTHER);
    expect(segmentTabs()).toEqual([
      [REPO, "origin", ["changes", "pulls"]],
      [OTHER, "upstream", ["issues"]],
    ]);
    expect(hist().segments[0].entries[1].selection).toEqual({
      selectedPr: pr(2),
    });
    // An unflagged held landing over that history starts it over.
    st().openRun({ repoPath: "C:/repos/gamma", repoName: "gamma", runId: 1 });
    await settle();
    expect(segmentTabs()).toEqual([["C:/repos/gamma", null, ["actions"]]]);
  });
});

// Registers its own warm-up per case; after the describe above for the same reason.
describe("held cross-repository restores", () => {
  const gates: (() => void)[] = [];
  let live = true;
  const claimedAt: number[] = [];
  const claim = vi.fn((_root: string) => {
    claimedAt.push(st().interactionEpoch);
    return {
      settled: new Promise<void>((r) => gates.push(r)),
      stillCurrent: () => live,
    };
  });
  const openGates = async () => {
    for (const open of gates.splice(0)) open();
    await flush();
  };
  beforeEach(() => {
    live = true;
    claimedAt.length = 0;
    claim.mockClear();
    registerRepoShellWarmup(claim);
  });

  it("claim after the press's bump and land once both the warm-up and validation settled", async () => {
    enterRepo();
    st().setRepoTab("history");
    carriedIssue(OTHER, 1);
    await openGates();
    expect(st().repoPath).toBe(OTHER);
    claim.mockClear();
    const validate = vi.fn(async () => true);
    st().goBack({ validate });
    expect(claim).toHaveBeenCalledExactlyOnceWith(REPO);
    expect(claimedAt.at(-1)).toBe(st().interactionEpoch);
    await flush();
    expect(validate).toHaveBeenCalledTimes(1);
    expect(st().repoPath).toBe(OTHER);
    await openGates();
    expect(st()).toMatchObject({ repoPath: REPO, repoTab: "history" });
  });

  it("a warm-up that is no longer current lands nothing and removes nothing", async () => {
    enterRepo();
    carriedIssue(OTHER, 1);
    await openGates();
    const onDead = vi.fn();
    st().goBack({ validate: async () => false, onDead });
    live = false;
    const before = st();
    await openGates();
    expect(onDead).not.toHaveBeenCalled();
    expect(st()).toBe(before);
    expect(hist().segments).toHaveLength(2);
  });

  it("validation slower than the warm-up holds the landing until it answers dead", async () => {
    enterRepo();
    carriedIssue(OTHER, 1);
    await openGates();
    const { validate, answer } = deferredValidate();
    const onDead = vi.fn();
    st().goBack({ validate, onDead });
    const pressed = st();
    await openGates();
    expect(st()).toBe(pressed);
    const n = countNotifications();
    answer(false);
    await flush();
    n.stop();
    expect(n.count).toBe(1);
    expect(onDead).toHaveBeenCalledExactlyOnceWith(
      { repoPath: REPO, repoName: "alpha", lens: null },
      -1,
    );
    expect(segmentTabs()).toEqual([[OTHER, null, ["issues"]]]);
    expect(st().repoPath).toBe(OTHER);
  });

  it("validation slower than the warm-up lands once it answers live", async () => {
    enterRepo();
    st().setRepoTab("history");
    carriedIssue(OTHER, 1);
    await openGates();
    const { validate, answer } = deferredValidate();
    st().goBack({ validate });
    const pressed = st();
    await openGates();
    expect(st()).toBe(pressed);
    answer(true);
    await flush();
    expect(st()).toMatchObject({ repoPath: REPO, repoTab: "history" });
    expect(hist()).toMatchObject({ segment: 0, index: 1 });
  });

  it("a same-repository crossing claims no warm-up and validates nothing", () => {
    readLenses({ [REPO]: "origin" });
    enterRepo();
    st().openIssue({
      repoPath: REPO,
      repoName: "alpha",
      number: 2,
      carryHistory: true,
      beforeSelect: () => {
        lensOf[REPO] = "upstream";
      },
    });
    expect(hist().segments).toHaveLength(2);
    claim.mockClear();
    const validate = vi.fn(async () => true);
    st().goBack({ validate });
    expect(claim).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    expect(st()).toMatchObject({ repoPath: REPO, repoTab: "changes" });
    expect(hist()).toMatchObject({ segment: 0, index: 0 });
  });
});
