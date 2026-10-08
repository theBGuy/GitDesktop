import type { DiffStatEntry } from "./types";

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
      bytes.push(...encoder.encode(body.slice(start, i)));
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
    bytes.push(...encoder.encode(char));
    i += char.length;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * The new-file path from a header token, which is `b/<path>` either bare or
 * C-quoted. A bare token can carry a trailing TAB field, which git adds when the
 * name contains a space — cut at the tab rather than trimming, so a name that
 * genuinely ends in a space survives.
 *
 * No CR strip here, unlike the `\n`-slicing mirrors in truncate.ts and
 * generate.rs: both callers pass a `(.+)$` capture, and `.` never matches `\r`.
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

// Rename/copy destinations have no a/ or b/ prefix. git C-quotes whole values
// only; synthesized headers arrive raw, even when a path starts with a quote.
function movedFilePath(value: string): string | undefined {
  if (!value.startsWith('"')) return value || undefined;
  const close = value.lastIndexOf('"');
  if (close <= 0 || close !== value.length - 1) return value;
  return unescapeCQuoted(value.slice(1, close)) || undefined;
}

/**
 * Without a rename, git's header names match, so equal-name midpoint matching
 * comes first. Then try the quoted b-side, the escape-aware quoted a-side walk,
 * and finally the legacy last bare separator for synthetic differing names.
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
  // Differing bare names without rename/copy headers are not emitted by git;
  // retain last-separator parsing for these synthetic sections.
  const at = rest.lastIndexOf(" b/");
  return at < 0 ? undefined : newFilePath(rest.slice(at + 1));
}

/**
 * The decoded new-file path of one `diff --git` section.
 * Section keys and parallel file lists must share this decoder so AI-ignore
 * patterns match the same paths. A usable +++ path wins, then rename/copy
 * destinations, then the diff header: extended headers disambiguate renames
 * whose header names also match as an unrenamed pair.
 */
export function sectionFilePath(section: string): string | undefined {
  const plus = section.match(/^\+\+\+ (.+)$/m);
  const moved = section.match(/^(?:rename|copy) to (.+)$/m);
  const header = section.match(/^diff --git (.+)$/m);
  return (
    (plus?.[1] && newFilePath(plus[1])) ||
    (moved?.[1] && movedFilePath(moved[1])) ||
    (header?.[1] && headerFilePath(header[1])) ||
    undefined
  );
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
  for (const part of diff.split(/^(?=diff --git )/m)) {
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
        isBinary: part.includes("\nBinary files "),
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
 * the AI-ignore filter rebuilds the diff from this map, and an unkeyable section
 * is one that was never checked against the user's patterns.
 */
export function splitUnifiedDiff(diff: string): Map<string, string> {
  const sections = new Map<string, string>();
  for (const part of diff.split(/^(?=diff --git )/m)) {
    if (!part.trim()) continue;
    const path = sectionFilePath(part);
    if (path) sections.set(path, part);
  }
  return sections;
}
