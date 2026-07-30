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
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      bytes.push(...encoder.encode(ch));
      continue;
    }
    const next = body[++i];
    if (next === undefined) break;
    const mapped = C_ESCAPES[next];
    if (mapped !== undefined) {
      bytes.push(mapped);
      continue;
    }
    if (next >= "0" && next <= "7") {
      let octal = next;
      while (octal.length < 3) {
        const digit = body[i + 1];
        if (digit === undefined || digit < "0" || digit > "7") break;
        octal += body[++i];
      }
      bytes.push(Number.parseInt(octal, 8) & 0xff);
      continue;
    }
    bytes.push(...encoder.encode(next));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * The new-file path from a header token, which is `b/<path>` either bare or
 * C-quoted. A bare token can carry a trailing TAB field, which git adds when the
 * name contains a space — cut at the tab rather than trimming, so a name that
 * genuinely ends in a space survives.
 */
function newFilePath(rawToken: string): string | undefined {
  if (!rawToken) return undefined;
  // `$` matches before the newline, so a CRLF-terminated diff leaves the CR on
  // the token. Everything else here must survive verbatim.
  const token = rawToken.endsWith("\r") ? rawToken.slice(0, -1) : rawToken;
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
    // Prefer the `+++ b/<path>` line (present for edits); fall back to the
    // `diff --git` header, which is all a pure rename or a delete carries.
    // Either side may arrive C-quoted, so the token is located by separator and
    // decoded — a quoted token starts with `"`, not `b`.
    const plus = part.match(/^\+\+\+ (.+)$/m);
    const header = part.match(/^diff --git (.+)$/m);
    const path =
      (plus?.[1] && newFilePath(plus[1])) ??
      (header?.[1] && newFilePath(newSideToken(header[1])));
    if (path) sections.set(path, part);
  }
  return sections;
}
