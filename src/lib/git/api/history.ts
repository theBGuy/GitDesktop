import { invoke } from "@/lib/tauri/invoke";
import type {
  BlameLine,
  CommitAuthor,
  CommitDetails,
  CommitSummary,
  DiffStatEntry,
  FileDiff,
  StagedDiff,
  TodoScan,
} from "../types";

export const gitCommitAuthors = (repoPath: string) =>
  invoke<CommitAuthor[]>("git_commit_authors", { repoPath });

export const gitCommitDiff = (
  repoPath: string,
  hash: string,
  maxBytes?: number,
) =>
  invoke<StagedDiff>("git_commit_diff", {
    repoPath,
    hash,
    maxBytes: maxBytes ?? null,
  });

export const gitRecentCommits = (repoPath: string, limit: number) =>
  invoke<CommitSummary[]>("git_recent_commits", { repoPath, limit });

export const gitLog = (
  repoPath: string,
  limit: number,
  skip: number,
  /** When set, search the whole history by commit message instead of paging. */
  search?: string,
) =>
  invoke<CommitSummary[]>("git_log", {
    repoPath,
    limit,
    skip,
    search: search ?? null,
  });

export const gitCommitDetails = (repoPath: string, hash: string) =>
  invoke<CommitDetails>("git_commit_details", { repoPath, hash });

export const gitFileLog = (
  repoPath: string,
  path: string,
  limit: number,
  skip: number,
) => invoke<CommitSummary[]>("git_file_log", { repoPath, path, limit, skip });

export const gitBlame = (repoPath: string, path: string, rev?: string | null) =>
  invoke<BlameLine[]>("git_blame", { repoPath, path, rev: rev ?? null });

export const gitCommitFiles = (repoPath: string, hash: string) =>
  invoke<DiffStatEntry[]>("git_commit_files", { repoPath, hash });

export const gitCommitFileDiff = (
  repoPath: string,
  hash: string,
  filePath: string,
) => invoke<FileDiff>("git_commit_file_diff", { repoPath, hash, filePath });

/** Scans the working tree for TODO/FIXME/HACK/… code comments (case-sensitive
 *  fixed-string `git grep`), grouped by path in output order. `maxHits` caps the
 *  total (default 2000 server-side); `truncated` reports when the cap was hit. */
export const gitTodoScan = (
  repoPath: string,
  markers: string[],
  maxHits?: number,
) => invoke<TodoScan>("git_todo_scan", { repoPath, markers, maxHits });
