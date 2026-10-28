import {
  ArrowCounterClockwiseIcon,
  ArrowDownIcon,
  SparkleIcon,
} from "@phosphor-icons/react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { quickTransition } from "@/lib/motion";
import { useToastClearance } from "@/lib/use-toast-clearance";
import { cn } from "@/lib/utils";
import { AgentNarration } from "./AgentNarration";
import { AgentTranscript } from "./AgentTranscript";
import { SessionComposer, type SessionComposerHandle } from "./SessionComposer";
import { type AgentSession, type SessionTurn, useSessionsStore } from "./store";

/**
 * The conversation column of the agent canvas: a document-style log of turns
 * (your prompt, then the agent's streamed narration + per-turn status), with a
 * composer pinned at the bottom for follow-ups. Auto-scrolls to the newest
 * output while you're at the bottom, but yields if you've scrolled up to read —
 * a "Latest" affordance brings you back so the composer is never lost. Each turn
 * can be reloaded into the composer to edit and resend (handy after a failure).
 */
export function SessionConversation({
  session,
  repoPath,
  terminalOpen,
}: {
  session: AgentSession;
  repoPath: string;
  /** The terminal dock is open below this column. */
  terminalOpen: boolean;
}) {
  const resume = useSessionsStore((s) => s.resume);
  const busy = useSessionsStore((s) => s.busyId === session.id);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<SessionComposerHandle>(null);
  // With the terminal dock open below it, the bottom bar sits mid-window, clear
  // of the toasts' corner, so lifting them would only strand them.
  const bottomBarRef = useRef<HTMLDivElement>(null);
  useToastClearance(bottomBarRef, !terminalOpen);
  // Whether the view is pinned to the bottom (so streaming output keeps it
  // there). `atBottom` mirrors it for rendering the "Latest" button; `stick`
  // is read by the auto-scroll effect without a stale closure.
  const stick = useRef(true);
  // True while a smooth "jump to latest" animates, so onScroll ignores the
  // intermediate positions (otherwise the button flickers back in mid-scroll).
  const jumping = useRef(false);
  const [atBottom, setAtBottom] = useState(true);

  const last = session.turns[session.turns.length - 1];
  // A cheap signature of everything that grows during streaming, so the
  // auto-scroll effect fires on each delta without deep-watching the array.
  const streamSig = `${session.turns.length}:${last?.narration.length ?? 0}:${last?.statusText ?? ""}:${last?.status ?? ""}`;
  const prevLen = useRef(session.turns.length);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || jumping.current) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stick.current = bottom;
    setAtBottom(bottom);
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = true;
    setAtBottom(true);
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduce) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    // Smooth-scroll to the bottom, ignoring scroll events until it settles.
    jumping.current = true;
    const clear = () => {
      jumping.current = false;
      el.removeEventListener("scrollend", clear);
    };
    el.addEventListener("scrollend", clear);
    window.setTimeout(clear, 1000); // fallback if `scrollend` doesn't fire
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-pin on each stream delta
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // A brand-new turn means the user just sent one — always jump to it. While a
    // turn streams, only keep pinned if they're already at the bottom.
    const grew = session.turns.length > prevLen.current;
    prevLen.current = session.turns.length;
    if (stick.current || grew) el.scrollTop = el.scrollHeight;
  }, [streamSig]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="h-full overflow-y-auto"
        >
          <div className="mx-auto flex max-w-3xl flex-col gap-6 p-4">
            {session.turns.map((turn, i) => (
              <TurnView
                key={`${i}:${turn.prompt.slice(0, 32)}`}
                turn={turn}
                baseDir={session.kept ? session.repoPath : session.worktreePath}
                // Inline edit-step diffs need the live worktree (freed once kept)
                // and the base to diff against; omitted for kept sessions. While the
                // session runs, the worktree keeps changing, so an open diff polls.
                editDiffBase={session.kept ? undefined : session.base}
                editDiffLive={session.running}
                resendable={!session.kept}
                onEditResend={() => composerRef.current?.setPrompt(turn.prompt)}
              />
            ))}
          </div>
        </div>
        <AnimatePresence>
          {!atBottom && (
            // Centering = left-1/2 + motion x:-50% (NOT a -translate-x-1/2
            // class — motion owns the x transform so it can compose with the
            // animated y; re-adding that class would double-center it off-screen).
            <m.button
              key="latest"
              type="button"
              onClick={jumpToLatest}
              style={{ x: "-50%" }}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={quickTransition}
              className="absolute bottom-3 left-1/2 flex items-center gap-1.5 border bg-background px-2.5 py-1 text-[11px] font-medium shadow-sm transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
            >
              <ArrowDownIcon className="size-3.5" />
              Latest
            </m.button>
          )}
        </AnimatePresence>
      </div>
      <div ref={bottomBarRef} className="shrink-0 border-t p-2">
        {session.kept ? (
          <div className="flex items-center gap-2 px-1 py-1">
            <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">
              Kept on <span className="font-mono">{session.branch}</span> —
              resume to continue the conversation.
            </span>
            <Button
              size="sm"
              className="shrink-0"
              disabled={busy}
              onClick={() => resume(session.id)}
            >
              Resume
            </Button>
          </div>
        ) : (
          <SessionComposer
            repoPath={repoPath}
            session={session}
            handleRef={composerRef}
          />
        )}
      </div>
    </div>
  );
}

function RoleLabel({ children, agent }: { children: string; agent?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground/70">
      {agent && <SparkleIcon className="size-3.5 text-primary" />}
      {children}
    </div>
  );
}

function TurnView({
  turn,
  baseDir,
  editDiffBase,
  editDiffLive,
  resendable,
  onEditResend,
}: {
  turn: SessionTurn;
  baseDir: string;
  /** Session base commit for inline edit-step diffs (undefined = kept session). */
  editDiffBase?: string;
  /** The session is still running, so an open edit diff polls to stay fresh. */
  editDiffLive?: boolean;
  /** Whether edit & resend is available (false for a kept session — no composer). */
  resendable: boolean;
  onEditResend: () => void;
}) {
  const running = turn.status === "running" || turn.status === "committing";
  // A turn that finished with no narration and no commit (or errored) produced
  // nothing — offer to edit & resend it so a failure is easy to retry. Normal,
  // successful turns stay clean (recall any prompt with ↑/↓ in the composer).
  const unproductive =
    resendable &&
    !running &&
    (turn.status === "error" || (!turn.commitHash && !turn.narration));
  return (
    <div className="flex flex-col gap-3 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1">
      <div className="flex flex-col gap-1.5">
        <RoleLabel>You</RoleLabel>
        <div className="bg-muted/50 px-3 py-2 text-xs leading-relaxed break-words whitespace-pre-wrap">
          {turn.prompt}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <RoleLabel agent>Agent</RoleLabel>
        {turn.segments?.length ? (
          <AgentTranscript
            segments={turn.segments}
            baseDir={baseDir}
            editDiffBase={editDiffBase}
            editDiffLive={editDiffLive}
          />
        ) : turn.narration ? (
          // Reloaded session (segments are in-memory) or a whole-message agent.
          <AgentNarration text={turn.narration} baseDir={baseDir} />
        ) : (
          !running &&
          turn.status !== "error" && (
            <p className="px-0.5 text-xs text-muted-foreground">No response.</p>
          )
        )}
        <TurnStatus
          turn={turn}
          running={running}
          canResend={unproductive}
          onEditResend={onEditResend}
        />
      </div>
    </div>
  );
}

function TurnStatus({
  turn,
  running,
  canResend,
  onEditResend,
}: {
  turn: SessionTurn;
  running: boolean;
  /** Show the resend control (a turn that produced nothing / errored). */
  canResend: boolean;
  onEditResend: () => void;
}) {
  const cancelled = turn.status === "error" && turn.error === "Cancelled.";
  const failed = turn.status === "error" && !cancelled;
  const text = running
    ? turn.statusText ||
      (turn.status === "committing" ? "Committing this turn…" : "Working…")
    : turn.status === "error"
      ? (turn.error ?? "Failed")
      : turn.commitHash
        ? "Committed"
        : "No changes";

  return (
    <div
      className={cn(
        "mt-0.5 flex items-center gap-1.5 px-0.5 text-[11px]",
        failed ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {running && <Spinner className="size-3" />}
      <span aria-live={running ? "polite" : undefined}>{text}</span>
      {turn.costUsd != null && (
        <span className="tabular-nums">· ${turn.costUsd.toFixed(3)}</span>
      )}
      {!running && canResend && (
        <button
          type="button"
          onClick={onEditResend}
          title="Edit & resend"
          className="ml-1 inline-flex items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none"
        >
          <ArrowCounterClockwiseIcon className="size-3" />
          Edit &amp; resend
        </button>
      )}
    </div>
  );
}
