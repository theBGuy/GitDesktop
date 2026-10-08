import type { DiffAST, SyntaxLine, SyntaxNode } from "@git-diff-view/core";

/**
 * Segment-aware tokenization for hunk-reconstructed ("holey") diff buffers,
 * whose elided regions arrive as blank placeholder lines. Tokenizing each run
 * of non-blank lines on its own keeps tokenizer state from crossing a gap, so a
 * construct a hunk boundary left unclosed can't paint the rest of the buffer.
 * Trade-off: a construct spanning a GENUINE blank line inside a holey buffer
 * now resets there — a bounded local mis-color in place of unbounded bleed, on
 * a path (hunk-mode highlighting) that is already best-effort.
 *
 * Type-only imports here keep this module free of engine code: it is reachable
 * from the highlight worker (highlight-worker -> shiki-highlighter -> here).
 */

/**
 * Per-object `maxLineToIgnoreSyntax` for the hunk-scoped highlighters: the core
 * checks it before `getAST`, so lifting it only lets a deep hunk reach the
 * tokenizer, and gap isolation plus {@link hunkScopedProcessAST} keep the work
 * proportional to hunk content (not a cap raise).
 */
export const HUNK_SCOPED_MAX_LINES = Number.POSITIVE_INFINITY;

/** Buffers below this many lines are never treated as holey. */
const HOLEY_MIN_LINES = 50;
/** Blank-line ratio at which a buffer is treated as hunk-reconstructed.
 *  Measured holey buffers run ~99% blank; no file in this repo reaches 50%
 *  (highest among the 519 code files of >=50 lines: 15%). */
const HOLEY_MIN_BLANK_RATIO = 0.5;

/**
 * Whether pre-split `lines` look hunk-reconstructed. Blank means exactly `""` —
 * placeholder lines carry no whitespace, so whitespace-only lines stay real
 * content (and a CRLF file's content lines end `"\r"`, keeping them non-blank).
 * Exported for hljs-gap-isolation, its only other consumer.
 */
export function isHoley(lines: readonly string[]): boolean {
  if (lines.length < HOLEY_MIN_LINES) return false;
  let blank = 0;
  for (const line of lines) if (line === "") blank++;
  return blank / lines.length >= HOLEY_MIN_BLANK_RATIO;
}

/** Flattened text length of an AST, without materializing the string. */
function astTextLength(node: DiffAST | DiffAST["children"][number]): number {
  if (node.type === "text") return node.value.length;
  return "children" in node
    ? node.children.reduce((sum, child) => sum + astTextLength(child), 0)
    : 0;
}

/**
 * Tokenize each run of non-blank lines separately and merge the ASTs; `lines`
 * must be `raw.split("\n")`. Null means the merge lost text and the caller
 * should use its own whole-buffer result. The merged root inherits the first
 * segment's `data`: every segment is tokenized as the same language, and a
 * per-segment relevance score means nothing once the buffer is split.
 * Exported for hljs-gap-isolation, its only other consumer.
 */
export function mergeSegments(
  raw: string,
  lines: readonly string[],
  tokenize: (segment: string) => DiffAST,
): DiffAST | null {
  // N split elements are joined by exactly N-1 "\n" separators: one separator
  // PRECEDES every element but the first. A run of non-blank elements keeps its
  // internal separators inside the segment text handed to `tokenize`.
  const children: DiffAST["children"] = [];
  let data: DiffAST["data"];
  let i = 0;
  let sepsPending = 0;
  const emitSeps = () => {
    if (sepsPending > 0) {
      children.push({ type: "text", value: "\n".repeat(sepsPending) });
      sepsPending = 0;
    }
  };
  while (i < lines.length) {
    if (lines[i] === "") {
      if (i > 0) sepsPending++;
      i++;
      continue;
    }
    if (i > 0) sepsPending++;
    emitSeps();
    const start = i;
    while (i < lines.length && lines[i] !== "") i++;
    const segmentAst = tokenize(lines.slice(start, i).join("\n"));
    data ??= segmentAst.data;
    // Appended one at a time: a long contiguous run can exceed the engine's
    // argument limit when spread into push().
    for (const child of segmentAst.children ?? []) children.push(child);
  }
  emitSeps();
  const merged: DiffAST = { type: "root", children };
  if (data) merged.data = data;
  // An engine whose AST doesn't flatten back to its input (e.g. an empty-tree
  // fallback for one segment) would drop text, so the caller falls back to its
  // whole-buffer result.
  return astTextLength(merged) === raw.length ? merged : null;
}

/**
 * Tokenize `raw` segment by segment when it looks hunk-reconstructed; a
 * sub-threshold buffer takes the unchanged single `tokenize(raw)` path.
 */
export function gapIsolatedAst(
  raw: string,
  tokenize: (segment: string) => DiffAST,
): DiffAST {
  const lines = raw.split("\n");
  if (!isHoley(lines)) return tokenize(raw);
  return mergeSegments(raw, lines, tokenize) ?? tokenize(raw);
}

type SyntaxFile = Record<number, SyntaxLine>;

/** Appends `node` to `lineNumber`'s entry, creating it on first use. */
function appendToLine(
  syntax: SyntaxFile,
  lineNumber: number,
  node: SyntaxNode,
  wrapper: SyntaxNode | undefined,
): void {
  const valueLength = node.value.length;
  const line = syntax[lineNumber];
  if (!line) {
    node.startIndex = 0;
    node.endIndex = valueLength - 1;
    syntax[lineNumber] = {
      value: node.value,
      lineNumber,
      valueLength,
      nodeList: [{ node, wrapper }],
    };
    return;
  }
  node.startIndex = line.valueLength;
  node.endIndex = node.startIndex + valueLength - 1;
  line.value += node.value;
  line.valueLength += valueLength;
  line.nodeList.push({ node, wrapper });
}

/**
 * @git-diff-view's `processAST`, except a multi-line text node's EMPTY interior
 * lines get no entry: those are the placeholder runs between hunk segments, so
 * entry count tracks hunk content rather than buffer length. Every other line,
 * and the returned line count, match the vendor's (a missing entry renders that
 * line plain, which for an empty line is indistinguishable).
 */
export function hunkScopedProcessAST(ast: DiffAST): {
  syntaxFileObject: SyntaxFile;
  syntaxFileLineNumber: number;
} {
  const syntax: SyntaxFile = {};
  let lineNumber = 1;
  const walk = (
    nodes: readonly SyntaxNode[],
    wrapper: SyntaxNode | undefined,
  ) => {
    for (const node of nodes) {
      if (node.type !== "text") {
        if (node.children) {
          walk(node.children, node);
          node.lineNumber = lineNumber;
        }
        continue;
      }
      const value = node.value;
      let start = value.indexOf("\n");
      if (start === -1) {
        appendToLine(syntax, lineNumber, node, wrapper);
        node.lineNumber = lineNumber;
        continue;
      }
      // Scans by index rather than split(): a placeholder run is one long
      // "\n"-only string, and its empty interior parts must cost no allocation.
      const parts = node.children ?? [];
      node.children = parts;
      const emit = (part: string) => {
        const child: SyntaxNode = {
          type: "text",
          value: part,
          startIndex: Number.POSITIVE_INFINITY,
          endIndex: Number.POSITIVE_INFINITY,
          lineNumber,
        };
        appendToLine(syntax, lineNumber, child, wrapper);
        parts.push(child);
      };
      emit(value.slice(0, start + 1));
      for (;;) {
        lineNumber++;
        const end = value.indexOf("\n", start + 1);
        if (end === -1) {
          emit(value.slice(start + 1));
          break;
        }
        if (end > start + 1) emit(value.slice(start + 1, end + 1));
        start = end;
      }
      node.lineNumber = lineNumber;
    }
  };
  walk(ast.children as unknown as SyntaxNode[], undefined);
  return { syntaxFileObject: syntax, syntaxFileLineNumber: lineNumber };
}
