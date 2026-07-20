import { useSyncExternalStore } from "react";
import { formatDuration } from "@/lib/time";
import { cn } from "@/lib/utils";

// All mounted elapsed counters compute from ONE shared snapshot, refreshed every
// second, so simultaneously-mounted rows tick in lockstep (the point of a shared
// ticker) — and the React Compiler memoizes each row's output, so a bare
// `Date.now()` read in render is invisible to it and the elapsed would freeze at
// mount time. Threading `now` through useSyncExternalStore keeps the memo key
// aware of the clock. The interval runs ONLY while at least one counter is
// mounted (started at 0→1 subscribers, cleared at 1→0).
const TICK_MS = 1000;
let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function refresh() {
  now = Date.now();
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (timer === null) {
    // Going 0→1 subscribers: the snapshot may be stale from an idle spell —
    // refresh once so the first mounted counter starts from real now.
    timer = setInterval(refresh, TICK_MS);
    refresh();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const getNow = () => now;

/** Live, ticking elapsed time since an epoch-ms instant, rendered as a compact
 *  duration ("42s", "3m 12s"). `tabular-nums` keeps the width steady as it
 *  ticks. Mount one only while the underlying run is actually in progress. */
export function ElapsedTime({
  since,
  className,
}: {
  since: number;
  className?: string;
}) {
  const nowMs = useSyncExternalStore(subscribe, getNow);
  return (
    <span className={cn("tabular-nums", className)}>
      {formatDuration(nowMs - since)}
    </span>
  );
}
