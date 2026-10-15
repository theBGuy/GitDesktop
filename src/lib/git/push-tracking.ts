import type { Branch, BranchHead } from "./types/branches";

// Pure on purpose: scripts/push-tracking.test.mjs imports this file straight
// under Node's type stripping, which resolves no aliases, so imports stay type-only.

/** Whether a fresh status read of HEAD tracks what the branch list's row of the
 *  same branch says it tracks. Compared on the canonical remote + branch split,
 *  never the short `upstream` strings (two different git reads spell them), and
 *  a mismatch reads as the list catching up, so the caller refuses, never pushes. */
export function headTrackingMatchesRow(head: BranchHead, row: Branch): boolean {
  if (head.upstreamGone !== row.upstreamGone) return false;
  if ((head.upstream === null) !== (row.upstream === null)) return false;
  if (head.upstream === null) return true;
  // Status reports null for a local (`.`) upstream and for a failed split read,
  // so only a row the list reports as local (git's `.` passes through) matches.
  if (head.upstreamRemote === null)
    return row.upstreamRemote === null || row.upstreamRemote === ".";
  const rowBranch = row.upstreamRemoteRef?.startsWith("refs/heads/")
    ? row.upstreamRemoteRef.slice("refs/heads/".length)
    : null;
  return (
    head.upstreamRemote === row.upstreamRemote &&
    head.upstreamBranch === rowBranch
  );
}

/** Whether a freshly read branch-list row tracks exactly what the listed row the
 *  decision was made from does. Same read on both sides, so exact equality; a
 *  mismatch reads as the list catching up, so the caller refuses, never pushes. */
export function rowTrackingMatches(fresh: Branch, listed: Branch): boolean {
  return (
    fresh.upstream === listed.upstream &&
    fresh.upstreamGone === listed.upstreamGone &&
    fresh.upstreamRemote === listed.upstreamRemote &&
    fresh.upstreamRemoteRef === listed.upstreamRemoteRef
  );
}
