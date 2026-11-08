import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { SettingsScreen } from "@/features/settings/SettingsScreen";
import { stableStringify } from "@/features/settings/save-reset";
import { toDraft } from "@/features/settings/settings-form";
import { queryClient } from "@/lib/query-client";
import {
  type AppSettings,
  loadSettings,
  saveSettingsMerged,
  saveSettingsPatch,
} from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { __resetZoomForTests, setZoomLevel } from "@/lib/zoom/zoom";
import { unmockedCommands } from "./setup";

// Zoom applies on change, outside the bulk form: a zoom change while Settings is
// open must neither dirty the form nor ride its Save back stale. The screen
// renders over the SHARED client, the one the zoom controller patches.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: vi.fn(async () => undefined) }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({}),
  currentMonitor: vi.fn(async () => null),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
  saveSettingsMerged: vi.fn(),
  saveSettingsPatch: vi.fn(),
}));
vi.mock("@/lib/automations/store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/automations/store")>();
  return {
    ...actual,
    loadAutomations: vi.fn(async () => actual.normalizeAutomations(undefined)),
  };
});

let stored: AppSettings;

function Host() {
  const view = useUiStore((s) => s.view);
  return view === "settings" ? <SettingsScreen /> : null;
}

beforeEach(() => {
  stored = structuredClone(DEFAULT_SETTINGS);
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(stored),
  );
  vi.mocked(saveSettingsMerged).mockImplementation(async (next) => {
    stored = structuredClone(next);
    return structuredClone(stored);
  });
  vi.mocked(saveSettingsPatch).mockImplementation(async (patch) => {
    stored = { ...stored, ...patch };
    return structuredClone(stored);
  });
  useUiStore.setState(useUiStore.getInitialState(), true);
});

afterEach(() => {
  __resetZoomForTests();
  queryClient.clear();
});

afterAll(() => {
  if (unmockedCommands.length > 0)
    console.warn(`unmocked commands: ${unmockedCommands.join(", ")}`);
});

async function openSettings() {
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={queryClient}>
      <Host />
    </QueryClientProvider>,
  );
  act(() => useUiStore.getState().openSettings());
  await screen.findByText("Create pull requests as drafts");
  return user;
}

/** A zoom change from the Settings control, through the real controller. */
async function changeZoom(zoom: number) {
  await act(async () => {
    setZoomLevel(zoom, "settings");
  });
  await waitFor(() => expect(stored.zoom).toBe(zoom));
}

describe("zoom stays out of the bulk settings form", () => {
  it("leaves zoom out of the draft", () => {
    const live = { ...structuredClone(DEFAULT_SETTINGS), zoom: 1.5 };
    expect("zoom" in toDraft(live)).toBe(false);
  });

  it("a zoom change reaches the screen's cache without dirtying the form", async () => {
    await openSettings();
    await changeZoom(1.5);
    expect(
      queryClient.getQueryData<AppSettings>(settingsKeys.settings)?.zoom,
    ).toBe(1.5);
    expect(screen.queryByText("You have unsaved changes")).toBeNull();
  });

  it("a form Save carries the live zoom, not the seed-time one", async () => {
    const user = await openSettings();
    await user.click(screen.getByText("Create pull requests as drafts"));
    await screen.findByText("You have unsaved changes");
    await changeZoom(1.5);
    await user.click(screen.getByRole("button", { name: /Save changes/ }));
    await waitFor(() => expect(saveSettingsMerged).toHaveBeenCalledTimes(1));
    const [written] = vi.mocked(saveSettingsMerged).mock.calls[0];
    expect(written.zoom).toBe(1.5);
    expect(written.createPrsAsDraft).toBe(!DEFAULT_SETTINGS.createPrsAsDraft);
  });

  // NEGATIVE CONTROL: the same dirty and payload checks over a draft that still
  // carries zoom (the Omit reverted) fail both ways.
  it("a draft carrying zoom would dirty the form and write a stale zoom", () => {
    const seed = structuredClone(DEFAULT_SETTINGS);
    const live = { ...seed, zoom: 1.5 };
    const reverted = (s: AppSettings) => ({ ...toDraft(s), zoom: s.zoom });
    const draft = reverted(seed);
    expect(stableStringify(draft) !== stableStringify(reverted(live))).toBe(
      true,
    );
    expect({ ...live, ...draft }.zoom).toBe(seed.zoom);
    // The real draft passes the same checks.
    expect(stableStringify(toDraft(seed))).toBe(stableStringify(toDraft(live)));
    expect({ ...live, ...toDraft(seed) }.zoom).toBe(1.5);
  });
});
