import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eventToBinding, isImeKeydown } from "@/lib/hotkeys/binding";
import { useHotkeyAction, useHotkeysListener } from "@/lib/hotkeys/hotkeys";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { unmockedCommands } from "./setup";

// The settings read is the seam: with no overrides command-palette keeps its
// registry default, mod+k, and next-conflict keeps bare F7.
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));

// The modifier flags of user-event's own Control chord, so the platform
// modifier is never spelled here.
const mod: KeyboardEventInit = {};
beforeAll(async () => {
  let chord: KeyboardEvent | undefined;
  const record = (e: KeyboardEvent) => {
    if (e.key === "k") chord = e;
  };
  window.addEventListener("keydown", record);
  await userEvent.setup().keyboard("{Control>}k{/Control}");
  window.removeEventListener("keydown", record);
  if (chord === undefined) throw new Error("no chord recorded");
  for (const flag of Object.getOwnPropertyNames(KeyboardEvent.prototype))
    if (flag.endsWith("Key"))
      Object.assign(mod, { [flag]: chord[flag as keyof KeyboardEvent] });
});

beforeEach(() => {
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
});

afterAll(() => expect(unmockedCommands).toEqual([]));

type Init = KeyboardEventInit & { keyCode?: number };

const domKey = (init: Init) =>
  new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });

/** The React synthetic event a keydown on a rendered element produces. */
function reactKey(init: Init): React.KeyboardEvent {
  let seen: React.KeyboardEvent | undefined;
  const { unmount } = render(
    <div
      data-testid="probe"
      onKeyDown={(e) => {
        e.persist();
        seen = e;
      }}
    />,
  );
  fireEvent.keyDown(screen.getByTestId("probe"), init);
  unmount();
  if (seen === undefined) throw new Error("no synthetic keydown");
  return seen;
}

const SHAPES: [string, (init: Init) => KeyboardEvent | React.KeyboardEvent][] =
  [
    ["a DOM event", domKey],
    ["a React synthetic event", reactKey],
  ];

describe("isImeKeydown", () => {
  describe.each(SHAPES)("on %s", (_, make) => {
    it.each([
      ["composing", { isComposing: true, keyCode: 13 }, true],
      ["keyCode 229 after the composition ended", { keyCode: 229 }, true],
      ["composing with keyCode 229", { isComposing: true, keyCode: 229 }, true],
      ["neither signal", { keyCode: 13 }, false],
    ] as const)("%s", (_case, init, expected) => {
      expect(isImeKeydown(make({ key: "Enter", ...init }))).toBe(expected);
    });
  });
});

describe("eventToBinding reads no chord from an input-method key", () => {
  it("a composing Ctrl+Enter", () => {
    expect(
      eventToBinding(domKey({ key: "Enter", ...mod, isComposing: true })),
    ).toBeNull();
  });

  // WebKit's shape: the composition already ended, keyCode still 229.
  it("a keyCode-229 Ctrl+K that is no longer composing", () => {
    const e = domKey({ key: "k", ...mod, keyCode: 229 });
    expect(e.isComposing).toBe(false);
    expect(eventToBinding(e)).toBeNull();
  });

  it("a React synthetic event whose native event is composing", () => {
    expect(
      eventToBinding(reactKey({ key: "Enter", ...mod, isComposing: true })),
    ).toBeNull();
  });

  // Positive controls: the same keys outside a composition are chords.
  it("the same keys outside a composition", () => {
    expect(eventToBinding(domKey({ key: "Enter", ...mod }))).toBe("mod+enter");
    expect(eventToBinding(domKey({ key: "k", ...mod }))).toBe("mod+k");
    expect(eventToBinding(reactKey({ key: "Enter", ...mod }))).toBe(
      "mod+enter",
    );
  });
});

const openPalette = vi.fn();
const nextConflict = vi.fn();

function Host() {
  useHotkeysListener();
  useHotkeyAction("command-palette", openPalette);
  useHotkeyAction("next-conflict", nextConflict);
  return null;
}

function renderHost() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Host />
    </QueryClientProvider>,
  );
}

function press(init: Init) {
  const event = domKey(init);
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

describe("the app listener leaves input-method keys to the input method", () => {
  it("a composing Ctrl+K runs nothing and keeps its default", () => {
    renderHost();
    const event = press({ key: "k", code: "KeyK", ...mod, isComposing: true });
    expect(event.defaultPrevented).toBe(false);
    expect(openPalette).not.toHaveBeenCalled();
  });

  it("a keyCode-229 Ctrl+K runs nothing and keeps its default", () => {
    renderHost();
    const event = press({ key: "k", code: "KeyK", ...mod, keyCode: 229 });
    expect(event.defaultPrevented).toBe(false);
    expect(openPalette).not.toHaveBeenCalled();
  });

  // The F7 guard sits below the input-method return, so only that return
  // keeps a composing F7's default.
  it.each([
    ["composing", { isComposing: true }],
    ["keyCode 229", { keyCode: 229 }],
  ] as const)("a %s bare F7 keeps its default", (_, init) => {
    renderHost();
    const event = press({ key: "F7", code: "F7", ...init });
    expect(event.defaultPrevented).toBe(false);
    expect(nextConflict).not.toHaveBeenCalled();
  });

  // Positive controls: the same keys outside a composition.
  it("a plain bare F7 is consumed and a plain Ctrl+K runs the action", () => {
    renderHost();
    expect(press({ key: "F7", code: "F7" }).defaultPrevented).toBe(true);
    expect(nextConflict).toHaveBeenCalledTimes(1);
    const chord = press({ key: "k", code: "KeyK", ...mod });
    expect(chord.defaultPrevented).toBe(true);
    expect(openPalette).toHaveBeenCalledTimes(1);
  });
});
