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
 * never rewrites the text, while the automated seam (where nobody is present to
 * confirm) neutralizes what it can and names what it could not, via
 * {@link AiCommentParts.neutralizeRefs}.
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

/** Trigger characters that autolink per provider — mirrors the NUMERIC triggers of
 *  the app's renderer (`src/components/markdown/markdown-refs.ts`), whose `@`
 *  user-mention trigger is deliberately out of scope here: a mention notifies a
 *  person, not a thread, and neither seam rewrites one. Bitbucket autolinks
 *  neither number trigger, so it detects nothing there by design. */
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

/** A blank line, CommonMark's own definition: spaces and tabs only. `String.trim`
 *  is NOT the same test — it also strips NBSP, U+2028 and the rest of Unicode
 *  whitespace, and a line the renderer treats as content while this scan treats it
 *  as a boundary is exactly how a wrap lands inside a region that never closed. */
const BLANK = /^[ \t]*$/;

/** Container markers CommonMark strips before a leaf block ever sees its line:
 *  blockquote first, then at most one list marker. An HTML block opens at that
 *  CONTENT column, so `> <details>` starts one just as a bare `<details>` does. */
const QUOTE_PREFIX = /^(?: {0,3}> ?)+/;
const LIST_MARKER = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/;

/** CommonMark's type-6 HTML-block tag list (spec 0.31.2), verbatim and in the
 *  spec's order. A line whose first non-space run is `<` or `</` plus one of these
 *  opens a RAW block that runs to the next blank line, and unlike a fence it may
 *  interrupt a paragraph. Written as one split string because the only consumer is
 *  the alternation below, which a 62-line literal would bury. */
const HTML_BLOCK_TAGS =
  "address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul".split(
    " ",
  );

/** Type 6: a known block tag closed by whitespace, `>`, `/>`, or the line's end —
 *  so a single-line `<details><summary>x</summary> text` opens one too. Tag names
 *  are case-insensitive. */
const HTML_BLOCK_TYPE_6 = new RegExp(
  `^ {0,3}</?(?:${HTML_BLOCK_TAGS.join("|")})(?:[ \\t]|/?>|$)`,
  "i",
);

const HTML_TAG_NAME = "[A-Za-z][A-Za-z0-9-]*";
const HTML_ATTR = `[ \\t]+[a-zA-Z_:][\\w.:-]*(?:[ \\t]*=[ \\t]*(?:[^ \\t"'=<>\`]+|'[^']*'|"[^"]*"))?`;

/** Type 7: one COMPLETE open or closing tag alone on a line, any tag name. Unlike
 *  types 1 and 6 it cannot interrupt a paragraph, so it needs a BLOCK START under
 *  it: either a line whose predecessor left no open paragraph, or a container
 *  opening on the line itself ({@link opensContainer}). Both halves are load-bearing
 *  and the gate is this arm's own — the indented and definition arms read the
 *  paragraph flag alone. */
const HTML_BLOCK_TYPE_7 = new RegExp(
  `^ {0,3}(?:<${HTML_TAG_NAME}(?:${HTML_ATTR})*[ \\t]*/?>|</${HTML_TAG_NAME}[ \\t]*>)[ \\t]*$`,
);

/** A COMPLETE inline tag starting here — the type-7 shapes without the line anchors.
 *  Sticky, so it can be tried at a position without slicing; the caller still has to
 *  reject a match that ran past the line, since a quoted attribute value may hold a
 *  newline. */
const INLINE_TAG = new RegExp(
  `(?:<${HTML_TAG_NAME}(?:${HTML_ATTR})*[ \\t]*/?>|</${HTML_TAG_NAME}[ \\t]*>)`,
  "y",
);

/**
 * The end index (exclusive) of a complete inline tag opening at `open`, or `open` when
 * what is there is not one. The WHOLE tag is skipped, attribute values and all: it is
 * raw-HTML markup rather than a text node, so no reference inside it is live and a
 * wrap there corrupts the tag — a quoted `href="#123"` becomes ``href="`#123`"`` and
 * the link breaks, while an unquoted one stops parsing as HTML altogether.
 *
 * Ticks inside the tag are NOT recorded as strays. CommonMark gives code spans and raw
 * HTML equal precedence and lets the leftmost win; this arm is only reached with no
 * span open, so the tag genuinely starts first and its backticks are raw. A tick
 * BEFORE the tag wins instead, and the scan is already in span state by then.
 */
function inlineTagEnd(text: string, open: number, limit: number): number {
  INLINE_TAG.lastIndex = open;
  const tag = INLINE_TAG.exec(text);
  if (!tag) return open;
  const end = open + tag[0].length;
  return end <= limit && !tag[0].includes("\n") ? end : open;
}

/** Type 1, the raw-text tags. Their block ignores blank lines entirely and ends only
 *  at {@link RAW_TEXT_CLOSE} — which CommonMark takes as ANY of the four closing tags
 *  anywhere on a line, the opener's own line included. Note the start condition
 *  admits no `/>`, per the spec. */
const RAW_TEXT_OPEN = /^ {0,3}<(?:pre|script|style|textarea)(?:[ \t]|>|$)/i;
const RAW_TEXT_CLOSE = /<\/(?:pre|script|style|textarea)>/i;

/** Whether `line` (at its content column) opens a raw HTML block — see
 *  {@link scanRefs} for why the region suppresses wrapping without suppressing
 *  detection. */
function opensHtmlBlock(line: string, atParagraphStart = true): boolean {
  return (
    RAW_TEXT_OPEN.test(line) ||
    HTML_BLOCK_TYPE_6.test(line) ||
    (atParagraphStart && HTML_BLOCK_TYPE_7.test(line))
  );
}

/** The two raw-block starts CommonMark lets INTERRUPT a paragraph (types 1 and 6);
 *  type 7 needs a blank line before it. The block pass runs before inline parsing,
 *  so one of these beats an open code span rather than sitting inside it. */
function interruptsParagraph(line: string): boolean {
  return RAW_TEXT_OPEN.test(line) || HTML_BLOCK_TYPE_6.test(line);
}

/** A link reference definition's opening: `[label]:` at the content column, where the
 *  label holds no unescaped bracket. The capture exists to reject an all-whitespace
 *  label, which CommonMark does not accept. This matches the OPENING only; whether
 *  the line is really a definition is {@link DEFINITION_TAIL}'s call, and a line that
 *  fails there is a paragraph whose references stay scannable. */
const LINK_DEFINITION = /^ {0,3}\[((?:[^\\[\]]|\\.)*)\]:/;

/** What must follow that `]:` for the line to BE a definition: a destination, then
 *  the line's end or a title. `[issue #5]: not a valid url` fails it — a bare
 *  destination cannot hold spaces — and CommonMark renders that line as a paragraph
 *  whose refs are live, so a prefix-only test would silence them. Control characters
 *  are not excluded from the bare form (biome bans them in a class, and they cannot
 *  occur meaningfully here); that over-accepts, which only ever over-skips. */
const DEFINITION_TAIL =
  /^[ \t]*(?:<(?:[^<>\\]|\\.)*>|(?:[^\s\\]|\\.)+)(?:[ \t]+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\)))?[ \t]*$/;

/** An ATX heading, and the two shapes a GFM table row takes. Both are leaf blocks
 *  that close any paragraph above them. */
const ATX_HEADING = /^ {0,3}#{1,6}([ \t]|$)/;
const TABLE_ROW = /^ {0,3}\||\|[ \t]*$/;

/** A letter or a digit, in any script — what tells prose from the punctuation-only
 *  lines (setext underlines, thematic breaks) that are structure. */
const HAS_TEXT = /[\p{L}\p{N}]/u;

/** The two punctuation-only lines that really are block starts, as opposed to prose
 *  that merely happens to carry no letters. */
const THEMATIC_BREAK =
  /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;

/**
 * Whether this line unconditionally ENDS the paragraph above it. A code span cannot
 * cross a paragraph boundary, so {@link paragraphLimit} stops here: a closer beyond
 * one of these belongs to another block and must never pair with an opener before it.
 *
 * Deliberately NARROWER than the inverse of {@link leavesOpenParagraph}, because the
 * two answer for opposite polarities. That one may guess "no open paragraph" freely —
 * its consumer then reads an indented line as code, which over-skips. This one may
 * not: a wrong YES splits a paragraph the renderer keeps whole, so the span never
 * opens and a reference the renderer had already made inert is wrapped inside
 * rendered code and claimed neutralized. Hence prose without letters (a line of
 * emoji, `!!!`) stays paragraph content here, and so does a `| a | b |` line, which
 * is only a table when a delimiter row follows it.
 */
function breaksParagraph(quoted: string): boolean {
  return (
    ATX_HEADING.test(quoted) ||
    THEMATIC_BREAK.test(quoted) ||
    SETEXT_UNDERLINE.test(quoted)
  );
}

/**
 * Whether this line leaves an OPEN PARAGRAPH behind it, which is the one thing that
 * stops the next line from starting a block. Only a line recognized as paragraph
 * content answers YES; everything else — a blank line, a heading, a table row, and
 * any punctuation-only line, including shapes not modelled here — answers NO, so an
 * indented line after it stays code and stays skipped.
 *
 * The polarity is the point. Guessing YES for an unmodelled leaf would let the next
 * indented line be wrapped inside rendered code while the footer claimed it was
 * neutralized; guessing NO merely over-skips, which is the status quo. The
 * approximations lean that way too: a line of pure punctuation reads as structure
 * even when it is really prose, and so does any line ending in a pipe, since
 * {@link TABLE_ROW}'s trailing alternative is unanchored. Both cost a detection
 * after such a line, never a false claim.
 *
 * TABLE_ROW is deliberately left loose. Tightening it to "a leading pipe, or two
 * pipes" would recover `a table |` as prose, but `use a || b` would then read as a
 * table row and lose ITS following line instead — one missed reference traded for
 * another. The honest fix is GFM's actual rule, where a table exists only when the
 * NEXT line is a delimiter row, and that is a lookahead this line-at-a-time model
 * does not have.
 *
 * KNOWN DEPTH-BLINDNESS, left as it is: this reads the line's CONTENT and never its
 * container depth, so an open paragraph carries across a depth INCREASE — in
 * `intro\n>     #5` the flag survives into the blockquote and the indented line
 * there is scanned as prose, wrapping a reference inside quoted indented code.
 * Mangling only, since indented code never autolinks; fixing it means tracking the
 * container stack, not another line test.
 */
function leavesOpenParagraph(quoted: string): boolean {
  if (BLANK.test(quoted)) return false;
  const inner = quoted.replace(LIST_MARKER, "");
  if (ATX_HEADING.test(inner) || TABLE_ROW.test(inner)) return false;
  return HAS_TEXT.test(quoted);
}

/** Whether `line` can serve as a definition's DEFERRED destination — the line after a
 *  `]:` that ended its own line, where `depth` is that line's own blockquote depth.
 *  CommonMark settles BLOCK STRUCTURE before it looks for link reference
 *  definitions, so any line that STARTS a block ends the definition instead of
 *  supplying its destination: a fence, a raw-HTML or ATX opener, a setext underline
 *  or thematic break (both punctuation-only, hence the text test), and any container
 *  that opens here. A container already open is a different matter — a quoted
 *  definition's destination carries the same `>` its label did — so the depths are
 *  compared rather than required to be zero. */
function opensDeferredDestination(line: string, depth: number): boolean {
  // Only a container that OPENS ends the definition. A shallower line is a lazy
  // continuation, which CommonMark folds back into the same paragraph, so the
  // destination still belongs to the definition and rewriting it corrupts the URL.
  if (quoteDepth(line) > depth) return false;
  const content = line.replace(QUOTE_PREFIX, "");
  return (
    DEFINITION_TAIL.test(content) &&
    HAS_TEXT.test(content) &&
    !FENCE.test(content) &&
    !ATX_HEADING.test(content) &&
    !interruptsParagraph(content) &&
    !LIST_MARKER.test(content)
  );
}

/** Whether `line` starts a container relative to `depth`. A RISE always does, and so
 *  does a list marker; a DROP depends on what the caller is asking, which is what
 *  `lazyContinues` selects.
 *
 *  With `lazyContinues` false — the type-7 arm's reading, and the default — any
 *  change counts, because that arm must fail OPEN: over-holding costs a truthful
 *  disclosure while a missed block start costs a false claim.
 *
 *  With it true, a shallower line is a LAZY CONTINUATION that CommonMark folds back
 *  into the paragraph above, so it starts nothing — the same rule
 *  {@link opensDeferredDestination} follows. {@link paragraphLimit} passes its own
 *  open-paragraph state here, since a span really does reach across such a line.
 *
 *  The two call sites therefore diverge ON PURPOSE, and only on drops. The scan may
 *  then open a type-7 region inside a span the limit let form; the `span === 0` guard
 *  shuts the HTML arm there, which is what the renderer does too.
 *
 *  A list DEDENT is invisible to this function — measuring one needs the item's
 *  content column — so the type-7 gate carries a separate stand-in for it: a tag at a
 *  column the last list marker's content had left counts as a transition there. That
 *  heuristic can only ever HOLD a reference, and holding is truthful under both
 *  readings of the shape (outside the item its refs are raw HTML; inside it they are
 *  prose), so it cannot produce a false claim. What it costs is the occasional
 *  over-hold, disclosed honestly; and it deliberately ignores a tag indented INTO the
 *  item, which the ordinary arms handle. */
function opensContainer(
  line: string,
  depth: number,
  lazyContinues = false,
): boolean {
  const lineDepth = quoteDepth(line);
  return (
    lineDepth > depth ||
    (!lazyContinues && lineDepth !== depth) ||
    LIST_MARKER.test(line.replace(QUOTE_PREFIX, ""))
  );
}

/** How many blockquote markers a line opens with. A fence must pair at the SAME
 *  depth: an unquoted ``` line does not close one opened inside a blockquote. */
function quoteDepth(line: string): number {
  const marker = QUOTE_PREFIX.exec(line);
  if (!marker) return 0;
  let depth = 0;
  for (const ch of marker[0]) if (ch === ">") depth++;
  return depth;
}

/** The line as its innermost leaf block sees it, container markers removed. */
function containerContent(line: string): string {
  return line.replace(QUOTE_PREFIX, "").replace(LIST_MARKER, "");
}

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
const BLANK_LINE = /\r?\n[ \t]*\r?\n/g;

/**
 * A line's text for CLASSIFICATION, with the CR of a CRLF pair removed.
 *
 * The scan splits on `\n`, so under CRLF every line would otherwise carry a trailing
 * `\r` — and each line test is anchored at `$`, so a blank line would not read blank,
 * a closing fence's tail would not read empty, and the fence would run to the end of
 * the comment swallowing every reference after it. Stripping at EXTRACTION fixes all
 * of them at once.
 *
 * Offsets are never derived from this string. The raw text keeps feeding `lineStart`
 * / `lineEnd`, so wraps still land at positions in the original and every untouched
 * region stays byte-identical — which is why the input is not normalized instead.
 */
function classifyLine(text: string, start: number, end: number): string {
  const stop = end > start && text[end - 1] === "\r" ? end - 1 : end;
  return text.slice(start, stop);
}

/** One suspect token's position in the scanned text. */
interface RefOccurrence {
  start: number;
  end: number;
  token: string;
  /** Backtick run length a wrap here must use to be un-stealable — see
   *  {@link wrapRunLength}. */
  wrapRun: number;
  /** Inside a raw HTML block, where a wrap would emit literal backticks and
   *  neutralize nothing. Reported, never rewritten — see {@link scanRefs}. */
  htmlBlock: boolean;
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

/** A link label reduced to its matching key, per CommonMark: internal whitespace runs
 *  collapse to one space, the ends are trimmed, and case folds away. `toLowerCase` is
 *  a near-fold rather than the spec's full Unicode one — but the definition and the
 *  use site both come through HERE, so any divergence only fails to resolve a pair,
 *  which lands on the status quo of scanning the brackets as prose. */
function normalizeLabel(label: string): string {
  return label
    .replace(/[ \t\r\n\f]+/g, " ")
    .replace(/^ | $/g, "")
    .toLowerCase();
}

/** Index of the `]` closing the bracket span opened at `open`, or -1 when none does
 *  before `limit`. An escaped bracket is content, not structure. */
function bracketEnd(text: string, open: number, limit: number): number {
  let depth = 0;
  for (let i = open; i < limit; i++) {
    if (isEscaped(text, i)) continue;
    const ch = text[i];
    if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) return i;
  }
  return -1;
}

/** The end index (exclusive) of a REFERENCE link opening at `open` whose label one of
 *  `labels` defines, or `open` when nothing resolves. All three forms: shortcut
 *  `[label]`, collapsed `[label][]`, and full `[text][label]` — the last resolves on
 *  the SECOND bracket, and skipping from `open` covers the text's own refs, which
 *  render inside the anchor where no forge filter reaches them. */
function referenceEnd(
  text: string,
  open: number,
  limit: number,
  labels: ReadonlySet<string>,
): number {
  if (labels.size === 0) return open;
  const close = bracketEnd(text, open, limit);
  if (close === -1) return open;
  const first = normalizeLabel(text.slice(open + 1, close));
  if (text[close + 1] !== "[") return labels.has(first) ? close + 1 : open;
  const second = bracketEnd(text, close + 1, limit);
  if (second === -1) return open;
  const inner = text.slice(close + 2, second);
  return labels.has(inner === "" ? first : normalizeLabel(inner))
    ? second + 1
    : open;
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

/** Where a code span opened at `from` must stop looking for its closer: whichever
 *  comes first of the next blank line, container start, paragraph-interrupting line
 *  ({@link breaksParagraph}), fence line, or raw-HTML-block opener. Every one ends
 *  the paragraph CommonMark parses the span within — the block pass runs before
 *  inline parsing — so reading past any of them would let a delimiter or another
 *  block's content pose as a closer. The bounding line itself is EXCLUDED: the index
 *  returned is its first character, and the caller's window is half-open.
 *
 *  Two of those need spelling out. A `>`-only line is a blockquote's blank line, and
 *  `BLANK_LINE` cannot see it — that pattern wants two newlines — so the gate tests
 *  the quote-stripped line itself. And the OPENER's own line may be the block that
 *  ends: a heading can carry a backtick and still close at its line end, so the
 *  search is capped there before the walk begins. A drop in depth, by contrast, is a
 *  lazy continuation while a paragraph is open, and does NOT bound. */
function paragraphLimit(text: string, from: number): number {
  BLANK_LINE.lastIndex = from;
  const blank = BLANK_LINE.exec(text);
  const limit = blank ? blank.index : text.length;
  // The block state the scan's own arm would carry, walked line by line from the one
  // the span opened on. Both halves matter: a type-7 tag needs a block start, which
  // is EITHER a line whose predecessor left no open paragraph OR a container opening
  // here. Seeding from the opener rather than assuming it is paragraph content keeps
  // a heading (which can hold a backtick and yet ends the paragraph) honest.
  const openerStart = text.lastIndexOf("\n", from - 1) + 1;
  let openerEnd = text.indexOf("\n", openerStart);
  if (openerEnd === -1) openerEnd = text.length;
  const opener = classifyLine(text, openerStart, openerEnd);
  // The opener's OWN line can be the block that ends here — a heading may carry a
  // backtick and still close at its line end, so nothing after it can be the closer.
  // `openerEnd` never exceeds `limit`: the earliest newline at or after `from` is the
  // opener's own, and `BLANK_LINE` needs one before it can match.
  if (breaksParagraph(opener.replace(QUOTE_PREFIX, ""))) return openerEnd;
  let prevDepth = quoteDepth(opener);
  let openParagraph = leavesOpenParagraph(opener.replace(QUOTE_PREFIX, ""));
  let nl = text.indexOf("\n", from);
  while (nl !== -1 && nl + 1 < limit) {
    const start = nl + 1;
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    const line = classifyLine(text, start, end);
    const quoted = line.replace(QUOTE_PREFIX, "");
    // Read before the state advances, so each line is judged by what the one above it
    // left behind — the same order the scan's arm uses.
    if (
      BLANK.test(quoted) ||
      opensContainer(line, prevDepth, openParagraph) ||
      breaksParagraph(quoted) ||
      FENCE.test(quoted) ||
      opensHtmlBlock(containerContent(line), !openParagraph)
    )
      return start;
    openParagraph = leavesOpenParagraph(quoted);
    prevDepth = quoteDepth(line);
    nl = end < text.length ? end : -1;
  }
  return limit;
}

/** Whether a run of exactly `run` backticks appears at or after `from` within the
 *  paragraph. CommonMark closes a code span only on an equal-length run, so an
 *  opener without one is literal text — entering span state there would silently
 *  swallow every later reference.
 *
 *  APPROXIMATE in one narrow place. {@link paragraphLimit} bounds at blank lines,
 *  container starts, headings, thematic breaks, setext underlines, fences and
 *  HTML-block starts — every paragraph interruption recognizable from a single line.
 *  What it cannot see is a GFM TABLE: `| a | b |` is ordinary prose until a delimiter
 *  row follows it, and that lookahead is beyond a line-at-a-time model. A span can
 *  therefore still pair across a real table and swallow a reference the renderer
 *  leaves live in a cell — a silent miss, sharing its missing-lookahead root cause
 *  with the table arm of {@link leavesOpenParagraph}. */
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
 * The scan never fires inside five SKIP regions: fenced blocks, inline code spans,
 * markdown link syntax (inline `[text](dest)` plus the three reference forms —
 * shortcut `[label]`, collapsed `[label][]`, and full `[text][label]`), indented
 * code, and link reference definition lines. Their boundaries are approximate, but
 * NOT uniformly in one direction any more, so each arm states its own:
 *   - fence: over-skips, and its container-depth model is why (see below);
 *   - indented code and definitions: gated on where a block may START, so they can
 *     under-skip a line the renderer would have treated as a block;
 *   - code spans: the closer search over-reaches past blocks it does not model,
 *     which opens a span the renderer never opens and under-detects;
 *   - link syntax: over-skips, since a resolving label need not be a link.
 * Where an arm can go either way the choice is spelled out at its own site; nothing
 * here silently assumes over-skipping is always the outcome.
 *
 * Two of those regions are gated on where a block may START, because CommonMark
 * forbids both from interrupting a paragraph: an indented line is code only at a
 * paragraph start (`Review notes:\n    Fixes #123` is prose with a LIVE reference,
 * not a code block), and a definition line likewise. That gate needs no block state
 * of its own — a skipped line leaves the paragraph-start flag set, so a real
 * indented block keeps its later lines, blank lines included. What COUNTS as a
 * paragraph start is {@link leavesOpenParagraph}'s call, and it answers
 * conservatively: any line it cannot recognize as paragraph content leaves the next
 * indented line skipped, because the opposite guess wraps inside rendered code and
 * claims the reference was neutralized.
 *
 * A reference form only skips when its label actually RESOLVES against a definition
 * this text carries, which is why {@link scanRefs} walks the lines twice: phase 0
 * collects the labels, phase 1 scans. Both walks run the same classification, so a
 * definition inside a fence, an indent, or raw HTML is code and defines nothing, and
 * its use site stays prose — matching what the renderer does with it. Resolution has
 * to be the gate: skipping every bracket span would ship a live `#N` out of `see
 * [maybe #5] there`, while skipping none breaks real links, because a wrap inside a
 * label defeats a lookup that only case-folds and collapses whitespace. Where a
 * resolving span is not a link after all (a code span crossing the bracket), the
 * skip is an over-skip — status quo, and the safe side.
 *
 * ONE STRUCTURAL CLASS IS LEFT: every inline construct here is recognized within a
 * single LINE, while CommonMark lets these run across a newline. Three known
 * instances, all renderer-verified:
 *   - a reference label — `[a\n#5]` against a matching definition wraps and the
 *     link dies as bracket text;
 *   - an inline destination — `[see](\n#123\n)` wraps and the href becomes
 *     `%60#123%60`;
 *   - a definition TITLE on its own continuation line, which the definition arm
 *     does not follow — the href survives and only the tooltip gains backticks.
 * Closing the class means a character scan that can consume across line
 * boundaries, which the line-driven block model this function is built on cannot
 * express — a structural change rather than another region rule.
 *
 * The definition line is the one region skipped to prevent DAMAGE rather than a
 * false claim. It renders nothing: the label is consumed and the destination
 * becomes an href, which no forge's reference filter rewrites, so a `#N` there was
 * never live and warning about it is a false positive. Worse, a wrap would land
 * INSIDE the URL — the renderer percent-encodes the backticks into the
 * destination — so the automated seam would corrupt a working link. Recognition is
 * bounded to lines where a paragraph could start, CommonMark's own rule, because a
 * definition-shaped line that merely continues a paragraph really does render as
 * prose. A malformed definition at a genuine start is skipped anyway; that is an
 * under-detect, the status-quo direction.
 *
 * A deferred destination must not be a BLOCK START — see
 * {@link opensDeferredDestination}. Block structure is settled before definitions
 * are looked for, so `[d]:` over `---`, `***`, a fence, a type-1/6 tag, or any
 * container marker leaves both references live rather than minting a definition.
 * `## H` needs no rule of its own: a space makes it an invalid bare destination and
 * {@link DEFINITION_TAIL} already rejects it.
 *
 * ORACLE DIVERGENCE, worth knowing before trusting a test here: marked 18.0.11
 * disagrees on the leaf shapes — it swallows `---`, `***`, a type-6 tag or a fence
 * line into the destination and renders the pair as an empty definition. GitHub
 * renders `[d #5]:` over `---` as a HEADING carrying a live linked reference
 * (probed 2026-09-08), which is what CommonMark's two-phase parse predicts. Where
 * the two disagree the FORGE wins, since predicting the forge is this module's whole
 * job; the suite pins those shapes directly and excludes them from its
 * marked-oracle sweep.
 *
 * A sixth region, the raw HTML block (CommonMark types 1, 6 and 7), is DETECTED
 * but never rewritten. A forge's reference filter runs inside raw HTML, so a `#N`
 * there really does autolink and the manual seam must still warn about it; a
 * backtick wrap there, though, is literal text that mangles the block while the
 * reference stays live. So its occurrences carry `htmlBlock` and
 * {@link neutralizeSuspectRefs} routes them into `survived` for the footer to
 * name. Region starts are read at the CONTAINER CONTENT COLUMN, since a `> ` or a
 * list marker does not stop a block from opening. The fence arm reads both kinds of
 * marker, and pairs each fence against the container it opened in: a quoted one by
 * blockquote depth, a `- ~~~` one by the item's content column. An unrecognized
 * opener was never merely cosmetic — its own closer would go on to open a PHANTOM
 * fence that swallowed the rest of the comment, so the wrap inside the code example
 * came with a silently missed reference after it.
 *
 * Paragraph state IS tracked ({@link leavesOpenParagraph}), and the type-7 arm reads
 * it alongside {@link opensContainer}. What remains is that pair answering YES too
 * readily: `text` then `2. <span>` looks like a container start, but an ordered list
 * beginning at 2 cannot interrupt a paragraph, so no block opens and the reference
 * below stays ordinary prose. The scan holds it and discloses it — an over-hold with
 * a TRUTHFUL disclosure, which is the polarity this arm is built for. Over-warning
 * is the tolerable failure; a false claim of neutralization is not.
 *
 * The inline-HTML family splits two ways, and both are handled. A `#N` inside a
 * complete inline TAG is markup: no filter rewrites it, and wrapping it corrupts the
 * tag, so {@link inlineTagEnd} skips the whole thing. A `#N` in an element's TEXT
 * (`<span>see #5</span>`) is LIVE — the filter walks text nodes and that is one — so
 * it is detected and wrapped like any other prose. What is left of the family is a
 * tag this line-local grammar cannot complete: one split across lines, or a
 * malformed one. Those fall through to being scanned as prose, which is where the
 * cross-line class below already leaves them.
 *
 * Backslash parity is an EXACT rule, not an approximation. It still GATES the two
 * region openers, a span's opening backtick run and a link's opening bracket, where
 * an escape-blind opener is the dangerous direction: it would enter a region
 * markdown never enters and hide every reference after it. At the TRIGGER it no
 * longer gates but decides — an escaped trigger is a candidate whenever
 * `escapedRefsLive` says the forge would link it anyway, and the occurrence then
 * begins at the backslash run so the wrap encloses it rather than being escaped by
 * it. {@link findSuspectRefs} carries the forge split behind that flag.
 *
 * Each occurrence also carries the wrap run length the neutralizer must use there,
 * derived from the literal backtick runs this scan believes are live for pairing.
 * Which regions contribute those: fence content NO and indented code NO (both are
 * blocks, their ticks never pair), span content NO (the span consumed them), raw
 * HTML block content NO (a block parses no inline syntax at all, so its ticks are
 * ordinary characters that no code span outside the block can ever pair with),
 * link regions YES, inline and reference alike (spans parse before links, so a tick
 * inside a label is still live for pairing), definition lines YES — a valid one
 * renders nothing and could pair with nothing, but the INVALID lines this arm also
 * skips are prose whose ticks are live, and over-recording only lengthens a wrap —
 * so the link and definition arms are what feed `strays`. Every claim built on that
 * set is SCANNER-RELATIVE; the marked-oracle test in `scripts/comment-refs.test.mjs`
 * is what grounds it against a real parser, except where marked itself diverges from
 * the forges — those fixtures are pinned directly instead.
 */
function scanRefs(
  text: string,
  triggers: readonly string[],
  escapedRefsLive: boolean,
): RefOccurrence[] {
  const out: RefOccurrence[] = [];
  if (triggers.length === 0) return out;
  // A reference link resolves against a definition that may sit ANYWHERE in the
  // document, so phase 0 walks the lines first and collects the labels. Both phases
  // run the same line classification AND the same character scan, so the pre-pass
  // honours every region the scan does — no definition inside a fence, an indent,
  // raw HTML, or a multi-line code span is ever collected.
  //
  // The one thing phase 0 lacks is the label set it is building, so a `[` it cannot
  // resolve is walked into rather than skipped. NO COUNTEREXAMPLE HAS BEEN FOUND to
  // the claim that this only ever shrinks the label set: the subset argument is
  // solid for the reference lookups themselves, but the span-state divergence it can
  // cause has not been proven monotonic, so treat the direction as observed rather
  // than guaranteed. That divergence can open a code span phase 1
  // never opens, which suppresses a definition line phase 0 would otherwise have
  // collected — a SMALLER label set, so fewer use sites are skipped and more
  // references are reported. Under-collecting is the safe direction here, and two
  // passes settle it: nothing feeds back into phase 0.
  const labels = new Set<string>();
  let phase = 0;
  let fence: {
    char: string;
    len: number;
    depth: number;
    column: number;
  } | null = null;
  // The open code span's backtick-run length; 0 when none. A run of N backticks
  // closes at the next run of exactly N (CommonMark), and a span may cross lines.
  let span = 0;
  // Whether an open raw HTML block covers this line, and whether that block is a
  // type-1 raw-text one (ends at its closing tag, never at a blank line).
  let htmlBlock = false;
  let rawText = false;
  // A link reference definition is only parsed where a PARAGRAPH could start —
  // otherwise the line is a lazy continuation and renders as ordinary prose. Only a
  // preceding open paragraph line takes this false. `definitionTail` carries the
  // one continuation CommonMark allows without re-stating the label: a destination
  // on the line after a `]:` that ended its own line.
  let atParagraphStart = true;
  let definitionTail = false;
  // The previous line's blockquote depth, so the HTML arm can tell an opening
  // container from one that was already there.
  let prevDepth = 0;
  // Content column of the most recent list marker, or -1 when none is in play; a
  // blank line clears it. Read ONLY by the type-7 gate — see `leftListIndent`.
  let listColumn = -1;
  // Lengths of the unpaired literal runs seen so far in THIS paragraph; inline
  // syntax is paragraph-scoped, so a blank line clears them. Only a blank line does,
  // though a heading or container start also ends the paragraph for span purposes —
  // so a tick above one still lengthens a wrap below it, which over-shoots in the
  // direction this set is meant to over-shoot in.
  let strays = new Set<number>();
  let lineStart = 0;
  while (true) {
    if (lineStart > text.length) {
      if (phase === 1) break;
      // Rewind for the scanning pass with every piece of block state reset — the
      // stray set included, so phase 0's tick bookkeeping cannot leak into the wrap
      // lengths phase 1 computes — and with the label set now built.
      phase = 1;
      fence = null;
      span = 0;
      htmlBlock = false;
      rawText = false;
      atParagraphStart = true;
      definitionTail = false;
      prevDepth = 0;
      strays = new Set();
      lineStart = 0;
      continue;
    }
    let lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    const line = classifyLine(text, lineStart, lineEnd);
    // A blockquote's content column is where its leaf blocks live; the list-marker
    // strip is for the opener test only, since a lone `-` would otherwise strip to
    // nothing and read as the blank line that ends an open block.
    const quoted = line.replace(QUOTE_PREFIX, "");
    const inner = quoted.replace(LIST_MARKER, "");
    const depth = quoteDepth(line);
    // A container that starts on this line begins a fresh block context, so a type-7
    // tag may open inside it even while the outer paragraph is still going. Only the
    // HTML arm reads this, and it fails OPEN on purpose: over-holding costs an honest
    // disclosure, whereas wrapping inside raw HTML is a false claim of
    // neutralization — the opposite polarity from the indent arm, which fails closed.
    const containerOpens = opensContainer(line, prevDepth);
    // A type-7 tag sitting at a column the list marker's content had left is either
    // outside the item (a block start, its refs raw HTML) or a lazy continuation of
    // the item's paragraph (its refs prose). Both readings leave the reference LIVE,
    // so holding it is truthful either way — which is what makes this one-boolean
    // stand-in for an indentation model safe. Over-tripping only ever over-holds.
    const leftListIndent =
      listColumn >= 0 &&
      quoted.length - quoted.replace(/^[ \t]*/, "").length < listColumn;
    // Updated here rather than at the loop's foot, so the block arms' `continue`
    // paths cannot leave it stale.
    prevDepth = depth;
    const marker = LIST_MARKER.exec(quoted);
    if (BLANK.test(quoted)) listColumn = -1;
    else if (marker) listColumn = marker[0].length;
    // Closing a type-1 block is deferred past this line's scan: the line carrying
    // the closing tag is the block's LAST line, content included.
    let closeAfterLine = false;
    // Consumed here whatever this line turns out to be, so a definition whose next
    // line is a fence or a block opener cannot leak the skip past that block.
    const tailPending = definitionTail;
    definitionTail = false;
    if (BLANK.test(line)) strays = new Set();
    // A block start beats inline parsing, so an open span cannot reach across one
    // that may interrupt a paragraph — and while a span is open, block structure
    // is otherwise unreadable, since the span swallows fence lines and all.
    if (span > 0 && interruptsParagraph(inner)) span = 0;
    if (span === 0) {
      if (htmlBlock) {
        if (rawText) {
          if (RAW_TEXT_CLOSE.test(line)) closeAfterLine = true;
        } else if (BLANK.test(quoted)) {
          // A blank line is the only thing that ends a type-6/7 block: a fence or
          // an indent inside one is raw content, so the checks below must not run.
          htmlBlock = false;
        }
      } else {
        // Fences are read at their CONTAINER's content column. A blockquote marker
        // repeats on every line, so `quoted` carries opener and closer alike; a list
        // marker appears only on the item's first line, so a fence behind one records
        // the item's column and its later lines are matched against that instead.
        const fenced = FENCE.exec(quoted);
        const indent = quoted.length - quoted.replace(/^[ \t]*/, "").length;
        // Inside a list fence the closer sits at the item's column, plus CommonMark's
        // usual three-space slack; `quoted` still carries that indentation.
        const listClose =
          fence && fence.column > 0 && indent >= fence.column
            ? FENCE.exec(quoted.slice(fence.column))
            : null;
        const closer = fence && fence.column > 0 ? listClose : fenced;
        if (fence) {
          if (
            closer &&
            closer[1][0] === fence.char &&
            closer[1].length >= fence.len &&
            depth === fence.depth &&
            BLANK.test(quoted.slice(fence.column + closer[0].length))
          ) {
            fence = null;
            atParagraphStart = true;
            lineStart = lineEnd + 1;
            continue;
          }
          // A list fence dies with its ITEM. A non-blank line short of the column has
          // left it; a blank line ends it too unless the next non-blank line is still
          // indented into the item, which CommonMark keeps as code content.
          //
          // A fence-shaped line that is NOT this fence's closer is treated as content
          // instead, deferring the death to the next ordinary line. That is the arm
          // that keeps later references scannable: ending the item here would let the
          // very same line re-open a fence at column 0 and swallow everything after
          // it. Every judgment call in here is settled that way — an item ended too
          // soon only exposes more text to the scan, while one left open hides it.
          if (fence.column > 0 && !fenced) {
            let ends = false;
            if (BLANK.test(quoted)) {
              let at = lineEnd + 1;
              while (at <= text.length) {
                let to = text.indexOf("\n", at);
                if (to === -1) to = text.length;
                const ahead = classifyLine(text, at, to).replace(
                  QUOTE_PREFIX,
                  "",
                );
                if (!BLANK.test(ahead)) {
                  ends =
                    ahead.length - ahead.replace(/^[ \t]*/, "").length <
                    fence.column;
                  break;
                }
                at = to + 1;
              }
              if (at > text.length) ends = true;
            } else if (indent < fence.column) {
              ends = true;
            }
            if (ends) {
              // Outside the item now, so this line falls through to be classified.
              fence = null;
            } else {
              atParagraphStart = true;
              lineStart = lineEnd + 1;
              continue;
            }
          }
        }
        if (fence) {
          // A fence dies with its CONTAINER, and DEPTH is the whole test: a line
          // that drops below the fence's depth has left the blockquote, and a truly
          // blank line is depth 0, so it is already covered. Testing the
          // quote-stripped line for blankness instead would kill the fence on a
          // `>`-only line — which CommonMark keeps INSIDE the quoted block as a
          // blank code line — and the real closer would then open a phantom fence
          // over the rest of the quote. Without any of this an unterminated `> ~~~`
          // swallows the rest of the comment and posts its references live and
          // undisclosed. A depth-0 fence has no container to lose, so it keeps
          // running to the end — the pinned behaviour for an unterminated fence.
          if (fence.depth >= 1 && depth < fence.depth) {
            // This line is OUTSIDE the fence, so it falls through to be scanned.
            fence = null;
          } else {
            atParagraphStart = true;
            lineStart = lineEnd + 1;
            continue;
          }
        }
        // A fence behind a list marker opens at the item's content column; one
        // anywhere else opens at column 0 and keeps the blockquote-depth rules.
        const markerFence = marker ? FENCE.exec(inner) : null;
        if (fenced || markerFence) {
          const open = fenced ?? markerFence;
          if (open) {
            fence = {
              char: open[1][0],
              len: open[1].length,
              depth,
              column: fenced ? 0 : (marker?.[0].length ?? 0),
            };
          }
          atParagraphStart = true;
          lineStart = lineEnd + 1;
          continue;
        }
        // Indented code CANNOT interrupt a paragraph, so an indented line is code
        // only where a paragraph could start; anywhere else it is a continuation
        // whose refs are live prose. A real block's later lines stay skipped without
        // any extra state, because every skipped line leaves this flag true — and a
        // blank line inside the block leaves it true as well. The column is measured
        // at the blockquote content, like the fence and definition arms; list markers
        // stay unstripped for the same reason they do there — a marker appears only
        // on the item's first line, so stripping it would measure the item's own
        // indentation against nothing.
        if (atParagraphStart && INDENTED.test(quoted)) {
          lineStart = lineEnd + 1;
          continue;
        }
        // A link reference definition renders NOTHING: its label is consumed and its
        // destination becomes an href, which no forge's reference filter rewrites. A
        // wrap here would be spliced into the URL itself, so the whole line is
        // skipped — including a destination that spilled onto the next line.
        if (tailPending) {
          atParagraphStart = true;
          recordTicks(text, lineStart, lineEnd, strays);
          lineStart = lineEnd + 1;
          continue;
        }
        const definition = atParagraphStart
          ? LINK_DEFINITION.exec(inner)
          : null;
        // A label alone proves nothing: the tail has to parse as a destination, or
        // the line is a paragraph whose refs are live and must stay scannable.
        let deferred = false;
        let defines = false;
        if (definition && /\S/.test(definition[1])) {
          const tail = inner.slice(definition[0].length);
          defines = DEFINITION_TAIL.test(tail);
          if (!defines && BLANK.test(tail)) {
            // The destination may sit on the next line — but only if THAT line is
            // one, so it is validated here rather than trusted on arrival.
            let nextEnd = text.indexOf("\n", lineEnd + 1);
            if (nextEnd === -1) nextEnd = text.length;
            const next = classifyLine(text, lineEnd + 1, nextEnd);
            defines =
              lineEnd < text.length && opensDeferredDestination(next, depth);
            deferred = defines;
          }
        }
        if (defines && definition) {
          // Collected in phase 0 only, so the set is frozen while phase 1 resolves
          // against it and a use site cannot depend on where it sits in the text.
          if (phase === 0) labels.add(normalizeLabel(definition[1]));
          definitionTail = deferred;
          atParagraphStart = true;
          recordTicks(text, lineStart, lineEnd, strays);
          lineStart = lineEnd + 1;
          continue;
        }
        // The opener line is itself inside the block, so a ref after the tag on
        // that same line is covered.
        if (RAW_TEXT_OPEN.test(inner)) {
          htmlBlock = true;
          rawText = true;
          if (RAW_TEXT_CLOSE.test(line)) closeAfterLine = true;
        } else if (
          opensHtmlBlock(
            inner,
            atParagraphStart || containerOpens || leftListIndent,
          )
        ) {
          htmlBlock = true;
        }
      }
    }
    let i = lineStart;
    // BOTH phases run the character scan. Phase 0 needs it for its side effects, not
    // its output: code-span state is derived here, and without it a definition line
    // sitting inside a multi-line span would register a phantom label that phase 1
    // then resolves a live reference against. Only the recording is phase-gated.
    while (i < lineEnd) {
      const ch = text[i];
      // A raw HTML block parses no inline syntax, so its backticks and brackets
      // are ordinary characters and only the trigger scan runs inside one.
      if (ch === "`" && !htmlBlock) {
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
      // An inline tag is markup, not text: nothing in it autolinks, and a wrap there
      // breaks the tag. Its TEXT CONTENT is a different matter and keeps being
      // scanned — a reference between the tags is live prose.
      if (ch === "<" && !htmlBlock && !isEscaped(text, i)) {
        const skip = inlineTagEnd(text, i, lineEnd);
        if (skip > i) {
          i = skip;
          continue;
        }
      }
      if (ch === "[" && !htmlBlock && !isEscaped(text, i)) {
        // Inline syntax first, then the reference forms. A label that resolves to no
        // definition is prose, and its refs stay detected — the alternative, skipping
        // every bracket span, would ship a live `#N` from `see [maybe #5] there`.
        let skip = linkEnd(text, i, lineEnd);
        if (skip === i) skip = referenceEnd(text, i, lineEnd, labels);
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
      if (triggers.includes(ch)) {
        const escaped = isEscaped(text, i);
        // The occurrence starts at the BACKSLASH RUN, not at the trigger. A wrap
        // opened after the backslash would have its own opening tick escaped, and
        // the reference would sit bare and live outside a span that never formed;
        // enclosing the run puts the tick where nothing escapes it. The boundary
        // rule then reads the character before the run, since that is what ends up
        // adjacent to the reference once the renderer consumes the backslash.
        let start = i;
        if (escaped) while (start > 0 && text[start - 1] === "\\") start--;
        // A raw HTML block processes no escapes at all, so the backslash there is
        // literal text and BOTH forges still linkify the reference beside it. That
        // makes it a candidate whatever `escapedRefsLive` says — the GitLab excuse
        // for leaving an escape alone only holds outside raw HTML. It still cannot
        // be wrapped, so it routes to `survived` like any other block reference.
        if (
          (escapedRefsLive || !escaped || htmlBlock) &&
          !(start > 0 && BLOCKED_BEFORE.test(text[start - 1]))
        ) {
          const num = REF_NUMBER.exec(
            text.slice(i + 1, i + 1 + REF_NUMBER_SPAN),
          );
          if (num) {
            const end = i + 1 + num[0].length;
            if (phase === 1) {
              out.push({
                start,
                end,
                token: text.slice(start, end),
                wrapRun: wrapRunLength(strays),
                htmlBlock,
              });
            }
            // Advanced in both phases, so the two walks stay in step.
            i = end;
            continue;
          }
        }
      }
      i++;
    }
    // Only an open paragraph line can make the NEXT line a continuation; every
    // other path above restores the flag before its own `continue`. A raw HTML
    // block's lines leave no paragraph either, the one that closes it included —
    // so this reads `htmlBlock` BEFORE the close below clears it.
    atParagraphStart = htmlBlock || !leavesOpenParagraph(quoted);
    if (closeAfterLine) {
      htmlBlock = false;
      rawText = false;
    }
    lineStart = lineEnd + 1;
  }
  return out;
}

/**
 * Distinct suspect reference tokens ("#12", "!4") in first-appearance order. An
 * escaped token keeps its backslashes ("\\#12"), because that is the text a caller
 * would have to show or rewrite.
 *
 * `escapedRefsLive` says whether `\#12` still autolinks on the target forge, and the
 * forges disagree: GitHub runs its reference filter AFTER rendering, on text the
 * escape has already been consumed from, so the anchor is minted anyway; GitLab
 * wraps the escaped character and leaves it alone. Defaulting to TRUE is the safe
 * direction — a caller that knows it is posting to GitLab passes false and gets the
 * old behaviour, while a caller that knows nothing over-wraps rather than shipping a
 * live reference it promised to neutralize.
 *
 * GitLab's exemption stops at raw HTML: no escape is processed inside an HTML block
 * on either forge, so the backslash is literal text and the reference beside it
 * links regardless. Those occurrences are candidates in BOTH modes.
 */
export function findSuspectRefs(
  text: string,
  triggers: readonly string[] = ["#", "!"],
  escapedRefsLive = true,
): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const hit of scanRefs(text, triggers, escapedRefsLive)) {
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
 *
 * Occurrences inside a raw HTML block are the one case never even attempted: a
 * wrap there emits literal backticks around a reference that autolinks anyway, so
 * the region comes through byte-identical and its tokens go straight to
 * `survived`. A token appearing both inside and outside such a block is wrapped
 * where it can be, and the post-condition still lands it in `survived` because
 * the copy in the block survives the rescan.
 */
export function neutralizeSuspectRefs(
  text: string,
  triggers: readonly string[] = ["#", "!"],
  escapedRefsLive = true,
): { text: string; wrapped: string[]; survived: string[] } {
  const forms = new Map<string, string>();
  // Tokens every occurrence of which sat in a raw HTML block on the first pass —
  // detected, deliberately not rewritten, and owed a disclosure. Pass 0 alone is
  // enough because a wrap never changes a line's leading column: the one character
  // this rewrite adds is a separator before a backtick-adjacent wrap, and a wrap is
  // always preceded by its own trigger, so no later pass can move a line into or
  // out of a region.
  const held = new Set<string>();
  let out = text;
  for (let pass = 0; pass < NEUTRALIZE_PASSES; pass++) {
    const hits = scanRefs(out, triggers, escapedRefsLive);
    if (hits.length === 0) break;
    const parts: string[] = [];
    let cursor = 0;
    for (const hit of hits) {
      if (hit.htmlBlock) {
        // Leaving `cursor` where it is keeps the region byte-identical.
        if (pass === 0) held.add(hit.token);
        continue;
      }
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
    const next = parts.join("");
    // A pass that wrapped nothing (every hit was held) cannot change the text, and
    // re-running it would only re-derive the same hits.
    if (next === out) break;
    out = next;
  }
  if (out === text && held.size === 0) {
    return { text, wrapped: [], survived: [] };
  }
  const survivors = new Set(findSuspectRefs(out, triggers, escapedRefsLive));
  const wrapped: string[] = [];
  const survived: string[] = [];
  for (const [token, form] of forms) {
    if (survivors.has(token)) survived.push(`\`${token}\``);
    else wrapped.push(form);
  }
  for (const token of held) {
    if (!forms.has(token)) survived.push(`\`${token}\``);
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
  // wrapped `!N` on GitHub is a literal that never linked anyway. The escape default
  // rides the same reasoning: `\#N` autolinks on GitHub and does not on GitLab, so
  // treating it as live costs a visible `\#N` in a code span on GitLab and saves a
  // live cross-reference on GitHub. Cosmetic against undisclosed — no contest.
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
