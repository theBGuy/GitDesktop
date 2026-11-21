import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useMacAppMenu } from "@/features/app-menu/useMacAppMenu";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { unmockedCommands } from "./setup";

// The native menu's two events arrive through `listen`; the hook is inert off
// macOS, so `isMac` is forced on.
const listeners = vi.hoisted(
  () => new Map<string, (e: { payload: unknown }) => void>(),
);
const openByPath = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    listeners.set(name, cb);
    return () => listeners.delete(name);
  }),
}));
vi.mock("@/lib/hotkeys/binding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hotkeys/binding")>()),
  isMac: true,
}));
vi.mock("@/features/repository/useOpenRepoByPath", () => ({
  useOpenRepoByPath: () => openByPath,
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));

beforeEach(() => {
  listeners.clear();
  openByPath.mockClear();
  // No recents: the Open Recent submenu push stays out of these tests.
  vi.mocked(loadSettings).mockImplementation(async () => ({
    ...structuredClone(DEFAULT_SETTINGS),
    recentRepos: undefined as never,
  }));
});

afterAll(() => expect(unmockedCommands).toEqual([]));

function Host({
  openSettings,
  dialog,
}: {
  openSettings: () => void;
  dialog: boolean;
}) {
  useMacAppMenu();
  useHotkeyAction("open-settings", openSettings);
  return (
    <Dialog open={dialog}>
      <DialogContent>
        <DialogTitle>Some dialog</DialogTitle>
        <DialogDescription>Body</DialogDescription>
      </DialogContent>
    </Dialog>
  );
}

function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

async function mount(dialog: boolean) {
  const openSettings = vi.fn();
  render(
    <Providers>
      <Host openSettings={openSettings} dialog={dialog} />
    </Providers>,
  );
  await waitFor(() => expect(listeners.size).toBe(2));
  if (dialog) await screen.findByText("Some dialog");
  return openSettings;
}

function fire(event: string, payload: unknown) {
  const cb = listeners.get(event);
  if (!cb) throw new Error(`no listener for ${event}`);
  act(() => cb({ payload }));
}

function blurToBody() {
  act(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
}

describe("macOS menu actions under a modal", () => {
  it("M8 a menu action runs with no dialog open", async () => {
    const openSettings = await mount(false);
    fire("app-menu-action", "open-settings");
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("M8 a menu action runs nothing under an open dialog, body focus included", async () => {
    const openSettings = await mount(true);
    fire("app-menu-action", "open-settings");
    blurToBody();
    fire("app-menu-action", "open-settings");
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("M8b Open Recent opens the repository with no dialog open", async () => {
    await mount(false);
    fire("app-menu-open-recent", "C:/repos/alpha");
    expect(openByPath).toHaveBeenCalledWith("C:/repos/alpha", "recent");
  });

  it("M8b Open Recent opens nothing under an open dialog", async () => {
    await mount(true);
    fire("app-menu-open-recent", "C:/repos/alpha");
    blurToBody();
    fire("app-menu-open-recent", "C:/repos/alpha");
    expect(openByPath).not.toHaveBeenCalled();
  });
});
