/** Which secret store a name lives in. Variables are Actions-only. */
export type SecretApp = "actions" | "dependabot" | "codespaces";

/** A secret's metadata — GitHub never returns the value, only set/delete. */
export interface GhSecret {
  name: string;
  updatedAt: string;
}

/** An Actions variable. Unlike a secret, its value is readable and editable. */
export interface GhVariable {
  name: string;
  value: string;
  updatedAt: string;
}

/** A repo permission level (the invitation/role vocabulary). */
export type RepoRole = "read" | "triage" | "write" | "maintain" | "admin";

/** A repo collaborator. (GitHub can't reliably distinguish a direct grant from
 *  one inherited via a team/org, so we just show the effective role.) */
export interface Collaborator {
  login: string;
  avatarUrl: string;
  /** read | triage | write | maintain | admin */
  roleName: string;
}

/** A pending repo invitation (not yet accepted). */
export interface Invitation {
  id: string;
  login: string;
  avatarUrl: string;
  permission: RepoRole;
  createdAt: string;
}

/** GitHub Pages site config (null when Pages is disabled). */
export interface PagesInfo {
  htmlUrl: string;
  /** "built" | "building" | "errored" | "" */
  status: string;
  /** "legacy" (deploy from a branch) | "workflow" (GitHub Actions) */
  buildType: string;
  sourceBranch: string;
  sourcePath: string;
  cname: string;
  httpsEnforced: boolean;
  /** TLS certificate state for a custom domain — one of "new",
   * "authorization_created", "authorization_pending", "authorized",
   * "uploaded", "approved", "errored", "bad_authz". `null` when the repo has no
   * custom domain (no certificate is provisioned). */
  httpsCertificateState: string | null;
}

export type RulesetEnforcement = "active" | "evaluate" | "disabled";

/** A repo ruleset in the list view. */
export interface RulesetSummary {
  id: number;
  name: string;
  target: string;
  enforcement: string;
  /** "Repository" | "Organization" — org rulesets are read-only from a repo. */
  sourceType: string;
}

/** The full ruleset object (raw GitHub schema, snake_case) for the editor. Only what
 *  the editor reads is modelled; the object carries the rest of GitHub's schema, and
 *  a save spreads those fields back so the full PUT replace doesn't drop them. */
export interface RulesetFull {
  id: number;
  name: string;
  target?: string;
  enforcement: string;
  conditions?: {
    ref_name?: { include?: string[]; exclude?: string[] };
  } & Record<string, unknown>;
  bypass_actors?: unknown[];
  rules?: { type: string; parameters?: Record<string, unknown> }[];
}

/** A GitHub App that reports checks on the repo, for naming a required-check
 *  entry's `integration_id` pin. An app that has never reported on the default
 *  branch's head is absent, and its pin stays unresolved. */
export interface CheckApp {
  id: number;
  name: string;
  slug: string;
}

/** What a branch's active rules demand of a pull request, aggregated across every
 *  ruleset that applies. GitHub only. */
export interface BranchRequiredRules {
  /** Required status-check contexts, in GitHub's own order and deduplicated. */
  contexts: string[];
  /** Approving reviews the rules require; `null` when no rule names a count. The
   *  PR's check rollup can never carry this — nothing in it names reviews. */
  requiredApprovingReviewCount: number | null;
}

/** A "Code security and analysis" toggle. */
export type SecurityFeature =
  | "advanced_security"
  | "secret_scanning"
  | "secret_scanning_push_protection"
  | "secret_scanning_ai_detection"
  | "secret_scanning_non_provider_patterns"
  | "code_scanning"
  | "dependabot_alerts"
  | "dependabot_security_updates"
  | "private_vulnerability_reporting";

/** State of the repo's security toggles. The three `security_and_analysis`
 *  fields are null when not applicable (e.g. a public repo has no GHAS toggle). */
export interface SecurityStatus {
  isPrivate: boolean;
  advancedSecurity: boolean | null;
  secretScanning: boolean | null;
  secretScanningPushProtection: boolean | null;
  secretScanningAiDetection: boolean | null;
  secretScanningNonProviderPatterns: boolean | null;
  dependabotAlerts: boolean;
  dependabotSecurityUpdates: boolean;
  privateVulnerabilityReporting: boolean;
  codeScanning: boolean;
}

/** A GitHub (classic) branch protection rule, for importing into branch rules. */
export interface GhBranchProtection {
  /** fnmatch-style branch name pattern the rule targets. */
  pattern: string;
  allowsDeletions: boolean;
  allowsForcePushes: boolean;
  requiresLinearHistory: boolean;
  requiresApprovingReviews: boolean;
}
