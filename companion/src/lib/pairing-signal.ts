// A tiny module-level signal recording WHEN this browser last paired
// successfully. It exists to defeat a live-found race (see App.tsx's 401→#pair
// redirect): the shell's `["status"]` probe can cache a 401 while the user sits
// on #pair (no cookie yet); on pair-success the shell must NOT bounce back to
// #pair on that STALE 401. The redirect gates on the 401 being newer than this
// timestamp, so a pre-pair 401 can never trigger it.
//
// Module state (not React state) on purpose: it must survive the #pair→#status
// hash navigation and the remount that follows, and it's read once inside an
// effect — no re-render needs to key off it.

let pairedAt = 0;

/** Stamp "just paired now" (called by the Pair screen on success). */
export function markPaired(): void {
  pairedAt = Date.now();
}

/** The epoch-ms of the last successful pair (0 if never). */
export function lastPairedAt(): number {
  return pairedAt;
}
