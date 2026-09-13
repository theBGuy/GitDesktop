import { repoIdentity } from "@/lib/git/repo-identity";
import {
  memoizedStoreLoader,
  reloadToleratingEmptyStore,
} from "@/lib/plugin-store";
import { invoke } from "@/lib/tauri/invoke";
import { COLD_START } from "@/lib/test-mode";

/** A per-branch "Notes for reviewers" deposit, keyed by the repo's
 *  worktree-stable identity then the branch name. Written (out-of-process) by
 *  the MCP server's `set_review_notes`; the GUI's Create-PR dialogs only read
 *  (`getReviewNote`) and consume (`deleteReviewNote`) deposits. */
export interface ReviewNote {
  body: string;
  savedAt: string;
}

/** The branch → note map stored at a single identity key. The store's TOP-LEVEL
 *  keys are identity keys (no wrapper) — the exact layout the Rust mirror
 *  (`src-tauri/src/review_notes.rs`) reads/writes, matching the local-prs
 *  precedent (`store.set(identityKey, …)`). */
type BranchNotes = Record<string, ReviewNote>;

// Personal app-data, keyed by the repo's worktree-stable identity — never
// written into the repo itself.
const getStore = memoizedStoreLoader("review-notes.json");

// Serialize every read-modify-write on this store (and the reconcile reload)
// through one in-process queue. Without it, two overlapping mutations each
// reload the SAME pre-flush disk snapshot — autoSave persists on a ~100ms
// debounce, so the first write isn't on disk yet — and the later write drops
// the earlier one's change (a lost update; the settings-store write-race rule).
// Running them one at a time, plus the force-save in `writeBranchToStore`,
// guarantees each reload sees a current snapshot.
let opChain: Promise<unknown> = Promise.resolve();
function serialize<T>(op: () => Promise<T>): Promise<T> {
  const run = opChain.then(op, op);
  // Keep the queue alive whether `op` fulfilled or rejected; callers still get `run`.
  opChain = run.catch(() => undefined);
  return run;
}

async function reloadRaw(): Promise<void> {
  await reloadToleratingEmptyStore(await getStore());
}

/** Re-read `review-notes.json` from disk into the in-memory store. The MCP
 *  server (with `--allow-write`) can mutate this file externally; without a
 *  reload the autoSave store would clobber those writes on the next GUI
 *  mutation. `ignoreDefaults` fully matches the store to disk (so external
 *  deletes drop). Serialized so it can't land between another mutation's set and
 *  its flush. */
export async function reloadReviewNotes(): Promise<void> {
  return serialize(reloadRaw);
}

// This store has NO legacy checkout-path keys (it postdates identity-keying), so
// we key on the identity directly — no `identityKeyFor` fold is needed.
async function keyFor(repo: string): Promise<string> {
  return repoIdentity(repo);
}

/** Write `branch`'s note (or clear it with `note === null`) for `repo`. The write
 *  runs in Rust, under the cross-process lock the MCP server's writer also takes —
 *  the plugin store's cache is per-process, so a GUI write through it can drop a
 *  concurrent MCP deposit. Reads stay on the plugin store, so pull the file back in
 *  afterwards. */
async function writeBranch(
  repo: string,
  branch: string,
  note: ReviewNote | null,
): Promise<void> {
  // Cold-start test mode aliases the GUI's store FILE (`coldstart-review-notes.json`,
  // `storeName`) while the Rust command always writes the real one, so routing there
  // would leak throwaway onboarding state into the user's own notes. That mode has no
  // second writer to race, so it keeps the plugin-store path.
  if (COLD_START) {
    return writeBranchToStore(await keyFor(repo), branch, note);
  }
  if (note === null) {
    await invoke<void>("review_notes_delete_branch", {
      repoPath: repo,
      branch,
    });
  } else {
    // The Rust writer stamps its own savedAt — a save is a save, whatever the
    // caller's record said.
    await invoke<boolean>("review_notes_set_branch", {
      repoPath: repo,
      branch,
      body: note.body,
    });
  }
  // `reloadRaw`, not the serialized `reloadReviewNotes`: we are already inside a
  // serialized op, and queueing behind it would wait on ourselves.
  //
  // The ONLY reload in this codebase that runs AFTER its write, so the only one that
  // swallows every failure: the strict form exists to abort a read-modify-write before
  // it clobbers disk, and this is not one — the note is already committed by the Rust
  // writer above. Letting a refresh failure (a Windows sharing violation, say) reject
  // here would toast an error for a save that succeeded; the stale cache instead
  // self-corrects on the next reload or relaunch.
  try {
    await reloadRaw();
  } catch {
    // Cache refresh only — the write already landed.
  }
}

/** The legacy plugin-store write, still the cold-start path (see [`writeBranch`]). */
async function writeBranchToStore(
  key: string,
  branch: string,
  note: ReviewNote | null,
): Promise<void> {
  const store = await getStore();
  const branches = { ...((await store.get<BranchNotes>(key)) ?? {}) };
  if (note === null) {
    delete branches[branch];
  } else {
    branches[branch] = note;
  }
  // Mirror the Rust writer's semantics exactly: an emptied branch map DROPS the
  // identity key from the store (never a lingering empty object), so the two
  // processes agree on the file layout.
  if (Object.keys(branches).length === 0) {
    await store.delete(key);
  } else {
    await store.set(key, branches);
  }
  // Flush now instead of on autoSave's debounce, so the next serialized reload
  // can't re-read a pre-write disk snapshot and drop this change.
  await store.save();
}

/** The reviewer note for `repo`'s `branch`, or null if none is stored. */
export async function getReviewNote(
  repo: string,
  branch: string,
): Promise<ReviewNote | null> {
  const store = await getStore();
  const id = await repoIdentity(repo);
  const branches = await store.get<BranchNotes>(id);
  return branches?.[branch] ?? null;
}

/** Removes the reviewer note for `repo`'s `branch` (no-op if absent). */
export async function deleteReviewNote(
  repo: string,
  branch: string,
): Promise<void> {
  return serialize(async () => {
    // Fresh disk state first. Only the cold-start plugin-store path needs it — its
    // in-memory copy would otherwise clobber an external write. The Rust route reads
    // the file itself, under the lock.
    await reloadRaw();
    await writeBranch(repo, branch, null);
  });
}
