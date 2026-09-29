import {
  CircleIcon,
  FileDashedIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  type Icon,
  XCircleIcon,
} from "@phosphor-icons/react";

// A leaf on purpose: the markdown ref card draws from this too, and the issue
// module reaches markdown, so a home under issues/ would close an import cycle.

interface PrStatePresentation {
  Icon: Icon;
  tone: string;
  /** State AND kind as words: what carries the state, since colour never may. */
  word: string;
}

/**
 * The one PR-state table every surface draws from. Each arm carries its own
 * SHAPE so no two states differ by colour alone. CLOSED is XCircle + destructive
 * because a closed pull request is abandoned where a closed issue is resolved
 * (the issue `StateIcon`), and no shape reuses an issue glyph since boards mix both.
 */
const PR_STATE: Partial<Record<string, PrStatePresentation>> = {
  OPEN: {
    Icon: GitPullRequestIcon,
    tone: "text-success",
    word: "Open pull request",
  },
  MERGED: {
    Icon: GitMergeIcon,
    tone: "text-merged",
    word: "Merged pull request",
  },
  CLOSED: {
    Icon: XCircleIcon,
    tone: "text-destructive",
    word: "Closed pull request",
  },
};

/** Draft qualifies an OPEN pull request only, and takes `FileDashed` because the
 *  dashed circle is the open-issue glyph. A state this build doesn't know keeps a
 *  shape of its own and the forge's word, never "open"'s glyph at another tone. */
export function prPill(state: string, isDraft: boolean): PrStatePresentation {
  if (isDraft && state === "OPEN")
    return {
      Icon: FileDashedIcon,
      tone: "text-muted-foreground",
      word: "Draft pull request",
    };
  return (
    PR_STATE[state] ?? {
      Icon: CircleIcon,
      tone: "text-muted-foreground",
      word: `${state} pull request`,
    }
  );
}
