import {
  CaretDownIcon,
  CaretRightIcon,
  PencilSimpleIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { Textarea } from "@/components/ui/textarea";
import type { RemoteLens } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import {
  useClearReviews,
  useDeleteReview,
  useReviewHistory,
  useUpdateReviewText,
} from "@/lib/pulls/queries";
import { formatDuration, formatRelativeTime } from "@/lib/time";
import { ThoughtsDisclosure } from "./ThoughtsDisclosure";

/**
 * The "Previous reviews" disclosure — past AI reviews for this PR (both modes),
 * each expandable to its text. The latest per mode is what the next run feeds as
 * soft context, so each row is **editable** ("trim before re-running"): deleting
 * a false finding here persists, and the trimmed text is what travels next round.
 * Rows are arrow-key navigable; every text surface is `ph-no-capture` (it quotes
 * the user's source + AI output).
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
  const history = useReviewHistory(repoPath, lens, prKind, prRef);
  const del = useDeleteReview(repoPath, lens, prKind, prRef);
  const clear = useClearReviews(repoPath, lens, prKind, prRef);
  const update = useUpdateReviewText(repoPath, lens, prKind, prRef);
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const records = history.data ?? [];
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

  function saveEdit(id: string) {
    update.mutate({ id, text: draft }, { onSuccess: () => setEditingId(null) });
  }

  const onKeyDown = listKeyboardNav({
    items: records,
    activeIndex,
    onActivate: (_item, to) => setActiveIndex(to),
    rowKey: (r) => r.id,
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
              <span className="text-muted-foreground">
                Clear this PR's history?
              </span>
              <Button
                variant="ghost"
                size="xs"
                className="text-destructive"
                disabled={clear.isPending}
                onClick={() =>
                  clear.mutate(undefined, {
                    onSettled: () => setConfirmingClear(false),
                  })
                }
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
            const duration =
              typeof r.startedAt === "number" &&
              typeof r.finishedAt === "number" &&
              r.finishedAt - r.startedAt > 0
                ? formatDuration(r.finishedAt - r.startedAt)
                : null;
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
                      <span>
                        {formatRelativeTime(
                          new Date(r.finishedAt).toISOString(),
                        )}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label="Delete this review from history"
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
                            onClick={() => saveEdit(r.id)}
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
                        <Markdown>{r.text}</Markdown>
                        {r.thoughts?.trim() && (
                          <ThoughtsDisclosure thoughts={r.thoughts} />
                        )}
                        <Button
                          variant="ghost"
                          size="xs"
                          className="mt-1 text-muted-foreground"
                          onClick={() => startEdit(r.id, r.text)}
                        >
                          <PencilSimpleIcon data-icon="inline-start" />
                          Trim before re-running
                        </Button>
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
