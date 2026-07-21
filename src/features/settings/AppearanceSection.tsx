import { useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  settingsKeys,
  useSaveSettings,
  useSettings,
} from "@/lib/settings/queries";
import {
  commitTheme,
  THEME_LABELS,
  THEME_ORDER,
  type ThemeSetting,
} from "@/lib/theme";

/**
 * Settings → Appearance. The theme picker is an apply-on-change preference owned
 * by this control (not the bulk Save bar), mirroring `diffViewMode`: it persists
 * and applies the class immediately, so picking a theme previews it live.
 */
export function AppearanceSection() {
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const queryClient = useQueryClient();
  const labelId = useId();
  const theme = settings.data?.theme ?? "system";

  function selectTheme(next: ThemeSetting) {
    if (!settings.data || next === settings.data.theme) return;
    const updated = { ...settings.data, theme: next };
    // Optimistically patch the settings cache so the controlled <Select> reflects
    // the pick immediately; the mutation's success-invalidate reconciles it.
    // Without this the trigger briefly flickers back to the old value while the
    // store write + refetch complete.
    queryClient.setQueryData(settingsKeys.settings, updated);
    saveSettings.mutate(updated);
    commitTheme(next);
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-medium">Appearance</h2>
        <p className="text-xs text-muted-foreground">
          How GitDesktop looks. Changes apply immediately.
        </p>
      </div>
      <div className="space-y-1.5">
        <span id={labelId} className="text-xs font-medium">
          Theme
        </span>
        <div className="max-w-xs">
          <Select
            items={THEME_LABELS}
            value={theme}
            onValueChange={(value) => selectTheme(value as ThemeSetting)}
          >
            <SelectTrigger aria-labelledby={labelId} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THEME_ORDER.map((id) => (
                <SelectItem key={id} value={id}>
                  {THEME_LABELS[id]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">System</span> follows
          your operating system's light/dark setting.{" "}
          <span className="font-medium text-foreground">Slate</span> is a softer
          dark theme — a lifted, cool blue-gray canvas that eases eye strain on
          long sessions. You can also cycle themes from the command palette.
        </p>
      </div>
    </section>
  );
}
