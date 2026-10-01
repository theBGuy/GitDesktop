import { Popover } from "@base-ui/react/popover";
import { UserPlusIcon, XIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { presentError } from "@/lib/error-summary";
import {
  useBbAddDefaultReviewer,
  useBbDefaultReviewers,
  useBbMemberCandidates,
  useBbRemoveDefaultReviewer,
} from "@/lib/git/queries";
import type { ForgeUserRef } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { toastError } from "@/lib/toast";
import { useOnline } from "@/lib/use-online";
import { cn } from "@/lib/utils";
import { userRefHint } from "../pulls/ReviewersPopover";
import {
  InlineConfirm,
  OFFLINE_WRITE_REASON,
  RemoteListSection,
} from "./parts";

/** Bitbucket default reviewers: the accounts auto-added to every new pull
 *  request. List the current reviewers (arrow-key navigable), add from the
 *  workspace members not already added, and remove with a confirm. */
export function BitbucketDefaultReviewersSection({
  repoPath,
  open,
}: {
  repoPath: string;
  open: boolean;
}) {
  const reviewers = useBbDefaultReviewers(repoPath, open);
  const add = useBbAddDefaultReviewer(repoPath);
  const remove = useBbRemoveDefaultReviewer(repoPath);
  const online = useOnline();

  const [confirming, setConfirming] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);

  const rows = reviewers.data ?? [];

  // Awaited, not per-call callbacks: this subtree unmounts when the dialog
  // closes or the rail crossfades to another section, and react-query drops
  // per-call callbacks on unmount — the outcome would never reach the user.
  async function handleAdd(user: ForgeUserRef) {
    try {
      await add.mutateAsync(user.id);
      toast.success(`Added ${user.label}`);
    } catch (e) {
      toastError(e);
    }
  }

  async function handleRemove(reviewer: ForgeUserRef) {
    try {
      await remove.mutateAsync(reviewer.id);
      toast.success(`Removed ${reviewer.label}`);
      setConfirming(null);
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Reviewers automatically added to every new pull request.
        </p>
        <AddReviewerPopover
          repoPath={repoPath}
          open={open}
          added={rows}
          pending={add.isPending}
          onAdd={handleAdd}
        />
      </div>

      <RemoteListSection
        query={reviewers}
        rowCount={rows.length}
        noun="default reviewers"
        loadFailed="Couldn't load default reviewers."
        emptyLabel="No default reviewers — new pull requests start with no reviewers."
        skeletonClassName="h-11 w-full"
        errorTitle="Couldn't load default reviewers."
        errorHint="If this is a permissions error, managing default reviewers needs admin on this repository."
      >
        <div
          role="listbox"
          aria-label="Default reviewers"
          tabIndex={0}
          className="space-y-2 rounded-md outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onKeyDown={listKeyboardNav({
            items: rows,
            activeIndex,
            onActivate: (_item, to) => setActiveIndex(to),
            rowKey: (r) => r.id,
            rowAttr: "data-reviewer",
          })}
        >
          {rows.map((r, i) => (
            <ReviewerRow
              key={r.id}
              reviewer={r}
              all={rows}
              active={i === activeIndex}
              onFocus={() => setActiveIndex(i)}
              confirming={confirming === r.id}
              pending={remove.isPending}
              confirmHeld={online ? undefined : OFFLINE_WRITE_REASON}
              onConfirm={() => setConfirming(r.id)}
              onCancel={() => setConfirming(null)}
              onRemove={() => handleRemove(r)}
            />
          ))}
        </div>
      </RemoteListSection>
    </div>
  );
}

function ReviewerRow({
  reviewer,
  all,
  active,
  onFocus,
  confirming,
  pending,
  confirmHeld,
  onConfirm,
  onCancel,
  onRemove,
}: {
  reviewer: ForgeUserRef;
  all: ForgeUserRef[];
  active: boolean;
  onFocus: () => void;
  confirming: boolean;
  pending: boolean;
  /** Why the confirm's Remove is held; unset leaves it enabled. */
  confirmHeld?: string;
  onConfirm: () => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  const hint = userRefHint(reviewer, all);
  return (
    <div
      role="option"
      aria-selected={active}
      data-reviewer={reviewer.id}
      tabIndex={-1}
      onFocus={onFocus}
      className={cn(
        "flex items-center gap-2 rounded-md border p-2 text-xs outline-none",
        active && "ring-1 ring-ring",
      )}
    >
      <div className="min-w-0 flex-1">
        <p
          className="truncate font-medium"
          title={hint ? `${reviewer.label} (${hint})` : reviewer.label}
        >
          {reviewer.label}
          {hint && <span className="text-muted-foreground"> · {hint}</span>}
        </p>
      </div>
      {confirming ? (
        <InlineConfirm
          prompt="Remove?"
          actLabel="Remove"
          pending={pending}
          heldReason={confirmHeld}
          onCancel={onCancel}
          onAct={onRemove}
        />
      ) : (
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:text-destructive"
          onClick={onConfirm}
          title="Remove"
        >
          <XIcon />
        </Button>
      )}
    </div>
  );
}

function AddReviewerPopover({
  repoPath,
  open,
  added,
  pending,
  onAdd,
}: {
  repoPath: string;
  open: boolean;
  added: ForgeUserRef[];
  pending: boolean;
  onAdd: (user: ForgeUserRef) => void;
}) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const online = useOnline();
  const heldReason = !online
    ? OFFLINE_WRITE_REASON
    : pending
      ? "Saving your last change…"
      : undefined;
  // A pick made offline would park silently, so a picker open when the
  // connection drops closes with its trigger held. Reset, not derived into
  // `open`: a derived close would reopen and take focus on reconnect.
  if (!online && popoverOpen) setPopoverOpen(false);
  // Only fetch candidates once the picker opens (workspace member list is heavy).
  const candidates = useBbMemberCandidates(repoPath, open && popoverOpen);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const addedIds = new Set(added.map((a) => a.id));
  const q = query.trim().toLowerCase();
  const suggestions = (candidates.data ?? [])
    .filter((c) => !addedIds.has(c.id))
    .filter((c) => !q || c.label.toLowerCase().includes(q))
    .slice(0, 8);

  const optionCount = suggestions.length;
  const active = optionCount > 0 ? Math.min(activeIndex, optionCount - 1) : 0;

  function add(user: ForgeUserRef) {
    if (!online) return;
    onAdd(user);
    setQuery("");
    setActiveIndex(0);
    setPopoverOpen(false);
  }

  function onInputKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex(Math.min(active + 1, optionCount - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex(Math.max(active - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const match = suggestions[active];
      if (match) add(match);
    }
  }

  return (
    <Popover.Root open={popoverOpen} onOpenChange={setPopoverOpen}>
      <Popover.Trigger
        render={
          <DisabledReasonButton
            size="sm"
            disabled={heldReason !== undefined}
            reason={heldReason}
          />
        }
        aria-label="Add default reviewer"
      >
        {pending ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <UserPlusIcon data-icon="inline-start" />
        )}
        Add reviewer
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="end" sideOffset={4} className="isolate z-50">
          <Popover.Popup className="w-80 rounded-none bg-popover p-3 text-popover-foreground shadow-md ring-1 ring-foreground/10">
            <p className="pb-2 text-sm font-medium">Add a default reviewer</p>
            <Input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onInputKeyDown}
              placeholder="Search workspace members"
              autoComplete="off"
              role="combobox"
              aria-expanded={optionCount > 0}
              aria-controls="bb-reviewer-options"
              aria-activedescendant={
                optionCount > 0 ? `bb-reviewer-option-${active}` : undefined
              }
            />
            <div
              id="bb-reviewer-options"
              role="listbox"
              aria-label="Member suggestions"
              className="mt-2 space-y-px"
            >
              {candidates.isPending && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  Loading members…
                </p>
              )}
              {candidates.isError && (
                <p className="px-2 py-1.5 text-xs text-destructive">
                  {presentError(candidates.error).summary}
                </p>
              )}
              {suggestions.map((c, i) => {
                const hint = userRefHint(c, suggestions);
                return (
                  <button
                    type="button"
                    key={c.id}
                    id={`bb-reviewer-option-${i}`}
                    role="option"
                    aria-selected={active === i}
                    title={hint ? `${c.label} (${hint})` : undefined}
                    className={cn(
                      "flex w-full items-baseline gap-2 px-2 py-1.5 text-left text-xs",
                      active === i
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-muted/60",
                    )}
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => add(c)}
                  >
                    <span className="truncate font-medium">
                      {c.label}
                      {hint && (
                        <span className="text-muted-foreground"> · {hint}</span>
                      )}
                    </span>
                  </button>
                );
              })}
              {!candidates.isPending &&
                !candidates.isError &&
                suggestions.length === 0 && (
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">
                    {q
                      ? "No matching members."
                      : "Everyone in this workspace is already a default reviewer."}
                  </p>
                )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
