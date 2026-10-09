// Pure path helpers for a file task's stored script path. Runtime-import-free:
// scripts/script-path.test.mjs imports this file directly under Node's type
// stripping, which resolves no bundler aliases.

/** Where a task draft is offered, as the scope-flip repair sees it. */
export type ScopeKind = "this-repo" | "global" | "elsewhere" | "unknown";

/** What switching a draft's scope does to its script path. `repaired.from` is
 *  the untrimmed field text, so undoing restores exactly what was typed. */
export type FlipOutcome =
  | { kind: "none" }
  | { kind: "repaired"; path: string; from: string }
  | { kind: "unrepairable" };

/** Which missing-file sentence the run dialog shows. */
export type MissingScriptCase =
  | "absolute"
  | "repo-relative"
  | "global-relative";

// Rust's `Path::is_absolute` is per-OS (`/x` isn't absolute on Windows, `C:/x`
// is relative on Linux); this approximation only decides whether to rewrite and
// which copy to show, so an exotic input fails safe as "absolute": no rewrite.
const ABSOLUTE_RE = /^(?:[\\/]|[A-Za-z]:[\\/])/;
// `C:x` is relative to drive C's current directory, so no root can be prefixed.
const DRIVE_RELATIVE_RE = /^[A-Za-z]:(?![\\/])/;

/** A rooted POSIX path, a drive-absolute Windows path, or a UNC share. */
export function isAbsoluteScriptPath(p: string): boolean {
  return ABSOLUTE_RE.test(p);
}

/** Join a relative script path under a checkout root with forward slashes.
 *  Lexical only: `..` segments are kept, never resolved. */
export function absolutizeScriptPath(repoRoot: string, rel: string): string {
  const root = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const tail = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  return `${root}/${tail}`;
}

/** The path consequence of moving a file task's draft from `from` to `to`.
 *  Only a move to every repository acts: a relative path whose root is the open
 *  checkout becomes its full path, and one with no knowable root is flagged
 *  rather than guessed at. */
export function pathOnScopeFlip({
  from,
  to,
  path,
  repoRoot,
}: {
  from: ScopeKind;
  to: ScopeKind;
  path: string;
  repoRoot: string | null;
}): FlipOutcome {
  if (to !== "global" || from === "global") return { kind: "none" };
  const trimmed = path.trim();
  if (trimmed === "" || isAbsoluteScriptPath(trimmed)) return { kind: "none" };
  if (
    from === "this-repo" &&
    repoRoot !== null &&
    !DRIVE_RELATIVE_RE.test(trimmed)
  )
    return {
      kind: "repaired",
      path: absolutizeScriptPath(repoRoot, trimmed),
      from: path,
    };
  return { kind: "unrepairable" };
}

/** Why a stored script path names no file: an absolute path is simply absent,
 *  while a relative one depends on where it was resolved. */
export function missingScriptCase(
  isGlobal: boolean,
  storedPath: string,
): MissingScriptCase {
  if (isAbsoluteScriptPath(storedPath.trim())) return "absolute";
  return isGlobal ? "global-relative" : "repo-relative";
}
