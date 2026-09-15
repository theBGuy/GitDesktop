import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useRepoIdentity } from "@/lib/git/queries";
import { repoIdentity } from "@/lib/git/repo-identity";
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

/** The cache key for a repo's filter prefs: its identity, or — once the identity
 *  lookup has failed for good — the raw checkout path, which is what the disk
 *  loader falls back to on the same failure, so cache and record stay addressed
 *  alike. Null only while the lookup is still pending, since callers hold their
 *  ready-gates on a null key and a gate with nothing left to wait for never opens.
 *  Module-private on purpose: the reader, the writer and the invalidator below are
 *  the only holders, so nothing outside can key this cache by checkout path. */
function useConversationFilterPrefsKey(repo: string) {
  const { data: identity, isError } = useRepoIdentity(repo);
  if (identity !== undefined) return prefsKey(identity);
  return isError ? prefsKey(repo) : null;
}

// Unsettled saves per identity. Module-level rather than per-hook because the Pull
// Requests and Issues panels each hold their own mutation over the SAME record, so
// a per-instance counter would miss the cross-panel overlap entirely.
const pendingSaves = new Map<string, number>();

// Repos whose key upgrade the transfer below has already handled. One-shot because
// an `<Activity>` tab re-show REPLAYS effects, and a replayed transfer would copy the
// older raw-path snapshot back over newer identity-side edits. Cleared when the key
// drops back to the raw form, so a later failure→heal cycle transfers again; one
// short string per repo visited bounds it.
const transferredUpgrades = new Set<string>();

/** A repo's persisted PR/issue filter prefs. The store is the source of truth —
 *  there's no server to go stale against. `data` stays undefined across the
 *  identity-resolution window as well as the disk read, which is what callers'
 *  ready-gates gate on; a failed identity lookup falls the key back to the raw
 *  path, so the read still runs and the gate still opens, and a later mount
 *  upgrades the key once the identity resolves — carrying the raw-path entry's
 *  data forward while a save over it is in flight, so that optimistic patch
 *  survives the upgrade, and which is why a save's settle invalidation spans both
 *  addresses rather than the one it patched. */
export function useConversationFilterPrefs(repo: string) {
  const queryClient = useQueryClient();
  const key = useConversationFilterPrefsKey(repo);
  const identityKey = key !== null && key[1] !== repo ? key[1] : null;
  // `initialData` below owns the flip only while the identity entry is NEW; an entry
  // this window already filled would ignore it, landing readers on that older copy
  // mid-patch. Carry it across here — once per upgrade, marked on first OBSERVATION
  // rather than on the write, since the seeded cell replays just the same once a
  // toggle makes the identity entry newer. Declared BEFORE useQuery so the write
  // clears `isInvalidated` pre-subscribe: else a mount refetch lands over the transfer.
  useEffect(() => {
    if (identityKey === null) {
      transferredUpgrades.delete(repo);
      return;
    }
    if (transferredUpgrades.has(repo)) return;
    transferredUpgrades.add(repo);
    if (!pendingSaves.has(repo)) return;
    const raw = queryClient.getQueryData<ConversationFilterPrefs>(
      prefsKey(repo),
    );
    const cur = queryClient.getQueryData<ConversationFilterPrefs>(
      prefsKey(identityKey),
    );
    if (raw !== undefined && cur !== undefined && cur !== raw)
      queryClient.setQueryData(prefsKey(identityKey), raw);
  }, [identityKey, repo, queryClient]);
  return useQuery({
    // The unresolved-identity key is a parking spot, never fetched (disabled below)
    // and never written — callers compose keys through the hook above, which
    // withholds one until the identity settles.
    queryKey: key ?? prefsKey(""),
    queryFn: () => loadConversationFilterPrefs(repo),
    enabled: key !== null,
    // Carry an IN-FLIGHT optimistic patch across a key upgrade, and only that: a
    // heal mints an empty identity entry whose first read can predate the pending
    // write, and the callers compose their next write from what they see. With no
    // save pending, the identity entry must read disk instead — the raw-path entry
    // can hold failure-window DEFAULTS (that key had no record) while the real one
    // sits under the identity, and seeding those would hide it for the session.
    initialData: () =>
      key !== null && key[1] !== repo && pendingSaves.has(repo)
        ? queryClient.getQueryData<ConversationFilterPrefs>(prefsKey(repo))
        : undefined,
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
    // this CONTEXT carries the identity for the settle's counter. Both are read
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
      return { identity };
    },
    // The patch above is optimistic and the settle below re-reads disk — so a failed
    // write SNAPS the control back with no other sign. The note names that outcome
    // rather than leaving a silently reverted toggle, and names the ORIGINATING repo
    // from the variables: the user may have switched away by the time this fires.
    // The note describes the fallback rather than reporting it done: this fires
    // before the settle's re-read, which a concurrent save defers to the LAST
    // settle. It names both landings because the loader swallows its own failures
    // into the DEFAULTS, so the fault that rejected the write can leave the list
    // wider than anything the user saved.
    onError: (e, vars) =>
      toastErrorWithNote(
        e,
        `Your filter choice for ${repoNameFromPath(vars.repo)} wasn't saved. The list falls back to your saved filters — or to the defaults, if those can't be read either.`,
      ),
    // Counts against the CONTEXT, never the closure — see onMutate: this runs at
    // settle time, when the closure names whatever repo is open by then. Switching
    // repos mid-save would otherwise decrement the new repo's counter and leave the
    // originating one permanently positive, so THAT repo never reconciles again.
    //
    // The invalidation reaches this record's own addresses only: a lookup that heals
    // mid-write moves it from the raw path to the identity, and a settle aimed at the
    // patched address alone leaves the new one holding a pre-write read, which the
    // next toggle composes from. Never the key PREFIX, which would cross repos and
    // refetch over a sibling's in-flight patch — and for that same reason an alias
    // carrying a pending save of its own is skipped; its last settle reconciles it.
    //
    // Last save reconciles, and only it. The race an unconditional invalidate loses:
    //   A) toggle A patches the cache, save A starts;
    //   B) toggle B patches A∪B, save B starts;
    //   C) save A settles first and refetches disk before B's write lands, reverting
    //      the cache to A-only — and the next toggle composes its whole object from
    //      that reverted copy, persisting the loss.
    // No context = onMutate never ran its snapshot, so it never counted this save
    // either; returning leaves the ledger balanced.
    onSettled: async (_data, _error, vars, ctx) => {
      if (!ctx) return;
      const left = Math.max(0, (pendingSaves.get(ctx.identity) ?? 1) - 1);
      if (left > 0) {
        pendingSaves.set(ctx.identity, left);
        return;
      }
      pendingSaves.delete(ctx.identity);
      // Where the record sat at mutate time, and where it resolves NOW — the same
      // address unless the lookup healed mid-write. In the failure state nothing has
      // seeded the memo (only successes cache), so this can be a fresh invoke; the
      // counter is deleted BEFORE that await so a save starting during it registers
      // and is skipped below, rather than being invalidated out from under.
      // A REJECTED save reaches here too (the error path settles as well), which is
      // what turns its optimistic patch back into the stored value.
      const aliases = new Set([ctx.identity, await repoIdentity(vars.repo)]);
      for (const alias of aliases) {
        if (pendingSaves.has(alias)) continue;
        queryClient.invalidateQueries({ queryKey: prefsKey(alias) });
      }
    },
  });
}
