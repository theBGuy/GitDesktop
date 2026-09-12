import { notify, notifyIfUnfocused } from "@/lib/notify";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  type NotificationSource,
} from "@/lib/settings/api";
import {
  AI_NOTIFICATION_KINDS,
  DEDUPE_WINDOW_MS,
  pushNotification,
} from "@/lib/stores/notifications";
import { effectiveChannels, overrideForRepo } from "./overrides";

export interface EmitOsPing {
  title: string;
  body?: string;
  /** "unfocused" → notifyIfUnfocused; "always" → notify (agent surfaces ping
   *  even focused — you may be watching a different session). */
  focus: "unfocused" | "always";
}

/** When each `source:repoPath:producerKey` last claimed the window. Held here rather
 *  than left to the inbox's own dedupe because that one can only suppress the row,
 *  never the OS ping. A key is claimed synchronously and RELEASED again if the gates
 *  end up delivering nothing, so a suppressed no-op can't shadow the next event. */
const lastEmit = new Map<string, number>();
/** Bound on a long session's key churn; the oldest delivered key is evicted first
 *  (insertion order tracks delivery time, since every write re-inserts). */
const MAX_DEDUPE_KEYS = 500;

/** Check-and-set, synchronous by contract: two same-tick fires must not both pass
 *  the window. True = this key already holds the window and is suppressed. */
function seenRecently(key: string, now: number): boolean {
  const last = lastEmit.get(key);
  if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return true;
  for (const [k, ts] of lastEmit) {
    if (now - ts >= DEDUPE_WINDOW_MS) lastEmit.delete(k);
  }
  lastEmit.delete(key);
  lastEmit.set(key, now);
  while (lastEmit.size > MAX_DEDUPE_KEYS) {
    const oldest = lastEmit.keys().next().value;
    if (oldest === undefined) break;
    lastEmit.delete(oldest);
  }
  return false;
}

/** Hands a claimed window back when the gates delivered nothing, but only if this
 *  call still owns it — a later fire's claim must never be cancelled by an earlier
 *  one settling. */
function releaseDedupeKey(key: string, claimedAt: number): void {
  if (lastEmit.get(key) === claimedAt) lastEmit.delete(key);
}

/**
 * The single gate every notification producer calls: it resolves the source's
 * channels (global settings merged with the repo's override) and delivers the
 * inbox row, the OS ping, or neither. Fire-and-forget: internally async, never
 * throws or rejects — a missed notification must never break the work that fired
 * it.
 *
 * Each read degrades to its own default independently: a failed settings read
 * falls back to DEFAULT_SETTINGS (every channel on, AI unhidden) while a surviving
 * repo override still applies, and a failed override read leaves the user's real
 * global prefs governing. Silence is never the failure mode.
 */
export function emitNotification(input: {
  source: NotificationSource;
  row: Parameters<typeof pushNotification>[0];
  os?: EmitOsPing;
}): void {
  const { source, row, os } = input;
  // Producer keys are repo-unqualified (`opened:42`), so two repos raising the same
  // event would collapse into one. Qualify ONCE here and pass the same key down, so
  // the inbox backstop dedupes on exactly what this register claimed.
  const dedupeKey = row.dedupeKey
    ? `${source}:${row.repoPath}:${row.dedupeKey}`
    : undefined;
  // Claimed before the first await, so two same-tick fires of one transition can't
  // both get through and double-deliver on BOTH channels.
  const claimedAt = Date.now();
  if (dedupeKey && seenRecently(dedupeKey, claimedAt)) return;
  void (async () => {
    const [settings, override] = await Promise.all([
      loadSettings().catch(() => DEFAULT_SETTINGS),
      overrideForRepo(row.repoPath).catch(() => undefined),
    ]);
    const channels = effectiveChannels(
      settings.notifications,
      override,
      source,
    );
    if (channels.inApp) {
      pushNotification(dedupeKey ? { ...row, dedupeKey } : row);
    }
    // Hiding AI features mutes the OS ping for AI-minted kinds — a hidden feature
    // must not tap you on the shoulder — but never the inbox row above, which the
    // dock filters at render time.
    const aiMuted = settings.hideAi && AI_NOTIFICATION_KINDS.has(row.kind);
    const pinged = Boolean(os) && channels.os && !aiMuted;
    if (os && pinged) {
      void (os.focus === "always"
        ? notify(os.title, os.body)
        : notifyIfUnfocused(os.title, os.body));
    }
    // Nothing left the gate, so the window was never really used — hand it back,
    // or a source switched on mid-window would lose its first real event.
    if (dedupeKey && !channels.inApp && !pinged) {
      releaseDedupeKey(dedupeKey, claimedAt);
    }
  })().catch(() => {
    // best-effort — a missed notification must never break the work that fired it
  });
}
