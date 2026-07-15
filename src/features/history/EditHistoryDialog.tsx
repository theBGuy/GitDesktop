import {
  ArrowDownIcon,
  ArrowUpIcon,
  CaretDownIcon,
  SparkleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  useRebaseEdit,
  useRewriteCommits,
  useUnpushedMessages,
} from "@/lib/git/queries";
import type { CommitSummary } from "@/lib/git/types";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { useLatestRef } from "@/lib/use-latest-ref";
import { cn } from "@/lib/utils";
import { compilePlan, type EditRow, type RowAction } from "./edit-history-plan";
import { useGenerateSquashMessage } from "./RewriteDialogs";

/** Action labels + one-line descriptions for the per-row picker. */
const ACTIONS: { value: RowAction; label: string; hint: string }[] = [
  { value: "pick", label: "Pick", hint: "Keep this commit as-is" },
  {
    value: "reword",
    label: "Reword",
    hint: "Keep the changes, edit the message",
  },
  {
    value: "squash",
    label: "Squash",
    hint: "Merge into the commit below, combine messages",
  },
  {
    value: "fixup",
    label: "Fixup",
    hint: "Merge into the commit below, keep its message",
  },
  {
    value: "edit",
    label: "Edit",
    hint: "Stop to amend this commit's changes",
  },
  { value: "drop", label: "Drop", hint: "Remove this commit entirely" },
];
const ACTION_LABEL = new Map(ACTIONS.map((a) => [a.value, a.label]));

/**
 * The unified interactive-rebase editor over the unpushed tip (`base..HEAD`).
 * Each row picks an action (pick / reword / squash / fixup / drop), reorders
 * with ↑/↓, and edits its message inline; the plan compiles to the replay
 * engine, which applies it atomically (any conflict rolls back untouched).
 */
export function EditHistoryDialog({
  repoPath,
  base,
  commits,
  open,
  onOpenChange,
  onDone,
}: {
  repoPath: string;
  base: string;
  /** Editable unpushed commits, newest-first (matches the history list). */
  commits: CommitSummary[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const rewrite = useRewriteCommits(repoPath);
  const rebaseEdit = useRebaseEdit(repoPath);
  const setRepoTab = useUiStore((s) => s.setRepoTab);
  const messages = useUnpushedMessages(repoPath, base, open);

  const [order, setOrder] = useState<string[]>(() =>
    commits.map((c) => c.hash),
  );
  const [actions, setActions] = useState<Record<string, RowAction>>({});
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  // Reseed when a different set of commits arrives (render-time adjustment, the
  // same pattern as ReorderDialog).
  const key = commits.map((c) => c.hash).join();
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setOrder(commits.map((c) => c.hash));
    setActions({});
    setOverrides({});
  }

  const subjectOf = useMemo(
    () => new Map(commits.map((c) => [c.hash, c.subject])),
    [commits],
  );
  const fullMessages = messages.data ?? {};

  // Per-row AI message generation (reword only — a single commit's own diff).
  // The hash lives in state so render can read which row is generating; the ref
  // mirrors it for the async completion callback (which fires after streaming).
  const [genHash, setGenHash] = useState<string | null>(null);
  const genHashRef = useLatestRef(genHash);
  const ai = useGenerateSquashMessage(repoPath, (message) => {
    const h = genHashRef.current;
    if (h) setOverrides((o) => ({ ...o, [h]: message }));
  });

  const rows: EditRow[] = useMemo(
    () =>
      order.map((hash) => {
        const action = actions[hash] ?? "pick";
        const subject = subjectOf.get(hash) ?? hash.slice(0, 7);
        // The full original message (or subject until it loads); compilePlan
        // uses it only for reword/squash leaders and squash contributions.
        const message = overrides[hash] ?? fullMessages[hash] ?? subject;
        return { hash, subject, action, message };
      }),
    [order, actions, overrides, subjectOf, fullMessages],
  );

  const originalHashes = useMemo(() => commits.map((c) => c.hash), [commits]);
  const plan = useMemo(
    () => compilePlan(rows, originalHashes),
    [rows, originalHashes],
  );
  // reword/squash bake the message into the rewrite, so they can't be applied
  // until the full bodies have loaded — otherwise a multi-line body would be
  // silently truncated to its subject.
  const needsMessages = rows.some(
    (r) => r.action === "reword" || r.action === "squash",
  );

  function setAction(hash: string, action: RowAction) {
    setActions((a) => ({ ...a, [hash]: action }));
  }

  function move(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
  }

  const busy = rewrite.isPending || rebaseEdit.isPending;
  function apply() {
    if (plan.error || !plan.changed) return;
    if (plan.hasEdit) {
      // Resumable path: starts a real rebase that pauses at the first Edit —
      // the conflict/op banner in Changes takes it from there.
      rebaseEdit.mutate(
        { base, steps: plan.steps },
        {
          onSuccess: () => {
            toast.success("Rebase started — paused to edit a commit");
            onOpenChange(false);
            setRepoTab("changes");
            onDone();
          },
          onError: (e) => toastError(e),
        },
      );
      return;
    }
    rewrite.mutate(
      { base, steps: plan.steps },
      {
        onSuccess: () => {
          toast.success(
            plan.resultCount === 1
              ? "History rewritten into one commit"
              : `History rewritten — ${plan.resultCount} commits`,
          );
          onOpenChange(false);
          onDone();
        },
        onError: (e) => toastError(e),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit history</DialogTitle>
          <DialogDescription>
            Reshape your unpushed commits — reword, squash, fixup, drop, or
            reorder. Newest on top. This rewrites local history; if replaying
            hits a conflict, nothing is changed.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-px overflow-y-auto border">
          {rows.map((row, index) => {
            const view = plan.views[index];
            const dropped = row.action === "drop";
            return (
              <div
                key={row.hash}
                className="border-b last:border-b-0 data-[dropped=true]:bg-muted/30"
                data-dropped={dropped}
              >
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={busy}
                          className="w-20 justify-between"
                          aria-label={`Action for ${row.subject}`}
                        >
                          {ACTION_LABEL.get(row.action)}
                          <CaretDownIcon />
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="start" className="min-w-56">
                      {ACTIONS.map((a) => (
                        <DropdownMenuItem
                          key={a.value}
                          onClick={() => setAction(row.hash, a.value)}
                          className="flex-col items-start gap-0.5"
                        >
                          <span className="text-xs font-medium">{a.label}</span>
                          <span className="text-[11px] text-muted-foreground">
                            {a.hint}
                          </span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>

                  <span className="font-mono text-[11px] text-muted-foreground">
                    {row.hash.slice(0, 7)}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-xs",
                      dropped && "text-muted-foreground line-through",
                    )}
                  >
                    {row.subject}
                  </span>
                  {view.foldInto && (
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      ↳ {view.foldInto}
                    </span>
                  )}
                  {row.action === "edit" && (
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      ↳ pauses to amend
                    </span>
                  )}
                  {dropped && (
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      removed
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Move ${row.subject} up`}
                    disabled={index === 0 || busy}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUpIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Move ${row.subject} down`}
                    disabled={index === order.length - 1 || busy}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDownIcon />
                  </Button>
                </div>

                {view.showMessage && (
                  <div className="space-y-1 px-2 pb-2 pl-24">
                    <Textarea
                      aria-label={`Message for ${row.subject}`}
                      rows={row.action === "squash" ? 4 : 3}
                      // Disabled until the full bodies load, so editing can't
                      // capture a subject-only message and drop the body.
                      disabled={busy || !messages.isSuccess}
                      placeholder={
                        messages.isLoading ? "Loading message…" : undefined
                      }
                      className="max-h-40 min-h-16 resize-y font-mono text-xs"
                      value={messages.isSuccess ? row.message : ""}
                      onChange={(e) =>
                        setOverrides((o) => ({
                          ...o,
                          [row.hash]: e.target.value,
                        }))
                      }
                    />
                    {row.action === "reword" &&
                      (ai.generating && genHash === row.hash ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={ai.cancel}
                        >
                          <XIcon data-icon="inline-start" />
                          Cancel
                        </Button>
                      ) : (
                        // Wrap so the title still shows when the button is
                        // disabled — a native-disabled button swallows it.
                        <span
                          className="inline-flex"
                          title="Generate this commit's message with AI"
                        >
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            disabled={ai.generating || !messages.isSuccess}
                            onClick={() => {
                              setGenHash(row.hash);
                              ai.generate(`${row.hash}^`, row.hash);
                            }}
                          >
                            <SparkleIcon data-icon="inline-start" />
                            Generate
                          </Button>
                        </span>
                      ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <DialogFooter className="sm:items-center sm:justify-between">
          <div className="mr-auto text-xs text-muted-foreground">
            {messages.isError ? (
              <span className="text-warning">
                Couldn't load commit messages.{" "}
                <button
                  type="button"
                  className="cursor-pointer underline underline-offset-2"
                  onClick={() => messages.refetch()}
                >
                  Retry
                </button>
              </span>
            ) : plan.error ? (
              <span className="text-warning">{plan.error}</span>
            ) : (
              <>
                Result:{" "}
                <span className="tabular-nums text-foreground">
                  {plan.resultCount}
                </span>{" "}
                {plan.resultCount === 1 ? "commit" : "commits"}
                {plan.hasEdit && (
                  <span className="block text-[11px]">
                    Pauses at each Edit so you can amend it, then Continue from
                    the banner.
                  </span>
                )}
              </>
            )}
          </div>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={
              busy ||
              !plan.changed ||
              plan.error !== null ||
              (needsMessages && !messages.isSuccess)
            }
            onClick={apply}
          >
            {busy && <Spinner data-icon="inline-start" />}
            {plan.hasEdit ? "Start rebase" : "Rewrite history"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
