import { invoke } from "@/lib/tauri/invoke";
import { COLD_START } from "@/lib/test-mode";

/**
 * Runs `fn` holding the cross-process advisory lock on app-data store `file`
 * (its bare name, e.g. `"local-prs.json"`), the lock the Rust-side writers and
 * the MCP server take too. It serializes WRITERS across app instances; readers
 * never take it. Fail-open: an acquire that errors or answers null runs `fn`
 * unlocked, so the lock can never block a write. Keep the hold ms-scale: resolve
 * identity keys and spawn git BEFORE calling this, since contenders stop waiting
 * after ~475ms; past ~5s this process's next acquire of the same store evicts the
 * hold, and past ~10s any process can. The release is awaited so this chain's next
 * acquire never races it. Cold-start instances skip it: their `coldstart-*` files
 * have no second writer.
 */
export async function withAppStoreLock<T>(
  file: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (COLD_START) return fn();
  const id = await invoke<string | null>("app_store_lock_acquire", {
    store: file,
  }).catch(() => null);
  try {
    return await fn();
  } finally {
    if (id)
      await invoke("app_store_lock_release", { id }).catch(() => undefined);
  }
}
