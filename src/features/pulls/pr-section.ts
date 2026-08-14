/** The tabs a PR view can show. Shared by the remote and local views so the two
 *  stay in step; each keeps its own labels, since only the counts differ. */
export type PrSection = "conversation" | "commits" | "files" | "review";
