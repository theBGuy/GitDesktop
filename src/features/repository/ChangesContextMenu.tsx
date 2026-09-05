import {
  ContextMenuItem,
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

/** What the one shared context menu acts on, set on right-click. */
export type MenuTarget =
  | { kind: "row"; entry: FileEntry; staged: boolean }
  | { kind: "global" }
  | null;

/** Callbacks the menu items invoke — all owned by the parent ChangesPanel so the
 *  menu stays presentational (selection mutations, confirm-dialog scopes, etc.). */
export interface ChangesMenuActions {
  discardAll: () => void;
  stashAll: () => void;
  stageSelected: () => void;
  unstageSelected: () => void;
  discardSelected: () => void;
  stashSelected: () => void;
  ignoreSelected: () => void;
  untrackSelected: () => void;
  toggle: (entry: FileEntry, staged: boolean) => void;
  resolveWithAi: (path: string) => void;
  discardFile: (entry: FileEntry) => void;
  stashFile: (entry: FileEntry) => void;
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
  selectionCount,
  stageableSelectionCount,
  selectedTrackedCount,
  actions,
}: {
  target: MenuTarget;
  repoPath: string;
  /** Whether the right-clicked row is part of the active multi-selection. */
  inSelection: boolean;
  selectionCount: number;
  /** Selected files staging can actually reach — the whole selection minus the
   *  Windows-reserved device names `git add` refuses. Drives the Stage item's
   *  count, and disables it at 0. */
  stageableSelectionCount: number;
  selectedTrackedCount: number;
  actions: ChangesMenuActions;
}) {
  const settings = useSettings();
  const aiEnabled = useAiEnabled();
  const reviewConfigured = useReviewConfigured();
  const editorPath = (settings.data?.externalEditor ?? "").trim();
  const editorName =
    (settings.data?.externalEditorName ?? "").trim() || "editor";
  const onError = (e: unknown) => toastError(e);

  if (!target) return null;
  if (target.kind === "global") {
    return (
      <>
        <ContextMenuItem onClick={actions.discardAll}>
          Discard all changes…
        </ContextMenuItem>
        <ContextMenuItem onClick={actions.stashAll}>
          Stash all changes…
        </ContextMenuItem>
      </>
    );
  }
  const { entry, staged } = target;
  if (inSelection && selectionCount > 1) {
    // The stageable count can drop to 1 (or 0) inside a >1 selection when the
    // rest are Windows-reserved names, so this label pluralizes off its own n.
    const n = stageableSelectionCount;
    return (
      <>
        {!staged && (
          <ContextMenuItem
            disabled={stageableSelectionCount === 0}
            onClick={actions.stageSelected}
          >
            {n === 0
              ? "Stage files (Windows-reserved names)"
              : `Stage ${n} file${n === 1 ? "" : "s"}`}
          </ContextMenuItem>
        )}
        {staged && (
          <ContextMenuItem onClick={actions.unstageSelected}>
            Unstage {selectionCount} files
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={actions.discardSelected}>
          Discard {selectionCount} changes…
        </ContextMenuItem>
        <ContextMenuItem onClick={actions.stashSelected}>
          Stash {selectionCount} changes…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={actions.ignoreSelected}>
          Ignore {selectionCount} files (add to .gitignore)
        </ContextMenuItem>
        {selectedTrackedCount > 0 && (
          <ContextMenuItem onClick={actions.untrackSelected}>
            Untrack {selectedTrackedCount} files (keep on disk)
          </ContextMenuItem>
        )}
        {aiEnabled && (
          <ContextMenuItem onClick={actions.aiExcludeSelected}>
            Exclude {selectionCount} files from AI (add to .gitdesktop/aiignore)
          </ContextMenuItem>
        )}
      </>
    );
  }
  // Build the absolute path with the OS-native separator: git emits "/" in
  // entry.path, but reveal/open/copy expect "\" on Windows and "/" elsewhere.
  const sep = isWindows ? "\\" : "/";
  const absolutePath = `${repoPath}${sep}${entry.path.replaceAll("/", sep)}`;
  const folders = ancestorFolders(entry.path);
  const dot = entry.path.lastIndexOf(".");
  const extension =
    dot > entry.path.lastIndexOf("/") + 1 ? entry.path.slice(dot + 1) : null;
  // `*.` is a deliberate glob, but the extension after it is path-derived and can
  // hold a metacharacter of its own (`a.ts[x]`), which would widen the match.
  const extensionPattern = extension && `*.${globLiteralPath(extension)}`;
  const isTracked = entry.unstaged !== "untracked" && entry.staged !== "added";
  // Only staging reads the working-tree file, so only it hits the device.
  const stageBlocked = !staged && reservedDeviceName(entry.path) !== null;
  const isConflicted =
    entry.unstaged === "conflicted" || entry.staged === "conflicted";
  return (
    <>
      {isConflicted && aiEnabled && reviewConfigured && (
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
      <ContextMenuItem onClick={() => actions.stashFile(entry)}>
        Stash change…
      </ContextMenuItem>
      {isTracked && (
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
      {isTracked && (
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
