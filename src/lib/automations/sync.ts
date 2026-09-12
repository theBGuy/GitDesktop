import { listReviews } from "@/lib/pulls/reviews-history";
import { errorMessage } from "@/lib/tauri/invoke";
import { getDismissedHeadMap } from "./dismissals";
import {
  type AutomationOutcome,
  type AutomationOutcomeCode,
  type AutomationTrigger,
  recordAutomationActivity,
} from "./history";
import { triggerAutomations } from "./runner";
import { loadAutomations, repoAutomationsFor } from "./store";
import { type ActionId, ALL_ACTION_IDS, effectiveActions } from "./types";

/** Why one mode didn't need a first review — the two genuine-false axes, kept apart
 *  because they are different facts: a cancel writes a dismissal with no review at
 *  all, so "already reviewed" would be a lie about a PR that has zero reviews. */
interface BlockedMode {
  action: ActionId;
  code: "already-reviewed" | "head-dismissed";
}

/**
 * Per-`(kind, repo, ref)` EVERY head already fired for, `sameSha`-matched — an
 * eventually-consistent poll can re-serve a PREVIOUS head right after a push, and that
 * stale head must not fire again. Never reclaimed (the dedup must survive a repo view
 * unmounting); bounded by the real pushes per PR this session, and resets on restart.
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
  // Decisions worth durable evidence, collected DURING the synchronous pre-filter
  // and recorded afterwards — the author gate runs first, so a foreign PR (the
  // poll's majority) can never reach the store and evict the user's own rows.
  const skipped: {
    candidate: CatchUpCandidate;
    code: AutomationOutcomeCode;
    detail?: string;
  }[] = [];
  // Synchronous pre-filter: mine, has a head, opened recently, drafts only when
  // `reviewDrafts` is on, and not already attempted this session.
  const eligible = candidates
    .filter((c) => {
      if (!c.currentHeadSha) return false;
      if (c.author !== viewerLogin) return false;
      if (c.isDraft && !reviewDrafts) {
        skipped.push({ candidate: c, code: "draft-skipped" });
        return false;
      }
      const opened = Date.parse(c.createdAt);
      if (Number.isNaN(opened)) {
        // Shares the fail-closed code with a genuine window miss, but carries its
        // own reason: the age this code usually implies was never measured here.
        skipped.push({
          candidate: c,
          code: "too-old",
          detail: "Skipped — couldn't read when this pull request was opened",
        });
        return false;
      }
      if (now - opened > CATCH_UP_WINDOW_MS) {
        skipped.push({ candidate: c, code: "too-old" });
        return false;
      }
      // Already attempted this session: self-resolving, so it records nothing.
      return !catchUpAttempted.has(`${repoPath}#${c.ref}@${c.currentHeadSha}`);
    })
    // Oldest first (lowest number) so the backlog drains in order, one per tick.
    .sort((a, b) => Number(a.ref) - Number(b.ref));

  const pick = eligible[0];
  // Fire-and-forget (no await here), so the mark below still precedes every await
  // in this function. Runs even when nothing was picked — a skipped PR's evidence
  // doesn't depend on another PR being caught up. Candidates that are eligible but
  // merely NOT PICKED record nothing: that deferral resolves within minutes by
  // construction, so a durable row would be a stale lie.
  void recordCatchUpSkips(repoPath, skipped).catch(() => undefined);
  if (!pick) return;

  // Mark BEFORE any await so a concurrent tick can't also claim this PR.
  catchUpAttempted.add(`${repoPath}#${pick.ref}@${pick.currentHeadSha}`);

  void catchUpEligible(repoPath, pick).then(
    ({ eligible: ok, error, blocked }) => {
      if (!ok) {
        // An eligibility ERROR is recorded inside the core (it knows the reason); a
        // genuine false is recorded here, one outcome PER MODE — "already reviewed"
        // and "this head was dismissed" are different facts, and a cancelled run
        // writes a dismissal with no review at all.
        if (error === undefined && blocked && blocked.length > 0) {
          void recordCatchUpDecision(repoPath, pick, blocked, "catch-up").catch(
            () => undefined,
          );
        }
        return;
      }
      triggerAutomations(
        {
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
        },
        "catch-up",
      );
    },
  );
}

/** Whether this repo has any effective `pr-open` action — the gate on every row
 *  this module records, so a repo with no pr-open automation accrues none at all
 *  (its dialog's empty state teaches instead). */
async function prOpenAutomationEnabled(repoPath: string): Promise<boolean> {
  const config = await loadAutomations();
  const repo = await repoAutomationsFor(config, repoPath);
  return effectiveActions(config, repo, "pr-open").length > 0;
}

/** One action-less catch-up row for a remote PR. Best-effort by construction —
 *  `recordAutomationActivity` resolves null rather than rejecting. */
async function recordCatchUpDecision(
  repoPath: string,
  row: { ref: string; title: string; currentHeadSha: string },
  outcomes: AutomationOutcome[],
  trigger: AutomationTrigger,
): Promise<void> {
  if (!(await prOpenAutomationEnabled(repoPath))) return;
  await recordAutomationActivity(repoPath, {
    trigger,
    targetKind: "remote",
    ref: row.ref,
    title: row.title,
    headSha: row.currentHeadSha,
    outcomes,
  });
}

/** The pre-filter's skipped candidates, gated ONCE per call. Sequential so the
 *  store's own queue takes them in order; the steady upsert coalesces repeats. */
async function recordCatchUpSkips(
  repoPath: string,
  skipped: {
    candidate: CatchUpCandidate;
    code: AutomationOutcomeCode;
    detail?: string;
  }[],
): Promise<void> {
  if (skipped.length === 0) return;
  if (!(await prOpenAutomationEnabled(repoPath))) return;
  for (const { candidate, code, detail } of skipped) {
    await recordAutomationActivity(repoPath, {
      trigger: "catch-up",
      targetKind: "remote",
      ref: candidate.ref,
      title: candidate.title,
      headSha: candidate.currentHeadSha,
      outcomes: [{ action: null, code, ...(detail ? { detail } : {}) }],
    });
  }
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
  trigger: AutomationTrigger = "pr-open",
): Promise<boolean> {
  const { eligible } = await prOpenEligibleDetailed(
    repoPath,
    ref,
    currentHeadSha,
    trigger,
  );
  return eligible;
}

/**
 * The eligibility core {@link prOpenEligible} maps to a boolean, distinguishing a
 * genuine "every mode already reviewed" from a store failure that failed CLOSED —
 * the pair reads identically at the call sites, and only this layer can tell them
 * apart, so this is where the fail-closed trap leaves its evidence.
 */
async function prOpenEligibleDetailed(
  repoPath: string,
  ref: string,
  currentHeadSha: string,
  trigger: AutomationTrigger,
): Promise<{
  eligible: boolean;
  error?: string;
  /** Present on a GENUINE false: the axis that blocked each mode. Absent when the
   *  verdict came from the fail-closed catch, where nothing is known. */
  blocked?: BlockedMode[];
}> {
  try {
    // One fresh read of each store for the whole PR instead of one per mode, and the two
    // concurrently — separate stores, independent queues. `fresh` reloads from disk and
    // queues behind any writer: this is a gate, so it must see another instance's
    // just-written record, not this process's launch-time cache.
    // Origin-pinned: this gate mirrors the origin-scoped poller, so it reads the
    // fork's own PRs only.
    const [reviews, dismissedByMode] = await Promise.all([
      listReviews(repoPath, "origin", "remote", ref, { fresh: true }),
      getDismissedHeadMap(repoPath, "origin", "remote", ref, { fresh: true }),
    ]);
    // The loop already knows which arm each mode hits, so keep it rather than
    // re-deriving a reason at the log site from a bare boolean.
    const blocked: BlockedMode[] = [];
    for (const mode of ALL_ACTION_IDS) {
      // Newest-first, so this mode's first entry is the latest review for it.
      const prior = reviews.find((r) => r.mode === mode);
      if (prior) {
        // this mode already reviewed — no need on its account
        blocked.push({ action: mode, code: "already-reviewed" });
        continue;
      }
      const dismissed = dismissedByMode[mode];
      // A dismissed head matching the current head means this mode was deliberately
      // skipped for this head — it doesn't need a review either.
      if (dismissed && sameSha(dismissed, currentHeadSha)) {
        blocked.push({ action: mode, code: "head-dismissed" });
        continue;
      }
      return { eligible: true };
    }
    return { eligible: false, blocked };
  } catch (e) {
    const detail = errorMessage(e);
    // Fire-and-forget with its own catch, so the recording attempt is structurally
    // incapable of changing the verdict below. This placement is what gives the
    // Mark-ready call site (RemotePrView) evidence too.
    void recordEligibilityError(
      repoPath,
      ref,
      currentHeadSha,
      trigger,
      detail,
    ).catch(() => undefined);
    return { eligible: false, error: detail };
  }
}

/** The eligibility-error row, gated on this repo actually having a pr-open
 *  automation (an error nobody's automation would have acted on is not evidence). */
async function recordEligibilityError(
  repoPath: string,
  ref: string,
  currentHeadSha: string,
  trigger: AutomationTrigger,
  detail: string,
): Promise<void> {
  if (!(await prOpenAutomationEnabled(repoPath))) return;
  await recordAutomationActivity(repoPath, {
    trigger,
    targetKind: "remote",
    ref,
    title: "",
    headSha: currentHeadSha,
    outcomes: [{ action: null, code: "eligibility-error", detail }],
  });
}

/**
 * Catch-up wrapper over {@link prOpenEligibleDetailed}. Runs after the synchronous
 * attempt-mark, so a failure here won't re-enter the same PR this session.
 */
async function catchUpEligible(
  repoPath: string,
  pick: CatchUpCandidate,
): Promise<{ eligible: boolean; error?: string; blocked?: BlockedMode[] }> {
  return prOpenEligibleDetailed(
    repoPath,
    pick.ref,
    pick.currentHeadSha,
    "catch-up",
  );
}
