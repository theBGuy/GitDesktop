/**
 * The one-line summary a project status strip shows for an update's Markdown
 * note. Import-free on purpose: `scripts/project-status-summary.test.mjs` imports
 * this file straight from `src/` under Node's type stripping, which resolves no
 * bundler aliases, so a runtime import added here fails that test.
 *
 * The rule throughout: the summary drops Markdown SYNTAX and never the reader's
 * characters. Anything that doesn't parse as syntax stays as it was written.
 * No regex here uses lookbehind — this module evaluates when the repository view
 * loads, and a lookbehind literal is a parse error on older WebKit.
 */

// Hoisted: the summary is rebuilt on every render of the strip.
/** A fence OPENER: a backtick fence's info string may not hold a backtick
 *  (CommonMark), which is what keeps "``` inline ``` text" a line of prose. */
const FENCE_OPEN = /^\s*(?:(`{3,})[^`]*|(~{3,}).*)$/;
/** A fence CLOSER carries nothing after its marker run. */
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;
const RULE = /^\s*(?:[-*_]\s*){3,}$/;
/** Every leading container marker — quotes and list items nest ("> - item") —
 *  then at most one heading marker, which holds no blocks of its own. */
const BLOCK_PREFIX =
  /^(?:\s*(?:>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+))*\s*(?:#{1,6}\s+)?/;
const IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
/** URI and email autolinks, which read as their own text. */
const AUTOLINK =
  /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/g;
/** A tag needs a letter after `<` (or `</`), so "p95 < 200ms, p99 > 1s" isn't one. */
const HTML_TAG = /<\/?[A-Za-z][^<>]*>/g;
// Emphasis is stripped only as a PAIR of delimiters around non-space text, which
// keeps a lone `*` ("2 * 3 builds left") as the character it is. Each pattern
// matches the pair alone; whether its surroundings let it open and close is
// decided in the replacer (see `flanked`), since no lookbehind is available.
const STRONG_STAR = /\*\*(\S(?:.*?\S)?)\*\*/g;
const STRONG_EM_UNDERSCORE = /___(\S(?:.*?\S)?)___/g;
const STRONG_UNDERSCORE = /__(\S(?:.*?\S)?)__/g;
const STRIKE = /~~(\S(?:.*?\S)?)~~/g;
const EM_STAR = /\*([^\s*](?:[^*]*?[^\s*])?)\*/g;
const EM_UNDERSCORE = /_([^\s_](?:[^_]*?[^\s_])?)_/g;
const BACKTICK_RUN = /`+/g;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** The longest line the inline passes read. Their lazy scans — `.*?` in the strong
 *  and strikethrough pairs, `[^*]*?` / `[^_]*?` in the emphasis ones — are
 *  quadratic in the line's length when no closer follows (~1s measured at 64K),
 *  and the strip shows one truncated line, far less than this. */
const MAX_LINE = 400;

/** Private-use characters stand in for code spans while the other passes run, so
 *  nothing they do can reach code: one per span, indexed from here. A note that
 *  itself holds one of these would have it read as a marker; written prose doesn't. */
const CODE_MARK = 0xe000;

/** Whether `ch` is a letter or digit — the characters a FLANKED delimiter pair
 *  mustn't touch from outside (see {@link flanked} and where it's applied). */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

/** A replacer that strips a delimiter pair only where neither neighbour outside it
 *  is a letter, a digit, or another copy of the delimiter. */
function flanked(delimiter: string) {
  return (match: string, text: string, offset: number, whole: string) => {
    const before = whole[offset - 1];
    const after = whole[offset + match.length];
    const blocked = (ch: string | undefined) =>
      isWordChar(ch) || ch === delimiter;
    return blocked(before) || blocked(after) ? match : text;
  };
}

/** `line` with every code span swapped for a marker character, and the spans'
 *  contents in marker order. A span opens and closes on backtick runs of the SAME
 *  length (CommonMark); a run with no partner stays literal text. */
function markCodeSpans(line: string): { text: string; codes: string[] } {
  const runs = [...line.matchAll(BACKTICK_RUN)].map((m) => ({
    at: m.index,
    length: m[0].length,
  }));
  const codes: string[] = [];
  let text = "";
  let cursor = 0;
  for (let i = 0; i < runs.length; i += 1) {
    const open = runs[i];
    const close = runs.findIndex((r, j) => j > i && r.length === open.length);
    if (close < 0) continue;
    let code = line.slice(open.at + open.length, runs[close].at);
    // One space padding each side is the span's own syntax, not its content.
    if (code.length > 2 && code.startsWith(" ") && code.endsWith(" "))
      code = code.slice(1, -1);
    text +=
      line.slice(cursor, open.at) +
      String.fromCharCode(CODE_MARK + codes.length);
    codes.push(code);
    cursor = runs[close].at + runs[close].length;
    i = close;
  }
  return { text: text + line.slice(cursor), codes };
}

/** `text` with each marker put back as its code span's content, verbatim. */
function restoreCodeSpans(text: string, codes: string[]): string {
  if (codes.length === 0) return text;
  let out = "";
  for (const ch of text) {
    const index = ch.charCodeAt(0) - CODE_MARK;
    out += index >= 0 && index < codes.length ? codes[index] : ch;
  }
  return out;
}

/** One prose line's inline Markdown as plain text. Code spans are set aside
 *  FIRST, so no other pass can read inside one or pair a delimiter across it. */
function plainInline(line: string): string {
  const { text, codes } = markCodeSpans(line);
  const plain = text
    .replace(IMAGE, (_m, alt: string) => alt)
    .replace(LINK, (_m, label: string) => label)
    .replace(AUTOLINK, (_m, target: string) => target)
    .replace(HTML_TAG, "")
    .replace(STRONG_STAR, (_m, inner: string) => inner)
    // Underscores can't open or close inside a word (CommonMark), so
    // `snake__case__name` stays. The triple pair goes first: the double alone
    // would take `___x__` and leave a stray `_` the flank then refuses.
    .replace(STRONG_EM_UNDERSCORE, flanked("_"))
    .replace(STRONG_UNDERSCORE, flanked("_"))
    .replace(STRIKE, (_m, inner: string) => inner)
    // `*` and `**` CAN pair inside a word in CommonMark (`foo*bar*` is emphasis).
    // Flanking the single `*` is this summary's own choice, so arithmetic like
    // `2*3*4` stays literal in the strip; the history's full render reads it as
    // Markdown.
    .replace(EM_STAR, flanked("*"))
    .replace(EM_UNDERSCORE, flanked("_"));
  return restoreCodeSpans(plain, codes).trim();
}

/** The body's first line of PROSE with content, as plain text. Fenced code is
 *  passed over — a snippet of it reads as the update's point when it rarely is —
 *  unless the body holds nothing else, when its first code line is all there is. */
export function plainFirstLine(body: string | null): string {
  if (body === null) return "";
  // The open fence's marker run: a close needs the same character, at least as
  // many of it, which is the CommonMark rule.
  let fence: string | null = null;
  let firstCode = "";
  for (const full of body.split(/\r?\n/)) {
    const raw = full.slice(0, MAX_LINE);
    if (fence !== null) {
      const close = FENCE_CLOSE.exec(raw)?.[1];
      if (close?.[0] === fence[0] && close.length >= fence.length) fence = null;
      else if (firstCode === "" && raw.trim() !== "") firstCode = raw.trim();
      continue;
    }
    const open = FENCE_OPEN.exec(raw);
    if (open !== null) {
      fence = open[1] ?? open[2];
      continue;
    }
    if (raw.trim() === "" || RULE.test(raw)) continue;
    const line = plainInline(raw.replace(BLOCK_PREFIX, ""));
    if (line !== "") return line;
  }
  return firstCode;
}
