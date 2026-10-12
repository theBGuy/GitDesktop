import {
  ArrowBendUpLeftIcon,
  CaretDownIcon,
  CheckCircleIcon,
  CircleDashedIcon,
  PlusIcon,
  XIcon,
} from "@phosphor-icons/react";
import { type Ref, useState } from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useRetryFocusRescue } from "@/features/conversations/ConversationListPanel";
import {
  offlinePendingMessage,
  refreshFailed,
} from "@/features/conversations/remote-section-state";
import {
  pendingIssueWrite,
  useAddSubIssue,
  useIssueDependencies,
  useIssueList,
  useIssueRelations,
  usePendingIssueWrites,
  useRemoveSubIssue,
  useSetIssueDependency,
} from "@/lib/git/queries";
import type {
  IssueInfo,
  IssueRelation,
  RelatedIssue,
  RemoteLens,
} from "@/lib/git/types";
import { pendingWriteReason } from "@/lib/offline-writes";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { CreateIssueDialog } from "./CreateIssueDialog";

/** Open/closed glyph for a related issue, so state isn't conveyed by text alone. */
export function StateIcon({ state }: { state: string }) {
  return state === "CLOSED" ? (
    <CheckCircleIcon className="size-3.5 shrink-0 text-merged" />
  ) : (
    <CircleDashedIcon className="size-3.5 shrink-0 text-success" />
  );
}

/** A pending rail write's visible note, worded by the caller for whether it is
 *  saving or parked offline; nothing while no write is pending. */
export function PendingWriteNote({ reason }: { reason: string | undefined }) {
  if (reason === undefined) return null;
  return (
    <p role="status" className="text-[11px] text-muted-foreground">
      {reason}
    </p>
  );
}

/** What {@link SectionReadLine} reads off a section's query. */
type SectionRead = {
  isPaused: boolean;
  isError: boolean;
  isFetching: boolean;
  refetch: () => unknown;
};

/** Whether a section's read failed with nothing loaded: the arm that shows
 *  Retry, which the caller feeds to `useRetryFocusRescue`. */
export function sectionReadFailed(q: SectionRead & { data: unknown }): boolean {
  return q.data === undefined && refreshFailed(q);
}

/** What {@link SectionReadLine} says while the read has nothing loaded, for a
 *  control that waits on the same read to name its hold in the same words. */
export function sectionReadReason(query: SectionRead, noun: string): string {
  if (query.isPaused) return offlinePendingMessage(noun);
  if (refreshFailed(query)) return `Couldn't load ${noun}.`;
  return `Loading ${noun}…`;
}

/** The line a section shows where its answer goes while its read has none: a
 *  skeleton the height of the one-line empty state, so the answer grows the
 *  section downward instead of popping a line in; the offline line for a read
 *  parked with nothing loaded; or the failure with Retry, so a reserved slot
 *  never sits loading forever. `noun` is plural and lowercase ("sub-issues"). */
export function SectionReadLine({
  query,
  noun,
  retryRef,
}: {
  query: SectionRead;
  noun: string;
  /** `useRetryFocusRescue`'s ref, for the Retry this renders on a failure. */
  retryRef: Ref<HTMLButtonElement>;
}) {
  const line = sectionReadReason(query, noun);
  if (query.isPaused)
    return <p className="text-[11px] text-muted-foreground">{line}</p>;
  if (refreshFailed(query))
    return (
      <p className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
        {line}
        <button
          ref={retryRef}
          type="button"
          aria-label={`Retry loading ${noun}`}
          className="cursor-pointer underline hover:text-foreground"
          onClick={() => void query.refetch()}
        >
          Retry
        </button>
      </p>
    );
  // A div, not a p, since the skeleton is one. Its inline-block sits on a
  // single line box, so the slot is exactly the empty state's line height.
  return (
    <div className="text-[11px]">
      <Skeleton
        aria-hidden
        className="inline-block h-[1em] w-32 align-middle"
      />
      <span className="sr-only">{line}</span>
    </div>
  );
}

/** A row's own pending remove: the hold's reason, and whether the write is
 *  parked offline rather than running. */
export type RowPending = { reason: string; paused: boolean };

/** A pending write's {@link RowPending}, worded `inFlight` while it runs. */
export function rowPending(
  pending: { paused: boolean } | undefined,
  inFlight: string,
): RowPending | undefined {
  return pending
    ? {
        reason: pendingWriteReason(pending.paused, inFlight),
        paused: pending.paused,
      }
    : undefined;
}

/** A clickable related-issue row with an always-visible remove button. Callers
 *  that pass `pending` get it held while their unlink is in flight or parked, so
 *  a slow one can't double-fire; it spins only while the write runs, since a
 *  parked one isn't working. */
export function RelatedRow({
  issue,
  onOpen,
  onRemove,
  pending,
  removeDisabledReason,
}: {
  issue: RelatedIssue;
  onOpen: (n: number) => void;
  onRemove: () => void;
  /** Set while this row's own remove is pending. */
  pending?: RowPending;
  /** Set when this row's remove can't be used right now — the viewer lacks the
   *  access it needs (sub-issues are write, dependency and related-issue links
   *  are triage), or the surface is still loading the entity. The button stays
   *  visible but disabled. */
  removeDisabledReason?: string;
}) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <StateIcon state={issue.state} />
      <button
        type="button"
        onClick={() => onOpen(issue.number)}
        className="min-w-0 flex-1 cursor-pointer truncate text-left hover:underline"
        title={`#${issue.number} ${issue.title}`}
      >
        <span className="text-muted-foreground">#{issue.number}</span>{" "}
        {issue.title}
      </button>
      <DisabledReasonButton
        variant="ghost"
        size="icon-xs"
        aria-label={`Remove #${issue.number}`}
        disabled={pending !== undefined || !!removeDisabledReason}
        reason={removeDisabledReason ?? pending?.reason}
        // Full opacity only for the running spinner.
        className={cn(
          "text-muted-foreground",
          pending && !pending.paused && "aria-disabled:opacity-100",
        )}
        onClick={onRemove}
      >
        {pending && !pending.paused ? <Spinner /> : <XIcon />}
      </DisabledReasonButton>
    </div>
  );
}

/** A labelled dependency list (Blocked by / Blocking). `removing` reports a row's
 *  pending unlink, if any, so its remove button can show pending + hold. */
function RelationList({
  label,
  items,
  onOpen,
  onRemove,
  removing,
  removeDisabledReason,
}: {
  label: string;
  items: RelatedIssue[];
  onOpen: (n: number) => void;
  onRemove: (target: number) => void;
  removing: (target: number) => RowPending | undefined;
  /** Set when the viewer may not edit dependencies: each row's remove stays
   *  visible but disabled, with this text as its hint. */
  removeDisabledReason?: string;
}) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      {items.map((it) => (
        <RelatedRow
          key={it.id}
          issue={it}
          onOpen={onOpen}
          onRemove={() => onRemove(it.number)}
          pending={removing(it.number)}
          removeDisabledReason={removeDisabledReason}
        />
      ))}
    </div>
  );
}

/**
 * Autocomplete over the repo's existing issues (open + closed), excluding the
 * ones that can't be added (self, parent, already-linked). Picking one fires
 * `onPick`. The lists only load while this is mounted (the picker is open).
 */
export function IssuePicker({
  repoPath,
  exclude,
  pending,
  onPick,
  lens,
}: {
  repoPath: string;
  exclude: Set<number>;
  pending: boolean;
  onPick: (n: number) => void;
  /** The origin|upstream lens the parent issue surface resolved. */
  lens: RemoteLens;
}) {
  const open = useIssueList(repoPath, true, "open", undefined, lens);
  const closed = useIssueList(repoPath, true, "closed", undefined, lens);
  const candidates = [...(open.data ?? []), ...(closed.data ?? [])].filter(
    (i) => !exclude.has(i.number),
  );
  return (
    <Combobox
      items={candidates}
      itemToStringLabel={(i: IssueInfo) => `#${i.number} ${i.title}`}
      value={null}
      // The input disables while pending, but a popup already open could still
      // pick; a held pick would start a second write.
      onValueChange={(item: IssueInfo | null) =>
        item && !pending && onPick(item.number)
      }
      openOnInputClick
    >
      <ComboboxInput
        autoFocus
        className="w-full"
        placeholder="Search issues by # or title"
        disabled={pending}
      />
      <ComboboxContent>
        <ComboboxEmpty>No matching issues.</ComboboxEmpty>
        <ComboboxList>
          {(item: IssueInfo) => (
            <ComboboxItem key={item.number} value={item}>
              <StateIcon state={item.state} />
              <span className="text-muted-foreground">#{item.number}</span>
              <span className="truncate">{item.title}</span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

/**
 * An issue's parent + sub-issues: a clickable parent breadcrumb, the sub-issue
 * checklist with its completion bar, and an "Add sub-issue" menu (create a new
 * linked issue or attach an existing one). A conversation-column body section.
 */
export function IssueSubIssues({
  repoPath,
  issueId,
  number,
  lens,
  disabledReason,
  reserve = false,
  held = false,
}: {
  repoPath: string;
  issueId: string;
  number: number;
  /** The origin|upstream lens the parent issue view resolved. */
  lens: RemoteLens;
  /** Set when these edits can't be used right now — the viewer may not write to
   *  the repo, or the surface is still loading the entity: the add + remove
   *  affordances stay visible but disabled, with this text as their hint. The
   *  parent breadcrumb and the checklist itself are reads and stay live. */
  disabledReason?: string;
  /** The provider is known to carry sub-issues: the section holds its minimum
   *  loaded height while the read is out, and says so when it can't load.
   *  Otherwise it stays absent until the read answers. */
  reserve?: boolean;
  /** The host is holding this issue on screen while another loads. `inert`
   *  can't reach a portaled dialog or popup, so this shuts them. */
  held?: boolean;
}) {
  const relations = useIssueRelations(repoPath, number, lens);
  const addSub = useAddSubIssue();
  const removeSub = useRemoveSubIssue(repoPath);
  const selectIssue = useUiStore((s) => s.selectIssue);
  const [mode, setMode] = useState<null | "existing">(null);
  const [createOpen, setCreateOpen] = useState(false);
  if (held && (createOpen || mode !== null)) {
    setCreateOpen(false);
    setMode(null);
  }
  // From the cache, not the observers: this section remounts per issue, and a
  // write still pending on the issue switched back to must still show.
  const pendingWrites = usePendingIssueWrites(repoPath);
  const addPending = pendingIssueWrite(
    pendingWrites,
    "add-sub-issue",
    (v) => v.parentId === issueId,
  );
  const addReason = addPending
    ? pendingWriteReason(addPending.paused, "Adding the sub-issue…")
    : undefined;
  const removing = (subId: string) =>
    rowPending(
      pendingIssueWrite(
        pendingWrites,
        "remove-sub-issue",
        (v) => v.parentId === issueId && v.subId === subId,
      ),
      "Removing this sub-issue…",
    );

  const onError = (e: unknown) => toastError(e);
  const data = relations.data;
  // A pressed Retry swaps the failure for the skeleton; the section root it
  // sits in survives and takes focus.
  const { hostRef, retryRef } = useRetryFocusRescue(
    reserve && sectionReadFailed(relations),
  );

  // Unreserved, wait for the first load so issues with no sub-issues don't
  // flash an empty section before it resolves.
  if (!data && !reserve) return null;

  const parent = data?.parent ?? null;
  const subIssues = data?.subIssues ?? [];
  const completed = data?.completed ?? 0;
  const total = data?.total ?? 0;
  // "Add existing" excludes the loaded parent and sub-issues, so it waits for
  // them, naming the wait as the line below does; the viewer's own reason
  // outranks it.
  const addHeldReason =
    disabledReason ??
    (data ? undefined : sectionReadReason(relations, "sub-issues"));
  const exclude = new Set<number>([
    number,
    ...(parent ? [parent.number] : []),
    ...subIssues.map((s) => s.number),
  ]);

  function open(n: number) {
    selectIssue({ kind: "remote", id: String(n) });
  }

  async function pickExisting(n: number) {
    try {
      await addSub.mutateAsync({
        repo: repoPath,
        parentId: issueId,
        subNumber: n,
        lens,
      });
    } catch (e) {
      onError(e);
      return;
    }
    setMode(null);
  }

  return (
    <div
      ref={hostRef}
      tabIndex={-1}
      className="space-y-2 border-y py-3 outline-none"
    >
      {parent && (
        <button
          type="button"
          onClick={() => open(parent.number)}
          className="flex w-full items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
          title={`Parent: #${parent.number} ${parent.title}`}
        >
          <ArrowBendUpLeftIcon className="size-3.5 shrink-0" />
          <span className="shrink-0">Parent</span>
          <StateIcon state={parent.state} />
          <span className="truncate">
            #{parent.number} {parent.title}
          </span>
        </button>
      )}

      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium">Sub-issues</span>
          {total > 0 && (
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {completed}/{total}
            </span>
          )}
          <span className="flex-1" />
          {mode === null && (
            <DropdownMenu>
              {/* Every item in this menu is a write, so the whole trigger
                  button disables rather than each item. */}
              <DropdownMenuTrigger
                render={
                  <DisabledReasonButton
                    variant="ghost"
                    size="xs"
                    aria-label="Add a sub-issue"
                    disabled={!!addHeldReason}
                    reason={addHeldReason}
                  />
                }
              >
                <PlusIcon data-icon="inline-start" />
                Add sub-issue
                <CaretDownIcon data-icon="inline-end" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-52">
                <DropdownMenuItem onClick={() => setCreateOpen(true)}>
                  Create new sub-issue…
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setMode("existing")}>
                  Add existing issue…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {total > 0 && (
          <div className="h-1 w-full bg-muted" aria-hidden>
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${(completed / total) * 100}%` }}
            />
          </div>
        )}

        {subIssues.map((s) => (
          <RelatedRow
            key={s.id}
            issue={s}
            onOpen={open}
            onRemove={() =>
              void removeSub
                .mutateAsync({ parentId: issueId, subId: s.id })
                .catch(onError)
            }
            pending={removing(s.id)}
            removeDisabledReason={disabledReason}
          />
        ))}
        <PendingWriteNote reason={addReason} />

        {!data ? (
          <SectionReadLine
            query={relations}
            noun="sub-issues"
            retryRef={retryRef}
          />
        ) : (
          subIssues.length === 0 &&
          mode === null && (
            <p className="text-[11px] text-muted-foreground">
              No sub-issues yet.
            </p>
          )
        )}

        {mode === "existing" && (
          <div className="flex items-center gap-1.5">
            <div className="min-w-0 flex-1">
              <IssuePicker
                repoPath={repoPath}
                exclude={exclude}
                pending={addReason !== undefined}
                onPick={(n) => void pickExisting(n)}
                lens={lens}
              />
            </div>
            <Button variant="ghost" size="xs" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        )}
      </div>

      <CreateIssueDialog
        repoPath={repoPath}
        lens={lens}
        open={createOpen}
        onOpenChange={setCreateOpen}
        subIssueParentId={issueId}
      />
    </div>
  );
}

/**
 * An issue's blocked-by / blocking dependencies — a meta-sidebar section with an
 * "Add ▾" menu, the two dependency lists, and an inline issue-picker.
 */
export function IssueRelationships({
  repoPath,
  number,
  lens,
  disabledReason,
  reserve = false,
}: {
  repoPath: string;
  number: number;
  /** The origin|upstream lens the parent issue view resolved. */
  lens: RemoteLens;
  /** Set when the viewer lacks the access dependency edits need: Add and the
   *  per-row removes disable, with this text as their hint. The lists stay live. */
  disabledReason?: string;
  /** The provider is known to carry dependencies: the empty state's line is
   *  held while the read is out, and says so when it can't load. */
  reserve?: boolean;
}) {
  const dependencies = useIssueDependencies(repoPath, number, lens);
  const setDep = useSetIssueDependency(repoPath, lens);
  const selectIssue = useUiStore((s) => s.selectIssue);
  const [addRelation, setAddRelation] = useState<IssueRelation | null>(null);
  // From the cache, so a write still pending survives this section's remount.
  const pendingWrites = usePendingIssueWrites(repoPath);
  const dependencyPending = (
    match: (v: {
      relation: IssueRelation;
      target: number;
      add: boolean;
    }) => boolean,
    inFlight: string,
  ) =>
    rowPending(
      pendingIssueWrite(
        pendingWrites,
        "dependency",
        (v) => v.number === number && match(v),
      ),
      inFlight,
    );
  const addReason = dependencyPending(
    (v) => v.add,
    "Adding the relationship…",
  )?.reason;
  const removing = (relation: IssueRelation) => (target: number) =>
    dependencyPending(
      (v) => !v.add && v.relation === relation && v.target === target,
      "Removing this relationship…",
    );
  // Any dependency write on this issue holds the picker, as before.
  const pickerPending =
    pendingIssueWrite(
      pendingWrites,
      "dependency",
      (v) => v.number === number,
    ) !== undefined;

  const onError = (e: unknown) => toastError(e);
  const { hostRef, retryRef } = useRetryFocusRescue(
    reserve && sectionReadFailed(dependencies),
  );
  const depsLoaded = dependencies.data !== undefined;
  const blockedBy = dependencies.data?.blockedBy ?? [];
  const blocking = dependencies.data?.blocking ?? [];
  const excludeBlockedBy = new Set<number>([
    number,
    ...blockedBy.map((i) => i.number),
  ]);
  const excludeBlocking = new Set<number>([
    number,
    ...blocking.map((i) => i.number),
  ]);

  function open(n: number) {
    selectIssue({ kind: "remote", id: String(n) });
  }

  function removeDependency(relation: IssueRelation, target: number) {
    void setDep
      .mutateAsync({ number, relation, target, add: false })
      .catch(onError);
  }

  async function addDependency(relation: IssueRelation, target: number) {
    try {
      await setDep.mutateAsync({ number, relation, target, add: true });
    } catch (e) {
      onError(e);
      return;
    }
    setAddRelation(null);
  }

  return (
    <div ref={hostRef} tabIndex={-1} className="space-y-1.5 outline-none">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          Relationships
        </span>
        <span className="flex-1" />
        {addRelation === null && (
          <DropdownMenu>
            {/* Every item in this menu is a write, so the whole trigger
                button disables rather than each item. */}
            <DropdownMenuTrigger
              render={
                <DisabledReasonButton
                  variant="ghost"
                  size="xs"
                  aria-label="Add a relationship"
                  disabled={!!disabledReason}
                  reason={disabledReason}
                />
              }
            >
              <PlusIcon data-icon="inline-start" />
              Add
              <CaretDownIcon data-icon="inline-end" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuItem onClick={() => setAddRelation("blocked_by")}>
                Blocked by…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setAddRelation("blocking")}>
                Blocking…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {blockedBy.length > 0 && (
        <RelationList
          label="Blocked by"
          items={blockedBy}
          onOpen={open}
          onRemove={(t) => removeDependency("blocked_by", t)}
          removing={removing("blocked_by")}
          removeDisabledReason={disabledReason}
        />
      )}
      {blocking.length > 0 && (
        <RelationList
          label="Blocking"
          items={blocking}
          onOpen={open}
          onRemove={(t) => removeDependency("blocking", t)}
          removing={removing("blocking")}
          removeDisabledReason={disabledReason}
        />
      )}
      <PendingWriteNote reason={addReason} />
      {!depsLoaded
        ? reserve && (
            <SectionReadLine
              query={dependencies}
              noun="relationships"
              retryRef={retryRef}
            />
          )
        : blockedBy.length === 0 &&
          blocking.length === 0 &&
          addRelation === null && (
            <p className="text-[11px] text-muted-foreground">
              No linked issues.
            </p>
          )}

      {addRelation !== null && (
        <div className="space-y-1">
          <p className="text-[11px] text-muted-foreground">
            {addRelation === "blocked_by"
              ? "Add an issue that blocks this one"
              : "Add an issue this one blocks"}
          </p>
          <div className="flex items-center gap-1.5">
            <div className="min-w-0 flex-1">
              <IssuePicker
                repoPath={repoPath}
                exclude={
                  addRelation === "blocked_by"
                    ? excludeBlockedBy
                    : excludeBlocking
                }
                pending={pickerPending}
                onPick={(t) => void addDependency(addRelation, t)}
                lens={lens}
              />
            </div>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setAddRelation(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
