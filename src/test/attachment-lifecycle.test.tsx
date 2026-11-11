import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { type ReactNode, useState } from "react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Markdown } from "@/components/markdown/markdown";
import { IMAGE_CAPTION_REASON } from "@/components/markdown/markdown-images";
import { MarkdownEditor } from "@/components/markdown-editor";
import { Thread } from "@/features/conversations/Thread";
import { attachmentDiscard, attachmentStage } from "@/lib/attachments/api";
import { encodeBase64 } from "@/lib/attachments/encode";
import {
  beginAttachmentPost,
  draftEntry,
  endDraftAttachments,
  settleAttachmentPost,
  stageAttachment,
} from "@/lib/attachments/store";
import {
  useAttachmentOwner,
  useDraftAttachments,
} from "@/lib/attachments/use-draft-attachments";
import { copyText } from "@/lib/clipboard";
import type { PrThreadOut } from "@/lib/git/types";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => undefined) }));
// The thread rows' host lookup; it never answers here.
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("@/lib/attachments/api", () => ({
  attachmentStage: vi.fn(),
  attachmentDiscard: vi.fn(async () => undefined),
}));
// The file reader every stage runs first, observed as is.
vi.mock("@/lib/attachments/encode", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/lib/attachments/encode")>();
  return { ...real, encodeBase64: vi.fn(real.encodeBase64) };
});

// The store is module state: every test stages into its own session and key.
let SESSION = "";
let sessionSeq = 0x400;
let seq = 0;
let urlSeq = 0;

type Staged = Awaited<ReturnType<typeof attachmentStage>>;
const stagedAs = (name: string): Staged => ({
  session: SESSION,
  name,
  mime: "image/png",
  size: 2048,
  width: 4,
  height: 4,
});

beforeEach(() => {
  sessionSeq += 1;
  SESSION = sessionSeq.toString(16).padStart(32, "0");
  vi.mocked(attachmentStage).mockReset();
  vi.mocked(attachmentDiscard).mockClear();
  let n = 0;
  vi.mocked(attachmentStage).mockImplementation(async () => {
    n += 1;
    return stagedAs(`image-${n}.png`);
  });
  URL.createObjectURL = vi.fn(() => {
    urlSeq += 1;
    return `blob:life-${urlSeq}`;
  });
  URL.revokeObjectURL = vi.fn();
  vi.mocked(encodeBase64).mockClear();
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, "execCommand");
});

afterAll(() => expect(unmockedCommands).toEqual([]));

const png = (name = "shot.png") =>
  new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });

function huge() {
  const file = png("huge.png");
  Object.defineProperty(file, "size", { value: 11 * 1024 * 1024 });
  return file;
}

function paste(target: Element, files: File[]) {
  return fireEvent.paste(target, {
    clipboardData: { files, types: ["Files"], getData: () => "" },
  });
}

/** jsdom has no execCommand: this one edits the focused textarea the way the
 *  webview does, firing the input event React reads. */
function installExecCommand() {
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: (command: string, _ui: boolean, insert?: string) => {
      const ta = document.activeElement as HTMLTextAreaElement;
      const { value, selectionStart: s, selectionEnd: e } = ta;
      const added = command === "delete" ? "" : (insert ?? "");
      setValue?.call(ta, value.slice(0, s) + added + value.slice(e));
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    },
  });
}

function Host({
  draftKey,
  hold = null,
}: {
  draftKey: string;
  hold?: string | null;
}) {
  const [texts, setTexts] = useState<Record<string, string>>({});
  const owner = useAttachmentOwner("issue-comment", false);
  const handle = useDraftAttachments({
    draftKey,
    owner,
    gateReason: null,
    holdReason: hold,
    writeDraft: (key, update) =>
      setTexts((t) => ({ ...t, [key]: update(t[key] ?? "") })),
  });
  return (
    <>
      <MarkdownEditor
        aria-label="Comment"
        value={texts[draftKey] ?? ""}
        onChange={(v) => setTexts((t) => ({ ...t, [draftKey]: v }))}
        attachments={handle}
      />
      <pre data-testid="texts">{JSON.stringify(texts)}</pre>
    </>
  );
}

const freshKey = () => {
  seq += 1;
  return `issue-comment|/life#origin#${seq}`;
};
const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
);
const textbox = () =>
  screen.getByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement;
const textOf = (key: string) =>
  (
    JSON.parse(screen.getByTestId("texts").textContent ?? "{}") as Record<
      string,
      string
    >
  )[key] ?? "";
const statusText = () =>
  screen
    .getAllByRole("status")
    .map((el) => el.textContent)
    .join("");
const chips = () =>
  screen.queryByRole("list", { name: "Attached images" })?.children.length ?? 0;

/** A stage call that waits until the test resolves it. */
function holdNextStage() {
  let resolve: (v: Staged) => void = () => undefined;
  vi.mocked(attachmentStage).mockImplementationOnce(
    () =>
      new Promise<Staged>((r) => {
        resolve = r;
      }),
  );
  return (v: Staged) => resolve(v);
}

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });

/** A later file reaches its stage only through its own file read: one task
 *  turn runs every queued continuation, then every read so far settles, then
 *  one more turn, so any stage a finished read would start has been called. */
const readsDrained = () =>
  act(async () => {
    const turn = () => new Promise((r) => setTimeout(r, 0));
    await turn();
    const files = vi.mocked(encodeBase64).mock.results.map((r) => r.value);
    const settled = await Promise.allSettled(files);
    await turn();
    expect(settled.map((s) => s.status)).not.toContain("rejected");
  });

describe("one attach gesture, one status line", () => {
  it("keeps a too-big refusal while a later file of the same paste stages", async () => {
    const key = freshKey();
    render(wrap(<Host draftKey={key} />));
    await act(async () => {
      paste(textbox(), [huge(), png()]);
    });
    await waitFor(() => expect(chips()).toBe(1));
    expect(statusText()).toBe(
      "The pasted file is 11.0 MB. Images can be at most 10 MB.",
    );
  });

  it("keeps a Rust refusal for file 1 of 2", async () => {
    vi.mocked(attachmentStage).mockRejectedValueOnce(
      new Error("That file isn't an image."),
    );
    const key = freshKey();
    render(wrap(<Host draftKey={key} />));
    await act(async () => {
      paste(textbox(), [png(), png()]);
    });
    await waitFor(() => expect(chips()).toBe(1));
    expect(statusText()).toBe("That file isn't an image.");
  });

  it("the next gesture clears it once", async () => {
    const key = freshKey();
    render(wrap(<Host draftKey={key} />));
    await act(async () => {
      paste(textbox(), [huge()]);
    });
    await waitFor(() => expect(statusText()).not.toBe(""));
    await act(async () => {
      paste(textbox(), [png()]);
    });
    await waitFor(() => expect(chips()).toBe(1));
    expect(statusText()).toBe("");
  });

  async function partialPost(key: string) {
    await act(async () => {
      paste(textbox(), [png(), png()]);
    });
    await waitFor(() => expect(chips()).toBe(2));
    const ticket = beginAttachmentPost(key, textOf(key), true);
    if (!ticket) throw new Error("no ticket");
    act(() => {
      settleAttachmentPost(ticket, { posted: true, failed: ["image-2.png"] });
    });
    expect(draftEntry(key)?.notice).toEqual({ failed: ["image-2.png"] });
  }

  it("the editor's own reference insert is no user edit", async () => {
    installExecCommand();
    const key = freshKey();
    render(wrap(<Host draftKey={key} />));
    await partialPost(key);
    await act(async () => {
      paste(textbox(), [png()]);
    });
    await waitFor(() => expect(textOf(key)).toContain("](image-3.png)"));
    expect(draftEntry(key)?.notice).toEqual({ failed: ["image-2.png"] });
    // A keystroke is an edit.
    fireEvent.change(textbox(), { target: { value: `${textOf(key)} x` } });
    expect(draftEntry(key)?.notice).toBeNull();
  });

  it("Remove in Preview is an edit", async () => {
    const key = freshKey();
    render(wrap(<Host draftKey={key} />));
    await partialPost(key);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove image-2.png" }));
    expect(textOf(key)).not.toContain("image-2.png");
    expect(draftEntry(key)?.notice).toBeNull();
  });
});

describe("a batch stops when its draft moves on", () => {
  async function pasteFour(key: string) {
    const release = holdNextStage();
    render(wrap(<Host draftKey={key} />));
    await act(async () => {
      paste(textbox(), [png(), png(), png(), png()]);
    });
    await waitFor(() => expect(attachmentStage).toHaveBeenCalledTimes(1));
    return release;
  }

  it("Clear during file 1: no later stage, no reference, no new entry", async () => {
    const key = freshKey();
    const release = await pasteFour(key);
    act(() => endDraftAttachments(key));
    release(stagedAs("image-1.png"));
    await readsDrained();
    // File 1 was read; file 2 never was.
    expect(encodeBase64).toHaveBeenCalledTimes(1);
    expect(attachmentStage).toHaveBeenCalledTimes(1);
    expect(textOf(key)).toBe("");
    expect(draftEntry(key)).toBeUndefined();
  });

  it("a submit during file 1: no later stage, no reference", async () => {
    const key = freshKey();
    const release = await pasteFour(key);
    act(() => {
      beginAttachmentPost(key, "", true);
    });
    release(stagedAs("image-1.png"));
    await readsDrained();
    expect(encodeBase64).toHaveBeenCalledTimes(1);
    expect(attachmentStage).toHaveBeenCalledTimes(1);
    expect(textOf(key)).toBe("");
  });

  it("a refusal on file 2 of 3 still stages file 3", async () => {
    let n = 0;
    vi.mocked(attachmentStage).mockImplementation(async () => {
      n += 1;
      if (n === 2) throw new Error("That file isn't an image.");
      return stagedAs(`image-${n}.png`);
    });
    const key = freshKey();
    render(wrap(<Host draftKey={key} />));
    await act(async () => {
      paste(textbox(), [png(), png(), png()]);
    });
    await waitFor(() => expect(chips()).toBe(2));
    expect(attachmentStage).toHaveBeenCalledTimes(3);
    expect(statusText()).toBe("That file isn't an image.");
  });
});

describe("chip Remove", () => {
  it("removes a reference with a bracketed alt and a plain link to the name", async () => {
    const key = freshKey();
    render(wrap(<Host draftKey={key} />));
    await act(async () => {
      paste(textbox(), [png()]);
    });
    await waitFor(() => expect(chips()).toBe(1));
    fireEvent.change(textbox(), {
      target: { value: "a ![Before [v2]](image-1.png) b [see](image-1.png)" },
    });
    expect(chips()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove image-1.png" }));
    expect(textOf(key)).toBe("a  b ");
    expect(chips()).toBe(0);
  });

  it("a reference alone on its line takes its separator with it, in one splice", async () => {
    installExecCommand();
    const key = freshKey();
    render(wrap(<Host draftKey={key} />));
    await act(async () => {
      paste(textbox(), [png(), png()]);
    });
    await waitFor(() => expect(chips()).toBe(2));
    const before = textOf(key);
    expect(before).toBe("![image](image-1.png)\n![image](image-2.png)");
    const exec = vi.spyOn(document, "execCommand");
    fireEvent.click(screen.getByRole("button", { name: "Remove image-1.png" }));
    expect(textOf(key)).toBe("![image](image-2.png)");
    expect(exec).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove image-2.png" }));
    expect(textOf(key)).toBe("");
  });

  it("a held Enter on Remove does nothing; a fresh one is left alone", async () => {
    const key = freshKey();
    render(wrap(<Host draftKey={key} />));
    await act(async () => {
      paste(textbox(), [png()]);
    });
    await waitFor(() => expect(chips()).toBe(1));
    const remove = screen.getByRole("button", { name: "Remove image-1.png" });
    expect(fireEvent.keyDown(remove, { key: "Enter", repeat: true })).toBe(
      false,
    );
    expect(fireEvent.keyDown(remove, { key: "Enter" })).toBe(true);
  });
});

describe("a parked post's status line", () => {
  it("shows the host's hold while posting, not the uploading text", async () => {
    const key = freshKey();
    const queued = "Queued: posts when you're back online.";
    const { rerender } = render(wrap(<Host draftKey={key} />));
    await act(async () => {
      paste(textbox(), [png()]);
    });
    await waitFor(() => expect(chips()).toBe(1));
    act(() => {
      beginAttachmentPost(key, textOf(key), true);
    });
    expect(statusText()).toBe("Uploading 1 image and posting…");
    rerender(wrap(<Host draftKey={key} hold={queued} />));
    expect(statusText()).toBe(queued);
  });
});

describe("a held attach's reason lasts as long as its hold", () => {
  const uploading = "Uploading 1 image and posting…";
  const pressAttach = () =>
    fireEvent.keyDown(screen.getByRole("button", { name: /Attach image/ }), {
      key: "Enter",
    });

  async function blockedMidPost(key: string) {
    const view = render(wrap(<Host draftKey={key} />));
    await act(async () => {
      paste(textbox(), [png()]);
    });
    await waitFor(() => expect(chips()).toBe(1));
    let ticket: ReturnType<typeof beginAttachmentPost> = null;
    act(() => {
      ticket = beginAttachmentPost(key, textOf(key), true);
    });
    view.rerender(wrap(<Host draftKey={key} hold={uploading} />));
    pressAttach();
    expect(draftEntry(key)?.status).toEqual({
      tone: "info",
      text: uploading,
      held: true,
    });
    if (!ticket) throw new Error("no ticket");
    return { view, ticket: ticket as NonNullable<typeof ticket> };
  }

  it("clears when a failed post ends the hold", async () => {
    const key = freshKey();
    const { view, ticket } = await blockedMidPost(key);
    act(() => {
      settleAttachmentPost(ticket, { posted: false, failed: [] });
    });
    view.rerender(wrap(<Host draftKey={key} />));
    expect(chips()).toBe(1);
    expect(statusText()).toBe("");
    await waitFor(() => expect(draftEntry(key)?.status).toBeNull());
    // The same words holding again later never bring it back.
    view.rerender(wrap(<Host draftKey={key} hold={uploading} />));
    expect(statusText()).toBe("");
  });

  it("clears when a landed post ends the hold", async () => {
    const key = freshKey();
    const { view, ticket } = await blockedMidPost(key);
    act(() => {
      settleAttachmentPost(ticket, { posted: true, failed: [] });
    });
    view.rerender(wrap(<Host draftKey={key} />));
    expect(statusText()).toBe("");
  });

  it("clears when an offline hold ends, and stays gone when it returns", async () => {
    const key = freshKey();
    const offline = "You're offline. Reconnect to attach images.";
    const view = render(wrap(<Host draftKey={key} hold={offline} />));
    pressAttach();
    expect(statusText()).toBe(offline);
    view.rerender(wrap(<Host draftKey={key} />));
    expect(statusText()).toBe("");
    await waitFor(() => expect(draftEntry(key)?.status).toBeNull());
    view.rerender(wrap(<Host draftKey={key} hold={offline} />));
    expect(statusText()).toBe("");
  });

  it("a refusal survives the same hold coming and going", async () => {
    const key = freshKey();
    const view = render(wrap(<Host draftKey={key} />));
    await act(async () => {
      paste(textbox(), [huge()]);
    });
    const refusal = "The pasted file is 11.0 MB. Images can be at most 10 MB.";
    await waitFor(() => expect(statusText()).toBe(refusal));
    view.rerender(wrap(<Host draftKey={key} hold={uploading} />));
    view.rerender(wrap(<Host draftKey={key} />));
    await flush();
    expect(statusText()).toBe(refusal);
  });
});

describe("the chip lightbox follows its draft", () => {
  it("never reopens when the draft it closed on returns", async () => {
    const a = freshKey();
    const b = freshKey();
    const { rerender } = render(wrap(<Host draftKey={a} />));
    await act(async () => {
      paste(textbox(), [png()]);
    });
    await waitFor(() => expect(chips()).toBe(1));
    fireEvent.click(
      screen.getByRole("button", { name: "Preview image-1.png" }),
    );
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    rerender(wrap(<Host draftKey={b} />));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    rerender(wrap(<Host draftKey={a} />));
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("never reopens when the draft's chips empty and refill", async () => {
    const key = freshKey();
    render(wrap(<Host draftKey={key} />));
    await act(async () => {
      paste(textbox(), [png()]);
    });
    await waitFor(() => expect(chips()).toBe(1));
    fireEvent.click(
      screen.getByRole("button", { name: "Preview image-1.png" }),
    );
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    // A landed post clears the text under the same draft key; the modal hides
    // the editor from the accessibility tree meanwhile.
    fireEvent.change(
      screen.getByRole("textbox", { name: "Comment", hidden: true }),
      { target: { value: "" } },
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => {
      paste(textbox(), [png()]);
    });
    await waitFor(() => expect(chips()).toBe(1));
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("staged images render through the render's own source", () => {
  const typed = [
    "Inline `![x](image-1.png)` here.",
    "",
    "```",
    "![y](image-1.png)",
    "```",
    "",
    "[see](image-1.png) and ![z](image-1.png)",
  ].join("\n");

  it("Preview shows a staged image and leaves a code span, a fence and a link as typed", async () => {
    const key = freshKey();
    render(wrap(<Host draftKey={key} />));
    await act(async () => {
      paste(textbox(), [png()]);
    });
    await waitFor(() => expect(chips()).toBe(1));
    fireEvent.change(textbox(), { target: { value: typed } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const img = await screen.findByRole("img", { name: "z" });
    expect(img.getAttribute("src")).toMatch(/^blob:life-/);
    const preview = img.closest("div") as HTMLElement;
    const codes = Array.from(preview.querySelectorAll("code"));
    expect(codes.map((c) => c.textContent?.trim())).toEqual([
      "![x](image-1.png)",
      "![y](image-1.png)",
    ]);
    // The link renders exactly as a render without staged images does.
    const plain = render(wrap(<Markdown>{typed}</Markdown>));
    const link = (root: ParentNode) =>
      Array.from(root.querySelectorAll("a")).find(
        (a) => a.textContent === "see",
      )?.outerHTML;
    expect(link(preview)).toBe(link(plain.container));
  });

  it("a draft switch under identical text re-resolves Preview through the new draft", async () => {
    vi.mocked(attachmentStage).mockImplementation(async () =>
      stagedAs("image-1.png"),
    );
    const a = freshKey();
    const b = freshKey();
    const c = freshKey();
    const { rerender } = render(wrap(<Host draftKey={b} />));
    await act(async () => {
      paste(textbox(), [png()]);
    });
    await waitFor(() => expect(chips()).toBe(1));
    const urlB = draftEntry(b)?.images[0].url;
    // C has the same text but nothing staged under it.
    rerender(wrap(<Host draftKey={c} />));
    fireEvent.change(textbox(), { target: { value: "![image](image-1.png)" } });
    rerender(wrap(<Host draftKey={a} />));
    await act(async () => {
      paste(textbox(), [png()]);
    });
    await waitFor(() => expect(chips()).toBe(1));
    const urlA = draftEntry(a)?.images[0].url;
    expect(textOf(a)).toBe(textOf(b));
    expect(textOf(a)).toBe(textOf(c));
    expect(urlA).not.toBe(urlB);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByRole("img", { name: "image" })).toHaveAttribute(
      "src",
      urlA,
    );
    rerender(wrap(<Host draftKey={b} />));
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "image" })).toHaveAttribute(
        "src",
        urlB,
      ),
    );
    rerender(wrap(<Host draftKey={c} />));
    await waitFor(() =>
      expect(screen.queryByRole("img", { name: "image" })).toBeNull(),
    );
    expect(
      screen.getByText(`image · ${IMAGE_CAPTION_REASON.noRepo}`),
    ).toBeInTheDocument();
  });

  it("names an alt-less staged image by its file name", async () => {
    const key = freshKey();
    const owner = {};
    await stageAttachment({
      draftKey: key,
      owner,
      file: png(),
      source: "paste",
      blockedReason: null,
    });
    const { container } = render(
      wrap(
        <Markdown stagedImages={{ draftKey: key, owner }}>
          {"![](image-1.png)"}
        </Markdown>,
      ),
    );
    const img = container.querySelector("img");
    if (!img) throw new Error("no image");
    expect(img.getAttribute("src")).toMatch(/^blob:/);
    Object.defineProperty(img, "naturalWidth", { value: 400 });
    Object.defineProperty(img, "naturalHeight", { value: 300 });
    fireEvent.load(img);
    expect(img).toHaveAttribute("aria-label", "View image: image-1.png");
  });

  /** A post in flight with image-1.png, and a thread row for its body. */
  async function postInFlight(body: string) {
    const key = freshKey();
    await stageAttachment({
      draftKey: key,
      owner: {},
      file: png(),
      source: "paste",
      blockedReason: null,
    });
    const url = draftEntry(key)?.images[0].url ?? "";
    const ticket = beginAttachmentPost(key, "![shot](image-1.png)", true);
    if (!ticket) throw new Error("no ticket");
    const row = (over: Partial<PrThreadOut> = {}): PrThreadOut => ({
      author: "me",
      authorAvatarUrl: "",
      state: "",
      body,
      date: "2026-01-01T00:00:00Z",
      id: "optimistic:1",
      url: "",
      viewerDidAuthor: false,
      isMinimized: false,
      minimizedReason: "",
      reviewId: "",
      ...over,
    });
    return { url, ticket, row };
  }

  it("the optimistic row shows its images, and Copy markdown copies the body as typed", async () => {
    const body = "![shot](image-1.png)";
    const { url, ticket, row } = await postInFlight(body);
    render(wrap(<Thread thread={row({ postToken: ticket.token })} />));
    expect(screen.getByRole("img", { name: "shot" })).toHaveAttribute(
      "src",
      url,
    );
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Copy markdown" }),
    );
    expect(copyText).toHaveBeenCalledWith(body, "Markdown copied");
  });

  it("a row whose token changes under the same body shows the new post's image", async () => {
    vi.mocked(attachmentStage).mockImplementation(async () =>
      stagedAs("image-1.png"),
    );
    const body = "![shot](image-1.png)";
    const first = await postInFlight(body);
    const second = await postInFlight(body);
    expect(second.url).not.toBe(first.url);
    const { rerender } = render(
      wrap(<Thread thread={first.row({ postToken: first.ticket.token })} />),
    );
    expect(screen.getByRole("img", { name: "shot" })).toHaveAttribute(
      "src",
      first.url,
    );
    rerender(
      wrap(<Thread thread={first.row({ postToken: second.ticket.token })} />),
    );
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "shot" })).toHaveAttribute(
        "src",
        second.url,
      ),
    );
  });

  it.each([
    ["a bare staged name", () => "![shot](image-1.png)"],
    [
      "an old post marker",
      (token: string) => `![shot](gitdesktop-staged/post-${token}/image-1.png)`,
    ],
    [
      "an old draft marker",
      () => `![shot](gitdesktop-staged/${SESSION}/image-1.png)`,
    ],
  ])("a remote row naming %s resolves nothing", async (_label, bodyFor) => {
    const { ticket, row } = await postInFlight("");
    const body = bodyFor(ticket.token);
    const { container } = render(
      wrap(<Thread thread={row({ body, id: "C_9" })} />),
    );
    for (const img of container.querySelectorAll("img"))
      expect(img.getAttribute("src") ?? "").not.toMatch(/^blob:/);
    // Marker-shaped text stays exactly as the remote author wrote it.
    const code = render(
      wrap(<Thread thread={row({ body: `\`${body}\``, id: "C_10" })} />),
    );
    expect(code.container.querySelector("code")?.textContent).toBe(body);
  });
});

describe("a staged image shows only where it will upload, and a mounted row follows the store", () => {
  /** Two staged images and a post in flight for the given referenced names. */
  async function twoStaged(postBody: string) {
    const key = freshKey();
    const owner = {};
    for (let i = 0; i < 2; i++)
      await stageAttachment({
        draftKey: key,
        owner,
        file: png(),
        source: "paste",
        blockedReason: null,
      });
    const [url1, url2] = draftEntry(key)?.images.map((i) => i.url) ?? [];
    const ticket = beginAttachmentPost(key, postBody, true);
    if (!ticket) throw new Error("no ticket");
    const thread = (body: string): PrThreadOut => ({
      author: "me",
      authorAvatarUrl: "",
      state: "",
      body,
      date: "2026-01-01T00:00:00Z",
      id: "optimistic:2",
      url: "",
      viewerDidAuthor: false,
      isMinimized: false,
      minimizedReason: "",
      reviewId: "",
      postToken: ticket.token,
    });
    return { key, url1, url2, ticket, thread };
  }
  const srcOf = (root: ParentNode, alt: string) =>
    root.querySelector(`img[alt="${alt}"]`)?.getAttribute("src") ?? null;

  it("Preview shows a raw <img> and a titled reference as their fallback, a counted one as its image", async () => {
    const key = freshKey();
    render(wrap(<Host draftKey={key} />));
    await act(async () => {
      paste(textbox(), [png(), png()]);
    });
    await waitFor(() => expect(chips()).toBe(2));
    const url2 = draftEntry(key)?.images[1].url;
    fireEvent.change(textbox(), {
      target: {
        value:
          '<img alt="raw" src="image-1.png"> ![titled](image-1.png "t") ![ok](image-2.png)',
      },
    });
    // Only the counted reference keeps a chip: the others will not upload.
    expect(chips()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByRole("img", { name: "ok" })).toHaveAttribute(
      "src",
      url2,
    );
    for (const alt of ["raw", "titled"])
      expect(
        screen.getByText(`${alt} · ${IMAGE_CAPTION_REASON.noRepo}`),
      ).toBeInTheDocument();
    expect(screen.queryAllByRole("img", { name: /raw|titled/ })).toEqual([]);
  });

  it("the in-flight row resolves only the names its post is sending", async () => {
    const { url1, thread } = await twoStaged("![a](image-1.png)");
    const { container } = render(
      wrap(<Thread thread={thread("![a](image-1.png) ![b](image-2.png)")} />),
    );
    expect(srcOf(container, "a")).toBe(url1);
    expect(srcOf(container, "b")).toBeNull();
    expect(
      screen.getByText(`b · ${IMAGE_CAPTION_REASON.noRepo}`),
    ).toBeInTheDocument();
  });

  it("a mounted row re-walks at the settle and never keeps a revoked URL", async () => {
    const body = "![a](image-1.png) ![b](image-2.png)";
    const { key, url1, url2, ticket, thread } = await twoStaged(body);
    const mounted = render(wrap(<Thread thread={thread(body)} />));
    expect(srcOf(mounted.container, "a")).toBe(url1);
    expect(srcOf(mounted.container, "b")).toBe(url2);
    act(() => {
      settleAttachmentPost(ticket, { posted: true, failed: ["image-2.png"] });
    });
    await waitFor(() => expect(srcOf(mounted.container, "b")).toBeNull());
    expect(srcOf(mounted.container, "a")).toBe(url1);
    // The mounted row now reads as a fresh mount of it does.
    const fresh = render(wrap(<Thread thread={thread(body)} />));
    expect(srcOf(fresh.container, "a")).toBe(url1);
    expect(srcOf(fresh.container, "b")).toBeNull();
    act(() => endDraftAttachments(key));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(url2);
    const revoked = vi.mocked(URL.revokeObjectURL).mock.calls.map(([u]) => u);
    for (const img of mounted.container.querySelectorAll("img"))
      expect(revoked).not.toContain(img.getAttribute("src"));
  });
});
