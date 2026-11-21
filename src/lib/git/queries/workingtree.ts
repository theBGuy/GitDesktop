import {
  type QueryClient,
  queryOptions,
  type UseQueryResult,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { usePanelActive } from "@/components/panel-portal";
import { ignoreLines } from "@/lib/ai/ignore";
import { appErrorDetail } from "@/lib/error-summary";
import { shouldRetryQuery } from "@/lib/forge-backoff";
import {
  REPO_SHELL_GC_TIME,
  REPO_SHELL_WARM_STALE_MS,
} from "@/lib/query-cache-times";
import { useHideWhitespace } from "@/lib/settings/hide-whitespace";
import { isAppError } from "@/lib/tauri/invoke";
import * as api from "../api";
import {
  type ConflictSides,
  checkoutConflictSide,
  conflictMarkerScan,
  conflictSides,
  resolveConflict,
} from "../conflict";
import { MARKER_SCAN_TIMED_OUT } from "../conflict-prefilter";
import { literalPathspec } from "../glob";
import type {
  RemoteLens,
  RepoOp,
  SubmoduleConflict,
  SubmoduleConflictStages,
  UnignoreRule,
} from "../types";
import { readViewDiff } from "../whitespace-diff";
import { repoKeys } from "./core";
import { useRepoMutation, workingTreeKeys } from "./internal";

/** Prefix of every {@link useAiExcludedView} key for a repo (the global-pattern
 *  axis follows), so a rule edit invalidates the view whatever settings held. */
const aiExcludedKey = (repo: string) => ["repo", repo, "ai-excluded"] as const;

/** The HEAD-dependent families a commit's aftermath refreshes, minus the four
 *  the status/log sync already refreshes itself (log, the two unpushed reads,
 *  op state): history, branch tips/counters, HEAD-rev blobs, and prospective
 *  operation state (merge/conflict previews, local-PR merge states). Shared by
 *  a commit's aftermath and StatusLogSync's outside-move refresh; not every
 *  HEAD-dependent read (StatusLogSync re-reads rewrite-status beside it). */
export const headMoveAftermathKeys = (repo: string) =>
  [
    repoKeys.commits(repo),
    repoKeys.branches(repo),
    ["repo", repo, "log-search"],
    ["repo", repo, "recent-commits"],
    ["repo", repo, "commit-authors"],
    ["repo", repo, "branch-stats"],
    ["repo", repo, "stats"],
    ["repo", repo, "divergence"],
    ["repo", repo, "compare"],
    ["repo", repo, "file-log"],
    ["repo", repo, "blame"],
    ["repo", repo, "file-b64", "HEAD"],
    ["repo", repo, "conflict-file"],
    ["repo", repo, "merge-preview"],
    ["repo", repo, "conflict-preview"],
    ["repo", repo, "local-pr-merge-states"],
    ["repo", repo, "oplog-check"],
    ["repo", repo, "insights", "contributors"],
    ["repo", repo, "insights", "commit-activity"],
    ["repo", repo, "insights", "code-frequency"],
    ["repo", repo, "insights", "punch-card"],
  ] as const;

/** The families a commit (or amend) makes stale BEYOND the working tree: the
 *  HEAD-move set plus the four the status/log sync owns, since a commit (which
 *  can conclude a merge or an interrupted journaled op) refreshes them itself.
 *  Invalidated fire-and-forget so the Commit button never waits on them;
 *  forge-backed keys (pr/issue/CI/…) are deliberately absent — a local
 *  commit cannot change forge state. */
const commitAftermathKeys = (repo: string) =>
  [
    repoKeys.log(repo),
    repoKeys.unpushedCount(repo),
    repoKeys.unpushedMessages(repo),
    repoKeys.opState(repo),
    ...headMoveAftermathKeys(repo),
  ] as const;

type WorkingFile = { path: string; staged: boolean; untracked: boolean };

/** The working-tree file diff read in one whitespace mode: shared by
 *  {@link useFileDiff} and imperative prefetches, which inherit nothing from
 *  the hook (a prefetch without `networkMode` would park offline). */
export function fileDiffQueryOptions(
  repo: string,
  file: WorkingFile | null,
  hide: boolean,
) {
  return queryOptions({
    // `untracked` is in the key so the untracked→tracked flip (after staging part
    // of a new file) subscribes to a fresh query — the `--no-index` "all new"
    // diff and the normal remainder diff must not share a cache entry, or an
    // invalidation race could leave the stale all-lines view on screen. The
    // whitespace mode keys last, and its answer carries the mode it was read in.
    queryKey: [
      ...repoKeys.diff(repo, file?.path ?? "", file?.staged ?? false),
      file?.untracked ?? false,
      hide,
    ] as const,
    queryFn: () =>
      readViewDiff(hide, (iw) =>
        api.gitDiffFile(
          repo,
          file?.path ?? "",
          file?.staged ?? false,
          file?.untracked ?? false,
          iw,
        ),
      ),
    enabled: file !== null,
    // Local reads must not park on react-query's default "online" mode offline;
    // the same holds for every `networkMode` in this file.
    networkMode: "always",
  });
}

export function useFileDiff(repo: string, file: WorkingFile | null) {
  const hide = useHideWhitespace();
  return useQuery(fileDiffQueryOptions(repo, file, hide));
}

/**
 * A file's cumulative diff in an agent session worktree vs the session's base commit.
 * `base` is in the key so a restarted session's new base can't cache-hit; idle until
 * `enabled` (the step is expanded). While `live` it polls: the agent edits the worktree
 * through its own CLI, outside any app mutation that could invalidate this, so an open
 * diff would otherwise freeze.
 */
export function useSessionFileDiff(
  repo: string,
  filePath: string,
  base: string,
  enabled: boolean,
  live: boolean,
) {
  const hide = useHideWhitespace();
  return useQuery({
    queryKey: [
      ...repoKeys.diff(repo, filePath, false),
      "session-base",
      base,
      hide,
    ],
    queryFn: () =>
      readViewDiff(hide, (iw) =>
        api.gitSessionFileDiff(repo, filePath, base, iw),
      ),
    enabled: enabled && Boolean(repo && filePath && base),
    // An errored read stops polling: each poll would flip `isFetching` and
    // remount the failure notice and its Retry. Retry, invalidation and focus
    // refetches still resume it, and a success re-arms the poll.
    refetchInterval: (query) =>
      enabled && live && query.state.status !== "error" ? 1500 : false,
    refetchIntervalInBackground: false,
    networkMode: "always",
  });
}

export function useStage(repo: string) {
  return useRepoMutation(repo, (paths: string[]) => api.gitStage(repo, paths), {
    invalidate: workingTreeKeys(repo),
    // Local working-tree write — never park it offline.
    networkMode: "always",
  });
}

/** Shared so every observer of a repo's op-state key fetches under the same
 *  options: the fetch takes them from whichever observer starts it. */
export function opStateOptions(repo: string) {
  return {
    queryKey: repoKeys.opState(repo),
    queryFn: () => api.gitOpState(repo),
    networkMode: "always" as const,
    staleTime: REPO_SHELL_WARM_STALE_MS,
    gcTime: REPO_SHELL_GC_TIME,
  };
}

export function useOpState(repo: string) {
  return useQuery(opStateOptions(repo));
}

export function useOpAbort(repo: string) {
  return useRepoMutation(repo, (op: RepoOp) => api.gitOpAbort(repo, op), {
    // Local git write — never park it offline.
    networkMode: "always",
  });
}

export function useOpContinue(repo: string) {
  return useRepoMutation(repo, (op: RepoOp) => api.gitOpContinue(repo, op), {
    // Local git write — never park it offline.
    networkMode: "always",
  });
}

/** How often an open conflict file re-reads from disk while its panel shows. */
const CONFLICT_FILE_POLL_MS = 2000;

/** The slower cadence for a file whose last read carried more than
 *  {@link CONFLICT_FILE_LARGE_CHARS} across its versions: each tick re-sends
 *  them all, hashes the working file and spawns a `git show` per stage. */
const CONFLICT_FILE_LARGE_POLL_MS = 10_000;
const CONFLICT_FILE_LARGE_CHARS = 256_000;

/** The pause before a conflict-file read's one retry after an `io` failure. */
const CONFLICT_FILE_RETRY_MS = 300;

/** The conflict reads' retry rule: one quick retry after an `io` failure (a
 *  read colliding with an editor's save), nothing else. */
const retryConflictReadOnIo = (failureCount: number, error: Error) =>
  failureCount < 1 && isAppError(error) && error.kind === "io";

/** Characters across every version a sides read carried. */
function sidesChars(sides: ConflictSides): number {
  return [sides.working, sides.ours, sides.theirs, sides.base].reduce(
    (sum, body) => sum + (typeof body === "string" ? body.length : 0),
    0,
  );
}

/**
 * The conflicted file's sides + marked working text, for the conflict editor.
 * Polls while its panel shows: the file is edited outside any app mutation (the
 * terminal, an agent, an external editor), and git status still lists an
 * on-disk resolve as unmerged. A tick costs one `git ls-files -u`, a `git show`
 * per present stage, and a whole-file read, hence the panel gate. A file whose
 * last read carried a large payload polls at the slower large-file cadence. The
 * document-visibility pause applies only where the webview reports hidden; a
 * minimized Windows window does not, so it keeps polling like the status poll
 * does. An `io` failure (a read colliding with an editor's save) retries once
 * quickly, since any error swaps the pane to the read-error copy. A failed read
 * also re-runs on the next tick (retry limits only one fetch), so that pane
 * heals without a Retry, except `invalidArgument` (binary, oversized, a
 * submodule conflict, or refused by the path gate): it can't clear by itself,
 * and each tick would re-read the whole file.
 */
export function useConflictFile(repo: string, path: string) {
  const panelActive = usePanelActive();
  return useQuery({
    queryKey: ["repo", repo, "conflict-file", path] as const,
    queryFn: () => conflictSides(repo, path, []),
    retry: retryConflictReadOnIo,
    retryDelay: CONFLICT_FILE_RETRY_MS,
    refetchInterval: (query) => {
      if (
        !panelActive ||
        (isAppError(query.state.error) &&
          query.state.error.kind === "invalidArgument")
      )
        return false;
      const data = query.state.data;
      return data !== undefined && sidesChars(data) > CONFLICT_FILE_LARGE_CHARS
        ? CONFLICT_FILE_LARGE_POLL_MS
        : CONFLICT_FILE_POLL_MS;
    },
    refetchIntervalInBackground: false,
    networkMode: "always",
  });
}

/** A polled read with its last settled error held while a DATALESS re-read is
 *  in flight: react-query resets such a query to `pending` with no error on
 *  every fetch, so a read that keeps failing would flip spinner → error each
 *  tick. Narrow on purpose: a spread of the query result would subscribe the
 *  caller to `isFetching` and re-render it on every poll tick. */
export interface HeldRead<T> {
  data: T | undefined;
  /** True only before the first settle of this (repo, path): never while an
   *  error is held. */
  isPending: boolean;
  isError: boolean;
  error: unknown;
  /** The query's own refetch, same identity. */
  refetch: UseQueryResult<T>["refetch"];
}

/** One slot per view: the last error a (repo, path) read settled on, cleared
 *  by that read's success. Adjusted during render, so the frame a re-read
 *  starts in already shows the held error; a slot of another (repo, path) is
 *  never shown. An arrow, since scripts/conflict-file-poll.test.mjs reads
 *  `function` declarations by name and a generic one fails its parse. */
const useHeldRead = <T>(
  query: UseQueryResult<T>,
  repo: string,
  path: string,
): HeldRead<T> => {
  const [slot, setSlot] = useState<{
    repo: string;
    path: string;
    error: unknown;
  } | null>(null);
  const mine = slot !== null && slot.repo === repo && slot.path === path;
  if (query.isError) {
    if (!mine || slot.error !== query.error)
      setSlot({ repo, path, error: query.error });
  } else if (query.isSuccess && mine) {
    setSlot(null);
  }
  const holding = query.isPending && mine;
  let error: unknown = null;
  if (query.isError) error = query.error;
  else if (holding) error = slot?.error;
  return {
    data: query.data,
    isPending: query.isPending && !holding,
    isError: query.isError || holding,
    error,
    refetch: query.refetch,
  };
};

/** {@link useConflictFile} with its read error held across re-reads. */
export function useHeldConflictFile(
  repo: string,
  path: string,
): HeldRead<ConflictSides> {
  return useHeldRead(useConflictFile(repo, path), repo, path);
}

const conflictFileKey = (repo: string) =>
  ["repo", repo, "conflict-file"] as const;

/** Outside {@link conflictFileKey}'s prefix on purpose: the conflict writes
 *  await that prefix's refetch, and a whole-file scan may take its full budget,
 *  so they refresh this key fire-and-forget instead. */
const conflictMarkerScanKey = (repo: string) =>
  ["repo", repo, "conflict-marker-scan"] as const;

/** The scan's retry rule: the conflict reads' io retry, except a scan that ran
 *  out of its budget, which would only spend that budget again. */
const retryMarkerScan = (failureCount: number, error: Error) =>
  retryConflictReadOnIo(failureCount, error) &&
  !(
    isAppError(error) &&
    appErrorDetail(error.kind, error.message) === MARKER_SCAN_TIMED_OUT
  );

/**
 * The capless marker scan of a conflicted working file, for a file whose sides
 * read refused it as too large to show. The conflict writes and
 * {@link refreshConflictFile} re-read it without awaiting it. No poll: the
 * refused sides read doesn't poll either, and staging re-scans at the click.
 * Stale at once, so the window-refocus refresh re-scans after an outside edit.
 */
const conflictMarkerScanOptions = (repo: string, path: string) =>
  queryOptions({
    queryKey: [...conflictMarkerScanKey(repo), path] as const,
    queryFn: () => conflictMarkerScan(repo, path),
    staleTime: 0,
    retry: retryMarkerScan,
    retryDelay: CONFLICT_FILE_RETRY_MS,
    networkMode: "always",
  });

/** {@link conflictMarkerScanOptions}, idle until `enabled`. */
export function useConflictMarkerScan(
  repo: string,
  path: string,
  enabled: boolean,
) {
  return useQuery({ ...conflictMarkerScanOptions(repo, path), enabled });
}

/** How often an open submodule conflict re-reads; useSubmoduleChanges' cadence,
 *  since each tick spawns git inside the submodule too. */
const SUBMODULE_CONFLICT_POLL_MS = 5000;

/** The submodule read's refusal once the path's conflict holds no gitlink
 *  (`git_submodule_conflict_core`, git/submodule.rs). */
const NOT_SUBMODULE_CONFLICT = "not a submodule conflict";

/**
 * Both commits of a conflicted submodule, for the conflict editor's submodule
 * pane; idle until `enabled` (the file read refused the path as a gitlink).
 * Keyed under the conflict-file prefix, so the conflict writes and
 * {@link refreshConflictFile} re-read it too. Polls while its panel shows: the
 * conflict can be resolved, and the submodule's checkout moved, outside the
 * app. Every failure re-polls but `invalidArgument`, which can't clear by
 * itself; the held read keeps its error on screen across those re-reads.
 */
export function useSubmoduleConflict(
  repo: string,
  path: string,
  enabled: boolean,
): HeldRead<SubmoduleConflict> {
  const panelActive = usePanelActive();
  const read = useQuery({
    queryKey: [...conflictFileKey(repo), path, "submodule"] as const,
    queryFn: () => api.gitSubmoduleConflict(repo, path),
    enabled,
    retry: false,
    refetchInterval: (query) =>
      panelActive &&
      !(
        isAppError(query.state.error) &&
        query.state.error.kind === "invalidArgument"
      )
        ? SUBMODULE_CONFLICT_POLL_MS
        : false,
    refetchIntervalInBackground: false,
    networkMode: "always",
  });
  // The conflict became a file conflict outside the app. The refused file read
  // no longer polls, so this answer re-reads it once and the text view takes
  // over. Keyed on the answer: a file read still refusing keeps this arm and
  // asks nothing new of the submodule read, so the two never ping-pong.
  const queryClient = useQueryClient();
  const notSubmodule =
    read.isError &&
    isAppError(read.error) &&
    read.error.kind === "invalidArgument" &&
    appErrorDetail(read.error.kind, read.error.message) ===
      NOT_SUBMODULE_CONFLICT
      ? read.error
      : null;
  useEffect(() => {
    if (notSubmodule === null) return;
    void queryClient.refetchQueries(
      { queryKey: [...conflictFileKey(repo), path], exact: true },
      { cancelRefetch: false },
    );
  }, [notSubmodule, queryClient, repo, path]);
  return useHeldRead(read, repo, path);
}

/** Stages one side's commit for a conflicted submodule, checking it out there
 *  when the read promised so (`expectCheckout`). `expected` is the read's stage
 *  shas: a moved stage, or a checkout the read said would stay, answers
 *  `changed` with nothing staged. Re-reads the conflict editor before
 *  `isPending` drops, like its three siblings. */
export function useAcceptSubmoduleConflictSide(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      path: string;
      side: "ours" | "theirs";
      expected: SubmoduleConflictStages;
      expectCheckout: boolean;
    }) =>
      api.gitAcceptSubmoduleConflictSide(
        repo,
        args.path,
        args.side,
        args.expected,
        args.expectCheckout,
      ),
    {
      invalidate: [conflictFileKey(repo)],
      invalidateAfter: [...workingTreeKeys(repo), conflictMarkerScanKey(repo)],
      refetchBeforeSuccess: true,
      // Local conflict write — never park it offline.
      networkMode: "always",
    },
  );
}

/** Re-reads the conflict editor (awaited) and fires the working-tree keys and
 *  the marker scan alongside it, where the conflict mutations fire them after;
 *  shared with the view's error-path refresh so the keys stay in this package. */
export async function refreshConflictFile(
  queryClient: QueryClient,
  repo: string,
): Promise<void> {
  const refresh = queryClient.invalidateQueries({
    queryKey: conflictFileKey(repo),
  });
  for (const queryKey of [
    ...workingTreeKeys(repo),
    conflictMarkerScanKey(repo),
  ])
    void queryClient.invalidateQueries({ queryKey });
  await refresh;
}

/** Writes a conflict resolution, staging it when `stage` (marks resolved).
 *  A mounted conflict editor's re-read lands before `isPending` drops, and one
 *  mounted or shown later holds its buttons through its own first read, so they
 *  never act on pre-write segments; the working tree refreshes behind it. On
 *  error nothing is invalidated: ConflictFileView re-reads itself, and the AI
 *  resolve view renders its own proposal, not the disk. A `changedOnDisk`
 *  outcome is a success here (the awaited re-read runs); the caller shows it. */
export function useResolveConflict(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      path: string;
      content: string;
      stage: boolean;
      expectedHash: string | null;
    }) =>
      resolveConflict(
        repo,
        args.path,
        args.content,
        args.stage,
        args.expectedHash,
      ),
    {
      invalidate: [conflictFileKey(repo)],
      invalidateAfter: [...workingTreeKeys(repo), conflictMarkerScanKey(repo)],
      refetchBeforeSuccess: true,
      // Local conflict write — never park it offline.
      networkMode: "always",
      // Each accept carries the whole file in its variables; nothing reads a
      // settled resolve back, so it leaves the cache as it settles.
      gcTime: 0,
    },
  );
}

/** Resolves a whole conflicted file by taking one side ("ours"/"theirs"). */
export function useCheckoutConflictSide(repo: string) {
  return useRepoMutation(
    repo,
    (args: { path: string; side: "ours" | "theirs" }) =>
      checkoutConflictSide(repo, args.path, args.side),
    {
      invalidate: [conflictFileKey(repo)],
      invalidateAfter: [...workingTreeKeys(repo), conflictMarkerScanKey(repo)],
      refetchBeforeSuccess: true,
      // Local conflict write — never park it offline.
      networkMode: "always",
    },
  );
}

/** Stages a conflicted file exactly as it stands on disk — edited, emptied, or
 *  removed — which marks the conflict resolved. */
export function useMarkConflictResolved(repo: string) {
  return useRepoMutation(
    repo,
    (path: string) => api.gitStage(repo, [literalPathspec(path)]),
    {
      invalidate: [conflictFileKey(repo)],
      invalidateAfter: [...workingTreeKeys(repo), conflictMarkerScanKey(repo)],
      refetchBeforeSuccess: true,
      // Local conflict write — never park it offline.
      networkMode: "always",
    },
  );
}

/** A full object id, optionally walked back with `~N` / `^N`: the bytes such a
 *  rev names never change, unlike HEAD, the index (`:0`) or a branch name. */
const IMMUTABLE_REV = /^(?:[0-9a-f]{40}|[0-9a-f]{64})(?:[~^]\d*)*$/;

/** One file's bytes at a rev (null = the working tree). Shared by the diff
 *  panes' reads and the markdown image loader's `fetchQuery`, so both run under
 *  the same options. `probeSize` stays out of the key: either mode answers a
 *  blob with the same `FileBytes`. An immutable rev never goes stale, which
 *  keeps it out of the window-focus refetch; invalidation still re-reads it. A
 *  refusal (`invalidArgument`) isn't retried: it answers the same every time. */
export function fileAtRevOptions(
  repo: string,
  rev: string | null,
  file: string,
  opts?: { probeSize?: boolean },
) {
  return {
    queryKey: ["repo", repo, "file-b64", rev ?? "worktree", file] as const,
    queryFn: () => api.gitFileBase64(repo, rev, file, opts?.probeSize ?? false),
    networkMode: "always" as const,
    staleTime: rev !== null && IMMUTABLE_REV.test(rev) ? Infinity : 0,
    retry: (failureCount: number, error: unknown) =>
      !(isAppError(error) && error.kind === "invalidArgument") &&
      shouldRetryQuery(failureCount, error),
  };
}

export function useFileAtRev(
  repo: string,
  rev: string | null,
  file: string,
  enabled: boolean,
) {
  return useQuery({ ...fileAtRevOptions(repo, rev, file), enabled });
}

/** The byte sizes of a binary diff's sides; idle while `args` is null. */
export function useBinarySizes(
  repo: string,
  args: {
    oldOid: string | null;
    newOid: string | null;
    worktreeFile: string | null;
    anchorCommit: string | null;
  } | null,
) {
  return useQuery({
    // Every input is in the key: the answer depends on all of them. Outside
    // workingTreeKeys' prefixes on purpose, since the ids already re-key on any
    // content change (the worktree side's newOid is its working-tree hash).
    queryKey: [
      "repo",
      repo,
      "blob-sizes",
      args?.oldOid ?? null,
      args?.newOid ?? null,
      args?.worktreeFile ?? null,
      args?.anchorCommit ?? null,
    ] as const,
    queryFn: () =>
      api.gitBlobSizes(
        repo,
        args?.oldOid ?? null,
        args?.newOid ?? null,
        args?.worktreeFile ?? null,
        args?.anchorCommit ?? null,
      ),
    enabled: args !== null,
    networkMode: "always",
    // Content-keyed, so it never goes stale, which also keeps it out of the
    // focus refetch. No placeholderData: it would show another file's sizes.
    staleTime: Infinity,
    retry: (failureCount, error) =>
      !(isAppError(error) && error.kind === "invalidArgument") &&
      shouldRetryQuery(failureCount, error),
  });
}

/** GitHub's byte sizes for an anchored binary diff's sides the local store
 *  couldn't size (a null id sends no lookup); idle while `args` is null. */
export function useGithubBlobSizes(
  repo: string,
  args: {
    oldOid: string | null;
    newOid: string | null;
    lens: RemoteLens;
  } | null,
) {
  return useQuery({
    // Outside the ["repo", …] subtree, as the lens key is: a repo mutation's
    // invalidation would refetch this active network read, and oid-keyed sizes
    // can't change; a null side (a missing or unparseable lens remote, the host
    // gate, or an id GitHub doesn't know) also holds until the query is collected.
    // The lens picks which GitHub repo answers.
    queryKey: [
      "github-blob-sizes",
      repo,
      args?.lens ?? null,
      args?.oldOid ?? null,
      args?.newOid ?? null,
    ] as const,
    queryFn: () =>
      api.githubBlobSizes(
        repo,
        args?.oldOid ?? null,
        args?.newOid ?? null,
        args?.lens ?? "origin",
      ),
    enabled: args !== null,
    // A forge read: the default network mode parks it offline. No placeholderData:
    // the oids are the identity, so it would show another file's sizes.
    staleTime: Infinity,
    retry: shouldRetryQuery,
  });
}

export function useApplyPatch(repo: string) {
  return useRepoMutation(
    repo,
    (args: { patch: string; cached: boolean; reverse: boolean }) =>
      api.gitApplyPatch(repo, args.patch, args.cached, args.reverse),
    {
      invalidate: workingTreeKeys(repo),
      // Local working-tree write — never park it offline.
      networkMode: "always",
    },
  );
}

export function useApplyPartial(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      diffText: string;
      selected: api.SelectedLine[];
      cached: boolean;
      reverse: boolean;
    }) =>
      api.gitApplyPartial(
        repo,
        args.diffText,
        args.selected,
        args.cached,
        args.reverse,
      ),
    {
      invalidate: workingTreeKeys(repo),
      // Local working-tree write — never park it offline.
      networkMode: "always",
    },
  );
}

/** Discards selected lines from an untracked (new) file (see
 *  {@link api.gitDiscardUntrackedLines}) — line/hunk discard for a new file. */
export function useDiscardUntrackedLines(repo: string) {
  return useRepoMutation(
    repo,
    (args: { path: string; lines: api.DiscardLine[] }) =>
      api.gitDiscardUntrackedLines(repo, args.path, args.lines),
    {
      invalidate: workingTreeKeys(repo),
      // Local working-tree write — never park it offline.
      networkMode: "always",
    },
  );
}

export function useUnstage(repo: string) {
  return useRepoMutation(
    repo,
    (paths: string[]) => api.gitUnstage(repo, paths),
    {
      invalidate: workingTreeKeys(repo),
      // Local working-tree write — never park it offline.
      networkMode: "always",
    },
  );
}

export function useCommit(repo: string) {
  // Awaited: only the working tree, so the emptied changes list, cleared draft,
  // and toast land together without waiting on forge queries; history and branch
  // counters refresh behind the toast (commitAftermathKeys).
  return useRepoMutation(
    repo,
    (args: {
      title: string;
      body?: string;
      amend?: boolean;
      expectedHead?: string | null;
      expectedBranch?: string | null;
    }) =>
      api.gitCommit(
        repo,
        args.title,
        args.body,
        args.amend ?? false,
        args.expectedHead,
        args.expectedBranch,
      ),
    {
      invalidate: workingTreeKeys(repo),
      invalidateAfter: commitAftermathKeys(repo),
      refetchBeforeSuccess: true,
      // Local commit write — never park it offline.
      networkMode: "always",
    },
  );
}

export function useAppendToGitignore(repo: string) {
  return useRepoMutation(
    repo,
    (patterns: string[]) => api.appendToGitignore(repo, patterns),
    {
      // Local working-tree write — never park it offline.
      networkMode: "always",
    },
  );
}

export function useAppendRepoAiIgnore(repo: string) {
  return useRepoMutation(
    repo,
    (patterns: string[]) => api.appendRepoAiIgnore(repo, patterns),
    // Staging-class edit — only the working tree changes (the aiignore file
    // appears/updates), so narrow like useStage/useApplySuggestion. The
    // AI-excluded view reads those rules, so it goes with them.
    {
      invalidate: [...workingTreeKeys(repo), aiExcludedKey(repo)],
      // Local working-tree write — never park it offline.
      networkMode: "always",
    },
  );
}

/**
 * Everything the AI-excluded view renders: the rules in force, which rule
 * decided each candidate file, and the names no rule could have decided.
 *
 * `exclude` is repo rules FIRST, global LAST — the same security invariant
 * `aiExcludePatterns` keeps, since last-match-wins and the repo file is
 * committed content: a committed `!` must never outrank a global exclude.
 * Verdicts index into that array, so the caller reads a rule's source from its
 * position.
 *
 * A name the listing flags `undecodable` leaves the corpus before the IPC call
 * and comes back as `unreadable`: generation hides such a name whatever the
 * patterns say, so attributing it to a rule would be a lie. The flag is judged on
 * the real bytes, so a name holding a real U+FFFD stays in the corpus and gets its
 * true verdict; two names sharing one lossy spelling fail closed together. Keyed
 * on the global patterns, so a settings edit produces a fresh view rather than a
 * stale attribution.
 */
export function useAiExcludedView(
  repo: string,
  enabled: boolean,
  globalPatterns: string,
) {
  return useQuery({
    queryKey: [...aiExcludedKey(repo), globalPatterns] as const,
    queryFn: async () => {
      const [repoRules, tracked, untracked] = await Promise.all([
        api.readRepoAiIgnore(repo),
        api.gitListTracked(repo),
        api.gitListUntracked(repo),
      ]);
      const globalRules = ignoreLines(globalPatterns);
      const exclude = [...repoRules, ...globalRules];
      const undecodableByPath = new Map<string, boolean>();
      for (const row of [...tracked, ...untracked]) {
        undecodableByPath.set(
          row.path,
          row.undecodable || (undecodableByPath.get(row.path) ?? false),
        );
      }
      const corpus: string[] = [];
      const unreadable: string[] = [];
      for (const [path, undecodable] of undecodableByPath) {
        (undecodable ? unreadable : corpus).push(path);
      }
      const verdicts =
        exclude.length > 0 && corpus.length > 0
          ? await api.gitAiIgnoreVerdicts(repo, corpus, exclude)
          : [];
      return {
        repoRules,
        globalRules,
        verdicts,
        untracked: untracked.map((row) => row.path),
        unreadable,
      };
    },
    enabled,
    staleTime: 30_000,
    networkMode: "always",
  });
}

export function useUntrack(repo: string) {
  return useRepoMutation(
    repo,
    (args: { pathspecs: string[]; ignorePatterns: string[] }) =>
      api.gitUntrack(repo, args.pathspecs, args.ignorePatterns),
    {
      // Local working-tree write — never park it offline.
      networkMode: "always",
    },
  );
}

/** Every file git tracks — for the Repository files manager. Fetched lazily. */
export function useTrackedFiles(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "tracked-files"] as const,
    queryFn: async () =>
      (await api.gitListTracked(repo)).map((row) => row.path),
    enabled,
    staleTime: 30_000,
    networkMode: "always",
  });
}

/** Slash-commands + skills available to `agent` (project + global). Fetched
 *  lazily while a slash command is being typed in the agent composer; keyed on
 *  the agent too, since each CLI reads different command/skill directories. */
export function useAgentCommands(
  repo: string,
  agent: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "agent-commands", agent] as const,
    queryFn: () => api.readAgentCommands(repo, agent),
    enabled,
    staleTime: 30_000,
    networkMode: "always",
  });
}

/** Files git ignores, with the rule responsible for each. Fetched lazily. */
export function useIgnoredFiles(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "ignored-files"] as const,
    queryFn: () => api.gitIgnoredFiles(repo),
    enabled,
    staleTime: 30_000,
    networkMode: "always",
  });
}

export function useForceAdd(repo: string) {
  return useRepoMutation(
    repo,
    (pathspecs: string[]) => api.gitForceAdd(repo, pathspecs),
    {
      // Local working-tree write — never park it offline.
      networkMode: "always",
    },
  );
}

export function useUnignoreRules(repo: string) {
  return useRepoMutation(
    repo,
    (rules: UnignoreRule[]) => api.gitUnignoreRules(repo, rules),
    {
      // Local working-tree write — never park it offline.
      networkMode: "always",
    },
  );
}

/** Deletes lines from the repo's `.gitdesktop/aiignore`. Same narrowing as
 *  {@link useAppendRepoAiIgnore} — the file is working-tree content, and the
 *  AI-excluded view reads the rules it holds. */
export function useRemoveRepoAiIgnore(repo: string) {
  return useRepoMutation(
    repo,
    (patterns: string[]) => api.removeRepoAiIgnore(repo, patterns),
    {
      invalidate: [...workingTreeKeys(repo), aiExcludedKey(repo)],
      // Local working-tree write — never park it offline.
      networkMode: "always",
    },
  );
}
