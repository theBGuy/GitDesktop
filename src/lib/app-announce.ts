/** One polite app-level status message, read by `<AppAnnouncer />` (mounted in
 *  App beside the confirm host). It outlives any view's own live region, so a
 *  landing that switches repository can still be heard after the switch. */

type Snapshot = { text: string; seq: number };

let snapshot: Snapshot = { text: "", seq: 0 };
const listeners = new Set<() => void>();

/** Speak `text` politely. Every call replaces the snapshot object and bumps
 *  `seq`, so an identical text still changes the region and announces again. */
export function announceApp(text: string): void {
  snapshot = { text, seq: snapshot.seq + 1 };
  for (const fn of listeners) fn();
}

export function subscribeAppAnnouncement(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The same object until the next `announceApp`: a stable
 *  `useSyncExternalStore` snapshot. */
export function appAnnouncementSnapshot(): Snapshot {
  return snapshot;
}
