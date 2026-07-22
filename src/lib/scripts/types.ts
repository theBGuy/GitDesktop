import { isWindows } from "@/lib/hotkeys/binding";

/**
 * The interpreters a Task can run with. The Rust side (pty.rs `task_interp`) maps
 * each key to the binary names it resolves, the temp-file extension, and the argv
 * that runs the script *file* — keep these keys in sync with that match.
 */
export type Interpreter =
  | "powershell"
  | "cmd"
  | "bash"
  | "sh"
  | "zsh"
  | "node"
  | "python";

export interface InterpreterInfo {
  id: Interpreter;
  label: string;
  /** A short hint shown in the picker (what the body is written in). */
  hint: string;
}

/** Interpreter options for the task editor, in display order. */
export const INTERPRETERS: InterpreterInfo[] = [
  { id: "powershell", label: "PowerShell", hint: "pwsh, or Windows PowerShell" },
  { id: "cmd", label: "Command Prompt", hint: "cmd.exe batch" },
  { id: "bash", label: "Bash", hint: "bash script" },
  { id: "sh", label: "sh", hint: "POSIX shell" },
  { id: "zsh", label: "Zsh", hint: "zsh script" },
  { id: "node", label: "Node.js", hint: "JavaScript (ESM)" },
  { id: "python", label: "Python", hint: "python3, or python" },
];

const INTERPRETER_IDS = new Set<string>(INTERPRETERS.map((i) => i.id));
export function isInterpreter(v: unknown): v is Interpreter {
  return typeof v === "string" && INTERPRETER_IDS.has(v);
}

/** The interpreter a new task defaults to, by platform (the host shell). */
export const DEFAULT_INTERPRETER: Interpreter = isWindows ? "powershell" : "bash";

/** Guess the interpreter for an existing script from its file extension — used
 *  to pre-select the dropdown when the user picks a file. Returns null when the
 *  extension isn't recognized (the user picks manually). */
export function interpreterForExt(path: string): Interpreter | null {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "ps1":
      return "powershell";
    case "cmd":
    case "bat":
      return "cmd";
    case "sh":
      return "bash";
    case "zsh":
      return "zsh";
    case "mjs":
    case "cjs":
    case "js":
      return "node";
    case "py":
      return "python";
    default:
      return null;
  }
}

/** Where a task's script comes from: an existing file in the repo (run live, in
 *  place) or an inline body saved with the task. */
export type TaskSource =
  | { kind: "file"; path: string }
  | { kind: "inline"; body: string };

/** One documented argument a task's script accepts — `--help`-style reference
 *  shown while editing args and in the run dialog. Documentation only; what
 *  actually gets passed is the args string. */
export interface ArgDoc {
  /** The flag/argument as typed, e.g. `--preview`. */
  arg: string;
  /** What it does, one line. */
  description: string;
}

/**
 * A registered runnable task (a saved script). Definitions live in app-data only
 * (`scripts.json`), never read from repository content — so a cloned or malicious
 * repo can never plant a task that GitDesktop would run. (A `file` task points at a
 * script in the repo; it's the user's own choice and only runs when they start it.)
 */
export interface TaskDef {
  /** Stable id (uuid) — list key and run identity. */
  id: string;
  /** Display name, e.g. "Release". */
  name: string;
  /** One-line summary of what the task does — shown on the row, in the run
   *  picker, and in the run dialog. Empty = none. */
  description: string;
  /** Which interpreter runs the script. */
  interpreter: Interpreter;
  /** File (an existing script, run in place) or inline (a body saved here). Both
   *  run in the current repo's directory. */
  source: TaskSource;
  /** Extra arguments passed to the script (e.g. `--preview`), as the user typed
   *  them; split to argv at run time by {@link parseArgs}. Empty = none. The run
   *  dialog can adjust these per run (this string stays the saved default). */
  args: string;
  /** `--help`-style documentation of the arguments the script accepts. Reference
   *  only — shown in the editor and the run dialog. Empty = undocumented. */
  argDocs: ArgDoc[];
  /** Confirm before each run. Defaults on; a trusted, frequently-run task can turn
   *  it off in its editor. */
  confirmBeforeRun: boolean;
}

/**
 * Splits a task's argument string into an argv array, respecting single/double
 * quotes so `--message "hello world"` is two args, not three. Deliberately does
 * NOT interpret shell metacharacters (globs, `$VAR`, pipes) — the args go straight
 * to the process as argv, never through a shell, matching the app's argv-only norm.
 */
export function parseArgs(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const c of input) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === " " || c === "\t" || c === "\n") {
      if (started) {
        out.push(cur);
        cur = "";
        started = false;
      }
    } else {
      cur += c;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

/**
 * The `scripts.json` store shape. `enabled` is the one-time consent to run tasks
 * at all (off until the user opts in); `tasks` is a list shared across every repo
 * (per-repo scoping is a later phase).
 */
export interface ScriptsConfig {
  schemaVersion: 1;
  enabled: boolean;
  tasks: TaskDef[];
}

export const EMPTY_SCRIPTS: ScriptsConfig = {
  schemaVersion: 1,
  enabled: false,
  tasks: [],
};
