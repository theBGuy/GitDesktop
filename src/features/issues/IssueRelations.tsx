import {
  ArrowBendUpLeftIcon,
  CaretDownIcon,
  CheckCircleIcon,
  CircleDashedIcon,
  PlusIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
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
import { Spinner } from "@/components/ui/spinner";
import {
  useAddSubIssue,
  useIssueDependencies,
  useIssueList,
  useIssueRelations,
  useRemoveSubIssue,
  useSetIssueDependency,
} from "@/lib/git/queries";
import type {
  IssueInfo,
  IssueRelation,
  RelatedIssue,
  RemoteLens,
} from "@/lib/git/types";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { CreateIssueDialog } from "./CreateIssueDialog";

/** Open/closed glyph for a related issue, so state isn't conveyed by text alone. */
export function StateIcon({ state }: { state: string }) {
  return state === "CLOSED" ? (
    <CheckCircleIcon className="size-3.5 shrink-0 text-merged" />
  ) : (
    <CircleDashedIcon className="size-3.5 shrink-0 text-success" />
  );
}

/** A clickable related-issue row with a hover remove button. `pending` disables
 *  the remove button and shows a spinner so a slow unlink can't double-fire. */
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
  pending?: boolean;
  /** Set when the viewer may not write to the repo: the remove button stays
   *  visible but disabled, with this text as its hint. */
  removeDisabledReason?: string;
}) {
  return (
    <div className="group flex items-center gap-1.5 text-xs">
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
      {/* A natively disabled button swallows `title`, so the reason rides a
          wrapping span. */}
      <span
        title={removeDisabledReason}
        className={
          removeDisabledReason
            ? "inline-flex cursor-not-allowed"
            : "inline-flex"
        }
      >
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove #${issue.number}`}
          disabled={pending || !!removeDisabledReason}
          className="text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-100"
          onClick={onRemove}
        >
          {pending ? <Spinner /> : <XIcon />}
        </Button>
      </span>
    </div>
  );
}

/** A labelled dependency list (Blocked by / Blocking). `isRemoving` reports which
 *  row's unlink is in flight so its remove button can show pending + disable. */
function RelationList({
  label,
  items,
  onOpen,
  onRemove,
  isRemoving,
}: {
  label: string;
  items: RelatedIssue[];
  onOpen: (n: number) => void;
  onRemove: (target: number) => void;
  isRemoving: (target: number) => boolean;
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
          pending={isRemoving(it.number)}
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
      onValueChange={(item: IssueInfo | null) => item && onPick(item.number)}
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
}: {
  repoPath: string;
  issueId: string;
  number: number;
  /** The origin|upstream lens the parent issue view resolved. */
  lens: RemoteLens;
  /** Set when the viewer may not write to the repo: the add + remove
   *  affordances stay visible but disabled, with this text as their hint. The
   *  parent breadcrumb and the checklist itself are reads and stay live. */
  disabledReason?: string;
}) {
  const relations = useIssueRelations(repoPath, number, lens);
  const addSub = useAddSubIssue(repoPath, lens);
  const removeSub = useRemoveSubIssue(repoPath);
  const selectIssue = useUiStore((s) => s.selectIssue);
  const [mode, setMode] = useState<null | "existing">(null);
  const [createOpen, setCreateOpen] = useState(false);

  const onError = (e: unknown) => toastError(e);
  const data = relations.data;

  // Wait for the first load so issues with no sub-issues don't flash an empty
  // section before it resolves.
  if (!data) return null;

  const { parent, subIssues, completed, total } = data;
  const exclude = new Set<number>([
    number,
    ...(parent ? [parent.number] : []),
    ...subIssues.map((s) => s.number),
  ]);

  function open(n: number) {
    selectIssue({ kind: "remote", id: String(n) });
  }

  function pickExisting(n: number) {
    addSub.mutate(
      { parentId: issueId, subNumber: n },
      { onSuccess: () => setMode(null), onError },
    );
  }

  return (
    <div className="space-y-2 border-y py-3">
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
              {/* A natively disabled button swallows `title`, so the reason
                  rides a wrapping span. Every item in this menu is a write, so
                  the gate sits on the trigger rather than on each item. */}
              <span
                title={disabledReason}
                className={
                  disabledReason
                    ? "inline-flex cursor-not-allowed"
                    : "inline-flex"
                }
              >
                <DropdownMenuTrigger
                  disabled={!!disabledReason}
                  render={
                    <Button
                      variant="ghost"
                      size="xs"
                      aria-label="Add a sub-issue"
                    />
                  }
                >
                  <PlusIcon data-icon="inline-start" />
                  Add sub-issue
                  <CaretDownIcon data-icon="inline-end" />
                </DropdownMenuTrigger>
              </span>
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
              removeSub.mutate({ parentId: issueId, subId: s.id }, { onError })
            }
            pending={removeSub.isPending && removeSub.variables?.subId === s.id}
            removeDisabledReason={disabledReason}
          />
        ))}

        {subIssues.length === 0 && mode === null && (
          <p className="text-[11px] text-muted-foreground">
            No sub-issues yet.
          </p>
        )}

        {mode === "existing" && (
          <div className="flex items-center gap-1.5">
            <div className="min-w-0 flex-1">
              <IssuePicker
                repoPath={repoPath}
                exclude={exclude}
                pending={addSub.isPending}
                onPick={pickExisting}
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
}: {
  repoPath: string;
  number: number;
  /** The origin|upstream lens the parent issue view resolved. */
  lens: RemoteLens;
}) {
  const dependencies = useIssueDependencies(repoPath, number, lens);
  const setDep = useSetIssueDependency(repoPath, lens);
  const selectIssue = useUiStore((s) => s.selectIssue);
  const [addRelation, setAddRelation] = useState<IssueRelation | null>(null);

  const onError = (e: unknown) => toastError(e);
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

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          Relationships
        </span>
        <span className="flex-1" />
        {addRelation === null && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label="Add a relationship"
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
          onRemove={(t) =>
            setDep.mutate(
              { number, relation: "blocked_by", target: t, add: false },
              { onError },
            )
          }
          isRemoving={(t) =>
            setDep.isPending &&
            setDep.variables?.add === false &&
            setDep.variables.relation === "blocked_by" &&
            setDep.variables.target === t
          }
        />
      )}
      {blocking.length > 0 && (
        <RelationList
          label="Blocking"
          items={blocking}
          onOpen={open}
          onRemove={(t) =>
            setDep.mutate(
              { number, relation: "blocking", target: t, add: false },
              { onError },
            )
          }
          isRemoving={(t) =>
            setDep.isPending &&
            setDep.variables?.add === false &&
            setDep.variables.relation === "blocking" &&
            setDep.variables.target === t
          }
        />
      )}
      {depsLoaded &&
        blockedBy.length === 0 &&
        blocking.length === 0 &&
        addRelation === null && (
          <p className="text-[11px] text-muted-foreground">No linked issues.</p>
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
                pending={setDep.isPending}
                onPick={(t) =>
                  setDep.mutate(
                    { number, relation: addRelation, target: t, add: true },
                    { onSuccess: () => setAddRelation(null), onError },
                  )
                }
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
