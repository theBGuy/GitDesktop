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
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CREATE_PENDING_GENERATE_REASON } from "@/features/conversations/useAiStream";
import { CreateLocalIssueDialog } from "@/features/issues/CreateLocalIssueDialog";
import { createLocalIssue } from "@/lib/issues/local";
import { ACT_PENDING_REASON } from "@/lib/offline-writes";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("@/lib/issues/local", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/issues/local")>()),
  createLocalIssue: vi.fn(),
}));
// Only the drafter's running flag matters here, and nothing generates.
vi.mock("@/features/issues/useGenerateIssueDraft", () => ({
  useGenerateIssueDraft: () => ({
    generate: vi.fn(async () => undefined),
    cancel: vi.fn(),
    generating: false,
  }),
}));
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

type Created = Awaited<ReturnType<typeof createLocalIssue>>;

function deferred() {
  let resolve: (v: Created) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<Created>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const issue = (id: string, title: string) =>
  ({
    id,
    title,
    body: "",
    status: "open",
    labels: [],
    comments: [],
    createdAt: new Date().toISOString(),
  }) as unknown as Created;

const control = { setOpen: (_open: boolean) => undefined as void };

function Host() {
  const [open, setOpen] = useState(true);
  control.setOpen = setOpen;
  return (
    <CreateLocalIssueDialog
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
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  useUiStore.setState({ repoPath: REPO, selectIssue: vi.fn() });
  vi.mocked(createLocalIssue).mockReset();
});

afterAll(() => {
  expect(unmockedCommands).toEqual([]);
});

// The running create's spinner joins the button's name.
const createButton = () =>
  screen.getByRole("button", { name: /Create local issue$/ });
const titleBox = () => screen.getByRole("textbox", { name: "Title" });
const form = () => titleBox().closest("form") as HTMLFormElement;
const tick = () => act(() => new Promise((r) => setTimeout(r, 20)));

/** Held with its reason: focusable, so never natively disabled. */
function expectCreateHeld() {
  const button = createButton();
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(button).not.toHaveAttribute("disabled");
  expect(button).toHaveAccessibleDescription(ACT_PENDING_REASON);
  expect(within(button).getByRole("status")).toBeInTheDocument();
}

/** Click, focused Enter and a native submit on the held button. */
function pressHeldCreate() {
  const button = createButton();
  act(() => button.focus());
  expect(button).toHaveFocus();
  fireEvent.keyDown(button, { key: "Enter" });
  fireEvent.click(button);
  fireEvent.submit(form());
}

async function fillTitle(text: string) {
  fireEvent.change(titleBox(), { target: { value: text } });
  await waitFor(() => expect(createButton()).toBeEnabled());
}

/** Draft A's create runs; a plain reopen seeds draft B, whose create starts too. */
async function twoCreatesRunning() {
  const a = deferred();
  const b = deferred();
  vi.mocked(createLocalIssue)
    .mockReturnValueOnce(a.promise)
    .mockReturnValueOnce(b.promise);
  mount();
  await fillTitle("A title");
  fireEvent.click(createButton());
  await waitFor(() => expect(createLocalIssue).toHaveBeenCalledTimes(1));
  act(() => control.setOpen(false));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  act(() => control.setOpen(true));
  expect(await screen.findByRole("textbox", { name: "Title" })).toHaveValue("");
  await fillTitle("B title");
  fireEvent.click(createButton());
  await waitFor(() => expect(createLocalIssue).toHaveBeenCalledTimes(2));
  return { a, b };
}

describe("New local issue: one create per draft", () => {
  it("holds Create with its reason and starts nothing more while its create runs (T19)", async () => {
    const a = deferred();
    vi.mocked(createLocalIssue).mockReturnValueOnce(a.promise);
    mount();
    await fillTitle("A title");
    fireEvent.click(createButton());
    await waitFor(() => expect(createLocalIssue).toHaveBeenCalledTimes(1));
    expectCreateHeld();
    pressHeldCreate();
    await tick();
    expect(createLocalIssue).toHaveBeenCalledTimes(1);
    expectCreateHeld();
    await act(async () => a.resolve(issue("i-1", "A title")));
  });

  it("holds the newer draft after the older create settles (T20)", async () => {
    const { a, b } = await twoCreatesRunning();
    await act(async () => a.resolve(issue("i-1", "A title")));
    await tick();
    // Form-core's own flag cleared with the older settle: only the hold holds.
    expectCreateHeld();
    const draftWithAi = screen.getByRole("button", { name: /Draft with AI/ });
    expect(draftWithAi).toHaveAttribute("aria-disabled", "true");
    expect(draftWithAi).toHaveAccessibleDescription(
      new RegExp(CREATE_PENDING_GENERATE_REASON),
    );
    pressHeldCreate();
    await tick();
    expect(createLocalIssue).toHaveBeenCalledTimes(2);
    await act(async () => b.resolve(issue("i-2", "B title")));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the newer draft held when the older create fails, and re-arms on its own failure (T21)", async () => {
    const { a, b } = await twoCreatesRunning();
    await act(async () => a.reject(new Error("create refused")));
    await tick();
    expectCreateHeld();
    fireEvent.submit(form());
    await tick();
    expect(createLocalIssue).toHaveBeenCalledTimes(2);
    await act(async () => b.reject(new Error("create refused")));
    // A held button is never natively disabled, so the release shows on aria-disabled.
    await waitFor(() =>
      expect(createButton()).not.toHaveAttribute("aria-disabled"),
    );
    expect(createButton()).toBeEnabled();
    expect(createButton()).not.toHaveAccessibleDescription();
    expect(titleBox()).toHaveValue("B title");
  });
});
