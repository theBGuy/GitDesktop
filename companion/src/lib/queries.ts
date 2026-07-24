import {
  keepPreviousData,
  QueryCache,
  QueryClient,
  useQuery,
} from "@tanstack/react-query";
import {
  ApiError,
  fetchBranches,
  fetchCiRun,
  fetchCiRuns,
  fetchCommit,
  fetchCommitDiff,
  fetchDiscussion,
  fetchDiscussionMeta,
  fetchDiscussions,
  fetchFileDiff,
  fetchIssue,
  fetchIssues,
  fetchLog,
  fetchPr,
  fetchPrs,
  fetchPrThreads,
  fetchPrTimeline,
  fetchRepos,
  fetchReviews,
  fetchStatus,
  fetchTags,
  fetchTodoScan,
  fetchWorkingDiff,
} from "./api";
import { navigate } from "./router";

// A fresh QueryClient for the companion — modest freshness, one retry, and NO
// refetch-on-focus (a phone backgrounds/foregrounds constantly; we drive
// freshness with a polling interval on the ACTIVE screen instead).
export const queryClient = new QueryClient({
  // ROUND-6 FINDING (PR #75): the "401 anywhere → #pair" invariant must hold
  // centrally, not just via the shell's status probe — that probe doesn't poll
  // on the PRs/CI tabs, so a phone revoked while sitting there kept its stale
  // list (the banner read "couldn't refresh") AND re-sent its dead cookie every
  // poll, burning the server's brute-force budget until it rate-limited itself
  // out of RE-pairing. Any query's fresh 401 now redirects; `navigate` is a
  // no-op when already on #pair. (The shell's status-based redirect remains as
  // belt-and-braces with its post-pair freshness gate.)
  queryCache: new QueryCache({
    onError: (err) => {
      if (err instanceof ApiError && err.isUnauthorized) navigate("#pair");
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      // One retry for transient failures — but never for a definitive error: a
      // 401 (re-sending the dead cookie double-bills the per-IP lockout budget on
      // every poll cycle), a 409 noActiveRepo, a 404 noSuchRepo (the scoped
      // repo is gone — a retry can't conjure it back and only delays the
      // repo-gone state), or a 400 discussionsUnavailable (the repo's HOST has no
      // Discussions — a retry can't change the host).
      retry: (failureCount, err) =>
        !(
          err instanceof ApiError &&
          (err.isUnauthorized ||
            err.isNoActiveRepo ||
            err.isNoSuchRepo ||
            err.isDiscussionsUnavailable)
        ) && failureCount < 1,
      refetchOnWindowFocus: false,
    },
  },
});

// Poll the active screen every ~15s; inactive screens don't poll (their hook is
// unmounted, or `active` is false). A number-or-false is exactly what
// react-query's `refetchInterval` expects.
const POLL_MS = 15_000;
const poll = (active: boolean) => (active ? POLL_MS : (false as const));

/** The repositories shared from the desktop, for the picker + TopBar title.
 *  A modest freshness window plus refetch-on-focus (the ONE exception to the
 *  companion's no-focus-refetch default): the shared set changes on the DESKTOP,
 *  so when the user brings the phone back to foreground we want a current list —
 *  a repo that stopped being shared should drop out promptly. Device-level (not
 *  repo-scoped): safe to fetch on any authed screen, and a 401 still routes
 *  through the central QueryCache → `#pair`.
 *
 *  `enabled` (default true) gates the query entirely — the shell passes false
 *  while the phone sits on `#pair` so an unpaired (or revoked-but-still-cookied)
 *  page fires ZERO authed traffic. This is load-bearing, not hygiene: a device
 *  that paired then got revoked still holds the `gd_lan` cookie, and the server
 *  deliberately penalizes a PRESENT-but-invalid credential (the PR-75 lockout
 *  budget). The phone backgrounds/foregrounds repeatedly during the pairing
 *  dance; with the query enabled, each foreground's focus-refetch would bank a
 *  rate-limit failure until the device locks itself out of RE-pairing. A disabled
 *  query neither mount-fetches nor focus-refetches, so `refetchOnWindowFocus` is
 *  safe to leave on for the enabled state. */
export function useRepos(enabled = true) {
  return useQuery({
    queryKey: ["repos"],
    queryFn: fetchRepos,
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    // Poll at the screens' cadence: the envelope carries `hideAi` (and the shared
    // set), and a phone left OPEN on a screen gets no focus event — without an
    // interval a desktop toggle would never converge until a manual reload
    // (live-caught in the slice-5 E2E).
    refetchInterval: enabled ? poll(true) : false,
  });
}

/** The selected repo's status. `repoId` scopes the query + cache key; `active`
 *  gates polling to the visible screen; `enabled` (default true) gates the query
 *  entirely — the shell passes false while the phone sits on `#pair`, so an
 *  unpaired page never fires authed requests (each would 401, and pre-pair
 *  traffic was how the shell once banked rate-limit failures before the user ever
 *  typed a PIN). A null `repoId` also disables it (no repo selected yet). */
export function useStatus(
  repoId: string | null,
  active: boolean,
  enabled = true,
) {
  const on = enabled && repoId != null;
  return useQuery({
    queryKey: ["status", repoId],
    queryFn: () => fetchStatus(repoId as string),
    enabled: on,
    refetchInterval: on ? poll(active) : false,
  });
}

export function usePrs(repoId: string | null, active: boolean) {
  return useQuery({
    queryKey: ["prs", repoId, "open"],
    queryFn: () => fetchPrs(repoId as string, "open"),
    enabled: repoId != null,
    refetchInterval: repoId != null ? poll(active) : false,
  });
}

export function usePr(repoId: string | null, number: number | null) {
  const on = repoId != null && number != null;
  return useQuery({
    queryKey: ["pr", repoId, number],
    queryFn: () => fetchPr(repoId as string, number as number),
    enabled: on,
    // A detail view is a deliberate drill-in; poll it while it's open.
    refetchInterval: on ? POLL_MS : (false as const),
  });
}

export function useCiRuns(repoId: string | null, active: boolean) {
  return useQuery({
    queryKey: ["ci", "runs", repoId],
    queryFn: () => fetchCiRuns(repoId as string),
    enabled: repoId != null,
    refetchInterval: repoId != null ? poll(active) : false,
  });
}

export function useCiRun(repoId: string | null, id: number | null) {
  const on = repoId != null && id != null;
  return useQuery({
    queryKey: ["ci", "run", repoId, id],
    queryFn: () => fetchCiRun(repoId as string, id as number),
    enabled: on,
    refetchInterval: on ? POLL_MS : (false as const),
  });
}

/** The live agent streams (AI reviews + agent sessions) to watch. `repoId` scopes
 *  the query + cache key; `active` gates polling — pass false while a watch screen
 *  is open so the list doesn't poll behind it. The watch screen also refetches
 *  THIS query to classify a stream that closed without a terminal event (present →
 *  still live, gone → ended/unshared), which is why it lives here (a react-query
 *  refetch routes a 401 through the central QueryCache → `#pair`, unlike a raw
 *  fetch). */
export function useReviews(repoId: string | null, active: boolean) {
  return useQuery({
    queryKey: ["reviews", repoId],
    queryFn: () => fetchReviews(repoId as string),
    enabled: repoId != null,
    refetchInterval: repoId != null ? poll(active) : false,
  });
}

export function usePrTimeline(repoId: string | null, number: number | null) {
  const on = repoId != null && number != null;
  return useQuery({
    queryKey: ["pr", repoId, number, "timeline"],
    queryFn: () => fetchPrTimeline(repoId as string, number as number),
    enabled: on,
    refetchInterval: on ? POLL_MS : (false as const),
  });
}

export function usePrThreads(repoId: string | null, number: number | null) {
  const on = repoId != null && number != null;
  return useQuery({
    queryKey: ["pr", repoId, number, "threads"],
    queryFn: () => fetchPrThreads(repoId as string, number as number),
    enabled: on,
    refetchInterval: on ? POLL_MS : (false as const),
  });
}

// ── Slice-6 hooks (Changes · History · Branches · Issues) ─────────────────────

/** The repo's local branches. `active` gates polling to the visible screen. */
export function useBranches(repoId: string | null, active: boolean) {
  return useQuery({
    queryKey: ["branches", repoId],
    queryFn: () => fetchBranches(repoId as string),
    enabled: repoId != null,
    refetchInterval: repoId != null ? poll(active) : false,
  });
}

/** A page of the commit history. `active` gates polling; `skip`/`limit` page the
 *  log and are part of the cache key so each page caches independently. */
export function useLog(
  repoId: string | null,
  active: boolean,
  skip = 0,
  limit = 50,
) {
  return useQuery({
    queryKey: ["log", repoId, skip, limit],
    queryFn: () => fetchLog(repoId as string, limit, skip),
    enabled: repoId != null,
    refetchInterval: repoId != null ? poll(active) : false,
    // "Load more" grows `limit`, which is part of the key — without a placeholder
    // the new key has NO cache and the mounted list collapses to skeletons on
    // every tap (review r2). Keep the prior page visible while the grown page
    // loads; the screen gates its button on `isPlaceholderData`.
    placeholderData: keepPreviousData,
  });
}

/** One commit's details. A commit is IMMUTABLE, so there's no `refetchInterval` —
 *  once fetched it never changes (no poll, and the default staleTime is irrelevant). */
export function useCommit(repoId: string | null, hash: string | null) {
  const on = repoId != null && hash != null;
  return useQuery({
    queryKey: ["commit", repoId, hash],
    queryFn: () => fetchCommit(repoId as string, hash as string),
    enabled: on,
  });
}

/** One commit's unified diff. Immutable like the commit itself — no polling. */
export function useCommitDiff(repoId: string | null, hash: string | null) {
  const on = repoId != null && hash != null;
  return useQuery({
    queryKey: ["commitDiff", repoId, hash],
    queryFn: () => fetchCommitDiff(repoId as string, hash as string),
    enabled: on,
  });
}

/** The working-tree diff (staged ∪ unstaged), with per-file stats. `active` gates
 *  polling — the working tree changes on the desktop, so the LIST view polls it. */
export function useWorkingDiff(repoId: string | null, active: boolean) {
  return useQuery({
    queryKey: ["workingDiff", repoId],
    queryFn: () => fetchWorkingDiff(repoId as string),
    enabled: repoId != null,
    refetchInterval: repoId != null ? poll(active) : false,
  });
}

/** One file's diff. Deliberately NOT polled: a file's content changing mid-read is
 *  jarring on a detail view, and the Changes LIST screen's own poll is the freshness
 *  mechanism (a re-visit refetches once the default staleTime lapses). `opts.staged`
 *  / `opts.untracked` select the diff side and are part of the cache key (falling
 *  back to their fetcher defaults so the key matches the request). */
export function useFileDiff(
  repoId: string | null,
  path: string | null,
  opts: { staged?: boolean; untracked?: boolean },
) {
  const on = repoId != null && path != null;
  return useQuery({
    queryKey: [
      "fileDiff",
      repoId,
      path,
      opts.staged ?? false,
      opts.untracked ?? false,
    ],
    queryFn: () => fetchFileDiff(repoId as string, path as string, opts),
    enabled: on,
    refetchInterval: false,
  });
}

/** The repo's issues. `active` gates polling; `state` ("open"/"closed") is part of
 *  the cache key so switching filters caches independently. `limit` grows the page
 *  (the "Load more" affordance) — like `useLog`, it's a single GROWING query keyed on
 *  the limit (the server re-serves the whole prefix), NOT a stitched pages array. */
export function useIssues(
  repoId: string | null,
  active: boolean,
  state = "open",
  limit = 30,
) {
  return useQuery({
    queryKey: ["issues", repoId, state, limit],
    queryFn: () => fetchIssues(repoId as string, state, limit),
    enabled: repoId != null,
    refetchInterval: repoId != null ? poll(active) : false,
    // Same growing-limit key as useLog: keep the prior page visible while the
    // grown page loads (review r2 — no placeholder = skeleton collapse on tap).
    placeholderData: keepPreviousData,
  });
}

/** One issue's full read view. Polls while open (comments do change) — a detail view
 *  is a deliberate drill-in, so keep it fresh at the standard cadence. */
export function useIssue(repoId: string | null, number: number | null) {
  const on = repoId != null && number != null;
  return useQuery({
    queryKey: ["issue", repoId, number],
    queryFn: () => fetchIssue(repoId as string, number as number),
    enabled: on,
    refetchInterval: on ? POLL_MS : (false as const),
  });
}

// ── Companion-extras hooks (Tags · Code TODOs · Discussions) ──────────────────

/** The repo's tags. `active` gates polling to the visible screen — refs are cheap,
 *  so the list polls at the standard cadence like the other list screens. */
export function useTags(repoId: string | null, active: boolean) {
  return useQuery({
    queryKey: ["tags", repoId],
    queryFn: () => fetchTags(repoId as string),
    enabled: repoId != null,
    refetchInterval: repoId != null ? poll(active) : false,
  });
}

/** A code-TODO scan for the given markers. Deliberately NOT polled: a scan is a
 *  git-grep sweep across the tree, so re-running it every 15s is pure waste — this is
 *  a deliberate divergence from the other list hooks (which DO poll). A modest
 *  `staleTime` lets a re-visit refetch without hammering. `markers` are sorted into
 *  the cache key so `["TODO","FIXME"]` and `["FIXME","TODO"]` share one entry.
 *  `enabled` (default true) plus a repo and at least one marker gate the query —
 *  scanning with zero markers would match nothing. `keepPreviousData`: toggling a
 *  marker chip re-keys the query, and without a placeholder the list would collapse
 *  to skeletons on every toggle (same finding as useLog). */
export function useTodoScan(
  repoId: string | null,
  markers: string[],
  enabled = true,
) {
  return useQuery({
    queryKey: ["todos", repoId, [...markers].sort().join(",")],
    queryFn: () => fetchTodoScan(repoId as string, markers),
    enabled: enabled && repoId != null && markers.length > 0,
    refetchInterval: false,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

/** The repo's discussions metadata (enablement + categories). No poll — categories
 *  and enablement rarely change — and a long `staleTime` (the desktop uses the same
 *  5-minute window). A null `repoId` disables it. */
export function useDiscussionMeta(repoId: string | null) {
  return useQuery({
    queryKey: ["discussions", repoId, "meta"],
    queryFn: () => fetchDiscussionMeta(repoId as string),
    enabled: repoId != null,
    staleTime: 300_000,
  });
}

/** The repo's discussions, filtered by `category` (null = all) and paged by `limit`.
 *  `active` gates polling to the visible screen; `enabled` (default true) additionally
 *  gates the query (e.g. off while Discussions are known-unavailable). `category` and
 *  `limit` are part of the cache key so each filter/page caches independently.
 *  `keepPreviousData`: a growing limit or a category switch re-keys the query — keep
 *  the prior page visible while the new one loads (same finding as useLog/useIssues). */
export function useDiscussions(
  repoId: string | null,
  active: boolean,
  category: string | null,
  limit: number,
  enabled = true,
) {
  const on = enabled && repoId != null;
  return useQuery({
    queryKey: ["discussions", repoId, category ?? "all", limit],
    queryFn: () => fetchDiscussions(repoId as string, category, limit),
    enabled: on,
    refetchInterval: on ? poll(active) : false,
    placeholderData: keepPreviousData,
  });
}

/** One discussion's full read view. Polls while open (comments/answers change) — a
 *  detail view is a deliberate drill-in, so keep it fresh at the standard cadence
 *  (same as useIssue). */
export function useDiscussion(repoId: string | null, number: number | null) {
  const on = repoId != null && number != null;
  return useQuery({
    queryKey: ["discussion", repoId, number],
    queryFn: () => fetchDiscussion(repoId as string, number as number),
    enabled: on,
    refetchInterval: on ? POLL_MS : (false as const),
  });
}

/** Narrow an unknown query error to an {@link ApiError} for state routing. */
export function asApiError(error: unknown): ApiError | null {
  return error instanceof ApiError ? error : null;
}
