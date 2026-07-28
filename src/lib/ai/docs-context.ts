import { gitListTracked } from "@/lib/git/api";

/** What `buildReviewPrompt` needs about the repo's documentation surfaces. */
export interface DocSurfacesContext {
  /** Repo-relative paths of the documentation surfaces this repo actually has —
   *  files as paths, conventional doc directories with a trailing `/`. Paths
   *  ONLY, never contents. Absent when the repo has none or the lookup failed,
   *  which omits the prompt block entirely. */
  docSurfaces?: string[];
}

/** Conventional documentation DIRECTORIES, matched by path prefix — present as
 *  soon as the repo tracks anything under them. Covers the changelog-fragment
 *  tools' DEFAULT directories (scriv, towncrier, changesets, covector) plus plain
 *  docs trees. A config file inside one still marks the surface present, which is
 *  right: the reviewer's question is whether THIS change carries its fragment. A
 *  project that moved its fragments says so via `.gitdesktop/instructions.md`. */
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

/** Longest surface path we will render. A backstop only — {@link ROOT_DOC_FILE}
 *  is anchored to a fixed extension set, so nothing legitimate comes close (see
 *  {@link sanitizeSurface}). */
const MAX_SURFACE_LEN = 120;

/** A ROOT-level documentation file. Deliberately GENERIC in NAME — this runs
 *  against whatever repository the user is reviewing, so a project's own surfaces
 *  (a marketing site, an in-app guide) reach the review through its
 *  `.gitdesktop/instructions.md`, not a hardcoded path here.
 *
 *  Constrained in EXTENSION, and that part matters: a bare `changelog.` prefix
 *  test also matched `changelog.config.js` / `.json` / `.yml` — commitizen
 *  CONFIG, not a doc surface, and listing one invites a finding about a "stale
 *  changelog" that is really a tool config. The optional middle segment keeps
 *  TRANSLATED surfaces (`README.zh-CN.md`) without re-admitting those configs,
 *  since the FINAL extension decides either way. */
const ROOT_DOC_FILE =
  /^(readme|changelog)(\.[a-z0-9_-]{1,12})?\.(md|markdown|mdown|rst|txt|adoc)$/i;

/** Strips what could let a FILENAME misrepresent itself in the rendered roster —
 *  control characters (a newline would forge a second bullet) and Unicode format
 *  characters (a bidi override reorders what the line appears to say) — then
 *  bounds the length.
 *
 *  Defense in depth, not a live hole: these filenames are not always the
 *  maintainer's (checking out a fork PR's branch is a supported flow) and POSIX
 *  filenames may contain newlines — but {@link ROOT_DOC_FILE} is anchored with no
 *  `m` flag, so a name carrying a control character cannot match it in the first
 *  place. Enforcing at RENDER keeps the guarantee true if that pattern is ever
 *  loosened; the directory entries are module constants and need none of it. */
function sanitizeSurface(path: string): string {
  return path.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, MAX_SURFACE_LEN);
}

/**
 * Derives the repository's documentation surfaces from what git actually
 * tracks, so a review can name a stale doc surface the diff never touched — the
 * class-sweep rule can only name files "visible in the diff" and therefore
 * structurally cannot.
 *
 * Reads the LOCAL working tree (`git ls-files` against `repoPath`), which on a
 * checked-out PR branch is THAT branch's tree; only a fixed set of sanitized
 * path shapes reaches the prompt, never contents (see {@link sanitizeSurface}).
 * One subprocess per review, best-effort like every other context resolver: any
 * failure yields `{}` and the prompt is unchanged.
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

  // Files first (sorted, so the roster is stable across runs), then directories in
  // candidate order. Directory slots are RESERVED rather than competing for the
  // tail: eight translated READMEs would otherwise push `changelog.d/` and `docs/`
  // off the end — the entries a reviewer is most likely to find stale.
  const presentDirs = DOC_DIR_CANDIDATES.filter((dir) => dirs.has(dir));
  const fileSlots = Math.max(0, MAX_SURFACES - presentDirs.length);
  const docSurfaces = [
    ...[...files].sort().slice(0, fileSlots),
    ...presentDirs,
  ];
  return docSurfaces.length > 0 ? { docSurfaces } : {};
}
