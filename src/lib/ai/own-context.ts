import { forgePrExternalReviews } from "@/lib/git/api";
import type { ExternalReviewItem, RemoteLens } from "@/lib/git/types";
import { GD_COMMENT_ANCHOR } from "./comment-branding";
import {
  digestKey,
  getDigest,
  recordDigestFailure,
  saveDigest,
} from "./own-digest-store";
import { distillOwnComments } from "./own-distill";
import {
  allocateBodyCaps,
  capBody,
  OWN_COMMENTS_CHAR_BUDGET,
} from "./truncate";

/** What `buildReviewPrompt` needs about GitDesktop's OWN prior comments on a PR. */
export interface OwnCommentsContext {
  /** One formatted block per comment GitDesktop itself posted on this PR — agent
   *  follow-ups (refutations, "fixed in `<sha>`" replies) and thread replies, oldest
   *  first. Our own posted AI review/audit bodies are EXCLUDED (redundant with the
   *  prior-review section). Soft resolution context, never ground truth.
   *  Replaced by a SINGLE distilled ledger block only when the caller opts into
   *  distillation, the caps would cost content, and the distill succeeds (see
   *  `ownDistilled`) — any failure falls back to these blocks. Absent for local
   *  PRs, on Bitbucket, and when none were found. */
  ownItems?: string[];
  /** True when `ownItems` is a machine-distilled decision ledger (one block)
   *  rather than the raw per-comment blocks — flips the prompt's own-section
   *  preamble so the model frames it as a compressed summary. */
  ownDistilled?: boolean;
}

/** Per-comment body FLOOR under the fair-share allocator: every comment is
 *  guaranteed at least this many chars, so one verbose review can never crowd out
 *  a later short refutation. NOT a ceiling — a comment's cap is its max-min share
 *  of the section budget. Head-kept: reviews front-load their blockers.
 *
 *  When `OWN_BODY_FLOOR × count > budget` the FOLLOW-UPS degenerate to
 *  floor-for-all (the oldest block keeps its reserve, below) and the caps
 *  over-allocate the section budget — by design: these caps decide how the budget
 *  is SHARED, while `fitOwn` (truncate.ts) stays the hard enforcement, dropping
 *  the MIDDLE comments first, with distillation firing before it. */
const OWN_BODY_FLOOR = 1_500;

/** Share of the section budget reserved for the OLDEST comment before the rest
 *  fair-share the remainder. Mirrors `fitOwn`'s pin fraction (`truncate.ts`,
 *  `Math.floor(cap * 0.35)`) so the same block is protected by the same fraction
 *  at both stages — see `allocateWithOpenerReserve` on why the bases differ.
 *
 *  Without it the opener is just another block, so the moment the floors regime
 *  hits it collapses to `OWN_BODY_FLOOR` in ONE step — at the 4th own comment on
 *  the default (1×) budget. That block is the pre-empt artifact (the author's
 *  opening context comment): losing most of it re-opens every finding it
 *  pre-empted, and the loss grows with round count. */
const OPENER_RESERVE_SHARE = 0.35;

/** Fair-share caps with the OLDEST block's share pre-reserved: a FLOOR under the
 *  opener, never a ceiling. The plain allocation runs first and is returned
 *  UNCHANGED whenever it already clears the reserve — which covers every case
 *  where the record fits, so the un-pressured path stays byte-identical. Only in
 *  the floors regime is the reserve taken off the top and the remainder
 *  fair-shared across the follow-ups.
 *
 *  The reserve is a fraction of `sectionBudget` (the section's FULL budget), not
 *  of `budget` (round 2 passes it net of scaffolding): `fitOwn` pins the same
 *  block at 35% of its own cap, so sizing against the netted figure would trim
 *  the opener HERE for room the next stage was willing to give it.
 *  Over-allocating is the safe side — `fitOwn` re-cuts with a disclosed note,
 *  whereas under-allocating discards text no later stage can bring back.
 *
 *  Like `allocateBodyCaps`, the result can sum past `budget`; `fitOwn` remains
 *  the hard enforcement. */
function allocateWithOpenerReserve(
  lengths: number[],
  budget: number,
  sectionBudget: number,
): number[] {
  const plain = allocateBodyCaps(lengths, budget, OWN_BODY_FLOOR);
  // A lone block has no follow-ups to reserve a share from.
  if (lengths.length < 2) return plain;
  const reserve = Math.min(
    lengths[0],
    Math.floor(sectionBudget * OPENER_RESERVE_SHARE),
  );
  if (plain[0] >= reserve) return plain;
  return [
    reserve,
    ...allocateBodyCaps(
      lengths.slice(1),
      Math.max(0, budget - reserve),
      OWN_BODY_FLOOR,
    ),
  ];
}

/** How long a remembered distillation FAILURE suppresses another attempt at the same
 *  comments. The record is keyed on the COMMENTS, but what usually fails is a property
 *  of the MODEL (no API key, CLI not logged in, network, ceiling) — none of which move
 *  the fingerprint, so without a window a fixed config would never get a ledger until
 *  someone edited a comment. An hour bounds a broken config to one 135–180s attempt
 *  per hour and lets every fixable cause heal on its own. */
const DISTILL_RETRY_AFTER_MS = 60 * 60 * 1000;

/** Share of the section budget the per-comment caps may swallow before a distilled
 *  ledger beats the trimmed render (arm 2 of the trigger below). */
const DISTILL_TRIM_SHARE = 0.25;

/**
 * Strips the branded wrapper from a GitDesktop-authored comment so only the substance
 * feeds the prompt — POSITIONALLY (the wrapper's own header, footer, bracketing rules),
 * never by content, so an interior `---` or a body line that merely mentions the app
 * URL survives. Both footers are a single trailing `_Posted by [GitDesktop](…)_` line,
 * so we drop from the LAST anchor-bearing line onward; the header is only ever the
 * first non-blank line.
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

/** A short "where + state" tag for an inline comment or thread reply. Plain
 *  conversation comments (no anchor) get none; anchored items get `path:line` plus
 *  resolved/outdated flags (themselves resolution signals) and a `reply` flag so the
 *  model reads a follow-up as inside a thread. */
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

/** Whether a body is one of OUR OWN posted AI review/audit bodies (branded first
 *  line). Redundant with the prompt's prior-review section and they crowd the
 *  own-comments budget, so they're dropped; refutations, replies and "fixed in
 *  `<sha>`" notes share the footer anchor but not this header, and stay. */
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
 *  `allocateWithOpenerReserve` and the scaffolding reserve below) and pass 2
 *  renders each body under its own cap. Capping per comment BEFORE the section
 *  budget is known would floor a lone long brief with the budget almost unspent. */
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
  // two-space continuation indent on every body newline, and the `\n\n` joiner —
  // all of which count against the budget `fitOwn` and the distill trigger
  // measure. Unreserved, the blocks were over-allocated by construction, so
  // `fitOwn` trimmed comments that would have fit and the distill trigger fired
  // on scaffolding. The newline term uses `body.slice(0, provisionalCap)` so a
  // long comment can't reserve for newlines its cap will cut away; round 2's caps
  // are ≤ round 1's (both take the opener's reserve off the same section budget),
  // keeping the count an upper bound (+1 covers `capBody`'s note line). Worst
  // case is slightly under-using the budget.
  const lengths = cleaned.map((c) => c.body.length);
  const provisional = allocateWithOpenerReserve(lengths, budget, budget);
  let scaffold = 0;
  cleaned.forEach(({ prefix, body }, i) => {
    scaffold +=
      prefix.length + 2 + 2 * body.slice(0, provisional[i]).split("\n").length;
  });

  const caps = allocateWithOpenerReserve(
    lengths,
    Math.max(0, budget - scaffold),
    budget,
  );
  const blocks = cleaned.map(({ body, prefix }, i) => {
    const capped = capBody(body, caps[i]);
    return `${prefix}${capped.replace(/\n/g, "\n  ")}`;
  });
  // The same blocks with NOTHING trimmed. Same `prefix` (resolved once above, so the
  // two renders can never drift on the author/location line); only the body differs.
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
 * Loads the comments GitDesktop itself posted on a remote PR — agent refutations,
 * thread replies, "fixed in `<sha>`" notes — as soft resolution context, so a
 * re-review doesn't cold-raise something already addressed. Our own posted AI review
 * bodies are excluded (redundant with the prior-review section). Best-effort and
 * remote-only, mirroring `resolveExternalContext`: a non-remote kind, non-numeric ref,
 * Bitbucket (no review-activity harvest), or any fetch failure yields `{}`.
 *
 * Detection keys off the shared `https://gitdesktop.app` footer anchor in the comment
 * BODY, not the author — the frontend review posts under the user's own account while
 * the MCP agent / GitLab bot post under other identities; only the anchor is common.
 */
export async function resolveOwnCommentsContext(
  repoPath: string,
  lens: RemoteLens,
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
    // Origin-pinned: AI review context reads the fork's OWN PR; an upstream-lens
    // review is a separate follow-up.
    items = await forgePrExternalReviews(repoPath, prNumber, "origin");
  } catch {
    return {};
  }
  const own = items.filter((it) => it.body.includes(GD_COMMENT_ANCHOR));
  if (own.length === 0) return {};

  // The per-comment caps, the distill trigger, and the ledger cap all key off the SAME
  // budget as the rest of the prompt (the user's Review-context knob, threaded in as
  // `ownBudgetChars`) — not the fixed 6K constant, which is only a defensive default
  // for a caller that doesn't pass one.
  const budget = opts?.ownBudgetChars ?? OWN_COMMENTS_CHAR_BUDGET;

  const {
    blocks: ownItems,
    uncappedBlocks,
    uncappedLen,
    survivors,
  } = formatOwnComments(own, budget);
  if (ownItems.length === 0) return {};

  // Over-budget own comments accumulate across rounds until even recency-first
  // selection drops recorded decisions, so distill ALL of them into a compact
  // per-finding ledger via the app's generation model — only when asked, and only when
  // NOT distilling costs something. Two arms, because the section loses content two
  // different ways:
  //   • DROPS (`cappedJoinedLen > budget`): `fitOwn` discards WHOLE middle blocks with
  //     nothing saying they existed — always material, at any size. This is the floors
  //     regime, where the caps over-allocate past the budget by design.
  //   • TRIMS (`uncappedLen − cappedJoinedLen > budget × DISTILL_TRIM_SHARE`):
  //     everything fits and every cut discloses itself via `capBody`. A disclosed tail
  //     is cheaper than compressing the record, so only a cut past a quarter of the
  //     budget is worth a ledger plus a multi-minute model call.
  //
  // Arm 1 alone is NOT the whole trigger: capping guarantees the render fits, so
  // `cappedJoinedLen > budget` can only ever be true in the floors regime — as a
  // sole condition it left a real over-budget PR, visibly cut with truncation
  // markers, never calling the distiller at all.
  //
  // DELIBERATELY no absolute floor under arm 2: at the smallest profile almost any
  // multi-comment PR is floors-regime, arm 1 fires, and a ledger IS strictly better
  // content than the one partial block `fitOwn` would keep; the fingerprint cache
  // bounds the cost to one call per change to the comments.
  //
  // The distiller reads `uncappedBlocks`, not the capped render: it applies its own
  // caps to whatever it is given — its per-block cap cuts with disclosure notes, and
  // a whole block dropped by its input cap is disclosed by a marker block — so
  // feeding it the pre-trimmed blocks would compress an already-lossy record and
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
    // Fingerprint the distilled comments so a repeat resolve with unchanged comments
    // hits the cache and never re-runs the model. The budget is in it so changing the
    // Review-context knob re-distills to the right size. BOTH lengths are in it:
    // `cappedJoinedLen` pins the section render the ledger was sized against, while
    // `uncappedLen` pins the distiller's actual INPUT — an edit appended PAST a block's
    // cap changes what the model reads while the count, newest timestamp and capped
    // render all stay identical (`ExternalReviewItem` has no `updatedAt`).
    // The leading version tag covers what the FIELDS can't express: bump it when the
    // ledger TEXT we'd produce today changes, not merely when the token reshapes. A
    // record with a stale token simply misses once and re-distills.
    //
    // `v4`: the distiller's per-block cap became a share of its input cap
    // (`distillBlockCap`, own-distill.ts), so the same fields now yield a
    // different ledger — no field moves, hence the tag.
    const fingerprint = `v4#${survivors.length}#${newest}#${budget}#${cappedJoinedLen}#${uncappedLen}`;
    const cacheKey = digestKey(lens, kind, ref);
    // The generation model this attempt used, reported by the distiller as soon as it
    // resolves settings (one load, not two that could disagree). Empty if that load
    // threw or the provider runs on its account-default model.
    let attemptedModel = "";
    // Remember a dead end so the next re-review of these SAME comments doesn't re-pay
    // the ceiling (up to 180s on a CLI model) to reach the same nothing. Both failure
    // shapes route here: the attempt THREW, or it returned EMPTY (which
    // `distillOwnComments` reports as `null`). Fire-and-forget like the success path —
    // a store write must never turn a swallowed distill failure into a thrown one.
    //
    // MERGE, never replace — inside the store's serialized queue in
    // `recordDigestFailure`, not here. The failure memory carries its OWN fingerprint,
    // so merging leaves an earlier round's cached ledger intact and still hittable;
    // reading here and writing there would let a concurrent run's stale spread erase a
    // ledger that just landed. Writers ride the chain — the settings-store house pattern.
    //
    // NOT recorded when the CALLER aborted: a dock Cancel says nothing about whether
    // these comments can be distilled. The internal ceiling is a separate signal
    // composed inside `distillOwnComments`, so a timeout still records.
    const rememberFailure = async () => {
      if (opts.signal?.aborted) return;
      await recordDigestFailure(repoPath, lens, kind, ref, {
        fingerprint,
        at: Date.now(),
        model: attemptedModel,
      });
    };
    try {
      const cached = await getDigest(repoPath, lens, kind, ref);
      if (cached?.fingerprint === fingerprint && cached.ledger.trim()) {
        return {
          ownItems: [capLedger(cached.ledger, budget)],
          ownDistilled: true,
        };
      }
      // No usable ledger, but we may already have tried these exact comments and
      // failed — `failed` carries its own fingerprint precisely so this is asked
      // independently of the ledger. Inside the window take the raw blocks; past it
      // fall through and retry, and any change to the comments re-keys immediately.
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

/** Safety net: hard-cap the distilled ledger at the resolved own-comments budget (the
 *  model is asked for ~3500 chars, but never trust that). Through `capBody` so the cut
 *  is disclosed in the standard note format — a bare `…` is invisible to
 *  `stripTruncationNote`, so a ledger cut here and again by `fitOwn` would have
 *  disclosed only the second cut. */
function capLedger(ledger: string, cap: number): string {
  return capBody(ledger, cap);
}
