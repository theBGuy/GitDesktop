import type { DiffStatEntry } from "./types";

/** Only \n delimits lines; JS's \r/U+2028/U+2029 breaks would miskey sections. */
export const DIFF_SECTION_BOUNDARY = /(?<![^\n])(?=diff --git )/;

const encoder = new TextEncoder();

/** git's `quote_c_style` single-character escapes, mapped to their byte. */
const C_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  f: 12,
  n: 10,
  r: 13,
  t: 9,
  v: 11,
  '"': 34,
  "\\": 92,
};

/**
 * Decodes the body of a git C-quoted path (the part inside the quotes).
 *
 * The `\ooo` escapes are BYTE-wise, so a multi-byte name arrives as several of
 * them (`café` → `caf\303\251`): decode to bytes and run UTF-8 over the whole
 * buffer at the end. Decoding escape-by-escape into characters would turn every
 * non-ASCII path into mojibake.
 */
function unescapeCQuoted(body: string): string {
  const bytes: number[] = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] !== "\\") {
      // Encode the whole unescaped RUN at once. Per-index encoding would hand
      // TextEncoder one UTF-16 code unit at a time, splitting a surrogate pair
      // into two lone halves that each become U+FFFD — mojibake for any
      // non-BMP name (`core.quotePath=false` emits those literally, and a
      // backslash or control char elsewhere in the path still forces quoting).
      const start = i;
      while (i < body.length && body[i] !== "\\") i++;
      // Byte by byte, never `push(...run)`: spreading a long run past the
      // engine's argument limit throws RangeError.
      for (const byte of encoder.encode(body.slice(start, i))) bytes.push(byte);
      continue;
    }
    i++; // consume the backslash
    const next = body[i];
    if (next === undefined) break;
    const mapped = C_ESCAPES[next];
    if (mapped !== undefined) {
      bytes.push(mapped);
      i++;
      continue;
    }
    if (next >= "0" && next <= "7") {
      let octal = "";
      while (octal.length < 3 && body[i] >= "0" && body[i] <= "7") {
        octal += body[i];
        i++;
      }
      bytes.push(Number.parseInt(octal, 8) & 0xff);
      continue;
    }
    // Unknown escape: keep the character itself, by CODE POINT so a non-BMP one
    // survives whole.
    const char = String.fromCodePoint(body.codePointAt(i) as number);
    for (const byte of encoder.encode(char)) bytes.push(byte);
    i += char.length;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * The new-file path from a header token, which is `b/<path>` either bare or
 * C-quoted. A bare token can carry a trailing TAB field, which git adds when the
 * name contains a space — cut at the tab rather than trimming, so a name that
 * genuinely ends in a space survives.
 */
function newFilePath(token: string): string | undefined {
  if (!token) return undefined;
  let path: string;
  if (token.startsWith('"')) {
    const close = token.lastIndexOf('"');
    if (close <= 0) return undefined;
    path = unescapeCQuoted(token.slice(1, close));
  } else {
    path = token.split("\t")[0];
  }
  return path.startsWith("b/") ? path.slice(2) : undefined;
}

/**
 * A rename/copy destination, which has no a/ or b/ prefix.
 * git's final b-side field repeats the escaped destination after `"b/`.
 * A producer that writes both raw puts the destination's quote after `b/`,
 * so this suffix cannot match; quote runs in the old name cannot change the
 * result.
 */
function movedFilePath(
  value: string,
  headerRest: string | undefined,
): string | undefined {
  const quoted =
    value.length >= 2 &&
    value.startsWith('"') &&
    value.endsWith('"') &&
    !!headerRest?.endsWith(`"b/${value.slice(1)}`);
  if (!quoted) return value || undefined;
  return unescapeCQuoted(value.slice(1, -1)) || undefined;
}

/**
 * The new path from a `diff --git` header's names. Unless the file was renamed
 * or copied, git writes the same name on both sides, so an equal-name midpoint
 * split is unique and wins; differing names fall back to separator search.
 */
function headerFilePath(rest: string): string | undefined {
  if (rest.startsWith("a/")) {
    const names = rest.slice(2);
    const half = (names.length - 3) / 2;
    if (
      Number.isInteger(half) &&
      half > 0 &&
      names.slice(half, half + 3) === " b/" &&
      names.slice(0, half) === names.slice(half + 3)
    )
      return names.slice(0, half);
  }
  // git never leaves quotes bare in a name and escapes them inside quoted
  // tokens, so ` "b/` can only be the separator.
  const quoted = rest.lastIndexOf(' "b/');
  if (quoted >= 0) return newFilePath(rest.slice(quoted + 1));
  if (rest.startsWith('"')) {
    let i = 1;
    // Skip both characters of escapes such as \"; bounds cover a trailing backslash.
    while (i < rest.length && rest[i] !== '"') i += rest[i] === "\\" ? 2 : 1;
    if (i < rest.length && rest[i + 1] === " ")
      return newFilePath(rest.slice(i + 2));
  }
  // git never emits differing bare names without rename/copy headers; the last
  // separator keys synthesized ones.
  const at = rest.lastIndexOf(" b/");
  return at < 0 ? undefined : newFilePath(rest.slice(at + 1));
}

/**
 * The decoded new-file path of one `diff --git` section.
 * Section keys and parallel file lists must share this decoder so AI-ignore
 * patterns match the same paths. A usable +++ path wins, then rename/copy
 * destinations, then the diff header: extended headers disambiguate renames
 * whose header names also match as an unrenamed pair.
 *
 * Logical lines use only `\n`; JS `.` and /m treat `\r`, U+2028 and U+2029
 * as line breaks and can miskey names or content. Strip one trailing CR as
 * CRLF transport; embedded CRs belong to the name and must survive.
 */
export function sectionFilePath(section: string): string | undefined {
  const plus = section
    .match(/(?<![^\n])\+\+\+ ([^\n]+)/)?.[1]
    .replace(/\r$/, "");
  const moved = section
    .match(/(?<![^\n])(?:rename|copy) to ([^\n]+)/)?.[1]
    .replace(/\r$/, "");
  const header = section
    .match(/(?<![^\n])diff --git ([^\n]+)/)?.[1]
    .replace(/\r$/, "");
  return (
    (plus && newFilePath(plus)) ||
    (moved && movedFilePath(moved, header)) ||
    (header && headerFilePath(header)) ||
    undefined
  );
}

/** A rename/copy SOURCE, which has no a/ or b/ prefix; quoted exactly when the
 *  header's a-side field opens with the same escaped name (the mirror of
 *  `movedFilePath`'s b-side test). */
function movedSourcePath(
  value: string,
  headerRest: string | undefined,
): string | undefined {
  const quoted =
    value.length >= 2 &&
    value.startsWith('"') &&
    value.endsWith('"') &&
    !!headerRest?.startsWith(`"a/${value.slice(1)}`);
  if (!quoted) return value || undefined;
  return unescapeCQuoted(value.slice(1, -1)) || undefined;
}

export type ModeTransition = "to-exec" | "from-exec" | "other";
export type HeaderOnlyKind =
  | "new-empty"
  | "deleted-empty"
  | "mode"
  | "rename"
  | "copy";

/** A diff section that changes no content: only its header says what changed. */
export interface HeaderOnlyDiff {
  kind: HeaderOnlyKind;
  /** The `mode` kind, and a mode change riding a rename or copy. */
  transition?: ModeTransition;
  oldMode?: string;
  newMode?: string;
  /** The rename/copy kinds, decoded. */
  oldPath?: string;
  newPath?: string;
}

const MODE_LINE = /^(old|new) mode ([0-7]{6})$/;
const MOVE_LINE = /^(rename|copy) (from|to) (.+)$/;
/** Header lines that carry no change of their own. */
const QUIET_LINE =
  /^(?:index [0-9a-f]+\.\.[0-9a-f]+(?: [0-7]{6})?|(?:dis)?similarity index \d+%)$/;

function modeTransition(oldMode: string, newMode: string): ModeTransition {
  if (oldMode === "100644" && newMode === "100755") return "to-exec";
  if (oldMode === "100755" && newMode === "100644") return "from-exec";
  return "other";
}

/**
 * What a hunk-less diff section changed: a new or deleted empty file, a mode
 * change, or a rename or copy with no content change. Null for anything else:
 * an empty section, a hunk or file header line, git's binary marker, a line
 * after a blank one, or any header line this doesn't recognize (callers then
 * render it as they always did). A renamed empty file reads as a rename (git
 * pairs its delete and add), and a rename or copy beside a new or deleted file
 * header is unclassifiable. Lines are read one at a time, so a diff with
 * content stops at its first `---` or `@@` line.
 */
export function classifyHeaderOnlyDiff(text: string): HeaderOnlyDiff | null {
  /** The logical line from `at` (one trailing CR dropped) and where the next
   *  one starts. */
  const lineAt = (at: number) => {
    const end = text.indexOf("\n", at);
    const stop = end < 0 ? text.length : end;
    return { line: text.slice(at, stop).replace(/\r$/, ""), next: stop + 1 };
  };
  const first = lineAt(0);
  if (!first.line.startsWith("diff --git ")) return null;
  const header = first.line.slice("diff --git ".length);
  const modes: { old?: string; new?: string } = {};
  const moves: { kind?: "rename" | "copy"; from?: string; to?: string } = {};
  let created = false;
  let deleted = false;
  let blank = false;
  let at = first.next;
  while (at < text.length) {
    const { line, next } = lineAt(at);
    at = next;
    // Trailing blank lines are transport; content after one is not a header.
    if (line === "") {
      blank = true;
      continue;
    }
    if (blank || line.startsWith("---") || line.startsWith("@@")) return null;
    const mode = MODE_LINE.exec(line);
    if (mode) {
      if (modes[mode[1] as "old" | "new"] !== undefined) return null;
      modes[mode[1] as "old" | "new"] = mode[2];
      continue;
    }
    const move = MOVE_LINE.exec(line);
    if (move) {
      const kind = move[1] as "rename" | "copy";
      const end = move[2] as "from" | "to";
      if ((moves.kind && moves.kind !== kind) || moves[end] !== undefined)
        return null;
      moves.kind = kind;
      moves[end] =
        end === "from"
          ? movedSourcePath(move[3], header)
          : movedFilePath(move[3], header);
      if (moves[end] === undefined) return null;
      continue;
    }
    if (/^new file mode [0-7]{6}$/.test(line)) created = true;
    else if (/^deleted file mode [0-7]{6}$/.test(line)) deleted = true;
    else if (!QUIET_LINE.test(line)) return null;
  }
  // Both halves of a mode change, or neither.
  if ((modes.old === undefined) !== (modes.new === undefined)) return null;
  const modeChange =
    modes.old !== undefined && modes.new !== undefined
      ? {
          transition: modeTransition(modes.old, modes.new),
          oldMode: modes.old,
          newMode: modes.new,
        }
      : {};
  if (moves.kind) {
    if (moves.from === undefined || moves.to === undefined) return null;
    if (created || deleted) return null;
    return {
      kind: moves.kind,
      ...modeChange,
      oldPath: moves.from,
      newPath: moves.to,
    };
  }
  if (created && deleted) return null;
  if (created) return modes.old === undefined ? { kind: "new-empty" } : null;
  if (deleted)
    return modes.old === undefined ? { kind: "deleted-empty" } : null;
  return modes.old === undefined ? null : { kind: "mode", ...modeChange };
}

/** The mode-change sentence, shared by the `mode` title and the rename/copy
 *  detail line so both use one term. */
export const MODE_CHANGE: Record<
  ModeTransition,
  (oldMode: string, newMode: string) => string
> = {
  "to-exec": () => "File is now executable",
  "from-exec": () => "File is no longer executable",
  other: (oldMode, newMode) =>
    `File mode changed from ${oldMode} to ${newMode}`,
};

/** A section's mode change in words, or null when it carries none. */
export function modeChangeMessage(diff: HeaderOnlyDiff): string | null {
  if (diff.transition === undefined) return null;
  return MODE_CHANGE[diff.transition](diff.oldMode ?? "", diff.newMode ?? "");
}

/** What a header-only diff changed, in sentence case with no trailing period
 *  (the diff pane's placeholder style; a surface with sentence copy adds one). */
export const HEADER_ONLY_MESSAGE: Record<
  HeaderOnlyKind,
  (diff: HeaderOnlyDiff) => string
> = {
  "new-empty": () => "New empty file",
  "deleted-empty": () => "Deleted empty file",
  mode: (diff) => modeChangeMessage(diff) ?? "File mode changed",
  rename: () => "Renamed with no content changes",
  copy: () => "Copied with no content changes",
};

export function headerOnlyMessage(diff: HeaderOnlyDiff): string {
  return HEADER_ONLY_MESSAGE[diff.kind](diff);
}

/** True when a diff section carries git's own binary marker at line start —
 *  hunk body lines are prefixed (+/-/space), so content can't match. A
 *  section never STARTS with the marker (every section opens with
 *  `diff --git`, or `---`/`+++` for a headerless patch), so the \n-prefixed
 *  literal needs no start-of-string arm — and it must stay this literal:
 *  diffSectionStats' behavior is pinned on it. */
export function sectionIsBinary(section: string): boolean {
  return section.includes("\nBinary files ");
}

/** The paths of the rows the PR Files list may flag binary: forge counts 0/0
 *  (forges report 0/0 for binaries; nonzero counts mean a huge-text fallback
 *  marker or a count/diff skew) AND the row's section carries the marker.
 *  Keyed exactly as the pane keys sections (the same map). */
export function binaryRowPaths(
  files: ReadonlyArray<{ path: string; additions: number; deletions: number }>,
  sections: ReadonlyMap<string, string>,
): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const file of files) {
    if (
      file.additions === 0 &&
      file.deletions === 0 &&
      sectionIsBinary(sections.get(file.path) ?? "")
    )
      paths.add(file.path);
  }
  return paths;
}

/**
 * Per-file `+added -deleted` counts read off a unified diff that arrived without
 * a file list. Paths come from `sectionFilePath`, the decoder `splitUnifiedDiff`
 * keys with, so the AI-ignore filter matches these entries by the same rule.
 * Only lines inside a hunk count: a `+++`/`---` header is never a change, and a
 * hunk line spelled that way always is one.
 */
export function diffSectionStats(diff: string): DiffStatEntry[] {
  if (typeof diff !== "string") return [];
  const stats: DiffStatEntry[] = [];
  for (const part of diff.split(DIFF_SECTION_BOUNDARY)) {
    if (!part.trim()) continue;
    try {
      const path = sectionFilePath(part);
      if (!path) continue;
      let added = 0;
      let deleted = 0;
      let inHunk = false;
      for (const line of part.split("\n")) {
        if (line.startsWith("@@")) inHunk = true;
        else if (!inHunk) continue;
        else if (line.startsWith("+")) added++;
        else if (line.startsWith("-")) deleted++;
      }
      stats.push({
        path,
        added,
        deleted,
        isBinary: sectionIsBinary(part),
      });
    } catch {
      // One malformed section must never cost the rest of the list.
    }
  }
  return stats;
}

/**
 * Splits a combined unified diff (e.g. `gh pr diff`) into per-file sections
 * keyed by the new-file path, so each can be fed to the file diff viewer.
 *
 * A section whose path can't be keyed is dropped rather than passed through:
 * an unkeyable section has no file row to attach to.
 */
export function splitUnifiedDiff(diff: string): Map<string, string> {
  const sections = new Map<string, string>();
  for (const part of diff.split(DIFF_SECTION_BOUNDARY)) {
    if (!part.trim()) continue;
    const path = sectionFilePath(part);
    if (path) sections.set(path, part);
  }
  return sections;
}
