import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ReactNode } from "react";
import { Markdown } from "@/components/markdown/markdown";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { forgeReady, forgeSupports, useForgeStatus } from "@/lib/git/queries";
import type {
  CodeScanningAlertOut,
  CvssOut,
  DependabotAlertOut,
  ReferenceOut,
  RepoAdvisoryOut,
  SecretScanningAlertOut,
} from "@/lib/github/security-findings";
import {
  useCodeScanningAlerts,
  useDependabotAlerts,
  useRepoAdvisories,
  useSecretScanningAlerts,
} from "@/lib/github/security-findings";
import type {
  GlCodeQualityFindingOut,
  GlFindingsOut,
  GlSecureFindingOut,
} from "@/lib/gitlab/security-findings";
import {
  codeQualityFindingId,
  secureFindingId,
  useGitLabFindings,
} from "@/lib/gitlab/security-findings";
import { type SelectedFinding, useUiStore } from "@/lib/stores/ui";
import { parseableDate } from "@/lib/time";
import {
  CodeScanningChip,
  CqChip,
  SeverityChip,
  ValidityChip,
  validityLabel,
} from "./severity";

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
  chip,
  htmlUrl,
  linkLabel = "View on GitHub",
  meta,
  children,
}: {
  title: string;
  /** The category's own status chip — severity, SARIF level, or validity; each
   *  category names its state in its own ladder's words. */
  chip: ReactNode;
  htmlUrl: string;
  /** What the link-out opens, when it isn't the finding's page on GitHub. */
  linkLabel?: string;
  meta: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b p-4">
        <h2 className="text-sm font-semibold text-balance">{title}</h2>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {chip}
          {/* A tolerated malformed item can lack html_url — no link, no button. */}
          {htmlUrl ? (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() => openUrl(htmlUrl)}
            >
              <ArrowSquareOutIcon data-icon="inline-start" />
              {linkLabel}
            </Button>
          ) : null}
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

/** GitHub reports `direct` / `transitive`; anything else is shown as it arrived,
 *  so a value we don't know yet is never dropped or mislabeled. */
function relationshipLabel(relationship: string): string {
  switch (relationship.toLowerCase()) {
    case "direct":
      return "Direct";
    case "transitive":
      return "Transitive";
    default:
      return relationship;
  }
}

/** One CVSS version's score and decoded metrics. An advisory can carry v3 and v4
 *  at once, so each gets its own section rather than one collapsed "CVSS" row. */
function CvssSection({ cvss }: { cvss: CvssOut }) {
  return (
    <section className="mb-4">
      <h3 className="mb-1.5 flex items-baseline gap-2 text-xs font-semibold">
        {/* The version is empty when the vector named none — heading it
            "CVSS" alone beats a dangling revision number. */}
        <span>{cvss.version ? `CVSS ${cvss.version}` : "CVSS"}</span>
        {cvss.score !== null ? (
          <span className="font-normal text-muted-foreground tabular-nums">
            {cvss.score}
          </span>
        ) : null}
      </h3>
      {cvss.metrics.length > 0 ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          {cvss.metrics.map((m) => (
            <Row key={m.label} label={m.label}>
              {m.value}
            </Row>
          ))}
        </dl>
      ) : (
        // An unparseable vector still says something — show it raw rather than
        // silently rendering an empty section.
        <p className="font-mono text-[11px] wrap-break-word text-muted-foreground">
          {cvss.vectorString}
        </p>
      )}
    </section>
  );
}

function ReferencesSection({ references }: { references: ReferenceOut[] }) {
  return (
    <section className="mt-4">
      <h3 className="mb-1.5 text-xs font-semibold">References</h3>
      <ul>
        {references.map((r, i) => (
          <li key={`${r.url}-${i}`}>
            <button
              type="button"
              onClick={() => openUrl(r.url)}
              className="flex w-full cursor-pointer items-center gap-2 rounded px-1 py-1 text-left text-xs hover:bg-muted/40"
            >
              <span className="shrink-0">{r.label}</span>
              <span
                className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
                title={r.url}
              >
                {r.url}
              </span>
              <ArrowSquareOutIcon className="size-3 shrink-0 text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AlertDetail({ alert }: { alert: DependabotAlertOut }) {
  return (
    <DetailShell
      // Falls back to the identity field, never invented prose: a doubly-degraded
      // item with no GHSA id either keeps a blank heading rather than a lie.
      title={alert.summary || alert.ghsaId}
      chip={<SeverityChip severity={alert.severity} />}
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
          {/* Next to the package: whether this is your dependency or something
              underneath it decides who can act on it. Omitted when unstated. */}
          {alert.relationship ? (
            <Row label="Dependency">
              {relationshipLabel(alert.relationship)}
            </Row>
          ) : null}
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
          {/* Only when there's no CVSS section to carry the score — otherwise
              this row and the first section state the same number twice. */}
          {alert.cvssScore !== null && alert.cvss.length === 0 ? (
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
          {alert.cwes.length > 0 ? (
            <Row label="CWE">
              <span className="flex flex-wrap gap-1">
                {alert.cwes.map((c) => (
                  <Badge
                    key={c.cweId}
                    variant="outline"
                    className="h-auto max-w-full py-0.5 text-left font-normal whitespace-normal"
                  >
                    <span className="font-mono">{c.cweId}</span> {c.name}
                  </Badge>
                ))}
              </span>
            </Row>
          ) : null}
          {parseableDate(alert.createdAt) ? (
            <Row label="Opened">
              <RelativeTime date={alert.createdAt} />
            </Row>
          ) : null}
        </>
      }
    >
      {/* Index-keyed: the version can come through empty, so it isn't unique. */}
      {alert.cvss.map((c, i) => (
        <CvssSection key={`${c.version}-${i}`} cvss={c} />
      ))}
      <Markdown>{alert.description}</Markdown>
      {alert.references.length > 0 ? (
        <ReferencesSection references={alert.references} />
      ) : null}
    </DetailShell>
  );
}

/** Sentence-case a raw wire value, leaving the rest of it as it arrived so an
 *  unrecognized level still reads instead of collapsing to "Unspecified". */
function capitalizeFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** `path:line`, or a placeholder when the path came through empty — a line
 *  number hung off nothing reads as a location. Must stay in step with
 *  `PathLabel` in FindingsPanel, which renders the same value in the list. */
function locationText(path: string, line: number | null): string {
  return path ? (line === null ? path : `${path}:${line}`) : "No file path";
}

function CodeScanningDetail({ alert }: { alert: CodeScanningAlertOut }) {
  return (
    <DetailShell
      title={alert.ruleName || alert.ruleId || "Unidentified rule"}
      chip={
        <CodeScanningChip
          securitySeverity={alert.securitySeverity}
          severity={alert.severity}
        />
      }
      htmlUrl={alert.htmlUrl}
      meta={
        <>
          {/* Omitted outright when the id is empty — the title already carries
              the fallback, matching how a missing date drops its row. */}
          {alert.ruleId ? (
            <Row label="Rule">
              <span className="font-mono">{alert.ruleId}</span>
            </Row>
          ) : null}
          {/* The SARIF level, spelled out — the chip shows it only when the rule
              carries no security severity to outrank it. */}
          {alert.severity ? (
            <Row label="Level">{capitalizeFirst(alert.severity)}</Row>
          ) : null}
          <Row label="Tool">
            {alert.toolName}
            {alert.toolVersion ? (
              <span className="text-muted-foreground">
                {" "}
                {alert.toolVersion}
              </span>
            ) : null}
          </Row>
          <Row label="Location">
            <span className="font-mono">
              {locationText(alert.path, alert.startLine)}
            </span>
          </Row>
          {alert.ref ? (
            <Row label="Ref">
              <span className="font-mono">{alert.ref}</span>
            </Row>
          ) : null}
          {/* No State row: the fetch pins state=open, so it could only ever
              read "open". */}
          {parseableDate(alert.createdAt) ? (
            <Row label="Opened">
              <RelativeTime date={alert.createdAt} />
            </Row>
          ) : null}
        </>
      }
    >
      <p className="text-xs wrap-break-word">{alert.message}</p>
      {alert.ruleDescription ? (
        <p className="mt-3 text-xs wrap-break-word text-muted-foreground">
          {alert.ruleDescription}
        </p>
      ) : null}
    </DetailShell>
  );
}

function SecretScanningDetail({ alert }: { alert: SecretScanningAlertOut }) {
  return (
    <DetailShell
      title={
        alert.secretTypeDisplayName || alert.secretType || "Unknown secret type"
      }
      chip={<ValidityChip validity={alert.validity} />}
      htmlUrl={alert.htmlUrl}
      meta={
        <>
          <Row label="Type">
            {alert.secretTypeDisplayName || alert.secretType || "Unknown"}
          </Row>
          <Row label="Validity">{validityLabel(alert.validity)}</Row>
          {/* No State row: the fetch pins state=open, so it could only ever
              read "open". */}
          {/* Only for a confirmed public leak — a null means GitHub didn't say,
              and "No" would read as a clearance it never gave. */}
          {alert.publiclyLeaked === true ? (
            <Row label="Publicly leaked">Yes</Row>
          ) : null}
          {parseableDate(alert.createdAt) ? (
            <Row label="Opened">
              <RelativeTime date={alert.createdAt} />
            </Row>
          ) : null}
        </>
      }
    >
      {/* The locations of a secret are a separate paginated endpoint we don't
          fetch, so this says so instead of implying the alert has no detail. */}
      <p className="text-xs text-muted-foreground">
        Open this alert on GitHub to see where the secret appears and manage it.
      </p>
    </DetailShell>
  );
}

function AdvisoryDetail({ advisory }: { advisory: RepoAdvisoryOut }) {
  return (
    <DetailShell
      title={advisory.summary || advisory.ghsaId}
      chip={<SeverityChip severity={advisory.severity} />}
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
          {advisory.publishedAt && parseableDate(advisory.publishedAt) ? (
            <Row label="Published">
              <RelativeTime date={advisory.publishedAt} />
            </Row>
          ) : null}
          {advisory.updatedAt && parseableDate(advisory.updatedAt) ? (
            <Row label="Updated">
              <RelativeTime date={advisory.updatedAt} />
            </Row>
          ) : null}
          {advisory.withdrawnAt && parseableDate(advisory.withdrawnAt) ? (
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

/** The URL only when it's one the system browser should open. Identifier links
 *  come from third-party report files, where a `file://` or `javascript:` value
 *  has no meaning here. */
function httpUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? url
      : null;
  } catch {
    return null;
  }
}

/** A permalink to the finding's line at the pipeline's commit, or `""` when any
 *  piece is missing. GitLab's own vulnerability pages are an Ultimate feature and
 *  404 for exactly the Free-tier projects this reads reports for, so the blob
 *  view is the only link that resolves. */
function glBlobUrl(
  data: GlFindingsOut,
  path: string,
  line: number | null,
): string {
  if (!data.projectWebUrl || !data.pipeline || !path) return "";
  // Each segment encoded, `/` separators kept, so an odd path can't rewrite the
  // URL it lands in.
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const anchor = line === null ? "" : `#L${line}`;
  return `${data.projectWebUrl}/-/blob/${data.pipeline.sha}/${encoded}${anchor}`;
}

/** The pipeline these findings were read from, one click from the detail. */
function GlPipelineRow({ data }: { data: GlFindingsOut }) {
  const pipeline = data.pipeline;
  if (!pipeline?.webUrl) return null;
  return (
    <Row label="Pipeline">
      <button
        type="button"
        onClick={() => openUrl(pipeline.webUrl)}
        className="inline-flex cursor-pointer items-center gap-1 hover:underline"
      >
        #{pipeline.iid}
        <ArrowSquareOutIcon className="size-3" />
      </button>
    </Row>
  );
}

function GlSecureDetail({
  finding,
  data,
  fallbackTitle,
}: {
  finding: GlSecureFindingOut;
  data: GlFindingsOut;
  /** The category's own name for a finding whose report gave none. */
  fallbackTitle: string;
}) {
  return (
    <DetailShell
      title={finding.name || fallbackTitle}
      chip={<SeverityChip severity={finding.severity} />}
      htmlUrl={glBlobUrl(data, finding.file, finding.startLine)}
      linkLabel="View file on GitLab"
      meta={
        <>
          <Row label="File">
            <span className="font-mono">
              {locationText(finding.file, finding.startLine)}
            </span>
          </Row>
          {finding.scannerName ? (
            <Row label="Scanner">{finding.scannerName}</Row>
          ) : null}
          {finding.identifiers.length > 0 ? (
            <Row label="Identifiers">
              <span className="flex flex-wrap gap-1">
                {finding.identifiers.map((identifier, i) => {
                  const label =
                    identifier.name || identifier.value || identifier.type;
                  const url = httpUrl(identifier.url);
                  const key = `${identifier.type}-${identifier.value}-${i}`;
                  return url ? (
                    <button
                      key={key}
                      type="button"
                      onClick={() => openUrl(url)}
                      className="inline-flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 hover:bg-muted/40"
                    >
                      {label}
                      <ArrowSquareOutIcon className="size-3 text-muted-foreground" />
                    </button>
                  ) : (
                    <Badge key={key} variant="outline" className="font-normal">
                      {label}
                    </Badge>
                  );
                })}
              </span>
            </Row>
          ) : null}
          <GlPipelineRow data={data} />
        </>
      }
    >
      {/* Scanner descriptions carry fenced code and links, so they render as
          markdown rather than as preformatted text. */}
      {finding.description ? <Markdown>{finding.description}</Markdown> : null}
    </DetailShell>
  );
}

function GlQualityDetail({
  finding,
  data,
}: {
  finding: GlCodeQualityFindingOut;
  data: GlFindingsOut;
}) {
  return (
    <DetailShell
      title={finding.checkName || "Unidentified check"}
      chip={<CqChip severity={finding.severity} />}
      htmlUrl={glBlobUrl(data, finding.path, finding.line)}
      linkLabel="View file on GitLab"
      meta={
        <>
          {/* No Severity row — the chip above already names it in the
              CodeClimate ladder's own words. */}
          <Row label="Path">
            <span className="font-mono">
              {locationText(finding.path, finding.line)}
            </span>
          </Row>
          <GlPipelineRow data={data} />
        </>
      }
    >
      {finding.description ? <Markdown>{finding.description}</Markdown> : null}
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
  // Same hooks, same provider gate and same store limits as the panel, so these
  // are cache hits rather than a second fetch — and the other provider's
  // commands are never invoked.
  const provider = forge.data?.provider;
  const onGitHub = enabled && provider === "github";
  const alerts = useDependabotAlerts(repoPath, onGitHub, active, limits.alerts);
  const codeScanning = useCodeScanningAlerts(
    repoPath,
    onGitHub,
    active,
    limits.codeScanning,
  );
  const secrets = useSecretScanningAlerts(
    repoPath,
    onGitHub,
    active,
    limits.secretScanning,
  );
  const advisories = useRepoAdvisories(
    repoPath,
    onGitHub,
    active,
    limits.advisories,
  );
  const gl = useGitLabFindings(
    repoPath,
    enabled && provider === "gitlab",
    active,
    limits.gitlab,
  );

  // Only the selected finding's own category decides the pending/error state —
  // a sibling category failing must not blank a finding that loaded fine. Typed
  // to what's read here, since the five categories carry different data shapes.
  const queryByType: Record<
    SelectedFinding["type"],
    { isPending: boolean; isError: boolean }
  > = {
    alert: alerts,
    codeScanning,
    secretScanning: secrets,
    advisory: advisories,
    glFinding: gl,
  };
  const query = selectedFinding ? queryByType[selectedFinding.type] : alerts;

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
  } else if (selectedFinding?.type === "codeScanning") {
    const alert = codeScanning.data?.alerts.find(
      (a) => a.number === selectedFinding.number,
    );
    if (alert) return <CodeScanningDetail alert={alert} />;
  } else if (selectedFinding?.type === "secretScanning") {
    const alert = secrets.data?.alerts.find(
      (a) => a.number === selectedFinding.number,
    );
    if (alert) return <SecretScanningDetail alert={alert} />;
  } else if (selectedFinding?.type === "advisory") {
    const advisory = advisories.data?.advisories.find(
      (a) => a.ghsaId === selectedFinding.ghsaId,
    );
    if (advisory) return <AdvisoryDetail advisory={advisory} />;
  } else if (selectedFinding?.type === "glFinding" && gl.data) {
    const data = gl.data;
    if (selectedFinding.category === "codeQuality") {
      const finding = data.codeQuality.findings.find(
        (f) => codeQualityFindingId(f) === selectedFinding.id,
      );
      if (finding) return <GlQualityDetail finding={finding} data={data} />;
    } else {
      const category =
        selectedFinding.category === "sast" ? data.sast : data.secretDetection;
      const finding = category.findings.find(
        (f) => secureFindingId(f) === selectedFinding.id,
      );
      if (finding)
        return (
          <GlSecureDetail
            finding={finding}
            data={data}
            fallbackTitle={
              selectedFinding.category === "sast"
                ? "Unidentified rule"
                : "Unknown secret type"
            }
          />
        );
    }
  }

  return (
    <div className="p-6 text-center text-sm text-muted-foreground">
      This finding is no longer in the list.
    </div>
  );
}
