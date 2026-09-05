import { fileExt } from "./diff-lang";

/** Extensions the diff pane offers a rendered Preview for. */
const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx"]);

export function isMarkdownPath(filePath: string): boolean {
  return MARKDOWN_EXTS.has(fileExt(filePath));
}

export function isMdxPath(filePath: string): boolean {
  return fileExt(filePath) === "mdx";
}

// Past this the preview shows a placeholder instead of parsing: marked, the
// hljs fence pass, and DOMPurify all run synchronously on the main thread, so
// the budget stays in the diff's own highlight-cap band
// (HIGHLIGHT_MAX_CHARS_HLJS = 400_000).
export const PREVIEW_MAX_CHARS = 400_000;

const stripCr = (line: string): string =>
  line.endsWith("\r") ? line.slice(0, -1) : line;

/**
 * Drop a leading YAML (`---`) or TOML (`+++`) frontmatter block. marked
 * renders a YAML block as an `<hr>` plus a giant setext `<h2>` of the raw
 * YAML (the closing `---` underlines it), so every Astro/Jekyll/Hugo post
 * would open its preview with heading-sized YAML. The scan bails at a blank
 * line or a missing closer: a doc that merely opens with a thematic break
 * keeps its content — this fails toward showing text, never toward eating it.
 */
function stripFrontmatter(text: string): string {
  const lines = text.split("\n");
  const open = stripCr(lines[0] ?? "");
  if (open !== "---" && open !== "+++") return text;
  for (let i = 1; i < lines.length; i++) {
    const line = stripCr(lines[i]);
    if (line === open) return lines.slice(i + 1).join("\n");
    if (line.trim() === "") return text;
  }
  return text;
}

// CommonMark fences: up to 3 leading spaces; closing needs the same char, at
// least the opening run's length, and no info string — a fenced example like
// ```js inside an open block must not close it.
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/;
// An indented (≥4-space) line is a markdown code block — never transformed.
const INDENTED_CODE_RE = /^(?: {4}|\t)/;
// In MDX, any block starting with these words IS an ESM block (prose that
// starts a line with them is a compile error there), running to the next
// blank line.
const ESM_START_RE = /^(?:import|export)\s/;
// Capitalized (component) JSX tags and fragments only — lowercase HTML in
// markdown already flows through marked + DOMPurify.
const JSX_TAG_RE = /<\/?[A-Z][\w.]*(?:\s[^<>]*)?\/?>|<\/?>/g;
// Split that keeps inline code spans (odd indexes) untouched.
const INLINE_CODE_RE = /(`[^`]*`)/;

/**
 * Make MDX renderable by the plain markdown pipeline: drop top-level
 * import/export blocks and unwrap single-line component JSX tags (keeping
 * their text children), leaving fenced and indented code untouched. `{expr}`
 * stays literal and a multi-line opening tag survives as text. The result is
 * approximate BY DESIGN — components resolve against the host project's own
 * build, which this app cannot see, and compiling/evaluating MDX to close that
 * gap would be arbitrary code execution from repo content. Never do it.
 */
function cleanMdx(text: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  let inEsm = false;
  let prevBlank = true;
  for (const raw of text.split("\n")) {
    const line = stripCr(raw);
    if (fence !== null) {
      out.push(raw);
      const close = line.match(FENCE_CLOSE_RE)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (inEsm) {
      if (line.trim() === "") {
        inEsm = false;
        prevBlank = true;
        out.push(raw);
      }
      continue;
    }
    const open = line.match(FENCE_RE)?.[1];
    if (open) {
      fence = open;
      prevBlank = false;
      out.push(raw);
      continue;
    }
    if (prevBlank && ESM_START_RE.test(line)) {
      inEsm = true;
      continue;
    }
    prevBlank = line.trim() === "";
    out.push(
      INDENTED_CODE_RE.test(line)
        ? raw
        : raw
            .split(INLINE_CODE_RE)
            .map((seg, i) => (i % 2 === 1 ? seg : seg.replace(JSX_TAG_RE, "")))
            .join(""),
    );
  }
  return out.join("\n");
}

/** The pre-pass handing diff-pane text to the shared `<Markdown>` renderer.
 *  Lives here at the call-site layer deliberately — the shared component's
 *  consumers must keep rendering their input verbatim. */
export function cleanMarkdownForPreview(
  text: string,
  filePath: string,
): string {
  const body = stripFrontmatter(text);
  return isMdxPath(filePath) ? cleanMdx(body) : body;
}
