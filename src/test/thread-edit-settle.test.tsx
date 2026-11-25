// A comment's inline edit stays open, frozen, until its save settles: a save
// that failed keeps the editor and the revised text, and a close (a save that
// landed, or Cancel) hands focus to that comment's actions trigger unless the
// user has moved on or the comment's tab is hidden.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalComment } from "@/features/conversations/LocalComment";
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
  body: "Original words",
  date: "2026-11-01T10:00:00Z",
  id: "c1",
  url: "",
  viewerDidAuthor: true,
  isMinimized: false,
  minimizedReason: "",
  reviewId: "",
};

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function Host({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

const trigger = () => screen.getByRole("button", { name: "Comment actions" });
const editBox = () =>
  screen.queryByRole<HTMLTextAreaElement>("textbox", { name: "Edit comment" });

/** Opens the editor, types the revision and puts focus in the box. */
async function openAndRevise(text = "Revised words") {
  fireEvent.click(trigger());
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  const box = await screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "Edit comment",
  });
  fireEvent.change(box, { target: { value: text } });
  act(() => box.focus());
  return box;
}

async function settle<T>(
  d: { promise: Promise<T>; resolve: (v: T) => void },
  v: T,
) {
  await act(async () => {
    d.resolve(v);
    await d.promise;
  });
}

describe("Thread's inline edit", () => {
  it("closes only once a save resolves true, and lands focus on the comment's trigger", async () => {
    const d = deferred<boolean>();
    const onSaveEdit = vi.fn(() => d.promise);
    render(
      <Host>
        <Thread thread={thread} onSaveEdit={onSaveEdit} />
      </Host>,
    );
    const box = await openAndRevise();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSaveEdit).toHaveBeenCalledWith("Revised words");
    expect(editBox()).toBe(box);
    await settle(d, true);
    await waitFor(() => expect(editBox()).toBeNull());
    expect(document.activeElement).toBe(trigger());
  });

  it("lands focus on the trigger at once on Cancel", async () => {
    const onSaveEdit = vi.fn(() => true);
    render(
      <Host>
        <Thread thread={thread} onSaveEdit={onSaveEdit} />
      </Host>,
    );
    await openAndRevise();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(editBox()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(onSaveEdit).not.toHaveBeenCalled();
  });

  it("keeps the editor and its text when the save resolves false, and saves again", async () => {
    const onError = vi.fn();
    const first = deferred<boolean>();
    const onSaveEdit = vi
      .fn<(body: string) => Promise<boolean>>()
      .mockImplementationOnce(async () => {
        const saved = await first.promise;
        if (!saved) onError();
        return saved;
      })
      .mockResolvedValueOnce(true);
    render(
      <Host>
        <Thread thread={thread} onSaveEdit={onSaveEdit} />
      </Host>,
    );
    const box = await openAndRevise();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle(first, false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(editBox()).toBe(box);
    expect(box).toHaveValue("Revised words");
    expect(box).not.toBeDisabled();
    expect(document.activeElement).toBe(box);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSaveEdit).toHaveBeenCalledTimes(2);
    expect(onSaveEdit).toHaveBeenLastCalledWith("Revised words");
    await waitFor(() => expect(editBox()).toBeNull());
  });

  it("freezes the editor while a save is pending, and a second submit sends nothing", async () => {
    const d = deferred<boolean>();
    const onSaveEdit = vi.fn(() => d.promise);
    render(
      <Host>
        <Thread thread={thread} onSaveEdit={onSaveEdit} />
      </Host>,
    );
    const box = await openAndRevise();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(onSaveEdit).toHaveBeenCalledTimes(1);
    expect(box).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSaveEdit).toHaveBeenCalledTimes(1);
    expect(editBox()).toBe(box);
    await settle(d, true);
    await waitFor(() => expect(editBox()).toBeNull());
  });

  it("leaves focus on a control the user moved to while the save was pending", async () => {
    const d = deferred<boolean>();
    render(
      <Host>
        <button type="button">Elsewhere</button>
        <Thread thread={thread} onSaveEdit={() => d.promise} />
      </Host>,
    );
    await openAndRevise();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const other = screen.getByRole("button", { name: "Elsewhere" });
    act(() => other.focus());
    await settle(d, true);
    await waitFor(() => expect(editBox()).toBeNull());
    expect(document.activeElement).toBe(other);
  });

  it("takes no focus on re-show when the save settled while its tab was hidden", async () => {
    const d = deferred<boolean>();
    const client = new QueryClient();
    const ui = (active: boolean) => (
      <QueryClientProvider client={client}>
        <TabPanel active={active}>
          <Thread thread={thread} onSaveEdit={() => d.promise} />
        </TabPanel>
      </QueryClientProvider>
    );
    const view = render(ui(true));
    await openAndRevise();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    view.rerender(ui(false));
    await settle(d, true);
    view.rerender(ui(true));
    await waitFor(() => expect(editBox()).toBeNull());
    expect(document.activeElement).not.toBe(trigger());
  });
});

/** Focus sits on a live control: never <body>, never one the freeze disabled
 *  (a browser drops focus off a disabled element; jsdom leaves it there). */
function expectFocusLive() {
  const active = document.activeElement;
  expect(active).not.toBe(document.body);
  expect(active?.matches(":disabled")).toBe(false);
}

async function tick() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

/** Saves from the field's chord or the Save button, sampling focus at each
 *  await while the save is in flight and after it lands. */
async function saveKeepsFocus(route: "chord" | "click") {
  const d = deferred<boolean>();
  const user = userEvent.setup();
  render(
    <Host>
      <Thread thread={thread} onSaveEdit={() => d.promise} />
    </Host>,
  );
  await openAndRevise();
  if (route === "chord") await user.keyboard("{Control>}{Enter}{/Control}");
  else await user.click(screen.getByRole("button", { name: "Save" }));
  expectFocusLive();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Save" }),
  );
  await tick();
  expectFocusLive();
  await settle(d, true);
  expectFocusLive();
  await waitFor(() => expect(editBox()).toBeNull());
  expect(document.activeElement).toBe(trigger());
}

/** A save that fails (resolves false, or rejects) from the Save button. */
async function failedSaveRefocuses(rejects: boolean) {
  const d = deferred<boolean>();
  const user = userEvent.setup();
  const saver = () =>
    rejects ? d.promise.then(() => Promise.reject(new Error("x"))) : d.promise;
  render(
    <Host>
      <Thread thread={thread} onSaveEdit={saver} />
    </Host>,
  );
  const box = await openAndRevise();
  box.setSelectionRange(0, 0);
  await user.click(screen.getByRole("button", { name: "Save" }));
  expectFocusLive();
  await settle(d, false);
  await tick();
  expect(editBox()).toBe(box);
  expect(document.activeElement).toBe(box);
  expect(box.selectionStart).toBe(box.value.length);
  expect(box.selectionEnd).toBe(box.value.length);
}

/** The user moves focus to another button while the save is in flight. */
async function movedFocusStays(saved: boolean) {
  const d = deferred<boolean>();
  const user = userEvent.setup();
  render(
    <Host>
      <button type="button">Elsewhere</button>
      <Thread thread={thread} onSaveEdit={() => d.promise} />
    </Host>,
  );
  await openAndRevise();
  await user.click(screen.getByRole("button", { name: "Save" }));
  const other = screen.getByRole("button", { name: "Elsewhere" });
  act(() => other.focus());
  await settle(d, saved);
  await tick();
  expect(editBox() === null).toBe(saved);
  expect(document.activeElement).toBe(other);
}

describe("Thread's inline edit keeps focus across a save", () => {
  it("never drops focus while a save from the field's chord is in flight, then lands on the trigger", async () => {
    await saveKeepsFocus("chord");
  });

  it("never drops focus while a save from the Save button is in flight, then lands on the trigger", async () => {
    await saveKeepsFocus("click");
  });

  it("puts focus back in the field, caret at the end, when the save resolves false", async () => {
    await failedSaveRefocuses(false);
  });

  it("puts focus back in the field, caret at the end, when the save rejects", async () => {
    await failedSaveRefocuses(true);
  });

  it("leaves focus on a control the user moved to when the save fails", async () => {
    await movedFocusStays(false);
  });

  it("leaves focus on a control the user moved to when the save lands", async () => {
    await movedFocusStays(true);
  });
});

describe("LocalComment's inline edit", () => {
  const comment = { body: "Original words", createdAt: "2026-11-01T10:00:00Z" };
  const noop = () => undefined;

  it.each(["Save", "Cancel"])(
    "lands focus on the comment's trigger after %s",
    async (button) => {
      const onSaveEdit = vi.fn();
      render(
        <Host>
          <LocalComment
            comment={comment}
            onSaveEdit={onSaveEdit}
            onDelete={noop}
            onHide={noop}
            onUnhide={noop}
          />
        </Host>,
      );
      await openAndRevise();
      fireEvent.click(screen.getByRole("button", { name: button }));
      expect(editBox()).toBeNull();
      expect(document.activeElement).toBe(trigger());
      expect(onSaveEdit).toHaveBeenCalledTimes(button === "Save" ? 1 : 0);
    },
  );
});
