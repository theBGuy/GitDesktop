import { getLatestReview } from "@/lib/pulls/reviews-history";
import { getDismissedHead } from "./dismissals";
import { triggerAutomations } from "./runner";

/**
 * Per-`(kind, repo, ref)` EVERY head we already fired a pr-sync event for, so each
 * head fires at most once instead of on every poll tick — watchers can call
 * `maybeFireSync` freely. Every head is kept rather than just the last one: an
 * eventually-consistent poll can serve the PREVIOUS head right after a push, and a
 * last-head-only dedup would let that stale head fire a second time. Intentionally
 * never reclaimed (the dedup must survive a repo view unmounting); bounded by the
 * real pushes per PR seen this session, and resets on restart.
 */
const firedHeads = new Map<string, string[]>();

/**
 * Whether two commit SHAs refer to the same commit, tolerating short-vs-full.
 * Providers disagree on length: pr-open seeds the FULL 40-char local sha while
 * Bitbucket's poll delivers a 12-char short sha for the same head, so a plain `===`
 * would treat every poll tick as a new head and re-fire pr-sync forever. Equal
 * non-empty values match outright; otherwise it prefix-matches by the shorter sha,
 * which must be ≥7 chars (git's minimum unambiguous length) so a stray empty/1-char
 * value can't false-match.
 */
export function sameSha(a: string, b: string): boolean {
  if (a === b) return a !== "";
  if (!a || !b) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < 7) return false;
  return longer.startsWith(shorter);
}

export interface SyncCandidate {
  repoPath: string;
  kind: "remote" | "local";
  /** Remote PR number (as a string) or local PR id. */
  ref: string;
  /** The PR head's current tip SHA. */
  currentHeadSha: string;
  base: string;
  head: string;
  title: string;
  body: string;
  commitSubjects: string[];
}

/**
 * Fires a `pr-sync` automation event for an open PR's head we haven't fired for
 * this session. Deduped by head, so an unchanged PR observed on every poll never
 * re-fires — and neither does a head the poll re-serves after moving off it. The
 * runner gates whether to actually review (only a PR already reviewed in a mode,
 * on a head that mode hasn't already covered).
 */
export function maybeFireSync(c: SyncCandidate): void {
  if (!c.currentHeadSha) return;
  const key = `${c.kind}:${c.repoPath}#${c.ref}`;
  const fired = firedHeads.get(key);
  // sameSha rather than set membership: the same head arrives short from one
  // provider and full from another, and both must count as already fired.
  if (fired?.some((sha) => sameSha(sha, c.currentHeadSha))) return;
  if (fired) fired.push(c.currentHeadSha);
  else firedHeads.set(key, [c.currentHeadSha]);
  triggerAutomations({
    kind: "pr-sync",
    repoPath: c.repoPath,
    base: c.base,
    head: c.head,
    headSha: c.currentHeadSha,
    title: c.title,
    body: c.body,
    commitSubjects: c.commitSubjects,
    target:
      c.kind === "remote"
        ? { type: "remote", number: Number(c.ref) }
        : { type: "local", id: c.ref },
  });
}

/**
 * How recently a PR must have been opened to earn an initial catch-up review, so
 * enabling a rule doesn't fan out a burst of (paid) reviews over an old backlog of
 * un-reviewed PRs. A `createdAt` that is missing or unparsable fails CLOSED.
 */
const CATCH_UP_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Per-`(repoPath, ref, headSha)` catch-up attempts made this session. Marked
 * SYNCHRONOUSLY (before any await) so a poll tick racing an in-flight async
 * eligibility check can't double-enter the same PR. Entries stay even when
 * eligibility later fails; a genuinely missed catch-up retries after a restart.
 */
const catchUpAttempted = new Set<string>();

/** A poll snapshot's open remote PR, carrying the fields the catch-up needs on
 *  top of what `maybeFireSync` reads. Built by the pollers from `PrPollInfo`. */
export interface CatchUpCandidate {
  /** Remote PR number (as a string). */
  ref: string;
  currentHeadSha: string;
  base: string;
  head: string;
  title: string;
  /** The PR author's login — must equal the viewer to be caught up. */
  author: string;
  /** ISO-8601 open time; "" (or unparsable) fails closed. */
  createdAt: string;
  isDraft: boolean;
}

/**
 * Synthesizes the initial `pr-open` automation event for a PR opened OUTSIDE
 * GitDesktop (gh CLI, the web, a bot flow), which otherwise falls between both
 * triggers: `pr-open` fires only from the app's own create / mark-ready paths, and
 * the `pr-sync` runner deliberately skips any PR with no prior review record.
 * Detecting such a PR on the existing poll tick and firing the same `pr-open` event
 * closes the gap — without it, externally-opened PRs get zero signal.
 *
 * Scope is deliberately narrow (user-locked): the viewer's OWN, open, recent PRs
 * where AT LEAST ONE mode still needs a review (see {@link prOpenEligible}). Drafts
 * are included only when `reviewDrafts` is set (the `reviewDraftPrs` setting,
 * default OFF); skipped drafts are picked up by the mark-ready path instead. At
 * most ONE PR is caught up per call (the oldest), bounding burst token spend.
 */
export function maybeCatchUpMissedOpen(
  repoPath: string,
  candidates: CatchUpCandidate[],
  viewerLogin: string | null,
  reviewDrafts: boolean,
): void {
  // A null login means we can't tell which PRs are the viewer's — never guess.
  if (!viewerLogin) return;

  const now = Date.now();
  // Synchronous pre-filter: mine, has a head, opened recently, drafts only when
  // `reviewDrafts` is on, and not already attempted this session.
  const eligible = candidates
    .filter((c) => {
      if (!c.currentHeadSha) return false;
      if (c.author !== viewerLogin) return false;
      if (c.isDraft && !reviewDrafts) return false;
      const opened = Date.parse(c.createdAt);
      if (Number.isNaN(opened)) return false;
      if (now - opened > CATCH_UP_WINDOW_MS) return false;
      return !catchUpAttempted.has(`${repoPath}#${c.ref}@${c.currentHeadSha}`);
    })
    // Oldest first (lowest number) so the backlog drains in order, one per tick.
    .sort((a, b) => Number(a.ref) - Number(b.ref));

  const pick = eligible[0];
  if (!pick) return;

  // Mark BEFORE any await so a concurrent tick can't also claim this PR.
  catchUpAttempted.add(`${repoPath}#${pick.ref}@${pick.currentHeadSha}`);

  void catchUpEligible(repoPath, pick).then((ok) => {
    if (!ok) return;
    triggerAutomations({
      kind: "pr-open",
      repoPath,
      base: pick.base,
      head: pick.head,
      headSha: pick.currentHeadSha,
      title: pick.title,
      // The poll payload carries no body/commit subjects; the PR diff is the
      // source of truth (pr-sync already fires them empty the same way).
      body: "",
      commitSubjects: [],
      target: { type: "remote", number: Number(pick.ref) },
    });
  });
}

/**
 * Async eligibility to fire a `pr-open` review for a remote PR: true when AT LEAST
 * ONE mode still needs a first review — no prior review record (manual or automated)
 * AND no dismissed head matching the current head. Any-mode rather than both-modes,
 * so a stolen or failed mode is still retried after the other has run; the runner's
 * per-mode `pr-open` gate then skips the modes that already delivered. Errors swallow
 * to `false` (fail-closed) — a store hiccup must never fire a redundant review.
 *
 * Shared by the catch-up poller (via {@link catchUpEligible}) and the in-app
 * Mark-ready trigger (RemotePrView), so both ready paths stay identical. It's the
 * ONLY guard that covers a manual panel review: those save via `saveReview` without
 * taking an automation claim, so the runner's per-headSha claim dedup can't see them.
 */
export async function prOpenEligible(
  repoPath: string,
  ref: string,
  currentHeadSha: string,
): Promise<boolean> {
  try {
    const modes = ["general", "security"] as const;
    for (const mode of modes) {
      const prior = await getLatestReview(repoPath, "remote", ref, mode);
      if (prior) continue; // this mode already reviewed — no need on its account
      const dismissed = await getDismissedHead(repoPath, "remote", ref, mode);
      // A dismissed head matching the current head means this mode was deliberately
      // skipped for this head — it doesn't need a review either.
      if (dismissed && sameSha(dismissed, currentHeadSha)) continue;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Catch-up wrapper over {@link prOpenEligible}. Runs after the synchronous
 * attempt-mark, so a failure here won't re-enter the same PR this session.
 */
async function catchUpEligible(
  repoPath: string,
  pick: CatchUpCandidate,
): Promise<boolean> {
  return prOpenEligible(repoPath, pick.ref, pick.currentHeadSha);
}
