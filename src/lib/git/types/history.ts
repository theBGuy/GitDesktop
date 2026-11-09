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

/** A commit whose id starts with a searched prefix. */
export interface CommitPrefixMatch {
  commit: CommitSummary;
  /** An ancestor of HEAD. */
  onBranch: boolean;
}

/** One file-history entry: the commit plus the file's path as of that commit. */
export interface FileLogEntry extends CommitSummary {
  path: string;
}

export interface CommitDetails {
  hash: string;
  subject: string;
  body: string;
  author: string;
  authorEmail: string;
  /** Author date, strict ISO 8601 (%aI). */
  date: string;
  /**
   * Committer date, strict ISO 8601 (%cI); always present. May differ from
   * `date` after a rewrite, a cherry-pick or an applied patch.
   */
  committerDate: string;
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

/** What a raced amend rewrote instead of the commit the user saw. */
export interface AmendRace {
  rewrote: string | null;
  branch: string | null;
  detached: boolean;
}

export interface CommitResult {
  hash: string;
  raced: AmendRace | null;
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

/** A commit timestamp as git records it: seconds since the Unix epoch plus the
 *  UTC offset in minutes (east positive). Mirrors the Rust `CommitDate`. */
export interface CommitDate {
  epochSeconds: number;
  offsetMinutes: number;
}

/** One resulting commit in a history rewrite (multi-hash = squash). */
export interface RewriteStep {
  hashes: string[];
  message?: string;
  /** Pause at this commit (interactive-rebase path only; the replay engine
   *  ignores it). */
  edit?: boolean;
  /** The commit's new dates; omitted = no change (git keeps the author date and
   *  stamps the committer date with the time of the rewrite). A fold group's
   *  dates apply to the one commit the group makes. */
  authorDate?: CommitDate;
  committerDate?: CommitDate;
}
