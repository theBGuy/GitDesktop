import { useId } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useApplyAppearance, useSettings } from "@/lib/settings/queries";
import {
  DEFAULT_ACCENT_HUE,
  DEFAULT_UI_FONT,
  isDefaultAccentAndFont,
  sanitizeAccentHue,
  THEME_LABELS,
  THEME_ORDER,
  type ThemeSetting,
  UI_FONT_LABELS,
  UI_FONT_ORDER,
  type UiFont,
} from "@/lib/theme";

/**
 * Settings → Appearance. Theme, accent hue, and UI font are apply-on-change
 * (not the bulk Save bar), mirroring `diffViewMode`: they persist and apply
 * immediately so picking a value previews it live.
 */
export function AppearanceSection() {
  const settings = useSettings();
  const apply = useApplyAppearance();
  const themeLabelId = useId();
  const hueLabelId = useId();
  const fontLabelId = useId();

  const current = settings.data;
  const theme = current?.theme ?? "system";
  const accentHue = current?.accentHue ?? DEFAULT_ACCENT_HUE;
  const uiFont = current?.uiFont ?? DEFAULT_UI_FONT;
  const atDefault = isDefaultAccentAndFont(accentHue, uiFont);

  function selectTheme(next: ThemeSetting) {
    if (current) apply(current, { theme: next });
  }

  function selectHue(raw: number) {
    if (current) apply(current, { accentHue: sanitizeAccentHue(raw) });
  }

  function selectFont(next: UiFont) {
    if (current) apply(current, { uiFont: next });
  }

  function resetAccentAndFont() {
    if (!current || atDefault) return;
    apply(current, {
      accentHue: DEFAULT_ACCENT_HUE,
      uiFont: DEFAULT_UI_FONT,
    });
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
        <span id={themeLabelId} className="text-xs font-medium">
          Theme
        </span>
        <div className="max-w-xs">
          <Select
            items={THEME_LABELS}
            value={theme}
            onValueChange={(value) => selectTheme(value as ThemeSetting)}
          >
            <SelectTrigger aria-labelledby={themeLabelId} className="w-full">
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
      <div className="space-y-1.5">
        <span id={hueLabelId} className="text-xs font-medium">
          Accent colour
        </span>
        <div className="flex max-w-xs items-center gap-2">
          <span
            className="size-6 shrink-0 border bg-primary"
            aria-hidden="true"
          />
          <input
            type="range"
            min={0}
            max={360}
            step={1}
            value={accentHue}
            aria-labelledby={hueLabelId}
            aria-valuetext={`${accentHue} degrees`}
            className="gd-hue-slider min-w-0 flex-1"
            onChange={(e) => selectHue(Number(e.currentTarget.value))}
          />
          <span className="w-8 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
            {accentHue}°
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Tints buttons, focus rings, and highlights. Light, Dark, and Slate
          keep their own surfaces. Status colours (added, deleted, warning) stay
          put.
        </p>
      </div>
      <div className="space-y-1.5">
        <span id={fontLabelId} className="text-xs font-medium">
          UI font
        </span>
        <div className="max-w-xs">
          <Select
            items={UI_FONT_LABELS}
            value={uiFont}
            onValueChange={(value) => selectFont(value as UiFont)}
          >
            <SelectTrigger aria-labelledby={fontLabelId} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {UI_FONT_ORDER.map((id) => (
                <SelectItem key={id} value={id}>
                  {UI_FONT_LABELS[id]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground">
          Chrome, headings, and body copy. Code, diffs, and the terminal stay on
          JetBrains Mono.
        </p>
      </div>
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={atDefault}
          onClick={resetAccentAndFont}
        >
          Reset accent & font
        </Button>
      </div>
    </section>
  );
}
