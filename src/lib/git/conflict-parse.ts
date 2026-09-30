/**
 * Parses a conflicted file's text (the working tree, with git's conflict
 * markers) into renderable segments, and rebuilds the file when the user
 * resolves one conflict region. Pure + line-ending-preserving: split on "\n"
 * and the trailing "\r" rides with each line, so joining back is byte-exact
 * (CRLF survives a round-trip).
 *
 * git's markers, always at line start, exactly 7 chars + space/EOL:
 *   <<<<<<< <label>      current / ours
 *   ||||||| <label>      common ancestor (diff3 only) — parsed and skipped
 *   =======              separator
 *   >>>>>>> <label>      incoming / theirs
 */

export interface ConflictBlock {
  /** Current side (ours / HEAD) content; "" if that side is empty. */
  current: string;
  /** Incoming side (theirs) content. */
  incoming: string;
  /** Whether the current side had any lines (distinguishes a genuinely empty
   *  side from one that is a single blank line — both serialize to ""). */
  hasCurrent: boolean;
  /** Whether the incoming side had any lines. */
  hasIncoming: boolean;
  /** Label after `<<<<<<<` (e.g. "HEAD"); "" if none. */
  currentLabel: string;
  /** Label after `>>>>>>>` (e.g. the merged branch); "" if none. */
  incomingLabel: string;
  /** The exact original block text (incl. markers), so an UNresolved block
   *  reconstructs byte-for-byte when a sibling block is resolved. */
  raw: string;
}

export type Segment =
  | { kind: "context"; text: string }
  | ({ kind: "conflict" } & ConflictBlock);

/** Which side(s) to keep when resolving a conflict block. */
export type ConflictChoice = "current" | "incoming" | "both";

/** Whether `line` is exactly a 7-char `char` marker (8th char is space/tab/CR,
 *  or end of line) — git never indents a marker, so line-start + length match. */
function isMarker(line: string, char: string): boolean {
  if (line.length < 7) return false;
  for (let i = 0; i < 7; i++) if (line[i] !== char) return false;
  const next = line[7];
  return next === undefined || next === " " || next === "\t" || next === "\r";
}

/** Whether a line looks like ANY conflict marker — used to detect an ambiguous
 *  region whose own content contains a marker-shaped line (e.g. a setext
 *  `=======` heading underline), which git's format can't disambiguate. */
function isAnyMarker(line: string): boolean {
  return (
    isMarker(line, "<") ||
    isMarker(line, "=") ||
    isMarker(line, ">") ||
    isMarker(line, "|")
  );
}

/** Whether unresolved conflict markers remain — the staging gate for the two
 *  content-writing accepts (the AI accept and per-region accept). It differs from
 *  `isAnyMarker` on two axes, both deliberate. Narrower on `=`: only the angle and
 *  pipe markers count, since a bare `=======` can be a markdown underline and
 *  staging must not refuse on one. Wider on run length: 7 or more, because a
 *  `conflict-marker-size` attribute lengthens git's markers; the parser stays
 *  exactly-7 and sends such files to its unparsed arm, so only staging needs it. */
export function hasConflictMarkers(text: string): boolean {
  return (
    /^<{7,}( |\t|$)/m.test(text) ||
    /^>{7,}( |\t|$)/m.test(text) ||
    /^\|{7,}( |\t|$)/m.test(text)
  );
}

/** The label text after a `<<<<<<<` / `>>>>>>>` marker (trimmed, CR stripped). */
function labelOf(line: string): string {
  return line.slice(7).replace(/\r$/, "").trim();
}

/**
 * Splits conflicted text into context and conflict segments. Returns `null` when
 * it can't trust the split — malformed/out-of-order markers, OR a region whose
 * own content contains a marker-shaped line (a bare 7-char `=======`/`<<<<<<<`/…
 * that git's un-escaped format makes ambiguous). The caller falls back to a raw
 * view + whole-file actions, so an ambiguous file is never rendered or resolved
 * as a confidently-wrong split (which could silently destroy content).
 */
export function parseConflictSegments(text: string): Segment[] | null {
  const lines = text.split("\n");
  const segments: Segment[] = [];
  let ctx: string[] = [];
  const flushCtx = () => {
    if (ctx.length > 0) {
      segments.push({ kind: "context", text: ctx.join("\n") });
      ctx = [];
    }
  };

  let i = 0;
  let sawConflict = false;
  while (i < lines.length) {
    const line = lines[i];
    if (!isMarker(line, "<")) {
      ctx.push(line);
      i++;
      continue;
    }
    // Start of a conflict region.
    sawConflict = true;
    flushCtx();
    const start = i;
    const currentLabel = labelOf(line);
    i++;
    const current: string[] = [];
    while (
      i < lines.length &&
      !isMarker(lines[i], "|") &&
      !isMarker(lines[i], "=")
    ) {
      current.push(lines[i]);
      i++;
    }
    // Optional diff3 base block — consume and discard (not shown in v1).
    if (i < lines.length && isMarker(lines[i], "|")) {
      i++;
      while (i < lines.length && !isMarker(lines[i], "=")) i++;
    }
    if (i >= lines.length || !isMarker(lines[i], "=")) return null; // no separator
    i++;
    const incoming: string[] = [];
    while (i < lines.length && !isMarker(lines[i], ">")) {
      incoming.push(lines[i]);
      i++;
    }
    if (i >= lines.length || !isMarker(lines[i], ">")) return null; // unterminated
    // A side that contains its own marker-shaped line means the split is
    // ambiguous (the first `=======` we took as the separator may have been a
    // setext underline in `current`, folding the real separator into
    // `incoming`). git can't disambiguate this, so bail to the raw view rather
    // than silently mis-split + auto-stage truncated content.
    if (current.some(isAnyMarker) || incoming.some(isAnyMarker)) return null;
    const incomingLabel = labelOf(lines[i]);
    i++; // consume the >>>>>>> line
    segments.push({
      kind: "conflict",
      current: current.join("\n"),
      incoming: incoming.join("\n"),
      hasCurrent: current.length > 0,
      hasIncoming: incoming.length > 0,
      currentLabel,
      incomingLabel,
      raw: lines.slice(start, i).join("\n"),
    });
  }
  flushCtx();
  // A "conflicted" file with no parseable markers is itself suspicious — let the
  // caller fall back rather than show a file with nothing to resolve.
  return sawConflict ? segments : null;
}

/** The text a choice keeps: one side, or both (current then incoming). */
function chosenText(block: ConflictBlock, choice: ConflictChoice): string {
  if (choice === "current") return block.current;
  if (choice === "incoming") return block.incoming;
  // both — current then incoming, dropping a genuinely absent side (zero lines)
  // so accepting both never injects a spurious blank line. Keyed on the
  // had-lines flag, NOT string length, so a side that is one intentional blank
  // line (also "") is preserved.
  const parts: string[] = [];
  if (block.hasCurrent) parts.push(block.current);
  if (block.hasIncoming) parts.push(block.incoming);
  return parts.join("\n");
}

/**
 * Rebuilds the full file with conflict block #`index` resolved to `choice`,
 * leaving every other block untouched (its original markers). Byte-exact for the
 * unchanged parts. Feed the result to `git_resolve_conflict`.
 */
export function resolveBlock(
  segments: Segment[],
  index: number,
  choice: ConflictChoice,
): string {
  let conflictIdx = -1;
  return segments
    .map((s) => {
      if (s.kind === "context") return s.text;
      conflictIdx++;
      return conflictIdx === index ? chosenText(s, choice) : s.raw;
    })
    .join("\n");
}

/** Count of conflict blocks in a parsed segment list. */
export function conflictCount(segments: Segment[]): number {
  return segments.reduce((n, s) => n + (s.kind === "conflict" ? 1 : 0), 0);
}
