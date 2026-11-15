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
import { CreateDiscussionDialog } from "@/features/discussions/CreateDiscussionDialog";
import { ghDiscussionCategories, ghDiscussionCreate } from "@/lib/git/api";
import { ACT_PENDING_REASON } from "@/lib/offline-writes";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(() => new Promise(() => undefined)),
  // The scope hint's read never answers.
  ghTokenScopes: vi.fn(() => new Promise(() => undefined)),
  ghDiscussionCategories: vi.fn(),
  ghDiscussionCreate: vi.fn(),
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
const URL_7 = "https://github.com/owner/repo/discussions/7";

type Created = Awaited<ReturnType<typeof ghDiscussionCreate>>;

function deferred() {
  let resolve: (v: Created) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<Created>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const control = { setOpen: (_open: boolean) => undefined as void };

function Host() {
  const [open, setOpen] = useState(true);
  control.setOpen = setOpen;
  return (
    <CreateDiscussionDialog
      repoPath={REPO}
      open={open}
      onOpenChange={setOpen}
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
  useUiStore.setState({ repoPath: REPO, selectDiscussion: vi.fn() });
  vi.mocked(ghDiscussionCategories).mockReset();
  vi.mocked(ghDiscussionCategories).mockResolvedValue({
    repoId: "R_1",
    hasDiscussionsEnabled: true,
    categories: [
      { id: "C_1", name: "General", emoji: "", isAnswerable: false },
    ],
  });
  vi.mocked(ghDiscussionCreate).mockReset();
});

afterAll(() => {
  expect(unmockedCommands).toEqual([]);
});

// The running create's spinner joins the button's name.
const createButton = () =>
  screen.getByRole("button", { name: /Start discussion$/ });
const titleBox = () => screen.getByRole("textbox", { name: "Title" });
const form = () => titleBox().closest("form") as HTMLFormElement;
const tick = () => act(() => new Promise((r) => setTimeout(r, 20)));

async function fillTitle(text: string) {
  fireEvent.change(titleBox(), { target: { value: text } });
  // Create is live once the category list has seeded the default category.
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
  vi.mocked(ghDiscussionCreate)
    .mockReturnValueOnce(a.promise)
    .mockReturnValueOnce(b.promise);
  mount();
  await fillTitle("A title");
  fireEvent.click(createButton());
  await waitFor(() => expect(ghDiscussionCreate).toHaveBeenCalledTimes(1));
  act(() => control.setOpen(false));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  act(() => control.setOpen(true));
  expect(await screen.findByRole("textbox", { name: "Title" })).toHaveValue("");
  await fillTitle("B title");
  fireEvent.click(createButton());
  await waitFor(() => expect(ghDiscussionCreate).toHaveBeenCalledTimes(2));
  return { a, b };
}

describe("New discussion: one create per draft", () => {
  it("starts nothing from a native submit while its create runs (T13)", async () => {
    const a = deferred();
    vi.mocked(ghDiscussionCreate).mockReturnValueOnce(a.promise);
    mount();
    await fillTitle("A title");
    fireEvent.click(createButton());
    await waitFor(() => expect(ghDiscussionCreate).toHaveBeenCalledTimes(1));
    fireEvent.submit(form());
    await tick();
    expect(ghDiscussionCreate).toHaveBeenCalledTimes(1);
    expectHeld();
    await act(async () => a.resolve({ number: 7, url: URL_7 }));
  });

  it("holds the newer draft after the older create settles (T14)", async () => {
    const { a, b } = await twoCreatesRunning();
    await act(async () => a.resolve({ number: 7, url: URL_7 }));
    await tick();
    expectHeld();
    expect(within(createButton()).getByRole("status")).toBeInTheDocument();
    fireEvent.click(createButton());
    fireEvent.submit(form());
    await tick();
    expect(ghDiscussionCreate).toHaveBeenCalledTimes(2);
    await act(async () => b.resolve({ number: 8, url: URL_7 }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the newer draft held when the older create fails, and re-arms on its own failure (T15)", async () => {
    const { a, b } = await twoCreatesRunning();
    await act(async () => a.reject(new Error("create refused")));
    await tick();
    expectHeld();
    fireEvent.submit(form());
    await tick();
    expect(ghDiscussionCreate).toHaveBeenCalledTimes(2);
    await act(async () => b.reject(new Error("create refused")));
    await waitFor(() =>
      expect(createButton()).not.toHaveAttribute("aria-disabled", "true"),
    );
    expect(titleBox()).toHaveValue("B title");
  });
});

describe("New discussion: created with its number or link unknown", () => {
  /** Creates one draft that resolves `created`; returns the success toast. */
  async function createAs(created: Created) {
    vi.mocked(ghDiscussionCreate).mockResolvedValueOnce(created);
    mount();
    await fillTitle("A title");
    fireEvent.click(createButton());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toast.success).toHaveBeenCalledTimes(1);
    return vi.mocked(toast.success).mock.calls[0] as [
      string,
      { description?: unknown; action?: unknown } | undefined,
    ];
  }

  it("says it opened the discussion, offering nothing it can't link (T27)", async () => {
    const [title, options] = await createAs({ number: 0, url: "" });
    expect(title).toBe("Opened discussion");
    expect(options?.description).toBeUndefined();
    expect(options?.action).toBeUndefined();
    expect(JSON.stringify(vi.mocked(toast.success).mock.calls)).not.toContain(
      "#0",
    );
    expect(useUiStore.getState().selectDiscussion).not.toHaveBeenCalled();
  });

  it("links a numberless discussion whose URL came back (T27b)", async () => {
    const [title, options] = await createAs({ number: 0, url: URL_7 });
    expect(title).toBe("Opened discussion");
    expect(options?.description).toBe(URL_7);
    expect(options?.action).toMatchObject({ label: "View" });
    expect(useUiStore.getState().selectDiscussion).not.toHaveBeenCalled();
  });

  it("keeps the numbered toast and selection as before (T27b)", async () => {
    const [title, options] = await createAs({ number: 12, url: URL_7 });
    expect(title).toBe("Opened discussion #12");
    expect(options?.description).toBe(URL_7);
    expect(options?.action).toMatchObject({ label: "View" });
    expect(useUiStore.getState().selectDiscussion).toHaveBeenCalledWith({
      number: 12,
    });
  });
});
