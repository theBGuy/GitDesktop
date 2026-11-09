// What opening a Changes row does: the one decision the row's double-click, the
// palette's "Open file in external editor" and the file menu's Open items share,
// plus the executor that carries it out.

import { toast } from "sonner";
import {
  openWithDefault,
  openWithProgram,
  revealInExplorer,
} from "@/lib/git/api";
import { conflictSides } from "@/lib/git/conflict";
import type { FileEntry } from "@/lib/git/types";
import { refuseIfSwitched } from "@/lib/stores/notifications";
import { toastError } from "@/lib/toast";
import { isConflictedEntry } from "./bulk-row-targets";

/** The file-menu Open item a double-click runs, which carries its hint. */
export type OpenHintTarget = "editor" | "default" | "submodule";

/** `probeWorkingFile`: the working file may or may not exist (a conflict, or a
 *  staged deletion that "Untrack file (keep on disk)" left in place), so every
 *  open checks it on disk first. */
export type OpenChangedFileAction =
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
    }
  | { kind: "refuse"; reason: string }
  /** An untracked folder (git's trailing-slash spelling) is revealed in the
   *  file manager, never handed to a program. */
  | { kind: "folder"; relPath: string; absolutePath: string }
  /** A submodule row opens the submodule as its own repository. */
  | { kind: "submodule"; relPath: string };

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
  // A submodule is a folder: the probe below reads a FILE, so no submodule
  // action ever probes; the hook behind the `submodule` arm makes its own check.
  const submodule = entry.submodule !== undefined;
  if (submodule && via === undefined)
    return { kind: "submodule", relPath: entry.path };
  const sep = windows ? "\\" : "/";
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
  const probeWorkingFile =
    !submodule &&
    (isConflictedEntry(entry) ||
      (entry.staged === "deleted" && entry.unstaged === null));
  const relPath = entry.path;
  const absolutePath = `${repoPath}${sep}${relPath.replaceAll("/", sep)}`;
  const program = via ?? (editorPath !== "" ? "editor" : "default");
  if (program === "editor" && editorPath !== "")
    return {
      kind: "editor",
      program: editorPath,
      relPath,
      absolutePath,
      probeWorkingFile,
    };
  return { kind: "default", relPath, absolutePath, probeWorkingFile };
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
    case "submodule":
      return { showFileOpens: true, hintOn: "submodule" };
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

/** Probe-class opens in flight, keyed `${repoPath}\0${relPath}`: a repeat while
 *  one is pending is dropped, so a row never launches twice. */
const probing = new Set<string>();

function launch(
  action: Extract<OpenChangedFileAction, { kind: "editor" | "default" }>,
): void {
  if (action.kind === "editor")
    void openWithProgram(action.program, action.absolutePath).catch(toastError);
  else void openWithDefault(action.absolutePath).catch(toastError);
}

/** Carries out an open. Its only effects are a toast or an external launch:
 *  it touches no selection, focus or store state, whenever it settles. */
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
    // The hook claims before its own probe, so a second press retires the
    // first: no drop set and no switch check here.
    case "submodule":
      await openSubmodule(action.relPath);
      return;
    case "editor":
    case "default": {
      if (!action.probeWorkingFile) {
        launch(action);
        return;
      }
      const key = `${repoPath}\0${action.relPath}`;
      if (probing.has(key)) return;
      probing.add(key);
      const firedOn = repoPath;
      // Only an answered `workingExists: false` proves the file is gone.
      let exists = true;
      try {
        exists = (await conflictSides(repoPath, action.relPath, []))
          .workingExists;
      } catch {
        // A failed probe falls through to the opener, whose own error toasts.
      } finally {
        probing.delete(key);
      }
      if (
        refuseIfSwitched(
          firedOn,
          "the file didn't open",
          "while checking the file",
        )
      )
        return;
      if (!exists) {
        toast.info(deletedNothingToOpen(action.relPath));
        return;
      }
      launch(action);
      return;
    }
    default:
      return action satisfies never;
  }
}
