export interface LanguageStat {
  name: string;
  files: number;
  lines: number;
  bytes: number;
}

export interface ContributorStat {
  name: string;
  commits: number;
}

export interface RepoStats {
  commitCount: number;
  branchCount: number;
  tagCount: number;
  contributorCount: number;
  topContributors: ContributorStat[];
  firstCommitDate: string | null;
  lastCommitDate: string | null;
  trackedFiles: number;
  trackedBytes: number;
  gitDirBytes: number;
  totalLines: number;
  languages: LanguageStat[];
}

export interface BranchStats {
  commitCount: number;
  contributorCount: number;
  topContributors: ContributorStat[];
  firstCommitDate: string | null;
  lastCommitDate: string | null;
  filesChanged: number;
  additions: number;
  deletions: number;
}

// ── Insights graphs (local-git) ──────────────────────────────────────────────

/** A contributor with commit count + line churn, for the Insights tab. */
export interface ContributorChurn {
  name: string;
  commits: number;
  additions: number;
  deletions: number;
}

/** Commits in one ISO week ("2025-07"); sorts chronologically as a string. */
export interface WeekCount {
  week: string;
  commits: number;
}

/** Additions/deletions in one ISO week, for the code-frequency graph. */
export interface CodeFreqPoint {
  week: string;
  additions: number;
  deletions: number;
}

/** Punch card: 7 rows (day-of-week, 0=Sun) × 24 columns (hour) of commit counts. */
export type PunchCard = number[][];

/** Community-health profile + social counts (gh API), for the Insights tab. */
export interface CommunityInsights {
  healthPercentage: number;
  hasReadme: boolean;
  hasLicense: boolean;
  hasCodeOfConduct: boolean;
  hasContributing: boolean;
  hasIssueTemplate: boolean;
  hasPullRequestTemplate: boolean;
  license: string | null;
  forksCount: number;
  stargazersCount: number;
  watchersCount: number;
  openIssuesCount: number;
  private: boolean;
}

/** One day of traffic (views or clones). */
export interface TrafficPoint {
  timestamp: string;
  count: number;
  uniques: number;
}

/** A traffic referrer or popular path. */
export interface TrafficItem {
  name: string;
  title: string;
  count: number;
  uniques: number;
}

/** 14-day repo traffic (gh API; needs push access → `available: false` if not). */
export interface RepoTraffic {
  available: boolean;
  viewsCount: number;
  viewsUniques: number;
  views: TrafficPoint[];
  clonesCount: number;
  clonesUniques: number;
  clones: TrafficPoint[];
  referrers: TrafficItem[];
  paths: TrafficItem[];
}

export interface DependencyPackage {
  ecosystem: string;
  name: string;
  version: string;
  /** Declared directly by the repo (vs. pulled in transitively). */
  direct: boolean;
}

/** Dependency-graph SBOM summary (gh API; `available: false` when the graph is off). */
export interface RepoDependencies {
  available: boolean;
  total: number;
  packages: DependencyPackage[];
}

/** One direct fork, with the activity signals every provider can supply.
 *  `activeAt` is the provider's own recency field (GitHub `pushed_at`, GitLab
 *  `last_activity_at`, Bitbucket `updated_on`), so the UI names the verb per
 *  provider; `stars` is null where the platform has no star concept (Bitbucket). */
export interface ForgeForkEntry {
  /** "owner/name" — a GitLab fork under a subgroup reads "group/sub/name". */
  fullName: string;
  webUrl: string;
  activeAt: string | null;
  stars: number | null;
  isPrivate: boolean;
  /** The fork's own default branch — the compare head; null when unknown. */
  defaultBranch: string | null;
}

/** A repo's direct forks, most-recently-active first (max 10). `totalCount` is the
 *  provider's whole count, so it can legitimately exceed the listed rows; null when
 *  the provider states no authoritative total (the normal case on Bitbucket). */
export interface ForgeForkActivity {
  totalCount: number | null;
  /** The open repo's default branch — the compare base; null when unknown. */
  defaultBranch: string | null;
  forks: ForgeForkEntry[];
}

/** How far one fork's branch has moved relative to the open repo's base branch. */
export interface ForgeForkDivergence {
  aheadBy: number;
  behindBy: number;
}
