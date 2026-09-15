import { pathIsDir } from "@/lib/git/api";
import { peekRepoIdentity, repoIdentity } from "@/lib/git/repo-identity";
import { notify, notifyIfUnfocused } from "@/lib/notify";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  type NotificationOutcome,
  type NotificationSource,
  type OutcomeSource,
} from "@/lib/settings/api";
import {
  AI_NOTIFICATION_KINDS,
  DEDUPE_WINDOW_MS,
  pushNotification,
} from "@/lib/stores/notifications";
import { deliveredChannels, overrideForRepo } from "./overrides";

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

/** How long the identity stamp may hold up a delivery before the row ships without
 *  one — the stamp is an optimization for the click-through, never a precondition. */
const IDENTITY_STAMP_TIMEOUT_MS = 1_500;

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
export function emitNotification(
  input:
    | {
        source: OutcomeSource;
        /** Compulsory by type, which is why a CI producer cannot forget to hand
         *  the outcome filter the class it needs. */
        outcome: NotificationOutcome;
        row: Parameters<typeof pushNotification>[0];
        os?: EmitOsPing;
      }
    | {
        source: Exclude<NotificationSource, OutcomeSource>;
        /** No outcome axis — `never` so passing one is a compile error rather than
         *  a field the gate silently ignores. */
        outcome?: never;
        row: Parameters<typeof pushNotification>[0];
        os?: EmitOsPing;
      },
): void {
  const { source, row, os, outcome } = input;
  // Producer keys vary: most are repo-unqualified (`opened:42`), a few already
  // embed the path (harmlessly duplicated here), so isolation rests on THIS
  // uniform prefix, not the producer — and the inbox gets the key we claimed.
  const dedupeKey = row.dedupeKey
    ? `${source}:${row.repoPath}:${row.dedupeKey}`
    : undefined;
  // Claimed before the first await, so two same-tick fires of one transition can't
  // both get through and double-deliver on BOTH channels.
  const claimedAt = Date.now();
  if (dedupeKey && seenRecently(dedupeKey, claimedAt)) return;
  void (async () => {
    // Probe THEN resolve, bounded as a unit: the liveness check gates the resolve
    // (resolving a DEAD path caches the raw-path fallback for the session, under
    // the key every identity-keyed store reads), and both live on the timed side
    // so a hung mount delays neither the inbox row nor the OS ping. Every arm that
    // skips the resolver still PEEKS the memo — read-only, so no poisoning — because
    // a repo muted under its identity key must stay muted once its checkout is gone.
    let stampTimer: ReturnType<typeof setTimeout> | undefined;
    const knownIdentity = () => peekRepoIdentity(row.repoPath) ?? row.repoPath;
    const [settings, identity] = await Promise.all([
      loadSettings().catch(() => DEFAULT_SETTINGS),
      Promise.race([
        (async () => {
          const live = await pathIsDir(row.repoPath).catch(() => false);
          return live ? repoIdentity(row.repoPath) : knownIdentity();
        })(),
        new Promise<string>((resolve) => {
          stampTimer = setTimeout(
            () => resolve(knownIdentity()),
            IDENTITY_STAMP_TIMEOUT_MS,
          );
        }),
      ]).finally(() => clearTimeout(stampTimer)),
    ]);
    // A cold-cache dead path, hung probe, or unresolvable repo all answer the raw
    // path, and an absent stamp is the honest answer for each: a checkout path
    // posing as an identity key would mislead the click-time ladder.
    const repoId = identity === row.repoPath ? undefined : identity;
    // Sequenced after the race so the lookup reuses that key instead of resolving a
    // second time; a raw path here reads the legacy override key only and never
    // reaches the resolver. Costs this read the race's bound, and — on a cold
    // memo — the identity key itself: a mute stored under the identity is missed
    // for that one event, the price of never blocking delivery on a hung mount.
    const override = await overrideForRepo(row.repoPath, identity).catch(
      () => undefined,
    );
    // The kind rides along for every source; the seam scopes it to the one source
    // that carries a kind axis.
    const channels = deliveredChannels(
      settings.notifications,
      override,
      source,
      outcome,
      row.kind,
    );
    if (channels.inApp) {
      pushNotification({
        ...row,
        ...(dedupeKey ? { dedupeKey } : {}),
        ...(repoId ? { repoId } : {}),
      });
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
