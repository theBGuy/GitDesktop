import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
// Aliased: scripts/toast-clearance-adopters.test.mjs rosters every product
// `<CommentComposer` mount, and this harness mount docks on no pane.
import { CommentComposer as Composer } from "@/features/conversations/CommentComposer";
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
}: {
  value: string;
  readOnlyReason?: string | null;
  collapsed?: boolean;
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
  const tree = (reason: string | null | undefined) => (
    <QueryClientProvider client={client}>
      <Composer
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
    setReadOnly: (reason: string | null | undefined) => rerender(tree(reason)),
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
