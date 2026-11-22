import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ConfirmDialogHost } from "@/components/confirm-dialog-host";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { TabPanel } from "@/features/repository/TabPanel";
import { CommandPalette } from "@/features/shortcuts/CommandPalette";
import { HotkeyAction } from "@/lib/hotkeys/HotkeyAction";
import {
  registerHandler,
  unregisterHandler,
} from "@/lib/hotkeys/handler-registry";
import {
  dispatchShortcut,
  useHotkeyAction,
  useHotkeysListener,
} from "@/lib/hotkeys/hotkeys";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useConfirm } from "@/lib/stores/confirm";
import { unmockedCommands } from "./setup";

// The real listener, palette, Dialog and ConfirmDialog over the real
// PanelPortalReset, so the modal scope comes from React position as in the app.
// jsdom is not macOS: mod is Ctrl.
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));

let hotkeyOverrides: Record<string, string | null> = {};

beforeEach(() => {
  hotkeyOverrides = {};
  vi.mocked(loadSettings).mockImplementation(async () => ({
    ...structuredClone(DEFAULT_SETTINGS),
    hotkeys: hotkeyOverrides,
  }));
});

afterEach(() => {
  act(() => useConfirm.setState(useConfirm.getInitialState(), true));
});

afterAll(() => expect(unmockedCommands).toEqual([]));

function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function Listener() {
  useHotkeysListener();
  return null;
}

function PageAction({
  id,
  run,
  enabled = true,
}: {
  id: Parameters<typeof useHotkeyAction>[0];
  run: () => void;
  enabled?: boolean;
}) {
  useHotkeyAction(id, run, enabled);
  return null;
}

function TestDialog({
  open,
  onOpenChange,
  title = "Test dialog",
  children,
}: {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  title?: string;
  children?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle className="pr-8">{title}</DialogTitle>
        <DialogDescription>Body</DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function PaletteHost() {
  const [open, setOpen] = useState(false);
  useHotkeyAction("command-palette", () => setOpen(true));
  return <CommandPalette open={open} onOpenChange={setOpen} />;
}

/** Presses `keys` (user-event syntax) at the focused element; whether the
 *  app listener left the main key's keydown default-prevented. */
async function press(keys: string) {
  let prevented: boolean | undefined;
  const spy = (e: KeyboardEvent) => {
    if (e.key !== "Control") prevented = e.defaultPrevented;
  };
  window.addEventListener("keydown", spy);
  try {
    await userEvent.setup().keyboard(keys);
  } finally {
    window.removeEventListener("keydown", spy);
  }
  return prevented;
}
const modEnter = () => press("{Control>}{Enter}{/Control}");
const modK = () => press("{Control>}k{/Control}");

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

const paletteOpen = () => screen.queryByText("Command palette") !== null;

function blurToBody() {
  act(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
}

describe("page shortcuts under an open modal", () => {
  it("M1 a page chord runs nothing from the dialog's Close button and is consumed", async () => {
    const commit = vi.fn();
    render(
      <Providers>
        <Listener />
        <PageAction id="commit" run={commit} />
        <TestDialog open />
      </Providers>,
    );
    const close = await screen.findByRole("button", { name: "Close" });
    act(() => close.focus());
    expect(await modEnter()).toBe(true);
    expect(commit).not.toHaveBeenCalled();
  });

  it("M2a the palette opens nothing over a useConfirm prompt", async () => {
    render(
      <Providers>
        <Listener />
        <PaletteHost />
        <ConfirmDialogHost />
      </Providers>,
    );
    act(() => {
      void useConfirm.getState().ask({
        title: "Discard changes?",
        body: "Gone for good.",
        confirmLabel: "Discard",
        scope: "app",
      });
    });
    await screen.findByText("Discard changes?");
    expect(await modK()).toBe(true);
    await settle();
    expect(paletteOpen()).toBe(false);
    blurToBody();
    await modK();
    await settle();
    expect(paletteOpen()).toBe(false);
  });

  it("M2b the palette opens nothing over a ConfirmDialog rendered directly", async () => {
    render(
      <Providers>
        <Listener />
        <PaletteHost />
        <ConfirmDialog
          open
          onCancel={() => undefined}
          title="Check out commit?"
          body="Detaches HEAD."
          confirmLabel="Check out"
          onConfirm={() => undefined}
        />
      </Providers>,
    );
    await screen.findByText("Check out commit?");
    expect(await modK()).toBe(true);
    await settle();
    expect(paletteOpen()).toBe(false);
  });

  it("M2c a palette pick runs nothing once a prompt opened over the palette", async () => {
    const openSettings = vi.fn();
    render(
      <Providers>
        <Listener />
        <PageAction id="open-settings" run={openSettings} />
        <PaletteHost />
        <ConfirmDialogHost />
      </Providers>,
    );
    await modK();
    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "open settings" } });
    act(() => {
      void useConfirm.getState().ask({
        title: "Discard changes?",
        body: "Gone for good.",
        confirmLabel: "Discard",
        scope: "app",
      });
    });
    await screen.findByText("Discard changes?");
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await settle();
    expect(openSettings).not.toHaveBeenCalled();
  });

  // Control: decide at pick time and dispatch the raw action in the timer;
  // Settings opens over the prompt.
  it("M2d a pick whose deferred dispatch lands after a prompt opened runs nothing", async () => {
    const openSettings = vi.fn();
    render(
      <Providers>
        <Listener />
        <PageAction id="open-settings" run={openSettings} />
        <PaletteHost />
        <ConfirmDialogHost />
      </Providers>,
    );
    await modK();
    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "open settings" } });
    // The pick and the prompt land in one synchronous act, so the prompt is
    // up before the pick's 0-ms deferred dispatch can run.
    act(() => {
      fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
      void useConfirm.getState().ask({
        title: "Discard changes?",
        body: "Gone for good.",
        confirmLabel: "Discard",
        scope: "app",
      });
    });
    expect(screen.getByText("Discard changes?")).toBeInTheDocument();
    expect(openSettings).not.toHaveBeenCalled();
    await settle();
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("M3 a palette pick with no other modal open still runs (its own closing popup does not count)", async () => {
    const openSettings = vi.fn();
    render(
      <Providers>
        <Listener />
        <PageAction id="open-settings" run={openSettings} />
        <PaletteHost />
      </Providers>,
    );
    await modK();
    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "open settings" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(openSettings).toHaveBeenCalledTimes(1));
  });
});

describe("a dialog's own shortcuts", () => {
  it("M5 a registration inside DialogContent answers; a page entry re-registered after it does not", async () => {
    const inner = vi.fn();
    const page = vi.fn();
    const ui = (pageEnabled: boolean) => (
      <Providers>
        <Listener />
        <TestDialog open>
          <HotkeyAction id="commit" run={inner} />
        </TestDialog>
        <PageAction id="commit" run={page} enabled={pageEnabled} />
      </Providers>
    );
    const { rerender } = render(ui(false));
    const close = await screen.findByRole("button", { name: "Close" });
    rerender(ui(true));
    act(() => close.focus());
    expect(await modEnter()).toBe(true);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(page).not.toHaveBeenCalled();
  });

  it("M6 a prompt over a dialog makes the dialog's chord inert until the prompt is gone", async () => {
    const inner = vi.fn();
    const ui = (prompt: boolean) => (
      <Providers>
        <Listener />
        <TestDialog open>
          <HotkeyAction id="commit" run={inner} />
        </TestDialog>
        <ConfirmDialog
          open={prompt}
          onCancel={() => undefined}
          title="Discard changes?"
          body="Gone for good."
          confirmLabel="Discard"
          onConfirm={() => undefined}
        />
      </Providers>
    );
    const { rerender } = render(ui(true));
    await screen.findByText("Discard changes?");
    await modEnter();
    blurToBody();
    await modEnter();
    expect(inner).not.toHaveBeenCalled();
    rerender(ui(false));
    await waitFor(() =>
      expect(screen.queryByText("Discard changes?")).toBeNull(),
    );
    await modEnter();
    expect(inner).toHaveBeenCalledTimes(1);
  });
});

describe("what counts as an open modal", () => {
  it("M7 a dialog left open in a hidden tab panel leaves page shortcuts live", async () => {
    const page = vi.fn();
    const ui = (active: boolean) => (
      <Providers>
        <Listener />
        <PageAction id="commit" run={page} />
        <TabPanel active={active}>
          <TestDialog open title="Panel dialog" />
        </TabPanel>
      </Providers>
    );
    const { rerender } = render(ui(true));
    await screen.findByText("Panel dialog");
    rerender(ui(false));
    await settle();
    expect(
      document.querySelector('[data-slot="dialog-content"][data-open]'),
    ).not.toBeNull();
    blurToBody();
    await modEnter();
    expect(page).toHaveBeenCalledTimes(1);
  });

  it("M7 an open modal content with no scope (drawer-shaped) makes every entry inert", async () => {
    const page = vi.fn();
    render(
      <Providers>
        <Listener />
        <PageAction id="commit" run={page} />
        <div data-slot="drawer-content" data-state="open">
          <button type="button">in drawer</button>
        </div>
      </Providers>,
    );
    const inside = screen.getByRole("button", { name: "in drawer" });
    act(() => inside.focus());
    expect(await modEnter()).toBe(true);
    expect(page).not.toHaveBeenCalled();
  });
});

describe("the consume axis under a modal", () => {
  it("M10 bare Space reaches the dialog's button, an unregistered chord is left alone, Escape closes", async () => {
    hotkeyOverrides = { "toggle-notifications": "space" };
    const user = userEvent.setup();
    const pageSpace = vi.fn();
    const pressed = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <Providers>
        <Listener />
        <PageAction id="toggle-notifications" run={pageSpace} />
        <TestDialog open onOpenChange={onOpenChange}>
          <button type="button" onClick={pressed}>
            Dialog button
          </button>
        </TestDialog>
      </Providers>,
    );
    await waitFor(() => expect(loadSettings).toHaveBeenCalled());
    await settle();
    const button = await screen.findByRole("button", { name: "Dialog button" });
    act(() => button.focus());
    let spacePrevented: boolean | undefined;
    const spy = (e: KeyboardEvent) => {
      if (e.key === " ") spacePrevented = e.defaultPrevented;
    };
    window.addEventListener("keydown", spy);
    try {
      await user.keyboard(" ");
    } finally {
      window.removeEventListener("keydown", spy);
    }
    expect(spacePrevented).toBe(false);
    expect(pressed).toHaveBeenCalledTimes(1);
    expect(pageSpace).not.toHaveBeenCalled();
    // show-branches (mod+b) has no registration here: its native meaning stays.
    expect(await press("{Control>}b{/Control}")).toBe(false);
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  });
});

describe("app zoom is exempt", () => {
  // roadmap-zoom-in has no default binding, so both ids go through
  // dispatchShortcut directly rather than a chord.
  // Every MODAL_EXEMPT id (dispatch-shortcut.ts), each focus placement.
  const ZOOM_IDS = ["app-zoom-in", "app-zoom-out", "app-zoom-reset"] as const;
  it.each(
    ZOOM_IDS.flatMap((id) =>
      (["inside", "blurred"] as const).map((focusAt) => [id, focusAt] as const),
    ),
  )(
    "Z1 %s runs under an open dialog and the roadmap zoom does not, focus %s",
    async (id, focusAt) => {
      const zoom = vi.fn();
      const roadmap = vi.fn();
      // Registered the way src/lib/zoom/zoom.ts registers: a raw literal.
      const zoomEntry = { run: zoom, enabled: true };
      const roadmapEntry = { run: roadmap, enabled: true };
      registerHandler(id, zoomEntry);
      registerHandler("roadmap-zoom-in", roadmapEntry);
      try {
        render(
          <Providers>
            <TestDialog open />
          </Providers>,
        );
        const close = await screen.findByRole("button", { name: "Close" });
        act(() => close.focus());
        if (focusAt === "blurred") blurToBody();
        expect(document.activeElement).toBe(
          focusAt === "inside" ? close : document.body,
        );
        let ranZoom = false;
        let ranRoadmap = true;
        act(() => {
          ranZoom = dispatchShortcut(id);
          ranRoadmap = dispatchShortcut("roadmap-zoom-in");
        });
        expect(ranZoom).toBe(true);
        expect(zoom).toHaveBeenCalledTimes(1);
        expect(ranRoadmap).toBe(false);
        expect(roadmap).not.toHaveBeenCalled();
      } finally {
        unregisterHandler(id, zoomEntry);
        unregisterHandler("roadmap-zoom-in", roadmapEntry);
      }
    },
  );
});
