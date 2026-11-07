import { splitPath } from "@/lib/git/worktree-default-path";

export {
  isAbsolutePath,
  splitPath,
} from "@/lib/git/worktree-default-path";

/** `<parent>/<leaf>` for a folder a Browse picked: a directory picker only
 *  returns folders that already exist, which git refuses as a worktree target,
 *  so the pick is the new folder's PARENT. With no leaf yet the result is "":
 *  the bare pick is a folder that exists, never a valid target. The picker's
 *  backslashes become forward slashes, git's own spelling (and
 *  `deriveDefaultWorktreePath`'s), so a composed path never mixes the two. */
export function underPickedParent(parent: string, leaf: string): string {
  const base = parent.replace(/\\/g, "/").replace(/\/+$/, "");
  return leaf ? `${base}/${leaf}` : "";
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
