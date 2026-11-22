import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HandlerTier } from "@/lib/hotkeys/handler-registry";
import { useHotkeyAction, useHotkeysListener } from "@/lib/hotkeys/hotkeys";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { unmockedCommands } from "./setup";

// Precedence tiers through the real listener: the highest tier among enabled
// entries answers, and registration order decides only inside one tier. jsdom
// is not macOS: mod is Ctrl.
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
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

function Entry({
  run,
  enabled = true,
  tier,
}: {
  run: () => void;
  enabled?: boolean;
  tier?: HandlerTier;
}) {
  useHotkeyAction("focus-filter", run, enabled, tier ? { tier } : undefined);
  return null;
}

const modF = () => userEvent.setup().keyboard("{Control>}f{/Control}");

function Host({
  popup,
  surface,
  surfaceEnabled,
}: {
  popup: () => void;
  surface: () => void;
  surfaceEnabled: boolean;
}) {
  return (
    <Providers>
      <Listener />
      <Entry run={popup} tier="popup" />
      <Entry run={surface} enabled={surfaceEnabled} />
    </Providers>
  );
}

describe("hotkey precedence tiers", () => {
  it("P3 a popup entry keeps the chord when an older surface entry re-registers", async () => {
    const popup = vi.fn();
    const surface = vi.fn();
    const view = render(
      <Host popup={popup} surface={surface} surfaceEnabled />,
    );
    await modF();
    expect(popup).toHaveBeenCalledTimes(1);
    // The poll flip: the surface entry re-registers newest, disabled then enabled.
    view.rerender(
      <Host popup={popup} surface={surface} surfaceEnabled={false} />,
    );
    view.rerender(<Host popup={popup} surface={surface} surfaceEnabled />);
    await modF();
    expect(popup).toHaveBeenCalledTimes(2);
    expect(surface).not.toHaveBeenCalled();
  });

  it("P3 a fallback registered after an enabled surface entry never answers", async () => {
    const surface = vi.fn();
    const fallback = vi.fn();
    function Pair({ surfaceEnabled }: { surfaceEnabled: boolean }) {
      return (
        <Providers>
          <Listener />
          <Entry run={surface} enabled={surfaceEnabled} />
          <Entry run={fallback} tier="fallback" />
        </Providers>
      );
    }
    const view = render(<Pair surfaceEnabled />);
    await modF();
    expect(surface).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    act(() => view.rerender(<Pair surfaceEnabled={false} />));
    await modF();
    expect(fallback).toHaveBeenCalledTimes(1);
    act(() => view.rerender(<Pair surfaceEnabled />));
    await modF();
    expect(surface).toHaveBeenCalledTimes(2);
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});
