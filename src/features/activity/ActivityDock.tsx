import {
  BellIcon,
  CaretRightIcon,
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
import { useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";
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
import { useAutomationHistoryDialog } from "@/features/automations/AutomationHistoryDialog";
import { openAutomationResult } from "@/lib/automations/results";
import { validateRepo } from "@/lib/git/api";
import { displayLogin } from "@/lib/git/bot-login";
import { normPath } from "@/lib/git/path";
import { repoIdentity } from "@/lib/git/repo-identity";
import type { RemoteLens } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import type { PrSection } from "@/lib/pulls/pr-section";
import { applyRepoLens } from "@/lib/repo-lens/queries";
import { loadSettings } from "@/lib/settings/api";
import { useAiEnabled } from "@/lib/settings/queries";
import {
  AI_NOTIFICATION_KINDS,
  type AppNotification,
  clearAllNotifications,
  clearNotification,
  clearNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  markNotificationsRead,
  type NotificationKind,
  type NotificationTone,
  useNotifications,
} from "@/lib/stores/notifications";
import {
  cancelReview,
  type ReviewTask,
  resetReview,
  useReviewTasks,
} from "@/lib/stores/reviews";
import { isRepoTab, useUiStore } from "@/lib/stores/ui";
import { formatDuration, validEpochMs } from "@/lib/time";
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
  const aiEnabled = useAiEnabled();
  // The header dock already covers the repo view; the strip only fills in for
  // the header-less screens — when there's something to reach, OR when the
  // palette / hotkey opened the popover (so the bell + its empty state are
  // reachable even with an empty inbox on the welcome/settings/help screens).
  if (view === "repo") return null;
  const live = liveTasks(tasks);
  const stopped = stoppedTasks(tasks, aiEnabled);
  const visible = visibleNotifications(notifs, aiEnabled);
  if (
    live.length === 0 &&
    stopped.length === 0 &&
    visible.length === 0 &&
    !activityOpen
  ) {
    return null;
  }
  return (
    // box-content: the trigger inside is h-7 too, so border-box would leave a
    // 27px content box and hang the child 0.5px past the viewport — the last
    // element in the h-screen column, so the document grows a window scrollbar.
    <div className="box-content flex h-7 shrink-0 items-center border-t bg-background px-1.5">
      <ActivityBell variant="strip" />
    </div>
  );
}

function liveTasks(tasks: ReviewTask[]): ReviewTask[] {
  return tasks.filter((t) => t.phase === "running" || t.phase === "queued");
}

/** Stopped automation runs — cancelled or failed rows that carry a `rerun`. The
 *  `rerun` presence is the discriminator: a manual panel run also reaches
 *  "cancelled"/"error" but never carries one, so it's kept out of the dock.
 *
 *  Every row here is an AI automation review by construction, so hiding AI
 *  features empties the zone outright. Live rows are NOT filtered — they hold the
 *  only Cancel an in-flight automation run has, so they stay until they settle. */
function stoppedTasks(tasks: ReviewTask[], aiEnabled: boolean): ReviewTask[] {
  if (!aiEnabled) return [];
  return tasks.filter(
    (t) => (t.phase === "cancelled" || t.phase === "error") && t.rerun,
  );
}

/** The inbox rows this dock shows. Hiding AI features drops AI-minted kinds from
 *  the render only — the records keep accruing, so the history is intact when AI
 *  is shown again. A kind the set doesn't name renders (hydrated rows from an
 *  older build are untrusted, and a forge event must never be mistaken for AI). */
function visibleNotifications(
  notifs: AppNotification[],
  aiEnabled: boolean,
): AppNotification[] {
  if (aiEnabled) return notifs;
  return notifs.filter((n) => !AI_NOTIFICATION_KINDS.has(n.kind));
}

function ActivityBell({ variant }: { variant: "header" | "strip" }) {
  const tasks = useReviewTasks();
  const notifs = useNotifications();
  const aiEnabled = useAiEnabled();
  // Open state lives in the UI store so the command palette / a hotkey can
  // toggle it (only one mount — header or strip — is on screen at a time).
  const open = useUiStore((s) => s.activityOpen);
  const setOpen = useUiStore((s) => s.setActivityOpen);
  // The badge counts what the panel will actually show: a hidden AI row must not
  // send the user to an inbox where the unread it promised isn't there.
  const unread = visibleNotifications(notifs, aiEnabled).reduce(
    (n, i) => (i.read ? n : n + 1),
    0,
  );
  const live = liveTasks(tasks).length;
  const stopped = stoppedTasks(tasks, aiEnabled).length;

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

/** Click generation. Module-scoped because the panel unmounts as the click closes
 *  the popover: against a component ref, a continuation from a previous mount
 *  would compare with a fresh counter, pass its own check, and navigate the app by
 *  itself. Read only from handlers and continuations, never in render. */
let clickGen = 0;

/** A live checkout a notification can be opened in. */
interface LiveTarget {
  repoPath: string;
  repoName: string;
}

/** How far down the repo list the last rung looks. The scan is serial git work
 *  behind an already-closed popover, so a match further back than this would read
 *  as a dead click. */
const MAX_RECENTS_SCANNED = 10;

/** Split a path's parent off, or null when it has none — the identity key is the
 *  repo's common git dir, so its parent is the main working tree. */
function parentDir(p: string): string | null {
  const cut = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return cut > 0 ? p.slice(0, cut) : null;
}

/** Whether a live checkout is the repository `stamp` names. Three-valued because
 *  `repoIdentity` answers from memory or with a path stand-in rather than
 *  rejecting, so that equality is UNKNOWN, never a mismatch. Resolve only paths
 *  `validateRepo` has proven live: a dead one's answer is not a fresh fact.
 *  Casefolded `normPath` and the resolver's shared bounded memo are both the
 *  app-wide identity idiom — diverging from either navigates by an identity no
 *  store keys on. */
async function identityVerdict(
  repoPath: string,
  stamp: string,
): Promise<"match" | "mismatch" | "unknown"> {
  const id = await repoIdentity(repoPath);
  if (normPath(id) === normPath(repoPath)) return "unknown";
  return normPath(id) === normPath(stamp) ? "match" : "mismatch";
}

/**
 * Resolve a live checkout for `n`. Its `repoPath` is the checkout captured at emit
 * time, so a worktree removed since turns every row from it into a dangling
 * pointer — following it opens the app in a directory that no longer exists.
 * `repoId` (the worktree-stable identity key) is what survives that, so the ladder
 * tries: the captured path, the repo on screen, the main checkout, then the repo
 * list. Answers null when nothing live matches, which the caller reports instead
 * of navigating — a refusal performs no git work and writes no state.
 *
 * `superseded` is consulted after every await: a later click must not have its
 * navigation stomped by an earlier one settling. Every comparison goes through
 * `normPath` — the keys are forward-slashed as git prints them while the ui store
 * holds `validate_repo`'s backslashed spelling, and Windows compares paths
 * case-insensitively.
 */
async function resolveLiveTarget(
  n: AppNotification,
  superseded: () => boolean,
): Promise<LiveTarget | null> {
  // Hydrated rows are untrusted, so narrow at use; a row from before the field
  // existed carries none and can only take the captured path or be refused.
  const stamp = typeof n.repoId === "string" ? n.repoId : undefined;
  const captured = await validateRepo(n.repoPath).catch(() => null);
  if (superseded()) return null;
  if (captured) {
    if (stamp === undefined) {
      return { repoPath: captured.root, repoName: captured.name };
    }
    // Belt check: a folder recreated at the same path (or an enclosing repo the
    // walk-up found) is a DIFFERENT repository, so a mismatch falls into the
    // ladder rather than opening someone else's pull request. An unknown identity
    // stands: this checkout is live, and it is the one the event named.
    const verdict = await identityVerdict(captured.root, stamp);
    if (superseded()) return null;
    if (verdict !== "mismatch") {
      return { repoPath: captured.root, repoName: captured.name };
    }
  }
  if (stamp === undefined) return null;

  // The repo on screen, retargeted in place: passing the ui store's own spelling
  // keeps the navigators' repo compare equal, so no CROSS_REPO_RESET fires and
  // the user's other selections survive. Validated first — it may ITSELF be the
  // deleted worktree, and the resolver must only ever see a live path.
  const cur = useUiStore.getState().repoPath;
  if (cur) {
    const info = await validateRepo(cur).catch(() => null);
    if (superseded()) return null;
    if (info) {
      const verdict = await identityVerdict(cur, stamp);
      if (superseded()) return null;
      if (verdict === "match") {
        return {
          repoPath: cur,
          repoName: useUiStore.getState().repoName ?? info.name,
        };
      }
    }
  }

  // The main checkout, whose working tree is the identity key's parent. Navigate
  // with the RETURNED root, never the raw parent: identity keys are
  // forward-slashed while the ui store holds the backslashed spelling, and a
  // mismatched target reads as a repo switch — firing a CROSS_REPO_RESET and
  // re-keying every path-keyed derivative. Proven like any other candidate, since
  // `validate_repo` walks UPWARD and can answer an enclosing repo.
  const main = parentDir(stamp);
  if (main) {
    const info = await validateRepo(main).catch(() => null);
    if (superseded()) return null;
    if (info) {
      const verdict = await identityVerdict(info.root, stamp);
      if (superseded()) return null;
      if (verdict === "match") {
        return { repoPath: info.root, repoName: info.name };
      }
    }
  }

  // Any other clone in the repo list, most recent first.
  const recents = await loadSettings()
    .then((s) => s.recentRepos.slice(0, MAX_RECENTS_SCANNED))
    .catch(() => []);
  if (superseded()) return null;
  for (const entry of recents) {
    const info = await validateRepo(entry.path).catch(() => null);
    if (superseded()) return null;
    if (!info) continue;
    const verdict = await identityVerdict(info.root, stamp);
    if (superseded()) return null;
    if (verdict === "match") {
      return { repoPath: info.root, repoName: info.name };
    }
  }
  return null;
}

function ActivityPanel({ onClose }: { onClose: () => void }) {
  const tasks = useReviewTasks();
  const notifs = useNotifications();
  const repoPath = useUiStore((s) => s.repoPath);
  const queryClient = useQueryClient();
  const openPr = useUiStore((s) => s.openPr);
  const openRun = useUiStore((s) => s.openRun);
  const openAgentTab = useUiStore((s) => s.openAgentTab);
  const openRepoView = useUiStore((s) => s.openRepoView);
  const openHistory = useAutomationHistoryDialog((s) => s.open);
  const aiEnabled = useAiEnabled();
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const live = liveTasks(tasks);
  const stopped = stoppedTasks(tasks, aiEnabled);
  const visible = visibleNotifications(notifs, aiEnabled);
  // Queue position per lane (local + cloud run independently), FIFO by seq.
  const queuePos = new Map<string, number>();
  for (const isLocal of [true, false]) {
    live
      .filter((t) => t.phase === "queued" && t.local === isLocal)
      .sort((a, b) => a.seq - b.seq)
      .forEach((t, i) => queuePos.set(t.key, i + 1));
  }

  const navigate = (n: AppNotification) => {
    const t = n.target;
    // Claimed before the first await AND before every early return, so each click
    // supersedes a pending one. The store's `interactionEpoch` is the other half of
    // the guard: every user navigation or selection action bumps it, so a settled
    // continuation strands instead of yanking the user off a newer choice of theirs.
    // The navigators bump only AFTER the final check below, so this click's own
    // landing can't strand itself — a popover click that goes on to navigate is one
    // user action, counted once.
    const gen = ++clickGen;
    const startEpoch = useUiStore.getState().interactionEpoch;
    const superseded = () =>
      gen !== clickGen || useUiStore.getState().interactionEpoch !== startEpoch;
    // Synchronous, ahead of the awaits: the popover closes on the click itself,
    // never a resolution later.
    onClose();
    if (t?.type === "automation-result") {
      if (typeof t.id === "string") {
        markNotificationRead(n.id);
        // The stamped identity is the store key the result was written under, so
        // a result stays readable after its checkout is gone.
        void openAutomationResult(
          n.repoPath,
          t.id,
          typeof n.repoId === "string" ? n.repoId : undefined,
        );
      }
      return;
    }
    if (
      t?.type !== "pr" &&
      t?.type !== "run" &&
      t?.type !== "agent" &&
      t?.type !== "repo"
    ) {
      // Nowhere to navigate (no target, or a kind this build doesn't route) —
      // the click is still an acknowledgement, as it has always been.
      markNotificationRead(n.id);
      return;
    }
    void (async () => {
      const target = await resolveLiveTarget(n, superseded);
      if (superseded()) return;
      if (!target) {
        // Unread by design: the row is the retry affordance once the user has a
        // checkout of that repo open again.
        toast.info(
          `The checkout for ${n.repoName} no longer exists, and no other copy was found — nothing was opened.`,
        );
        return;
      }
      markNotificationRead(n.id);
      // The check above covers SCHEDULING this landing; `stillValid` re-checks at
      // the deferred apply — generation for a later notification click, epoch for
      // any OTHER user action in that window. The epoch is comparable only because
      // the navigator hands back the value its own synchronous bump produced; this
      // landing's beforeSelect bumps too, but runs after the check.
      const stillValid = (epochAtRequest: number) =>
        gen === clickGen &&
        useUiStore.getState().interactionEpoch === epochAtRequest;
      if (t.type === "run") {
        openRun({ ...target, runId: t.runId, stillValid });
        return;
      }
      if (t.type === "agent") {
        openAgentTab({ ...target, stillValid });
        return;
      }
      if (t.type === "repo") {
        openRepoView({
          ...target,
          tab: isRepoTab(t.tab) ? t.tab : undefined,
          stillValid,
        });
        return;
      }
      // Land under the lens the event happened under — a fork's two lenses
      // surface different pull requests at the same ref. Session-only
      // (`persist: false`): a click is navigation, not a choice of lens, so the
      // switcher's stored preference is what later sessions still open on.
      // Only for REMOTE rows — a local PR is lens-independent, so applying one
      // there would be a side effect its navigation never implied. Hydrated
      // rows are untrusted, so narrow the stored value the way the lens reader
      // does; a row from before the field existed carries none and keeps
      // today's behavior (whichever lens the repo already sits on). Keyed on the
      // RESOLVED checkout — the lens cache is per checkout path, so writing it
      // under the captured one is a key nothing reads; every rung of the ladder
      // shares this repo's common git dir, so the lens stays meaningful.
      let applyLens: (() => void) | undefined;
      if (t.kind === "remote" && t.lens !== undefined) {
        const lens: RemoteLens = t.lens === "upstream" ? "upstream" : "origin";
        applyLens = () =>
          applyRepoLens(queryClient, target.repoPath, lens, {
            // A sibling selection minted under the other lens would outlive the
            // flip; openPr's own set lands this PR in the same commit.
            clearSelections: true,
            persist: false,
          });
      }
      openPr({
        ...target,
        kind: t.kind,
        ref: t.ref,
        section: KIND_SECTION[n.kind as NotificationKind] ?? null,
        // Hydrated rows are untrusted here too — a non-string can't address a
        // review card, so it reads as "no reveal" rather than travelling on.
        reviewId: typeof t.reviewId === "string" ? t.reviewId : null,
        // Run inside openPr's view-transition callback, so the lens and the
        // selection reach the same commit; applied here it would land a render
        // early and fetch the new lens against the OLD number.
        beforeSelect: applyLens,
        stillValid,
      });
    })().catch(() => {
      // best-effort — an unexpected throw degrades the click to a no-op
    });
  };

  // Keyboard delete: focus the neighbour that takes this row's place (next, else
  // previous) so arrow-key flow survives a delete instead of dropping to <body>.
  const handleDelete = (id: string) => {
    const idx = visible.findIndex((n) => n.id === id);
    const nextId = visible[idx + 1]?.id ?? visible[idx - 1]?.id ?? null;
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
    items: visible,
    activeIndex: focusedId ? visible.findIndex((n) => n.id === focusedId) : -1,
    onActivate: (n) => setFocusedId(n.id),
    rowKey: (n) => n.id,
  });

  // Bulk actions reach only what's on screen: while AI rows are hidden they run
  // id-scoped, so pressing Clear all can't wipe history the user can't see. With
  // nothing filtered out the blanket store actions stay, which also catch a row
  // that arrived between this render and the click.
  const markAllVisibleRead = () => {
    if (aiEnabled) markAllNotificationsRead();
    else markNotificationsRead(visible.map((n) => n.id));
  };
  const clearAllVisible = () => {
    if (aiEnabled) clearAllNotifications();
    else clearNotifications(visible.map((n) => n.id));
  };

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
        {visible.length > 0 && (
          <div className="-mr-1 flex items-center gap-0.5">
            <Button variant="ghost" size="xs" onClick={markAllVisibleRead}>
              Mark all read
            </Button>
            <Button variant="ghost" size="xs" onClick={clearAllVisible}>
              Clear all
            </Button>
          </div>
        )}
      </div>

      {visible.length === 0 ? (
        <div className="px-3 pt-1 pb-6 text-center">
          <p className="text-xs font-medium">You're all caught up</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {aiEnabled
              ? "Finished reviews, PR activity, checks, and completed runs show up here so you never miss one."
              : "PR activity, checks, and completed runs show up here so you never miss one."}
          </p>
        </div>
      ) : (
        <div
          ref={listRef}
          className="max-h-80 overflow-y-auto outline-none"
          onKeyDown={onListKeyDown}
        >
          {visible.map((n) => (
            <NotificationRow
              key={n.id}
              n={n}
              onNavigate={() => navigate(n)}
              onDelete={() => handleDelete(n.id)}
            />
          ))}
        </div>
      )}

      {/* The dock's one way into the automation decision log. Needs a current
          repo: the strip variant renders on welcome/settings/help, where a
          repo-scoped dialog would have nothing to open. */}
      {aiEnabled && repoPath && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-between border-t px-3 text-muted-foreground"
          onClick={() => {
            // Close FIRST: Base UI returns focus to the popover's trigger as it
            // unwinds, which would steal it from a dialog opened before that.
            onClose();
            openHistory(repoPath);
          }}
        >
          Automation history
          <CaretRightIcon />
        </Button>
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
  const detailId = useId();
  // A one-line failure's full text IS its subtitle, already in the accessible name.
  const detail = n.detail !== n.subtitle ? n.detail : undefined;

  return (
    <div className="flex items-stretch not-last:border-b hover:bg-muted/60">
      <button
        type="button"
        data-row={n.id}
        aria-describedby={detail ? detailId : undefined}
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
              title={detail ?? n.subtitle}
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
        {/* A stamp read back from notifications.json only had to be a `number`
            to hydrate, and `toISOString` throws outside Date's range — which
            here would take down the whole dock. Drop the cell, keep the row. */}
        {validEpochMs(n.ts) && (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            <RelativeTime date={new Date(n.ts).toISOString()} />
          </span>
        )}
      </button>
      {/* The full text is otherwise only in the subtitle's hover title, which
          assistive tech never reads; aria-describedby resolves hidden targets. */}
      {detail && (
        <span id={detailId} hidden>
          {detail}
        </span>
      )}
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
const KIND_GLYPH: Partial<Record<NotificationKind, typeof CheckCircleIcon>> = {
  "review-ready": SparkleIcon,
  "review-posted": SparkleIcon,
  "review-failed": SparkleIcon,
  "checks-passed": CheckCircleIcon,
  "checks-failed": XCircleIcon,
  "pr-opened": GitPullRequestIcon,
  "pr-merged": GitMergeIcon,
  "pr-closed": GitPullRequestIcon,
  "pr-create-failed": GitPullRequestIcon,
  "pr-approved": CheckCircleIcon,
  "pr-changes-requested": WarningCircleIcon,
  "pr-comment": ChatCircleIcon,
  "pr-review": ChatCircleIcon,
  "review-requested": EyeIcon,
  "agent-done": SparkleIcon,
  "research-done": MagnifyingGlassIcon,
  "plan-done": ListChecksIcon,
};

/** PR sub-tab a notification's click-through lands on, per event kind. Kinds not
 *  listed get no override (the user's current tab stands) — deliberate for the
 *  checks family, whose rollup renders in the PR header above the tab strip and
 *  is therefore already on screen from every section. A `review-failed` from an
 *  *automation* still points at Review even though the panel shows idle: those
 *  runs use a separate `auto:<n>` key namespace, but Review is where the Run
 *  button lives. `review-posted` means the automation already posted the review
 *  as a PR comment, so it lives in the Conversation timeline; `review-ready` is
 *  saved to the review panel un-posted, so Review is its landing. Read with a
 *  row's plain-string kind — a hydrated row can carry a kind from an older
 *  build, so a lookup must miss, never fail. */
const KIND_SECTION: Partial<Record<NotificationKind, PrSection>> = {
  "review-ready": "review",
  "review-posted": "conversation",
  "review-failed": "review",
  "pr-opened": "conversation",
  "pr-merged": "conversation",
  "pr-closed": "conversation",
  "pr-approved": "conversation",
  "pr-changes-requested": "conversation",
  "pr-review": "conversation",
  "pr-comment": "conversation",
  "review-requested": "conversation",
};

/** Fallback glyph for kinds `KIND_GLYPH` doesn't name — the tone is then the
 *  only signal the mark can carry. */
const TONE_ICON: Record<NotificationTone, typeof CheckCircleIcon> = {
  success: CheckCircleIcon,
  warning: WarningCircleIcon,
  danger: XCircleIcon,
  info: CheckCircleIcon,
  merged: CheckCircleIcon,
  neutral: CheckCircleIcon,
};

function glyphFor(n: AppNotification): typeof CheckCircleIcon {
  // The cast reads a maybe-unknown kind against a closed map: hydrated rows are
  // untrusted, so the lookup must be allowed to miss into the tone fallback.
  return KIND_GLYPH[n.kind as NotificationKind] ?? TONE_ICON[n.tone];
}
