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
