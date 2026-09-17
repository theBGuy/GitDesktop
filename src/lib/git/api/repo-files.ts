import { invoke } from "@/lib/tauri/invoke";
import type { AiIgnoreVerdict } from "../types";

export const readRepoInstructions = (repoPath: string) =>
  invoke<string | null>("read_repo_instructions", { repoPath });

export const readRepoAiIgnore = (repoPath: string) =>
  invoke<string[]>("read_repo_ai_ignore", { repoPath });

/** Appends AI-ignore patterns to `<repo>/.gitdesktop/aiignore` (created if
 *  absent), returning the number actually appended. Skipped only when already
 *  EFFECTIVE — a pattern sitting before a later `!` un-ignore line is re-added
 *  at the end, where last-match-wins puts it back in force. */
export const appendRepoAiIgnore = (repoPath: string, patterns: string[]) =>
  invoke<number>("append_repo_ai_ignore", { repoPath, patterns });

/** Deletes lines from `<repo>/.gitdesktop/aiignore`, matched as the matcher
 *  reads them (trimmed), returning the number actually removed. */
export const removeRepoAiIgnore = (repoPath: string, patterns: string[]) =>
  invoke<number>("remove_repo_ai_ignore", { repoPath, patterns });

/** Which of `paths` the user's AI-ignore patterns hide, decided by git's own
 *  gitignore engine — the same matcher the diff commands filter through. For
 *  path lists the frontend holds itself (a remote PR's changed files): the paths
 *  need not exist in the working tree or index. Returns `[]` when nothing
 *  matches, or when either list is empty. */
export const gitFilterAiIgnored = (
  repoPath: string,
  paths: string[],
  exclude: string[],
) => invoke<string[]>("git_filter_ai_ignored", { repoPath, paths, exclude });

/** Which rule decided each of `paths`, for the same matcher and `exclude` list
 *  {@link gitFilterAiIgnored} filters through — the verification surface behind
 *  the hiding. Every decided path is reported, negations included; paths no rule
 *  touches are absent. */
export const gitAiIgnoreVerdicts = (
  repoPath: string,
  paths: string[],
  exclude: string[],
) =>
  invoke<AiIgnoreVerdict[]>("git_ai_ignore_verdicts", {
    repoPath,
    paths,
    exclude,
  });

/** Raw contents of `<repo>/.gitdesktop/branch-rules.json`, or null if absent. */
export const readRepoBranchRules = (repoPath: string) =>
  invoke<string | null>("read_repo_branch_rules", { repoPath });

/** Writes `<repo>/.gitdesktop/branch-rules.json` (caller passes serialized JSON). */
export const writeRepoBranchRules = (repoPath: string, contents: string) =>
  invoke<void>("write_repo_branch_rules", { repoPath, contents });

/** Raw contents of `<repo>/.gitdesktop/syntax.json`, or null if absent. */
export const readRepoSyntax = (repoPath: string) =>
  invoke<string | null>("read_repo_syntax", { repoPath });

/** Writes `<repo>/.gitdesktop/syntax.json` (caller passes serialized JSON). */
export const writeRepoSyntax = (repoPath: string, contents: string) =>
  invoke<void>("write_repo_syntax", { repoPath, contents });

/** A slash-command or skill discovered for an agent (project or global). */
export interface AgentCommand {
  name: string;
  description: string;
  /** Command body (`$ARGUMENTS`/`$1..` expanded on use); empty for skills. */
  prompt: string;
  argumentHint: string;
  kind: "command" | "skill";
  scope: "project" | "global";
}

/** Slash-commands + skills available to `agent`, from the repo and the user's
 *  home, following each CLI's conventions + the canonical `.agents/skills`. */
export const readAgentCommands = (repoPath: string, agent: string) =>
  invoke<AgentCommand[]>("read_agent_commands", { repoPath, agent });

/** Reads a small text file the user picked (for importing a language config). */
export const readTextFile = (path: string) =>
  invoke<string>("read_text_file", { path });
