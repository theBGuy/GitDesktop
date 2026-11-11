import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "@/components/markdown/markdown";
import { attachmentStage } from "@/lib/attachments/api";
import {
  beginAttachmentPost,
  releaseHeldCopies,
  settleAttachmentPost,
  stageAttachment,
} from "@/lib/attachments/store";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/attachments/api", () => ({
  attachmentStage: vi.fn(),
  attachmentDiscard: vi.fn(async () => undefined),
}));

// The store is module state that outlives each test, so every test stages into
// its own session and key.
let sessionSeq = 0;
let keySeq = 0;
let urlSeq = 0;

beforeEach(() => {
  sessionSeq += 1;
  const session = sessionSeq.toString(16).padStart(32, "0");
  let n = 0;
  vi.mocked(attachmentStage).mockReset();
  vi.mocked(attachmentStage).mockImplementation(async () => {
    n += 1;
    return {
      session,
      name: `image-${n}.png`,
      mime: "image/png",
      size: 1,
      width: 400,
      height: 300,
    };
  });
  URL.createObjectURL = vi.fn(() => {
    urlSeq += 1;
    return `blob:v-${urlSeq}`;
  });
  URL.revokeObjectURL = vi.fn();
});

afterAll(() => expect(unmockedCommands).toEqual([]));

const BODY = "![a](image-1.png) ![b](image-2.png)";

/** Two staged images posting in one body, rendered as the post's optimistic
 *  row with the viewer open on the first. */
async function postedRowWithViewer() {
  keySeq += 1;
  const draftKey = `issue-comment|/repo#origin#viewer-${keySeq}`;
  const owner = {};
  for (let i = 0; i < 2; i += 1)
    await stageAttachment({
      draftKey,
      owner,
      file: new File([new Uint8Array([1, 2])], "x.png"),
      source: "paste",
      blockedReason: null,
    });
  const ticket = beginAttachmentPost(draftKey, BODY, true);
  if (!ticket) throw new Error("no ticket");
  const client = new QueryClient();
  const { container } = render(
    <QueryClientProvider client={client}>
      <Markdown stagedImages={{ postToken: ticket.token }}>{BODY}</Markdown>
    </QueryClientProvider>,
  );
  const imgs = () => Array.from(container.querySelectorAll("img"));
  await waitFor(() => {
    expect(imgs()).toHaveLength(2);
    for (const el of imgs()) expect(el.getAttribute("src")).toMatch(/^blob:/);
  });
  for (const el of imgs()) {
    Object.defineProperty(el, "naturalWidth", { value: 400 });
    Object.defineProperty(el, "naturalHeight", { value: 300 });
    fireEvent.load(el);
  }
  const shown = imgs()[0].getAttribute("src");
  fireEvent.click(imgs()[0]);
  const dialog = await screen.findByRole("dialog");
  expect(dialog.querySelector(`img[src="${shown}"]`)).not.toBeNull();
  return { ticket, shown };
}

describe("a posted row's open viewer at the post's settle", () => {
  it("closes when a failed image drops out of the row", async () => {
    const { ticket } = await postedRowWithViewer();
    act(() => {
      settleAttachmentPost(ticket, { posted: true, failed: ["image-2.png"] });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    releaseHeldCopies(ticket.token);
  });

  it("stays open on the same image through a full success", async () => {
    const { ticket, shown } = await postedRowWithViewer();
    act(() => {
      settleAttachmentPost(ticket, { posted: true, failed: [] });
    });
    // Flushes the commit and effects the settle's store notify scheduled.
    await act(() => Promise.resolve());
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector(`img[src="${shown}"]`)).not.toBeNull();
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(shown);
    releaseHeldCopies(ticket.token);
  });
});
