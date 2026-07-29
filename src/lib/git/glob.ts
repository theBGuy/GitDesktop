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
 */
export function globLiteralPath(path: string): string {
  return path.replace(/[[*?]/g, (c) => `[${c}]`);
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
 */
export function literalPathspec(path: string): string {
  return `:(literal)${path}`;
}
