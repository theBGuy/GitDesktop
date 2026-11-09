import {
  ArrowDownIcon,
  ArrowUpIcon,
  CaretDownIcon,
  CheckIcon,
  ClockIcon,
  SparkleIcon,
  WarningIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { MENU_HELD_ROW_CLASS } from "@/components/menu-held-row";
import { useRelativeNow } from "@/components/relative-time";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { PROMOTION_BLOCKS_CHECKOUT } from "@/features/repository/checkout-copy";
import { clipTitle, clipTitleFromText } from "@/lib/clip-title";
import {
  useCommitDetails,
  useRebaseEdit,
  useRewriteCommits,
  useUnpushedMessages,
} from "@/lib/git/queries";
import type { CommitDate, CommitSummary } from "@/lib/git/types";
import {
  bindingToAriaKeyshortcuts,
  eventToBinding,
  formatBinding,
  hasChordModifier,
} from "@/lib/hotkeys/binding";
import { useRovingRows } from "@/lib/list-keyboard-nav";
import {
  type AppSettings,
  EDIT_HISTORY_ORDERS,
  subscribeSettingsWritten,
} from "@/lib/settings/api";
import {
  settingsKeys,
  useAiEnabled,
  useSaveSettingsPatch,
  useSettings,
} from "@/lib/settings/queries";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";
import { promotionBlocksCheckout } from "@/lib/stores/worktree-removal";
import { toastError } from "@/lib/toast";
import {
  ARIA_DISABLED_CLASS,
  useDisabledReason,
} from "@/lib/use-disabled-reason";
import { useLatestRef } from "@/lib/use-latest-ref";
import { cn } from "@/lib/utils";
import { CommitDateField, SameAsAuthorCheckbox } from "./CommitDateField";
import {
  beforeParentNote,
  datesBeforeParentConfirm,
  PARENT_DATE_PENDING,
} from "./commit-confirms";
import {
  commitDateFromIso,
  DATE_FORMAT_HINT,
  type DateDraft,
  dateWarnings,
  FIX_DATE_FIRST,
  formatCommitDate,
  inEditableRange,
  OUT_OF_RANGE_NOTE,
  readableCommitDate,
  readCommitDate,
  resolveDates,
  rowDateLabel,
  sameCommitDate,
  sameUnreachableNote,
  UNREADABLE_DATE_TEXT,
} from "./commit-date";
import {
  beforeParentSteps,
  type ChronoEnd,
  type CompiledPlan,
  compilePlan,
  displayIndex,
  type EditRow,
  moveAnnouncement,
  type RowAction,
  visualMoveTarget,
} from "./edit-history-plan";
import {
  leftRebaseInProgress,
  useGenerateSquashMessage,
} from "./RewriteDialogs";

/** Action labels + one-line descriptions for the per-row picker. Squash and
 *  fixup carry no static hint: theirs names the commit they combine into. */
const ACTIONS: { value: RowAction; label: string; hint?: string }[] = [
  { value: "pick", label: "Pick", hint: "Keep this commit as-is" },
  {
    value: "reword",
    label: "Reword",
    hint: "Keep the changes, edit the message",
  },
  { value: "squash", label: "Squash" },
  { value: "fixup", label: "Fixup" },
  {
    value: "edit",
    label: "Edit",
    hint: "Stop to amend this commit's changes",
  },
  { value: "drop", label: "Drop", hint: "Remove this commit entirely" },
];
const ACTION_LABEL = new Map(ACTIONS.map((a) => [a.value, a.label]));

type FoldAction = "squash" | "fixup";
const isFold = (a: RowAction): a is FoldAction =>
  a === "squash" || a === "fixup";
/** The second line of a fold's menu hint, after the quoted target. */
const FOLD_HINT_TAIL: Record<FoldAction, string> = {
  squash: "joining the messages",
  fixup: "keeping that commit's message",
};
const FOLD_VERB: Record<FoldAction, string> = {
  squash: "squashed",
  fixup: "fixed up",
};
const BUSY_REASON = "The rewrite is still running.";
const AT_NEWEST = "Already the newest commit";
const AT_OLDEST = "Already the oldest commit";
/** Refusals name the chronological end, whichever end of the list it shows at. */
const END_REASON: Record<ChronoEnd, string> = {
  newest: AT_NEWEST,
  oldest: AT_OLDEST,
};

/** Why a row's date button is held. `busy` keeps an open editor rendered and
 *  inert; every other hold renders no editor (a draft survives and returns). */
type DateHold =
  | "busy"
  | "loading"
  | "failed"
  | "unreadable"
  | "fold"
  | "dropped";
const DATE_HOLD_REASON: Record<DateHold, string> = {
  busy: BUSY_REASON,
  loading: "Loading dates…",
  failed: "Couldn't load commit dates",
  unreadable: "This commit's dates can't be read",
  fold: "A squashed or fixed-up commit takes its dates from the commit it combines into.",
  dropped: "A removed commit has no dates to change.",
};
/** A row's date button text when the read failed and the listed date doesn't
 *  parse either. */
const DATE_FAILED_TEXT = "Date not loaded";

/** A planned commit flagged against its parent: dated before it, or (only the
 *  oldest, on a failed base read) re-dated while the parent's date is unread. */
type ParentFlag = {
  hash: string;
  parentHash: string;
  parentDate: CommitDate | null;
};
type ParentFlagKind = "before" | "unread";
const parentFlagKind = (flag: ParentFlag): ParentFlagKind =>
  flag.parentDate === null ? "unread" : "before";
const PARENT_FLAG_LABEL: Record<ParentFlagKind, string> = {
  before: "before parent",
  unread: "parent date unread",
};
const PARENT_FLAG_NAME: Record<ParentFlagKind, string> = {
  before: ", dated before its parent",
  unread: ", parent's date unread",
};
const EDIT_PAUSE_DATES_NOTE =
  "This commit pauses for amending. These dates are applied when you continue and replace any set during the pause. If you split the commit there, they land on the last new commit.";

type ResolvedDates = ReturnType<typeof resolveDates>;
/** A row's dates, decided from that row's own entry in the read, never from the
 *  read's status alone: a row that has its entry keeps it through a later
 *  failed refetch. */
type RowDates =
  | { kind: "none"; hold: "loading" | "failed" }
  | { kind: "unreadable"; author: CommitDate | null }
  | {
      kind: "ok";
      original: { author: CommitDate; committer: CommitDate };
      resolved: ResolvedDates;
    };

function rowDatesOf(
  entry:
    | { authorDate: CommitDate | null; committerDate: CommitDate | null }
    | undefined,
  readFailed: boolean,
  draft: DateDraft | undefined,
): RowDates {
  if (entry === undefined) {
    return { kind: "none", hold: readFailed ? "failed" : "loading" };
  }
  const author = readableCommitDate(entry.authorDate);
  const committer = readableCommitDate(entry.committerDate);
  if (author === null || committer === null) {
    return { kind: "unreadable", author };
  }
  const original = { author, committer };
  return { kind: "ok", original, resolved: resolveDates(original, draft) };
}

/** Why a row can't take dates of its own, busy aside; null = it can. */
function structuralHold(
  action: RowAction,
  info: RowDates | undefined,
): Exclude<DateHold, "busy"> | null {
  if (action === "drop") return "dropped";
  if (isFold(action)) return "fold";
  if (info === undefined) return "loading";
  if (info.kind === "none") return info.hold;
  if (info.kind === "unreadable") return "unreadable";
  return null;
}

/** A row's draft with nothing typed yet: its current dates, and "Same as
 *  author date" ticked iff they match. */
function draftOf(
  info: Extract<RowDates, { kind: "ok" }>,
  draft: DateDraft | undefined,
): DateDraft {
  return (
    draft ?? {
      author: formatCommitDate(info.original.author),
      same: info.resolved.same,
      committer: formatCommitDate(info.original.committer),
    }
  );
}

const commitsWord = (n: number) => (n === 1 ? "commit" : "commits");
const skippedTail = (k: number) => (k > 0 ? `, ${k} skipped` : "");

type ListOrder = AppSettings["editHistoryOrder"];
/** Direction-dependent copy. Folds still name their target and "older"; the
 *  position word says where that older commit sits in the displayed list. */
const ORDER_COPY: Record<
  ListOrder,
  {
    onTop: string;
    listLabel: string;
    foldPosition: string;
    heldHint: string;
    heldLabel: string;
  }
> = {
  "newest-first": {
    onTop: "Newest on top;",
    listLabel: "Commits, newest first",
    foldPosition: "below",
    heldHint: "No older kept commit below in this list to combine into",
    heldLabel: "no older kept commit below to combine into",
  },
  "oldest-first": {
    onTop: "Oldest on top;",
    listLabel: "Commits, oldest first",
    foldPosition: "above",
    heldHint: "No older kept commit above in this list to combine into",
    heldLabel: "no older kept commit above to combine into",
  },
};

/** Segmented secondary-vs-ghost, as ConversationListPanel's state filter. The
 *  secondary and muted fills are one token, so an unpressed hover stays at
 *  half strength with muted text, the pressed segment holds under hover, and
 *  weight marks it beyond color. h-6 keeps the title row at its usual height. */
const ORDER_SEGMENT_CLASS =
  "h-6 font-normal text-muted-foreground hover:bg-muted/50 hover:text-muted-foreground aria-pressed:bg-secondary aria-pressed:font-medium aria-pressed:text-secondary-foreground aria-pressed:hover:bg-secondary aria-pressed:hover:text-secondary-foreground";

// Counts order changes across every mount, so only the latest one's failure
// rolls back: a value compare can't tell a stale failure from a later change
// back to its value, and a closed dialog's late failure must not undo a
// reopened one's change.
let orderChangeSeq = 0;
// The order a failed latest change rolls back to: the last one on disk. Every
// settings write that lands moves it, whoever made it (other writers save whole
// snapshots, which carry the cached order too); the cache seeds it only while
// it is still unknown, since a landed write can be ahead of the cache.
let persistedOrder: AppSettings["editHistoryOrder"] | null = null;
subscribeSettingsWritten((saved) => {
  persistedOrder = saved.editHistoryOrder;
});

/** Test-only: module state would otherwise carry the baseline between cases. */
export function resetOrderBaselineForTests() {
  persistedOrder = null;
}

type OrderHold = "loading" | "failed";
/** Why the order toggle is held while there are no settings to patch. */
const ORDER_HOLD_REASON: Record<OrderHold, string> = {
  loading: "Loading settings…",
  failed: "Couldn't load settings",
};

/** Why a reword row's Generate is held. `otherGenerating` means ANOTHER row
 *  is generating: this row's own run renders Cancel instead. */
function generateHeldReason(
  otherGenerating: boolean,
  messagesFailed: boolean,
): string {
  if (otherGenerating) return "Another commit message is generating";
  if (messagesFailed) return "Couldn't load commit messages";
  return "Loading commit messages…";
}

/** The dialog's move chords, as canonical bindings (`eventToBinding`'s own
 *  spelling). Feature-local rather than registry bindings: they act on the
 *  focused commit row, which only this handler can see. */
const MOVE_CHORDS: Partial<Record<string, "up" | "down" | "top" | "bottom">> = {
  "alt+up": "up",
  "alt+down": "down",
  "alt+home": "top",
  "alt+end": "bottom",
};
/** The row's date keys: D opens its editor, Shift+arrows extend a selection. */
const DATE_KEYS = ["d", "shift+up", "shift+down"];
const ROW_KEYSHORTCUTS = [...Object.keys(MOVE_CHORDS), ...DATE_KEYS]
  .map(bindingToAriaKeyshortcuts)
  .join(" ");
/** Plain navigation keys, which clear a selection before they move. */
const NAV_KEYS: ReadonlySet<string> = new Set(["up", "down", "home", "end"]);
/** Every key a row answers with Alt held. The chords above match first; any
 *  other Alt press on these (Alt+←, Alt+Shift+Home) is swallowed, so Alt never
 *  degrades to plain navigation or reaches the webview's own accelerators. */
const ALT_SWALLOWED_KEYS: ReadonlySet<string> = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
]);
/** Zero-width space, built from its code point so no invisible byte sits in
 *  source. Toggled into the live region so a repeated message re-announces. */
const ZWSP = String.fromCharCode(0x200b);

/** The commit row for `hash` inside `list`, or null. */
function findRow(list: HTMLElement | null, hash: string): HTMLElement | null {
  return (
    list?.querySelector<HTMLElement>(`[data-row="${CSS.escape(hash)}"]`) ?? null
  );
}

/** A menu item's second line: what a squash or fixup combines into (or why it
 *  can't), else the action's static hint. */
function ActionHint({
  action,
  hint,
  target,
  listOrder,
}: {
  action: RowAction;
  hint?: string;
  target: string | null;
  listOrder: ListOrder;
}) {
  if (!isFold(action))
    return <span className="text-[11px] text-muted-foreground">{hint}</span>;
  // Foreground, so it reads muted under the held item's disabled opacity.
  if (target === null)
    return (
      <span className="text-[11px] text-foreground">
        {ORDER_COPY[listOrder].heldHint}
      </span>
    );
  // The subject truncates to what the first line leaves after its quotes, so
  // it always starts right after the opening one. The text still reads as one
  // sentence, since typeahead reads the item's whole text.
  return (
    <span className="flex max-w-full flex-col text-[11px] text-muted-foreground">
      <span className="flex min-w-0 max-w-full">
        <span className="shrink-0 whitespace-pre">Combine into "</span>
        <span className="min-w-0 truncate" onMouseEnter={clipTitle(target)}>
          {target}
        </span>
        <span className="shrink-0 whitespace-pre">
          {`" ${ORDER_COPY[listOrder].foldPosition},`}
        </span>
      </span>
      <span> {FOLD_HINT_TAIL[action]}</span>
    </span>
  );
}

/** One warning line: icon + text in the warning token. */
function DateWarning({ children }: { children: string }) {
  return (
    <p className="flex items-start gap-1 pl-30 text-[11px] text-warning">
      <WarningIcon aria-hidden className="mt-px size-3 shrink-0" />
      {children}
    </p>
  );
}

/** A row's inline date editor. Escape is matched on this container, so it
 *  closes the editor and never reaches the dialog's own dismiss. */
function RowDatesEditor({
  id,
  subject,
  info,
  draft,
  isEdit,
  changed,
  parent,
  nowMs,
  heldReason,
  onDraft,
  onReset,
  onEscape,
}: {
  id: string;
  subject: string;
  info: Extract<RowDates, { kind: "ok" }>;
  draft: DateDraft;
  isEdit: boolean;
  changed: boolean;
  parent: ParentFlag | undefined;
  nowMs: number;
  heldReason: string | null;
  onDraft: (next: DateDraft) => void;
  onReset: () => void;
  /** `repeat` is the key's auto-repeat flag. */
  onEscape: (repeat: boolean) => void;
}) {
  const { resolved, original } = info;
  const { author, committer } = resolved.planned;
  const warnings = dateWarnings(resolved.planned, nowMs);
  const sameNote = sameUnreachableNote(original, resolved);
  if (parent !== undefined) {
    warnings.push(
      beforeParentNote(
        parent.parentHash,
        parent.parentDate === null
          ? null
          : rowDateLabel(parent.parentDate, nowMs),
      ),
    );
  }
  const hasError =
    resolved.authorError !== null || resolved.committerError !== null;
  // A changed commit sends the committer date it shows; one outside the
  // editable range can't be sent, so git stamps it.
  const committerNote =
    resolved.changed &&
    !hasError &&
    committer !== null &&
    !inEditableRange(committer)
      ? OUT_OF_RANGE_NOTE
      : null;

  return (
    <div
      id={id}
      role="group"
      aria-label={`Dates for ${subject}`}
      data-row-dates=""
      className="space-y-1.5 px-2 pb-2 pl-29"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        e.preventDefault();
        onEscape(e.repeat);
      }}
    >
      <CommitDateField
        label="Author date"
        value={draft.author}
        onChange={(text) => onDraft({ ...draft, author: text })}
        original={original.author}
        date={author}
        error={resolved.authorError}
        nowMs={nowMs}
        heldReason={heldReason}
        onReset={onReset}
      />
      <SameAsAuthorCheckbox
        checked={resolved.same}
        heldReason={heldReason}
        // Unticking seeds the committer field with the commit's current one.
        onChange={(same) =>
          onDraft({
            ...draft,
            same,
            committer: same
              ? draft.committer
              : formatCommitDate(original.committer),
          })
        }
      />
      {sameNote !== null && (
        <p className="pl-30 text-[11px] text-muted-foreground">{sameNote}</p>
      )}
      {!resolved.same && (
        <CommitDateField
          label="Committer date"
          value={draft.committer}
          onChange={(text) => onDraft({ ...draft, committer: text })}
          original={original.committer}
          date={committer}
          error={resolved.committerError}
          nowMs={nowMs}
          note={committerNote}
          heldReason={heldReason}
          reserveReset
        />
      )}
      {warnings.map((w) => (
        <DateWarning key={w}>{w}</DateWarning>
      ))}
      {isEdit && changed && (
        <p className="pl-30 text-[11px] text-muted-foreground">
          {EDIT_PAUSE_DATES_NOTE}
        </p>
      )}
      {!hasError && warnings.length === 0 && (
        <p className="pl-30 text-[11px] text-muted-foreground">
          {DATE_FORMAT_HINT}
        </p>
      )}
    </div>
  );
}

/** Whose offset the strip assumes when none is typed: it applies the offset of
 *  the commit its text was filled from to every selected commit. */
const stripOffsetNote = (seedHash: string) =>
  `the offset of ${seedHash.slice(0, 7)}, the commit this strip was filled from`;

/** The shared editor for a multi-selection's dates, seeded once when it
 *  appears. Its draft holds texts and the offsets an omitted one falls back to. */
interface StripDraft {
  /** The commit the strip was filled from, whose offsets are the fallbacks. */
  seedHash: string;
  author: string;
  same: boolean;
  committer: string;
  fallback: CommitDate;
  fallbackCommitter: CommitDate;
}

function SelectionStrip({
  count,
  skipped,
  draft,
  nowMs,
  heldReason,
  onDraft,
  onApply,
  onClear,
  onEscape,
}: {
  count: number;
  skipped: number;
  draft: StripDraft;
  nowMs: number;
  heldReason: string | null;
  onDraft: (next: StripDraft) => void;
  onApply: () => void;
  onClear: () => void;
  /** `repeat` is the key's auto-repeat flag. */
  onEscape: (repeat: boolean) => void;
}) {
  const author = readCommitDate(draft.author, draft.fallback.offsetMinutes);
  const committer = draft.same
    ? author
    : readCommitDate(draft.committer, draft.fallbackCommitter.offsetMinutes);
  const applyReason = (() => {
    switch (true) {
      case heldReason !== null:
        return heldReason;
      case !author.ok || !committer.ok:
        return FIX_DATE_FIRST;
      default:
        return null;
    }
  })();
  return (
    <div
      role="group"
      aria-label="Dates for the selected commits"
      data-dates-strip=""
      className="shrink-0 space-y-1.5 border bg-muted/40 px-2 py-2"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        e.preventDefault();
        onEscape(e.repeat);
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs">
          <span className="tabular-nums">{count}</span> commits selected
        </span>
        <DisabledReasonButton
          type="button"
          variant="ghost"
          size="xs"
          disabled={heldReason !== null}
          reason={heldReason}
          onClick={onClear}
        >
          Clear selection
        </DisabledReasonButton>
      </div>
      <CommitDateField
        label={`Date for all ${count}`}
        value={draft.author}
        onChange={(text) => onDraft({ ...draft, author: text })}
        original={draft.fallback}
        date={author.ok ? author.date : null}
        error={author.ok ? null : author.error}
        nowMs={nowMs}
        offsetNote={stripOffsetNote(draft.seedHash)}
        heldReason={heldReason}
        trailing={
          <DisabledReasonButton
            type="button"
            variant="outline"
            size="xs"
            disabled={applyReason !== null}
            reason={applyReason}
            onClick={onApply}
          >
            Apply to {count}
          </DisabledReasonButton>
        }
      />
      <SameAsAuthorCheckbox
        checked={draft.same}
        heldReason={heldReason}
        onChange={(same) => onDraft({ ...draft, same })}
      />
      {!draft.same && (
        <CommitDateField
          label="Committer date"
          value={draft.committer}
          onChange={(text) => onDraft({ ...draft, committer: text })}
          original={draft.fallbackCommitter}
          date={committer.ok ? committer.date : null}
          error={committer.ok ? null : committer.error}
          nowMs={nowMs}
          offsetNote={stripOffsetNote(draft.seedHash)}
          heldReason={heldReason}
        />
      )}
      <p className="text-[11px] text-muted-foreground">
        Each selected commit gets exactly this date. They keep their order: Git
        orders equal dates by ancestry.
      </p>
      {skipped > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {skipped} in the selection can't take dates and{" "}
          {skipped === 1 ? "is" : "are"} skipped.
        </p>
      )}
    </div>
  );
}

/**
 * The unified interactive-rebase editor over the unpushed tip (`base..HEAD`).
 * Each row picks an action (pick / reword / squash / fixup / edit / drop),
 * reorders with its ↑/↓ buttons, Alt+↑/↓ or Alt+Home/End, edits its message
 * inline when the action bakes one (reword, squash, and a pick or edit a
 * squash folds into), and edits its dates inline (one row, or a selection
 * through the strip above the list).
 * The plan compiles to the replay engine, which applies it all at once (a
 * conflict rolls it back), or to a resumable rebase when a row is set to edit.
 */
export function EditHistoryDialog({
  repoPath,
  base,
  commits,
  emptyNote,
  open,
  onOpenChange,
  onDone,
  initialDatesFor,
}: {
  repoPath: string;
  base: string;
  /** Editable unpushed commits, newest-first (matches the history list). */
  commits: CommitSummary[];
  /** Why `commits` is empty, shown in the footer while it is; the caller
   *  derives it from the same hold that disables the menu rows. */
  emptyNote: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
  /** A commit whose Dates editor starts open; the dialog's initial focus is
   *  that row, and nothing moves focus later when its dates arrive. */
  initialDatesFor?: string;
}) {
  const rewrite = useRewriteCommits(repoPath);
  const rebaseEdit = useRebaseEdit(repoPath);
  const busy = rewrite.isPending || rebaseEdit.isPending;
  const setRepoTab = useUiStore((s) => s.setRepoTab);
  const messages = useUnpushedMessages(repoPath, base, open);
  // The base's author date judges the oldest planned commit: a dated plan is
  // held while it reads, and a failed read asks instead of judging.
  const baseDetails = useCommitDetails(
    repoPath,
    commits.length > 0 && base !== "" ? base : null,
  );
  const nowMs = useRelativeNow();
  const idBase = useId();

  const [order, setOrder] = useState<string[]>(() =>
    commits.map((c) => c.hash),
  );
  const [actions, setActions] = useState<Record<string, RowAction>>({});
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [dateDrafts, setDateDrafts] = useState<Record<string, DateDraft>>({});
  const [openDates, setOpenDates] = useState<ReadonlySet<string>>(
    () => new Set(initialDatesFor === undefined ? [] : [initialDatesFor]),
  );
  // Selection is explicit and a set of hashes: rows that can't take dates are
  // filtered out at read time, so an eligibility change never needs a clear.
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  // The focused row at the latest selecting gesture: the strip seeds from it.
  const [gestureFocus, setGestureFocus] = useState<string | null>(null);
  const [strip, setStrip] = useState<StripDraft | null>(null);
  // Bumps on every reseed, so focus the reorder dropped can be put back.
  const [reseedNonce, setReseedNonce] = useState(0);
  const [menuHash, setMenuHash] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState({ text: "", seq: 0 });
  const announce = (text: string) =>
    setAnnouncement((prev) => ({ text, seq: prev.seq + 1 }));

  // The display order only: `order` and the plan stay newest-first.
  const settings = useSettings();
  const queryClient = useQueryClient();
  const saveOrder = useSaveSettingsPatch();
  // The last pick until its write settles: an earlier write's re-read lands
  // that write's order in the cache while the later one is still pending.
  const [pendingOrder, setPendingOrder] = useState<ListOrder | null>(null);
  const listOrder =
    pendingOrder ?? settings.data?.editHistoryOrder ?? "newest-first";
  const reversed = listOrder === "oldest-first";
  // Until settings load there is nothing to patch, so the toggle holds.
  let orderHold: OrderHold | null = null;
  if (settings.data === undefined) {
    orderHold = settings.isError ? "failed" : "loading";
  }
  // Held by aria-disabled, not native disabled, so the segments keep their tab
  // stop and the reason reaches keyboard and AT.
  const orderToggleHold = useDisabledReason({
    disabled: orderHold !== null,
    reason: orderHold === null ? null : ORDER_HOLD_REASON[orderHold],
  });
  function applyListOrder(next: ListOrder) {
    const current = settings.data;
    if (!current || listOrder === next) return;
    persistedOrder ??= current.editHistoryOrder;
    const updated = { ...current, editHistoryOrder: next };
    const seq = ++orderChangeSeq;
    setPendingOrder(next);
    // A settings read already running would land the old order over the patch.
    void queryClient.cancelQueries({
      queryKey: settingsKeys.settings,
      exact: true,
    });
    // Patched first, so the click's own commit reverses the list.
    queryClient.setQueryData(settingsKeys.settings, updated);
    // Only the field: the cached snapshot's other fields can be older than disk.
    void saveOrder.mutateAsync({ editHistoryOrder: next }).then(
      () => {
        if (seq === orderChangeSeq) setPendingOrder(null);
      },
      () => {
        if (seq !== orderChangeSeq) return;
        setPendingOrder(null);
        const latest = queryClient.getQueryData<AppSettings>(
          settingsKeys.settings,
        );
        if (latest === undefined || persistedOrder === null) return;
        // Only this field, and no re-read: a concurrent settings change still
        // pending must keep its own optimistic value and rollback.
        queryClient.setQueryData(settingsKeys.settings, {
          ...latest,
          editHistoryOrder: persistedOrder,
        });
      },
    );
  }

  // Reseed when a different set of commits arrives (render-time adjustment).
  const key = commits.map((c) => c.hash).join();
  const [lastKey, setLastKey] = useState(key);
  const [lastNote, setLastNote] = useState(emptyNote);
  if (key !== lastKey) {
    setLastKey(key);
    setOrder(commits.map((c) => c.hash));
    setActions({});
    setOverrides({});
    setDateDrafts({});
    setOpenDates(new Set());
    setPicked(new Set());
    setAnchor(null);
    setGestureFocus(null);
    setStrip(null);
    setReseedNonce((n) => n + 1);
    // The footer's note is spoken whenever it changes under an open dialog:
    // when the rows vanish (here) or when an empty set's reason moves on (below),
    // once per change and never on mount.
    if (commits.length === 0 && emptyNote !== "") announce(emptyNote);
    // A menu whose row left would otherwise reopen by itself if the row came
    // back; one whose row survived stays open.
    if (menuHash !== null && !commits.some((c) => c.hash === menuHash)) {
      setMenuHash(null);
    }
  }
  if (emptyNote !== lastNote) {
    setLastNote(emptyNote);
    if (key === lastKey && commits.length === 0 && emptyNote !== "")
      announce(emptyNote);
  }

  const subjectOf = useMemo(
    () => new Map(commits.map((c) => [c.hash, c.subject])),
    [commits],
  );
  const listedDateOf = useMemo(
    () => new Map(commits.map((c) => [c.hash, c.date])),
    [commits],
  );
  const fullMessages = messages.data ?? {};

  // Per-row AI message generation (reword only — a single commit's own diff).
  // The hash lives in state so render can read which row is generating; the ref
  // mirrors it for the async completion callback (which fires after streaming).
  const [genHash, setGenHash] = useState<string | null>(null);
  const genHashRef = useLatestRef(genHash);
  const aiEnabled = useAiEnabled();
  // A reseed retires the reword a run writes into, and its hash may survive
  // into the new set: text from a run started before a reseed is dropped (a
  // hidden tab commits reseeds but runs no effects). Keyed on the reseed count,
  // not the commit set, so a set that changes and changes back still counts.
  const genKeyRef = useRef<number | null>(null);
  const liveKeyRef = useLatestRef(reseedNonce);
  const ai = useGenerateSquashMessage(repoPath, (message) => {
    const h = genHashRef.current;
    if (h && genKeyRef.current === liveKeyRef.current)
      setOverrides((o) => ({ ...o, [h]: message }));
  });
  // Any reseed committed since the last run of this effect stops the run, hidden
  // ones included once the tab shows. The ref keeps an <Activity> show with no
  // reseed, which replays this effect, from stopping it.
  const committedKeyRef = useRef(reseedNonce);
  const stopGeneration = useEffectEvent(() => {
    ai.cancel();
    setGenHash(null);
  });
  useEffect(() => {
    if (committedKeyRef.current === reseedNonce) return;
    committedKeyRef.current = reseedNonce;
    stopGeneration();
  }, [reseedNonce]);

  const dateInfo = useMemo(() => {
    const out = new Map<string, RowDates>();
    for (const hash of order) {
      out.set(
        hash,
        rowDatesOf(messages.data?.[hash], messages.isError, dateDrafts[hash]),
      );
    }
    return out;
  }, [order, messages.data, messages.isError, dateDrafts]);

  const rows: EditRow[] = useMemo(
    () =>
      order.map((hash) => {
        const action = actions[hash] ?? "pick";
        const subject = subjectOf.get(hash) ?? hash.slice(0, 7);
        // The full original message (or subject until it loads); compilePlan
        // uses it only for reword/squash leaders and squash contributions.
        const message =
          overrides[hash] ?? fullMessages[hash]?.message ?? subject;
        const row: EditRow = { hash, subject, action, message };
        // Only a row that can take dates, with a change and no error, carries
        // them; a held row's draft waits for the row to come back.
        const info = dateInfo.get(hash);
        if (structuralHold(action, info) === null && info?.kind === "ok") {
          const { changed, authorError, committerError } = info.resolved;
          if (changed && authorError === null && committerError === null) {
            row.dates = {
              ...(info.resolved.authorDate && {
                authorDate: info.resolved.authorDate,
              }),
              ...(info.resolved.committerDate && {
                committerDate: info.resolved.committerDate,
              }),
            };
          }
        }
        return row;
      }),
    [order, actions, overrides, subjectOf, fullMessages, dateInfo],
  );

  const originalHashes = useMemo(() => commits.map((c) => c.hash), [commits]);
  const plan = useMemo(
    () => compilePlan(rows, originalHashes),
    [rows, originalHashes],
  );
  // reword/squash bake the message into the rewrite, and a dated step its
  // dates, so neither can be applied until the plan's own rows have loaded:
  // otherwise a multi-line body would be silently truncated to its subject.
  const needsRead =
    plan.datedCount > 0 ||
    rows.some((r) => r.action === "reword" || r.action === "squash");
  const rowsRead = rows.every((r) => messages.data?.[r.hash] !== undefined);
  // A held fold's error says where the missing older commit would sit in the
  // displayed list; every other plan error reads verbatim. Shared by the footer
  // and the move announcement, so both say the same thing.
  function heldFoldErrorOf(p: CompiledPlan, r: EditRow[]): string | null {
    if (p.error === null || p.errorHash === null) return null;
    const i = r.findIndex((x) => x.hash === p.errorHash);
    const row = r[i];
    if (row === undefined || !isFold(row.action)) return null;
    if (p.views[i].foldTarget !== null) return null;
    return `"${row.subject}" can't be ${FOLD_VERB[row.action]} — no older commit ${ORDER_COPY[listOrder].foldPosition} in this list is kept to combine it into.`;
  }
  const heldFoldError = heldFoldErrorOf(plan, rows);

  // Before-parent: judged on the compiled plan, from the rows' original
  // author dates and the base's (placeholder-guarded: the details read keeps
  // the previous commit's answer while the next loads).
  // A row whose committer date alone is unreadable still has a readable author
  // date, so its children are compared against it.
  const originalAuthor: Record<string, CommitDate> = {};
  for (const [hash, info] of dateInfo) {
    if (info.kind === "ok") originalAuthor[hash] = info.original.author;
    else if (info.kind === "unreadable" && info.author !== null) {
      originalAuthor[hash] = info.author;
    }
  }
  const baseRead = ((): "none" | "pending" | "unread" | CommitDate => {
    if (commits.length === 0 || base === "") return "none";
    if (!baseDetails.isPlaceholderData && baseDetails.data?.hash === base) {
      return commitDateFromIso(baseDetails.data.date) ?? "unread";
    }
    return baseDetails.isError ? "unread" : "pending";
  })();
  const beforeParent = beforeParentSteps({
    steps: plan.steps,
    originalAuthor,
    base:
      typeof baseRead === "string" ? null : { hash: base, author: baseRead },
  });
  // Unread base: the oldest step is flagged whenever its author date is edited,
  // the condition under which a readable base would have been compared.
  const oldest = plan.steps.at(0);
  const oldestOriginal =
    oldest === undefined ? undefined : originalAuthor[oldest.hashes[0]];
  const parentUnread =
    baseRead === "unread" &&
    oldest?.authorDate !== undefined &&
    oldestOriginal !== undefined &&
    !sameCommitDate(oldest.authorDate, oldestOriginal);
  const parentFlags: ParentFlag[] =
    parentUnread && oldest !== undefined
      ? [
          { hash: oldest.hashes[0], parentHash: base, parentDate: null },
          ...beforeParent,
        ]
      : beforeParent;
  const parentFlagOf = new Map(parentFlags.map((b) => [b.hash, b]));

  // Display order; each displayed row maps back to its data index through
  // `displayIndex`, which `plan.views` and the moves index by.
  const shownRows = reversed ? [...rows].reverse() : rows;

  const canTakeDates = (row: EditRow) =>
    structuralHold(row.action, dateInfo.get(row.hash)) === null;
  const selectedOf = (set: ReadonlySet<string>) =>
    shownRows.filter((r) => set.has(r.hash) && canTakeDates(r));
  const selected = selectedOf(picked);
  const skipped = picked.size - selected.length;
  const stripShown = selected.length >= 2;
  // Seeded once, when the strip first shows: from the focused row when it can
  // take dates, else the first selected row; later selection changes keep it.
  if (stripShown && strip === null) {
    const seedRow =
      selected.find((r) => r.hash === gestureFocus) ?? selected[0];
    const info = dateInfo.get(seedRow.hash);
    if (info?.kind === "ok") {
      const { planned } = info.resolved;
      setStrip({
        seedHash: seedRow.hash,
        author: formatCommitDate(planned.author ?? info.original.author),
        same: info.resolved.same,
        committer: formatCommitDate(
          planned.committer ?? info.original.committer,
        ),
        fallback: info.original.author,
        fallbackCommitter: info.original.committer,
      });
    }
  }
  if (!stripShown && strip !== null) setStrip(null);

  // The first row, in display order, whose date can't be read as typed.
  const invalidDateRow = shownRows.find((r) => {
    const info = dateInfo.get(r.hash);
    return (
      canTakeDates(r) &&
      info?.kind === "ok" &&
      (info.resolved.authorError !== null ||
        info.resolved.committerError !== null)
    );
  });
  const primaryLabel = plan.hasEdit ? "Start rebase" : "Rewrite history";
  const primaryReason = (() => {
    switch (true) {
      case busy:
        return BUSY_REASON;
      case plan.error !== null:
        return heldFoldError ?? plan.error;
      case invalidDateRow !== undefined:
        return `Fix the date on ${invalidDateRow.hash.slice(0, 7)} first.`;
      case !plan.changed:
        return "Nothing to rewrite yet.";
      case needsRead && !rowsRead && messages.isError:
        return "Couldn't load commit messages and dates.";
      case needsRead && !rowsRead:
        return "Loading commit messages and dates…";
      case plan.datedCount > 0 && baseRead === "pending":
        return PARENT_DATE_PENDING;
      default:
        return null;
    }
  })();

  // The rows are one Tab stop (message and date fields and Generate keep their
  // own); the trigger and arrow buttons are tabIndex -1, as Enter or Space
  // opens the menu from the row.
  const nav = useRovingRows({ items: shownRows, rowKey: (r) => r.hash });
  const listRef = useRef<HTMLDivElement>(null);
  const lastFocusedRow = useRef<string | null>(null);
  // The row whose menu `onOpenChange(true)` opened during a key-driven click.
  const keyOpenedRow = useRef<string | null>(null);
  // A row to land focus on after the commit that moved or unmounted what held
  // it: a move, or an editor or the strip closing under focus.
  const [rowFocus, setRowFocus] = useState<{
    hash: string;
    nonce: number;
  } | null>(null);
  const focusRow = (hash: string) =>
    setRowFocus((prev) => ({ hash, nonce: (prev?.nonce ?? 0) + 1 }));
  // A row whose just-opened editor takes focus in its author field.
  const [datesFocus, setDatesFocus] = useState<{
    hash: string;
    nonce: number;
  } | null>(null);

  // A move re-orders keyed nodes, which can drop focus off the moved row (and a
  // button click parks it on a button), so every move lands focus back on it.
  useLayoutEffect(() => {
    if (rowFocus === null) return;
    const el = findRow(listRef.current, rowFocus.hash);
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  }, [rowFocus]);

  useLayoutEffect(() => {
    if (datesFocus === null) return;
    findRow(listRef.current, datesFocus.hash)
      ?.querySelector<HTMLElement>("[data-row-dates] input")
      ?.focus();
  }, [datesFocus]);

  // A reseed re-orders and can drop rows too. Focus returns only when it was on
  // a row or fell to the body; a field that survived, Generate or the footer
  // keep it.
  useLayoutEffect(() => {
    if (reseedNonce === 0) return;
    const list = listRef.current;
    if (list === null) return;
    const active = document.activeElement;
    const onRow =
      active instanceof HTMLElement &&
      list.contains(active) &&
      active.closest(
        "[data-row-message], [data-row-dates], [data-dates-strip]",
      ) === null;
    if (!onRow && active !== null && active !== document.body) return;
    const remembered = lastFocusedRow.current;
    const el =
      (remembered === null ? null : findRow(list, remembered)) ??
      list.querySelector<HTMLElement>("[data-row]");
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  }, [reseedNonce]);

  function setAction(hash: string, action: RowAction) {
    setActions((a) => ({ ...a, [hash]: action }));
  }

  function setDraft(hash: string, draft: DateDraft) {
    setDateDrafts((d) => ({ ...d, [hash]: draft }));
  }

  function resetDraft(hash: string) {
    setDateDrafts((d) => {
      const { [hash]: _gone, ...rest } = d;
      return rest;
    });
  }

  function toggleDates(hash: string) {
    setOpenDates((s) => {
      const next = new Set(s);
      if (!next.delete(hash)) next.add(hash);
      return next;
    });
  }

  function closeDates(hash: string) {
    setOpenDates((s) => {
      const next = new Set(s);
      next.delete(hash);
      return next;
    });
    focusRow(hash);
  }

  /** Display-order hashes from `from` to `to`, both included. */
  function rangeOf(from: string, to: string): Set<string> {
    const a = shownRows.findIndex((r) => r.hash === from);
    const b = shownRows.findIndex((r) => r.hash === to);
    if (a === -1 || b === -1) return new Set([to]);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    return new Set(shownRows.slice(lo, hi + 1).map((r) => r.hash));
  }

  function select(
    next: ReadonlySet<string>,
    nextAnchor: string | null,
    focused: string | null,
  ) {
    const same =
      next.size === picked.size && [...next].every((h) => picked.has(h));
    setPicked(next);
    setAnchor(nextAnchor);
    setGestureFocus(focused);
    if (same) return;
    const n = selectedOf(next).length;
    const k = next.size - n;
    if (n === 0 && k === 0) {
      announce("Selection cleared");
      return;
    }
    announce(`${n} ${commitsWord(n)} selected${skippedTail(k)}`);
  }

  // Escape in an editor or the strip refuses while busy: nothing unmounts for
  // the length of a rewrite.
  function escapeUnlessBusy(repeat: boolean, close: () => void) {
    if (!busy) close();
    else if (!repeat) announce(BUSY_REASON);
  }

  // Clearing from the strip lands on the anchor row, else the last focused
  // row, else the first: the strip unmounts under focus.
  function clearSelection() {
    const target =
      anchor ?? lastFocusedRow.current ?? shownRows[0]?.hash ?? null;
    select(new Set(), null, null);
    if (target !== null) focusRow(target);
  }

  function applyStrip() {
    if (strip === null || busy) return;
    const a = readCommitDate(strip.author, strip.fallback.offsetMinutes);
    const c = strip.same
      ? a
      : readCommitDate(strip.committer, strip.fallbackCommitter.offsetMinutes);
    if (!a.ok || !c.ok) return;
    const draft: DateDraft = {
      author: formatCommitDate(a.date),
      same: strip.same,
      committer: formatCommitDate(c.date),
    };
    setDateDrafts((d) => {
      const next = { ...d };
      for (const r of selected) next[r.hash] = draft;
      return next;
    });
    announce(
      `Dates applied to ${selected.length} ${commitsWord(selected.length)}${skippedTail(skipped)}`,
    );
  }

  // Moves the row at `index` to `to` and announces it (`moveAnnouncement` says
  // what that covers). The next plan is compiled here: the memoized one is a
  // render behind inside the handler.
  function moveTo(index: number, to: number) {
    if (to === index || to < 0 || to >= order.length) return;
    const nextOrder = [...order];
    const [hash] = nextOrder.splice(index, 1);
    nextOrder.splice(to, 0, hash);
    const nextRows = [...rows];
    const [moved] = nextRows.splice(index, 1);
    nextRows.splice(to, 0, moved);
    const nextPlan = compilePlan(nextRows, originalHashes);
    setOrder(nextOrder);
    focusRow(hash);

    announce(
      moveAnnouncement({
        prev: plan,
        next: nextPlan,
        action: moved.action,
        hash,
        from: index,
        to,
        total: order.length,
        reversed,
        heldLabel: ORDER_COPY[listOrder].heldLabel,
        errorText: heldFoldErrorOf(nextPlan, nextRows),
      }),
    );
  }

  function onListKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // Rows only: caret keys in a message or date field, and keys on a button
    // or in a menu, keep their own behavior.
    const row = e.target;
    if (!(row instanceof HTMLElement)) return;
    const hash = row.getAttribute("data-row");
    if (hash === null) return;
    const chord = eventToBinding(e);
    const direction = chord === null ? undefined : MOVE_CHORDS[chord];
    const swallowed = e.altKey && ALT_SWALLOWED_KEYS.has(e.key);
    // Plain Home/End only; a modified one keeps its native behavior.
    const jump = chord === "home" || chord === "end";
    // Unmodified only: the canonical binding carries every modifier, so a
    // modified Enter or Space keeps its native behavior (Shift+Space scrolls,
    // Alt+Space is the system menu).
    const menuKey = chord === "enter" || chord === "space";
    const extend = chord === "shift+up" || chord === "shift+down";

    // Every consumed press is default-prevented, so a user binding of the same
    // key can't also fire behind the dialog.
    if (chord === "d") {
      e.preventDefault();
      if (e.repeat) return;
      if (busy) {
        announce(BUSY_REASON);
        return;
      }
      const hold = structuralHold(actions[hash] ?? "pick", dateInfo.get(hash));
      if (hold !== null) {
        announce(DATE_HOLD_REASON[hold]);
        return;
      }
      setOpenDates((s) => (s.has(hash) ? s : new Set(s).add(hash)));
      setDatesFocus((prev) => ({ hash, nonce: (prev?.nonce ?? 0) + 1 }));
      return;
    }
    if (extend) {
      e.preventDefault();
      if (busy) {
        if (!e.repeat) announce(BUSY_REASON);
        return;
      }
      const at = shownRows.findIndex((r) => r.hash === hash);
      const landing = shownRows[at + (chord === "shift+up" ? -1 : 1)];
      // At the edge nothing moves; the key is still consumed.
      if (landing === undefined) return;
      const from = anchor ?? hash;
      const el = findRow(listRef.current, landing.hash);
      el?.focus();
      el?.scrollIntoView({ block: "nearest" });
      select(rangeOf(from, landing.hash), from, landing.hash);
      return;
    }

    // While busy, walking the rows stays live (it changes nothing); moves, the
    // Alt swallow and the menu open refuse with the reason.
    if (busy && (direction !== undefined || swallowed || menuKey)) {
      e.preventDefault();
      if (!e.repeat) announce(BUSY_REASON);
      return;
    }
    // No repeat gate: holding the chord repeats the move.
    if (direction !== undefined) {
      e.preventDefault();
      const index = order.indexOf(hash);
      const target = visualMoveTarget(index, order.length, direction, reversed);
      if ("to" in target) moveTo(index, target.to);
      // Once per press: a held chord at the end would spam the region.
      else if (!e.repeat) announce(END_REASON[target.at]);
      return;
    }
    if (swallowed) {
      e.preventDefault();
      return;
    }
    // Plain navigation clears a selection, as History and Changes do; a busy
    // rewrite keeps it (nothing can act on it then).
    if (
      chord !== null &&
      NAV_KEYS.has(chord) &&
      !busy &&
      (picked.size > 0 || anchor !== null)
    ) {
      select(new Set(), null, null);
    }
    if (jump) {
      const all = e.currentTarget.querySelectorAll<HTMLElement>("[data-row]");
      const edge = chord === "home" ? all[0] : all[all.length - 1];
      if (edge === undefined) return;
      e.preventDefault();
      edge.focus();
      edge.scrollIntoView({ block: "nearest" });
      return;
    }
    if (menuKey) {
      // Every press is handled, so a held Space can't scroll the list; only the
      // first opens, as a held Enter would flicker the menu.
      e.preventDefault();
      if (e.repeat) return;
      // A controlled open gets no keyboard highlight, so open through Base UI's
      // own keyboard-activation click (detail 0, no pointer type) on the trigger.
      const trigger = row.querySelector<HTMLElement>("[data-action-trigger]");
      const click = () =>
        trigger?.dispatchEvent(
          new PointerEvent("click", {
            bubbles: true,
            cancelable: true,
            composed: true,
            detail: 0,
          }),
        );
      keyOpenedRow.current = null;
      click();
      // A press that ended off the trigger makes Base UI swallow one click.
      if (keyOpenedRow.current !== hash) click();
      return;
    }
    nav.onRowKeyDown(e);
  }

  /** The row a pointer event hit on its body: never a control, a field or a
   *  menu (a portaled menu bubbles through React, so containment is checked). */
  function rowBodyOf(e: MouseEvent<HTMLDivElement>): HTMLElement | null {
    const t = e.target;
    if (!(t instanceof Element) || !e.currentTarget.contains(t)) return null;
    if (
      t.closest("[data-row-control], [data-row-dates], [data-row-message]") !==
      null
    ) {
      return null;
    }
    return t.closest<HTMLElement>("[data-row]");
  }

  // Shift+click would otherwise start a native text-range selection; its
  // click handler focuses the row itself.
  function onListMouseDown(e: MouseEvent<HTMLDivElement>) {
    if (e.shiftKey && rowBodyOf(e) !== null) e.preventDefault();
  }

  function onListClick(e: MouseEvent<HTMLDivElement>) {
    const row = rowBodyOf(e);
    const hash = row?.getAttribute("data-row");
    if (row == null || hash == null) return;
    // Ctrl/Cmd through the hotkeys helper; Alt with it is no toggle gesture.
    const toggle = hasChordModifier(e) && !e.altKey;
    const modified = e.shiftKey || toggle;
    if (busy) {
      if (modified) announce(BUSY_REASON);
      return;
    }
    if (e.shiftKey) {
      const from = anchor ?? lastFocusedRow.current ?? hash;
      row.focus();
      select(rangeOf(from, hash), from, hash);
      return;
    }
    if (toggle) {
      const next = new Set(picked);
      if (!next.delete(hash)) next.add(hash);
      row.focus();
      select(next, hash, hash);
      return;
    }
    if (picked.size > 0 || anchor !== null) select(new Set(), null, null);
  }

  function onListFocusCapture(e: FocusEvent<HTMLDivElement>) {
    if (e.target instanceof HTMLElement && e.target.hasAttribute("data-row")) {
      lastFocusedRow.current = e.target.getAttribute("data-row");
    }
  }

  // A failure that left the rebase in progress (a timed-out or interrupted run,
  // or a rollback that couldn't abort) hands off to Changes like a paused edit;
  // a clean rollback keeps the dialog open with the plan intact.
  async function handOffIfLeftRebasing() {
    if (!(await leftRebaseInProgress(repoPath))) return;
    if (useUiStore.getState().repoPath !== repoPath) return;
    onOpenChange(false);
    setRepoTab("changes");
    onDone();
  }

  // Awaited rather than per-call mutation callbacks: this dialog is mounted
  // conditionally, so closing it mid-rewrite would drop the outcome — including
  // the hand-off to the Changes tab that the paused rebase depends on.
  async function apply() {
    if (primaryReason !== null) return;
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return;
    }
    if (parentFlags.length > 0) {
      // One confirm for the whole plan. A commit set that changed under
      // the prompt drops the run, and a promote that started under it refuses.
      const asked = reseedNonce;
      const ok = await useConfirm
        .getState()
        .ask(
          datesBeforeParentConfirm(
            beforeParent.length,
            primaryLabel,
            parentUnread ? "oldest" : null,
          ),
        );
      if (!ok || liveKeyRef.current !== asked) return;
      if (promotionBlocksCheckout(repoPath)) {
        toast.info(PROMOTION_BLOCKS_CHECKOUT);
        return;
      }
    }
    if (plan.hasEdit) {
      // Resumable path: starts a real rebase that pauses at the first Edit —
      // the conflict/op banner in Changes takes it from there.
      try {
        await rebaseEdit.mutateAsync({
          base,
          steps: plan.steps,
          dropped: plan.dropped,
        });
        toast.success("Rebase started — paused to edit a commit");
        onOpenChange(false);
        if (useUiStore.getState().repoPath === repoPath) setRepoTab("changes");
        onDone();
      } catch (e) {
        toastError(e);
        await handOffIfLeftRebasing();
      }
      return;
    }
    try {
      await rewrite.mutateAsync({
        base,
        steps: plan.steps,
        dropped: plan.dropped,
      });
      toast.success(
        plan.resultCount === 1
          ? "History rewritten into one commit"
          : `History rewritten — ${plan.resultCount} commits`,
      );
      onOpenChange(false);
      onDone();
    } catch (e) {
      toastError(e);
      await handOffIfLeftRebasing();
    }
  }

  return (
    <Dialog
      open={open}
      // Close requests are ignored while the rewrite runs: a seconds-scale
      // local operation whose outcome this dialog still owes the user. A repo
      // switch, or leaving the repository view, unmounts it anyway; the
      // awaited continuation still settles, and its tab hand-off guards on
      // the live repo.
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      {/* The Root renders no element, so this sits in the host's own DOM, not
          the popup's portal: it tells the generator a tab hide from a close. */}
      <span hidden ref={ai.hostRef} />
      {/* The corner X would be a dead control while the guard above swallows
          every close path, so it goes away for the duration. */}
      <DialogContent
        className="flex max-h-[85vh] flex-col sm:max-w-2xl"
        showCloseButton={!busy}
        initialFocus={() =>
          (initialDatesFor === undefined
            ? null
            : findRow(listRef.current, initialDatesFor)) ??
          listRef.current?.querySelector<HTMLElement>("[data-row]") ??
          true
        }
      >
        <DialogHeader>
          {/* pr-8 keeps the order control clear of the corner X. */}
          <div className="flex items-center gap-3 pr-8">
            <DialogTitle>Edit history</DialogTitle>
            {/* Enabled while busy: it changes the rendering, never the plan. */}
            <span
              className={cn(
                "ml-auto inline-flex",
                orderToggleHold.blockedReason !== null && "cursor-not-allowed",
              )}
              title={orderToggleHold.wrapperTitle}
            >
              <ToggleGroup
                aria-label="Commit order"
                variant="outline"
                size="sm"
                spacing={0}
                value={[listOrder]}
                onValueChange={(next) => {
                  // Pressing the pressed segment reports [], which keeps it.
                  const picked = EDIT_HISTORY_ORDERS.find((o) => o === next[0]);
                  if (picked === undefined || picked === listOrder) return;
                  applyListOrder(picked);
                }}
              >
                <ToggleGroupItem
                  value="newest-first"
                  aria-disabled={orderHold !== null || undefined}
                  aria-describedby={orderToggleHold.describedBy}
                  className={cn(ARIA_DISABLED_CLASS, ORDER_SEGMENT_CLASS)}
                >
                  Newest first
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="oldest-first"
                  aria-disabled={orderHold !== null || undefined}
                  aria-describedby={orderToggleHold.describedBy}
                  className={cn(ARIA_DISABLED_CLASS, ORDER_SEGMENT_CLASS)}
                >
                  Oldest first
                </ToggleGroupItem>
              </ToggleGroup>
              {orderToggleHold.blockedReason !== null && (
                <span id={orderToggleHold.reasonId} className="sr-only">
                  {orderToggleHold.blockedReason}
                </span>
              )}
            </span>
          </div>
          <DialogDescription>
            Reshape your unpushed commits: reword, squash, fixup, drop, reorder,
            or change dates. {ORDER_COPY[listOrder].onTop}{" "}
            {formatBinding("alt+up")} and {formatBinding("alt+down")} move the
            focused commit; {formatBinding("shift+up")} or{" "}
            {formatBinding("shift+down")}, or {formatBinding("mod+click")},
            select several to date together. This rewrites local history; a
            conflict rolls it back.
          </DialogDescription>
        </DialogHeader>

        {stripShown && strip !== null && (
          <SelectionStrip
            count={selected.length}
            skipped={skipped}
            draft={strip}
            nowMs={nowMs}
            heldReason={busy ? BUSY_REASON : null}
            onDraft={setStrip}
            onApply={applyStrip}
            onClear={clearSelection}
            onEscape={(repeat) => escapeUnlessBusy(repeat, clearSelection)}
          />
        )}

        {/* data-multiselect: Ctrl/Cmd+scroll over a list that takes Ctrl+click
            scrolls it instead of zooming the app (src/lib/zoom/zoom.ts). */}
        <div
          ref={listRef}
          role="list"
          aria-label={ORDER_COPY[listOrder].listLabel}
          data-multiselect=""
          className="min-h-0 flex-1 space-y-px overflow-y-auto border"
          onKeyDown={onListKeyDown}
          onMouseDown={onListMouseDown}
          onClick={onListClick}
          onFocusCapture={onListFocusCapture}
        >
          {shownRows.map((row, shown) => {
            const index = displayIndex(shown, rows.length, reversed);
            const view = plan.views[index];
            const dropped = row.action === "drop";
            const target = view.foldTarget;
            const folds = isFold(row.action);
            const folding = folds && target !== null;
            const held = folds && target === null;
            const info = dateInfo.get(row.hash);
            const structural = structuralHold(row.action, info);
            const ok = info?.kind === "ok" ? info : null;
            const isSelected = picked.has(row.hash) && structural === null;
            const foldState = (() => {
              switch (true) {
                case folding:
                  return `, into "${target}"`;
                case held:
                  return `, ${ORDER_COPY[listOrder].heldLabel}`;
                default:
                  return "";
              }
            })();
            const glyph = (() => {
              switch (true) {
                case folding:
                  return "↳";
                case isSelected:
                  return <CheckIcon className="inline size-3" />;
                default:
                  return null;
              }
            })();
            const up = visualMoveTarget(index, rows.length, "up", reversed);
            const down = visualMoveTarget(index, rows.length, "down", reversed);
            const upReason = (() => {
              switch (true) {
                case busy:
                  return BUSY_REASON;
                case "at" in up:
                  return END_REASON[up.at];
                default:
                  return null;
              }
            })();
            const downReason = (() => {
              switch (true) {
                case busy:
                  return BUSY_REASON;
                case "at" in down:
                  return END_REASON[down.at];
                default:
                  return null;
              }
            })();
            const dateHold: DateHold | null = busy ? "busy" : structural;
            // A busy editor stays rendered and inert; any other hold drops it.
            const editorShown =
              ok !== null && structural === null && openDates.has(row.hash);
            const editorId = `${idBase}-dates-${row.hash}`;
            const changed = row.dates !== undefined;
            const flagged = parentFlagOf.get(row.hash);
            // The label falls back to the listed date while the read has none
            // for this row: display only, never a value to send.
            const shownDate = (() => {
              if (ok !== null) {
                return ok.resolved.planned.author ?? ok.original.author;
              }
              if (info?.kind === "unreadable" && info.author !== null) {
                return info.author;
              }
              return commitDateFromIso(listedDateOf.get(row.hash) ?? "");
            })();
            // With no date to show, the button's visible text (unreadable,
            // failed, or a loading skeleton) is what its name carries.
            const dateText = (() => {
              if (info?.kind === "unreadable") return UNREADABLE_DATE_TEXT;
              if (info?.kind === "none" && info.hold === "failed") {
                return DATE_FAILED_TEXT;
              }
              return null;
            })();
            const dateName = (() => {
              if (shownDate === null) {
                return dateText === null
                  ? `Dates for ${row.subject}`
                  : `Dates for ${row.subject}: ${dateText}`;
              }
              const full = formatCommitDate(shownDate);
              if (changed && ok !== null) {
                return `Dates for ${row.subject}: ${full}, was ${formatCommitDate(ok.original.author)}`;
              }
              return `Dates for ${row.subject}: ${full}`;
            })();
            return (
              <div
                key={row.hash}
                role="listitem"
                {...nav.rowProps(row)}
                aria-label={`${ACTION_LABEL.get(row.action)} ${row.hash.slice(0, 7)} ${row.subject}${foldState}${flagged !== undefined ? PARENT_FLAG_NAME[parentFlagKind(flagged)] : ""}${changed ? ", dates changed" : ""}${isSelected ? ", selected" : ""}`}
                aria-keyshortcuts={ROW_KEYSHORTCUTS}
                className={cn(
                  "border-b outline-none last:border-b-0 focus-visible:bg-muted/40 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset data-[dropped=true]:bg-muted/30",
                  isSelected && "bg-accent focus-visible:bg-accent",
                )}
                data-dropped={dropped}
              >
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <span data-row-control="" className="contents">
                    <DropdownMenu
                      open={menuHash === row.hash}
                      onOpenChange={(o) => {
                        if (o) keyOpenedRow.current = row.hash;
                        // Clears only its own row, so a close racing another
                        // row's open can't wipe that open.
                        setMenuHash((cur) => {
                          if (o) return row.hash;
                          return cur === row.hash ? null : cur;
                        });
                      }}
                    >
                      <DropdownMenuTrigger
                        render={
                          <DisabledReasonButton
                            variant="outline"
                            size="xs"
                            tabIndex={-1}
                            disabled={busy}
                            reason={BUSY_REASON}
                            data-action-trigger=""
                            className="w-20 justify-between"
                            aria-label={`Action for ${row.subject}`}
                          >
                            {ACTION_LABEL.get(row.action)}
                            <CaretDownIcon />
                          </DisabledReasonButton>
                        }
                      />
                      <DropdownMenuContent
                        align="start"
                        className="w-64"
                        // Back to the row, so the next arrow walks the list
                        // instead of reopening the menu from its trigger. Base
                        // UI runs an explicit target after the exit animation
                        // without checking where focus went, so focus already
                        // moved to another element (a click on another row) stays.
                        finalFocus={() => {
                          const active = document.activeElement;
                          if (
                            active !== null &&
                            active !== document.body &&
                            active.closest('[role="menu"]') === null
                          ) {
                            return false;
                          }
                          return findRow(listRef.current, row.hash) ?? true;
                        }}
                      >
                        {ACTIONS.map((a) => {
                          const heldItem = isFold(a.value) && target === null;
                          return (
                            <DropdownMenuItem
                              key={a.value}
                              disabled={heldItem}
                              // Named outright: the hint's first line is three
                              // flex items, which a name from content joins
                              // with spaces inside the quotes.
                              aria-label={
                                isFold(a.value) && target !== null
                                  ? `${a.label} Combine into "${target}" ${ORDER_COPY[listOrder].foldPosition}, ${FOLD_HINT_TAIL[a.value]}`
                                  : undefined
                              }
                              onClick={() => setAction(row.hash, a.value)}
                              // Base UI activates a menu item on keydown with
                              // no repeat check, so a key still held from
                              // opening the menu would pick the highlighted
                              // item.
                              onKeyDown={(e) => {
                                if (
                                  e.repeat &&
                                  (e.key === "Enter" || e.key === " ")
                                ) {
                                  e.preventDefault();
                                  e.preventBaseUIHandler();
                                }
                              }}
                              className={cn(
                                "flex-col items-start gap-0.5",
                                heldItem && MENU_HELD_ROW_CLASS,
                              )}
                            >
                              <span className="text-xs font-medium">
                                {a.label}
                              </span>
                              <ActionHint
                                action={a.value}
                                hint={a.hint}
                                target={target}
                                listOrder={listOrder}
                              />
                            </DropdownMenuItem>
                          );
                        })}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </span>

                  {/* Reserved on every row, so the fold glyph or the selection
                      check shifts nothing. A fold member is never selected. */}
                  <span
                    aria-hidden
                    className="w-3 shrink-0 text-center text-[11px] text-muted-foreground"
                  >
                    {glyph}
                  </span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {row.hash.slice(0, 7)}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-xs",
                      dropped && "text-muted-foreground line-through",
                    )}
                    onMouseEnter={clipTitleFromText}
                  >
                    {row.subject}
                  </span>
                  {folding && (
                    <span
                      className="max-w-[40%] truncate text-[11px] text-muted-foreground"
                      onMouseEnter={clipTitle(target)}
                    >
                      into <span className="text-foreground">"{target}"</span>
                    </span>
                  )}
                  {held && (
                    <span
                      className="max-w-[40%] truncate text-[11px] text-warning"
                      onMouseEnter={clipTitleFromText}
                    >
                      {ORDER_COPY[listOrder].heldLabel}
                    </span>
                  )}
                  {row.action === "edit" && (
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      pauses to amend
                    </span>
                  )}
                  {dropped && (
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      removed
                    </span>
                  )}
                  {flagged !== undefined && (
                    <span className="flex shrink-0 items-center gap-1 text-[11px] text-warning">
                      <WarningIcon aria-hidden className="size-3" />
                      {PARENT_FLAG_LABEL[parentFlagKind(flagged)]}
                    </span>
                  )}
                  <span data-row-control="" className="contents">
                    <DisabledReasonButton
                      type="button"
                      variant="ghost"
                      size="xs"
                      tabIndex={-1}
                      aria-label={dateName}
                      title={
                        shownDate === null
                          ? undefined
                          : formatCommitDate(shownDate)
                      }
                      aria-expanded={editorShown}
                      aria-controls={editorShown ? editorId : undefined}
                      disabled={dateHold !== null}
                      reason={
                        dateHold === null ? null : DATE_HOLD_REASON[dateHold]
                      }
                      className={cn(
                        "text-[11px] tabular-nums",
                        changed
                          ? "font-medium text-foreground"
                          : "font-normal text-muted-foreground",
                      )}
                      onClick={() => toggleDates(row.hash)}
                    >
                      {changed && <ClockIcon data-icon="inline-start" />}
                      {(() => {
                        if (shownDate !== null)
                          return rowDateLabel(shownDate, nowMs);
                        if (dateText !== null) return dateText;
                        return <Skeleton className="h-3 w-16" />;
                      })()}
                    </DisabledReasonButton>
                    <DisabledReasonButton
                      variant="ghost"
                      size="icon-xs"
                      tabIndex={-1}
                      aria-label={`Move ${row.subject} up`}
                      title={`Move up (${formatBinding("alt+up")})`}
                      disabled={upReason !== null}
                      reason={upReason}
                      onClick={() => {
                        if ("to" in up) moveTo(index, up.to);
                      }}
                    >
                      <ArrowUpIcon />
                    </DisabledReasonButton>
                    <DisabledReasonButton
                      variant="ghost"
                      size="icon-xs"
                      tabIndex={-1}
                      aria-label={`Move ${row.subject} down`}
                      title={`Move down (${formatBinding("alt+down")})`}
                      disabled={downReason !== null}
                      reason={downReason}
                      onClick={() => {
                        if ("to" in down) moveTo(index, down.to);
                      }}
                    >
                      <ArrowDownIcon />
                    </DisabledReasonButton>
                  </span>
                </div>

                {view.showMessage && (
                  <div
                    className="space-y-1 px-2 pb-2 pl-29"
                    data-row-message=""
                  >
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
                    {aiEnabled &&
                      row.action === "reword" &&
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
                        <DisabledReasonButton
                          type="button"
                          variant="ghost"
                          size="xs"
                          disabled={ai.generating || !messages.isSuccess}
                          title="Generate this commit's message with AI"
                          reason={generateHeldReason(
                            ai.generating,
                            messages.isError,
                          )}
                          onClick={() => {
                            setGenHash(row.hash);
                            genKeyRef.current = reseedNonce;
                            ai.generate(`${row.hash}^`, row.hash);
                          }}
                        >
                          <SparkleIcon data-icon="inline-start" />
                          Generate
                        </DisabledReasonButton>
                      ))}
                  </div>
                )}

                {editorShown && (
                  <RowDatesEditor
                    id={editorId}
                    subject={row.subject}
                    info={ok}
                    draft={draftOf(ok, dateDrafts[row.hash])}
                    isEdit={row.action === "edit"}
                    changed={changed}
                    parent={flagged}
                    nowMs={nowMs}
                    heldReason={busy ? BUSY_REASON : null}
                    onDraft={(d) => setDraft(row.hash, d)}
                    onReset={() => resetDraft(row.hash)}
                    onEscape={(repeat) =>
                      escapeUnlessBusy(repeat, () => closeDates(row.hash))
                    }
                  />
                )}
              </div>
            );
          })}
        </div>
        {/* Inside the popup: the dialog is modal, so content outside it is
            hidden from assistive tech. The seq's zero-width space makes a
            repeated message (the same end bump twice) still announce. */}
        <span role="status" aria-live="polite" className="sr-only">
          {announcement.text}
          {ZWSP.repeat(announcement.seq % 2)}
        </span>

        <DialogFooter className="sm:items-center sm:justify-between">
          <div className="mr-auto text-xs text-muted-foreground">
            {(() => {
              switch (true) {
                // First: an empty set has no messages worth retrying and no
                // plan to fault.
                case commits.length === 0 && emptyNote !== "":
                  return emptyNote;
                case messages.isError:
                  return (
                    <span className="text-warning">
                      Couldn't load commit messages and dates.{" "}
                      <button
                        type="button"
                        className="cursor-pointer underline underline-offset-2"
                        onClick={() => messages.refetch()}
                      >
                        Retry
                      </button>
                    </span>
                  );
                case Boolean(plan.error):
                  return (
                    <span className="text-warning">
                      {heldFoldError ?? plan.error}
                    </span>
                  );
                default:
                  return (
                    <>
                      Result:{" "}
                      <span className="tabular-nums text-foreground">
                        {plan.resultCount}
                      </span>{" "}
                      {commitsWord(plan.resultCount)}
                      {plan.datedCount > 0 && (
                        <>
                          {" · dates change on "}
                          <span className="tabular-nums text-foreground">
                            {plan.datedCount}
                          </span>
                        </>
                      )}
                      {beforeParent.length > 0 && (
                        <span className="text-warning">
                          {` · ${beforeParent.length} dated before ${beforeParent.length === 1 ? "its parent" : "their parents"}`}
                        </span>
                      )}
                      {parentUnread && (
                        <span className="text-warning">
                          {" · oldest commit's parent date unread"}
                        </span>
                      )}
                      {plan.hasEdit && (
                        <span className="block text-[11px]">
                          Pauses at each Edit so you can amend it, then Continue
                          from the banner.
                        </span>
                      )}
                    </>
                  );
              }
            })()}
          </div>
          <DisabledReasonButton
            variant="outline"
            disabled={busy}
            reason={BUSY_REASON}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </DisabledReasonButton>
          <DisabledReasonButton
            disabled={primaryReason !== null}
            reason={primaryReason}
            onClick={apply}
          >
            {busy && <Spinner data-icon="inline-start" />}
            {primaryLabel}
          </DisabledReasonButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
