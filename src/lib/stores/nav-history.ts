import type { RemoteLens } from "@/lib/git/types";
import type { RepoTab, UiState } from "@/lib/stores/ui";

// Pure rules of the in-repo Back/Forward history. Imports from ui.ts are type-only so
// ui.ts can import this module at runtime without a cycle.

export type NavSelectionKey =
  | "selectedFile"
  | "selectedCommitHash"
  | "compareBranch"
  | "compareCommitHash"
  | "selectedPr"
  | "selectedIssue"
  | "selectedDiscussion"
  | "selectedRunId"
  | "selectedFinding"
  | "selectedTag"
  | "selectedTodo";

/** Total over RepoTab: a new tab stops compiling until it is classified. */
export const NAV_SELECTION_FIELDS: Record<RepoTab, readonly NavSelectionKey[]> =
  {
    changes: ["selectedFile"],
    history: ["selectedCommitHash"],
    compare: ["compareBranch", "compareCommitHash"],
    pulls: ["selectedPr"],
    issues: ["selectedIssue"],
    projects: [],
    discussions: ["selectedDiscussion"],
    actions: ["selectedRunId"],
    findings: ["selectedFinding"],
    tags: ["selectedTag"],
    insights: [],
    "code-todos": ["selectedTodo"],
    tasks: [],
    agent: [],
  };

export type NavSelection = Partial<Pick<UiState, NavSelectionKey>>;

/** Where on the Projects tab the user was. `itemId` is the card that opened the item, or
 *  the cursor's card for any other departure; null when the cursor addressed no card. */
export interface BoardAnchor {
  projectId: string;
  viewId: string | null;
  itemId: string | null;
  /** The board's Show archived cards state: it decides whether `itemId` is drawn. */
  showArchived: boolean;
}

export interface NavEntry {
  tab: RepoTab;
  /** Exactly the keys NAV_SELECTION_FIELDS[tab] lists, each present (null when unset). */
  selection: NavSelection;
  anchor: BoardAnchor | null;
}

export interface NavHistory {
  entries: readonly NavEntry[];
  /** The current entry; -1 only while `entries` is empty. */
  index: number;
  /** The lens the entries were recorded under; null until the lens reads answered. */
  lens: RemoteLens | null;
}

export const EMPTY_NAV_HISTORY: NavHistory = {
  entries: [],
  index: -1,
  lens: null,
};
export const NAV_HISTORY_CAP = 50;
/** What the lens reads serve before they answer; a null stamp stands for it. */
export const PROVISIONAL_NAV_LENS: RemoteLens = "origin";

export interface BoardReturnRequest {
  anchor: BoardAnchor;
  /** The interactionEpoch the restore's own bump produced. */
  epoch: number;
}

type NavState = Pick<
  UiState,
  | "view"
  | "repoPath"
  | "repoTab"
  | NavSelectionKey
  | "navHistory"
  | "navHiddenTabs"
>;
type NavLocation = Pick<NavEntry, "tab" | "selection">;
type AnchorReader = (tab: RepoTab) => BoardAnchor | null | undefined;

function pickSelection(tab: RepoTab, source: NavSelection): NavSelection {
  const out: NavSelection = {};
  for (const key of NAV_SELECTION_FIELDS[tab]) {
    Object.assign(out, { [key]: source[key] ?? null });
  }
  return out;
}

export function selectionOf(
  tab: RepoTab,
  s: Pick<UiState, NavSelectionKey>,
): NavSelection {
  return pickSelection(tab, s);
}

/** `Object.is`, or two flat objects whose own keys are `Object.is`-equal: the selection
 *  values are primitives or one-level records, and a select writes a fresh object. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return false;
  }
  const aKeys = Object.keys(a);
  return (
    aKeys.length === Object.keys(b).length &&
    aKeys.every(
      (k) =>
        Object.hasOwn(b, k) &&
        Object.is(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        ),
    )
  );
}

/** Equal tabs and equal listed keys. The anchor is not part of a location. */
export function sameLocation(a: NavLocation, b: NavLocation): boolean {
  return (
    a.tab === b.tab &&
    NAV_SELECTION_FIELDS[a.tab].every((key) =>
      sameValue(a.selection[key] ?? null, b.selection[key] ?? null),
    )
  );
}

/** Index-based, and truthful because every returned history keeps I1 and I2. */
export function canGoBack(s: Pick<NavState, "view" | "navHistory">): boolean {
  return s.view === "repo" && s.navHistory.index > 0;
}

export function canGoForward(
  s: Pick<NavState, "view" | "navHistory">,
): boolean {
  const { index, entries } = s.navHistory;
  return s.view === "repo" && index >= 0 && index < entries.length - 1;
}

/** The ONE place the invariants are enforced: I1 no two adjacent equal locations, I2 no
 *  non-current entry on a hidden tab, I3 at most NAV_HISTORY_CAP entries with `index` on
 *  the current one. Only drops entries, and returns `history` itself when none drop. */
function normalize(
  history: NavHistory,
  hidden: readonly RepoTab[],
): NavHistory {
  const { entries, index, lens } = history;
  if (index < 0) return history;
  const kept: NavEntry[] = [];
  let at = -1;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const current = i === index;
    if (!current && hidden.includes(entry.tab)) continue;
    const last = kept.length - 1;
    if (last >= 0 && sameLocation(kept[last], entry)) {
      // Keep the current one of the pair; when neither is, the later survives.
      if (at === last) continue;
      kept[last] = entry;
      if (current) at = last;
      continue;
    }
    kept.push(entry);
    if (current) at = last + 1;
  }
  // Eviction is oldest-first; only an over-cap history whose current entry sits that
  // far back (never produced here) trims forward entries instead of the current one.
  const start = Math.min(Math.max(0, kept.length - NAV_HISTORY_CAP), at);
  const capped = kept.slice(start, start + NAV_HISTORY_CAP);
  if (capped.length === entries.length) return history;
  return { entries: capped, index: at - start, lens };
}

/** The departing entry rewritten from live state, keeping its own anchor when the
 *  provider answers `undefined` (none registered). */
function departingEntry(
  entry: NavEntry,
  live: Pick<UiState, NavSelectionKey>,
  anchorFor: AnchorReader,
): NavEntry {
  const answer = anchorFor(entry.tab);
  return {
    tab: entry.tab,
    selection: selectionOf(entry.tab, live),
    anchor: answer === undefined ? entry.anchor : answer,
  };
}

/** The history with the current entry's anchor re-read as the same repo's view leaves
 *  for an overlay. `next.navHistory` itself when the provider has nothing new, and,
 *  unread, when the repo changed or closed, the history is empty or was rewritten. */
function anchorOnLeave(
  next: NavState,
  prev: NavState,
  anchorFor: AnchorReader,
): NavHistory {
  const history = next.navHistory;
  if (
    next.repoPath === null ||
    next.repoPath !== prev.repoPath ||
    history.index < 0 ||
    history !== prev.navHistory
  ) {
    return history;
  }
  const current = history.entries[history.index];
  const answer = anchorFor(current.tab);
  if (answer === undefined || sameValue(answer, current.anchor)) return history;
  const entries = [...history.entries];
  entries[history.index] = { ...current, anchor: answer };
  return normalize(
    { entries, index: history.index, lens: history.lens },
    next.navHiddenTabs,
  );
}

/** The history after observing one committed store change; returns `next.navHistory`
 *  itself (same identity) when there is nothing to write. */
export function recordNavigation(
  next: NavState,
  prev: NavState,
  hop: boolean,
  anchorFor: AnchorReader,
): NavHistory {
  const history = next.navHistory;
  // N1: overlays neither push nor clear, and nothing written under one is recorded. The
  // change that leaves the repo view only stores the current tab's anchor first, since
  // the panel that answers for it unmounts under the overlay.
  if (next.view !== "repo" || next.repoPath === null) {
    return prev.view === "repo"
      ? anchorOnLeave(next, prev, anchorFor)
      : history;
  }
  // N2: a repo switch or an empty history starts over at the landing.
  if (next.repoPath !== prev.repoPath || history.index === -1) {
    return seedHistory(next);
  }
  // N3: a history-aware writer (restore, lens sync, prune) authored this change.
  if (history !== prev.navHistory) return history;
  const { entries, index, lens } = history;
  const current = entries[index];
  const tab = next.repoTab;
  const arrival: NavEntry = {
    tab,
    selection: selectionOf(tab, next),
    anchor: null,
  };
  // N4: a tab change pushes, whatever wrote it.
  if (tab !== current.tab) {
    return normalize(
      {
        entries: [
          ...entries.slice(0, index),
          departingEntry(current, prev, anchorFor),
          arrival,
        ],
        index: index + 1,
        lens,
      },
      next.navHiddenTabs,
    );
  }
  // N5: a duplicate location never pushes, hop or not.
  if (sameLocation(current, arrival)) return history;
  // N6: a link hop pushes.
  if (hop) {
    return normalize(
      {
        entries: [...entries.slice(0, index + 1), arrival],
        index: index + 1,
        lens,
      },
      next.navHiddenTabs,
    );
  }
  // N7: list browsing, deselects and prunes rewrite the current entry in place.
  const rewritten = [...entries];
  rewritten[index] = { ...current, selection: arrival.selection };
  return normalize({ entries: rewritten, index, lens }, next.navHiddenTabs);
}

/** The history and location patch for one Back (-1) or Forward (+1) step, or null when
 *  that direction is empty. Never contains a `view` key. Calls `anchorFor` only after
 *  the direction check passed: a provider read spends the board's opener. */
export function restoreStep(
  s: NavState,
  delta: -1 | 1,
  anchorFor: AnchorReader,
): {
  navHistory: NavHistory;
  patch: Partial<UiState>;
  anchor: BoardAnchor | null;
} | null {
  const history = s.navHistory;
  const target = history.index + delta;
  if (history.index < 0 || target < 0 || target >= history.entries.length)
    return null;
  const entries = [...history.entries];
  entries[history.index] = departingEntry(entries[history.index], s, anchorFor);
  const navHistory = normalize(
    { entries, index: target, lens: history.lens },
    s.navHiddenTabs,
  );
  const entry = navHistory.entries[navHistory.index];
  const patch: Partial<UiState> = {
    repoTab: entry.tab,
    ...pickSelection(entry.tab, entry.selection),
    // The list's state tab is panel state, so the restored PR needs the align to show.
    ...(entry.tab === "pulls"
      ? {
          pendingPrSection: null,
          pendingReviewId: null,
          pendingPrAlign: entry.selection.selectedPr != null,
        }
      : {}),
  };
  return {
    navHistory,
    patch,
    anchor: entry.tab === "projects" ? entry.anchor : null,
  };
}

/** One entry at the current location, anchor null, `lens: null`. */
export function seedHistory(s: NavState): NavHistory {
  return {
    entries: [
      { tab: s.repoTab, selection: selectionOf(s.repoTab, s), anchor: null },
    ],
    index: 0,
    lens: null,
  };
}

/** The history after comparing the live lens with the stamp; `s.navHistory` itself when
 *  there is nothing to write. A null stamp against the provisional lens only stamps, so
 *  what was recorded before the lens reads answered survives. */
export function syncLens(s: NavState, lens: RemoteLens): NavHistory {
  const stamp = s.navHistory.lens;
  if (stamp === lens) return s.navHistory;
  if (stamp === null && lens === PROVISIONAL_NAV_LENS)
    return { ...s.navHistory, lens };
  return { ...seedHistory(s), lens };
}

/** The history with every non-current entry on a `hidden` tab dropped; `history` itself
 *  when nothing changes. */
export function pruneHiddenTabs(
  history: NavHistory,
  hidden: readonly RepoTab[],
): NavHistory {
  return normalize(history, hidden);
}

// A wrapper per registration, so an unregister removes only its own provider.
const anchorProviders = new Map<
  RepoTab,
  { read: () => BoardAnchor | null | undefined }
>();

/** One provider per tab. Returns its unregister, which removes only this registration.
 *  A provider answers `undefined` when it cannot tell yet; the entry keeps its anchor. */
export function registerNavAnchorProvider(
  tab: RepoTab,
  provider: () => BoardAnchor | null | undefined,
): () => void {
  const registration = { read: provider };
  anchorProviders.set(tab, registration);
  return () => {
    if (anchorProviders.get(tab) === registration) anchorProviders.delete(tab);
  };
}

/** The registered provider's answer; `undefined` when none is registered for `tab`. */
export function readNavAnchor(tab: RepoTab): BoardAnchor | null | undefined {
  return anchorProviders.get(tab)?.read();
}

// The mark describes exactly the next ui-store change: the recorder takes it on every
// change, and the microtask retires it (by identity) if no change came in that task.
let linkHopMark: object | null = null;

export function armLinkHop(): void {
  const mark = {};
  linkHopMark = mark;
  queueMicrotask(() => {
    if (linkHopMark === mark) linkHopMark = null;
  });
}

export function takeLinkHop(): boolean {
  const marked = linkHopMark !== null;
  linkHopMark = null;
  return marked;
}

/** Test-only: drops the hop mark and every provider. */
export function __resetNavHistoryForTests(): void {
  linkHopMark = null;
  anchorProviders.clear();
}
