import {
  CircleIcon,
  FileDashedIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  type Icon,
  MagnifyingGlassIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useState } from "react";
import { usePanelActive } from "@/components/panel-portal";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { StateIcon } from "@/features/issues/IssueRelations";
import { clipTitleFromText } from "@/lib/clip-title";
import { presentError } from "@/lib/error-summary";
import { required, useAppForm } from "@/lib/form";
import { useBoardCandidates } from "@/lib/git/queries";
import type { BoardCandidate, RemoteLens } from "@/lib/git/types";
import { SUBMIT_HINT } from "@/lib/hotkeys/binding";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import {
  ARIA_DISABLED_CLASS,
  useDisabledReason,
} from "@/lib/use-disabled-reason";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import { cn } from "@/lib/utils";

/** Long enough that a word typed at speed makes one search, short enough that the
 *  list feels live. The Explore and registry searches sit either side of it. */
const SEARCH_DEBOUNCE_MS = 300;

/** A pull request's glyph and tone per state, matching `BoardCard.tsx`'s own
 *  `PR_STATE` shape for shape — these rows sit one keystroke from the cards they
 *  become, so one state must not draw two different glyphs across the pair. Every
 *  arm carries its own SHAPE, including the unknown-state fallback below: the tone
 *  only repeats what the row already says in words, so two states separated by
 *  colour alone would be conveying meaning by colour. */
const PR_STATE: Record<string, { Icon: Icon; tone: string } | undefined> = {
  OPEN: { Icon: GitPullRequestIcon, tone: "text-success" },
  MERGED: { Icon: GitMergeIcon, tone: "text-merged" },
  CLOSED: { Icon: XCircleIcon, tone: "text-destructive" },
};

/** Why a closed issue closed, as words. An unmapped reason (wire drift) leaves the
 *  bare state rather than a guess — the board card's own rule. */
const CLOSED_REASON: Record<string, string> = {
  COMPLETED: "closed as completed",
  NOT_PLANNED: "closed as not planned",
  DUPLICATE: "closed as duplicate",
};

/** A candidate's state AND kind as words. Nothing here is carried by colour: the
 *  glyph's tone repeats what this sentence already says. A reason only qualifies a
 *  CLOSED issue — REOPENED rides an OPEN one. */
function candidateStateWord(candidate: BoardCandidate): string {
  if (candidate.kind === "pr") {
    if (candidate.isDraft && candidate.state === "OPEN")
      return "Draft pull request";
    const known: Record<string, string> = {
      OPEN: "Open pull request",
      MERGED: "Merged pull request",
      CLOSED: "Closed pull request",
    };
    return known[candidate.state] ?? `${candidate.state} pull request`;
  }
  if (candidate.state !== "CLOSED") return "Open issue";
  const reason =
    candidate.stateReason === null
      ? undefined
      : CLOSED_REASON[candidate.stateReason];
  return reason === undefined ? "Closed issue" : `Issue ${reason}`;
}

/** The row's leading glyph. Issues reuse the related-issue {@link StateIcon} the
 *  board card does, so a closed issue reads the same on both. */
function CandidateGlyph({ candidate }: { candidate: BoardCandidate }) {
  if (candidate.kind === "issue") return <StateIcon state={candidate.state} />;
  if (candidate.isDraft && candidate.state === "OPEN")
    return (
      <FileDashedIcon className="size-3.5 shrink-0 text-muted-foreground" />
    );
  // A state this build doesn't know keeps a shape of its own rather than
  // borrowing "open"'s glyph at another tone.
  const pill = PR_STATE[candidate.state] ?? {
    Icon: CircleIcon,
    tone: "text-muted-foreground",
  };
  return <pill.Icon className={cn("size-3.5 shrink-0", pill.tone)} />;
}

/** One short sentence where the results would be. The dialog's own arm of the
 *  board's {@link BoardNotice}. */
function ResultsNote({ children }: { children: ReactNode }) {
  return <p className="px-1 py-6 text-xs text-muted-foreground">{children}</p>;
}

/** The first paint of a search: a row shell rather than a spinner, so real rows
 *  replace it without the list shifting. */
function SearchingRows() {
  return (
    <>
      <span role="status" className="sr-only">
        Searching this repository…
      </span>
      <div aria-busy className="space-y-1.5 py-1">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    </>
  );
}

/**
 * One candidate row. Held rather than hidden whenever it can't be picked — already
 * on this board, already added here, or an add in flight — through the raw-button
 * arm of the disabled-reason contract, which keeps the row focusable so a keyboard
 * reader is told WHY rather than finding a gap in the list.
 */
function CandidateRow({
  candidate,
  heldReason,
  rovingTab,
  onAdd,
  onFocus,
}: {
  candidate: BoardCandidate;
  /** Why this row can't be picked, or undefined while it can. */
  heldReason: string | undefined;
  /** Roving tabindex: one tab stop for the whole list, on the active row. */
  rovingTab: number;
  onAdd: () => void;
  onFocus: () => void;
}) {
  const { blockedReason, reasonId, wrapperTitle, describedBy, nativeProps } =
    useDisabledReason({
      disabled: heldReason !== undefined,
      reason: heldReason,
      onClick: onAdd,
    });
  return (
    <button
      type="button"
      {...nativeProps}
      data-row={candidate.id}
      tabIndex={rovingTab}
      onFocus={onFocus}
      title={wrapperTitle}
      aria-describedby={describedBy}
      className={cn(
        "flex w-full items-center gap-1.5 border px-2 py-1.5 text-left text-xs outline-none hover:bg-muted/60 focus-visible:ring-1 focus-visible:ring-ring",
        blockedReason && "cursor-not-allowed",
        ARIA_DISABLED_CLASS,
      )}
    >
      <CandidateGlyph candidate={candidate} />
      <span className="sr-only">{candidateStateWord(candidate)}</span>
      <span className="shrink-0 tabular-nums text-muted-foreground">
        #{candidate.number}
      </span>
      <span
        className="min-w-0 flex-1 truncate"
        onMouseEnter={clipTitleFromText}
      >
        {candidate.title}
      </span>
      {blockedReason !== null && (
        <>
          <span aria-hidden className="shrink-0 text-muted-foreground">
            {blockedReason}
          </span>
          <span id={reasonId} className="sr-only">
            {blockedReason}
          </span>
        </>
      )}
    </button>
  );
}

/** The draft dialog's single-flight hold, in the board's own "Finishing…" register
 *  so the footer and the pending strip behind it name the same wait. */
const DRAFT_PENDING_REASON = "Finishing your last draft…";

const ON_BOARD_REASON = "Already on this board";
const ADDED_REASON = "Added";
/** The row the user actually clicked, from the click itself until the write
 *  settles. Its sibling names the hold the OTHER rows take meanwhile, which is a
 *  different statement: one of them is happening, the rest are waiting on it. */
const ADDING_REASON = "Adding…";
const ADDING_OTHER_REASON = "Finishing the last add…";

/**
 * Search this repository's issues and pull requests and add them to the board, one
 * at a time. The dialog STAYS OPEN after each add — consecutive adds are the point,
 * and Esc or Close is what ends the run.
 *
 * Current repo only, by owner's decision: an owner-wide search would offer items
 * from repositories this window isn't showing, and the board is reached from one.
 */
export function AddExistingItemsDialog({
  repoPath,
  projectTitle,
  lens,
  open,
  onOpenChange,
  onBoardContentIds,
  onAdd,
}: {
  repoPath: string;
  /** The board's title, for this dialog's own copy — never an id in user-facing
   *  text. The add's toast is the panel's, which owns the write. */
  projectTitle: string;
  /** The fork/upstream lens the board was read under: which repo "this" is. */
  lens: RemoteLens;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Content node ids of the board items LOADED so far. A board still paging in
   *  knows about its loaded pages alone, so this holds back the "already on this
   *  board" claim rather than making it about the whole board — and the add is
   *  idempotent, so a missed one costs nothing. */
  onBoardContentIds: Set<string>;
  /** Put `candidate` on the board, resolving whether it landed. The panel owns the
   *  write so the board can report it while this dialog is open — or after it has
   *  been closed over an add still in flight. */
  onAdd: (candidate: BoardCandidate) => Promise<boolean>;
}) {
  const [raw, setRaw] = useState("");
  const search = useDebouncedValue(raw.trim(), SEARCH_DEBOUNCE_MS);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Content ids added during THIS run of the dialog. The board's own refetch
  // settles behind the dialog, so `onBoardContentIds` can't be relied on to flip
  // a row before the user's next keystroke.
  const [added, setAdded] = useState<Set<string>>(new Set());
  // The row with a write in flight, held LOCALLY rather than read off the
  // mutation: this is set in the click handler itself, so the re-render that holds
  // every row lands before the next click event can be processed. The mutation's
  // own `isPending` arrives a beat later, which is exactly the window two fast
  // clicks used to fit through.
  const [pendingId, setPendingId] = useState<string | null>(null);

  // Each open is a fresh search: the dialog stays mounted across open/close, so
  // without this the last run's query and its "Added" flags come back with it.
  // `pendingId` is deliberately NOT reset — an add outlives a close (the panel
  // owns it), and clearing the flag would offer the row again mid-write.
  useSeedOnOpen(open, () => {
    setRaw("");
    setActiveId(null);
    setAdded(new Set());
  });

  // Gated on the panel being the VISIBLE tab as well as the dialog being open:
  // `<Activity>` defers a hidden panel's effects but NOT its queries, so a dialog
  // left open while the user works another repo tab would keep re-searching behind
  // it. The board's own reads take the same gate; this one reads it from the
  // panel's context rather than a prop, which holds through the dialog's portal
  // because context follows the React tree, not the DOM.
  //
  // Fired on an EMPTY search too: the backend trims the text into
  // `repo:<slug> sort:updated-desc`, so an untouched dialog opens on the
  // repository's recently-updated issues and pull requests rather than an empty
  // pane the user has to guess their way out of.
  const panelActive = usePanelActive();
  const candidates = useBoardCandidates(
    repoPath,
    search,
    open && panelActive,
    lens,
  );
  const rows = candidates.data?.candidates ?? [];
  // The rows on screen belong to the PREVIOUS search until every one of these
  // clears, so the two claims derived from them wait: "no matching items" and the
  // capped note. `isPlaceholderData` alone would miss the debounce window, where
  // the query hasn't even been asked the current question yet.
  const inFlight =
    raw.trim() !== search ||
    candidates.isFetching ||
    candidates.isPlaceholderData;

  const activeIndex = rows.findIndex((c) => c.id === activeId);
  // Nothing active yet (or the active row vanished under a new search) parks the
  // single tab stop on the first row.
  const focusIndex = activeIndex === -1 ? 0 : activeIndex;
  const onListKeyDown = listKeyboardNav<BoardCandidate>({
    items: rows,
    activeIndex,
    onActivate: (c) => setActiveId(c.id),
    rowKey: (c) => c.id,
  });

  /** Why `candidate` can't be picked, ranked: what it already is, then the write in
   *  flight — the clicked row and the rest saying different things about it.
   *  Single-flight on purpose, one add at a time, so the board's settle refetches
   *  can't race each other. */
  function heldReason(candidate: BoardCandidate): string | undefined {
    switch (true) {
      case added.has(candidate.id):
        return ADDED_REASON;
      case onBoardContentIds.has(candidate.id):
        return ON_BOARD_REASON;
      case pendingId === candidate.id:
        return ADDING_REASON;
      case pendingId !== null:
        return ADDING_OTHER_REASON;
      default:
        return undefined;
    }
  }

  async function add(candidate: BoardCandidate) {
    // Belt-and-braces with the row's own hold: it is derived at render, and a
    // click racing the render that sets it must not get through either.
    if (heldReason(candidate) !== undefined) return;
    // Before the await, so the row reads as busy from the click rather than from
    // the mutation's first settled state.
    setPendingId(candidate.id);
    const ok = await onAdd(candidate);
    // Functional, and it runs whichever way the write went: this dialog outlives
    // the write only when it stays open, and a failed add has to hand the row
    // back rather than leaving the whole list held.
    setPendingId((cur) => (cur === candidate.id ? null : cur));
    if (ok) setAdded((prev) => new Set(prev).add(candidate.id));
  }

  const body = (() => {
    switch (true) {
      case rows.length === 0 && inFlight:
        return <SearchingRows />;
      // Gated on having NOTHING to show. A refetch that failed over rows already
      // on screen must not blank them: those rows are real, just possibly stale,
      // and the full-pane error would trade a working list for a dead end. That
      // case takes the inline notice in the rows arm instead — the board's own
      // rule for a failed read over drawn cards.
      case candidates.error !== null && rows.length === 0:
        return (
          <div className="space-y-2 px-1 py-6 text-xs">
            <p className="text-muted-foreground">
              {presentError(candidates.error).summary}
            </p>
            <Button
              variant="outline"
              size="xs"
              onClick={() => void candidates.refetch()}
            >
              Retry
            </Button>
          </div>
        );
      case rows.length === 0:
        return <ResultsNote>No matching items in this repository.</ResultsNote>;
      default:
        return (
          <div className="space-y-1">
            {/* A failed read over rows that ARE on screen: the list stands and
                says what went wrong beside it, with its own retry — the in-flow
                notice shape the board uses for the same situation. Without this
                the rows would just go quietly stale, since `retry: false` means
                nothing tries again on its own. */}
            {candidates.error !== null && (
              <p className="flex flex-wrap items-center gap-1.5 px-1 pb-1 text-[11px]">
                <span className="text-destructive">
                  {presentError(candidates.error).summary}
                </span>
                <button
                  type="button"
                  aria-label="Retry searching this repository"
                  onClick={() => void candidates.refetch()}
                  className="cursor-pointer text-muted-foreground underline hover:text-foreground"
                >
                  Retry
                </button>
              </p>
            )}
            {rows.map((candidate, i) => (
              <CandidateRow
                key={candidate.id}
                candidate={candidate}
                heldReason={heldReason(candidate)}
                rovingTab={i === focusIndex ? 0 : -1}
                onAdd={() => void add(candidate)}
                onFocus={() => setActiveId(candidate.id)}
              />
            ))}
            {/* The board's own capped-note wording, one surface over: a capped
                search says what wasn't looked through rather than implying these
                are all of them. Held back while the rows are the previous
                query's, since the claim is about THIS one. */}
            {candidates.data?.truncated === true &&
              !candidates.isPlaceholderData && (
                <p className="px-1 pt-1 text-[11px] text-muted-foreground">
                  Some matching items aren't listed above.
                </p>
              )}
          </div>
        );
    }
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add issue or pull request</DialogTitle>
          <DialogDescription>
            Adds to {projectTitle}. The dialog stays open, so you can add
            several.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="Search this repository…"
            aria-label="Search this repository's issues and pull requests"
            className="pl-8"
            spellCheck={false}
          />
        </div>
        {/* The arrows drive the rows from here rather than from the input, so the
            caret keys still work while typing — the rows carry the roving tab
            stop and take focus as the selection moves. */}
        <div
          onKeyDown={onListKeyDown}
          className="max-h-[55vh] min-h-40 overflow-y-auto px-1"
        >
          {body}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A new DRAFT item: a note that lives on this board alone, with no issue behind it.
 * The body rides to GitHub as Markdown verbatim — the card's popover renders it as
 * such, so anything typed here survives the round trip.
 */
export function NewDraftDialog({
  projectTitle,
  open,
  pending,
  onOpenChange,
  onCreate,
}: {
  projectTitle: string;
  open: boolean;
  /** A draft write is in flight for this repo's boards — from THIS run or an
   *  earlier one the user closed over. Repo-level rather than per-board because the
   *  hold explains itself either way, and threading a project id through the
   *  write's variables to narrow it buys nothing. Single-flight, the same contract
   *  the add-existing rows keep: this dialog outlives its own submissions, so its
   *  form can't be the thing that knows one is still going. */
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  /** Write the draft. The panel owns it — so the board can report a write this
   *  dialog was closed over, and so the CLOSE on success is decided by whoever
   *  knows whether this run is still the one on screen. Resolves when the write
   *  settles either way; `onSubmit` awaits it, which drives the submit button's own
   *  spinner — the in-place feedback for the window where this dialog covers the
   *  board's strip. */
  onCreate: (title: string, body: string) => Promise<void>;
}) {
  const form = useAppForm({
    defaultValues: { title: "", body: "" },
    // Awaited but not acted on: the panel owns both outcomes. It closes this dialog
    // on success — and only if the run that submitted is still the one on screen,
    // which is a question about state the panel holds, not this component — and
    // leaves it open on failure, where the draft's text still is. The await is what
    // drives the submit button's spinner.
    onSubmit: ({ value }) => onCreate(value.title.trim(), value.body),
  });
  // Held rather than hidden, and explained where the user is looking. The reason is
  // the board's own "Finishing…" register, so the footer and the strip behind the
  // dialog describe the same wait. The submit chord's hint rides the same wrapper,
  // which is what keeps the reason from being overwritten by it while held.
  const { blockedReason, reasonId, wrapperTitle, describedBy } =
    useDisabledReason({
      disabled: pending,
      reason: DRAFT_PENDING_REASON,
      title: SUBMIT_HINT,
    });

  // keepDefaultValues: otherwise the per-render options sync clobbers the reset
  // values back to empty on an untouched form.
  useSeedOnOpen(open, () =>
    form.reset({ title: "", body: "" }, { keepDefaultValues: true }),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] flex-col sm:max-w-2xl"
        // mod+enter submits from anywhere in the dialog, the Notes textarea
        // included. Captured on DialogContent (the Popup) rather than the <form>:
        // the X close renders as a SIBLING of the form inside the Popup, so a chord
        // pressed with focus on X would bypass a form-level handler and reach the
        // global mod+enter action. ALWAYS swallow the chord here; submit only under
        // the gate the button takes.
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            if (!pending) form.handleSubmit();
          }
        }}
      >
        <form
          className="flex min-h-0 min-w-0 flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            // The same gate the button takes, so Enter can't walk around it.
            if (pending) return;
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New draft</DialogTitle>
            <DialogDescription>
              A note that lives on {projectTitle} alone. Convert it to an issue
              from the card's menu whenever it earns one.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            <form.AppField
              name="title"
              validators={{ onChange: ({ value }) => required(value) }}
            >
              {(field) => (
                <field.TextField label="Title" placeholder="Name the note" />
              )}
            </form.AppField>
            <form.AppField name="body">
              {(field) => (
                <field.MarkdownField
                  label="Notes"
                  placeholder="Markdown, rendered on the card"
                  rows={8}
                  textareaClassName="max-h-72 min-h-24 resize-y font-mono"
                />
              )}
            </form.AppField>
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
              {/* The reasoned hold keeps the button FOCUSABLE — a natively-disabled
                  control leaves the tab order, and a description nothing can reach
                  explains nothing. `focusableWhenDisabled` rides `blockedReason`
                  alone, so the plain `!canSubmit || isSubmitting` disable that
                  `SubmitButton` ORs in stays a native one: there is no reason to
                  announce for an empty title. Activation is refused by the Button's
                  own handler layer and again by the form's `pending` guard. */}
              <span
                className={cn(
                  "inline-flex",
                  blockedReason && "cursor-not-allowed",
                )}
                title={wrapperTitle}
              >
                <form.SubmitButton
                  focusableWhenDisabled={!!blockedReason}
                  disabled={pending}
                  aria-describedby={describedBy}
                  className={ARIA_DISABLED_CLASS}
                >
                  Create draft
                </form.SubmitButton>
              </span>
            </form.AppForm>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
