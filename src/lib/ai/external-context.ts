import { forgePrExternalReviews } from "@/lib/git/api";
import type { ExternalReviewItem } from "@/lib/git/types";

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

/** Per-item body caps before the global budget allocator — keep inline findings
 *  tight and hard-cap the giant conversation summaries (CodeRabbit walkthroughs). */
const INLINE_BODY_CAP = 700;
const REVIEW_BODY_CAP = 1_500;
const COMMENT_BODY_CAP = 1_200;

/** Crudely de-noises a bot comment body: drops HTML comments and collapsible
 *  `<details>` blocks (walkthroughs / sequence diagrams), unwraps the remaining
 *  tags, and collapses blank runs. The actionable findings live in inline
 *  comments; this is only to make a summary comment cheap to include. */
function condense(body: string, cap: number): string {
  const cleaned = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<details[\s\S]*?<\/details>/gi, "")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length > cap ? `${cleaned.slice(0, cap)}…` : cleaned;
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
 */
function formatExternalFindings(items: ExternalReviewItem[]): string {
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
  const blocks: string[] = [];
  for (const [reviewer, list] of byReviewer) {
    const sorted = [...list].sort((a, b) => order[a.kind] - order[b.kind]);
    const lines: string[] = [];
    for (const it of sorted) {
      if (it.kind === "inline") {
        const tag = locationTag(it);
        const body = condense(it.body, INLINE_BODY_CAP).replace(/\n/g, "\n  ");
        lines.push(`- ${tag ? `${tag} — ` : ""}${body}`);
      } else if (it.kind === "review") {
        const body = condense(it.body, REVIEW_BODY_CAP);
        if (body) lines.push(`- (review) ${body.replace(/\n/g, "\n  ")}`);
      } else {
        const body = condense(it.body, COMMENT_BODY_CAP);
        if (body) lines.push(`- (summary) ${body.replace(/\n/g, "\n  ")}`);
      }
    }
    if (lines.length > 0) {
      blocks.push(`### ${reviewer}\n${lines.join("\n")}`);
    }
  }
  return blocks.join("\n\n");
}

/**
 * Loads third-party AI-reviewer findings for a remote PR and formats them as
 * soft context. Remote-only (local PRs have no remote reviewers) and best-effort
 * — `ignore`, a non-remote kind, a non-numeric ref, or any fetch failure yields
 * `{}`. Mirrors `resolvePriorContext`: takes primitives, never throws, never the
 * source of truth.
 */
export async function resolveExternalContext(
  repoPath: string,
  kind: "remote" | "local",
  ref: string,
  currentHeadSha: string | undefined,
  ignore: boolean,
  provider: string = "github",
): Promise<ExternalContext> {
  if (ignore || kind !== "remote") return {};
  const prNumber = Number(ref);
  if (!Number.isInteger(prNumber) || prNumber <= 0) return {};

  const items = await fetchExternalFindings(repoPath, prNumber, provider);
  if (items.length === 0) return {};

  const externalFindings = formatExternalFindings(items);
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
