import { isWindows } from "@/lib/hotkeys/binding";
import { invoke } from "@/lib/tauri/invoke";
import { parseArgs, type TaskDef } from "./types";

/**
 * Whether task runs use an external OS terminal instead of the in-app PTY. True
 * only on **Windows under `pnpm tauri dev`**, where the in-app ConPTY can't spawn
 * (a documented dev-only limitation — see `pty.rs`); a release install uses the
 * in-app terminal. Everywhere else this is false and runs stay in-app.
 *
 * `import.meta.env.DEV` comes FIRST: it's statically replaced at build time, so a
 * production bundle sees `false && isWindows` and folds the whole thing to
 * `false` — with `isWindows` (a runtime value) first, the expression survives and
 * drags this module into the bundle. Verified by grepping the built chunks.
 */
export const TASKS_USE_EXTERNAL_TERMINAL = import.meta.env.DEV && isWindows;

/**
 * Runs a task in the user's OS terminal — the dev-only fallback for the Windows
 * ConPTY limitation. A real, interactive terminal window, so even a prompting
 * script (a release flow) works while iterating in dev. `args` is the effective
 * argument string for THIS run (the run dialog may have adjusted it).
 */
export function openTaskInTerminal(
  task: TaskDef,
  cwd: string,
  args: string,
): Promise<void> {
  return invoke<void>("task_open_terminal", {
    cwd,
    interpreter: task.interpreter,
    body: task.source.kind === "inline" ? task.source.body : null,
    path: task.source.kind === "file" ? task.source.path : null,
    args: parseArgs(args),
  });
}
