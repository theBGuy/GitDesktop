// Thread tells its host whether its editor is open from a layout effect's
// setup only: an <Activity> hide runs effect cleanups with the editor still
// open, and a host pinning that edit's row must not hear the hide as a close.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Thread } from "@/features/conversations/Thread";
import { TabPanel } from "@/features/repository/TabPanel";
import type { PrThreadOut } from "@/lib/git/types";

afterEach(cleanup);

// jsdom implements no scrollIntoView; the editor calls it from a frame callback on open.
Element.prototype.scrollIntoView ??= () => undefined;

const thread: PrThreadOut = {
  author: "ada",
  authorAvatarUrl: "",
  state: "",
  body: "On line 4",
  date: "2026-11-01T10:00:00Z",
  id: "c1",
  url: "",
  viewerDidAuthor: true,
  isMinimized: false,
  minimizedReason: "",
  reviewId: "",
};

it("keeps reporting an open editor across a hide and show, and reports its close", async () => {
  const onEditingChange = vi.fn();
  const client = new QueryClient();
  const ui = (active: boolean) => (
    <QueryClientProvider client={client}>
      <TabPanel active={active}>
        <Thread
          thread={thread}
          onSaveEdit={() => undefined}
          onEditingChange={onEditingChange}
        />
      </TabPanel>
    </QueryClientProvider>
  );
  const view = render(ui(true));
  fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  await screen.findByRole("textbox", { name: "Edit comment" });
  expect(onEditingChange).toHaveBeenLastCalledWith(true);
  view.rerender(ui(false));
  expect(onEditingChange).toHaveBeenLastCalledWith(true);
  view.rerender(ui(true));
  expect(onEditingChange).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onEditingChange).toHaveBeenLastCalledWith(false);
});
