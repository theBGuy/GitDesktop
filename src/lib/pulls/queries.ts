import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  externalReviewerNames,
  fetchExternalFindings,
} from "@/lib/ai/external-context";
import { resolveReviewerNotesContext } from "@/lib/ai/notes-context";
import { useForgeStatus } from "@/lib/git/queries";
import type { RemoteLens } from "@/lib/git/types";
import {
  createLocalPr,
  deleteLocalPr,
  type LocalPr,
  listLocalPrs,
  updateLocalPr,
} from "./local";
import {
  clearReviewsFor,
  deleteReview,
  listReviews,
  updateReviewText,
} from "./reviews-history";

const localPrKey = (repo: string) => ["local-prs", repo] as const;

export function useLocalPrs(repo: string) {
  return useQuery({
    queryKey: localPrKey(repo),
    queryFn: () => listLocalPrs(repo),
  });
}

function useLocalPrMutation<TArgs, TData>(
  repo: string,
  fn: (args: TArgs) => Promise<TData>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: localPrKey(repo) }),
  });
}

export function useCreateLocalPr(repo: string) {
  return useLocalPrMutation(
    repo,
    (input: { title: string; body: string; base: string; head: string }) =>
      createLocalPr(repo, input),
  );
}

export function useUpdateLocalPr(repo: string) {
  return useLocalPrMutation(
    repo,
    ({ id, mutate }: { id: string; mutate: (pr: LocalPr) => LocalPr }) =>
      updateLocalPr(repo, id, mutate),
  );
}

export function useDeleteLocalPr(repo: string) {
  return useLocalPrMutation(repo, (id: string) => deleteLocalPr(repo, id));
}

type PrKind = "remote" | "local";

const reviewHistoryKey = (
  repo: string,
  lens: RemoteLens,
  kind: PrKind,
  ref: string,
) => ["review-history", repo, lens, kind, ref] as const;

/** Persisted AI reviews for a PR (both modes), newest first. Read-only — never
 *  creates a record, so a never-reviewed PR's first run stays unchanged. */
export function useReviewHistory(
  repo: string,
  lens: RemoteLens,
  kind: PrKind,
  ref: string,
) {
  return useQuery({
    queryKey: reviewHistoryKey(repo, lens, kind, ref),
    queryFn: () => listReviews(repo, lens, kind, ref),
  });
}

function useReviewHistoryMutation<TArgs>(
  repo: string,
  lens: RemoteLens,
  kind: PrKind,
  ref: string,
  fn: (args: TArgs) => Promise<void>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: reviewHistoryKey(repo, lens, kind, ref),
      }),
  });
}

/** Edits a stored review's text — backs "trim before re-running". */
export function useUpdateReviewText(
  repo: string,
  lens: RemoteLens,
  kind: PrKind,
  ref: string,
) {
  return useReviewHistoryMutation(
    repo,
    lens,
    kind,
    ref,
    ({ id, text }: { id: string; text: string }) =>
      updateReviewText(repo, id, text),
  );
}

export function useDeleteReview(
  repo: string,
  lens: RemoteLens,
  kind: PrKind,
  ref: string,
) {
  return useReviewHistoryMutation(repo, lens, kind, ref, (id: string) =>
    deleteReview(repo, id),
  );
}

export function useClearReviews(
  repo: string,
  lens: RemoteLens,
  kind: PrKind,
  ref: string,
) {
  return useReviewHistoryMutation(repo, lens, kind, ref, () =>
    clearReviewsFor(repo, lens, kind, ref),
  );
}

/** Third-party AI-reviewer findings on a remote PR (Copilot/CodeRabbit/…), for
 *  the Review panel's "build on external reviews" banner. Remote PRs only;
 *  best-effort (errors degrade to no banner). Returns the kept findings plus the
 *  distinct reviewer display names. */
export function useExternalReviews(repo: string, kind: PrKind, ref: string) {
  // Harvested behind the forge abstraction for GitHub + GitLab; Bitbucket has no
  // bot-review ecosystem, so the query is disabled there (no banner, no round trip).
  // Gate on the forge status being RESOLVED before enabling: while it's pending the
  // provider is unknown, so we must not run under a default-"github" assumption
  // (wrong trust semantics on GitLab, a wasted IPC harvest on Bitbucket).
  const forge = useForgeStatus(repo);
  const provider = forge.data?.provider;
  const enabled =
    forge.isSuccess &&
    provider != null &&
    provider !== "bitbucket" &&
    kind === "remote" &&
    repo !== "" &&
    /^\d+$/.test(ref);
  return useQuery({
    queryKey: ["external-reviews", repo, ref, provider ?? "pending"],
    queryFn: async () => {
      // Only runs when enabled, so provider is guaranteed a resolved non-Bitbucket value.
      const items = await fetchExternalFindings(
        repo,
        Number(ref),
        provider ?? undefined,
      );
      return { items, reviewers: externalReviewerNames(items) };
    },
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** The author's "Notes for reviewers" on a remote PR — lifted from the marker
 *  conversation comment (author-gated inside the resolver). Drives the Review
 *  panel's per-run "Ignore author notes" row; the run re-resolves them itself.
 *  Remote PRs only; best-effort (a failure just hides the row). */
export function useReviewerNotes(repo: string, kind: PrKind, ref: string) {
  // Same gating as `useExternalReviews`, for the same reasons: wait for the forge
  // status to RESOLVE (an unknown provider must not run under a default-"github"
  // assumption), and skip Bitbucket — the notes harvest reads the same conversation
  // comments the external path does, so a Bitbucket round trip buys nothing.
  const forge = useForgeStatus(repo);
  const provider = forge.data?.provider;
  const enabled =
    forge.isSuccess &&
    provider != null &&
    provider !== "bitbucket" &&
    kind === "remote" &&
    repo !== "" &&
    /^\d+$/.test(ref);
  return useQuery({
    queryKey: ["reviewer-notes", repo, ref, provider ?? "pending"],
    queryFn: () => resolveReviewerNotesContext(repo, Number(ref)),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}
