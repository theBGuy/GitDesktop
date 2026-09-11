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
import { useQuery } from "@tanstack/react-query";
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
  SESSION_START_MS,
  STEADY_OUTCOME_CODES,
} from "@/lib/automations/history";
import { useAutomations } from "@/lib/automations/queries";
import {
  ACTION_LABELS,
  type ActionId,
  effectiveActions,
  LIFECYCLE_LABELS,
  type LifecycleEvent,
  repoEntry,
} from "@/lib/automations/types";
import { clipTitle, clipTitleFromText } from "@/lib/clip-title";
import { useRepoIdentity } from "@/lib/git/queries";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { useAiEnabled, useSettings } from "@/lib/settings/queries";
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
 * later can't render as silence. `delivered` and `started` read the entry — one
 * varies with where the output went, the other with whether the run belongs to
 * this session or to one the app closed on.
 */
const OUTCOME_REASON: Record<
  AutomationOutcomeCode,
  (entry: AutomationHistoryEntry, outcome: Outcome) => ReasonLine
> = {
  delivered: (entry) => ({
    text: DELIVERED_TEXT[entry.targetKind] ?? "Delivered",
    tone: "success",
  }),
  started: (entry) =>
    (stampMs(entry.ts) ?? 0) >= SESSION_START_MS
      ? { text: "Running — watch it in Activity", tone: "info" }
      : {
          text: "Interrupted — the app closed while this was running",
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
    text: outcome.detail || "Skipped — opened more than 14 days ago",
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
  "eligibility-error": () => ({
    text: "Couldn't read review history — treated as already reviewed",
    tone: "warning",
  }),
  failed: (_entry, outcome) => ({
    text: outcome.detail ? `Failed — ${outcome.detail}` : "Failed",
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

const LIFECYCLES: LifecycleEvent[] = ["commit", "pr-open", "pr-sync"];

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
    const ref = asText(entry.ref);
    return title ? `${ref} · ${title}` : ref;
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
  const lifecycleRows = LIFECYCLES.map((lifecycle) => ({
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

  const onListKeyDown = listKeyboardNav({
    items: rows,
    activeIndex: focusedId ? rows.findIndex((r) => r.id === focusedId) : -1,
    onActivate: (entry) => setFocusedId(entry.id),
    rowKey: (entry) => entry.id,
  });

  const openTarget = (entry: AutomationHistoryEntry) => {
    onClose();
    openPr({
      kind: entry.targetKind === "remote" ? "remote" : "local",
      repoPath,
      repoName: repoPath.split(/[/\\]/).pop() ?? repoPath,
      ref: asText(entry.ref),
      section: null,
      reviewId: null,
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
  onListKeyDown,
  onOpenTarget,
  onSetUp,
}: {
  rows: AutomationHistoryEntry[];
  anyEnabled: boolean;
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
        <HistoryRow key={entry.id} entry={entry} onOpenTarget={onOpenTarget} />
      ))}
    </div>
  );
}

const ROW_CLASS =
  "flex w-full items-start gap-2 border-b px-3 py-2 text-left outline-none focus-visible:bg-muted";

function HistoryRow({
  entry,
  onOpenTarget,
}: {
  entry: AutomationHistoryEntry;
  onOpenTarget: (entry: AutomationHistoryEntry) => void;
}) {
  const outcomes = Array.isArray(entry.outcomes) ? entry.outcomes : [];
  // Target kind first, then trigger: a pause marker is stored with the
  // user-initiated trigger, and a Play glyph would claim a run that never was.
  const Glyph =
    entry.targetKind === "none"
      ? LightningIcon
      : (TRIGGER_GLYPH[entry.trigger] ?? LightningIcon);
  const title =
    TITLE_FOR[entry.targetKind]?.(entry, outcomes) ?? markerTitle(outcomes);
  const count = asCount(entry.count);
  const stamp = stampMs(entry.ts) !== null ? entry.ts : null;
  // Only a pull request has somewhere to go; a commit or marker row would give
  // Enter nothing to do, and a button that no-ops is worse than plain text.
  const navigable =
    (entry.targetKind === "remote" || entry.targetKind === "local") &&
    asText(entry.ref) !== "";
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
          const reason =
            OUTCOME_REASON[outcome.code]?.(entry, outcome) ?? UNKNOWN_REASON;
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
