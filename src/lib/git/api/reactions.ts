import { invoke } from "@/lib/tauri/invoke";
import type { IssueReactions, RemoteLens } from "../types";

export const forgeIssueReactions = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) =>
  invoke<IssueReactions>("forge_issue_reactions", { repoPath, number, lens });

/** The reaction subject travels in BOTH provider vocabularies: GitHub keys on
 *  `subjectId` (a GraphQL node id) and ignores `target`/`number`; GitLab keys on
 *  `target` ("issue"/"mr") + `number`, with `subjectId` empty for the body or
 *  the note id for a comment. Discussions (GitHub-only) pass "discussion". */
export type ReactionTarget = "issue" | "mr" | "discussion";

export const forgeAddReaction = (
  repoPath: string,
  target: ReactionTarget,
  number: number,
  subjectId: string,
  content: string,
) =>
  invoke<void>("forge_add_reaction", {
    repoPath,
    target,
    number,
    subjectId,
    content,
  });

export const forgeRemoveReaction = (
  repoPath: string,
  target: ReactionTarget,
  number: number,
  subjectId: string,
  content: string,
) =>
  invoke<void>("forge_remove_reaction", {
    repoPath,
    target,
    number,
    subjectId,
    content,
  });

/** Reactions for a PR/MR body + each comment (keyed by the comment's id — a
 *  GraphQL node id on GitHub, a note id on GitLab). */
export const forgePrReactions = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) => invoke<IssueReactions>("forge_pr_reactions", { repoPath, number, lens });
