import { Popover } from "@base-ui/react/popover";
import { TagIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { MetaValueCell } from "@/components/meta-field-cells";
import { usePanelPortalContainer } from "@/components/panel-portal";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { useEditPrLabels, useRepoLabels } from "@/lib/git/queries";
import type { RemoteLens, RepoLabel } from "@/lib/git/types";
import { LabelChip } from "./Thread";

/**
 * Labels editor + chips, shared by the issue, PR and discussion views (labels
 * are a Labelable, so the same `labelableId`-keyed mutation works for all).
 * Edits are drafted while the popover is open and committed as one batched
 * mutation on close — instant checkboxes, one network call.
 */
export function LabelsPopover({
  repoPath,
  enabled,
  number,
  target,
  labelableId,
  labels,
  lens,
  disabledReason,
  cells = false,
}: {
  repoPath: string;
  enabled: boolean;
  /** The issue/MR number — GitLab keys the write on it (GitHub uses `labelableId`). */
  number: number;
  /** Which surface these labels live on — GitLab's endpoint differs (issues vs MRs). */
  target: "issue" | "mr" | "discussion";
  labelableId: string;
  labels: RepoLabel[];
  /** The origin|upstream lens the parent PR/issue surface resolved. */
  lens: RemoteLens;
  /** Set when this picker can't be edited right now — the viewer lacks the access
   *  its action needs, or the surface is still loading the entity. The trigger
   *  stays visible but disabled and this text explains why. Absent = editable. */
  disabledReason?: string;
  /** Emit the trigger and the chips as two SIBLING elements rather than one
   *  inline row, so a caller's label/value grid can place each in its own
   *  column. Default renders the inline row. */
  cells?: boolean;
}) {
  const repoLabels = useRepoLabels(repoPath, enabled, lens);
  const editLabels = useEditPrLabels(repoPath, lens);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const portalContainer = usePanelPortalContainer();

  function toggleDraft(name: string, on: boolean) {
    setDraft((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  }

  function handleOpenChange(o: boolean) {
    if (o) {
      setDraft(new Set(labels.map((l) => l.name)));
      setOpen(true);
      return;
    }
    setOpen(false);
    const applied = new Set(labels.map((l) => l.name));
    const idByName = new Map(
      (repoLabels.data ?? []).map((l) => [l.name, l.id]),
    );
    const ids = (names: string[]) =>
      names.map((n) => idByName.get(n)).filter((id): id is string => !!id);
    const addNames = [...draft].filter((n) => !applied.has(n));
    const removeNames = [...applied].filter((n) => !draft.has(n));
    // Guard on NAMES, not ids: GitLab labels carry no node id, so an id-based guard
    // would skip every GitLab edit. GitHub keys on the ids derived here; GitLab on
    // the names — the forge command takes whichever pair its provider addresses by.
    if (addNames.length > 0 || removeNames.length > 0) {
      editLabels.mutate({
        // `target` is this popover's surface; it doubles as the reconcile `kind`,
        // which is what picks the wire shape and the caches to invalidate.
        kind: target,
        number,
        labelableId,
        addIds: ids(addNames),
        removeIds: ids(removeNames),
        addNames,
        removeNames,
      });
    }
  }

  // Trigger first, so it never shifts as chips come and go. A natively disabled
  // button swallows `title`, so the reason rides a wrapping span.
  const trigger = (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <span
        title={disabledReason}
        className={
          disabledReason ? "inline-flex cursor-not-allowed" : "inline-flex"
        }
      >
        <Popover.Trigger
          disabled={!!disabledReason}
          render={<Button variant="ghost" size="xs" aria-label="Edit labels" />}
        >
          {/* size-3 explicitly: the Button's own icon rule skips a sized
              element, and a 16px swap would widen the label column mid-write. */}
          {editLabels.isPending ? (
            <Spinner className="size-3" data-icon="inline-start" />
          ) : (
            <TagIcon data-icon="inline-start" />
          )}
          Labels
        </Popover.Trigger>
      </span>
      <Popover.Portal container={portalContainer}>
        <Popover.Positioner
          align="start"
          sideOffset={4}
          className="isolate z-50"
        >
          <Popover.Popup className="w-60 rounded-none bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10">
            <p className="px-1 pb-1.5 text-xs font-medium">Labels</p>
            {(repoLabels.data ?? []).length === 0 && (
              <p className="px-1 py-1 text-xs text-muted-foreground">
                {repoLabels.isPending
                  ? "Loading labels…"
                  : "This repository has no labels."}
              </p>
            )}
            {(repoLabels.data ?? []).map((label) => (
              <label
                key={label.name}
                className="flex cursor-pointer items-center gap-2 px-1 py-1.5 text-xs hover:bg-muted/60"
              >
                <Checkbox
                  checked={draft.has(label.name)}
                  onCheckedChange={(v) => toggleDraft(label.name, v === true)}
                />
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: `#${label.color}` }}
                />
                <span className="flex-1 truncate" title={label.name}>
                  {label.name}
                </span>
              </label>
            ))}
            {(repoLabels.data ?? []).length > 0 && (
              <p className="mt-1 border-t px-1 pt-1.5 text-[11px] text-muted-foreground">
                Changes apply when this closes.
              </p>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
  const chips = labels.map((label) => (
    <LabelChip key={label.name} label={label} />
  ));

  if (cells) {
    return (
      <>
        {trigger}
        <MetaValueCell label="Labels" empty={labels.length === 0}>
          {chips}
        </MetaValueCell>
      </>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {trigger}
      {chips}
    </div>
  );
}
