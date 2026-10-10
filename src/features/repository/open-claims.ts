// Import-free on purpose: scripts/open-claims.test.mjs imports this file
// straight from src/ under Node's type stripping, which resolves no aliases.

/**
 * Request order across the repo opens one owner makes, checked together with an
 * interaction epoch. Recents writes serialize, so an earlier open would otherwise
 * land first and retire the newer one through the epoch check; numbering the
 * requests keeps the latest the winner. Opens made outside it aren't numbered:
 * they retire pending ones through the epoch instead.
 */
export function createOpenClaims(getEpoch: () => number) {
  let latest = 0;
  return {
    /** Claims an open at its REQUEST: the check passes only while no newer open
     *  was requested and the epoch hasn't moved. */
    claim: (): (() => boolean) => {
      const request = ++latest;
      const epoch = getEpoch();
      return () => request === latest && getEpoch() === epoch;
    },
    /** Detects a newer open or navigation WITHOUT claiming one, for a caller
     *  whose wait may end in something other than an open. */
    watermark: (): (() => boolean) => {
      const seen = latest;
      const epoch = getEpoch();
      return () => latest === seen && getEpoch() === epoch;
    },
  };
}
