import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MyWorkScreen } from "@/features/mywork/MyWorkScreen";
import type { MyWorkItem } from "@/lib/git/types";
import type { RecentRepo } from "@/lib/settings/api";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { unmockedCommands } from "./setup";

const data = vi.hoisted(() => ({
  items: [] as MyWorkItem[],
  recents: [] as RecentRepo[],
}));

vi.mock("@/lib/git/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/queries")>()),
  useMyWorkSources: () => ({
    data: { github: true, gitlab: false, bitbucket: false },
    isPending: false,
    isSuccess: true,
    isError: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  }),
  useForgeMyWork: (provider: string) =>
    provider === "github"
      ? {
          data: { items: data.items, truncated: false },
          isPending: false,
          isSuccess: true,
          isError: false,
          isPaused: false,
          isFetching: false,
          isPlaceholderData: false,
          error: null,
          refetch: vi.fn(),
        }
      : {
          data: undefined,
          isPending: true,
          isSuccess: false,
          isError: false,
          isPaused: false,
          isFetching: false,
          isPlaceholderData: false,
          error: null,
          refetch: vi.fn(),
        },
}));
// No recents outside MK12, so every row open goes to the browser and nothing
// reaches git; MK12's one recent matches its row, so only the menu's direct
// browser call keeps that open off git.
vi.mock("@/lib/settings/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/queries")>()),
  useSettings: () => ({ data: { recentRepos: data.recents } }),
}));
vi.mock("@/features/repository/useOpenRepoByPath", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/repository/useOpenRepoByPath")
  >()),
  claimRepoOpen: () => () => true,
}));
// The opener plugin calls Tauri directly, past the test transport.
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/lib/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/toast")>()),
  toastError: vi.fn(),
}));

const opened = vi.mocked(openUrl);

const item = (repoName: string, number: number): MyWorkItem => ({
  number,
  title: `${repoName} ${number}`,
  isPullRequest: true,
  isDraft: false,
  repoFullName: `acme/${repoName}`,
  repoOwner: "acme",
  repoName,
  host: "github.com",
  url: `https://github.com/acme/${repoName}/pull/${number}`,
  updatedAt: `2026-01-0${number}T00:00:00Z`,
  provider: "github",
});

beforeEach(() => {
  data.items = [item("alpha", 3), item("beta", 2), item("gamma", 1)];
  data.recents = [];
  opened.mockReset().mockResolvedValue(undefined);
  vi.mocked(toastError).mockReset();
  useUiStore.setState({ view: "mywork" });
});

afterEach(() => cleanup());

afterAll(() => expect(unmockedCommands).toEqual([]));

function renderScreen() {
  const user = userEvent.setup();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <MyWorkScreen />
    </QueryClientProvider>,
  );
  const input = screen.getByRole("combobox", { name: "Filter your work" });
  input.focus();
  return { ...view, user, input };
}

/** Stands in for WebView2's trusted follow-up; true = not default-prevented. */
const followUp = (target: Element = document.body) =>
  target.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
  );

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

// jsdom lays nothing out, so the virtualized list (@tanstack/virtual-core sizes
// its viewport from the scroll element's clientWidth/clientHeight) paints no
// row; a fixed client size gives it a viewport.
describe("with rendered rows", () => {
  const CLIENT_SIZE = { clientWidth: 800, clientHeight: 600 } as const;
  beforeAll(() => {
    for (const [k, v] of Object.entries(CLIENT_SIZE)) {
      Object.defineProperty(HTMLElement.prototype, k, {
        configurable: true,
        get: () => v,
      });
    }
  });
  afterAll(() => {
    for (const k of Object.keys(CLIENT_SIZE)) {
      Reflect.deleteProperty(HTMLElement.prototype, k);
    }
  });

  async function openWith(
    init: { key: string; shiftKey?: boolean },
    downs = 1,
  ) {
    const view = renderScreen();
    for (let i = 0; i < downs; i++) {
      fireEvent.keyDown(view.input, { key: "ArrowDown" });
    }
    expect(fireEvent.keyDown(view.input, init)).toBe(false);
    const menu = await screen.findByRole("menu");
    return { ...view, menu };
  }

  it("MK1: the Menu key opens the active row's menu, focus inside it", async () => {
    const { menu } = await openWith({ key: "ContextMenu" });
    expect(screen.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
    await waitFor(() =>
      expect(menu.contains(document.activeElement)).toBe(true),
    );
  });

  it("MK2: Shift+F10 opens the same menu, focus inside it", async () => {
    const { menu } = await openWith({ key: "F10", shiftKey: true });
    expect(screen.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
    await waitFor(() =>
      expect(menu.contains(document.activeElement)).toBe(true),
    );
  });

  it("MK3: a right-click on a row opens the menu and arms nothing", async () => {
    const { user } = renderScreen();
    const row = screen.getAllByRole("option")[1];
    await user.pointer({ keys: "[MouseRight]", target: row });
    const menu = await screen.findByRole("menu");
    expect(screen.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
    await waitFor(() =>
      expect(menu.contains(document.activeElement)).toBe(true),
    );
    expect(followUp(menu)).toBe(true);
  });

  it("MK4: cancels the contextmenu that follows the Menu key, once", async () => {
    const { menu } = await openWith({ key: "ContextMenu" });
    expect(followUp(menu)).toBe(false);
    expect(followUp(menu)).toBe(true);
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("MK5: lets a contextmenu through a task after the Menu key's keyup", async () => {
    const { input, menu } = await openWith({ key: "ContextMenu" });
    // Armed before the keyup; the swallow spends it, so the key arms afresh.
    expect(followUp(menu)).toBe(false);
    expect(fireEvent.keyDown(input, { key: "ContextMenu" })).toBe(false);
    fireEvent.keyUp(input, { key: "ContextMenu" });
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(followUp(menu)).toBe(true);
  });

  it("MK11: cancels a follow-up that arrives right after the Menu key's keyup", async () => {
    const { input, menu } = await openWith({ key: "ContextMenu" });
    fireEvent.keyUp(input, { key: "ContextMenu" });
    expect(followUp(menu)).toBe(false);
  });

  it("MK6: arms nothing for Shift+F10", async () => {
    const { menu } = await openWith({ key: "F10", shiftKey: true });
    expect(followUp(menu)).toBe(true);
  });

  it("MK7: with no active row neither key is taken and nothing arms", async () => {
    const { input } = renderScreen();
    expect(fireEvent.keyDown(input, { key: "ContextMenu" })).toBe(true);
    expect(fireEvent.keyDown(input, { key: "F10", shiftKey: true })).toBe(true);
    await settle();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(followUp()).toBe(true);
  });

  it("MK8: disarms when the screen unmounts", async () => {
    const { input, menu, unmount } = await openWith({ key: "ContextMenu" });
    // Armed before the unmount; the swallow spends it, so the key arms afresh.
    expect(followUp(menu)).toBe(false);
    expect(fireEvent.keyDown(input, { key: "ContextMenu" })).toBe(false);
    unmount();
    expect(followUp()).toBe(true);
  });

  it("MK10: arrow keys move the active row and Enter opens it", async () => {
    const { input } = renderScreen();
    const rows = screen.getAllByRole("option");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", rows[1].id);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveAttribute("aria-activedescendant", rows[0].id);
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    await waitFor(() => expect(opened).toHaveBeenCalledWith(data.items[0].url));
    expect(followUp()).toBe(true);
  });

  it("MK12: a browser open the OS refuses from the row menu takes the generic toast once", async () => {
    data.recents = [
      {
        path: "C:/repos/beta",
        name: "beta",
        lastOpenedAt: "2026-01-01T00:00:00Z",
        owner: "acme",
        host: "github.com",
        repoName: "beta",
        provider: "github",
      },
    ];
    // The second row, so a menu acting on the first one can't pass.
    const { user } = await openWith({ key: "ContextMenu" }, 2);
    const refusal = new Error("no handler for https");
    opened.mockRejectedValueOnce(refusal);
    await user.click(screen.getByRole("menuitem", { name: /^Open on / }));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith(data.items[1].url);
    expect(toastError).toHaveBeenCalledWith(refusal);
    await settle();
    expect(toastError).toHaveBeenCalledTimes(1);
  });
});

describe("with no rendered rows", () => {
  it("MK9: an active row the virtualizer didn't render swallows the Menu key and its follow-up once", async () => {
    const { input } = renderScreen();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(fireEvent.keyDown(input, { key: "ContextMenu" })).toBe(false);
    await settle();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(followUp(input)).toBe(false);
    expect(followUp(input)).toBe(true);
  });
});
