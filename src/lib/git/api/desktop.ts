import { invoke } from "@/lib/tauri/invoke";

export const revealInExplorer = (path: string) =>
  invoke<void>("reveal_in_explorer", { path });

export const openWithDefault = (path: string) =>
  invoke<void>("open_with_default", { path });

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
