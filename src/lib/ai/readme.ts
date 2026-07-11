// A deterministic, progressive README distiller. The AI "Generate" for a repo's
// About description feeds the README into the prompt; a blind slice discards the
// tail (features/highlights breadth) of long READMEs. This condenses a README to
// fit a char budget while preserving the high-signal content — what the project
// does and the breadth of what it can do — over install/dev boilerplate. Pure,
// self-contained, no AI pre-pass: same input always yields the same output. The
// output is always ≤ budget; a README that already fits passes through normalized
// (CRLF→LF + trim) but otherwise untouched.

// Heading text (lowercased) that marks a HIGH-signal section — its body is worth
// keeping in full for as long as the budget allows.
const HIGH_HEADINGS = [
  "feature",
  "highlight",
  "overview",
  "about",
  "introduction",
  "what ",
  "why ",
  "motivation",
  "capabilit",
  "how it works",
  "usage",
];

// Heading text (lowercased) whose body is boilerplate — keep the heading line as
// a breadcrumb of the section's existence, but drop everything under it.
const LOW_HEADINGS = [
  "install",
  "getting started",
  "quick start",
  "setup",
  "requirement",
  "prerequisite",
  "development",
  "developing",
  "build",
  "contribut",
  "license",
  "acknowledg",
  "credit",
  "sponsor",
  "donat",
  "support",
  "changelog",
  "release",
  "roadmap",
  "faq",
  "troubleshoot",
  "screenshot",
  "table of contents",
  "update",
  "privacy",
  "security",
  "architecture",
  "testing",
];

/** Deterministically condense a README to fit `budget` chars, favoring
 *  what-it-does / features content over install/dev boilerplate. */
export function distillReadme(markdown: string, budget: number): string {
  // Phase 0 — normalize and short-circuit. A README that already fits passes
  // through in its normalized form (CRLF→LF + trim). Returning the raw markdown
  // here would let content that's short but padded with trailing newlines ship
  // over budget while skipping every phase (including the newline collapse).
  const normalized = markdown.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= budget) {
    return normalized;
  }

  // Phase 1 — strip markup noise (order matters: comments/fences before the
  // tag/link rewrites, so we don't chew half-processed markup).
  let text = stripNoise(normalized);
  if (text.length <= budget) {
    return text;
  }

  // Phase 2 — classify sections and drop LOW bodies / trim MID bodies.
  text = selectSections(text);
  if (text.length <= budget) {
    return text;
  }

  // Phase 3 — compress within surviving sections (first line of each list item,
  // first sentence of long paragraphs).
  text = compressBlocks(text);
  if (text.length <= budget) {
    return text;
  }

  // Phase 4 — hard cut on the cleanest boundary before the budget.
  return hardCut(text, budget);
}

/** Phase 1: remove markup that carries no description signal. */
function stripNoise(text: string): string {
  return (
    text
      // HTML comments (multiline, non-greedy).
      .replace(/<!--[\s\S]*?-->/g, "")
      // Fenced code blocks (``` or ~~~, optional language) — drop entirely.
      .replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm, "")
      // Linked badges [![alt](img)](href) — drop before plain images/links.
      .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "")
      // Bare images ![alt](src) — drop (alt text too).
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      // Links [text](url) — keep the visible text.
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Autolinks <https://…> — drop.
      .replace(/<https?:\/\/[^>\s]*>/g, "")
      // Remaining HTML tags — strip the tag, keep inner text.
      .replace(/<\/?[a-zA-Z][^>]*>/g, "")
      // Per-line trailing whitespace.
      .replace(/[ \t]+$/gm, "")
      // Collapse 3+ consecutive newlines to a paragraph break.
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/** Phase 2: split at ATX headings, keep the intro in full, and reduce each
 *  section by its classification (LOW → heading only, MID → heading + first
 *  paragraph, HIGH → whole body for now). Document order is preserved. */
function selectSections(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let heading: string | null = null;
  let body: string[] = [];

  const flush = () => {
    if (heading === null) {
      // Intro (content before the first heading) — always kept in full.
      if (body.length > 0) {
        out.push(body.join("\n"));
      }
      return;
    }
    const title = heading.replace(/^#{1,6}\s+/, "").toLowerCase();
    if (matches(title, LOW_HEADINGS)) {
      out.push(heading);
    } else if (matches(title, HIGH_HEADINGS)) {
      out.push([heading, ...body].join("\n"));
    } else {
      out.push([heading, firstParagraph(body)].join("\n"));
    }
  };

  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line)) {
      flush();
      heading = line;
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();

  return out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The section body up to (but excluding) its first blank line. */
function firstParagraph(body: string[]): string {
  const para: string[] = [];
  // Skip leading blank lines, then collect until the next blank line.
  let started = false;
  for (const line of body) {
    if (line.trim() === "") {
      if (started) {
        break;
      }
      continue;
    }
    started = true;
    para.push(line);
  }
  return para.join("\n");
}

/** Phase 3: within each surviving block, keep only the first line of top-level
 *  list items (dropping wrapped continuations and nested items) and trim long
 *  non-list paragraphs — whole blank-line-delimited blocks, wrapping and all —
 *  to their first sentence. */
function compressBlocks(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  // Wrapped lines of the current non-list, non-heading paragraph awaiting flush.
  let para: string[] = [];
  let inTopItem = false;

  const flushPara = () => {
    if (para.length > 0) {
      out.push(compressParagraph(para.join("\n")));
      para = [];
    }
  };

  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line)) {
      // Headings pass through untouched and end any open paragraph / list item.
      flushPara();
      inTopItem = false;
      out.push(line);
      continue;
    }
    if (isTopLevelListItem(line)) {
      // Start of a top-level item: keep this first line verbatim, drop the rest.
      flushPara();
      inTopItem = true;
      out.push(line);
      continue;
    }
    if (line.trim() === "") {
      // Blank line ends the current paragraph or list item.
      flushPara();
      inTopItem = false;
      out.push(line);
      continue;
    }
    if (inTopItem) {
      // Wrapped continuation or nested/indented sub-item of the open top-level
      // list item — drop it.
      continue;
    }
    // Ordinary (non-list) line — accumulate into the current paragraph.
    para.push(line);
  }
  flushPara();

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** A top-level (indent-0) unordered or ordered list item. */
function isTopLevelListItem(line: string): boolean {
  return /^(?:[-*+]\s+|\d+\.\s+)/.test(line);
}

/** Trim a paragraph (possibly wrapped across lines) longer than ~200 chars to
 *  its first sentence. */
function compressParagraph(block: string): string {
  if (block.length <= 200) {
    return block;
  }
  // First sentence boundary after char 40 (avoids cutting at "e.g." early on).
  // A wrapped sentence ends with ". " OR ".\n", so match a period followed by
  // any whitespace.
  const m = /\. |\.\n/.exec(block.slice(40));
  if (m) {
    return block.slice(0, 40 + m.index + 1);
  }
  // No sentence break — fall back to the first physical line.
  const nl = block.indexOf("\n");
  return nl === -1 ? block : block.slice(0, nl);
}

/** Phase 4: cut at the cleanest boundary that lands before `budget`. */
function hardCut(text: string, budget: number): string {
  if (text.length <= budget) {
    return text;
  }
  const window = text.slice(0, budget);
  const para = window.lastIndexOf("\n\n");
  if (para >= budget * 0.6) {
    return text.slice(0, para).trim();
  }
  const nl = window.lastIndexOf("\n");
  if (nl !== -1) {
    return text.slice(0, nl).trim();
  }
  return window.trim();
}

/** Does the lowercased heading text contain any keyword? */
function matches(title: string, keywords: readonly string[]): boolean {
  return keywords.some((k) => title.includes(k));
}
