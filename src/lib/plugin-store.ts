import { load, type Store } from "@tauri-apps/plugin-store";
import { storeName } from "@/lib/test-mode";

// The two mechanics every `@tauri-apps/plugin-store`-backed app-data store shares:
// opening its file once per session, and re-reading it before a read-modify-write.
// Both used to be copy-pasted per store, and both had a failure mode the copies got
// wrong in the same way — see each helper.

/**
 * A memoized opener for one app-data store file, routed through `storeName` so a
 * cold-start/test instance never reads or writes real data.
 *
 * A REJECTED load is deliberately NOT memoized. One unreadable file would otherwise
 * pin the failure for the rest of the session and leave that store dead until the
 * app restarts — the notification emit gate, for one, reads its store on every
 * notification, so a pinned failure would silently ignore every preference. Clearing
 * the memo is safe against its own assignment because rejection handlers run in a
 * later microtask: `??=` has already stored the promise by the time `.catch` runs,
 * so the reset can never erase a NEWER memo, and the next call retries the load.
 *
 * Options are fixed rather than per-caller: the plugin keys one shared instance per
 * FILE, so every opener of a file must agree on them (`repo-data-migration.ts`
 * re-loads each file with this exact shape precisely to mutate the instance the
 * feature modules cached, rather than a private copy the next autosave would lose).
 */
export function memoizedStoreLoader(file: string): () => Promise<Store> {
  let opened: Promise<Store> | null = null;
  return () => {
    opened ??= load(storeName(file), { autoSave: true, defaults: {} }).catch(
      (e: unknown) => {
        opened = null;
        throw e;
      },
    );
    return opened;
  };
}

/**
 * The `(os error N)` codes a MISSING store file surfaces as. The prose differs per
 * platform ("The system cannot find the file specified." on Windows, measured on the
 * first-ever Save 2026-07-10; "No such file or directory" elsewhere), so the numeric
 * code is the only stable part: 2 is ENOENT / ERROR_FILE_NOT_FOUND, and 3 is
 * Windows' ERROR_PATH_NOT_FOUND, which is what a not-yet-created app-data DIRECTORY
 * answers (unix errno 3 is ESRCH, which `fs::read` cannot produce).
 *
 * Matching on the message is what the plugin leaves us: its `reload` is `fs::read` +
 * deserialize, and `Error::Io` is `#[error(transparent)]`, so a raw `std::io::Error`
 * Display crosses the IPC boundary verbatim while a corrupt file arrives as
 * "Failed to deserialize store. …" (tauri-plugin-store 2.4.4, `src/store.rs`
 * `load_ignore_defaults` + `src/error.rs`). An existence probe would be cleaner, but
 * `@tauri-apps/plugin-fs` is not a dependency of this app.
 */
const MISSING_FILE_IO_CODES = ["(os error 2)", "(os error 3)"];

/**
 * The deserialize error a ZERO-BYTE store file produces — reachable because the
 * plugin's `save()` is `fs::write` (truncate in place, not an atomic rename), so a
 * crash mid-save can leave the file empty. An empty file has nothing left to
 * preserve, so tolerating it restores the self-heal the catch-everything used to
 * give: the mutation proceeds and the next `save()` rewrites the file. A TRUNCATED
 * but non-empty file rethrows instead, because its bytes may still hold recoverable
 * content — and it can't reach this string anyway: `default_serialize` is
 * `to_vec_pretty`, so any non-zero prefix opens with `{` and parses as "EOF while
 * parsing an OBJECT".
 *
 * Measured against the exact call the plugin makes —
 * `serde_json::from_slice::<HashMap<String, JsonValue>>` (tauri-plugin-store 2.4.4
 * `src/lib.rs` `default_deserialize`), serde_json 1.0.151, run in a scratch crate
 * 2026-09-13: `""` → this string; `"{"` → "EOF while parsing an object at line 1
 * column 1"; `"{\"a\": 1"` → "…an object at line 1 column 7"; `"not json"` →
 * "expected ident at line 1 column 2". Only the serde TAIL is matched, never the
 * plugin's "Failed to deserialize store. " prefix. A whitespace-only file misses by
 * position ("line 2 column 0" for a lone newline) and so rethrows — the safe
 * direction, and unreachable from a truncated write of `{`-leading JSON.
 */
const EMPTY_FILE_PARSE_ERROR = "EOF while parsing a value at line 1 column 0";

/** The two signatures above are the whole tolerated set — every reload failure with
 *  provably nothing on disk left to preserve. Anything unmatched fails SAFE: it
 *  rethrows, which is the strict behavior.
 *
 *  The match modes differ on purpose. An io code sits MID-string by construction (the
 *  OS prose precedes it, and the plugin may frame it), so it can only be a substring
 *  test. The parse signature is the message's TAIL, so anchoring it at the end is what
 *  keeps an error that merely QUOTES the string — a wrapper appending context, a future
 *  plugin message naming the case — from being read as the case itself. */
function isNothingToPreserve(e: unknown): boolean {
  const text = e instanceof Error ? e.message : String(e);
  return (
    MISSING_FILE_IO_CODES.some((code) => text.includes(code)) ||
    text.endsWith(EMPTY_FILE_PARSE_ERROR)
  );
}

/**
 * Re-read a store's file into its in-memory cache, tolerating an EMPTY store — one
 * whose file is missing entirely, or is zero-byte from a crash mid-save — and
 * rethrowing on everything else. Its job is the reload that precedes a
 * read-modify-write, so the write is based on current disk state rather than this
 * process's launch-time snapshot; `ignoreDefaults: true` matches the cache to disk
 * exactly, so a key deleted out of process drops instead of lingering.
 *
 * Asymmetry this exists for: `load()` tolerates a missing file but `reload()` rejects
 * with a raw io error until the first `save()` creates it, so an unguarded reload
 * makes the first-ever mutation throw before reaching `save()` and the store can
 * never bootstrap (live-hit 2026-07-10); an external delete of the file breaks every
 * mutation until restart the same way. Either empty form therefore returns normally —
 * the in-memory state stands and the next `save()` writes the file (the zero-byte arm
 * is {@link EMPTY_FILE_PARSE_ERROR}).
 *
 * EVERY other failure rethrows, which aborts the caller's read-modify-write. That is
 * the point: a transient io error or a file that parses to nothing usable means we do
 * not know what is on disk, and saving the in-memory cache over it would destroy
 * whatever we failed to read. Callers are serialized write queues, so the rejection
 * reaches the mutation's own error path (a toast, a mutation `onError`) rather than
 * being swallowed. The one caller that reloads AFTER its write — review-notes'
 * `writeBranch`, refreshing the cache behind a Rust-side writer — swallows on its own
 * side instead, since there is no pending write left for a rejection to protect.
 */
export async function reloadToleratingEmptyStore(store: Store): Promise<void> {
  try {
    await store.reload({ ignoreDefaults: true });
  } catch (e) {
    if (!isNothingToPreserve(e)) throw e;
  }
}
