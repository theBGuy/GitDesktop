/** The markers the Code TODOs scan looks for, case-sensitive. NOTE/OPTIMIZE are
 *  deliberately excluded as too noisy. Order here drives the toolbar chip order. */
export const DEFAULT_MARKERS = ["TODO", "FIXME", "HACK", "BUG", "XXX"] as const;

/** Global cap on scan hits — passed explicitly as `maxHits` so the "truncated"
 *  banner's count and the backend cap can't silently drift (mirrors the Rust
 *  `DEFAULT_MAX_HITS`). */
export const TODO_SCAN_CAP = 2000;

export type Marker = (typeof DEFAULT_MARKERS)[number];

/** Semantic text tint per marker — meaning always carried by the marker WORD
 *  itself (never color alone). Uses only semantic state tokens, never raw
 *  palette colors. Unknown markers fall through to muted. */
export function markerTint(marker: string): string {
  switch (marker) {
    case "BUG":
      return "text-destructive";
    case "FIXME":
      return "text-warning";
    case "TODO":
      return "text-info";
    default:
      // Everything else (the muted markers, e.g. HACK, XXX).
      return "text-muted-foreground";
  }
}

/** Last path segment (basename) of a forward-slash repo-relative path. */
export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
