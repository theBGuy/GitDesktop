import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteReviewNote, getReviewNote } from "./store";

export const reviewNoteKey = (repo: string, branch: string) =>
  ["review-notes", repo, branch] as const;

/** The stored "Notes for reviewers" deposit for a branch, or null when none
 *  exists. Disabled until a non-empty branch is known. */
export function useReviewNote(repo: string, branch: string | null) {
  return useQuery({
    queryKey: reviewNoteKey(repo, branch ?? ""),
    // Only runs when enabled, so `branch` is guaranteed a non-empty string.
    queryFn: () => getReviewNote(repo, branch as string),
    enabled: Boolean(branch),
  });
}

/** Deletes a branch's reviewer note, invalidating every review-note query for
 *  the repo on settle (mirrors `useLocalPrMutation`'s invalidate-on-settle). */
export function useDeleteReviewNote(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (branch: string) => deleteReviewNote(repo, branch),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["review-notes", repo] }),
  });
}
