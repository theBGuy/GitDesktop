import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { forgeRepoUrl } from "@/lib/git/api";
import { useActiveGhHost } from "@/lib/git/host";
import { toastError } from "@/lib/toast";

// Insights surfaces GitHub only renders on the web (no usable API) — link out
// rather than show an empty panel. See [[api-hardstop-github-link]].
const LINKS: { label: string; suffix: string; publicOnly?: boolean }[] = [
  { label: "Pulse", suffix: "/pulse" },
  { label: "Network graph", suffix: "/network" },
  // "Dependents" only exists for public repos that others depend on; it 404s otherwise.
  { label: "Dependents", suffix: "/network/dependents", publicOnly: true },
  { label: "Actions usage", suffix: "/actions/metrics/usage" },
  { label: "Actions performance", suffix: "/actions/metrics/performance" },
];

// GitLab's analytics equivalents also only render on the web. Branch-scoped
// pages (contributor graphs) are omitted — their URLs need a ref and don't
// redirect reliably.
const GITLAB_LINKS: { label: string; suffix: string }[] = [
  { label: "Activity", suffix: "/activity" },
  { label: "CI/CD analytics", suffix: "/-/pipelines/charts" },
  {
    label: "Value stream analytics",
    suffix: "/-/analytics/value_stream_analytics",
  },
];

// Bitbucket's equivalents also only render on the web. It has no analytics
// dashboards, but these views (commits, branches, pipelines) have no usable API
// here — link out rather than show an empty panel.
const BITBUCKET_LINKS: { label: string; suffix: string }[] = [
  { label: "Commits", suffix: "/commits/" },
  { label: "Branches", suffix: "/branches/" },
  { label: "Pipelines", suffix: "/pipelines" },
  { label: "Deployments", suffix: "/deployments" },
];

export function GitLabLinkOutsCard({ repoPath }: { repoPath: string }) {
  async function open(suffix: string) {
    try {
      const url = await forgeRepoUrl(repoPath);
      await openUrl(`${url}${suffix}`);
    } catch (e) {
      toastError(e);
    }
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        These insights only render on the web:
      </p>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {GITLAB_LINKS.map((l) => (
          <Button
            key={l.label}
            variant="outline"
            size="sm"
            className="cursor-pointer justify-start"
            onClick={() => open(l.suffix)}
          >
            <ArrowSquareOutIcon data-icon="inline-start" />
            {l.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

export function BitbucketLinkOutsCard({ repoPath }: { repoPath: string }) {
  async function open(suffix: string) {
    try {
      const url = await forgeRepoUrl(repoPath);
      await openUrl(`${url}${suffix}`);
    } catch (e) {
      toastError(e);
    }
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        These views only render on the web:
      </p>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {BITBUCKET_LINKS.map((l) => (
          <Button
            key={l.label}
            variant="outline"
            size="sm"
            className="cursor-pointer justify-start"
            onClick={() => open(l.suffix)}
          >
            <ArrowSquareOutIcon data-icon="inline-start" />
            {l.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

export function LinkOutsCard({
  repoPath,
  isPublic,
}: {
  repoPath: string;
  isPublic?: boolean;
}) {
  async function open(suffix: string) {
    try {
      const url = await forgeRepoUrl(repoPath);
      await openUrl(`${url}${suffix}`);
    } catch (e) {
      toastError(e);
    }
  }
  // Stars-over-time has no native GitHub page; star-history.com is the de-facto
  // tool, but it only covers github.com — hidden on Enterprise hosts.
  const host = useActiveGhHost();
  const canStarHistory = host === "github.com";
  async function openStars() {
    try {
      const url = await forgeRepoUrl(repoPath);
      const slug = url
        .replace(/^https?:\/\/github\.com\//, "")
        .replace(/\/$/, "");
      await openUrl(`https://star-history.com/#${slug}&Date`);
    } catch (e) {
      toastError(e);
    }
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        These insights only render on the web:
      </p>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {LINKS.filter((l) => !l.publicOnly || isPublic).map((l) => (
          <Button
            key={l.label}
            variant="outline"
            size="sm"
            className="cursor-pointer justify-start"
            onClick={() => open(l.suffix)}
          >
            <ArrowSquareOutIcon data-icon="inline-start" />
            {l.label}
          </Button>
        ))}
        {canStarHistory && (
          <Button
            variant="outline"
            size="sm"
            className="cursor-pointer justify-start"
            onClick={openStars}
          >
            <ArrowSquareOutIcon data-icon="inline-start" />
            Stars over time
          </Button>
        )}
      </div>
    </div>
  );
}
