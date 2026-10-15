/** The runner's forge read of the PR body: present = the read settled. */
export type ReviewBodyFetch = { ok: true; body: string } | { ok: false };

/** Resolves what the review prompt's "Author's description" section gets, from the
 *  event's own body plus the runner's optional forge read. A non-empty (trimmed)
 *  event body wins untouched; `fetched` absent means no forge read exists for this
 *  target (local PR), so an empty event body is authoritatively empty. */
export function reviewBody(
  eventBody: string,
  fetched: ReviewBodyFetch | undefined,
): { body: string; bodyState: "empty" | "unreadable" | undefined } {
  if (eventBody.trim()) return { body: eventBody, bodyState: undefined };
  if (fetched === undefined) return { body: eventBody, bodyState: "empty" };
  if (!fetched.ok) return { body: "", bodyState: "unreadable" };
  return {
    body: fetched.body,
    bodyState: fetched.body.trim() ? undefined : "empty",
  };
}
