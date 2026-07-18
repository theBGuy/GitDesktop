import { forgePrExternalReviews } from "@/lib/git/api";
import type { ExternalReviewItem } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { GD_COMMENT_ANCHOR } from "./comment-branding";
import { getDigest, saveDigest } from "./own-digest-store";
import { distillOwnComments } from "./own-distill";
import { OWN_COMMENTS_CHAR_BUDGET } from "./truncate";

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

/** Per-comment body cap before the global budget allocator — keep one verbose
 *  review from crowding out a later, shorter refutation. Head-kept: reviews
 *  front-load their blockers and a "fixed in `<sha>`" reply is short anyway. */
const OWN_BODY_CAP = 1_500;

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
function condenseOwnComment(body: string, cap: number): string {
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
  const cleaned = kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length > cap ? `${cleaned.slice(0, cap)}…` : cleaned;
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
 *  fingerprint the cache off the exact comments the blocks were built from. */
function formatOwnComments(items: ExternalReviewItem[]): {
  blocks: string[];
  survivors: ExternalReviewItem[];
} {
  const ordered = [...items].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  );
  const blocks: string[] = [];
  const survivors: ExternalReviewItem[] = [];
  for (const it of ordered) {
    if (isOwnAiReviewBody(it.body)) continue;
    const body = condenseOwnComment(it.body, OWN_BODY_CAP);
    if (!body) continue;
    blocks.push(
      `- (${it.author}${ownLocationTag(it)})\n  ${body.replace(/\n/g, "\n  ")}`,
    );
    survivors.push(it);
  }
  return { blocks, survivors };
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

  const { blocks: ownItems, survivors } = formatOwnComments(own);
  if (ownItems.length === 0) return {};

  // Over-budget own comments accumulate across review rounds until even
  // recency-first selection drops recorded decisions, so distill ALL of them
  // into a compact per-finding ledger via the app's generation model. Only when
  // asked (interactive/automation callers opt in) and only when the joined raw
  // blocks actually exceed the section budget — under-budget comments never call
  // the model. Best-effort throughout: ANY failure (missing key, network, abort,
  // empty output) falls back silently to the raw recency-first blocks, so
  // distillation can never fail or delay-fail a review.
  // The distill trigger and the ledger cap both key off the SAME budget the rest
  // of the prompt scales to (the user's Review-context knob, resolved before this
  // call and threaded in as `ownBudgetChars`) — not the fixed 6K constant — so the
  // knob actually reaches the own-comments section. Defaults to the constant when
  // no profile is supplied (the non-review generation paths).
  const budget = opts?.ownBudgetChars ?? OWN_COMMENTS_CHAR_BUDGET;
  const joinedLen = ownItems.join("\n\n").length;
  if (opts?.distill && joinedLen > budget) {
    try {
      // Fingerprint the distilled comments so a repeat resolve with unchanged
      // comments hits the cache and never re-runs the model. Include the budget so
      // changing the Review-context knob re-distills to the right size rather than
      // serving a stale-sized ledger.
      const newest = survivors.reduce(
        (max, it) => (it.createdAt > max ? it.createdAt : max),
        survivors[0].createdAt,
      );
      const fingerprint = `${survivors.length}#${newest}#${budget}`;
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
        blocks: ownItems,
        signal: opts.signal,
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
 *  that). The cap is the profile-scaled budget, not the fixed constant. */
function capLedger(ledger: string, cap: number): string {
  return ledger.length > cap ? `${ledger.slice(0, cap)}…` : ledger;
}
