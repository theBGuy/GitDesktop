// The forge pages the Actions tab links out to: management surfaces the rail
// deliberately leaves to the forge rather than adding data or features for them.
// One table feeds the Manage menu and its palette actions.
// Runtime-import-free, so the install-less guards job can import it.
import type { ForgeProvider } from "@/lib/git/types";

export type ActionsLinkId =
  | "open-actions-github-caches"
  | "open-actions-github-deployments"
  | "open-actions-github-attestations"
  | "open-actions-github-runners"
  | "open-actions-github-usage"
  | "open-actions-github-performance"
  | "open-actions-gitlab-pipelines"
  | "open-actions-gitlab-environments"
  | "open-actions-gitlab-ci-settings"
  | "open-actions-gitlab-ci-analytics"
  | "open-actions-bitbucket-pipelines"
  | "open-actions-bitbucket-deployments";

export interface ActionsLink {
  id: ActionsLinkId;
  provider: ForgeProvider;
  label: string;
  /** Appended to the repo's web URL. */
  suffix: string;
  /** Who can open the page, shown muted beside the label. */
  muted?: string;
}

/** Render order per provider. The labels and suffixes Insights' LinkOutsCard
 *  also links keep its spelling, so the two can later share this table. */
export const ACTIONS_LINKS: readonly ActionsLink[] = [
  {
    id: "open-actions-github-caches",
    provider: "github",
    label: "Caches",
    suffix: "/actions/caches",
  },
  {
    id: "open-actions-github-deployments",
    provider: "github",
    label: "Deployments",
    suffix: "/deployments",
  },
  {
    id: "open-actions-github-attestations",
    provider: "github",
    label: "Attestations",
    suffix: "/attestations",
  },
  {
    id: "open-actions-github-runners",
    provider: "github",
    label: "Runners",
    suffix: "/settings/actions/runners",
    muted: "Admins",
  },
  {
    id: "open-actions-github-usage",
    provider: "github",
    label: "Actions usage",
    suffix: "/actions/metrics/usage",
  },
  {
    id: "open-actions-github-performance",
    provider: "github",
    label: "Actions performance",
    suffix: "/actions/metrics/performance",
  },
  {
    id: "open-actions-gitlab-pipelines",
    provider: "gitlab",
    label: "Pipelines & caches",
    suffix: "/-/pipelines",
  },
  {
    id: "open-actions-gitlab-environments",
    provider: "gitlab",
    label: "Environments",
    suffix: "/-/environments",
  },
  {
    id: "open-actions-gitlab-ci-settings",
    provider: "gitlab",
    label: "CI/CD settings (runners)",
    suffix: "/-/settings/ci_cd",
    muted: "Maintainers",
  },
  {
    id: "open-actions-gitlab-ci-analytics",
    provider: "gitlab",
    label: "CI/CD analytics",
    suffix: "/-/pipelines/charts",
  },
  {
    id: "open-actions-bitbucket-pipelines",
    provider: "bitbucket",
    label: "Pipelines & caches",
    suffix: "/pipelines",
  },
  {
    id: "open-actions-bitbucket-deployments",
    provider: "bitbucket",
    label: "Deployments",
    suffix: "/deployments",
  },
];

export function linksFor(
  provider: ForgeProvider | null | undefined,
): readonly ActionsLink[] {
  if (!provider) return [];
  return ACTIONS_LINKS.filter((l) => l.provider === provider);
}

export function manageGroupLabel(providerLabel: string): string {
  return `Open on ${providerLabel}`;
}
