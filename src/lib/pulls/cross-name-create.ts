// Create PR's guidance for a head the backend refused as a renamed copy of the
// differently named remote branch it still tracks (`pushUpstreamNameMismatch`).

interface CrossNameFields {
  branch: string;
  remote: string;
  remoteBranch: string;
}

/** The refusal sentence for a head that tracks a differently named branch it
 *  was renamed from. A checked-out head gets the backend's line verbatim; any
 *  other head is pointed at its own row menu, since the Push menu acts on HEAD. */
export function crossNameCreateSentence(
  f: CrossNameFields,
  headIsCurrent: boolean,
): string {
  const lead = `Push blocked — ${f.branch} tracks ${f.remote}/${f.remoteBranch}, which has a different name.`;
  return headIsCurrent
    ? `${lead} Choose where to push from the Push menu.`
    : `${lead} Choose where to push it from ${f.branch}'s menu in the branch list.`;
}

/** `error` with its message replaced by the not-checked-out form when it is a
 *  pushUpstreamNameMismatch and the head is not checked out; anything else is
 *  returned as it is. */
export function withCrossNameGuidance(
  error: unknown,
  headIsCurrent: boolean,
): unknown {
  if (headIsCurrent || typeof error !== "object" || error === null)
    return error;
  const e = error as Record<string, unknown>;
  if (e.kind !== "pushUpstreamNameMismatch") return error;
  const { branch, remote, remoteBranch } = e;
  if (
    typeof branch !== "string" ||
    typeof remote !== "string" ||
    typeof remoteBranch !== "string"
  )
    return error;
  return {
    ...e,
    message: crossNameCreateSentence({ branch, remote, remoteBranch }, false),
  };
}
