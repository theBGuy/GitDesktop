import { queryOptions } from "@tanstack/react-query";
import {
  IDENTITY_TTL_MS,
  repoIdentityStrict,
  settledIdentityWithin,
} from "./repo-identity";

/** How long this READ surface keeps serving an identity a re-validation could not
 *  confirm. Two windows: one failed re-validation is a hiccup worth riding out, a
 *  second says the condition isn't transient, and past that an honest error beats a
 *  key nothing has reconfirmed. The wall-clock bound is a BAND, not this number: a
 *  grace-served answer settles as a success and restarts `staleTime`, so the error
 *  surfaces on the first refetch at or after ten minutes from the last CONFIRMED
 *  answer — typically ten to fifteen, later still if nothing mounts or refocuses to
 *  trigger one, and up to one resolver-timeout shorter at the floor (the memo
 *  stamps at issue time). A bound is affordable HERE and nowhere else: running
 *  out of it shows an error body, whereas the same bound on `repoIdentity`'s
 *  fallback would silently redirect a store write to the raw path. */
const IDENTITY_READ_GRACE_MS = IDENTITY_TTL_MS * 2;

/** The ONE options factory for the `["repo-identity", repoPath]` query: the shared
 *  fetch takes its options from whichever observer starts it, so an inline copy
 *  splits behavior (notably `networkMode`, without which this local read parks
 *  offline). A path this session never resolved REJECTS — the ladder and the next
 *  observer mount heal it, but a MOUNTED observer holds isError with no data until
 *  one comes, so gating consumers fall back.
 *
 *  A path it HAS resolved keeps its last identity through a failing re-validation,
 *  bounded by {@link IDENTITY_READ_GRACE_MS}: without it, the window below turns
 *  every transient git failure into an isError flip on a healthy repo, and the
 *  surfaces that render an error body for an unresolved identity would show one
 *  mid-session. Readers only — {@link repoIdentityStrict} keeps rejecting for the
 *  store writers, whose contract is to refuse rather than address themselves by an
 *  unconfirmed key.
 *
 *  The staleness window is the RESOLVER's, not a policy of its own: a checkout path
 *  can change hands mid-session, and a query pinned longer than the memo would hand
 *  React surfaces one identity while the imperative store writers key on another.
 *  Refetching costs no IPC inside the window — the resolver answers from its memo. */
export function repoIdentityQueryOptions(repoPath: string | null) {
  return queryOptions({
    queryKey: ["repo-identity", repoPath] as const,
    queryFn: () =>
      repoIdentityStrict(repoPath as string).catch((e: unknown) => {
        const last = settledIdentityWithin(
          repoPath as string,
          IDENTITY_READ_GRACE_MS,
        );
        if (last !== undefined) return last;
        throw e;
      }),
    enabled: !!repoPath,
    staleTime: IDENTITY_TTL_MS,
    networkMode: "always",
  });
}
