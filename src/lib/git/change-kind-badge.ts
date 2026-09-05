import type { ChangeKind } from "./types";

/** The status letter, screen-reader label, and colour token per change kind.
 *  Shared so the Changes list and the commit dialog's staged summary read the
 *  same letter and colour for the same file. */
export const KIND_BADGE: Record<
  ChangeKind,
  { letter: string; label: string; className: string }
> = {
  added: { letter: "A", label: "Added", className: "text-success" },
  untracked: { letter: "U", label: "Untracked", className: "text-success" },
  modified: { letter: "M", label: "Modified", className: "text-warning" },
  typechange: { letter: "T", label: "Type changed", className: "text-warning" },
  deleted: { letter: "D", label: "Deleted", className: "text-destructive" },
  renamed: { letter: "R", label: "Renamed", className: "text-info" },
  copied: { letter: "C", label: "Copied", className: "text-info" },
  conflicted: {
    letter: "!",
    label: "Conflicted",
    className: "text-destructive",
  },
};
