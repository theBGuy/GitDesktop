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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { CommandPalette } from "@/features/shortcuts/CommandPalette";
import { formatBinding } from "@/lib/hotkeys/binding";
import { dispatchShortcut } from "@/lib/hotkeys/dispatch-shortcut";
import { HotkeyAction } from "@/lib/hotkeys/HotkeyAction";
import {
  registerHandler,
  unregisterHandler,
} from "@/lib/hotkeys/handler-registry";
import { useHotkeyAction, useHotkeysListener } from "@/lib/hotkeys/hotkeys";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(loadSettings).mockResolvedValue(structuredClone(DEFAULT_SETTINGS));
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

describe("a drawer over a scoped dialog", () => {
  it("leaves the dialog's own action inert while app zoom still runs", async () => {
    const commit = vi.fn();
    const zoom = vi.fn();
    const zoomEntry = { run: zoom, enabled: true };
    registerHandler("app-zoom-in", zoomEntry);
    const ui = (drawer: boolean) => (
      <Providers>
        <Dialog open>
          <DialogContent>
            <DialogTitle>Scoped</DialogTitle>
            <DialogDescription>Body</DialogDescription>
            <HotkeyAction id="commit" run={commit} />
          </DialogContent>
        </Dialog>
        {drawer && <div data-slot="drawer-content" data-state="open" />}
      </Providers>
    );
    const view = render(ui(false));
    await screen.findByRole("dialog");
    expect(dispatchShortcut("commit")).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);

    view.rerender(ui(true));
    expect(dispatchShortcut("commit")).toBe(false);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(dispatchShortcut("app-zoom-in")).toBe(true);
    expect(zoom).toHaveBeenCalledTimes(1);
    unregisterHandler("app-zoom-in", zoomEntry);
  });
});

function SettingsAction({ run }: { run: () => void }) {
  useHotkeyAction("open-settings", run);
  return null;
}

function PaletteHost() {
  const [open, setOpen] = useState(true);
  return <CommandPalette open={open} onOpenChange={setOpen} />;
}

describe("the command palette picks on plain Enter only", () => {
  it("Ctrl+Enter on the highlighted row runs nothing; Enter runs it", async () => {
    const openSettings = vi.fn();
    render(
      <Providers>
        <Listener />
        <SettingsAction run={openSettings} />
        <PaletteHost />
      </Providers>,
    );
    const search = await screen.findByRole("textbox", {
      name: "Search commands",
    });
    act(() => search.focus());
    await userEvent.keyboard("Open settings");
    await screen.findByRole("button", { name: /Open settings/ });
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(openSettings).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(openSettings).toHaveBeenCalledTimes(1));
  });

  it("a held Enter picks nothing and keeps nothing native; a fresh one picks once", async () => {
    const openSettings = vi.fn();
    render(
      <Providers>
        <Listener />
        <SettingsAction run={openSettings} />
        <PaletteHost />
      </Providers>,
    );
    const search = await screen.findByRole("textbox", {
      name: "Search commands",
    });
    act(() => search.focus());
    await userEvent.keyboard("Open settings");
    await screen.findByRole("button", { name: /Open settings/ });
    // fireEvent answers false when the handler prevented the default.
    expect(fireEvent.keyDown(search, { key: "Enter", repeat: true })).toBe(
      false,
    );
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(openSettings).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(fireEvent.keyDown(search, { key: "Enter" })).toBe(false);
    await waitFor(() => expect(openSettings).toHaveBeenCalledTimes(1));
  });
});

function ZoomAction({ run }: { run: () => void }) {
  useHotkeyAction("app-zoom-in", run);
  return null;
}

const highlightedRow = () =>
  document.querySelector('[data-highlighted="true"]')?.textContent ?? "";

describe("the command palette leaves IME composition keys alone", () => {
  // jsdom implements no scrollIntoView; the palette scrolls its marked row.
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  });

  it("a composing Enter or arrow does nothing; the plain keys still act", async () => {
    const openSettings = vi.fn();
    const zoomIn = vi.fn();
    render(
      <Providers>
        <Listener />
        <SettingsAction run={openSettings} />
        <ZoomAction run={zoomIn} />
        <PaletteHost />
      </Providers>,
    );
    const search = await screen.findByRole("textbox", {
      name: "Search commands",
    });
    await screen.findByRole("button", { name: /Zoom in/ });
    act(() => search.focus());
    // fireEvent answers false when the handler prevented the default.
    const press = (init: KeyboardEventInit & { keyCode?: number }) =>
      fireEvent.keyDown(search, init);
    expect(highlightedRow()).toMatch(/Open settings/);

    expect(press({ key: "ArrowDown", isComposing: true })).toBe(true);
    expect(highlightedRow()).toMatch(/Open settings/);
    expect(press({ key: "ArrowDown" })).toBe(false);
    expect(highlightedRow()).toMatch(/Zoom in/);
    expect(press({ key: "ArrowUp", isComposing: true })).toBe(true);
    expect(highlightedRow()).toMatch(/Zoom in/);

    expect(press({ key: "Enter", isComposing: true })).toBe(true);
    // WebKit's shape: the composition already ended, keyCode still 229.
    expect(press({ key: "Enter", keyCode: 229 })).toBe(true);
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(zoomIn).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    expect(press({ key: "Enter" })).toBe(false);
    await waitFor(() => expect(zoomIn).toHaveBeenCalledTimes(1));
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("a keyCode 229 Escape keeps the palette and its query; a plain one closes it", async () => {
    render(
      <Providers>
        <Listener />
        <PaletteHost />
      </Providers>,
    );
    const search = await screen.findByRole("textbox", {
      name: "Search commands",
    });
    act(() => search.focus());
    await userEvent.keyboard("zoom");
    // WebKit's shape: the composition already ended, keyCode still 229.
    expect(fireEvent.keyDown(search, { key: "Escape", keyCode: 229 })).toBe(
      true,
    );
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(search).toHaveValue("zoom");
    // Positive control: the plain key reaches the dialog's dismissal.
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("a chord on a focused palette row", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  });

  it("Ctrl+Enter runs the app chord and leaves the row; Enter then runs the row", async () => {
    vi.mocked(loadSettings).mockResolvedValue({
      ...structuredClone(DEFAULT_SETTINGS),
      hotkeys: { "app-zoom-in": "mod+enter" },
    });
    const openSettings = vi.fn();
    const zoomIn = vi.fn();
    render(
      <Providers>
        <Listener />
        <SettingsAction run={openSettings} />
        <ZoomAction run={zoomIn} />
        <PaletteHost />
      </Providers>,
    );
    // The override is live once the zoom row shows it.
    const zoomRow = await screen.findByRole("button", { name: /Zoom in/ });
    await waitFor(() =>
      expect(zoomRow).toHaveTextContent(formatBinding("mod+enter")),
    );
    const search = screen.getByRole("textbox", { name: "Search commands" });
    act(() => search.focus());
    await userEvent.keyboard("Open settings");
    await userEvent.tab();
    const row = screen.getByRole("button", { name: /Open settings/ });
    expect(row).toHaveFocus();

    // user-event sends no activation click under Control, so the row's
    // native click is pinned by the press's prevented default, which cancels
    // a button's Enter activation in the webview.
    let chord: KeyboardEvent | undefined;
    const record = (e: KeyboardEvent) => {
      if (e.key === "Enter") chord = e;
    };
    window.addEventListener("keydown", record);
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    window.removeEventListener("keydown", record);
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(chord?.defaultPrevented).toBe(true);
    expect(zoomIn).toHaveBeenCalledTimes(1);
    expect(openSettings).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(openSettings).toHaveBeenCalledTimes(1));
    expect(zoomIn).toHaveBeenCalledTimes(1);
  });
});
