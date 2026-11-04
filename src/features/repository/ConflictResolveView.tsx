import {
  ArrowClockwiseIcon,
  CheckIcon,
  SparkleIcon,
  WarningIcon,
  XIcon,
} from "@phosphor-icons/react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { ignoreHeldEnter } from "@/components/confirm-swap-focus";
import { PathText } from "@/components/path-text";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Spinner } from "@/components/ui/spinner";
import { GitDiffView } from "@/features/diff/DiffSurfaceLazy";
import { HighlightedCode } from "@/features/diff/HighlightedCode";
import { SPLIT_MIN_CONTAINER_PX } from "@/features/diff/split-threshold";
import { useFocusOnControlsSwap } from "@/features/diff/use-hidden-trigger-focus";
import {
  buildConflictPrompt,
  extractResolvedContent,
  withReferenceTrailingNewline,
} from "@/lib/ai/conflict-prompt";
import { aiExcludePatterns } from "@/lib/ai/ignore";
import { PROVIDER_LABELS } from "@/lib/ai/providers";
import { useAiTextStream } from "@/lib/ai/stream";
import { presentError } from "@/lib/error-summary";
import { readRepoInstructions } from "@/lib/git/api";
import {
  type ConflictSides,
  changedOnDiskCopy,
  conflictSides,
  diffContents,
} from "@/lib/git/conflict";
import { hasConflictMarkers } from "@/lib/git/conflict-parse";
import {
  type ConflictBlockReason,
  conflictAiBlockReason,
} from "@/lib/git/conflict-prefilter";
import { useResolveConflict } from "@/lib/git/queries";
import { useReviewConfigured, useSettings } from "@/lib/settings/queries";
import {
  useConflictResolve,
  walkGeneration,
} from "@/lib/stores/conflict-resolve";
import { isAppError } from "@/lib/tauri/invoke";
import { toastError } from "@/lib/toast";
import { useContainerWidth } from "@/lib/use-container-width";
import { useLatestRef } from "@/lib/use-latest-ref";
import { useToastClearance } from "@/lib/use-toast-clearance";
import { conflictPathRefusal, PANE_SCROLL_KEYS } from "./conflict-banner-state";
import { useRefuseIfMoved } from "./use-refuse-if-moved";

type Phase = "loading" | "streaming" | "ready" | "blocked" | "idle";
type ViewKey = "diff" | "proposed" | "ours" | "theirs" | "base";

const baseName = (path: string) => path.split("/").pop() || path;

/** Why a file never reaches the model, in the shared gate's priority. */
function blockedReason(sides: ConflictSides | null): ConflictBlockReason {
  return (sides && conflictAiBlockReason(sides)) ?? "excluded";
}

/** The non-UTF-8 arms name the byte-safe actions as the conflict editor words
 *  them, in place of the generic by-hand sentence the other two end with. */
const BLOCKED_COPY: Record<
  ConflictBlockReason,
  (fileName: string) => ReactNode
> = {
  undecodable: () =>
    "This file isn't UTF-8 text, so it isn't sent to a model: a text resolution couldn't keep its bytes exact. Use Accept all current or Accept all incoming in the conflict editor, or resolve it in your own editor.",
  partUndecodable: () =>
    "Part of this conflict isn't UTF-8 text, so it isn't sent to a model: a text resolution couldn't keep its bytes exact. Resolve it in the conflict editor, whose accepts keep the file's bytes exact, or in your own editor.",
  unreadableName: () =>
    "This file's name can't be read as text, so it isn't sent to a model. Resolve it by hand in your editor, then stage it.",
  excluded: (fileName) => (
    <>
      <span className="font-mono">{fileName}</span> matches your AI ignore
      patterns, so it isn't sent to a model. Resolve it by hand in your editor,
      then stage it.
    </>
  ),
};

/** A path-gate refusal's closing guidance, worded as the conflict editor words
 *  it: only a link at the path itself keeps Accept all there. */
const PATH_REFUSAL_GUIDANCE = {
  leaf: "Accept all current or incoming in the conflict editor can still resolve it: git replaces or removes the link itself, not what it points to.",
  other: "Resolve it in your editor or a terminal.",
} as const;

/** Where focus goes once Accept settles without leaving this view, pinned to
 *  the file it was armed for and the element focused at the press. */
type LandRequest = {
  repoPath: string;
  path: string;
  kind: "region" | "header";
  ordinal?: number;
  pressed: HTMLElement | null;
};

/**
 * Inline resolution surface for one conflicted file: asks the configured review
 * model to merge the file's sides, streams the proposal, shows it as a reviewable
 * diff (proposed-vs-ours) with the raw sides one click away, and applies it only
 * when the user accepts. Replaces the working-tree diff pane while a resolution
 * session is active for this file (see DiffViewer). Multi-provider, including
 * local Ollama and keyless CLI agents.
 */
export function ConflictResolveView({
  repoPath,
  path,
  focusSink,
}: {
  repoPath: string;
  path: string;
  /** The host's landing outside this view, which outlives it: an accept or a
   *  walk step unmounts the view. */
  focusSink?: RefObject<HTMLElement | null>;
}) {
  const settings = useSettings();
  const reviewAi = settings.data?.reviewAi;
  const reviewConfigured = useReviewConfigured();
  const { run, cancel, reset, generating, text, status } = useAiTextStream();
  const resolve = useResolveConflict(repoPath);
  const queue = useConflictResolve((s) => s.queue);
  const advance = useConflictResolve((s) => s.advance);
  const stop = useConflictResolve((s) => s.stop);

  const [phase, setPhase] = useState<Phase>("loading");
  const [sides, setSides] = useState<ConflictSides | null>(null);
  // A backend path-gate refusal from the sides read: it can't heal on a retry,
  // so the blocked screen names it instead of offering Try again.
  const [pathRefusal, setPathRefusal] = useState<{
    summary: string;
    linkedLeaf: boolean;
  } | null>(null);
  const [proposed, setProposed] = useState("");
  const [previewDiff, setPreviewDiff] = useState<string | null>(null);
  const [view, setView] = useState<ViewKey>("diff");
  // Bumped on each run so a superseded continuation (cancel / regenerate /
  // navigate-away) can't settle the shared state the newer run now owns.
  const genRef = useRef(0);
  // Whether a resolution is genuinely in flight. Tracked explicitly rather than
  // derived from phase/`generating`: both lag the decision points — `generating`
  // stays true across a cancel's kill round-trip, and the phase is still
  // "streaming" while the finished proposal is being diffed.
  const runningRef = useRef(false);
  // Set by the teardown below when it cut a session short, so the next setup can
  // tell a resumable interruption from a session that settled on its own. A
  // start() still before its stream reads it after every await and stops: its
  // view is gone (unmount) or hidden, and a show restarts it fresh.
  const interruptedRef = useRef(false);
  const textRef = useLatestRef(text);
  // Accept's live re-read runs before `resolve.isPending` turns on, so it holds
  // the action bar itself: the ref refuses a second press inside the same
  // frame, the state disables Skip/Discard/Regenerate and Escape for the read.
  const acceptingRef = useRef(false);
  const [accepting, setAccepting] = useState(false);
  const refuseIfMoved = useRefuseIfMoved(repoPath);
  // The resolve view shares the diff pane's width budget, so the preview takes
  // the same legibility gate: below it, render unified.
  const [paneRef, paneWidth] = useContainerWidth<HTMLDivElement>();
  // The action bar is mounted in every phase.
  const actionBarRef = useRef<HTMLDivElement>(null);
  useToastClearance(actionBarRef, true);
  const rootRef = useRef<HTMLDivElement>(null);
  const resolveSinkRef = useRef<HTMLSpanElement>(null);
  // Armed by an Accept that refused and left this view up; consumed by the
  // landing effect below once the hold drops.
  const [landRequest, setLandRequest] = useState<LandRequest | null>(null);
  // Set at Accept's press, cleared when its landing runs or when the user takes
  // the view over first (a click, wheel, touch or scroll key in it), so focus
  // that input left on <body> never reads as the accept's to move.
  const landPendingRef = useRef(false);
  const takeOverLanding = () => {
    landPendingRef.current = false;
  };
  // The blocked screen drops Try again; focus on it would fall to <body>.
  useFocusOnControlsSwap(phase === "blocked", resolveSinkRef);

  // Focus inside a view the host unmounts falls to <body>; the host's sink
  // outlives the view. Runs before React detaches this subtree.
  useLayoutEffect(() => {
    const root = rootRef.current;
    return () => {
      if (root?.contains(document.activeElement))
        focusSink?.current?.focus({ preventScroll: true });
    };
  }, [focusSink]);

  // Waits out the hold, so the Accept button is enabled again. Consumed
  // whether or not it lands: it never takes focus the user moved elsewhere or
  // took over the view from.
  const acceptBusy = resolve.isPending || accepting;
  useLayoutEffect(() => {
    if (landRequest === null || acceptBusy) return;
    setLandRequest(null);
    const pending = landPendingRef.current;
    landPendingRef.current = false;
    if (!pending) return;
    if (landRequest.repoPath !== repoPath || landRequest.path !== path) return;
    const active = document.activeElement;
    if (
      active !== null &&
      active !== document.body &&
      active !== landRequest.pressed
    )
      return;
    const pressed = landRequest.pressed;
    (pressed?.isConnected ? pressed : resolveSinkRef.current)?.focus({
      preventScroll: true,
    });
  }, [landRequest, acceptBusy, repoPath, path]);

  const markersLeft = phase === "ready" && hasConflictMarkers(proposed);

  async function start() {
    if (!reviewAi || !reviewConfigured) return;
    const gen = ++genRef.current;
    cancel();
    reset();
    setSides(null);
    setPathRefusal(null);
    setProposed("");
    setPreviewDiff(null);
    setPhase("loading");
    runningRef.current = true;

    let resolved: ConflictSides;
    try {
      // An unreadable repo ignore file must not abort a resolution the global
      // patterns alone can still serve.
      const exclude = await aiExcludePatterns(
        repoPath,
        settings.data?.aiIgnorePatterns ?? "",
        { tolerateRepoReadError: true },
      );
      resolved = await conflictSides(repoPath, path, exclude);
    } catch (e) {
      if (gen === genRef.current && !interruptedRef.current) {
        runningRef.current = false;
        // Only a path-gate refusal blocks; any other failure can heal, so it
        // keeps its toast and Try again. The blocked body names the refusal.
        const refusal = isAppError(e)
          ? conflictPathRefusal(e.kind, presentError(e).summary)
          : null;
        if (refusal !== null) {
          setPathRefusal(refusal);
          setPhase("blocked");
        } else {
          toastError(e);
          setPhase("idle");
        }
      }
      return;
    }
    if (gen !== genRef.current || interruptedRef.current) return;
    setSides(resolved);
    if (conflictAiBlockReason(resolved) !== null) {
      runningRef.current = false;
      setPhase("blocked");
      return;
    }

    const repoInstructions = await readRepoInstructions(repoPath).catch(
      () => null,
    );
    if (gen !== genRef.current || interruptedRef.current) return;
    const { system, prompt } = buildConflictPrompt({
      path,
      sides: resolved,
      repoInstructions,
      globalInstructions: settings.data?.globalInstructions ?? "",
    });
    setPhase("streaming");
    const completed = await run(reviewAi, { system, prompt, repoPath });
    if (gen !== genRef.current) return;
    runningRef.current = false;
    // A failed or cancelled run leaves a partial (or provider-error) buffer behind;
    // proposing a "resolution" from it would corrupt the file. The hook already
    // toasted a failure (cancels stay silent by design) — just let the user retry.
    if (!completed) {
      setPhase("idle");
      return;
    }

    // The diff's own reference side decides the trailing newline; a modify/delete
    // with no OURS falls back to the surviving file on disk.
    const merged = withReferenceTrailingNewline(
      extractResolvedContent(textRef.current),
      resolved.ours ?? resolved.working,
    );
    if (!merged.trim()) {
      // Nothing usable came back (empty response / immediate cancel) — let the
      // user retry rather than showing an empty diff.
      setPhase("idle");
      return;
    }
    setProposed(merged);
    let diffText: string | null = null;
    if (resolved.ours != null) {
      diffText = await diffContents(resolved.ours, merged).catch(() => null);
    }
    if (gen !== genRef.current) return;
    setPreviewDiff(diffText);
    // An empty diff (identical to ours) opens on the proposed file, like no diff.
    setView(diffText ? "diff" : "proposed");
    setPhase("ready");
  }

  // Auto-start once per mounted file. Remounts (keyed on path in DiffViewer) as
  // the resolve-all walk advances, so each conflict kicks off on arrival.
  // `<Activity>` replays this effect on every show, so only a fresh session or one
  // the teardown below interrupted restarts: a settled phase never restarts, and a
  // cancelled run waits behind Try again — it lands on the same "idle" phase as an
  // interrupted one, so the flag is what tells those two apart.
  const kickoff = useEffectEvent(() => {
    const resume = interruptedRef.current;
    interruptedRef.current = false;
    if (phase === "ready" || phase === "blocked") return;
    if (phase !== "loading" && !resume) return;
    void start();
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: start once per file
  useEffect(() => {
    kickoff();
  }, [path]);
  // DiffViewer swaps this view out (keyed on path) the moment another file is
  // selected, so without this a streaming resolution keeps billing into an
  // orphaned component; `<Activity>` hide runs it too. The flag marks a run this
  // teardown cut short — never a user cancel, never one that already settled.
  // Before the stream starts there is nothing to cancel (`run` clears the cancel
  // on entry), so the flag is what stops a start() still loading. Teardown never
  // bumps `genRef`: a hide would then strand a settling run on "streaming".
  useEffect(
    () => () => {
      if (runningRef.current) interruptedRef.current = true;
      cancel();
    },
    [cancel],
  );

  function handleCancel() {
    genRef.current++;
    runningRef.current = false;
    cancel();
    setPhase("idle");
  }

  // Ends the session; the bump retires a start() still loading the sides (Close
  // or Escape during the loading phase) even before the view unmounts and the
  // teardown's flag stops it too, so it never goes on to stream.
  function stopSession() {
    genRef.current++;
    stop();
  }

  // Awaited, not per-call callbacks: `<Activity>` hide tears this observer's
  // subscription down, and react-query drops per-call callbacks once an observer
  // has no listeners — the walk would stall pinned to an already-resolved file.
  async function accept() {
    if (acceptingRef.current) return;
    // Captured before any await: the hold disables the button and Chromium
    // blurs it to <body>. The refusal arms keep this view up and land focus.
    landPendingRef.current = true;
    const active = document.activeElement;
    const pressed =
      active instanceof HTMLElement && rootRef.current?.contains(active)
        ? active
        : null;
    const land = () =>
      setLandRequest({ repoPath, path, kind: "header", pressed });
    // A settled accept usually unmounts this view (the walk advances or the host
    // drops the staged file) while the disabled button's focus sits on <body>,
    // where the unmount hand-off can't see it: hand it to the host's sink first.
    // An unclean accept whose walk still shows this file (held by a Resolve all
    // reading for this tree, or re-armed onto it) keeps the view up, so it lands
    // back on the pressed control instead.
    const handOff = () => {
      landPendingRef.current = false;
      const now = document.activeElement;
      if (now === null || now === document.body || now === pressed)
        (focusSink?.current ?? resolveSinkRef.current)?.focus({
          preventScroll: true,
        });
    };
    acceptingRef.current = true;
    setAccepting(true);
    const gen = genRef.current;
    const walkGen = walkGeneration();
    const acceptIn = repoPath;
    // A staged file with markers left would ride Continue's commit, so a
    // marker-bearing proposal is written unstaged. The file stays conflicted and
    // the walk moves on, since the hand fix (open in editor, Mark resolved) lives
    // in the conflict editor; only a walk still on this file (a Resolve all
    // reading for this tree, or one re-armed onto it) holds it.
    const clean = !hasConflictMarkers(proposed);
    try {
      // Phase "ready" implies `sides`. Its hash, never the re-read's below, is
      // the expected value: the proposal was built from this read.
      if (!sides) return;
      const expected = sides.workingHash;
      // `sides` is the start-time read; the write refuses on the LIVE bytes, so a
      // file that stopped being UTF-8 since then never takes a lossy proposal.
      let fresh: ConflictSides;
      try {
        fresh = await conflictSides(acceptIn, path, []);
      } catch {
        toast.info(
          `${baseName(path)} couldn't be re-read — nothing was written.`,
        );
        land();
        return;
      }
      // A belt: `accepting` holds every control that could retire this accept
      // during the read, so only a restart moves the generation here (unmounts and
      // hides are refuseIfMoved's arms).
      if (gen !== genRef.current) return;
      if (
        refuseIfMoved(
          acceptIn,
          "nothing was written",
          "before the check finished",
        )
      )
        return;
      if (fresh.undecodable) {
        // A moved working file reads as changed on disk. An unmoved one was
        // decodable at the start read, so a stage version turned non-UTF-8.
        toast.info(
          fresh.workingHash !== expected
            ? changedOnDiskCopy(baseName(path))
            : `Part of the conflict in ${baseName(path)} isn't UTF-8 text, so the proposal wasn't applied. Resolve it in the conflict editor instead; its accepts keep the file's bytes exact.`,
        );
        land();
        return;
      }
      // A hash mismatch alone still goes to the backend, whose guard lets a
      // retry over its own landed write through.
      const outcome = await resolve.mutateAsync({
        path,
        content: proposed,
        stage: clean,
        expectedHash: expected,
      });
      // The proposal and Regenerate stay; only a Regenerate re-reads the sides
      // and refreshes the expected hash.
      if (outcome.kind === "changedOnDisk") {
        toast.info(changedOnDiskCopy(baseName(path)));
        land();
        return;
      }
      // This continuation can outlive the walk that armed it (another surface armed
      // its own walk, or the repo-switch clear fired) during the mutation, so both
      // the wording and the advance come from a fresh read gated on it still
      // being ours. The generation check also refuses a walk re-armed over this
      // same file (a Resolve all pressed during the write, or a self-heal that
      // already advanced past it), so one accept never advances twice.
      const walk = useConflictResolve.getState();
      const owns =
        walk.scopePath === repoPath &&
        walk.activePath === path &&
        walkGeneration() === walkGen;
      // A Resolve all reading for this tree replaces the walk at its arm (or the
      // self-heal moves on once it lands); advancing here would drop that run.
      const advances = owns && walk.prefiltering !== repoPath;
      if (clean) {
        toast.success(
          advances && walk.queue.length > 0
            ? `Resolved ${baseName(path)} — next conflict`
            : `Resolved ${baseName(path)}`,
        );
      } else {
        toast.warning(
          `Applied the proposal to ${baseName(path)} but left it unstaged — conflict markers remain. Fix the rest by hand, then mark it resolved.`,
        );
      }
      // Up only when the walk keeps this file and it stays conflicted.
      const leaves =
        advances ||
        clean ||
        walk.scopePath !== repoPath ||
        walk.activePath !== path;
      if (leaves) handOff();
      else land();
      // An empty queue ends the session, so a single-file resolve exits too.
      if (advances) walk.advance();
    } catch (e) {
      toastError(e);
      land();
    } finally {
      acceptingRef.current = false;
      setAccepting(false);
    }
  }

  // "Reject this proposal": in a resolve-all run, skip to the next file (leaving
  // this one conflicted); otherwise end the session.
  function reject() {
    if (queue.length > 0) advance();
    else stop();
  }

  const providerLabel = reviewAi
    ? PROVIDER_LABELS[reviewAi.provider]
    : "the review model";
  const model = reviewAi?.model || "review model";

  // `git diff --no-index` prints nothing for identical files. That empty diff gets
  // no tab (it would render blank) and a caption instead. The switcher only
  // mounts once the diff is settled, so the tab never vanishes under focus.
  const matchesOurs = previewDiff === "";
  const sideViews: { key: ViewKey; label: string; body: string | null }[] = [
    { key: "diff", label: "Diff", body: matchesOurs ? null : previewDiff },
    { key: "proposed", label: "Proposed", body: proposed },
    { key: "ours", label: "Ours", body: sides?.ours ?? null },
    { key: "theirs", label: "Theirs", body: sides?.theirs ?? null },
    { key: "base", label: "Base", body: sides?.base ?? null },
  ];

  return (
    <div
      ref={rootRef}
      className="ph-no-capture flex h-full flex-col"
      onPointerDownCapture={takeOverLanding}
      onWheelCapture={takeOverLanding}
      onTouchMoveCapture={takeOverLanding}
      onKeyDownCapture={(e) => {
        if (PANE_SCROLL_KEYS.has(e.key)) takeOverLanding();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !resolve.isPending && !accepting) {
          generating ? handleCancel() : stopSession();
        }
      }}
    >
      {/* Where focus goes when the control holding it leaves. */}
      <span ref={resolveSinkRef} tabIndex={-1} className="sr-only" />
      {/* Header — mirrors the diff pane's file bar */}
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <SparkleIcon className="size-3.5 shrink-0 text-primary" />
          <PathText
            path={path}
            className="font-mono text-xs text-muted-foreground"
          />
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {providerLabel} · {model}
        </span>
      </div>

      {queue.length > 0 && (
        <div className="border-b bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground">
          Resolving conflicts with AI — {queue.length} more after this.
        </div>
      )}

      {markersLeft && (
        <div className="flex items-center gap-2 border-b bg-warning/10 px-3 py-1.5 text-[11px] text-warning">
          <WarningIcon className="size-3.5 shrink-0" />
          <span>
            The proposal still has conflict markers — regenerate, or accept and
            fix the rest by hand.
          </span>
        </div>
      )}

      {/* View switcher (ready only) */}
      {phase === "ready" && (
        <div className="flex items-center gap-2 border-b px-3 py-1.5">
          <ButtonGroup aria-label="Resolution view">
            {sideViews
              .filter((v) => v.body != null)
              .map((v) => (
                <Button
                  key={v.key}
                  variant={view === v.key ? "secondary" : "ghost"}
                  size="xs"
                  onClick={() => setView(v.key)}
                >
                  {v.label}
                </Button>
              ))}
          </ButtonGroup>
          <span className="ml-auto text-[11px] text-muted-foreground">
            {(() => {
              switch (true) {
                case view === "diff":
                  return "Proposed changes vs. your side";
                case matchesOurs && view === "proposed":
                  return "Matches your side exactly, so accepting keeps your version";
                default:
                  return "Full file (read-only)";
              }
            })()}
          </span>
        </div>
      )}

      {/* Body */}
      <div ref={paneRef} className="min-h-0 flex-1 overflow-auto">
        {phase === "blocked" ? (
          <p className="p-4 text-xs text-muted-foreground">
            {pathRefusal !== null
              ? `${pathRefusal.summary} ${PATH_REFUSAL_GUIDANCE[pathRefusal.linkedLeaf ? "leaf" : "other"]}`
              : BLOCKED_COPY[blockedReason(sides)](baseName(path))}
          </p>
        ) : phase === "loading" ? (
          <p className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            Reading the conflict…
          </p>
        ) : phase === "streaming" || generating ? (
          <div className="p-3">
            <p className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3" />
              {status || `${providerLabel} is proposing a resolution…`}
            </p>
            <pre className="font-mono text-xs whitespace-pre-wrap wrap-break-word text-muted-foreground">
              {extractResolvedContent(text) || " "}
            </pre>
          </div>
        ) : phase === "ready" ? (
          view === "diff" && previewDiff ? (
            <GitDiffView
              filePath={path}
              text={previewDiff}
              repoPath={repoPath}
              forceUnified={
                paneWidth !== null && paneWidth < SPLIT_MIN_CONTAINER_PX
              }
            />
          ) : (
            <HighlightedCode
              path={path}
              content={sideViews.find((v) => v.key === view)?.body ?? ""}
            />
          )
        ) : (
          <p className="p-4 text-xs text-muted-foreground">
            {reviewConfigured
              ? "Couldn't get a resolution. Try again."
              : "Configure a review model in Settings → AI to resolve conflicts with AI."}
          </p>
        )}
      </div>

      {/* Action bar */}
      <div
        ref={actionBarRef}
        className="flex items-center gap-2 border-t px-3 py-2"
      >
        {generating ? (
          <Button variant="outline" size="sm" onClick={handleCancel}>
            <XIcon data-icon="inline-start" />
            Cancel
          </Button>
        ) : phase === "ready" ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={resolve.isPending || accepting}
              onClick={reject}
            >
              {queue.length > 0 ? "Skip" : "Discard"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={resolve.isPending || accepting}
              onClick={start}
            >
              <ArrowClockwiseIcon data-icon="inline-start" />
              Regenerate
            </Button>
            <Button
              size="sm"
              className="ml-auto"
              disabled={resolve.isPending || accepting}
              onClick={() => void accept()}
              // A refused accept hands focus back here; the Enter still held
              // from that press must not accept again.
              onKeyDown={ignoreHeldEnter}
            >
              {resolve.isPending || accepting ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <CheckIcon data-icon="inline-start" />
              )}
              {markersLeft ? "Accept" : "Accept & stage"}
            </Button>
          </>
        ) : (
          <>
            {/* Blocked files (AI-ignored, not UTF-8 text, or refused by the
                path gate) have no bypass: honoring the ignore, and keeping the
                bytes exact, is the point, and a refused path can't heal on a
                retry. Other idle states (cancelled / empty response) can retry. */}
            {phase !== "blocked" && (
              <Button
                variant="outline"
                size="sm"
                disabled={!reviewConfigured || phase === "loading"}
                onClick={start}
              >
                <SparkleIcon data-icon="inline-start" />
                Try again
              </Button>
            )}
            {/* Mid-run, let the user move past a skipped/blocked file without
                ending the whole resolve-all walk. */}
            {queue.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => advance()}>
                Skip to next
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={stopSession}
            >
              {queue.length > 0 ? "Stop" : "Close"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
