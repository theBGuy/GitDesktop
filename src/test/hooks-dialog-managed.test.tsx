import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
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
import { HooksDialog } from "@/features/hooks/HooksDialog";
import {
  gitHookDelete,
  gitHookRead,
  gitHookSetEnabled,
  gitHooksList,
  gitHookWrite,
} from "@/lib/git/api";
import type { HookEntry, HooksInfo } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitHooksList: vi.fn(),
  gitHookRead: vi.fn(),
  gitHookWrite: vi.fn(),
  gitHookSetEnabled: vi.fn(),
  gitHookDelete: vi.fn(),
}));
// CodeMirror stands in as a textarea: the dialog only reads value/onChange.
vi.mock("@/components/code-editor", () => ({
  CodeEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (v: string) => void;
  }) => (
    <textarea
      aria-label="Hook script"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
vi.mock("sonner", () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    dismiss: vi.fn(),
  },
}));

const REPO = "C:/repos/guarded";
const SCRIPT = "#!/bin/sh\n# GitDesktop keep-local guard\n";
const LABEL = "Managed by GitDesktop";
const LEAD =
  "This pre-push hook is the terminal push guard GitDesktop installed to stop git push for branches marked Keep local.";
const CONFIRMS = {
  save: {
    title: "Save your edit to the terminal push guard?",
    body: `${LEAD} Saving replaces its script with your edit, so terminal pushes of those branches are stopped only if your edit keeps the guard's check.`,
    confirmLabel: "Save",
    confirmVariant: "default",
  },
  disable: {
    title: "Disable the terminal push guard?",
    body: `${LEAD} While it is disabled, git push in a terminal can publish those branches. GitDesktop still refuses to push them itself.`,
    confirmLabel: "Disable",
    confirmVariant: "destructive",
  },
  delete: {
    title: "Delete the terminal push guard?",
    body: `${LEAD} Deleting it moves the file to the recycle bin, and git push in a terminal can then publish those branches. GitDesktop still refuses to push them itself, and you can install the guard again from a kept-local branch's menu.`,
    confirmLabel: "Delete",
    confirmVariant: "destructive",
  },
} as const;

const hook = (
  name: string,
  state: HookEntry["state"],
  managed: boolean,
): HookEntry => ({
  name,
  description: `${name} hook`,
  state,
  hasSample: false,
  managed,
});

/** The pre-push entry the backend lists; the post-Disable flip is A2.7's. */
let prePush: HookEntry;

function info(): HooksInfo {
  return {
    hooksPath: `${REPO}/.git/hooks`,
    customHooksPath: false,
    manager: null,
    managerConfig: null,
    entries: [prePush, hook("pre-commit", "active", false)],
  };
}

beforeEach(() => {
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
  prePush = hook("pre-push", "active", true);
  vi.mocked(gitHooksList).mockImplementation(async () => info());
  vi.mocked(gitHookRead).mockImplementation(async () => SCRIPT);
  vi.mocked(gitHookWrite).mockImplementation(async () => undefined);
  vi.mocked(gitHookSetEnabled).mockImplementation(async () => undefined);
  vi.mocked(gitHookDelete).mockImplementation(async () => undefined);
  useUiStore.setState(useUiStore.getInitialState(), true);
  useUiStore.setState({ repoPath: REPO });
  useConfirm.setState({ request: null, requestHold: null });
});

afterEach(() => useConfirm.getState().answer(false));

afterAll(() => expect(unmockedCommands).toEqual([]));

function renderDialog(withHost = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <HooksDialog repoPath={REPO} open onOpenChange={() => undefined} />
      {withHost && <ConfirmDialogHost />}
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), client };
}

/** A hook's list row; its name runs into the label and chip in jsdom, which
 *  lays out no flex items, so the row is found by its hook. */
const row = (name: string) => {
  const el = document.querySelector<HTMLElement>(`[data-hook="${name}"]`);
  if (!el) throw new Error(`no row for ${name}`);
  return el;
};

/** Selects a hook and waits for its script to seed the editor. */
async function select(user: ReturnType<typeof userEvent.setup>, name: string) {
  await waitFor(() => row(name));
  await user.click(row(name));
  await waitFor(() =>
    expect(screen.getByLabelText("Hook script")).toHaveValue(SCRIPT),
  );
}

const request = () => useConfirm.getState().request;

function expectAsked(action: keyof typeof CONFIRMS) {
  const r = request();
  expect(r).not.toBeNull();
  expect(r?.title).toBe(CONFIRMS[action].title);
  expect(r?.body).toBe(CONFIRMS[action].body);
  expect(r?.confirmLabel).toBe(CONFIRMS[action].confirmLabel);
  expect(r?.confirmVariant).toBe(CONFIRMS[action].confirmVariant);
}

const answer = (ok: boolean) =>
  act(async () => useConfirm.getState().answer(ok));

describe("the managed pre-push guard in the Hooks dialog", () => {
  it("A2.1: labels only the managed row, inside its accessible name", async () => {
    renderDialog();
    await waitFor(() => row("pre-push"));
    expect(row("pre-push")).toHaveAccessibleName(
      expect.stringContaining(LABEL),
    );
    expect(row("pre-commit")).not.toHaveAccessibleName(
      expect.stringContaining(LABEL),
    );
    expect(screen.getAllByText(LABEL)).toHaveLength(1);
  });

  it("A2.2: Save asks first, writes nothing on Cancel and the draft at press on Confirm", async () => {
    const { user } = renderDialog();
    await select(user, "pre-push");
    const editor = screen.getByLabelText("Hook script");
    await user.clear(editor);
    await user.type(editor, "#!/bin/sh{Enter}exit 0");
    const draft = "#!/bin/sh\nexit 0";
    await user.click(screen.getByRole("button", { name: "Save" }));
    expectAsked("save");
    await answer(false);
    expect(gitHookWrite).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expectAsked("save");
    await answer(true);
    await waitFor(() =>
      expect(gitHookWrite).toHaveBeenCalledWith(REPO, "pre-push", draft),
    );
    expect(gitHookWrite).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("Saved the pre-push hook");
  });

  it("A2.2: Disable asks first and writes nothing on Cancel", async () => {
    const { user } = renderDialog();
    await select(user, "pre-push");
    await user.click(screen.getByRole("button", { name: "Disable" }));
    expectAsked("disable");
    await answer(false);
    expect(gitHookSetEnabled).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Disable" }));
    await answer(true);
    await waitFor(() =>
      expect(gitHookSetEnabled).toHaveBeenCalledWith(REPO, "pre-push", false),
    );
    expect(gitHookSetEnabled).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("Disabled pre-push");
  });

  it("A2.2/A2.3: Delete asks the shared confirm instead of the inline swap", async () => {
    const { user } = renderDialog();
    await select(user, "pre-push");
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    expectAsked("delete");
    expect(screen.queryByText("Recycle bin?")).not.toBeInTheDocument();
    await answer(false);
    expect(gitHookDelete).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    await answer(true);
    await waitFor(() =>
      expect(gitHookDelete).toHaveBeenCalledWith(REPO, "pre-push"),
    );
    expect(gitHookDelete).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("Deleted pre-push");
    expect(screen.queryByText("Recycle bin?")).not.toBeInTheDocument();
  });

  it("A2.3: an unmanaged hook saves and disables at once and deletes through the inline swap", async () => {
    const { user } = renderDialog();
    await select(user, "pre-commit");
    await user.type(screen.getByLabelText("Hook script"), "true");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(gitHookWrite).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Disable" }));
    await waitFor(() =>
      expect(gitHookSetEnabled).toHaveBeenCalledWith(REPO, "pre-commit", false),
    );
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    expect(screen.getByText("Recycle bin?")).toBeInTheDocument();
    expect(request()).toBeNull();
  });

  it("A2.4: a managed delete settling after the confirm closed lands on its row", async () => {
    let land: () => void = () => undefined;
    vi.mocked(gitHookDelete).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          land = resolve;
        }),
    );
    const { user } = renderDialog(true);
    await select(user, "pre-push");
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    const confirm = await screen.findByRole("dialog", {
      name: CONFIRMS.delete.title,
    });
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(gitHookDelete).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: CONFIRMS.delete.title }),
      ).not.toBeInTheDocument(),
    );
    await act(async () => land());
    await waitFor(() => expect(document.activeElement).toBe(row("pre-push")));
  });

  it("A2.4: a managed delete settling while the confirm still closes lands on its row", async () => {
    const { user } = renderDialog(true);
    await select(user, "pre-push");
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    const confirm = await screen.findByRole("dialog", {
      name: CONFIRMS.delete.title,
    });
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Deleted pre-push"),
    );
    await waitFor(() => expect(document.activeElement).toBe(row("pre-push")));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: CONFIRMS.delete.title }),
      ).not.toBeInTheDocument(),
    );
    expect(document.activeElement).toBe(row("pre-push"));
  });

  it("A2.7: a disabled guard reads as an ordinary hook, and re-enabling it restores the label and the confirms", async () => {
    // The backend lists a disabled guard as unmanaged and a re-enabled one
    // (same bytes, marker intact) as active and managed again.
    vi.mocked(gitHooksList).mockImplementation(async () =>
      vi.mocked(gitHookSetEnabled).mock.lastCall?.[2] === false
        ? {
            ...info(),
            entries: info().entries.map((e) =>
              e.name === "pre-push" ? hook("pre-push", "disabled", false) : e,
            ),
          }
        : info(),
    );
    const { user } = renderDialog();
    await select(user, "pre-push");
    await user.click(screen.getByRole("button", { name: "Disable" }));
    await answer(true);
    await screen.findByRole("button", { name: "Enable" });
    await waitFor(() =>
      expect(screen.queryByText(LABEL)).not.toBeInTheDocument(),
    );
    await user.type(screen.getByLabelText("Hook script"), "true");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(gitHookWrite).toHaveBeenCalledTimes(1));
    expect(request()).toBeNull();
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    expect(screen.getByText("Recycle bin?")).toBeInTheDocument();
    expect(request()).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Enable" }));
    await waitFor(() =>
      expect(gitHookSetEnabled).toHaveBeenLastCalledWith(
        REPO,
        "pre-push",
        true,
      ),
    );
    expect(request()).toBeNull();
    await screen.findByText(LABEL);
    await user.type(screen.getByLabelText("Hook script"), "x");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expectAsked("save");
    await answer(false);
    expect(gitHookWrite).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    expectAsked("delete");
    expect(screen.queryByText("Recycle bin?")).not.toBeInTheDocument();
    await answer(false);
    expect(gitHookDelete).not.toHaveBeenCalled();
  });

  it("an open inline delete gives way when a re-read turns the guard managed", async () => {
    prePush = hook("pre-push", "disabled", false);
    const { user, client } = renderDialog();
    await select(user, "pre-push");
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    expect(screen.getByText("Recycle bin?")).toBeInTheDocument();
    prePush = hook("pre-push", "active", true);
    await act(() =>
      client.invalidateQueries({ queryKey: ["repo", REPO, "hooks"] }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Recycle bin?")).not.toBeInTheDocument(),
    );
    expect(gitHookDelete).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    expectAsked("delete");
    expect(screen.queryByText("Recycle bin?")).not.toBeInTheDocument();
    await answer(false);
    expect(gitHookDelete).not.toHaveBeenCalled();
    // Back to unmanaged: the dropped swap stays dropped until a fresh press.
    prePush = hook("pre-push", "disabled", false);
    await act(() =>
      client.invalidateQueries({ queryKey: ["repo", REPO, "hooks"] }),
    );
    await screen.findByRole("button", { name: "Enable" });
    expect(screen.queryByText("Recycle bin?")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    expect(screen.getByText("Recycle bin?")).toBeInTheDocument();
    expect(request()).toBeNull();
    expect(gitHookDelete).not.toHaveBeenCalled();
  });

  it("an open inline delete still works when a re-read turns the hook unmanaged", async () => {
    prePush = hook("pre-push", "disabled", false);
    const { user, client } = renderDialog();
    await select(user, "pre-push");
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    expect(screen.getByText("Recycle bin?")).toBeInTheDocument();
    prePush = hook("pre-push", "active", false);
    await act(() =>
      client.invalidateQueries({ queryKey: ["repo", REPO, "hooks"] }),
    );
    expect(screen.getByText("Recycle bin?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(gitHookDelete).toHaveBeenCalledWith(REPO, "pre-push"),
    );
    expect(request()).toBeNull();
  });

  it("A2.8: an active pre-push the app doesn't manage gets no label and no confirm", async () => {
    prePush = hook("pre-push", "active", false);
    const { user } = renderDialog();
    await select(user, "pre-push");
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Hook script"), "true");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(gitHookWrite).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(gitHookSetEnabled).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    expect(screen.getByText("Recycle bin?")).toBeInTheDocument();
    expect(request()).toBeNull();
  });

  it("A2.8: a list answered without the managed field reads as unmanaged", async () => {
    const { managed: _, ...bare } = hook("pre-push", "active", true);
    prePush = bare as HookEntry;
    const { user } = renderDialog();
    await select(user, "pre-push");
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(gitHookSetEnabled).toHaveBeenCalledTimes(1));
    expect(request()).toBeNull();
  });
});

describe("the managed delete's landing waits on a clock, not a frame count", () => {
  /** Frames and the clock both run by hand: a fast display packs many frames
   *  into the confirm's close, so the bound must be time. */
  function manualFrames() {
    let clock = 0;
    let queue: FrameRequestCallback[] = [];
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const raf = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb) => queue.push(cb));
    const caf = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => undefined);
    return {
      /** Runs `count` frames `stepMs` apart. */
      run(count: number, stepMs: number) {
        act(() => {
          for (let i = 0; i < count; i++) {
            clock += stepMs;
            const due = queue;
            queue = [];
            for (const cb of due) cb(clock);
          }
        });
      },
      pending: () => queue.length,
      restore() {
        now.mockRestore();
        raf.mockRestore();
        caf.mockRestore();
      },
    };
  }

  /** Deletes the guard while focus sits outside the Hooks dialog, standing in
   *  for the shared confirm still closing over it. */
  async function deleteWithFocusOutside() {
    const outside = document.createElement("button");
    document.body.append(outside);
    const { user } = renderDialog();
    await select(user, "pre-push");
    const frames = manualFrames();
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    expectAsked("delete");
    act(() => outside.focus());
    await answer(true);
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Deleted pre-push"),
    );
    expect(document.activeElement).toBe(outside);
    return { outside, frames };
  }

  it("lands when focus frees up late but inside the deadline", async () => {
    const { outside, frames } = await deleteWithFocusOutside();
    try {
      // 120 frames at 3 ms: far past any frame count, well inside 500 ms.
      frames.run(120, 3);
      expect(document.activeElement).toBe(outside);
      act(() => outside.blur());
      frames.run(1, 3);
      expect(document.activeElement).toBe(row("pre-push"));
    } finally {
      frames.restore();
      outside.remove();
    }
  });

  it("stops waiting once the deadline passes", async () => {
    const { outside, frames } = await deleteWithFocusOutside();
    try {
      frames.run(60, 10);
      act(() => outside.blur());
      frames.run(5, 10);
      expect(document.activeElement).toBe(document.body);
      expect(frames.pending()).toBe(0);
    } finally {
      frames.restore();
      outside.remove();
    }
  });
});
