import {
  BellIcon,
  CaretUpIcon,
  ChatCircleIcon,
  CheckCircleIcon,
  EyeIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  ShieldCheckIcon,
  SparkleIcon,
  WarningCircleIcon,
  XCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { ElapsedTime } from "@/components/elapsed-time";
import { ForgeUserAvatar } from "@/components/forge-user-avatar";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { displayLogin } from "@/lib/git/bot-login";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import {
  type AppNotification,
  clearAllNotifications,
  clearNotification,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationTone,
  useNotifications,
  useUnreadCount,
} from "@/lib/stores/notifications";
import {
  cancelReview,
  type ReviewTask,
  resetReview,
  useReviewTasks,
} from "@/lib/stores/reviews";
import { useUiStore } from "@/lib/stores/ui";
import { formatDuration } from "@/lib/time";
import { cn } from "@/lib/utils";

/**
 * The header **Activity & Notifications** control — one stable, always-present
 * anchor (a bell that never vanishes, so a finished review is never a missed
 * click). Its popover has two zones:
 *
 * - **In progress** — live review runs (running / queued) with Cancel. Ephemeral;
 *   a run that finishes leaves this zone and lands in Notifications.
 * - **Notifications** — a persistent, restart-surviving history of terminal
 *   events (review done, checks, PR approvals/comments, CI runs, agent sessions).
 *   Each row click-navigates to its source; unread rows carry a mint dot.
 *
 * {@link ActivityStrip} is the same control for the header-less screens (welcome
 * / settings / help), living in a thin bottom bar so a finished run stays
 * reachable there too.
 */
export function ActivityDock() {
  return <ActivityBell variant="header" />;
}

export function ActivityStrip() {
  const view = useUiStore((s) => s.view);
  const activityOpen = useUiStore((s) => s.activityOpen);
  const tasks = useReviewTasks();
  const notifs = useNotifications();
  // The header dock already covers the repo view; the strip only fills in for
  // the header-less screens — when there's something to reach, OR when the
  // palette / hotkey opened the popover (so the bell + its empty state are
  // reachable even with an empty inbox on the welcome/settings/help screens).
  if (view === "repo") return null;
  const live = liveTasks(tasks);
  const stopped = stoppedTasks(tasks);
  if (
    live.length === 0 &&
    stopped.length === 0 &&
    notifs.length === 0 &&
    !activityOpen
  ) {
    return null;
  }
  return (
    <div className="flex h-7 shrink-0 items-center border-t bg-background px-1.5">
      <ActivityBell variant="strip" />
    </div>
  );
}

function liveTasks(tasks: ReviewTask[]): ReviewTask[] {
  return tasks.filter((t) => t.phase === "running" || t.phase === "queued");
}

/** Stopped automation runs — cancelled or failed rows that carry a `rerun`. The
 *  `rerun` presence is the discriminator: a manual panel run also reaches
 *  "cancelled"/"error" but never carries one, so it's kept out of the dock. */
function stoppedTasks(tasks: ReviewTask[]): ReviewTask[] {
  return tasks.filter(
    (t) => (t.phase === "cancelled" || t.phase === "error") && t.rerun,
  );
}

function ActivityBell({ variant }: { variant: "header" | "strip" }) {
  const tasks = useReviewTasks();
  const unread = useUnreadCount();
  // Open state lives in the UI store so the command palette / a hotkey can
  // toggle it (only one mount — header or strip — is on screen at a time).
  const open = useUiStore((s) => s.activityOpen);
  const setOpen = useUiStore((s) => s.setActivityOpen);
  const live = liveTasks(tasks).length;
  const stopped = stoppedTasks(tasks).length;

  const label = `Activity & notifications${
    unread > 0 ? ` · ${unread} unread` : ""
  }${live > 0 ? ` · ${live} in progress` : ""}${
    stopped > 0 ? ` · ${stopped} stopped` : ""
  }`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="inline-flex h-7 items-center gap-1 rounded-none px-1.5 text-xs text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 aria-expanded:bg-muted aria-expanded:text-foreground"
        aria-label={`${label}. Open the list.`}
        title={label}
      >
        {live > 0 ? (
          <Spinner className="size-4" />
        ) : (
          <BellIcon
            className="size-4"
            weight={unread > 0 ? "fill" : "regular"}
          />
        )}
        {unread > 0 && (
          <span className="min-w-4 rounded-full bg-primary px-1 text-center text-[10px] font-semibold text-primary-foreground leading-4 tabular-nums">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
        {variant === "strip" && <CaretUpIcon className="size-3" />}
      </PopoverTrigger>
      <PopoverContent
        side={variant === "header" ? "bottom" : "top"}
        align={variant === "header" ? "end" : "start"}
        sideOffset={6}
        className="w-96 gap-0 p-0"
      >
        <ActivityPanel onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

function ActivityPanel({ onClose }: { onClose: () => void }) {
  const tasks = useReviewTasks();
  const notifs = useNotifications();
  const repoPath = useUiStore((s) => s.repoPath);
  const openPrReview = useUiStore((s) => s.openPrReview);
  const openRun = useUiStore((s) => s.openRun);
  const openAgentTab = useUiStore((s) => s.openAgentTab);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const live = liveTasks(tasks);
  const stopped = stoppedTasks(tasks);
  // Queue position per lane (local + cloud run independently), FIFO by seq.
  const queuePos = new Map<string, number>();
  for (const isLocal of [true, false]) {
    live
      .filter((t) => t.phase === "queued" && t.local === isLocal)
      .sort((a, b) => a.seq - b.seq)
      .forEach((t, i) => queuePos.set(t.key, i + 1));
  }

  const navigate = (n: AppNotification) => {
    markNotificationRead(n.id);
    const t = n.target;
    if (t?.type === "pr") {
      openPrReview({
        kind: t.kind,
        repoPath: n.repoPath,
        repoName: n.repoName,
        ref: t.ref,
      });
    } else if (t?.type === "run") {
      openRun({ repoPath: n.repoPath, repoName: n.repoName, runId: t.runId });
    } else if (t?.type === "agent") {
      openAgentTab({ repoPath: n.repoPath, repoName: n.repoName });
    }
    onClose();
  };

  // Keyboard delete: focus the neighbour that takes this row's place (next, else
  // previous) so arrow-key flow survives a delete instead of dropping to <body>.
  const handleDelete = (id: string) => {
    const idx = notifs.findIndex((n) => n.id === id);
    const nextId = notifs[idx + 1]?.id ?? notifs[idx - 1]?.id ?? null;
    clearNotification(id);
    setFocusedId(nextId);
    if (nextId) {
      requestAnimationFrame(() => {
        listRef.current
          ?.querySelector<HTMLElement>(`[data-row="${CSS.escape(nextId)}"]`)
          ?.focus();
      });
    }
  };

  const onListKeyDown = listKeyboardNav({
    items: notifs,
    activeIndex: focusedId ? notifs.findIndex((n) => n.id === focusedId) : -1,
    onActivate: (n) => setFocusedId(n.id),
    rowKey: (n) => n.id,
  });

  return (
    <>
      {live.length > 0 && (
        <div className="border-b">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-xs font-medium">In progress</span>
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {live.length}
            </span>
          </div>
          <div className="max-h-44 overflow-y-auto">
            {live.map((task) => (
              <LiveTaskRow
                key={task.key}
                task={task}
                crossRepo={task.target.repoPath !== repoPath}
                queuePosition={
                  task.phase === "queued" ? (queuePos.get(task.key) ?? 0) : 0
                }
              />
            ))}
          </div>
        </div>
      )}

      {stopped.length > 0 && (
        <div className="border-b">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-xs font-medium">Stopped</span>
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {stopped.length}
            </span>
          </div>
          <div className="max-h-44 overflow-y-auto">
            {stopped.map((task) => (
              <StoppedTaskRow
                key={task.key}
                task={task}
                crossRepo={task.target.repoPath !== repoPath}
              />
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-medium">Notifications</span>
        {notifs.length > 0 && (
          <div className="-mr-1 flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => markAllNotificationsRead()}
            >
              Mark all read
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => clearAllNotifications()}
            >
              Clear all
            </Button>
          </div>
        )}
      </div>

      {notifs.length === 0 ? (
        <div className="px-3 pt-1 pb-6 text-center">
          <p className="text-xs font-medium">You're all caught up</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Finished reviews, PR activity, checks, and completed runs show up
            here so you never miss one.
          </p>
        </div>
      ) : (
        <div
          ref={listRef}
          className="max-h-80 overflow-y-auto outline-none"
          onKeyDown={onListKeyDown}
        >
          {notifs.map((n) => (
            <NotificationRow
              key={n.id}
              n={n}
              onNavigate={() => navigate(n)}
              onDelete={() => handleDelete(n.id)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function LiveTaskRow({
  task,
  crossRepo,
  queuePosition,
}: {
  task: ReviewTask;
  crossRepo: boolean;
  /** 1-based place in the run queue when queued, else 0. */
  queuePosition: number;
}) {
  const ModeIcon = task.mode === "security" ? ShieldCheckIcon : SparkleIcon;
  const modeName = task.mode === "security" ? "Security audit" : "Review";
  const stateWord =
    task.phase === "queued"
      ? queuePosition <= 1
        ? "Queued · next"
        : `Queued · #${queuePosition}`
      : task.status.trim() || "Running…";

  return (
    <div className="flex items-start gap-2 px-3 py-2 not-last:border-b">
      <ModeIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium" title={task.title}>
          {task.title || "Pull request"}
        </p>
        <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1 truncate">
            <Spinner className="size-3 shrink-0" />
            <span className="truncate">
              {modeName} · {stateWord}
              {crossRepo ? ` · ${task.target.repoName}` : ""}
            </span>
          </span>
          {task.phase === "running" && task.startedAt && (
            <ElapsedTime since={task.startedAt} className="ml-auto shrink-0" />
          )}
        </p>
      </div>
      <Button
        variant="ghost"
        size="xs"
        className="shrink-0"
        onClick={() => cancelReview(task.key)}
      >
        Cancel
      </Button>
    </div>
  );
}

/** A cancelled/failed automation run, kept in the dock (unlike a live row) with
 *  Re-run + Dismiss. Failed rows carry the error in the subtitle's tooltip and
 *  render "Failed" in the destructive token (word + color, never color alone).
 *
 *  Re-run just fires `task.rerun()` — it does NOT remove the row here. The row is
 *  removed inside the runner only once the replacement run actually registers, so
 *  a re-run that can't start (rule disabled since, or a claim or already-covered
 *  head still held by the canceled run unwinding) leaves the row in place as a
 *  retry target and toasts why. Dismiss removes the row outright. */
function StoppedTaskRow({
  task,
  crossRepo,
}: {
  task: ReviewTask;
  crossRepo: boolean;
}) {
  const ModeIcon = task.mode === "security" ? ShieldCheckIcon : SparkleIcon;
  const modeName = task.mode === "security" ? "Security audit" : "Review";
  const failed = task.phase === "error";
  const title = task.title || "Pull request";
  // Static "ran for X" — only when both stamps exist and are ordered (a run
  // cancelled while queued never entered "running", so it carries no start).
  const ranFor =
    task.startedAt && task.endedAt && task.endedAt > task.startedAt
      ? formatDuration(task.endedAt - task.startedAt)
      : null;

  return (
    <div className="flex items-start gap-2 px-3 py-2 not-last:border-b">
      <ModeIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium" title={task.title}>
          {title}
        </p>
        <p
          className="mt-0.5 truncate text-[11px] text-muted-foreground"
          title={failed ? task.error : undefined}
        >
          {modeName} ·{" "}
          {failed ? (
            <span className="text-destructive">Failed</span>
          ) : (
            "Cancelled"
          )}
          {ranFor ? ` · ran ${ranFor}` : ""}
          {crossRepo ? ` · ${task.target.repoName}` : ""}
        </p>
      </div>
      <Button
        variant="ghost"
        size="xs"
        className="shrink-0"
        aria-label={`Re-run ${title}`}
        onClick={() => task.rerun?.()}
      >
        Re-run
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        className="shrink-0 self-start text-muted-foreground"
        aria-label={`Dismiss "${title}"`}
        onClick={() => resetReview(task.key)}
      >
        <XIcon />
      </Button>
    </div>
  );
}

function NotificationRow({
  n,
  onNavigate,
  onDelete,
}: {
  n: AppNotification;
  onNavigate: () => void;
  /** Keyboard delete — restores focus to a neighbour (unlike the mouse clear). */
  onDelete: () => void;
}) {
  const Glyph = glyphFor(n);

  return (
    <div className="flex items-stretch not-last:border-b hover:bg-muted/60">
      <button
        type="button"
        data-row={n.id}
        onClick={onNavigate}
        onKeyDown={(e) => {
          if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            onDelete();
          }
        }}
        className="flex min-w-0 flex-1 items-start gap-2 px-3 py-2 text-left outline-none focus-visible:bg-muted"
      >
        <span className="relative mt-0.5 shrink-0">
          <Glyph className={cn("size-4", TONE_CLASS[n.tone])} weight="fill" />
          {!n.read && (
            <span
              aria-hidden
              className="absolute -top-1 -left-1 size-1.5 rounded-full bg-primary ring-2 ring-popover"
            />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-xs",
              n.read ? "font-normal text-muted-foreground" : "font-medium",
            )}
            title={n.title}
          >
            {n.title}
          </span>
          {n.subtitle && (
            <span
              className="mt-0.5 block truncate text-[11px] text-muted-foreground"
              title={n.subtitle}
            >
              {n.subtitle}
            </span>
          )}
          {/* Meta line: repo (always) · author (when known). The inbox is global,
              so the repo name orients rows from any repo; the author renders with a
              small bot-aware avatar. */}
          <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
            {/* min-w-0 defeats flex's default min-width:auto so truncate engages;
                repoName (flex-1) shrinks first, the author name keeps a capped
                share so both stay visible when the row is tight. `title` keeps a
                clipped value readable on hover. */}
            <span className="min-w-0 flex-1 truncate" title={n.repoName}>
              {n.repoName}
            </span>
            {n.authorLogin && (
              <>
                <span aria-hidden>·</span>
                <ForgeUserAvatar
                  login={n.authorLogin}
                  avatarUrl={n.authorAvatarUrl}
                  ghHost={n.authorGhHost}
                  size="sm"
                  className="size-4"
                  decorative
                />
                <span
                  className="min-w-0 max-w-[45%] shrink-0 truncate"
                  title={displayLogin(n.authorLogin)}
                >
                  {displayLogin(n.authorLogin)}
                </span>
              </>
            )}
          </span>
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
          <RelativeTime date={new Date(n.ts).toISOString()} />
        </span>
      </button>
      {n.action && (
        <Button
          variant="ghost"
          size="xs"
          className="my-1.5 shrink-0 self-start"
          // Self-contained: a row is ambiguous by its action label alone.
          aria-label={`${n.action.label} — ${n.title}`}
          onClick={() => {
            // Mark read (it's now acted on) then fire — but keep the popover open
            // and the row in place: the fresh run registers an "In progress" row in
            // this same panel (that's the feedback), and the notification is history.
            markNotificationRead(n.id);
            n.action?.run();
          }}
        >
          {n.action.label}
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        className="mt-0 my-1.5 mr-1 shrink-0 self-start text-muted-foreground"
        aria-label={`Clear "${n.title}"`}
        onClick={() => clearNotification(n.id)}
      >
        <XIcon />
      </Button>
    </div>
  );
}

/** Tone → semantic token; paired with the descriptive title so state never
 *  rides on color alone (WCAG AA). */
const TONE_CLASS: Record<NotificationTone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
  info: "text-info",
  merged: "text-merged",
  neutral: "text-muted-foreground",
};

/** Glyph per event kind; kinds not listed fall back to a tone-appropriate mark
 *  (e.g. `ci-run`, whose success/failure lives in the tone). */
const KIND_GLYPH: Record<string, typeof CheckCircleIcon> = {
  "review-ready": SparkleIcon,
  "review-failed": SparkleIcon,
  "checks-passed": CheckCircleIcon,
  "checks-failed": XCircleIcon,
  "pr-opened": GitPullRequestIcon,
  "pr-merged": GitMergeIcon,
  "pr-closed": GitPullRequestIcon,
  "pr-approved": CheckCircleIcon,
  "pr-changes-requested": WarningCircleIcon,
  "pr-comment": ChatCircleIcon,
  "pr-review": ChatCircleIcon,
  "review-requested": EyeIcon,
  "agent-done": SparkleIcon,
  "research-done": MagnifyingGlassIcon,
  "plan-done": ListChecksIcon,
};

function glyphFor(n: AppNotification): typeof CheckCircleIcon {
  return (
    KIND_GLYPH[n.kind] ??
    (n.tone === "danger"
      ? XCircleIcon
      : n.tone === "warning"
        ? WarningCircleIcon
        : CheckCircleIcon)
  );
}
