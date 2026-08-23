import { useQueryClient } from "@tanstack/react-query";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
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
 * @param onExpand run when the palette action expands the box
 * @param onCollapse run when it collapses. Both directions re-home focus, but to
 *   different controls, so the hook delegates rather than picking one.
 */
export function useComposerCollapsed(
  onExpand: () => void,
  onCollapse: () => void,
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
    // failed write refetches the stored truth back over the patch.
    queryClient.setQueryData(settingsKeys.settings, updated);
    saveSettings.mutate(updated, {
      onError: () =>
        queryClient.invalidateQueries({ queryKey: settingsKeys.settings }),
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
