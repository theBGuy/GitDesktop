import { Popover } from "@base-ui/react/popover";
import {
  CheckIcon,
  CircleIcon,
  FileDashedIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  type Icon,
  LockSimpleIcon,
  NoteIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { Fragment, memo, type ReactNode, useId, useRef } from "react";
import { ForgeUserAvatar } from "@/components/forge-user-avatar";
import { Markdown } from "@/components/markdown/markdown";
import { usePanelPortalContainer } from "@/components/panel-portal";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import {
  formatFieldDate,
  iterationRange,
  OptionValue,
} from "@/features/conversations/ProjectFieldValues";
import { StateIcon } from "@/features/issues/IssueRelations";
import { clipTitle, clipTitleFromText } from "@/lib/clip-title";
import type {
  AssigneeRef,
  BoardItem,
  BoardItemContent,
  ProjectFieldDef,
  ProjectFieldValue,
} from "@/lib/git/types";
import { parseableDate } from "@/lib/time";
import { cn } from "@/lib/utils";

/** How many assignee faces a card shows before the rest collapse into "+N" —
 *  three is what fits beside the number on the narrowest column. */
const AVATARS_SHOWN = 3;

/** Why a closed issue closed, as the words that ride beside its glyph. An
 *  unmapped reason (wire drift) leaves the bare state, never a guess. */
const CLOSED_REASON: Record<string, string> = {
  COMPLETED: "Issue closed as completed",
  NOT_PLANNED: "Issue closed as not planned",
  DUPLICATE: "Issue closed as duplicate",
};

interface StatePill {
  Icon: Icon;
  tone: string;
  /** The state as words — what actually carries it, since colour never may. */
  word: string;
}

/**
 * A pull request's glyph and tone per state. Every arm carries its OWN SHAPE:
 * a card shows no state text, so a table that separated open from closed by tone
 * alone would be conveying state by colour — which is why this diverges from
 * `IssueDevelopment`'s `prPresentation` and `markdown-ref-card`'s `STATE_PILL`
 * (both hand `GitPullRequestIcon` to more than one state). CLOSED also takes the
 * destructive tone because a closed pull request is abandoned where a closed
 * ISSUE is resolved, the one place the app's two conventions part — so the issue
 * arm reuses `StateIcon` rather than sharing this table.
 *
 * Shapes are picked to stay distinct from the ISSUE glyphs too, since one board
 * mixes both: `CircleDashed` (issue open) and `CheckCircle` (issue closed) are
 * spoken for, hence `FileDashed` for a draft rather than a second dashed circle.
 */
const PR_STATE: Record<string, StatePill | undefined> = {
  OPEN: {
    Icon: GitPullRequestIcon,
    tone: "text-success",
    word: "Open pull request",
  },
  MERGED: {
    Icon: GitMergeIcon,
    tone: "text-merged",
    word: "Merged pull request",
  },
  CLOSED: {
    Icon: XCircleIcon,
    tone: "text-destructive",
    word: "Closed pull request",
  },
};

function prPill(state: string, isDraft: boolean): StatePill {
  if (isDraft && state === "OPEN")
    return {
      Icon: FileDashedIcon,
      tone: "text-muted-foreground",
      word: "Draft pull request",
    };
  return (
    // A state this build doesn't know keeps a shape of its own and the forge's
    // own word, rather than borrowing "open"'s glyph at a different tone.
    PR_STATE[state] ?? {
      Icon: CircleIcon,
      tone: "text-muted-foreground",
      word: `${state} pull request`,
    }
  );
}

/** State AND kind, since the card shows neither as text. A reason only qualifies
 *  a CLOSED issue: REOPENED rides an OPEN one, so a present reason is never on
 *  its own proof the issue is closed. */
function issueStateWord(state: string, stateReason: string | null): string {
  if (state !== "CLOSED") return "Open issue";
  if (stateReason === null) return "Closed issue";
  return CLOSED_REASON[stateReason] ?? "Closed issue";
}

/** The card's first line: glyph, the state in words for a reader, and the title
 *  over at most two lines. */
function CardTitle({
  glyph,
  stateWord,
  title,
  checked,
}: {
  glyph: ReactNode;
  /** State AND kind — "Open issue", "Draft pull request". The glyph carries the
   *  pair visually, so the sr-only text has to carry both too; a bare "Open"
   *  leaves a reader unable to tell an issue from a pull request. */
  stateWord: string;
  title: string;
  /** This card is one of SEVERAL selected. A tick rather than the accent seam
   *  alone, so membership is never conveyed by colour: `aria-selected` already
   *  carries it for a reader, which is why the glyph is hidden from one. The
   *  singleton stays tick-free — it is the board's cursor, not a set the user
   *  built. */
  checked: boolean;
}) {
  return (
    <span className="flex items-start gap-1.5">
      {checked && <CheckIcon aria-hidden className="mt-px size-3.5 shrink-0" />}
      {glyph}
      <span className="sr-only">{stateWord}</span>
      {/* `clipTitleFromText` measures BOTH axes, so a two-line clamp counts as
          clipped and a title only appears once the text really is cut off. */}
      <span
        className="line-clamp-2 min-w-0 flex-1 font-medium"
        onMouseEnter={clipTitleFromText}
      >
        {title}
      </span>
    </span>
  );
}

/** Up to three assignee faces plus a "+N" for the rest. Nothing at all when the
 *  item has none, so the meta line doesn't reserve empty space. */
function Assignees({
  assignees,
  ghHost,
}: {
  assignees: AssigneeRef[];
  ghHost: string | null;
}) {
  if (assignees.length === 0) return null;
  const shown = assignees.slice(0, AVATARS_SHOWN);
  const overflow = assignees.length - shown.length;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-0.5">
      {shown.map((assignee) => (
        <ForgeUserAvatar
          key={assignee.login}
          login={assignee.login}
          avatarUrl={assignee.avatarUrl}
          ghHost={ghHost}
          size="sm"
        />
      ))}
      {overflow > 0 && (
        <span className="tabular-nums">
          +{overflow}
          <span className="sr-only"> more assignees</span>
        </span>
      )}
    </span>
  );
}

/** An issue's head line. The glyph is the related-issue `StateIcon` the Issues
 *  surfaces already use, so a closed issue reads the same everywhere. */
function IssueHead({
  content,
  checked,
}: {
  content: Extract<BoardItemContent, { kind: "issue" }>;
  checked: boolean;
}) {
  return (
    <CardTitle
      glyph={<StateIcon state={content.state} />}
      stateWord={issueStateWord(content.state, content.stateReason)}
      title={content.title}
      checked={checked}
    />
  );
}

/** A pull request's head line, off {@link PR_STATE}. */
function PullRequestHead({
  content,
  checked,
}: {
  content: Extract<BoardItemContent, { kind: "pullRequest" }>;
  checked: boolean;
}) {
  const pill = prPill(content.state, content.isDraft);
  return (
    <CardTitle
      glyph={<pill.Icon className={cn("size-3.5 shrink-0", pill.tone)} />}
      stateWord={pill.word}
      title={content.title}
      checked={checked}
    />
  );
}

/** The card's second line: the number, the owning repo when the board reaches
 *  past this one, and the assignees. */
function CardMeta({
  number,
  repoLabel,
  assignees,
  ghHost,
}: {
  number: number;
  repoLabel: string | null;
  assignees: AssigneeRef[];
  ghHost: string | null;
}) {
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className="shrink-0 tabular-nums">#{number}</span>
      {repoLabel !== null && (
        <span className="min-w-0 truncate" onMouseEnter={clipTitleFromText}>
          {repoLabel}
        </span>
      )}
      <Assignees assignees={assignees} ghHost={ghHost} />
    </span>
  );
}

/** One chip: a hairline box that stays quiet beside the card's own two lines. */
const CHIP_CLASS =
  "inline-flex min-w-0 max-w-full items-center gap-1 border px-1 py-px text-[10px] text-muted-foreground";

/** The item's value for `def`, or undefined when it holds none. The value's own
 *  kind has to match the definition's — a wire shape that disagrees is not a
 *  value of this field — which is the same test `valueOfKind` makes in
 *  board-model, so the chips and the sort read an item the same way. `unknown` is
 *  the one value arm without a `fieldId`, and it matches no definition. */
function valueFor(
  item: BoardItem,
  def: ProjectFieldDef,
): ProjectFieldValue | undefined {
  return item.fieldValues.find(
    (value) =>
      value.kind === def.kind && "fieldId" in value && value.fieldId === def.id,
  );
}

/**
 * One field's value as chip contents, or null when there is nothing to show —
 * an unset field, a blank one, or a kind this build has no compact form for. A
 * name with no value beside it reads as a broken render, so the whole chip drops
 * rather than the value, which is the field rail's own contract.
 *
 * Only a NUMBER carries its field name: a select option, a date and an iteration
 * all say what they are, where a bare `3` on a card means nothing.
 */
function chipNode(value: ProjectFieldValue): ReactNode {
  switch (value.kind) {
    case "singleSelect":
      return value.name ? (
        <OptionValue name={value.name} color={value.color} />
      ) : null;
    case "multiSelect": {
      const options = value.options.filter((option) => option.name);
      return options.length === 0 ? null : (
        <span className="inline-flex min-w-0 items-center gap-x-1.5">
          {options.map((option) => (
            <OptionValue
              key={option.id}
              name={option.name}
              color={option.color}
            />
          ))}
        </span>
      );
    }
    case "number":
      return Number.isFinite(value.number) ? (
        <>
          {/* `truncate` rather than `shrink-0`: overflow-hidden zeroes the flex
              auto-minimum, so a long field name clips inside the chip instead of
              pushing the value past its width. */}
          <span className="truncate" onMouseEnter={clipTitleFromText}>
            {value.fieldName}
          </span>
          <span className="shrink-0 tabular-nums">
            {value.number.toLocaleString(undefined, {
              maximumFractionDigits: 20,
            })}
          </span>
        </>
      ) : null;
    case "date":
      return value.date === "" ? null : formatFieldDate(value.date);
    case "iteration": {
      // The title is the compact form; a board that left one unnamed still has
      // its span, and one with neither has nothing to draw.
      if (value.title !== "") return value.title;
      const range = iterationRange(value.startDate, value.duration);
      return range === "" ? null : range;
    }
    case "text": {
      const text = value.text.trim();
      return text === "" ? null : (
        <span className="truncate" onMouseEnter={clipTitle(text)}>
          {text}
        </span>
      );
    }
    // `unknown`, and any kind a later backend adds: silent rather than guessed at.
    default:
      return null;
  }
}

/** The active view's visible fields, as chips under the card's meta line. The
 *  field ORDER is the view's; a field the item hasn't filled in draws nothing, so
 *  a card carries no empty chrome. Nothing at all with no view — `fields` is empty
 *  then, which is the card exactly as it was. */
function CardChips({
  item,
  fields,
}: {
  item: BoardItem;
  fields: ProjectFieldDef[];
}) {
  const chips: { id: string; node: ReactNode }[] = [];
  for (const def of fields) {
    const value = valueFor(item, def);
    const node = value === undefined ? null : chipNode(value);
    if (node !== null) chips.push({ id: def.id, node });
  }
  if (chips.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {chips.map((chip) => (
        <span key={chip.id} className={CHIP_CLASS}>
          {chip.node}
        </span>
      ))}
    </span>
  );
}

/** One dated fact about a card, as the popover reads it out. */
interface CardDate {
  label: string;
  date: string;
}

/** A forge timestamp this build can actually format, or null. Three ways it isn't
 *  one, all tested rather than trusted: the backend serializes an absent date as the
 *  EMPTY STRING (its dates are `unwrap_or_default`ed), a build older than these
 *  fields answers without them at all, and an unparseable date formats as "in NaN
 *  years". `parseableDate("")` is false, so the sentinel and the garbage share an
 *  arm. */
function usableDate(value: string | undefined): string | null {
  return typeof value === "string" && parseableDate(value) ? value : null;
}

/** The pairs that have a date, in the order given. */
function dated(pairs: [string, string | null][]): CardDate[] {
  return pairs.flatMap(([label, date]) =>
    date === null ? [] : [{ label, date }],
  );
}

/** What a card's popover says about WHEN, per kind. An issue or pull request carries
 *  three dates that mean three different things — when it was opened, when it joined
 *  THIS board, and when it last changed. A draft was created by being added, so its
 *  membership date repeats its own. */
function cardDates(item: BoardItem): CardDate[] {
  const content = item.content;
  switch (content.kind) {
    // A redacted card is inert: no popover, no menu, so there is nowhere for a date
    // to be read. Copy written for a surface that doesn't exist can't be kept true.
    case "redacted":
      return [];
    case "draft":
      return dated([
        ["Created", usableDate(content.createdAt)],
        ["Updated", usableDate(content.updatedAt)],
      ]);
    case "issue":
    case "pullRequest":
      return dated([
        ["Opened", usableDate(content.createdAt)],
        ["Added to board", usableDate(item.addedAt)],
        ["Updated", usableDate(content.updatedAt)],
      ]);
  }
}

/** A card's dates, muted under its popover's own content — the draft's notes, or an
 *  issue/pull request peek. Labelled every one: three relative times in a row say
 *  nothing about each other without the words. `RelativeTime` rides the shared
 *  ticker and carries the absolute local time as its own tooltip. */
function CardDates({ item }: { item: BoardItem }) {
  const dates = cardDates(item);
  if (dates.length === 0) return null;
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-1.5 px-1 text-xs text-muted-foreground">
      {dates.map((entry, i) => (
        <Fragment key={entry.label}>
          {i > 0 && <span aria-hidden>·</span>}
          <span className="whitespace-nowrap">
            {entry.label} <RelativeTime date={entry.date} />
          </span>
        </Fragment>
      ))}
    </p>
  );
}

const CARD_CLASS =
  "flex w-full flex-col gap-1 border bg-background px-2 py-1.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/** An archived card's own line, drawn above everything else on it: the board draws
 *  these only while **Show archived cards** is on, so the card has to say which one
 *  it is. The BADGE is what carries that — the quieter text around it is a hint for
 *  a sighted reader scanning a column, never the statement itself. */
function ArchivedBadge() {
  return (
    <span className="flex items-center">
      <Badge variant="outline">Archived</Badge>
    </span>
  );
}

/**
 * One board card. Memoized and deliberately light: a column re-renders its whole
 * mounted window whenever the keyboard cursor moves, and only the two cards whose
 * `active` flips should re-render with it.
 *
 * Issues and pull requests activate (the panel decides where they land); a draft
 * owns its own popover, so the trigger IS this card and the popup's lifetime is
 * tied to the card's — a virtualized row that scrolls out must never leave a
 * popup anchored to a detached node. A redacted item explains itself and does
 * nothing: it still takes a position in the column so the counts and the
 * keyboard walk stay honest about what the board holds.
 */
export const BoardCard = memo(function BoardCard({
  item,
  index,
  setSize,
  columnIndex,
  selected,
  checked,
  busy,
  peek,
  rovingTab,
  repoSlug,
  ghHost,
  chipFields,
  onFocus,
  onPeekChange,
  onOpen,
}: {
  item: BoardItem;
  /** Position in the COLUMN, which is also the virtualizer's index. */
  index: number;
  /** The column's full item count — windowing hides it from a reader otherwise. */
  setSize: number;
  columnIndex: number;
  /** This card is in the board's selection — which, with nothing selected, is the
   *  keyboard cursor's own card. The accent seam and `aria-selected` both ride
   *  this one reading, so a cursor toggled OUT of a real selection keeps its focus
   *  ring and drops the accent. */
  selected: boolean;
  /** {@link CardTitle}'s tick: selected, in a selection of several. */
  checked: boolean;
  /** A write is changing this card in place — a draft being converted to an issue, or
   *  one being edited. BUSY, not disabled: the card is still a real card and still
   *  opens, and the menu rows that could collide with the write are held by the
   *  panel. */
  busy: boolean;
  /** This card's details peek is the one open. Drafts ignore it — their popover is
   *  the card's own trigger and Base UI owns its state. */
  peek: boolean;
  /** Roving tabindex: one tab stop for the whole board, on the cursor's card. */
  rovingTab: number;
  /** The open repo under the ACTIVE lens; a card from another repo names its own. */
  repoSlug: string | null;
  ghHost: string | null;
  /** The active view's visible fields, in its order — empty with no view. Held
   *  identity-stable by the panel: this component is memoized, and a fresh array
   *  every render would re-render every mounted card. */
  chipFields: ProjectFieldDef[];
  onFocus: (columnIndex: number, index: number) => void;
  /** Which card's peek is open, by item id — null closes. Board-wide state so only
   *  one is ever open, the shape `busy` already keeps. */
  onPeekChange: (itemId: string | null) => void;
  onOpen: (item: BoardItem) => void;
}) {
  const portalContainer = usePanelPortalContainer();
  // The peek's anchor AND its focus return. Explicit on both counts because this
  // card is deliberately NOT the popover's trigger — Base UI would toggle on click,
  // and click belongs to opening the item.
  const cardRef = useRef<HTMLButtonElement>(null);
  // Not being the trigger also costs the popup relationship Base UI wires for free,
  // so the card states it itself. The id overrides the Popup's internal `floatingId`
  // (caller props merge last), which is safe here precisely BECAUSE there is no
  // trigger holding the old one in an `aria-controls`.
  const peekId = useId();
  const content = item.content;
  const shared = {
    "data-card-index": index,
    // WHICH card this node is, beside where it sits. A focus claim resolves an
    // INDEX, and the rows are keyed by item id — so a node that has since slid to
    // a neighbouring slot answers to the old index while carrying the wrong card.
    "data-item-id": item.itemId,
    role: "option",
    "aria-selected": selected,
    "aria-setsize": setSize,
    "aria-posinset": index + 1,
    tabIndex: rovingTab,
    // Absent rather than `false` when nothing is in flight: `aria-busy="false"` is
    // valid but says something on every card on the board, where the attribute is
    // only meaningful on the one being written.
    "aria-busy": busy || undefined,
    onFocus: () => onFocus(columnIndex, index),
  } as const;
  const toneClass = selected && "bg-accent text-accent-foreground";
  // Lighter than the app's 50% disabled dim on purpose: this card is BUSY, not
  // disabled — it still opens, and `aria-busy` is what carries the state to a
  // reader. Colour says nothing here that the attribute doesn't.
  const busyClass = busy && "opacity-60";
  // The muted TOKEN rather than an opacity filter: the token is the app's own
  // AA-passing quiet text in both themes, where dimming real foreground would put
  // the title under it. The badge beside the title is what states the fact.
  const archivedClass = item.isArchived && "text-muted-foreground";

  if (content.kind === "redacted") {
    return (
      // Focusable but inert: `aria-disabled` with no handlers, so the walk can
      // pass over it and a reader is told why it can't be opened.
      <div
        {...shared}
        aria-disabled
        className={cn(
          CARD_CLASS,
          "text-muted-foreground",
          toneClass,
          busyClass,
        )}
      >
        {item.isArchived && <ArchivedBadge />}
        <span className="flex items-start gap-1.5">
          <LockSimpleIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 font-medium">Redacted item</span>
        </span>
        {/* States the effect, never a cause: this arm covers an item the viewer
            has no access to AND any content shape this build doesn't recognise,
            so naming a reason would be a guess in at least one of them. */}
        <span className="text-[11px]">
          The board can't show this item here. Open the project on GitHub to see
          what it is.
        </span>
      </div>
    );
  }

  if (content.kind === "draft") {
    const body = content.body.trim();
    return (
      <Popover.Root>
        <Popover.Trigger
          render={
            <button
              type="button"
              {...shared}
              className={cn(
                CARD_CLASS,
                "cursor-pointer",
                archivedClass,
                toneClass,
                busyClass,
              )}
            />
          }
        >
          {item.isArchived && <ArchivedBadge />}
          <CardTitle
            glyph={
              <NoteIcon className="size-3.5 shrink-0 text-muted-foreground" />
            }
            stateWord="Draft item"
            title={content.title}
            checked={checked}
          />
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Badge variant="secondary">Draft</Badge>
            <Assignees assignees={content.assignees} ghHost={ghHost} />
          </span>
          <CardChips item={item} fields={chipFields} />
        </Popover.Trigger>
        <Popover.Portal container={portalContainer}>
          <Popover.Positioner
            align="start"
            sideOffset={4}
            className="isolate z-50"
          >
            <Popover.Popup className="max-h-96 w-80 overflow-y-auto rounded-none bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10">
              {/* The caption IS the popup's accessible name: Popup takes its
                  `aria-labelledby` from whatever Title registers, and a bare
                  element leaves the dialog unnamed. `render` keeps it a <p> —
                  Title's own default element is an <h2>. */}
              <Popover.Title
                render={<p />}
                className="px-1 pb-1.5 text-xs font-medium"
              >
                {content.title || "Draft item"}
              </Popover.Title>
              {body === "" ? (
                <p className="px-1 text-xs text-muted-foreground">
                  This draft has no notes yet.
                </p>
              ) : (
                <Markdown className="px-1 text-xs">{body}</Markdown>
              )}
              <CardDates item={item} />
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    );
  }

  // A board reaches across repositories, so name the owner only where it is
  // KNOWN to differ from the one that's open — on a single-repo board every card
  // would carry it, and while the open repo's slug is still resolving `null`
  // means "not known yet", never "different", so the label stays off rather than
  // flickering onto every card.
  const repoLabel =
    repoSlug !== null &&
    content.repoNameWithOwner.toLowerCase() !== repoSlug.toLowerCase()
      ? content.repoNameWithOwner
      : null;
  // The same pair the head line draws, needed again as the peek's own sentence.
  const stateWord =
    content.kind === "pullRequest"
      ? prPill(content.state, content.isDraft).word
      : issueStateWord(content.state, content.stateReason);
  return (
    <Popover.Root
      open={peek}
      onOpenChange={(open) => onPeekChange(open ? item.itemId : null)}
    >
      <button
        type="button"
        {...shared}
        ref={cardRef}
        // The three attributes Base UI's own `Popover.Trigger` renders (its
        // `aria-haspopup`/`aria-expanded`/`aria-controls` trio), stated by hand so an
        // issue card announces its peek the way a draft card announces its notes.
        // `aria-controls` only while open: the popup is unmounted otherwise, and a
        // reference to a missing id is worse than none.
        aria-haspopup="dialog"
        aria-expanded={peek}
        aria-controls={peek ? peekId : undefined}
        className={cn(
          CARD_CLASS,
          "cursor-pointer",
          archivedClass,
          toneClass,
          busyClass,
        )}
        onClick={() => onOpen(item)}
        // Space peeks where Enter opens. These cards are `role="option"` in a roving
        // listbox, where Space previews and Enter activates, and `preventDefault` on
        // the KEYDOWN is what stops the click the browser would otherwise fire on
        // keyup — the native activation this has to get in front of. Bare `e.key`,
        // no modifier read, the shape every list handler here keeps
        // (`listKeyboardNav`): no action binds a modified Space, and the global
        // listener still sees the event either way.
        onKeyDown={(e) => {
          if (e.key !== " ") return;
          e.preventDefault();
          onPeekChange(item.itemId);
        }}
      >
        {item.isArchived && <ArchivedBadge />}
        {content.kind === "pullRequest" ? (
          <PullRequestHead content={content} checked={checked} />
        ) : (
          <IssueHead content={content} checked={checked} />
        )}
        <CardMeta
          number={content.number}
          repoLabel={repoLabel}
          assignees={content.assignees}
          ghHost={ghHost}
        />
        <CardChips item={item} fields={chipFields} />
      </button>
      <Popover.Portal container={portalContainer}>
        {/* Anchored to the card rather than triggered by it, and `finalFocus` says
            where Esc lands for the same reason: with no trigger there is nothing for
            Base UI to infer a focus return from. */}
        <Popover.Positioner
          align="start"
          sideOffset={4}
          anchor={cardRef}
          className="isolate z-50"
        >
          <Popover.Popup
            id={peekId}
            finalFocus={cardRef}
            className="max-h-96 w-80 overflow-y-auto rounded-none bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10"
          >
            {/* The caption IS the popup's accessible name: Popup takes its
                `aria-labelledby` from whatever Title registers. `render` keeps it a
                <p> — Title's own default element is an <h2>. */}
            <Popover.Title
              render={<p />}
              className="px-1 pb-1.5 text-xs font-medium"
            >
              {content.title}
            </Popover.Title>
            <p className="px-1 text-xs text-muted-foreground">{stateWord}</p>
            <CardDates item={item} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
});
