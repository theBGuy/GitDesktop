// Import-free on purpose: `scripts/confirm-successors.test.mjs` loads this
// file directly under node's type stripping, with fake elements.

/** What a confirm-swap successor search reads from the DOM, captured by the
 *  caller so the candidate order is testable without one. */
export interface SuccessorView<T> {
  /** The section's `data-confirm-row` elements in DOM order; empty when the
   *  leaving node had no row or no section. */
  rows: T[];
  /** The rows before the leaving row, nearest first. */
  before: T[];
  connected: (el: T) => boolean;
  /** A row's swap stops: the row itself when it is marked one, then its marked
   *  descendants, in DOM order. */
  stopsOf: (row: T) => T[];
  /** False when no section was found or it left the document. */
  sectionConnected: boolean;
  /** The section's `data-confirm-fallback` controls, even when detached. */
  sectionFallbacks: T[];
  /** The host's `data-confirm-fallback` controls; read only while the section
   *  is gone, so a section that survives keeps the search inside itself. */
  hostFallbacks: T[];
  host: T | null;
}

/** A row's swap stops for {@link SuccessorView.stopsOf}: the row itself only
 *  when it carries the marker literally (opt-in), then its marked descendants. */
export function rowSwapStops<T>(row: T, rowIsStop: boolean, marked: T[]): T[] {
  return rowIsStop ? [row, ...marked] : marked;
}

/**
 * Every successor candidate in the order the caller tries them: the rows after
 * the removed one, then the earlier rows nearest first, then the section's
 * fallbacks, then (section gone) the host's fallbacks, then the host itself.
 */
export function successorCandidates<T>(v: SuccessorView<T>): T[] {
  // The nearest surviving earlier row marks the removed row's place, so a row
  // re-keyed into that place counts as the next one.
  const anchor = v.before.find(v.connected);
  const at = anchor === undefined ? 0 : v.rows.indexOf(anchor) + 1;
  const ordered = [...v.rows.slice(at), ...v.rows.slice(0, at).reverse()];
  const out = ordered.flatMap(v.stopsOf);
  out.push(...v.sectionFallbacks);
  if (!v.sectionConnected) out.push(...v.hostFallbacks);
  if (v.host !== null) out.push(v.host);
  return out;
}
