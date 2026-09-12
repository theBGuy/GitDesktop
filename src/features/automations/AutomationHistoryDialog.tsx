import {
  ArrowCounterClockwiseIcon,
  ArrowsClockwiseIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  InfoIcon,
  LightningIcon,
  MagnifyingGlassIcon,
  PlayIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { create } from "zustand";
import { ListRowSkeletons } from "@/components/list-row-skeleton";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  type AutomationHistoryEntry,
  type AutomationOutcomeCode,
  type AutomationTrigger,
  automationHistoryKey,
  listAutomationHistory,
  recordAutomationPauseMarker,
  STEADY_OUTCOME_CODES,
} from "@/lib/automations/history";
import { useAutomations } from "@/lib/automations/queries";
import {
  ACTION_LABELS,
  type ActionId,
  effectiveActions,
  LIFECYCLE_EVENTS,
  LIFECYCLE_LABELS,
  repoEntry,
} from "@/lib/automations/types";
import { clipTitle, clipTitleFromText } from "@/lib/clip-title";
import { useRepoIdentity } from "@/lib/git/queries";
import { repoIdentity } from "@/lib/git/repo-identity";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { applyRepoLens } from "@/lib/repo-lens/queries";
import { useAiEnabled, useSettings } from "@/lib/settings/queries";
import { useReviewTasks } from "@/lib/stores/reviews";
import { useUiStore } from "@/lib/stores/ui";
import { COLD_START_AUTOMATIONS_OFF } from "@/lib/test-mode";
import { validEpochMs } from "@/lib/time";
import { useRetained } from "@/lib/use-retained";
import { cn } from "@/lib/utils";

interface AutomationHistoryDialogState {
  /** Repo path whose history is open, or null when closed. */
  openFor: string | null;
  open: (repoPath: string) => void;
  close: () => void;
}

/** Open-state for the one mounted {@link AutomationHistoryDialogHost} (the
 *  AutomationResultDialog precedent), so any surface — the repo menu, the
 *  activity dock's footer — opens it without threading props or a second mount. */
export const useAutomationHistoryDialog =
  create<AutomationHistoryDialogState>()((set) => ({
    openFor: null,
    open: (repoPath) => set({ openFor: repoPath }),
    close: () => set({ openFor: null }),
  }));

type TargetKind = AutomationHistoryEntry["targetKind"];
type Outcome = AutomationHistoryEntry["outcomes"][number];
type Tone = "success" | "destructive" | "warning" | "info" | "muted";

/** Tone → semantic token. Always applied to the WORDS of a reason line, never to
 *  the row's glyph, so no state is carried by color alone (WCAG AA). */
const TONE_CLASS: Record<Tone, string> = {
  success: "text-success",
  destructive: "text-destructive",
  warning: "text-warning",
  info: "text-info",
  muted: "text-muted-foreground",
};

/** Glyph per trigger — the shape says what fired. Read with a plain string from
 *  the log, so an entry written by a newer build must miss into the fallback
 *  rather than fail. */
const TRIGGER_GLYPH: Partial<Record<AutomationTrigger, typeof LightningIcon>> =
  {
    commit: GitCommitIcon,
    "pr-open": GitPullRequestIcon,
    "pr-sync": ArrowsClockwiseIcon,
    "catch-up": MagnifyingGlassIcon,
    "run-now": PlayIcon,
    "re-run": ArrowCounterClockwiseIcon,
  };

/** Where a delivered result landed, which is a property of the target, not of
 *  the outcome code. */
const DELIVERED_TEXT: Record<TargetKind, string> = {
  remote: "Posted as a comment",
  local: "Posted as a comment",
  commit: "Review saved",
  none: "Delivered",
};

interface ReasonLine {
  text: string;
  tone: Tone;
}

const UNKNOWN_REASON: ReasonLine = { text: "Unknown", tone: "muted" };

/**
 * Reason copy + tone per outcome code, total over the union so a code added
 * later can't render as silence. `delivered` reads the entry (where the output
 * went); `started` reads `live` — whether THIS instance holds a running run for
 * the row's target.
 */
const OUTCOME_REASON: Record<
  AutomationOutcomeCode,
  (entry: AutomationHistoryEntry, outcome: Outcome, live: boolean) => ReasonLine
> = {
  delivered: (entry) => ({
    text: DELIVERED_TEXT[entry.targetKind] ?? "Delivered",
    tone: "success",
  }),
  // Liveness, never the clock: instances share this store, so a row's age says
  // nothing about whether its run is still going. "Running" is claimed only
  // where this instance can show the row it points at; everything else — a
  // crash mid-run, or a run another instance owns and will still post — is the
  // same honest statement about the RECORD, which never settled.
  started: (entry, _outcome, live) =>
    live
      ? { text: "Running — watch it in Activity", tone: "info" }
      : {
          // Commit runs register a degenerate live target (no commit kind, empty
          // ref), so their rows can never match liveness — the honest set for
          // them includes "still running here".
          text:
            entry.targetKind === "commit"
              ? "Didn't settle — it may still be running, or the app closed mid-run"
              : "Didn't settle — the app closed mid-run, or another instance owns it",
          tone: "warning",
        },
  "branch-skip": () => ({
    text: "Skipped — branch conditions didn't match",
    tone: "muted",
  }),
  "needs-first-review": () => ({
    text: "Skipped — waiting for a first review in this mode",
    tone: "muted",
  }),
  "head-covered": () => ({
    text: "Skipped — this head was already reviewed",
    tone: "muted",
  }),
  "head-dismissed": () => ({
    text: "Skipped — this head was dismissed",
    tone: "muted",
  }),
  "already-reviewed": () => ({
    text: "Skipped — already reviewed",
    tone: "muted",
  }),
  "draft-skipped": () => ({
    text: "Skipped — draft (draft reviews are off)",
    tone: "muted",
  }),
  // The recorder attaches a detail when it could NOT measure the PR's age, so
  // the 14-day claim is only made where an age was actually read.
  "too-old": (_entry, outcome) => ({
    text: asText(outcome.detail) || "Skipped — opened more than 14 days ago",
    tone: "muted",
  }),
  "empty-diff": () => ({
    text: "Skipped — no changes to review",
    tone: "muted",
  }),
  cancelled: () => ({ text: "Cancelled", tone: "muted" }),
  "claim-held": () => ({
    text: "Skipped — this head is already claimed by a review run",
    tone: "warning",
  }),
  // The Run-now toast sends users HERE for the error, so the recorded detail
  // must render (the row truncates with a full-text hover tooltip).
  "eligibility-error": (_entry, outcome) => ({
    text: asText(outcome.detail)
      ? `Couldn't read review history — ${asText(outcome.detail)}`
      : "Couldn't read review history — treated as already reviewed",
    tone: "warning",
  }),
  failed: (_entry, outcome) => ({
    text: asText(outcome.detail)
      ? `Failed — ${asText(outcome.detail)}`
      : "Failed",
    tone: "destructive",
  }),
  "timed-out": () => ({
    text: "Timed out — partial output kept",
    tone: "destructive",
  }),
  paused: () => ({
    text: "AI features hidden — automations paused",
    tone: "muted",
  }),
  resumed: () => ({
    text: "AI features shown — automations resumed",
    tone: "muted",
  }),
};

/** Codes whose catch-up run latched the (PR, head) pair for the session, so the
 *  poller won't come back to it on its own. */
const LATCHING_CODES = new Set<string>([
  "eligibility-error",
  "failed",
  "claim-held",
]);

/** Every field below is read back from a JSON file a user can hand-edit, so a
 *  non-string reaches JSX as an object React refuses to render. */
function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A stamp's epoch-ms, or null when it isn't a date `RelativeTime` can render —
 *  a hand-edited value must drop its cell, not take down the dialog. */
function stampMs(ts: string): number | null {
  const ms = new Date(asText(ts)).getTime();
  return validEpochMs(ms) ? ms : null;
}

/** Coalesced-entry count, floored at 1 — a hand-edited or absent value must read
 *  as a single event, never as a negative or fractional one. */
function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 1
    ? Math.floor(value)
    : 1;
}

function actionLabel(action: ActionId | null): string {
  // A row can record a decision that belongs to no single action (a marker, a
  // whole-event skip), and the stored id may be one this build doesn't know.
  return (action && ACTION_LABELS[action]) || "Automations";
}

/**
 * Row glyph. Target kind decides first: a pause marker is stored with the
 * user-initiated trigger, and a Play glyph would claim a run that never was.
 * The trigger lookup is OWN-property only — a hand-edited `"__proto__"` would
 * otherwise resolve up the prototype chain to a truthy non-component that `??`
 * can't catch and JSX throws on. (`action` and `targetKind` are
 * membership-validated at the store's guard, so their Record lookups stay plain.)
 */
function glyphFor(entry: AutomationHistoryEntry): typeof LightningIcon {
  if (entry.targetKind === "none") return LightningIcon;
  if (!Object.hasOwn(TRIGGER_GLYPH, entry.trigger)) return LightningIcon;
  return TRIGGER_GLYPH[entry.trigger] ?? LightningIcon;
}

/**
 * One outcome's reason line. Own-property only, for the same reason
 * {@link glyphFor} is: a hand-edited code resolves up the prototype chain
 * otherwise — `"__proto__"` to a non-function the optional call throws on,
 * `"toString"` to a real function that returns a string and renders as blanks.
 */
function reasonFor(
  entry: AutomationHistoryEntry,
  outcome: Outcome,
  live: boolean,
): ReasonLine {
  if (!Object.hasOwn(OUTCOME_REASON, outcome.code)) return UNKNOWN_REASON;
  return OUTCOME_REASON[outcome.code]?.(entry, outcome, live) ?? UNKNOWN_REASON;
}

/** Marker rows carry no target, so their title comes from what was recorded. */
function markerTitle(outcomes: Outcome[]): string {
  if (outcomes.some((o) => o.code === "resumed")) return "Automations resumed";
  if (outcomes.some((o) => o.code === "paused")) return "Automations paused";
  return "Automations";
}

const TITLE_FOR: Record<
  TargetKind,
  (entry: AutomationHistoryEntry, outcomes: Outcome[]) => string
> = {
  remote: (entry) => {
    const title = asText(entry.title);
    const ref = asText(entry.ref);
    return title ? `#${ref} · ${title}` : `#${ref}`;
  },
  local: (entry) => asText(entry.title),
  commit: (entry) => {
    const title = asText(entry.title);
    // ref is the BRANCH, which a commit made on a detached HEAD records as ""
    // — the separator must not render against an empty side.
    const ref = asText(entry.ref);
    if (!title) return ref;
    return ref ? `${ref} · ${title}` : title;
  },
  none: (_entry, outcomes) => markerTitle(outcomes),
};

/** A coalesced row must read as a summary, not as one event: commit rows count
 *  the commits inside the skip, PR rows count the times the same decision
 *  recurred for one pull request. Only steady outcomes coalesce, so only they
 *  carry the count into their words. */
function joinCount(
  text: string,
  count: number,
  kind: TargetKind,
  code: AutomationOutcomeCode,
): string {
  if (count <= 1 || !STEADY_OUTCOME_CODES.includes(code)) return text;
  if (kind !== "commit") return `${text} (seen ${count}×)`;
  const skip = "Skipped — ";
  return text.startsWith(skip)
    ? `Skipped ${count} commits — ${text.slice(skip.length)}`
    : `${text} (${count} commits)`;
}

type BannerTone = "info" | "warning";

const BANNER_CLASS: Record<BannerTone, string> = {
  info: "bg-info/10 text-info",
  warning: "bg-warning/10 text-warning",
};

const BANNER_GLYPH: Record<BannerTone, typeof InfoIcon> = {
  info: InfoIcon,
  warning: WarningIcon,
};

/** A present-tense state, in the layout flow above the records — it pushes the
 *  list down rather than covering any of it. */
function Banner({ tone, children }: { tone: BannerTone; children: ReactNode }) {
  const Glyph = BANNER_GLYPH[tone];
  return (
    <p
      className={cn(
        "flex items-start gap-1.5 border-b px-3 py-1.5 text-[11px]",
        BANNER_CLASS[tone],
      )}
    >
      <Glyph className="mt-px size-3.5 shrink-0" weight="fill" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/**
 * What this repository's automations ran, skipped, and why — the durable
 * decision log, read-only. Mounted once at the app root and opened by store
 * flag, so the repo menu and the activity dock share one instance.
 *
 * Historical rows carry no actions: a record is evidence, and re-running from
 * one would spend money and post publicly from a surface that reads as a log.
 */
export function AutomationHistoryDialogHost() {
  const openFor = useAutomationHistoryDialog((s) => s.openFor);
  const close = useAutomationHistoryDialog((s) => s.close);
  // Retained so the body keeps its repo through the close fade instead of
  // blanking the dialog as it animates out.
  const shownRepo = useRetained(openFor);

  // Mark the pause and the resume in the log itself, so a repository whose
  // automations went quiet says why in line. It watches the SAVED setting, not
  // a Settings draft, and lives on this always-mounted host rather than in the
  // General panel — that panel only renders while it is the active one, so a
  // flip saved from another panel would record nothing. The first observation
  // seeds the ref: a mount is not a flip.
  const savedHideAi = useSettings().data?.hideAi;
  const recordedHideAi = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    if (savedHideAi === undefined) return;
    const previous = recordedHideAi.current;
    recordedHideAi.current = savedHideAi;
    if (previous === undefined || previous === savedHideAi) return;
    // Fire-and-forget: a marker that can't be written must never surface as a
    // failure of the settings save that triggered it.
    void recordAutomationPauseMarker(savedHideAi).catch(() => undefined);
  }, [savedHideAi]);

  return (
    <Dialog
      open={openFor !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      {/* Capped flex column: the header stays pinned while the banners, the
          config summary, and the records scroll as one body. */}
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Automation history</DialogTitle>
          <DialogDescription>
            What this repository's automations ran, what they skipped, and why.
          </DialogDescription>
        </DialogHeader>
        {shownRepo !== null && (
          <AutomationHistoryBody
            repoPath={shownRepo}
            open={openFor !== null}
            onClose={close}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AutomationHistoryBody({
  repoPath,
  open,
  onClose,
}: {
  repoPath: string;
  open: boolean;
  onClose: () => void;
}) {
  const aiEnabled = useAiEnabled();
  const queryClient = useQueryClient();
  const reviewTasks = useReviewTasks();
  const openPr = useUiStore((s) => s.openPr);
  const openSettings = useUiStore((s) => s.openSettings);
  const automations = useAutomations();
  // Worktree-stable identity, so a worktree checkout reads the same overrides as
  // its main checkout; the raw path stands in while it resolves.
  const identity = useRepoIdentity(repoPath).data;
  const history = useQuery({
    queryKey: automationHistoryKey(repoPath),
    queryFn: () => listAutomationHistory(repoPath),
    enabled: open,
  });
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // An entry with no id can't be keyed, focused, or arrow-navigated, so it is
  // dropped rather than rendered into a list the keyboard can't address.
  const rows = (history.data ?? []).filter(
    (entry) => typeof entry?.id === "string" && entry.id !== "",
  );

  const config = automations.data;
  const lifecycleRows = LIFECYCLE_EVENTS.map((lifecycle) => ({
    lifecycle,
    actions: config
      ? effectiveActions(
          config,
          repoEntry(config, identity ?? repoPath, repoPath),
          lifecycle,
        )
      : [],
  }));
  const anyEnabled = lifecycleRows.some((l) => l.actions.length > 0);

  const newest = rows[0];
  const newestStamp = newest && stampMs(newest.ts) !== null ? newest.ts : null;

  // Live automation runs in this instance — same discriminator as reviews.ts'
  // imperative `hasLiveAutomationRun` (phase + the automation-only `rerun`); a
  // shared reactive hook is a homed backlog follow-up. Filtered BEFORE the
  // signature so the query key churns only on runs that could match.
  const liveTasks = reviewTasks.filter(
    (t) =>
      (t.phase === "running" || t.phase === "queued") && t.rerun !== undefined,
  );
  const liveSignature = liveTasks
    .map(
      (t) => `${t.target.repoPath}#${t.target.kind}#${t.target.ref}#${t.mode}`,
    )
    .join("|");
  // Matched by worktree-stable IDENTITY, never raw path: linked worktrees of one
  // repo share this history, so a run started in a worktree is live for the main
  // checkout's dialog too. A query because identities resolve over IPC and render
  // can't await one per task; the signature in the key is what keeps it reactive,
  // so a run starting or settling re-resolves the set.
  const liveKeys = useQuery({
    queryKey: [
      "automation-live-targets",
      repoPath,
      identity ?? repoPath,
      liveSignature,
    ],
    queryFn: async () => {
      // Both sides go through the same memoized resolver, so the comparison can
      // never straddle a raw path and an identity.
      const mine = await repoIdentity(repoPath);
      const resolved = await Promise.all(
        liveTasks.map(async (t) => ({
          key: `${t.target.kind}#${t.target.ref}#${t.mode}`,
          identity: await repoIdentity(t.target.repoPath),
        })),
      );
      return resolved.filter((r) => r.identity === mine).map((r) => r.key);
    },
    enabled: open,
  }).data;
  // Set built here, not returned from the query: structural sharing only
  // recurses plain objects and arrays.
  const liveTargets = new Set(liveKeys ?? []);
  // Per OUTCOME, not per row: the outcome's action IS the run's mode, so an
  // interrupted row can't light up because a NEW run for the same pull request
  // is live. A null action (records are untrusted) matches nothing. Accepted
  // residual: the live task carries no headSha, so two same-mode runs on one PR
  // stay indistinguishable — head-granular matching needs the spine to register
  // the head, and that follow-up is backlog-homed.
  const isLive = (entry: AutomationHistoryEntry, action: ActionId | null) =>
    action !== null &&
    liveTargets.has(`${entry.targetKind}#${asText(entry.ref)}#${action}`);

  const onListKeyDown = listKeyboardNav({
    items: rows,
    activeIndex: focusedId ? rows.findIndex((r) => r.id === focusedId) : -1,
    onActivate: (entry) => setFocusedId(entry.id),
    rowKey: (entry) => entry.id,
  });

  const openTarget = (entry: AutomationHistoryEntry) => {
    onClose();
    const kind = entry.targetKind === "remote" ? "remote" : "local";
    // Land under the lens the record was written for. Every automation path is
    // origin-pinned, so a remote row always names an origin pull request, and a
    // fork sitting on the upstream lens would otherwise open upstream's
    // same-numbered one. Session-only (`persist: false`): a click is navigation,
    // not a choice of lens. REMOTE only — a local PR is lens-independent, so
    // applying one there would be a side effect its navigation never implied.
    // No selection clears: the same call selects this PR.
    const applyLens =
      kind === "remote"
        ? () =>
            applyRepoLens(queryClient, repoPath, "origin", {
              clearSelections: false,
              persist: false,
            })
        : undefined;
    openPr({
      kind,
      repoPath,
      repoName: repoPath.split(/[/\\]/).pop() ?? repoPath,
      ref: asText(entry.ref),
      section: null,
      reviewId: null,
      // Run inside openPr's view-transition callback, so the lens and the
      // selection reach the same commit; applied here it would land a render
      // early and fetch the new lens against the OLD number.
      beforeSelect: applyLens,
    });
  };

  return (
    // Full-bleed to the dialog's edges so the banners read as strips and the
    // rows as a list, not as inset cards.
    <div className="-mx-4 -mb-4 min-h-0 flex-1 overflow-x-hidden overflow-y-auto border-t">
      {COLD_START_AUTOMATIONS_OFF && (
        <Banner tone="info">
          Automations are off in cold-start test mode.
        </Banner>
      )}
      {!aiEnabled && (
        <Banner tone="info">
          Automations are paused while AI features are hidden.
        </Banner>
      )}
      {/* The effective config IS the answer to "why did nothing run for that
          event" — stated once here rather than repeated on every absent row. */}
      <div className="border-b px-3 py-2">
        {lifecycleRows.map(({ lifecycle, actions }) => (
          <p
            key={lifecycle}
            className="truncate text-[11px] text-muted-foreground"
            onMouseEnter={clipTitleFromText}
          >
            <span className="font-medium">{LIFECYCLE_LABELS[lifecycle]}:</span>{" "}
            {actions.length === 0
              ? "off"
              : actions.map((a) => ACTION_LABELS[a.action]).join(" + ")}
          </p>
        ))}
      </div>
      {rows.length > 0 && !anyEnabled && (
        <Banner tone="warning">
          No automation is enabled for this repository
          {newestStamp ? (
            <>
              {" — the most recent decision here was recorded "}
              <RelativeTime date={newestStamp} />
              {"."}
            </>
          ) : (
            "."
          )}
        </Banner>
      )}
      {history.isPending ? (
        <ListRowSkeletons rows={4} lines={2} name="automation history" />
      ) : (
        <HistoryList
          rows={rows}
          anyEnabled={anyEnabled}
          isLive={isLive}
          onListKeyDown={onListKeyDown}
          onOpenTarget={openTarget}
          onSetUp={() => {
            onClose();
            openSettings("automations");
          }}
        />
      )}
    </div>
  );
}

function HistoryList({
  rows,
  anyEnabled,
  isLive,
  onListKeyDown,
  onOpenTarget,
  onSetUp,
}: {
  rows: AutomationHistoryEntry[];
  anyEnabled: boolean;
  /** Whether THIS instance holds a running/queued automation run for the row's
   *  target in that outcome's mode. */
  isLive: (entry: AutomationHistoryEntry, action: ActionId | null) => boolean;
  onListKeyDown: (e: KeyboardEvent) => void;
  onOpenTarget: (entry: AutomationHistoryEntry) => void;
  onSetUp: () => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="px-3 pt-4 pb-6 text-center">
        <p className="text-xs font-medium">
          {anyEnabled
            ? "No decisions recorded yet."
            : "No automations are set up for this repository."}
        </p>
        {anyEnabled ? (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Decisions appear here as commits land and pull requests are checked.
          </p>
        ) : (
          <Button
            variant="outline"
            size="xs"
            className="mt-2"
            onClick={onSetUp}
          >
            Set up automations
          </Button>
        )}
      </div>
    );
  }

  return (
    // Roving tabindex: the list takes one tab stop and the arrows walk the rows,
    // so Tab never has to step through fifty records to leave the dialog.
    <div
      // The container is the tab stop, so it carries the name a reader hears on
      // arrival; `group` is the generic role that can hold one.
      role="group"
      tabIndex={0}
      aria-label="Recorded automation decisions"
      className="outline-none"
      onKeyDown={onListKeyDown}
    >
      {rows.map((entry) => (
        <HistoryRow
          key={entry.id}
          entry={entry}
          isLive={isLive}
          onOpenTarget={onOpenTarget}
        />
      ))}
    </div>
  );
}

const ROW_CLASS =
  "flex w-full items-start gap-2 border-b px-3 py-2 text-left outline-none focus-visible:bg-muted";

function HistoryRow({
  entry,
  isLive,
  onOpenTarget,
}: {
  entry: AutomationHistoryEntry;
  isLive: (entry: AutomationHistoryEntry, action: ActionId | null) => boolean;
  onOpenTarget: (entry: AutomationHistoryEntry) => void;
}) {
  const outcomes = Array.isArray(entry.outcomes) ? entry.outcomes : [];
  const Glyph = glyphFor(entry);
  const title =
    TITLE_FOR[entry.targetKind]?.(entry, outcomes) ?? markerTitle(outcomes);
  const count = asCount(entry.count);
  const stamp = stampMs(entry.ts) !== null ? entry.ts : null;
  // Only a pull request has somewhere to go; a commit or marker row would give
  // Enter nothing to do, and a button that no-ops is worse than plain text. A
  // REMOTE ref must be numeric to be addressable — a hand-edited junk ref would
  // navigate to a NaN PR number — while local ids are opaque strings.
  const navigable =
    entry.targetKind === "local"
      ? asText(entry.ref) !== ""
      : entry.targetKind === "remote" && /^\d+$/.test(asText(entry.ref));
  // The catch-up poller latches per (PR, head), so an anomalous outcome there
  // is the end of the line until a push or a relaunch.
  const latched =
    entry.trigger === "catch-up" &&
    outcomes.some((o) => LATCHING_CODES.has(o.code));

  const body = (
    <>
      <Glyph className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span
          className="block truncate text-xs font-medium"
          onMouseEnter={clipTitle(title)}
        >
          {title}
        </span>
        {outcomes.map((outcome, i) => {
          const reason = reasonFor(
            entry,
            outcome,
            isLive(entry, outcome.action),
          );
          return (
            <span
              // Index key: one entry's outcomes are a fixed list that never reorders.
              key={i}
              className="mt-0.5 block truncate text-[11px]"
              onMouseEnter={clipTitleFromText}
            >
              <span className="text-muted-foreground">
                {actionLabel(outcome.action)} ·{" "}
              </span>
              <span className={TONE_CLASS[reason.tone]}>
                {joinCount(reason.text, count, entry.targetKind, outcome.code)}
              </span>
            </span>
          );
        })}
        {latched && (
          <span className="mt-0.5 block text-[11px] text-muted-foreground">
            Won't retry for this head until you push or relaunch.
          </span>
        )}
      </span>
      {/* A stamp only had to be a `string` to survive JSON, so an unparseable
          one drops its cell rather than rendering "in NaN years". */}
      {stamp && (
        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
          <RelativeTime date={stamp} />
        </span>
      )}
    </>
  );

  if (navigable) {
    return (
      <button
        type="button"
        data-row={entry.id}
        tabIndex={-1}
        onClick={() => onOpenTarget(entry)}
        className={cn(ROW_CLASS, "hover:bg-muted/60")}
      >
        {body}
      </button>
    );
  }
  return (
    <div data-row={entry.id} tabIndex={-1} className={ROW_CLASS}>
      {body}
    </div>
  );
}
