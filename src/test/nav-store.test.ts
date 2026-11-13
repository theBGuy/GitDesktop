import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetNavHistoryForTests,
  type BoardAnchor,
  canGoBack,
  canGoForward,
  NAV_HISTORY_CAP,
  NAV_SELECTION_FIELDS,
  type NavEntry,
  readNavAnchor,
  registerNavAnchorProvider,
  restoreStep,
  sameLocation,
  selectionOf,
} from "@/lib/stores/nav-history";
import { type RepoTab, type UiState, useUiStore } from "@/lib/stores/ui";

// The store wiring: the recorder's subscribe, goBack/goForward, the three
// non-bumping writers and the navigator hop marks, driven through useUiStore.
// jsdom has no View Transitions API, so every navigator applies synchronously.

const REPO = "C:/repos/alpha";
const OTHER = "C:/repos/beta";

const st = () => useUiStore.getState();
const hist = () => st().navHistory;
const tabs = () => hist().entries.map((e) => e.tab);
const current = (): NavEntry => hist().entries[hist().index];

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

/** The history invariants (no two adjacent equal locations, no non-current entry on a
 *  hidden tab, the cap with `index` on an entry) and "canGo* true exactly when a press
 *  changes location", checked after
 *  every store change until the returned function runs. */
function watchInvariants(): () => string[] {
  const problems: string[] = [];
  const unsubscribe = useUiStore.subscribe((s) => {
    const { entries, index } = s.navHistory;
    if (s.view !== "repo") return;
    if (entries.length > NAV_HISTORY_CAP) problems.push("over the cap");
    if (entries.length > 0 && (index < 0 || index >= entries.length))
      problems.push(`index ${index} names no entry`);
    entries.forEach((e, i) => {
      if (i > 0 && sameLocation(entries[i - 1], e))
        problems.push(`entries ${i - 1} and ${i} are one location`);
      if (i !== index && s.navHiddenTabs.includes(e.tab))
        problems.push(`entry ${i} is on hidden tab ${e.tab}`);
    });
    const here = { tab: s.repoTab, selection: selectionOf(s.repoTab, s) };
    const back = entries[index - 1];
    const fwd = entries[index + 1];
    if (canGoBack(s) !== (back !== undefined && !sameLocation(back, here)))
      problems.push("canGoBack disagrees with the trail");
    if (canGoForward(s) !== (fwd !== undefined && !sameLocation(fwd, here)))
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
      entries: [
        { tab: "changes", selection: { selectedFile: null }, anchor: null },
      ],
      index: 0,
      lens: null,
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
    expect(hist().entries).toEqual([]);
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
      expect(tabs()).toEqual([tab]);
      expect(hist().index).toBe(0);
      expect(hist().lens).toBeNull();
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
    expect(hist().entries.map((e) => e.selection)).toEqual([
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
    expect(hist().entries[3].selection).toEqual({ selectedPr: pr(4) });
    st().goBack();
    expect(st().selectedIssue).toEqual(issue(1));
    st().goForward();
    st().goForward();
    expect(st().repoTab).toBe("pulls");
    expect(st().selectedPr).toEqual(pr(4));
    expect(hist().entries).toHaveLength(4);
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
    expect(hist().entries).toHaveLength(NAV_HISTORY_CAP);
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
    expect(hist().entries[1].anchor).toEqual(anchor("A"));
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
    expect(hist().entries[1].anchor).toEqual(anchor("B"));
    unregisterB();
    st().goBack();
    expect(hist().entries[1].anchor).toEqual(anchor("B"));
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
    expect(hist().entries[1].anchor).toBeNull();
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
    expect(hist().entries.map((e) => e.selection)).toEqual([
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
      entries: [
        { tab: "pulls", selection: { selectedPr: pr(2) }, anchor: null },
      ],
      index: 0,
      lens: "upstream",
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
    expect(hist().entries).toBe(before.entries);
    expect(hist().index).toBe(2);
    expect(hist().lens).toBe("origin");
    expect(st().boardReturn).not.toBeNull();
    expect(st().interactionEpoch).toBe(epoch);
  });

  it("re-seeds a null stamp against upstream and nulls the board return", () => {
    several();
    const epoch = st().interactionEpoch;
    st().syncNavLens(REPO, "upstream");
    expect(hist()).toEqual({
      entries: [
        { tab: "tags", selection: { selectedTag: null }, anchor: null },
      ],
      index: 0,
      lens: "upstream",
    });
    expect(st().boardReturn).toBeNull();
    expect(st().interactionEpoch).toBe(epoch);
  });

  it("re-seeds on a flip of a real stamp and nulls the board return", () => {
    several();
    st().syncNavLens(REPO, "origin");
    st().syncNavLens(REPO, "upstream");
    expect(tabs()).toEqual(["tags"]);
    expect(hist().lens).toBe("upstream");
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
    expect(hist().lens).toBeNull();
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
    expect(hist().entries).toHaveLength(1);
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
    expect(hist().entries).toHaveLength(1);
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
    expect(hist().entries).toHaveLength(1);
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
    expect(hist().entries.length).toBeLessThanOrEqual(NAV_HISTORY_CAP);
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
    expect(hist().entries[1].anchor).toEqual(anchor("B"));
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
