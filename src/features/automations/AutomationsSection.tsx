import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { settingsFormOpts } from "@/features/settings/settings-form";
import { useAutomations, useSaveAutomations } from "@/lib/automations/queries";
import {
  type ActionId,
  type BranchConditions,
  type LifecycleConfig,
  type LifecycleEvent,
} from "@/lib/automations/types";
import { withForm } from "@/lib/form";
import { toastError } from "@/lib/toast";
import { useLatestRef } from "@/lib/use-latest-ref";
import {
  type CellPatch,
  type CellState,
  hasConditions,
  LifecycleEditor,
  sanitizeConditions,
} from "./LifecycleEditor";

type LifecycleDraft = Partial<Record<LifecycleEvent, LifecycleConfig>>;

/** Strips blank pattern rows from every cell's conditions before persisting, so
 *  a leftover empty include/exclude row can never survive as a stored glob. */
function sanitizeLifecycles(draft: LifecycleDraft): LifecycleDraft {
  const out: LifecycleDraft = {};
  for (const [lifecycle, config] of Object.entries(draft) as [
    LifecycleEvent,
    LifecycleConfig,
  ][]) {
    const actions: LifecycleConfig["actions"] = {};
    for (const [action, cfg] of Object.entries(config.actions) as [
      ActionId,
      LifecycleConfig["actions"][ActionId],
    ][]) {
      if (!cfg) continue;
      actions[action] = {
        enabled: cfg.enabled,
        conditions: sanitizeConditions(cfg.conditions),
      };
    }
    out[lifecycle] = { actions };
  }
  return out;
}

/** JSON with object keys sorted, so the dirty check ignores key order (mirrors
 *  SettingsScreen's stableStringify — the Tauri store reorders nested keys). */
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

/**
 * Global automation defaults — the lifecycle grid every repository inherits.
 * Edited as a draft behind a Save/Discard bar (no per-toggle autosave); a repo
 * can then override individual cells from its ⋯ menu.
 *
 * The `reviewDraftPrs` toggle at the top is a plain AppSettings field, so it
 * rides the settings form (`form.AppField`) and the SettingsScreen Save/Discard
 * footer like every other app-wide preference — separate from the lifecycle
 * grid's own draft below.
 */
export const AutomationsSection = withForm({
  ...settingsFormOpts,
  props: {
    onDirtyChange: undefined as ((dirty: boolean) => void) | undefined,
    /** Lets the host (Settings) fire this panel's save imperatively — e.g. from
     *  its confirm-close "Save and close". Called with the save fn while there
     *  are unsaved edits, and with `null` when clean or unmounted. */
    onRegisterSave: undefined as
      | ((save: (() => void) | null) => void)
      | undefined,
  },
  render: function AutomationsSectionRender({
    form,
    onDirtyChange,
    onRegisterSave,
  }) {
    const automations = useAutomations();
    const save = useSaveAutomations();
    const [draft, setDraft] = useState<LifecycleDraft>({});

    // Seed the editable draft once the config loads; afterwards the draft owns
    // the truth until Save or Discard (Save re-invalidates → this re-seeds).
    const seeded = useRef(false);
    useEffect(() => {
      if (automations.data && !seeded.current) {
        seeded.current = true;
        setDraft(automations.data.lifecycles);
      }
    }, [automations.data]);

    const saved = automations.data?.lifecycles ?? {};
    const dirty = seeded.current && sortedJson(draft) !== sortedJson(saved);

    // Surface dirtiness to the Settings screen so closing with unsaved
    // automations draft routes through its confirm-close path.
    useEffect(() => {
      onDirtyChange?.(dirty);
      return () => onDirtyChange?.(false);
    }, [dirty, onDirtyChange]);

    function cellState(lifecycle: LifecycleEvent, action: ActionId): CellState {
      const cfg = draft[lifecycle]?.actions[action];
      return {
        enabled: cfg?.enabled ?? false,
        conditions: cfg?.conditions,
        overridden: false,
      };
    }

    function patchCell(
      lifecycle: LifecycleEvent,
      action: ActionId,
      patch: CellPatch,
    ) {
      setDraft((d) => {
        const life = d[lifecycle] ?? { actions: {} };
        const existing = life.actions[action] ?? { enabled: false };
        const nextEnabled = patch.enabled ?? existing.enabled;
        const nextConditions: BranchConditions | undefined =
          "conditions" in patch ? patch.conditions : existing.conditions;

        const nextActions = { ...life.actions };
        // Turning a cell off with no conditions is a net no-op (an absent cell
        // is already "off") — drop it so the draft doesn't grow or read dirty
        // for nothing. A disabled cell that still carries conditions is kept
        // (the user may re-enable it later).
        if (!nextEnabled && !hasConditions(nextConditions)) {
          delete nextActions[action];
        } else {
          nextActions[action] = {
            enabled: nextEnabled,
            conditions: nextConditions,
          };
        }

        const nextDraft = { ...d };
        if (Object.keys(nextActions).length === 0) {
          delete nextDraft[lifecycle];
        } else {
          nextDraft[lifecycle] = { ...life, actions: nextActions };
        }
        return nextDraft;
      });
    }

    function discard() {
      setDraft(saved);
    }

    function doSave() {
      if (!automations.data) return;
      save.mutate(
        { ...automations.data, lifecycles: sanitizeLifecycles(draft) },
        { onError: toastError },
      );
    }

    // Register/deregister the imperative save with the host, so Settings' "Save
    // and close" persists this panel too. Kept in a latest-ref so the registered
    // fn always saves the current draft without re-registering on every keystroke.
    const doSaveRef = useLatestRef(doSave);
    useEffect(() => {
      if (!onRegisterSave) return;
      onRegisterSave(dirty ? () => doSaveRef.current() : null);
      return () => onRegisterSave(null);
    }, [dirty, onRegisterSave]);

    return (
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-medium">Automations</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Run an AI action automatically when something happens. These
            defaults apply to every repository; a repository can override them
            from its ⋯ menu. Reviews use the review model configured in the AI
            section — PR results are posted as a comment, commit results open
            from a notification.
          </p>
        </div>
        <div className="space-y-1.5">
          <form.AppField name="reviewDraftPrs">
            {(field) => (
              <field.CheckboxField
                label="Review draft PRs when created"
                className="flex cursor-pointer items-center gap-2 text-xs"
              />
            )}
          </form.AppField>
          <p className="text-xs text-muted-foreground">
            Off: automated review runs when a draft is marked ready for review.
          </p>
        </div>
        {automations.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <>
            <LifecycleEditor cellState={cellState} onCellPatch={patchCell} />
            {dirty && (
              <div className="flex items-center justify-between gap-3 border-t pt-3">
                <span className="text-xs text-muted-foreground">
                  You have unsaved changes
                </span>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={discard}>
                    Discard
                  </Button>
                  <Button size="sm" onClick={doSave} disabled={save.isPending}>
                    Save changes
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </section>
    );
  },
});
