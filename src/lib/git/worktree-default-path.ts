import { normPath } from "@/lib/git/path";
import type { UserWorktree } from "@/lib/git/worktree";
import { isMac, isWindows } from "@/lib/hotkeys/binding";

/** In-repo folder new worktrees default to; the backend's info/exclude line names the same path. */
export const GITDESKTOP_WORKTREES_DIR = ".gitdesktop/worktrees";

/** Splits a path into its parent and last segment, tolerating a trailing
 *  separator. Parent is "" when there's no separator. `\` separates only when
 *  `backslashSeparates` (Windows); elsewhere it is an ordinary character. */
export function splitPath(
  p: string,
  backslashSeparates = true,
): { parent: string; name: string } {
  const base = p.replace(backslashSeparates ? /[/\\]+$/ : /\/+$/, "");
  const i = backslashSeparates
    ? Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"))
    : base.lastIndexOf("/");
  return i >= 0
    ? { parent: base.slice(0, i), name: base.slice(i + 1) }
    : { parent: "", name: base };
}

/** A folder's comparison key: separator-, case- and trailing-separator-blind,
 *  since a typed path may differ from git's spelling. */
export function folderKey(p: string): string {
  return normPath(p).replace(/\/+$/, "");
}

/** A worktree folder name from a branch or PR leaf: slashes flattened to dashes, "" when blank. */
export function worktreeLeaf(leaf: string): string {
  return leaf.trim().replace(/[\\/]+/g, "-");
}

/** git's porcelain gives a bare main no HEAD, branch or detached line. */
export function isBareMainRow(w: UserWorktree): boolean {
  return w.isMain && !w.head && !w.branch && !w.isDetached;
}

/** The host's path rules for the default derivation. `windows`: `\` separates
 *  (elsewhere a git-reported `\` is content). `caseInsensitive`: the default
 *  filesystem folds case (Windows, macOS). */
export interface PathPlatform {
  windows?: boolean;
  caseInsensitive?: boolean;
}

/** `<parent>/<name>-<safe>` beside `base`, for a main that can't host the
 *  in-repo folder. */
function siblingPath(base: string, safe: string, windows: boolean): string {
  if (!base) return "";
  const { parent, name } = splitPath(base, windows);
  return parent ? `${parent}/${name}-${safe}` : `${name}-${safe}`;
}

/** A checkout path with the host's separators unified and trailing ones trimmed. */
function checkoutPath(p: string, windows: boolean): string {
  return (windows ? p.replace(/\\/g, "/") : p).replace(/\/+$/, "");
}

/** Whether two checkout paths name the same folder, by the host's rules: case
 *  folds only where the default filesystem is case-insensitive, so elsewhere
 *  "Repo" and "repo" are two checkouts (one would nest in, or be mistaken for,
 *  the other). `folderKey` folds everywhere; keep it for holds, where a fold
 *  can only over-hold. */
export function sameCheckout(
  a: string,
  b: string,
  {
    windows = isWindows,
    caseInsensitive = windows || isMac,
  }: PathPlatform = {},
): boolean {
  const key = (p: string) => {
    const k = checkoutPath(p, windows);
    return caseInsensitive ? k.toLowerCase() : k;
  };
  return key(a) === key(b);
}

/** The registered worktree at `path`, by `sameCheckout`. */
export function rowAtPath(
  rows: UserWorktree[] | undefined,
  path: string,
  platform: PathPlatform = {},
): UserWorktree | undefined {
  return rows?.find((w) => sameCheckout(w.path, path, platform));
}

/** The default folder for a new worktree, or null until `rows` answer which checkout is
 *  main: in-repo (relative from the main worktree, absolute under it from a linked one,
 *  so it never nests in a linked worktree); a sibling folder when main is bare or absent.
 *  `worktreeLeaf` still flattens `\`: git refuses it in ref names, so no branch has one.
 *  The relative form needs the open path to equal main's exactly (separators and a
 *  trailing one aside): a case-sensitive volume can sit on any platform and the
 *  frontend can't ask, so a case-only match takes the absolute form, which is the
 *  same folder spelled longer where case folds. */
export function deriveDefaultWorktreePath(
  repoPath: string,
  rows: UserWorktree[] | undefined,
  leaf: string,
  { windows = isWindows }: PathPlatform = {},
): string | null {
  if (rows === undefined) return null;
  const safe = worktreeLeaf(leaf);
  if (!safe) return "";
  const main = rows.find((w) => w.isMain);
  if (!main || isBareMainRow(main))
    return siblingPath(main?.path ?? repoPath, safe, windows);
  const rel = `${GITDESKTOP_WORKTREES_DIR}/${safe}`;
  return sameCheckout(repoPath, main.path, { windows, caseInsensitive: false })
    ? rel
    : `${checkoutPath(main.path, windows)}/${rel}`;
}

/** Whether `p` names one folder wherever it is resolved. On Windows only a
 *  drive path ("C:\x", "C:/x") or a UNC path ("\\server\share") does: "\x" and
 *  "/x" are relative to the current drive, "C:x" to that drive's directory.
 *  Elsewhere a leading "/" does. */
export function isAbsolutePath(p: string, windows = isWindows): boolean {
  return windows ? /^(?:[A-Za-z]:|[\\/])[\\/]/.test(p) : p.startsWith("/");
}

/** Where a typed folder lands, resolved lexically as gh and git do: a relative one
 *  against the repository, a root-relative one ("/x") against its drive or share. A
 *  drive-relative one ("C:x") depends on that drive's working directory, so it stays
 *  unresolved and matches no row. Holds, the Full path row and the toast's Open read it.
 *  Off Windows a backslash is an ordinary filename character, never a separator. */
export function resolveTarget(
  repoPath: string,
  target: string,
  windows = isWindows,
): string {
  if (isAbsolutePath(target, windows)) return target;
  const seps = (p: string) => (windows ? p.replace(/\\/g, "/") : p);
  const typed = seps(target);
  if (windows && /^[A-Za-z]:/.test(typed)) return target;
  let joined: string;
  if (windows && typed.startsWith("/")) {
    const drive = /^(?:\/\/[^/]+\/[^/]+|[A-Za-z]:)/.exec(seps(repoPath))?.[0];
    if (drive === undefined) return target;
    joined = drive + typed;
  } else joined = seps(`${repoPath}/${typed}`);
  // A drive, a UNC share or a leading "/" is never popped by "..".
  const rootRe = windows ? /^(?:\/\/[^/]+\/[^/]+|[A-Za-z]:)?\/?/ : /^\/?/;
  const root = rootRe.exec(joined)?.[0] ?? "";
  const out: string[] = [];
  for (const s of joined.slice(root.length).split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return root + out.join("/");
}
