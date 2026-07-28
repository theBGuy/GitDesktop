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

/** Known reviewer-bot logins → friendly display names. This allowlist is the only bot
 *  truth we have for GitLab, and the gate for conversation comments on GitHub (CI /
 *  deploy / dependabot post on that surface too) — see `isReviewerFinding`. */
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
 * GitHub: `isBot` is server truth (GraphQL `__typename == "Bot"`), so any bot's inline
 * or submitted review qualifies (only reviewers post those); conversation comments need
 * the `REVIEWER_BOTS` allowlist. GitLab: REST authors carry no bot flag (the Rust mapper
 * hardcodes `isBot: true`), so without the allowlist on EVERY kind a human teammate's
 * inline diff comment would pose as an AI finding.
 */
function isReviewerFinding(
  item: ExternalReviewItem,
  provider: string,
): boolean {
  // Replies are own-context's job; the external section stays opener-only. Only the
  // GitHub harvest emits `reply` — GitLab replies arrive as `inline`/`comment` and stay
  // admitted for allowlisted bots below.
  if (item.kind === "reply") return false;
  if (!item.isBot || !item.body.trim()) return false;
  if (provider === "gitlab") return isReviewerBotLogin(item.author);
  if (item.kind === "inline" || item.kind === "review") return true;
  return isReviewerBotLogin(item.author);
}

/**
 * Fetches a PR's review activity and keeps only the third-party AI-reviewer findings.
 * Best-effort: any failure (no gh, network) yields an empty list — external context never
 * blocks a review. Runs behind the forge abstraction (`forge_pr_external_reviews`);
 * Bitbucket has no third-party AI-reviewer ecosystem and its Rust arm is an empty
 * no-network `[]`, so short-circuiting here also skips the IPC round trip.
 *
 * Used by the panel's external-reviews query as well as `resolveExternalContext`.
 */
export async function fetchExternalFindings(
  repoPath: string,
  prNumber: number,
  provider: string = "github",
): Promise<ExternalReviewItem[]> {
  if (provider === "bitbucket") return [];
  try {
    // Origin-pinned: AI review context reads the fork's own PR, not the upstream lens.
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

/** Per-kind body FLOORS for the fair-share allocator — a guaranteed minimum per kept
 *  finding, so a giant conversation summary (a CodeRabbit walkthrough) can't crowd out a
 *  later inline finding. NOT ceilings: the actual cap is the max-min share
 *  (`allocateBodyCaps`), and when the floors alone exceed the budget the allocation
 *  over-allocates — `fit` in `budgetReviewExtras` stays the hard enforcement. */
const INLINE_BODY_FLOOR = 700;
const REVIEW_BODY_FLOOR = 1_500;
const COMMENT_BODY_FLOOR = 1_200;

/** De-noises a bot comment body: drops HTML comments and collapsible `<details>` blocks
 *  (walkthroughs / sequence diagrams), unwraps the remaining tags, collapses blank runs.
 *  The actionable findings live in inline comments, so a summary comment only has to be
 *  cheap to include. Length is pass 2's business (the fair-share caps). */
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
 * Formats the kept findings into a grouped markdown block, reviewer by reviewer: inline
 * (line-anchored) findings first — the actionable ones — then submitted review bodies,
 * then a condensed conversation summary. Returns "" when empty.
 *
 * Two passes, because each body's cap depends on all the others: pass 1 groups, sorts and
 * de-noises, dropping whatever condenses to nothing; the surviving lengths are fair-shared
 * across `budget` net of the rendered scaffolding — ALL reviewers pooled, since the budget
 * is section-wide — and pass 2 renders each body under its own cap.
 *
 * Capping per item BEFORE the section budget is known is the trap it avoids: a long review
 * body gets cut to its floor while most of the external budget goes unspent.
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

  // The caps govern BODY length, but the render also emits scaffolding: each line's prefix
  // + the joining newline, two more chars per newline inside a body (the `\n  ` continuation
  // indent), and a `### <reviewer>` header per group. Reserving it buys right-sized SHARES —
  // without it the split is computed over a budget the render then blows past. It is not a
  // guarantee of fit (the floors can lift a cap back over any netted budget).
  //
  // Round 1 allocates with no scaffolding purely to get provisional caps: the newline term
  // is charged against the body AS CUT, or one huge walkthrough reserves for newlines it
  // will never render and starves every other finding of its share. A smaller budget never
  // yields a LARGER share, so round 2's caps are ≤ round 1's and that count stays an upper
  // bound (+1 for `capBody`'s note line) — the only failure mode is under-using the budget.
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
 * Loads third-party AI-reviewer findings for a remote PR and formats them as soft context.
 * Remote-only (local PRs have no remote reviewers) and best-effort — `ignore`, a non-remote
 * kind, a non-numeric ref, or any fetch failure yields `{}`. Mirrors `resolvePriorContext`:
 * takes primitives, never throws, never the source of truth.
 *
 * `opts.budgetChars` is the section budget the per-finding caps are fair-shared across —
 * the user's Review-context knob, so the knob reaches this section; the constant is a
 * defensive default for callers that don't resolve it.
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
