// The repository view's secondary tabs, behind its "More ▾" overflow. Type-only,
// relative imports, so the installless suite loads it through the src hooks.

import type { ActionId } from "../../lib/hotkeys/registry";
import type { RepoTab } from "../../lib/stores/ui";

export interface SecondaryTab {
  tab: RepoTab;
  label: string;
  /** The tab's switch action, whose effective binding the menu row shows. */
  action: ActionId;
  ai?: boolean;
}

// Sorted by label: the number keys bind per tab, not by menu position, so the
// order is free to follow the labels.
export const SECONDARY_TABS: readonly SecondaryTab[] = (
  [
    { tab: "compare", label: "Compare", action: "tab-compare" },
    { tab: "agent", label: "Agent", action: "tab-agent", ai: true },
    { tab: "issues", label: "Issues", action: "tab-issues" },
    { tab: "projects", label: "Projects", action: "tab-projects" },
    { tab: "code-todos", label: "Code TODOs", action: "tab-code-todos" },
    { tab: "discussions", label: "Discussions", action: "tab-discussions" },
    { tab: "actions", label: "Actions", action: "tab-actions" },
    { tab: "findings", label: "Findings", action: "tab-findings" },
    { tab: "tags", label: "Tags", action: "tab-tags" },
    { tab: "tasks", label: "Tasks", action: "tab-tasks" },
    { tab: "insights", label: "Insights", action: "tab-insights" },
  ] satisfies SecondaryTab[]
).sort((a, b) => a.label.localeCompare(b.label, "en"));

/** The tabs the menus list (Agent only while AI features are on), each with
 *  its action's effective binding; null = palette-only or unbound. */
export function secondaryTabRows(
  aiEnabled: boolean,
  bindings: ReadonlyMap<ActionId, string | null>,
): (SecondaryTab & { binding: string | null })[] {
  return SECONDARY_TABS.filter((t) => aiEnabled || !t.ai).map((t) => ({
    ...t,
    binding: bindings.get(t.action) ?? null,
  }));
}
