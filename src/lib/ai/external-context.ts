import { forgePrExternalReviews } from "@/lib/git/api";
import type { ExternalReviewItem } from "@/lib/git/types";
import {
  allocateBodyCaps,
  capBody,
  EXTERNAL_FINDINGS_CHAR_BUDGET,
} from "./truncate";

/** What `buildReviewPrompt` needs about third-party AI reviews on a PR. */
export interface ExternalContext {
  /** Pre-formatted, grouped findings markdown — soft, re-verifiable context.
   *  Absent when no external AI review was found. */
  externalFindings?: string;
  /** Distinct reviewer display names folded in (for the section header + UI). */
  externalReviewers?: string[];
  /** Whether any included finding was made against an earlier commit (so the
   *  model — and the user — knows it may already be addressed). */
  externalStale?: boolean;
}

/**
 * Known reviewer-bot logins → friendly display names. Conversation comments are
 * harvested ONLY from these (other bots — CI, deploy, dependabot — also post on
 * that surface); inline review comments and submitted review bodies are taken
 * from ANY bot, since only reviewer tools produce those.
 */
const REVIEWER_BOTS: Record<string, string> = {
  copilot: "GitHub Copilot",
  "copilot-pull-request-reviewer": "GitHub Copilot",
  coderabbitai: "CodeRabbit",
  "sourcery-ai": "Sourcery",
  "codium-ai": "Qodo",
  qodo: "Qodo",
  "qodo-merge-pro": "Qodo",
  "ellipsis-dev": "Ellipsis",
  greptileai: "Greptile",
  "korbit-ai": "Korbit",
  "github-advanced-security": "GitHub code scanning",
  bito: "Bito",
  "pr-agent": "PR-Agent",
  "codescene-dev": "CodeScene",
  "codeball-ai": "Codeball",
};

/** Strips the trailing `[bot]` GitHub appends to App logins (REST does, the
 *  GraphQL `login` usually doesn't — normalize either form). */
function normalizeLogin(login: string): string {
  return login.toLowerCase().replace(/\[bot\]$/, "");
}

function displayName(login: string): string {
  return REVIEWER_BOTS[normalizeLogin(login)] ?? login.replace(/\[bot\]$/, "");
}

function isReviewerBotLogin(login: string): boolean {
  return normalizeLogin(login) in REVIEWER_BOTS;
}

/**
 * Whether an item is a genuine AI-reviewer finding worth folding in.
 *
 * On GitHub, `isBot` is server truth (GraphQL `__typename == "Bot"`), so inline
 * review comments and submitted reviews from any bot qualify (only reviewers post
 * those); conversation comments only from an allowlisted reviewer bot.
 *
 * On GitLab, REST authors carry NO bot flag — the Rust mapper sets `isBot: true`
 * unconditionally — so the inline/review "any bot" bypass would let a HUMAN
 * teammate's inline diff comment ("nit: rename this") pose as an AI finding. For
 * GitLab we therefore require the author to be an allowlisted reviewer bot for
 * EVERY kind; the login allowlist (`REVIEWER_BOTS`) is the only bot truth we have,
 * and it lives in exactly one place — here.
 */
function isReviewerFinding(
  item: ExternalReviewItem,
  provider: string,
): boolean {
  // Thread replies are scoped to own-context in v1; the external section stays
  // opener-only. Note the GitLab asymmetry: GitLab replies arrive as
  // `inline`/`comment` (never `reply`) and remain admitted for allowlisted bots
  // below — unchanged, deliberate. Only the GitHub harvest emits `reply`.
  if (item.kind === "reply") return false;
  if (!item.isBot || !item.body.trim()) return false;
  if (provider === "gitlab") return isReviewerBotLogin(item.author);
  // GitHub: `isBot` is server-verified, so reviewer-only surfaces (inline/review)
  // qualify from any bot; conversation comments need the allowlist.
  if (item.kind === "inline" || item.kind === "review") return true;
  return isReviewerBotLogin(item.author);
}

/**
 * Fetches a PR's review activity and keeps only the third-party AI-reviewer
 * findings. Best-effort: any failure (no gh, network) yields an empty list —
 * external context never blocks a review. Used by the panel's banner query and by
 * `resolveExternalContext`.
 *
 * The harvest runs behind the forge abstraction (`forge_pr_external_reviews`):
 * GitHub delegates unchanged, GitLab maps MR discussions. Bitbucket has no
 * third-party AI-reviewer ecosystem, so we skip it here (the Rust arm is an empty
 * no-network `[]` anyway — skipping in one place, the frontend, avoids even the
 * IPC round trip per automated run and per panel view). The `provider` param
 * defaults to GitHub so existing callers are unchanged.
 */
export async function fetchExternalFindings(
  repoPath: string,
  prNumber: number,
  provider: string = "github",
): Promise<ExternalReviewItem[]> {
  if (provider === "bitbucket") return [];
  try {
    // Origin-pinned (package B2 recorded gap): AI review context reads the fork's
    // own PR; upstream-lens AI review is a follow-up.
    const items = await forgePrExternalReviews(repoPath, prNumber, "origin");
    return items.filter((item) => isReviewerFinding(item, provider));
  } catch {
    return [];
  }
}

/** Distinct reviewer display names in a kept set, in first-seen order. */
export function externalReviewerNames(items: ExternalReviewItem[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const it of items) {
    const name = displayName(it.author);
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/** Per-kind body FLOORS under the fair-share allocator — every kept finding is
 *  guaranteed at least this many characters, so a giant conversation summary
 *  (a CodeRabbit walkthrough) can never crowd out a later inline finding. They
 *  are NOT ceilings: a finding's actual cap is its max-min share of the section
 *  budget (see `allocateBodyCaps`), which is larger whenever the other findings
 *  leave slack — an inline finding stays tight because it IS short, not because
 *  it's clamped. When the floors alone exceed the budget the allocation
 *  degenerates to floor-for-all and over-allocates; `fit` in `budgetReviewExtras`
 *  stays the hard enforcement. */
const INLINE_BODY_FLOOR = 700;
const REVIEW_BODY_FLOOR = 1_500;
const COMMENT_BODY_FLOOR = 1_200;

/** Crudely de-noises a bot comment body: drops HTML comments and collapsible
 *  `<details>` blocks (walkthroughs / sequence diagrams), unwraps the remaining
 *  tags, and collapses blank runs. The actionable findings live in inline
 *  comments; this is only to make a summary comment cheap to include. Length is
 *  not this function's business — the fair-share caps land in pass 2. */
function condense(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<details[\s\S]*?<\/details>/gi, "")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A short "where" tag for an inline finding. */
function locationTag(item: ExternalReviewItem): string {
  if (!item.path) return "";
  const loc = item.line > 0 ? `${item.path}:${item.line}` : item.path;
  const flags: string[] = [];
  if (item.isOutdated) flags.push("outdated");
  if (item.isResolved) flags.push("resolved");
  const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
  return `\`${loc}\`${suffix}`;
}

/**
 * Formats the kept findings into a grouped markdown block, reviewer by reviewer:
 * inline (line-anchored) findings first — the actionable ones — then submitted
 * review bodies, then a condensed conversation summary. Returns "" when empty.
 *
 * Two passes, because each body's cap depends on all the others: pass 1 groups,
 * sorts and de-noises, dropping whatever condenses to nothing, then the surviving
 * lengths are fair-shared across `budget` net of the rendered scaffolding (see
 * `allocateBodyCaps` and the reserve below) — ALL reviewers pooled, since the
 * budget is section-wide — and pass 2 renders each body under its own cap.
 * Capping per item BEFORE knowing the section budget was the old bug: a bot's 5K
 * review body was cut to 1.5K even with most of the external budget unspent.
 */
function formatExternalFindings(
  items: ExternalReviewItem[],
  budget: number,
): string {
  const byReviewer = new Map<string, ExternalReviewItem[]>();
  for (const it of items) {
    const name = displayName(it.author);
    const list = byReviewer.get(name) ?? [];
    list.push(it);
    byReviewer.set(name, list);
  }

  // `reply` never reaches here (filtered out of the external set upstream), but
  // it's in the union, so it's mapped for typechecking + defense if one ever does.
  const order = { inline: 0, review: 1, comment: 2, reply: 3 } as const;
  const floors = {
    inline: INLINE_BODY_FLOOR,
    review: REVIEW_BODY_FLOOR,
    comment: COMMENT_BODY_FLOOR,
    reply: COMMENT_BODY_FLOOR,
  } as const;

  const cleaned: {
    reviewer: string;
    item: ExternalReviewItem;
    body: string;
    /** The item's rendered line prefix, resolved in pass 1 so the scaffolding
     *  reserve is charged against exactly what pass 2 emits. */
    prefix: string;
  }[] = [];
  for (const [reviewer, list] of byReviewer) {
    const sorted = [...list].sort((a, b) => order[a.kind] - order[b.kind]);
    for (const it of sorted) {
      const body = condense(it.body);
      if (!body) continue;
      let prefix: string;
      if (it.kind === "inline") {
        const tag = locationTag(it);
        prefix = `- ${tag ? `${tag} — ` : ""}`;
      } else if (it.kind === "review") {
        prefix = "- (review) ";
      } else {
        prefix = "- (summary) ";
      }
      cleaned.push({ reviewer, item: it, body, prefix });
    }
  }

  // The caps govern BODY length, but the rendered section also carries
  // scaffolding: each line's prefix and the newline joining it to the next, two
  // more characters for every newline inside a body (the `\n  ` continuation
  // indent), and a `### <reviewer>` header plus blank-line joiner per group.
  // Reserving it buys right-sized SHARES — without it the fair split is computed
  // over a budget the render then blows past, so the bodies are collectively
  // sized wrong. It is NOT a guarantee that the result fits `budget`: the floors
  // can lift a cap back above any netted budget, and `fit` (truncate.ts) is the
  // real enforcement point — it now cuts through `capBody`, so an overflow ends
  // in a marked cut rather than a bare one.
  //
  // The newline term is charged against `body.slice(0, provisionalCap)`, not the
  // whole body: a 40K walkthrough with 2,000 newlines would otherwise reserve
  // ~4,000 characters for a body that will be cut to ~1,200, starving every other
  // finding of its share. Round 1 allocates with no scaffolding to get those
  // provisional caps; since a smaller budget never yields a LARGER share, round
  // 2's caps are ≤ round 1's, so the measured newline count stays an upper bound
  // (+1 covers the line `capBody` adds for its note) and the only failure mode is
  // slightly under-using the budget.
  const lengths = cleaned.map((c) => c.body.length);
  const bodyFloors = cleaned.map((c) => floors[c.item.kind]);
  const provisional = allocateBodyCaps(lengths, budget, bodyFloors);
  let scaffold = 0;
  cleaned.forEach(({ prefix, body }, i) => {
    scaffold +=
      prefix.length + 1 + 2 * body.slice(0, provisional[i]).split("\n").length;
  });
  for (const reviewer of new Set(cleaned.map((c) => c.reviewer))) {
    scaffold += `### ${reviewer}\n`.length + 2;
  }

  const caps = allocateBodyCaps(
    lengths,
    Math.max(0, budget - scaffold),
    bodyFloors,
  );

  const linesByReviewer = new Map<string, string[]>();
  cleaned.forEach(({ reviewer, body, prefix }, i) => {
    const capped = capBody(body, caps[i]).replace(/\n/g, "\n  ");
    const lines = linesByReviewer.get(reviewer) ?? [];
    lines.push(`${prefix}${capped}`);
    linesByReviewer.set(reviewer, lines);
  });

  return [...linesByReviewer]
    .map(([reviewer, lines]) => `### ${reviewer}\n${lines.join("\n")}`)
    .join("\n\n");
}

/**
 * Loads third-party AI-reviewer findings for a remote PR and formats them as
 * soft context. Remote-only (local PRs have no remote reviewers) and best-effort
 * — `ignore`, a non-remote kind, a non-numeric ref, or any fetch failure yields
 * `{}`. Mirrors `resolvePriorContext`: takes primitives, never throws, never the
 * source of truth.
 *
 * `opts.budgetChars` is the section budget the per-finding caps are fair-shared
 * across — the same budget the rest of the prompt scales to (the user's
 * Review-context knob), so the knob actually reaches this section. The constant
 * is a defensive default for a caller that doesn't resolve it.
 */
export async function resolveExternalContext(
  repoPath: string,
  kind: "remote" | "local",
  ref: string,
  currentHeadSha: string | undefined,
  ignore: boolean,
  provider: string = "github",
  opts?: { budgetChars?: number },
): Promise<ExternalContext> {
  if (ignore || kind !== "remote") return {};
  const prNumber = Number(ref);
  if (!Number.isInteger(prNumber) || prNumber <= 0) return {};

  const items = await fetchExternalFindings(repoPath, prNumber, provider);
  if (items.length === 0) return {};

  const externalFindings = formatExternalFindings(
    items,
    opts?.budgetChars ?? EXTERNAL_FINDINGS_CHAR_BUDGET,
  );
  if (!externalFindings.trim()) return {};

  // Stale = an included finding was made against a commit other than the current
  // head, or GitHub already flagged its anchored line as outdated.
  const externalStale = items.some(
    (it) =>
      it.isOutdated ||
      (Boolean(it.commitSha) &&
        Boolean(currentHeadSha) &&
        it.commitSha !== currentHeadSha),
  );

  return {
    externalFindings,
    externalReviewers: externalReviewerNames(items),
    externalStale,
  };
}
