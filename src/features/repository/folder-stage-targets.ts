// Imported by scripts/folder-stage-targets.test.mjs under Node's type stripping,
// so this module keeps to type-only imports.

export interface FolderRowKeyParts {
  section: "staged" | "unstaged";
  /** Repo-relative directory path, "/"-separated, no trailing slash. */
  path: string;
}

function parseSectionPath(key: string): FolderRowKeyParts | null {
  const colon = key.indexOf(":");
  if (colon === -1) return null;
  const section = key.slice(0, colon);
  if (section !== "staged" && section !== "unstaged") return null;
  const path = key.slice(colon + 1);
  return path ? { section, path } : null;
}

/** Parses only folder keys, preserving every path character verbatim. */
export function parseFolderRowKey(key: string): FolderRowKeyParts | null {
  return key.startsWith("folder:") ? parseSectionPath(key.slice(7)) : null;
}

/** Strict descendants in input order, including files hidden by tree collapse.
 *  Only "/" separates segments; ":" and "\\" remain filename characters. */
export function entriesUnderFolder<T>(
  items: readonly T[],
  getPath: (item: T) => string,
  dir: string,
): T[] {
  const prefix = `${dir}/`;
  return items.filter((item) => getPath(item).startsWith(prefix));
}

/** Previous-order survivor after the block, then nearest before it, then an
 *  other-section folder twin (possibly compacted deeper), then a file under it.
 *  Call only on emptying: surviving own-section descendants belong to the
 *  caller's re-key backstop and are never eligible block survivors here. */
export function rowAfterFolderLeaves(
  prevRowKeys: readonly string[],
  folderKey: string,
  nowRowKeys: readonly string[],
): string | null {
  const folder = parseFolderRowKey(folderKey);
  const index = prevRowKeys.indexOf(folderKey);
  if (!folder || index === -1) return null;

  const prefix = `${folder.path}/`;
  const atOrUnder = (path: string) =>
    path === folder.path || path.startsWith(prefix);
  const inBlock = (key: string) => {
    if (key === folderKey) return true;
    const row = parseFolderRowKey(key) ?? parseSectionPath(key);
    return row?.section === folder.section && atOrUnder(row.path);
  };
  const now = new Set(nowRowKeys);
  for (let i = index + 1; i < prevRowKeys.length; i++) {
    const key = prevRowKeys[i];
    if (now.has(key) && !inBlock(key)) return key;
  }
  for (let i = index - 1; i >= 0; i--) {
    const key = prevRowKeys[i];
    if (now.has(key) && !inBlock(key)) return key;
  }

  const otherSection = folder.section === "staged" ? "unstaged" : "staged";
  for (const key of nowRowKeys) {
    const row = parseFolderRowKey(key);
    if (row?.section === otherSection && atOrUnder(row.path)) return key;
  }
  for (const key of nowRowKeys) {
    const row = parseSectionPath(key);
    if (row?.section === otherSection && row.path.startsWith(prefix))
      return key;
  }
  return null;
}
