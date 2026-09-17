import { invoke } from "@/lib/tauri/invoke";
import type { GitLabTimeStats } from "../types";

// GitLab time tracking (estimate + spent) on issues and MRs — `implemented.timeTracking`.
// Durations use GitLab's human format ("3h", "1d 2h 30m"); the server validates. Every
// write returns the fresh {@link GitLabTimeStats}, so callers write it straight into the
// cache.
export const forgeGlIssueTimeStats = (repoPath: string, number: number) =>
  invoke<GitLabTimeStats>("forge_gl_issue_time_stats", { repoPath, number });

export const forgeGlMrTimeStats = (repoPath: string, number: number) =>
  invoke<GitLabTimeStats>("forge_gl_mr_time_stats", { repoPath, number });

/** Set or reset (null/empty) an issue's estimate. */
export const forgeGlIssueSetTimeEstimate = (
  repoPath: string,
  number: number,
  duration: string | null,
) =>
  invoke<GitLabTimeStats>("forge_gl_issue_set_time_estimate", {
    repoPath,
    number,
    duration,
  });

/** Add to (or, with null, reset) an issue's spent time. Positive adds; a
 *  negative duration ("-15m") subtracts. */
export const forgeGlIssueAddSpentTime = (
  repoPath: string,
  number: number,
  duration: string | null,
) =>
  invoke<GitLabTimeStats>("forge_gl_issue_add_spent_time", {
    repoPath,
    number,
    duration,
  });

export const forgeGlMrSetTimeEstimate = (
  repoPath: string,
  number: number,
  duration: string | null,
) =>
  invoke<GitLabTimeStats>("forge_gl_mr_set_time_estimate", {
    repoPath,
    number,
    duration,
  });

export const forgeGlMrAddSpentTime = (
  repoPath: string,
  number: number,
  duration: string | null,
) =>
  invoke<GitLabTimeStats>("forge_gl_mr_add_spent_time", {
    repoPath,
    number,
    duration,
  });
