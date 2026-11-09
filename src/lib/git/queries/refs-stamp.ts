import { useQuery } from "@tanstack/react-query";
import * as api from "../api";
import { repoKeys } from "./core";
import { repoStatusPoll } from "./status";

/** The refs stamp read. `retry: false` because the next poll is the retry: an
 *  over-cap repo's Err must cost one bounded listing per poll, not two. */
export function refsStampOptions(repo: string) {
  return {
    queryKey: repoKeys.refsStamp(repo),
    queryFn: () => api.gitRefsStamp(repo),
    networkMode: "always" as const,
    retry: false as const,
  };
}

/** Polled beside status on its own cadence, so ref moves made outside the app
 *  (a terminal fetch or push, a sibling worktree's commit) are seen within a
 *  poll while the window is visible. */
export function useRefsStamp(repo: string) {
  return useQuery({
    ...refsStampOptions(repo),
    ...repoStatusPoll,
  });
}
