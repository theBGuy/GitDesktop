// Feeding concrete paths to git's matchers. The split these two draw is the
// point: a path the user PICKED must match only itself, so it goes through one
// of these; a glob the user or a menu wrote as a pattern (`*.log`, `*.tsx`) is
// meant to match broadly and goes to git raw. Only the call site knows which it
// holds, so neither is applied centrally in the Rust commands.

/**
 * A concrete path turned into a glob pattern that matches exactly that path —
 * for .gitignore lines and AI-ignore entries.
 *
 * `[`, `*` and `?` are metacharacters, so a raw path holding one matches the
 * wrong files: `app/[slug]/page.tsx` reads as a character class. Wrapping each
 * as a one-character class (`[` → `[[]`) is the only form BOTH engines honor —
 * pathspec ignores the backslash escapes .gitignore accepts (measured, git
 * 2.51.1). `]` outside a class is already literal; a literal backslash is
 * inexpressible on either engine and is left alone (impossible on Windows).
 *
 * A trailing space is the one case backslash IS the answer: .gitignore strips
 * unescaped trailing whitespace, so a file named `notes ` yields the pattern
 * `notes`, which hides a DIFFERENT file and leaves the named one visible
 * (measured).
 *
 * NOTE that fixes the gitignore engine ONLY, and the two AI-ignore engines
 * diverge on WINDOWS for this shape: a backslash in a pathspec is a SEPARATOR,
 * not an escape, so an emitted `notes\ ` term normalizes to `notes/ ` and
 * matches nothing (measured, git 2.51.1.windows.1: `:(glob)a\b.ts` matches
 * `a/b.ts`, while `:(glob)a/b\.ts` matches nothing). Unix honors the escape,
 * which is why the cross-engine test passes on CI. Pre-existing, not introduced
 * here — the pathspec side never matched this shape either way.
 *
 * That escape is defeated when the name ALREADY ends in a backslash (`notes\ `):
 * the emitted `notes\\ ` is an even backslash run, so the space reads as
 * unescaped and is stripped again. Bounded by the same limitation as above — a
 * literal backslash is inexpressible here — and impossible on Windows.
 */
export function globLiteralPath(path: string): string {
  return path
    .replace(/[[*?]/g, (c) => `[${c}]`)
    .replace(/ +$/, (spaces) => spaces.replaceAll(" ", "\\ "));
}

/**
 * Trims an ignore pattern the way git reads one — the mirror of Rust's
 * `trim_ignore_pattern`, which the matcher itself applies.
 *
 * A trailing SPACE is insignificant to git unless backslash-escaped, and a
 * blanket `trim()` here would strip the escape [`globLiteralPath`] just added
 * before the pattern ever reaches the matcher. Only the space: git's
 * `trim_trailing_spaces` special-cases it alone, so a trailing TAB belongs to the
 * pattern (measured). A line ending is not part of the pattern either way —
 * callers split a stored list on `\n`, which leaves the CR of a CRLF-stored one
 * behind.
 *
 * The LEADING trim is ours, not git's: git keeps leading whitespace (measured).
 * It is deliberate and unreachable from the menus, which emit only `/`-anchored
 * patterns; it exists to forgive a hand-typed settings line.
 */
export function trimIgnorePattern(pattern: string): string {
  const rest = pattern.trimStart().replace(/[\r\n]+$/, "");
  let end = rest.length;
  while (end > 0 && rest[end - 1] === " ") {
    let slashes = 0;
    while (rest[end - 2 - slashes] === "\\") slashes++;
    if (slashes % 2 === 1) break;
    end--;
  }
  return rest.slice(0, end);
}

/**
 * A concrete path as a pathspec that matches only itself — for the commands
 * that take pathspecs (`git rm --cached`, and anything else given a path the
 * user picked from a list).
 *
 * Pathspecs glob too, and git tries a literal match FIRST, so a raw path is not
 * safe merely because it names a real file: `git rm --cached -r --
 * src/app/[slug]/page.tsx` drops that file AND `src/app/s/page.tsx` from the
 * index (measured, git 2.51.1). `:(literal)` magic turns globbing off for the
 * term. [`globLiteralPath`] is NOT an alternative here — its escaped folder
 * form (`src/app/[[]slug]`) matches nothing at all, since git's directory
 * recursion only runs on the literal branch.
 *
 * An empty path stays empty: a bare `:(literal)` matches EVERYTHING, and the
 * Rust commands' `!isEmpty()` guards would wave it through.
 */
export function literalPathspec(path: string): string {
  return path ? `:(literal)${path}` : path;
}
