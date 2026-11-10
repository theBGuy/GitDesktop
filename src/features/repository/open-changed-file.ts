// What opening a Changes row does: the one decision the row's double-click, the
// palette's "Open changed file" and the file menu's Open items share, plus the
// executor that carries it out.

import { toast } from "sonner";
import {
  openWithDefault,
  openWithProgram,
  type PathKind,
  pathKind,
  revealInExplorer,
} from "@/lib/git/api";
import type { FileEntry } from "@/lib/git/types";
import { refuseIfSwitched } from "@/lib/stores/notifications";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { isConflictedEntry } from "./bulk-row-targets";
import { submoduleFileOnDisk } from "./submodule-row";
import { claimRepoOpenOrder } from "./useOpenRepoByPath";

/** The file-menu Open item a double-click runs, which carries its hint. */
export type OpenHintTarget = "editor" | "default" | "submodule";

/** `probeWorkingFile`: the working file may or may not exist (a conflict, or a
 *  staged deletion that "Untrack file (keep on disk)" left in place), so every
 *  open checks it on disk first. */
type FileOpenAction =
  | {
      kind: "editor";
      program: string;
      relPath: string;
      absolutePath: string;
      probeWorkingFile: boolean;
    }
  | {
      kind: "default";
      relPath: string;
      absolutePath: string;
      probeWorkingFile: boolean;
    };

export type OpenChangedFileAction =
  | FileOpenAction
  | { kind: "refuse"; reason: string }
  /** An untracked folder (git's trailing-slash spelling) is revealed in the
   *  file manager, never handed to a program. */
  | { kind: "folder"; relPath: string; absolutePath: string }
  /** A submodule row opens the submodule as its own repository while a folder
   *  is there; a file that replaced it opens as `asFile`. `typechange` marks a
   *  row whose submodule a file replaced (`submoduleFileOnDisk`). */
  | {
      kind: "submodule";
      relPath: string;
      asFile: FileOpenAction;
      typechange: boolean;
    };

export function deletedNothingToOpen(path: string): string {
  return `${path} was deleted, so there's nothing to open.`;
}

export function openChangedFileAction(input: {
  entry: FileEntry;
  repoPath: string;
  /** Trimmed settings.externalEditor; "" = none set. */
  editorPath: string;
  /** `isWindows` from @/lib/hotkeys/binding; picks the path separator. */
  windows: boolean;
  /** A menu item's own program. Omitted = editor when set, else default
   *  (double-click, palette). `"editor"` with editorPath "" yields `default`. */
  via?: "editor" | "default";
}): OpenChangedFileAction {
  const { entry, repoPath, editorPath, windows, via } = input;
  // A worktree deletion's file is certainly gone, on both rows of the entry.
  if (entry.unstaged === "deleted")
    return { kind: "refuse", reason: deletedNothingToOpen(entry.path) };
  const sep = windows ? "\\" : "/";
  const relPath = entry.path;
  const absolutePath = `${repoPath}${sep}${relPath.replaceAll("/", sep)}`;
  const program = via ?? (editorPath !== "" ? "editor" : "default");
  const fileOpen = (probeWorkingFile: boolean): FileOpenAction => {
    if (program === "editor" && editorPath !== "")
      return {
        kind: "editor",
        program: editorPath,
        relPath,
        absolutePath,
        probeWorkingFile,
      };
    return { kind: "default", relPath, absolutePath, probeWorkingFile };
  };
  // A submodule row's executor checks what is on disk itself, so its file
  // fallback and its menu's file items never probe.
  const submodule = entry.submodule !== undefined;
  if (submodule && via === undefined)
    return {
      kind: "submodule",
      relPath,
      asFile: fileOpen(false),
      typechange: submoduleFileOnDisk(entry),
    };
  // git ends a path with "/" only for an untracked directory (an embedded
  // repository among them), whatever the menu item asked for.
  if (entry.path.endsWith("/")) {
    const folder = entry.path.slice(0, -1).replaceAll("/", sep);
    return {
      kind: "folder",
      relPath: entry.path,
      absolutePath: `${repoPath}${sep}${folder}`,
    };
  }
  return fileOpen(
    !submodule &&
      (isConflictedEntry(entry) ||
        (entry.staged === "deleted" && entry.unstaged === null)),
  );
}

/** Whether the single-file menu offers its Open items, and which one carries
 *  the "Double-click" hint. */
export function fileMenuOpens(action: OpenChangedFileAction): {
  showFileOpens: boolean;
  hintOn: OpenHintTarget | null;
} {
  switch (action.kind) {
    case "refuse":
    case "folder":
      return { showFileOpens: false, hintOn: null };
    case "editor":
    case "default":
      return { showFileOpens: true, hintOn: action.kind };
    // A folder row never launches an editor: Open submodule is its open item
    // (Show in Explorer stays). A row whose submodule a file replaced offers the
    // file opens instead, hinting the one its double-click runs; a file that
    // became a submodule keeps Open submodule.
    case "submodule":
      return action.typechange
        ? { showFileOpens: true, hintOn: action.asFile.kind }
        : { showFileOpens: false, hintOn: "submodule" };
    default:
      return action satisfies never;
  }
}

/** One flag per hinted item, so the menu reads a slot instead of comparing. */
export function hintSlots(
  hintOn: OpenHintTarget | null,
): Record<OpenHintTarget, boolean> {
  switch (hintOn) {
    case null:
      return { editor: false, default: false, submodule: false };
    case "editor":
      return { editor: true, default: false, submodule: false };
    case "default":
      return { editor: false, default: true, submodule: false };
    case "submodule":
      return { editor: false, default: false, submodule: true };
    default:
      return hintOn satisfies never;
  }
}

/** Probing opens in flight, keyed `${repoPath}\0${relPath}`: a repeat while one
 *  is pending is dropped, so a probing row never launches twice. */
const probing = new Set<string>();
const probeKey = (repoPath: string, relPath: string) =>
  `${repoPath}\0${relPath}`;

function launch(action: FileOpenAction): void {
  if (action.kind === "editor")
    void openWithProgram(action.program, action.absolutePath).catch(toastError);
  else void openWithDefault(action.absolutePath).catch(toastError);
}

/** What is at the row's path, "unknown" when the probe failed, or null when the
 *  open stops: a repeat already probing, or a repo switch during the probe
 *  (which says so). */
async function probeKind(
  repoPath: string,
  relPath: string,
  what: string,
): Promise<PathKind | "unknown" | null> {
  const key = probeKey(repoPath, relPath);
  if (probing.has(key)) return null;
  probing.add(key);
  let kind: PathKind | "unknown" = "unknown";
  try {
    kind = await pathKind(repoPath, relPath);
  } catch {
    // A failed probe falls through to the arm's own open, whose error toasts.
  } finally {
    probing.delete(key);
  }
  if (
    refuseIfSwitched(
      repoPath,
      `the ${what} didn't open`,
      `while checking the ${what}`,
    )
  )
    return null;
  return kind;
}

/** Carries out an open. Every arm but one only toasts, reveals or launches,
 *  touching no selection, focus or store state; the exception is `submodule`,
 *  which hands a folder off to `openSubmodule` and so can switch repositories. */
export async function runOpenChangedFile(
  action: OpenChangedFileAction,
  repoPath: string,
  /** The function useOpenSubmoduleAsRepo returns. */
  openSubmodule: (subPath: string) => Promise<boolean>,
): Promise<void> {
  switch (action.kind) {
    case "refuse":
      toast.info(action.reason);
      return;
    case "folder":
      void revealInExplorer(action.absolutePath).catch(toastError);
      return;
    // The status token outlives the folder: a file that replaced the submodule
    // keeps it, so the arm opens what is there now. The press claims its open
    // before the probe, so the latest press wins. Retired silently by: a repo
    // switch during the probe (probeKind); a newer open claimed during the
    // probe, another submodule row's press included; any interaction during the
    // probe that leaves another row selected; and a newer open or any epoch
    // bump during the hook's own validate (its claim). Exempt during the probe
    // only: re-selecting this same row, which bumps the epoch too; the hook's
    // epoch-checked claim still retires on it. A repeat of a probing row
    // returns before claiming, so it never retires the press it repeats.
    case "submodule": {
      if (probing.has(probeKey(repoPath, action.relPath))) return;
      const stillLatest = claimRepoOpenOrder();
      const pressEpoch = useUiStore.getState().interactionEpoch;
      const kind = await probeKind(repoPath, action.relPath, "submodule");
      const ui = useUiStore.getState();
      const movedOn =
        ui.interactionEpoch !== pressEpoch &&
        ui.selectedFile?.path !== action.relPath;
      switch (kind) {
        case null:
          return;
        case "missing":
          toast.info(deletedNothingToOpen(action.relPath));
          return;
        case "file":
        case "symlink":
          launch(action.asFile);
          return;
        case "dir":
        case "unknown":
          if (stillLatest() && !movedOn) await openSubmodule(action.relPath);
          return;
        default:
          return kind satisfies never;
      }
    }
    case "editor":
    case "default": {
      if (!action.probeWorkingFile) {
        launch(action);
        return;
      }
      const kind = await probeKind(repoPath, action.relPath, "file");
      switch (kind) {
        case null:
          return;
        // Only an answered "missing" proves the file is gone.
        case "missing":
          toast.info(deletedNothingToOpen(action.relPath));
          return;
        case "dir":
          void revealInExplorer(action.absolutePath).catch(toastError);
          return;
        case "file":
        case "symlink":
        case "unknown":
          launch(action);
          return;
        default:
          return kind satisfies never;
      }
    }
    default:
      return action satisfies never;
  }
}
