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
 *  fragment conventions (towncrier-style `changelog.d/`, changesets'
 *  `.changeset/`, covector's `.changes/`) alongside plain docs trees; a config
 *  file inside one still marks the surface present, which is right — the
 *  reviewer's question is whether THIS change carries its fragment. */
const DOC_DIR_CANDIDATES = [
  "changelog.d/",
  ".changeset/",
  ".changes/",
  "docs/",
  "doc/",
];

/** Defensive ceiling on the rendered roster: a repo with a dozen translated
 *  READMEs shouldn't push a dozen lines into the system prompt. */
const MAX_SURFACES = 8;

/** Whether a tracked path is a ROOT-level documentation file. Deliberately
 *  GENERIC — `README.*` and `CHANGELOG.*` in any extension — because this
 *  runs against whatever repository the user is reviewing, not against
 *  GitDesktop. A project's own surfaces (a marketing site, an in-app guide) are
 *  its own business and reach the review through its
 *  `.gitdesktop/instructions.md`, never through a hardcoded path here.
 *  Case-insensitive: `readme.md` and `Readme.md` are the same surface. */
function isRootDocFile(path: string): boolean {
  if (path.includes("/")) return false;
  const lower = path.toLowerCase();
  return lower.startsWith("readme.") || lower.startsWith("changelog.");
}

/**
 * Derives the repository's documentation surfaces from what git actually
 * tracks, so a review can name a stale doc surface the diff never touched —
 * the mechanism behind the one-surface-per-round docs dribble, where the
 * class-sweep rule can only name files "visible in the diff" and therefore
 * structurally cannot mention a surface the author forgot entirely.
 *
 * Reads the MAINTAINER's checkout (`git ls-files` against `repoPath`), never
 * the PR head, so a fork PR can't add a path to the reviewer's prompt. One
 * subprocess per review, best-effort like every other context resolver: any
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
    if (isRootDocFile(path)) {
      files.add(path);
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
