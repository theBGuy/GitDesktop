import { SparkleIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { InfoNote } from "@/components/info-note";
import { usePanelActive } from "@/components/panel-portal";
import { PathText } from "@/components/path-text";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { HighlightedCode } from "@/features/diff/HighlightedCode";
import { gitStatus, openWithDefault, openWithProgram } from "@/lib/git/api";
import { type ConflictSides, conflictSides } from "@/lib/git/conflict";
import {
  type ConflictChoice,
  deletedSide,
  type FallbackArm,
  fallbackArm,
  hasConflictMarkers,
  MARK_RESOLVED_ARMS,
  markNeedsConfirm,
  noLongerConflicted,
  parseConflictSegments,
  resolveBlock,
} from "@/lib/git/conflict-parse";
import {
  refreshConflictFile,
  repoKeys,
  useCheckoutConflictSide,
  useConflictFile,
  useMarkConflictResolved,
  useResolveConflict,
} from "@/lib/git/queries";
import { isWindows } from "@/lib/hotkeys/binding";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import {
  useAiEnabled,
  useReviewConfigured,
  useSettings,
} from "@/lib/settings/queries";
import { useConfirm } from "@/lib/stores/confirm";
import { useConflictResolve } from "@/lib/stores/conflict-resolve";
import { type AppError, isAppError } from "@/lib/tauri/invoke";
import { toastError } from "@/lib/toast";
import { useLatestRef } from "@/lib/use-latest-ref";
import { markerStagePrompt } from "./conflict-confirms";
import { useRefuseIfMoved } from "./use-refuse-if-moved";

const baseName = (path: string) => path.split("/").pop() || path;

/** The `notConflicted` line, and the reason the header's whole-file actions
 *  hold under it. */
const NOT_CONFLICTED_COPY = "This file is no longer conflicted.";

/** Why the per-region accepts are off for a non-UTF-8 working file: they
 *  rebuild the file from its lossy decode. Names the byte-safe actions as the
 *  header buttons word them. */
const CONFLICT_UNDECODABLE_NOTE =
  "This file isn't UTF-8 text, so it resolves as a whole to keep its bytes exact. Use Accept all current, Accept all incoming, or Open in editor.";

/** Why Resolve with AI holds over a non-UTF-8 working file: the proposal would
 *  be written back from its lossy decode. */
const AI_UNDECODABLE_REASON =
  "This file isn't UTF-8 text, so AI resolution would change its bytes.";

/** The whole-file sides, worded as the header buttons word them. */
const ACCEPT_ALL_COPY = {
  ours: { side: "current", other: "incoming" },
  theirs: { side: "incoming", other: "current" },
} as const;

/** What taking a whole side actually does, given which side (if either) has no
 *  version at this path; `unclassified` when no sides read has landed. */
type AcceptAllArm = "content" | "takesDeletion" | "keepsFile" | "unclassified";

/** One body per outcome: a modify/delete conflict doesn't "replace" anything —
 *  the backend runs `git rm` for a removing side and re-checks the file out
 *  whole for a surviving one. */
const ACCEPT_ALL_BODY: Record<
  AcceptAllArm,
  (name: string, side: string, other: string) => string
> = {
  content: (name, side, other) =>
    `Replaces ${name} with the whole ${side} version, including any conflict regions you already resolved by hand. The ${other} changes to this file are discarded.`,
  takesDeletion: (name, side, other) =>
    `The ${side} side removed ${name}, so this deletes the file from your working tree and index. The ${other} side's changes to it are discarded.`,
  keepsFile: (name, side, other) =>
    `Keeps ${name} whole as the ${side} side left it, replacing what's in your working tree now. The ${other} side removed the file, and that removal is discarded.`,
  unclassified: (name, side, other) =>
    `Takes the ${side} side for ${name}: its version, or its removal if that side deleted the file. The ${other} side's changes and any conflict regions you already resolved by hand are discarded.`,
};

/** The notice per removing side. "Removed" rather than "deleted": a side that
 *  renamed the file away also has no version at this path. */
const DELETION_COPY = {
  ours: {
    lead: "The current branch removed this file; the incoming change edited it (below).",
    takesDeletion: "Accept all current",
    keepsFile: "Accept all incoming",
  },
  theirs: {
    lead: "The incoming change removed this file; the current branch edited it (below).",
    takesDeletion: "Accept all incoming",
    keepsFile: "Accept all current",
  },
} as const;

/** The error pane's copy per failed-read kind: the backend refuses a binary or
 *  oversized file as invalidArgument; `io` covers a lock, a permission change,
 *  or a directory at the path (a conflicted submodule), none promised to pass.
 *  Other kinds take the fallback. */
const READ_ERROR_COPY: Partial<Record<AppError["kind"], ReactNode>> = {
  invalidArgument: (
    <>
      This looks like a binary or oversized conflict, so it can't be merged as
      text. Take a side with{" "}
      <span className="font-medium">Accept all current</span> /{" "}
      <span className="font-medium">incoming</span>, or open it in your editor.
    </>
  ),
  io: "Couldn't read this file. It may be locked, its permissions may have changed, or a folder (such as a conflicted submodule) may sit at this path. Open it in your editor to resolve the conflict, or try again if it becomes readable.",
};
const READ_ERROR_FALLBACK =
  "Couldn't read this file, so it can't be shown here. Resolve the conflict in your editor.";

/** The two working-file states with no text to show, each worded for what
 *  staging it actually records (content vs. a removal). */
const EMPTIED_COPY: Record<
  "emptiedOnDisk" | "emptiedGone",
  { state: string; action: string }
> = {
  emptiedOnDisk: {
    state: "You've emptied this file",
    action: "stages it exactly as it is on disk.",
  },
  emptiedGone: {
    state: "This file is gone from your working tree",
    action: "stages the removal.",
  },
};

/**
 * What a conflicted file shows when the parser found no regions to resolve: a
 * side with no version at this path, an empty file, content already resolved
 * outside the app, or markers it can't trust. Each keeps the header's
 * whole-file actions as the way through; the arms in `MARK_RESOLVED_ARMS` also
 * offer Mark resolved, which confirms first while markers remain. A path that
 * is no longer conflicted gets a plain line until the host drops this pane.
 */
function ConflictFallback({
  path,
  sides,
  arm,
  busy,
  onMarkResolved,
}: {
  path: string;
  sides: ConflictSides;
  arm: FallbackArm;
  busy: boolean;
  onMarkResolved: () => void;
}) {
  const markButton = MARK_RESOLVED_ARMS.has(arm) ? (
    <Button
      size="xs"
      variant="outline"
      disabled={busy}
      onClick={onMarkResolved}
    >
      Mark resolved
    </Button>
  ) : null;
  const markersRemain = markNeedsConfirm(sides);

  if (arm === "notConflicted") {
    return (
      <p className="p-4 text-xs text-muted-foreground">{NOT_CONFLICTED_COPY}</p>
    );
  }

  if (arm === "deletion" || arm === "deletionEdited") {
    // The arm doesn't carry WHICH side removed the file, and the notice names
    // it. Both deletion arms come from a non-null `deletedSide` (asserted).
    const copy = DELETION_COPY[deletedSide(sides) as "ours" | "theirs"];
    const lead = (
      <>
        {copy.lead} <span className="font-medium">{copy.takesDeletion}</span>{" "}
        takes the deletion,{" "}
        <span className="font-medium">{copy.keepsFile}</span> keeps the file.
      </>
    );
    return (
      <>
        {arm === "deletionEdited" ? (
          <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
            <p className="min-w-0 flex-1">
              {lead} You've edited this file —{" "}
              <span className="font-medium">Mark resolved</span> keeps it
              exactly as shown.
              {markersRemain &&
                " It still has conflict markers, so you'll be asked before they're staged."}
            </p>
            {markButton}
          </div>
        ) : (
          <p className="border-b bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
            {lead}
          </p>
        )}
        <HighlightedCode path={path} content={sides.working || " "} />
      </>
    );
  }

  if (arm === "emptiedOnDisk" || arm === "emptiedGone") {
    return (
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
        <p className="min-w-0 flex-1">
          {EMPTIED_COPY[arm].state} —{" "}
          <span className="font-medium">Mark resolved</span>{" "}
          {EMPTIED_COPY[arm].action}
        </p>
        {markButton}
      </div>
    );
  }

  if (arm === "bothDeleted") {
    // Nothing to merge as text, and nothing on disk worth staging as-is.
    return (
      <p className="p-4 text-xs text-muted-foreground">
        This file was deleted on both sides — there's nothing to merge. Take a
        side with <span className="font-medium">Accept all current</span> /{" "}
        <span className="font-medium">incoming</span>, or open it in your
        editor.
      </p>
    );
  }

  if (arm === "externallyResolved") {
    return (
      <>
        <div className="flex items-center gap-2 border-b bg-success/10 px-3 py-1.5 text-[11px] text-success">
          <p className="min-w-0 flex-1">
            No conflict markers remain — this file looks resolved. Review it,
            then <span className="font-medium">Mark resolved</span> to stage it
            exactly as it is on disk.
          </p>
          {markButton}
        </div>
        <HighlightedCode path={path} content={sides.working} />
      </>
    );
  }

  // Couldn't parse the markers cleanly (malformed or ambiguous, e.g. a bare
  // 7-char marker inside the content) — show the raw file so nothing is hidden.
  // The markerless form is an entry with only its base stage but real content.
  return (
    <>
      <div className="flex items-center gap-2 border-b bg-warning/10 px-3 py-1.5 text-[11px] text-warning">
        <p className="min-w-0 flex-1">
          {markersRemain ? (
            <>
              Couldn't cleanly parse the conflict markers in this file. Take a
              side with the header actions, or fix it in your editor and then{" "}
              <span className="font-medium">Mark resolved</span>. While markers
              remain, you'll be asked before they're staged.
            </>
          ) : (
            <>
              Couldn't tell how this conflict should resolve. Review the file,
              then <span className="font-medium">Mark resolved</span> to stage
              it exactly as it is on disk, or take a side with the header
              actions.
            </>
          )}
        </p>
        {markButton}
      </div>
      <HighlightedCode path={path} content={sides.working} />
    </>
  );
}

/**
 * The conflicted-file editor: renders the file with git's conflict markers
 * resolved into reviewable regions. Each region shows Current (ours) over
 * Incoming (theirs) with per-region Accept current / incoming / both; the header
 * offers whole-file Accept all current / all incoming, Open in editor, and
 * (when configured) Resolve with AI. Replaces the diff pane for a conflicted
 * file when no AI session is active. Works with AI off — only the AI button is
 * gated.
 */
export function ConflictFileView({
  repoPath,
  path,
}: {
  repoPath: string;
  path: string;
}) {
  const file = useConflictFile(repoPath, path);
  const resolve = useResolveConflict(repoPath);
  const checkoutSide = useCheckoutConflictSide(repoPath);
  const markResolve = useMarkConflictResolved(repoPath);
  // Whether the view moved to another repo, or went away, while a prompt was
  // open or Mark resolved's re-read ran. A prompt never reaches the closed arm
  // (the confirm store cancels a repo-scoped prompt on a close); the re-read can.
  const refuseIfMoved = useRefuseIfMoved(repoPath);
  const aiEnabled = useAiEnabled();
  const reviewConfigured = useReviewConfigured();
  const startResolveAi = useConflictResolve((s) => s.startOne);
  const settings = useSettings();
  const queryClient = useQueryClient();
  const [recovering, setRecovering] = useState(false);
  const [checking, setChecking] = useState(false);
  // Set synchronously by every write handler and cleared only after its write
  // and re-read: a second click inside the render that disables the buttons
  // would otherwise resolve against the segments the first write replaced.
  const inFlightRef = useRef(false);

  // The file this view last saw a read land for since it mounted or its panel
  // last showed. Cleared on every hide and unmount, so a cached entry, as old
  // as the time off-screen, never reaches live buttons. Joins a read already
  // in flight (the mount's own) rather than spawning a second one.
  const panelActive = usePanelActive();
  const refetchFile = file.refetch;
  const [freshFor, setFreshFor] = useState<{
    repoPath: string;
    path: string;
  } | null>(null);
  useEffect(() => {
    if (!panelActive) return;
    let current = true;
    void refetchFile({ cancelRefetch: false }).then(() => {
      if (current) setFreshFor({ repoPath, path });
    });
    return () => {
      current = false;
      setFreshFor(null);
    };
  }, [panelActive, refetchFile, repoPath, path]);
  const awaitingRead =
    freshFor?.repoPath !== repoPath || freshFor.path !== path;

  // A read with no index stages renders the no-longer-conflicted line whatever
  // the text holds, so no region offers an Accept on a path git calls merged.
  const segments = useMemo(
    () =>
      file.data && !noLongerConflicted(file.data)
        ? parseConflictSegments(file.data.working)
        : null,
    [file.data],
  );

  // Each mutation re-reads the conflict file before its isPending drops, a
  // failed one re-reads under `recovering`, Mark resolved's click-time read
  // holds under `checking`, and a mount or show waits for its own read
  // (`awaitingRead`), so the buttons stay disabled until fresh segments land:
  // a click on stale segments would resurrect a resolved region. Fetch state
  // stays out of it, so poll ticks neither flicker the buttons nor re-render
  // the view.
  const busy =
    resolve.isPending ||
    checkoutSide.isPending ||
    markResolve.isPending ||
    checking ||
    recovering ||
    awaitingRead;
  // A conflict the backend wouldn't read (binary, too large, or unreadable)
  // can't be text-merged; offer only whole-file resolution + the editor.
  const textResolvable = !file.isError;
  // The working file alone: per-region accepts rebuild from it, so a clean
  // working file over a non-UTF-8 stage blob stays lossless for them. The AI
  // button holds on it too, but deliberately leaves that blob-only case to
  // ConflictResolveView's `undecodable` block, which keeps the AI flow safe there.
  const workingUndecodable = file.data?.workingUndecodable === true;
  // Offered exactly as for a UTF-8 file; a non-UTF-8 one disables it with a
  // reason instead of hiding it.
  const offersAi = aiEnabled && reviewConfigured && textResolvable;
  // The fire-time belt reads this: a committed Accept's closure predates a flip.
  const workingUndecodableRef = useLatestRef(workingUndecodable);

  const sep = isWindows ? "\\" : "/";
  const absPath = `${repoPath}${sep}${path.replaceAll("/", sep)}`;
  const editorPath = (settings.data?.externalEditor ?? "").trim();

  function openInEditor() {
    const open = editorPath
      ? openWithProgram(editorPath, absPath)
      : openWithDefault(absPath);
    open.catch(toastError);
  }

  // A failed write invalidates nothing (the mutations refresh only on success),
  // and a partial failure (content written, stage failed) must not leave the
  // buttons enabled over stale segments. Keys follow the prop: a PR's resolve
  // worktree hosts this view as well as the open repo.
  async function refreshAfterError() {
    setRecovering(true);
    try {
      await refreshConflictFile(queryClient, repoPath);
    } finally {
      setRecovering(false);
    }
  }

  async function acceptRegion(index: number, choice: ConflictChoice) {
    if (inFlightRef.current || !segments) return;
    if (workingUndecodableRef.current) {
      toast.info(CONFLICT_UNDECODABLE_NOTE);
      return;
    }
    const content = resolveBlock(segments, index, choice);
    // Stage once the last marker is gone — same end state as the AI flow.
    const stage = !hasConflictMarkers(content);
    inFlightRef.current = true;
    try {
      await resolve.mutateAsync({ path, content, stage });
      if (stage) toast.success(`Resolved ${baseName(path)}`);
    } catch (e) {
      toastError(e);
      await refreshAfterError();
    } finally {
      inFlightRef.current = false;
    }
  }

  async function acceptAll(side: "ours" | "theirs") {
    // Nothing records which regions were resolved by hand, so every arm warns
    // unconditionally: taking a side re-checks the file out from the index and
    // any manual work in it goes with the other side. Classifies from the last
    // successful read; when none has landed (the first read failed) a deleting
    // side can't be ruled out, so the unclassified arm names both outcomes.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const copy = ACCEPT_ALL_COPY[side];
      const name = baseName(path);
      const deleted = file.data ? deletedSide(file.data) : null;
      const arm: AcceptAllArm = (() => {
        switch (true) {
          case !file.data:
            return "unclassified";
          case deleted === null:
            return "content";
          case deleted === side:
            return "takesDeletion";
          default:
            return "keepsFile";
        }
      })();
      const acceptIn = repoPath;
      const ok = await useConfirm.getState().ask({
        title: `Accept all ${copy.side} in ${name}?`,
        body: ACCEPT_ALL_BODY[arm](name, copy.side, copy.other),
        confirmLabel: `Accept all ${copy.side}`,
        confirmVariant: "destructive",
      });
      if (!ok || refuseIfMoved(acceptIn, "nothing was resolved")) return;
      try {
        await checkoutSide.mutateAsync({ path, side });
        toast.success(
          `Resolved ${baseName(path)} — took ${side === "ours" ? "current" : "incoming"}`,
        );
      } catch (e) {
        toastError(e);
        await refreshAfterError();
      }
    } finally {
      inFlightRef.current = false;
    }
  }

  // Which fallback state is on screen, and so whether Mark resolved is offered.
  // Gated on !isError as well as data: a refetch that errors (the file became
  // unreadable, binary or oversized) keeps the last data while the pane shows
  // the error copy.
  const arm =
    file.data && !file.isError && segments === null
      ? fallbackArm(file.data)
      : null;
  const canMarkResolved = arm !== null && MARK_RESOLVED_ARMS.has(arm);

  // A staging write's re-read lands before git status is even requested, and an
  // outside `git add` can beat the status poll: refresh status once, so the host
  // drops this pane. Restarts a status read already in flight, since one begun
  // before an outside `git add` still lists the path as unmerged.
  const notConflicted = arm === "notConflicted";
  useEffect(() => {
    if (!notConflicted) return;
    void queryClient.invalidateQueries({ queryKey: repoKeys.status(repoPath) });
  }, [notConflicted, queryClient, repoPath]);

  const aiHeldReason = (() => {
    switch (true) {
      case notConflicted:
        return NOT_CONFLICTED_COPY;
      case workingUndecodable:
        return AI_UNDECODABLE_REASON;
      default:
        return null;
    }
  })();

  // The button and the palette action both land here, so this is the one gate:
  // staging is a plain `git add`, which would take any remaining markers along.
  // It asks the generic stage routes' question, from their shared builder. The
  // question is decided by a read taken at the click, called straight: the
  // view's last read (or a poll joined via fetchQuery) can predate the save.
  async function markResolved() {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const markIn = repoPath;
      let fresh: ConflictSides;
      setChecking(true);
      try {
        fresh = await conflictSides(repoPath, path, []);
      } catch {
        toast.info("Couldn't re-read the file — nothing was marked resolved.");
        await refreshAfterError();
        return;
      } finally {
        setChecking(false);
      }
      if (
        refuseIfMoved(
          markIn,
          "nothing was marked resolved",
          "before the check finished",
        )
      )
        return;
      if (markNeedsConfirm(fresh)) {
        const flag = { name: baseName(path), unchecked: false };
        const ok = await useConfirm
          .getState()
          .ask(markerStagePrompt([flag], false));
        if (!ok || refuseIfMoved(markIn, "nothing was marked resolved")) return;
      }
      try {
        await markResolve.mutateAsync(path);
        toast.success(`Resolved ${baseName(path)}`);
      } catch (e) {
        // A stale click: the path can be resolved elsewhere (an AI walk, another
        // window) between render and click, leaving NO index entry, and `git
        // add` then exits 128 on a pathspec matching nothing. Only a
        // still-conflicted path is a real failure; a failed status read falls
        // back to the error. The hold starts before that read, so the buttons
        // stay disabled across it.
        setRecovering(true);
        const status = await gitStatus(repoPath).catch(() => null);
        const resolvedElsewhere = status?.entries.every(
          (entry) =>
            entry.path !== path ||
            (entry.staged !== "conflicted" && entry.unstaged !== "conflicted"),
        );
        if (!resolvedElsewhere) toastError(e);
        await refreshAfterError();
      }
    } finally {
      inFlightRef.current = false;
    }
  }

  // Palette-only; enabled with the button, busy state included, so the palette
  // can't fire a second stage while one is in flight.
  useHotkeyAction(
    "mark-conflict-resolved",
    markResolved,
    canMarkResolved && !busy,
  );

  // Precompute each segment's conflict ordinal (its index among conflicts, for
  // resolveBlock) up front, so the render map only reads a stable array rather
  // than mutating a counter captured by the per-region onClick lambdas.
  const conflictOrdinals: (number | null)[] = [];
  let conflictSeen = -1;
  for (const seg of segments ?? []) {
    conflictOrdinals.push(seg.kind === "context" ? null : ++conflictSeen);
  }

  return (
    <div className="ph-no-capture flex h-full flex-col">
      {/* Header toolbar — calm, neutral; whole-file + AI actions */}
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <PathText
          path={path}
          className="font-mono text-xs text-muted-foreground"
        />
        <span className="flex shrink-0 items-center gap-1.5">
          <Button size="xs" variant="ghost" onClick={openInEditor}>
            Open in editor
          </Button>
          {/* Held on a path git calls merged: Accept all re-checks the file out
              from the index, over any edits made after an outside `git add`. */}
          <DisabledReasonButton
            size="xs"
            variant="outline"
            disabled={busy || notConflicted}
            reason={notConflicted ? NOT_CONFLICTED_COPY : null}
            onClick={() => acceptAll("ours")}
          >
            Accept all current
          </DisabledReasonButton>
          <DisabledReasonButton
            size="xs"
            variant="outline"
            disabled={busy || notConflicted}
            reason={notConflicted ? NOT_CONFLICTED_COPY : null}
            onClick={() => acceptAll("theirs")}
          >
            Accept all incoming
          </DisabledReasonButton>
          {offersAi && (
            // This view's OWN repoPath scopes the walk — the main repo on the
            // Changes tab, the hidden worktree in a PR takeover.
            <DisabledReasonButton
              size="xs"
              disabled={busy || notConflicted || workingUndecodable}
              reason={aiHeldReason}
              onClick={() => startResolveAi(path, repoPath)}
            >
              <SparkleIcon data-icon="inline-start" />
              Resolve with AI
            </DisabledReasonButton>
          )}
        </span>
      </div>

      {/* Only over the region view: the fallback arms already resolve whole. */}
      {!file.isError && segments !== null && workingUndecodable && (
        <InfoNote className="shrink-0">{CONFLICT_UNDECODABLE_NOTE}</InfoNote>
      )}

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto">
        {file.isPending ? (
          <p className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            Reading the conflict…
          </p>
        ) : file.isError ? (
          <p className="p-4 text-xs text-muted-foreground">
            {(isAppError(file.error) && READ_ERROR_COPY[file.error.kind]) ||
              READ_ERROR_FALLBACK}
          </p>
        ) : segments === null ? (
          <ConflictFallback
            path={path}
            sides={file.data}
            // Non-null on this branch: it's the same data + `segments === null`
            // + not-error condition `arm` was computed under.
            arm={arm as FallbackArm}
            busy={busy}
            onMarkResolved={markResolved}
          />
        ) : (
          segments.map((seg, idx) => {
            if (seg.kind === "context") {
              return seg.text === "" ? null : (
                <HighlightedCode
                  key={`ctx-${idx}`}
                  path={path}
                  content={seg.text}
                  className="px-3 py-1"
                />
              );
            }
            // Non-context segments always have an ordinal (asserted non-null).
            const index = conflictOrdinals[idx] as number;
            return (
              <div
                key={`conflict-${idx}`}
                className="border-y border-warning/40"
              >
                <div className="flex items-center gap-2 bg-muted/40 px-3 py-1 text-[11px]">
                  <span className="font-medium text-muted-foreground">
                    Conflict
                  </span>
                  <span className="flex-1" />
                  {!workingUndecodable && (
                    <>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => acceptRegion(index, "current")}
                      >
                        Accept current
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => acceptRegion(index, "incoming")}
                      >
                        Accept incoming
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => acceptRegion(index, "both")}
                      >
                        Both
                      </Button>
                    </>
                  )}
                </div>
                <div className="bg-success/5">
                  <div className="px-3 py-0.5 text-[10px] font-medium text-success">
                    Current (ours)
                    {seg.currentLabel ? ` · ${seg.currentLabel}` : ""}
                  </div>
                  <HighlightedCode
                    path={path}
                    content={seg.current || " "}
                    className="px-3 py-1"
                  />
                </div>
                <div className="bg-info/5">
                  <div className="px-3 py-0.5 text-[10px] font-medium text-info">
                    Incoming (theirs)
                    {seg.incomingLabel ? ` · ${seg.incomingLabel}` : ""}
                  </div>
                  <HighlightedCode
                    path={path}
                    content={seg.incoming || " "}
                    className="px-3 py-1"
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
