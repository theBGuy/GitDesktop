import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffectiveBindings } from "@/lib/hotkeys/hotkeys";
import { useGenerateChord } from "@/lib/hotkeys/useGenerateChord";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { unmockedCommands } from "./setup";

// The generate chord belongs to its first holder in ACTIONS order, as in the
// window listener. jsdom is not macOS: mod is Ctrl.
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

afterAll(() => expect(unmockedCommands).toEqual([]));

function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function Surface({ run }: { run: () => void }) {
  const chord = useGenerateChord({ enabled: true, run });
  // Shows commit's binding, so a test can wait for the overrides to load.
  const commitBinding = useEffectiveBindings().get("commit") ?? "none";
  return (
    <div onKeyDown={chord.onKeyDown}>
      <button type="button">Focus</button>
      <span>{`commit: ${commitBinding}`}</span>
    </div>
  );
}

/** Presses Ctrl+G at the focused button; whether its keydown was prevented. */
async function modG() {
  let prevented: boolean | undefined;
  const spy = (e: KeyboardEvent) => {
    if (e.key !== "Control") prevented = e.defaultPrevented;
  };
  window.addEventListener("keydown", spy);
  try {
    await userEvent.setup().keyboard("{Control>}g{/Control}");
  } finally {
    window.removeEventListener("keydown", spy);
  }
  return prevented;
}

describe("useGenerateChord owner check", () => {
  it("O1 a chord an earlier action also holds is neither run nor swallowed", async () => {
    // Hand-edited shape: Settings itself would unbind the earlier holder.
    hotkeyOverrides = { commit: "mod+g", "generate-commit-message": "mod+g" };
    const run = vi.fn();
    render(
      <Providers>
        <Surface run={run} />
      </Providers>,
    );
    await screen.findByText("commit: mod+g");
    screen.getByRole("button", { name: "Focus" }).focus();
    expect(await modG()).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("O1 the sole holder's chord is swallowed and runs Generate", async () => {
    const run = vi.fn();
    render(
      <Providers>
        <Surface run={run} />
      </Providers>,
    );
    await screen.findByText("commit: mod+enter");
    screen.getByRole("button", { name: "Focus" }).focus();
    expect(await modG()).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
