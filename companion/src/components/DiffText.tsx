// A shared unified-diff renderer for the Changes/History file-diff views.
// F0 froze the props type; this package (F23) fills the body: line coloring,
// binary/truncated states, and the multi-file `splitCommitDiff` helper.
//
// Design (user-confirmed): SEMANTIC diff, no syntax highlighting in v1. Lines are
// classified by their unified-diff prefix and colored with the design tokens
// (success = added, destructive = removed). Meaning never rests on color alone —
// every +/− line keeps its leading glyph, so the diff reads correctly in
// monochrome too. Wide lines scroll inside the code block; the page never scrolls
// sideways. No line numbers: raw unified text carries none, and the `@@` hunk
// headers already carry position.

import { WarningCircleIcon } from "@phosphor-icons/react";
import { useMemo } from "react";

/** One classified diff line. `kind` drives the per-line styling; `text` is the raw
 *  line (glyph included). */
type LineKind = "meta" | "hunk" | "add" | "del" | "context";
interface DiffLine {
  kind: LineKind;
  text: string;
}

// Multi-char META prefixes — the file/index/rename headers of a unified diff. These
// MUST be checked before the 1-char +/- classes: `+++`/`---` (the file markers)
// start with the same char as an added/removed line, so a naive `startsWith("+")`
// would miscolor the `+++ b/…` header as an added line.
const META_PREFIXES = [
  "+++",
  "---",
  "diff --git",
  "index ",
  "new file",
  "deleted file",
  "rename ",
  "similarity",
];

/** Classify one diff line by its leading token. Order matters: multi-char meta
 *  prefixes first (`+++`/`---` collide with the +/- classes), then hunk headers,
 *  then the single-char add/remove markers, else context. */
function classify(line: string): LineKind {
  for (const p of META_PREFIXES) {
    if (line.startsWith(p)) return "meta";
  }
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

// Per-kind line styling. The +/- backgrounds are a low-alpha token tint (subtle
// enough that the token text color stays AA against it in BOTH themes); the text
// color is the semantic token itself, the same success/destructive the chips use.
// A hunk header gets a full-width muted band so a reader can scan hunk boundaries.
const LINE_CLASS: Record<LineKind, string> = {
  meta: "text-muted-foreground",
  hunk: "bg-muted text-muted-foreground",
  add: "bg-success/10 text-success",
  del: "bg-destructive/10 text-destructive",
  context: "text-foreground",
};

/** Render a unified diff. `text` is the diff body; `truncated` marks a diff cut off
 *  at the server's size cap; `isBinary` marks a binary file (no textual diff). */
export function DiffText({
  text,
  truncated,
  isBinary = false,
}: {
  text: string;
  truncated: boolean;
  isBinary?: boolean;
}) {
  // Classify once per `text` (up to the server's 1MB cap). No virtualization in v1
  // (recorded follow-up) — the cap bounds the worst case. Skipped entirely for a
  // binary file (no lines to render).
  const lines = useMemo<DiffLine[]>(() => {
    if (isBinary) return [];
    return text.split("\n").map((t) => ({ kind: classify(t), text: t }));
  }, [text, isBinary]);

  if (isBinary) {
    return (
      <p className="px-4 py-8 text-center text-sm text-muted-foreground">
        Binary file — no text diff.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <div
        className="min-w-max font-mono text-xs leading-relaxed"
        aria-label="File diff"
      >
        {lines.map((line, i) => (
          <div
            // Diff lines are a static, index-stable sequence (never reordered or
            // filtered), so the index is a safe key here.
            key={i}
            className={`whitespace-pre px-4 ${LINE_CLASS[line.kind]}`}
          >
            {/* A blank line still needs height so the diff's spacing survives. */}
            {line.text || " "}
          </div>
        ))}
        {truncated ? (
          <p className="flex items-center gap-2 border-t border-border bg-warning/15 px-4 py-2 text-xs whitespace-normal text-foreground">
            <WarningCircleIcon size={14} className="shrink-0 text-warning" />
            Diff truncated — view the full diff on the desktop.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Split a multi-file unified diff (a `StagedDiff.text` / commit diff) into one
 * chunk per file. Splits on the `diff --git ` boundary (each chunk keeps its own
 * `diff --git` header line) and registers each chunk under EVERY path it can extract:
 * the `+++ b/<path>` path (when present), plus BOTH the `a/` and `b/` paths from the
 * `diff --git a/<path> b/<path>` header. Registering one chunk under several keys is
 * intentional — a lookup only needs one to hit.
 *
 * Why several keys: a pure RENAME (100% similarity, no content change) has no `+++`
 * line at all, and the file-stat row navigates with the server's stat path for the
 * NEW name (`git diff --numstat -z` reports the new path for a rename), which is the
 * `b/` path — so the `b/`-from-header key is the one that matches. A deletion's `+++`
 * is `/dev/null` (keyed by the `a/` path). Feeds CommitFileBody: it looks a file's
 * chunk up by the path the file-stat row navigated with.
 */
export function splitCommitDiff(text: string): Map<string, string> {
  const chunks = new Map<string, string>();
  if (!text) return chunks;
  // Split on the start-of-line `diff --git ` boundary, keeping the delimiter with
  // the chunk it introduces (a lookahead split). Leading content before the first
  // boundary (there shouldn't be any in git output) is dropped.
  const parts = text.split(/(?=^diff --git )/m);
  for (const part of parts) {
    if (!part.startsWith("diff --git ")) continue;
    for (const path of chunkPaths(part)) chunks.set(path, part);
  }
  return chunks;
}

/** Strip an optional surrounding double-quote pair (git quotes paths with special or
 *  non-ASCII chars under `core.quotePath`'s default). Full C-style unescaping of the
 *  inner bytes is out of scope — an escaped byte inside stays as-is, matching however
 *  the server's stat path reports it. */
function unquote(path: string): string {
  return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
}

/** All keys a chunk should be registered under: the `+++ b/<path>` path plus the `a/`
 *  and `b/` paths from the `diff --git` header. Each regex tolerates an optional
 *  surrounding double-quote pair (stripped). A `diff --git a/X b/Y` with SPACES in an
 *  unquoted path is ambiguous — we split on the LAST ` b/` occurrence, which is
 *  correct for the overwhelmingly common equal-path case (and rename-with-spaces
 *  pathological cases aren't chased). */
function chunkPaths(chunk: string): string[] {
  const keys: string[] = [];
  const plus = chunk.match(/^\+\+\+ ("?b\/.+"?)$/m);
  if (plus) {
    const inner = unquote(plus[1]);
    if (inner.startsWith("b/")) keys.push(inner.slice(2));
  }
  const header = chunk.match(/^diff --git ("?a\/.+"?) ("?b\/.+"?)$/m);
  if (header) {
    // The header line: `diff --git a/X b/Y`. Prefer a quote-delimited split when the
    // paths are quoted; otherwise fall back to the last ` b/` in the raw line.
    const line = header[0].slice("diff --git ".length);
    const split = splitHeaderPaths(line);
    if (split) {
      const a = unquote(split.a);
      const b = unquote(split.b);
      if (a.startsWith("a/")) keys.push(a.slice(2));
      if (b.startsWith("b/")) keys.push(b.slice(2));
    }
  }
  return keys;
}

/** Split a `diff --git` header's `a/X b/Y` remainder into its two path tokens. When
 *  both are double-quoted, split on the `" "` between them; otherwise split on the
 *  LAST ` b/` (correct for the common equal-path case — see chunkPaths). */
function splitHeaderPaths(line: string): { a: string; b: string } | null {
  if (line.startsWith('"') && line.endsWith('"')) {
    const between = line.indexOf('" "');
    if (between !== -1) {
      return { a: line.slice(0, between + 1), b: line.slice(between + 2) };
    }
  }
  const at = line.lastIndexOf(" b/");
  if (at === -1) return null;
  return { a: line.slice(0, at), b: line.slice(at + 1) };
}
