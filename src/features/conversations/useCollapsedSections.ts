import { useSaveSettings, useSettings } from "@/lib/settings/queries";

/** The conversation panel a collapse key belongs to. The remote key is
 *  feature-scoped, not provider-scoped, so collapsing the remote section in a
 *  GitHub repo also collapses it in a GitLab repo (intended — the preference is
 *  global). */
export type ConversationFeature = "pulls" | "issues";
type SectionKind = "local" | "remote";
/** The remote section's review-state subsections, when the PR list groups by the
 *  viewer's review. Keys nest under the remote one (`"pulls:remote:reviewed"`),
 *  so they can't collide with the two top-level keys. */
export type ReviewGroupKind = "not-reviewed" | "updated" | "reviewed";

/**
 * Global, persisted collapse state for the sections of a conversation list panel:
 * "Local", the remote provider section, and the remote section's review-state
 * subsections. Keyed `"<feature>:<kind>"` (e.g. `"pulls:local"`), stored as a flat
 * string array so a missing key = the section is expanded (the default). Both the
 * shell (which unmounts a collapsed section body) and the caller (which drops a
 * collapsed section's rows from the arrow-key registry) read the same state, so a
 * collapsed section can never hold a selectable-but-invisible row.
 */
export function useCollapsedSections(feature: ConversationFeature) {
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const collapsed = settings.data?.collapsedConversationSections ?? [];

  const key = (kind: SectionKind) => `${feature}:${kind}`;
  const isCollapsed = (kind: SectionKind) => collapsed.includes(key(kind));
  const groupKey = (kind: ReviewGroupKind) => `${feature}:remote:${kind}`;

  function toggleKey(k: string) {
    if (!settings.data) return;
    const next = collapsed.includes(k)
      ? collapsed.filter((c) => c !== k)
      : [...collapsed, k];
    saveSettings.mutate({
      ...settings.data,
      collapsedConversationSections: next,
    });
  }

  return {
    localCollapsed: isCollapsed("local"),
    remoteCollapsed: isCollapsed("remote"),
    toggleLocal: () => toggleKey(key("local")),
    toggleRemote: () => toggleKey(key("remote")),
    isReviewGroupCollapsed: (kind: ReviewGroupKind) =>
      collapsed.includes(groupKey(kind)),
    toggleReviewGroup: (kind: ReviewGroupKind) => toggleKey(groupKey(kind)),
  };
}
