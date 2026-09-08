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
  /** Backtick-wrap what it can of the `#N`-style references in `text`, disclose
   *  exactly what was neutralized, and name what it could not. For the automated
   *  seam only, where nobody is present to confirm intent. */
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

/** Opens or closes a fenced block. The `^ {0,3}` anchor admits only spaces before
 *  the run, so a leading backslash already breaks the match — fences need no
 *  separate escape check. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Indented code: four spaces or a tab of leading whitespace. */
const INDENTED = /^(?: {4}|\t)/;

/** How many references a formatted list names before it counts the rest. */
const REF_LIST_CAP = 5;

/** Rewrite passes the neutralizer may take. Wrapping can UNBLOCK a trigger that the
 *  wrapped token's own trailing digit was shielding (`#1#2` → `` `#1` ``#2), so one
 *  pass can mint the very thing it removes; repeating settles it. The cap keeps a
 *  geometry neither pass converges on from looping — the post-condition in
 *  {@link neutralizeSuspectRefs} then withholds the claim instead. */
const NEUTRALIZE_PASSES = 4;

/** Matches a blank line — CommonMark's paragraph boundary, which a line of spaces
 *  or tabs satisfies just as well as an empty one. Sticky-ish by `lastIndex` so the
 *  lookahead below needs no tail slice; every use MUST set `lastIndex` first, since
 *  the flag makes that position shared state between calls. */
const BLANK_LINE = /\n[ \t]*\n/g;

/** One suspect token's position in the scanned text. */
interface RefOccurrence {
  start: number;
  end: number;
  token: string;
  /** Backtick run length a wrap here must use to be un-stealable — see
   *  {@link wrapRunLength}. */
  wrapRun: number;
}

/** The shortest backtick run a wrap can use without a live literal run in the same
 *  paragraph stealing its opener. A stray run pairs only with a run of ITS OWN
 *  length, so a length outside `strays` leaves the wrap's own two runs to pair with
 *  each other. Only as complete as `strays` is — see {@link scanRefs}, whose skip
 *  regions decide which literal runs get recorded at all. */
function wrapRunLength(strays: ReadonlySet<number>): number {
  let len = 1;
  while (strays.has(len)) len++;
  return len;
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

/** Whether the character at `i` is markdown-escaped: an ODD run of immediately
 *  preceding backslashes (a backslash escapes any ASCII punctuation; an even run is
 *  self-escaped backslashes). The neutralizer needs this too — a backslash before
 *  the wrap's opening backtick escapes it, leaving a bare live reference. */
function isEscaped(text: string, i: number): boolean {
  let slashes = 0;
  while (i - slashes - 1 >= 0 && text[i - slashes - 1] === "\\") slashes++;
  return slashes % 2 === 1;
}

/** Records every backtick run in `[from, to)` as a stray, counting runs the way the
 *  main scan does (an escaped tick is a literal that joins no run). For a region the
 *  scan SKIPS whose ticks markdown still parses. */
function recordTicks(
  text: string,
  from: number,
  to: number,
  strays: Set<number>,
): void {
  let i = from;
  while (i < to) {
    if (text[i] !== "`") {
      i++;
      continue;
    }
    if (isEscaped(text, i)) {
      i++;
      continue;
    }
    let run = 1;
    while (i + run < to && text[i + run] === "`") run++;
    strays.add(run);
    i += run;
  }
}

/** Where a code span opened at `from` must stop looking for its closer: the next
 *  blank line or the next fence line, whichever comes first. Both end the paragraph
 *  CommonMark parses the span within — a fence interrupts one, and reading past
 *  either would let a delimiter or a fenced line's content pose as a closer. */
function paragraphLimit(text: string, from: number): number {
  BLANK_LINE.lastIndex = from;
  const blank = BLANK_LINE.exec(text);
  const limit = blank ? blank.index : text.length;
  let nl = text.indexOf("\n", from);
  while (nl !== -1 && nl + 1 < limit) {
    const start = nl + 1;
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    if (FENCE.test(text.slice(start, end))) return start;
    nl = end < text.length ? end : -1;
  }
  return limit;
}

/** Whether a run of exactly `run` backticks appears at or after `from` within the
 *  paragraph. CommonMark closes a code span only on an equal-length run, so an
 *  opener without one is literal text — entering span state there would silently
 *  swallow every later reference.
 *
 *  APPROXIMATE in one direction still: another block that can interrupt a paragraph
 *  (a heading, a list) is not bounded here, so its content can pose as a closer and
 *  answer TRUE where markdown would not. That arm opens a span the renderer never
 *  opens, which under-detects — the status quo — and produces no wrap, so the
 *  post-condition in {@link neutralizeSuspectRefs} keeps the disclosure honest. */
function hasClosingRun(text: string, from: number, run: number): boolean {
  const limit = paragraphLimit(text, from);
  let i = from;
  while (i < limit) {
    if (text[i] !== "`") {
      i++;
      continue;
    }
    let n = 1;
    while (i + n < limit && text[i + n] === "`") n++;
    if (n === run) return true;
    i += n;
  }
  return false;
}

/**
 * Every suspect reference occurrence in `text`, in source order — the ONE scan
 * both {@link findSuspectRefs} and {@link neutralizeSuspectRefs} consume, so the
 * warning and the rewrite can never disagree about what counts.
 *
 * The scan never fires inside four REGIONS: fenced blocks, inline code spans,
 * markdown link syntax, and indented code. Their boundaries are approximate and
 * deliberately over-skip at the margins (a lazy paragraph continuation indented
 * four spaces, say), failing toward the status quo — no warning, no rewrite — the
 * safe direction for both callers.
 *
 * Backslash parity is an EXACT rule, not an approximation, and it gates all three
 * syntax-recognizing sites: the trigger character, a span's opening backtick run,
 * and a link's opening bracket. An escape-blind opener is the dangerous direction —
 * it would enter a region that markdown never enters and hide the refs after it.
 *
 * Each occurrence also carries the wrap run length the neutralizer must use there,
 * derived from the literal backtick runs this scan believes are live for pairing.
 * Which skipped regions contribute those: fence content NO and indented code NO
 * (both are blocks, their ticks never pair), span content NO (the span consumed
 * them), link regions YES (spans parse before links) — so the link arm alone feeds
 * `strays` on skip. Every claim built on that set is SCANNER-RELATIVE; the
 * marked-oracle test in `scripts/comment-refs.test.mjs` is what grounds it against
 * a real parser.
 */
function scanRefs(text: string, triggers: readonly string[]): RefOccurrence[] {
  const out: RefOccurrence[] = [];
  if (triggers.length === 0) return out;
  let fence: { char: string; len: number } | null = null;
  // The open code span's backtick-run length; 0 when none. A run of N backticks
  // closes at the next run of exactly N (CommonMark), and a span may cross lines.
  let span = 0;
  // Lengths of the unpaired literal runs seen so far in THIS paragraph; inline
  // syntax is paragraph-scoped, so a blank line clears them.
  let strays = new Set<number>();
  let lineStart = 0;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.slice(lineStart, lineEnd);
    if (line.trim() === "") strays = new Set();
    // Block structure is only readable outside a code span: an open span swallows
    // whatever it crosses, fence lines included.
    if (span === 0) {
      const fenced = FENCE.exec(line);
      if (fence) {
        if (
          fenced &&
          fenced[1][0] === fence.char &&
          fenced[1].length >= fence.len &&
          line.slice(fenced[0].length).trim() === ""
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
      if (INDENTED.test(line)) {
        lineStart = lineEnd + 1;
        continue;
      }
    }
    let i = lineStart;
    while (i < lineEnd) {
      const ch = text[i];
      if (ch === "`") {
        // An escaped backtick is a literal character the renderer consumes with its
        // backslash, so it neither opens a span nor joins the run that follows it.
        if (span === 0 && isEscaped(text, i)) {
          i++;
          continue;
        }
        let run = 1;
        while (i + run < lineEnd && text[i + run] === "`") run++;
        // Escapes do not work inside a code span, so the closing arm is unguarded;
        // a run that never meets its match stays literal and can steal a wrap.
        if (span === run) span = 0;
        else if (span === 0) {
          if (hasClosingRun(text, i + run, run)) span = run;
          else strays.add(run);
        }
        i += run;
        continue;
      }
      if (span > 0) {
        i++;
        continue;
      }
      if (ch === "[" && !isEscaped(text, i)) {
        const skip = linkEnd(text, i, lineEnd);
        if (skip > i) {
          // Code spans parse BEFORE links, so a tick inside the region this arm
          // jumps is still live for pairing and must not be missed by `strays`.
          recordTicks(text, i, skip, strays);
          i = skip;
        } else {
          i++;
        }
        continue;
      }
      if (
        triggers.includes(ch) &&
        !(i > 0 && BLOCKED_BEFORE.test(text[i - 1])) &&
        !isEscaped(text, i)
      ) {
        const num = REF_NUMBER.exec(text.slice(i + 1, i + 1 + REF_NUMBER_SPAN));
        if (num) {
          const end = i + 1 + num[0].length;
          out.push({
            start: i,
            end,
            token: text.slice(i, end),
            wrapRun: wrapRunLength(strays),
          });
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

/**
 * Backtick-wraps every suspect occurrence; the rest of the text stays byte-identical
 * apart from a separating space where a wrap would otherwise fuse with an adjacent
 * literal backtick. The run length is per-occurrence rather than always one tick,
 * because a stray unpaired tick earlier in the paragraph would otherwise pair with
 * the wrap's OPENER and leave the reference bare and live outside the resulting span.
 *
 * Both `wrapped` and `survived` list backticked forms (`` `#12` ``), never bare
 * tokens: their only consumers are disclosure lines inside the same comment body,
 * and naming a bare token there would create the very cross-reference the wrapping
 * prevents. The split is the post-condition — re-scanning the output decides which
 * list a ref lands in, so a geometry this scan approximates wrongly is REPORTED as
 * un-neutralized rather than silently claimed. The text keeps every attempted wrap
 * either way. `survived` carries run-1 forms because its reader renders it in the
 * footer's own fresh paragraph, where no stray from the body can reach it.
 */
export function neutralizeSuspectRefs(
  text: string,
  triggers: readonly string[] = ["#", "!"],
): { text: string; wrapped: string[]; survived: string[] } {
  const forms = new Map<string, string>();
  let out = text;
  for (let pass = 0; pass < NEUTRALIZE_PASSES; pass++) {
    const hits = scanRefs(out, triggers);
    if (hits.length === 0) break;
    const parts: string[] = [];
    let cursor = 0;
    for (const hit of hits) {
      const ticks = "`".repeat(hit.wrapRun);
      // A wrap tick touching a literal one FUSES into a longer run, so the chosen
      // length is no longer what the renderer sees and the two ends stop pairing.
      // A separating space is the only added character this rewrite ever makes.
      const before =
        hit.start > 0 &&
        out[hit.start - 1] === "`" &&
        !isEscaped(out, hit.start - 1)
          ? " "
          : "";
      const after = out[hit.end] === "`" ? " " : "";
      parts.push(
        out.slice(cursor, hit.start),
        before,
        ticks,
        hit.token,
        ticks,
        after,
      );
      cursor = hit.end;
      // Pass 0 fixes WHICH refs the caller may be told about; later passes only
      // refresh a form they re-wrapped, so the disclosure names what shipped.
      if (pass === 0 || forms.has(hit.token)) {
        forms.set(hit.token, `${ticks}${hit.token}${ticks}`);
      }
    }
    parts.push(out.slice(cursor));
    out = parts.join("");
  }
  if (out === text) return { text, wrapped: [], survived: [] };
  const survivors = new Set(findSuspectRefs(out, triggers));
  const wrapped: string[] = [];
  const survived: string[] = [];
  for (const [token, form] of forms) {
    if (survivors.has(token)) survived.push(`\`${token}\``);
    else wrapped.push(form);
  }
  return { text: out, wrapped, survived };
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
  // The wraps stay in the body whatever the guard concluded; only the CLAIM is
  // gated, so an unverifiable wrap ships silently rather than as a false promise.
  const body = neutralized?.text ?? text;
  const done = neutralized?.wrapped.length
    ? formatRefList(neutralized.wrapped)
    : "";
  const missed = neutralized?.survived.length
    ? formatRefList(neutralized.survived)
    : "";
  let disclosure = "";
  if (done) {
    const couldNot = missed ? ` It could not neutralize ${missed}.` : "";
    disclosure = `\n\n_References ${done} are shown as plain text — this automated run could not confirm they were meant to link.${couldNot}_`;
  } else if (missed) {
    disclosure = `\n\n_This automated run could not neutralize ${missed} — verify before trusting any links it created._`;
  }
  return `🤖 **GitDesktop AI ${kind}** · \`${model}\`${meta}\n\n---\n\n${body}\n\n---\n\n_Posted by [GitDesktop](${GD_COMMENT_ANCHOR}) — AI output, verify before acting on it._${disclosure}`;
}
