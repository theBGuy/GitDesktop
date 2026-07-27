import { gitListTracked } from "@/lib/git/api";

/** What `buildReviewPrompt` needs about the repo's documentation surfaces. */
export interface DocSurfacesContext {
  /** Repo-relative paths of the documentation surfaces this repository actually
   *  has — files as paths, conventional doc directories with a trailing `/`.
   *  Paths ONLY, never contents. Absent when the repo has none (or the lookup
   *  failed), which keeps the prompt byte-for-byte identical to before. */
  docSurfaces?: string[];
}

/** Conventional documentation DIRECTORIES, matched by path prefix — present as
 *  soon as the repo tracks anything under them. Covers the common changelog-
 *  fragment conventions, each under the tool's own default directory: scriv's
 *  `changelog.d/`, towncrier's `newsfragments/`, changesets' `.changeset/`, and
 *  covector's `.changes/` — alongside plain docs trees. A config file inside one
 *  still marks the surface present, which is right: the reviewer's question is
 *  whether THIS change carries its fragment. (Each tool's directory is
 *  configurable; these are the defaults, and a project that has moved its
 *  fragments elsewhere says so through its `.gitdesktop/instructions.md`.) */
const DOC_DIR_CANDIDATES = [
  "changelog.d/",
  "newsfragments/",
  ".changeset/",
  ".changes/",
  "docs/",
  "doc/",
];

/** Defensive ceiling on the rendered roster: a repo with a dozen translated
 *  READMEs shouldn't push a dozen lines into the system prompt. */
const MAX_SURFACES = 8;

/** Longest surface path we will render. With {@link ROOT_DOC_FILE} anchored to a
 *  fixed extension set nothing legitimate comes close (the longest match is
 *  `changelog.markdown`), so this is purely a backstop — see
 *  {@link sanitizeSurface}. */
const MAX_SURFACE_LEN = 120;

/** A ROOT-level documentation file. Deliberately GENERIC in NAME — this runs
 *  against whatever repository the user is reviewing, not against GitDesktop, so
 *  a project's own surfaces (a marketing site, an in-app guide) reach the review
 *  through its `.gitdesktop/instructions.md` rather than a hardcoded path here.
 *
 *  Constrained in EXTENSION, though, and that part matters: a bare
 *  `readme.`/`changelog.` prefix test also matched `changelog.config.js`,
 *  `changelog.json`, `changelog.yml`, and `changelog.config.cjs` —
 *  commitizen/conventional-changelog CONFIG, not a documentation surface, and
 *  listing one invites a finding about a "stale changelog" that is really a tool
 *  config. The extension set is the plain-text documentation formats a README or
 *  CHANGELOG is actually written in; a repo using something else is covered by its
 *  instructions file.
 *
 *  The optional middle segment keeps TRANSLATED surfaces (`README.de.md`,
 *  `README.zh-CN.md`, `readme.pt_BR.md`), which the prefix test used to catch and
 *  which the reserved directory slots below are sized against — narrowing to a
 *  bare `readme.<ext>` would have dropped them silently. It cannot re-admit the
 *  config files, because the decision is made by the FINAL extension either way.
 *  Anchored at both ends and case-insensitive, so `Readme.MD` matches while
 *  `README.md.bak` does not. */
const ROOT_DOC_FILE =
  /^(readme|changelog)(\.[a-z0-9_-]{1,12})?\.(md|markdown|mdown|rst|txt|adoc)$/i;

/** Strips anything that could let a FILENAME misrepresent itself once rendered
 *  into the system prompt's roster — control characters (a newline would forge a
 *  second bullet) and Unicode format characters (a bidi override can reorder what
 *  the line appears to say) — then bounds the length.
 *
 *  Defense in depth, not a live hole: `git ls-files` reads whatever tree is
 *  CHECKED OUT, and checking out a fork PR's branch is a supported flow, so the
 *  filenames here are not always the maintainer's own. But POSIX filenames may
 *  contain newlines, and {@link ROOT_DOC_FILE} is anchored (`$` matches only the
 *  true end of input in JS, with no `m` flag), so a name carrying a newline or
 *  any other control character cannot match it in the first place. This keeps the
 *  guarantee at the point of RENDERING, where it stays true if the pattern is
 *  ever loosened. The directory entries need none of this — they are module
 *  constants, never repo input. */
function sanitizeSurface(path: string): string {
  return path.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, MAX_SURFACE_LEN);
}

/**
 * Derives the repository's documentation surfaces from what git actually
 * tracks, so a review can name a stale doc surface the diff never touched —
 * the mechanism behind the one-surface-per-round docs dribble, where the
 * class-sweep rule can only name files "visible in the diff" and therefore
 * structurally cannot mention a surface the author forgot entirely.
 *
 * Reads the LOCAL working tree (`git ls-files` against `repoPath`) — nothing is
 * fetched from a PR head. That is not the same as "always the maintainer's own
 * files": checking out a PR's branch is a supported flow, and a review run while
 * it is checked out sees that branch's tree. What reaches the prompt is bounded
 * accordingly — a fixed set of path shapes, sanitized, names only, no contents
 * (see {@link sanitizeSurface}). One subprocess per review, best-effort like
 * every other context resolver: any failure yields `{}` and the prompt is
 * unchanged.
 */
export async function resolveDocSurfacesContext(
  repoPath: string,
): Promise<DocSurfacesContext> {
  let tracked: string[];
  try {
    tracked = await gitListTracked(repoPath);
  } catch {
    return {};
  }

  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const entry of tracked) {
    const path = entry.trim();
    if (!path) continue;
    if (ROOT_DOC_FILE.test(path)) {
      // Sanitized on the way IN, so the set dedupes on what will actually be
      // rendered; an entry sanitized down to nothing is no longer a path.
      const safe = sanitizeSurface(path);
      if (safe) files.add(safe);
      continue;
    }
    for (const dir of DOC_DIR_CANDIDATES) {
      if (path.startsWith(dir)) dirs.add(dir);
    }
  }

  // Files first (sorted, so the roster is stable across runs), then the
  // directories in candidate order. The directories get their slots RESERVED
  // rather than competing for the tail: a repo with eight translated READMEs
  // would otherwise push `changelog.d/` and `docs/` off the end, and those are
  // the entries a reviewer is most likely to find stale.
  const presentDirs = DOC_DIR_CANDIDATES.filter((dir) => dirs.has(dir));
  const fileSlots = Math.max(0, MAX_SURFACES - presentDirs.length);
  const docSurfaces = [
    ...[...files].sort().slice(0, fileSlots),
    ...presentDirs,
  ];
  return docSurfaces.length > 0 ? { docSurfaces } : {};
}
