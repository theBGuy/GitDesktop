import { useId } from "react";
import { MENU_HELD_ROW_CLASS } from "@/components/menu-held-row";
import { PathText } from "@/components/path-text";
import {
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { copyText } from "@/lib/clipboard";
import {
  openWithDefault,
  openWithProgram,
  revealInExplorer,
} from "@/lib/git/api";
import {
  aiExcludePatternLinesForPath,
  globLiteralPath,
  literalPathspec,
} from "@/lib/git/glob";
import { reservedDeviceName } from "@/lib/git/reserved-device-name";
import type { FileEntry } from "@/lib/git/types";
import { isWindows } from "@/lib/hotkeys/binding";
import {
  useAiEnabled,
  useReviewConfigured,
  useSettings,
} from "@/lib/settings/queries";
import { toastError } from "@/lib/toast";
import { canUntrack, isConflictedEntry } from "./bulk-row-targets";

/** What the one shared context menu acts on, set on right-click. */
export type MenuTarget =
  | { kind: "row"; entry: FileEntry; staged: boolean }
  | {
      kind: "folder";
      section: "staged" | "unstaged";
      /** Repo-relative directory path, "/"-separated. */
      path: string;
      /** The repository the right-click landed in. */
      repo: string;
    }
  | { kind: "global" }
  | null;

/** A right-clicked folder's counts, resolved by the parent from its live lists
 *  at every render (the menu stays open across polls). */
export interface FolderMenuCounts {
  /** Files shown under the folder in its section: the row's "(N)". */
  fileCount: number;
  /** Of those, the ones staging can reach (Changes section only). */
  stageableCount: number;
  /** Same-side files under the folder that the filter hides. */
  hiddenCount: number;
  /** Shown files that are conflicted: Discard leaves them alone. */
  conflictedCount: number;
  /** Shown files a Stash takes: untracked Windows-reserved names stay behind. */
  stashableCount: number;
}

/** Callbacks the menu items invoke — all owned by the parent ChangesPanel so the
 *  menu stays presentational (selection mutations, confirm-dialog scopes, etc.). */
export interface ChangesMenuActions {
  discardAll: () => void;
  stashAll: () => void;
  stageFolder: () => void;
  unstageFolder: () => void;
  discardFolder: () => void;
  stashFolder: () => void;
  stageSelected: () => void;
  unstageSelected: () => void;
  discardSelected: () => void;
  stashSelected: () => void;
  ignoreSelected: () => void;
  untrackSelected: () => void;
  toggle: (entry: FileEntry, staged: boolean) => void;
  resolveWithAi: (path: string) => void;
  discardFile: (entry: FileEntry) => void;
  stashFile: (entry: FileEntry, staged: boolean) => void;
  viewHistory: (path: string) => void;
  blame: (path: string) => void;
  // The three below take what git gets and, separately, what the user reads: a
  // concrete path is glob-escaped while `label` stays the plain path. A
  // deliberate glob (`*.log`) is identical in both.
  /** `pattern` is a gitignore line — glob-escape a concrete path. */
  ignore: (pattern: string, label: string) => void;
  /** `pathspec` reaches `git rm --cached` as given, so a concrete path must
   *  arrive through `literalPathspec` or it removes its glob-siblings too. */
  untrack: (pathspec: string, ignorePattern: string, label: string) => void;
  /** AI-ignore LINES for a concrete path — build them with
   *  `aiExcludePatternLinesForPath`, which glob-escapes and adds the
   *  `/`-separated twin a `\`-holding path needs to be hidden on Windows. */
  aiExclude: (patterns: string[], label: string) => void;
  aiExcludeSelected: () => void;
}

/** A disabled menu item can't carry a tooltip, so the reason rides its label. */
const RESERVED_HINT = " (Windows-reserved name)";
/** Git refuses every path stash while any file is conflicted. */
const CONFLICT_HINT = " (resolve conflicts first)";

/** A Stash label counts the files that go: untracked Windows-reserved names
 *  stay behind, so a target holding any takes the "N of M" form, like Stage. */
function stashLabel(stashable: number, total: number): string {
  return stashable === total
    ? `Stash ${total} change${total === 1 ? "" : "s"}…`
    : `Stash ${stashable} of ${total} changes…`;
}

/** "src/lib/x.ts" -> ["src/lib", "src"] (closest folder first). */
function ancestorFolders(path: string): string[] {
  const folders: string[] = [];
  let current = path;
  for (;;) {
    const slash = current.lastIndexOf("/");
    if (slash === -1) break;
    current = current.slice(0, slash);
    folders.push(current);
  }
  return folders;
}

/**
 * The shared context menu's items, chosen from whatever was right-clicked: the
 * whole tree (header / blank space), a multi-selection, or a single file. Lives
 * in one always-mounted `<ContextMenuContent>`; the parent records the target on
 * right-click (capture phase) and hands it down here.
 */
export function ChangesContextMenuItems({
  target,
  repoPath,
  inSelection,
  rowCount,
  stagedRowCount,
  unstagedRowCount,
  stageableCount,
  pathCount,
  stashablePathCount,
  trackedPathCount,
  discardableCount,
  anyConflicted,
  folderCounts,
  actions,
}: {
  target: MenuTarget;
  repoPath: string;
  /** Whether the right-clicked row is part of the active multi-selection. */
  inSelection: boolean;
  /** Selected rows that still resolve to a change; above 1 opens the bulk menu. */
  rowCount: number;
  /** Selected staged rows (Unstage). */
  stagedRowCount: number;
  /** Selected unstaged rows (Stage, Discard). */
  unstagedRowCount: number;
  /** Selected unstaged rows staging can actually reach: minus the
   *  Windows-reserved device names `git add` refuses. */
  stageableCount: number;
  /** Distinct selected files (Stash, Ignore, Exclude from AI act per file). */
  pathCount: number;
  /** Of those, the ones a Stash takes: minus untracked Windows-reserved names. */
  stashablePathCount: number;
  /** Distinct selected files `canUntrack` accepts (Untrack). */
  trackedPathCount: number;
  /** Selected unstaged rows Discard sends: minus the conflicted ones. */
  discardableCount: number;
  /** Whether any file in the repository is conflicted; every Stash item
   *  disables while one is. */
  anyConflicted: boolean;
  /** The folder target's counts; null for any other target. */
  folderCounts: FolderMenuCounts | null;
  actions: ChangesMenuActions;
}) {
  const settings = useSettings();
  const aiEnabled = useAiEnabled();
  const reviewConfigured = useReviewConfigured();
  const noteId = useId();
  const editorPath = (settings.data?.externalEditor ?? "").trim();
  const editorName =
    (settings.data?.externalEditorName ?? "").trim() || "editor";
  const onError = (e: unknown) => toastError(e);
  // Build the absolute path with the OS-native separator: git emits "/" in
  // entry.path, but reveal/open/copy expect "\" on Windows and "/" elsewhere.
  const sep = isWindows ? "\\" : "/";
  const absoluteOf = (path: string) =>
    `${repoPath}${sep}${path.replaceAll("/", sep)}`;

  if (!target) return null;
  if (target.kind === "folder") {
    const staged = target.section === "staged";
    const files = folderCounts?.fileCount ?? 0;
    const stageable = folderCounts?.stageableCount ?? 0;
    const stashable = folderCounts?.stashableCount ?? 0;
    const hidden = folderCounts?.hiddenCount ?? 0;
    const discardable = staged
      ? 0
      : files - (folderCounts?.conflictedCount ?? 0);
    const plural = files === 1 ? "" : "s";
    const verb = staged ? "unstage" : "stage";
    let label: string;
    if (files === 0 && hidden > 0) label = `No visible files to ${verb}`;
    else if (files === 0) label = `Nothing to ${verb} in this folder`;
    else if (staged) label = `Unstage ${files} file${plural}`;
    else if (stageable === 0) label = "Stage files (Windows-reserved names)";
    else if (stageable < files) label = `Stage ${stageable} of ${files} files`;
    else label = `Stage ${files} file${plural}`;
    const absoluteFolder = absoluteOf(target.path);
    return (
      <>
        {/* Base UI's GroupLabel must sit inside a group, which it names for
            assistive tech. The label's max width makes PathText truncate
            instead of widening the menu. */}
        <ContextMenuGroup>
          <ContextMenuLabel className="max-w-64">
            <PathText path={target.path} />
          </ContextMenuLabel>
          <ContextMenuItem
            className={MENU_HELD_ROW_CLASS}
            disabled={files === 0 || (!staged && stageable === 0)}
            aria-describedby={hidden > 0 ? noteId : undefined}
            onClick={staged ? actions.unstageFolder : actions.stageFolder}
          >
            {label}
          </ContextMenuItem>
          {discardable > 0 && (
            <ContextMenuItem
              aria-describedby={hidden > 0 ? noteId : undefined}
              onClick={actions.discardFolder}
            >
              {discardable === files
                ? `Discard ${discardable} change${discardable === 1 ? "" : "s"}…`
                : `Discard ${discardable} of ${files} changes…`}
            </ContextMenuItem>
          )}
          {stashable > 0 && (
            <ContextMenuItem
              className={MENU_HELD_ROW_CLASS}
              disabled={anyConflicted}
              aria-describedby={hidden > 0 ? noteId : undefined}
              onClick={actions.stashFolder}
            >
              {`${stashLabel(stashable, files)}${anyConflicted ? CONFLICT_HINT : ""}`}
            </ContextMenuItem>
          )}
          {hidden > 0 && (
            <div
              id={noteId}
              className="max-w-64 px-2 pb-1.5 text-xs text-muted-foreground"
            >
              {files === 0
                ? `${hidden} file${hidden === 1 ? " here is" : "s here are"} hidden by the filter.`
                : `${hidden} more ${hidden === 1 ? "is" : "are"} hidden by the filter and ${hidden === 1 ? "is" : "are"} left alone.`}
            </div>
          )}
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() => copyText(absoluteFolder, "Path copied")}
        >
          Copy folder path
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => copyText(target.path, "Relative path copied")}
        >
          Copy relative folder path
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() => revealInExplorer(absoluteFolder).catch(onError)}
        >
          Show in Explorer
        </ContextMenuItem>
      </>
    );
  }
  if (target.kind === "global") {
    return (
      <>
        <ContextMenuItem onClick={actions.discardAll}>
          Discard all changes…
        </ContextMenuItem>
        <ContextMenuItem
          className={MENU_HELD_ROW_CLASS}
          disabled={anyConflicted}
          onClick={actions.stashAll}
        >
          Stash all changes…
          {anyConflicted ? CONFLICT_HINT : ""}
        </ContextMenuItem>
      </>
    );
  }
  const { entry, staged } = target;
  if (inSelection && rowCount > 1) {
    // Each item counts the selected rows (or files) it acts on and hides at
    // zero; the clicked side's verb leads. Stage stays visible but disabled
    // when every selected unstaged row is a Windows-reserved name.
    const unstageItem = stagedRowCount > 0 && (
      <ContextMenuItem onClick={actions.unstageSelected}>
        {`Unstage ${stagedRowCount} file${stagedRowCount === 1 ? "" : "s"}`}
      </ContextMenuItem>
    );
    const stageItem = unstagedRowCount > 0 && (
      <ContextMenuItem
        className={MENU_HELD_ROW_CLASS}
        disabled={stageableCount === 0}
        onClick={actions.stageSelected}
      >
        {stageableCount === 0
          ? "Stage files (Windows-reserved names)"
          : stageableCount < unstagedRowCount
            ? `Stage ${stageableCount} of ${unstagedRowCount} files`
            : `Stage ${stageableCount} file${stageableCount === 1 ? "" : "s"}`}
      </ContextMenuItem>
    );
    return (
      <>
        {staged ? unstageItem : stageItem}
        {staged ? stageItem : unstageItem}
        {discardableCount > 0 && (
          <ContextMenuItem onClick={actions.discardSelected}>
            {discardableCount === unstagedRowCount
              ? `Discard ${discardableCount} change${discardableCount === 1 ? "" : "s"}…`
              : `Discard ${discardableCount} of ${unstagedRowCount} changes…`}
          </ContextMenuItem>
        )}
        {stashablePathCount > 0 && (
          <ContextMenuItem
            className={MENU_HELD_ROW_CLASS}
            disabled={anyConflicted}
            onClick={actions.stashSelected}
          >
            {`${stashLabel(stashablePathCount, pathCount)}${anyConflicted ? CONFLICT_HINT : ""}`}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={actions.ignoreSelected}>
          {`Ignore ${pathCount} file${pathCount === 1 ? "" : "s"} (add to .gitignore)`}
        </ContextMenuItem>
        {trackedPathCount > 0 && (
          <ContextMenuItem onClick={actions.untrackSelected}>
            {`Untrack ${trackedPathCount} file${trackedPathCount === 1 ? "" : "s"} (keep on disk)`}
          </ContextMenuItem>
        )}
        {aiEnabled && (
          <ContextMenuItem onClick={actions.aiExcludeSelected}>
            {`Exclude ${pathCount} file${pathCount === 1 ? "" : "s"} from AI (add to .gitdesktop/aiignore)`}
          </ContextMenuItem>
        )}
      </>
    );
  }
  const absolutePath = absoluteOf(entry.path);
  const folders = ancestorFolders(entry.path);
  const dot = entry.path.lastIndexOf(".");
  const extension =
    dot > entry.path.lastIndexOf("/") + 1 ? entry.path.slice(dot + 1) : null;
  // `*.` is a deliberate glob, but the extension after it is path-derived and can
  // hold a metacharacter of its own (`a.ts[x]`), which would widen the match.
  const extensionPattern = extension && `*.${globLiteralPath(extension)}`;
  const untrackable = canUntrack(entry);
  // A staged deletion has no index entry to untrack, but HEAD still holds its
  // history.
  const hasHistory = untrackable || entry.staged === "deleted";
  // Only staging reads the working-tree file, so only it hits the device.
  const stageBlocked = !staged && reservedDeviceName(entry.path) !== null;
  return (
    <>
      {isConflictedEntry(entry) && aiEnabled && reviewConfigured && (
        <>
          <ContextMenuItem onClick={() => actions.resolveWithAi(entry.path)}>
            Resolve with AI…
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      <ContextMenuItem
        disabled={stageBlocked}
        onClick={() => actions.toggle(entry, staged)}
      >
        {staged ? "Unstage file" : "Stage file"}
        {stageBlocked ? RESERVED_HINT : ""}
      </ContextMenuItem>
      {!staged && (
        <ContextMenuItem onClick={() => actions.discardFile(entry)}>
          Discard changes…
        </ContextMenuItem>
      )}
      <ContextMenuItem
        className={MENU_HELD_ROW_CLASS}
        disabled={anyConflicted}
        onClick={() => actions.stashFile(entry, staged)}
      >
        Stash change…
        {anyConflicted ? CONFLICT_HINT : ""}
      </ContextMenuItem>
      {hasHistory && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => actions.viewHistory(entry.path)}>
            View file history…
          </ContextMenuItem>
          <ContextMenuItem onClick={() => actions.blame(entry.path)}>
            Blame…
          </ContextMenuItem>
        </>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem
        onClick={() =>
          actions.ignore(`/${globLiteralPath(entry.path)}`, `/${entry.path}`)
        }
      >
        Ignore file (add to .gitignore)
      </ContextMenuItem>
      {folders.length > 0 && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            Ignore folder (add to .gitignore)
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {folders.map((folder) => (
              <ContextMenuItem
                key={folder}
                onClick={() =>
                  actions.ignore(`/${globLiteralPath(folder)}/`, `/${folder}/`)
                }
              >
                <span className="font-mono">{folder}/</span>
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      {extensionPattern && (
        <ContextMenuItem
          onClick={() => actions.ignore(extensionPattern, `*.${extension}`)}
        >
          Ignore all .{extension} files (add to .gitignore)
        </ContextMenuItem>
      )}
      {untrackable && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={() =>
              actions.untrack(
                literalPathspec(entry.path),
                `/${globLiteralPath(entry.path)}`,
                `"${entry.path}"`,
              )
            }
          >
            Untrack file (keep on disk)
          </ContextMenuItem>
          {folders.length > 0 && (
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                Untrack folder (keep on disk)
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {folders.map((folder) => (
                  <ContextMenuItem
                    key={folder}
                    onClick={() =>
                      actions.untrack(
                        literalPathspec(folder),
                        `/${globLiteralPath(folder)}/`,
                        `"${folder}/"`,
                      )
                    }
                  >
                    <span className="font-mono">{folder}/</span>
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
          {extensionPattern && (
            <ContextMenuItem
              onClick={() =>
                actions.untrack(
                  extensionPattern,
                  extensionPattern,
                  `*.${extension} files`,
                )
              }
            >
              Untrack all .{extension} files (keep on disk)
            </ContextMenuItem>
          )}
        </>
      )}
      {aiEnabled && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={() =>
              actions.aiExclude(
                aiExcludePatternLinesForPath(entry.path),
                `/${entry.path}`,
              )
            }
          >
            Exclude from AI (add to .gitdesktop/aiignore)
          </ContextMenuItem>
          {folders.length > 0 && (
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                Exclude folder from AI (add to .gitdesktop/aiignore)
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {folders.map((folder) => (
                  <ContextMenuItem
                    key={folder}
                    onClick={() =>
                      actions.aiExclude(
                        aiExcludePatternLinesForPath(folder).map(
                          (line) => `${line}/`,
                        ),
                        `/${folder}/`,
                      )
                    }
                  >
                    <span className="font-mono">{folder}/</span>
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
          {extensionPattern && (
            <ContextMenuItem
              onClick={() =>
                actions.aiExclude([extensionPattern], `*.${extension}`)
              }
            >
              Exclude all .{extension} files from AI (add to
              .gitdesktop/aiignore)
            </ContextMenuItem>
          )}
        </>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => copyText(absolutePath, "Path copied")}>
        Copy file path
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => copyText(entry.path, "Relative path copied")}
      >
        Copy relative file path
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        onClick={() => revealInExplorer(absolutePath).catch(onError)}
      >
        Show in Explorer
      </ContextMenuItem>
      {editorPath && (
        <ContextMenuItem
          onClick={() =>
            openWithProgram(editorPath, absolutePath).catch(onError)
          }
        >
          Open in {editorName}
        </ContextMenuItem>
      )}
      <ContextMenuItem
        onClick={() => openWithDefault(absolutePath).catch(onError)}
      >
        Open with default program
      </ContextMenuItem>
    </>
  );
}
