import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
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
import { type ConfirmRequest, useConfirm } from "@/lib/stores/confirm";
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
 *  stableStringify in settings/save-reset.ts — the Tauri store reorders nested
 *  keys). */
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
    /** The same for this panel's discard, so the host's confirmed footer
     *  Discard (and "Discard and close") resets the lifecycle draft too. */
    onRegisterDiscard: undefined as
      | ((discard: (() => void) | null) => void)
      | undefined,
  },
  render: function AutomationsSectionRender({
    form,
    onDirtyChange,
    onRegisterSave,
    onRegisterDiscard,
  }) {
    const automations = useAutomations();
    const save = useSaveAutomations();
    const [draft, setDraft] = useState<LifecycleDraft>({});

    // Seeded once, when the config first loads; afterwards only edits and
    // Discard change the draft (a save's refetch never re-seeds it).
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

    const pendingDiscard = useRef<LifecycleDraft | null>(null);
    // Resets at once to what an in-flight save (its refetch included) is
    // writing, so nothing reads as unsaved once it lands and no edit made
    // after the reset is overwritten by a deferred one.
    function discard() {
      const target =
        save.isPending && save.variables ? save.variables.lifecycles : saved;
      pendingDiscard.current = save.isPending ? target : null;
      setDraft(target);
    }

    // A save that fails under a Discard must not leave the discarded rules for
    // a later Save to persist: an unedited reset (still that same object)
    // returns to the stored config, while any edit since makes a new draft.
    useEffect(() => {
      if (save.isPending) return;
      const target = pendingDiscard.current;
      if (!target) return;
      pendingDiscard.current = null;
      if (save.isError) setDraft((d) => (d === target ? saved : d));
    }, [save.isPending, save.isError, saved]);
    const mounted = useRef(true);
    useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
      };
    }, []);
    const dirtyRef = useLatestRef(dirty);

    // Bar-unmount focus, in the commit that hides the bar: land on the panel's
    // heading when the removed bar held focus (now on body) or a confirmed
    // Discard aimed there (focus may still sit in the closing prompt).
    const headingRef = useRef<HTMLHeadingElement>(null);
    const pendingHeadingFocus = useRef(false);
    const barWasShown = useRef(false);
    useLayoutEffect(() => {
      const hid = barWasShown.current && !dirty;
      barWasShown.current = dirty;
      const aimed = pendingHeadingFocus.current;
      pendingHeadingFocus.current = false;
      if (!hid) return;
      const active = document.activeElement;
      if (aimed || active === null || active === document.body)
        headingRef.current?.focus({ preventScroll: true });
    }, [dirty]);

    // For a prompt answer that flips no state: the frame outlasts the dialog's
    // close commit and lands before Base UI's later focus return to a Discard
    // button that is already gone.
    function focusHeadingAfterPrompt() {
      requestAnimationFrame(() =>
        headingRef.current?.focus({ preventScroll: true }),
      );
    }

    // This panel's own open Discard prompt, dismissed if the panel unmounts
    // under it (a hotkey can navigate away past the modal).
    const promptRef = useRef<ConfirmRequest | null>(null);
    useEffect(
      () => () => {
        if (useConfirm.getState().request === promptRef.current)
          promptRef.current?.resolve(false, false);
      },
      [],
    );
    async function requestDiscard() {
      const answer = useConfirm.getState().ask({
        title: "Discard unsaved changes?",
        body: "Every automation rule change since your last save is undone.",
        confirmLabel: "Discard changes",
        confirmVariant: "destructive",
        scope: "app",
      });
      const mine = useConfirm.getState().request;
      promptRef.current = mine;
      const ok = await answer;
      if (promptRef.current === mine) promptRef.current = null;
      if (!ok) {
        // A superseding prompt or an unmounted panel keeps focus where it is.
        if (
          mounted.current &&
          useConfirm.getState().request === null &&
          !dirtyRef.current
        )
          focusHeadingAfterPrompt();
        return;
      }
      if (!mounted.current) return;
      if (!dirtyRef.current) {
        focusHeadingAfterPrompt();
        return;
      }
      pendingHeadingFocus.current = true;
      discard();
    }

    function doSave() {
      if (!automations.data) return;
      // Detached: Settings' "Save and close" fires this right before unmounting
      // the panel, so the failure toast must not depend on it staying mounted.
      void save
        .mutateAsync({
          ...automations.data,
          lifecycles: sanitizeLifecycles(draft),
        })
        .catch(toastError);
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
    const discardRef = useLatestRef(discard);
    useEffect(() => {
      if (!onRegisterDiscard) return;
      onRegisterDiscard(dirty ? () => discardRef.current() : null);
      return () => onRegisterDiscard(null);
    }, [dirty, onRegisterDiscard]);

    return (
      <section className="space-y-3">
        <div>
          <h2 ref={headingRef} tabIndex={-1} className="text-sm font-medium">
            Automations
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Run an AI action automatically when something happens. These
            defaults apply to every repository; a repository can override them
            from its ⋯ menu. Reviews use the review model configured in the AI
            section — PR results are posted as a comment, commit results open
            from their notification row, and from Automation history whatever
            your Notify on choice for Automation results is (Settings →
            Notifications).
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
                  <DisabledReasonButton
                    variant="outline"
                    size="sm"
                    onClick={requestDiscard}
                    disabled={save.isPending}
                    reason="Saving…"
                  >
                    Discard
                  </DisabledReasonButton>
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
