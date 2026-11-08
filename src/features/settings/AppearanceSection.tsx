import { MinusIcon, PlusIcon } from "@phosphor-icons/react";
import { Fragment, useId } from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group";
import { Kbd } from "@/components/ui/kbd";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatBinding } from "@/lib/hotkeys/binding";
import { useEffectiveBindings } from "@/lib/hotkeys/hotkeys";
import { useApplyTheme, useSettings } from "@/lib/settings/queries";
import { THEME_LABELS, THEME_ORDER, type ThemeSetting } from "@/lib/theme";
import {
  formatZoom,
  ZOOM_DEFAULT,
  ZOOM_HARD_MAX,
  ZOOM_MIN,
} from "@/lib/zoom/steps";
import { useZoom } from "@/lib/zoom/use-zoom";
import { resetZoom, stepZoom } from "@/lib/zoom/zoom";

// The buttons sit in plain wrapper spans, so ButtonGroup's data-slot border
// collapse never engages: each child after the first overlaps its neighbour's
// border instead, and the focused one rises so its ring stays on top.
const GROUP_FOLLOWER = "relative -ml-px focus-within:z-10";

/**
 * Settings → Appearance. The theme picker is an apply-on-change preference owned
 * by this control (not the bulk Save bar), mirroring `diffViewMode`: it persists
 * and applies the class immediately, so picking a theme previews it live.
 */
export function AppearanceSection() {
  const settings = useSettings();
  const applyTheme = useApplyTheme();
  const labelId = useId();
  const theme = settings.data?.theme ?? "system";

  function selectTheme(next: ThemeSetting) {
    if (settings.data) applyTheme(settings.data, next);
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
      <InterfaceZoomRow />
    </section>
  );
}

/**
 * Apply-on-change like the theme: it drives the zoom controller with the
 * "settings" source, which shows no zoom toast, and renders the APPLIED level
 * alone (a saved level the display can't fit reads as its clamped value).
 */
function InterfaceZoomRow() {
  const { level, max } = useZoom();
  const labelId = useId();
  const atMin = level <= ZOOM_MIN;
  const atMax = level >= max;
  const atDefault = level === ZOOM_DEFAULT;
  const maxReason =
    max < ZOOM_HARD_MAX
      ? "Maximum zoom for this display"
      : `Maximum zoom (${formatZoom(ZOOM_HARD_MAX)})`;

  return (
    <div className="space-y-1.5">
      <span id={labelId} className="text-xs font-medium">
        Interface zoom
      </span>
      <div className="flex items-center gap-2">
        <ButtonGroup aria-labelledby={labelId}>
          <DisabledReasonButton
            variant="outline"
            size="icon"
            aria-label="Zoom out"
            wrapperClassName="relative focus-within:z-10"
            disabled={atMin}
            reason={`Minimum zoom (${formatZoom(ZOOM_MIN)})`}
            onClick={() => stepZoom(-1, "settings")}
          >
            <MinusIcon />
          </DisabledReasonButton>
          <ButtonGroupText
            role="status"
            className={`${GROUP_FOLLOWER} min-w-16 justify-center tabular-nums`}
          >
            <span className="sr-only">Zoom </span>
            {formatZoom(level)}
          </ButtonGroupText>
          <DisabledReasonButton
            variant="outline"
            size="icon"
            aria-label="Zoom in"
            wrapperClassName={GROUP_FOLLOWER}
            disabled={atMax}
            reason={maxReason}
            onClick={() => stepZoom(1, "settings")}
          >
            <PlusIcon />
          </DisabledReasonButton>
        </ButtonGroup>
        <DisabledReasonButton
          variant="outline"
          aria-label="Reset zoom"
          disabled={atDefault}
          reason={`Already at ${formatZoom(ZOOM_DEFAULT)}`}
          onClick={() => resetZoom("settings")}
        >
          Reset
        </DisabledReasonButton>
      </div>
      <ZoomHint />
    </div>
  );
}

/** One Kbd per whole chord, so a line can break only between chords; an
 *  unbound action's chord drops out of the sentence. */
function ZoomHint() {
  const bindings = useEffectiveBindings();
  const steps = (["app-zoom-in", "app-zoom-out"] as const).flatMap((id) => {
    const binding = bindings.get(id);
    return binding ? [{ id, binding }] : [];
  });
  const reset = bindings.get("app-zoom-reset");
  const scroll = (
    <span className="whitespace-nowrap">{formatBinding("mod")}+scroll</span>
  );

  return (
    <p className="text-xs text-muted-foreground">
      Scales the whole app, diffs included.{" "}
      {steps.length > 0 ? (
        <>
          {steps.map(({ id, binding }, i) => (
            <Fragment key={id}>
              {i > 0 ? " / " : null}
              <Kbd>{formatBinding(binding)}</Kbd>
            </Fragment>
          ))}{" "}
          or {scroll}
        </>
      ) : (
        <>{scroll} zooms</>
      )}
      {reset ? (
        <>
          ; <Kbd>{formatBinding(reset)}</Kbd> resets.
        </>
      ) : (
        "."
      )}
    </p>
  );
}
