import { SparkleIcon } from "@phosphor-icons/react";
import { useMemo } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { HighlightedCode } from "@/features/diff/HighlightedCode";
import { hasConflictMarkers } from "@/lib/ai/conflict-prompt";
import { openWithDefault, openWithProgram } from "@/lib/git/api";
import type { ConflictSides } from "@/lib/git/conflict";
import {
  type ConflictChoice,
  parseConflictSegments,
  resolveBlock,
} from "@/lib/git/conflict-parse";
import {
  useCheckoutConflictSide,
  useConflictFile,
  useResolveConflict,
} from "@/lib/git/queries";
import { isWindows } from "@/lib/hotkeys/binding";
import {
  useAiEnabled,
  useReviewConfigured,
  useSettings,
} from "@/lib/settings/queries";
import { useConflictResolve } from "@/lib/stores/conflict-resolve";
import { toastError } from "@/lib/toast";

const baseName = (path: string) => path.split("/").pop() || path;

/** Which side has no version at this path, when exactly one of them does — the
 *  modify/delete shape. `null` for a content conflict (both sides present) and
 *  when both are absent, neither of which is about a removal to accept. */
function deletedSide(sides: ConflictSides): "ours" | "theirs" | null {
  const ourGone = sides.ours == null;
  if (ourGone === (sides.theirs == null)) return null;
  return ourGone ? "ours" : "theirs";
}

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

/**
 * What a conflicted file shows when the parser found no regions to resolve: a
 * side with no version at this path, an empty file, or markers it can't trust.
 * Each keeps the header's whole-file actions as the way through.
 */
function ConflictFallback({
  path,
  sides,
}: {
  path: string;
  sides: ConflictSides;
}) {
  // The index stages decide first: a modify/delete leaves the SURVIVING side's
  // content in the tree, marker-free, so the parser's null here means a removal
  // to accept rather than markers it failed on. Ordered ahead of the empty-file
  // check, which is a heuristic and would swallow a surviving side that is empty.
  const deleted = deletedSide(sides);
  if (deleted !== null) {
    const copy = DELETION_COPY[deleted];
    return (
      <>
        <p className="border-b bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
          {copy.lead} <span className="font-medium">{copy.takesDeletion}</span>{" "}
          takes the deletion,{" "}
          <span className="font-medium">{copy.keepsFile}</span> keeps the file.
        </p>
        <HighlightedCode path={path} content={sides.working || " "} />
      </>
    );
  }

  if (sides.working.trim() === "") {
    // A both-deleted (or empty) conflict — nothing to merge as text.
    return (
      <p className="p-4 text-xs text-muted-foreground">
        This file was deleted on one or both sides — there's nothing to merge.
        Take a side with <span className="font-medium">Accept all current</span>{" "}
        / <span className="font-medium">incoming</span>, or open it in your
        editor.
      </p>
    );
  }

  // Couldn't parse the markers cleanly (malformed or ambiguous, e.g. a bare
  // 7-char marker inside the content) — show the raw file so nothing is hidden,
  // and keep the whole-file actions in the header.
  return (
    <>
      <p className="border-b bg-warning/10 px-3 py-1.5 text-[11px] text-warning">
        Couldn't cleanly parse the conflict markers in this file. Resolve it
        with the header actions or in your editor.
      </p>
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
  const aiEnabled = useAiEnabled();
  const reviewConfigured = useReviewConfigured();
  const startResolveAi = useConflictResolve((s) => s.startOne);
  const settings = useSettings();

  const segments = useMemo(
    () => (file.data ? parseConflictSegments(file.data.working) : null),
    [file.data],
  );

  // Include the post-accept refetch (file.isFetching) so the per-region buttons
  // stay disabled until fresh segments land — otherwise a fast second click
  // resolves against stale segments and resurrects an already-resolved region.
  const busy = resolve.isPending || checkoutSide.isPending || file.isFetching;
  // A binary / too-large conflict can't be text-merged (the backend refuses to
  // read it); offer only whole-file resolution + the editor.
  const textResolvable = !file.isError;
  const canAi = aiEnabled && reviewConfigured && textResolvable;

  const sep = isWindows ? "\\" : "/";
  const absPath = `${repoPath}${sep}${path.replaceAll("/", sep)}`;
  const editorPath = (settings.data?.externalEditor ?? "").trim();

  function openInEditor() {
    const open = editorPath
      ? openWithProgram(editorPath, absPath)
      : openWithDefault(absPath);
    open.catch(toastError);
  }

  function acceptRegion(index: number, choice: ConflictChoice) {
    if (!segments) return;
    const content = resolveBlock(segments, index, choice);
    // Stage once the last marker is gone — same end state as the AI flow.
    const stage = !hasConflictMarkers(content);
    resolve.mutate(
      { path, content, stage },
      {
        onSuccess: () => {
          if (stage) toast.success(`Resolved ${baseName(path)}`);
        },
        onError: toastError,
      },
    );
  }

  function acceptAll(side: "ours" | "theirs") {
    checkoutSide.mutate(
      { path, side },
      {
        onSuccess: () =>
          toast.success(
            `Resolved ${baseName(path)} — took ${side === "ours" ? "current" : "incoming"}`,
          ),
        onError: toastError,
      },
    );
  }

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
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-xs text-muted-foreground">
            {path}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <Button size="xs" variant="ghost" onClick={openInEditor}>
            Open in editor
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => acceptAll("ours")}
          >
            Accept all current
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => acceptAll("theirs")}
          >
            Accept all incoming
          </Button>
          {canAi && (
            <Button
              size="xs"
              disabled={busy}
              onClick={() => startResolveAi(path)}
            >
              <SparkleIcon data-icon="inline-start" />
              Resolve with AI
            </Button>
          )}
        </span>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto">
        {file.isPending ? (
          <p className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            Reading the conflict…
          </p>
        ) : file.isError ? (
          <p className="p-4 text-xs text-muted-foreground">
            This looks like a binary or oversized conflict, so it can't be
            merged as text. Take a side with{" "}
            <span className="font-medium">Accept all current</span> /{" "}
            <span className="font-medium">incoming</span>, or open it in your
            editor.
          </p>
        ) : segments === null ? (
          <ConflictFallback path={path} sides={file.data} />
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
