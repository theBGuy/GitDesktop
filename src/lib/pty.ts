import { Channel } from "@tauri-apps/api/core";
import { invoke } from "@/lib/tauri/invoke";

/** What a terminal runs: a host shell in the worktree, a shell inside the
 *  worktree's Docker/Podman test container (publishing its dev-server ports), or —
 *  for the Tasks feature — a registered script (`interpreter` runs a temp file
 *  holding `body`) in `cwd`. */
export interface PtyOpts {
  kind: "host" | "container" | "task";
  /** The working directory (cwd for host/task; mount + container key for container). */
  cwd: string;
  /** Dev-server ports to publish (container only) — `"5173"` or `"5174:5173"`. */
  ports: string[];
  cols: number;
  rows: number;
  /** Task only: interpreter key (`"powershell"` | `"bash"` | `"node"` | …). */
  interpreter?: string;
  /** Task only, inline source: the script body run by `interpreter` (temp file). */
  body?: string;
  /** Task only, file source: an existing script file to run in place (relative to
   *  `cwd`, or absolute). Takes precedence over `body`. */
  path?: string;
  /** Task only: extra arguments after the script (already split to argv). */
  args?: string[];
}

/** Streamed from a PTY. `output.data` is base64 (binary- and partial-UTF-8-safe);
 *  `exit.code` is the shell's exit status when known. */
export type PtyEvent =
  | { type: "output"; data: string }
  | { type: "exit"; code: number | null };

/** Opens a PTY identified by `id`, streaming its output to `onEvent`. The shell is
 *  killed when `ptyClose(id)` runs (or it exits on its own → an `exit` event). */
export function ptyOpen(
  id: string,
  opts: PtyOpts,
  onEvent: (e: PtyEvent) => void,
): Promise<void> {
  const channel = new Channel<PtyEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("pty_open", { id, opts, onEvent: channel });
}

/** Sends keystrokes (UTF-8) to the PTY. */
export const ptyWrite = (id: string, data: string) =>
  invoke<void>("pty_write", { id, data });

/** Resizes the PTY to the terminal's current grid. */
export const ptyResize = (id: string, cols: number, rows: number) =>
  invoke<void>("pty_resize", { id, cols, rows });

/** Kills the shell and drops the PTY. Idempotent. */
export const ptyClose = (id: string) => invoke<void>("pty_close", { id });
