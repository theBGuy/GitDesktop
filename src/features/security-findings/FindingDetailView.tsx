import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ReactNode } from "react";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { forgeReady, forgeSupports, useForgeStatus } from "@/lib/git/queries";
import type {
  DependabotAlertOut,
  RepoAdvisoryOut,
} from "@/lib/github/security-findings";
import {
  useDependabotAlerts,
  useRepoAdvisories,
} from "@/lib/github/security-findings";
import { useUiStore } from "@/lib/stores/ui";
import { SeverityChip } from "./severity";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 wrap-break-word">{children}</dd>
    </>
  );
}

function DetailShell({
  title,
  severity,
  htmlUrl,
  meta,
  children,
}: {
  title: string;
  severity: string | null;
  htmlUrl: string;
  meta: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b p-4">
        <h2 className="text-sm font-semibold text-balance">{title}</h2>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <SeverityChip severity={severity} />
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => openUrl(htmlUrl)}
          >
            <ArrowSquareOutIcon data-icon="inline-start" />
            View on GitHub
          </Button>
        </div>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
          {meta}
        </dl>
      </div>
      {/* overflow-hidden: the vendored ScrollArea Root is `relative`-only, so a
          fill-layout body would grow the pane past the viewport without it. */}
      <ScrollArea className="min-h-0 flex-1 overflow-hidden">
        <div className="p-4">{children}</div>
      </ScrollArea>
    </div>
  );
}

function AlertDetail({ alert }: { alert: DependabotAlertOut }) {
  return (
    <DetailShell
      title={alert.summary}
      severity={alert.severity}
      htmlUrl={alert.htmlUrl}
      meta={
        <>
          <Row label="Package">
            <span className="font-mono">{alert.packageName}</span>{" "}
            <span className="text-muted-foreground">
              {alert.ecosystem}
              {alert.scope ? ` · ${alert.scope}` : ""}
            </span>
          </Row>
          <Row label="Manifest">
            <span className="font-mono">{alert.manifestPath}</span>
          </Row>
          <Row label="GHSA">
            <span className="font-mono">{alert.ghsaId}</span>
          </Row>
          {alert.cveId ? (
            <Row label="CVE">
              <span className="font-mono">{alert.cveId}</span>
            </Row>
          ) : null}
          {alert.cvssScore !== null ? (
            <Row label="CVSS">
              <span className="tabular-nums">{alert.cvssScore}</span>
            </Row>
          ) : null}
          <Row label="Affected">
            {alert.vulnerableVersionRange ?? "Not stated"}
          </Row>
          <Row label="Patched">
            {alert.firstPatchedVersion ?? "No patched version yet"}
          </Row>
          <Row label="Opened">
            <RelativeTime date={alert.createdAt} />
          </Row>
        </>
      }
    >
      <Markdown>{alert.description}</Markdown>
    </DetailShell>
  );
}

function AdvisoryDetail({ advisory }: { advisory: RepoAdvisoryOut }) {
  return (
    <DetailShell
      title={advisory.summary}
      severity={advisory.severity}
      htmlUrl={advisory.htmlUrl}
      meta={
        <>
          <Row label="GHSA">
            <span className="font-mono">{advisory.ghsaId}</span>
          </Row>
          {advisory.cveId ? (
            <Row label="CVE">
              <span className="font-mono">{advisory.cveId}</span>
            </Row>
          ) : null}
          <Row label="State">{advisory.state}</Row>
          {advisory.cvssScore !== null ? (
            <Row label="CVSS">
              <span className="tabular-nums">{advisory.cvssScore}</span>
            </Row>
          ) : null}
          {/* Dates that don't exist are omitted outright — a withdrawn-at of
              "never" would read as a claim the advisory stands. */}
          {advisory.publishedAt ? (
            <Row label="Published">
              <RelativeTime date={advisory.publishedAt} />
            </Row>
          ) : null}
          {advisory.updatedAt ? (
            <Row label="Updated">
              <RelativeTime date={advisory.updatedAt} />
            </Row>
          ) : null}
          {advisory.withdrawnAt ? (
            <Row label="Withdrawn">
              <RelativeTime date={advisory.withdrawnAt} />
            </Row>
          ) : null}
        </>
      }
    >
      {advisory.vulnerabilities.length > 0 && (
        <section className="mb-4">
          <h3 className="mb-1.5 text-xs font-semibold">Affected packages</h3>
          <ul className="space-y-1 text-xs">
            {advisory.vulnerabilities.map((v) => (
              <li key={`${v.ecosystem}/${v.packageName}`}>
                <span className="font-mono">{v.packageName}</span>{" "}
                <span className="text-muted-foreground">{v.ecosystem}</span>
                <span className="block text-[11px] text-muted-foreground">
                  {v.vulnerableVersionRange ?? "Range not stated"} →{" "}
                  {v.patchedVersions ?? "No patched version listed"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {advisory.description ? (
        <Markdown>{advisory.description}</Markdown>
      ) : null}
    </DetailShell>
  );
}

export function FindingDetailView({
  repoPath,
  active,
}: {
  repoPath: string;
  active: boolean;
}) {
  const selectedFinding = useUiStore((s) => s.selectedFinding);
  const limits = useUiStore((s) => s.findingsLimits);
  const forge = useForgeStatus(repoPath);
  const enabled =
    forgeReady(forge.data) && forgeSupports(forge.data, "securityFindings");
  // Same hooks + same store limits as the panel, so these are cache hits rather
  // than a second fetch.
  const alerts = useDependabotAlerts(repoPath, enabled, active, limits.alerts);
  const advisories = useRepoAdvisories(
    repoPath,
    enabled,
    active,
    limits.advisories,
  );

  const query = selectedFinding?.type === "advisory" ? advisories : alerts;

  // Gated on `enabled`: a disabled query stays `isPending` forever, so an
  // ungated skeleton would spin here if the repo lost the capability mid-session.
  if (enabled && query.isPending) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground">
        Couldn't load this finding.
      </div>
    );
  }

  if (selectedFinding?.type === "alert") {
    const alert = alerts.data?.alerts.find(
      (a) => a.number === selectedFinding.number,
    );
    if (alert) return <AlertDetail alert={alert} />;
  } else if (selectedFinding?.type === "advisory") {
    const advisory = advisories.data?.advisories.find(
      (a) => a.ghsaId === selectedFinding.ghsaId,
    );
    if (advisory) return <AdvisoryDetail advisory={advisory} />;
  }

  return (
    <div className="p-6 text-center text-sm text-muted-foreground">
      This finding is no longer in the list.
    </div>
  );
}
