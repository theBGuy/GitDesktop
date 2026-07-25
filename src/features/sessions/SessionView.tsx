import { Popover } from "@base-ui/react/popover";
import {
  CubeIcon,
  SparkleIcon,
  TerminalWindowIcon,
  TreeStructureIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BranchDiffView } from "@/features/compare/BranchDiffView";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import { PlanView } from "@/features/plan/PlanView";
import { usePlanStore } from "@/features/plan/store";
import { ResearchView } from "@/features/research/ResearchView";
import { useResearchStore } from "@/features/research/store";
import { TerminalDock } from "@/features/terminal/TerminalDock";
import { formatUsd } from "@/lib/ai/cost";
import { openContainerShell } from "@/lib/ai/sandbox";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { usePrAuditByBranch } from "@/lib/pulls/audit";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { ContainerLaunchPanel } from "./ContainerLaunchPanel";
import { PrAuditChip } from "./PrAuditChip";
import { SessionActivation } from "./SessionActivation";
import { SessionConversation } from "./SessionConversation";
import { SessionOpenMenu } from "./SessionOpenMenu";
import { StatusIndicator } from "./status";
import { type AgentSession, useSessionsStore } from "./store";
import { useSessionTerminal } from "./useSessionTerminal";
import { WorktreeChangesView } from "./WorktreeChangesView";

type Segment = "conversation" | "changes";

/**
 * The agent "canvas". With no session selected it's the new-session activation
 * panel; with one selected it's a focused two-pane workspace — a header
 * (title, status, branch, Keep / Discard) over a segmented Conversation |
 * Changes view. Keyed by session id upstream so per-session view state resets.
 */
export function SessionView({ repoPath }: { repoPath: string }) {
  const sessions = useSessionsStore((s) => s.sessions);
  const activeId = useSessionsStore((s) => s.activeId);
  // The read-only plan canvas takes over the surface when a plan run for this
  // repo is selected (mutually exclusive with a selected session — see
  // agentSelect.ts). Plans and sessions both live in the Agent sidebar.
  const planActive = usePlanStore((s) => {
    const run = s.runs.find((r) => r.id === s.activePlanId);
    return Boolean(run && run.repoPath === repoPath);
  });
  // Research runs likewise take over the surface when one for this repo is
  // selected (mutually exclusive with sessions and plans — see agentSelect.ts).
  const researchActive = useResearchStore((s) => {
    const run = s.runs.find((r) => r.id === s.activeResearchId);
    return Boolean(run && run.repoPath === repoPath);
  });
  // activeId is global; only adopt it when the session belongs to this repo.
  const active =
    sessions.find((s) => s.id === activeId && s.repoPath === repoPath) ?? null;

  if (planActive) return <PlanView repoPath={repoPath} />;
  if (researchActive) return <ResearchView />;
  if (!active) return <SessionActivation repoPath={repoPath} />;
  return <SessionCanvas key={active.id} session={active} repoPath={repoPath} />;
}

function SessionCanvas({
  session,
  repoPath,
}: {
  session: AgentSession;
  repoPath: string;
}) {
  const busyId = useSessionsStore((s) => s.busyId);
  const keep = useSessionsStore((s) => s.keep);
  const resume = useSessionsStore((s) => s.resume);
  const discard = useSessionsStore((s) => s.discard);
  const deleteSession = useSessionsStore((s) => s.deleteSession);
  const [segment, setSegment] = useState<Segment>("conversation");
  const [squash, setSquash] = useState(true);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmKeepEnsemble, setConfirmKeepEnsemble] = useState(false);
  const openLocalPrCreate = useUiStore((s) => s.openLocalPrCreate);
  // Integrated terminal state + actions (dock visibility, launch, the container
  // port popover) live in their own hook.
  const {
    isContainer,
    terminalOpen,
    setTerminalOpen,
    launch,
    launchPopoverOpen,
    setLaunchPopoverOpen,
    launchTerminal,
    restartTerminal,
    stopTerminal,
    toggleTerminal,
  } = useSessionTerminal(session);

  const kept = session.kept;
  const hasCommits = kept || session.headHash !== session.base;
  const commitCount = session.turns.filter((t) => t.commitHash).length;
  // PR/merge audit for this branch (local + GitHub) — surfaced beside the branch
  // so you can confirm the work landed before deleting it. Remote PRs are only
  // fetched for a kept session; a working one has no PR yet.
  const prAudit = usePrAuditByBranch(session.repoPath, kept).get(
    session.branch,
  );
  // Best-of-N: this session's ensemble arms (incl. itself), their combined live
  // cost (the running-aggregate half of the cost guardrail), and how many idle
  // arms a "keep this" would discard.
  const keepWinner = useSessionsStore((s) => s.keepWinner);
  const allSessions = useSessionsStore((s) => s.sessions);
  const ensemble = useMemo(
    () =>
      session.ensembleId
        ? allSessions.filter((x) => x.ensembleId === session.ensembleId)
        : [],
    [allSessions, session.ensembleId],
  );
  const ensembleCost = useMemo(
    () =>
      ensemble.reduce(
        (sum, s) => sum + s.turns.reduce((a, t) => a + (t.costUsd ?? 0), 0),
        0,
      ),
    [ensemble],
  );
  const idleSiblings = ensemble.filter(
    (x) => x.id !== session.id && !x.kept && !x.running,
  ).length;
  // Actions are disabled while the agent runs or a keep/resume/discard is mid-flight.
  const blocked = session.running || busyId === session.id;
  const title = session.turns[0]?.prompt.trim() || "Agent session";

  const doKeep = () => {
    if (blocked || kept || !hasCommits) return;
    // Best-of-N: keeping a winner should clear the losers. Confirm, since
    // discarding the other arms deletes their branches (and let you keep more
    // than one if you really want).
    if (ensemble.length > 1 && idleSiblings > 0) {
      setConfirmKeepEnsemble(true);
      return;
    }
    keep(session.id, squash);
  };
  // Discarding deletes the worktree AND branch — confirm when there's work to
  // lose; an empty session (no commits) is a harmless cleanup, so skip the gate.
  const doDiscard = () => {
    if (blocked || kept) return;
    if (hasCommits) setConfirmDiscard(true);
    else discard(session.id);
  };
  const doResume = () => {
    if (!blocked && kept) resume(session.id);
  };
  const doDelete = () => {
    if (!blocked && kept) setConfirmDelete(true);
  };
  // Promote a kept session: open a local PR from its (finalized) branch. Gated on
  // `kept` so the branch is squashed/settled before it's proposed for merge.
  const doCreatePr = () => {
    if (!blocked && kept) openLocalPrCreate({ defaultHead: session.branch });
  };
  const toggleView = () =>
    setSegment((s) => (s === "conversation" ? "changes" : "conversation"));

  useHotkeyAction(
    "agent-keep-session",
    doKeep,
    !blocked && !kept && hasCommits,
  );
  useHotkeyAction("agent-discard-session", doDiscard, !blocked && !kept);
  useHotkeyAction("agent-resume-session", doResume, !blocked && kept);
  useHotkeyAction("agent-delete-session", doDelete, !blocked && kept);
  useHotkeyAction("agent-create-pr", doCreatePr, !blocked && kept);
  useHotkeyAction("agent-toggle-view", toggleView);
  useHotkeyAction("agent-toggle-terminal", toggleTerminal);

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b">
        <div className="flex items-start gap-3 px-3 pt-2.5">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-xs font-medium" title={title}>
              {title}
            </h2>
            <div className="mt-1 flex items-center gap-2 text-[11px]">
              <StatusIndicator session={session} />
              <span className="text-muted-foreground" aria-hidden>
                ·
              </span>
              <span
                className="truncate font-mono text-muted-foreground"
                title={session.branch}
              >
                {session.branch}
              </span>
              <span className="text-muted-foreground" aria-hidden>
                ·
              </span>
              <IsolationChip isolation={session.isolation} />
              {prAudit && (
                <>
                  <span className="text-muted-foreground" aria-hidden>
                    ·
                  </span>
                  <PrAuditChip audit={prAudit} />
                </>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {kept ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={blocked}
                  onClick={doDelete}
                >
                  Delete
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={blocked}
                  onClick={doCreatePr}
                >
                  Create PR
                </Button>
                <Button size="sm" disabled={blocked} onClick={doResume}>
                  Resume
                </Button>
              </>
            ) : (
              <>
                <SessionOpenMenu
                  worktreePath={session.worktreePath}
                  isolation={session.isolation}
                />
                {commitCount > 1 && (
                  <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground select-none">
                    <Checkbox
                      checked={squash}
                      onCheckedChange={(v) => setSquash(v === true)}
                    />
                    Squash {commitCount}
                  </label>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={blocked}
                  onClick={doDiscard}
                >
                  Discard
                </Button>
                <Button
                  size="sm"
                  disabled={blocked || !hasCommits}
                  onClick={doKeep}
                >
                  Keep
                </Button>
              </>
            )}
          </div>
        </div>
        {ensemble.length > 1 && (
          <div className="flex items-center gap-2 border-t bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground">
            <UsersThreeIcon className="size-3.5 shrink-0" />
            <span>
              Best of {ensemble.length}
              {ensembleCost > 0 && ` · ${formatUsd(ensembleCost)} so far`}
              {!kept && idleSiblings > 0 && " · Keep discards the other arms"}
            </span>
          </div>
        )}
        <div className="flex items-center justify-between gap-2 px-3 py-2.5">
          <Tabs value={segment} onValueChange={(v) => setSegment(v as Segment)}>
            <TabsList>
              <TabsTrigger value="conversation">Conversation</TabsTrigger>
              <TabsTrigger value="changes">
                Changes
                {(hasCommits || session.running) && (
                  <>
                    <span
                      className="ml-1.5 size-1.5 rounded-full bg-current"
                      aria-hidden
                    />
                    <span className="sr-only">
                      {session.running
                        ? " (agent is making changes)"
                        : " (changes ready to review)"}
                    </span>
                  </>
                )}
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {isContainer && !launch ? (
            // A container terminal needs ports chosen before it spins up — the
            // Terminal button opens a popover (same flow as the old Test button)
            // to pick them, then mounts the in-app shell in the dock.
            <Popover.Root
              open={launchPopoverOpen}
              onOpenChange={setLaunchPopoverOpen}
            >
              <Popover.Trigger
                render={
                  <Button
                    size="xs"
                    variant={launchPopoverOpen ? "secondary" : "ghost"}
                  />
                }
                title="Open a terminal in the session's container"
              >
                <TerminalWindowIcon className="size-3.5" />
                Terminal
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Positioner
                  align="end"
                  sideOffset={6}
                  className="isolate z-50"
                >
                  <Popover.Popup className="w-80 bg-popover p-3 text-popover-foreground shadow-md ring-1 ring-foreground/10">
                    <p className="mb-2 text-xs font-medium">
                      Open container terminal
                    </p>
                    {/* Remount on open so it re-checks whether one is up. */}
                    {launchPopoverOpen && (
                      <ContainerLaunchPanel
                        worktreePath={session.worktreePath}
                        onStart={launchTerminal}
                        onReconnect={() => launchTerminal([])}
                        // Dev-only escape hatch: the in-app PTY needs a release
                        // build on Windows, so in dev keep the (working) external
                        // shell reachable. Tree-shaken from release builds.
                        onOpenExternal={
                          import.meta.env.DEV
                            ? (ports) => {
                                openContainerShell(
                                  session.worktreePath,
                                  ports,
                                ).catch(toastError);
                                setLaunchPopoverOpen(false);
                              }
                            : undefined
                        }
                      />
                    )}
                  </Popover.Popup>
                </Popover.Positioner>
              </Popover.Portal>
            </Popover.Root>
          ) : (
            <Button
              size="xs"
              variant={terminalOpen ? "secondary" : "ghost"}
              onClick={toggleTerminal}
              title="Toggle the terminal"
            >
              <TerminalWindowIcon className="size-3.5" />
              Terminal
            </Button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {segment === "conversation" ? (
          <SessionConversation session={session} repoPath={repoPath} />
        ) : (
          <SessionChanges session={session} />
        )}
      </div>

      <TerminalDock
        session={session}
        open={terminalOpen}
        onOpenChange={setTerminalOpen}
        launch={launch}
        onRestart={restartTerminal}
        onStop={stopTerminal}
      />

      <ConfirmDialog
        open={confirmDiscard}
        onCancel={() => setConfirmDiscard(false)}
        title="Discard this session?"
        body={
          <>
            The agent's work on{" "}
            <span className="font-mono">{session.branch}</span> will be
            permanently deleted — its worktree and branch are removed. This
            can't be undone.
          </>
        }
        confirmLabel="Discard"
        confirmVariant="destructive"
        onConfirm={() => {
          setConfirmDiscard(false);
          discard(session.id);
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        onCancel={() => setConfirmDelete(false)}
        title="Delete this session?"
        body={
          <>
            This removes the session and its conversation from the app. The work
            stays on branch <span className="font-mono">{session.branch}</span>{" "}
            — delete that from Branches if you no longer need it.
          </>
        }
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={() => {
          setConfirmDelete(false);
          deleteSession(session.id);
        }}
      />

      {/* Best-of-N: keeping a winner offers to discard the other arms (the losers).
          "Keep only" leaves them if you want to keep more than one. */}
      <Dialog open={confirmKeepEnsemble} onOpenChange={setConfirmKeepEnsemble}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Keep this arm and discard the rest?</DialogTitle>
            <DialogDescription>
              Keeping on branch{" "}
              <span className="font-mono">{session.branch}</span>. This is one
              of {ensemble.length} best-of-N arms — discarding the other{" "}
              {idleSiblings} permanently deletes their worktrees and branches.
              This can't be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmKeepEnsemble(false)}
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setConfirmKeepEnsemble(false);
                keep(session.id, squash);
              }}
            >
              Keep only
            </Button>
            <Button
              onClick={() => {
                setConfirmKeepEnsemble(false);
                keepWinner(session.id, squash);
              }}
            >
              Keep & discard {idleSiblings}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * How this session is sandboxed, in the canvas header beside the branch. Isolation
 * is fixed at creation and can now be overridden per session (the composer's Options
 * → Isolation row), so two Active sessions in the same repo can differ — the mode
 * has to be readable after the fact, not only at start. Mirrors the PrAuditChip
 * idiom: icon + text (never color alone), muted, with the caveat in the title.
 */
function IsolationChip({
  isolation,
}: {
  isolation: AgentSession["isolation"];
}) {
  const container = isolation === "container";
  const Icon = container ? CubeIcon : TreeStructureIcon;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-muted-foreground"
      title={
        container
          ? "Runs in an ephemeral container — file writes are confined by the kernel."
          : "Runs on the host in a throwaway worktree — file writes are confined by convention, not the kernel."
      }
    >
      <Icon weight="bold" className="size-3" />
      {container ? "Container" : "Worktree"}
    </span>
  );
}

function SessionChanges({ session }: { session: AgentSession }) {
  const hasCommits = session.kept || session.headHash !== session.base;
  // While a turn is running, reflect the worktree's uncommitted changes live so
  // you can watch the agent work before the checkpoint commit lands. (A kept
  // session has no worktree, so it always shows the committed diff.)
  if (session.running && !session.kept) {
    return <WorktreeChangesView repoPath={session.worktreePath} />;
  }
  if (!hasCommits) {
    return (
      <DiffPlaceholder
        icon={SparkleIcon}
        message="No changes yet. Send the agent a task in Conversation."
      />
    );
  }
  // Diff `base..branch` (not the cached headHash, which goes stale after a Keep
  // squashes the checkpoints). A kept session has no worktree, but its branch +
  // commits live in the shared object database, so read it from the main repo.
  return (
    <BranchDiffView
      repoPath={session.kept ? session.repoPath : session.worktreePath}
      base={session.base}
      compare={session.branch}
    />
  );
}
