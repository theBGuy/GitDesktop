// Pure, type-only imports: scripts/offline-park.test.mjs imports this file
// through Node's type stripping, which resolves no aliases.
import type {
  FetchStatus,
  NetworkMode,
  QueryStatus,
} from "@tanstack/react-query";

/** The slice of a react-query `Query` the offline park reads. */
export type ParkCandidate = {
  state: { status: QueryStatus; fetchStatus: FetchStatus; data: unknown };
  options: { networkMode?: NetworkMode };
};

/** Whether going offline should refetch this query so it parks. react-query
 *  reacts only to coming back online, so a settled error would otherwise keep
 *  its failure copy and Retry for the whole outage; a refetch in "online" mode
 *  parks at once, keeping the error and data beside `isPaused` for the notice
 *  ladders to read. Deliberately excluded: a query with no data, which the
 *  refetch would reset to pending (an endless skeleton, and a permanent verdict
 *  such as a disabled feature lost with its error); any other network mode,
 *  which would really run; and a fetch in flight, which a refetch would cancel. */
export function shouldParkOnOffline(query: ParkCandidate): boolean {
  const { status, fetchStatus, data } = query.state;
  return (
    status === "error" &&
    fetchStatus === "idle" &&
    data !== undefined &&
    (query.options.networkMode ?? "online") === "online"
  );
}
