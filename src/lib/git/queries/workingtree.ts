import { useQuery } from "@tanstack/react-query";
import { ignoreLines, REPLACEMENT_CHAR } from "@/lib/ai/ignore";
import * as api from "../api";
import {
  checkoutConflictSide,
  conflictSides,
  resolveConflict,
} from "../conflict";
import { literalPathspec } from "../glob";
import type { RepoOp, UnignoreRule } from "../types";
import { repoKeys } from "./core";
import { useRepoMutation, workingTreeKeys } from "./internal";

/** Prefix of every {@link useAiExcludedView} key for a repo (the global-pattern
 *  axis follows), so a rule edit invalidates the view whatever settings held. */
const aiExcludedKey = (repo: string) => ["repo", repo, "ai-excluded"] as const;

/** The families a commit (or amend) makes stale BEYOND the working tree —
 *  history, branch tips/counters, HEAD-rev blobs, and operation state, both
 *  in-flight (a commit can conclude a merge or an interrupted journaled op)
 *  and prospective (merge/conflict previews, local-PR merge states).
 *  Invalidated fire-and-forget so the Commit button never waits on them;
 *  forge-backed keys (pr/issue/CI/…) are deliberately absent — a local
 *  commit cannot change forge state. */
const commitAftermathKeys = (repo: string) =>
  [
    repoKeys.log(repo),
    repoKeys.commits(repo),
    repoKeys.branches(repo),
    ["repo", repo, "log-search"],
    ["repo", repo, "recent-commits"],
    ["repo", repo, "commit-authors"],
    ["repo", repo, "unpushed-count"],
    ["repo", repo, "unpushed-messages"],
    ["repo", repo, "branch-stats"],
    ["repo", repo, "stats"],
    ["repo", repo, "divergence"],
    ["repo", repo, "compare"],
    ["repo", repo, "file-log"],
    ["repo", repo, "blame"],
    ["repo", repo, "file-b64", "HEAD"],
    repoKeys.opState(repo),
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

export function useFileDiff(
  repo: string,
  file: { path: string; staged: boolean; untracked: boolean } | null,
) {
  return useQuery({
    // `untracked` is in the key so the untracked→tracked flip (after staging part
    // of a new file) subscribes to a fresh query — the `--no-index` "all new"
    // diff and the normal remainder diff must not share a cache entry, or an
    // invalidation race could leave the stale all-lines view on screen.
    queryKey: [
      ...repoKeys.diff(repo, file?.path ?? "", file?.staged ?? false),
      file?.untracked ?? false,
    ] as const,
    queryFn: () =>
      api.gitDiffFile(
        repo,
        file?.path ?? "",
        file?.staged ?? false,
        file?.untracked ?? false,
      ),
    enabled: file !== null,
  });
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
  return useQuery({
    queryKey: [...repoKeys.diff(repo, filePath, false), "session-base", base],
    queryFn: () => api.gitSessionFileDiff(repo, filePath, base),
    enabled: enabled && Boolean(repo && filePath && base),
    refetchInterval: enabled && live ? 1500 : false,
    refetchIntervalInBackground: false,
  });
}

export function useStage(repo: string) {
  return useRepoMutation(repo, (paths: string[]) => api.gitStage(repo, paths), {
    invalidate: workingTreeKeys(repo),
  });
}

export function useOpState(repo: string) {
  return useQuery({
    queryKey: repoKeys.opState(repo),
    queryFn: () => api.gitOpState(repo),
  });
}

export function useOpAbort(repo: string) {
  return useRepoMutation(repo, (op: RepoOp) => api.gitOpAbort(repo, op));
}

export function useOpContinue(repo: string) {
  return useRepoMutation(repo, (op: RepoOp) => api.gitOpContinue(repo, op));
}

/** The conflicted file's sides + marked working text, for the conflict editor.
 *  Re-fetches after each per-region resolve (the mutations invalidate this). */
export function useConflictFile(repo: string, path: string) {
  return useQuery({
    queryKey: ["repo", repo, "conflict-file", path] as const,
    queryFn: () => conflictSides(repo, path, []),
    retry: false,
  });
}

const conflictFileKeys = (repo: string) =>
  [...workingTreeKeys(repo), ["repo", repo, "conflict-file"]] as const;

/** Writes a conflict resolution, staging it when `stage` (marks resolved).
 *  Invalidates the working tree + conflict editor so they refresh. */
export function useResolveConflict(repo: string) {
  return useRepoMutation(
    repo,
    (args: { path: string; content: string; stage: boolean }) =>
      resolveConflict(repo, args.path, args.content, args.stage),
    { invalidate: conflictFileKeys(repo) },
  );
}

/** Resolves a whole conflicted file by taking one side ("ours"/"theirs"). */
export function useCheckoutConflictSide(repo: string) {
  return useRepoMutation(
    repo,
    (args: { path: string; side: "ours" | "theirs" }) =>
      checkoutConflictSide(repo, args.path, args.side),
    { invalidate: conflictFileKeys(repo) },
  );
}

/** Stages a conflicted file exactly as it stands on disk — edited, emptied, or
 *  removed — which marks the conflict resolved. */
export function useMarkConflictResolved(repo: string) {
  return useRepoMutation(
    repo,
    (path: string) => api.gitStage(repo, [literalPathspec(path)]),
    { invalidate: conflictFileKeys(repo) },
  );
}

export function useFileAtRev(
  repo: string,
  rev: string | null,
  file: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "file-b64", rev ?? "worktree", file] as const,
    queryFn: () => api.gitFileBase64(repo, rev, file),
    enabled,
  });
}

export function useApplyPatch(repo: string) {
  return useRepoMutation(
    repo,
    (args: { patch: string; cached: boolean; reverse: boolean }) =>
      api.gitApplyPatch(repo, args.patch, args.cached, args.reverse),
    { invalidate: workingTreeKeys(repo) },
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
    { invalidate: workingTreeKeys(repo) },
  );
}

/** Discards selected lines from an untracked (new) file (see
 *  {@link api.gitDiscardUntrackedLines}) — line/hunk discard for a new file. */
export function useDiscardUntrackedLines(repo: string) {
  return useRepoMutation(
    repo,
    (args: { path: string; lines: number[] }) =>
      api.gitDiscardUntrackedLines(repo, args.path, args.lines),
    { invalidate: workingTreeKeys(repo) },
  );
}

export function useUnstage(repo: string) {
  return useRepoMutation(
    repo,
    (paths: string[]) => api.gitUnstage(repo, paths),
    { invalidate: workingTreeKeys(repo) },
  );
}

export function useCommit(repo: string) {
  // Awaited: only the working tree, so the emptied changes list, cleared draft,
  // and toast land together without waiting on forge queries; history and branch
  // counters refresh behind the toast (commitAftermathKeys).
  return useRepoMutation(
    repo,
    (args: { title: string; body?: string; amend?: boolean }) =>
      api.gitCommit(repo, args.title, args.body, args.amend ?? false),
    {
      invalidate: workingTreeKeys(repo),
      invalidateAfter: commitAftermathKeys(repo),
      refetchBeforeSuccess: true,
    },
  );
}

export function useAppendToGitignore(repo: string) {
  return useRepoMutation(repo, (patterns: string[]) =>
    api.appendToGitignore(repo, patterns),
  );
}

export function useAppendRepoAiIgnore(repo: string) {
  return useRepoMutation(
    repo,
    (patterns: string[]) => api.appendRepoAiIgnore(repo, patterns),
    // Staging-class edit — only the working tree changes (the aiignore file
    // appears/updates), so narrow like useStage/useApplySuggestion. The
    // AI-excluded view reads those rules, so it goes with them.
    { invalidate: [...workingTreeKeys(repo), aiExcludedKey(repo)] },
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
 * A name carrying U+FFFD leaves the corpus before the IPC call and comes back
 * as `unreadable`: generation hides such a name whatever the patterns say, so
 * attributing it to a rule would be a lie. That is a conservative string-domain
 * rule — `gitListTracked`/`gitListUntracked` decode lossily, so a real U+FFFD is
 * indistinguishable here, while the Rust arms judge real bytes. Keyed on the
 * global patterns, so a settings edit produces a fresh view rather than a stale
 * attribution.
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
      const candidates = [...new Set([...tracked, ...untracked])];
      const corpus = candidates.filter((p) => !p.includes(REPLACEMENT_CHAR));
      const unreadable = candidates.filter((p) => p.includes(REPLACEMENT_CHAR));
      const verdicts =
        exclude.length > 0 && corpus.length > 0
          ? await api.gitAiIgnoreVerdicts(repo, corpus, exclude)
          : [];
      return { repoRules, globalRules, verdicts, untracked, unreadable };
    },
    enabled,
    staleTime: 30_000,
  });
}

export function useUntrack(repo: string) {
  return useRepoMutation(
    repo,
    (args: { pathspecs: string[]; ignorePatterns: string[] }) =>
      api.gitUntrack(repo, args.pathspecs, args.ignorePatterns),
  );
}

/** Every file git tracks — for the Repository files manager. Fetched lazily. */
export function useTrackedFiles(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "tracked-files"] as const,
    queryFn: () => api.gitListTracked(repo),
    enabled,
    staleTime: 30_000,
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
  });
}

/** Files git ignores, with the rule responsible for each. Fetched lazily. */
export function useIgnoredFiles(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "ignored-files"] as const,
    queryFn: () => api.gitIgnoredFiles(repo),
    enabled,
    staleTime: 30_000,
  });
}

export function useForceAdd(repo: string) {
  return useRepoMutation(repo, (pathspecs: string[]) =>
    api.gitForceAdd(repo, pathspecs),
  );
}

export function useUnignoreRules(repo: string) {
  return useRepoMutation(repo, (rules: UnignoreRule[]) =>
    api.gitUnignoreRules(repo, rules),
  );
}

/** Deletes lines from the repo's `.gitdesktop/aiignore`. Same narrowing as
 *  {@link useAppendRepoAiIgnore} — the file is working-tree content, and the
 *  AI-excluded view reads the rules it holds. */
export function useRemoveRepoAiIgnore(repo: string) {
  return useRepoMutation(
    repo,
    (patterns: string[]) => api.removeRepoAiIgnore(repo, patterns),
    { invalidate: [...workingTreeKeys(repo), aiExcludedKey(repo)] },
  );
}
