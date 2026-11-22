import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
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
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
// Aliased: scripts/toast-clearance-adopters.test.mjs rosters every product
// `<CommentComposer` mount, and this harness mount docks on no pane.
import { CommentComposer as Composer } from "@/features/conversations/CommentComposer";
import type { MentionSource } from "@/features/conversations/useMentionCandidates";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { unmockedCommands } from "./setup";

// The settings read is the composer's one IPC seam (its collapse preference).
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
  saveSettingsMerged: vi.fn(async (s: unknown) => s),
}));

// The modifier flags of user-event's own Control chord, so the platform
// modifier is never spelled here.
const mod: KeyboardEventInit = {};
beforeAll(async () => {
  let chord: KeyboardEvent | undefined;
  const record = (e: KeyboardEvent) => {
    if (e.key === "k") chord = e;
  };
  window.addEventListener("keydown", record);
  await userEvent.setup().keyboard("{Control>}k{/Control}");
  window.removeEventListener("keydown", record);
  if (chord === undefined) throw new Error("no chord recorded");
  for (const flag of Object.getOwnPropertyNames(KeyboardEvent.prototype))
    if (flag.endsWith("Key"))
      Object.assign(mod, { [flag]: chord[flag as keyof KeyboardEvent] });
});

beforeEach(() => {
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
  // jsdom implements neither: the editor's edits then take their controlled
  // rewrite fallback, and the popover scrolls its marked row.
  document.execCommand = vi.fn(() => false);
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  Reflect.deleteProperty(document, "execCommand");
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

afterAll(() => expect(unmockedCommands).toEqual([]));

const MENTIONS: MentionSource = {
  triggers: ["@"],
  ghHost: null,
  prNoun: "pull request",
  onActive: vi.fn(),
  query: () => ({
    items: [
      { key: "u-ada", insert: "ada", label: "Ada" },
      { key: "u-alan", insert: "alan", label: "Alan" },
    ],
    loading: false,
    isError: false,
  }),
};

function Host({ onSubmit }: { onSubmit: () => void }) {
  const [value, setValue] = useState("");
  return (
    <Composer
      value={value}
      onChange={setValue}
      onSubmit={onSubmit}
      submitLabel="Comment"
      ariaLabel="Leave a comment"
      placeholder="Leave a comment…"
      mentions={MENTIONS}
    />
  );
}

const UNWIRED: MentionSource = { ...MENTIONS, triggers: [] };

/** A composer whose source gains its triggers on a rerender. */
function renderUnwiredThenWired() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, {
    ...structuredClone(DEFAULT_SETTINGS),
    commentComposerCollapsed: false,
  });
  function SwitchHost({ mentions }: { mentions: MentionSource }) {
    const [value, setValue] = useState("");
    return (
      <Composer
        value={value}
        onChange={setValue}
        onSubmit={vi.fn()}
        submitLabel="Comment"
        ariaLabel="Leave a comment"
        placeholder="Leave a comment…"
        mentions={mentions}
      />
    );
  }
  const ui = (mentions: MentionSource) => (
    <QueryClientProvider client={client}>
      <SwitchHost mentions={mentions} />
    </QueryClientProvider>
  );
  const view = render(ui(UNWIRED));
  return { wire: () => view.rerender(ui(MENTIONS)) };
}

/** The composer inside a real Dialog, whose Escape dismissal listens on the document. */
function renderInDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, {
    ...structuredClone(DEFAULT_SETTINGS),
    commentComposerCollapsed: false,
  });
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>Edit comment</DialogTitle>
          <Host onSubmit={vi.fn()} />
        </DialogContent>
      </Dialog>
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

function renderHost() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, {
    ...structuredClone(DEFAULT_SETTINGS),
    commentComposerCollapsed: false,
  });
  const onSubmit = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <Host onSubmit={onSubmit} />
    </QueryClientProvider>,
  );
  return { onSubmit };
}

const editor = () =>
  screen.getByRole("textbox", {
    name: "Leave a comment",
  }) as HTMLTextAreaElement;
const suggestions = () =>
  screen.queryByRole("listbox", { name: "Mention suggestions" });
type Init = KeyboardEventInit & { keyCode?: number };
/** fireEvent answers false when a handler prevented the default. */
const press = (init: Init) => fireEvent.keyDown(editor(), init);
const IME_SHAPES: [string, Init][] = [
  ["composing", { isComposing: true }],
  // WebKit's shape: the composition already ended, keyCode still 229.
  ["keyCode 229", { keyCode: 229 }],
];

describe("the markdown editor leaves input-method keys to the input method", () => {
  it.each(IME_SHAPES)("a %s Ctrl+K inserts no link", async (_, ime) => {
    renderHost();
    await userEvent.type(editor(), "hi");
    expect(press({ key: "k", code: "KeyK", ...mod, ...ime })).toBe(true);
    expect(editor().value).toBe("hi");
    // Positive control: the plain chord formats.
    expect(press({ key: "k", code: "KeyK", ...mod })).toBe(false);
    expect(editor().value).not.toBe("hi");
  });

  it.each(IME_SHAPES)(
    "a %s Escape leaves an open suggestion list alone",
    async (_, ime) => {
      renderHost();
      await userEvent.type(editor(), "@a");
      expect(suggestions()).not.toBeNull();
      expect(press({ key: "Escape", ...ime })).toBe(true);
      expect(suggestions()).not.toBeNull();
      // Positive control: the plain key dismisses it.
      expect(press({ key: "Escape" })).toBe(false);
      expect(suggestions()).toBeNull();
    },
  );

  it.each(IME_SHAPES)(
    "a %s Enter or Ctrl+Enter neither picks a suggestion nor submits",
    async (_, ime) => {
      const { onSubmit } = renderHost();
      await userEvent.type(editor(), "@a");
      expect(suggestions()).not.toBeNull();
      expect(press({ key: "Enter", ...mod, ...ime })).toBe(true);
      expect(press({ key: "Enter", ...ime })).toBe(true);
      expect(editor().value).toBe("@a");
      expect(onSubmit).not.toHaveBeenCalled();
      // Positive controls: plain Ctrl+Enter submits without picking, plain
      // Enter picks.
      expect(press({ key: "Enter", ...mod })).toBe(false);
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(editor().value).toBe("@a");
      expect(press({ key: "Enter" })).toBe(false);
      expect(editor().value).not.toBe("@a");
    },
  );

  it.each(IME_SHAPES)(
    "a %s Escape inside a dialog reaches neither the suggestions nor the dialog",
    async (_, ime) => {
      const { onOpenChange } = renderInDialog();
      await userEvent.type(editor(), "@a");
      expect(suggestions()).not.toBeNull();
      expect(press({ key: "Escape", ...ime })).toBe(true);
      expect(suggestions()).not.toBeNull();
      expect(onOpenChange).not.toHaveBeenCalled();
      // Positive controls: a plain Escape dismisses the suggestions alone, and
      // the next one reaches the dialog.
      expect(press({ key: "Escape" })).toBe(false);
      expect(suggestions()).toBeNull();
      expect(onOpenChange).not.toHaveBeenCalled();
      press({ key: "Escape" });
      expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
    },
  );

  const highlighted = () =>
    screen.getByRole("option", { selected: true }).textContent;
  // Keydown and keyup of one IME-owned arrow; the last pair's keyup arrives
  // after the composition ended, and Chromium names the composing keydown
  // `Process`.
  const IME_ARROWS: [string, Init, Init][] = [
    ...IME_SHAPES.map(([name, ime]): [string, Init, Init] => [name, ime, ime]),
    ["composition ended before keyup", { isComposing: true }, {}],
    ["Process", { key: "Process", isComposing: true }, {}],
  ];
  it.each(IME_ARROWS)(
    "a %s ArrowDown keeps the highlighted suggestion",
    async (_, down, up) => {
      renderHost();
      await userEvent.type(editor(), "@a");
      const arrow = { key: "ArrowDown", code: "ArrowDown" };
      fireEvent.keyDown(editor(), arrow);
      fireEvent.keyUp(editor(), arrow);
      expect(highlighted()).toContain("Alan");
      expect(press({ ...arrow, ...down })).toBe(true);
      fireEvent.keyUp(editor(), { ...arrow, ...up });
      expect(highlighted()).toContain("Alan");
      expect(press({ key: "Enter" })).toBe(false);
      expect(editor().value).toBe("@alan ");
    },
  );
});

describe("a stale input-method mark never withholds a caret re-sync", () => {
  const home = { key: "Home", code: "Home" };
  /** Moves the caret to the start, as Home does, and releases the key. */
  const homeUp = () => {
    editor().setSelectionRange(0, 0);
    fireEvent.keyUp(editor(), home);
  };

  // Control: record the mark while unwired; the keyup skips the re-sync.
  it("an IME Home while unwired leaves no mark for a later Home keyup", async () => {
    const { wire } = renderUnwiredThenWired();
    press({ ...home, keyCode: 229 });
    wire();
    await userEvent.type(editor(), "@a");
    expect(suggestions()).not.toBeNull();
    // A Home whose keydown the editor never heard (focus arrived mid-press).
    homeUp();
    expect(suggestions()).toBeNull();
  });

  // Control: keep the mark through a plain keydown; the keyup skips the re-sync.
  it("a plain Home keydown drops a mark its IME keyup never cleared", async () => {
    renderHost();
    await userEvent.type(editor(), "@a");
    expect(suggestions()).not.toBeNull();
    // The IME owned a Home whose keyup never reached the editor.
    press({ ...home, keyCode: 229 });
    expect(press(home)).toBe(true);
    homeUp();
    expect(suggestions()).toBeNull();
  });
});
