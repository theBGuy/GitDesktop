// Pure, import-free: scripts/remote-list-state.test.mjs imports this file
// through Node's type stripping, which resolves no aliases.

/** The degraded notice's link-style action; extra actions wear it too. */
export const DEGRADED_ACTION_CLASS =
  "cursor-pointer underline underline-offset-2 hover:text-foreground";

/** The notice over cached rows whose refresh is waiting for a connection. */
export const OFFLINE_ROWS_NOTICE =
  "You're offline — showing the last loaded results.";

/** What stands in for `subject` ("pull requests", "this issue") while its
 *  first read waits for a connection, where a skeleton would spin forever. */
export function offlinePendingMessage(subject: string): string {
  return `You're offline — ${subject} will load once you're back online.`;
}

/** Whether a read's notice speaks of a failed refresh and offers Retry.
 *  Offline outranks a failure it follows: a retry would park at once, and
 *  reconnecting resumes the read by itself. A refetch in flight is unsettled
 *  too (a reconnect resumes the errored read with `isError` still set), so it
 *  says nothing until it lands. Omitting `isFetching` reads as settled, which
 *  is only safe where the caller's degraded gate can't see the fetch either. */
export function refreshFailed(q: {
  isError: boolean;
  isPaused: boolean;
  isFetching?: boolean;
}): boolean {
  return q.isError && !q.isPaused && !q.isFetching;
}

/** The line a picker shows while it draws no options. A park outranks the
 *  failure it follows, a failure being refetched still loads, and `empty` is
 *  said only once a read has answered with none: a parked refetch over a
 *  loaded empty list keeps it, being a loaded answer. */
export function emptyPickerCopy(
  q: {
    data: unknown;
    isPending: boolean;
    isError: boolean;
    isPaused: boolean;
    isFetching: boolean;
  },
  copy: { noun: string; loadFailed: string; empty: string; loading?: string },
): string {
  if (q.isPaused && (q.data === undefined || q.isError))
    return offlinePendingMessage(copy.noun);
  if (refreshFailed(q)) return copy.loadFailed;
  if (q.isPending || q.isError) return copy.loading ?? "Loading…";
  return copy.empty;
}

/** The notice over a detail pane's retained content. `noun` is bare ("pull
 *  request"); `stale` is a switch still showing the PREVIOUS item as
 *  placeholder, which a parked read can't call this one's last loaded version. */
export function detailNoticeMessage(input: {
  noun: string;
  isError: boolean;
  stale: boolean;
}): string {
  const { noun } = input;
  if (input.isError)
    return `Couldn't refresh this ${noun} — showing the last loaded version.`;
  if (input.stale)
    return `You're offline — showing the last opened ${noun}; this one will load once you're back online.`;
  return "You're offline — showing the last loaded version.";
}

/** What a remote list section draws. "rows-degraded" is rows plus a notice
 *  that the last refresh failed; "rows-offline" is rows plus a notice that the
 *  refresh is waiting for a connection; "offline" says the list will load once
 *  back online, where a skeleton would spin forever. */
export type RemoteSectionState =
  | "gh-skeleton"
  | "not-ready"
  | "offline"
  | "list-skeleton"
  | "error"
  | "empty"
  | "rows"
  | "rows-degraded"
  | "rows-offline";

/** The remote section's render ladder. A failed read replaces the list only
 *  when there is nothing to draw: react-query keeps the last good data beside
 *  `isError`, and blanking those rows would make a transient outage read as
 *  data loss. `paused` is react-query's offline park (`isPaused`): an
 *  online-mode read waits there with no timeout, so it needs its own words,
 *  and it outranks an earlier failure the way {@link resolveDetailPane} does,
 *  since a Retry would only park again. `fetching` is a refetch in flight: over
 *  an earlier failure it is not settled yet, so its rows draw quietly; omitted,
 *  it reads as settled. Its empty arm loads rather than erroring: react-query
 *  resets a never-loaded errored read to pending on refetch, so error, fetching
 *  and no rows together come only from derived inputs (rows filtered out, or an
 *  `error` merged from several reads). */
export function resolveRemoteSection(input: {
  ghPending: boolean;
  ghReady: boolean;
  listPending: boolean;
  error: boolean;
  rowCount: number;
  paused?: boolean;
  fetching?: boolean;
}): RemoteSectionState {
  const { ghPending, ghReady, listPending, error, rowCount } = input;
  const paused = input.paused ?? false;
  if (ghPending) return "gh-skeleton";
  if (!ghReady) return "not-ready";
  if (listPending) return paused ? "offline" : "list-skeleton";
  if (paused && rowCount > 0) return "rows-offline";
  // A parked retry after a failure has nothing loaded to call empty. A parked
  // refetch over a loaded list without one keeps the empty copy below: zero
  // drawn rows is still a loaded answer.
  if (paused && error) return "offline";
  if (error && input.fetching) return rowCount > 0 ? "rows" : "list-skeleton";
  if (error) return rowCount > 0 ? "rows-degraded" : "error";
  return rowCount === 0 ? "empty" : "rows";
}

const PERMANENT_LIST_ERROR_KINDS: ReadonlySet<string> = new Set([
  "issuesDisabled",
  "invalidArgument",
]);

/** Whether a list read's error is a verdict neither a retry nor a reconnect can
 *  change for the same key: a feature the repo has turned off, or a filter the
 *  forge refuses. A list's error slot withholds its Retry for one, and the
 *  ladder is fed {@link parkedUnlessPermanent} so its explanation stays on
 *  screen instead of the "will load once you're back online" line. Structural,
 *  since this file stays import-free. */
export function isPermanentListError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    typeof error.kind === "string" &&
    PERMANENT_LIST_ERROR_KINDS.has(error.kind)
  );
}

/** The `paused` a list section passes {@link resolveRemoteSection}: the read's
 *  park, except while {@link isPermanentListError} holds, which a park can't
 *  clear. */
export function parkedUnlessPermanent(q: {
  isPaused: boolean;
  error: unknown;
}): boolean {
  return q.isPaused && !isPermanentListError(q.error);
}

/** The one line the review-comments block shows, or null. `threadCount` is
 *  the threads it draws, `undefined` until the read has loaded. A failure offers
 *  Retry and outranks `truncated`: unlike {@link unknownListNotice}, where the wire
 *  makes the two exclusive, `isError` here is the threads query's own refresh
 *  state over a retained capped payload, and its Retry can bring in newer
 *  threads. `truncated` is the loaded read's wire flag, never the drawn count. It
 *  outranks a park and offers no Retry: a capped read re-reads the same list, and
 *  though a failed reply top-up may fill in on a refetch, the bool-only flag
 *  can't tell the two apart. A park never offers Retry and outranks the failure it
 *  follows. A loaded empty answer stays quiet offline, like a list's empty rung. */
export function reviewCommentsNotice(input: {
  threadCount: number | undefined;
  truncated: boolean;
  isError: boolean;
  isPaused: boolean;
  isFetching?: boolean;
}): { message: string; retry: boolean } | null {
  const { threadCount, isPaused } = input;
  const failed = refreshFailed(input);
  const drawn = threadCount !== undefined && threadCount > 0;
  switch (true) {
    case failed && drawn:
      return {
        message:
          "Couldn't refresh review comments — showing the last loaded ones.",
        retry: true,
      };
    case failed && threadCount !== undefined:
      return { message: "Couldn't refresh review comments.", retry: true };
    case failed:
      return { message: "Couldn't load review comments.", retry: true };
    case input.truncated:
      return { message: "Review comments may be incomplete.", retry: false };
    case isPaused && drawn:
      return {
        message: "You're offline — showing the last loaded review comments.",
        retry: false,
      };
    case isPaused && threadCount === undefined:
      return {
        message: offlinePendingMessage("review comments"),
        retry: false,
      };
    default:
      return null;
  }
}

/** The notice props for a PR sub-list whose read failed or may be partial,
 *  keyed on the wire's `truncated` flag, never the shown row count (filtering can
 *  empty a capped page; an optimistic append can fill a failed one). A truncated
 *  read re-reads the same cap on refetch or reconnect, so it outranks offline and
 *  offers no Retry; its copy says "may be" because some caps are length
 *  heuristics (a list of exactly the cap can be complete). A failed read says so
 *  beside any rows it shows (an optimistic append, or the GraphQL rows GitHub
 *  keeps after a failed top-up); parked offline it resumes by itself, so it
 *  offers no Retry. */
export function unknownListNotice(opts: {
  prNoun: string;
  list: string;
  truncated: boolean;
  paused: boolean;
  onRetry?: () => void;
}): { message: string; onRetry?: () => void } {
  const { prNoun, list, truncated, paused, onRetry } = opts;
  if (truncated)
    return { message: `This ${prNoun}'s ${list} may be incomplete.` };
  if (paused) return { message: offlinePendingMessage(`the ${list}`) };
  return { message: `Couldn't fully load this ${prNoun}'s ${list}.`, onRetry };
}

/** {@link unknownListNotice} over several sub-lists of ONE read (a PR's comments
 *  and commits both ride its details payload), so they share one line and one
 *  Retry instead of stacking. Lists in the same arm join into one sentence; the
 *  arms keep that function's precedence order, and Retry rides only a shown
 *  failed arm. Null when every list is complete. */
export function unknownListsNotice(opts: {
  prNoun: string;
  lists: readonly { list: string; unknown: boolean; truncated: boolean }[];
  paused: boolean;
  onRetry?: () => void;
}): { message: string; onRetry?: () => void; retryLabel?: string } | null {
  const { prNoun, paused, onRetry } = opts;
  const truncated: string[] = [];
  const offline: string[] = [];
  const failed: string[] = [];
  for (const l of opts.lists) {
    if (!l.unknown) continue;
    if (l.truncated) truncated.push(l.list);
    else if (paused) offline.push(l.list);
    else failed.push(l.list);
  }
  const sentence = (
    names: string[],
    arm: { truncated: boolean; paused: boolean },
  ) => unknownListNotice({ prNoun, list: names.join(" and "), ...arm }).message;
  const sentences: string[] = [];
  if (truncated.length > 0)
    sentences.push(sentence(truncated, { truncated: true, paused }));
  if (offline.length > 0)
    sentences.push(sentence(offline, { truncated: false, paused: true }));
  if (failed.length > 0)
    sentences.push(sentence(failed, { truncated: false, paused: false }));
  if (sentences.length === 0) return null;
  const message = sentences.join(" ");
  // The Retry's name lists only the failed arm: the rest wouldn't change on retry.
  return failed.length > 0
    ? { message, onRetry, retryLabel: `Retry loading ${failed.join(" and ")}` }
    : { message };
}

export type ListNoticeCause = "refresh" | "load-more" | "offline";

/** The one line a list's notice shows, or null when healthy. A failing or
 *  parked list outranks a failed Load more, whose retry would meet the same
 *  outage. `cause` tells the caller which Retry to wire: a refetch of the list
 *  ("refresh"), growing the limit again ("load-more"), or none ("offline": a
 *  retry while offline parks again at once, and reconnecting resumes the read
 *  by itself, so the button would do nothing). `placeholder` says the
 *  drawn rows were loaded for ANOTHER view (a state tab, filter or category
 *  switch), so offline they can't be called this list's last loaded results.
 *  `hasRows` is whether rows are drawn at all: a section showing only an
 *  explanation card still reports a failed refresh, minus the "showing" claim,
 *  and has nothing to say offline. */
export function listNotice(input: {
  noun: string;
  failed: boolean;
  offline: boolean;
  placeholder: boolean;
  hasRows: boolean;
  loadMoreFailed: boolean;
}): {
  cause: ListNoticeCause;
  message: string;
  retryLabel: string;
} | null {
  const { noun } = input;
  if (input.failed)
    return {
      cause: "refresh",
      message: input.hasRows
        ? `Couldn't refresh ${noun} — showing the last loaded results.`
        : `Couldn't refresh ${noun}.`,
      retryLabel: `Retry loading ${noun}`,
    };
  if (input.offline && input.hasRows)
    return {
      cause: "offline",
      message: input.placeholder
        ? offlinePendingMessage(`${noun} for this view`)
        : OFFLINE_ROWS_NOTICE,
      retryLabel: `Retry loading ${noun}`,
    };
  if (input.loadMoreFailed)
    return {
      cause: "load-more",
      message: `Couldn't load more ${noun} — showing the ones already loaded.`,
      retryLabel: `Retry loading more ${noun}`,
    };
  return null;
}

/** The one line a small section over a single read (a pull request's tasks, a
 *  commit's comments) shows, or null. `rowCount` is `undefined` until the read
 *  has loaded; loaded rows stay drawn under {@link listNotice}'s line. With
 *  nothing loaded, a park says the section waits for a connection and a failure
 *  says `loadFailed`, offering Retry. */
export function sectionReadNotice(input: {
  noun: string;
  loadFailed: string;
  rowCount: number | undefined;
  isError: boolean;
  isPaused: boolean;
  isFetching?: boolean;
}): { message: string; retryLabel: string; retry: boolean } | null {
  const { noun, rowCount, isPaused } = input;
  const failed = refreshFailed(input);
  const retryLabel = `Retry loading ${noun}`;
  if (rowCount === undefined) {
    if (isPaused)
      return { message: offlinePendingMessage(noun), retryLabel, retry: false };
    return failed
      ? { message: input.loadFailed, retryLabel, retry: true }
      : null;
  }
  const notice = listNotice({
    noun,
    failed,
    offline: isPaused,
    placeholder: false,
    hasRows: rowCount > 0,
    loadMoreFailed: false,
  });
  return (
    notice && {
      message: notice.message,
      retryLabel: notice.retryLabel,
      retry: notice.cause === "refresh",
    }
  );
}

export type UngroupedReason = "offline" | "error" | "truncated";

/** Why a list the user asked to group by review state is drawn flat, or null
 *  when it is grouped or there is nothing to explain yet (a map still fetching).
 *  `truncated` is a loaded map too short to bucket every row, a verdict a park
 *  can't change; a park outranks a failure it follows, since a retry would only
 *  park again, and it covers a first load that would otherwise wait unexplained.
 *  A failure being refetched is still fetching, so it stays silent too. */
export function ungroupedReason(input: {
  requested: boolean;
  grouped: boolean;
  isError: boolean;
  isPaused: boolean;
  isFetching?: boolean;
  truncated: boolean;
}): UngroupedReason | null {
  if (!input.requested || input.grouped) return null;
  if (input.truncated) return "truncated";
  if (input.isPaused) return "offline";
  if (refreshFailed(input)) return "error";
  return null;
}

/** What a detail pane (one pull request, one issue) draws. */
export type DetailPaneState =
  | "skeleton"
  | "offline"
  | "error"
  | "content"
  | "content-degraded";

/** The detail pane's ladder: loaded content always renders, with a notice when
 *  its refresh failed or is parked offline, since react-query keeps the last
 *  good data beside both. Placeholder data counts as data. With nothing loaded,
 *  a parked read says it's offline rather than spinning a skeleton forever.
 *  `fetching` is required, not defaulted: a failure being refetched (a
 *  reconnect's resumed read) hasn't settled, and a pane degraded on the raw
 *  error would pair with {@link refreshFailed}'s silence as an offline claim.
 *  Its no-data skeleton arm serves derived inputs only (a `hasData` backed by
 *  another cache, say): react-query resets a never-loaded errored read to
 *  pending on refetch. */
export function resolveDetailPane(input: {
  pending: boolean;
  error: boolean;
  hasData: boolean;
  paused: boolean;
  fetching: boolean;
}): DetailPaneState {
  const { pending, hasData, paused } = input;
  const failed = input.error && !input.fetching;
  if (hasData) return failed || paused ? "content-degraded" : "content";
  if (paused) return "offline";
  if (pending || (input.error && !failed)) return "skeleton";
  return "error";
}

/** What a "Load more" guard remembers, stamped with the list identity (repo,
 *  lens, state, filter) it was recorded under: a changed identity reads as a
 *  fresh guard. `lastGood` is the limit that last loaded; `failed` is the grown
 *  limit whose load failed, cleared once a load reaches it. `rollback` holds a
 *  rollback the caller's own limit hasn't caught up with yet: while the caller
 *  still asks for `from`, the query runs at `to`. */
export type LoadMoreGuardState = {
  identity: string;
  lastGood: number | null;
  failed: number | null;
  rollback: { from: number; to: number } | null;
};

export function initialLoadMoreGuard(identity: string): LoadMoreGuardState {
  return { identity, lastGood: null, failed: null, rollback: null };
}

/** The limit the query runs at: the caller's `requested` limit, except while a
 *  rollback away from exactly that limit is pending under this identity. */
export function guardedLimit(
  state: LoadMoreGuardState,
  identity: string,
  requested: number,
): number {
  const rollback = state.identity === identity ? state.rollback : null;
  return rollback !== null && rollback.from === requested
    ? rollback.to
    : requested;
}

/** A limit-keyed list read as the guard observes it: `loaded` is success on
 *  real (non-placeholder) data, `failed` an error with no fetch in flight. A
 *  read parked offline is not settled either way: a retry refetches the errored
 *  key, which stays `isError` until that fetch starts, and a park would record
 *  a failure whose Retry could only park again. */
export function guardObservation(q: {
  isSuccess: boolean;
  isError: boolean;
  isPlaceholderData: boolean;
  isFetching: boolean;
  isPaused: boolean;
}): { loaded: boolean; failed: boolean } {
  return {
    loaded: q.isSuccess && !q.isPlaceholderData,
    failed: q.isError && !q.isFetching && !q.isPaused,
  };
}

/** One observation of the limit-keyed list query, run at `limit` (the guarded
 *  limit) for the caller's `requested` one. A grown limit that fails rolls back
 *  to the last limit that loaded, whose cached rows come straight back, and is
 *  remembered for a Retry. A failure with nothing loaded yet under this
 *  identity is the list's own error, never a rollback. `loaded` and `failed`
 *  are SETTLED reads: success on real (non-placeholder) data, and an error with
 *  no fetch in flight. Idempotent: observing the result of its own step
 *  returns the same object, which is what lets a caller apply it while
 *  rendering without looping. */
export function stepLoadMoreGuard(
  state: LoadMoreGuardState,
  input: {
    identity: string;
    requested: number;
    limit: number;
    loaded: boolean;
    failed: boolean;
  },
): LoadMoreGuardState {
  let next =
    state.identity === input.identity
      ? state
      : initialLoadMoreGuard(input.identity);
  // The caller has moved off the rolled-back limit (synced to it, or asked for
  // another), so the override has nothing left to redirect.
  if (next.rollback !== null && input.requested !== next.rollback.from)
    next = { ...next, rollback: null };
  if (input.loaded) {
    const failed =
      next.failed !== null && input.limit >= next.failed ? null : next.failed;
    if (next.lastGood !== input.limit || failed !== next.failed)
      next = { ...next, lastGood: input.limit, failed };
    return next;
  }
  if (input.failed && next.lastGood !== null && input.limit > next.lastGood) {
    return {
      ...next,
      failed: input.limit,
      rollback: { from: input.requested, to: next.lastGood },
    };
  }
  return next;
}

/** Address:port tokens: IPv4, bracketed IPv6, and localhost. Only these are
 *  masked, never bare digits, so two different HTTP statuses stay distinct. */
const ADDRESS_PORT =
  /\b\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}\b|\[[0-9A-Fa-f:.]+\]:\d{1,5}\b|\blocalhost:\d{1,5}\b/gi;

/** A failure message with its volatile address:port tokens masked. Transport
 *  errors name each connection's own ephemeral local port, so one outage
 *  reads differently on every read until those are masked. */
export function normalizeNoticeMessage(message: string): string {
  return message.replace(ADDRESS_PORT, "<addr>");
}

/** Buckets failure notices whose normalized `message` is identical, in
 *  first-seen order, so one outage behind several reads renders as a single
 *  line. Each group keeps its members' original messages. */
export function groupNoticesByMessage<T extends { message: string }>(
  notices: readonly T[],
): T[][] {
  const groups = new Map<string, T[]>();
  for (const notice of notices) {
    const key = normalizeNoticeMessage(notice.message);
    const group = groups.get(key);
    if (group) group.push(notice);
    else groups.set(key, [notice]);
  }
  return [...groups.values()];
}
