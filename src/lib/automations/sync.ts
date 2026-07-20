import { getLatestReview } from "@/lib/pulls/reviews-history";
import { getDismissedHead } from "./dismissals";
import { triggerAutomations } from "./runner";

/**
 * Per-`(kind, repo, ref)` last head we already fired a pr-sync event for. A head
 * change fires at most once — not on every poll tick — so the watchers can call
 * `maybeFireSync` freely. The runner does the real work (per-mode watermark gate
 * + build-on-prior); this just debounces the trigger by head.
 *
 * Intentionally never reclaimed (the dedup must survive a repo view unmounting),
 * so it holds one small entry per distinct PR observed this session — a bounded,
 * negligible footprint that resets on restart.
 */
const lastFiredHead = new Map<string, string>();

/**
 * Whether two commit SHAs refer to the same commit, tolerating a short-vs-full
 * mismatch. Providers disagree on length: pr-open events seed the FULL 40-char
 * local sha, while Bitbucket's poll delivers a 12-char short sha for the same
 * head. A plain `===` would then treat every poll tick as a new head and re-fire
 * pr-sync forever. An exact-equal fast path returns true for any equal non-empty
 * value (identical SHAs are trivially the same commit, whatever their length).
 * Otherwise it prefix-matches by the shorter sha — and ONLY that prefix path
 * requires ≥7 chars (git's minimum unambiguous length), so a stray empty/1-char
 * value can't false-match a longer one.
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
 * Fires a `pr-sync` automation event when an open PR's head has advanced since
 * the last time we fired for it. Deduped by head, so an unchanged PR observed on
 * every poll never re-fires. The runner gates whether to actually review (only a
 * PR already reviewed in a mode, whose head is past that mode's watermark).
 */
export function maybeFireSync(c: SyncCandidate): void {
  if (!c.currentHeadSha) return;
  const key = `${c.kind}:${c.repoPath}#${c.ref}`;
  const prior = lastFiredHead.get(key);
  // sameSha (not `===`) so a short-vs-full sha for the SAME head (Bitbucket's
  // 12-char poll head vs a full-40 seed) doesn't re-fire on every poll tick.
  if (prior !== undefined && sameSha(prior, c.currentHeadSha)) return;
  lastFiredHead.set(key, c.currentHeadSha);
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
 * How recently a PR must have been opened to earn an initial catch-up review.
 * Bounds the reach of the catch-up so an old backlog of un-reviewed PRs doesn't
 * fan out a burst of (paid) reviews the first time a rule is enabled — only PRs
 * you opened in the last two weeks are candidates. A `createdAt` that is missing
 * or unparsable fails CLOSED (not eligible).
 */
const CATCH_UP_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Per-`(repoPath, ref, headSha)` catch-up attempts made this session. Marked
 * SYNCHRONOUSLY (before any await) so a poll tick racing an in-flight async
 * eligibility check can't double-enter the same PR. Entries stay even when
 * eligibility later fails — a review record doesn't un-exist mid-session, and a
 * genuinely missed catch-up is retried after a restart (this Set resets then).
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
 * Synthesizes the initial `pr-open` automation event for a PR that was opened
 * OUTSIDE GitDesktop (gh CLI, the web, a bot flow) and so never got its initial
 * automated review.
 *
 * Why this exists — the two-trigger gap: `pr-open` events fire ONLY from the
 * app's own Create-PR dialogs, and the `pr-sync` runner deliberately skips any
 * PR with no prior review record (`!prior → continue`). A PR you opened with
 * `gh pr create` therefore falls between both triggers and never gets a first
 * pass. This closes that gap by detecting such a PR on the existing poll tick
 * and firing the same `pr-open` event an in-app create would — which then flows
 * through the untouched runner (claim dedup → review → post → record → toast).
 * Do NOT "simplify" this away: without it, externally-opened PRs get zero signal.
 *
 * Scope is deliberately narrow (user-locked): the viewer's OWN, open, recent
 * PRs with no prior review (any mode) and no dismissed head. Drafts are included
 * only when `reviewDrafts` is set (the `reviewDraftPrs` setting); off (the
 * default) they're skipped until marked ready for review. At most ONE PR is
 * caught up per call (the oldest), bounding burst token spend — the next tick
 * takes the next one.
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
  // Synchronous pre-filter: mine, non-draft, has a head, opened recently, and
  // not already attempted this session. `createdAt` fails closed on missing/
  // unparsable — an undated PR is never eligible.
  const eligible = candidates
    .filter((c) => {
      if (!c.currentHeadSha) return false;
      if (c.author !== viewerLogin) return false;
      // Drafts are caught up only when the reviewDraftPrs setting is on;
      // otherwise they wait until marked ready for review.
      if (c.isDraft && !reviewDrafts) return false;
      const opened = Date.parse(c.createdAt);
      if (Number.isNaN(opened)) return false;
      if (now - opened > CATCH_UP_WINDOW_MS) return false;
      return !catchUpAttempted.has(`${repoPath}#${c.ref}@${c.currentHeadSha}`);
    })
    // Oldest PR first (lowest number) — one per tick, so the backlog drains in
    // number order rather than picking an arbitrary one.
    .sort((a, b) => Number(a.ref) - Number(b.ref));

  const pick = eligible[0];
  if (!pick) return;

  // Mark BEFORE any await so a concurrent tick can't also claim this PR. Left
  // marked even if the async eligibility below rejects it (see the Set's doc).
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
 * Async eligibility for a catch-up: true only when NO review record exists for
 * this PR in EITHER mode (a manual OR automated review in general or security
 * counts as "the user knows this PR" and suppresses catch-up), and no dismissed
 * head matches the current head in either mode. Errors swallow to `false` — a
 * store hiccup must never fire a redundant review. Runs after the synchronous
 * attempt-mark, so a failure here won't re-enter the same PR this session.
 */
async function catchUpEligible(
  repoPath: string,
  pick: CatchUpCandidate,
): Promise<boolean> {
  try {
    const modes = ["general", "security"] as const;
    for (const mode of modes) {
      const prior = await getLatestReview(repoPath, "remote", pick.ref, mode);
      if (prior) return false;
      const dismissed = await getDismissedHead(
        repoPath,
        "remote",
        pick.ref,
        mode,
      );
      if (dismissed && sameSha(dismissed, pick.currentHeadSha)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
