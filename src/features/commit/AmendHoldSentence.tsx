import type { ReactNode } from "react";
import type { AmendHold } from "./useCommitSubmit";

/** One sentence per hold, total over the union so a new hold can't ship without
 *  copy; the trailing space separates it from the surface's Stop amending button. */
const SENTENCES: Record<AmendHold, (short: ReactNode) => ReactNode> = {
  none: (short) => (
    <>Your changes will amend the most recent commit ({short}). </>
  ),
  commit: (short) => (
    <>
      The latest commit is no longer {short}, so your changes can't amend it.{" "}
    </>
  ),
  branch: (short) => (
    <>
      The checked-out branch changed since you started amending {short}, so your
      changes can't amend it.{" "}
    </>
  ),
};

/** The amend banner's sentence, shared by the commit box and the commit dialog. */
export function AmendHoldSentence({
  hold,
  hash,
}: {
  hold: AmendHold;
  hash: string | null;
}) {
  return SENTENCES[hold](
    <span className="font-mono">{hash?.slice(0, 7)}</span>,
  );
}
