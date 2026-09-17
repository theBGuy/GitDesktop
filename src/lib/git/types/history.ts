export interface CommitSummary {
  hash: string;
  subject: string;
  author: string;
  /** Author email (%ae) — drives the History-tab commit avatar. May be "". */
  authorEmail: string;
  date: string;
  /** Tags pointing at this commit. */
  tags: string[];
  /** More than one parent — history rewriting must not cross it. */
  isMerge: boolean;
}

export interface CommitDetails {
  hash: string;
  subject: string;
  body: string;
  author: string;
  authorEmail: string;
  date: string;
}

/** One line of `git blame`: its content plus the commit that last changed it. */
export interface BlameLine {
  lineNo: number;
  hash: string;
  author: string;
  /** Author time, epoch seconds. */
  time: number;
  summary: string;
  content: string;
}

export interface CommitResult {
  hash: string;
}

/** One TODO/FIXME/HACK/… comment found in the working tree by `git_todo_scan`. */
export interface TodoScanItem {
  /** Repo-relative path, forward slashes. */
  path: string;
  /** 1-based line number of the match. */
  line: number;
  /** The marker word that matched, e.g. `"TODO"`. */
  marker: string;
  /** The comment text after the marker (may be `""`); capped at 300 chars
   *  server-side. */
  text: string;
}

/** Result of a working-tree TODO scan (`git_todo_scan`). */
export interface TodoScan {
  /** Matches in git grep output order (grouped by path). */
  items: TodoScanItem[];
  /** The global cap (default 2000) was hit — more matches may exist. */
  truncated: boolean;
}

export interface CommitAuthor {
  name: string;
  email: string;
}

/** One resulting commit in a history rewrite (multi-hash = squash). */
export interface RewriteStep {
  hashes: string[];
  message?: string;
  /** Pause at this commit (interactive-rebase path only; the replay engine
   *  ignores it). */
  edit?: boolean;
}
