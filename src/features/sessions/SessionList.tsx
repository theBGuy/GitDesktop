import {
  MagnifyingGlassIcon,
  PlusIcon,
  SparkleIcon,
  UsersThreeIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import {
  AnimatePresence,
  type MotionProps,
  m,
  useReducedMotion,
} from "motion/react";
import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CreateLocalIssueDialog } from "@/features/issues/CreateLocalIssueDialog";
import { type PlanRun, usePlanStore } from "@/features/plan/store";
import { useReconcileLocalPrs } from "@/features/pulls/useReconcileLocalPrs";
import {
  assembleSessionReport,
  type ResearchRun,
  researchRunContextPack,
  useResearchStore,
} from "@/features/research/store";
import type { AgentKind } from "@/lib/ai/agent";
import { copyText } from "@/lib/clipboard";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { type PrAudit, usePrAuditByBranch } from "@/lib/pulls/audit";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { AGENT_LABELS } from "./AgentPickers";
import { useAgentNumber, useAgentNumbers } from "./agentNumber";
import {
  agentSelectionUnchanged,
  captureAgentSelection,
  clearAgentSelection,
  selectPlan,
  selectResearch,
  selectSession,
} from "./agentSelect";
import { PrAuditChip } from "./PrAuditChip";
import { StatusIndicator, sessionStatus } from "./status";
import { type AgentSession, useSessionsStore } from "./store";

/** A compact `#N · provider · model` line for a list row, so entries are browsable
 *  by their identifier + which agent/model produced them. The `#N` (a GitHub-style
 *  global id) lets a plan point at its implementing session. Model omitted when
 *  it's the account default. */
function RowAgentMeta({
  id,
  agent,
  model,
}: {
  id: string;
  agent: AgentKind;
  model: string;
}) {
  const number = useAgentNumber(id);
  return (
    <span className="w-full truncate text-[10px] text-muted-foreground/80">
      {number != null && (
        <span className="font-medium text-muted-foreground tabular-nums">
          #{number}
          {" · "}
        </span>
      )}
      {AGENT_LABELS[agent]}
      {model ? ` · ${model}` : ""}
    </span>
  );
}

/** A destructive action awaiting confirmation (the row's context menu defers it). */
type ConfirmReq = {
  title: string;
  body: string;
  label: string;
  action: () => void;
};

/** Wraps a list row's button in a right-click context menu of per-entry actions.
 *  Base UI `render` makes the trigger BE the motion button (no extra DOM, so the
 *  list's enter/exit animations are untouched); destructive items route through a
 *  shared confirm dialog. */
function RowMenu({
  trigger,
  items,
}: {
  trigger: ReactElement;
  items: (requestConfirm: (req: ConfirmReq) => void) => ReactNode;
}) {
  const [confirm, setConfirm] = useState<ConfirmReq | null>(null);
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger render={trigger} />
        <ContextMenuContent className="min-w-44">
          {items(setConfirm)}
        </ContextMenuContent>
      </ContextMenu>
      {confirm && (
        <ConfirmDialog
          open
          onCancel={() => setConfirm(null)}
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.label}
          confirmVariant="destructive"
          onConfirm={() => {
            confirm.action();
            setConfirm(null);
          }}
        />
      )}
    </>
  );
}

/** Context-menu actions for a session row — all directly callable (the dialog-led
 *  ones like Create PR live in the canvas, reached via Open). */
function SessionMenuItems({
  session,
  requestConfirm,
}: {
  session: AgentSession;
  requestConfirm: (req: ConfirmReq) => void;
}) {
  const store = useSessionsStore.getState;
  const reviewable = !session.kept && session.headHash !== session.base;
  return (
    <>
      <ContextMenuItem onClick={() => selectSession(session.id)}>
        Open
      </ContextMenuItem>
      {session.kept && (
        <ContextMenuItem onClick={() => store().resume(session.id)}>
          Resume
        </ContextMenuItem>
      )}
      {reviewable && (
        <ContextMenuItem onClick={() => store().keep(session.id, false)}>
          Keep
        </ContextMenuItem>
      )}
      {session.running && (
        <ContextMenuItem onClick={() => store().cancel(session.id)}>
          Stop
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      {session.kept ? (
        <ContextMenuItem
          variant="destructive"
          onClick={() =>
            requestConfirm({
              title: "Delete this session?",
              body: "Removes the kept session and its transcript. This can't be undone.",
              label: "Delete",
              action: () => store().deleteSession(session.id),
            })
          }
        >
          Delete
        </ContextMenuItem>
      ) : (
        <ContextMenuItem
          variant="destructive"
          onClick={() =>
            requestConfirm({
              title: "Discard this session?",
              body: "Deletes the worktree and its branch, throwing away the agent's work. This can't be undone.",
              label: "Discard",
              action: () => store().discard(session.id),
            })
          }
        >
          Discard
        </ContextMenuItem>
      )}
    </>
  );
}

/** Context-menu actions for a plan row. Mirrors the canvas footer's actions: jump
 *  to the implementing session, and file the drafted plan as a local issue. */
function PlanMenuItems({
  run,
  requestConfirm,
  onCreateIssue,
}: {
  run: PlanRun;
  requestConfirm: (req: ConfirmReq) => void;
  onCreateIssue: () => void;
}) {
  const store = usePlanStore.getState;
  // The write-capable session this plan was implemented into, if it still exists
  // (discarding the session reverts the plan to editable) — gates "View session".
  const session = useSessionsStore((s) =>
    run.implementedSessionId
      ? s.sessions.find((x) => x.id === run.implementedSessionId)
      : undefined,
  );
  return (
    <>
      <ContextMenuItem onClick={() => selectPlan(run.id)}>Open</ContextMenuItem>
      {session && (
        <ContextMenuItem onClick={() => selectSession(session.id)}>
          View session
        </ContextMenuItem>
      )}
      {run.draft && (
        <ContextMenuItem onClick={onCreateIssue}>
          Create local issue
        </ContextMenuItem>
      )}
      {run.generating && (
        <ContextMenuItem onClick={() => store().cancel(run.id)}>
          Stop
        </ContextMenuItem>
      )}
      {(run.stopped || run.error) && (
        <ContextMenuItem onClick={() => store().restart(run.id)}>
          Restart
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem
        variant="destructive"
        onClick={() =>
          requestConfirm({
            title: "Dismiss this plan?",
            body: "Removes the plan from the list. This can't be undone.",
            label: "Dismiss",
            action: () => store().remove(run.id),
          })
        }
      >
        Dismiss
      </ContextMenuItem>
    </>
  );
}

/** Context-menu actions for a research row, including the handoffs to Plan/clipboard. */
function ResearchMenuItems({
  run,
  requestConfirm,
}: {
  run: ResearchRun;
  requestConfirm: (req: ConfirmReq) => void;
}) {
  const store = useResearchStore.getState;
  const turnIntoPlan = async () => {
    if (!run.report || run.distilling) return;
    // Snapshot the agent-surface selection AT CLICK, so on completion we can tell
    // whether the user navigated to another run/plan/session mid-distill.
    const selectionAtClick = captureAgentSelection();
    // Distill the whole session into a plan-ready brief (one resumed turn); on
    // error/cancel/empty fall back to the raw assembly. Never blocks the handoff.
    const brief = await store().distillPlanBrief(run.id);
    // Re-read from the store — the captured `run` is stale after the await.
    const cur = store().runs.find((r) => r.id === run.id);
    if (!cur?.report) return;
    // Only steal the canvas if the selection is unchanged since the click (the user
    // is still waiting on this handoff). If they moved to another surface mid-distill,
    // leave their view alone; the pending seed still lands and is consumed later.
    if (agentSelectionUnchanged(selectionAtClick)) clearAgentSelection();
    usePlanStore.getState().setPendingPlanSeed({
      issueTitle: cur.report.title,
      issueBody: brief ?? assembleSessionReport(cur),
      originResearchId: run.id,
      // Carry forward what research already examined (all turns), as grounding data.
      contextPack: researchRunContextPack(cur),
    });
  };
  return (
    <>
      <ContextMenuItem onClick={() => selectResearch(run.id)}>
        Open
      </ContextMenuItem>
      {run.report && (
        <>
          <ContextMenuItem
            onClick={() => void turnIntoPlan()}
            disabled={run.distilling}
          >
            {run.distilling ? "Distilling…" : "Turn into a Plan"}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => void store().saveReport(run.id).catch(toastError)}
          >
            Save report
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() =>
              copyText(assembleSessionReport(run), "Report copied")
            }
          >
            Copy report
          </ContextMenuItem>
        </>
      )}
      {(run.generating || run.distilling) && (
        <ContextMenuItem onClick={() => store().cancel(run.id)}>
          Stop
        </ContextMenuItem>
      )}
      {(run.stopped || run.error) && (
        <ContextMenuItem onClick={() => store().restart(run.id)}>
          Restart
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem
        variant="destructive"
        onClick={() =>
          requestConfirm({
            title: "Dismiss this research?",
            body: "Removes the research run and its report from the list. This can't be undone.",
            label: "Dismiss",
            action: () => store().remove(run.id),
          })
        }
      >
        Dismiss
      </ContextMenuItem>
    </>
  );
}

/** Which bucket the list shows: in-progress, finalized sessions, or implemented
 *  plans filed away as references. */
type SessionTab = "active" | "kept" | "archived";

/** A row in the unified list — a read-only research run, a read-only plan run, or
 *  a write-capable session. All share the agent surface; one is selected at a
 *  time. Listed upstream-first (research → plan → session). */
type NavRow =
  | { kind: "research"; id: string }
  | { kind: "plan"; id: string }
  | { kind: "session"; id: string };

/** Lowercased text a session search matches: the branch and every turn's prompt. */
function sessionHaystack(s: AgentSession): string {
  return [s.branch, ...s.turns.map((t) => t.prompt)].join(" \n ").toLowerCase();
}

/** Lowercased text a plan search matches: its prompt and the drafted plan. */
function planHaystack(r: PlanRun): string {
  return [r.origin?.goal, r.origin?.issueTitle, r.text]
    .filter(Boolean)
    .join(" \n ")
    .toLowerCase();
}

function planLabel(r: PlanRun): string {
  return r.origin?.issueTitle?.trim() || r.origin?.goal?.trim() || "Plan";
}

/** Lowercased text a research search matches: its topic and every turn's report. */
function researchHaystack(r: ResearchRun): string {
  return [r.origin?.topic, ...(r.history ?? []).map((t) => t.text), r.text]
    .filter(Boolean)
    .join(" \n ")
    .toLowerCase();
}

function researchLabel(r: ResearchRun): string {
  return r.origin?.topic?.trim() || "Research";
}

/** Total cost of a research session — every turn, not just the latest. */
function researchCost(r: ResearchRun): number {
  const prior = (r.history ?? []).reduce((sum, t) => sum + (t.costUsd ?? 0), 0);
  return prior + (r.costUsd ?? 0);
}

/**
 * The agent sidebar: read-only **plans** and write-capable **sessions** in one
 * list, each as a row with its task and status. Sessions split into **Active**
 * (working / ready to review) and **Kept** tabs; plans (always in-progress work)
 * sit above the active sessions. A search box finds one by task, branch, or
 * message. Selecting a row shows it in the canvas; New shows the composer. Arrow
 * keys walk the rows.
 */
export function SessionList({ repoPath }: { repoPath: string }) {
  const allSessions = useSessionsStore((s) => s.sessions);
  const activeId = useSessionsStore((s) => s.activeId);
  const allRuns = usePlanStore((s) => s.runs);
  const activePlanId = usePlanStore((s) => s.activePlanId);
  const setPendingPlanSeed = usePlanStore((s) => s.setPendingPlanSeed);
  const allResearch = useResearchStore((s) => s.runs);
  const activeResearchId = useResearchStore((s) => s.activeResearchId);
  const setPendingResearchSeed = useResearchStore(
    (s) => s.setPendingResearchSeed,
  );

  // Mint a stable `#N` for every agent entry (research → plans → sessions, in
  // creation order), backfilling existing ones and numbering new ones. Global
  // (across repos) so an id is unique app-wide, like a GitHub PR number.
  const ensureNumbers = useAgentNumbers((s) => s.ensure);
  const numbersHydrated = useAgentNumbers((s) => s.hydrated);
  const orderedIds = useMemo(
    () => [
      ...allResearch.map((r) => r.id),
      ...allRuns.map((r) => r.id),
      ...allSessions.map((s) => s.id),
    ],
    [allResearch, allRuns, allSessions],
  );
  useEffect(() => {
    if (numbersHydrated) ensureNumbers(orderedIds);
  }, [orderedIds, numbersHydrated, ensureNumbers]);

  const [tab, setTab] = useState<SessionTab>("active");
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // Plans and sessions belong to the repo they were started in.
  const repoSessions = useMemo(
    () => allSessions.filter((s) => s.repoPath === repoPath),
    [allSessions, repoPath],
  );
  const repoPlans = useMemo(
    () => allRuns.filter((r) => r.repoPath === repoPath),
    [allRuns, repoPath],
  );
  const repoResearch = useMemo(
    () => allResearch.filter((r) => r.repoPath === repoPath),
    [allResearch, repoPath],
  );
  const activeSessionCount = useMemo(
    () => repoSessions.filter((s) => !s.kept).length,
    [repoSessions],
  );
  // A plan whose implementing session has been kept is "archived" — it moves to
  // the Kept tab (a finished reference) instead of cluttering Active. Derived, so
  // it stays in sync (and reverts if the session is later discarded).
  const keptSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of repoSessions) if (s.kept) ids.add(s.id);
    return ids;
  }, [repoSessions]);
  const archivedPlanCount = useMemo(
    () =>
      repoPlans.filter(
        (r) =>
          r.implementedSessionId && keptSessionIds.has(r.implementedSessionId),
      ).length,
    [repoPlans, keptSessionIds],
  );
  // A research run that's been handed off ("Turn into a Plan") is "archived" — a
  // plan run records the originating research id on its seed, so this derives
  // (and reverts if that plan is discarded), the same way an implemented plan
  // archives off its kept session.
  const seededResearchIds = useMemo(() => {
    const ids = new Set<string>();
    for (const p of repoPlans)
      if (p.seed?.originResearchId) ids.add(p.seed.originResearchId);
    return ids;
  }, [repoPlans]);
  const archivedResearchCount = useMemo(
    () => repoResearch.filter((r) => seededResearchIds.has(r.id)).length,
    [repoResearch, seededResearchIds],
  );
  // Active = in-progress research + in-progress plans + working/ready sessions.
  // Kept = finalized sessions. Archived = implemented plans + research that became
  // a plan (kept references) in their own tab so they don't crowd either.
  const activeCount =
    activeSessionCount +
    (repoPlans.length - archivedPlanCount) +
    (repoResearch.length - archivedResearchCount);
  const keptCount = repoSessions.length - activeSessionCount;
  const archivedCount = archivedPlanCount + archivedResearchCount;

  // The Archived tab only exists while there are archived plans; if it empties
  // (e.g. its session was discarded) while you're on it, fall back to Active —
  // derived at render so the raw `tab` state stays the user's chosen tab.
  const effectiveTab: SessionTab =
    tab === "archived" && archivedCount === 0 ? "active" : tab;

  // Audit: link each session's branch to its pull request and merge state. Keep
  // local PRs honest with git while the agent tab is open, then look up by branch
  // (local + GitHub). Remote PRs are only fetched once something's been kept —
  // before that, no session has a PR to show.
  useReconcileLocalPrs(repoPath);
  const prAudit = usePrAuditByBranch(repoPath, keptCount > 0);

  // The visible rows: the current tab, narrowed by the search query. Sessions show
  // on Active (working) / Kept (finalized); plans show on Active (in-progress) /
  // Archived (implemented).
  const sessions = useMemo(() => {
    if (effectiveTab === "archived") return [];
    const q = query.trim().toLowerCase();
    return repoSessions.filter(
      (s) =>
        s.kept === (effectiveTab === "kept") &&
        (!q || sessionHaystack(s).includes(q)),
    );
  }, [repoSessions, effectiveTab, query]);
  const plans = useMemo(() => {
    if (effectiveTab === "kept") return [];
    const q = query.trim().toLowerCase();
    const archived = (r: PlanRun) =>
      Boolean(
        r.implementedSessionId && keptSessionIds.has(r.implementedSessionId),
      );
    return repoPlans.filter(
      (r) =>
        archived(r) === (effectiveTab === "archived") &&
        (!q || planHaystack(r).includes(q)),
    );
  }, [repoPlans, effectiveTab, query, keptSessionIds]);
  // Research shows on Active (in-progress / report ready) and Archived (handed off
  // to a plan). Never on Kept (that's finalized write-sessions only).
  const research = useMemo(() => {
    if (effectiveTab === "kept") return [];
    const q = query.trim().toLowerCase();
    return repoResearch.filter(
      (r) =>
        seededResearchIds.has(r.id) === (effectiveTab === "archived") &&
        (!q || researchHaystack(r).includes(q)),
    );
  }, [repoResearch, effectiveTab, query, seededResearchIds]);

  const newSession = () => clearAgentSelection();
  const openPlanComposer = () => {
    clearAgentSelection();
    setPendingPlanSeed({});
  };
  const openResearchComposer = () => {
    clearAgentSelection();
    setPendingResearchSeed({});
  };
  useHotkeyAction("agent-new-session", newSession);
  useHotkeyAction("agent-plan", openPlanComposer);
  useHotkeyAction("agent-research", openResearchComposer);
  useHotkeyAction("agent-toggle-list-tab", () =>
    setTab((t) =>
      t === "active" ? "kept" : t === "kept" ? "archived" : "active",
    ),
  );
  useHotkeyAction("focus-filter", () => searchRef.current?.focus());

  // Rows fade + collapse on add/remove so the list reflows calmly. Reduced
  // motion → opacity only (no height motion). py-2 (8px) is mirrored here because
  // motion owns the row's vertical padding while it collapses to nothing.
  const reduce = useReducedMotion();
  const rowMotion: Pick<MotionProps, "initial" | "animate" | "exit"> = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0, height: 0, paddingTop: 0, paddingBottom: 0 },
        animate: {
          opacity: 1,
          height: "auto",
          paddingTop: 8,
          paddingBottom: 8,
        },
        exit: { opacity: 0, height: 0, paddingTop: 0, paddingBottom: 0 },
      };

  // One flat navigation order, upstream-first: research, then plans, then sessions.
  const navItems = useMemo<NavRow[]>(
    () => [
      ...research.map((r) => ({ kind: "research" as const, id: r.id })),
      ...plans.map((r) => ({ kind: "plan" as const, id: r.id })),
      ...sessions.map((s) => ({ kind: "session" as const, id: s.id })),
    ],
    [research, plans, sessions],
  );
  // One table per kind for "is this the selected row?" and "open it" — the
  // roving tab stop and the keyboard nav read the same entry, so they can't
  // drift apart.
  const navKind: Record<
    NavRow["kind"],
    { isActive: (id: string) => boolean; activate: (id: string) => void }
  > = {
    research: {
      isActive: (id) => id === activeResearchId,
      activate: selectResearch,
    },
    plan: { isActive: (id) => id === activePlanId, activate: selectPlan },
    session: { isActive: (id) => id === activeId, activate: selectSession },
  };
  const activeIndex = navItems.findIndex((it) =>
    navKind[it.kind].isActive(it.id),
  );
  // When nothing in this list is selected, the first row is the roving tab stop.
  const rovingIndex = activeIndex === -1 ? 0 : activeIndex;
  const onKeyDown = listKeyboardNav({
    items: navItems,
    activeIndex,
    rowKey: (it) => it.id,
    onActivate: (it) => navKind[it.kind].activate(it.id),
  });

  const nothingSelected =
    activeId === null && activePlanId === null && activeResearchId === null;
  const repoEmpty =
    repoSessions.length === 0 &&
    repoPlans.length === 0 &&
    repoResearch.length === 0;
  // A group label per kind, shown only when more than one kind is present.
  const groupCount =
    (research.length > 0 ? 1 : 0) +
    (plans.length > 0 ? 1 : 0) +
    (sessions.length > 0 ? 1 : 0);
  const showGroups = groupCount > 1;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b p-2 pl-3">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <SparkleIcon className="size-4 text-primary" />
          Agent
        </span>
        <Button
          size="xs"
          variant={nothingSelected ? "secondary" : "ghost"}
          className="ml-auto"
          onClick={newSession}
        >
          <PlusIcon className="size-3.5" />
          New
        </Button>
      </div>
      {repoEmpty ? (
        <EmptyState onNew={newSession} />
      ) : (
        <>
          <div className="shrink-0 space-y-2 border-b p-2">
            <Tabs
              value={effectiveTab}
              onValueChange={(v) => setTab(v as SessionTab)}
            >
              <TabsList className="w-full">
                <TabsTrigger value="active" className="min-w-0 flex-1">
                  Active
                  <Count n={activeCount} />
                </TabsTrigger>
                <TabsTrigger value="kept" className="min-w-0 flex-1">
                  Kept
                  <Count n={keptCount} />
                </TabsTrigger>
                {archivedCount > 0 && (
                  <TabsTrigger value="archived" className="min-w-0 flex-1">
                    Archived
                    <Count n={archivedCount} />
                  </TabsTrigger>
                )}
              </TabsList>
            </Tabs>
            <div className="relative">
              <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search research, plans & sessions"
                aria-label="Search agent research, plans, and sessions"
                autoComplete="off"
                className="h-7 pl-7"
              />
            </div>
          </div>
          {navItems.length === 0 ? (
            <ListEmpty tab={effectiveTab} hasQuery={query.trim().length > 0} />
          ) : (
            <div
              role="listbox"
              aria-label="Agent research, plans, and sessions"
              onKeyDown={onKeyDown}
              className="min-h-0 flex-1 overflow-y-auto p-1"
            >
              {/* Keyed by tab so switching tabs is an instant swap; within a tab,
                  add/remove animates. */}
              <AnimatePresence key={effectiveTab} initial={false}>
                {showGroups && research.length > 0 && (
                  <GroupLabel key="g-research">Research</GroupLabel>
                )}
                {/* Research is first in navItems, so a research row's array index
                    IS its nav index — no offset (plans/sessions add one below). */}
                {research.map((r, i) => (
                  <ResearchRow
                    key={`research:${r.id}`}
                    run={r}
                    planned={effectiveTab === "archived"}
                    active={r.id === activeResearchId}
                    tabIndex={i === rovingIndex ? 0 : -1}
                    motionProps={rowMotion}
                    onClick={() => selectResearch(r.id)}
                  />
                ))}
                {showGroups && plans.length > 0 && (
                  <GroupLabel key="g-plans">Plans</GroupLabel>
                )}
                {plans.map((r, i) => {
                  const idx = research.length + i;
                  return (
                    <PlanRow
                      key={`plan:${r.id}`}
                      run={r}
                      audit={prAudit}
                      active={r.id === activePlanId}
                      tabIndex={idx === rovingIndex ? 0 : -1}
                      motionProps={rowMotion}
                      onClick={() => selectPlan(r.id)}
                    />
                  );
                })}
                {showGroups && sessions.length > 0 && (
                  <GroupLabel key="g-sessions">Sessions</GroupLabel>
                )}
                {sessions.map((s, j) => {
                  const idx = research.length + plans.length + j;
                  return (
                    <SessionRow
                      key={`session:${s.id}`}
                      session={s}
                      audit={prAudit.get(s.branch)}
                      active={s.id === activeId}
                      tabIndex={idx === rovingIndex ? 0 : -1}
                      motionProps={rowMotion}
                      onClick={() => selectSession(s.id)}
                    />
                  );
                })}
              </AnimatePresence>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** A small count beside a tab label (decorative — the label carries meaning). */
function Count({ n }: { n: number }) {
  return (
    <span className="ml-1.5 text-[10px] text-muted-foreground tabular-nums">
      {n}
    </span>
  );
}

/** A group divider label (decorative — the rows carry the meaning, so it's hidden
 *  from assistive tech, which reads the options in order). */
function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p
      aria-hidden
      className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-muted-foreground"
    >
      {children}
    </p>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <SparkleIcon className="size-7 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-xs font-medium">No agent sessions yet</p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Delegate a task and the agent works in an isolated worktree you review
          before keeping — or plan one first, read-only.
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={onNew}>
        <PlusIcon className="size-3.5" />
        New
      </Button>
    </div>
  );
}

/** What an otherwise-empty tab says about itself — each names how rows land
 *  there. */
const TAB_EMPTY_MESSAGE: Record<SessionTab, string> = {
  active: "Nothing active — start a plan or session with New.",
  kept: "No kept sessions yet. Keep a session to file it here.",
  archived:
    "No archived plans yet. Plans land here once their session is kept.",
};

/** Shown when a tab (or a search within it) has no rows, but other rows exist —
 *  so the full empty state with its New button would be misleading. */
function ListEmpty({ tab, hasQuery }: { tab: SessionTab; hasQuery: boolean }) {
  const message = hasQuery
    ? "Nothing matches your search."
    : TAB_EMPTY_MESSAGE[tab];
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {message}
      </p>
    </div>
  );
}

/** Status line for a plan row — mirrors a session's StatusIndicator. */
function PlanStatus({
  run,
  audit,
}: {
  run: PlanRun;
  audit: Map<string, PrAudit>;
}) {
  // Subscribe to the spawned session (if any) so the row tracks its status live.
  const session = useSessionsStore((s) =>
    run.implementedSessionId
      ? s.sessions.find((x) => x.id === run.implementedSessionId)
      : undefined,
  );
  // The implementing session's `#N`, so the plan points at what's attached to it
  // ("Implemented · Ready to review #10"). Empty id → undefined (hooks stay top-level).
  const sessionNumber = useAgentNumber(session?.id ?? "");

  if (run.generating) {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
        Planning…
      </span>
    );
  }
  // Once implemented, mirror the spawned session's status instead of "Plan ready".
  if (session) {
    const st = sessionStatus(session);
    if (st.kind === "working") {
      return (
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
          Implementing…
        </span>
      );
    }
    if (st.kind === "error") {
      return (
        <span className="flex min-w-0 items-center gap-1.5 text-destructive">
          <WarningCircleIcon className="size-3.5 shrink-0" />
          Implement failed
        </span>
      );
    }
    // Audit trail: once the implementing session has a pull request, surface it
    // (its merge is the real "done") instead of the redundant "Kept".
    const merge = audit.get(session.branch);
    const num = sessionNumber != null ? ` #${sessionNumber}` : "";
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        <span className="truncate">
          {merge ? "Implemented" : `Implemented · ${st.label}${num}`}
        </span>
        {merge && <PrAuditChip audit={merge} />}
      </span>
    );
  }
  if (run.error)
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-destructive">
        <WarningCircleIcon className="size-3.5 shrink-0" />
        Plan failed
      </span>
    );
  if (run.draft)
    return <span className="text-muted-foreground">Plan ready</span>;
  return <span className="text-muted-foreground">Read-only plan</span>;
}

function PlanRow({
  run,
  audit,
  active,
  tabIndex,
  motionProps,
  onClick,
}: {
  run: PlanRun;
  audit: Map<string, PrAudit>;
  active: boolean;
  tabIndex: number;
  motionProps: Pick<MotionProps, "initial" | "animate" | "exit">;
  onClick: () => void;
}) {
  // The plan can be filed as a local issue from its context menu; the dialog lives
  // here (a sibling of the row's menu) so it survives the menu closing, prefilled
  // with the plan's drafted issue — same flow as the canvas footer.
  const [issueOpen, setIssueOpen] = useState(false);
  return (
    <>
      <RowMenu
        trigger={
          <m.button
            {...motionProps}
            type="button"
            role="option"
            aria-selected={active}
            data-row={run.id}
            tabIndex={tabIndex}
            onClick={onClick}
            className={cn(
              "flex w-full flex-col items-start gap-1 overflow-hidden px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
              active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
            )}
          >
            <span className="line-clamp-2 w-full text-xs font-medium leading-snug">
              {planLabel(run)}
            </span>
            <span className="flex w-full items-center gap-2 text-[11px]">
              <PlanStatus run={run} audit={audit} />
              {run.costUsd != null && (
                <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
                  ${run.costUsd.toFixed(2)}
                </span>
              )}
            </span>
            <RowAgentMeta id={run.id} agent={run.agent} model={run.model} />
          </m.button>
        }
        items={(req) => (
          <PlanMenuItems
            run={run}
            requestConfirm={req}
            onCreateIssue={() => setIssueOpen(true)}
          />
        )}
      />
      {run.draft && (
        <CreateLocalIssueDialog
          repoPath={run.repoPath}
          open={issueOpen}
          onOpenChange={setIssueOpen}
          initialDraft={{ title: run.draft.title, body: run.draft.body }}
        />
      )}
    </>
  );
}

function SessionRow({
  session,
  audit,
  active,
  tabIndex,
  motionProps,
  onClick,
}: {
  session: AgentSession;
  audit: PrAudit | undefined;
  active: boolean;
  tabIndex: number;
  motionProps: Pick<MotionProps, "initial" | "animate" | "exit">;
  onClick: () => void;
}) {
  const title = session.turns[0]?.prompt.trim() || "New session";
  const cost = session.turns.reduce((sum, t) => sum + (t.costUsd ?? 0), 0);
  return (
    <RowMenu
      trigger={
        <m.button
          {...motionProps}
          type="button"
          role="option"
          aria-selected={active}
          data-row={session.id}
          tabIndex={tabIndex}
          onClick={onClick}
          className={cn(
            "flex w-full flex-col items-start gap-1 overflow-hidden px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
            active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
          )}
        >
          <span className="line-clamp-2 w-full text-xs font-medium leading-snug">
            {title}
          </span>
          <span className="flex w-full items-center gap-2 text-[11px]">
            <StatusIndicator session={session} className="min-w-0" />
            {session.ensembleId && (
              <span
                className="inline-flex shrink-0 items-center text-muted-foreground"
                title="One arm of a best-of-N ensemble"
              >
                <UsersThreeIcon className="size-3.5" />
              </span>
            )}
            {audit && <PrAuditChip audit={audit} />}
            {cost > 0 && (
              <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
                ${cost.toFixed(2)}
              </span>
            )}
          </span>
          <RowAgentMeta
            id={session.id}
            agent={session.agent}
            model={session.model}
          />
        </m.button>
      }
      items={(req) => (
        <SessionMenuItems session={session} requestConfirm={req} />
      )}
    />
  );
}

/** Status line for a research row — mirrors a plan's PlanStatus. `planned` marks
 *  a run that's been handed off to a plan (shown in the Archived tab). */
function ResearchStatus({
  run,
  planned,
}: {
  run: ResearchRun;
  planned: boolean;
}) {
  // The plan this research was handed off into ("Turn into a Plan"), if any — the
  // research→plan analogue of a plan's "Implemented … #N" session link, so the row
  // points at what it became. A plan records its originating research id on its seed.
  const plan = usePlanStore((s) =>
    s.runs.find((p) => p.seed?.originResearchId === run.id),
  );
  const planNumber = useAgentNumber(plan?.id ?? "");
  if (run.generating || run.distilling) {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
        {run.distilling
          ? "Distilling plan brief…"
          : run.depth === "deep"
            ? "Researching…"
            : "Brainstorming…"}
      </span>
    );
  }
  if (run.error)
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-destructive">
        <WarningCircleIcon className="size-3.5 shrink-0" />
        Research failed
      </span>
    );
  if (planned)
    return (
      <span className="text-muted-foreground">
        {planNumber != null
          ? `Turned into plan #${planNumber}`
          : "Turned into a plan"}
      </span>
    );
  if (run.report)
    return <span className="text-muted-foreground">Report ready</span>;
  return <span className="text-muted-foreground">Read-only research</span>;
}

function ResearchRow({
  run,
  planned,
  active,
  tabIndex,
  motionProps,
  onClick,
}: {
  run: ResearchRun;
  planned: boolean;
  active: boolean;
  tabIndex: number;
  motionProps: Pick<MotionProps, "initial" | "animate" | "exit">;
  onClick: () => void;
}) {
  return (
    <RowMenu
      trigger={
        <m.button
          {...motionProps}
          type="button"
          role="option"
          aria-selected={active}
          data-row={run.id}
          tabIndex={tabIndex}
          onClick={onClick}
          className={cn(
            "flex w-full flex-col items-start gap-1 overflow-hidden px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
            active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
          )}
        >
          <span className="line-clamp-2 w-full text-xs font-medium leading-snug">
            {researchLabel(run)}
          </span>
          <span className="flex w-full items-center gap-2 text-[11px]">
            <ResearchStatus run={run} planned={planned} />
            {researchCost(run) > 0 && (
              <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
                ${researchCost(run).toFixed(2)}
              </span>
            )}
          </span>
          <RowAgentMeta id={run.id} agent={run.agent} model={run.model} />
        </m.button>
      }
      items={(req) => <ResearchMenuItems run={run} requestConfirm={req} />}
    />
  );
}
