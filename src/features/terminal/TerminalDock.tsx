import {
  ArrowClockwiseIcon,
  TerminalWindowIcon,
  XIcon,
} from "@phosphor-icons/react";
import { lazy, Suspense, useState } from "react";
import { LazyPanelFallback } from "@/components/lazy-panel-fallback";
import { Button } from "@/components/ui/button";
import type { AgentSession } from "@/features/sessions/store";

// Lazy-load the terminal so xterm.js and its CSS stay off the startup bundle and
// load only the first time a session actually opens a shell. TerminalDock itself
// (and its cheap `if (!launch) return null` gate) stays eager so sessions that
// never launch a terminal pull in none of that graph.
const Terminal = lazy(() =>
  import("./Terminal").then((m) => ({ default: m.Terminal })),
);

// Persist the dock height across open/close within a session (not across restart).
let lastHeight = 260;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 640;

/** The launch the dock should render: which ports to publish (container only) and a
 *  `token` that, when bumped, remounts the terminal for a fresh shell / reconnect.
 *  `null` means nothing has been launched yet, so the dock renders nothing. */
export type TerminalLaunch = { ports: string[]; token: number };

/**
 * The integrated-terminal bottom dock for a session — a resizable, collapsible
 * panel that holds one {@link Terminal}. It's a *controlled* renderer: the parent
 * owns the launch (a host shell launches immediately; a container shell launches
 * from the Terminal button's port popover, so ports are chosen before the
 * container spins up) and the open/collapse state. Once launched the terminal
 * stays **mounted** and is merely collapsed to height 0 when hidden, so a
 * long-running command (a dev server) survives toggling the dock. `onRestart`
 * re-runs the shell (reconnecting into a still-up container); `onStop` tears the
 * container down (container sessions only).
 */
export function TerminalDock({
  session,
  open,
  onOpenChange,
  launch,
  onRestart,
  onStop,
}: {
  session: AgentSession;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  launch: TerminalLaunch | null;
  onRestart: () => void;
  onStop: () => void;
}) {
  const [height, setHeight] = useState(lastHeight);

  // Nothing launched yet → render nothing (the parent's port popover gates a
  // container launch; a host launch is immediate).
  if (!launch) return null;

  const isContainer = session.isolation === "container";

  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(
        MAX_HEIGHT,
        Math.max(MIN_HEIGHT, startH + (startY - ev.clientY)),
      );
      setHeight(next);
      lastHeight = next;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const termKey = `${session.id}:${launch.token}`;

  return (
    <div
      className="flex shrink-0 flex-col overflow-hidden border-t bg-background"
      style={{ height: open ? height : 0 }}
    >
      {/* Drag-to-resize handle along the top edge. */}
      <div
        onMouseDown={onResizeStart}
        className="h-1 shrink-0 cursor-row-resize bg-border/60 transition-colors hover:bg-primary/50"
      />
      <div className="flex shrink-0 items-center gap-1.5 px-2 py-1 text-[11px]">
        <TerminalWindowIcon className="size-3.5 text-muted-foreground" />
        <span className="font-medium">Terminal</span>
        <span className="text-muted-foreground">
          {isContainer ? "· container" : "· worktree"}
        </span>
        {isContainer && launch.ports.length > 0 && (
          <span
            className="font-mono text-muted-foreground"
            title="Published ports"
          >
            {launch.ports.join(" ")}
          </span>
        )}
        <Button
          size="icon-xs"
          variant="ghost"
          className="ml-1"
          onClick={onRestart}
          title={
            isContainer ? "Restart / reconnect the shell" : "Restart the shell"
          }
          aria-label={
            isContainer ? "Restart or reconnect the shell" : "Restart the shell"
          }
        >
          <ArrowClockwiseIcon />
        </Button>
        {isContainer && (
          <Button
            size="xs"
            variant="ghost"
            onClick={onStop}
            title="Stop the container (frees its ports)"
          >
            Stop
          </Button>
        )}
        <Button
          size="icon-xs"
          variant="ghost"
          className="ml-auto text-muted-foreground"
          onClick={() => onOpenChange(false)}
          title="Hide the terminal (toggle with the terminal hotkey)"
          aria-label="Hide terminal"
        >
          <XIcon />
        </Button>
      </div>
      <Suspense
        fallback={
          <LazyPanelFallback
            name="the terminal"
            className="min-h-0 flex-1 p-1"
          />
        }
      >
        <Terminal
          key={termKey}
          ptyId={termKey}
          kind={isContainer ? "container" : "host"}
          cwd={session.worktreePath}
          ports={launch.ports}
          className="min-h-0 flex-1 px-1 pb-1"
        />
      </Suspense>
    </div>
  );
}
