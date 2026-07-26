import { forgePrExternalReviews } from "@/lib/git/api";
import type { ExternalReviewItem } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { GD_COMMENT_ANCHOR } from "./comment-branding";
import { getDigest, saveDigest } from "./own-digest-store";
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
   *  ground truth. When the raw blocks exceed the own-comments budget and
   *  distillation succeeded, this is a SINGLE distilled decision-ledger block
   *  (see `ownDistilled`). Absent for local PRs, on Bitbucket, and when none
   *  were found. */
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
  opts?: { distill?: boolean; signal?: AbortSignal; ownBudgetChars?: number },
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
  // recency-first selection drops recorded decisions, so distill ALL of them
  // into a compact per-finding ledger via the app's generation model. Only when
  // asked (interactive/automation callers opt in) and only when the comments
  // genuinely can't all fit — measured on `uncappedLen`, the joined length of the
  // blocks rendered with NOTHING trimmed, i.e. the true cost of the full record.
  // Gating on the post-cap length instead was a live-caught DEAD ZONE: the
  // fair-share allocator caps every body into `budget − scaffold` by construction,
  // so the rendered blocks are ≤ budget by definition and the comparison could only
  // ever fire in the floors regime (floor × count over budget, ~12 comments at the
  // default profile). A real PR whose comments were being cut with truncation
  // markers therefore never called the distiller at all. Uncapped-vs-budget fires
  // exactly when the caps are costing content, and still spares a
  // long-but-affordable single brief.
  //
  // The distiller reads `uncappedBlocks`, not the capped render: it applies its own
  // per-block and total-input caps (with disclosure notes) to whatever it is given,
  // so feeding it the pre-trimmed blocks would compress an already-lossy record and
  // double-cut it. The capped `ownItems` remain the FALLBACK — no distill asked,
  // under budget, or any failure. Best-effort throughout: ANY failure (missing key,
  // network, abort, empty output) falls back silently to the raw recency-first
  // blocks, so distillation can never fail or delay-fail a review.
  const joinedLen = ownItems.join("\n\n").length;
  if (opts?.distill && uncappedLen > budget) {
    try {
      // Fingerprint the distilled comments so a repeat resolve with unchanged
      // comments hits the cache and never re-runs the model. Include the budget so
      // changing the Review-context knob re-distills to the right size rather than
      // serving a stale-sized ledger, and the joined post-cap length so an IN-PLACE
      // edit to a comment (which moves neither the count nor the newest timestamp)
      // still invalidates. Existing cached digests miss once and re-distill.
      //
      // `joinedLen` here stays measured off the CAPPED blocks on purpose, and the
      // prefix stays `v2`: the trigger moving to `uncappedLen` changed WHEN we
      // distill, not the ledger's text format, so re-keying would invalidate every
      // cached ledger for no gain — don't "fix" this to v3. The capped length keeps
      // exactly the edit-detection it always had (an edit that changes a body's
      // length reshuffles the fair-share caps and moves the render; one landing
      // wholly inside an already-cut tail can still hide, as before).
      //
      // The `v2` prefix retires every ledger cached with the old truncation-note
      // wording. Not because anything breaks on a re-cut — a cached note only ever
      // sits at the ledger's END, and `fitOwn`'s head-cut either drops it with the
      // tail or hits the partial-note guard, which keys off the note's HEAD (the
      // half both wordings share) — but because a cached ledger that is NEVER
      // re-cut carries the old "…on the PR thread" claim straight into the prompt,
      // pointing an agentic reviewer at a thread that has no such text. That claim
      // is exactly what the reworded note retired. One re-distill per PR buys the
      // self-heal — the same accepted cost as the fingerprint's last change.
      const newest = survivors.reduce(
        (max, it) => (it.createdAt > max ? it.createdAt : max),
        survivors[0].createdAt,
      );
      const fingerprint = `v2#${survivors.length}#${newest}#${budget}#${joinedLen}`;
      const cacheKey = `${kind}#${ref}`;

      const cached = await getDigest(repoPath, kind, ref);
      if (cached?.fingerprint === fingerprint && cached.ledger.trim()) {
        return {
          ownItems: [capLedger(cached.ledger, budget)],
          ownDistilled: true,
        };
      }

      const settings = await loadSettings();
      const ledger = await distillOwnComments({
        blocks: uncappedBlocks,
        signal: opts.signal,
        repoPath,
      });
      if (ledger?.trim()) {
        const capped = capLedger(ledger, budget);
        saveDigest(repoPath, {
          schemaVersion: 1,
          key: cacheKey,
          fingerprint,
          ledger: capped,
          model: settings.ai.model,
          createdAt: Date.now(),
        }).catch(() => undefined);
        return { ownItems: [capped], ownDistilled: true };
      }
    } catch {
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
