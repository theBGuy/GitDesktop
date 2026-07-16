import { forgePrExternalReviews } from "@/lib/git/api";
import type { ExternalReviewItem } from "@/lib/git/types";
import { GD_COMMENT_ANCHOR } from "./comment-branding";

/** What `buildReviewPrompt` needs about GitDesktop's OWN prior comments on a PR. */
export interface OwnCommentsContext {
  /** Pre-formatted markdown of the comments GitDesktop itself posted on this PR
   *  — past AI reviews plus any agent follow-ups (refutations, "fixed in `<sha>`"
   *  replies), oldest first. Soft resolution context, never ground truth. Absent
   *  for local PRs, on Bitbucket, and when none were found. */
  ownFindings?: string;
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

/** A short "where + state" tag for an inline comment. Ours are usually
 *  conversation-level (no anchor), but future-proof it — and surface a resolved
 *  or outdated thread, which is itself a resolution signal. */
function ownLocationTag(item: ExternalReviewItem): string {
  if (item.kind !== "inline" || !item.path) return "";
  const loc = item.line > 0 ? `${item.path}:${item.line}` : item.path;
  const flags: string[] = [];
  if (item.isOutdated) flags.push("outdated");
  if (item.isResolved) flags.push("resolved thread");
  const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
  return ` on \`${loc}\`${suffix}`;
}

/** Formats our own comments oldest → newest, so the model reads the original
 *  review before any later refutation / "fixed in `<sha>`" follow-up under it. */
function formatOwnComments(items: ExternalReviewItem[]): string {
  const ordered = [...items].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  );
  const lines: string[] = [];
  for (const it of ordered) {
    const body = condenseOwnComment(it.body, OWN_BODY_CAP);
    if (!body) continue;
    lines.push(
      `- (${it.author}${ownLocationTag(it)})\n  ${body.replace(/\n/g, "\n  ")}`,
    );
  }
  return lines.join("\n\n");
}

/**
 * Loads the comments GitDesktop itself has posted on a remote PR — its past AI
 * reviews and any agent refutation / "fixed in `<sha>`" replies — as soft
 * resolution context, so a re-review doesn't cold-raise something the team
 * already addressed. Best-effort and remote-only, mirroring
 * `resolveExternalContext`: a non-remote kind, a non-numeric ref, Bitbucket (no
 * review-activity harvest — an empty no-network `[]`), or any fetch failure
 * yields `{}`. Never the source of truth; the current diff always wins.
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

  const ownFindings = formatOwnComments(own);
  if (!ownFindings.trim()) return {};
  return { ownFindings };
}
