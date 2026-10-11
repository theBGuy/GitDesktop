/**
 * Minimal semver-aware tag ordering, just enough to pick the "previous tag" for
 * generated release notes the way GitHub does.
 *
 * - **Monorepo namespaces:** a tag's package prefix (`dashboard/`, `cli/`, `pkg@`)
 *   is split off and only tags sharing it are compared.
 * - **Prerelease conventions:** the prerelease suffix is detected whether it's
 *   semver-style (`-rc.1`, `-beta`, `-alpha.2`), dot-separated (`.beta`), or
 *   PEP 440-style with no separator (`rc1`, `b2`, `a1`). Identifiers split on
 *   separators *and* alpha/numeric boundaries so `rc.9 < rc.31` and `rc9 < rc31`.
 * - **Final vs prerelease:** picking the previous tag for a *final* release skips
 *   prereleases (changelog since the last stable); for a *prerelease* it includes
 *   them (changelog since the last preview).
 *
 * Build metadata (`+…`) is ignored. Anything unparseable is skipped.
 */

interface ParsedTag {
  release: number[];
  /** Prerelease identifiers; numeric ones are numbers. Empty = a final release. */
  pre: (string | number)[];
}

// Splits a tag into its (possibly empty) package prefix and the version core.
// The version is the trailing `v?MAJOR[.MINOR…]` run plus any prerelease/build
// suffix, so the prefix captures monorepo namespaces (`dashboard/`, `pkg@`).
const TAG_RE = /^(.*?)(v?\d+(?:\.\d+)*[0-9A-Za-z.\-_+]*)$/;
const LEADING_V_RE = /^[vV]/;
const VERSION_CORE_RE = /^(\d+(?:\.\d+)*)(.*)$/;
const LEADING_SEP_RE = /^[-._]/;
const PRE_SEP_RE = /[.\-_]/;
const ALNUM_RUN_RE = /\d+|[A-Za-z]+/g;
const NUM_ONLY_RE = /^\d+$/;

function splitTag(tag: string): { prefix: string; version: string } | null {
  const m = TAG_RE.exec(tag.trim());
  if (!m) return null;
  return { prefix: m[1], version: m[2] };
}

// Breaks a prerelease suffix into comparable identifiers: split on separators
// and on alpha/numeric boundaries, numeric runs become numbers ("rc1" → ["rc",1]).
function splitPreIdentifiers(s: string): (string | number)[] {
  const ids: (string | number)[] = [];
  for (const token of s.split(PRE_SEP_RE)) {
    if (!token) continue;
    for (const part of token.match(ALNUM_RUN_RE) ?? []) {
      ids.push(
        NUM_ONLY_RE.test(part) ? Number.parseInt(part, 10) : part.toLowerCase(),
      );
    }
  }
  return ids;
}

function parseVersion(version: string): ParsedTag | null {
  const noBuild = version.replace(LEADING_V_RE, "").split("+")[0]; // drop build metadata
  const m = VERSION_CORE_RE.exec(noBuild);
  if (!m) return null;
  const release = m[1].split(".").map((n) => Number.parseInt(n, 10));
  if (release.some((n) => Number.isNaN(n))) return null;
  // Everything after the numeric release (minus a leading separator) is the
  // prerelease — covers `-rc.1`, `.beta`, and PEP 440 `rc1`/`b2` alike.
  const pre = splitPreIdentifiers(m[2].replace(LEADING_SEP_RE, ""));
  return { release, pre };
}

/** Semver precedence: <0 if a<b, 0 if equal, >0 if a>b. */
function compareParsed(a: ParsedTag, b: ParsedTag): number {
  const len = Math.max(a.release.length, b.release.length);
  for (let i = 0; i < len; i++) {
    const d = (a.release[i] ?? 0) - (b.release[i] ?? 0);
    if (d !== 0) return d;
  }
  // A release outranks any prerelease of the same core version.
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const plen = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < plen; i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1; // fewer identifiers = lower precedence
    if (y === undefined) return 1;
    const xNum = typeof x === "number";
    const yNum = typeof y === "number";
    if (xNum && yNum) {
      if (x !== y) return (x as number) - (y as number);
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1; // numeric identifiers rank below alphanumeric
    } else if (x !== y) {
      return (x as string) < (y as string) ? -1 : 1;
    }
  }
  return 0;
}

/**
 * The previous tag for generated release notes: the greatest tag in `all` that
 * shares `selected`'s package prefix and is semantically *less than* it. When
 * `selected` is a final release, prereleases are skipped so the baseline is the
 * last stable; when it's a prerelease, prereleases count too. Returns "" when
 * nothing qualifies, letting the caller fall back to GitHub auto-detect.
 */
export function findPreviousTag(selected: string, all: string[]): string {
  const sel = splitTag(selected);
  if (!sel) return "";
  const selParsed = parseVersion(sel.version);
  if (!selParsed) return "";
  const selIsPrerelease = selParsed.pre.length > 0;

  let bestTag = "";
  let bestParsed: ParsedTag | null = null;
  for (const tag of all) {
    if (tag === selected) continue;
    const cand = splitTag(tag);
    // Only consider tags in the same namespace (monorepo-safe).
    if (!cand || cand.prefix !== sel.prefix) continue;
    const parsed = parseVersion(cand.version);
    if (!parsed) continue;
    // A final release's baseline is the previous final release, not an rc.
    if (!selIsPrerelease && parsed.pre.length > 0) continue;
    if (compareParsed(parsed, selParsed) >= 0) continue;
    if (!bestParsed || compareParsed(parsed, bestParsed) > 0) {
      bestTag = tag;
      bestParsed = parsed;
    }
  }
  return bestTag;
}

const WHITESPACE_RE = /\s/;
const FORBIDDEN_TAG_CHARS = "~^:?*[\\";

/**
 * Why `name` can't be a new tag, or null when it can: the practical subset of
 * `git check-ref-format` a typed tag trips, checked on the trimmed name the
 * create sends, reporting the first rule violated. The backend's
 * `validate_tag_name` stays the authority; this only lets the field say so early.
 */
export function validateTagName(name: string): string | null {
  const n = name.trim();
  if (!n) return "Enter a tag name";
  if (WHITESPACE_RE.test(n)) return "Tag names can't contain spaces";
  if (n.startsWith("-")) return `Tag names can't start with "-"`;
  // A trailing "." is a whole-name rule; a leading "." and a trailing ".lock"
  // apply to every "/"-separated part. The one-level rule is skipped: a tag
  // always sits under refs/tags/.
  if (n.endsWith(".")) return `Tag names can't end with "."`;
  if (n.startsWith("/")) return `Tag names can't start with "/"`;
  if (n.endsWith("/")) return `Tag names can't end with "/"`;
  if (n.includes("//")) return `Tag names can't contain "//"`;
  const parts = n.split("/");
  for (const part of parts) {
    const subject =
      parts.length === 1 ? "Tag names" : `The tag name part "${part}"`;
    if (part.startsWith(".")) return `${subject} can't start with "."`;
    if (part.endsWith(".lock")) return `${subject} can't end with ".lock"`;
  }
  if (n.includes("..")) return `Tag names can't contain ".."`;
  // A lone "@" is deliberately VALID: git's anti-"@" rule matches the entire
  // refname, never refs/tags/<name> — mirrors validate_tag_name (ops.rs), probe-verified.
  if (n.includes("@{")) return `Tag names can't contain "@{"`;
  for (const ch of n) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      return "Tag names can't contain control characters";
    }
    if (FORBIDDEN_TAG_CHARS.includes(ch)) {
      return `Tag names can't contain "${ch}"`;
    }
  }
  return null;
}

/** Whether a trimmed tag name is one the release would create: typed, not an
 *  existing tag, and valid. */
export function isNewTagName(trimmed: string, existing: string[]): boolean {
  return (
    !!trimmed &&
    !existing.includes(trimmed) &&
    validateTagName(trimmed) === null
  );
}
