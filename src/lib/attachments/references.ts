// The text rules of staged image attachments. Import-free, so the installless
// `scripts/attachment-references.test.mjs` suite loads it under type stripping.
// Text is never rewritten to show a staged image: a render resolves the plain
// name through its own staged-image source (the attachment store).

/** Rust's per-image limit, inclusive. The UI refuses above it before encoding,
 *  so an oversized file is never read. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type AttachSource = "paste" | "picker";

export interface AttachmentRefs {
  session: string;
  names: string[];
}

/** A staged name: the grammar Rust's `is_staged_name` shares, both sides
 *  pinned against the same fixture rows. */
const NAME_CHARS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NAME_EXTENSIONS = new Set(["png", "jpg", "gif", "webp"]);
const RESERVED_STEM = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function isStagedName(name: string): boolean {
  if (name.length === 0 || name.length > 80 || !NAME_CHARS.test(name))
    return false;
  const lastDot = name.lastIndexOf(".");
  if (lastDot === -1 || !NAME_EXTENSIONS.has(name.slice(lastDot + 1)))
    return false;
  return !RESERVED_STEM.test(name.slice(0, name.indexOf(".")));
}

/** The one reference rule both sides share: the text holds `](NAME)`. */
export function referencesName(text: string, name: string): boolean {
  return text.includes(`](${name})`);
}

/** The staged names `text` references, in first-occurrence order. */
export function referencedNames(text: string, names: readonly string[]) {
  return names
    .map((name) => ({ name, at: text.indexOf(`](${name})`) }))
    .filter((r) => r.at !== -1)
    .sort((a, b) => a.at - b.at)
    .map((r) => r.name);
}

/** An alt with the characters that would end or escape it backslashed and its
 *  line breaks flattened, since a newline would split the reference. A `(`
 *  right after a `]` is backslashed too, so the alt never holds a `](` the
 *  reference rule counts; any other parenthesis stays as typed. */
function escapeAlt(alt: string): string {
  return alt
    .split(/\r\n|\r|\n/)
    .join(" ")
    .replace(/[\\[\]]/g, (c) => `\\${c}`)
    .replaceAll("](", "]\\(");
}

/** A picked file's name without its extension. */
function fileStem(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/** The reference an attach inserts: a paste's alt is `image`, a picked file's is
 *  its name without the extension. */
export function imageReference(
  source: AttachSource,
  fileName: string | null,
  stagedName: string,
): string {
  const stem =
    source === "picker" && fileName !== null ? fileStem(fileName) : "";
  const alt = stem === "" ? "image" : escapeAlt(stem);
  return `![${alt}](${stagedName})`;
}

/** An image reference ending right where the text does. */
const TRAILING_IMAGE_REFERENCE = /!\[(?:\\.|[^\]\\\n])*\]\([^()\s]*\)$/;

/** What an insert at `caret` adds, separators included, and where the caret
 *  lands: right after the reference's `)`. Before it: nothing at the start or
 *  after whitespace, a newline after another image reference, else a space.
 *  After it: a space only when a non-whitespace character follows. */
export function insertionFor(
  text: string,
  caret: number,
  reference: string,
): { insert: string; caret: number } {
  const before = text.slice(0, caret);
  let lead = " ";
  if (before === "" || /\s$/.test(before)) lead = "";
  else if (TRAILING_IMAGE_REFERENCE.test(before)) lead = "\n";
  const next = text.charAt(caret);
  const trail = next !== "" && !/\s/.test(next) ? " " : "";
  return {
    insert: lead + reference + trail,
    caret: caret + lead.length + reference.length,
  };
}

/** `text` with `reference` appended the way an insert at its end would. */
export function appendReferenceText(text: string, reference: string): string {
  return text + insertionFor(text, text.length, reference).insert;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
}

function referencePattern(name: string): RegExp {
  return new RegExp(
    `${String.raw`!\[(?:\\.|[^\]\\\n])*\]\(`}${escapeRegExp(name)}\\)`,
    "g",
  );
}

/** Whether the character at `at` is backslash-escaped. */
function escapedAt(text: string, at: number): boolean {
  let n = 0;
  for (let j = at - 1; j >= 0 && text[j] === "\\"; j--) n += 1;
  return n % 2 === 1;
}

/** A text ending in a line break plus blanks: the line after it is blank, which
 *  bracket text never spans. */
const BLANK_LINE_BEFORE = /\n[ \t]*$/;

/** Where the bracket text closed by the `]` at `close` opens: its matching
 *  unescaped `[` (nesting counted), widened over a directly preceding unescaped
 *  `!`. `close` itself when there is none before a blank line or the start, or
 *  when that `]` is escaped and so closes nothing. */
function referenceStart(text: string, close: number): number {
  if (escapedAt(text, close)) return close;
  let depth = 0;
  for (let j = close - 1; j >= 0; j--) {
    const c = text[j];
    if (c === "\n" && BLANK_LINE_BEFORE.test(text.slice(0, j))) return close;
    if ((c !== "[" && c !== "]") || escapedAt(text, j)) continue;
    if (c === "]") depth += 1;
    else if (depth > 0) depth -= 1;
    else
      return j > 0 && text[j - 1] === "!" && !escapedAt(text, j - 1)
        ? j - 1
        : j;
  }
  return close;
}

/** A reference alone on its line takes one adjoining line break with it (the
 *  one after it, else the one before it), so no blank line is left behind. An
 *  inline reference keeps every character around it. */
function withOwnLineBreak(
  text: string,
  start: number,
  end: number,
): [number, number] {
  const ownsLine =
    (start === 0 || text[start - 1] === "\n") &&
    (end === text.length || text[end] === "\n");
  if (!ownsLine) return [start, end];
  if (end < text.length) return [start, end + 1];
  return start > 0 ? [start - 1, end] : [start, end];
}

/** `text` without one pass of `](NAME)` occurrences, each taken back to its
 *  opening bracket. */
function removeOnce(text: string, name: string): string {
  const token = `](${name})`;
  const ranges: [number, number][] = [];
  for (
    let at = text.indexOf(token);
    at !== -1;
    at = text.indexOf(token, at + 1)
  )
    ranges.push(
      withOwnLineBreak(text, referenceStart(text, at), at + token.length),
    );
  ranges.sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (end <= cursor) continue;
    out += text.slice(cursor, Math.max(start, cursor));
    cursor = end;
  }
  return out + text.slice(cursor);
}

/**
 * The one splice that deletes every reference the chip rule counts: each
 * `](NAME)` with the bracket text it closes (an image's `!` included, and a
 * plain link's text the same way), so no `](NAME)` remains and the chip goes.
 * One splice from the first change to the last, so a removal is one undo step.
 * Null when the text holds none.
 */
export function removalSplice(
  text: string,
  name: string,
): { start: number; end: number; replacement: string } | null {
  if (!referencesName(text, name)) return null;
  let out = text;
  // A deletion can join text into a new occurrence; each pass shrinks the text.
  while (referencesName(out, name)) out = removeOnce(out, name);
  let start = 0;
  while (start < out.length && text[start] === out[start]) start += 1;
  let tail = 0;
  while (
    tail < out.length - start &&
    text[text.length - 1 - tail] === out[out.length - 1 - tail]
  )
    tail += 1;
  return {
    start,
    end: text.length - tail,
    replacement: out.slice(start, out.length - tail),
  };
}

export function removeReferences(text: string, name: string): string {
  const splice = removalSplice(text, name);
  if (splice === null) return text;
  return (
    text.slice(0, splice.start) + splice.replacement + text.slice(splice.end)
  );
}

/** The draft a partial failure leaves: each failed image's reference with the
 *  alt it was posted with, one per line. */
export function failedReferencesDraft(
  postedBody: string,
  failedNames: readonly string[],
): string {
  return failedNames
    .map((name) => {
      const found = postedBody.match(new RegExp(referencePattern(name).source));
      return found ? found[0] : `![image](${name})`;
    })
    .join("\n");
}

/** The failed names of a post's outcome, tolerating the `null`/`undefined` an
 *  older backend or a test mock resolves. */
export function failedAttachmentsOf(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  const failed = (value as { failedAttachments?: unknown }).failedAttachments;
  if (!Array.isArray(failed)) return [];
  return failed.filter((n): n is string => typeof n === "string");
}

export type UploadAct = "posting" | "creating";

const UPLOADING: Record<
  UploadAct,
  { one: string; many: (n: number) => string }
> = {
  posting: {
    one: "Uploading 1 image and posting…",
    many: (n) => `Uploading ${n} images and posting…`,
  },
  creating: {
    one: "Uploading 1 image and creating…",
    many: (n) => `Uploading ${n} images and creating…`,
  },
};

/** Why a post holds while an image of its draft is still being staged. */
export const ATTACHING_REASON = "Wait for the image to finish attaching.";

export function uploadingReason(n: number, act: UploadAct): string {
  return n === 1 ? UPLOADING[act].one : UPLOADING[act].many(n);
}

/** A byte count as Rust's refusal prints it: megabytes rounded UP to a tenth,
 *  in integers so both sides agree at every boundary. */
export function refusalSize(bytes: number): string {
  const tenths = Math.floor((bytes * 10 + 1048575) / 1048576);
  return `${Math.floor(tenths / 10)}.${tenths % 10} MB`;
}

/** Rust's too-big sentence, spelled here too so a huge file is refused before
 *  it is read. */
export function tooBigRefusal(name: string | null, bytes: number): string {
  return `${name ?? "The pasted file"} is ${refusalSize(bytes)}. Images can be at most 10 MB.`;
}
