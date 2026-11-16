import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { toast } from "sonner";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CREATE_PENDING_GENERATE_REASON } from "@/features/conversations/useAiStream";
import { CreateReleaseDialog } from "@/features/tags/CreateReleaseDialog";
import { forgeReleaseCreate } from "@/lib/git/api";
import { ACT_PENDING_REASON } from "@/lib/offline-writes";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { originNoteFor } from "@/lib/stores/notifications";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
// The dialog's shell reads never answer; only the create is driven.
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(() => new Promise(() => undefined)),
  gitStatus: vi.fn(() => new Promise(() => undefined)),
  gitWorkingLineStats: vi.fn(() => new Promise(() => undefined)),
  gitBranches: vi.fn(() => new Promise(() => undefined)),
  gitRemoteBranches: vi.fn(() => new Promise(() => undefined)),
  gitRecentCommits: vi.fn(() => new Promise(() => undefined)),
  gitListTags: vi.fn(() => new Promise(() => undefined)),
  forgeReleaseCreate: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sonner")>()),
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}));

const REPO = "C:/repo";
const URL_1 = "https://github.com/owner/repo/releases/tag/v1.0.0";

function deferred() {
  let resolve: (v: string) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const control = {
  setOpen: (_open: boolean) => undefined as void,
  setTag: (_tag: string) => undefined as void,
};

function Host() {
  const [open, setOpen] = useState(true);
  const [tag, setTag] = useState("v1.0.0");
  control.setOpen = setOpen;
  control.setTag = setTag;
  return (
    <CreateReleaseDialog
      repoPath={REPO}
      open={open}
      onOpenChange={setOpen}
      initialTag={tag}
    />
  );
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Host />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  // The tag host's precondition for the settle's close: its selected tag.
  useUiStore.setState({ repoPath: REPO, selectedTag: { tag: "v1.0.0" } });
  vi.mocked(forgeReleaseCreate).mockReset();
});

afterAll(() => {
  expect(unmockedCommands).toEqual([]);
});

// The running create's spinner joins the button's name.
const createButton = () =>
  screen.getByRole("button", { name: /Publish release$/ });
const titleBox = () =>
  screen.getByRole("textbox", { name: "Title (optional)" });
const form = () => titleBox().closest("form") as HTMLFormElement;
const tick = () => act(() => new Promise((r) => setTimeout(r, 20)));

async function fillTitle(text: string) {
  fireEvent.change(titleBox(), { target: { value: text } });
  await waitFor(() =>
    expect(createButton()).not.toHaveAttribute("aria-disabled", "true"),
  );
}

function expectHeld() {
  const button = createButton();
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(button).toHaveAccessibleDescription(new RegExp(ACT_PENDING_REASON));
}

/** Draft A's create runs; a plain reopen seeds draft B, whose create starts too. */
async function twoCreatesRunning() {
  const a = deferred();
  const b = deferred();
  vi.mocked(forgeReleaseCreate)
    .mockReturnValueOnce(a.promise)
    .mockReturnValueOnce(b.promise);
  mount();
  await fillTitle("A title");
  fireEvent.click(createButton());
  await waitFor(() => expect(forgeReleaseCreate).toHaveBeenCalledTimes(1));
  act(() => control.setOpen(false));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  act(() => control.setOpen(true));
  await waitFor(() => expect(titleBox()).toHaveValue(""));
  await fillTitle("B title");
  fireEvent.click(createButton());
  await waitFor(() => expect(forgeReleaseCreate).toHaveBeenCalledTimes(2));
  return { a, b };
}

describe("New release: one create per draft", () => {
  it("starts nothing from a native submit while its create runs (T16)", async () => {
    const a = deferred();
    vi.mocked(forgeReleaseCreate).mockReturnValueOnce(a.promise);
    mount();
    await fillTitle("A title");
    fireEvent.click(createButton());
    await waitFor(() => expect(forgeReleaseCreate).toHaveBeenCalledTimes(1));
    fireEvent.submit(form());
    await tick();
    expect(forgeReleaseCreate).toHaveBeenCalledTimes(1);
    expectHeld();
    expect(within(createButton()).getByRole("status")).toBeInTheDocument();
    await act(async () => a.resolve(URL_1));
  });

  it("re-arms the same draft when its create fails", async () => {
    const a = deferred();
    vi.mocked(forgeReleaseCreate)
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(new Promise(() => undefined));
    vi.mocked(toast.error).mockClear();
    mount();
    await fillTitle("A title");
    fireEvent.click(createButton());
    await waitFor(() => expect(forgeReleaseCreate).toHaveBeenCalledTimes(1));
    await act(async () => a.reject(new Error("create refused")));
    await waitFor(() =>
      expect(createButton()).not.toHaveAttribute("aria-disabled", "true"),
    );
    expect(within(createButton()).queryByRole("status")).toBeNull();
    expect(toast.error).toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(titleBox()).toHaveValue("A title");
    fireEvent.click(createButton());
    await waitFor(() => expect(forgeReleaseCreate).toHaveBeenCalledTimes(2));
  });

  it("holds the newer draft and its notes generator after the older create settles (T17)", async () => {
    const { a, b } = await twoCreatesRunning();
    await act(async () => a.resolve(URL_1));
    await tick();
    expectHeld();
    expect(within(createButton()).getByRole("status")).toBeInTheDocument();
    const generate = screen.getByRole("button", { name: /Generate notes/ });
    expect(generate).toHaveAttribute("aria-disabled", "true");
    expect(generate).toHaveAccessibleDescription(
      new RegExp(CREATE_PENDING_GENERATE_REASON),
    );
    fireEvent.click(createButton());
    fireEvent.submit(form());
    await tick();
    expect(forgeReleaseCreate).toHaveBeenCalledTimes(2);
    await act(async () => b.resolve(URL_1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("lets a create settling after a tag switch leave the dialog open (T18)", async () => {
    const a = deferred();
    vi.mocked(forgeReleaseCreate).mockReturnValueOnce(a.promise);
    mount();
    await fillTitle("A title");
    fireEvent.click(createButton());
    await waitFor(() => expect(forgeReleaseCreate).toHaveBeenCalledTimes(1));
    // No open transition, so no seed runs; the store's selected tag stays put.
    act(() => control.setTag("v1.1.0"));
    await act(async () => a.resolve(URL_1));
    await tick();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("New release: created with its link unknown (T28)", () => {
  /** Publishes one draft whose create resolves `url`, `before` running first. */
  async function publishAs(url: string, before: () => void = () => undefined) {
    const a = deferred();
    vi.mocked(forgeReleaseCreate).mockReturnValueOnce(a.promise);
    vi.mocked(toast.success).mockClear();
    mount();
    await fillTitle("A title");
    fireEvent.click(createButton());
    await waitFor(() => expect(forgeReleaseCreate).toHaveBeenCalledTimes(1));
    act(before);
    await act(async () => a.resolve(url));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    return vi.mocked(toast.success).mock.calls[0] as [
      string,
      { description?: unknown; action?: unknown } | undefined,
    ];
  }

  it("offers no description or View while the repo is on screen", async () => {
    const [title, options] = await publishAs("");
    expect(title).toBe("Released v1.0.0");
    expect(options?.description).toBeUndefined();
    expect(options?.action).toBeUndefined();
  });

  it("names only the origin when it settles in another repository", async () => {
    let note: string | undefined;
    const [title, options] = await publishAs("", () => {
      useUiStore.setState({ repoPath: "C:/other" });
      note = originNoteFor(REPO);
    });
    expect(note).toBeTruthy();
    expect(title).toBe("Released v1.0.0");
    expect(options?.description).toBe(note);
    expect(options?.action).toBeUndefined();
  });

  it("keeps the link and View when the URL came back", async () => {
    const [, options] = await publishAs(URL_1);
    expect(options?.description).toBe(URL_1);
    expect(options?.action).toMatchObject({ label: "View" });
  });
});
