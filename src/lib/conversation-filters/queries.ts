import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRepoIdentity } from "@/lib/git/queries";
import { repoNameFromPath } from "@/lib/stores/notifications";
import { toastErrorWithNote } from "@/lib/toast";
import {
  type ConversationFilterPrefs,
  loadConversationFilterPrefs,
  saveConversationFilterPrefs,
} from "./store";

// Keyed by the repo's worktree-stable IDENTITY, not its checkout path, because the
// store addresses one disk record per identity: a path-keyed cache would give a
// repo's main checkout and each worktree their own infinitely-fresh entry over that
// single record, and this is a read-modify-write (callers compose a whole prefs
// object from their cached copy), so the second checkout to write would compose
// from a stale object and silently revert the first's change. `repo-lens` escapes
// this by storing a single atom, which has nothing to compose from.
//
// Deliberately OUTSIDE the ["repo", …] subtree (like `lensKey`): every repo mutation
// invalidates that whole prefix, and an invalidation refetches an active query
// whatever its staleTime — which would re-read disk over a filter the user just
// changed, snapping the panel back to the stored set.
const prefsKey = (identity: string) =>
  ["conversation-filters", identity] as const;

/** The cache key for a repo's filter prefs, or null until its identity resolves.
 *  Module-private on purpose: the reader, the writer and the invalidator below are
 *  the only holders, so nothing outside can key this cache by checkout path. */
function useConversationFilterPrefsKey(repo: string) {
  const identity = useRepoIdentity(repo).data;
  return identity === undefined ? null : prefsKey(identity);
}

// Unsettled saves per identity. Module-level rather than per-hook because the Pull
// Requests and Issues panels each hold their own mutation over the SAME record, so
// a per-instance counter would miss the cross-panel overlap entirely.
const pendingSaves = new Map<string, number>();

/** A repo's persisted PR/issue filter prefs. The store is the source of truth —
 *  there's no server to go stale against. `data` stays undefined across the
 *  identity-resolution window as well as the disk read, which is what callers'
 *  ready-gates gate on; it can't wedge there, since `repoIdentity` falls back to
 *  the raw path rather than failing. */
export function useConversationFilterPrefs(repo: string) {
  const key = useConversationFilterPrefsKey(repo);
  return useQuery({
    // The unresolved-identity key is a parking spot, never fetched (disabled below)
    // and never written — callers compose keys through the hook above, which
    // withholds one until the identity lands.
    queryKey: key ?? prefsKey(""),
    queryFn: () => loadConversationFilterPrefs(repo),
    enabled: key !== null,
    staleTime: Number.POSITIVE_INFINITY,
    // Local read: the default "online" mode parks it while the OS reports no
    // connection, which would leave the panels on their unfiltered defaults.
    networkMode: "always",
  });
}

/** A save's payload. Both fields are pinned AT MUTATE TIME, which is the whole
 *  point: nothing in this mutation's lifecycle may read the hook's `repo` closure
 *  after the call, since react-query hands an in-flight mutation each later
 *  render's options — a repo switch mid-save would otherwise redirect the write. */
interface SavePrefsVars {
  prefs: ConversationFilterPrefs;
  /** The originating checkout path. The store re-resolves its identity; pinning
   *  the PATH is what keeps the write on the repo the user was looking at. */
  repo: string;
}

export function useSaveConversationFilterPrefs(repo: string) {
  const queryClient = useQueryClient();
  const key = useConversationFilterPrefsKey(repo);
  return useMutation({
    // Reads `vars.repo`, never the closure — see SavePrefsVars.
    mutationFn: ({ prefs, repo: from }: SavePrefsVars) =>
      saveConversationFilterPrefs(from, prefs),
    // Local write — see useConversationFilterPrefs: "online" mode would park it offline.
    networkMode: "always",
    // The optimistic patch belongs HERE, behind the cancel, not at the call site:
    // cancelling a fetch reverts the query to its FETCH-START snapshot, so a patch
    // applied before the cancel would be swallowed by an in-flight read.
    // (The prefs query never goes stale on its own, so without the patch a toggle
    // wouldn't show until the disk write round-tripped through the settle below.)
    //
    // The snapshot splits by job: the VARIABLES carry the repo path for the write,
    // this CONTEXT carries the cache key + identity for the settle. Both are read
    // from the same render, so they name one repo by construction.
    //
    // Reading the `key` CLOSURE is safe in this callback and only in this one:
    // onMutate runs synchronously at mutate time, whereas every later callback gets
    // whatever options the newest render pushed onto the mutation.
    onMutate: async ({ prefs }: SavePrefsVars) => {
      if (!key) return;
      const settleKey = key;
      const identity = settleKey[1];
      pendingSaves.set(identity, (pendingSaves.get(identity) ?? 0) + 1);
      await queryClient.cancelQueries({ queryKey: settleKey });
      queryClient.setQueryData(settleKey, prefs);
      return { key: settleKey, identity };
    },
    // The patch above is optimistic and the settle below re-reads disk — so a failed
    // write SNAPS the control back with no other sign. The note names that outcome
    // rather than leaving a silently reverted toggle, and names the ORIGINATING repo
    // from the variables: the user may have switched away by the time this fires.
    onError: (e, vars) =>
      toastErrorWithNote(
        e,
        `Your filter choice for ${repoNameFromPath(vars.repo)} wasn't saved.`,
      ),
    // Reconciles against the CONTEXT, never the closure — see onMutate: this runs at
    // settle time, when the closure names whatever repo is open by then. Switching
    // repos mid-save would otherwise decrement the new repo's counter and leave the
    // originating one permanently positive, so THAT repo never reconciles again.
    //
    // Last save reconciles, and only it. The race an unconditional invalidate loses:
    //   A) toggle A patches the cache, save A starts;
    //   B) toggle B patches A∪B, save B starts;
    //   C) save A settles first and refetches disk before B's write lands, reverting
    //      the cache to A-only — and the next toggle composes its whole object from
    //      that reverted copy, persisting the loss.
    // No context = onMutate never ran its snapshot, so it never counted this save
    // either; returning leaves the ledger balanced.
    onSettled: (_data, _error, _vars, ctx) => {
      if (!ctx) return;
      const left = Math.max(0, (pendingSaves.get(ctx.identity) ?? 1) - 1);
      if (left > 0) {
        pendingSaves.set(ctx.identity, left);
        return;
      }
      pendingSaves.delete(ctx.identity);
      queryClient.invalidateQueries({ queryKey: ctx.key });
    },
  });
}
