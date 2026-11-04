import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsScreen } from "@/features/settings/SettingsScreen";
import {
  type AppSettings,
  loadSettings,
  saveSettingsMerged,
} from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

// The api modules are the seam: the screen's read and write stay real hooks
// over mocked store calls, and everything else in those modules stays real.
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
  saveSettingsMerged: vi.fn(),
}));
vi.mock("@/lib/automations/store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/automations/store")>();
  return {
    ...actual,
    loadAutomations: vi.fn(async () => actual.normalizeAutomations(undefined)),
  };
});

// The value the mocked store holds: reads get a copy, a resolving write lands.
let stored: AppSettings;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Mirrors the app's view switch, so leaving Settings unmounts the screen. */
function Host() {
  const view = useUiStore((s) => s.view);
  return view === "settings" ? <SettingsScreen /> : null;
}

const view = () => useUiStore.getState().view;
const leaveGuard = () => useUiStore.getState().settingsLeaveGuard;
const prompt = () => screen.findByRole("dialog", { name: "Unsaved changes" });

beforeEach(() => {
  stored = structuredClone(DEFAULT_SETTINGS);
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(stored),
  );
  vi.mocked(saveSettingsMerged).mockImplementation(async (next) => {
    stored = structuredClone(next);
    return structuredClone(stored);
  });
  useUiStore.setState(useUiStore.getInitialState(), true);
});

afterAll(() => {
  // A backend call no api mock covered is a finding to report, not a test of
  // these flows, so it is surfaced here rather than asserted.
  if (unmockedCommands.length > 0)
    console.warn(`unmocked commands: ${unmockedCommands.join(", ")}`);
});

async function openSettings() {
  const user = userEvent.setup();
  // Mutations take no client defaults (the mutation-defaults guard), and
  // react-query already never retries one.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Host />
    </QueryClientProvider>,
  );
  act(() => useUiStore.getState().openSettings());
  await screen.findByText("Create pull requests as drafts");
  return user;
}

async function makeDirty(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText("Create pull requests as drafts"));
  await screen.findByText("You have unsaved changes");
}

describe("Settings leave guard", () => {
  // Scan header L8 (one requestLeave that Back and Esc call, which asks) and L12
  // (Keep editing cancels it); the prompt Dialog's onOpenChange (Esc keeps
  // editing).
  it("F1: Esc and Back ask while dirty, and Keep editing stays", async () => {
    const user = await openSettings();
    await makeDirty(user);

    await user.keyboard("{Escape}");
    await prompt();
    expect(view()).toBe("settings");
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(view()).toBe("settings");
    expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back" }));
    await prompt();
    expect(view()).toBe("settings");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(view()).toBe("settings");
    expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
  });

  // Scan header L8-10 (the route asks, or goes).
  it("F2: Discard and close leaves without writing", async () => {
    const user = await openSettings();
    await makeDirty(user);

    await user.keyboard("{Escape}");
    await prompt();
    await user.click(screen.getByRole("button", { name: "Discard and close" }));

    await waitFor(() => expect(view()).toBe("welcome"));
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(leaveGuard()).toBeNull();
    expect(saveSettingsMerged).not.toHaveBeenCalled();
  });

  // Scan header L10-13 (a Save continues only from its success arm).
  it("F3: Save and close leaves only once the write lands", async () => {
    const write = deferred<AppSettings>();
    vi.mocked(saveSettingsMerged).mockImplementation(() => write.promise);
    const user = await openSettings();
    await makeDirty(user);

    await user.keyboard("{Escape}");
    await prompt();
    await user.click(screen.getByRole("button", { name: "Save and close" }));

    await waitFor(() => expect(saveSettingsMerged).toHaveBeenCalledTimes(1));
    expect(
      vi.mocked(saveSettingsMerged).mock.calls[0][0].createPrsAsDraft,
    ).toBe(!DEFAULT_SETTINGS.createPrsAsDraft);
    expect(view()).toBe("settings");

    await act(async () => {
      const [written] = vi.mocked(saveSettingsMerged).mock.calls[0];
      stored = structuredClone(written);
      write.resolve(structuredClone(stored));
    });
    await waitFor(() => expect(view()).toBe("welcome"));
  });

  // Scan header L6-7 (guard registered only while unsaved or writing);
  // SettingsScreen's guardOn registration effect. The null guard, read after
  // the seeded form renders and right before the move, is the evidence: jsdom
  // runs no view transition, so the screen unmounts at once and an absent
  // dialog alone can't tell "never asked" from "asked and gone".
  it("F4: a clean screen is never intercepted", async () => {
    const user = await openSettings();
    expect(leaveGuard()).toBeNull();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(view()).toBe("welcome"));
  });

  it("F4: a clean screen lets another navigator go directly", async () => {
    await openSettings();
    expect(leaveGuard()).toBeNull();

    act(() => useUiStore.getState().openHelp());
    expect(view()).toBe("help");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // Scan header L1-4 (every navigator consults the guard before its bump);
  // ui.ts openHelp's interceptSettingsLeave.
  it("F5: a navigator from elsewhere asks, then resumes its own move", async () => {
    const user = await openSettings();
    await makeDirty(user);

    act(() => useUiStore.getState().openHelp());
    await prompt();
    expect(view()).toBe("settings");

    await user.click(screen.getByRole("button", { name: "Discard and close" }));
    await waitFor(() => expect(view()).toBe("help"));
  });

  // SettingsScreen's onSubmit catch and finally (a failed Save never leaves);
  // scan header L9-11. The write is held so the test sees it in flight, then
  // fails it inside act, so the post-state is read after the failure settled.
  it("F6: a failed Save stays on Settings with the draft", async () => {
    const write = deferred<AppSettings>();
    vi.mocked(saveSettingsMerged).mockImplementation(() => write.promise);
    const user = await openSettings();
    await makeDirty(user);

    await user.keyboard("{Escape}");
    await prompt();
    await user.click(screen.getByRole("button", { name: "Save and close" }));

    await waitFor(() => expect(saveSettingsMerged).toHaveBeenCalledTimes(1));
    // A regex: the in-flight Spinner's "Loading" label joins the button's name.
    const saveChanges = () =>
      screen.getByRole("button", { name: /Save changes/ });
    await waitFor(() =>
      expect(saveChanges()).toHaveAttribute("aria-disabled", "true"),
    );

    await act(async () => write.reject({ kind: "io", message: "disk full" }));
    await waitFor(() =>
      expect(saveChanges()).not.toHaveAttribute("aria-disabled", "true"),
    );
    expect(view()).toBe("settings");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
  });
});
