import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useAutomations,
  useSaveRepoAutomations,
} from "@/lib/automations/queries";
import {
  type ActionConfig,
  type ActionId,
  type BranchConditions,
  type LifecycleEvent,
  type RepoActionOverride,
  type RepoOverride,
  repoEntry,
} from "@/lib/automations/types";
import { useRepoIdentity } from "@/lib/git/queries";
import { toastError } from "@/lib/toast";
import {
  type CellPatch,
  type CellState,
  LifecycleEditor,
  sanitizeConditions,
} from "./LifecycleEditor";

const EMPTY_OVERRIDE: RepoOverride = { lifecycles: {} };

function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.keys(val as Record<string, unknown>)
            .sort()
            .map((k) => [k, (val as Record<string, unknown>)[k]]),
        )
      : val,
  );
}

function sameConditions(
  a: BranchConditions | undefined,
  b: BranchConditions | undefined,
): boolean {
  return sortedJson(a ?? null) === sortedJson(b ?? null);
}

/** Strips blank pattern rows from every override cell's conditions before
 *  persisting, so a leftover empty include/exclude row can never survive. */
function sanitizeOverride(override: RepoOverride): RepoOverride {
  const lifecycles: RepoOverride["lifecycles"] = {};
  for (const [lifecycle, actions] of Object.entries(override.lifecycles) as [
    LifecycleEvent,
    Partial<Record<ActionId, RepoActionOverride>>,
  ][]) {
    const cleaned: Partial<Record<ActionId, RepoActionOverride>> = {};
    for (const [action, cfg] of Object.entries(actions) as [
      ActionId,
      RepoActionOverride,
    ][]) {
      cleaned[action] = {
        ...cfg,
        ...("conditions" in cfg
          ? { conditions: sanitizeConditions(cfg.conditions) }
          : {}),
      };
    }
    lifecycles[lifecycle] = cleaned;
  }
  return { lifecycles };
}

/**
 * This repository's automations: per-cell overrides on top of the global
 * lifecycle grid. Edited as a draft override behind Cancel / Save changes; a
 * cell edited back to match the global default drops its override (inherits).
 */
export function RepoAutomationsDialog({
  repoPath,
  open,
  onOpenChange,
}: {
  repoPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const automations = useAutomations();
  const save = useSaveRepoAutomations(repoPath);

  // Look up this repo's overrides by its worktree-stable identity (so a worktree
  // checkout and main share one entry); falls back to the raw path while identity
  // resolves or for a not-yet-folded legacy key.
  const repoId = useRepoIdentity(repoPath).data;
  const savedOverride = automations.data
    ? (repoEntry(automations.data, repoId ?? repoPath, repoPath) ??
      EMPTY_OVERRIDE)
    : EMPTY_OVERRIDE;

  const [draft, setDraft] = useState<RepoOverride>(EMPTY_OVERRIDE);

  // Seed the draft from the saved override when the dialog opens (reset on close
  // so a reopen reflects the persisted state, not stale in-flight edits).
  const seeded = useRef(false);
  useEffect(() => {
    if (!open) {
      seeded.current = false;
      return;
    }
    if (!seeded.current && automations.data) {
      seeded.current = true;
      setDraft(savedOverride);
    }
  }, [open, automations.data, savedOverride]);

  const dirty = sortedJson(draft) !== sortedJson(savedOverride);

  const global = automations.data?.lifecycles ?? {};

  function globalCfg(
    lifecycle: LifecycleEvent,
    action: ActionId,
  ): ActionConfig | undefined {
    return global[lifecycle]?.actions[action];
  }

  function cellState(lifecycle: LifecycleEvent, action: ActionId): CellState {
    const base = globalCfg(lifecycle, action);
    const override = draft.lifecycles[lifecycle]?.[action];
    const enabled = override?.enabled ?? base?.enabled ?? false;
    const conditions = override?.conditions ?? base?.conditions;
    const overridden = override !== undefined && override !== null;
    return { enabled, conditions, overridden };
  }

  function patchCell(
    lifecycle: LifecycleEvent,
    action: ActionId,
    patch: CellPatch,
  ) {
    setDraft((d) => {
      const base = globalCfg(lifecycle, action);
      const current = cellState(lifecycle, action);
      const nextEnabled = patch.enabled ?? current.enabled;
      const nextConditions =
        "conditions" in patch ? patch.conditions : current.conditions;

      // An override is only stored where the resulting cell differs from the
      // global default; edited back to match global, it's dropped (inherits).
      const matchesGlobal =
        nextEnabled === (base?.enabled ?? false) &&
        sameConditions(nextConditions, base?.conditions);

      const lifecycleMap = { ...(d.lifecycles[lifecycle] ?? {}) };
      if (matchesGlobal) {
        delete lifecycleMap[action];
      } else {
        const override: RepoActionOverride = {};
        if (nextEnabled !== (base?.enabled ?? false))
          override.enabled = nextEnabled;
        if (!sameConditions(nextConditions, base?.conditions))
          override.conditions = nextConditions;
        lifecycleMap[action] = override;
      }

      const nextLifecycles = { ...d.lifecycles };
      if (Object.keys(lifecycleMap).length === 0) {
        delete nextLifecycles[lifecycle];
      } else {
        nextLifecycles[lifecycle] = lifecycleMap;
      }
      return { lifecycles: nextLifecycles };
    });
  }

  function resetToGlobal() {
    setDraft(EMPTY_OVERRIDE);
  }

  function doSave() {
    save.mutate(sanitizeOverride(draft), {
      onSuccess: () => {
        toast.success("Repository automations saved");
        onOpenChange(false);
      },
      onError: toastError,
    });
  }

  const hasOverrides = Object.keys(draft.lifecycles).length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Flex column with a capped height so tall content (lifecycle cards +
          expanded conditions editors) never outgrows the viewport; the body
          scrolls while the header and footer stay pinned. */}
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Repository automations</DialogTitle>
          <DialogDescription>
            What runs automatically in this repository. Cells start from the
            global defaults in Settings → Automations; change one here to
            override it for this repository only.
          </DialogDescription>
        </DialogHeader>
        {/* overflow-x-hidden alongside overflow-y-auto so the vertical
            scrollbar's width can't induce a phantom horizontal one. */}
        <div className="min-h-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto pr-1">
          {automations.isPending ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <>
              <div className="flex justify-end">
                <DisabledReasonButton
                  variant="ghost"
                  size="xs"
                  onClick={resetToGlobal}
                  disabled={!hasOverrides}
                  reason="No overrides to reset"
                  title="Remove all overrides and inherit the global defaults"
                >
                  Reset to global defaults
                </DisabledReasonButton>
              </div>
              <LifecycleEditor cellState={cellState} onCellPatch={patchCell} />
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <DisabledReasonButton
            onClick={doSave}
            disabled={!dirty || save.isPending}
            reason={save.isPending ? "Saving…" : "No changes to save"}
          >
            Save changes
          </DisabledReasonButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
