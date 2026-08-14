import {
  CheckIcon,
  InfoIcon,
  LightningIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import type { MergeConflictStrategy } from "@/lib/git/api";
import { useMergePreview } from "@/lib/git/queries";
import type { Branch } from "@/lib/git/types";

export type PickerMode = "merge" | "squash" | "rebase";

/** Advanced merge options; `strategy` is meaningful only for a regular merge. */
export interface MergeRunOptions {
  noFf: boolean;
  strategy: MergeConflictStrategy;
}

const PICKER_COPY: Record<
  PickerMode,
  { title: (current: string) => string; description: string; action: string }
> = {
  merge: {
    title: (c) => `Merge into ${c}`,
    description: "Merge conflicts, if any, will appear in the changes list.",
    action: "Merge",
  },
  squash: {
    title: (c) => `Squash and merge into ${c}`,
    description:
      "Combines the selected branch's changes into staged changes for a single commit.",
    action: "Squash and merge",
  },
  rebase: {
    title: (c) => `Rebase ${c} onto`,
    description:
      "Replays your branch's commits on top of the selected branch. Aborted automatically on conflicts.",
    action: "Rebase",
  },
};

/**
 * The merge / squash / rebase picker. Open when `mode` is set (null = closed).
 * Owns the selected branch, the advanced merge options (merge mode only), and
 * the in-memory conflict preview; the switcher owns the merge/rebase mutations
 * (they feed its `busy` gate) and runs them via `onRun`. On open it seeds the
 * branch to the first available and resets the options.
 */
export function BranchMergePickerDialog({
  repoPath,
  mode,
  onClose,
  onRun,
  otherBranches,
  currentLabel,
}: {
  repoPath: string;
  mode: PickerMode | null;
  onClose: () => void;
  onRun: (mode: PickerMode, branch: string, options: MergeRunOptions) => void;
  otherBranches: Branch[];
  currentLabel: string;
}) {
  const [pickerBranch, setPickerBranch] = useState("");
  // The dialog stays mounted through Base UI's ~100ms exit fade, by which time
  // `mode` is already null — its copy renders from the last non-null value or
  // it blanks mid-fade.
  const lastMode = useRef(mode);
  if (mode) lastMode.current = mode;
  const shownMode = mode ?? lastMode.current;
  const branchSelectId = useId();
  const conflictSelectId = useId();
  // Advanced merge options (merge mode only).
  const [mergeNoFf, setMergeNoFf] = useState(false);
  const [mergeStrategy, setMergeStrategy] =
    useState<MergeConflictStrategy>("none");
  // In-memory conflict prediction for the selected branch, while the merge
  // picker is open.
  const mergePreview = useMergePreview(
    repoPath,
    pickerBranch,
    mergeStrategy,
    mode === "merge",
  );

  const seedOnOpen = useEffectEvent(() => {
    setPickerBranch(otherBranches[0]?.name ?? "");
    setMergeNoFf(false);
    setMergeStrategy("none");
  });
  useEffect(() => {
    if (mode !== null) seedOnOpen();
  }, [mode]);

  function runPicker() {
    if (!mode || !pickerBranch) return;
    onRun(mode, pickerBranch, { noFf: mergeNoFf, strategy: mergeStrategy });
  }

  // The merge picker's in-memory conflict prediction, as a calm status line.
  function renderMergePreview() {
    if (mergePreview.isFetching) {
      return (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Spinner className="size-3" /> Checking…
        </span>
      );
    }
    const p = mergePreview.data;
    if (!p || p.status === "unknown") return null;
    if (p.status === "fast-forward") {
      // --no-ff suppresses the fast-forward, so reflect that when it's ticked.
      return mergeNoFf ? (
        <span className="flex items-center gap-1.5 text-info">
          <InfoIcon className="size-3.5 shrink-0" /> Fast-forward available —
          will create a merge commit
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-info">
          <LightningIcon className="size-3.5 shrink-0" /> Fast-forward — no
          merge commit needed
        </span>
      );
    }
    if (p.status === "up-to-date") {
      return (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <CheckIcon className="size-3.5 shrink-0" /> Already up to date —
          nothing to merge
        </span>
      );
    }
    if (p.status === "clean") {
      // The preview already ran with the chosen strategy, so a "clean" result
      // means it really will be clean (any conflicts auto-resolved).
      return (
        <span className="flex items-center gap-1.5 text-success">
          <CheckIcon className="size-3.5 shrink-0" /> Clean merge — creates a
          merge commit
        </span>
      );
    }
    // conflict — the preview is strategy-aware, so these are real conflicts that
    // remain even with the chosen strategy ("still" once a strategy can't take
    // them, e.g. structural delete/rename conflicts).
    const n = p.conflicts.length;
    const files = p.conflicts.slice(0, 4).join(", ");
    const more = n > 4 ? `, +${n - 4}` : "";
    const noun = n === 1 ? "file" : "files";
    const still = mergeStrategy !== "none" ? "still " : "";
    return (
      <span className="flex items-start gap-1.5 text-warning">
        <WarningIcon className="mt-px size-3.5 shrink-0" />
        <span>
          {n > 0
            ? `${n} ${noun} will ${still}conflict`
            : `This merge will ${still}conflict`}
          {files && `: ${files}${more}`}
        </span>
      </span>
    );
  }

  return (
    <Dialog
      open={mode !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {shownMode ? PICKER_COPY[shownMode].title(currentLabel) : ""}
          </DialogTitle>
          <DialogDescription>
            {shownMode ? PICKER_COPY[shownMode].description : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor={branchSelectId}>Branch</Label>
          <Select
            items={Object.fromEntries(
              otherBranches.map((b) => [b.name, b.name]),
            )}
            value={pickerBranch || null}
            onValueChange={(v) => v && setPickerBranch(v)}
          >
            <SelectTrigger id={branchSelectId} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {otherBranches.map((b) => (
                <SelectItem key={b.name} value={b.name}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {mode === "merge" && (
          <div className="space-y-3">
            <div className="min-h-5 text-xs">{renderMergePreview()}</div>
            <label className="flex cursor-pointer items-center gap-2 text-xs">
              <Checkbox
                checked={mergeNoFf}
                onCheckedChange={(c) => setMergeNoFf(c === true)}
              />
              Always create a merge commit
            </label>
            <div className="space-y-1.5">
              <Label htmlFor={conflictSelectId} className="text-xs">
                On conflict
              </Label>
              <Select
                items={{
                  none: "Stop and let me resolve",
                  ours: "Prefer current branch",
                  theirs: "Prefer incoming branch",
                }}
                value={mergeStrategy}
                onValueChange={(v) =>
                  v && setMergeStrategy(v as MergeConflictStrategy)
                }
              >
                <SelectTrigger id={conflictSelectId} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Stop and let me resolve</SelectItem>
                  <SelectItem value="ours">Prefer current branch</SelectItem>
                  <SelectItem value="theirs">Prefer incoming branch</SelectItem>
                </SelectContent>
              </Select>
              {mergeStrategy !== "none" &&
                mergePreview.data?.status !== "fast-forward" &&
                mergePreview.data?.status !== "up-to-date" && (
                  <p className="text-[11px] text-muted-foreground">
                    Conflicting changes from the{" "}
                    {mergeStrategy === "ours" ? "incoming" : "current"} side are
                    discarded.
                  </p>
                )}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={runPicker} disabled={!pickerBranch}>
            {shownMode ? PICKER_COPY[shownMode].action : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
