import {
  CaretDownIcon,
  CaretRightIcon,
  CopyIcon,
  PencilSimpleIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { Markdown } from "@/components/markdown/markdown";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { copyText } from "@/lib/clipboard";
import { useForgeStatus } from "@/lib/git/queries";
import type { RemoteLens } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import {
  useClearReviews,
  useDeleteReview,
  useReviewHistory,
  useReviewPartials,
  useUpdateReviewText,
} from "@/lib/pulls/queries";
import {
  isPartialReview,
  partialReviewReason,
  reviewText,
} from "@/lib/pulls/reviews-history";
import { formatDuration, validEpochMs } from "@/lib/time";
import { ThoughtsDisclosure } from "./ThoughtsDisclosure";

/**
 * The "Previous reviews" disclosure — past AI reviews for this PR (both modes) plus
 * any kept partial output from a run that stopped early, each expandable to its text.
 * The latest completed review per mode is what the next run feeds as soft context, so
 * those rows are **editable** ("trim before re-running"): deleting a false finding here
 * persists, and the trimmed text is what travels next round. Kept partials feed nothing,
 * so they offer no trim. Rows are arrow-key navigable; every text surface is
 * `ph-no-capture` (it quotes the user's source + AI output).
 */
export function ReviewHistory({
  repoPath,
  lens,
  prKind,
  prRef,
}: {
  repoPath: string;
  /** The origin|upstream lens the PR was opened under — a fork's two lenses keep
   *  separate histories for the same PR number. */
  lens: RemoteLens;
  prKind: "remote" | "local";
  prRef: string;
}) {
  // Stored review text cites `#N` the same way a live run does, so it linkifies
  // against this repo's forge.
  const provider = useForgeStatus(repoPath).data?.provider;
  const refs = provider ? { provider, repoPath, lens } : undefined;
  const history = useReviewHistory(repoPath, lens, prKind, prRef);
  const partials = useReviewPartials(repoPath, lens, prKind, prRef);
  const del = useDeleteReview(repoPath, lens, prKind, prRef);
  const clear = useClearReviews(repoPath, lens, prKind, prRef);
  const update = useUpdateReviewText(repoPath, lens, prKind, prRef);
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  // ONE list: completed reviews and kept partial runs interleave by time, so the
  // disclosure, its count, and the arrow-key walk all cover every stored record — a PR
  // whose only record is a kept partial still gets its row (and its Clear).
  const partialRecords = partials.data ?? [];
  const records = [...(history.data ?? []), ...partialRecords].sort(
    (a, b) => b.finishedAt - a.finishedAt,
  );
  if (records.length === 0) return null;

  function toggleExpand(id: string) {
    setEditingId(null);
    setExpandedId((cur) => (cur === id ? null : id));
  }

  function startEdit(id: string, text: string) {
    setExpandedId(id);
    setEditingId(id);
    setDraft(text);
  }

  // Awaited rather than per-call mutate callbacks: an `<Activity>` tab hide tears
  // this observer's subscription down mid-write, and react-query drops per-call
  // callbacks once an observer has no listeners — the edit row would stay open and
  // the confirm would stay armed. The catches do nothing: neither this surface nor
  // the shared review-history mutation has a failure surface.
  async function saveEdit(id: string) {
    try {
      await update.mutateAsync({ id, text: draft });
      setEditingId(null);
    } catch {
      // No failure surface (see above).
    }
  }

  async function clearHistory() {
    try {
      await clear.mutateAsync(undefined);
    } catch {
      // No failure surface (see above).
    } finally {
      setConfirmingClear(false);
    }
  }

  const onKeyDown = listKeyboardNav({
    items: records,
    activeIndex,
    onActivate: (_item, to) => setActiveIndex(to),
    rowKey: (r) => r.id,
    ignoreTextEntry: true,
  });

  return (
    <div className="text-xs">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? (
            <CaretDownIcon className="size-3" />
          ) : (
            <CaretRightIcon className="size-3" />
          )}
          Previous reviews ({records.length})
        </button>
        {open &&
          (confirmingClear ? (
            <span className="ml-auto flex items-center gap-1">
              {/* Clearing takes the kept partials with it (the store's filter carries no
                  phase test), so say so whenever there is one to lose. */}
              <span className="text-muted-foreground">
                {partialRecords.length > 0
                  ? "Clear this PR's history, including the kept partial output?"
                  : "Clear this PR's history?"}
              </span>
              <Button
                variant="ghost"
                size="xs"
                className="text-destructive"
                disabled={clear.isPending}
                onClick={() => void clearHistory()}
              >
                Yes
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setConfirmingClear(false)}
              >
                No
              </Button>
            </span>
          ) : (
            <Button
              variant="ghost"
              size="xs"
              className="ml-auto text-muted-foreground"
              onClick={() => setConfirmingClear(true)}
            >
              Clear history
            </Button>
          ))}
      </div>

      {open && (
        <div role="list" className="mt-1 space-y-1" onKeyDown={onKeyDown}>
          {records.map((r) => {
            const expanded = expandedId === r.id;
            const editing = editingId === r.id;
            // Total run duration — only on records with both stamps and a
            // positive span. Note: records saved before the runtime-display
            // change stamped `startedAt` at enqueue (queue wait included);
            // newer ones stamp at run start — historical durations mix the two.
            // `validEpochMs`, not `typeof === "number"`: this shares the
            // timestamp's gate so that duration present ⇒ `finishedAt` renders,
            // and the "·" below can never dangle. Only that direction holds —
            // a valid stamp with no positive span shows the time alone.
            const duration =
              validEpochMs(r.startedAt) &&
              validEpochMs(r.finishedAt) &&
              r.finishedAt - r.startedAt > 0
                ? formatDuration(r.finishedAt - r.startedAt)
                : null;
            const partial = isPartialReview(r);
            return (
              <div key={r.id} role="listitem" className="border">
                <div className="flex items-center gap-2 px-2 py-1">
                  <button
                    type="button"
                    data-row={r.id}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    aria-expanded={expanded}
                    onFocus={() =>
                      setActiveIndex(records.findIndex((x) => x.id === r.id))
                    }
                    onClick={() => toggleExpand(r.id)}
                  >
                    {expanded ? (
                      <CaretDownIcon className="size-3 shrink-0" />
                    ) : (
                      <CaretRightIcon className="size-3 shrink-0" />
                    )}
                    <Badge variant="secondary" className="shrink-0">
                      {r.mode === "security" ? "Security" : "Review"}
                    </Badge>
                    {/* Says in words what the tone shows — kept output is not a review. */}
                    {partial && (
                      <Badge
                        variant="outline"
                        className="shrink-0 border-warning/40 bg-warning/10 text-warning"
                      >
                        {partialReviewReason(r).timedOut
                          ? "Timed out — partial output"
                          : "Stopped early"}
                      </Badge>
                    )}
                    <span className="truncate font-mono text-muted-foreground">
                      {r.model || "model"}
                    </span>
                    <span className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground">
                      {duration && (
                        <>
                          <span className="tabular-nums">{duration}</span>
                          <span aria-hidden>·</span>
                        </>
                      )}
                      {validEpochMs(r.finishedAt) && (
                        <span>
                          <RelativeTime
                            date={new Date(r.finishedAt).toISOString()}
                          />
                        </span>
                      )}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={
                      partial
                        ? "Delete this kept partial output from history"
                        : "Delete this review from history"
                    }
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => del.mutate(r.id)}
                  >
                    <TrashIcon className="size-3.5" />
                  </button>
                </div>

                {expanded && (
                  <div className="ph-no-capture border-t p-2">
                    {editing ? (
                      <div className="space-y-2">
                        <Textarea
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          rows={8}
                          className="max-h-72 min-h-24 resize-y font-mono text-xs"
                          aria-label="Edit the previous review's findings"
                        />
                        <div className="flex items-center gap-2">
                          <Button
                            size="xs"
                            disabled={update.isPending}
                            onClick={() => void saveEdit(r.id)}
                          >
                            Save
                          </Button>
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => setEditingId(null)}
                          >
                            Cancel
                          </Button>
                          <span className="text-muted-foreground">
                            Trimmed text is what the next review builds on.
                          </span>
                        </div>
                      </div>
                    ) : (
                      <>
                        {/* Capped + self-scrolling: an expanded review is arbitrarily long,
                            and this disclosure sits in the panel's fixed header, above the
                            Close/Merge controls. */}
                        <div className="max-h-64 overflow-y-auto">
                          <Markdown refs={refs}>{reviewText(r)}</Markdown>
                          {r.thoughts?.trim() && (
                            <ThoughtsDisclosure thoughts={r.thoughts} />
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          {/* Kept output feeds no later run, so it gets no trim — only the
                              copy path, since it may be the only copy left. */}
                          {!partial && (
                            <Button
                              variant="ghost"
                              size="xs"
                              className="text-muted-foreground"
                              onClick={() => startEdit(r.id, reviewText(r))}
                            >
                              <PencilSimpleIcon data-icon="inline-start" />
                              Trim before re-running
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="xs"
                            className="text-muted-foreground"
                            onClick={() =>
                              copyText(
                                reviewText(r),
                                partial
                                  ? "Partial output copied"
                                  : "Review copied",
                              )
                            }
                          >
                            <CopyIcon data-icon="inline-start" />
                            Copy
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
