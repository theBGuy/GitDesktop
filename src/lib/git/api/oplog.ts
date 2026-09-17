import { invoke } from "@/lib/tauri/invoke";
import type { OpLogEntry, RepoOp, RepoOpState } from "../types";

/** Full operation journal, newest-first (pure read). */
export const gitOplogList = (repoPath: string) =>
  invoke<OpLogEntry[]>("git_oplog_list", { repoPath });

/** Reconciles the journal against the repo and returns the genuinely
 *  interrupted op (0 or 1). Writes the store as an idempotent side effect. */
export const gitOplogCheck = (repoPath: string) =>
  invoke<OpLogEntry[]>("git_oplog_check", { repoPath });

/** Marks a journal entry "dismissed" so it stops surfacing as interrupted. */
export const gitOplogDismiss = (repoPath: string, id: string) =>
  invoke<void>("git_oplog_dismiss", { repoPath, id });

export const gitOpState = (repoPath: string) =>
  invoke<RepoOpState>("git_op_state", { repoPath });

export const gitOpAbort = (repoPath: string, op: RepoOp) =>
  invoke<void>("git_op_abort", { repoPath, op });

/** Resolves true when the operation completed normally, false when the pending
 *  cherry-pick was skipped because the resolution left nothing to commit. The
 *  flag speaks for that pick alone: it fully describes a single-commit
 *  cherry-pick, while a longer sequence may still have applied its remaining
 *  picks. */
export const gitOpContinue = (repoPath: string, op: RepoOp) =>
  invoke<boolean>("git_op_continue", { repoPath, op });
