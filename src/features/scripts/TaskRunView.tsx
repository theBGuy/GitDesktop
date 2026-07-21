import {
  ArrowClockwiseIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  PlayCircleIcon,
  StopIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Suspense, lazy } from "react";
import { Button } from "@/components/ui/button";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import { ptyClose } from "@/lib/pty";
import { INTERPRETERS, parseArgs } from "@/lib/scripts/types";
import { useTaskRunStore } from "@/lib/stores/taskRun";
import { taskPtyId } from "@/lib/stores/taskRun";
import { useUiStore } from "@/lib/stores/ui";

// Reuse the interactive PTY terminal (xterm + Rust PTY). Lazy so its chunk loads
// with the first run rather than on boot.
const Terminal = lazy(() =>
  import("@/features/terminal/Terminal").then((m) => ({ default: m.Terminal })),
);

const INTERPRETER_LABELS: Record<string, string> = Object.fromEntries(
  INTERPRETERS.map((i) => [i.id, i.label]),
);

export function TaskRunView() {
  const repoPath = useUiStore((s) => s.repoPath);
  const activeRun = useTaskRunStore((s) => s.activeRun);
  const rerun = useTaskRunStore((s) => s.rerun);
  const markExited = useTaskRunStore((s) => s.markExited);
  const clear = useTaskRunStore((s) => s.clear);

  if (!activeRun || !repoPath) {
    return (
      <DiffPlaceholder
        icon={PlayCircleIcon}
        message="Run a task to see its output here"
      />
    );
  }

  const { task, status, code, token } = activeRun;
  const ptyId = taskPtyId(activeRun);
  const running = status === "running";
  const succeeded = status === "exited" && code === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2 text-xs">
        <span className="shrink-0 truncate font-medium">{task.name}</span>
        {task.source.kind === "file" && (
          <span
            className="min-w-0 truncate font-mono text-[10px] text-muted-foreground"
            title={task.source.path}
          >
            {task.source.path}
          </span>
        )}
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {INTERPRETER_LABELS[task.interpreter] ?? task.interpreter}
        </span>

        {/* Status — icon + text, never color alone (WCAG AA). */}
        {running ? (
          <span className="flex items-center gap-1 text-muted-foreground">
            <CircleNotchIcon className="size-3.5 animate-spin" />
            Running
          </span>
        ) : succeeded ? (
          <span className="flex items-center gap-1 text-success">
            <CheckCircleIcon className="size-3.5" />
            Exited · 0
          </span>
        ) : (
          <span className="flex items-center gap-1 text-destructive">
            <WarningCircleIcon className="size-3.5" />
            {code === null ? "Stopped" : `Exited · ${code}`}
          </span>
        )}

        <span className="flex-1" />

        {running ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => ptyClose(ptyId).catch(() => undefined)}
            title="Stop the running task"
          >
            <StopIcon data-icon="inline-start" />
            Stop
          </Button>
        ) : (
          <>
            <Button
              size="xs"
              variant="ghost"
              onClick={rerun}
              title="Run this task again"
            >
              <ArrowClockwiseIcon data-icon="inline-start" />
              Rerun
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              className="text-muted-foreground"
              onClick={clear}
              title="Clear the run"
              aria-label="Clear the run"
            >
              <XIcon />
            </Button>
          </>
        )}
      </div>

      <Suspense fallback={null}>
        <Terminal
          key={ptyId}
          ptyId={ptyId}
          kind="task"
          cwd={repoPath}
          ports={[]}
          interpreter={task.interpreter}
          body={task.source.kind === "inline" ? task.source.body : undefined}
          path={task.source.kind === "file" ? task.source.path : undefined}
          args={parseArgs(task.args)}
          onExit={(c) => markExited(token, c)}
          className="min-h-0 flex-1 px-1 pb-1"
        />
      </Suspense>
    </div>
  );
}
