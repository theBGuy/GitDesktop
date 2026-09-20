export type ChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "conflicted"
  | "untracked";

export interface FileEntry {
  path: string;
  origPath?: string;
  staged: ChangeKind | null;
  unstaged: ChangeKind | null;
}

export interface FileDiff {
  filePath: string;
  isBinary: boolean;
  isTruncated: boolean;
  text: string;
}

export interface DiffStatEntry {
  path: string;
  added: number;
  deleted: number;
  isBinary: boolean;
}

/** Per-file line counts for the working tree, one list per diff side. Untracked
 *  paths report on the unstaged side with every line counted as an addition —
 *  numstat reports tracked changes alone, so those counts are read from the
 *  worktree. */
export interface WorkingLineStats {
  /** Index vs HEAD — what the Staged section's rows show. */
  staged: DiffStatEntry[];
  /** Working tree vs index — what the Changes section's rows show. */
  unstaged: DiffStatEntry[];
}

export interface StagedDiff {
  text: string;
  truncated: boolean;
  files: DiffStatEntry[];
  /** Changed files hidden from the AI context by ignore patterns. */
  excludedFiles: number;
}

/** Why a `DeltaDiff` could (or couldn't) be computed — drives how the caller
 *  frames or omits the "changes since last review" delta. */
export type DeltaReason = "ok" | "missing" | "rewritten" | "indeterminate";

/** The literal two-dot `from..to` diff ("what changed since"), with a `reason`
 *  for graceful fallback when the delta can't be produced. */
export interface DeltaDiff {
  resolvable: boolean;
  isAncestor: boolean;
  reason: DeltaReason;
  text: string;
  truncated: boolean;
  files: DiffStatEntry[];
}

/** Result of applying a review suggestion to the working tree (see
 *  `gitReplaceFileLines` for the verification/EOL contract). */
export interface ApplyLinesResult {
  /** File was staged (only when it had no other local changes before the apply). */
  staged: boolean;
  /** File already had local changes before the apply — we never auto-stage then. */
  hadLocalChanges: boolean;
}

/** An ignored file and the .gitignore rule responsible for ignoring it. A
 *  trailing "/" on `path` marks a collapsed fully-ignored directory. */
export interface IgnoredFile {
  path: string;
  source: string;
  line: number;
  pattern: string;
}

/** A gitignore rule to delete: the file it lives in + its exact pattern line. */
export interface UnignoreRule {
  source: string;
  pattern: string;
}

/** Which AI-ignore rule decided a path, from git's own matcher. Covers every
 *  path a rule decides, INCLUDING one whose decider is a `!` negation — that
 *  path stays visible to AI, so `negated` is the gate on "is this hidden". */
export interface AiIgnoreVerdict {
  /** Path exactly as sent. */
  path: string;
  /** 0-based index into the exclude array AS PASSED of the deciding line. */
  patternIndex: number;
  /** The deciding line as the matcher read it (trimmed). */
  pattern: string;
  /** True when the deciding line is a `!` negation — the path is NOT hidden. */
  negated: boolean;
}
