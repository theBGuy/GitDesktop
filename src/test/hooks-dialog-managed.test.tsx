import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
import { HOOK_TEMPLATES } from "@/features/hooks/templates";
import { presentError } from "@/lib/error-summary";
import {
  gitHookDelete,
  gitHookRead,
  gitHookSetEnabled,
  gitHooksList,
  gitHookWrite,
  type HookDeleteOutcome,
  type HookWriteOutcome,
} from "@/lib/git/api";
import type { HookEntry, HooksInfo } from "@/lib/git/types";
import { ACT_PENDING_REASON } from "@/lib/offline-writes";
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
/** Which element stands in for CodeMirror: a textarea, or an `<input>` the
 *  dialog's focus landing doesn't take for the editor's text input. */
const editorMock = vi.hoisted(() => ({
  tag: "textarea" as "textarea" | "input",
}));
// CodeMirror stands in as a textarea: the dialog only reads value/onChange/readOnly.
vi.mock("@/components/code-editor", () => ({
  CodeEditor: ({
    value,
    onChange,
    readOnly,
  }: {
    value: string;
    onChange: (v: string) => void;
    readOnly?: boolean;
  }) => {
    const Tag = editorMock.tag;
    return (
      <Tag
        aria-label="Hook script"
        value={value}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  },
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
const WRITTEN: HookWriteOutcome = { status: "written", managed: false };
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
  vi.mocked(gitHookWrite).mockImplementation(async () => WRITTEN);
  vi.mocked(gitHookSetEnabled).mockImplementation(async () => WRITTEN);
  vi.mocked(gitHookDelete).mockImplementation(async () => ({
    status: "deleted",
  }));
  useUiStore.setState(useUiStore.getInitialState(), true);
  useUiStore.setState({ repoPath: REPO });
  useConfirm.setState({ request: null, requestHold: null });
  editorMock.tag = "textarea";
});

afterEach(() => useConfirm.getState().answer(false));

afterAll(() => expect(unmockedCommands).toEqual([]));

function renderDialog(
  withHost = false,
  onOpenChange: (open: boolean) => void = () => undefined,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let shown = { open: true, repo: REPO };
  const tree = () => (
    <QueryClientProvider client={client}>
      <HooksDialog
        repoPath={shown.repo}
        open={shown.open}
        onOpenChange={onOpenChange}
      />
      {withHost && <ConfirmDialogHost />}
    </QueryClientProvider>
  );
  const { rerender } = render(tree());
  return {
    user: userEvent.setup(),
    client,
    /** Sets the dialog's `open` prop the way its parent would. */
    setOpen: (open: boolean) => {
      shown = { ...shown, open };
      rerender(tree());
    },
    /** Switches the open repository under the dialog, as RepositoryView does. */
    setRepo: (repo: string) => {
      shown = { ...shown, repo };
      act(() => useUiStore.setState({ repoPath: repo }));
      rerender(tree());
    },
  };
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
      expect(gitHookWrite).toHaveBeenCalledWith(REPO, "pre-push", draft, true),
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
      expect(gitHookSetEnabled).toHaveBeenCalledWith(
        REPO,
        "pre-push",
        false,
        true,
      ),
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
      expect(gitHookDelete).toHaveBeenCalledWith(REPO, "pre-push", true),
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
      expect(gitHookSetEnabled).toHaveBeenCalledWith(
        REPO,
        "pre-commit",
        false,
        false,
      ),
    );
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    expect(screen.getByText("Recycle bin?")).toBeInTheDocument();
    expect(request()).toBeNull();
  });

  // The confirm's own Escape handling stops the key before the Hooks dialog's
  // document listener, so one press closes only the prompt.
  it.each([
    ["save", "Save", gitHookWrite],
    ["disable", "Disable", gitHookSetEnabled],
    ["delete", "Delete…", gitHookDelete],
  ] as const)(
    "Escape on the managed %s confirm cancels it and keeps the Hooks dialog",
    async (action, button, write) => {
      const onOpenChange = vi.fn();
      const { user } = renderDialog(true, onOpenChange);
      await select(user, "pre-push");
      const editor = screen.getByLabelText("Hook script");
      await user.type(editor, "true");
      const draft = (editor as HTMLTextAreaElement).value;
      expect(draft).not.toBe(SCRIPT);
      await user.click(screen.getByRole("button", { name: button }));
      const confirm = await screen.findByRole("dialog", {
        name: CONFIRMS[action].title,
      });
      await waitFor(() =>
        expect(confirm.contains(document.activeElement)).toBe(true),
      );
      await user.keyboard("{Escape}");
      await waitFor(() => expect(request()).toBeNull());
      expect(write).not.toHaveBeenCalled();
      // Base UI passes event details after the flag, so match the first argument.
      expect(onOpenChange.mock.calls.map((c) => c[0])).not.toContain(false);
      expect(
        screen.getByRole("dialog", { name: "Git hooks" }),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Hook script")).toHaveValue(draft);
    },
  );

  it("A2.4: a managed delete settling after the confirm closed lands on its row", async () => {
    let land: () => void = () => undefined;
    vi.mocked(gitHookDelete).mockImplementation(
      () =>
        new Promise<HookDeleteOutcome>((resolve) => {
          land = () => resolve({ status: "deleted" });
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
        false,
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
      expect(gitHookDelete).toHaveBeenCalledWith(REPO, "pre-push", false),
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
    // An absent field must reach the backend as false, never as an omitted key.
    await inlineDelete(user);
    await waitFor(() =>
      expect(gitHookDelete).toHaveBeenCalledWith(REPO, "pre-push", false),
    );
    expect(request()).toBeNull();
  });
});

const NOTICE = "pre-push changed since this list loaded — nothing was deleted.";

/** Holds the next delete until the test answers it. */
function deferDelete() {
  let land: (outcome: HookDeleteOutcome) => void = () => undefined;
  vi.mocked(gitHookDelete).mockImplementationOnce(
    () =>
      new Promise<HookDeleteOutcome>((resolve) => {
        land = resolve;
      }),
  );
  return (outcome: HookDeleteOutcome) => act(async () => land(outcome));
}

/** Presses the inline swap's Delete on the selected unmanaged hook. */
async function inlineDelete(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Delete…" }));
  expect(screen.getByText("Recycle bin?")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Delete" }));
}

describe("held controls in the Hooks dialog", () => {
  it("keeps focus on the toggle through its own write and flip", async () => {
    let enabled: () => void = () => undefined;
    vi.mocked(gitHookSetEnabled).mockImplementationOnce(
      () =>
        new Promise<HookWriteOutcome>((resolve) => {
          enabled = () => resolve(WRITTEN);
        }),
    );
    vi.mocked(gitHooksList).mockImplementation(async () =>
      vi.mocked(gitHookSetEnabled).mock.lastCall?.[2] === false
        ? {
            ...info(),
            entries: info().entries.map((e) =>
              e.name === "pre-commit"
                ? hook("pre-commit", "disabled", false)
                : e,
            ),
          }
        : info(),
    );
    const { user } = renderDialog();
    await select(user, "pre-commit");
    const toggle = screen.getByRole("button", { name: "Disable" });
    act(() => toggle.focus());
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(toggle).toHaveAttribute("aria-disabled", "true"),
    );
    expect(toggle).toHaveAccessibleDescription(
      "A hook change is already running.",
    );
    expect(document.activeElement).toBe(toggle);
    await act(async () => enabled());
    await waitFor(() => expect(toggle).toHaveAccessibleName("Enable"));
    expect(document.activeElement).toBe(toggle);
    expect(toggle).not.toHaveAttribute("aria-disabled");
    // The Enter still held from the Disable press must not fire Enable.
    expect(fireEvent.keyDown(toggle, { key: "Enter", repeat: true })).toBe(
      false,
    );
    await act(() => Promise.resolve());
    expect(gitHookSetEnabled).toHaveBeenCalledTimes(1);
  });

  it("holds Save with the reason that applies", async () => {
    let saved: () => void = () => undefined;
    let reread: () => void = () => undefined;
    vi.mocked(gitHookWrite).mockImplementationOnce(
      (_r, _n, content) =>
        new Promise<HookWriteOutcome>((resolve) => {
          saved = () => {
            // The save's re-read is held, so Save is checked before it lands.
            vi.mocked(gitHookRead).mockImplementationOnce(
              () =>
                new Promise<string>((r) => {
                  reread = () => r(content);
                }),
            );
            resolve(WRITTEN);
          };
        }),
    );
    const { user } = renderDialog();
    await select(user, "pre-commit");
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(save).toHaveAccessibleDescription("No changes to save.");
    const editor = screen.getByLabelText("Hook script");
    await user.clear(editor);
    expect(save).toHaveAccessibleDescription("The script is empty.");
    await user.type(editor, "#!/bin/sh");
    expect(save).not.toHaveAttribute("aria-disabled");
    await user.click(save);
    await waitFor(() =>
      expect(save).toHaveAccessibleDescription("A save is already running."),
    );
    expect(save).toHaveAttribute("aria-disabled", "true");
    await act(async () => saved());
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Saved the pre-commit hook"),
    );
    await waitFor(() => expect(save).not.toHaveAttribute("aria-disabled"));
    expect(fireEvent.keyDown(save, { key: "Enter", repeat: true })).toBe(false);
    await act(() => Promise.resolve());
    expect(gitHookWrite).toHaveBeenCalledTimes(1);
    await act(async () => reread());
    await waitFor(() =>
      expect(save).toHaveAccessibleDescription("No changes to save."),
    );
  });

  it("refuses to close while its own managed prompt is pending", async () => {
    const onOpenChange = vi.fn();
    const { user } = renderDialog(false, onOpenChange);
    await select(user, "pre-push");
    await user.click(screen.getByRole("button", { name: "Disable" }));
    expectAsked("disable");
    await user.keyboard("{Escape}");
    expect(onOpenChange.mock.calls.map((c) => c[0])).not.toContain(false);
    expectAsked("disable");
    await answer(false);
    await user.keyboard("{Escape}");
    expect(onOpenChange.mock.calls.map((c) => c[0])).toContain(false);
    expect(gitHookSetEnabled).not.toHaveBeenCalled();
  });
});

describe("a delete whose hook changed since the list loaded", () => {
  beforeEach(() => {
    prePush = hook("pre-push", "active", false);
  });

  /** The first delete finds the hook turned into the guard. */
  const turnsManaged = (): HookDeleteOutcome => {
    prePush = hook("pre-push", "active", true);
    return { status: "managedChanged", managed: true };
  };

  it("asks the guard's prompt, then deletes on Confirm", async () => {
    vi.mocked(gitHookDelete).mockImplementationOnce(async () => turnsManaged());
    const { user } = renderDialog();
    await select(user, "pre-push");
    await inlineDelete(user);
    await waitFor(() => expectAsked("delete"));
    expect(gitHookDelete).toHaveBeenCalledTimes(1);
    expect(gitHookDelete).toHaveBeenCalledWith(REPO, "pre-push", false);
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.queryByText("Recycle bin?")).not.toBeInTheDocument();
    await answer(true);
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Deleted pre-push"),
    );
    expect(gitHookDelete).toHaveBeenCalledTimes(2);
    expect(gitHookDelete).toHaveBeenLastCalledWith(REPO, "pre-push", true);
  });

  it("deletes nothing more when that prompt is cancelled", async () => {
    vi.mocked(gitHookDelete).mockImplementationOnce(async () => turnsManaged());
    const { user } = renderDialog();
    await select(user, "pre-push");
    await inlineDelete(user);
    await waitFor(() => expectAsked("delete"));
    await answer(false);
    expect(gitHookDelete).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("asks only once the inline confirm has left and Delete… holds focus", async () => {
    vi.mocked(gitHookDelete).mockImplementationOnce(async () => turnsManaged());
    let snapshot: { inline: boolean; active: Element | null } | null = null;
    const unsubscribe = useConfirm.subscribe((s, prev) => {
      if (s.request !== null && prev.request === null && snapshot === null) {
        snapshot = {
          inline: screen.queryByText("Recycle bin?") !== null,
          active: document.activeElement,
        };
      }
    });
    try {
      const { user } = renderDialog();
      await select(user, "pre-push");
      await inlineDelete(user);
      await waitFor(() => expect(snapshot).not.toBeNull());
      expect(snapshot).toEqual({
        inline: false,
        active: screen.getByRole("button", { name: "Delete…" }),
      });
    } finally {
      unsubscribe();
    }
  });

  it("says so when the confirmed guard turned into an ordinary hook", async () => {
    prePush = hook("pre-push", "active", true);
    vi.mocked(gitHookDelete).mockImplementationOnce(async () => {
      prePush = hook("pre-push", "active", false);
      return { status: "managedChanged", managed: false };
    });
    const { user } = renderDialog();
    await select(user, "pre-push");
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    expectAsked("delete");
    await answer(true);
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(NOTICE));
    expect(gitHookDelete).toHaveBeenCalledTimes(1);
    expect(gitHookDelete).toHaveBeenCalledWith(REPO, "pre-push", true);
    expect(toast.success).not.toHaveBeenCalled();
    expect(request()).toBeNull();
    expect(row("pre-push")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Hook script")).toBeInTheDocument();
  });

  it("asks nothing after a repository switch, and says so once", async () => {
    const land = deferDelete();
    const { user } = renderDialog();
    await select(user, "pre-push");
    await inlineDelete(user);
    await waitFor(() => expect(gitHookDelete).toHaveBeenCalledTimes(1));
    act(() => useUiStore.setState({ repoPath: "C:/repos/other" }));
    await land(turnsManaged());
    await waitFor(() => expect(toast.info).toHaveBeenCalledTimes(1));
    await act(() => Promise.resolve());
    expect(vi.mocked(toast.info).mock.calls[0]?.[0]).toMatch(
      /nothing was deleted in guarded\.$/,
    );
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(request()).toBeNull();
    expect(gitHookDelete).toHaveBeenCalledTimes(1);
  });

  it("asks nothing when the dialog closed before the answer", async () => {
    const land = deferDelete();
    const { user, setOpen } = renderDialog();
    await select(user, "pre-push");
    await inlineDelete(user);
    await waitFor(() => expect(gitHookDelete).toHaveBeenCalledTimes(1));
    setOpen(false);
    await land(turnsManaged());
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(NOTICE));
    await act(() => Promise.resolve());
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(request()).toBeNull();
    expect(gitHookDelete).toHaveBeenCalledTimes(1);
  });

  it("asks nothing when the re-read finds the hook gone", async () => {
    vi.mocked(gitHookDelete).mockImplementationOnce(async () => {
      prePush = hook("pre-push", "inactive", false);
      return { status: "managedChanged", managed: true };
    });
    const { user } = renderDialog();
    await select(user, "pre-push");
    await inlineDelete(user);
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(NOTICE));
    await act(() => Promise.resolve());
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(request()).toBeNull();
    expect(gitHookDelete).toHaveBeenCalledTimes(1);
  });

  it("holds the guard's Delete… while the inline delete still runs", async () => {
    const land = deferDelete();
    const { user, client } = renderDialog();
    await select(user, "pre-push");
    await inlineDelete(user);
    await waitFor(() => expect(gitHookDelete).toHaveBeenCalledTimes(1));
    prePush = hook("pre-push", "active", true);
    await act(() =>
      client.invalidateQueries({ queryKey: ["repo", REPO, "hooks"] }),
    );
    const guardDelete = await screen.findByRole("button", { name: "Delete…" });
    expect(guardDelete).toHaveAttribute("aria-disabled", "true");
    expect(guardDelete).toHaveAccessibleDescription(ACT_PENDING_REASON);
    await user.click(guardDelete);
    await act(() => Promise.resolve());
    expect(request()).toBeNull();
    expect(gitHookDelete).toHaveBeenCalledTimes(1);
    await land({ status: "deleted" });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Deleted pre-push"),
    );
  });

  it("asks nothing when another hook was selected before the answer", async () => {
    const land = deferDelete();
    const { user } = renderDialog();
    await select(user, "pre-push");
    await inlineDelete(user);
    await waitFor(() => expect(gitHookDelete).toHaveBeenCalledTimes(1));
    await select(user, "pre-commit");
    await land(turnsManaged());
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(NOTICE));
    await act(() => Promise.resolve());
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(request()).toBeNull();
    expect(gitHookDelete).toHaveBeenCalledTimes(1);
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

describe("a save or toggle whose hook changed since the list loaded", () => {
  const changed = (verb: string) =>
    `pre-push changed since this list loaded — nothing was ${verb}.`;

  it.each([
    ["Save", "saved", true],
    ["Save", "saved", false],
    ["Disable", "disabled", true],
    ["Disable", "disabled", false],
  ] as const)(
    "%s refuses with the %s notice when the list showed managed: %s",
    async (button, verb, managed) => {
      prePush = hook("pre-push", "active", managed);
      const refused = { status: "managedChanged", managed: !managed } as const;
      const write = button === "Save" ? gitHookWrite : gitHookSetEnabled;
      // The list re-reads are held, so the notice is seen to wait for one.
      const lists: (() => void)[] = [];
      vi.mocked(write).mockImplementationOnce(async () => {
        prePush = hook("pre-push", "active", !managed);
        vi.mocked(gitHooksList).mockImplementation(
          () => new Promise<HooksInfo>((r) => lists.push(() => r(info()))),
        );
        return refused;
      });
      const { user } = renderDialog();
      await select(user, "pre-push");
      if (button === "Save")
        await user.type(screen.getByLabelText("Hook script"), "true");
      await user.click(screen.getByRole("button", { name: button }));
      if (managed) await answer(true);
      await waitFor(() => expect(lists.length).toBeGreaterThan(0));
      await act(() => new Promise((r) => setTimeout(r, 0)));
      expect(toast.info).not.toHaveBeenCalled();
      await act(async () => {
        for (const land of lists.splice(0)) land();
      });
      await waitFor(() =>
        expect(toast.info).toHaveBeenCalledWith(changed(verb)),
      );
      expect(vi.mocked(write).mock.lastCall?.[3]).toBe(managed);
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.info).toHaveBeenCalledTimes(1);
    },
  );

  it("Enable refuses with the enabled notice", async () => {
    prePush = hook("pre-push", "disabled", false);
    vi.mocked(gitHookSetEnabled).mockImplementationOnce(async () => ({
      status: "managedChanged",
      managed: true,
    }));
    const { user } = renderDialog();
    await select(user, "pre-push");
    await user.click(screen.getByRole("button", { name: "Enable" }));
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(changed("enabled")),
    );
    expect(gitHookSetEnabled).toHaveBeenCalledWith(
      REPO,
      "pre-push",
      true,
      false,
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("a refusal settling after a repository switch says only that", async () => {
    prePush = hook("pre-push", "active", false);
    let land: (o: HookWriteOutcome) => void = () => undefined;
    vi.mocked(gitHookWrite).mockImplementationOnce(
      () =>
        new Promise<HookWriteOutcome>((resolve) => {
          land = resolve;
        }),
    );
    const { user } = renderDialog();
    await select(user, "pre-push");
    await user.type(screen.getByLabelText("Hook script"), "true");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(gitHookWrite).toHaveBeenCalledTimes(1));
    act(() => useUiStore.setState({ repoPath: "C:/repos/other" }));
    await act(async () => land({ status: "managedChanged", managed: true }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledTimes(1));
    await act(() => Promise.resolve());
    expect(vi.mocked(toast.info).mock.calls[0]?.[0]).toMatch(
      /nothing was saved in guarded\.$/,
    );
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("a Disable refusal settling after a repository switch says only that", async () => {
    prePush = hook("pre-push", "active", false);
    let land: (o: HookWriteOutcome) => void = () => undefined;
    vi.mocked(gitHookSetEnabled).mockImplementationOnce(
      () =>
        new Promise<HookWriteOutcome>((resolve) => {
          land = resolve;
        }),
    );
    const { user } = renderDialog();
    await select(user, "pre-push");
    await user.click(screen.getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(gitHookSetEnabled).toHaveBeenCalledTimes(1));
    act(() => useUiStore.setState({ repoPath: "C:/repos/other" }));
    await act(async () => land({ status: "managedChanged", managed: true }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledTimes(1));
    await act(() => Promise.resolve());
    expect(vi.mocked(toast.info).mock.calls[0]?.[0]).toMatch(
      /nothing was disabled in guarded\.$/,
    );
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe("a hook that changes on disk while it is open", () => {
  /** What each hook's file holds; a name missing here reads as SCRIPT. */
  let disk: Map<string, string | null>;
  /** Hooks whose script read fails. */
  let unreadable: Set<string>;
  const EDITED = `${SCRIPT}true`;
  const LINE =
    "pre-commit changed on disk while you were editing. Reload replaces your edit with the script on disk.";
  const READ_ERROR = {
    kind: "io",
    message: "Access is denied. (os error 5)",
  };

  beforeEach(() => {
    prePush = hook("pre-push", "active", false);
    disk = new Map();
    unreadable = new Set();
    vi.mocked(gitHookRead).mockImplementation(async (_repo, name) => {
      if (unreadable.has(name)) throw READ_ERROR;
      return disk.has(name) ? (disk.get(name) ?? null) : SCRIPT;
    });
  });

  /** The line's live region: it holds the sentence only, never Reload. */
  const line = () => {
    const regions = screen
      .getAllByRole("status")
      .filter((el) => el.tagName === "P");
    expect(regions).toHaveLength(1);
    return regions[0] as HTMLElement;
  };
  const editor = () => screen.getByLabelText("Hook script");
  const reread = (client: QueryClient, name = "pre-commit") =>
    act(() =>
      client.invalidateQueries({ queryKey: ["repo", REPO, "hook", name] }),
    );

  async function edited() {
    const r = renderDialog();
    await select(r.user, "pre-commit");
    await r.user.type(editor(), "true");
    expect(editor()).toHaveValue(EDITED);
    return r;
  }

  it("reloads an untouched script silently", async () => {
    const { user, client } = renderDialog();
    await select(user, "pre-commit");
    expect(line().textContent).toBe("");
    disk.set("pre-commit", "#!/bin/sh\necho new\n");
    await reread(client);
    await waitFor(() => expect(editor()).toHaveValue("#!/bin/sh\necho new\n"));
    expect(line().textContent).toBe("");
    expect(screen.queryByRole("button", { name: "Reload" })).toBe(null);
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(save).toHaveAccessibleDescription("No changes to save.");
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("keeps an edit and says the file changed, with Reload beside the line", async () => {
    const { client } = await edited();
    disk.set("pre-commit", "#!/bin/sh\necho new\n");
    await reread(client);
    await waitFor(() => expect(line().textContent).toBe(LINE));
    expect(editor()).toHaveValue(EDITED);
    expect(screen.getByRole("button", { name: "Save" })).not.toHaveAttribute(
      "aria-disabled",
    );
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("an edit set back to the original keeps the line, Reload and Save through a same-bytes re-read", async () => {
    const { client } = await edited();
    disk.set("pre-commit", "#!/bin/sh\necho new\n");
    await reread(client);
    await waitFor(() => expect(line().textContent).toBe(LINE));
    fireEvent.change(editor(), { target: { value: SCRIPT } });
    expect(editor()).toHaveValue(SCRIPT);
    expect(line().textContent).toBe(LINE);
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).not.toHaveAttribute(
      "aria-disabled",
    );
    // The draft stays the user's: a re-read of the same disk text neither
    // replaces it nor hides the line.
    const reads = vi.mocked(gitHookRead).mock.calls.length;
    await reread(client);
    await waitFor(() =>
      expect(vi.mocked(gitHookRead).mock.calls.length).toBe(reads + 1),
    );
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(editor()).toHaveValue(SCRIPT);
    expect(line().textContent).toBe(LINE);
  });

  it("a template whose script is the original keeps the line", async () => {
    const template = HOOK_TEMPLATES.find((t) => t.hook === "pre-commit");
    if (!template) throw new Error("no pre-commit template");
    disk.set("pre-commit", template.body);
    const { user, client } = renderDialog();
    await waitFor(() => row("pre-commit"));
    await user.click(row("pre-commit"));
    await waitFor(() => expect(editor()).toHaveValue(template.body));
    await user.type(editor(), "x");
    disk.set("pre-commit", "#!/bin/sh\necho new\n");
    await reread(client);
    await waitFor(() => expect(line().textContent).toBe(LINE));
    await user.click(screen.getByRole("button", { name: "Templates" }));
    await user.click(
      await screen.findByRole("menuitem", { name: new RegExp(template.name) }),
    );
    await waitFor(() => expect(editor()).toHaveValue(template.body));
    expect(line().textContent).toBe(LINE);
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("Reload by keyboard takes the disk's script and lands on the editor", async () => {
    const { user, client } = await edited();
    disk.set("pre-commit", "#!/bin/sh\necho new\n");
    await reread(client);
    const reload = await screen.findByRole("button", { name: "Reload" });
    act(() => reload.focus());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(editor()).toHaveValue("#!/bin/sh\necho new\n"));
    expect(line().textContent).toBe("");
    expect(document.activeElement).toBe(editor());
  });

  it("a disk change converging with the edit hides the line, and focus on Reload lands on the editor", async () => {
    const { client } = await edited();
    disk.set("pre-commit", "#!/bin/sh\necho new\n");
    await reread(client);
    const reload = await screen.findByRole("button", { name: "Reload" });
    act(() => reload.focus());
    disk.set("pre-commit", EDITED);
    await reread(client);
    await waitFor(() => expect(line().textContent).toBe(""));
    expect(document.activeElement).toBe(editor());
    expect(editor()).toHaveValue(EDITED);
  });

  it("an edit set to the disk's change reloads the next change silently", async () => {
    const { client } = await edited();
    disk.set("pre-commit", "#!/bin/sh\necho new\n");
    await reread(client);
    await waitFor(() => expect(line().textContent).toBe(LINE));
    fireEvent.change(editor(), { target: { value: "#!/bin/sh\necho new\n" } });
    expect(line().textContent).toBe("");
    disk.set("pre-commit", "#!/bin/sh\necho newer\n");
    await reread(client);
    await waitFor(() =>
      expect(editor()).toHaveValue("#!/bin/sh\necho newer\n"),
    );
    expect(line().textContent).toBe("");
    expect(screen.queryByRole("button", { name: "Reload" })).toBe(null);
  });

  it("an edit set to the disk's change follows the disk back to the original", async () => {
    const { client } = await edited();
    disk.set("pre-commit", "#!/bin/sh\necho new\n");
    await reread(client);
    await waitFor(() => expect(line().textContent).toBe(LINE));
    fireEvent.change(editor(), { target: { value: "#!/bin/sh\necho new\n" } });
    disk.set("pre-commit", SCRIPT);
    await reread(client);
    await waitFor(() => expect(editor()).toHaveValue(SCRIPT));
    expect(line().textContent).toBe("");
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(save).toHaveAccessibleDescription("No changes to save.");
  });

  it("a line hiding while Save holds focus leaves focus there", async () => {
    const { client } = await edited();
    disk.set("pre-commit", "#!/bin/sh\necho new\n");
    await reread(client);
    await waitFor(() => expect(line().textContent).toBe(LINE));
    const save = screen.getByRole("button", { name: "Save" });
    act(() => save.focus());
    disk.set("pre-commit", EDITED);
    await reread(client);
    await waitFor(() => expect(line().textContent).toBe(""));
    expect(document.activeElement).toBe(save);
  });

  it("selecting another hook clears the line and leaves focus on its row", async () => {
    const { user, client } = await edited();
    disk.set("pre-commit", "#!/bin/sh\necho new\n");
    await reread(client);
    await waitFor(() => expect(line().textContent).toBe(LINE));
    await select(user, "pre-push");
    expect(line().textContent).toBe("");
    expect(document.activeElement).toBe(row("pre-push"));
  });

  it("a Save refused by a managed change keeps the edit and shows the line once the script re-reads", async () => {
    vi.mocked(gitHookWrite).mockImplementationOnce(async () => {
      prePush = hook("pre-push", "active", true);
      disk.set("pre-push", "#!/bin/sh\n# the guard\n");
      return { status: "managedChanged", managed: true };
    });
    const { user } = renderDialog();
    await select(user, "pre-push");
    await user.type(editor(), "true");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(line().textContent).toBe(
        "pre-push changed on disk while you were editing. Reload replaces your edit with the script on disk.",
      ),
    );
    expect(editor()).toHaveValue(EDITED);
    expect(toast.info).toHaveBeenCalledWith(
      "pre-push changed since this list loaded — nothing was saved.",
    );
  });

  it("this dialog's own Save never reads as a change on disk, even typed past before the re-read", async () => {
    // The save's re-read is held, so it lands only after more typing.
    let reply: () => void = () => undefined;
    vi.mocked(gitHookWrite).mockImplementationOnce(async (_r, _n, content) => {
      vi.mocked(gitHookRead).mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            reply = () => resolve(content);
          }),
      );
      return WRITTEN;
    });
    const { user, client } = await edited();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Saved the pre-commit hook"),
    );
    await user.type(editor(), "x");
    // Inside the window: the read still answers the text the Save replaced.
    expect(client.getQueryData(["repo", REPO, "hook", "pre-commit"])).toBe(
      SCRIPT,
    );
    expect(line().textContent).toBe("");
    expect(screen.queryByRole("button", { name: "Reload" })).toBe(null);
    await act(async () => reply());
    await waitFor(() =>
      expect(client.getQueryData(["repo", REPO, "hook", "pre-commit"])).toBe(
        EDITED,
      ),
    );
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(line().textContent).toBe("");
    expect(editor()).toHaveValue(`${EDITED}x`);
  });

  it("after the Save's re-read lands, a disk change back to the replaced text shows the line", async () => {
    vi.mocked(gitHookWrite).mockImplementationOnce(async (_r, name, text) => {
      disk.set(name, text);
      return WRITTEN;
    });
    const { user, client } = await edited();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(client.getQueryData(["repo", REPO, "hook", "pre-commit"])).toBe(
        EDITED,
      ),
    );
    await user.type(editor(), "x");
    expect(line().textContent).toBe("");
    disk.set("pre-commit", SCRIPT);
    await reread(client);
    await waitFor(() => expect(line().textContent).toBe(LINE));
    expect(editor()).toHaveValue(`${EDITED}x`);
  });

  it("a Save's re-read answering the cached text it replaced shows the line", async () => {
    // The write lands, but the disk is put back before its held re-read
    // answers, so that answer equals the cache and only its time moves.
    let reply: () => void = () => undefined;
    vi.mocked(gitHookWrite).mockImplementationOnce(async (_r, name, text) => {
      disk.set(name, text);
      vi.mocked(gitHookRead).mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            reply = () => resolve(disk.get(name) ?? SCRIPT);
          }),
      );
      return WRITTEN;
    });
    const { user, client } = await edited();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Saved the pre-commit hook"),
    );
    disk.set("pre-commit", SCRIPT);
    await user.type(editor(), "x");
    expect(line().textContent).toBe("");
    const before = client.getQueryState(["repo", REPO, "hook", "pre-commit"]);
    await act(async () => reply());
    await waitFor(() =>
      expect(
        client.getQueryState(["repo", REPO, "hook", "pre-commit"])
          ?.dataUpdatedAt,
      ).toBeGreaterThan(before?.dataUpdatedAt ?? 0),
    );
    expect(client.getQueryData(["repo", REPO, "hook", "pre-commit"])).toBe(
      SCRIPT,
    );
    await waitFor(() => expect(line().textContent).toBe(LINE));
    expect(editor()).toHaveValue(`${EDITED}x`);
  });

  it("a Save whose hook was re-selected during the write leaves the fresh seed to its re-read", async () => {
    let release: () => void = () => undefined;
    let replyRead: () => void = () => undefined;
    vi.mocked(gitHookWrite).mockImplementationOnce(
      (_r, name, text) =>
        new Promise<HookWriteOutcome>((resolve) => {
          release = () => {
            disk.set(name, text);
            // The save's own re-read is held, so the stamp lands first.
            vi.mocked(gitHookRead).mockImplementationOnce(
              () =>
                new Promise<string>((r) => {
                  replyRead = () => r(text);
                }),
            );
            resolve(WRITTEN);
          };
        }),
    );
    const { user, client } = renderDialog();
    await select(user, "pre-push");
    await select(user, "pre-commit");
    await user.type(editor(), "true");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(gitHookWrite).toHaveBeenCalledTimes(1));
    await select(user, "pre-push");
    await select(user, "pre-commit");
    await act(async () => release());
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Saved the pre-commit hook"),
    );
    await act(async () => replyRead());
    await waitFor(() =>
      expect(client.getQueryData(["repo", REPO, "hook", "pre-commit"])).toBe(
        EDITED,
      ),
    );
    await waitFor(() => expect(editor()).toHaveValue(EDITED));
    expect(
      screen.getByRole("button", { name: "Save" }),
    ).toHaveAccessibleDescription("No changes to save.");
    expect(line().textContent).toBe("");
  });

  it("a second Save pressed before the first one's re-read keeps a draft set back to the first save's text", async () => {
    // Each write holds the re-read it starts, and the second write is held,
    // so the first re-read lands while the second write runs.
    const key = ["repo", REPO, "hook", "pre-commit"];
    const replies: Array<() => void> = [];
    const holdReread = (name: string) =>
      vi.mocked(gitHookRead).mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            replies.push(() => resolve(disk.get(name) ?? SCRIPT));
          }),
      );
    let release: () => void = () => undefined;
    vi.mocked(gitHookWrite)
      .mockImplementationOnce(async (_r, name, text) => {
        disk.set(name, text);
        holdReread(name);
        return WRITTEN;
      })
      .mockImplementationOnce(
        (_r, name, text) =>
          new Promise<HookWriteOutcome>((resolve) => {
            release = () => {
              disk.set(name, text);
              holdReread(name);
              resolve(WRITTEN);
            };
          }),
      );
    const { user, client } = await edited();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    await user.type(editor(), "x");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(gitHookWrite).toHaveBeenCalledTimes(2));
    await act(async () => replies[0]?.());
    await waitFor(() => expect(client.getQueryData(key)).toBe(EDITED));
    await act(async () => release());
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(2));
    // The second write replaced the first one's text, never a change on disk.
    await user.type(editor(), "y");
    expect(line().textContent).toBe("");
    fireEvent.change(editor(), { target: { value: EDITED } });
    expect(line().textContent).toBe("");
    await act(async () => replies[1]?.());
    await waitFor(() => expect(client.getQueryData(key)).toBe(`${EDITED}x`));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(editor()).toHaveValue(EDITED);
    expect(line().textContent).toBe("");
  });

  it("Reload pressed while a Save writes follows the disk to the saved script", async () => {
    const NEW = "#!/bin/sh\necho new\n";
    let release: () => void = () => undefined;
    vi.mocked(gitHookWrite).mockImplementationOnce(
      (_r, name, text) =>
        new Promise<HookWriteOutcome>((resolve) => {
          release = () => {
            disk.set(name, text);
            resolve(WRITTEN);
          };
        }),
    );
    const { user, client } = await edited();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(gitHookWrite).toHaveBeenCalledTimes(1));
    disk.set("pre-commit", NEW);
    await reread(client);
    await user.click(await screen.findByRole("button", { name: "Reload" }));
    expect(editor()).toHaveValue(NEW);
    await act(async () => release());
    await waitFor(() =>
      expect(client.getQueryData(["repo", REPO, "hook", "pre-commit"])).toBe(
        EDITED,
      ),
    );
    await waitFor(() => expect(editor()).toHaveValue(EDITED));
    expect(line().textContent).toBe("");
  });

  it("a change on disk read while a Save writes still shows its line after the save", async () => {
    const OTHER = "#!/bin/sh\necho other\n";
    let release: () => void = () => undefined;
    vi.mocked(gitHookWrite).mockImplementationOnce(
      (_r, name, text) =>
        new Promise<HookWriteOutcome>((resolve) => {
          release = () => {
            disk.set(name, text);
            vi.mocked(gitHookRead).mockImplementationOnce(
              () => new Promise<string>(() => undefined),
            );
            resolve(WRITTEN);
          };
        }),
    );
    const { user, client } = await edited();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(gitHookWrite).toHaveBeenCalledTimes(1));
    await user.type(editor(), "x");
    disk.set("pre-commit", OTHER);
    await reread(client);
    await waitFor(() => expect(line().textContent).toBe(LINE));
    await act(async () => release());
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Saved the pre-commit hook"),
    );
    expect(editor()).toHaveValue(`${EDITED}x`);
    expect(line().textContent).toBe(LINE);
  });

  it("an edited hook deleted on disk shows no line", async () => {
    const { client } = await edited();
    vi.mocked(gitHooksList).mockImplementation(async () => ({
      ...info(),
      entries: [prePush, hook("pre-commit", "inactive", false)],
    }));
    disk.set("pre-commit", "#!/bin/sh\n# git's sample\n");
    await act(() =>
      client.invalidateQueries({ queryKey: ["repo", REPO, "hooks"] }),
    );
    await reread(client);
    await screen.findByRole("button", { name: "Create hook" });
    expect(line().textContent).toBe("");
    expect(editor()).toHaveValue(EDITED);
  });

  it("holds Save and the toggle while a newly selected hook's script loads", async () => {
    let reply: () => void = () => undefined;
    const { user } = await edited();
    vi.mocked(gitHookRead).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          reply = () => resolve("#!/bin/sh\n# pre-push\n");
        }),
    );
    await user.click(row("pre-push"));
    const save = screen.getByRole("button", { name: "Save" });
    const toggle = screen.getByRole("button", { name: "Disable" });
    for (const held of [save, toggle]) {
      expect(held).toHaveAttribute("aria-disabled", "true");
      expect(held).toHaveAccessibleDescription(
        "This hook's script is still loading.",
      );
    }
    await user.click(save);
    await user.click(toggle);
    await act(() => Promise.resolve());
    expect(gitHookWrite).not.toHaveBeenCalled();
    expect(gitHookSetEnabled).not.toHaveBeenCalled();
    act(() => save.focus());
    await act(async () => reply());
    await waitFor(() =>
      expect(editor()).toHaveValue("#!/bin/sh\n# pre-push\n"),
    );
    expect(save).toHaveAccessibleDescription("No changes to save.");
    expect(toggle).not.toHaveAttribute("aria-disabled");
    expect(document.activeElement).toBe(save);
  });

  it("a move between two hooks whose scripts are cached never commits the loading hold", async () => {
    const PUSH = "#!/bin/sh\n# pre-push\n";
    disk.set("pre-push", PUSH);
    const { user } = renderDialog();
    await waitFor(() => row("pre-push"));
    await user.click(row("pre-push"));
    await waitFor(() => expect(editor()).toHaveValue(PUSH));
    await select(user, "pre-commit");
    const save = screen.getByRole("button", { name: "Save" });
    const toggle = screen.getByRole("button", { name: "Disable" });
    expect(toggle).not.toHaveAttribute("aria-disabled");
    expect(save).toHaveAccessibleDescription("No changes to save.");
    const records: { target: string; attr: string | null }[] = [];
    const observer = new MutationObserver((list) => {
      for (const r of list)
        records.push({
          target: r.target === toggle ? "toggle" : "save",
          attr: r.attributeName,
        });
    });
    observer.observe(toggle, { attributeFilter: ["aria-disabled"] });
    // Save stays held by "No changes" on both hooks, so its reason node is
    // watched too: the loading hold would swap that text.
    const saveBox = save.parentElement ?? save;
    observer.observe(saveBox, {
      subtree: true,
      characterData: true,
      childList: true,
      attributeFilter: ["aria-disabled", "aria-describedby"],
    });
    await user.click(row("pre-push"));
    await waitFor(() => expect(editor()).toHaveValue(PUSH));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    records.push(
      ...observer.takeRecords().map((r) => ({
        target: r.target === toggle ? "toggle" : "save",
        attr: r.attributeName,
      })),
    );
    observer.disconnect();
    expect(records).toEqual([]);
    expect(toggle).not.toHaveAttribute("aria-disabled");
    expect(save).toHaveAccessibleDescription("No changes to save.");
  });

  it("holds Templates and keeps the editor read-only while a newly selected hook's script loads", async () => {
    let reply: () => void = () => undefined;
    const { user } = await edited();
    vi.mocked(gitHookRead).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          reply = () => resolve("#!/bin/sh\n# pre-push\n");
        }),
    );
    await user.click(row("pre-push"));
    const templates = screen.getByRole("button", { name: "Templates" });
    expect(templates).toHaveAttribute("aria-disabled", "true");
    expect(templates).toHaveAccessibleDescription(
      "This hook's script is still loading.",
    );
    expect(editor()).toHaveAttribute("readonly");
    await act(async () => reply());
    await waitFor(() =>
      expect(editor()).toHaveValue("#!/bin/sh\n# pre-push\n"),
    );
    expect(templates).not.toHaveAttribute("aria-disabled");
    expect(editor()).not.toHaveAttribute("readonly");
  });

  it("the toggle names its own running write over the loading hold", async () => {
    let enabled: () => void = () => undefined;
    let reply: () => void = () => undefined;
    vi.mocked(gitHookSetEnabled).mockImplementationOnce(
      () =>
        new Promise<HookWriteOutcome>((resolve) => {
          enabled = () => resolve(WRITTEN);
        }),
    );
    const { user } = renderDialog();
    await select(user, "pre-commit");
    await user.click(screen.getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(gitHookSetEnabled).toHaveBeenCalledTimes(1));
    vi.mocked(gitHookRead).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          reply = () => resolve(SCRIPT);
        }),
    );
    await user.click(row("pre-push"));
    const toggle = screen.getByRole("button", { name: "Disable" });
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    expect(toggle).toHaveAccessibleDescription(
      "A hook change is already running.",
    );
    // The write's settle re-reads the selected hook, which may seed it first.
    await act(async () => enabled());
    await act(async () => reply());
    await waitFor(() => expect(toggle).not.toHaveAttribute("aria-disabled"));
  });

  it("Reload pressed by Enter drops the held key's repeats in the editor until it is released", async () => {
    const { user, client } = await edited();
    disk.set("pre-commit", "#!/bin/sh\necho new\n");
    await reread(client);
    const reload = await screen.findByRole("button", { name: "Reload" });
    act(() => reload.focus());
    await user.keyboard("{Enter>}");
    await waitFor(() => expect(editor()).toHaveValue("#!/bin/sh\necho new\n"));
    expect(document.activeElement).toBe(editor());
    expect(fireEvent.keyDown(editor(), { key: "Enter", repeat: true })).toBe(
      false,
    );
    expect(editor()).toHaveValue("#!/bin/sh\necho new\n");
    await user.keyboard("{/Enter}");
    expect(fireEvent.keyDown(editor(), { key: "Enter" })).toBe(true);
    expect(fireEvent.keyDown(editor(), { key: "Enter", repeat: true })).toBe(
      true,
    );
  });

  it("a line hiding with no editor input mounted lands on the selected row", async () => {
    editorMock.tag = "input";
    disk.set("pre-commit", "#!/bin/sh true");
    const { user, client } = renderDialog();
    await waitFor(() => row("pre-commit"));
    await user.click(row("pre-commit"));
    await waitFor(() => expect(editor()).toHaveValue("#!/bin/sh true"));
    await user.type(editor(), "x");
    disk.set("pre-commit", "#!/bin/sh new");
    await reread(client);
    const reload = await screen.findByRole("button", { name: "Reload" });
    act(() => reload.focus());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(editor()).toHaveValue("#!/bin/sh new"));
    expect(document.activeElement).toBe(row("pre-commit"));
  });

  describe("a script that can't be read", () => {
    const UNREADABLE = "This hook's script couldn't be read.";
    const failed = () => screen.queryByRole("alert");

    it("replaces the editor with the failure and holds what would write", async () => {
      unreadable.add("pre-push");
      const { user } = await edited();
      await user.click(row("pre-push"));
      await waitFor(() =>
        expect(failed()).toHaveTextContent(
          `Couldn't read pre-push.${presentError(READ_ERROR).summary}`,
        ),
      );
      expect(screen.queryByLabelText("Hook script")).toBe(null);
      expect(screen.getByText("pre-push hook")).toBeInTheDocument();
      for (const name of ["Save", "Disable", "Templates"]) {
        const held = screen.getByRole("button", { name });
        expect(held).toHaveAttribute("aria-disabled", "true");
        expect(held).toHaveAccessibleDescription(UNREADABLE);
      }
      await user.click(screen.getByRole("button", { name: "Save" }));
      await act(() => Promise.resolve());
      expect(gitHookWrite).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Retry" })).not.toHaveAttribute(
        "aria-disabled",
      );
    });

    it("Retry stays in place while it reads, then seeds the hook and lands on the editor", async () => {
      unreadable.add("pre-push");
      const { user } = await edited();
      await user.click(row("pre-push"));
      const retry = await screen.findByRole("button", { name: "Retry" });
      unreadable.delete("pre-push");
      let reply: () => void = () => undefined;
      vi.mocked(gitHookRead).mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            reply = () => resolve("#!/bin/sh\n# pre-push\n");
          }),
      );
      act(() => retry.focus());
      await user.keyboard("{Enter}");
      await waitFor(() => expect(retry).toHaveAccessibleName("Retrying…"));
      expect(failed()).toBeInTheDocument();
      await act(async () => reply());
      await waitFor(() =>
        expect(editor()).toHaveValue("#!/bin/sh\n# pre-push\n"),
      );
      expect(failed()).toBe(null);
      expect(document.activeElement).toBe(editor());
      expect(
        screen.getByRole("button", { name: "Save" }),
      ).toHaveAccessibleDescription("No changes to save.");
      for (const name of ["Disable", "Templates"])
        expect(screen.getByRole("button", { name })).not.toHaveAttribute(
          "aria-disabled",
        );
    });

    it("a failed re-read of a seeded hook keeps the editor and the draft", async () => {
      const { client } = await edited();
      unreadable.add("pre-commit");
      await reread(client);
      await waitFor(() =>
        expect(
          client.getQueryState(["repo", REPO, "hook", "pre-commit"])?.status,
        ).toBe("error"),
      );
      expect(failed()).toBe(null);
      expect(editor()).toHaveValue(EDITED);
      expect(screen.getByRole("button", { name: "Save" })).not.toHaveAttribute(
        "aria-disabled",
      );
    });
  });
});

describe("a repository switch under the open dialog", () => {
  const OTHER = "C:/repos/other";

  it("seeds the other repository's same-named hook even when its script reads the same", async () => {
    const { user, client, setRepo } = renderDialog();
    await select(user, "pre-commit");
    client.setQueryData(["repo", OTHER, "hooks"], info());
    client.setQueryData(["repo", OTHER, "hook", "pre-commit"], SCRIPT);
    setRepo(OTHER);
    await waitFor(() =>
      expect(gitHookRead).toHaveBeenCalledWith(OTHER, "pre-commit"),
    );
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() =>
      expect(save).toHaveAccessibleDescription("No changes to save."),
    );
    expect(screen.getByRole("button", { name: "Disable" })).not.toHaveAttribute(
      "aria-disabled",
    );
    expect(screen.getByLabelText("Hook script")).toHaveValue(SCRIPT);
  });

  it("holds an edited draft while the other repository's script loads", async () => {
    let reply: () => void = () => undefined;
    const { user, client, setRepo } = renderDialog();
    await select(user, "pre-commit");
    await user.type(screen.getByLabelText("Hook script"), "true");
    client.setQueryData(["repo", OTHER, "hooks"], info());
    vi.mocked(gitHookRead).mockImplementation((repo) =>
      repo === OTHER
        ? new Promise<string>((resolve) => {
            reply = () => resolve(SCRIPT);
          })
        : Promise.resolve(SCRIPT),
    );
    setRepo(OTHER);
    await waitFor(() =>
      expect(gitHookRead).toHaveBeenCalledWith(OTHER, "pre-commit"),
    );
    const save = screen.getByRole("button", { name: "Save" });
    const toggle = screen.getByRole("button", { name: "Disable" });
    for (const held of [save, toggle]) {
      expect(held).toHaveAttribute("aria-disabled", "true");
      expect(held).toHaveAccessibleDescription(
        "This hook's script is still loading.",
      );
    }
    expect(screen.getByLabelText("Hook script")).toHaveAttribute("readonly");
    await user.click(save);
    await act(() => Promise.resolve());
    expect(gitHookWrite).not.toHaveBeenCalled();
    await act(async () => reply());
    await waitFor(() =>
      expect(screen.getByLabelText("Hook script")).toHaveValue(SCRIPT),
    );
    expect(save).toHaveAccessibleDescription("No changes to save.");
    expect(toggle).not.toHaveAttribute("aria-disabled");
    expect(screen.getByLabelText("Hook script")).not.toHaveAttribute(
      "readonly",
    );
  });
});
