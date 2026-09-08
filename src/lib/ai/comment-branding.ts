/**
 * The single source of truth for the AI-review comment body convention. Both
 * posting seams — the manual `PrReviewPanel` and the automations `runner` —
 * MUST build their comment bodies through {@link buildAiCommentBody} so a
 * posted AI review is unmistakably machine-authored and byte-identical across
 * both paths. Do not hand-roll the header/footer in either seam again.
 *
 * It also owns the forge-reference detector both seams share. A bare `#N` in
 * posted text is a live cross-reference that backlinks and notifies whatever
 * thread it names, so the manual seam confirms with the user before posting and
 * never rewrites the text, while the automated seam — where nobody is present to
 * confirm — neutralizes the refs and says so, via {@link AiCommentParts.neutralizeRefs}.
 *
 * The output is pure Markdown: it renders on every forge (GitHub / GitLab /
 * Bitbucket) AND in the app's own `Markdown` component, so it uses no raw HTML
 * and no `<details>`.
 *
 * DEPENDENCY-FREE, ERASABLE TS ONLY: `scripts/comment-refs.test.mjs` imports this
 * module directly under Node's default type stripping, which resolves no bundler
 * aliases and erases types rather than compiling them. Keep it at zero runtime
 * imports, and to syntax that erases (interfaces, plain functions, `as const`).
 */
export interface AiCommentParts {
  kind: "review" | "security audit";
  model: string;
  automated: boolean;
  text: string;
  /** Backtick-wrap any `#N`-style reference in `text` and disclose that in the
   *  footer. For the automated seam only: nobody is there to confirm intent, so
   *  the stray cross-reference is prevented outright. */
  neutralizeRefs?: boolean;
}

/**
 * The domain link every GitDesktop-authored comment carries in its footer — the
 * stable anchor by which the app recognizes its OWN comments on a PR later (both
 * this AI-review footer and the MCP agent footer embed it; their wording differs,
 * so detection keys off this URL, never the phrasing). Keep it a bare string so a
 * simple `body.includes(GD_COMMENT_ANCHOR)` is the whole test.
 */
export const GD_COMMENT_ANCHOR = "https://gitdesktop.app";

/** Trigger characters that autolink per provider — mirrors the app's renderer
 *  (Bitbucket autolinks neither, so it detects nothing there by design). */
export const REF_TRIGGERS = {
  github: ["#"],
  gitlab: ["#", "!"],
  bitbucket: [],
} as const;

/** A reference only opens at a boundary: a word char keeps `word#123` plain, `/`
 *  keeps a URL fragment plain, and `&` keeps entities like `&#39;` unlinkified.
 *  Cross-module contract: the same set as `BLOCKED_BEFORE` in
 *  `src/components/markdown/markdown-refs.ts`, so this detector and the app's own
 *  autolinker agree on what is prose. */
const BLOCKED_BEFORE = /[\w/&]/;

/** No forge numbers an item 0, and the value caps at ten digits — the grammar the
 *  renderer's `NUMBER_SRC` emits. */
const REF_NUMBER = /^[1-9]\d{0,9}(?!\w)/;

/** How far past a trigger the number grammar can possibly reach: ten digits plus
 *  the one character the boundary lookahead reads. */
const REF_NUMBER_SPAN = 12;

/** Opens or closes a fenced block. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Indented code: four spaces or a tab of leading whitespace. */
const INDENTED = /^(?: {4}|\t)/;

/** How many references a formatted list names before it counts the rest. */
const REF_LIST_CAP = 5;

/** One suspect token's position in the scanned text. */
interface RefOccurrence {
  start: number;
  end: number;
  token: string;
}

/** The end index (exclusive) of a `[label](destination)` opening at `open`, or
 *  `open` when what's there isn't one. Both halves skip whole — a number in
 *  either belongs to the link. Bounded to `limit` (the line), so a link split
 *  across lines is not recognized. */
function linkEnd(text: string, open: number, limit: number): number {
  let depth = 0;
  let i = open;
  for (; i < limit; i++) {
    const ch = text[i];
    if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) break;
  }
  if (i >= limit || text[i + 1] !== "(") return open;
  let parens = 0;
  for (i += 1; i < limit; i++) {
    const ch = text[i];
    if (ch === "(") parens++;
    else if (ch === ")" && --parens === 0) return i + 1;
  }
  return open;
}

/**
 * Every suspect reference occurrence in `text`, in source order — the ONE scan
 * both {@link findSuspectRefs} and {@link neutralizeSuspectRefs} consume, so the
 * warning and the rewrite can never disagree about what counts.
 *
 * Regions the scan never fires inside: fenced blocks, inline code spans, markdown
 * link syntax, and indented code. Each of those over-skips at the margins (a lazy
 * paragraph continuation indented four spaces, say), which fails toward the
 * status quo — no warning, no rewrite — the safe direction for both callers.
 */
function scanRefs(text: string, triggers: readonly string[]): RefOccurrence[] {
  const out: RefOccurrence[] = [];
  if (triggers.length === 0) return out;
  let fence: { char: string; len: number } | null = null;
  // The open code span's backtick-run length; 0 when none. A run of N backticks
  // closes at the next run of exactly N (CommonMark), and a span may cross lines.
  let span = 0;
  let lineStart = 0;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    // Block structure is only readable outside a code span: an open span swallows
    // whatever it crosses, fence lines included.
    if (span === 0) {
      const fenced = FENCE.exec(text.slice(lineStart, lineEnd));
      if (fence) {
        if (
          fenced &&
          fenced[1][0] === fence.char &&
          fenced[1].length >= fence.len &&
          text.slice(lineStart + fenced[0].length, lineEnd).trim() === ""
        ) {
          fence = null;
        }
        lineStart = lineEnd + 1;
        continue;
      }
      if (fenced) {
        fence = { char: fenced[1][0], len: fenced[1].length };
        lineStart = lineEnd + 1;
        continue;
      }
      if (INDENTED.test(text.slice(lineStart, lineEnd))) {
        lineStart = lineEnd + 1;
        continue;
      }
    }
    let i = lineStart;
    while (i < lineEnd) {
      const ch = text[i];
      if (ch === "`") {
        let run = 1;
        while (i + run < lineEnd && text[i + run] === "`") run++;
        if (span === 0) span = run;
        else if (span === run) span = 0;
        i += run;
        continue;
      }
      if (span > 0) {
        i++;
        continue;
      }
      if (ch === "[") {
        const skip = linkEnd(text, i, lineEnd);
        i = skip > i ? skip : i + 1;
        continue;
      }
      if (
        triggers.includes(ch) &&
        !(i > 0 && BLOCKED_BEFORE.test(text[i - 1]))
      ) {
        const num = REF_NUMBER.exec(text.slice(i + 1, i + 1 + REF_NUMBER_SPAN));
        if (num) {
          const end = i + 1 + num[0].length;
          out.push({ start: i, end, token: text.slice(i, end) });
          i = end;
          continue;
        }
      }
      i++;
    }
    lineStart = lineEnd + 1;
  }
  return out;
}

/** Distinct suspect reference tokens ("#12", "!4") in first-appearance order. */
export function findSuspectRefs(
  text: string,
  triggers: readonly string[] = ["#", "!"],
): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const hit of scanRefs(text, triggers)) {
    if (seen.has(hit.token)) continue;
    seen.add(hit.token);
    refs.push(hit.token);
  }
  return refs;
}

/** Backtick-wraps every suspect occurrence; everything else stays byte-identical.
 *  `wrapped` lists the distinct NEUTRALIZED forms (`` `#12` ``), not the bare
 *  tokens: its only consumer is a disclosure line inside the same comment body,
 *  and naming the bare token there would create the very cross-reference the
 *  wrapping prevents. */
export function neutralizeSuspectRefs(
  text: string,
  triggers: readonly string[] = ["#", "!"],
): { text: string; wrapped: string[] } {
  const hits = scanRefs(text, triggers);
  if (hits.length === 0) return { text, wrapped: [] };
  const seen = new Set<string>();
  const wrapped: string[] = [];
  const parts: string[] = [];
  let cursor = 0;
  for (const hit of hits) {
    parts.push(text.slice(cursor, hit.start), "`", hit.token, "`");
    cursor = hit.end;
    const form = `\`${hit.token}\``;
    if (seen.has(form)) continue;
    seen.add(form);
    wrapped.push(form);
  }
  parts.push(text.slice(cursor));
  return { text: parts.join(""), wrapped };
}

/** "#12" | "#12 and #45" | "#12, #45, and #103" | caps at 5 then "and N more". */
export function formatRefList(refs: string[]): string {
  const shown = refs.slice(0, REF_LIST_CAP);
  const extra = refs.length - shown.length;
  const items = extra > 0 ? [...shown, `${extra} more`] : shown;
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** Wraps raw AI review text in the branded GitDesktop AI-comment body. */
export function buildAiCommentBody({
  kind,
  model,
  automated,
  text,
  neutralizeRefs,
}: AiCommentParts): string {
  const meta = automated ? " · automated" : "";
  // Both triggers deliberately, no provider: this seam has none in hand, and a
  // wrapped `!N` on GitHub is a literal that never linked anyway.
  const neutralized = neutralizeRefs ? neutralizeSuspectRefs(text) : null;
  const body = neutralized?.wrapped.length ? neutralized.text : text;
  const disclosure = neutralized?.wrapped.length
    ? `\n\n_References ${formatRefList(neutralized.wrapped)} are shown as plain text — this automated run could not confirm they were meant to link._`
    : "";
  return `🤖 **GitDesktop AI ${kind}** · \`${model}\`${meta}\n\n---\n\n${body}\n\n---\n\n_Posted by [GitDesktop](${GD_COMMENT_ANCHOR}) — AI output, verify before acting on it._${disclosure}`;
}
