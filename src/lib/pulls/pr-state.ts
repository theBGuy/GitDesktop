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

/** The kind half of `word`: GitLab calls its change requests merge requests. */
type PrNoun = "pull request" | "merge request";

/**
 * The one PR-state table every surface draws from. Each arm carries its own
 * SHAPE so no two states differ by colour alone. CLOSED is XCircle + destructive
 * because a closed pull request is abandoned where a closed issue is resolved
 * (the issue `StateIcon`), and no shape reuses an issue glyph since boards mix both.
 */
const PR_STATE: Partial<
  Record<string, Omit<PrStatePresentation, "word"> & { label: string }>
> = {
  OPEN: { Icon: GitPullRequestIcon, tone: "text-success", label: "Open" },
  MERGED: { Icon: GitMergeIcon, tone: "text-merged", label: "Merged" },
  CLOSED: { Icon: XCircleIcon, tone: "text-destructive", label: "Closed" },
};

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
  const known = PR_STATE[state];
  if (known === undefined)
    return {
      Icon: CircleIcon,
      tone: "text-muted-foreground",
      word: `${state} ${noun}`,
    };
  return { Icon: known.Icon, tone: known.tone, word: `${known.label} ${noun}` };
}
