/**
 * Splitting a unified diff into hunks so each one can be staged, unstaged,
 * or discarded on its own via `git apply` (see git_apply_patch).
 */

export interface DiffHunk {
  /** The `@@ -a,b +c,d @@ …` line. */
  header: string;
  /** The hunk including its header line, ending with a newline. */
  text: string;
}

export interface ParsedDiff {
  /** Everything before the first hunk (diff --git / index / --- / +++). */
  fileHeader: string;
  hunks: DiffHunk[];
}

/** Parses single-file unified diff text. Returns no hunks for binary diffs. */
export function parseHunks(diffText: string): ParsedDiff {
  const lines = diffText.split("\n");
  const firstHunk = lines.findIndex((l) => l.startsWith("@@"));
  if (firstHunk === -1) return { fileHeader: diffText, hunks: [] };

  const fileHeader = `${lines.slice(0, firstHunk).join("\n")}\n`;
  const hunks: DiffHunk[] = [];
  let start = firstHunk;
  for (let i = firstHunk + 1; i <= lines.length; i++) {
    if (i === lines.length || lines[i].startsWith("@@")) {
      const body = lines.slice(start, i).join("\n");
      // The split leaves a trailing empty string from the final newline —
      // joining can yield a trailing "\n" already; normalize to exactly one.
      hunks.push({
        header: lines[start],
        text: `${body.replace(/\n+$/, "")}\n`,
      });
      start = i;
    }
  }
  return { fileHeader, hunks };
}

/** A patch containing just one hunk, in the form `git apply` expects. */
export function buildHunkPatch(parsed: ParsedDiff, hunk: DiffHunk): string {
  return `${plainModificationHeader(parsed.fileHeader)}${hunk.text}`;
}

/** File-header lines that pair a diff with a different source path. */
const PAIRING_HEADERS = [
  "similarity index ",
  "dissimilarity index ",
  "rename from ",
  "rename to ",
  "copy from ",
  "copy to ",
];

/**
 * A rename/copy file header rewritten as a plain modification of the NEW path,
 * so a hunk patch edits that path in place: applied in reverse, the pairing
 * would undo the rename itself. Mirrors the Rust `plain_modification_header`
 * byte for byte (mode and index lines stay; a header without pairing lines
 * comes back unchanged). Names reuse the diff's own `+++` token, quoting
 * included; its trailing TAB stays on `---`/`+++` and never reaches `diff --git`.
 */
function plainModificationHeader(header: string): string {
  const lines = header.split("\n");
  const pairs = (l: string) => PAIRING_HEADERS.some((p) => l.startsWith(p));
  const minus = lines.find((l) => l.startsWith("--- "))?.slice(4);
  const plus = lines.find((l) => l.startsWith("+++ "))?.slice(4);
  if (!lines.some(pairs) || minus === undefined || plus === undefined)
    return header;
  const tab = plus.endsWith("\t") ? "\t" : "";
  const newName = tab ? plus.slice(0, -1) : plus;
  const oldSide = oldSideSpelling(
    minus.endsWith("\t") ? minus.slice(0, -1) : minus,
    newName,
  );
  if (oldSide === null) return header;
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git "))
      out.push(`diff --git ${oldSide} ${newName}`);
    else if (line.startsWith("--- ")) out.push(`--- ${oldSide}${tab}`);
    else if (!pairs(line)) out.push(line);
  }
  return out.join("\n");
}

/** `name`'s path under the prefix `old` carries (`b/x` beside `a/y` gives
 *  `a/x`), keeping `name`'s C-quoting; null for a name without a prefix. */
function oldSideSpelling(old: string, name: string): string | null {
  const bareOld = old.startsWith('"') ? old.slice(1) : old;
  const quote = name.startsWith('"') ? '"' : "";
  const bareNew = quote ? name.slice(1) : name;
  const oldSlash = bareOld.indexOf("/");
  const newSlash = bareNew.indexOf("/");
  if (oldSlash === -1 || newSlash === -1) return null;
  return `${quote}${bareOld.slice(0, oldSlash)}/${bareNew.slice(newSlash + 1)}`;
}
