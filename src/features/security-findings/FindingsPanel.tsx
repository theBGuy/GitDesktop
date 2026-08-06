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
import { forgeReady, forgeSupports, useForgeStatus } from "@/lib/git/queries";
import type {
  DependabotAlertOut,
  FindingAvailability,
  RepoAdvisoryOut,
} from "@/lib/github/security-findings";
import {
  useDependabotAlerts,
  useRepoAdvisories,
} from "@/lib/github/security-findings";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { type SelectedFinding, useUiStore } from "@/lib/stores/ui";
import { cn } from "@/lib/utils";
import { SEVERITY_RANK, SeverityChip, severityLevel } from "./severity";

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

/** Worst-first: the alerts endpoint orders by creation date, so severity order is
 *  applied here. The sort is stable, leaving created-order as the tiebreak within
 *  a level, and grouping preserves it — so both the groups and the rows inside
 *  each group run worst-first. */
function buildAlertGroups(alerts: DependabotAlertOut[]): AlertGroup[] {
  const sorted = alerts.toSorted(
    (a, b) =>
      SEVERITY_RANK[severityLevel(a.severity)] -
      SEVERITY_RANK[severityLevel(b.severity)],
  );
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

/** Whether two selections point at the same finding. Degenerate identities (a
 *  tolerated alert numbered 0, an advisory with no GHSA id) can't be told apart
 *  by the stored selection, so the first matching row wins. */
function sameFinding(a: SelectedFinding, b: SelectedFinding): boolean {
  if (a.type === "alert") return b.type === "alert" && a.number === b.number;
  return b.type === "advisory" && a.ghsaId === b.ghsaId;
}

const matchesAlert = (a: DependabotAlertOut, q: string) =>
  !q ||
  a.packageName.toLowerCase().includes(q) ||
  a.summary.toLowerCase().includes(q) ||
  a.ghsaId.toLowerCase().includes(q) ||
  (a.cveId?.toLowerCase().includes(q) ?? false);

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
 * The card for any envelope that isn't `"available"`. `onEnable` is passed only
 * by a category with a repo-level toggle; a category without one still reports
 * the state the server named rather than falling through to "couldn't check".
 * `Category` is the sentence-initial form of `category`.
 */
function UnavailableCard({
  availability,
  detail,
  category,
  Category,
  onRetry,
  onEnable,
}: {
  availability: Exclude<FindingAvailability, "available">;
  detail: string | null;
  category: string;
  Category: string;
  onRetry: () => void;
  onEnable?: () => void;
}) {
  if (availability === "notEnabled") {
    return onEnable ? (
      <ReasonCard
        icon={ShieldSlashIcon}
        message="Dependabot alerts are off for this repository. Turn them on to see vulnerable dependencies here."
        action={
          <Button variant="outline" size="sm" onClick={onEnable}>
            <GearSixIcon data-icon="inline-start" />
            Open security settings
          </Button>
        }
      />
    ) : (
      <ReasonCard
        icon={ShieldSlashIcon}
        message={`${Category} aren't enabled for this repository.`}
        detail={detail}
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
  // Dependabot alerts and repository advisories are GitHub-only surfaces, so the
  // gate is the capability, not a per-provider dispatch: a GitLab/Bitbucket repo
  // fires no query at all.
  const ready = forgeReady(forge.data);
  const supported = forgeSupports(forge.data, "securityFindings");
  const enabled = ready && supported;

  const limits = useUiStore((s) => s.findingsLimits);
  const setFindingsLimits = useUiStore((s) => s.setFindingsLimits);
  const selectedFinding = useUiStore((s) => s.selectedFinding);
  const selectFinding = useUiStore((s) => s.selectFinding);
  const requestRepoSettings = useUiStore((s) => s.requestRepoSettings);

  const alerts = useDependabotAlerts(repoPath, enabled, active, limits.alerts);
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
  const advisoriesOut = advisories.data;
  const allAlerts = alertsOut?.alerts ?? [];
  const allAdvisories = advisoriesOut?.advisories ?? [];
  const alertGroups = buildAlertGroups(
    allAlerts.filter((a) => matchesAlert(a, query)),
  );
  const advisoryRows = allAdvisories
    .filter((a) => matchesAdvisory(a, query))
    .map((advisory, i) => ({
      // Index fallback for a tolerated advisory with no GHSA id (see AlertRow).
      id: advisory.ghsaId ? `advisory-${advisory.ghsaId}` : `advisory-i${i}`,
      advisory,
    }));

  const alertsShown =
    !alerts.isError && alertsOut?.availability === "available";
  const advisoriesShown =
    !advisories.isError && advisoriesOut?.availability === "available";

  // Flat, document-order nav list: the grouped alert rows, then the advisory
  // rows. Group headers and the Load-more buttons are intentionally skipped.
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

  const refreshing = alerts.isFetching || advisories.isFetching;
  const refreshReason = enabled
    ? "Refresh findings"
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
          placeholder="Filter by package, summary, GHSA, or CVE"
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
                onRetry={() => alerts.refetch()}
                onEnable={() => requestRepoSettings("security")}
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
                {alertsOut.truncated && (
                  <LoadMoreRow
                    count={allAlerts.length}
                    loading={alerts.isFetching}
                    onLoadMore={() =>
                      setFindingsLimits({
                        ...limits,
                        alerts: limits.alerts + PAGE_SIZE,
                      })
                    }
                  />
                )}
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
                {advisoriesOut.truncated && (
                  <LoadMoreRow
                    count={allAdvisories.length}
                    loading={advisories.isFetching}
                    onLoadMore={() =>
                      setFindingsLimits({
                        ...limits,
                        advisories: limits.advisories + PAGE_SIZE,
                      })
                    }
                  />
                )}
              </>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
