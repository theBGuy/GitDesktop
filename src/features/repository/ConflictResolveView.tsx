import {
  ArrowClockwiseIcon,
  CheckIcon,
  SparkleIcon,
  WarningIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Spinner } from "@/components/ui/spinner";
import { GitDiffView } from "@/features/diff/DiffSurfaceLazy";
import { HighlightedCode } from "@/features/diff/HighlightedCode";
import { SPLIT_MIN_CONTAINER_PX } from "@/features/diff/split-threshold";
import {
  buildConflictPrompt,
  extractResolvedContent,
  hasConflictMarkers,
} from "@/lib/ai/conflict-prompt";
import { aiExcludePatterns } from "@/lib/ai/ignore";
import { PROVIDER_LABELS } from "@/lib/ai/providers";
import { useAiTextStream } from "@/lib/ai/stream";
import { readRepoInstructions } from "@/lib/git/api";
import {
  type ConflictSides,
  conflictSides,
  diffContents,
} from "@/lib/git/conflict";
import { useResolveConflict } from "@/lib/git/queries";
import { useReviewConfigured, useSettings } from "@/lib/settings/queries";
import { useConflictResolve } from "@/lib/stores/conflict-resolve";
import { toastError } from "@/lib/toast";
import { useContainerWidth } from "@/lib/use-container-width";
import { useLatestRef } from "@/lib/use-latest-ref";

type Phase = "loading" | "streaming" | "ready" | "blocked" | "idle";
type ViewKey = "diff" | "proposed" | "ours" | "theirs" | "base";

const baseName = (path: string) => path.split("/").pop() || path;

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
}: {
  repoPath: string;
  path: string;
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
  const [proposed, setProposed] = useState("");
  const [previewDiff, setPreviewDiff] = useState<string | null>(null);
  const [view, setView] = useState<ViewKey>("diff");
  // Bumped on each run so a superseded continuation (cancel / regenerate /
  // navigate-away) can't settle the shared state the newer run now owns.
  const genRef = useRef(0);
  const textRef = useLatestRef(text);
  // The resolve view shares the diff pane's width budget, so the preview takes
  // the same legibility gate: below it, render unified.
  const [paneRef, paneWidth] = useContainerWidth<HTMLDivElement>();

  const markersLeft = phase === "ready" && hasConflictMarkers(proposed);

  async function start() {
    if (!reviewAi || !reviewConfigured) return;
    const gen = ++genRef.current;
    cancel();
    reset();
    setSides(null);
    setProposed("");
    setPreviewDiff(null);
    setPhase("loading");

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
      if (gen === genRef.current) {
        toastError(e);
        setPhase("idle");
      }
      return;
    }
    if (gen !== genRef.current) return;
    setSides(resolved);
    if (resolved.aiIgnored) {
      setPhase("blocked");
      return;
    }

    const repoInstructions = await readRepoInstructions(repoPath).catch(
      () => null,
    );
    if (gen !== genRef.current) return;
    const { system, prompt } = buildConflictPrompt({
      path,
      sides: resolved,
      repoInstructions,
      globalInstructions: settings.data?.globalInstructions ?? "",
    });
    setPhase("streaming");
    const completed = await run(reviewAi, { system, prompt, repoPath });
    if (gen !== genRef.current) return;
    // A failed or cancelled run leaves a partial (or provider-error) buffer behind;
    // proposing a "resolution" from it would corrupt the file. The hook already
    // toasted a failure (cancels stay silent by design) — just let the user retry.
    if (!completed) {
      setPhase("idle");
      return;
    }

    const merged = extractResolvedContent(textRef.current);
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
    setView(diffText ? "diff" : "proposed");
    setPhase("ready");
  }

  // Set by the teardown below when it cut a session short, so the next setup can
  // tell a resumable interruption from a session that settled on its own.
  const interruptedRef = useRef(false);
  // Auto-start once per mounted file. Remounts (keyed on path in DiffViewer) as
  // the resolve-all walk advances, so each conflict kicks off on arrival.
  // `<Activity>` replays this effect on every show, so only a fresh session or one
  // the teardown below interrupted restarts: a settled phase always wins (a hide
  // between the run and `setPhase("ready")` flags an interruption the result then
  // overtakes), and a cancelled run waits behind Try again — it settles on the same
  // "idle" phase as an interrupted one, so the flag is what tells those two apart.
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
  const inFlightRef = useLatestRef(
    phase === "loading" || phase === "streaming" || generating,
  );
  // DiffViewer swaps this view out (it's keyed on path) the moment another file
  // is selected, so without this an in-flight resolution keeps streaming — and
  // billing — into an orphaned component. `<Activity>` hide runs it too, hence the
  // flag: only what this cut short is the kickoff's to resume. A hide during the
  // pre-stream read cancels nothing (the run hasn't started, and it clears the
  // cancel flag when it does), so that one session streams on until the restart.
  useEffect(
    () => () => {
      if (inFlightRef.current) interruptedRef.current = true;
      cancel();
    },
    [cancel],
  );

  function handleCancel() {
    genRef.current++;
    cancel();
    setPhase("idle");
  }

  // Awaited, not per-call callbacks: `<Activity>` hide tears this observer's
  // subscription down, and react-query drops per-call callbacks once an observer
  // has no listeners — the walk would stall pinned to an already-resolved file.
  async function accept() {
    try {
      await resolve.mutateAsync({ path, content: proposed, stage: true });
      toast.success(
        queue.length > 0
          ? `Resolved ${baseName(path)} — next conflict`
          : `Resolved ${baseName(path)}`,
      );
      advance();
    } catch (e) {
      toastError(e);
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

  const sideViews: { key: ViewKey; label: string; body: string | null }[] = [
    { key: "diff", label: "Diff", body: previewDiff },
    { key: "proposed", label: "Proposed", body: proposed },
    { key: "ours", label: "Ours", body: sides?.ours ?? null },
    { key: "theirs", label: "Theirs", body: sides?.theirs ?? null },
    { key: "base", label: "Base", body: sides?.base ?? null },
  ];

  return (
    <div
      className="ph-no-capture flex h-full flex-col"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !resolve.isPending) {
          generating ? handleCancel() : stop();
        }
      }}
    >
      {/* Header — mirrors the diff pane's file bar */}
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <SparkleIcon className="size-3.5 shrink-0 text-primary" />
          <span className="truncate font-mono text-xs text-muted-foreground">
            {path}
          </span>
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
          <ButtonGroup>
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
            {view === "diff"
              ? "Proposed changes vs. your side"
              : "Full file (read-only)"}
          </span>
        </div>
      )}

      {/* Body */}
      <div ref={paneRef} className="min-h-0 flex-1 overflow-auto">
        {phase === "blocked" ? (
          <p className="p-4 text-xs text-muted-foreground">
            <span className="font-mono">{baseName(path)}</span> matches your AI
            ignore patterns, so it isn't sent to a model. Resolve it by hand in
            your editor, then stage it.
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
      <div className="flex items-center gap-2 border-t px-3 py-2">
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
              disabled={resolve.isPending}
              onClick={reject}
            >
              {queue.length > 0 ? "Skip" : "Discard"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={resolve.isPending}
              onClick={start}
            >
              <ArrowClockwiseIcon data-icon="inline-start" />
              Regenerate
            </Button>
            <Button
              size="sm"
              className="ml-auto"
              disabled={resolve.isPending}
              onClick={() => void accept()}
            >
              {resolve.isPending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <CheckIcon data-icon="inline-start" />
              )}
              Accept &amp; stage
            </Button>
          </>
        ) : (
          <>
            {/* AI-ignored files have no bypass — honoring the ignore is the point.
                Other idle states (cancelled / empty response) can retry. */}
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
              <Button variant="ghost" size="sm" onClick={advance}>
                Skip to next
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={stop}
            >
              {queue.length > 0 ? "Stop" : "Close"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
