import { reloadLocalIssues } from "@/lib/issues/local";
import { reloadLocalPrs } from "@/lib/pulls/local";
import { reloadReviewNotes } from "@/lib/review-notes/store";

interface McpWritableStore {
  /** Re-read the store file from disk into the plugin store's memory cache. */
  reload: () => Promise<void>;
  /** Query-key prefix invalidated once the reload lands. */
  queryKey: readonly string[];
}

/** Every app-data store the MCP server (`--allow-write`) can mutate out of process
 *  registers here. The focus sweep reloads each from DISK before invalidating,
 *  because tauri-plugin-store caches the file in memory — a plain
 *  invalidate/refetch re-reads the stale snapshot forever. A store missing from
 *  this table shows external writes only after an app relaunch. */
export const MCP_WRITABLE_STORES: readonly McpWritableStore[] = [
  { reload: reloadLocalPrs, queryKey: ["local-prs"] },
  { reload: reloadReviewNotes, queryKey: ["review-notes"] },
  { reload: reloadLocalIssues, queryKey: ["local-issues"] },
];
