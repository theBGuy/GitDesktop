import type { ReactNode } from "react";
import { MetaFieldLabel, MetaValueCell } from "@/components/meta-field-cells";
import { Skeleton } from "@/components/ui/skeleton";
import { clipTitle, clipTitleFromText } from "@/lib/clip-title";
import { presentError } from "@/lib/error-summary";
import { useActiveGhHost } from "@/lib/git/host";
import {
  useGhScopes,
  useItemFieldValues,
  useItemProjects,
} from "@/lib/git/queries";
import type {
  ItemProjectFieldValues,
  ProjectFieldValue,
  RemoteLens,
} from "@/lib/git/types";
import { parseableDate } from "@/lib/time";
import { type EditableBoard, ProjectFieldsEditor } from "./ProjectFieldsEditor";
import { projectScopeMissing } from "./ProjectsPopover";

const FIELD_LABEL = "Project fields";

/** GitHub select-option color NAMES → a dot hex. Data colours in a rail that has
 *  to stay quiet, so they sit well under the semantic state tokens' chroma; an
 *  unmapped name takes the neutral dot, and the option's name renders beside every
 *  one of them. */
const OPTION_COLORS: Record<string, string> = {
  GRAY: "#8b8b93",
  BLUE: "#6a8fc0",
  GREEN: "#5f9c78",
  YELLOW: "#b09a4e",
  ORANGE: "#bd8353",
  RED: "#bd6c6c",
  PINK: "#b9739a",
  PURPLE: "#8d80ba",
};

/** GitHub's Date scalar, which carries no zone. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function optionColor(color: string): string {
  return OPTION_COLORS[color.toUpperCase()] ?? OPTION_COLORS.GRAY;
}

/** A project date field as a LOCAL date: a bare `YYYY-MM-DD` parses as UTC
 *  midnight, which renders a day early everywhere west of Greenwich. */
function parseFieldDate(date: string): Date | null {
  const iso = DATE_ONLY.test(date) ? `${date}T00:00:00` : date;
  return parseableDate(iso) ? new Date(iso) : null;
}

/** A date field in the user's locale, falling back to the raw forge string when it
 *  can't be read — never "Invalid Date". */
function formatFieldDate(date: string): string {
  const parsed = parseFieldDate(date);
  if (parsed === null) return date;
  return parsed.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function shortDay(date: Date, withYear: boolean): string {
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
  };
  if (withYear) options.year = "numeric";
  return date.toLocaleDateString(undefined, options);
}

/** An iteration's span, start through its last day. `""` when the start can't be
 *  read or the duration isn't a usable day count — the title alone still names it.
 *  A span crossing New Year carries the year on BOTH ends: "Dec 28 – Jan 10" reads
 *  backwards without it. */
function iterationRange(startDate: string, duration: number): string {
  const start = parseFieldDate(startDate);
  if (start === null || !Number.isFinite(duration) || duration < 1) return "";
  const end = new Date(start);
  end.setDate(end.getDate() + Math.round(duration) - 1);
  // A duration past Date's range lands an Invalid Date, whose formatted form is
  // the literal string this module's date handling promises never to show.
  if (Number.isNaN(end.getTime())) return "";
  const spansYears = start.getFullYear() !== end.getFullYear();
  return `${shortDay(start, spansYears)} – ${shortDay(end, spansYears)}`;
}

/** An iteration's span in muted parentheses, or nothing when it can't be read. The
 *  parenthetical is one unbreakable run: wrapped mid-span it reads as two values on
 *  two lines. Shared with the field editor's iteration rows. */
export function IterationRange({
  startDate,
  duration,
}: {
  startDate: string;
  duration: number;
}) {
  const range = iterationRange(startDate, duration);
  if (range === "") return null;
  return (
    <span className="whitespace-nowrap text-muted-foreground"> ({range})</span>
  );
}

/** One select option. The dot is decorative and the name carries the value, so
 *  nothing here rests on the colour. Shared with the field editor's option rows. */
export function OptionValue({ name, color }: { name: string; color: string }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1">
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: optionColor(color) }}
      />
      <span className="truncate" onMouseEnter={clipTitleFromText}>
        {name}
      </span>
    </span>
  );
}

/** One field's value, or `null` when there's nothing to show — an unset field, or
 *  a kind this build has no rendering for. A name with no value beside it reads as
 *  a broken render, so both cases drop the whole entry rather than the value. */
function fieldValueNode(value: ProjectFieldValue): ReactNode {
  switch (value.kind) {
    case "singleSelect":
      return value.name ? (
        <OptionValue name={value.name} color={value.color} />
      ) : null;
    case "multiSelect": {
      const options = value.options.filter((option) => option.name);
      return options.length === 0 ? null : (
        <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
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
    case "text": {
      const text = value.text.trim();
      return text === "" ? null : (
        // Capped rather than free-flowing: one long note would otherwise set the
        // whole line's width and push every other field off it.
        <span
          className="inline-block max-w-40 truncate align-bottom"
          onMouseEnter={clipTitle(text)}
        >
          {text}
        </span>
      );
    }
    case "number":
      // Locale-grouped, so a number field doesn't read as raw output beside the
      // locale-formatted dates on the same line. The fraction cap is explicit:
      // the default rounds to 3 digits, rendering 0.0001 as 0.
      return Number.isFinite(value.number)
        ? value.number.toLocaleString(undefined, { maximumFractionDigits: 20 })
        : null;
    case "date":
      return value.date === "" ? null : formatFieldDate(value.date);
    case "iteration": {
      if (
        value.title === "" &&
        iterationRange(value.startDate, value.duration) === ""
      )
        return null;
      return (
        <>
          {value.title}
          <IterationRange
            startDate={value.startDate}
            duration={value.duration}
          />
        </>
      );
    }
    // `unknown`, and any kind a later backend adds: silent rather than guessed at.
    default:
      return null;
  }
}

type FieldPart = { key: string; name: string; node: ReactNode };

function renderableParts(entry: ItemProjectFieldValues): FieldPart[] {
  const parts: FieldPart[] = [];
  for (const value of entry.values) {
    const node = fieldValueNode(value);
    if (node === null) continue;
    // `unknown` is the only arm without a `fieldId`, and it always renders null —
    // the guard is here because TS can't narrow the union through that filter.
    const id = "fieldId" in value ? value.fieldId : value.fieldName;
    parts.push({ key: `${value.kind}-${id}`, name: value.fieldName, node });
  }
  return parts;
}

/** One board's set fields, as a single line: muted field name, then its value,
 *  middot-separated. The project's own title prefixes the line only when the item
 *  sits on more than one board — with one, the Projects chips above already named
 *  it. */
function ProjectFieldLine({
  title,
  showTitle,
  parts,
}: {
  title: string;
  showTitle: boolean;
  parts: FieldPart[];
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[11px]">
      {showTitle ? (
        <span
          className="min-w-0 max-w-full truncate font-medium"
          onMouseEnter={clipTitle(title)}
        >
          {title}
        </span>
      ) : null}
      {parts.map((part, i) => (
        <span
          key={part.key}
          className="inline-flex min-w-0 max-w-full items-center gap-x-1.5"
        >
          {/* Separates the previous field from this one; the gap already reads as
              a break for a screen reader, so the glyph itself is decorative. */}
          {i > 0 || showTitle ? (
            <span aria-hidden className="text-muted-foreground/60">
              ·
            </span>
          ) : null}
          <span className="text-muted-foreground">{part.name}</span>
          <span className="min-w-0">{part.node}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * An item's GitHub Projects field values — one line per board, under the Projects
 * picker on both the issue rail and the PR header grid, with the editor's trigger
 * taking the place of the heading that names them. Nothing renders until there is
 * something to say: no memberships, or no GitHub, and the block is absent entirely
 * rather than leaving a heading standing over nothing. The picker above owns the
 * memberships; this owns the values.
 */
export function ProjectFieldValues({
  repoPath,
  enabled,
  kind,
  number,
  lens,
  disabledReason,
  cells = false,
}: {
  repoPath: string;
  /** Gates the reads, matching the Projects picker's own gate — the real gate is
   *  upstream and deliberately forgiving about a not-yet-identified provider. */
  enabled: boolean;
  kind: "issue" | "pr";
  number: number;
  /** The origin|upstream lens the parent PR/issue surface resolved. */
  lens: RemoteLens;
  /** Set when the editor can't be opened right now — the viewer lacks the access
   *  its writes need, or the surface is still loading the entity. Write access
   *  itself is the MOUNT's gate: both call sites render this only where they render
   *  the Projects picker, which is the same permission. */
  disabledReason?: string;
  /** Emit a label cell and a value cell as two SIBLING elements for a caller's
   *  label/value grid. Default renders the rail form, which labels itself above
   *  the lines. */
  cells?: boolean;
}) {
  const host = useActiveGhHost();
  const scopes = useGhScopes(host);
  const canRead = enabled && !projectScopeMissing(scopes.data);
  // Same key as the picker's own read, so this shares that cache rather than
  // paying a second fetch to learn whether the item is on any board at all.
  const memberships = useItemProjects(repoPath, kind, number, canRead, lens);
  // Cached memberships are what prove a board exists — a read that has never
  // produced data (pending, or failed) leaves this whole block silent, the picker
  // above owning that failure's wording and its Retry. Boardless is the common
  // case, so gating the values query here is also what keeps it from spawning a
  // `gh` call per issue nobody has put on a board.
  const boardsKnown = (memberships.data?.length ?? 0) > 0;
  const values = useItemFieldValues(
    repoPath,
    kind,
    number,
    canRead && boardsKnown,
    lens,
  );

  // Keyed on CACHED DATA, never on query status, matching the chips above: a
  // failed background refetch flips the status to error while the data it already
  // served is still good.
  const membershipIds = new Set(
    (memberships.data ?? []).map((item) => item.project.id),
  );
  // Gated on live memberships AND the scope gate, because a cache outlives the
  // gate that filled it: either one going away disables this query, which an
  // invalidate can then neither refetch nor clear. The picker's chips and its
  // scope-gap block are what the rail has to agree with.
  const entries = canRead
    ? (values.data ?? []).filter((entry) => membershipIds.has(entry.project.id))
    : [];
  const lines = entries
    .map((entry) => ({ entry, parts: renderableParts(entry) }))
    .filter((line) => line.parts.length > 0);
  // Counts LIVE boards, not lines: an item on three boards where only one has set
  // fields still needs that line named, and an unlinked board stops counting the
  // moment its chip goes.
  const showTitles = entries.length > 1;
  // A disabled query is not loading — it is the resolved "no boards" answer.
  const loading =
    canRead &&
    boardsKnown &&
    values.data === undefined &&
    values.error === null;

  const content = (() => {
    switch (true) {
      case lines.length > 0:
        return (
          <div className="flex w-full min-w-0 flex-col gap-0.5">
            {lines.map(({ entry, parts }) => (
              <ProjectFieldLine
                key={entry.itemId}
                // A board GitHub reports with no title arrives as `""`, which as a
                // prefix is an empty span and a leading middot.
                showTitle={showTitles && entry.project.title !== ""}
                title={entry.project.title}
                parts={parts}
              />
            ))}
          </div>
        );
      case loading:
        return <Skeleton className="h-4 w-40" aria-hidden />;
      // Still gated: a disabled query keeps whatever error it last cached, so an
      // item whose boards — or whose scope — have since gone stays silent.
      case canRead && values.error !== null && boardsKnown:
        return (
          <span className="inline-flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
            {presentError(values.error).summary}
            <button
              type="button"
              aria-label={`Retry loading ${FIELD_LABEL.toLowerCase()}`}
              className="cursor-pointer underline hover:text-foreground"
              onClick={() => values.refetch()}
            >
              Retry
            </button>
          </span>
        );
      default:
        return null;
    }
  })();

  // The editor rides the same gate the VALUES do: a boardless item has nothing to
  // edit, so it gets no trigger and — the null contract below — no heading either.
  const showEditor = canRead && boardsKnown;
  // Memberships order, not the values read's: the boards are named in the same
  // sequence the chips above are. A board whose values haven't arrived has no
  // baseline to draft from, so it stays out and the trigger says why.
  // PARITY REQUIREMENT: both reads page `projectItems(first: 20)`, and a board the
  // memberships read returns but the values read doesn't leaves the editor without
  // a word — this intersection is only safe while their caps and filters agree.
  const entryByProject = new Map(
    entries.map((entry) => [entry.project.id, entry]),
  );
  // `viewerCanUpdate` is read off the MEMBERSHIP row, which is the read that
  // populates it — the same board inside a values entry doesn't carry the viewer's
  // access, and the editor holds a board's rows on this flag.
  const boards = (memberships.data ?? [])
    .map((item) => {
      const entry = entryByProject.get(item.project.id);
      return entry === undefined
        ? undefined
        : { ...entry, viewerCanUpdate: item.project.viewerCanUpdate };
    })
    .filter((board): board is EditableBoard => board !== undefined);
  const unsettledReason = (() => {
    switch (true) {
      case boards.length > 0:
        return undefined;
      case loading:
        return "Loading project fields…";
      // Reachable with no error and nothing to retry — a values read that settled
      // empty against live memberships lands here, so this names no control.
      default:
        return "Project fields haven't loaded for this item's boards yet.";
    }
  })();
  const heading = showEditor ? (
    <ProjectFieldsEditor
      repoPath={repoPath}
      kind={kind}
      number={number}
      lens={lens}
      boards={boards}
      disabledReason={disabledReason}
      unsettledReason={unsettledReason}
    />
  ) : null;

  if (content === null && heading === null) return null;
  // The rail form carries its OWN heading rather than taking the row list's: this
  // block renders nothing on a boardless item, and a host-supplied heading would
  // be left standing over it.
  if (!cells)
    return (
      <div className="space-y-1.5">
        {heading ?? (
          <p className="text-xs font-medium text-muted-foreground">
            {FIELD_LABEL}
          </p>
        )}
        {content}
      </div>
    );
  return (
    <>
      {heading ?? <MetaFieldLabel>{FIELD_LABEL}</MetaFieldLabel>}
      <MetaValueCell
        label={FIELD_LABEL}
        empty={content === null}
        busy={lines.length === 0 && loading}
      >
        {content}
      </MetaValueCell>
    </>
  );
}
