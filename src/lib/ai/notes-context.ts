import { forgePrExternalReviews, forgePrView } from "@/lib/git/api";

/**
 * Lifts the author's "Notes for reviewers" from the newest conversation comment
 * that carries the notes marker, so catch-up and re-review rounds see them even
 * though those rounds have no dialog event carrying the notes: the fresh-event
 * path threads the notes straight into the prompt, but a re-review triggered
 * later (no new event) would otherwise lose them — so we recover them from the
 * marker comment the dialog posts. Best-effort and remote-only, mirroring the
 * own-comments harvest in `own-context.ts`: any fetch failure, no comments, or no
 * marker match yields `{}`. Never ground truth; the current diff always wins.
 *
 * The lifted comment MUST be the PR author's own: the notes section carries
 * author-level trust in the security review prompt (a documented accepted-risk
 * disposition), so an ungated lift would let any commenter on a public-repo PR
 * post a marker-headed comment and be treated as the author (round-1 security
 * finding, PR #91). Dialog- and MCP-posted notes are the author's own login, so
 * they pass; do not remove this gate.
 */

/** Wire format: the "Notes for reviewers" dialog posts a conversation comment
 *  whose body begins with exactly this marker followed by a blank line. Exported
 *  so the poster and this lifter share one string — never inline it twice. */
export const REVIEWER_NOTES_MARKER = "🗒️ **Notes for reviewers**";

/** The stable ASCII anchor inside the marker. The READER matches on this — not
 *  the full `REVIEWER_NOTES_MARKER` — because forge APIs (GitLab/Bitbucket
 *  especially) may normalize returned comment bodies: CRLF line endings, a
 *  stripped emoji variation selector (🗒️ is multi-codepoint, U+1F5D2 U+FE0F),
 *  or leading whitespace all silently break an emoji-anchored `startsWith`.
 *  Anchoring on this bold literal survives that normalization. Do NOT tighten
 *  the reader back to the emoji-bearing constant. */
const REVIEWER_NOTES_ANCHOR = "**Notes for reviewers**";

export async function resolveReviewerNotesContext(
  repoPath: string,
  prNumber: number,
): Promise<{ reviewNotes?: string }> {
  if (!Number.isInteger(prNumber) || prNumber <= 0) return {};

  let items: Awaited<ReturnType<typeof forgePrExternalReviews>>;
  let prAuthor: string;
  try {
    // Origin-pinned, matching `own-context.ts`: notes belong to the fork's own PR.
    // The PR fetch gives us the author login to gate the lift on (see module doc).
    const [reviews, pr] = await Promise.all([
      forgePrExternalReviews(repoPath, prNumber, "origin"),
      forgePrView(repoPath, prNumber, "origin"),
    ]);
    items = reviews;
    prAuthor = pr.author;
  } catch {
    return {};
  }
  // No usable author to compare against ⇒ can't establish authorship ⇒ lift
  // nothing rather than trust an arbitrary commenter.
  if (!prAuthor.trim()) return {};
  const prAuthorKey = prAuthor.trim().toLowerCase();

  // Newest conversation comment BY THE PR AUTHOR whose first non-empty line
  // carries the notes anchor. Reader is looser than the poster on the marker text
  // (see the anchor's doc), but authorship is a hard security gate: the notes feed
  // an author-trusted prompt section (round-1 finding, PR #91). Case-insensitive
  // to tolerate forge login-casing drift — a stricter compare can only DROP the
  // author's own notes, never let a non-author through.
  let newest: (typeof items)[number] | undefined;
  for (const it of items) {
    if (it.kind !== "comment") continue;
    if (it.author.trim().toLowerCase() !== prAuthorKey) continue;
    if (extractNotesBody(it.body) === undefined) continue;
    if (!newest || it.createdAt > newest.createdAt) newest = it;
  }
  if (!newest) return {};

  const reviewNotes = extractNotesBody(newest.body);
  if (!reviewNotes) return {};
  return { reviewNotes };
}

/** Returns the notes body from a comment whose FIRST non-empty line is the notes
 *  header (that trimmed line — trailing `\r` tolerated — CONTAINS the ASCII
 *  anchor), stripping that whole header line and any following blank lines;
 *  `undefined` when it is not a notes comment, `""` when it is but carries no
 *  body. Line-scanned rather than `startsWith` so forge body normalization
 *  (CRLF, stripped variation selector, leading whitespace) can't hide the notes. */
function extractNotesBody(body: string): string | undefined {
  const lines = body.split("\n");
  const firstNonBlank = lines.findIndex((l) => l.trim() !== "");
  if (firstNonBlank < 0) return undefined;
  if (!lines[firstNonBlank].trim().includes(REVIEWER_NOTES_ANCHOR))
    return undefined;
  return lines
    .slice(firstNonBlank + 1)
    .join("\n")
    .trim();
}
