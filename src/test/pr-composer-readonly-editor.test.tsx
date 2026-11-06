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

// The composer's one IPC seam; the editor itself is the real MarkdownEditor.
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));

const REASON =
  "This conversation is locked, so only collaborators can comment.";

beforeEach(() => {
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
});

afterAll(() => expect(unmockedCommands).toEqual([]));

function renderHeld() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, structuredClone(DEFAULT_SETTINGS));
  const onChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <Composer
        value="a draft"
        onChange={onChange}
        onSubmit={vi.fn()}
        submitLabel="Comment"
        ariaLabel="Leave a comment"
        placeholder="Leave a comment…"
        readOnlyReason={REASON}
      />
    </QueryClientProvider>,
  );
  return { onChange };
}

describe("CommentComposer readOnlyReason over the real editor", () => {
  it("disables the textarea and every formatting button", () => {
    renderHeld();
    expect(
      screen.getByRole("textbox", { name: "Leave a comment" }),
    ).toBeDisabled();
    const formatting = ["Heading", "Bold", "Italic", "Link"].map((label) =>
      screen.getByRole("button", { name: new RegExp(`^${label}`) }),
    );
    for (const button of formatting) expect(button).toBeDisabled();
  });

  it("leaves the draft unchanged when the user types", async () => {
    const user = userEvent.setup();
    const { onChange } = renderHeld();
    const textarea = screen.getByRole("textbox", { name: "Leave a comment" });
    await user.type(textarea, " more");
    expect(textarea).toHaveValue("a draft");
    expect(onChange).not.toHaveBeenCalled();
  });
});
