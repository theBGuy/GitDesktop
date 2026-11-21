import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
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
import { type AppSettings, loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

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

let stored: AppSettings;
// jsdom implements no scrollIntoView; record which element each call scrolled.
const scrollIntoView = vi.fn();

/** Mirrors the app's view switch, so leaving Settings unmounts the screen. */
function Host() {
  const view = useUiStore((s) => s.view);
  return view === "settings" ? <SettingsScreen /> : null;
}

const st = () => useUiStore.getState();
const region = () => screen.findByRole("group", { name: "Isolation" });
/** Scroll calls whose target was `el`. */
const scrollsOf = (el: Element) =>
  scrollIntoView.mock.contexts.filter((c) => c === el).length;

beforeEach(() => {
  stored = structuredClone(DEFAULT_SETTINGS);
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(stored),
  );
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
  useUiStore.setState(useUiStore.getInitialState(), true);
});

afterEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: removing the test-only stub
  delete (Element.prototype as any).scrollIntoView;
});

afterAll(() => {
  if (unmockedCommands.length > 0)
    console.warn(`unmocked commands: ${unmockedCommands.join(", ")}`);
});

/** `cached` = the settings read already answered (the composer jump's case), so
 *  the AI panel mounts in Settings' first commit, before the form is seeded. */
function mount(cached?: AppSettings) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (cached) client.setQueryData(settingsKeys.settings, cached);
  render(
    <QueryClientProvider client={client}>
      <Host />
    </QueryClientProvider>,
  );
}

describe("Settings in-panel anchor", () => {
  it("the store keeps the anchor until cleared, and every other open drops it", () => {
    st().openSettings("ai", "agent-sandbox");
    expect(st().settingsTarget).toBe("ai");
    expect(st().settingsAnchor).toBe("agent-sandbox");
    st().clearSettingsAnchor();
    expect(st().settingsAnchor).toBeNull();

    st().openSettings("ai", "agent-sandbox");
    st().openSettings("ai");
    expect(st().settingsAnchor).toBeNull();

    st().openSettings("ai", "agent-sandbox");
    st().openMcpBrowse();
    expect(st().settingsAnchor).toBeNull();
  });

  it("lands on the sandbox region once; a later visit stays at the top", async () => {
    const user = userEvent.setup();
    mount();
    act(() => st().openSettings("ai", "agent-sandbox"));
    const first = await region();
    expect(first).toHaveAttribute("tabindex", "-1");
    expect(scrollsOf(first)).toBe(1);
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "start",
      behavior: "instant",
    });
    expect(document.activeElement).toBe(first);
    expect(first).toHaveAttribute("data-anchor-landed");
    expect(st().settingsAnchor).toBeNull();

    // Away and back within the same visit remounts the panel.
    await user.click(screen.getByRole("button", { name: "General" }));
    await user.click(screen.getByRole("button", { name: "AI" }));
    const again = await region();
    expect(scrollsOf(again)).toBe(0);
    expect(document.activeElement).not.toBe(again);

    act(() => st().closeSettings());
    expect(st().view).not.toBe("settings");
    act(() => st().openSettings("ai"));
    const second = await region();
    expect(scrollsOf(second)).toBe(0);
    expect(document.activeElement).not.toBe(second);
  });

  it("a plain open of the AI panel neither scrolls nor focuses", async () => {
    mount();
    act(() => st().openSettings("ai"));
    const el = await region();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(el);
  });

  it("an anchor whose panel isn't active is dropped without moving anything", async () => {
    const user = userEvent.setup();
    mount();
    act(() => st().openSettings("general", "agent-sandbox"));
    await screen.findByText("Create pull requests as drafts");
    expect(st().settingsAnchor).toBeNull();

    await user.click(screen.getByRole("button", { name: "AI" }));
    const el = await region();
    expect(scrollsOf(el)).toBe(0);
    expect(document.activeElement).not.toBe(el);
  });

  it("the landing ring survives a window deactivation and clears once focus moves off", async () => {
    const user = userEvent.setup();
    mount();
    act(() => st().openSettings("ai", "agent-sandbox"));
    const el = await region();
    expect(el).toHaveAttribute("data-anchor-landed");
    // A window deactivation blurs the region but leaves it the active element.
    fireEvent.blur(el);
    expect(document.activeElement).toBe(el);
    expect(el).toHaveAttribute("data-anchor-landed");
    await user.tab();
    expect(el).not.toHaveAttribute("data-anchor-landed");
  });

  it("with settings already cached, the landing waits for the saved values and runs once", async () => {
    stored = { ...structuredClone(DEFAULT_SETTINGS), defaultAgent: "codex" };
    const seenAtScroll: boolean[] = [];
    scrollIntoView.mockImplementation(() => {
      seenAtScroll.push(
        document.body.textContent?.includes("runs start on Codex") ?? false,
      );
    });
    mount(structuredClone(stored));
    act(() => st().openSettings("ai", "agent-sandbox"));
    const el = await region();
    await screen.findByText(/runs start on Codex/);
    expect(scrollsOf(el)).toBe(1);
    expect(seenAtScroll).toEqual([true]);
    expect(document.activeElement).toBe(el);
    expect(st().settingsAnchor).toBeNull();
  });

  it("with Hide AI on, a pending anchor is dropped and nothing moves", async () => {
    stored = { ...structuredClone(DEFAULT_SETTINGS), hideAi: true };
    mount();
    act(() => st().openSettings("ai", "agent-sandbox"));
    await screen.findByText("Create pull requests as drafts");
    expect(st().settingsAnchor).toBeNull();
    expect(screen.queryByRole("group", { name: "Isolation" })).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
