import {
  ArrowsMergeIcon,
  CircleIcon,
  FileDashedIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  type Icon,
  XCircleIcon,
} from "@phosphor-icons/react";
import type { ForgeProvider } from "@/lib/git/types";

// A leaf on purpose: the markdown ref card draws from this too, and the issue
// module reaches markdown, so a home under issues/ would close an import cycle.

interface PrStatePresentation {
  Icon: Icon;
  tone: string;
  /** State AND kind as words: what carries the state, since colour never may. */
  word: string;
}

/** The kind half of `word`: GitLab calls its change requests merge requests. */
export type PrNoun = "pull request" | "merge request";

/** What each forge calls a pull request (plural as `${PR_NOUN[provider]}s`). */
export const PR_NOUN: Record<ForgeProvider, PrNoun> = {
  github: "pull request",
  gitlab: "merge request",
  bitbucket: "pull request",
};

/**
 * The one PR-state table every surface draws from. Each arm carries its own
 * SHAPE so no two states differ by colour alone. CLOSED is XCircle + destructive
 * because a closed pull request is abandoned where a closed issue is resolved
 * (the issue `StateIcon`), and no shape reuses an issue glyph since boards mix both.
 */
const PR_STATE: Partial<
  Record<
    string,
    Omit<PrStatePresentation, "word"> & {
      label: string;
      /** Overrides the `${label} ${noun}` word where that reads as an action. */
      word?: (noun: PrNoun) => string;
    }
  >
> = {
  OPEN: { Icon: GitPullRequestIcon, tone: "text-success", label: "Open" },
  MERGED: { Icon: GitMergeIcon, tone: "text-merged", label: "Merged" },
  CLOSED: { Icon: XCircleIcon, tone: "text-destructive", label: "Closed" },
  // GitLab's mid-merge `locked`: a merge in progress, which can also end with the
  // MR still open. It shares the merged tone as the outcome it is working toward;
  // its glyph and word carry the difference.
  MERGING: {
    Icon: ArrowsMergeIcon,
    tone: "text-merged",
    label: "Merging",
    word: (noun) => `${noun[0].toUpperCase()}${noun.slice(1)} being merged`,
  },
};

/** A state's badge word: a known state's label lower-cased, else the forge's own
 *  state lower-cased. */
export function prStateWord(state: string): string {
  return (PR_STATE[state]?.label ?? state).toLowerCase();
}

/** Draft qualifies an OPEN pull request only, and takes `FileDashed` because the
 *  dashed circle is the open-issue glyph. A state this build doesn't know keeps a
 *  shape of its own and the forge's word, never "open"'s glyph at another tone. */
export function prPill(
  state: string,
  isDraft: boolean,
  noun: PrNoun = "pull request",
): PrStatePresentation {
  if (isDraft && state === "OPEN")
    return {
      Icon: FileDashedIcon,
      tone: "text-muted-foreground",
      word: `Draft ${noun}`,
    };
  const known = Object.hasOwn(PR_STATE, state) ? PR_STATE[state] : undefined;
  if (known === undefined)
    return {
      Icon: CircleIcon,
      tone: "text-muted-foreground",
      word: `${state} ${noun}`,
    };
  return {
    Icon: known.Icon,
    tone: known.tone,
    word: known.word?.(noun) ?? `${known.label} ${noun}`,
  };
}

/** The glyph per pull-request audit state (the branch switcher's and the
 *  session strip's chips), derived from `prPill` so the two vocabularies can't
 *  drift. Its own union: this module imports nothing from the audit layer. */
export const PR_AUDIT_ICON: Record<
  "open" | "draft" | "merged" | "closed",
  Icon
> = {
  open: prPill("OPEN", false).Icon,
  draft: prPill("OPEN", true).Icon,
  merged: prPill("MERGED", false).Icon,
  closed: prPill("CLOSED", false).Icon,
};
