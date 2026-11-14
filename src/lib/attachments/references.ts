// The text rules of staged image attachments. Import-free, so the installless
// `scripts/attachment-references.test.mjs` suite loads it under type stripping.
// Text is never rewritten to show a staged image: a render resolves the plain
// name through its own staged-image source (the attachment store).

/** Rust's per-image limit, inclusive. The UI refuses above it before encoding,
 *  so an oversized file is never read. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Rust's per-draft image cap (MAX_IMAGES in src-tauri/src/attachments.rs);
 *  scripts/attachment-drafts.test.mjs keeps the two equal. */
export const MAX_STAGED_IMAGES = 10;

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

/** What a backslash pairs with in bracket text (`.`): anything but a line
 *  terminator. */
const PAIRABLE = /./;

/** What ends a reference's target: a parenthesis or whitespace. */
const TARGET_STOP = /[()\s]/;

/**
 * Bracket text as `!\[(?:\\.|[^\]\\\n])*\]` reads it, walked once forward: a
 * backslash pairs with the next pairable character, a `\n` or an unpaired
 * backslash ends all open bracket text, and the first unescaped `]` closes it.
 * `\r`, U+2028 and U+2029 stay inside bracket text; a backslash cannot pair
 * with them. Returns the earliest `![` whose `]` `accept` takes, with that
 * `]`, or null. One pass whatever the `![` count, so it stays linear.
 */
function findImageBracket(
  text: string,
  accept: (close: number) => boolean,
): [number, number] | null {
  let open = -1;
  for (let p = 0; p < text.length; p++) {
    const c = text[p];
    if (c === "\\") {
      if (p + 1 < text.length && PAIRABLE.test(text[p + 1])) {
        p += 1;
        // The regex has no lookbehind: an escaped `!` still opens `![`.
        if (open === -1 && text[p] === "!" && text[p + 1] === "[") open = p;
      } else open = -1;
    } else if (c === "\n") open = -1;
    else if (c === "]") {
      if (open !== -1 && accept(p)) return [open, p];
      open = -1;
    } else if (open === -1 && c === "!" && text[p + 1] === "[") open = p;
  }
  return null;
}

/** How many backslashes directly precede `at`. */
function backslashRunBefore(text: string, at: number): number {
  let n = 0;
  while (at - 1 - n >= 0 && text[at - 1 - n] === "\\") n += 1;
  return n;
}

/** Whether an image reference ends right where the text does: a `)` closing a
 *  target with no parenthesis or whitespace, after an unescaped `]` whose
 *  bracket text some `![` opens. Read back from the end, each backslash run
 *  once, and stops at the nearest `![` or at what ends bracket text. */
function endsInImageReference(text: string): boolean {
  if (!text.endsWith(")")) return false;
  let open = text.length - 2;
  while (open >= 0 && !TARGET_STOP.test(text[open])) open -= 1;
  const close = open - 1;
  if (close < 0 || text[open] !== "(" || text[close] !== "]") return false;
  let run = backslashRunBefore(text, close);
  if (run % 2 === 1) return false;
  for (let j = close - 1 - run; j >= 0; j -= 1 + run) {
    run = backslashRunBefore(text, j);
    const c = text[j];
    const escaped = run % 2 === 1;
    if (c === "\n" || (c === "]" && !escaped)) return false;
    if (escaped && !PAIRABLE.test(c)) return false;
    if (c === "[" && text[j - 1] === "!") return true;
  }
  return false;
}

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
  else if (endsInImageReference(before)) lead = "\n";
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

/** The first image reference in `text` whose target is exactly `name`, as
 *  written there, or null. */
function imageReferenceTo(text: string, name: string): string | null {
  const token = `](${name})`;
  let next = text.indexOf(token);
  if (next === -1) return null;
  const found = findImageBracket(text, (close) => {
    if (next !== -1 && next < close) next = text.indexOf(token, close);
    return next === close;
  });
  return found === null ? null : text.slice(found[0], found[1] + token.length);
}

/**
 * For each `]` at the ascending positions `closes`, where the bracket text it
 * closes opens: its matching unescaped `[` (nesting counted), widened over a
 * directly preceding unescaped `!`. A `]` with no such `[` since a blank line or
 * the start, or an escaped one, has no entry. One forward pass to the last of
 * them, so a line of many occurrences stays linear.
 */
function bracketStarts(
  text: string,
  closes: readonly number[],
): Map<number, number> {
  const starts = new Map<number, number>();
  const opens: number[] = [];
  let next = 0; // the first of `closes` not yet reached
  let run = 0; // backslashes directly before `p`
  let prevBang = false; // the character before `p` is an unescaped `!`
  let blankLine = false; // a line break came, then only blanks
  for (let p = 0; next < closes.length && p < text.length; p++) {
    const c = text[p];
    const escaped = run % 2 === 1;
    if (c === "\n") {
      // Bracket text never spans a blank line.
      if (blankLine) opens.length = 0;
      blankLine = true;
    } else if (c !== " " && c !== "\t") blankLine = false;
    if (c === "[" && !escaped) opens.push(prevBang ? p - 1 : p);
    else if (c === "]") {
      const wanted = p === closes[next];
      if (wanted) next += 1;
      const open = escaped ? undefined : opens.pop();
      if (wanted && open !== undefined) starts.set(p, open);
    }
    prevBang = c === "!" && !escaped;
    run = c === "\\" ? run + 1 : 0;
  }
  return starts;
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

/**
 * The start `bracketStarts` gives the `]` at `close` (`close` itself where it
 * gives none), read backward from it, which is cheap when its `[` is near.
 * Every character it steps over, in backslash runs and blank-line checks too,
 * spends one step of `budget`. A start it returns is exact even when the walk
 * overdrew the budget; undefined only when a step finds the budget already
 * spent.
 */
function walkedStart(
  text: string,
  close: number,
  budget: { left: number },
): number | undefined {
  const escaped = (at: number) => {
    const run = backslashRunBefore(text, at);
    budget.left -= run;
    return run % 2 === 1;
  };
  if (escaped(close)) return close;
  let depth = 0;
  for (let j = close - 1; j >= 0; j--) {
    if (--budget.left < 0) return undefined;
    const c = text[j];
    if (c === "\n") {
      // Bracket text never spans a blank line.
      let k = j - 1;
      while (k >= 0 && (text[k] === " " || text[k] === "\t")) k -= 1;
      budget.left -= j - 1 - k;
      if (k >= 0 && text[k] === "\n") return close;
    } else if ((c === "[" || c === "]") && !escaped(j)) {
      if (c === "]") depth += 1;
      else if (depth > 0) depth -= 1;
      else return j > 0 && text[j - 1] === "!" && !escaped(j - 1) ? j - 1 : j;
    }
  }
  return close;
}

/** `text` without one pass of `](NAME)` occurrences, each taken back to its
 *  opening bracket. */
function removeOnce(text: string, name: string): string {
  const token = `](${name})`;
  const closes: number[] = [];
  for (
    let at = text.indexOf(token);
    at !== -1;
    at = text.indexOf(token, at + 1)
  )
    closes.push(at);
  // Walks back from each occurrence until their total steps reach three
  // forward scans' worth (a scan step costs more than a walk step), then one
  // scan to the last occurrence answers the rest. A removal pass therefore
  // costs at most a few times the cheaper of the two methods.
  const end = (closes.at(-1) ?? -1) + 1;
  const budget = { left: end * 3 };
  let starts: Map<number, number> | undefined;
  const ranges = closes.map((at) => {
    let start = starts ? undefined : walkedStart(text, at, budget);
    if (start === undefined) {
      starts ??= bracketStarts(text, closes);
      start = starts.get(at) ?? at;
    }
    return withOwnLineBreak(text, start, at + token.length);
  });
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
    .map((name) => imageReferenceTo(postedBody, name) ?? `![image](${name})`)
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

/** A create's follow-up reason (the item exists, its metadata step failed);
 *  null for any outcome without a non-empty string there. */
export function followupErrorOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const reason = (value as { followupError?: unknown }).followupError;
  return typeof reason === "string" && reason !== "" ? reason : null;
}

/** A created item's number; null when it couldn't be read (the backend answers
 *  0), so nothing navigates to, links or prints "#0". */
export function createdNumberOf(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  const number = (value as { number?: unknown }).number;
  return typeof number === "number" && Number.isInteger(number) && number > 0
    ? number
    : null;
}

/** A partial edit's saved description; null when the outcome carries none. An
 *  empty string is a saved (empty) description, so it is returned as is. */
export function savedBodyOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const body = (value as { body?: unknown }).body;
  return typeof body === "string" ? body : null;
}

export type UploadAct = "posting" | "creating" | "saving";

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
  saving: {
    one: "Uploading 1 image and saving…",
    many: (n) => `Uploading ${n} images and saving…`,
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
