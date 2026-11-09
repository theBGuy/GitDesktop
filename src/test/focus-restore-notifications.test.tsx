import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
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
import { ConfirmDialogHost } from "@/components/confirm-dialog-host";
import { NotificationsSection } from "@/features/settings/NotificationsSection";
import { settingsFormOpts } from "@/features/settings/settings-form";
import { useAppForm } from "@/lib/form";
import {
  clearNotificationOverride,
  loadNotificationOverrides,
  type RepoNotificationOverride,
} from "@/lib/notifications/overrides";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useConfirm } from "@/lib/stores/confirm";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/notifications/overrides", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications/overrides")>()),
  loadNotificationOverrides: vi.fn(),
  clearNotificationOverride: vi.fn(),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));

afterAll(() => expect(unmockedCommands).toEqual([]));

// Git-common-dir keys that name no recent repo, so each row is path-null and
// named by its folder basename.
const ALPHA = "C:/repos/alpha/.git";
const BETA = "C:/repos/beta/.git";

let stored: Record<string, RepoNotificationOverride> = {};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Holds the clear write open until the test resolves it; the re-read after
 *  the mutation's invalidation then serves the reduced set. */
function gateClear() {
  const gate = deferred();
  vi.mocked(clearNotificationOverride).mockImplementation(async (key) => {
    await gate.promise;
    const { [key]: _cleared, ...rest } = stored;
    stored = rest;
  });
  return gate;
}

function Harness() {
  const form = useAppForm({ ...settingsFormOpts });
  return <NotificationsSection form={form} />;
}

function renderSection({ withHost = false } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Harness />
      {withHost && <ConfirmDialogHost />}
    </QueryClientProvider>,
  );
  return client;
}

/** Holds every element's exit animation open until `release`, so the confirm
 *  dialog keeps focus through its close the way a real 100 ms exit does. */
function holdExitAnimations() {
  const hold = deferred();
  const original = Element.prototype.getAnimations;
  const animation = {
    finished: hold.promise,
    pending: false,
    playState: "running",
    effect: { getTiming: () => ({ duration: 100, iterations: 1 }) },
  };
  Element.prototype.getAnimations = () => [animation as unknown as Animation];
  return {
    release: () => {
      Element.prototype.getAnimations = original;
      hold.resolve();
    },
    restore: () => {
      Element.prototype.getAnimations = original;
    },
  };
}

const keyOf = (name: string) => `C:/repos/${name}/.git`;

const rowOf = (name: string) =>
  screen.getByText(name).closest<HTMLElement>("[data-row]");
const clearButtonOf = (name: string) => {
  const row = rowOf(name);
  if (!row) throw new Error(`no row for ${name}`);
  return within(row).getByRole("button", { name: "Clear" });
};

const realAsk = useConfirm.getState().ask;

describe("NotificationsSection clear-overrides focus restore", () => {
  beforeEach(() => {
    vi.mocked(loadSettings).mockImplementation(async () => ({
      ...DEFAULT_SETTINGS,
      recentRepos: [],
    }));
    vi.mocked(loadNotificationOverrides).mockImplementation(async () => ({
      ...stored,
    }));
    useConfirm.setState({ ask: vi.fn(async () => true) });
  });
  afterEach(() => {
    useConfirm.setState({ ask: realAsk });
  });

  it("leaves focus where the user moved it during the clear", async () => {
    stored = { [ALPHA]: { muted: true }, [BETA]: { muted: true } };
    const gate = gateClear();
    const user = userEvent.setup();
    renderSection();
    await screen.findByText("alpha");
    await user.click(clearButtonOf("alpha"));
    await waitFor(() => expect(clearNotificationOverride).toHaveBeenCalled());
    const betaClear = clearButtonOf("beta");
    act(() => betaClear.focus());
    await act(async () => gate.resolve());
    await waitFor(() => expect(screen.queryByText("alpha")).toBeNull());
    expect(document.activeElement).toBe(betaClear);
  });

  it("focuses the neighbour row when focus fell to body", async () => {
    // Through the real confirm dialog: its close returns focus to the clicked
    // Clear, which then unmounts with its row.
    useConfirm.setState({ ask: realAsk });
    stored = { [ALPHA]: { muted: true }, [BETA]: { muted: true } };
    const gate = gateClear();
    const user = userEvent.setup();
    renderSection({ withHost: true });
    await screen.findByText("alpha");
    await user.click(clearButtonOf("alpha"));
    await user.click(
      await screen.findByRole("button", { name: "Clear overrides" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(clearNotificationOverride).toHaveBeenCalled());
    await act(async () => gate.resolve());
    await waitFor(() => expect(screen.queryByText("alpha")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(rowOf("beta")));
  });

  it("focuses the neighbour row when the write lands while the dialog closes", async () => {
    useConfirm.setState({ ask: realAsk });
    stored = { [ALPHA]: { muted: true }, [BETA]: { muted: true } };
    const gate = gateClear();
    const user = userEvent.setup();
    renderSection({ withHost: true });
    await screen.findByText("alpha");
    await user.click(clearButtonOf("alpha"));
    const confirm = await screen.findByRole("button", {
      name: "Clear overrides",
    });
    const exit = holdExitAnimations();
    try {
      await user.click(confirm);
      await waitFor(() => expect(clearNotificationOverride).toHaveBeenCalled());
      // The fast ordering: the dialog is still closing and holds focus.
      expect(screen.getByRole("dialog", { hidden: true })).toBeTruthy();
      expect(document.activeElement).toBe(confirm);
      await act(async () => gate.resolve());
      await waitFor(() => expect(screen.queryByText("alpha")).toBeNull());
      await act(async () => exit.release());
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { hidden: true })).toBeNull(),
      );
      await waitFor(() => expect(document.activeElement).toBe(rowOf("beta")));
    } finally {
      exit.restore();
    }
  });

  it("moves the arrow cursor to the row the user focused during the clear", async () => {
    stored = Object.fromEntries(
      ["alpha", "beta", "gamma", "delta"].map((n) => [
        keyOf(n),
        { muted: true },
      ]),
    );
    const gate = gateClear();
    const user = userEvent.setup();
    renderSection();
    await screen.findByText("alpha");
    await user.click(clearButtonOf("alpha"));
    await waitFor(() => expect(clearNotificationOverride).toHaveBeenCalled());
    const gammaClear = clearButtonOf("gamma");
    act(() => gammaClear.focus());
    await act(async () => gate.resolve());
    await waitFor(() => expect(screen.queryByText("alpha")).toBeNull());
    expect(document.activeElement).toBe(gammaClear);
    // Rows now read beta, delta, gamma. The aimed neighbour was beta; the
    // cursor follows focus to gamma instead, so ArrowUp steps to delta.
    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = () => undefined;
    try {
      await user.keyboard("{ArrowUp}");
    } finally {
      Element.prototype.scrollIntoView = scrollIntoView;
    }
    expect(document.activeElement).toBe(rowOf("delta"));
  });

  it("drops the aim when the cleared key survives the re-read", async () => {
    stored = { [ALPHA]: { muted: true }, [BETA]: { muted: true } };
    // Another window re-adds the key as the clear lands.
    vi.mocked(clearNotificationOverride).mockImplementation(
      async () => undefined,
    );
    const user = userEvent.setup();
    const client = renderSection();
    await screen.findByText("alpha");
    await user.click(clearButtonOf("alpha"));
    await waitFor(() => expect(clearNotificationOverride).toHaveBeenCalled());
    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(screen.getByText("alpha")).toBeTruthy();
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(document.activeElement).toBe(document.body);
    // A later, unrelated row change must not fire the old aim at beta.
    stored = { ...stored, [keyOf("gamma")]: { muted: true } };
    await act(async () => {
      await client.invalidateQueries();
    });
    await screen.findByText("gamma");
    expect(document.activeElement).toBe(document.body);
  });

  it("focuses Customize when the last row is cleared", async () => {
    stored = { [ALPHA]: { muted: true } };
    const gate = gateClear();
    const user = userEvent.setup();
    renderSection();
    await screen.findByText("alpha");
    await user.click(clearButtonOf("alpha"));
    await waitFor(() => expect(clearNotificationOverride).toHaveBeenCalled());
    await act(async () => gate.resolve());
    await waitFor(() => expect(screen.queryByText("alpha")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: /Customize/ }),
      ),
    );
  });
});
