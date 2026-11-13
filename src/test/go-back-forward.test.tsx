import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { GUIDE_SECTIONS } from "@/features/help/content";
import {
  useAvailableActions,
  useEffectiveBindings,
  useHotkeyAction,
  useHotkeysListener,
} from "@/lib/hotkeys/hotkeys";
import { useNavHistoryActions } from "@/lib/hotkeys/nav-history-actions";
import { ACTIONS } from "@/lib/hotkeys/registry";
import {
  navigateBySideButton,
  useSideButtonNavigation,
  vetoSideButtonNavigation,
} from "@/lib/hotkeys/side-buttons";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { __resetNavHistoryForTests } from "@/lib/stores/nav-history";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

// The shipped registrations and side-button listener, mounted the way App mounts
// them, behind the real window keydown listener. The settings read is the seam;
// jsdom is not macOS, so the defaults are alt+left / alt+right.
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));

const REPO = "C:/repos/alpha";
const st = () => useUiStore.getState();

const showBranches = vi.fn();

function Host({
  dialogOpen = false,
  withShowBranches = false,
}: {
  dialogOpen?: boolean;
  withShowBranches?: boolean;
}) {
  useHotkeysListener();
  useNavHistoryActions(dialogOpen);
  useSideButtonNavigation();
  const available = useAvailableActions();
  const navRows = (["go-back", "go-forward"] as const).filter((id) =>
    available.has(id),
  );
  const goBackKey = useEffectiveBindings().get("go-back");
  return (
    <>
      <input aria-label="field" />
      <output>{goBackKey === null ? "unbound" : goBackKey}</output>
      <span data-testid="palette">{navRows.join(",")}</span>
      {withShowBranches ? <ShowBranches /> : null}
    </>
  );
}

function ShowBranches() {
  useHotkeyAction("show-branches", showBranches);
  return null;
}

/** A Base UI-shaped open modal holding a focusable button. */
function OpenModal() {
  return (
    <div data-slot="dialog-content" data-open="">
      <button type="button">inside</button>
    </div>
  );
}

function renderHost(
  props: { dialogOpen?: boolean; withShowBranches?: boolean } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = (p: typeof props) => (
    <QueryClientProvider client={client}>
      <Host {...p} />
    </QueryClientProvider>
  );
  const result = render(ui(props));
  return {
    ...result,
    rerenderHost: (p: typeof props) => result.rerender(ui(p)),
  };
}

/** Repo open on Changes, then History: one step back, none forward. */
function enterRepoWithBack() {
  act(() => {
    st().openRepo({ root: REPO, name: "alpha" });
    st().setRepoTab("history");
  });
  expect(st().repoTab).toBe("history");
}

function press(
  key: "ArrowLeft" | "ArrowRight",
  target: EventTarget = window,
  init: KeyboardEventInit = {},
) {
  const event = new KeyboardEvent("keydown", {
    key,
    code: key,
    altKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function mouse(
  type: "mousedown" | "mouseup",
  button: number,
  target: EventTarget = document.body,
) {
  const event = new MouseEvent(type, {
    button,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

/** A full side-button press; both edges returned. */
function click(button: number, target: EventTarget = document.body) {
  return [mouse("mousedown", button, target), mouse("mouseup", button, target)];
}

const extraListeners: [string, EventListener, boolean][] = [];
function addWindowListener(type: string, fn: EventListener, capture = false) {
  extraListeners.push([type, fn, capture]);
  window.addEventListener(type, fn, capture);
}

function resetStore() {
  useUiStore.setState(useUiStore.getInitialState(), true);
  __resetNavHistoryForTests();
}

beforeEach(() => {
  resetStore();
  showBranches.mockReset();
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
});

afterEach(() => {
  for (const [type, fn, capture] of extraListeners.splice(0))
    window.removeEventListener(type, fn, capture);
  // Runs before RTL's cleanup unmounts the host, which re-renders on the reset.
  act(resetStore);
});

afterAll(() => expect(unmockedCommands).toEqual([]));

describe("Go back / Go forward keys", () => {
  it("Alt+Left steps back and Alt+Right steps forward again", async () => {
    const { findByText } = renderHost();
    await findByText("alt+left");
    enterRepoWithBack();
    const back = press("ArrowLeft");
    expect(back.defaultPrevented).toBe(true);
    expect(st().repoTab).toBe("changes");
    const fwd = press("ArrowRight");
    expect(fwd.defaultPrevented).toBe(true);
    expect(st().repoTab).toBe("history");
  });

  it("an empty direction is consumed and changes nothing", async () => {
    const { findByText } = renderHost();
    await findByText("alt+left");
    act(() => st().openRepo({ root: REPO, name: "alpha" }));
    const before = st();
    const back = press("ArrowLeft");
    const fwd = press("ArrowRight");
    expect(back.defaultPrevented).toBe(true);
    expect(fwd.defaultPrevented).toBe(true);
    expect(st().repoTab).toBe(before.repoTab);
    expect(st().interactionEpoch).toBe(before.interactionEpoch);
    expect(st().navHistory).toBe(before.navHistory);
  });

  it("outside the repo view the chord is consumed and nothing runs", async () => {
    const { findByText } = renderHost();
    await findByText("alt+left");
    expect(st().view).not.toBe("repo");
    const before = st();
    expect(press("ArrowLeft").defaultPrevented).toBe(true);
    expect(st()).toBe(before);
  });

  it("an open App dialog consumes the chord without stepping", async () => {
    const { findByText } = renderHost({ dialogOpen: true });
    await findByText("alt+left");
    enterRepoWithBack();
    expect(press("ArrowLeft").defaultPrevented).toBe(true);
    expect(st().repoTab).toBe("history");
  });

  it("focus inside an open modal stands both directions down", async () => {
    const { findByText, getByTestId } = renderHost();
    await findByText("alt+left");
    enterRepoWithBack();
    act(() => st().setRepoTab("compare"));
    act(() => st().goBack());
    // Both directions can run now; only focus decides.
    expect(getByTestId("palette")).toHaveTextContent("go-back,go-forward");
    const modal = render(<OpenModal />);
    const inside = modal.getByRole("button", { name: "inside" });
    inside.focus();
    expect(press("ArrowLeft", inside).defaultPrevented).toBe(true);
    expect(st().repoTab).toBe("history");
    expect(press("ArrowRight", inside).defaultPrevented).toBe(true);
    expect(st().repoTab).toBe("history");
    modal.unmount();
    press("ArrowLeft");
    expect(st().repoTab).toBe("changes");
  });

  it("the palette lists each direction only while it can run", async () => {
    const { findByText, getByTestId, rerenderHost } = renderHost();
    await findByText("alt+left");
    const palette = () => getByTestId("palette").textContent;
    expect(palette()).toBe("");
    enterRepoWithBack();
    expect(palette()).toBe("go-back");
    act(() => st().goBack());
    expect(palette()).toBe("go-forward");
    rerenderHost({ dialogOpen: true });
    expect(palette()).toBe("");
  });
});

describe("text fields and repeats", () => {
  it("Alt+Left fires from a focused text field", async () => {
    const { findByText, getByLabelText } = renderHost();
    await findByText("alt+left");
    enterRepoWithBack();
    const field = getByLabelText("field");
    field.focus();
    expect(press("ArrowLeft", field).defaultPrevented).toBe(true);
    expect(st().repoTab).toBe("changes");
  });

  it("a held key steps once: repeats are neither dispatched nor consumed", async () => {
    const { findByText } = renderHost();
    await findByText("alt+left");
    enterRepoWithBack();
    act(() => st().setRepoTab("compare"));
    press("ArrowLeft");
    expect(st().repoTab).toBe("history");
    const repeat = press("ArrowLeft", window, { repeat: true });
    expect(repeat.defaultPrevented).toBe(false);
    expect(st().repoTab).toBe("history");
  });
});

describe("another action's override on the chord, at the listener", () => {
  it("Alt+Left runs the override's action and never Go back", async () => {
    vi.mocked(loadSettings).mockImplementation(async () => ({
      ...structuredClone(DEFAULT_SETTINGS),
      hotkeys: { "show-branches": "alt+left" },
    }));
    const { findByText } = renderHost({ withShowBranches: true });
    await findByText("unbound");
    enterRepoWithBack();
    expect(press("ArrowLeft").defaultPrevented).toBe(true);
    expect(showBranches).toHaveBeenCalledTimes(1);
    expect(st().repoTab).toBe("history");
  });
});

describe("mouse side buttons", () => {
  it("button 3 steps back on release and button 4 steps forward", async () => {
    const { findByText } = renderHost();
    await findByText("alt+left");
    enterRepoWithBack();
    mouse("mousedown", 3);
    expect(st().repoTab).toBe("history");
    mouse("mouseup", 3);
    expect(st().repoTab).toBe("changes");
    click(4);
    expect(st().repoTab).toBe("history");
  });

  it("both edges are prevented even with an empty history outside the repo view", async () => {
    const { findByText } = renderHost();
    await findByText("alt+left");
    expect(st().view).not.toBe("repo");
    for (const button of [3, 4]) {
      const [down, up] = click(button);
      expect(down.defaultPrevented).toBe(true);
      expect(up.defaultPrevented).toBe(true);
    }
    act(() => st().openRepo({ root: REPO, name: "alpha" }));
    const before = st();
    for (const button of [3, 4]) {
      const [down, up] = click(button);
      expect(down.defaultPrevented).toBe(true);
      expect(up.defaultPrevented).toBe(true);
    }
    expect(st().interactionEpoch).toBe(before.interactionEpoch);
    expect(st().navHistory).toBe(before.navHistory);
  });

  it("buttons 0 to 2 are left alone", async () => {
    const { findByText } = renderHost();
    await findByText("alt+left");
    enterRepoWithBack();
    for (const button of [0, 1, 2]) {
      const [down, up] = click(button);
      expect(down.defaultPrevented).toBe(false);
      expect(up.defaultPrevented).toBe(false);
    }
    expect(st().repoTab).toBe("history");
  });

  it("a release with no press before it still navigates", async () => {
    const { findByText } = renderHost();
    await findByText("alt+left");
    enterRepoWithBack();
    expect(mouse("mouseup", 3).defaultPrevented).toBe(true);
    expect(st().repoTab).toBe("changes");
  });

  it("an App dialog and a focused modal stand the buttons down", async () => {
    const { findByText, rerenderHost } = renderHost({ dialogOpen: true });
    await findByText("alt+left");
    enterRepoWithBack();
    click(3);
    expect(st().repoTab).toBe("history");
    rerenderHost({ dialogOpen: false });
    const modal = render(<OpenModal />);
    const inside = modal.getByRole("button", { name: "inside" });
    inside.focus();
    const [down, up] = click(3, inside);
    expect(down.defaultPrevented).toBe(true);
    expect(up.defaultPrevented).toBe(true);
    expect(st().repoTab).toBe("history");
    modal.unmount();
    click(3);
    expect(st().repoTab).toBe("changes");
  });

  it("navigateBySideButton runs the same dispatch and ignores other buttons", async () => {
    const { findByText } = renderHost();
    await findByText("alt+left");
    enterRepoWithBack();
    let ran = false;
    act(() => {
      ran = navigateBySideButton(1);
    });
    expect(ran).toBe(false);
    act(() => {
      ran = navigateBySideButton(3);
    });
    expect(ran).toBe(true);
    expect(st().repoTab).toBe("changes");
    act(() => {
      ran = navigateBySideButton(3);
    });
    expect(ran).toBe(false);
  });
});

describe("vetoed side-button presses", () => {
  it("a press a surface vetoes after the window listener does not navigate; the next one does", async () => {
    const { findByText } = renderHost();
    await findByText("alt+left");
    enterRepoWithBack();
    const surface = document.createElement("div");
    document.body.append(surface);
    const veto = (e: Event) => vetoSideButtonNavigation(e as MouseEvent);
    surface.addEventListener("mousedown", veto);
    try {
      const [down, up] = click(3, surface);
      expect(down.defaultPrevented).toBe(true);
      expect(up.defaultPrevented).toBe(true);
      expect(st().repoTab).toBe("history");
      surface.removeEventListener("mousedown", veto);
      click(3, surface);
      expect(st().repoTab).toBe("changes");
    } finally {
      surface.remove();
    }
  });

  it("a veto from a capture listener that runs first holds as well", async () => {
    let vetoNext = true;
    addWindowListener(
      "mousedown",
      (e) => {
        if (vetoNext) vetoSideButtonNavigation(e as MouseEvent);
      },
      true,
    );
    const { findByText } = renderHost();
    await findByText("alt+left");
    enterRepoWithBack();
    click(3);
    expect(st().repoTab).toBe("history");
    vetoNext = false;
    click(3);
    expect(st().repoTab).toBe("changes");
  });

  it("a vetoed press whose release never came does not poison the next press", async () => {
    const { findByText } = renderHost();
    await findByText("alt+left");
    enterRepoWithBack();
    addWindowListener(
      "mousedown",
      (e) => vetoSideButtonNavigation(e as MouseEvent),
      false,
    );
    mouse("mousedown", 3);
    for (const [type, fn, capture] of extraListeners.splice(0))
      window.removeEventListener(type, fn, capture);
    click(3);
    expect(st().repoTab).toBe("changes");
  });

  it("a primary-button press is not prevented and vetoes no side-button release", async () => {
    const { findByText } = renderHost();
    await findByText("alt+left");
    enterRepoWithBack();
    addWindowListener(
      "mousedown",
      (e) => vetoSideButtonNavigation(e as MouseEvent),
      false,
    );
    const [down] = click(0);
    expect(down.defaultPrevented).toBe(false);
    for (const [type, fn, capture] of extraListeners.splice(0))
      window.removeEventListener(type, fn, capture);
    mouse("mouseup", 3);
    expect(st().repoTab).toBe("changes");
  });
});

describe("the help guide's shortcut tokens", () => {
  it("names a current action in every kbd token", () => {
    const actionIds = new Set<string>(ACTIONS.map((a) => a.id));
    const used = new Set<string>();
    for (const section of GUIDE_SECTIONS)
      for (const [, id] of section.body.matchAll(/\{\{kbd:([^}]*)\}\}/g))
        used.add(id);
    expect(used.has("go-back")).toBe(true);
    expect(used.has("go-forward")).toBe(true);
    expect([...used].filter((id) => !actionIds.has(id))).toEqual([]);
  });
});
