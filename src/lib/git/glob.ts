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
 * as a one-character class (`[` → `[[]`) makes it literal to git's matcher
 * (measured, git 2.51.1). `]` outside a class is already literal.
 *
 * A `\` is DOUBLED, because raw it is a gitignore escape that eats the next
 * character: `weird\name.env` names `weirdname.env` — a different file hidden
 * while the one the user picked stays visible (the `src\foo.ts` row of Rust's
 * PARITY table pins exactly that, and nothing more).
 *
 * Doubling fixes the PARSE everywhere — `\\` is a literal backslash to git on
 * every platform — but not the MATCH, which diverges on the name side: Windows
 * normalizes a name's `\` to a separator before comparing, so no backslash
 * spelling reaches such a file there. That is why a second, `/`-separated line
 * is required and NOT redundant; see [`aiExcludePatternLinesForPath`].
 *
 * A trailing space is the other case backslash is the answer: .gitignore strips
 * unescaped trailing whitespace, so a file named `notes ` yields the pattern
 * `notes`, which hides a DIFFERENT file and leaves the named one visible
 * (measured). The escape is written in the idiomatic .gitignore spelling users
 * read in their own files, and `check-ignore` — the one engine every AI-ignore
 * verdict comes from — reads it natively on every platform.
 *
 * Order is load-bearing: doubling runs FIRST, so the escape the trailing-space
 * arm adds is not doubled in turn, and a name already ending in `\` yields an
 * ODD run (`notes\` + space → `notes\\\ `) that both `trimIgnorePattern` and
 * Rust's `trim_ignore_pattern` read as a kept space.
 */
export function globLiteralPath(path: string): string {
  return path
    .replace(/\\/g, "\\\\")
    .replace(/[[*?]/g, (c) => `[${c}]`)
    .replace(/ +$/, (spaces) => spaces.replaceAll(" ", "\\ "));
}

/**
 * The AI-ignore line(s) that hide one concrete path, anchored to the repo root.
 *
 * Usually one line. A path containing `\` gets a second, `/`-separated twin,
 * because the two platforms disagree about what that byte IS during matching:
 * Windows normalizes the NAME's `\` to a separator, so there only
 * `weird/name.env` reaches it and no backslash spelling can. Unix keeps it an
 * ordinary byte, where the escaped form matches exactly and the `/` twin is a
 * real path pattern that would also hide a genuine `weird/name.env` subtree.
 * So the pair can over-hide on either platform — the safe direction on a
 * privacy boundary — and never misses the named file. AI-ignore files are
 * committed and shared, so one line set has to serve both.
 */
export function aiExcludePatternLinesForPath(path: string): string[] {
  const lines = [`/${globLiteralPath(path)}`];
  if (path.includes("\\")) {
    lines.push(`/${globLiteralPath(path.replaceAll("\\", "/"))}`);
  }
  return lines;
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
 * It is deliberate and unreachable from the menus, whose patterns all begin
 * with `/` or `*`; it exists to forgive a hand-typed settings line.
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
