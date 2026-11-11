// Import-free on purpose: scripts/open-claims.test.mjs imports this file
// straight from src/ under Node's type stripping, which resolves no aliases.

/**
 * Request order across the repo opens one owner makes, checked together with an
 * interaction epoch. Recents writes serialize, so an earlier open would otherwise
 * land first and retire the newer one through the epoch check; numbering the
 * requests keeps the latest the winner. Every request takes its place from one
 * counter, and `latest` is the place of the newest CLAIMED one, so a reserved
 * place that never claims retires nothing. Opens made outside it aren't
 * numbered: they retire pending ones through the epoch instead.
 */
export function createOpenClaims(getEpoch: () => number) {
  let issued = 0;
  let latest = 0;
  return {
    /** Claims an open at its REQUEST: the check passes only while no newer open
     *  was claimed and the epoch hasn't moved. */
    claim: (): (() => boolean) => {
      const request = ++issued;
      latest = request;
      const epoch = getEpoch();
      return () => request === latest && getEpoch() === epoch;
    },
    /** Takes a place at the REQUEST without claiming it, for a request that may
     *  turn out to be no open. Calling the result claims that place: null once a
     *  newer open was claimed or the epoch moved since the reservation, else the
     *  check `claim` returns, which retires every older claim. */
    reserve: (): (() => (() => boolean) | null) => {
      const request = ++issued;
      const epoch = getEpoch();
      return () => {
        if (latest > request || getEpoch() !== epoch) return null;
        latest = request;
        return () => request === latest && getEpoch() === epoch;
      };
    },
    /** Detects a newer open or navigation WITHOUT claiming one, for a caller
     *  whose wait may end in something other than an open. */
    watermark: (): (() => boolean) => {
      const seen = latest;
      const epoch = getEpoch();
      return () => latest === seen && getEpoch() === epoch;
    },
    /** Claims an open at its REQUEST, ignoring the epoch: the check fails only
     *  once a newer open is claimed, for a caller whose wait a re-selection of
     *  its own row must not retire. */
    claimOrder: (): (() => boolean) => {
      const request = ++issued;
      latest = request;
      return () => request === latest;
    },
  };
}
