/**
 * Pure helpers behind review composition, consumed by ReviewComposer.tsx and
 * ReviewThreads.tsx: extracting the new-side content of a selected line range
 * from a file's unified-diff section, building the provider-correct
 * ```suggestion fence, and synthesizing a GitHub-shaped `diffHunk` for
 * GitLab/Bitbucket threads (whose APIs return none) so the Apply affordance can
 * light up. The marker and new-side counter rules are a deliberate separate copy
 * of ReviewThreads.tsx's private `parseHunk`/`newSideLines` (those are coupled to
 * its own `HunkLine`/`ReviewThreadOut` shapes) — any change to them must be
 * mirrored in BOTH. The section walk itself is bounded like every other hunk
 * walk over a file section (`patchLines` in diff-split.ts). Its only import is a
 * relative .ts one, so scripts/diff-split.test.mjs loads it under Node.
 */
import { diffLines } from "../../lib/git/diff-split.ts";

const SECTION_HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** One parsed new-side line of a unified-diff section: its 1-based new-side line
 *  number, null for removed lines (which carry no new-side number). */
interface SectionLine {
  number: number | null;
  kind: "add" | "del" | "context";
  /** Raw line including its leading marker (+, -, or space). */
  text: string;
  /** `\ No newline at end of file` follows: the line has no terminator. */
  noEol?: boolean;
}

const NO_EOL_MARKER = "\\ No newline at end of file";
const BOM = String.fromCharCode(0xfeff);

/**
 * Parse every hunk of a per-file unified-diff section into new-side-numbered
 * lines. The section is the text produced for ONE file (one or more `@@` hunks;
 * leading `diff --git`/`---`/`+++` header lines are ignored). New-side numbering
 * advances on context + added lines and resets at each hunk header's `+c` start;
 * removed lines carry no number. The counter rules mirror ReviewThreads.tsx's
 * private `parseHunk`, so a hunk synthesized here lines up with its Apply gating.
 * Each hunk ends at its header's counts (an omitted count is 1), so neither the
 * empty tail a final newline leaves nor a joined section's next file header is
 * read as a line; an empty line inside a hunk is a blank context line.
 */
function parseSectionLines(section: string): SectionLine[] {
  const out: SectionLine[] = [];
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of diffLines(section)) {
    const marker = raw[0];
    // `\ No newline at end of file` annotates the previous line — not content,
    // so it gets no number and must not advance the counter. It follows a
    // hunk's last line too, after the counts ran out.
    if (marker === "\\") {
      const prev = out.at(-1);
      if (prev) prev.noEol = true;
      continue;
    }
    if (oldLeft <= 0 && newLeft <= 0) {
      const header = SECTION_HUNK.exec(raw);
      if (header) {
        oldLeft = header[1] === undefined ? 1 : Number(header[1]);
        newNo = Number(header[2]);
        newLeft = header[3] === undefined ? 1 : Number(header[3]);
      }
      continue;
    }
    if (marker === "-") {
      out.push({ number: null, kind: "del", text: raw });
      oldLeft -= 1;
      continue;
    }
    // A line past its side's count draws no new-side line, as in `patchLines`.
    const number = newLeft > 0 ? newNo : null;
    if (marker === "+") out.push({ number, kind: "add", text: raw });
    else {
      out.push({ number, kind: "context", text: raw });
      oldLeft -= 1;
    }
    newNo += 1;
    newLeft -= 1;
  }
  return out;
}

/**
 * The current new-side content of new-side lines `[from, to]` (inclusive,
 * 1-based) of a per-file unified-diff `section`, with the leading +/space marker
 * stripped — the lines a suggestion would replace. Removed lines are skipped (no
 * new-side number). Returns null when the range isn't fully covered by the section
 * (a gap, or `from > to`) so the caller degrades instead of prefilling a partial
 * suggestion.
 */
export function extractNewSideLines(
  fileSection: string,
  from: number,
  to: number,
): string[] | null {
  if (from <= 0 || to < from) return null;
  const parsed = parseSectionLines(fileSection);
  const byNumber = new Map<number, SectionLine>();
  for (const ln of parsed) if (ln.number !== null) byNumber.set(ln.number, ln);
  const picked: string[] = [];
  for (let n = from; n <= to; n += 1) {
    const hit = byNumber.get(n);
    if (!hit) return null; // gap — range not fully in the section
    // Strip the single leading marker, and any "\r": the composer's textarea
    // would turn a lone CR into a line break inside the fence. Line 1 sheds a
    // leading BOM: Apply restores the file's own, so the fence's would double it.
    let body = hit.text.slice(1).replace(/\r$/, "");
    if (n === 1 && body.startsWith(BOM)) body = body.slice(1);
    picked.push(body);
  }
  return picked;
}

/**
 * Build the provider-correct ```suggestion fence for a selected new-side range,
 * pre-filled with `currentLines`. Returns the full fenced block (opener, lines,
 * closing ```) — ready to splice into a comment body.
 * - **GitHub**: a bare ```suggestion — the multi-line range rides the thread's
 *   `startLine`/`line` anchor, not the fence.
 * - **GitLab**: the fence anchors at the END line; a multi-line replacement is
 *   ```suggestion:-N+0 with `N = to - from` lines above it (0 ⇒ bare fence).
 * - **Bitbucket**: single-line only (a suggestion replaces one line) — the caller
 *   must not offer the action for a multi-line range; we still emit a valid fence.
 */
export function buildSuggestionFence(
  provider: "github" | "gitlab" | "bitbucket",
  selected: { from: number; to: number },
  currentLines: string[],
): string {
  const span = Math.max(0, selected.to - selected.from);
  const opener =
    provider === "gitlab" && span > 0
      ? `\`\`\`suggestion:-${span}+0`
      : "```suggestion";
  return [opener, ...currentLines, "```"].join("\n");
}

/**
 * Synthesize a GitHub-shaped `diffHunk` for a thread whose provider
 * (GitLab/Bitbucket) returns none, so ReviewThreads' HunkExcerpt +
 * `recoverOriginals` render and gate Apply exactly as they do for GitHub. Emits a
 * `@@ -a,b +c,d @@` fragment whose new-side numbering reaches — and ends at — the
 * thread's anchor `line`, carrying the real +/-/context markers from
 * `fileSection`; old-side counts are best-effort (consumers read only the `+c`
 * start and the markers). Returns null when the section doesn't cover the range
 * `[startLine>0 ? startLine : line, line]`, so the caller keeps the degraded
 * no-Apply render rather than a half-hunk.
 */
export function synthesizeThreadHunk(
  fileSection: string,
  thread: { line: number; startLine: number },
): string | null {
  const anchor = thread.line;
  if (anchor <= 0) return null;
  const from = thread.startLine > 0 ? thread.startLine : anchor;
  if (from <= 0 || from > anchor) return null;

  const parsed = parseSectionLines(fileSection);
  if (parsed.length === 0) return null;

  // Window: `from`..`anchor` inclusive, preserving interleaved removed lines.
  const startIdx = parsed.findIndex((l) => l.number === from);
  const endIdx = parsed.findIndex((l) => l.number === anchor);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return null;
  const window = parsed.slice(startIdx, endIdx + 1);

  // Every new-side number in [from, anchor] must be present (no gap) — otherwise
  // recoverOriginals would refuse it anyway; bail so we don't emit a half-hunk.
  const covered = new Set<number>();
  for (const l of window) if (l.number !== null) covered.add(l.number);
  for (let n = from; n <= anchor; n += 1) if (!covered.has(n)) return null;

  const newCount = window.filter((l) => l.kind !== "del").length;
  const oldCount = window.filter((l) => l.kind !== "add").length;
  const header = `@@ -${from},${oldCount} +${from},${newCount} @@`;
  // A blank context line takes its leading space back: ReviewThreads'
  // `parseHunk` skips an empty first row as an artifact. The no-newline marker
  // rides along, since Apply keeps an unterminated line's "\r".
  const rows = window.flatMap((l) => {
    const row =
      l.kind === "context" && (l.text === "" || l.text === "\r")
        ? ` ${l.text}`
        : l.text;
    return l.noEol ? [row, NO_EOL_MARKER] : [row];
  });
  return [header, ...rows].join("\n");
}
