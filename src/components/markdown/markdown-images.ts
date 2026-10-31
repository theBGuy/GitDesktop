// Import-free on purpose: scripts/markdown-images.test.mjs loads this module
// straight from src under Node's type stripping, which can't follow an `@/`
// alias or a .tsx import.

/** Any scheme at all, in RFC 3986's shape. DOMPurify's default allowlist admits
 *  far more than the `http(s):` and `mailto:` forms the link renderer opens
 *  (`tel:`, `ftp:`, `sms:`, `cid:`, `xmpp:` …), and a scheme-bearing href is not
 *  a repository path, so it never becomes one. */
export const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Two leading slashes, in either slash. `new URL` reads both `//host/x` and
 *  `\\host\x` against an https base as an AUTHORITY, resolving to that host — so
 *  an href in either shape would otherwise wear a repo-file card naming the
 *  forge while opening somewhere else entirely. Backslashes reach the DOM only
 *  through a body's raw HTML; marked percent-encodes them in its own syntax. */
export const AUTHORITY_PREFIX = /^[\\/]{2}/;

/** Tab, LF, and CR — the URL parser removes these from ANYWHERE in an href. */
export const URL_REMOVED = /[\t\n\r]/g;

/** A single leading separator. Dropped from a root-relative href so it resolves
 *  against the repository root rather than the forge's site root, and tested
 *  again afterwards: one still there means the href carried two, which addresses
 *  something other than a file in this repo. */
export const LEADING_SEPARATOR = /^[\\/]/;

/** An href as the URL parser will read it: those three gone, then the
 *  leading/trailing C0-and-space run stripped (`String.trim` misses C0).
 *  DOMPurify only edge-trims attribute values, so both shapes reach the DOM, and
 *  judging the raw text would judge a different string than the one that
 *  resolves: `/<tab>/evil.com` reads as a path and resolves to an authority.
 *  The edge walk is by code point; a control-character regex class fails lint. */
export function normalizeHref(raw: string): string {
  const s = raw.replace(URL_REMOVED, "");
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 0x20) start++;
  while (end > start && s.charCodeAt(end - 1) <= 0x20) end--;
  return s.slice(start, end);
}

/** Reads one rendered document issues at once. */
export const REPO_IMAGE_MAX_IN_FLIGHT = 4;

/** Decoded image bytes one rendered document may load; past it an image gets
 *  the "too large" caption, so a document can't make the app buffer without
 *  bound. */
export const REPO_IMAGE_DOC_BUDGET_BYTES = 64 * 1024 * 1024;

/** One document's image budget. Every completed read is charged, kept or not,
 *  since its bytes were buffered either way; once the charge reaches the limit
 *  no further read starts, so overshoot stays within the reads in flight. */
export interface ImageBudget {
  /** Charges `size` decoded bytes; true when they still fit the limit. */
  admit(size: number): boolean;
  /** Whether the limit is reached, so a read not yet started must not start. */
  exhausted(): boolean;
}

export function createImageBudget(
  limit = REPO_IMAGE_DOC_BUDGET_BYTES,
): ImageBudget {
  let spent = 0;
  return {
    admit(size) {
      spent += size;
      return spent <= limit;
    },
    exhausted: () => spent >= limit,
  };
}

/** Why an image in rendered markdown shows a caption instead of itself. */
export type ImageCaptionReason =
  | "absent"
  | "tooLarge"
  | "notImage"
  | "readFailed"
  | "noRepo";

/** The one spelling of each reason, shared by the markdown captions and the
 *  image diff's failed and refused panes. */
export const IMAGE_CAPTION_REASON: Record<ImageCaptionReason, string> = {
  absent: "Not in this version",
  tooLarge: "Too large to preview",
  notImage: "Can't show this file",
  readFailed: "Couldn't read the file",
  noRepo: "Images can't load in this view",
};

/** Phosphor's `Image` icon, regular weight, on its 256-unit viewBox: the
 *  caption builds its glyph from this path rather than rendering a component
 *  into injected HTML. */
export const IMAGE_ICON_VIEWBOX = "0 0 256 256";
export const IMAGE_ICON_PATH =
  "M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Zm0,16V158.75l-26.07-26.06a16,16,0,0,0-22.63,0l-20,20-44-44a16,16,0,0,0-22.62,0L40,149.37V56ZM40,172l52-52,80,80H40Zm176,28H194.63l-36-36,20-20L216,181.38V200ZM144,100a12,12,0,1,1,12,12A12,12,0,0,1,144,100Z";

/**
 * Runs `task` over `items` in order with at most `limit` in flight. Cancellation
 * is checked immediately before each start, so once `isCancelled()` answers true
 * nothing new starts; tasks already running are left to settle. A rejection
 * counts as settled (tasks own their errors), and the promise resolves once every
 * started task has.
 */
export function runCapped<T>(
  items: readonly T[],
  limit: number,
  isCancelled: () => boolean,
  task: (item: T) => Promise<void>,
): Promise<void> {
  return new Promise((resolve) => {
    let next = 0;
    let inFlight = 0;
    const settle = () => {
      inFlight--;
      pump();
    };
    function pump() {
      while (inFlight < limit && next < items.length) {
        if (isCancelled()) {
          next = items.length;
          break;
        }
        const item = items[next++];
        inFlight++;
        let run: Promise<void>;
        try {
          run = task(item);
        } catch (e) {
          run = Promise.reject(e);
        }
        run.then(settle, settle);
      }
      if (inFlight === 0) resolve();
    }
    pump();
  });
}

/** Whether an image URL names something in the repository, judged the way the
 *  URL parser would read it: no scheme, no authority, not a bare fragment. These
 *  are the values the webview would otherwise resolve against its own origin. */
export function isRepoRelativeImageUrl(raw: string): boolean {
  const s = normalizeHref(raw);
  return (
    s !== "" &&
    !ANY_SCHEME.test(s) &&
    !AUTHORITY_PREFIX.test(s) &&
    !s.startsWith("#")
  );
}

/** A control character or DEL anywhere in a string. */
function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * The repository path an image URL names from a document in `baseDir`, or null
 * when it names none. Every refusal leaves the read unissued: a scheme or an
 * authority (a network load, not a file), any control character or backslash, a
 * second leading separator, a segment that won't decode or decodes to a
 * separator or control character, and a `..` above the root. One leading `/`
 * addresses the repository root, as it does on the forges. Query and fragment
 * are dropped; dot segments collapse after decoding, so `%2e%2e` climbs too.
 */
export function resolveRepoImagePath(
  raw: string,
  baseDir: string,
): string | null {
  const href = normalizeHref(raw);
  if (href === "" || ANY_SCHEME.test(href) || AUTHORITY_PREFIX.test(href))
    return null;
  if (hasControl(href) || href.includes("\\")) return null;
  let path = href;
  const cut = path.search(/[?#]/);
  if (cut !== -1) path = path.slice(0, cut);
  const rooted = path.startsWith("/");
  if (rooted) {
    path = path.slice(1);
    if (LEADING_SEPARATOR.test(path)) return null;
  }
  const out = rooted ? [] : baseDir.split("/").filter((s) => s !== "");
  for (const segment of path.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (decoded.includes("/") || decoded.includes("\\") || hasControl(decoded))
      return null;
    if (decoded === "" || decoded === ".") continue;
    if (decoded === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(decoded);
  }
  return out.length === 0 ? null : out.join("/");
}

/** One `srcset` image candidate; `descriptor` is kept exactly as written. */
export interface SrcsetCandidate {
  url: string;
  descriptor: string;
}

const ASCII_SPACE = /[\t\n\f\r ]/;

/** A `srcset` split into candidates the way the HTML parser splits it: a URL
 *  runs to whitespace (a trailing comma ends it with no descriptor), and its
 *  descriptor to the next comma outside parentheses. */
export function parseSrcset(raw: string): SrcsetCandidate[] {
  const out: SrcsetCandidate[] = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && (ASCII_SPACE.test(raw[i]) || raw[i] === ",")) i++;
    if (i >= raw.length) break;
    const start = i;
    while (i < raw.length && !ASCII_SPACE.test(raw[i])) i++;
    let url = raw.slice(start, i);
    let descriptor = "";
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      const from = i;
      let depth = 0;
      while (i < raw.length) {
        const c = raw[i];
        if (c === "(") depth++;
        else if (c === ")") depth = Math.max(0, depth - 1);
        else if (c === "," && depth === 0) break;
        i++;
      }
      descriptor = raw.slice(from, i).trim();
      i++;
    }
    if (url !== "") out.push({ url, descriptor });
  }
  return out;
}

/** {@link parseSrcset}'s inverse. */
export function serializeSrcset(
  candidates: readonly SrcsetCandidate[],
): string {
  return candidates
    .map((c) => (c.descriptor === "" ? c.url : `${c.url} ${c.descriptor}`))
    .join(", ");
}

/** Bytes a base64 payload decodes to. */
export function decodedByteLength(base64: string): number {
  const pad = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - pad;
}

/** The base64 prefix an SVG root has to show up in. */
const SVG_HEAD_CHARS = 4096;
const SVG_EXTENSION = /\.svg$/i;
const XML_SPACE = /[\t\n\r ]/;
const XML_DECLARATION = /^<\?xml[\t\n\r ]/;
const XML_DOCTYPE = /^<!DOCTYPE[\t\n\r >]/;
const SVG_ROOT = /^<svg[\t\n\r >/]/;

/**
 * Whether `.svg`-named bytes really open an `<svg>` document: after an optional
 * BOM, whitespace, one XML declaration, comments and one doctype with no
 * internal subset (an entity can't ride in), the first element is `svg`.
 * Anything unterminated inside the window fails, so a file that only claims the
 * extension (HTML, text, a renamed raster) never reaches an `<img>` as SVG.
 */
export function isSvgDocument(base64: string, path: string): boolean {
  if (!SVG_EXTENSION.test(path)) return false;
  const head = base64.slice(0, SVG_HEAD_CHARS);
  let text: string;
  try {
    const bin = atob(head.slice(0, head.length - (head.length % 4)));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    text = new TextDecoder("utf-8").decode(bytes);
  } catch {
    return false;
  }
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let sawDeclaration = false;
  let sawDoctype = false;
  for (;;) {
    while (i < text.length && XML_SPACE.test(text[i])) i++;
    const rest = text.slice(i);
    if (!sawDeclaration && XML_DECLARATION.test(rest)) {
      const end = text.indexOf("?>", i);
      if (end === -1) return false;
      i = end + 2;
      sawDeclaration = true;
    } else if (rest.startsWith("<!--")) {
      const end = text.indexOf("-->", i + 4);
      if (end === -1) return false;
      i = end + 3;
    } else if (!sawDoctype && XML_DOCTYPE.test(rest)) {
      const end = text.indexOf(">", i);
      if (end === -1 || text.slice(i, end).includes("[")) return false;
      i = end + 1;
      sawDoctype = true;
    } else {
      return SVG_ROOT.test(rest);
    }
  }
}

/** The media type for a repository image's data: URL, or null to caption it:
 *  the backend's sniffed raster type, else SVG when the bytes prove it. */
export function renderableImageMime(
  bytes: { base64: string | null; mime: string | null; tooLarge: boolean },
  path: string,
): string | null {
  if (bytes.tooLarge || bytes.base64 === null) return null;
  if (bytes.mime !== null) return bytes.mime;
  return isSvgDocument(bytes.base64, path) ? "image/svg+xml" : null;
}

/** What a caption calls an image: its alt text, else the file name its URL
 *  ends in, else a generic word. */
export function captionName(alt: string, rawSrc: string): string {
  const named = alt.trim();
  if (named !== "") return named;
  const path = normalizeHref(rawSrc).split(/[?#]/, 1)[0];
  const last = path.split(/[\\/]/).findLast((s) => s !== "");
  if (last === undefined) return "Image";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** The repository directory a document's relative images resolve against;
 *  "" for a file at the root. */
export function repoDocBaseDir(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  return slash === -1 ? "" : filePath.slice(0, slash);
}
