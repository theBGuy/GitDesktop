import { invoke } from "@/lib/tauri/invoke";
import type { CommitCommentOut, RemoteLens } from "../types";

// Commit comments (GitHub commit comments / GitLab commit notes) — plain or
// diff-anchored, provider-neutral. `sha` is the commit; `commentId` addresses a
// single comment for edit/delete.
export const forgeCommitComments = (
  repoPath: string,
  sha: string,
  lens: RemoteLens,
) =>
  invoke<CommitCommentOut[]>("forge_commit_comments", { repoPath, sha, lens });

export const forgeCommitCommentCreate = (
  repoPath: string,
  args: {
    sha: string;
    body: string;
    path?: string;
    line?: number;
    startLine?: number;
    position?: number;
  },
  lens: RemoteLens,
) =>
  invoke<void>("forge_commit_comment_create", {
    repoPath,
    sha: args.sha,
    body: args.body,
    path: args.path ?? null,
    line: args.line ?? null,
    startLine: args.startLine ?? null,
    position: args.position ?? null,
    lens,
  });

export const forgeCommitCommentEdit = (
  repoPath: string,
  args: { sha: string; commentId: string; body: string },
  lens: RemoteLens,
) =>
  invoke<void>("forge_commit_comment_edit", {
    repoPath,
    sha: args.sha,
    commentId: args.commentId,
    body: args.body,
    lens,
  });

export const forgeCommitCommentDelete = (
  repoPath: string,
  args: { sha: string; commentId: string },
  lens: RemoteLens,
) =>
  invoke<void>("forge_commit_comment_delete", {
    repoPath,
    sha: args.sha,
    commentId: args.commentId,
    lens,
  });
