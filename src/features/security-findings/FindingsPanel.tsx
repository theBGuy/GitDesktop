import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  ClockIcon,
  GearSixIcon,
  InfoIcon,
  LockKeyIcon,
  QuestionIcon,
  ShieldCheckIcon,
  ShieldSlashIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type ReactNode, useRef, useState } from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
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
import { providerLabel } from "@/lib/git/types";
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
import type {
  GlCodeQualityFindingOut,
  GlFindingAvailability,
  GlFindingsOut,
  GlPipelineState,
  GlSecureFindingOut,
} from "@/lib/gitlab/security-findings";
import {
  codeQualityFindingId,
  secureFindingId,
  useGitLabFindings,
} from "@/lib/gitlab/security-findings";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { type SelectedFinding, useUiStore } from "@/lib/stores/ui";
import { cn } from "@/lib/utils";
import {
  CodeScanningChip,
  CqChip,
  codeScanningRank,
  cqRank,
  SEVERITY_RANK,
  SeverityChip,
  severityLevel,
  VALIDITY_RANK,
  ValidityChip,
  validityLevel,
} from "./severity";

/** Ceiling for a category's row limit. MUST stay in lockstep with `clamp_limit`
 *  in BOTH src-tauri/src/github/security_findings.rs and
 *  src-tauri/src/forge/gitlab_findings.rs, which are the source of truth: they
 *  clamp every fetch to 500, so growing the limit past this would re-read the
 *  same 500 rows and leave "Load more" permanently offered. */
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
        // `||`, not `??`: the tolerant Raw parse degrades a missing field to an
        // empty string, so an empty name must fall through the same as a null.
        label: alert.ruleName || alert.ruleId || "Unidentified rule",
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

/** A secret type's display name, falling back through the tolerated-empty fields
 *  the Raw parse can leave behind. Shared by the group header and the row title
 *  so the two can never disagree — and grouping on it keeps two differently-typed
 *  secrets apart when both lost their display name. */
const secretTypeLabel = (a: SecretScanningAlertOut) =>
  a.secretTypeDisplayName || a.secretType || "Unknown secret type";

function buildSecretGroups(alerts: SecretScanningAlertOut[]): SecretGroup[] {
  const sorted = alerts.toSorted(bySecretUrgency);
  const groups = new Map<string, SecretGroup>();
  sorted.forEach((alert, i) => {
    const row: SecretRow = {
      id: alert.number === 0 ? `secret-i${i}` : `secret-${alert.number}`,
      alert,
    };
    const label = secretTypeLabel(alert);
    const bucket = groups.get(label);
    if (bucket) bucket.rows.push(row);
    else groups.set(label, { key: label, label, rows: [row] });
  });
  return [...groups.values()];
}

// ── GitLab pipeline findings ─────────────────────────────────────────────────

interface GlSecureRow {
  /** The rendered row's DOM id, built from the same `secureFindingId` the stored
   *  selection uses — the two must agree or a click highlights another row. */
  id: string;
  finding: GlSecureFindingOut;
}

interface GlSecureGroup {
  key: string;
  label: string;
  rows: GlSecureRow[];
}

interface GlQualityRow {
  id: string;
  finding: GlCodeQualityFindingOut;
}

interface GlQualityGroup {
  key: string;
  label: string;
  rows: GlQualityRow[];
}

/** SAST and secret-detection findings, grouped by rule/secret type. Sort first,
 *  group after: the groups AND the rows inside each group both run worst-first,
 *  and the report's own order stays the tiebreak within a rung. */
function buildGlSecureGroups(
  findings: GlSecureFindingOut[],
  prefix: "gl-sast" | "gl-secret",
  fallbackLabel: string,
): GlSecureGroup[] {
  const sorted = findings.toSorted(
    (a, b) =>
      SEVERITY_RANK[severityLevel(a.severity)] -
      SEVERITY_RANK[severityLevel(b.severity)],
  );
  const groups = new Map<string, GlSecureGroup>();
  for (const finding of sorted) {
    // `||`, not `??`: the tolerant parse degrades a missing field to an empty
    // string, so an empty name must fall through the same as a null.
    const label = finding.name || fallbackLabel;
    const row: GlSecureRow = {
      id: `${prefix}-${secureFindingId(finding)}`,
      finding,
    };
    const bucket = groups.get(label);
    if (bucket) bucket.rows.push(row);
    else groups.set(label, { key: label, label, rows: [row] });
  }
  return [...groups.values()];
}

function buildGlQualityGroups(
  findings: GlCodeQualityFindingOut[],
): GlQualityGroup[] {
  const sorted = findings.toSorted(
    (a, b) => cqRank(a.severity) - cqRank(b.severity),
  );
  const groups = new Map<string, GlQualityGroup>();
  for (const finding of sorted) {
    const label = finding.checkName || "Unidentified check";
    const row: GlQualityRow = {
      id: `gl-cq-${codeQualityFindingId(finding)}`,
      finding,
    };
    const bucket = groups.get(label);
    if (bucket) bucket.rows.push(row);
    else groups.set(label, { key: label, label, rows: [row] });
  }
  return [...groups.values()];
}

/** Whether two selections point at the same finding. The GitLab arms carry a
 *  derived composite (`secureFindingId` / `codeQualityFindingId`) precisely so an
 *  id-less finding is still distinguishable. The GitHub arms keep first-match-wins
 *  for their degenerate identities (an alert numbered 0, an advisory with no GHSA
 *  id) — a recorded deferral, not an oversight: the server always sends those, so
 *  only a tolerated parse degradation can blank one. */
function sameFinding(a: SelectedFinding, b: SelectedFinding): boolean {
  if (a.type === "advisory")
    return b.type === "advisory" && a.ghsaId === b.ghsaId;
  // GitLab ids are unique only within their category — a secret and a SAST
  // finding can share one — so the category is part of the comparison.
  if (a.type === "glFinding")
    return b.type === "glFinding" && b.category === a.category && b.id === a.id;
  // The three numbered categories keep separate number sequences, so the type
  // tag has to match too — alert #4 is not code scanning alert #4.
  return (
    b.type !== "advisory" &&
    b.type !== "glFinding" &&
    b.type === a.type &&
    b.number === a.number
  );
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

/** Identifiers match on BOTH name and value: reports spell a CWE as name
 *  `CWE-79` with value `79`, so searching values alone would miss what the detail
 *  pane actually shows — and the placeholder cues identifiers. */
const matchesGlSecure = (f: GlSecureFindingOut, q: string) =>
  !q ||
  f.name.toLowerCase().includes(q) ||
  f.description.toLowerCase().includes(q) ||
  f.file.toLowerCase().includes(q) ||
  f.severity.toLowerCase().includes(q) ||
  f.scannerName.toLowerCase().includes(q) ||
  f.identifiers.some(
    (i) =>
      i.name.toLowerCase().includes(q) || i.value.toLowerCase().includes(q),
  );

const matchesGlQuality = (f: GlCodeQualityFindingOut, q: string) =>
  !q ||
  f.checkName.toLowerCase().includes(q) ||
  f.path.toLowerCase().includes(q) ||
  f.description.toLowerCase().includes(q) ||
  f.severity.toLowerCase().includes(q);

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
  // A tolerated alert can arrive with no path at all; a line number hung off the
  // placeholder would read as a location, so it's dropped with the path.
  const text = path
    ? line === null
      ? path
      : `${path}:${line}`
    : "No file path";
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
 * The card for any envelope that isn't `"available"`. `notEnabledMessage` and
 * `noResultsYetMessage` are the category's own copy for those two states;
 * `onEnable` is passed on top of either only where the app can open the toggle.
 * A category without them still reports the state the server named rather than
 * falling through to "couldn't check". `Category` is the sentence-initial form
 * of `category`.
 */
function UnavailableCard({
  availability,
  detail,
  category,
  Category,
  notEnabledMessage,
  noResultsYetMessage,
  onRetry,
  onEnable,
}: {
  availability: Exclude<FindingAvailability, "available">;
  detail: string | null;
  category: string;
  Category: string;
  notEnabledMessage?: string;
  noResultsYetMessage?: string;
  onRetry: () => void;
  onEnable?: () => void;
}) {
  const enableAction = onEnable ? (
    <Button variant="outline" size="sm" onClick={onEnable}>
      <GearSixIcon data-icon="inline-start" />
      Open security settings
    </Button>
  ) : undefined;
  const retryAction = (
    <Button variant="outline" size="sm" onClick={onRetry}>
      <ArrowClockwiseIcon data-icon="inline-start" />
      Retry
    </Button>
  );

  if (availability === "notEnabled") {
    // The category's own sentence is how a non-admin learns what to ask for, so
    // it shows with or without the action. It already names the cause, so the
    // server's detail would only restate it — detail is for the generic path.
    return (
      <ReasonCard
        icon={ShieldSlashIcon}
        message={
          notEnabledMessage ?? `${Category} aren't enabled for this repository.`
        }
        detail={notEnabledMessage ? null : detail}
        action={enableAction}
      />
    );
  }
  if (availability === "noResultsYet") {
    // Deliberately not phrased as "turn it on": this state can't distinguish an
    // unconfigured feature from one whose first analysis is still running, so
    // both the copy and the actions cover each — settings for setup, Retry for
    // a run that may since have finished. Retry is the non-admin's only path.
    return (
      <ReasonCard
        icon={InfoIcon}
        message={
          noResultsYetMessage ??
          `No ${category} have been reported for this repository yet — the feature may not be set up, or its first run may still be going.`
        }
        detail={noResultsYetMessage ? null : detail}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {enableAction}
            {retryAction}
          </div>
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
  if (availability === "indeterminate") {
    return (
      <ReasonCard
        icon={QuestionIcon}
        message={`Couldn't check ${category}.`}
        detail={detail}
        action={retryAction}
      />
    );
  }
  // Every state is branched above, so this is unreachable — and the assignment
  // is the point: a new FindingAvailability variant fails to compile here
  // instead of silently rendering the "couldn't check" card.
  const _exhaustive: never = availability;
  return _exhaustive;
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

/** `"HEAD"` is the wire's sentinel for a ref we cannot name: a detached checkout,
 *  and equally a branch read that failed or came back empty — the backend degrades
 *  both to it and never queries pipelines under that name. No copy may therefore
 *  claim a result *for* it; sentences name the ref actually listed instead. */
const isUnnamedRef = (ref: string): boolean => ref === "HEAD";

/** The refs that were looked at, for copy that would otherwise claim something
 *  project-wide. Built from `requestedRef` + `defaultRef` — NOT `fallbackRef`,
 *  which is set only when a default-branch pipeline was actually used and so can
 *  never name the second ref in the state this serves. The sentinel contributes
 *  nothing (never queried under a name) and a branch that IS the default is named
 *  once; null when neither can be named. */
function checkedRefs(data: GlFindingsOut): string | null {
  const names = [
    isUnnamedRef(data.requestedRef) ? null : data.requestedRef,
    data.defaultRef && data.defaultRef !== data.requestedRef
      ? data.defaultRef
      : null,
  ].filter((name): name is string => name !== null);
  if (names.length === 2) return `${names[0]} or ${names[1]}`;
  return names[0] ?? null;
}

/** The project's scanning setup page, or null when the project URL is unknown —
 *  derived in one place so the panel-level card and the per-category cards can't
 *  drift apart on the path. */
const glScanningSetupUrl = (data: GlFindingsOut): string | null =>
  data.projectWebUrl ? `${data.projectWebUrl}/-/security/configuration` : null;

/** A partial-read disclosure on a category that IS available: some report bodies
 *  or items failed to parse, so the rows below are incomplete. Quiet by design —
 *  the data is usable, just not whole. */
function GlPartialDetail({ detail }: { detail: string | null }) {
  if (!detail) return null;
  return (
    <p className="px-3 py-2 text-[11px] text-muted-foreground">{detail}</p>
  );
}

/**
 * Which pipeline these findings came from. GitLab's reports are artifacts of one
 * commit's pipeline, not a repository-wide alert store, so the strip is what
 * keeps the list honest about how current it is. In normal layout flow (never
 * floating) so it can never cover a row.
 */
function PipelineProvenance({ data }: { data: GlFindingsOut }) {
  const pipeline = data.pipeline;
  if (!pipeline) return null;
  // The finish time is what dates the findings; a still-listed pipeline that
  // never finished falls back to when it started rather than showing nothing.
  const when = pipeline.finishedAt ?? pipeline.createdAt;
  // A failed pipeline still publishes artifacts and is deliberately accepted as
  // a source, so its status is surfaced — otherwise a failed run reads as a
  // healthy one above cards blaming setup. Success is the quiet default.
  const degraded = pipeline.status !== "success";
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
      {data.usedFallback ? (
        <p className="w-full">
          {isUnnamedRef(data.requestedRef)
            ? `No named branch checked out — showing ${data.fallbackRef || "the default branch"}.`
            : `No pipelines on ${data.requestedRef} yet — showing ${data.fallbackRef || "the default branch"}.`}
        </p>
      ) : null}
      <p className="min-w-0 flex-1 truncate">
        From pipeline #{pipeline.iid}
        {degraded && pipeline.status ? (
          // Icon + the status word: the state is never carried by tone alone.
          <span className="ml-1 inline-flex items-center gap-1 text-warning">
            <WarningCircleIcon className="size-3" aria-hidden />
            {pipeline.status}
          </span>
        ) : null}{" "}
        · <span className="font-mono">{pipeline.ref}</span> @{" "}
        <span className="font-mono">{pipeline.sha.slice(0, 8)}</span> ·{" "}
        <RelativeTime date={when} />
      </p>
      {pipeline.webUrl ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => openUrl(pipeline.webUrl)}
        >
          <ArrowSquareOutIcon data-icon="inline-start" />
          View pipeline
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The one panel-level card for a repo with no pipeline to read reports from —
 * all three categories share the state, so three identical cards would only
 * repeat it. `state` is passed separately from `data` so the exhaustiveness net
 * below has a union without `"found"` to close over.
 */
function GlNoPipelineCard({
  state,
  data,
  onRetry,
}: {
  state: Exclude<GlPipelineState, "found">;
  data: GlFindingsOut;
  onRetry: () => void;
}) {
  const retryAction = (
    <Button variant="outline" size="sm" onClick={onRetry}>
      <ArrowClockwiseIcon data-icon="inline-start" />
      Retry
    </Button>
  );
  const setupUrl = glScanningSetupUrl(data);

  if (state === "none") {
    // Only two refs were queried, so the sentence names them rather than
    // clearing the whole project: pipelines can live on refs we never asked for
    // (merge-request refs, tags, other branches).
    const refs = checkedRefs(data);
    return (
      <ReasonCard
        icon={ShieldSlashIcon}
        message={`${refs ? `No pipelines found on ${refs}.` : "No pipelines found."} Add SAST, secret detection, or code quality jobs to see findings here.`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {setupUrl ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => openUrl(setupUrl)}
              >
                <GearSixIcon data-icon="inline-start" />
                Open scanning setup on GitLab
              </Button>
            ) : null}
            {retryAction}
          </div>
        }
      />
    );
  }
  if (state === "runningOnly") {
    // Name only a ref whose pipelines were actually listed: on the "HEAD"
    // sentinel that is the fallback branch, never the checkout itself.
    const listed =
      data.usedFallback || isUnnamedRef(data.requestedRef)
        ? data.fallbackRef
        : data.requestedRef;
    return (
      <ReasonCard
        icon={ClockIcon}
        // Canceled, skipped, manual and pending pipelines all land here, so this
        // promises no finish — only that a completed one would be read.
        message={
          listed
            ? `No pipeline on ${listed} has finished yet — findings will appear once one completes.`
            : "No pipeline has finished yet — findings will appear once one completes."
        }
        action={retryAction}
      />
    );
  }
  if (state === "unavailable") {
    // Every category carries the same classified state here, so the SAST
    // envelope speaks for the panel.
    if (data.sast.availability === "forbidden") {
      return (
        <ReasonCard
          icon={LockKeyIcon}
          message="Your GitLab sign-in can't read this project's pipelines."
          detail={data.sast.detail}
        />
      );
    }
    return (
      <ReasonCard
        icon={QuestionIcon}
        message="Couldn't check findings for this repository."
        detail={data.sast.detail}
        action={retryAction}
      />
    );
  }
  // A new GlPipelineState fails to compile here instead of silently rendering
  // nothing at all.
  const _exhaustive: never = state;
  return _exhaustive;
}

/**
 * The card for a category whose envelope isn't `"available"`, on a pipeline we
 * did find. `category` is the lowercase mid-sentence form, `Category` the
 * sentence-initial one; `onSetup` is passed only where the project's web URL is
 * known, so the setup link can't be a dead end.
 */
function GlUnavailableCard({
  availability,
  detail,
  category,
  Category,
  notConfiguredMessage,
  onRetry,
  onSetup,
}: {
  availability: Exclude<GlFindingAvailability, "available">;
  detail: string | null;
  category: string;
  Category: string;
  /** Replaces the per-category sentence where the shared template reads badly —
   *  the hoisted card speaks for all three at once. */
  notConfiguredMessage?: string;
  onRetry: () => void;
  onSetup?: () => void;
}) {
  const retryAction = (
    <Button variant="outline" size="sm" onClick={onRetry}>
      <ArrowClockwiseIcon data-icon="inline-start" />
      Retry
    </Button>
  );

  if (availability === "notConfigured") {
    return (
      <ReasonCard
        icon={ShieldSlashIcon}
        // Hedged deliberately: an analyzer job that ran and FAILED publishes no
        // artifacts either, and the wire can't tell that from never-configured.
        message={
          notConfiguredMessage ??
          `This pipeline didn't publish a ${category} report — most likely scanning isn't set up yet.`
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            {onSetup ? (
              <Button variant="outline" size="sm" onClick={onSetup}>
                <GearSixIcon data-icon="inline-start" />
                Open scanning setup on GitLab
              </Button>
            ) : null}
            {retryAction}
          </div>
        }
      />
    );
  }
  if (availability === "reportNotReadable") {
    return (
      <ReasonCard
        icon={WarningCircleIcon}
        // "the job that produces it" reads correctly whether this card speaks for
        // one category or, hoisted, for all three (up to three jobs).
        message={`This pipeline produced a ${category} report GitDesktop can't download. Add the gl-*-report.json file to artifacts:paths in the job that produces it.`}
        detail={detail}
        action={retryAction}
      />
    );
  }
  if (availability === "expired") {
    return (
      <ReasonCard
        icon={ClockIcon}
        message="The reports from this pipeline have expired. Findings will return on the next pipeline run."
        detail={detail}
        action={retryAction}
      />
    );
  }
  if (availability === "analysisPending") {
    return (
      <ReasonCard
        icon={InfoIcon}
        message={`${Category} is still running in this pipeline.`}
        action={retryAction}
      />
    );
  }
  if (availability === "forbidden") {
    return (
      <ReasonCard
        icon={LockKeyIcon}
        message="Your GitLab sign-in can't read this project's job artifacts."
        detail={detail}
      />
    );
  }
  if (availability === "indeterminate") {
    return (
      <ReasonCard
        icon={QuestionIcon}
        message={`Couldn't check ${category}.`}
        detail={detail}
        action={retryAction}
      />
    );
  }
  // A new GlFindingAvailability variant fails to compile here instead of
  // silently rendering the "couldn't check" card.
  const _exhaustive: never = availability;
  return _exhaustive;
}

/** The empty state for an available category with no rows. A wholly-clean report
 *  and one whose items partly failed to parse must never read the same, so the
 *  reassuring shield is reserved for the case where nothing was lost. The lossy
 *  wording claims only what was read: one analyzer's report can parse clean while
 *  a sibling's is lost, so "nothing readable" would deny a read that happened. */
function GlSectionEmpty({
  category,
  cleanTitle,
  detail,
}: {
  category: string;
  cleanTitle: string;
  detail: string | null;
}) {
  return (
    <Empty className="py-8">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {detail ? <InfoIcon /> : <ShieldCheckIcon />}
        </EmptyMedia>
        <EmptyTitle>
          {detail
            ? `No ${category} findings in the reports that could be read.`
            : cleanTitle}
        </EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}

/** The grouped rows of SAST or secret detection. The group header carries the
 *  rule/secret name, so each row leads with where it was found. */
function GlSecureRows({
  groups,
  category,
  selectedRowId,
  onSelect,
}: {
  groups: GlSecureGroup[];
  category: "sast" | "secretDetection";
  selectedRowId: string | null;
  onSelect: (finding: SelectedFinding) => void;
}) {
  return (
    <>
      {groups.map((group) => (
        <div key={group.key}>
          <div className="flex items-baseline gap-2 px-3 py-1 text-[11px] text-muted-foreground">
            <span className="truncate text-foreground" title={group.label}>
              {group.label}
            </span>
            <span className="ml-auto shrink-0 tabular-nums">
              {group.rows.length}
            </span>
          </div>
          {group.rows.map(({ id, finding: f }) => (
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
                onSelect({
                  type: "glFinding",
                  category,
                  id: secureFindingId(f),
                })
              }
            >
              <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <SeverityChip severity={f.severity} />
                <PathLabel path={f.file} line={f.startLine} />
              </p>
              {f.scannerName ? (
                <p
                  className="mt-1 truncate text-[11px] text-muted-foreground"
                  title={f.scannerName}
                >
                  {f.scannerName}
                </p>
              ) : null}
            </button>
          ))}
        </div>
      ))}
    </>
  );
}

function GlQualityRows({
  groups,
  selectedRowId,
  onSelect,
}: {
  groups: GlQualityGroup[];
  selectedRowId: string | null;
  onSelect: (finding: SelectedFinding) => void;
}) {
  return (
    <>
      {groups.map((group) => (
        <div key={group.key}>
          <div className="flex items-baseline gap-2 px-3 py-1 text-[11px] text-muted-foreground">
            <span className="truncate text-foreground" title={group.label}>
              {group.label}
            </span>
            <span className="ml-auto shrink-0 tabular-nums">
              {group.rows.length}
            </span>
          </div>
          {group.rows.map(({ id, finding: f }) => (
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
                onSelect({
                  type: "glFinding",
                  category: "codeQuality",
                  id: codeQualityFindingId(f),
                })
              }
            >
              <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <CqChip severity={f.severity} />
                <PathLabel path={f.path} line={f.line} />
              </p>
              {f.description ? (
                <p
                  className="mt-1 truncate text-xs font-medium"
                  title={f.description}
                >
                  {f.description}
                </p>
              ) : null}
            </button>
          ))}
        </div>
      ))}
    </>
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
  // Two different findings models behind one capability: GitHub's four
  // repository-wide alert stores, and GitLab's per-pipeline report artifacts.
  // The capability gates whether the tab has anything at all; the provider picks
  // which set of queries runs, so the other provider's fire not at all.
  const provider = forge.data?.provider;
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

  const glOut = gl.data;
  const glSetupUrl = glOut ? glScanningSetupUrl(glOut) : null;
  const allGlSast = glOut?.sast.findings ?? [];
  const allGlSecrets = glOut?.secretDetection.findings ?? [];
  const allGlQuality = glOut?.codeQuality.findings ?? [];
  const glSastGroups = buildGlSecureGroups(
    allGlSast.filter((f) => matchesGlSecure(f, query)),
    "gl-sast",
    "Unidentified rule",
  );
  const glSecretGroups = buildGlSecureGroups(
    allGlSecrets.filter((f) => matchesGlSecure(f, query)),
    "gl-secret",
    "Unknown secret type",
  );
  const glQualityGroups = buildGlQualityGroups(
    allGlQuality.filter((f) => matchesGlQuality(f, query)),
  );

  const alertsShown =
    !alerts.isError && alertsOut?.availability === "available";
  const codeScanningShown =
    !codeScanning.isError && codeScanningOut?.availability === "available";
  const secretsShown =
    !secrets.isError && secretsOut?.availability === "available";
  const advisoriesShown =
    !advisories.isError && advisoriesOut?.availability === "available";
  // Equal availability AND equal detail across all three — what a pipeline-wide
  // cause (a jobs-fetch failure, a pipeline with no scanning jobs) produces.
  const glUniformState =
    !!glOut &&
    glOut.sast.availability === glOut.secretDetection.availability &&
    glOut.sast.availability === glOut.codeQuality.availability &&
    glOut.sast.detail === glOut.secretDetection.detail &&
    glOut.sast.detail === glOut.codeQuality.detail;
  // Every GitLab category hangs off one pipeline, so a state other than "found"
  // hides all three at once.
  const glFound = !gl.isError && glOut?.pipelineState === "found";
  const glSastShown = glFound && glOut?.sast.availability === "available";
  const glSecretsShown =
    glFound && glOut?.secretDetection.availability === "available";
  const glQualityShown =
    glFound && glOut?.codeQuality.availability === "available";

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
  if (glSastShown) {
    for (const group of glSastGroups) {
      for (const row of group.rows) {
        navRows.push({
          id: row.id,
          finding: {
            type: "glFinding",
            category: "sast",
            id: secureFindingId(row.finding),
          },
        });
      }
    }
  }
  if (glSecretsShown) {
    for (const group of glSecretGroups) {
      for (const row of group.rows) {
        navRows.push({
          id: row.id,
          finding: {
            type: "glFinding",
            category: "secretDetection",
            id: secureFindingId(row.finding),
          },
        });
      }
    }
  }
  if (glQualityShown) {
    for (const group of glQualityGroups) {
      for (const row of group.rows) {
        navRows.push({
          id: row.id,
          finding: {
            type: "glFinding",
            category: "codeQuality",
            id: codeQualityFindingId(row.finding),
          },
        });
      }
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
    advisories.isFetching ||
    gl.isFetching;
  const refreshReason = enabled
    ? "Refresh findings"
    : !supported && ready
      ? "Security findings aren't available on this repository's host."
      : // Names the host the remote actually points at; a repo with no
        // recognized remote gets the neutral wording rather than a guess
        // (`providerLabel` alone would name GitHub for an unknown provider).
        provider
        ? `Connect this repo to ${providerLabel(provider)} to load findings`
        : "Connect this repo to a supported host to load findings";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b p-2">
        <p className="text-xs text-muted-foreground">Security findings</p>
        <div className="ml-auto flex items-center gap-1">
          <DisabledReasonButton
            variant="outline"
            size="icon-sm"
            aria-label="Refresh findings"
            disabled={!enabled || refreshing}
            // `refreshReason` doubles as the enabled-state hint ("Refresh findings").
            reason={enabled ? null : refreshReason}
            title={refreshReason}
            onClick={() =>
              queryClient.invalidateQueries({
                queryKey: ["repo", repoPath, "findings"],
              })
            }
          >
            <ArrowClockwiseIcon className={cn(refreshing && "animate-spin")} />
          </DisabledReasonButton>
        </div>
      </div>
      <div className="border-b p-2">
        <Input
          ref={filterRef}
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          placeholder={
            provider === "gitlab"
              ? "Filter by rule, secret type, check, file, severity, description, or identifier"
              : "Filter by package, rule, secret type, summary, GHSA, or CVE"
          }
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
        ) : provider === "gitlab" ? (
          gl.isError ? (
            <LoadFailed category="findings" onRetry={() => gl.refetch()} />
          ) : !glOut ? (
            <RowSkeletons />
          ) : glOut.pipelineState !== "found" ? (
            <GlNoPipelineCard
              state={glOut.pipelineState}
              data={glOut}
              onRetry={() => gl.refetch()}
            />
          ) : (
            <div onKeyDown={onListKeyDown}>
              <PipelineProvenance data={glOut} />
              {glUniformState && glOut.sast.availability !== "available" ? (
                /* One cause, one card — and no section headers, since naming
                   three empty sections would only restate it. */
                <GlUnavailableCard
                  availability={glOut.sast.availability}
                  detail={glOut.sast.detail}
                  category="findings"
                  Category="Scanning"
                  notConfiguredMessage="This pipeline didn't publish any scanning reports — most likely scanning isn't set up yet."
                  onRetry={() => gl.refetch()}
                  onSetup={glSetupUrl ? () => openUrl(glSetupUrl) : undefined}
                />
              ) : (
                <>
                  <SectionHeader title="SAST" />
                  {glOut.sast.availability !== "available" ? (
                    <GlUnavailableCard
                      availability={glOut.sast.availability}
                      detail={glOut.sast.detail}
                      category="SAST"
                      Category="SAST"
                      onRetry={() => gl.refetch()}
                      onSetup={
                        glSetupUrl ? () => openUrl(glSetupUrl) : undefined
                      }
                    />
                  ) : (
                    <>
                      <GlPartialDetail detail={glOut.sast.detail} />
                      {glSastGroups.length === 0 ? (
                        allGlSast.length > 0 ? (
                          <p className="px-3 py-4 text-xs text-muted-foreground">
                            No SAST findings match the filter.
                          </p>
                        ) : (
                          <GlSectionEmpty
                            category="SAST"
                            cleanTitle="No SAST findings in this pipeline"
                            detail={glOut.sast.detail}
                          />
                        )
                      ) : (
                        <GlSecureRows
                          groups={glSastGroups}
                          category="sast"
                          selectedRowId={selectedRowId}
                          onSelect={selectFinding}
                        />
                      )}
                      {/* Outside the empty branch: filtering to zero matches must
                          not strip the only way to reach rows past the window. */}
                      {glOut.sast.truncated &&
                        (limits.gitlab >= FINDINGS_LIMIT_CAP ? (
                          <p className="border-t px-3 py-3 text-xs text-muted-foreground">
                            Showing the first{" "}
                            {allGlSast.length.toLocaleString()} SAST findings.
                          </p>
                        ) : (
                          <LoadMoreRow
                            count={allGlSast.length}
                            loading={gl.isFetching}
                            onLoadMore={() =>
                              setFindingsLimits({
                                ...limits,
                                gitlab: Math.min(
                                  limits.gitlab + PAGE_SIZE,
                                  FINDINGS_LIMIT_CAP,
                                ),
                              })
                            }
                          />
                        ))}
                    </>
                  )}

                  <SectionHeader title="Secret detection" />
                  {glOut.secretDetection.availability !== "available" ? (
                    <GlUnavailableCard
                      availability={glOut.secretDetection.availability}
                      detail={glOut.secretDetection.detail}
                      category="secret detection"
                      Category="Secret detection"
                      onRetry={() => gl.refetch()}
                      onSetup={
                        glSetupUrl ? () => openUrl(glSetupUrl) : undefined
                      }
                    />
                  ) : (
                    <>
                      <GlPartialDetail detail={glOut.secretDetection.detail} />
                      {glSecretGroups.length === 0 ? (
                        allGlSecrets.length > 0 ? (
                          <p className="px-3 py-4 text-xs text-muted-foreground">
                            No secret findings match the filter.
                          </p>
                        ) : (
                          <GlSectionEmpty
                            category="secret detection"
                            cleanTitle="No secrets detected in this pipeline"
                            detail={glOut.secretDetection.detail}
                          />
                        )
                      ) : (
                        <GlSecureRows
                          groups={glSecretGroups}
                          category="secretDetection"
                          selectedRowId={selectedRowId}
                          onSelect={selectFinding}
                        />
                      )}
                      {glOut.secretDetection.truncated &&
                        (limits.gitlab >= FINDINGS_LIMIT_CAP ? (
                          <p className="border-t px-3 py-3 text-xs text-muted-foreground">
                            Showing the first{" "}
                            {allGlSecrets.length.toLocaleString()} secret
                            findings.
                          </p>
                        ) : (
                          <LoadMoreRow
                            count={allGlSecrets.length}
                            loading={gl.isFetching}
                            onLoadMore={() =>
                              setFindingsLimits({
                                ...limits,
                                gitlab: Math.min(
                                  limits.gitlab + PAGE_SIZE,
                                  FINDINGS_LIMIT_CAP,
                                ),
                              })
                            }
                          />
                        ))}
                    </>
                  )}

                  <SectionHeader title="Code quality" />
                  {glOut.codeQuality.availability !== "available" ? (
                    <GlUnavailableCard
                      availability={glOut.codeQuality.availability}
                      detail={glOut.codeQuality.detail}
                      category="code quality"
                      Category="Code quality"
                      onRetry={() => gl.refetch()}
                      onSetup={
                        glSetupUrl ? () => openUrl(glSetupUrl) : undefined
                      }
                    />
                  ) : (
                    <>
                      <GlPartialDetail detail={glOut.codeQuality.detail} />
                      {glQualityGroups.length === 0 ? (
                        allGlQuality.length > 0 ? (
                          <p className="px-3 py-4 text-xs text-muted-foreground">
                            No code quality findings match the filter.
                          </p>
                        ) : (
                          <GlSectionEmpty
                            category="code quality"
                            cleanTitle="No code quality findings in this pipeline"
                            detail={glOut.codeQuality.detail}
                          />
                        )
                      ) : (
                        <GlQualityRows
                          groups={glQualityGroups}
                          selectedRowId={selectedRowId}
                          onSelect={selectFinding}
                        />
                      )}
                      {glOut.codeQuality.truncated &&
                        (limits.gitlab >= FINDINGS_LIMIT_CAP ? (
                          <p className="border-t px-3 py-3 text-xs text-muted-foreground">
                            Showing the first{" "}
                            {allGlQuality.length.toLocaleString()} code quality
                            findings.
                          </p>
                        ) : (
                          <LoadMoreRow
                            count={allGlQuality.length}
                            loading={gl.isFetching}
                            onLoadMore={() =>
                              setFindingsLimits({
                                ...limits,
                                gitlab: Math.min(
                                  limits.gitlab + PAGE_SIZE,
                                  FINDINGS_LIMIT_CAP,
                                ),
                              })
                            }
                          />
                        ))}
                    </>
                  )}
                </>
              )}
            </div>
          )
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
                          title={group.packageName || "Unknown package"}
                        >
                          {group.packageName || "Unknown package"}
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
                notEnabledMessage="Code scanning is off for this repository. Turn it on to see alerts here."
                noResultsYetMessage="Code scanning hasn't reported results for this repository yet — it may still need setting up, or its first analysis may still be running."
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
                        {/* The raw id, alongside a named rule. Suppressed when
                            the id is itself empty — the label already covers it. */}
                        {group.key && group.label !== group.key ? (
                          <span
                            className="min-w-0 shrink truncate font-mono"
                            title={group.key}
                          >
                            {group.key}
                          </span>
                        ) : null}
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
                                the alert number is what tells them apart — but a
                                tolerated alert numbered 0 has none to show. */}
                            {a.number === 0 ? null : (
                              <span className="ml-auto shrink-0 tabular-nums">
                                #{a.number}
                              </span>
                            )}
                            {/* The number span normally carries `ml-auto`;
                                without it the date takes over pushing right. */}
                            <span
                              className={cn(
                                "shrink-0",
                                a.number === 0 && "ml-auto",
                              )}
                            >
                              <RelativeTime date={a.createdAt} />
                            </span>
                          </p>
                          {/* Full-width type line, matching the alert rows. */}
                          <p
                            className="mt-1 truncate text-xs font-medium"
                            title={secretTypeLabel(a)}
                          >
                            {secretTypeLabel(a)}
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
                          {adv.ghsaId ? (
                            <span className="ml-auto min-w-0 truncate font-mono">
                              {adv.ghsaId}
                            </span>
                          ) : null}
                          {/* The GHSA span normally carries `ml-auto`; without
                              it the state takes over pushing the row right. */}
                          <span
                            className={cn("shrink-0", !adv.ghsaId && "ml-auto")}
                          >
                            {adv.state}
                          </span>
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
