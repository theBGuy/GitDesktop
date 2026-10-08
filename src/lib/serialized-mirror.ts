// No runtime imports: scripts/serialized-mirror.test.mjs imports this file
// through Node's type stripping, which resolves no aliases.

/**
 * Mirrors a value into a backend through `push`, which may be an async command
 * whose calls the backend can complete out of order. Pushes are serialized, so
 * the backend always converges to the latest value: at most one is in flight,
 * later values coalesce to the newest, and a settle pushes again whenever that
 * newest value isn't the one confirmed landed.
 *
 * Returns the setter. Call it as often as convenient, since a value equal to
 * the confirmed or in-flight one sends nothing. A failed push forgets what had
 * landed and is retried by the next call, never in a loop, so a backend that
 * keeps rejecting costs one push per call.
 */
export function serializedMirror<T>(
  push: (value: T) => Promise<unknown>,
): (value: T) => void {
  let confirmed: { value: T } | undefined;
  let desired: { value: T } | undefined;
  let inFlight = false;
  let calls = 0;

  function pump() {
    if (inFlight || desired === undefined) return;
    if (confirmed !== undefined && Object.is(confirmed.value, desired.value))
      return;
    const { value } = desired;
    const sentAt = calls;
    inFlight = true;
    // Wrapped so a synchronous throw settles as a rejection, never leaving the
    // mirror stuck in flight.
    new Promise((resolve) => resolve(push(value))).then(
      () => {
        confirmed = { value };
        inFlight = false;
        pump();
      },
      () => {
        confirmed = undefined;
        inFlight = false;
        if (calls !== sentAt) pump();
      },
    );
  }

  return (value) => {
    calls += 1;
    desired = { value };
    pump();
  };
}
