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

/**
 * The b-side token of a `diff --git` header.
 *
 * git quotes each side INDEPENDENTLY, so a plain a-side routinely sits beside a
 * quoted b-side (`diff --git a/x "b/y\r"` — a real GitHub rename diff). Both
 * spellings of the separator have to be accepted; keying off the a-side's
 * quoting drops every mixed header.
 */
function newSideToken(headerRest: string): string {
  const at = Math.max(
    headerRest.lastIndexOf(' "b/'),
    headerRest.lastIndexOf(" b/"),
  );
  return at < 0 ? "" : headerRest.slice(at + 1);
}

/**
 * The decoded new-file path of one `diff --git` section.
 *
 * The single decoder for anything that has to KEY a section by path. Callers
 * that key a section and callers that build a parallel file list must use this
 * same one, or their keys disagree: the AI-ignore filter hides a file by
 * matching a section key against a file-list entry, and a file list parsed with
 * a different rule silently survives the filter.
 */
export function sectionFilePath(section: string): string | undefined {
  // Prefer the `+++ b/<path>` line (present for edits); fall back to the
  // `diff --git` header, which is all a pure rename or a delete carries. Either
  // side may arrive C-quoted, so the token is located by separator and decoded —
  // a quoted token starts with `"`, not `b`.
  const plus = section.match(/^\+\+\+ (.+)$/m);
  const header = section.match(/^diff --git (.+)$/m);
  return (
    (plus?.[1] && newFilePath(plus[1])) ??
    (header?.[1] && newFilePath(newSideToken(header[1]))) ??
    undefined
  );
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
