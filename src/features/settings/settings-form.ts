import { formOptions } from "@tanstack/react-form";
import { type AppSettings, DEFAULT_SETTINGS } from "@/lib/settings/api";

/**
 * The slice of AppSettings edited on the settings screen. Drafted in a
 * TanStack form and written once via the Save bar; recents and diff view
 * mode are app state owned by other surfaces.
 */
export type SettingsDraft = Omit<
  AppSettings,
  "recentRepos" | "diffViewMode" | "defaultBranch" | "theme"
>;

export function toDraft(settings: AppSettings): SettingsDraft {
  // defaultBranch is dropped: it now lives in global git config, edited by its
  // own form in GitSection, not the bulk Save bar. theme + diffViewMode are
  // apply-on-change prefs owned by their own controls, not the bulk Save bar.
  const { recentRepos, diffViewMode, defaultBranch, theme, ...draft } =
    settings;
  return draft;
}

/**
 * Shared options so the section components (built with `withForm`) and the
 * screen's `useAppForm` agree on the form's shape. The real values are
 * seeded from the settings store once it loads.
 */
export const settingsFormOpts = formOptions({
  defaultValues: toDraft(DEFAULT_SETTINGS),
});
