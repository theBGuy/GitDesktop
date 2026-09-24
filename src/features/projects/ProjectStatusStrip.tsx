import { CaretRightIcon, DotsThreeIcon } from "@phosphor-icons/react";
import { useSelector } from "@tanstack/react-store";
import {
  type Dispatch,
  type FocusEvent,
  type KeyboardEvent,
  type SetStateAction,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from "react";
import { ForgeUserAvatar } from "@/components/forge-user-avatar";
import { Markdown } from "@/components/markdown/markdown";
import { RelativeTime } from "@/components/relative-time";
import { SelectClipText } from "@/components/select-clip-text";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DATE_ONLY,
  formatFieldDate,
} from "@/features/conversations/ProjectFieldValues";
import { clipTitleFromText } from "@/lib/clip-title";
import { useAppForm } from "@/lib/form";
import {
  isOptimisticStatusUpdate,
  useCreateProjectStatusUpdate,
  useDeleteProjectStatusUpdate,
  useProjectStatusUpdates,
  useUpdateProjectStatusUpdate,
} from "@/lib/git/queries";
import type {
  AssigneeRef,
  ProjectStatusContent,
  ProjectStatusUpdate,
  ProjectStatusValue,
} from "@/lib/git/types";
import { eventToBinding, SUBMIT_HINT } from "@/lib/hotkeys/binding";
import { useRovingRows } from "@/lib/list-keyboard-nav";
import { useConfirm } from "@/lib/stores/confirm";
import {
  ARIA_DISABLED_CLASS,
  useDisabledReason,
} from "@/lib/use-disabled-reason";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import { cn } from "@/lib/utils";
import {
  INVALID_DRAFT,
  type ScalarDef,
  ScalarInput,
  scalarDraft,
} from "./ProjectFieldControls";
import { plainFirstLine } from "./status-summary";

/** Every status this build names, in the order the editor offers them: the three
 *  health readings first, then the two that end or pause the work. */
const STATUS_ORDER: readonly ProjectStatusValue[] = [
  "ON_TRACK",
  "AT_RISK",
  "OFF_TRACK",
  "COMPLETE",
  "INACTIVE",
];

const NEUTRAL_TONE = "border-border bg-muted/40 text-muted-foreground";

/** GitHub's own colour for each status, as the app's semantic tokens. The label
 *  always rides beside the colour, so neither carries the meaning alone. */
const STATUS_META: Record<ProjectStatusValue, { label: string; tone: string }> =
  {
    ON_TRACK: {
      label: "On track",
      tone: "border-success/40 bg-success/10 text-success",
    },
    AT_RISK: {
      label: "At risk",
      tone: "border-warning/40 bg-warning/10 text-warning",
    },
    OFF_TRACK: {
      label: "Off track",
      tone: "border-destructive/40 bg-destructive/10 text-destructive",
    },
    COMPLETE: {
      label: "Complete",
      tone: "border-merged/40 bg-merged/10 text-merged",
    },
    INACTIVE: { label: "Inactive", tone: NEUTRAL_TONE },
  };

/** What an update posted with no status reads as — a real state on GitHub, so
 *  the chip names the update rather than inventing a status for it. */
const NO_STATUS_LABEL = "Status update";

function isKnownStatus(status: string): status is ProjectStatusValue {
  return Object.hasOwn(STATUS_META, status);
}

/** A status GitHub added after this build, spelled the way the known ones read:
 *  `PAUSED_FOR_REVIEW` as "Paused for review". */
function humanizeStatus(status: string): string {
  const words = status.toLowerCase().replaceAll("_", " ").trim();
  return words === ""
    ? NO_STATUS_LABEL
    : words[0].toUpperCase() + words.slice(1);
}

function statusMeta(status: string | null): { label: string; tone: string } {
  if (status === null) return { label: NO_STATUS_LABEL, tone: NEUTRAL_TONE };
  if (isKnownStatus(status)) return STATUS_META[status];
  return { label: humanizeStatus(status), tone: NEUTRAL_TONE };
}

function StatusChip({ status }: { status: string | null }) {
  const { label, tone } = statusMeta(status);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center border px-1.5 py-px text-[11px] font-medium leading-4",
        tone,
      )}
    >
      {label}
    </span>
  );
}

/** A status update date for display — the bare `YYYY-MM-DD` GitHub sends, read as
 *  a LOCAL day. Null for a value that isn't one, which renders nothing. */
function displayDate(date: string | null): string | null {
  return date !== null && DATE_ONLY.test(date) ? formatFieldDate(date) : null;
}

/** Whether the signed-in account wrote `update`. Logins compare case-blind, as
 *  GitHub treats them; a post still on its way has no id to address yet. */
function canManage(
  update: ProjectStatusUpdate,
  viewerLogin: string | null,
): boolean {
  return (
    viewerLogin !== null &&
    update.creator !== null &&
    update.creator.login.toLowerCase() === viewerLogin.toLowerCase() &&
    !isOptimisticStatusUpdate(update)
  );
}

/**
 * The project's latest status as one full-width row, with its history folding out
 * INLINE beneath it. Data-shaped — updates in, edit/delete requests out — so it
 * knows nothing about where the updates come from. Draws nothing at all for a
 * project with no updates: posting lives in the toolbar, so an empty project pays
 * no chrome.
 */
export function ProjectStatusStrip({
  updates,
  truncated,
  viewerLogin,
  ghHost,
  writeHeldNote,
  onEdit,
  onDelete,
  onFocusLost,
}: {
  /** Newest first, as GitHub reads them. */
  updates: ProjectStatusUpdate[];
  /** GitHub holds older updates than these. */
  truncated: boolean;
  /** The signed-in login, or null while unknown — which offers no Edit/Delete. */
  viewerLogin: string | null;
  ghHost: string | null;
  /** Why this sign-in can't write to the project, as the SHORT parenthetical a
   *  held menu row carries beside its label; undefined when it can write. */
  writeHeldNote: string | undefined;
  onEdit: (update: ProjectStatusUpdate) => void;
  /** Resolves true once the user confirmed and the delete is on its way. */
  onDelete: (update: ProjectStatusUpdate) => Promise<boolean>;
  /** Place focus somewhere outside the strip — for the delete that took its last
   *  entry, which leaves the strip with nothing drawn to stand on. */
  onFocusLost: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const historyId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const nav = useRovingRows({ items: updates, rowKey: (u) => u.id });
  /** The entry a delete is taking out, and where it stood — so focus can land on
   *  whatever takes its place rather than dropping with the entry's own menu. Set
   *  BEFORE the confirm, so the removal can never land ahead of it. */
  const [removing, setRemoving] = useState<{
    id: string;
    index: number;
  } | null>(null);
  const removedGone =
    removing !== null && !updates.some((u) => u.id === removing.id);
  const removedIndex = removing?.index ?? 0;
  const focusFallback = useEffectEvent(() => onFocusLost());
  useEffect(() => {
    if (!removedGone) return;
    // A frame past the confirm dialog's own focus return, which would otherwise
    // aim at the trigger that unmounted with the entry. The latch is released
    // INSIDE the frame: clearing it here would re-run this effect and its cleanup
    // would cancel the frame doing the work.
    const frame = requestAnimationFrame(() => {
      const rows =
        listRef.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [];
      const row = rows[Math.min(removedIndex, rows.length - 1)];
      const landing = row ?? toggleRef.current;
      if (landing) landing.focus();
      else focusFallback();
      setRemoving(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [removedGone, removedIndex]);

  /** The focused entry while it is a post still on its way, and where it stands.
   *  GitHub's answer replaces it under a NEW id, which remounts the row and drops
   *  focus to the page; this is what puts focus on the entry that took its slot. */
  const [pendingFocus, setPendingFocus] = useState<{
    id: string;
    index: number;
  } | null>(null);
  const pendingGone =
    pendingFocus !== null && !updates.some((u) => u.id === pendingFocus.id);
  const pendingIndex = pendingFocus?.index ?? 0;
  useEffect(() => {
    if (!pendingGone) return;
    // Latch released inside the frame, for the reason the delete landing gives.
    const frame = requestAnimationFrame(() => {
      // Only a DROPPED focus is recovered: the user may have moved on since.
      const active = document.activeElement;
      if (active === null || active === document.body) {
        const rows =
          listRef.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [];
        (
          rows[Math.min(pendingIndex, rows.length - 1)] ?? toggleRef.current
        )?.focus();
      }
      setPendingFocus(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingGone, pendingIndex]);

  const latest = updates[0];
  if (latest === undefined) return null;
  const summary = plainFirstLine(latest.body);
  const target = displayDate(latest.targetDate);

  async function requestDelete(update: ProjectStatusUpdate, index: number) {
    setRemoving({ id: update.id, index });
    const confirmed = await onDelete(update);
    if (!confirmed)
      setRemoving((current) => (current?.id === update.id ? null : current));
  }

  function onListKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Home" || e.key === "End") {
      const rows = e.currentTarget.querySelectorAll<HTMLElement>("[data-row]");
      const row = e.key === "Home" ? rows[0] : rows[rows.length - 1];
      if (row === undefined) return;
      e.preventDefault();
      row.focus();
      row.scrollIntoView({ block: "nearest" });
      return;
    }
    nav.onRowKeyDown(e);
  }

  /** Tracks whether focus sits on a pending post — see {@link pendingFocus}. */
  function onListFocus(e: FocusEvent<HTMLDivElement>) {
    const id =
      e.target instanceof HTMLElement
        ? e.target.closest<HTMLElement>("[data-row]")?.dataset.row
        : undefined;
    const index = updates.findIndex((u) => u.id === id);
    const pending = index >= 0 && isOptimisticStatusUpdate(updates[index]);
    setPendingFocus((current) => {
      if (!pending) return current === null ? current : null;
      return current?.id === id ? current : { id: updates[index].id, index };
    });
  }

  return (
    <section
      aria-label="Project status"
      className="mb-2 shrink-0 border-b pb-1.5 text-[11px]"
    >
      <button
        ref={toggleRef}
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? historyId : undefined}
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 px-1 py-0.5 text-left outline-none hover:bg-muted/40 focus-visible:ring-1 focus-visible:ring-ring"
      >
        <CaretRightIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90",
          )}
        />
        <span className="sr-only">Project status: </span>
        <StatusChip status={latest.status} />
        <span
          className="min-w-0 flex-1 truncate text-foreground"
          onMouseEnter={clipTitleFromText}
        >
          {summary}
        </span>
        {target !== null && (
          <span className="shrink-0 text-muted-foreground">
            <span aria-hidden>→ </span>
            <span className="sr-only">target </span>
            {target}
          </span>
        )}
        <span className="shrink-0 text-muted-foreground">
          <RelativeTime date={latest.createdAt} />
        </span>
      </button>
      {expanded && (
        // Scrolls at its own edge rather than pushing the board off screen: GitHub
        // answers with up to 25 updates, each with a note of any length.
        <div id={historyId} className="mt-1 max-h-72 overflow-y-auto">
          <div
            ref={listRef}
            role="list"
            aria-label="Status update history"
            onKeyDown={onListKeyDown}
            onFocus={onListFocus}
          >
            {updates.map((update, index) => (
              <StatusEntry
                key={update.id}
                update={update}
                rowProps={nav.rowProps(update)}
                manageable={canManage(update, viewerLogin)}
                ghHost={ghHost}
                writeHeldNote={writeHeldNote}
                onEdit={() => onEdit(update)}
                onDelete={() => void requestDelete(update, index)}
              />
            ))}
          </div>
          {truncated && (
            // Names where the rest is, since the app reads only the newest page.
            <p className="border-t px-1 pt-1.5 text-muted-foreground">
              Older updates are on GitHub.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function StatusEntry({
  update,
  rowProps,
  manageable,
  ghHost,
  writeHeldNote,
  onEdit,
  onDelete,
}: {
  update: ProjectStatusUpdate;
  rowProps: ReturnType<ReturnType<typeof useRovingRows>["rowProps"]>;
  /** The viewer wrote this entry, so it offers Edit and Delete. */
  manageable: boolean;
  ghHost: string | null;
  writeHeldNote: string | undefined;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const start = displayDate(update.startDate);
  const target = displayDate(update.targetDate);
  const body = update.body?.trim() ? update.body : null;
  const pending = isOptimisticStatusUpdate(update);
  // A held row keeps its label and says why in a parenthetical beside it, the
  // board menu's grammar: a disabled menu item can't carry a tooltip.
  const held = writeHeldNote !== undefined;
  const editLabel = held ? `Edit update (${writeHeldNote})` : "Edit update…";
  const deleteLabel = held
    ? `Delete update (${writeHeldNote})`
    : "Delete update…";

  const content = (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <StatusChip status={update.status} />
        {update.creator !== null && (
          <span className="flex min-w-0 items-center gap-1">
            <ForgeUserAvatar
              login={update.creator.login}
              avatarUrl={update.creator.avatarUrl}
              ghHost={ghHost}
              size="sm"
              decorative
            />
            <span
              className="truncate font-medium text-foreground"
              onMouseEnter={clipTitleFromText}
            >
              {update.creator.login}
            </span>
          </span>
        )}
        <span className="text-muted-foreground">
          {pending ? "Posting…" : <RelativeTime date={update.createdAt} />}
        </span>
        {start !== null && (
          <span className="text-muted-foreground">Start {start}</span>
        )}
        {target !== null && (
          <span className="text-muted-foreground">Target {target}</span>
        )}
        {manageable && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Status update actions"
                  // Inside the roving row: a row the arrows haven't reached keeps
                  // its button out of the Tab order too.
                  tabIndex={rowProps.tabIndex}
                  className="ml-auto text-muted-foreground hover:text-foreground data-popup-open:text-foreground"
                />
              }
            >
              <DotsThreeIcon className="size-4" weight="bold" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuItem disabled={held} onClick={onEdit}>
                {editLabel}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                disabled={held}
                onClick={onDelete}
              >
                {deleteLabel}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {body !== null && (
        <Markdown className="mt-1 px-0.5 text-xs">{body}</Markdown>
      )}
    </>
  );

  const rowClass =
    "border-t px-1 py-1.5 outline-none select-text first:border-t-0 focus-visible:bg-muted/40 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset";
  if (!manageable)
    return (
      <div role="listitem" {...rowProps} className={rowClass}>
        {content}
      </div>
    );
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<div role="listitem" {...rowProps} className={rowClass} />}
      >
        {content}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-44">
        <ContextMenuItem disabled={held} onClick={onEdit}>
          {editLabel}
        </ContextMenuItem>
        <ContextMenuItem
          variant="destructive"
          disabled={held}
          onClick={onDelete}
        >
          {deleteLabel}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Which editor is open: a new post, an edit of one entry, or none. The entry is
 *  captured when the edit OPENS, so a refetch under the dialog can't swap what it
 *  was seeded from. */
export type StatusEditorState =
  | { mode: "create" }
  | { mode: "edit"; update: ProjectStatusUpdate }
  | null;

/** The select's key for "no status", which only an edit offers: GitHub reads a
 *  create with no status as an empty request when nothing else is filled in. */
const NO_STATUS_KEY = "none";

/** A date control's last report: its raw text and whether the browser could
 *  parse it — the pair {@link scalarDraft} reads. */
interface DateEntry {
  raw: string;
  badInput: boolean;
}

const EMPTY_DATE: DateEntry = { raw: "", badInput: false };

/** A date entry as the write's value: null for empty, {@link INVALID_DRAFT} for one
 *  the browser can't parse or an unfinished year — the shared rule the board's own
 *  date editors apply. */
function dateValue(
  def: ScalarDef,
  entry: DateEntry,
): string | null | typeof INVALID_DRAFT {
  const draft = scalarDraft(def, entry.raw, entry.badInput);
  if (draft === null || draft === INVALID_DRAFT) return draft;
  return draft.update.kind === "date" ? draft.update.date : INVALID_DRAFT;
}

const START_DEF: ScalarDef = {
  kind: "date",
  id: "status-start-date",
  name: "Start date",
  isIssueField: false,
};
const TARGET_DEF: ScalarDef = {
  kind: "date",
  id: "status-target-date",
  name: "Target date",
  isIssueField: false,
};

/** A native date input with a visible Clear. The input is the shared UNCONTROLLED
 *  one, whose keyup/focusout reconcile catches the keyboard clear that fires no
 *  input event; Clear remounts it empty through `resetKey`. */
function StatusDateField({
  def,
  seed,
  resetKey,
  onEdit,
  onClear,
}: {
  def: ScalarDef;
  seed: string;
  resetKey: number;
  onEdit: (entry: DateEntry) => void;
  onClear: () => void;
}) {
  const inputId = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>{def.name}</Label>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <ScalarInput
            key={resetKey}
            id={inputId}
            def={def}
            defaultValue={seed}
            onEdit={(raw, badInput) => onEdit({ raw, badInput })}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-label={`Clear ${def.name.toLowerCase()}`}
          onClick={onClear}
        >
          Clear
        </Button>
      </div>
    </div>
  );
}

/**
 * Post a status update, or rewrite one. Every starting value is read from
 * `editor` at the open transition: this dialog stays mounted across open and
 * close, and `<Activity>` replays its effects on show.
 *
 * `onSave` owns both outcomes — it closes the dialog on success, only if this run
 * is still the one on screen, and leaves it open on failure, where the draft is.
 */
export function ProjectStatusUpdateDialog({
  editor,
  pending,
  onOpenChange,
  onSave,
}: {
  editor: StatusEditorState;
  /** A status write is in flight — from THIS run or one the user closed over.
   *  Single-flight, the board dialogs' contract: this dialog outlives its own
   *  submissions, so its form can't be what knows one is still going. */
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (
    status: string | null,
    content: ProjectStatusContent,
  ) => Promise<void>;
}) {
  const open = editor !== null;
  const statusId = useId();
  // The entry the dialog is editing, held past the close so the title and the
  // status rows don't flip to the post arm while the dialog animates out.
  const [closingEdit, setClosingEdit] = useState<ProjectStatusUpdate | null>(
    null,
  );
  const liveEdit = editor?.mode === "edit" ? editor.update : null;
  const editing = open ? liveEdit : closingEdit;
  const [start, setStart] = useState<DateEntry>(EMPTY_DATE);
  const [target, setTarget] = useState<DateEntry>(EMPTY_DATE);
  const [dateSeed, setDateSeed] = useState({ start: "", target: "" });
  // Bumped to remount a date input: on each open, so it takes the new seed, and on
  // Clear, so it drops whatever the user typed.
  const [startKey, setStartKey] = useState(0);
  const [targetKey, setTargetKey] = useState(0);

  const form = useAppForm({
    defaultValues: { status: "", body: "" },
    onSubmit: ({ value }) => {
      const startDate = dateValue(START_DEF, start);
      const targetDate = dateValue(TARGET_DEF, target);
      if (startDate === INVALID_DRAFT || targetDate === INVALID_DRAFT)
        return undefined;
      const body = value.body.trim() === "" ? null : value.body;
      return onSave(value.status === NO_STATUS_KEY ? null : value.status, {
        body,
        startDate,
        targetDate,
      });
    },
  });
  const status = useSelector(form.store, (s) => s.values.status);
  // Derived in the selector, so typing re-renders the dialog only when the note
  // crosses between empty and not.
  const bodyBlank = useSelector(form.store, (s) => s.values.body.trim() === "");
  const submitting = useSelector(form.store, (s) => s.isSubmitting);

  useSeedOnOpen(open, () => {
    const seededStart =
      editing?.startDate && DATE_ONLY.test(editing.startDate)
        ? editing.startDate
        : "";
    const seededTarget =
      editing?.targetDate && DATE_ONLY.test(editing.targetDate)
        ? editing.targetDate
        : "";
    // keepDefaultValues: otherwise the per-render options sync clobbers the reset
    // values back to empty on an untouched form.
    form.reset(
      {
        status: editing === null ? "" : (editing.status ?? NO_STATUS_KEY),
        body: editing?.body ?? "",
      },
      { keepDefaultValues: true },
    );
    setClosingEdit(editing);
    setDateSeed({ start: seededStart, target: seededTarget });
    setStart({ raw: seededStart, badInput: false });
    setTarget({ raw: seededTarget, badInput: false });
    setStartKey((k) => k + 1);
    setTargetKey((k) => k + 1);
  });

  // The five known statuses, plus — on an edit only — "No status" and whatever
  // value the entry already holds that this build doesn't name, so saving an
  // unrelated change never rewrites a status the user didn't touch.
  const items: Record<string, string> = {};
  for (const value of STATUS_ORDER) items[value] = STATUS_META[value].label;
  if (editing !== null) {
    if (editing.status !== null && !isKnownStatus(editing.status))
      items[editing.status] = humanizeStatus(editing.status);
    items[NO_STATUS_KEY] = "No status";
  }

  const startValue = dateValue(START_DEF, start);
  const targetValue = dateValue(TARGET_DEF, target);
  // ONE predicate for the button, implicit Enter and the chord alike. The save arm
  // comes first: a second submit while one is out would post the update twice.
  const heldReason = (() => {
    switch (true) {
      case pending || submitting:
        return "Saving your update…";
      // A post writes one of the statuses this build names — the value its save
      // path accepts — so anything else holds here rather than failing silently.
      case status === "" || (editing === null && !isKnownStatus(status)):
        return "Pick a status to post the update";
      case startValue === INVALID_DRAFT:
        return "Finish or clear the start date";
      case targetValue === INVALID_DRAFT:
        return "Finish or clear the target date";
      // Only an edit can reach it (a post always carries its status), and GitHub
      // refuses a create with none of the four; an edit is held the same way.
      case status === NO_STATUS_KEY &&
        bodyBlank &&
        startValue === null &&
        targetValue === null:
        return "Keep a status, a note or a date on the update";
      default:
        return null;
    }
  })();
  const { blockedReason, reasonId, wrapperTitle, describedBy } =
    useDisabledReason({
      disabled: heldReason !== null,
      reason: heldReason,
      title: SUBMIT_HINT,
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] flex-col sm:max-w-2xl"
        // mod+enter submits from anywhere in the dialog, the body included. On
        // DialogContent rather than the <form>: the X close is the form's
        // SIBLING, so a form-level handler would miss the chord pressed there.
        onKeyDown={(e) => {
          if (eventToBinding(e) === "mod+enter") {
            e.preventDefault();
            if (heldReason === null) form.handleSubmit();
          }
        }}
      >
        <form
          className="flex min-h-0 min-w-0 flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            // The same gate the button takes, so Enter can't walk around it.
            if (heldReason !== null) return;
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {editing === null ? "Post status update" : "Edit status update"}
            </DialogTitle>
            <DialogDescription>
              {editing === null
                ? "Tell everyone on the project how the work is going. The newest update leads the board."
                : "Changes this update for everyone on the project."}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            <form.AppField name="status">
              {(field) => (
                // A raw Select rather than `SelectField`, which draws no
                // placeholder: a post starts with no status, and the empty field
                // has to say it's the step to take.
                <div className="space-y-2">
                  <Label htmlFor={statusId}>Status</Label>
                  <Select
                    items={items}
                    value={field.state.value || null}
                    onValueChange={(v) => {
                      if (typeof v === "string" && v !== "")
                        field.handleChange(v);
                    }}
                  >
                    <SelectTrigger id={statusId} className="w-full">
                      <SelectValue
                        placeholder="Pick a status"
                        onMouseEnter={clipTitleFromText}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(items).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          <SelectClipText>{label}</SelectClipText>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </form.AppField>
            <form.AppField name="body">
              {(field) => (
                <field.MarkdownField
                  label="Note"
                  placeholder="What's changed, what's next, and anything in the way"
                  rows={6}
                  textareaClassName="max-h-72 min-h-24 resize-y font-mono"
                />
              )}
            </form.AppField>
            <div className="grid gap-4 sm:grid-cols-2">
              <StatusDateField
                def={START_DEF}
                seed={dateSeed.start}
                resetKey={startKey}
                onEdit={setStart}
                onClear={() => {
                  setDateSeed((s) => ({ ...s, start: "" }));
                  setStart(EMPTY_DATE);
                  setStartKey((k) => k + 1);
                }}
              />
              <StatusDateField
                def={TARGET_DEF}
                seed={dateSeed.target}
                resetKey={targetKey}
                onEdit={setTarget}
                onClear={() => {
                  setDateSeed((s) => ({ ...s, target: "" }));
                  setTarget(EMPTY_DATE);
                  setTargetKey((k) => k + 1);
                }}
              />
            </div>
          </div>
          <DialogFooter>
            {blockedReason !== null && (
              <span
                id={reasonId}
                className="mr-auto self-center text-[11px] text-muted-foreground"
              >
                {blockedReason}
              </span>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <form.AppForm>
              {/* Held with its reason FOCUSABLE, the contract BoardDraftEditDialog
                  documents: `focusableWhenDisabled` rides the reason alone, so the
                  submitting disable `SubmitButton` ORs in stays a native one. */}
              <span
                className={cn(
                  "inline-flex",
                  blockedReason && "cursor-not-allowed",
                )}
                title={wrapperTitle}
              >
                <form.SubmitButton
                  focusableWhenDisabled={!!blockedReason}
                  disabled={heldReason !== null}
                  aria-describedby={describedBy}
                  className={ARIA_DISABLED_CLASS}
                >
                  {editing === null ? "Post update" : "Save update"}
                </form.SubmitButton>
              </span>
            </form.AppForm>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A project's status: the strip, its history, and the editor behind both, wired
 * to the project's reads and writes. The panel owns `editor` so its toolbar and
 * the command palette can open a post; everything past that lives here.
 *
 * A failed read draws nothing: the board is the surface this sits above, and a
 * status that can't be read is no reason to hold it up or to claim there is none.
 */
export function ProjectStatusSection({
  repoPath,
  projectId,
  enabled,
  viewer,
  ghHost,
  writeHeldNote,
  editor,
  setEditor,
  onFocusLost,
}: {
  repoPath: string;
  projectId: string;
  /** Read gate — the tab being visible, GitHub, the scope, a project. */
  enabled: boolean;
  /** The signed-in account, for Edit/Delete gating and the pending post's byline. */
  viewer: AssigneeRef | null;
  ghHost: string | null;
  writeHeldNote: string | undefined;
  editor: StatusEditorState;
  setEditor: Dispatch<SetStateAction<StatusEditorState>>;
  /** Where focus goes when a delete empties the strip. */
  onFocusLost: () => void;
}) {
  const read = useProjectStatusUpdates(repoPath, projectId, enabled);
  const createUpdate = useCreateProjectStatusUpdate();
  const updateUpdate = useUpdateProjectStatusUpdate();
  const deleteUpdate = useDeleteProjectStatusUpdate();

  async function save(status: string | null, content: ProjectStatusContent) {
    const run = editor;
    if (run === null) return;
    try {
      if (run.mode === "create") {
        // The dialog holds Post until a status is picked, so an unnamed value
        // here can only be one this build offered.
        if (status === null || !isKnownStatus(status)) return;
        await createUpdate.mutateAsync({
          repo: repoPath,
          projectId,
          status,
          content,
          creator: viewer,
        });
      } else {
        await updateUpdate.mutateAsync({
          repo: repoPath,
          projectId,
          statusUpdateId: run.update.id,
          status,
          content,
        });
      }
    } catch {
      // Reported by the hook; the dialog stays open with the draft in it.
      return;
    }
    // Only THIS run's dialog closes: one reopened while the write was in flight
    // is a different object and keeps its draft.
    setEditor((current) => (current === run ? null : current));
  }

  async function remove(update: ProjectStatusUpdate): Promise<boolean> {
    const ok = await useConfirm.getState().ask({
      title: "Delete this status update?",
      body: "It's removed from the project for everyone. This can't be undone.",
      confirmLabel: "Delete update",
      confirmVariant: "destructive",
    });
    if (!ok) return false;
    deleteUpdate
      .mutateAsync({ repo: repoPath, projectId, statusUpdateId: update.id })
      // Reported by the hook, which also puts the entry back.
      .catch(() => undefined);
    return true;
  }

  return (
    <>
      {read.data !== undefined && (
        <ProjectStatusStrip
          // A new project's history starts folded.
          key={projectId}
          updates={read.data.updates}
          truncated={read.data.truncated}
          viewerLogin={viewer?.login ?? null}
          ghHost={ghHost}
          writeHeldNote={writeHeldNote}
          // Only over a CLOSED editor, the rule the panel's post route keeps.
          onEdit={(update) =>
            setEditor((current) => current ?? { mode: "edit", update })
          }
          onDelete={remove}
          onFocusLost={onFocusLost}
        />
      )}
      <ProjectStatusUpdateDialog
        editor={editor}
        pending={createUpdate.isPending || updateUpdate.isPending}
        onOpenChange={(o) => {
          if (!o) setEditor(null);
        }}
        onSave={save}
      />
    </>
  );
}
