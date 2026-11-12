import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, describe, expect, it, vi } from "vitest";
import { resolveBody } from "@/features/help/resolve-body";
import { KeyboardSection } from "@/features/settings/KeyboardSection";
import { settingsFormOpts } from "@/features/settings/settings-form";
import { useAppForm } from "@/lib/form";
import { formatBinding } from "@/lib/hotkeys/binding";
import { effectiveBindings } from "@/lib/hotkeys/default-binding";
import { unmockedCommands } from "./setup";

// The Settings keyboard section resolves the draft the way the listener resolves
// saved settings: an override that takes another action's default leaves that
// action unbound, without writing anything for it.
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
  saveSettingsMerged: vi.fn(),
  saveSettingsPatch: vi.fn(),
}));

const OVERRIDE: Record<string, string | null> = {
  "show-branches": "alt+left",
};
const ALT_LEFT = formatBinding("alt+left");

let hotkeys: () => Record<string, string | null>;

function Host() {
  const form = useAppForm({
    ...settingsFormOpts,
    defaultValues: { ...settingsFormOpts.defaultValues, hotkeys: OVERRIDE },
  });
  hotkeys = () => form.state.values.hotkeys;
  return <KeyboardSection form={form} />;
}

const shortcut = (label: string) =>
  screen.getByRole("button", { name: new RegExp(`^Shortcut for ${label}:`) });
const reset = (label: string) =>
  screen.getByRole("button", { name: `Reset ${label} to default` });

afterAll(() => {
  expect(unmockedCommands).toEqual([]);
});

describe("Settings → Keyboard over an override that takes Go back's default", () => {
  it("reads Go back as unbound, with nothing to reset", () => {
    render(<Host />);
    expect(shortcut("Go back")).toHaveAccessibleName(
      "Shortcut for Go back: unbound. Click to change.",
    );
    expect(reset("Go back")).toHaveClass("invisible");
    expect(within(shortcut("Show branches")).getByText(ALT_LEFT)).toBeTruthy();
  });

  it("recording Alt+Left on Go back takes it from Show branches", async () => {
    const user = userEvent.setup();
    render(<Host />);
    await user.click(shortcut("Go back"));
    await user.keyboard("{Alt>}{ArrowLeft}{/Alt}");
    expect(shortcut("Go back")).toHaveAccessibleName(
      `Shortcut for Go back: ${ALT_LEFT}. Click to change.`,
    );
    expect(shortcut("Show branches")).toHaveAccessibleName(
      "Shortcut for Show branches: unbound. Click to change.",
    );
    // Shown, and announced through the section's status region.
    expect(
      screen.getAllByText(
        `${ALT_LEFT} was taken from "Show branches", which is now unbound.`,
      ),
    ).toHaveLength(2);
    // Go back is back on its own default, so it stores nothing.
    expect(hotkeys()).toEqual({ "show-branches": null });
  });

  it("clearing Go back stores an explicit unbound; its reset leaves it yielding", async () => {
    const user = userEvent.setup();
    render(<Host />);
    await user.click(shortcut("Go back"));
    await user.keyboard("{Backspace}");
    expect(hotkeys()).toEqual({ ...OVERRIDE, "go-back": null });
    expect(reset("Go back")).not.toHaveClass("invisible");

    await user.click(reset("Go back"));
    expect(hotkeys()).toEqual(OVERRIDE);
    expect(shortcut("Go back")).toHaveAccessibleName(
      "Shortcut for Go back: unbound. Click to change.",
    );
    expect(reset("Go back")).toHaveClass("invisible");
    expect(shortcut("Show branches")).toHaveAccessibleName(
      `Shortcut for Show branches: ${ALT_LEFT}. Click to change.`,
    );
  });
});

describe("the user guide's Go back token", () => {
  it("reads as unbound while Go back yields its default to another action", () => {
    expect(
      resolveBody("Press {{kbd:go-back}}.", true, effectiveBindings(OVERRIDE)),
    ).toBe("Press unbound.");
    expect(
      resolveBody("Press {{kbd:go-back}}.", true, effectiveBindings({})),
    ).toBe(`Press ${ALT_LEFT}.`);
  });
});
