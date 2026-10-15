/** The runner's forge read of the PR body: `ok: false` means the description
 *  couldn't be obtained (the read failed, or the PR number can't be read). */
export type ReviewBodyFetch = { ok: true; body: string } | { ok: false };

/** Resolves what the review prompt's "Author's description" section gets, from the
 *  event's own body plus the runner's optional forge read. A settled read wins, since
 *  an event body can be stale. A failed read falls back to a non-empty event body,
 *  else "unreadable". `fetched` absent means no read was made (a local PR, or a remote
 *  event whose own body and notes needed none), so the event body stands. */
export function reviewBody(
  eventBody: string,
  fetched: ReviewBodyFetch | undefined,
): { body: string; bodyState: "empty" | "unreadable" | undefined } {
  if (fetched?.ok) {
    return {
      body: fetched.body,
      bodyState: fetched.body.trim() ? undefined : "empty",
    };
  }
  if (eventBody.trim()) return { body: eventBody, bodyState: undefined };
  if (fetched === undefined) return { body: eventBody, bodyState: "empty" };
  return { body: "", bodyState: "unreadable" };
}

/** Settles the runner's shared PR read into the body arm's input. A body-less event
 *  without a read (its PR number can't be read) lands on "unreadable", never on the
 *  authoritatively-empty arm. */
export function bodyFetchFrom(
  read: Promise<{ body: string }> | undefined,
  needsBody: boolean,
): Promise<ReviewBodyFetch | undefined> {
  if (read) {
    return read.then(
      (p) => ({ ok: true as const, body: p.body }),
      () => ({ ok: false as const }),
    );
  }
  if (needsBody) return Promise.resolve({ ok: false as const });
  return Promise.resolve(undefined);
}

/** Whether the runner reads the PR, and whether the event needs that read for its
 *  description. Remote poll-fired PR events carry no description, so an empty one
 *  is read from the forge; with event-carried notes and a description, nothing is.
 *  Same positive-integer gate as the notes resolver: an unreadable PR number makes
 *  no doomed forge read, and the body arm reports it as unreadable. */
export function bodyReadPlan({
  remoteNumber,
  eventBody,
  hasEventNotes,
}: {
  remoteNumber: number | undefined;
  eventBody: string;
  hasEventNotes: boolean;
}): { read: boolean; needsBody: boolean } {
  const needsBody = remoteNumber !== undefined && !eventBody.trim();
  const validNumber =
    remoteNumber !== undefined &&
    Number.isInteger(remoteNumber) &&
    remoteNumber > 0;
  const read = validNumber && (needsBody || !hasEventNotes);
  return { read, needsBody };
}
