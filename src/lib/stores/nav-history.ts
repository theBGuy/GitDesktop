import type { RemoteLens } from "@/lib/git/types";
import type { RepoTab, UiState } from "@/lib/stores/ui";

// Pure rules of the Back/Forward history: an ordered list of segments, one per stretch of
// visits to one repository under one lens. Imports from ui.ts are type-only so ui.ts can
// import this module at runtime without a cycle.

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

export interface NavSegment {
  repoPath: string;
  /** The store's `repoName` when the segment started; null when the store held none. */
  repoName: string | null;
  /** The lens this segment's entries were recorded under; null until the lens reads answered. */
  lens: RemoteLens | null;
  /** Never empty in a history a function of this module returned. */
  entries: readonly NavEntry[];
}

export interface NavHistory {
  segments: readonly NavSegment[];
  /** The current segment; -1 only while `segments` is empty. */
  segment: number;
  /** The current entry inside the current segment; -1 only while `segments` is empty. */
  index: number;
}

export const EMPTY_NAV_HISTORY: NavHistory = {
  segments: [],
  segment: -1,
  index: -1,
};
/** The most entries the history holds, counted across every segment. */
export const NAV_HISTORY_CAP = 50;
/** What the lens reads serve before they answer; a null stamp stands for it. */
export const PROVISIONAL_NAV_LENS: RemoteLens = "origin";

export interface BoardReturnRequest {
  anchor: BoardAnchor;
  /** The interactionEpoch the restore's own bump produced. */
  epoch: number;
}

export interface NavSegmentTarget {
  repoPath: string;
  repoName: string | null;
  lens: RemoteLens | null;
}

/** What a landing reports: every `openPr` and `openIssue` landing, and any navigator's
 *  landing that keeps the history. */
export interface NavCarry {
  /** Whether the landing keeps the history (`carryHistory`): only such a landing adds a
   *  segment to the trail or rejoins one (rule C). One that keeps none reports its
   *  departure for the ordinary rules alone, its `lensFrom` is unread, and in another
   *  repository it seeds a new trail. */
  keepsHistory: boolean;
  /** The OPEN repository's lens before `beforeSelect` ran, by the reader; null when it
   *  could not tell. From under an overlay a recorded stamp outranks it on a hop to
   *  another repository, or back under that stamp. */
  lensFrom: RemoteLens | null;
  /** The target repository's lens after `beforeSelect`; null when no reader could tell. */
  lens: RemoteLens | null;
  /** The store state before `beforeSelect` ran: the departing stop's selection, and the
   *  trail that held it. */
  live: Pick<UiState, NavSelectionKey | "navHistory">;
}

/** A cross-repository restore's folder check. "gone": the backend answered not a
 *  directory, not a repository, or another root. "refused": git answered and the folder
 *  cannot be opened (its fatal exit, or a working tree it names that is not a
 *  directory). "unknown": the check failed any other way, or ran out of time. */
export type NavTargetCheck = "open" | "gone" | "refused" | "unknown";

export interface NavRestoreOptions {
  /** Cross-repository steps only. The target folder's check (see {@link NavTargetCheck}).
   *  Must never reject. */
  validate?: (target: NavSegmentTarget) => Promise<NavTargetCheck>;
  /** Run inside the landing, before its set, when the target segment's lens is non-null
   *  and `lensGone` did not answer true. */
  applyLens?: (repoPath: string, lens: RemoteLens) => void;
  /** Called once per press, after every stop of the target's repository was removed,
   *  with the answer that removed them. */
  onDead?: (
    target: NavSegmentTarget,
    delta: -1 | 1,
    reason: "gone" | "refused",
  ) => void;
  /** Called once per press whose check answered "unknown" while that press is still
   *  the current one; nothing was removed and nothing landed. */
  onUnchecked?: (target: NavSegmentTarget, delta: -1 | 1) => void;
  /** Asked inside the landing, once, when the target segment's lens is non-null. True
   *  only on positive evidence that the lens's remote is gone; false when it cannot
   *  tell. A true answer skips `applyLens` and drops the restored remote item; for a
   *  segment not already stamped "origin" it also re-seeds that segment as "origin"
   *  and arms no board return. */
  lensGone?: (repoPath: string, lens: RemoteLens) => boolean;
}

type NavState = Pick<
  UiState,
  | "view"
  | "repoPath"
  | "repoName"
  | "repoTab"
  | NavSelectionKey
  | "navHistory"
  | "navHiddenTabs"
>;
type NavLocation = Pick<NavEntry, "tab" | "selection">;
type AnchorReader = (tab: RepoTab) => BoardAnchor | null | undefined;

export function currentSegment(h: NavHistory): NavSegment | null {
  return h.segment < 0 ? null : (h.segments[h.segment] ?? null);
}

export function currentEntry(h: NavHistory): NavEntry | null {
  return currentSegment(h)?.entries[h.index] ?? null;
}

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

/** Equal tabs and equal listed keys. The anchor is not part of a location. Only ever
 *  applied to two entries of one segment: stops in two segments are never the same
 *  location, since crossing a boundary changes the repository or the lens. */
export function sameLocation(a: NavLocation, b: NavLocation): boolean {
  return (
    a.tab === b.tab &&
    NAV_SELECTION_FIELDS[a.tab].every((key) =>
      sameValue(a.selection[key] ?? null, b.selection[key] ?? null),
    )
  );
}

/** Position-based, and truthful because every returned history keeps I1, I2 and I5. */
export function canGoBack(s: Pick<NavState, "view" | "navHistory">): boolean {
  const { segment, index } = s.navHistory;
  return s.view === "repo" && segment >= 0 && (index > 0 || segment > 0);
}

export function canGoForward(
  s: Pick<NavState, "view" | "navHistory">,
): boolean {
  const { segments, segment, index } = s.navHistory;
  const current = currentSegment(s.navHistory);
  return (
    s.view === "repo" &&
    current !== null &&
    (index < current.entries.length - 1 || segment < segments.length - 1)
  );
}

function sameSegmentKey(a: NavSegmentTarget, b: NavSegmentTarget): boolean {
  return a.repoPath === b.repoPath && a.lens === b.lens;
}

interface WorkSegment {
  /** The input segments folded into this one, in order. */
  from: NavSegment[];
  repoPath: string;
  repoName: string | null;
  lens: RemoteLens | null;
  entries: NavEntry[];
  /** The current entry's position in `entries`; -1 when it sits elsewhere. */
  at: number;
}

/** The ONE place the invariants are enforced: I1 no two adjacent equal locations in a
 *  segment, I2 no non-current entry on a hidden tab, I3 at most NAV_HISTORY_CAP entries
 *  in total, I4 no empty segment, I5 no two adjacent segments with equal `repoPath` and
 *  `lens`, I6 `segment` and `index` on the current entry. Only drops and merges; returns
 *  `history` itself when nothing changes and keeps every untouched segment as it was.
 *  Order: drop hidden entries and emptied segments, merge equal neighbour segments, merge
 *  equal adjacent locations, cap; I1 runs after I5 because a merge can pair two at the join. */
function normalize(
  history: NavHistory,
  hidden: readonly RepoTab[],
): NavHistory {
  if (history.segment < 0) return history;
  const work: WorkSegment[] = [];
  history.segments.forEach((seg, s) => {
    const entries: NavEntry[] = [];
    let at = -1;
    seg.entries.forEach((entry, i) => {
      const current = s === history.segment && i === history.index;
      if (!current && hidden.includes(entry.tab)) return;
      if (current) at = entries.length;
      entries.push(entry);
    });
    if (entries.length === 0) return;
    work.push({
      from: [seg],
      repoPath: seg.repoPath,
      repoName: seg.repoName,
      lens: seg.lens,
      entries,
      at,
    });
  });
  const merged: WorkSegment[] = [];
  for (const w of work) {
    const last = merged[merged.length - 1];
    if (last !== undefined && sameSegmentKey(last, w)) {
      if (w.at >= 0) last.at = last.entries.length + w.at;
      last.entries.push(...w.entries);
      last.from.push(...w.from);
      last.repoName ??= w.repoName;
    } else {
      merged.push(w);
    }
  }
  for (const w of merged) {
    const kept: NavEntry[] = [];
    let at = -1;
    w.entries.forEach((entry, i) => {
      const current = i === w.at;
      const last = kept.length - 1;
      if (last >= 0 && sameLocation(kept[last], entry)) {
        // Keep the current one of the pair; when neither is, the later survives.
        if (at === last) return;
        kept[last] = entry;
        if (current) at = last;
        return;
      }
      kept.push(entry);
      if (current) at = last + 1;
    });
    w.entries = kept;
    w.at = at;
  }
  // Cap, oldest-first across segments; only an over-cap history whose current entry sits
  // that far back (never produced here) trims forward entries instead of the current one.
  let total = 0;
  let currentAt = -1;
  for (const w of merged) {
    if (w.at >= 0) currentAt = total + w.at;
    total += w.entries.length;
  }
  const start = Math.min(Math.max(0, total - NAV_HISTORY_CAP), currentAt);
  const end = start + NAV_HISTORY_CAP;
  const segments: NavSegment[] = [];
  let segment = -1;
  let index = -1;
  let offset = 0;
  for (const w of merged) {
    const lo = Math.max(start - offset, 0);
    const hi = Math.min(end - offset, w.entries.length);
    offset += w.entries.length;
    if (lo >= hi) continue;
    const entries =
      lo === 0 && hi === w.entries.length ? w.entries : w.entries.slice(lo, hi);
    if (w.at >= 0) {
      segment = segments.length;
      index = w.at - lo;
    }
    const only = w.from.length === 1 ? w.from[0] : null;
    segments.push(
      only !== null && only.entries.length === entries.length
        ? only
        : {
            repoPath: w.repoPath,
            repoName: w.repoName,
            lens: w.lens,
            entries,
          },
    );
  }
  if (
    segments.length === history.segments.length &&
    segments.every((seg, i) => seg === history.segments[i])
  ) {
    return history;
  }
  return { segments, segment, index };
}

/** The history with the current segment's entries replaced, every later segment dropped
 *  when `dropLater`; not normalized. */
function withCurrentEntries(
  history: NavHistory,
  entries: readonly NavEntry[],
  index: number,
  dropLater: boolean,
): NavHistory {
  const seg = history.segments[history.segment];
  const segments = dropLater
    ? history.segments.slice(0, history.segment + 1)
    : [...history.segments];
  segments[history.segment] = { ...seg, entries };
  return { segments, segment: history.segment, index };
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
  const current = currentEntry(history);
  if (
    next.repoPath === null ||
    next.repoPath !== prev.repoPath ||
    current === null ||
    history !== prev.navHistory
  ) {
    return history;
  }
  const answer = anchorFor(current.tab);
  if (answer === undefined || sameValue(answer, current.anchor)) return history;
  const entries = [...(currentSegment(history)?.entries ?? [])];
  entries[history.index] = { ...current, anchor: answer };
  return normalize(
    withCurrentEntries(history, entries, history.index, false),
    next.navHiddenTabs,
  );
}

function arrivalOf(next: NavState): NavEntry {
  const tab = next.repoTab;
  return { tab, selection: selectionOf(tab, next), anchor: null };
}

/** The trail as it stood before `beforeSelect`, with the state that held it, while it
 *  names the segment the landing found (`here`, current in `found`); null otherwise.
 *  In the repository view, a selection clear in there rewrites a departing stop that
 *  shows the cleared item to nothing selected, which can merge away an equal stop
 *  before it that the user saw (under an overlay nothing is recorded). A navigator run
 *  in there that moved the history to another segment keeps what it recorded. Whatever
 *  else was written in there inside that segment (a nested landing's stop; a reset,
 *  while the counts still match) is dropped with it: it never painted. */
function departureTrail(
  carry: NavCarry,
  found: NavHistory,
  here: NavSegment,
): { before: NavHistory; from: NavSegment; live: NavCarry["live"] } | null {
  const shown = carry.live.navHistory;
  const from = currentSegment(shown);
  return from !== null &&
    from.repoPath === here.repoPath &&
    shown.segment === found.segment &&
    shown.segments.length === found.segments.length
    ? { before: shown, from, live: carry.live }
    : null;
}

/** A carried hop's history, or null when the hop neither starts a segment nor rejoins one
 *  and the ordinary rules apply (the lens sync then does its own work). */
function carriedHistory(
  next: NavState & { repoPath: string },
  prev: NavState,
  anchorFor: AnchorReader,
  carry: NavCarry,
): NavHistory | null {
  const here = currentSegment(prev.navHistory);
  if (
    prev.repoPath === null ||
    here === null ||
    here.repoPath !== prev.repoPath
  )
    return null;
  // Against `prev`, never the departure's trail, which `beforeSelect` may have rewritten:
  // this refuses only a landing set that wrote a history of its own.
  if (next.navHistory !== prev.navHistory && next.navHistory.segment !== -1)
    return null;
  const shown = departureTrail(carry, prev.navHistory, here);
  const before = shown?.before ?? prev.navHistory;
  const from = shown?.from ?? here;
  const switching = next.repoPath !== prev.repoPath;
  const stamp = from.lens ?? PROVISIONAL_NAV_LENS;
  // Under an overlay the lens sync is unmounted, so a recorded stamp outranks the live
  // lens: the stored stops still stand under it. That holds on leaving the repository,
  // and on a same-repository hop that lands under the stamp after the live lens moved
  // off it, which rejoins the segment here so the departing entry is taken as stored,
  // with the anchor read when the view left.
  const overlaid = prev.view !== "repo" && from.lens !== null;
  const rejoins =
    overlaid &&
    !switching &&
    carry.lens === from.lens &&
    carry.lensFrom !== null &&
    carry.lensFrom !== from.lens;
  // Any other hop reads the live lens, so a same-repository one that changes no lens
  // leaves the stamp as recorded for the repository view's guard, which reads it against
  // the stored choice and the remotes list. A null stamp takes the live lens too.
  const lensFrom = overlaid && (switching || rejoins) ? null : carry.lensFrom;
  const departure = lensFrom ?? stamp;
  if (
    !switching &&
    !rejoins &&
    (carry.lens === null || carry.lens === departure)
  )
    return null;
  const stored = from.entries[before.index];
  // Under an overlay the departing entry stays as stored: its anchor was read on leaving.
  const departing =
    prev.view === "repo"
      ? departingEntry(stored, carry.live, anchorFor)
      : stored;
  // Brought in step with the live lens the way syncLens would: only a stamp the live
  // lens contradicts drops the stops recorded under it.
  const kept =
    lensFrom !== null && lensFrom !== stamp
      ? [departing]
      : [...from.entries.slice(0, before.index), departing];
  const departingSegment: NavSegment = {
    ...from,
    lens: lensFrom ?? (switching ? from.lens : stamp),
    entries: kept,
  };
  return normalize(
    {
      segments: [
        ...before.segments.slice(0, before.segment),
        departingSegment,
        {
          repoPath: next.repoPath,
          repoName: next.repoName,
          lens: carry.lens,
          entries: [arrivalOf(next)],
        },
      ],
      segment: before.segment + 1,
      index: 0,
    },
    next.navHiddenTabs,
  );
}

/** The history after observing one committed store change; returns `next.navHistory`
 *  itself (same identity) when there is nothing to write, except that a reported landing
 *  under a known, unchanged lens on the location it left returns the trail as shown
 *  before its `beforeSelect`, normalized. `carry` is the landing's carry mark, spent
 *  whether or not it applies. */
export function recordNavigation(
  next: NavState,
  prev: NavState,
  hop: boolean,
  anchorFor: AnchorReader,
  carry: NavCarry | null,
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
  // C: a landing that keeps the history adds a segment to the trail, or rejoins one, when
  // it changes the repository or the lens; one that keeps none never does (in another
  // repository it seeds a new trail, N2a).
  if (carry?.keepsHistory) {
    const carried = carriedHistory(
      { ...next, repoPath: next.repoPath },
      prev,
      anchorFor,
      carry,
    );
    if (carried !== null) return carried;
  }
  // N2a: an empty history starts at the landing.
  const seg = currentSegment(history);
  if (seg === null) return seedHistory(next);
  // N3: a history-aware writer (restore, lens sync, prune) authored this change. It runs
  // ahead of N2b so a restore that changes the repository keeps the history it wrote.
  if (history !== prev.navHistory) {
    return seg.repoPath === next.repoPath ? history : seedHistory(next);
  }
  // N2b: a repo switch the history does not describe starts over at the landing.
  if (next.repoPath !== prev.repoPath || seg.repoPath !== next.repoPath) {
    return seedHistory(next);
  }
  // A reported landing known to stay under the departing segment's lens departs from the
  // trail and state shown before its `beforeSelect`: a selection clear in there is no
  // deselect of the user's, though the rules would read it as one (N7 records it; from
  // under an overlay N4 reads the cleared state). An untold lens may still turn,
  // and the lens sync would then re-stamp a kept stop under the other lens, so that
  // landing, like one onto another lens, records as found.
  const shown = carry === null ? null : departureTrail(carry, history, seg);
  const reported =
    shown !== null &&
    carry !== null &&
    carry.lens !== null &&
    carry.lens === (shown.from.lens ?? PROVISIONAL_NAV_LENS)
      ? shown
      : null;
  const before = reported?.before ?? history;
  const { entries } = reported?.from ?? seg;
  const live = reported?.live ?? prev;
  const { index } = before;
  const current = entries[index];
  const arrival = arrivalOf(next);
  // N4: a tab change pushes, whatever wrote it; every later stop is dropped.
  if (arrival.tab !== current.tab) {
    return normalize(
      withCurrentEntries(
        before,
        [
          ...entries.slice(0, index),
          departingEntry(current, live, anchorFor),
          arrival,
        ],
        index + 1,
        true,
      ),
      next.navHiddenTabs,
    );
  }
  // N5: a duplicate location never pushes, hop or not. A reported landing returns the
  // trail as shown, which undoes the clear recorded before it, normalized against the
  // tabs hidden now; an unreported one keeps its identity return.
  if (sameLocation(current, arrival)) {
    return before === history ? history : normalize(before, next.navHiddenTabs);
  }
  // N6: a link hop pushes, dropping every later stop.
  if (hop) {
    return normalize(
      withCurrentEntries(
        before,
        [...entries.slice(0, index + 1), arrival],
        index + 1,
        true,
      ),
      next.navHiddenTabs,
    );
  }
  // N7: list browsing, deselects and prunes rewrite the current entry in place.
  const rewritten = [...entries];
  rewritten[index] = { ...current, selection: arrival.selection };
  return normalize(
    withCurrentEntries(before, rewritten, index, false),
    next.navHiddenTabs,
  );
}

/** Where one Back (-1) or Forward (+1) step goes, read without any anchor: inside the
 *  current segment, into a neighbouring segment, or nowhere. */
export function restoreTarget(
  s: NavState,
  delta: -1 | 1,
): { kind: "entry" } | ({ kind: "segment" } & NavSegmentTarget) | null {
  const history = s.navHistory;
  const seg = currentSegment(history);
  if (seg === null) return null;
  const at = history.index + delta;
  if (at >= 0 && at < seg.entries.length) return { kind: "entry" };
  const target = history.segments[history.segment + delta];
  if (target === undefined) return null;
  return {
    kind: "segment",
    repoPath: target.repoPath,
    repoName: target.repoName,
    lens: target.lens,
  };
}

/** The history and location patch for one Back (-1) or Forward (+1) step, or null when
 *  that direction is empty. The patch never holds `view`, `previousView`, `repoPath` or
 *  `repoName`; `crossing` names the target segment when the step leaves the current one.
 *  Calls `anchorFor` only after the direction check passed: a provider read spends the
 *  board's opener. */
export function restoreStep(
  s: NavState,
  delta: -1 | 1,
  anchorFor: AnchorReader,
): {
  navHistory: NavHistory;
  patch: Partial<UiState>;
  anchor: BoardAnchor | null;
  crossing: NavSegmentTarget | null;
} | null {
  const target = restoreTarget(s, delta);
  if (target === null) return null;
  const history = s.navHistory;
  const seg = history.segments[history.segment];
  const entries = [...seg.entries];
  entries[history.index] = departingEntry(entries[history.index], s, anchorFor);
  const departed = withCurrentEntries(history, entries, history.index, false);
  let segment = history.segment;
  let index = history.index + delta;
  let crossing: NavSegmentTarget | null = null;
  if (target.kind === "segment") {
    segment += delta;
    index = delta < 0 ? history.segments[segment].entries.length - 1 : 0;
    crossing = {
      repoPath: target.repoPath,
      repoName: target.repoName,
      lens: target.lens,
    };
  }
  const navHistory = normalize(
    { segments: departed.segments, segment, index },
    s.navHiddenTabs,
  );
  const entry = currentEntry(navHistory) as NavEntry;
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
    crossing,
  };
}

/** One segment of the open repository holding one entry at the current location, anchor
 *  null, `lens: null`; empty when no repository is open. */
export function seedHistory(s: NavState): NavHistory {
  if (s.repoPath === null) return EMPTY_NAV_HISTORY;
  return {
    segments: [
      {
        repoPath: s.repoPath,
        repoName: s.repoName,
        lens: null,
        entries: [arrivalOf(s)],
      },
    ],
    segment: 0,
    index: 0,
  };
}

/** The history after comparing the live lens with the current segment's stamp;
 *  `s.navHistory` itself when there is nothing to write. A null stamp against the
 *  provisional lens only stamps, so what was recorded before the lens reads answered
 *  survives; any other mismatch re-seeds the current segment alone. */
export function syncLens(
  s: NavState,
  lens: RemoteLens,
): { navHistory: NavHistory; reseeded: boolean } {
  const history = s.navHistory;
  const seg = currentSegment(history);
  if (seg === null || seg.lens === lens) {
    return { navHistory: history, reseeded: false };
  }
  const segments = [...history.segments];
  if (seg.lens === null && lens === PROVISIONAL_NAV_LENS) {
    segments[history.segment] = { ...seg, lens };
    return {
      navHistory: normalize(
        { segments, segment: history.segment, index: history.index },
        s.navHiddenTabs,
      ),
      reseeded: false,
    };
  }
  segments[history.segment] = { ...seg, lens, entries: [arrivalOf(s)] };
  return {
    navHistory: normalize(
      { segments, segment: history.segment, index: 0 },
      s.navHiddenTabs,
    ),
    reseeded: true,
  };
}

/** The history with every non-current entry on a `hidden` tab dropped; `history` itself
 *  when nothing changes. */
export function pruneHiddenTabs(
  history: NavHistory,
  hidden: readonly RepoTab[],
): NavHistory {
  return normalize(history, hidden);
}

/** Every segment of `repoPath` removed, whatever its lens and wherever it sits; never the
 *  current segment, so `history` itself when the current segment names `repoPath` or no
 *  segment does. Segments the removal makes adjacent merge when equal. */
export function dropRepository(
  history: NavHistory,
  repoPath: string,
  hidden: readonly RepoTab[],
): NavHistory {
  const seg = currentSegment(history);
  if (seg === null || seg.repoPath === repoPath) return history;
  if (!history.segments.some((x) => x.repoPath === repoPath)) return history;
  const segments = history.segments.filter((x) => x.repoPath !== repoPath);
  return normalize(
    { segments, segment: segments.indexOf(seg), index: history.index },
    hidden,
  );
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

// The lens lives in react-query, which this module and ui.ts cannot import; the app
// registers one reader. A wrapper per registration, as for the anchor providers.
let lensReader: { read: (repoPath: string) => RemoteLens | null } | null = null;

/** The one lens reader. Returns its unregister, which removes only this registration. */
export function registerNavLensReader(
  reader: (repoPath: string) => RemoteLens | null,
): () => void {
  const registration = { read: reader };
  lensReader = registration;
  return () => {
    if (lensReader === registration) lensReader = null;
  };
}

/** The registered reader's answer for `repoPath`; null when none is registered or it
 *  cannot tell. */
export function readNavLens(repoPath: string): RemoteLens | null {
  return lensReader?.read(repoPath) ?? null;
}

// Each mark describes exactly the next ui-store change: the recorder takes both on every
// change, and the microtask retires a mark (by identity) if no change came in that task.
let linkHopMark: object | null = null;
let carryMark: { carry: NavCarry } | null = null;

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

export function armCarry(carry: NavCarry): void {
  const mark = { carry };
  carryMark = mark;
  queueMicrotask(() => {
    if (carryMark === mark) carryMark = null;
  });
}

export function takeCarry(): NavCarry | null {
  const carry = carryMark?.carry ?? null;
  carryMark = null;
  return carry;
}

/** Test-only: drops both marks, every anchor provider and the lens reader. */
export function __resetNavHistoryForTests(): void {
  linkHopMark = null;
  carryMark = null;
  anchorProviders.clear();
  lensReader = null;
}
