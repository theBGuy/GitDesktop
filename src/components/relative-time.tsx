import { useSyncExternalStore } from "react";
import { formatRelativeTime } from "@/lib/time";

// All mounted timestamps compute from ONE shared snapshot, refreshed every 30s.
// Mutual consistency is the point — two rows mounted at different moments must
// never disagree about the same date (the React Compiler memoizes each row's
// output, and a bare `Date.now()` read is invisible to it, so without a shared,
// explicitly-threaded snapshot every timestamp freezes at its own mount time).
// Ticking every 30s is the bonus.
const TICK_MS = 30_000;
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
    // refresh once so the first mounted timestamp starts from real now.
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

/** The shared 30s clock snapshot, for callers that need the relative string
 *  itself (a `title`/`aria-label` attribute, or a larger composed string) and so
 *  can't render `<RelativeTime>`. Pass it to `formatRelativeTime`'s `now`. */
export function useRelativeNow(): number {
  return useSyncExternalStore(subscribe, getNow);
}

/** Relative timestamp with the absolute local date-time on hover.
 *  Callers keep their own `date &&` guards — pass a non-empty ISO string. */
export function RelativeTime({ date }: { date: string }) {
  const nowMs = useRelativeNow();
  const parsed = new Date(date);
  // An unparseable date renders nothing rather than "in NaN years"
  // (formatRelativeTime's unit walk emits the year unit for NaN) — this is a
  // shared primitive, so don't lean on callers' `date &&` guards alone.
  if (Number.isNaN(parsed.getTime())) return null;
  return (
    <time dateTime={date} title={parsed.toLocaleString()}>
      {formatRelativeTime(date, nowMs)}
    </time>
  );
}
