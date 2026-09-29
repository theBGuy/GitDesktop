// Pure, import-free: scripts/remote-list-state.test.mjs imports this file
// through Node's type stripping, which resolves no aliases.

/** The degraded notice's link-style action; extra actions wear it too. */
export const DEGRADED_ACTION_CLASS =
  "cursor-pointer underline underline-offset-2 hover:text-foreground";

/** What a remote list section draws. "rows-degraded" is rows plus a notice
 *  that the last refresh failed. */
export type RemoteSectionState =
  | "gh-skeleton"
  | "not-ready"
  | "list-skeleton"
  | "error"
  | "empty"
  | "rows"
  | "rows-degraded";

/** The remote section's render ladder. A failed read replaces the list only
 *  when there is nothing to draw: react-query keeps the last good data beside
 *  `isError`, and blanking those rows would make a transient outage read as
 *  data loss. */
export function resolveRemoteSection(input: {
  ghPending: boolean;
  ghReady: boolean;
  listPending: boolean;
  error: boolean;
  rowCount: number;
}): RemoteSectionState {
  const { ghPending, ghReady, listPending, error, rowCount } = input;
  if (ghPending) return "gh-skeleton";
  if (!ghReady) return "not-ready";
  if (listPending) return "list-skeleton";
  if (error) return rowCount > 0 ? "rows-degraded" : "error";
  return rowCount === 0 ? "empty" : "rows";
}

/** Address:port tokens: IPv4, bracketed IPv6, and localhost. Only these are
 *  masked, never bare digits, so two different HTTP statuses stay distinct. */
const ADDRESS_PORT =
  /\b\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}\b|\[[0-9A-Fa-f:.]+\]:\d{1,5}\b|\blocalhost:\d{1,5}\b/gi;

/** A failure message with its volatile address:port tokens masked. Transport
 *  errors name each connection's own ephemeral local port, so one outage
 *  reads differently on every read until those are masked. */
export function normalizeNoticeMessage(message: string): string {
  return message.replace(ADDRESS_PORT, "<addr>");
}

/** Buckets failure notices whose normalized `message` is identical, in
 *  first-seen order, so one outage behind several reads renders as a single
 *  line. Each group keeps its members' original messages. */
export function groupNoticesByMessage<T extends { message: string }>(
  notices: readonly T[],
): T[][] {
  const groups = new Map<string, T[]>();
  for (const notice of notices) {
    const key = normalizeNoticeMessage(notice.message);
    const group = groups.get(key);
    if (group) group.push(notice);
    else groups.set(key, [notice]);
  }
  return [...groups.values()];
}
