import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
// Aliased: scripts/toast-clearance-adopters.test.mjs rosters every product
// `<CommentComposer` mount, and this harness mount docks on no pane.
import { CommentComposer as Composer } from "@/features/conversations/CommentComposer";
import { useFocusCommentAction } from "@/features/pulls/RemotePrView";
import { PR_ARCHIVED_READONLY_MESSAGE } from "@/lib/git/types";
import { useAvailableActions } from "@/lib/hotkeys/hotkeys";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { unmockedCommands } from "./setup";

// The settings read is the composer's one IPC seam (its collapse preference).
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));

// The real editor's `disabled` takes keys away from the textarea, so the
// composer's chord guard behind it is reachable only through a stand-in that
// records the prop it was handed and stays typeable.
vi.mock("@/components/markdown-editor", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/components/markdown-editor")>();
  const { createElement } = await import("react");
  return {
    ...real,
    MarkdownEditor: (props: Parameters<typeof real.MarkdownEditor>[0]) =>
      createElement(
        "div",
        {
          "data-testid": "editor",
          "data-disabled": String(props.disabled === true),
        },
        createElement(real.MarkdownEditor, { ...props, disabled: false }),
      ),
  };
});

const REASON =
  "This conversation is locked, so only collaborators can comment.";
const BUSY = "Posting your comment…";

beforeEach(() => {
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
});

afterAll(() => expect(unmockedCommands).toEqual([]));

function renderComposer({
  value,
  readOnlyReason,
  collapsed = false,
  busy = false,
  holdKey,
}: {
  value: string;
  readOnlyReason?: string | null;
  collapsed?: boolean;
  busy?: boolean;
  holdKey?: string;
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, {
    ...structuredClone(DEFAULT_SETTINGS),
    commentComposerCollapsed: collapsed,
  });
  const onSubmit = vi.fn();
  const onClear = vi.fn();
  const onChange = vi.fn();
  const tree = (reason: string | null | undefined, key = holdKey) => (
    <QueryClientProvider client={client}>
      <Composer
        holdKey={key}
        busy={busy}
        reason={BUSY}
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        onClear={onClear}
        submitLabel="Comment"
        ariaLabel="Leave a comment"
        placeholder="Leave a comment…"
        readOnlyReason={reason}
      />
    </QueryClientProvider>
  );
  const { rerender } = render(tree(readOnlyReason));
  return {
    onSubmit,
    onClear,
    onChange,
    setReadOnly: (reason: string | null | undefined, key = holdKey) =>
      rerender(tree(reason, key)),
  };
}

const editor = () => screen.getByRole("textbox", { name: "Leave a comment" });
/** Whether the composer handed its editor `disabled`. */
const editorDisabled = () =>
  screen.getByTestId("editor").getAttribute("data-disabled") === "true";
const submit = () => screen.getByRole("button", { name: "Comment" });

describe("CommentComposer readOnlyReason", () => {
  it("disables the editor and holds submit with the reason, busy or not", async () => {
    const { onSubmit } = renderComposer({
      value: "a draft",
      readOnlyReason: REASON,
    });
    expect(editorDisabled()).toBe(true);
    const button = submit();
    expect(button).toHaveAttribute("aria-disabled", "true");
    // Focusable while held, with the reason announced through its description.
    expect(button).toHaveAccessibleDescription(REASON);
    await userEvent.click(button);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("explains the hold over an empty draft too", () => {
    renderComposer({ value: "", readOnlyReason: REASON });
    expect(submit()).toHaveAttribute("aria-disabled", "true");
    expect(submit()).toHaveAccessibleDescription(REASON);
  });

  // The archived latch can land while the user is typing in the box.
  it("refuses the mod+Enter submit chord", async () => {
    const user = userEvent.setup();
    const { onSubmit, setReadOnly } = renderComposer({ value: "a draft" });
    await user.click(editor());
    setReadOnly(REASON);
    expect(editorDisabled()).toBe(true);
    // The engage hands focus to Submit; the chords must reach the editor's own
    // guard, so focus goes back to the (stand-in, still typeable) editor first.
    act(() => editor().focus());
    expect(document.activeElement).toBe(editor());
    await user.keyboard("{Control>}{Enter}{/Control}");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps Clear live: discarding a draft is local", async () => {
    const { onClear } = renderComposer({
      value: "a draft",
      readOnlyReason: REASON,
    });
    const clear = screen.getByRole("button", { name: "Clear" });
    expect(clear).not.toHaveAttribute("aria-disabled", "true");
    expect(clear).not.toHaveAccessibleDescription(REASON);
    await userEvent.click(clear);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("shows the reason on the collapsed strip", async () => {
    renderComposer({
      value: "a draft",
      readOnlyReason: REASON,
      collapsed: true,
    });
    expect(await screen.findByText(REASON)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Comment" }),
    ).not.toBeInTheDocument();
  });

  it("without the prop, the composer stays live (negative control)", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderComposer({ value: "a draft" });
    expect(editorDisabled()).toBe(false);
    const button = submit();
    expect(button).not.toHaveAttribute("aria-disabled", "true");
    expect(button).not.toHaveAccessibleDescription(REASON);
    await user.click(editor());
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await user.click(button);
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("busy and read-only: submit names the hold, Clear the busy reason", () => {
    renderComposer({ value: "a draft", readOnlyReason: REASON, busy: true });
    expect(submit()).toHaveAttribute("aria-disabled", "true");
    expect(submit()).toHaveAccessibleDescription(REASON);
    const clear = screen.getByRole("button", { name: "Clear" });
    expect(clear).toHaveAttribute("aria-disabled", "true");
    expect(clear).toHaveAccessibleDescription(BUSY);
  });

  it("null reads as no hold, collapsed strip included", async () => {
    renderComposer({
      value: "a draft",
      readOnlyReason: null,
      collapsed: true,
    });
    await screen.findByText("Draft");
    expect(screen.queryByText(REASON)).not.toBeInTheDocument();
  });
});

// jsdom keeps focus on a disabled element, so each case asserts where focus WENT.

/** Blurs the editor to body without React seeing it. React DOM turns its event
 *  system off during a commit, so Chromium's blur as `disabled` lands on the
 *  focused textarea never reaches onBlur; stopping the native focusout before
 *  React's root listener reproduces that (jsdom won't blur a disabled element). */
function blurUnseenByReact() {
  const block = (e: Event) => e.stopPropagation();
  window.addEventListener("focusout", block, true);
  try {
    editor().blur();
  } finally {
    window.removeEventListener("focusout", block, true);
  }
}
describe("CommentComposer hold engaging under focus", () => {
  it("moves focus from the editor to the held submit after a keyboard submit's archived refusal", async () => {
    const user = userEvent.setup();
    const { onSubmit, setReadOnly } = renderComposer({
      value: "a draft",
      holdKey: "A",
    });
    await user.click(editor());
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // The refusal latches the same PR read-only.
    setReadOnly(PR_ARCHIVED_READONLY_MESSAGE, "A");
    expect(document.activeElement).toBe(submit());
    expect(submit()).toHaveAccessibleDescription(PR_ARCHIVED_READONLY_MESSAGE);
  });

  it("moves focus when the editor lost it to a blur React never processed", async () => {
    const user = userEvent.setup();
    const { setReadOnly } = renderComposer({ value: "a draft", holdKey: "A" });
    await user.click(editor());
    blurUnseenByReact();
    expect(document.activeElement).toBe(document.body);
    setReadOnly(REASON, "A");
    expect(document.activeElement).toBe(submit());
  });

  it("leaves focus alone after a click-away blur from the enabled editor", async () => {
    const user = userEvent.setup();
    const { setReadOnly } = renderComposer({ value: "a draft", holdKey: "A" });
    await user.click(editor());
    // A click on plain text: focus leaves for nothing while the editor is live.
    act(() => editor().blur());
    expect(document.activeElement).toBe(document.body);
    setReadOnly(REASON, "A");
    expect(document.activeElement).toBe(document.body);
  });

  it("drops the editor's focus ownership when the PR changes", async () => {
    const user = userEvent.setup();
    const { setReadOnly } = renderComposer({ value: "a draft", holdKey: "A" });
    await user.click(editor());
    blurUnseenByReact();
    expect(document.activeElement).toBe(document.body);
    setReadOnly(undefined, "B");
    setReadOnly(REASON, "B");
    expect(document.activeElement).toBe(document.body);
  });

  it("leaves focus alone when the hold comes with another PR", async () => {
    const user = userEvent.setup();
    const { setReadOnly } = renderComposer({ value: "a draft", holdKey: "A" });
    await user.click(editor());
    setReadOnly(REASON, "B");
    expect(document.activeElement).toBe(editor());
  });

  it("leaves focus alone when it is outside the editor", async () => {
    const user = userEvent.setup();
    const { setReadOnly } = renderComposer({ value: "a draft", holdKey: "A" });
    await user.click(editor());
    await user.tab();
    const elsewhere = document.activeElement;
    expect(elsewhere).not.toBe(editor());
    expect(elsewhere).not.toBe(document.body);
    setReadOnly(REASON, "A");
    expect(document.activeElement).toBe(elsewhere);
  });
});

describe("focus-comment palette action", () => {
  function Action({ composerHold }: { composerHold: string | null }) {
    useFocusCommentAction(() => undefined, {
      threadActive: true,
      canComment: true,
      composerHold,
    });
    const available = useAvailableActions();
    return (
      <output data-testid="offered">
        {String(available.has("focus-comment"))}
      </output>
    );
  }

  it("is not offered while the composer is held", () => {
    const view = render(<Action composerHold={null} />);
    expect(screen.getByTestId("offered")).toHaveTextContent("true");
    view.rerender(<Action composerHold={REASON} />);
    expect(screen.getByTestId("offered")).toHaveTextContent("false");
  });
});
