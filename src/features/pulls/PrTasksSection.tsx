import {
  ChatCircleIcon,
  CheckSquareIcon,
  CheckSquareOffsetIcon,
  DotsThreeIcon,
  PlusIcon,
  SquareIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { DeleteCommentDialog } from "@/features/conversations/DeleteCommentDialog";
import {
  prTasksKey,
  useCreatePrTask,
  useDeletePrTask,
  useEditPrTask,
  usePrTasks,
  useSetPrTaskState,
} from "@/lib/git/queries";
import type { PrTask } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";

/** Count of unresolved tasks — shared by the section and the header chip. */
function unresolved(tasks: PrTask[]): number {
  return tasks.filter((t) => t.state !== "RESOLVED").length;
}

/**
 * Scroll to (or open) the PR comment a task is attached to. Prefers the in-DOM
 * comment mount (`[data-comment-id]`, annotated by PrActivityFeed on the comment
 * Threads); falls back to the task's web URL when the comment isn't rendered.
 */
function viewComment(commentId: string, url: string) {
  const el = document.querySelector<HTMLElement>(
    `[data-comment-id~="${CSS.escape(commentId)}"]`,
  );
  if (el) {
    // behavior:"auto" — the app's other list scrolls (listKeyboardNav,
    // CommandPalette) all use the instant default rather than smooth, which
    // also respects a reduced-motion preference by never animating.
    el.scrollIntoView({ block: "nearest", behavior: "auto" });
    return;
  }
  if (url) openUrl(url);
}

/** One task row: checkbox affordance + text + (editable) a view-comment button
 *  and an always-visible kebab menu. Resolved state is carried by the checkbox
 *  glyph AND the strikethrough, never color alone. */
function TaskRow({
  task,
  editable,
  onToggle,
  onStartEdit,
  onDelete,
  onFocus,
}: {
  task: PrTask;
  editable: boolean;
  onToggle: () => void;
  onStartEdit: () => void;
  onDelete: () => void;
  onFocus: () => void;
}) {
  const resolved = task.state === "RESOLVED";
  const CheckIcon = resolved ? CheckSquareIcon : SquareIcon;
  const label = `${task.text} — ${resolved ? "resolved" : "unresolved"}`;

  return (
    <div
      data-row={task.id}
      // A checkbox row that also hosts its own action buttons (view-comment,
      // kebab) can't be a native <input>; role="checkbox" + aria-checked is the
      // standard ARIA composite here.
      role="checkbox"
      aria-checked={resolved}
      aria-disabled={!editable}
      aria-label={label}
      tabIndex={0}
      onFocus={onFocus}
      onClick={editable ? onToggle : undefined}
      onKeyDown={(e) => {
        // Keys from the nested action buttons pass through untouched, or the
        // preventDefault below would cancel their native Enter/Space activation.
        if (e.target !== e.currentTarget) return;
        if (!editable) return;
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onToggle();
        }
      }}
      className={cn(
        "group flex items-center gap-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
        editable && "cursor-pointer",
      )}
    >
      <CheckIcon
        className={cn(
          "size-4 shrink-0",
          resolved ? "text-primary" : "text-muted-foreground",
        )}
        aria-hidden
      />
      <span
        className={cn(
          "min-w-0 flex-1 whitespace-pre-wrap break-words",
          resolved && "text-muted-foreground line-through",
        )}
      >
        {task.text}
      </span>
      {task.commentId !== null && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          aria-label="View the comment this task is on"
          title="View the comment this task is on"
          onClick={(e) => {
            e.stopPropagation();
            viewComment(task.commentId as string, task.url);
          }}
        >
          <ChatCircleIcon />
        </Button>
      )}
      {editable && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Task actions for “${task.text}”`}
                className="shrink-0 text-muted-foreground hover:text-foreground data-popup-open:text-foreground"
                onClick={(e) => e.stopPropagation()}
              />
            }
          >
            <DotsThreeIcon className="size-4" weight="bold" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-36">
            {/* The menu is portaled, but React events bubble through the React
                tree — so a bare item click would reach the row's onClick and
                fire the resolve toggle. stopPropagation keeps Edit/Delete from
                toggling the task. */}
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onStartEdit();
              }}
            >
              Edit…
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
            >
              Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/** Inline single-line editor (add + edit share it): Enter submits, Escape
 *  cancels, whitespace-only disables the submit. Fully controlled — the parent
 *  owns `value`, so clearing after a create is a plain `setValue("")` (never a
 *  remount-toggle, which React 19 batches into a no-op). */
function TaskInput({
  value,
  onChange,
  placeholder,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
}: {
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
  submitLabel: string;
  pending: boolean;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const canSubmit = value.trim().length > 0 && !pending;

  return (
    <div className="flex items-center gap-1.5">
      <Input
        autoFocus
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (canSubmit) onSubmit(value.trim());
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        className="min-w-0 flex-1"
      />
      <Button
        size="xs"
        disabled={!canSubmit}
        onClick={() => canSubmit && onSubmit(value.trim())}
      >
        {submitLabel}
      </Button>
      <Button variant="ghost" size="xs" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

/**
 * The Bitbucket PR tasks checklist — a conversation-column section between the
 * PR description and the review Threads. Lists tasks with a resolve/unresolve
 * checkbox affordance, a completion progress bar, and (for an open PR) inline
 * add/edit + a per-row kebab (Edit / Delete). The resolve toggle is optimistic
 * (patch the cache, roll back on error); the mutation's own invalidation
 * reconciles. Mounted only for a ready Bitbucket repo (`forgeFeatureReady`).
 */
export function PrTasksSection({
  repoPath,
  number,
  editable,
}: {
  repoPath: string;
  number: number;
  /** Whether the PR is open — a closed/merged PR shows a read-only list. */
  editable: boolean;
}) {
  const queryClient = useQueryClient();
  const tasksQuery = usePrTasks(repoPath, number);
  const createTask = useCreatePrTask(repoPath);
  const editTask = useEditPrTask(repoPath);
  const setState = useSetPrTaskState(repoPath);
  const deleteTask = useDeletePrTask(repoPath);

  const [adding, setAdding] = useState(false);
  // The add-input's text lives here (controlled), so clearing it after a
  // successful create is a plain setState — remount-toggling `adding` in the
  // same tick is a React 19 no-op and never actually resets the field.
  const [addText, setAddText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  // The edit-input's text, seeded when a row's Edit is opened (see startEdit).
  const [editText, setEditText] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // The row the arrow-key nav walks from — updated as focus moves between rows.
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // Reset all PR-scoped UI state when the PR changes. Without this, switching
  // PRs with the add/edit input open would leave it open and pre-filled, so
  // submitting would create/edit a task on the NEW PR using the prior PR's text.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset intentionally keyed on `number` only.
  useEffect(() => {
    setAdding(false);
    setAddText("");
    setEditingId(null);
    setEditText("");
    setDeletingId(null);
    setFocusedId(null);
  }, [number]);

  const onError = (e: unknown) => toastError(e);
  const tasks = tasksQuery.data;

  // Wait for the first load so a PR with no tasks doesn't flash an empty section
  // before it resolves (IssueSubIssues idiom).
  if (!tasks && !tasksQuery.isError) return null;

  const list = tasks ?? [];
  const total = list.length;
  const resolvedCount = total - unresolved(list);

  // Every continuation in the helpers below rides the awaited promise, never
  // per-call mutate callbacks: an `<Activity>` tab hide tears this observer's
  // subscription down mid-write, and react-query drops per-call callbacks once
  // an observer has no listeners — the rollback, the field clears, and the
  // dialog close would silently never run.

  // Resolve toggle is optimistic: patch the one task's state in the cache, then
  // mutate with rollback on error (mirrors RemotePrView's toggleApproval). The
  // mutation's onSettled invalidation reconciles the real state.
  async function toggle(task: PrTask) {
    const key = prTasksKey(repoPath, number);
    const prev = queryClient.getQueryData<PrTask[]>(key);
    const nextResolved = task.state !== "RESOLVED";
    if (prev) {
      queryClient.setQueryData<PrTask[]>(
        key,
        prev.map((t) =>
          t.id === task.id
            ? { ...t, state: nextResolved ? "RESOLVED" : "UNRESOLVED" }
            : t,
        ),
      );
    }
    try {
      await setState.mutateAsync({
        number,
        taskId: task.id,
        resolved: nextResolved,
      });
    } catch (e) {
      if (prev) queryClient.setQueryData(key, prev);
      onError(e);
    }
  }

  function openAdd() {
    setAddText("");
    setAdding(true);
  }

  async function submitAdd(text: string) {
    try {
      await createTask.mutateAsync({ number, text });
      // Clear the controlled field but keep the row open for rapid entry.
      setAddText("");
    } catch (e) {
      onError(e);
    }
  }

  function startEdit(task: PrTask) {
    setEditText(task.text);
    setEditingId(task.id);
  }

  async function submitEdit(taskId: string, text: string) {
    try {
      await editTask.mutateAsync({ number, taskId, text });
      setEditingId(null);
    } catch (e) {
      onError(e);
    }
  }

  async function confirmDelete(taskId: string) {
    try {
      await deleteTask.mutateAsync({ number, taskId });
    } catch (e) {
      onError(e);
    } finally {
      setDeletingId(null);
    }
  }

  // Arrow keys walk the task rows (the helper moves DOM focus via rowKey);
  // `focusedId` tracks where to walk from, updated as rows gain focus.
  const onKeyDown = listKeyboardNav({
    items: list,
    activeIndex: list.findIndex((t) => t.id === focusedId),
    onActivate: (t) => setFocusedId(t.id),
    rowKey: (t) => t.id,
    rowAttr: "data-row",
    ignoreTextEntry: true,
  });

  return (
    <div id="pr-tasks-section" className="space-y-2 border-y py-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium">Tasks</span>
        {total > 0 && (
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {resolvedCount}/{total}
          </span>
        )}
        <span className="flex-1" />
        {editable && !adding && (
          <Button
            variant="ghost"
            size="xs"
            aria-label="Add a task"
            onClick={openAdd}
          >
            <PlusIcon data-icon="inline-start" />
            Add task
          </Button>
        )}
      </div>

      {total > 0 && (
        <div className="h-1 w-full bg-muted" aria-hidden>
          <div
            className="h-full bg-primary transition-[width]"
            style={{ width: `${(resolvedCount / total) * 100}%` }}
          />
        </div>
      )}

      {tasksQuery.isError ? (
        <p className="text-[11px] text-muted-foreground">
          Couldn't load tasks.
        </p>
      ) : (
        <div className="space-y-1.5" onKeyDown={onKeyDown}>
          {list.map((task) =>
            editingId === task.id ? (
              <TaskInput
                key={task.id}
                value={editText}
                onChange={setEditText}
                placeholder="Task text…"
                submitLabel="Save"
                pending={editTask.isPending}
                onSubmit={(text) => void submitEdit(task.id, text)}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <TaskRow
                key={task.id}
                task={task}
                editable={editable}
                onToggle={() => void toggle(task)}
                onStartEdit={() => startEdit(task)}
                onDelete={() => setDeletingId(task.id)}
                onFocus={() => setFocusedId(task.id)}
              />
            ),
          )}

          {total === 0 && !adding && (
            <p className="text-[11px] text-muted-foreground">
              {editable
                ? "No tasks yet — use Add task to keep a checklist of follow-ups to resolve before merging."
                : "No tasks."}
            </p>
          )}

          {adding && (
            <TaskInput
              value={addText}
              onChange={setAddText}
              placeholder="Add a task…"
              submitLabel="Add"
              pending={createTask.isPending}
              onSubmit={(text) => void submitAdd(text)}
              onCancel={() => setAdding(false)}
            />
          )}
        </div>
      )}

      <DeleteCommentDialog
        commentId={deletingId}
        onClose={() => setDeletingId(null)}
        pending={deleteTask.isPending}
        title="Delete task?"
        description="This permanently deletes the task on Bitbucket. This cannot be undone."
        onConfirm={(taskId) => void confirmDelete(taskId)}
      />
    </div>
  );
}

/**
 * The PR-header chip: "{n} open task{s}", shown when there are unresolved
 * tasks. Clicking runs `onView` (the parent switches to the conversation
 * section and scrolls the tasks section into view). Reads the same
 * `usePrTasks` query as the section — the cache dedupes.
 */
export function PrTasksChip({
  repoPath,
  number,
  onView,
}: {
  repoPath: string;
  number: number;
  onView: () => void;
}) {
  const tasksQuery = usePrTasks(repoPath, number);
  const count = unresolved(tasksQuery.data ?? []);
  if (count === 0) return null;

  const noun = count === 1 ? "open task" : "open tasks";
  return (
    <button
      type="button"
      onClick={onView}
      aria-label={`${count} ${noun} — view`}
      className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
    >
      <CheckSquareOffsetIcon className="size-3.5 shrink-0" aria-hidden />
      {count} {noun}
    </button>
  );
}
