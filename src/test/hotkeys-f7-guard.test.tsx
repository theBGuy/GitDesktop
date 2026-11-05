import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  useEffectiveBindings,
  useHotkeyAction,
  useHotkeysListener,
} from "@/lib/hotkeys/hotkeys";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { unmockedCommands } from "./setup";

// The settings read is the seam: with no hotkey overrides every action keeps
// its registry default, so next-conflict is bare F7.
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));

const nextConflict = vi.fn();

/** The app listener plus next-conflict's handler only, so shift+F7 (bound to
 *  previous-conflict) has no live handler and the listener leaves it alone. */
function Host() {
  useHotkeysListener();
  useHotkeyAction("next-conflict", nextConflict);
  return <input aria-label="field" />;
}

/** The app listener alone: no action has a live handler. */
function ListenerOnlyHost() {
  useHotkeysListener();
  return null;
}

/** next-conflict's handler, showing its effective binding so a case can wait
 *  for a settings override to land. */
function BindingHost() {
  useHotkeysListener();
  useHotkeyAction("next-conflict", nextConflict);
  const binding = useEffectiveBindings().get("next-conflict");
  return <output>{binding === null ? "unbound" : binding}</output>;
}

function renderHost(host: ReactNode = <Host />) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{host}</QueryClientProvider>,
  );
}

function pressF7(target: EventTarget, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "F7",
    code: "F7",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

// Listeners a case adds to window; removed after each case.
const extraListeners: ((e: KeyboardEvent) => void)[] = [];
function addWindowListener(fn: (e: KeyboardEvent) => void) {
  extraListeners.push(fn);
  window.addEventListener("keydown", fn);
}

beforeEach(() => {
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
});

afterEach(() => {
  for (const fn of extraListeners.splice(0))
    window.removeEventListener("keydown", fn);
});

afterAll(() => expect(unmockedCommands).toEqual([]));

describe("app-wide bare-F7 guard", () => {
  // The guard consumes bare F7, and dispatch below it still runs.
  it("bare F7 is consumed and still dispatches", () => {
    renderHost();
    const event = pressF7(window);
    expect(event.defaultPrevented).toBe(true);
    expect(nextConflict).toHaveBeenCalledTimes(1);
  });

  // The guard sits ahead of the consumed/repeat return: dispatch alone never
  // sees a repeat, so only the guard can consume it.
  it("a repeated bare F7 is consumed without dispatching", () => {
    renderHost();
    const event = pressF7(window, { repeat: true });
    expect(event.defaultPrevented).toBe(true);
    expect(nextConflict).not.toHaveBeenCalled();
  });

  // The guard precedes the editable-target return. firesInEditable("f7") is
  // false (binding.ts: a modifier-less binding never fires in a text field), so
  // the press is consumed without dispatching.
  it("bare F7 in a text field is consumed without dispatching", () => {
    const { getByLabelText } = renderHost();
    const input = getByLabelText("field");
    input.focus();
    const event = pressF7(input);
    expect(event.defaultPrevented).toBe(true);
    expect(nextConflict).not.toHaveBeenCalled();
  });

  // The consumed/repeat return reads the flag captured before the guard, so an
  // earlier handler's preventDefault still skips dispatch. Registered before
  // render: same-target listeners run in registration order, and the app's is
  // added in a mount effect.
  it("an F7 an earlier handler consumed never dispatches", () => {
    addWindowListener((e) => e.preventDefault());
    renderHost();
    const event = pressF7(window);
    expect(event.defaultPrevented).toBe(true);
    expect(nextConflict).not.toHaveBeenCalled();
  });

  // Each modifier term of the guard: a chord is not bare F7, and with no live
  // handler bound to it the listener leaves it alone. The recorder is added
  // after render, so it reads the event after the app's listener ran.
  it.each(["Control", "Alt", "Meta", "Shift"])(
    "F7 with %s held is left alone",
    async (modifier) => {
      renderHost();
      const seen: KeyboardEvent[] = [];
      addWindowListener((e) => {
        if (e.key === "F7") seen.push(e);
      });
      const user = userEvent.setup();
      await user.keyboard(`{${modifier}>}{F7}{/${modifier}}`);
      expect(seen).toHaveLength(1);
      expect(seen[0].defaultPrevented).toBe(false);
      expect(nextConflict).not.toHaveBeenCalled();
    },
  );

  // The guard matches F7 alone: another unbound function key keeps its default.
  it("a bare F8 is left alone", () => {
    renderHost();
    const event = pressF7(window, { key: "F8", code: "F8" });
    expect(event.defaultPrevented).toBe(false);
    expect(nextConflict).not.toHaveBeenCalled();
  });

  it("a character typed in a text field keeps its default", async () => {
    const { getByLabelText } = renderHost();
    const seen: KeyboardEvent[] = [];
    addWindowListener((e) => {
      if (e.key === "a") seen.push(e);
    });
    const user = userEvent.setup();
    await user.type(getByLabelText("field"), "a");
    expect(seen).toHaveLength(1);
    expect(seen[0].defaultPrevented).toBe(false);
    expect(getByLabelText("field")).toHaveValue("a");
  });

  // No action owns F7 here, so only the guard can consume it.
  it("bare F7 is consumed with no live handler", () => {
    renderHost(<ListenerOnlyHost />);
    const event = pressF7(window);
    expect(event.defaultPrevented).toBe(true);
  });

  // The guard keys on the key itself, never on what F7 is bound to.
  it("bare F7 is consumed after next-conflict is unbound from it", async () => {
    vi.mocked(loadSettings).mockImplementation(async () => ({
      ...structuredClone(DEFAULT_SETTINGS),
      hotkeys: { "next-conflict": null, "previous-conflict": null },
    }));
    const { findByText } = renderHost(<BindingHost />);
    await findByText("unbound");
    const event = pressF7(window);
    expect(event.defaultPrevented).toBe(true);
    expect(nextConflict).not.toHaveBeenCalled();
  });

  // The guard cuts off no window listener registered after the app's.
  it("bare F7 still reaches a later window listener", () => {
    renderHost();
    const later = vi.fn();
    addWindowListener(later);
    const event = pressF7(document.body);
    expect(event.defaultPrevented).toBe(true);
    expect(later).toHaveBeenCalledTimes(1);
  });
});
