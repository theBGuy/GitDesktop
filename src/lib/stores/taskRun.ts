import { toast } from "sonner";
import { create } from "zustand";
import {
  openTaskInTerminal,
  TASKS_USE_EXTERNAL_TERMINAL,
} from "@/lib/scripts/launch";
import type { TaskDef } from "@/lib/scripts/types";
import { useUiStore } from "@/lib/stores/ui";

export type RunStatus = "running" | "exited";

/** The one task currently shown in the run pane (v1 has a single run slot). */
export interface ActiveRun {
  task: TaskDef;
  /** The arguments THIS run was started with — the task's saved string, or the
   *  per-run adjustment made in the run dialog. Rerun reuses these. */
  args: string;
  /** Bumped on every (re)run so the run terminal remounts with a fresh PTY. */
  token: number;
  status: RunStatus;
  /** Exit code once `status === "exited"` (null = unknown / killed / spawn error). */
  code: number | null;
}

/** A run awaiting the user's confirmation. `confirm` = the task's own
 *  confirm-before-run; `replace` = a task is already running. */
export interface PendingRun {
  task: TaskDef;
  reason: "confirm" | "replace";
}

interface TaskRunState {
  activeRun: ActiveRun | null;
  pending: PendingRun | null;
  /** Ask to run `task`: runs immediately, or opens the run dialog (its own
   *  confirm-before-run, or replacing a still-running task). Always the entry
   *  point — panel Run, Enter, and the palette picker all funnel through here. */
  request: (task: TaskDef) => void;
  /** The user confirmed the pending run → start it with `args` (the dialog's
   *  possibly-adjusted argument string; the saved task is untouched). */
  confirmPending: (args: string) => void;
  cancelPending: () => void;
  /** Re-run the task currently in the pane with the same args (no confirm —
   *  explicit, same task, same arguments). */
  rerun: () => void;
  /** Mark the run for `token` exited. Guards on the token so a stale terminal's
   *  late exit can't clobber a newer run. */
  markExited: (token: number, code: number | null) => void;
  clear: () => void;
}

/** Actually start (or restart) a run and switch to the Tasks tab so its output is
 *  visible. Kept internal so every caller goes through `request`.
 *
 *  On Windows under `pnpm tauri dev` the in-app PTY can't spawn, so the run is
 *  handed to an external terminal instead (see {@link TASKS_USE_EXTERNAL_TERMINAL})
 *  — no in-app run row is created there. */
function begin(
  set: (fn: (s: TaskRunState) => Partial<TaskRunState>) => void,
  task: TaskDef,
  args: string,
) {
  set(() => ({ pending: null }));
  // The literal `import.meta.env.DEV` guard (not just the imported flag) is what
  // lets a production build statically drop this whole branch — and with it every
  // reference to the dev-only external-terminal fallback (verified by grepping
  // the built chunks; the imported const alone doesn't fold reliably).
  if (import.meta.env.DEV && TASKS_USE_EXTERNAL_TERMINAL) {
    // Silent hand-off: the terminal window opening IS the feedback. Only a
    // failed spawn surfaces.
    const cwd = useUiStore.getState().repoPath;
    if (cwd) {
      openTaskInTerminal(task, cwd, args).catch((e) => toast.error(String(e)));
    }
    return;
  }
  set((s) => ({
    activeRun: {
      task,
      args,
      token: (s.activeRun?.token ?? 0) + 1,
      status: "running",
      code: null,
    },
  }));
  useUiStore.getState().setRepoTab("tasks");
}

export const useTaskRunStore = create<TaskRunState>((set, get) => ({
  activeRun: null,
  pending: null,
  request: (task) => {
    const running = get().activeRun?.status === "running";
    if (running) {
      set(() => ({ pending: { task, reason: "replace" } }));
    } else if (task.confirmBeforeRun) {
      set(() => ({ pending: { task, reason: "confirm" } }));
    } else {
      // No dialog → the saved arguments run as-is.
      begin(set, task, task.args);
    }
  },
  confirmPending: (args) => {
    const p = get().pending;
    if (p) begin(set, p.task, args);
  },
  cancelPending: () => set(() => ({ pending: null })),
  rerun: () => {
    const cur = get().activeRun;
    if (cur) begin(set, cur.task, cur.args);
  },
  markExited: (token, code) =>
    set((s) =>
      s.activeRun &&
      s.activeRun.token === token &&
      s.activeRun.status === "running"
        ? { activeRun: { ...s.activeRun, status: "exited", code } }
        : {},
    ),
  clear: () => set(() => ({ activeRun: null })),
}));

/** The PTY id for a run — unique per (task, run) so a rerun gets a fresh PTY. */
export function taskPtyId(run: ActiveRun): string {
  return `task:${run.task.id}:${run.token}`;
}
