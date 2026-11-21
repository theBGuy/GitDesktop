import { useQuery } from "@tanstack/react-query";
import { failedSinceLastSuccess } from "@/features/conversations/remote-section-state";
import {
  repoStatusOptions,
  repoStatusPoll,
  useUnpushedCount,
} from "@/lib/git/queries";
import type { RepoStatus } from "@/lib/git/types";
import {
  isNoUpstream,
  type UndoPushedHold,
  undoPushedHold,
} from "./editable-set";

/** Only status's HEAD and whether it lacks an upstream, so working-tree polls
 *  don't re-render the host. */
const selectHeadPublication = (s: RepoStatus) =>
  s.branch ? { oid: s.branch.oid, noUpstream: isNoUpstream(s.branch) } : null;

/**
 * Whether a remote branch already has HEAD on a branch with no live upstream,
 * read from Undo's remotes count and believed only while it was counted from the
 * HEAD status reports now. Null while status says there is an upstream (the
 * force-push gate owns that arm) or nothing published blocks. Edit dates and
 * Amend share it, so their no-upstream warnings can't disagree.
 */
export function useHeadPublishedElsewhere(
  repoPath: string,
): UndoPushedHold | null {
  const head = useQuery({
    ...repoStatusOptions(repoPath),
    ...repoStatusPoll,
    select: selectHeadPublication,
  }).data;
  const noUpstream = head?.noUpstream === true;
  const unpushed = useUnpushedCount(repoPath, noUpstream);
  if (!noUpstream) return null;
  return undoPushedHold({
    noUpstream: true,
    ahead: 0,
    countLoaded: unpushed.data !== undefined,
    countFailed: failedSinceLastSuccess(unpushed),
    basis: unpushed.data?.basis ?? null,
    count: unpushed.data?.count ?? 0,
    agreed:
      !unpushed.isError && head != null && unpushed.data?.headOid === head.oid,
  });
}
