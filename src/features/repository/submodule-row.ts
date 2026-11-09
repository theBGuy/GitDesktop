// What a submodule row in Changes says and allows. Its suite loads it through
// the src hooks with no node_modules, so it imports nothing beyond the
// reserved-name module and types.

import { reservedDeviceName } from "../../lib/git/reserved-device-name";
import type { FileEntry } from "../../lib/git/types";

/** Why a submodule row whose commit hasn't moved can't stage: `git add` on it
 *  succeeds and records nothing. */
export const SUBMODULE_NOTHING_TO_STAGE =
  "Nothing to stage: commit inside the submodule first";

/** The row's "what changed", where line counts sit on other rows. The status
 *  token carries no direction, so a moved pointer is "commit changed"; only the
 *  pane names the direction. */
export function submoduleWords(entry: FileEntry, staged: boolean): string {
  const sub = entry.submodule;
  if (sub === undefined) return "";
  if ((staged ? entry.staged : entry.unstaged) !== "modified") return "";
  if (staged) return "commit changed";
  const words: string[] = [];
  if (sub.commitChanged) words.push("commit changed");
  if (sub.trackedModified) words.push("modified files");
  if (sub.untracked) words.push("untracked files");
  return words.join(", ");
}

/** Why a target's unstaged rows can't be staged. */
export type StageBlock = "reserved" | "submodule";

/** A dirty submodule whose checked-out commit is the recorded one: nothing the
 *  parent can stage. */
export function submoduleStageBlocked(
  entry: FileEntry,
  staged: boolean,
): boolean {
  return (
    !staged &&
    entry.submodule !== undefined &&
    entry.unstaged === "modified" &&
    !entry.submodule.commitChanged
  );
}

/** `git restore` on a gitlink restores nothing on a modified row, and on a
 *  typechange row it either does nothing or deletes the file in its place;
 *  `FileEntry` can't tell those two apart, so neither offers Discard. */
export function submoduleDiscardBlocked(entry: FileEntry): boolean {
  return (
    entry.submodule !== undefined &&
    (entry.unstaged === "modified" || entry.unstaged === "typechange")
  );
}

const NONE_STAGEABLE: Record<
  "reserved" | "submodule" | "both",
  { reason: string; menuLabel: string }
> = {
  reserved: {
    reason:
      "Git can't stage Windows-reserved device names, and every file here has one",
    menuLabel: "Stage files (Windows-reserved names)",
  },
  submodule: {
    reason: "Nothing to stage here: commit inside the submodule first",
    menuLabel: "Stage files (commit inside the submodule first)",
  },
  both: {
    reason:
      "Nothing here can be staged: Windows-reserved names, and submodules whose commit hasn't changed",
    menuLabel: "Stage files (none can be staged)",
  },
};

/** The reason and menu label for a target none of whose unstaged rows can be
 *  staged, naming the causes `blocks` holds. */
export function noneStageableCopy(blocks: readonly StageBlock[]): {
  reason: string;
  menuLabel: string;
} {
  const sub = blocks.includes("submodule");
  if (sub && blocks.includes("reserved")) return NONE_STAGEABLE.both;
  return sub ? NONE_STAGEABLE.submodule : NONE_STAGEABLE.reserved;
}

/** The causes, deduplicated, among the unstaged rows of `rows` that cannot be
 *  staged. A reserved name wins where both apply, as on the row itself. */
export function stageBlocks(rows: readonly FileEntry[]): StageBlock[] {
  const found = new Set<StageBlock>();
  for (const row of rows) {
    if (row.unstaged === null) continue;
    if (reservedDeviceName(row.path) !== null) found.add("reserved");
    else if (submoduleStageBlocked(row, false)) found.add("submodule");
  }
  return [...found];
}

/** The line a stage that went ahead says about the submodule rows of `rows`
 *  it left behind (counted as `stageBlocks` attributes them), or null when it
 *  left none: their tag and words don't say a press just skipped them. */
export function submodulesLeftUnstagedCopy(
  rows: readonly FileEntry[],
): string | null {
  let n = 0;
  for (const row of rows)
    if (
      row.unstaged !== null &&
      reservedDeviceName(row.path) === null &&
      submoduleStageBlocked(row, false)
    )
      n++;
  if (n === 0) return null;
  return n === 1
    ? "1 submodule was left unstaged: commit inside it first"
    : `${n} submodules were left unstaged: commit inside them first`;
}

/** `rows` minus the ones `submoduleDiscardBlocked` withholds, order kept. */
export function discardReach<T extends FileEntry>(rows: readonly T[]): T[] {
  return rows.filter((row) => !submoduleDiscardBlocked(row));
}

/** Whether two spellings name one folder: trailing separators dropped always;
 *  when `windows`, `\` and `/` unified and case folded. */
export function sameRepoRoot(a: string, b: string, windows: boolean): boolean {
  const norm = (p: string) =>
    windows
      ? p.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
      : p.replace(/\/+$/, "");
  return norm(a) === norm(b);
}

/** Verdicts by `${repo}:${staged}:${path}`. */
export type SubmoduleVerdicts = ReadonlyMap<string, boolean>;

/** For each seen key: its record's verdict when the record exists, else the
 *  value `prev` held. Keys not in `seen` are dropped. Returns `prev` itself
 *  when nothing changed. */
export function rememberSubmoduleVerdicts(
  prev: SubmoduleVerdicts,
  seen: readonly { key: string; record: FileEntry | undefined }[],
): SubmoduleVerdicts {
  const next = new Map<string, boolean>();
  for (const { key, record } of seen) {
    if (next.has(key)) continue;
    const verdict =
      record !== undefined ? record.submodule !== undefined : prev.get(key);
    if (verdict !== undefined) next.set(key, verdict);
  }
  if (
    next.size === prev.size &&
    [...next].every(([key, verdict]) => prev.get(key) === verdict)
  )
    return prev;
  return next;
}

/** The record's verdict when it exists, else the remembered one, else false. */
export function submoduleVerdict(
  memory: SubmoduleVerdicts,
  key: string,
  record: FileEntry | undefined,
): boolean {
  if (record !== undefined) return record.submodule !== undefined;
  return memory.get(key) ?? false;
}
