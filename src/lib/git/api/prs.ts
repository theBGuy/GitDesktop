import { invoke } from "@/lib/tauri/invoke";
import type {
  ForgeProvider,
  ForgeTimelineEvent,
  ForkPrMatch,
  MyTeams,
  PrBaseDivergence,
  PrCiStatus,
  PrDetails,
  PrHeadRef,
  PrInfo,
  PrMergeability,
  PrMergeabilityState,
  PrPollInfo,
  RemoteLens,
  RemoteListFilter,
  ReviewStatePage,
} from "../types";

/** Open PRs/MRs whose head is `head` — the ComparePanel duplicate probe. */
export const forgePrsForBranch = (
  repoPath: string,
  head: string,
  lens: RemoteLens,
) => invoke<PrInfo[]>("forge_prs_for_branch", { repoPath, head, lens });

export type PrStateFilter = "open" | "closed";

/** The CI rollup for a PR-list page, keyed by number (provider-neutral). `prs` carries
 *  each row's number plus head SHA (the Bitbucket arm needs the SHA). `sampleUrl` is any
 *  PR html url from the same page and is load-bearing for forks: it fixes which repo the
 *  numbers belong to when the list resolves to the parent while origin points at the
 *  fork. */
export const forgePrListCi = (
  repoPath: string,
  prs: { number: number; headSha: string }[],
  sampleUrl: string,
) => invoke<PrCiStatus[]>("forge_pr_list_ci", { repoPath, prs, sampleUrl });

/** Mergeability for a PR-list page, keyed by number — the sibling of
 *  {@link forgePrListCi}. Unlike the CI rollup it takes no row list: the backend
 *  re-queries the page from these same filter args, so only the filters cross the
 *  wire. Only rows the provider can answer for appear in the record. */
export const forgePrListMergeability = (
  repoPath: string,
  state: PrStateFilter,
  limit: number | undefined,
  lens: RemoteLens,
  filter: RemoteListFilter | null = null,
) =>
  invoke<Record<number, PrMergeabilityState>>("forge_pr_list_mergeability", {
    repoPath,
    state,
    limit,
    lens,
    filter,
  });

/** The viewer's review state for a PR-list page, keyed by number — the review-state
 *  grouping. Like {@link forgePrListMergeability} it takes no row list: the backend
 *  re-queries the page from these same filter args. Numbers the backend couldn't
 *  answer for are absent from `entries` — never defaulted to "not reviewed". */
export const forgePrReviewState = (
  repoPath: string,
  state: PrStateFilter,
  limit: number | undefined,
  lens: RemoteLens,
  filter: RemoteListFilter | null,
) =>
  invoke<ReviewStatePage>("forge_pr_review_state", {
    repoPath,
    state,
    limit,
    lens,
    filter,
  });

/** The teams the viewer belongs to, for the team-review filter's picker. GitHub-only
 *  (`implemented.listFilterTeam`); a token without the team-read scope answers with
 *  `missingScope` rather than failing. */
export const forgeMyTeams = (repoPath: string, lens: RemoteLens) =>
  invoke<MyTeams>("forge_my_teams", { repoPath, lens });

/** A PR's activity timeline (force-pushes, label changes, review requests, state
 *  changes, approvals) for the Conversation tab. Provider-neutral — the backend
 *  dispatches per provider (GitHub `gh`, GitLab `glab`, Bitbucket HTTP). */
export const forgePrTimeline = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) =>
  invoke<ForgeTimelineEvent[]>("forge_pr_timeline", { repoPath, number, lens });

// Provider-neutral merge/pull request reads — the backend resolves the repo's provider
// and dispatches, returning the same neutral `PrInfo`/`PrDetails` shapes. Neutral
// `forge*` wrappers cover the writes in pr-actions.ts, pr-reviews.ts and
// pr-write.ts; a few paths stay GitHub-only — comment hide/unhide,
// update-branch, base-divergence, and PR checkout.
export const forgePrList = (
  repoPath: string,
  state: PrStateFilter,
  limit: number | undefined,
  lens: RemoteLens,
  filter: RemoteListFilter | null = null,
) =>
  invoke<PrInfo[]>("forge_pr_list", { repoPath, state, limit, lens, filter });

export const forgePrView = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) => invoke<PrDetails>("forge_pr_view", { repoPath, number, lens });

/** A single PR's mergeability against its base. GitHub computes this asynchronously
 *  and this read PRIMES that computation, so a "checking" result means poll again;
 *  non-open PRs (and Bitbucket) answer "unavailable". */
export const forgePrMergeability = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) =>
  invoke<PrMergeability>("forge_pr_mergeability", { repoPath, number, lens });

export const forgePrDiff = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) => invoke<string>("forge_pr_diff", { repoPath, number, lens });

/** The unified diff for a single commit of a PR/MR (per-commit review view). */
export const forgePrCommitDiff = (
  repoPath: string,
  number: number,
  oid: string,
) => invoke<string>("forge_pr_commit_diff", { repoPath, number, oid });

/** The forge's own unified diff for a single commit, independent of any PR/MR.
 *  Reuses `forge_pr_commit_diff` with `number: 0` — `number` is part of the neutral
 *  contract but ignored by every provider (documented in forge/mod.rs), so a
 *  PR-independent commit diff just passes a placeholder. */
export const forgeCommitDiff = (repoPath: string, sha: string) =>
  invoke<string>("forge_pr_commit_diff", { repoPath, number: 0, oid: sha });

/** Whether a commit exists on any remote (the History-tab comment surface gates on
 *  it — you can only comment on a commit the forge already has). */
export const commitOnRemote = (repoPath: string, sha: string) =>
  invoke<boolean>("commit_on_remote", { repoPath, sha });

/** Provider-neutral PR poll for the notification poller + remote pr-sync — the
 *  backend dispatches (GitHub `gh`, GitLab `glab`, Bitbucket HTTP) onto the same
 *  neutral `PrPollInfo`. GitLab/Bitbucket carry no check rollup or review decision
 *  in list responses, so those fields come back empty (a v1 limit); `headSha`
 *  still drives pr-sync. */
export const forgePrPoll = (repoPath: string) =>
  invoke<PrPollInfo[]>("forge_pr_poll", { repoPath });

/** How far a PR's head is ahead of / behind its base. */
export const ghPrBaseDivergence = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) =>
  invoke<PrBaseDivergence>("gh_pr_base_divergence", { repoPath, number, lens });

/** Where one PR's head branch lives, by number. Targeted rather than a scan of
 *  the poll list, so it answers for a PR outside the poll's window. Takes the
 *  provider explicitly: the inbox asks about repositories it has not opened. */
export const forgePrHeadRef = (
  provider: ForgeProvider,
  repoPath: string,
  number: number,
) => invoke<PrHeadRef>("forge_pr_head_ref", { provider, repoPath, number });

/** The open fork PR whose head `branch` already contains, or null. Advisory —
 *  a forge outage answers null rather than failing. */
export const forgeDetectForkPrForBranch = (repoPath: string, branch: string) =>
  invoke<ForkPrMatch | null>("forge_detect_fork_pr_for_branch", {
    repoPath,
    branch,
  });

/** The name of a remote pointing at `owner/repo` on origin's host, adding one if
 *  needed. Idempotent — returns the same name on a second call. */
export const forgeEnsureForkRemote = (
  repoPath: string,
  owner: string,
  repo: string,
) => invoke<string>("forge_ensure_fork_remote", { repoPath, owner, repo });
