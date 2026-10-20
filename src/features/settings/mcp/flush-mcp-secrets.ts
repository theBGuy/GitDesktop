import { deleteMcpSecret, setMcpSecret } from "@/lib/git/api";
import {
  createCallQueue,
  type McpSecretDelete,
  type McpSetFailure,
  type McpStagedSecret,
} from "./secret-ops";

// The MCP keychain guard pins every statement here but the secret-ops import,
// and lets only SettingsScreen's Save run this module: an edit to a pinned
// statement re-points MCP_FLUSH_MODULE in the same change.

// The Rust keychain commands run on unordered threads, so one queue orders every
// MCP keychain call this window issues: a delete never lands after a later set.
const inOrder = createCallQueue();

/** Writes each staged value in turn and returns the failures, each with the
 *  error the keychain raised and `entry` the input object itself, which the
 *  settle matches by identity. Never throws: each await sits in its own
 *  try/catch, and the queue turns a sync throw into a rejection. */
export async function flushMcpSecretSets(
  sets: readonly McpStagedSecret[],
): Promise<McpSetFailure[]> {
  const failed: McpSetFailure[] = [];
  for (const entry of sets) {
    try {
      await inOrder(() => setMcpSecret(entry.serverId, entry.key, entry.value));
    } catch (error) {
      failed.push({ entry, error });
    }
  }
  return failed;
}

/** Fires each delete without waiting, in queue order. A failed delete leaves an
 *  orphaned keychain entry at worst, and deleting a missing entry succeeds. */
export function flushMcpSecretDeletes(
  deletes: readonly McpSecretDelete[],
): void {
  for (const { serverId, key } of deletes)
    void inOrder(() => deleteMcpSecret(serverId, key)).catch(() => undefined);
}
