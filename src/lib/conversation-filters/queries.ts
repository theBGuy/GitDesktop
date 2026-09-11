import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toastErrorWithNote } from "@/lib/toast";
import {
  type ConversationFilterPrefs,
  loadConversationFilterPrefs,
  saveConversationFilterPrefs,
} from "./store";

// Deliberately OUTSIDE the ["repo", …] subtree (like `lensKey`): every repo mutation
// invalidates that whole prefix, and an invalidation refetches an active query
// whatever its staleTime — which would re-read disk over a filter the user just
// changed, snapping the panel back to the stored set.
export const conversationFilterPrefsKey = (repo: string) =>
  ["conversation-filters", repo] as const;

/** A repo's persisted PR/issue filter prefs. The store is the source of truth —
 *  there's no server to go stale against. */
export function useConversationFilterPrefs(repo: string) {
  return useQuery({
    queryKey: conversationFilterPrefsKey(repo),
    queryFn: () => loadConversationFilterPrefs(repo),
    staleTime: Number.POSITIVE_INFINITY,
    // Local read: the default "online" mode parks it while the OS reports no
    // connection, which would leave the panels on their unfiltered defaults.
    networkMode: "always",
  });
}

export function useSaveConversationFilterPrefs(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (prefs: ConversationFilterPrefs) =>
      saveConversationFilterPrefs(repo, prefs),
    // Local write — see useConversationFilterPrefs: "online" mode would park it offline.
    networkMode: "always",
    // Callers patch the cache optimistically, and the settle below re-reads disk —
    // so a failed write SNAPS the control back with no other sign. The note names
    // that outcome rather than leaving a silently reverted toggle.
    onError: (e) =>
      toastErrorWithNote(
        e,
        "Your filter choice wasn't saved for this repository.",
      ),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: conversationFilterPrefsKey(repo),
      }),
  });
}
