import { Popover } from "@base-ui/react/popover";
import {
  CircleIcon,
  FileDashedIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  type Icon,
  LockSimpleIcon,
  NoteIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { memo, type ReactNode } from "react";
import { ForgeUserAvatar } from "@/components/forge-user-avatar";
import { Markdown } from "@/components/markdown/markdown";
import { usePanelPortalContainer } from "@/components/panel-portal";
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
}: {
  glyph: ReactNode;
  /** State AND kind — "Open issue", "Draft pull request". The glyph carries the
   *  pair visually, so the sr-only text has to carry both too; a bare "Open"
   *  leaves a reader unable to tell an issue from a pull request. */
  stateWord: string;
  title: string;
}) {
  return (
    <span className="flex items-start gap-1.5">
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
}: {
  content: Extract<BoardItemContent, { kind: "issue" }>;
}) {
  return (
    <CardTitle
      glyph={<StateIcon state={content.state} />}
      stateWord={issueStateWord(content.state, content.stateReason)}
      title={content.title}
    />
  );
}

/** A pull request's head line, off {@link PR_STATE}. */
function PullRequestHead({
  content,
}: {
  content: Extract<BoardItemContent, { kind: "pullRequest" }>;
}) {
  const pill = prPill(content.state, content.isDraft);
  return (
    <CardTitle
      glyph={<pill.Icon className={cn("size-3.5 shrink-0", pill.tone)} />}
      stateWord={pill.word}
      title={content.title}
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

const CARD_CLASS =
  "flex w-full flex-col gap-1 border bg-background px-2 py-1.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

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
  active,
  busy,
  rovingTab,
  repoSlug,
  ghHost,
  chipFields,
  onFocus,
  onOpen,
}: {
  item: BoardItem;
  /** Position in the COLUMN, which is also the virtualizer's index. */
  index: number;
  /** The column's full item count — windowing hides it from a reader otherwise. */
  setSize: number;
  columnIndex: number;
  active: boolean;
  /** A write is changing this card in place — today, a draft being converted to an
   *  issue. BUSY, not disabled: the card is still a real card and still opens, and
   *  the menu rows that could collide with the write are held by the panel. */
  busy: boolean;
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
  onOpen: (item: BoardItem) => void;
}) {
  const portalContainer = usePanelPortalContainer();
  const content = item.content;
  const shared = {
    "data-card-index": index,
    role: "option",
    "aria-selected": active,
    "aria-setsize": setSize,
    "aria-posinset": index + 1,
    tabIndex: rovingTab,
    // Absent rather than `false` when nothing is in flight: `aria-busy="false"` is
    // valid but says something on every card on the board, where the attribute is
    // only meaningful on the one being written.
    "aria-busy": busy || undefined,
    onFocus: () => onFocus(columnIndex, index),
  } as const;
  const toneClass = active && "bg-accent text-accent-foreground";
  // Lighter than the app's 50% disabled dim on purpose: this card is BUSY, not
  // disabled — it still opens, and `aria-busy` is what carries the state to a
  // reader. Colour says nothing here that the attribute doesn't.
  const busyClass = busy && "opacity-60";

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
              className={cn(CARD_CLASS, "cursor-pointer", toneClass, busyClass)}
            />
          }
        >
          <CardTitle
            glyph={
              <NoteIcon className="size-3.5 shrink-0 text-muted-foreground" />
            }
            stateWord="Draft item"
            title={content.title}
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
  return (
    <button
      type="button"
      {...shared}
      className={cn(CARD_CLASS, "cursor-pointer", toneClass, busyClass)}
      onClick={() => onOpen(item)}
    >
      {content.kind === "pullRequest" ? (
        <PullRequestHead content={content} />
      ) : (
        <IssueHead content={content} />
      )}
      <CardMeta
        number={content.number}
        repoLabel={repoLabel}
        assignees={content.assignees}
        ghHost={ghHost}
      />
      <CardChips item={item} fields={chipFields} />
    </button>
  );
});
