import { forgePrExternalReviews } from "@/lib/git/api";
import type { ExternalReviewItem } from "@/lib/git/types";
import { GD_COMMENT_ANCHOR } from "./comment-branding";
import { getDigest, recordDigestFailure, saveDigest } from "./own-digest-store";
import { distillOwnComments } from "./own-distill";
import {
  allocateBodyCaps,
  capBody,
  OWN_COMMENTS_CHAR_BUDGET,
} from "./truncate";

/** What `buildReviewPrompt` needs about GitDesktop's OWN prior comments on a PR. */
export interface OwnCommentsContext {
  /** One formatted block per comment GitDesktop itself posted on this PR — agent
   *  follow-ups (refutations, "fixed in `<sha>`" replies) and thread replies,
   *  oldest first. Our own posted AI review/audit bodies are EXCLUDED (they're
   *  redundant with the prior-review section). Soft resolution context, never
   *  ground truth. When the section can't render the whole record — the caps would
   *  drop whole comments outright, or trim away more than a quarter of the budget —
   *  and distillation succeeded, this is a SINGLE distilled decision-ledger block
   *  (see `ownDistilled`) instead. Absent for local PRs, on Bitbucket, and when
   *  none were found. */
  ownItems?: string[];
  /** True when `ownItems` is a machine-distilled decision ledger (one block)
   *  rather than the raw per-comment blocks — flips the prompt's own-section
   *  preamble so the model frames it as a compressed summary. */
  ownDistilled?: boolean;
}

/** Per-comment body FLOOR under the fair-share allocator — every comment is
 *  guaranteed at least this many characters, so one verbose review can never
 *  crowd out a later, shorter refutation. It is NOT a ceiling: a comment's actual
 *  cap is its max-min share of the section budget, which is larger whenever
 *  shorter comments leave slack. Head-kept: reviews front-load their blockers and
 *  a "fixed in `<sha>`" reply is short anyway.
 *
 *  When `OWN_BODY_FLOOR × count > budget` the allocation degenerates to
 *  floor-for-all and the caps therefore over-allocate the section budget — that
 *  is by design, not a bug: these caps decide how the budget is SHARED, while
 *  `fitOwn` (truncate.ts) stays the hard enforcement — dropping the MIDDLE
 *  comments first, keeping the opening brief and the newest follow-ups — with
 *  distillation firing before it in the over-budget regime. */
const OWN_BODY_FLOOR = 1_500;

/** How long a remembered distillation FAILURE suppresses another attempt at the
 *  same comments. The failure record is keyed on the COMMENTS (the fingerprint),
 *  but what usually fails is a property of the MODEL: no generation API key yet, a
 *  CLI not logged in, a network blip, a run that outlasted the ceiling. None of
 *  those move the fingerprint, so without a window the user could add the missing
 *  key and still never get a ledger until someone edited a comment. An hour keeps
 *  the point of the memory — a broken config costs one 135–180s attempt per hour,
 *  not one per re-review — while letting every fixable cause heal on its own. */
const DISTILL_RETRY_AFTER_MS = 60 * 60 * 1000;

/** Share of the section budget the per-comment caps may swallow before a distilled
 *  ledger beats the trimmed render — the trigger block below argues the number. */
const DISTILL_TRIM_SHARE = 0.25;

/**
 * Strips the branded wrapper from a GitDesktop-authored comment so only the
 * substance feeds the prompt — done POSITIONALLY (drop the wrapper's own header,
 * footer, and bracketing rules) rather than by content, so it never eats the
 * comment's real text: an interior `---` (a section rule, or a YAML/`---`
 * separator inside a code fence) or a body line that merely mentions the app's
 * own URL both survive.
 *
 * Both footers (the frontend AI-review one and the MCP agent one) are a single
 * trailing `_Posted by [GitDesktop](…)_` line, so we drop from the LAST
 * anchor-bearing line onward — which also spares an earlier legitimate mention of
 * the URL in the body. The header is only ever the first line, so we strip it
 * only when the first non-blank line is the branded one.
 */
function condenseOwnComment(body: string): string {
  const lines = body.split("\n");
  // Footer: everything from the last anchor-bearing line to the end.
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(GD_COMMENT_ANCHOR)) {
      end = i;
      break;
    }
  }
  let kept = lines.slice(0, end);
  // Header: only the first non-blank line, and only if it's the branded one.
  const firstNonBlank = kept.findIndex((l) => l.trim() !== "");
  if (
    firstNonBlank >= 0 &&
    /^🤖\s*\*\*GitDesktop/.test(kept[firstNonBlank].trim())
  ) {
    kept = kept.slice(firstNonBlank + 1);
  }
  // Trim ONLY the wrapper's `---` rules + blank lines that bracket the body;
  // leave any interior `---` untouched.
  const isRuleOrBlank = (l: string) => l.trim() === "" || /^\s*---\s*$/.test(l);
  while (kept.length > 0 && isRuleOrBlank(kept[0])) kept.shift();
  while (kept.length > 0 && isRuleOrBlank(kept[kept.length - 1])) kept.pop();
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A short "where + state" tag for an inline comment or a thread reply. Plain
 *  conversation comments (no anchor) get no tag; anchored `inline`/`reply` items
 *  get the `path:line` — and a resolved/outdated thread flag, itself a resolution
 *  signal. A `reply` also carries a `reply` flag so the model reads it as a
 *  follow-up inside a thread rather than a top-level comment. */
function ownLocationTag(item: ExternalReviewItem): string {
  if ((item.kind !== "inline" && item.kind !== "reply") || !item.path)
    return "";
  const loc = item.line > 0 ? `${item.path}:${item.line}` : item.path;
  const flags: string[] = [];
  if (item.kind === "reply") flags.push("reply");
  if (item.isOutdated) flags.push("outdated");
  if (item.isResolved) flags.push("resolved thread");
  const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
  return ` on \`${loc}\`${suffix}`;
}

/** Whether a comment body is one of OUR OWN posted AI review/audit bodies (its
 *  first non-blank line is the branded review header). Those are redundant with
 *  the prompt's prior-review section and only crowd the own-comments budget, so
 *  they're dropped here; triage refutations, thread replies, and "fixed in
 *  `<sha>`" notes carry the same footer anchor but not this header, and stay. */
function isOwnAiReviewBody(body: string): boolean {
  const firstNonBlank = body.split("\n").find((l) => l.trim() !== "");
  return (
    firstNonBlank !== undefined &&
    /^🤖\s*\*\*GitDesktop/.test(firstNonBlank.trim())
  );
}

/** Formats our own comments oldest → newest as one block per comment, so the
 *  model reads the original context before any later refutation / "fixed in
 *  `<sha>`" follow-up under it. Our own AI review/audit bodies are excluded
 *  first (redundant with the prior-review section). Returns the rendered blocks
 *  alongside the raw items that survived filtering (same order), so the caller can
 *  fingerprint the cache off the exact comments the blocks were built from.
 *
 *  Also returns the SAME blocks rendered from the UNCAPPED bodies
 *  (`uncappedBlocks`, and `uncappedLen` for their joined length): what the full
 *  record would cost if nothing were trimmed. That is what the distill trigger
 *  measures and what the distiller reads — the capped `blocks` can never exceed
 *  the budget by construction, so they cannot answer "does this all fit?".
 *
 *  Two passes, because each body's cap depends on all the others: pass 1 strips
 *  the wrappers and drops the excluded/empty comments, then the surviving lengths
 *  are fair-shared across `budget` net of the rendered scaffolding (see
 *  `allocateBodyCaps` and the reserve below) and pass 2 renders each body under
 *  its own cap. Capping per comment BEFORE knowing the section budget was the old
 *  bug — a single long brief was cut to the floor even with the budget almost
 *  entirely unspent. */
function formatOwnComments(
  items: ExternalReviewItem[],
  budget: number,
): {
  blocks: string[];
  uncappedBlocks: string[];
  uncappedLen: number;
  survivors: ExternalReviewItem[];
} {
  const ordered = [...items].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  );
  const cleaned: { item: ExternalReviewItem; body: string; prefix: string }[] =
    [];
  for (const it of ordered) {
    if (isOwnAiReviewBody(it.body)) continue;
    const body = condenseOwnComment(it.body);
    if (!body) continue;
    // Resolved once, so the reserve below is charged against exactly what pass 2
    // renders.
    cleaned.push({
      item: it,
      body,
      prefix: `- (${it.author}${ownLocationTag(it)})\n  `,
    });
  }

  // Same scaffolding reserve as the external section: the caps govern BODY
  // length, but each rendered block also carries its `- (author …)` line, the
  // two-space continuation indent on every body newline, and the `\n\n` joiner to
  // the next block — all of which count against the budget `fitOwn` and the
  // distill trigger measure. Charging it here is what makes those two comparisons
  // apples-to-apples; unreserved, the blocks were over-allocated by construction,
  // so `fitOwn` trimmed comments that would have fit and the distill trigger
  // fired on scaffolding. The newline term uses `body.slice(0, provisionalCap)`
  // (round 1 allocates with no scaffolding) so a long multi-line comment can't
  // reserve for newlines its cap will cut away; round 2's caps are ≤ round 1's,
  // keeping the count an upper bound (+1 covers `capBody`'s note line), and the
  // only failure mode is slightly under-using the budget.
  const lengths = cleaned.map((c) => c.body.length);
  const provisional = allocateBodyCaps(lengths, budget, OWN_BODY_FLOOR);
  let scaffold = 0;
  cleaned.forEach(({ prefix, body }, i) => {
    scaffold +=
      prefix.length + 2 + 2 * body.slice(0, provisional[i]).split("\n").length;
  });

  const caps = allocateBodyCaps(
    lengths,
    Math.max(0, budget - scaffold),
    OWN_BODY_FLOOR,
  );
  const blocks = cleaned.map(({ body, prefix }, i) => {
    const capped = capBody(body, caps[i]);
    return `${prefix}${capped.replace(/\n/g, "\n  ")}`;
  });
  // The same blocks with NOTHING trimmed — the true cost of the whole record.
  // Same `prefix` (resolved once above, so the two renders can never drift on the
  // author/location line) and the same continuation indent; only the body differs.
  const uncappedBlocks = cleaned.map(
    ({ body, prefix }) => `${prefix}${body.replace(/\n/g, "\n  ")}`,
  );
  return {
    blocks,
    uncappedBlocks,
    uncappedLen: uncappedBlocks.join("\n\n").length,
    survivors: cleaned.map((c) => c.item),
  };
}

/**
 * Loads the comments GitDesktop itself has posted on a remote PR — agent
 * refutations, thread replies, and "fixed in `<sha>`" notes — as soft resolution
 * context, so a re-review doesn't cold-raise something the team already
 * addressed. Our own posted AI review/audit bodies are excluded (they're
 * redundant with the prompt's prior-review section). Best-effort and remote-only,
 * mirroring `resolveExternalContext`: a non-remote kind, a non-numeric ref,
 * Bitbucket (no review-activity harvest — an empty no-network `[]`), or any fetch
 * failure yields `{}`. Never the source of truth; the current diff always wins.
 *
 * Detection keys off the shared `https://gitdesktop.app` footer anchor in the
 * comment BODY, not the author — the frontend AI review posts under the user's
 * own account while the MCP agent / GitLab review-bot post under a different
 * identity; only the anchor is common to all our comment paths.
 */
export async function resolveOwnCommentsContext(
  repoPath: string,
  kind: "remote" | "local",
  ref: string,
  provider: string = "github",
  opts?: {
    distill?: boolean;
    signal?: AbortSignal;
    ownBudgetChars?: number;
    /** Progress sink for the distillation step — the one part of this harvest
     *  that can take minutes (a CLI generation model). Called only when a
     *  distill actually opens a model call; the caller clears it. */
    onStatus?: (status: string) => void;
  },
): Promise<OwnCommentsContext> {
  if (kind !== "remote" || provider === "bitbucket") return {};
  const prNumber = Number(ref);
  if (!Number.isInteger(prNumber) || prNumber <= 0) return {};

  let items: ExternalReviewItem[];
  try {
    // Origin-pinned (package B2 recorded gap): AI review context reads the fork's
    // own PR; upstream-lens AI review is a follow-up.
    items = await forgePrExternalReviews(repoPath, prNumber, "origin");
  } catch {
    return {};
  }
  const own = items.filter((it) => it.body.includes(GD_COMMENT_ANCHOR));
  if (own.length === 0) return {};

  // The per-comment caps, the distill trigger, and the ledger cap all key off the
  // SAME budget the rest of the prompt scales to (the user's Review-context knob,
  // resolved before this call and threaded in as `ownBudgetChars`) — not the fixed
  // 6K constant — so the knob actually reaches the own-comments section. The
  // constant is a defensive default: every caller today resolves the knob and
  // passes it, but a future one that doesn't still gets a sane section size.
  const budget = opts?.ownBudgetChars ?? OWN_COMMENTS_CHAR_BUDGET;

  const {
    blocks: ownItems,
    uncappedBlocks,
    uncappedLen,
    survivors,
  } = formatOwnComments(own, budget);
  if (ownItems.length === 0) return {};

  // Over-budget own comments accumulate across review rounds until even
  // recency-first selection drops recorded decisions, so distill ALL of them into
  // a compact per-finding ledger via the app's generation model. Only when asked
  // (interactive/automation callers opt in), and only when NOT distilling would
  // actually cost something — which is two different questions, because the section
  // loses content in two very different ways:
  //
  //   • DROPS (arm 1, `cappedJoinedLen > budget`). The render doesn't fit, so
  //     `fitOwn` discards WHOLE middle blocks — every word of ~2 recorded decisions,
  //     with nothing in the prompt saying they existed. That is precisely the loss
  //     distillation exists to prevent, so it is ALWAYS material, at any size. This
  //     is the floors regime: once `OWN_BODY_FLOOR × count` exceeds the budget the
  //     caps over-allocate past it by design (13 × 1,600-char comments at an 18K
  //     budget land here, and under a pure threshold test their ~3.9K overshoot read
  //     as "immaterial" while two decisions silently vanished).
  //   • TRIMS (arm 2, `uncappedLen − cappedJoinedLen > budget × DISTILL_TRIM_SHARE`).
  //     Everything fits; the fair-share caps just cut tails, and every cut discloses
  //     itself inline via `capBody`. Losing a tail is far cheaper than compressing
  //     the record, so here a threshold is right: only when the caps swallow more
  //     than a quarter of the budget is a ledger the better trade. PR #125's own
  //     numbers — 18,759 uncapped against a 17,978 render at 18,000 — sit in this
  //     arm at 781 chars, and deliberately do NOT distill: a disclosed 781-char trim
  //     beats a ~3.5K ledger plus a measured 135s CLI call.
  //
  // Both arms replace `cappedJoinedLen > budget` alone, which was a live-caught DEAD
  // ZONE — capping guarantees the render fits, so it could only ever fire in the
  // floors regime and a real PR being cut with truncation markers never called the
  // distiller at all.
  //
  // DELIBERATELY no absolute floor under the arm-2 threshold. At the smallest
  // context profile (a 1,000-char section) almost any multi-comment PR is
  // floors-regime by construction, so arm 1 fires and we spend a model call to
  // produce a 1,000-char ledger. That is the right call, not a bug to "fix": at that
  // size `fitOwn` would keep barely one partial block, so the ledger is strictly
  // better content, and the fingerprint cache bounds the cost to one call per change
  // to the comments.
  //
  // The distiller reads `uncappedBlocks`, not the capped render: it applies its own
  // per-block and total-input caps (with disclosure notes) to whatever it is given,
  // so feeding it the pre-trimmed blocks would compress an already-lossy record and
  // double-cut it. The capped `ownItems` remain the FALLBACK — no distill asked,
  // immaterial trim, or any failure. Best-effort throughout: ANY failure (missing
  // key, network, abort, empty output) falls back silently to the raw recency-first
  // blocks, so distillation can never fail or delay-fail a review.
  const cappedJoinedLen = ownItems.join("\n\n").length;
  const willDropBlocks = cappedJoinedLen > budget;
  const trimmedAway = uncappedLen - cappedJoinedLen;
  if (
    opts?.distill &&
    (willDropBlocks || trimmedAway > budget * DISTILL_TRIM_SHARE)
  ) {
    // Resolved BEFORE the try so the catch can record the failed attempt under the
    // very fingerprint that attempt was for.
    const newest = survivors.reduce(
      (max, it) => (it.createdAt > max ? it.createdAt : max),
      survivors[0].createdAt,
    );
    // Fingerprint the distilled comments so a repeat resolve with unchanged
    // comments hits the cache and never re-runs the model. The budget is in it so
    // changing the Review-context knob re-distills to the right size rather than
    // serving a stale-sized ledger. BOTH lengths are in it because they answer
    // different questions: `cappedJoinedLen` pins the section render this ledger
    // was sized against, while `uncappedLen` pins the distiller's actual INPUT —
    // an edit appended PAST a block's cap changes what the model reads while the
    // count, the newest timestamp and the capped render all stay identical
    // (`ExternalReviewItem` carries no `updatedAt`), and without the second term
    // that edit would be served a stale ledger forever.
    //
    // The leading version tag exists for changes the FIELDS can't express: a cached
    // ledger whose TEXT is no longer what we would produce today (it went to `v2`
    // when the truncation note stopped claiming the omitted characters are "on the
    // PR thread"). It is belt to the field count's suspenders for a token reshape —
    // `v3`'s extra field already makes a v2 string unmatchable — so bump it for a
    // text change, not merely because the token grew. Records with a stale token
    // simply miss once and re-distill.
    const fingerprint = `v3#${survivors.length}#${newest}#${budget}#${cappedJoinedLen}#${uncappedLen}`;
    const cacheKey = `${kind}#${ref}`;
    // The generation model this attempt used, reported by the distiller as soon as
    // it resolves settings (one load, not two that could disagree mid-flight).
    // Stays empty when the attempt threw before that point — genuinely unknown.
    let attemptedModel = "";
    // Remember a dead end so the next re-review of these SAME comments doesn't
    // re-pay the ceiling — up to 180s on a CLI generation model — to reach the same
    // nothing. Both shapes of failure route here: the attempt THREW (timeout,
    // missing key, network) or it returned EMPTY/whitespace, which
    // `distillOwnComments` reports as `null` rather than an error. Fire-and-forget
    // like the success path — a store write must never turn a swallowed distill
    // failure into a thrown one.
    //
    // MERGE, never replace — and the merge happens inside the store's serialized
    // queue, in `recordDigestFailure`, not here. There is one digest per PR and the
    // failure memory carries its OWN fingerprint in `failed`, so merging leaves a
    // ledger cached for an earlier round intact and still cache-hittable; replacing
    // would blank a good ledger the moment any later round failed — permanently,
    // since every new comment moves the token forward. Doing the read HERE and the
    // write there would reopen the same hole for concurrent runs (a manual review
    // and an automation hold separate single-flight keys): the loser reads a
    // pre-success snapshot, the winner's ledger lands, and the loser's stale spread
    // erases it. Writers ride the chain — the repo's settings-store house pattern.
    //
    // NOT recorded when the CALLER aborted: a dock Cancel says nothing about whether
    // these comments can be distilled, and remembering it would suppress
    // distillation for this PR until the window expires. The internal ceiling is a
    // separate signal composed inside `distillOwnComments`, so it never marks
    // `opts.signal` aborted — a timeout still records, which is the whole point.
    const rememberFailure = async () => {
      if (opts.signal?.aborted) return;
      await recordDigestFailure(repoPath, kind, ref, {
        fingerprint,
        at: Date.now(),
        model: attemptedModel,
      });
    };
    try {
      const cached = await getDigest(repoPath, kind, ref);
      if (cached?.fingerprint === fingerprint && cached.ledger.trim()) {
        return {
          ownItems: [capLedger(cached.ledger, budget)],
          ownDistilled: true,
        };
      }
      // No usable ledger, but we may have already tried these exact comments and
      // failed — `failed` carries its own fingerprint precisely so this question is
      // asked independently of whatever ledger the record holds. Inside the window,
      // re-running would re-pay the full ceiling to fail again, so take the raw
      // blocks straight away; past it we fall through and try once more, and a
      // change to the comments re-keys and retries immediately either way.
      if (
        cached?.failed?.fingerprint === fingerprint &&
        Date.now() - cached.failed.at < DISTILL_RETRY_AFTER_MS
      ) {
        return { ownItems };
      }

      const ledger = await distillOwnComments({
        blocks: uncappedBlocks,
        signal: opts.signal,
        repoPath,
        onStatus: opts.onStatus,
        onModel: (m) => {
          attemptedModel = m;
        },
      });
      if (ledger?.trim()) {
        const capped = capLedger(ledger, budget);
        // A fresh record, deliberately NOT spread over the old one: omitting
        // `failed` is what clears a previous dead end once distillation heals.
        saveDigest(repoPath, {
          schemaVersion: 1,
          key: cacheKey,
          fingerprint,
          ledger: capped,
          model: attemptedModel,
          createdAt: Date.now(),
        }).catch(() => undefined);
        return { ownItems: [capped], ownDistilled: true };
      }
      // Model produced nothing usable. Costs the same full ceiling as a throw, so
      // it is remembered the same way rather than retried every re-review.
      rememberFailure().catch(() => undefined);
    } catch {
      // (A digest READ failure lands here too and would record a spurious miss, but
      // the same broken store almost certainly rejects this write as well, so the
      // record doesn't persist and the next review retries.)
      rememberFailure().catch(() => undefined);
      // Fall through to the raw recency-first blocks below.
    }
  }

  return { ownItems };
}

/** Safety net: hard-cap the distilled ledger at the resolved own-comments section
 *  budget (the model is asked to stay ~3500 chars, well under, but never trust
 *  that). The cap is the profile-scaled budget, not the fixed constant. Through
 *  `capBody`, so the cut is disclosed in the same note format as every other one:
 *  a bare `…` is invisible to `stripTruncationNote`, so a ledger cut here and
 *  again by `fitOwn` would have disclosed only the second cut's count. */
function capLedger(ledger: string, cap: number): string {
  return capBody(ledger, cap);
}
