import { type ReactNode, useId } from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { RelativeTime } from "@/components/relative-time";
import { Spinner } from "@/components/ui/spinner";
import type { HeldRead } from "@/lib/git/queries";
import type {
  SubmoduleCheckoutPlan,
  SubmoduleConflict,
  SubmoduleConflictRelation,
  SubmoduleConflictSide,
} from "@/lib/git/types";
import { ACT_PENDING_REASON } from "@/lib/offline-writes";
import { parseableDate } from "@/lib/time";

type Side = "ours" | "theirs";

/** The pane's first read, worded as the text conflict's, and the Accepts' hold
 *  reason while a read (not a write) holds them. */
const READING = "Reading the conflict…";

const READ_ERROR =
  "Couldn't read this submodule conflict, so its commits can't be shown here. Resolve it in a terminal.";

const TERMINAL_HINT =
  "To take the removal instead, resolve this conflict in a terminal.";

/** Each side worded and tinted as a text conflict's region words its sides. */
const SIDE_COPY: Record<
  Side,
  { label: string; accept: string; tint: string; text: string }
> = {
  ours: {
    label: "Current (ours)",
    accept: "Accept current",
    tint: "bg-success/5",
    text: "text-success",
  },
  theirs: {
    label: "Incoming (theirs)",
    accept: "Accept incoming",
    tint: "bg-info/5",
    text: "text-info",
  },
};

type RelationView = { line: string | null; newer: Side | null };

/** "(newer)" marks only a side measured to contain the other. */
const RELATION_VIEW: {
  [K in SubmoduleConflictRelation["kind"]]: (
    relation: Extract<SubmoduleConflictRelation, { kind: K }>,
  ) => RelationView;
} = {
  theirsContainsOurs: (r) => ({
    line: `Incoming includes current · ${r.ahead} ahead`,
    newer: "theirs",
  }),
  oursContainsTheirs: (r) => ({
    line: `Current includes incoming · ${r.ahead} ahead`,
    newer: "ours",
  }),
  diverged: () => ({ line: "These commits have diverged", newer: null }),
  unknown: () => ({ line: null, newer: null }),
};

const relationView = (relation: SubmoduleConflictRelation): RelationView =>
  (
    RELATION_VIEW[relation.kind] as (
      r: SubmoduleConflictRelation,
    ) => RelationView
  )(relation);

/** The plans under which the submodule's checkout stays as it is. */
type StayingPlan = Exclude<SubmoduleCheckoutPlan, "checkOut" | "alreadyThere">;

/** Which staying plan the footer names when sides differ: the tree-wide reasons
 *  first, then the per-side one. */
const FOOTER_ORDER = [
  "notInitialized",
  "unusable",
  "dirty",
  "detachedElsewhere",
  "notFetched",
] as const satisfies readonly StayingPlan[];

/** `StayingPlan` while FOOTER_ORDER lists every staying plan, else `never`, so
 *  a plan left out fails the footer's lookup to compile instead of reading as
 *  a confirmed checkout. */
type OrderedPlan = [
  Exclude<StayingPlan, (typeof FOOTER_ORDER)[number]>,
] extends [never]
  ? StayingPlan
  : never;

/** Says up front what picking a side does to the submodule's own checkout. */
const FOOTER: Record<StayingPlan | "confirmed", (name: string) => string> = {
  confirmed: (name) =>
    `Picking a side stages that commit and checks it out in ${name}.`,
  dirty: (name) =>
    `Picking a side stages that commit; ${name} has local changes, so its checkout stays as is.`,
  notInitialized: (name) =>
    `Picking a side stages that commit; ${name} isn't checked out here, so there is no checkout to move.`,
  unusable: (name) =>
    `Picking a side stages that commit; ${name}'s folder can't be read as a submodule, so its checkout stays as is.`,
  detachedElsewhere: (name) =>
    `Picking a side stages that commit; ${name} is on a commit of its own, so its checkout stays as is.`,
  notFetched: (name) =>
    `Picking a side stages that commit; a commit that isn't fetched in ${name} leaves its checkout as is.`,
};

/** A side whose commit can be staged: present, and a gitlink. */
const offersAccept = (side: SubmoduleConflictSide | null) =>
  side !== null && side.gitlink;

/** Plans under which the read never looked inside the submodule, so a missing
 *  commit there means nothing about fetching. */
const UNREAD_PLANS: ReadonlySet<SubmoduleCheckoutPlan | null> = new Set([
  "notInitialized",
  "unusable",
]);

function SideDetail({ side }: { side: SubmoduleConflictSide | null }) {
  if (side === null) return <span>Removed on this side</span>;
  if (!side.gitlink)
    return <span>A file on this side, not a submodule commit</span>;
  const parts: ReactNode[] = [
    <span key="sha" className="shrink-0 font-mono">
      {side.sha.slice(0, 7)}
    </span>,
  ];
  const commit = side.commit;
  if (commit !== null) {
    parts.push(
      <span key="subject" className="min-w-0 wrap-break-word text-foreground">
        {commit.subject}
      </span>,
    );
    if (parseableDate(commit.committedAt))
      parts.push(<RelativeTime key="date" date={commit.committedAt} />);
  } else if (!UNREAD_PLANS.has(side.plan)) {
    parts.push(<span key="missing">Not fetched in the submodule</span>);
  }
  return parts.flatMap((part, i) =>
    i === 0
      ? [part]
      : [
          <span key={`sep-${i}`} aria-hidden>
            ·
          </span>,
          part,
        ],
  );
}

function SideBlock({
  side,
  read,
  newer,
  busy,
  reading,
  onAccept,
}: {
  side: Side;
  read: SubmoduleConflictSide | null;
  newer: boolean;
  busy: boolean;
  reading: boolean;
  onAccept: (side: Side) => void;
}) {
  const labelId = useId();
  const copy = SIDE_COPY[side];
  return (
    <div role="group" aria-labelledby={labelId} className={copy.tint}>
      <div
        id={labelId}
        className={`px-3 py-0.5 text-[10px] font-medium ${copy.text}`}
      >
        {copy.label}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5 text-xs text-muted-foreground">
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5">
          <SideDetail side={read} />
        </span>
        {offersAccept(read) && (
          <DisabledReasonButton
            size="xs"
            variant="outline"
            wrapperClassName="ml-auto"
            disabled={busy}
            reason={reading ? READING : ACT_PENDING_REASON}
            onClick={() => onAccept(side)}
          >
            {newer ? `${copy.accept} (newer)` : copy.accept}
          </DisabledReasonButton>
        )}
      </div>
    </div>
  );
}

/**
 * A conflicted submodule's two commits, mirroring a text conflict's region:
 * Current (ours) over Incoming (theirs), each with its own Accept, the relation
 * between them, and what picking a side does to the submodule's checkout.
 * Presentational: the reads, the write and the focus landing stay with
 * ConflictFileView. A read whose stages are all gone never reaches it.
 */
export function SubmoduleConflictPane({
  name,
  read,
  busy,
  reading,
  onAccept,
}: {
  name: string;
  read: HeldRead<SubmoduleConflict>;
  /** Any hold on the Accepts. */
  busy: boolean;
  /** The hold is a read, not a write. */
  reading: boolean;
  onAccept: (side: Side) => void;
}) {
  if (read.isPending) {
    return (
      <p className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
        <Spinner className="size-3" />
        {READING}
      </p>
    );
  }
  const data = read.data;
  if (read.isError || data === undefined) {
    return <p className="p-4 text-xs text-muted-foreground">{READ_ERROR}</p>;
  }
  const relation = relationView(data.relation);
  const offering = [data.ours, data.theirs].filter(offersAccept);
  const staying: OrderedPlan | undefined = FOOTER_ORDER.find((plan) =>
    offering.some((side) => side?.plan === plan),
  );
  const footer =
    offering.length === 0 ? null : FOOTER[staying ?? "confirmed"](name);
  const sideProps = { busy, reading, onAccept };
  return (
    <div className="border-y border-warning/40">
      <SideBlock
        side="ours"
        read={data.ours}
        newer={relation.newer === "ours"}
        {...sideProps}
      />
      {relation.line !== null && (
        <p className="border-y bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground">
          {relation.line}
        </p>
      )}
      <SideBlock
        side="theirs"
        read={data.theirs}
        newer={relation.newer === "theirs"}
        {...sideProps}
      />
      {(!offersAccept(data.ours) || !offersAccept(data.theirs)) && (
        <p className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
          {TERMINAL_HINT}
        </p>
      )}
      {footer !== null && (
        <p className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
          {footer}
        </p>
      )}
    </div>
  );
}
