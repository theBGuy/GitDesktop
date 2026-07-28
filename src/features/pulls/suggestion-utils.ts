/**
 * Pure helpers behind review composition, consumed by ReviewComposer.tsx and
 * ReviewThreads.tsx: extracting the new-side content of a selected line range
 * from a file's unified-diff section, building the provider-correct
 * ```suggestion fence, and synthesizing a GitHub-shaped `diffHunk` for
 * GitLab/Bitbucket threads (whose APIs return none) so the Apply affordance can
 * light up. The hunk parsing is a deliberate separate copy of ReviewThreads.tsx's
 * private `parseHunk`/`newSideLines` (those are coupled to its own
 * `HunkLine`/`ReviewThreadOut` shapes) — any change to the unified marker/counter
 * rules must be mirrored in BOTH.
 */

/** One parsed new-side line of a unified-diff section: its 1-based new-side line
 *  number, null for removed lines (which carry no new-side number). */
interface SectionLine {
  number: number | null;
  kind: "add" | "del" | "context";
  /** Raw line including its leading marker (+, -, or space). */
  text: string;
}

/**
 * Parse every hunk of a per-file unified-diff section into new-side-numbered
 * lines. The section is the text produced for ONE file (one or more `@@` hunks;
 * leading `diff --git`/`---`/`+++` header lines are ignored). New-side numbering
 * advances on context + added lines and resets at each hunk header's `+c` start;
 * removed lines carry no number. The counter rules mirror ReviewThreads.tsx's
 * private `parseHunk`, so a hunk synthesized here lines up with its Apply gating.
 */
function parseSectionLines(section: string): SectionLine[] {
  const out: SectionLine[] = [];
  let newNo: number | null = null;
  for (const raw of section.split("\n")) {
    const header = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      newNo = Number(header[1]);
      continue;
    }
    // Skip everything before the first hunk header (file header lines).
    if (newNo === null) continue;
    const marker = raw[0];
    // `\ No newline at end of file` annotates the previous line — not content,
    // so it gets no number and must not advance the counter.
    if (marker === "\\") continue;
    if (marker === "+") {
      out.push({ number: newNo, kind: "add", text: raw });
      newNo += 1;
    } else if (marker === "-") {
      out.push({ number: null, kind: "del", text: raw });
    } else {
      // Context line (leading space) or a stray blank; both advance new-side.
      out.push({ number: newNo, kind: "context", text: raw });
      newNo += 1;
    }
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
    picked.push(hit.text.slice(1)); // strip the single leading marker
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
  return [header, ...window.map((l) => l.text)].join("\n");
}
