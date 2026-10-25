// Pure: scripts/board-notice.test.mjs imports this file through Node's type
// stripping, which resolves no aliases, so its one import is a relative path
// to another import-free module.
import { failedSinceLastSuccess } from "../../conversations/remote-section-state.ts";

/** The slice of a card's read the board decides on. */
export type BoardCardRead = {
  data: unknown;
  error: unknown;
  isError: boolean;
  isPaused: boolean;
  isFetching: boolean;
  isPlaceholderData: boolean;
  errorUpdatedAt: number;
  dataUpdatedAt: number;
};

/** Whether a card holds its own window's data. A local card's other window
 *  serves as placeholder while this one loads (`keepPreviousDataForRepo`), so
 *  placeholder rows never count as loaded. */
export function cardLoaded(read: BoardCardRead): boolean {
  return read.data !== undefined && !read.isPlaceholderData;
}

export type UnloadedCardBody = "offline" | "failed" | "loading";

/** What a card with no data draws. A park says it waits for a connection. A
 *  failure keeps saying it couldn't load through a background refetch (a poll,
 *  a focus refetch); only the board's own Retry, while that card refetches,
 *  shows it loading, as the notice is muted then. Anything else still loads. */
export function unloadedCardBody(
  read: BoardCardRead,
  retrying: boolean,
): UnloadedCardBody {
  if (read.isPaused) return "offline";
  if (failedSinceLastSuccess(read) && !(retrying && read.isFetching))
    return "failed";
  return "loading";
}

/** What a card draws: its data, or {@link unloadedCardBody}'s arm. Another
 *  window's placeholder rows stand in while this window loads, and for a failed
 *  read only while the board's own Retry refetches it. */
export function cardBody(
  read: BoardCardRead,
  retrying: boolean,
): UnloadedCardBody | "data" {
  if (cardLoaded(read)) return "data";
  const unloaded = unloadedCardBody(read, retrying);
  return read.data !== undefined && unloaded !== "failed" ? "data" : unloaded;
}

/** A card's key in the reason memory: a windowed card's per window (a toggle
 *  reads another query), a hosted card's by id alone (`weeks` null). */
export function cardErrorKey(id: string, weeks: number | null): string {
  return weeks === null ? id : `${id}:${weeks}`;
}

/** Each repository's cards' last real errors, by {@link cardErrorKey}. */
export type CardErrorMemory = Readonly<
  Record<string, Readonly<Record<string, unknown>>>
>;

/** The memory after this render's cards in `repo`: a never-loaded read's
 *  refetch resets its query error to null, which keeps the entry, so a switch
 *  back to a repository with a cached failure still quotes it. Only the repos
 *  in `keep` survive (bounded growth). Returns `prev` when nothing changes, so
 *  a caller may store it during render. */
export function rememberCardErrors(
  prev: CardErrorMemory,
  repo: string,
  cards: readonly { key: string; read: BoardCardRead }[],
  keep: readonly string[],
): CardErrorMemory {
  let next = prev;
  if (Object.keys(prev).some((r) => !keep.includes(r)))
    next = Object.fromEntries(
      Object.entries(prev).filter(([r]) => keep.includes(r)),
    );
  const before = next[repo];
  let mine = before;
  for (const { key, read } of cards) {
    if (read.error != null && mine?.[key] !== read.error)
      mine = { ...mine, [key]: read.error };
  }
  return mine === before || mine === undefined
    ? next
    : { ...next, [repo]: mine };
}

/** The Insights board's one failure line and the reads its Retry refetches,
 *  or null. A card counts while {@link failedSinceLastSuccess} holds, so a
 *  refetch in flight never drops it from the line. The refresh wording needs
 *  every failed card loaded ({@link cardLoaded}); otherwise the load wording
 *  quotes the first failed card's reason, in the cards' order: its read's
 *  error, or `lastError` while a never-loaded read's refetch has reset that
 *  error to null, so the text holds through the refetch. With no reason known
 *  it says only that some insights couldn't load. Silent only while a user's
 *  Retry is settling (`retrying`). */
export function boardNotice<R extends BoardCardRead>(
  cards: readonly { read: R; lastError?: unknown }[],
  retrying: boolean,
  summarize: (error: unknown) => string,
): { message: string; failed: R[] } | null {
  const failed = cards.filter((c) => failedSinceLastSuccess(c.read));
  if (retrying || failed.length === 0) return null;
  const reason = failed[0].read.error ?? failed[0].lastError;
  const message = failed.every((c) => cardLoaded(c.read))
    ? "Couldn't refresh some insights — showing the last loaded ones."
    : reason == null
      ? "Couldn't load some insights."
      : `Couldn't load some insights. ${summarize(reason)}`;
  return { message, failed: failed.map((c) => c.read) };
}
