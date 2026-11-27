import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JiraCommentItem } from "@/features/issues/JiraIssueView";
import type { JiraComment } from "@/lib/jira/types";

const writes = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let pending: unknown[] = [];
  return {
    edit: vi.fn(async (_vars: unknown) => undefined),
    /** The repo's pending Jira writes, set by a test as its write runs. */
    pending: () => pending,
    setPending(next: unknown[]) {
      pending = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});
vi.mock("@/lib/jira/queries", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await importOriginal<typeof import("@/lib/jira/queries")>()),
    useJiraCommentEdit: () => ({ mutateAsync: writes.edit }),
    useJiraCommentDelete: () => ({ mutateAsync: async () => undefined }),
    usePendingJiraWrites: () =>
      useSyncExternalStore(writes.subscribe, writes.pending),
  };
});

// jsdom has no layout: the editors scroll themselves into view on focus.
Element.prototype.scrollIntoView ??= () => undefined;
afterEach(() => {
  cleanup();
  writes.edit.mockReset();
  writes.setPending([]);
});

const comment: JiraComment = {
  id: "10001",
  author: null,
  bodyMd: "Jira words",
  createdAt: "2026-11-01T10:00:00Z",
  updatedAt: null,
};

type ItemProps = Partial<ComponentProps<typeof JiraCommentItem>>;

function renderItem() {
  const client = new QueryClient();
  const ui = (extra: ItemProps) => (
    <QueryClientProvider client={client}>
      <JiraCommentItem
        repoPath="C:/repo"
        link={{
          siteHost: "x.atlassian.net",
          projectKey: "P",
          projectName: "P",
        }}
        issueKey="P-1"
        comment={comment}
        isOwn
        canEditOwn
        canDeleteOwn
        canEditAll={false}
        canDeleteAll={false}
        {...extra}
      />
    </QueryClientProvider>
  );
  const view = render(ui({}));
  return { ...view, update: (extra: ItemProps) => view.rerender(ui(extra)) };
}

const trigger = () => screen.getByRole("button", { name: "Comment actions" });
const box = () =>
  screen.queryByRole<HTMLTextAreaElement>("textbox", { name: "Edit comment" });

async function openEdit() {
  const user = userEvent.setup();
  await user.click(trigger());
  await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
  const field = await waitFor(() => box() as HTMLTextAreaElement);
  await user.type(field, " revised");
  return { user, field };
}

describe("a Jira comment edit lands on its actions trigger", () => {
  it.each(["Save", "Cancel"])("after %s", async (name) => {
    renderItem();
    const { user } = await openEdit();
    await user.click(screen.getByRole("button", { name }));
    await waitFor(() => expect(box()).toBeNull());
    expect(document.activeElement).toBe(trigger());
  });

  it("sends the revised body, holds while it runs, and gives the field back with its text when the save fails", async () => {
    let refuse!: () => void;
    writes.edit.mockImplementationOnce((vars) => {
      writes.setPending([{ kind: "comment-edit", vars, paused: false }]);
      return new Promise<undefined>((_, reject) => {
        refuse = () => reject(new Error("refused"));
      });
    });
    renderItem();
    const { user, field } = await openEdit();
    field.setSelectionRange(0, 0);
    const save = screen.getByRole("button", { name: "Save" });
    await user.click(save);
    expect(writes.edit).toHaveBeenCalledWith({
      issueKey: "P-1",
      commentId: "10001",
      bodyMd: "Jira words revised",
    });
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(document.activeElement).toBe(save);
    await act(async () => {
      writes.setPending([]);
      refuse();
    });
    expect(box()).toBe(field);
    expect(field).toHaveValue("Jira words revised");
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(field.value.length);
  });
});

describe("a Jira comment edit whose save fails before it shows pending", () => {
  it("gives the field back with its text and the caret at the end", async () => {
    // Rejects at once and never reports a pending write, so no frame of the
    // editor ever renders the save as running.
    writes.edit.mockImplementationOnce(async () => {
      throw new Error("refused");
    });
    renderItem();
    const { user, field } = await openEdit();
    field.setSelectionRange(0, 0);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => undefined);
    expect(writes.edit).toHaveBeenCalledTimes(1);
    expect(box()).toBe(field);
    expect(field).toHaveValue("Jira words revised");
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(field.value.length);
  });
});

describe("a Jira comment edit whose menu goes away while it is open", () => {
  it.each<[string, ItemProps]>([
    [
      "its permissions are withdrawn",
      { canEditOwn: false, canDeleteOwn: false },
    ],
    ["the issue goes stale", { stale: true }],
  ])("lands Cancel on the comment when %s", async (_case, extra) => {
    const item = renderItem();
    const { user } = await openEdit();
    item.update(extra);
    expect(box()).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(box()).toBeNull());
    expect(
      screen.queryByRole("button", { name: "Comment actions" }),
    ).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(
      screen.getByText("Jira words").closest('[tabindex="-1"]'),
    );
  });

  it("names the landing by its author and rings it, and takes no focus while the menu shows", async () => {
    const item = renderItem();
    const root = () => screen.getByText("Jira words").closest(".space-y-1");
    // With the menu there, the comment is no focus target for a text click.
    await screen.findByRole("button", { name: "Comment actions" });
    expect(root()?.hasAttribute("tabindex")).toBe(false);
    expect(screen.queryByRole("group", { name: "unknown" })).toBeNull();
    const { user } = await openEdit();
    item.update({ canEditOwn: false, canDeleteOwn: false });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(box()).toBeNull());
    const landing = screen.getByRole("group", { name: "unknown" });
    expect(document.activeElement).toBe(landing);
    expect(landing.className).toContain("focus-visible:ring-1");
  });
});
