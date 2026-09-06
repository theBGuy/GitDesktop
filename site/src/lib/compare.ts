// Shared row machinery for the /compare/ pages. Row states render as WORDS
// ("Yes" / "Partial" / "No"), never color or glyph alone (WCAG); the class
// only shades emphasis on top of the word.

export type State = "yes" | "partial" | "no";

export interface Cell {
  state: State;
  note?: string;
}

export interface Row {
  label: string;
  /** The competitor's cell. */
  them: Cell;
  gd: Cell;
}

export interface Group {
  title: string;
  rows: Row[];
}

export const stateText: Record<State, string> = {
  yes: "Yes",
  partial: "Partial",
  no: "No",
};

export const stateClass: Record<State, string> = {
  yes: "text-ink",
  partial: "text-muted",
  no: "text-faint",
};

// One last-verified date per comparison, read by BOTH the page's hero stamp
// and the /compare/ hub — a re-verify updates it here so the two can't drift.
// Each page's meta description also hand-carries a "verified <Month> <Year>"
// phrase that is NOT derived from this map — update it in the same pass.
export const verifiedOn = {
  "github-desktop": "August 20, 2026",
  sourcetree: "August 24, 2026",
  gitkraken: "August 28, 2026",
  tower: "September 5, 2026",
} as const;

export type CompareSlug = keyof typeof verifiedOn;
