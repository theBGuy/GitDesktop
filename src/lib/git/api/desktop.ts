import { toast } from "sonner";
import { invoke, isAppError } from "@/lib/tauri/invoke";
import { toastError } from "@/lib/toast";

export const revealInExplorer = (path: string) =>
  invoke<void>("reveal_in_explorer", { path });

/** Rust refuses a file whose default action would run it. That one refusal is
 *  answered here, for every caller, with a notice offering Show in Explorer,
 *  and resolves; any other failure still rejects to the caller's handler. */
export async function openWithDefault(path: string): Promise<void> {
  try {
    await invoke<void>("open_with_default", { path });
  } catch (e) {
    if (!isAppError(e) || e.kind !== "defaultOpenRefused") throw e;
    toast.warning(
      `${e.name} wasn't opened: its default program could run it. Show it in Explorer instead.`,
      {
        duration: 8000,
        action: {
          label: "Show in Explorer",
          onClick: () => void revealInExplorer(path).catch(toastError),
        },
      },
    );
  }
}

/** What sits at a repo-relative path; a final link (a junction too) is never
 *  followed. */
export type PathKind = "missing" | "file" | "dir" | "symlink";

export const pathKind = (repoPath: string, relPath: string) =>
  invoke<PathKind>("path_kind", { repoPath, relPath });

export const openNearestFolder = (repoPath: string, relPath: string) =>
  invoke<void>("open_nearest_folder", { repoPath, relPath });

export const openInTerminal = (
  path: string,
  terminal?: string,
  program?: string,
  command?: string,
) =>
  invoke<void>("open_in_terminal", {
    path,
    terminal: terminal || null,
    program: program || null,
    command: command || null,
  });

export const openWithProgram = (program: string, path: string) =>
  invoke<void>("open_with_program", { program, path });

export interface DetectedEditor {
  name: string;
  path: string;
}

export const detectEditors = () => invoke<DetectedEditor[]>("detect_editors");

export interface DetectedTerminal {
  /** Known kind id the launcher dispatches on, e.g. "powershell". */
  id: string;
  name: string;
  path: string;
}

export const detectTerminals = () =>
  invoke<DetectedTerminal[]>("detect_terminals");
