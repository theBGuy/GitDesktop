// Imported by scripts/section-collapse.test.mjs under Node's type stripping, so
// this module imports only the import-free folder-key parser (by its .ts path).
import { parseFolderRowKey } from "./folder-stage-targets.ts";

export type ChangesSection = "staged" | "unstaged";

/** The section a file key (`"<section>:<path>"`) or folder row key
 *  (`"folder:<section>:<dir>"`) belongs to; null for any other key. Only the
 *  leading segment decides, so a colon inside the path never misfiles it. */
export function rowKeySection(key: string): ChangesSection | null {
  const folder = parseFolderRowKey(key);
  if (folder) return folder.section;
  if (key.startsWith("staged:")) return "staged";
  if (key.startsWith("unstaged:")) return "unstaged";
  return null;
}

/** Drops selection keys (`"staged:<path>"` / `"unstaged:<path>"`) belonging to
 *  a collapsed section. Returns `keys` itself when nothing was dropped. */
export function pruneCollapsedSectionKeys(
  keys: Set<string>,
  collapsed: ReadonlySet<ChangesSection>,
): Set<string> {
  if (collapsed.size === 0) return keys;
  const next = new Set(
    [...keys].filter((k) => {
      const section = rowKeySection(k);
      return section === null || !collapsed.has(section);
    }),
  );
  return next.size === keys.size ? keys : next;
}

/** Where an advance's focus lands: the target row when it is on screen; the
 *  intended section's toggle when that section is collapsed (the target key's
 *  own section, or `fallbackSection` for a target naming none); the silent
 *  landing otherwise. */
export type AdvanceLanding =
  | { kind: "row"; key: string }
  | { kind: "toggle"; section: ChangesSection }
  | { kind: "landing" };

export function advanceLanding(
  target: string | null,
  /** Every nav row key on screen now: file and folder rows alike. */
  navRowKeys: readonly string[],
  collapsed: ReadonlySet<ChangesSection>,
  fallbackSection: ChangesSection | null,
): AdvanceLanding {
  if (target !== null && navRowKeys.includes(target))
    return { kind: "row", key: target };
  const section =
    (target === null ? null : rowKeySection(target)) ?? fallbackSection;
  if (section !== null && collapsed.has(section))
    return { kind: "toggle", section };
  return { kind: "landing" };
}
