import { isWindows } from "@/lib/hotkeys/binding";

/** Splits a path into its parent and last segment, tolerating both separators
 *  and a trailing slash. Parent is "" when there's no separator. */
export function splitPath(p: string): { parent: string; name: string } {
  const base = p.replace(/[/\\]+$/, "");
  const i = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"));
  return i >= 0
    ? { parent: base.slice(0, i), name: base.slice(i + 1) }
    : { parent: "", name: base };
}

/** A sibling folder of the main worktree named for the branch:
 *  `<parent>/<repo>-<branch>` (branch slashes flattened to dashes). */
export function deriveSiblingPath(mainPath: string, branch: string): string {
  if (!mainPath) return "";
  const { parent, name } = splitPath(mainPath);
  const safe = branch.trim().replace(/[\\/]+/g, "-");
  if (!safe) return "";
  return parent ? `${parent}/${name}-${safe}` : `${name}-${safe}`;
}

/** `<parent>/<leaf>` for a folder a Browse picked: a directory picker only
 *  returns folders that already exist, which git refuses as a worktree target,
 *  so the pick is the new folder's PARENT. With no leaf yet the result is "":
 *  the bare pick is a folder that exists, never a valid target. The picker's
 *  backslashes become forward slashes, git's own spelling (and
 *  {@link deriveSiblingPath}'s), so a composed path never mixes the two. */
export function underPickedParent(parent: string, leaf: string): string {
  const base = parent.replace(/\\/g, "/").replace(/\/+$/, "");
  return leaf ? `${base}/${leaf}` : "";
}

/** Whether `p` names one folder wherever it is resolved. On Windows only a
 *  drive path ("C:\x", "C:/x") or a UNC path ("\\server\share") does: "\x" and
 *  "/x" are relative to the current drive, "C:x" to that drive's directory.
 *  Elsewhere a leading "/" does. */
export function isAbsolutePath(p: string, windows = isWindows): boolean {
  return windows ? /^(?:[A-Za-z]:|[\\/])[\\/]/.test(p) : p.startsWith("/");
}

/** A path's last segment as a folder name: a drive root ("C:\", "C:/") has
 *  none, since its only segment is the drive designator. */
function leafOf(p: string): string {
  const { name } = splitPath(p);
  return /^[A-Za-z]:$/.test(name) ? "" : name;
}

/** A Browse pick over the folder field's current value: the picked parent with
 *  the field's own last segment, or the derived one when the field has none. */
export function composePickedPath(
  parent: string,
  current: string,
  derived: string,
): string {
  return underPickedParent(parent, leafOf(current) || leafOf(derived));
}
