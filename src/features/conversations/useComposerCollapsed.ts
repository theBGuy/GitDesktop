import { useQueryClient } from "@tanstack/react-query";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import type { AppSettings } from "@/lib/settings/api";
import {
  settingsKeys,
  useSaveSettings,
  useSettings,
} from "@/lib/settings/queries";

/**
 * Global, persisted collapse state for the docked comment composer, shared by
 * every conversation surface (one preference, not one per entity — collapsing on
 * a PR reclaims the same reading space on issues and discussions). Registers the
 * palette action while a composer is mounted, so it is offered exactly where
 * there is a box to collapse.
 *
 * @param onExpand run when the box is expanded
 * @param onCollapse run when it collapses. Both directions re-home focus, but to
 *   different controls, so the hook delegates rather than picking one.
 * @param onRollback run with the collapsed value a refused write is restoring —
 *   the same re-homing decision for a transition the user never asked for, whose
 *   commit would otherwise unmount the focused control and strand focus.
 */
export function useComposerCollapsed(
  onExpand: () => void,
  onCollapse: () => void,
  onRollback: (restoredCollapsed: boolean) => void,
) {
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const queryClient = useQueryClient();
  const collapsed = settings.data?.commentComposerCollapsed ?? false;

  /** @returns whether the box actually changed state — false while settings are
   *  still loading, or when the preference already held `next`. Callers that arm
   *  follow-up work on the transition gate on it. */
  function setCollapsed(next: boolean): boolean {
    const current = settings.data;
    if (!current || current.commentComposerCollapsed === next) return false;
    const updated = { ...current, commentComposerCollapsed: next };
    // Patch the cache before persisting: an expand focuses the editor one frame
    // later, which the settings round-trip would not have landed in time for. A
    // refused write restores the previous value synchronously, so the caller's
    // re-homing has that one commit to ride.
    queryClient.setQueryData(settingsKeys.settings, updated);
    saveSettings.mutate(updated, {
      onError: () => {
        // Only roll back if this call's change is still the latest: otherwise a
        // late-failing earlier write would stomp a newer successful one (two
        // fast toggles where the first write rejects after the second lands).
        const latest = queryClient.getQueryData<AppSettings>(
          settingsKeys.settings,
        );
        if (latest?.commentComposerCollapsed !== next) return;
        // Armed before the restore, so the commit it rides is the very next one.
        onRollback(current.commentComposerCollapsed);
        queryClient.setQueryData(settingsKeys.settings, current);
      },
    });
    return true;
  }

  function toggle() {
    if (collapsed) onExpand();
    else onCollapse();
  }

  useHotkeyAction("toggle-comment-composer", toggle);

  return { collapsed, setCollapsed, toggle };
}
