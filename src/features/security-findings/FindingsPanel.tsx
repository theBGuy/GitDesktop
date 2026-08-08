import {
  ArrowClockwiseIcon,
  GearSixIcon,
  LockKeyIcon,
  QuestionIcon,
  ShieldCheckIcon,
  ShieldSlashIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useRef, useState } from "react";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadMoreRow, PAGE_SIZE } from "@/features/conversations/LoadMoreRow";
import { ForgeNotReady } from "@/features/repository/ForgeNotReady";
import {
  forgeFeatureReady,
  forgeReady,
  forgeSupports,
  useForgeStatus,
  useRepoAdmin,
} from "@/lib/git/queries";
import type {
  CodeScanningAlertOut,
  DependabotAlertOut,
  FindingAvailability,
  RepoAdvisoryOut,
  SecretScanningAlertOut,
} from "@/lib/github/security-findings";
import {
  useCodeScanningAlerts,
  useDependabotAlerts,
  useRepoAdvisories,
  useSecretScanningAlerts,
} from "@/lib/github/security-findings";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { type SelectedFinding, useUiStore } from "@/lib/stores/ui";
import { cn } from "@/lib/utils";
import {
  CodeScanningChip,
  codeScanningRank,
  SEVERITY_RANK,
  SeverityChip,
  severityLevel,
  VALIDITY_RANK,
  ValidityChip,
  validityLevel,
} from "./severity";

/** Ceiling for a category's row limit. MUST stay in lockstep with `clamp_limit`
 *  in src-tauri/src/github/security_findings.rs, which is the source of truth:
 *  it clamps every fetch to 500, so growing the limit past this would re-run the
 *  paged walk for the same 500 rows and leave "Load more" permanently offered. */
const FINDINGS_LIMIT_CAP = 500;

interface AlertRow {
  /** Unique per rendered row: the alert number, or an index fallback for a
   *  tolerated alert whose number came through as 0 (duplicate React keys and
   *  duplicate `data-row` values would misdirect the arrow-key focus). */
  id: string;
  alert: DependabotAlertOut;
}

interface AlertGroup {
  key: string;
  packageName: string;
  ecosystem: string;
  rows: AlertRow[];
}

interface CodeScanningRow {
  id: string;
  alert: CodeScanningAlertOut;
}

interface CodeScanningGroup {
  key: string;
  /** The rule's human name where it has one, else the raw id — never blank. */
  label: string;
  rows: CodeScanningRow[];
}

interface SecretRow {
  id: string;
  alert: SecretScanningAlertOut;
}

interface SecretGroup {
  key: string;
  label: string;
  rows: SecretRow[];
}

/** Worst-first, for every finding category: both endpoints order by date, so the
 *  severity ladder is applied here instead. Callers use `toSorted` so the sort
 *  stays stable and server date order remains the tiebreak within a level; a null
 *  or unrecognized severity ranks with `unknown`, i.e. last. */
const bySeverity = (
  a: { severity: string | null },
  b: { severity: string | null },
) =>
  SEVERITY_RANK[severityLevel(a.severity)] -
  SEVERITY_RANK[severityLevel(b.severity)];

function buildAlertGroups(alerts: DependabotAlertOut[]): AlertGroup[] {
  // Grouping preserves the sorted order, so the groups AND the rows inside each
  // group both run worst-first.
  const sorted = alerts.toSorted(bySeverity);
  // Keyed by name AND ecosystem: the same package name exists in several
  // ecosystems, and merging them would mislabel the group's ecosystem.
  const groups = new Map<string, AlertGroup>();
  sorted.forEach((alert, i) => {
    const key = `${alert.ecosystem}/${alert.packageName}`;
    const row: AlertRow = {
      id: alert.number === 0 ? `alert-i${i}` : `alert-${alert.number}`,
      alert,
    };
    const bucket = groups.get(key);
    if (bucket) bucket.rows.push(row);
    else {
      groups.set(key, {
        key,
        packageName: alert.packageName,
        ecosystem: alert.ecosystem,
        rows: [row],
      });
    }
  });
  return [...groups.values()];
}

function buildCodeScanningGroups(
  alerts: CodeScanningAlertOut[],
): CodeScanningGroup[] {
  // Sort first, group after: the groups AND the rows inside each group both run
  // worst-first, and the server's date order stays the tiebreak within a rung.
  const sorted = alerts.toSorted(
    (a, b) => codeScanningRank(a) - codeScanningRank(b),
  );
  const groups = new Map<string, CodeScanningGroup>();
  sorted.forEach((alert, i) => {
    const row: CodeScanningRow = {
      id: alert.number === 0 ? `cs-i${i}` : `cs-${alert.number}`,
      alert,
    };
    const bucket = groups.get(alert.ruleId);
    if (bucket) bucket.rows.push(row);
    else {
      groups.set(alert.ruleId, {
        key: alert.ruleId,
        label: alert.ruleName ?? alert.ruleId,
        rows: [row],
      });
    }
  });
  return [...groups.values()];
}

/** Urgency order for leaked secrets: a credential that still works first, then
 *  newest. `createdAt` is ISO-8601, so a string compare is a date compare. */
const bySecretUrgency = (
  a: SecretScanningAlertOut,
  b: SecretScanningAlertOut,
) =>
  VALIDITY_RANK[validityLevel(a.validity)] -
    VALIDITY_RANK[validityLevel(b.validity)] ||
  b.createdAt.localeCompare(a.createdAt);

function buildSecretGroups(alerts: SecretScanningAlertOut[]): SecretGroup[] {
  const sorted = alerts.toSorted(bySecretUrgency);
  const groups = new Map<string, SecretGroup>();
  sorted.forEach((alert, i) => {
    const row: SecretRow = {
      id: alert.number === 0 ? `secret-i${i}` : `secret-${alert.number}`,
      alert,
    };
    const bucket = groups.get(alert.secretTypeDisplayName);
    if (bucket) bucket.rows.push(row);
    else {
      groups.set(alert.secretTypeDisplayName, {
        key: alert.secretTypeDisplayName,
        label: alert.secretTypeDisplayName,
        rows: [row],
      });
    }
  });
  return [...groups.values()];
}

/** Whether two selections point at the same finding. Degenerate identities (a
 *  tolerated alert numbered 0, an advisory with no GHSA id) can't be told apart
 *  by the stored selection, so the first matching row wins. */
function sameFinding(a: SelectedFinding, b: SelectedFinding): boolean {
  if (a.type === "advisory")
    return b.type === "advisory" && a.ghsaId === b.ghsaId;
  // The three numbered categories keep separate number sequences, so the type
  // tag has to match too — alert #4 is not code scanning alert #4.
  return b.type !== "advisory" && b.type === a.type && b.number === a.number;
}

const matchesAlert = (a: DependabotAlertOut, q: string) =>
  !q ||
  a.packageName.toLowerCase().includes(q) ||
  a.summary.toLowerCase().includes(q) ||
  a.ghsaId.toLowerCase().includes(q) ||
  (a.cveId?.toLowerCase().includes(q) ?? false);

const matchesCodeScanning = (a: CodeScanningAlertOut, q: string) =>
  !q ||
  a.ruleId.toLowerCase().includes(q) ||
  (a.ruleName?.toLowerCase().includes(q) ?? false) ||
  a.message.toLowerCase().includes(q) ||
  a.path.toLowerCase().includes(q) ||
  a.toolName.toLowerCase().includes(q);

const matchesSecret = (a: SecretScanningAlertOut, q: string) =>
  !q ||
  a.secretType.toLowerCase().includes(q) ||
  a.secretTypeDisplayName.toLowerCase().includes(q);

const matchesAdvisory = (adv: RepoAdvisoryOut, q: string) =>
  !q ||
  adv.summary.toLowerCase().includes(q) ||
  adv.ghsaId.toLowerCase().includes(q) ||
  (adv.cveId?.toLowerCase().includes(q) ?? false) ||
  adv.vulnerabilities.some((v) => v.packageName.toLowerCase().includes(q));

function SectionHeader({ title }: { title: string }) {
  return (
    <h3 className="border-b bg-muted/40 px-3 py-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
      {title}
    </h3>
  );
}

/** `path:line`, truncated from the *start* so the filename — the part that
 *  identifies the finding — survives. `dir="rtl"` moves the ellipsis to the
 *  leading edge; the `<bdi>` keeps the path itself reading left-to-right. */
function PathLabel({ path, line }: { path: string; line: number | null }) {
  const text = line === null ? path : `${path}:${line}`;
  return (
    <span dir="rtl" className="ml-auto min-w-0 truncate font-mono" title={text}>
      <bdi>{text}</bdi>
    </span>
  );
}

function RowSkeletons() {
  return (
    <div className="space-y-2 p-3">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}

/** A full-width, in-flow explanation of why a category has no usable data, with
 *  the one action that resolves it. Icon + text — never tone alone. */
function ReasonCard({
  icon: Icon,
  message,
  detail,
  action,
}: {
  icon: typeof ShieldSlashIcon;
  message: string;
  detail?: string | null;
  action?: ReactNode;
}) {
  return (
    <div className="flex gap-2 border-b px-3 py-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-xs text-muted-foreground">{message}</p>
        {detail ? (
          <p className="text-[11px] wrap-break-word text-muted-foreground/80">
            {detail}
          </p>
        ) : null}
        {action}
      </div>
    </div>
  );
}

/**
 * The card for any envelope that isn't `"available"`. `notEnabledMessage` is the
 * category's own benefit-phrased sentence for the not-enabled state; `onEnable`
 * is passed on top of it only where the app can open the toggle. A category
 * without either still reports the state the server named rather than falling
 * through to "couldn't check". `Category` is the sentence-initial form of
 * `category`.
 */
function UnavailableCard({
  availability,
  detail,
  category,
  Category,
  notEnabledMessage,
  onRetry,
  onEnable,
}: {
  availability: Exclude<FindingAvailability, "available">;
  detail: string | null;
  category: string;
  Category: string;
  notEnabledMessage?: string;
  onRetry: () => void;
  onEnable?: () => void;
}) {
  if (availability === "notEnabled") {
    // The benefit sentence is how a non-admin learns what to ask for, so it
    // shows with or without the action. It already names the cause, so the
    // server's detail would only restate it — detail is for the generic path.
    return (
      <ReasonCard
        icon={ShieldSlashIcon}
        message={
          notEnabledMessage ?? `${Category} aren't enabled for this repository.`
        }
        detail={notEnabledMessage ? null : detail}
        action={
          onEnable ? (
            <Button variant="outline" size="sm" onClick={onEnable}>
              <GearSixIcon data-icon="inline-start" />
              Open security settings
            </Button>
          ) : undefined
        }
      />
    );
  }
  if (availability === "forbidden") {
    return (
      <ReasonCard
        icon={LockKeyIcon}
        message={`Your GitHub sign-in can't read ${category} on this repository.`}
        detail={detail}
      />
    );
  }
  return (
    <ReasonCard
      icon={QuestionIcon}
      message={`Couldn't check ${category}.`}
      detail={detail}
      action={
        <Button variant="outline" size="sm" onClick={onRetry}>
          <ArrowClockwiseIcon data-icon="inline-start" />
          Retry
        </Button>
      }
    />
  );
}

function LoadFailed({
  category,
  onRetry,
}: {
  category: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-2 border-b px-3 py-3">
      <p className="text-xs text-muted-foreground">
        Couldn't load {category}. Retry to try again.
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <ArrowClockwiseIcon data-icon="inline-start" />
        Retry
      </Button>
    </div>
  );
}

export function FindingsPanel({
  repoPath,
  active,
}: {
  repoPath: string;
  active: boolean;
}) {
  const forge = useForgeStatus(repoPath);
  // All four categories — Dependabot alerts, code scanning, secret scanning and
  // repository advisories — are GitHub-only surfaces, so the gate is the
  // capability, not a per-provider dispatch: a GitLab/Bitbucket repo fires no
  // query at all.
  const ready = forgeReady(forge.data);
  const supported = forgeSupports(forge.data, "securityFindings");
  const enabled = ready && supported;
  // Mirrors RepositoryMenu's gate on the "Repository settings…" item: the deep
  // link opens that same admin-only dialog, so offering it to a non-admin would
  // land them on a permissions error. Same query key, so no extra fetch.
  const settingsReady = forgeFeatureReady(forge.data, "repoSettings");
  const admin = useRepoAdmin(repoPath, settingsReady);
  const canOpenRepoSettings = settingsReady && Boolean(admin.data?.admin);

  const limits = useUiStore((s) => s.findingsLimits);
  const setFindingsLimits = useUiStore((s) => s.setFindingsLimits);
  const selectedFinding = useUiStore((s) => s.selectedFinding);
  const selectFinding = useUiStore((s) => s.selectFinding);
  const requestRepoSettings = useUiStore((s) => s.requestRepoSettings);

  const alerts = useDependabotAlerts(repoPath, enabled, active, limits.alerts);
  const codeScanning = useCodeScanningAlerts(
    repoPath,
    enabled,
    active,
    limits.codeScanning,
  );
  const secrets = useSecretScanningAlerts(
    repoPath,
    enabled,
    active,
    limits.secretScanning,
  );
  const advisories = useRepoAdvisories(
    repoPath,
    enabled,
    active,
    limits.advisories,
  );

  const [filterText, setFilterText] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  useHotkeyAction("focus-filter", () => filterRef.current?.focus());

  const query = filterText.trim().toLowerCase();
  const alertsOut = alerts.data;
  const codeScanningOut = codeScanning.data;
  const secretsOut = secrets.data;
  const advisoriesOut = advisories.data;
  const allAlerts = alertsOut?.alerts ?? [];
  const allCodeScanning = codeScanningOut?.alerts ?? [];
  const allSecrets = secretsOut?.alerts ?? [];
  const allAdvisories = advisoriesOut?.advisories ?? [];
  const alertGroups = buildAlertGroups(
    allAlerts.filter((a) => matchesAlert(a, query)),
  );
  const codeScanningGroups = buildCodeScanningGroups(
    allCodeScanning.filter((a) => matchesCodeScanning(a, query)),
  );
  const secretGroups = buildSecretGroups(
    allSecrets.filter((a) => matchesSecret(a, query)),
  );
  const advisoryRows = allAdvisories
    .filter((a) => matchesAdvisory(a, query))
    .toSorted(bySeverity)
    .map((advisory, i) => ({
      // Index fallback for a tolerated advisory with no GHSA id (see AlertRow).
      id: advisory.ghsaId ? `advisory-${advisory.ghsaId}` : `advisory-i${i}`,
      advisory,
    }));

  const alertsShown =
    !alerts.isError && alertsOut?.availability === "available";
  const codeScanningShown =
    !codeScanning.isError && codeScanningOut?.availability === "available";
  const secretsShown =
    !secrets.isError && secretsOut?.availability === "available";
  const advisoriesShown =
    !advisories.isError && advisoriesOut?.availability === "available";

  // Flat, document-order nav list: the grouped rows of each section in the order
  // the sections render. Group headers and the Load-more buttons are skipped.
  const navRows: { id: string; finding: SelectedFinding }[] = [];
  if (alertsShown) {
    for (const group of alertGroups) {
      for (const row of group.rows) {
        navRows.push({
          id: row.id,
          finding: { type: "alert", number: row.alert.number },
        });
      }
    }
  }
  if (codeScanningShown) {
    for (const group of codeScanningGroups) {
      for (const row of group.rows) {
        navRows.push({
          id: row.id,
          finding: { type: "codeScanning", number: row.alert.number },
        });
      }
    }
  }
  if (secretsShown) {
    for (const group of secretGroups) {
      for (const row of group.rows) {
        navRows.push({
          id: row.id,
          finding: { type: "secretScanning", number: row.alert.number },
        });
      }
    }
  }
  if (advisoriesShown) {
    for (const row of advisoryRows) {
      navRows.push({
        id: row.id,
        finding: { type: "advisory", ghsaId: row.advisory.ghsaId },
      });
    }
  }

  // Resolved against the rendered rows (not rebuilt from the selection) so the
  // highlight uses the same identity the nav list and `data-row` do.
  const selectedRowId = selectedFinding
    ? (navRows.find((r) => sameFinding(r.finding, selectedFinding))?.id ?? null)
    : null;

  const onListKeyDown = listKeyboardNav({
    items: navRows,
    activeIndex: navRows.findIndex((r) => r.id === selectedRowId),
    onActivate: (row) => selectFinding(row.finding),
    rowKey: (row) => row.id,
  });

  const refreshing =
    alerts.isFetching ||
    codeScanning.isFetching ||
    secrets.isFetching ||
    advisories.isFetching;
  const refreshReason = enabled
    ? "Refresh findings"
    : !supported && ready
      ? "Security findings aren't available on this repository's host."
      : "Connect this repo to GitHub to load findings";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b p-2">
        <p className="text-xs text-muted-foreground">Security findings</p>
        <div className="ml-auto flex items-center gap-1">
          {/* A `title` on a disabled Button never surfaces — the wrapper span is
              what carries the explanation while the control is unusable. */}
          <span title={refreshReason}>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Refresh findings"
              disabled={!enabled || refreshing}
              onClick={() =>
                queryClient.invalidateQueries({
                  queryKey: ["repo", repoPath, "findings"],
                })
              }
            >
              <ArrowClockwiseIcon
                className={cn(refreshing && "animate-spin")}
              />
            </Button>
          </span>
        </div>
      </div>
      <div className="border-b p-2">
        <Input
          ref={filterRef}
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          placeholder="Filter by package, rule, secret type, summary, GHSA, or CVE"
          className="h-7"
          autoComplete="off"
        />
      </div>

      {/* overflow-hidden: the vendored ScrollArea Root is `relative`-only, so
          without containment a long list leaks a window scrollbar. */}
      <ScrollArea className="min-h-0 flex-1 overflow-hidden">
        {forge.isPending ? (
          <RowSkeletons />
        ) : !ready ? (
          <ForgeNotReady repoPath={repoPath} feature="security findings" />
        ) : !supported ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            Security findings aren't available on this repository's host.
          </p>
        ) : (
          <div onKeyDown={onListKeyDown}>
            <SectionHeader title="Dependency alerts" />
            {alerts.isError ? (
              <LoadFailed
                category="dependency alerts"
                onRetry={() => alerts.refetch()}
              />
            ) : !alertsOut ? (
              <RowSkeletons />
            ) : alertsOut.availability !== "available" ? (
              <UnavailableCard
                availability={alertsOut.availability}
                detail={alertsOut.detail}
                category="dependency alerts"
                Category="Dependency alerts"
                notEnabledMessage="Dependabot alerts are off for this repository. Turn them on to see vulnerable dependencies here."
                onRetry={() => alerts.refetch()}
                onEnable={
                  canOpenRepoSettings
                    ? () => requestRepoSettings("security")
                    : undefined
                }
              />
            ) : (
              <>
                {alertGroups.length === 0 ? (
                  allAlerts.length > 0 ? (
                    <p className="px-3 py-4 text-xs text-muted-foreground">
                      No alerts match the filter.
                    </p>
                  ) : (
                    <Empty className="py-8">
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <ShieldCheckIcon />
                        </EmptyMedia>
                        <EmptyTitle>No open Dependabot alerts</EmptyTitle>
                      </EmptyHeader>
                    </Empty>
                  )
                ) : (
                  alertGroups.map((group) => (
                    <div key={group.key}>
                      <div className="flex items-baseline gap-2 px-3 py-1 text-[11px] text-muted-foreground">
                        <span
                          className="truncate font-mono text-foreground"
                          title={group.packageName}
                        >
                          {group.packageName}
                        </span>
                        <span className="shrink-0">{group.ecosystem}</span>
                        <span className="ml-auto shrink-0 tabular-nums">
                          {group.rows.length}
                        </span>
                      </div>
                      {group.rows.map(({ id, alert: a }) => (
                        <button
                          type="button"
                          key={id}
                          data-row={id}
                          className={cn(
                            "block w-full border-b px-3 py-2 text-left",
                            selectedRowId === id
                              ? "bg-accent text-accent-foreground"
                              : "hover:bg-muted/60",
                          )}
                          onClick={() =>
                            selectFinding({ type: "alert", number: a.number })
                          }
                        >
                          <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
                            <SeverityChip severity={a.severity} />
                            <span className="ml-auto min-w-0 truncate">
                              {a.firstPatchedVersion
                                ? `fix: ${a.firstPatchedVersion}`
                                : "no patch yet"}
                            </span>
                            <span className="shrink-0">
                              <RelativeTime date={a.createdAt} />
                            </span>
                          </p>
                          {/* The summary owns its own full-width line — sharing
                              one with the chip left it cramped and truncating early. */}
                          <p
                            className="mt-1 truncate text-xs font-medium"
                            title={a.summary}
                          >
                            {a.summary}
                          </p>
                        </button>
                      ))}
                    </div>
                  ))
                )}
                {/* Outside the empty branch: filtering to zero matches must not
                    strip the only way to reach rows past the fetched window. */}
                {alertsOut.truncated &&
                  (limits.alerts >= FINDINGS_LIMIT_CAP ? (
                    <p className="border-t px-3 py-3 text-xs text-muted-foreground">
                      Showing the first {allAlerts.length.toLocaleString()}{" "}
                      dependency alerts.
                    </p>
                  ) : (
                    <LoadMoreRow
                      count={allAlerts.length}
                      loading={alerts.isFetching}
                      onLoadMore={() =>
                        setFindingsLimits({
                          ...limits,
                          alerts: Math.min(
                            limits.alerts + PAGE_SIZE,
                            FINDINGS_LIMIT_CAP,
                          ),
                        })
                      }
                    />
                  ))}
              </>
            )}

            <SectionHeader title="Code scanning" />
            {codeScanning.isError ? (
              <LoadFailed
                category="code scanning alerts"
                onRetry={() => codeScanning.refetch()}
              />
            ) : !codeScanningOut ? (
              <RowSkeletons />
            ) : codeScanningOut.availability !== "available" ? (
              <UnavailableCard
                availability={codeScanningOut.availability}
                detail={codeScanningOut.detail}
                category="code scanning alerts"
                Category="Code scanning alerts"
                notEnabledMessage="Code scanning isn't producing results for this repository yet. Turn it on to see alerts here."
                onRetry={() => codeScanning.refetch()}
                onEnable={
                  canOpenRepoSettings
                    ? () => requestRepoSettings("security")
                    : undefined
                }
              />
            ) : (
              <>
                {codeScanningGroups.length === 0 ? (
                  allCodeScanning.length > 0 ? (
                    <p className="px-3 py-4 text-xs text-muted-foreground">
                      No code scanning alerts match the filter.
                    </p>
                  ) : (
                    <Empty className="py-8">
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <ShieldCheckIcon />
                        </EmptyMedia>
                        <EmptyTitle>No open code scanning alerts</EmptyTitle>
                      </EmptyHeader>
                    </Empty>
                  )
                ) : (
                  codeScanningGroups.map((group) => (
                    <div key={group.key}>
                      <div className="flex items-baseline gap-2 px-3 py-1 text-[11px] text-muted-foreground">
                        <span
                          className={cn(
                            "truncate text-foreground",
                            // A rule with no name falls back to its id, which
                            // reads as an identifier, so it gets the mono face.
                            group.label === group.key && "font-mono",
                          )}
                          title={group.label}
                        >
                          {group.label}
                        </span>
                        {group.label === group.key ? null : (
                          <span
                            className="min-w-0 shrink truncate font-mono"
                            title={group.key}
                          >
                            {group.key}
                          </span>
                        )}
                        <span className="ml-auto shrink-0 tabular-nums">
                          {group.rows.length}
                        </span>
                      </div>
                      {group.rows.map(({ id, alert: a }) => (
                        <button
                          type="button"
                          key={id}
                          data-row={id}
                          className={cn(
                            "block w-full border-b px-3 py-2 text-left",
                            selectedRowId === id
                              ? "bg-accent text-accent-foreground"
                              : "hover:bg-muted/60",
                          )}
                          onClick={() =>
                            selectFinding({
                              type: "codeScanning",
                              number: a.number,
                            })
                          }
                        >
                          <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
                            <CodeScanningChip
                              securitySeverity={a.securitySeverity}
                              severity={a.severity}
                            />
                            <PathLabel path={a.path} line={a.startLine} />
                            <span className="shrink-0">
                              <RelativeTime date={a.createdAt} />
                            </span>
                          </p>
                          {/* Full-width message line, matching the alert rows. */}
                          <p
                            className="mt-1 truncate text-xs font-medium"
                            title={a.message}
                          >
                            {a.message}
                          </p>
                        </button>
                      ))}
                    </div>
                  ))
                )}
                {codeScanningOut.truncated &&
                  (limits.codeScanning >= FINDINGS_LIMIT_CAP ? (
                    <p className="border-t px-3 py-3 text-xs text-muted-foreground">
                      Showing the first{" "}
                      {allCodeScanning.length.toLocaleString()} code scanning
                      alerts.
                    </p>
                  ) : (
                    <LoadMoreRow
                      count={allCodeScanning.length}
                      loading={codeScanning.isFetching}
                      onLoadMore={() =>
                        setFindingsLimits({
                          ...limits,
                          codeScanning: Math.min(
                            limits.codeScanning + PAGE_SIZE,
                            FINDINGS_LIMIT_CAP,
                          ),
                        })
                      }
                    />
                  ))}
              </>
            )}

            <SectionHeader title="Secret scanning" />
            {secrets.isError ? (
              <LoadFailed
                category="secret scanning alerts"
                onRetry={() => secrets.refetch()}
              />
            ) : !secretsOut ? (
              <RowSkeletons />
            ) : secretsOut.availability !== "available" ? (
              <UnavailableCard
                availability={secretsOut.availability}
                detail={secretsOut.detail}
                category="secret scanning alerts"
                Category="Secret scanning alerts"
                notEnabledMessage="Secret scanning is off for this repository. Turn it on to catch leaked credentials."
                onRetry={() => secrets.refetch()}
                onEnable={
                  canOpenRepoSettings
                    ? () => requestRepoSettings("security")
                    : undefined
                }
              />
            ) : (
              <>
                {secretGroups.length === 0 ? (
                  allSecrets.length > 0 ? (
                    <p className="px-3 py-4 text-xs text-muted-foreground">
                      No secret scanning alerts match the filter.
                    </p>
                  ) : (
                    <Empty className="py-8">
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <ShieldCheckIcon />
                        </EmptyMedia>
                        <EmptyTitle>No open secret scanning alerts</EmptyTitle>
                      </EmptyHeader>
                    </Empty>
                  )
                ) : (
                  secretGroups.map((group) => (
                    <div key={group.key}>
                      <div className="flex items-baseline gap-2 px-3 py-1 text-[11px] text-muted-foreground">
                        <span
                          className="truncate text-foreground"
                          title={group.label}
                        >
                          {group.label}
                        </span>
                        <span className="ml-auto shrink-0 tabular-nums">
                          {group.rows.length}
                        </span>
                      </div>
                      {group.rows.map(({ id, alert: a }) => (
                        <button
                          type="button"
                          key={id}
                          data-row={id}
                          className={cn(
                            "block w-full border-b px-3 py-2 text-left",
                            selectedRowId === id
                              ? "bg-accent text-accent-foreground"
                              : "hover:bg-muted/60",
                          )}
                          onClick={() =>
                            selectFinding({
                              type: "secretScanning",
                              number: a.number,
                            })
                          }
                        >
                          <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
                            <ValidityChip validity={a.validity} />
                            {/* Only ever rendered for a confirmed public leak —
                                a null `publiclyLeaked` means GitHub didn't say. */}
                            {a.publiclyLeaked === true ? (
                              <Badge
                                variant="outline"
                                className="text-destructive"
                              >
                                Publicly leaked
                              </Badge>
                            ) : null}
                            {/* Rows in a group share a type and often a date, so
                                the alert number is what tells them apart. */}
                            <span className="ml-auto shrink-0 tabular-nums">
                              #{a.number}
                            </span>
                            <span className="shrink-0">
                              <RelativeTime date={a.createdAt} />
                            </span>
                          </p>
                          {/* Full-width type line, matching the alert rows. */}
                          <p
                            className="mt-1 truncate text-xs font-medium"
                            title={a.secretTypeDisplayName}
                          >
                            {a.secretTypeDisplayName}
                          </p>
                        </button>
                      ))}
                    </div>
                  ))
                )}
                {secretsOut.truncated &&
                  (limits.secretScanning >= FINDINGS_LIMIT_CAP ? (
                    <p className="border-t px-3 py-3 text-xs text-muted-foreground">
                      Showing the first {allSecrets.length.toLocaleString()}{" "}
                      secret scanning alerts.
                    </p>
                  ) : (
                    <LoadMoreRow
                      count={allSecrets.length}
                      loading={secrets.isFetching}
                      onLoadMore={() =>
                        setFindingsLimits({
                          ...limits,
                          secretScanning: Math.min(
                            limits.secretScanning + PAGE_SIZE,
                            FINDINGS_LIMIT_CAP,
                          ),
                        })
                      }
                    />
                  ))}
              </>
            )}

            <SectionHeader title="Advisories" />
            {advisories.isError ? (
              <LoadFailed
                category="security advisories"
                onRetry={() => advisories.refetch()}
              />
            ) : !advisoriesOut ? (
              <RowSkeletons />
            ) : advisoriesOut.availability !== "available" ? (
              <UnavailableCard
                availability={advisoriesOut.availability}
                detail={advisoriesOut.detail}
                category="security advisories"
                Category="Security advisories"
                notEnabledMessage="Repository advisories are only published on public repositories."
                onRetry={() => advisories.refetch()}
              />
            ) : (
              <>
                {advisoryRows.length === 0 ? (
                  allAdvisories.length > 0 ? (
                    <p className="px-3 py-4 text-xs text-muted-foreground">
                      No advisories match the filter.
                    </p>
                  ) : (
                    <Empty className="py-8">
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <ShieldCheckIcon />
                        </EmptyMedia>
                        <EmptyTitle>No security advisories</EmptyTitle>
                      </EmptyHeader>
                    </Empty>
                  )
                ) : (
                  advisoryRows.map(({ id, advisory: adv }) => {
                    // Published is the meaningful date; fall back to updated, and
                    // render nothing when both are absent — never invent one.
                    const when = adv.publishedAt ?? adv.updatedAt;
                    return (
                      <button
                        type="button"
                        key={id}
                        data-row={id}
                        className={cn(
                          "block w-full border-b px-3 py-2 text-left",
                          selectedRowId === id
                            ? "bg-accent text-accent-foreground"
                            : "hover:bg-muted/60",
                        )}
                        onClick={() =>
                          selectFinding({
                            type: "advisory",
                            ghsaId: adv.ghsaId,
                          })
                        }
                      >
                        <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          <SeverityChip severity={adv.severity} />
                          <span className="ml-auto min-w-0 truncate font-mono">
                            {adv.ghsaId}
                          </span>
                          <span className="shrink-0">{adv.state}</span>
                          {when ? (
                            <span className="shrink-0">
                              <RelativeTime date={when} />
                            </span>
                          ) : null}
                        </p>
                        {/* Full-width summary line, matching the alert rows. */}
                        <p
                          className="mt-1 truncate text-xs font-medium"
                          title={adv.summary}
                        >
                          {adv.summary}
                        </p>
                      </button>
                    );
                  })
                )}
                {advisoriesOut.truncated &&
                  (limits.advisories >= FINDINGS_LIMIT_CAP ? (
                    <p className="border-t px-3 py-3 text-xs text-muted-foreground">
                      Showing the first {allAdvisories.length.toLocaleString()}{" "}
                      security advisories.
                    </p>
                  ) : (
                    <LoadMoreRow
                      count={allAdvisories.length}
                      loading={advisories.isFetching}
                      onLoadMore={() =>
                        setFindingsLimits({
                          ...limits,
                          advisories: Math.min(
                            limits.advisories + PAGE_SIZE,
                            FINDINGS_LIMIT_CAP,
                          ),
                        })
                      }
                    />
                  ))}
              </>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
