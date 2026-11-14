import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditor } from "@/components/markdown-editor";
import { attachmentDiscard, attachmentStage } from "@/lib/attachments/api";
import {
  type AttachmentSurface,
  endDraftAttachments,
} from "@/lib/attachments/store";
import {
  useAttachmentOwner,
  useDraftAttachments,
} from "@/lib/attachments/use-draft-attachments";
import { ghHostedImage } from "@/lib/hosted-images/api";
import { dispatchAction, hasLiveHandler } from "@/lib/hotkeys/handler-registry";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/attachments/api", () => ({
  attachmentStage: vi.fn(),
  attachmentDiscard: vi.fn(async () => undefined),
}));
vi.mock("@/lib/hosted-images/api", () => ({ ghHostedImage: vi.fn() }));

const SESSION = "0123456789abcdef0123456789abcdef";
let seq = 0;
let urlSeq = 0;

beforeEach(() => {
  vi.mocked(attachmentStage).mockReset();
  vi.mocked(attachmentDiscard).mockClear();
  vi.mocked(ghHostedImage).mockReset();
  let n = 0;
  vi.mocked(attachmentStage).mockImplementation(async (session) => {
    n += 1;
    return {
      session: session ?? SESSION,
      name: `image-${n}.png`,
      mime: "image/png",
      size: 2048,
      width: 4,
      height: 4,
    };
  });
  URL.createObjectURL = vi.fn(() => {
    urlSeq += 1;
    return `blob:test-${urlSeq}`;
  });
  URL.revokeObjectURL = vi.fn();
});

afterAll(() => expect(unmockedCommands).toEqual([]));

const png = (name = "shot.png") =>
  new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });

function paste(target: Element, files: File[], types = ["Files"]) {
  return fireEvent.paste(target, {
    clipboardData: { files, types, getData: () => "" },
  });
}

function Host({
  draftKey,
  surface = "issue-comment",
  gate = null,
  hold = null,
  initial = {},
  disabled,
}: {
  draftKey: string;
  surface?: AttachmentSurface;
  gate?: string | null;
  hold?: string | null;
  initial?: Record<string, string>;
  disabled?: boolean;
}) {
  const [texts, setTexts] = useState<Record<string, string>>(initial);
  const owner = useAttachmentOwner(surface, false);
  const handle = useDraftAttachments({
    draftKey,
    owner,
    gateReason: gate,
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
        disabled={disabled}
      />
      <pre data-testid="texts">{JSON.stringify(texts)}</pre>
    </>
  );
}

const freshKey = () => {
  seq += 1;
  return `issue-comment|/repo#origin#${seq}`;
};
const texts = () =>
  JSON.parse(screen.getByTestId("texts").textContent ?? "{}") as Record<
    string,
    string
  >;
const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
);
const textbox = () => screen.getByRole("textbox", { name: "Comment" });

describe("MarkdownEditor without attachments", () => {
  it("adds no input, button, list, paste handling or palette handler", () => {
    const { container } = render(
      wrap(<MarkdownEditor aria-label="Comment" value="" onChange={vi.fn()} />),
    );
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Attach image" })).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
    expect(paste(textbox(), [png()])).toBe(true);
    expect(attachmentStage).not.toHaveBeenCalled();
    expect(hasLiveHandler("attach-image")).toBe(false);
  });
});

describe("MarkdownEditor with attachments", () => {
  it("stages a files-only paste in order and inserts each reference", async () => {
    const key = freshKey();
    render(wrap(<Host draftKey={key} initial={{ [key]: "hi" }} />));
    expect(hasLiveHandler("attach-image")).toBe(true);
    const ta = textbox() as HTMLTextAreaElement;
    ta.setSelectionRange(2, 2);
    let notPrevented = true;
    await act(async () => {
      notPrevented = paste(ta, [png(), png()]);
    });
    expect(notPrevented).toBe(false);
    await waitFor(() =>
      expect(texts()[key]).toBe(
        "hi ![image](image-1.png)\n![image](image-2.png)",
      ),
    );
    expect(
      vi.mocked(attachmentStage).mock.calls.map((c) => [c[0], c[1]]),
    ).toEqual([
      [null, null],
      [SESSION, null],
    ]);
    expect(
      screen.getByRole("list", { name: "Attached images" }).children,
    ).toHaveLength(2);
  });

  it("leaves a paste carrying text/plain to the browser", async () => {
    render(wrap(<Host draftKey={freshKey()} />));
    let notPrevented = false;
    await act(async () => {
      notPrevented = paste(textbox(), [png()], ["Files", "text/plain"]);
    });
    expect(notPrevented).toBe(true);
    expect(attachmentStage).not.toHaveBeenCalled();
  });

  it("inserts a picked file under its escaped stem", async () => {
    vi.mocked(attachmentStage).mockResolvedValueOnce({
      session: SESSION,
      name: "a-b-c-d.png",
      mime: "image/png",
      size: 10,
      width: 1,
      height: 1,
    });
    const key = freshKey();
    const { container } = render(wrap(<Host draftKey={key} />));
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    expect(input.accept).toBe("image/png,image/jpeg,image/gif,image/webp");
    expect(input.multiple).toBe(true);
    await act(async () => {
      fireEvent.change(input, { target: { files: [png("a[b]\\c\nd.png")] } });
    });
    await waitFor(() =>
      expect(texts()[key]).toBe("![a\\[b\\]\\\\c d](a-b-c-d.png)"),
    );
    expect(vi.mocked(attachmentStage).mock.calls[0][1]).toBe("a[b]\\c\nd.png");
    expect(input.value).toBe("");
  });

  it("shows chips only for referenced images; Remove moves focus next, previous, textarea", async () => {
    const key = freshKey();
    render(wrap(<Host draftKey={key} />));
    await act(async () => {
      paste(textbox(), [png(), png(), png()]);
    });
    await screen.findByRole("button", { name: "Preview image-3.png" });
    const removeOf = (n: number) =>
      screen.getByRole("button", { name: `Remove image-${n}.png` });
    expect(
      screen.getByRole("button", { name: "Preview image-2.png" }),
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(removeOf(2));
    });
    expect(texts()[key]).not.toContain("image-2.png");
    expect(document.activeElement).toBe(removeOf(3));
    await act(async () => {
      fireEvent.click(removeOf(3));
    });
    expect(document.activeElement).toBe(removeOf(1));
    await act(async () => {
      fireEvent.click(removeOf(1));
    });
    expect(document.activeElement).toBe(textbox());
    expect(screen.queryByRole("list", { name: "Attached images" })).toBeNull();
    expect(attachmentDiscard).not.toHaveBeenCalled();
    // The staged file stays: the reference typed back brings its chip back.
    fireEvent.change(textbox(), { target: { value: "![x](image-2.png)" } });
    expect(removeOf(2)).toBeInTheDocument();
  });

  it("explains a gate on press, key and paste; a gate leaves Remove live, a hold doesn't", async () => {
    const user = userEvent.setup();
    const key = freshKey();
    const gate = "Image attachments aren't available on Bitbucket.";
    const { rerender } = render(wrap(<Host draftKey={key} />));
    await act(async () => {
      paste(textbox(), [png()]);
    });
    await screen.findByRole("button", { name: "Remove image-1.png" });
    rerender(wrap(<Host draftKey={key} gate={gate} />));
    const attach = screen.getByRole("button", { name: "Attach image" });
    expect(attach).toHaveAttribute("aria-disabled", "true");
    expect(attach).toHaveAccessibleDescription(gate);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    fireEvent.click(attach.parentElement?.parentElement as HTMLElement);
    expect(screen.getByRole("status")).toHaveTextContent(gate);
    fireEvent.change(textbox(), { target: { value: `${texts()[key]} x` } });
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    attach.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("status")).toHaveTextContent(gate);
    fireEvent.change(textbox(), { target: { value: `${texts()[key]} y` } });
    let notPrevented = true;
    await act(async () => {
      notPrevented = paste(textbox(), [png()]);
    });
    expect(notPrevented).toBe(false);
    expect(screen.getByRole("status")).toHaveTextContent(gate);
    expect(attachmentStage).toHaveBeenCalledTimes(1);
    const remove = screen.getByRole("button", { name: "Remove image-1.png" });
    expect(remove).not.toHaveAttribute("aria-disabled");
    expect(remove).toBeEnabled();
    rerender(wrap(<Host draftKey={key} hold="Posting your comment…" />));
    expect(
      screen.getByRole("button", { name: "Remove image-1.png" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(hasLiveHandler("attach-image")).toBe(true);
    expect(dispatchAction("attach-image")).toBe(false);
  });

  it("shows Rust's refusal verbatim and refuses an oversized file before reading it", async () => {
    const key = freshKey();
    render(wrap(<Host draftKey={key} />));
    const sentence =
      "The pasted file isn't an image. Attach a PNG, JPEG, GIF or WebP.";
    vi.mocked(attachmentStage).mockRejectedValueOnce({
      kind: "invalidArgument",
      message: `invalid argument: ${sentence}`,
    });
    await act(async () => {
      paste(textbox(), [png()]);
    });
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(sentence),
    );
    fireEvent.change(textbox(), { target: { value: "x" } });
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    const huge = png();
    Object.defineProperty(huge, "size", { value: 10_485_761 });
    vi.mocked(attachmentStage).mockClear();
    await act(async () => {
      paste(textbox(), [huge]);
    });
    expect(attachmentStage).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe(
      "The pasted file is 10.1 MB. Images can be at most 10 MB.",
    );
  });

  it("lands a late stage in the draft it started for, not the shown one", async () => {
    let resolve: (v: Awaited<ReturnType<typeof attachmentStage>>) => void =
      () => undefined;
    vi.mocked(attachmentStage).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const a = freshKey();
    const b = freshKey();
    const { rerender } = render(
      wrap(<Host draftKey={a} initial={{ [a]: "first", [b]: "second" }} />),
    );
    await act(async () => {
      paste(textbox(), [png()]);
    });
    await waitFor(() => expect(attachmentStage).toHaveBeenCalledTimes(1));
    rerender(
      wrap(<Host draftKey={b} initial={{ [a]: "first", [b]: "second" }} />),
    );
    await act(async () => {
      resolve({
        session: SESSION,
        name: "image-1.png",
        mime: "image/png",
        size: 1,
        width: 1,
        height: 1,
      });
    });
    expect(texts()[a]).toBe("first ![image](image-1.png)");
    expect(texts()[b]).toBe("second");
    expect(textbox()).toHaveValue("second");
  });

  it("closes the lightbox when the draft changes", async () => {
    const a = freshKey();
    const { rerender } = render(wrap(<Host draftKey={a} />));
    await act(async () => {
      paste(textbox(), [png()]);
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Preview image-1.png" }),
    );
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    rerender(wrap(<Host draftKey={freshKey()} />));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("previews a staged image from its local copy; removing the last chip there focuses the Preview tab", async () => {
    const key = freshKey();
    render(wrap(<Host draftKey={key} />));
    await act(async () => {
      paste(textbox(), [png()]);
    });
    const chip = await screen.findByRole("button", {
      name: "Remove image-1.png",
    });
    const previewTab = screen.getByRole("button", { name: "Preview" });
    fireEvent.click(previewTab);
    const img = await screen.findByRole("img", { name: "image" });
    expect(img.getAttribute("src")).toMatch(/^blob:test-/);
    await act(async () => {
      fireEvent.click(chip);
    });
    expect(texts()[key]).toBe("");
    expect(screen.queryByRole("list", { name: "Attached images" })).toBeNull();
    expect(document.activeElement).toBe(previewTab);
  });

  it("palette opens the picker of the editor focused last, and none while held, gated or in Preview", async () => {
    const click = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(function (this: HTMLInputElement) {
        clicked.push(this);
      });
    const clicked: HTMLInputElement[] = [];
    const a = freshKey();
    const b = freshKey();
    const { container, rerender } = render(
      wrap(
        <>
          <Host draftKey={a} />
          <Host draftKey={b} />
        </>,
      ),
    );
    const [inputA, inputB] = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="file"]'),
    );
    const [taA, taB] = screen.getAllByRole("textbox", { name: "Comment" });
    taB.focus();
    taA.focus();
    expect(dispatchAction("attach-image")).toBe(true);
    expect(clicked.at(-1)).toBe(inputA);
    taB.focus();
    dispatchAction("attach-image");
    expect(clicked.at(-1)).toBe(inputB);
    rerender(
      wrap(
        <>
          <Host
            draftKey={a}
            gate="Attaching images needs GitHub CLI 2.99 or newer."
          />
          <Host draftKey={b} hold="Closing this issue…" />
        </>,
      ),
    );
    expect(dispatchAction("attach-image")).toBe(false);
    rerender(
      wrap(
        <>
          <Host draftKey={a} />
          <Host draftKey={b} disabled />
        </>,
      ),
    );
    for (const btn of screen.getAllByRole("button", { name: "Preview" }))
      fireEvent.click(btn);
    expect(dispatchAction("attach-image")).toBe(false);
    click.mockRestore();
  });
});

describe("a full draft reclaims the images its text no longer references", () => {
  const refs = (...ns: number[]) =>
    ns.map((n) => `![image](image-${n}.png)`).join("\n");

  async function tenReferenced(key: string) {
    await act(async () => {
      paste(
        textbox(),
        Array.from({ length: 10 }, () => png()),
      );
    });
    await waitFor(() => expect(texts()[key]).toContain("](image-10.png)"));
    // The user deletes three references; their chips go, their files stay.
    fireEvent.change(textbox(), {
      target: { value: refs(1, 2, 3, 4, 5, 6, 7) },
    });
  }

  it("discards them before an eleventh pasted image, which then lands", async () => {
    const key = freshKey();
    render(wrap(<Host draftKey={key} />));
    await tenReferenced(key);
    await act(async () => {
      paste(textbox(), [png()]);
    });
    await waitFor(() => expect(texts()[key]).toContain("](image-11.png)"));
    expect(attachmentDiscard).toHaveBeenCalledWith(SESSION, [
      "image-8.png",
      "image-9.png",
      "image-10.png",
    ]);
    expect(attachmentStage).toHaveBeenCalledTimes(11);
    act(() => endDraftAttachments(key));
  });

  it.each([
    ["moves to another draft", "move"],
    ["unmounts", "unmount"],
  ] as const)(
    "reclaims nothing for a gesture's later file once the editor %s",
    async (_, how) => {
      const a = freshKey();
      const b = freshKey();
      const initial = { [b]: "Another draft" };
      const { rerender, unmount } = render(
        wrap(<Host draftKey={a} initial={initial} />),
      );
      await tenReferenced(a);
      // Every image referenced, so the gesture's first file reclaims nothing.
      fireEvent.change(textbox(), {
        target: { value: refs(1, 2, 3, 4, 5, 6, 7, 8, 9, 10) },
      });
      const staged = (name: string) => ({
        session: SESSION,
        name,
        mime: "image/png",
        size: 1,
        width: 1,
        height: 1,
      });
      let land: (v: Awaited<ReturnType<typeof attachmentStage>>) => void = () =>
        undefined;
      vi.mocked(attachmentStage)
        .mockImplementationOnce(
          () =>
            new Promise((r) => {
              land = r;
            }),
        )
        .mockImplementationOnce(async () => staged("image-12.png"));
      await act(async () => {
        paste(textbox(), [png(), png()]);
      });
      await waitFor(() => expect(attachmentStage).toHaveBeenCalledTimes(11));
      // A text the second file's reclaim would read as no longer referencing
      // image-8 to image-10, were it read.
      fireEvent.change(textbox(), {
        target: { value: refs(1, 2, 3, 4, 5, 6, 7) },
      });
      if (how === "move")
        rerender(wrap(<Host draftKey={b} initial={initial} />));
      else unmount();
      await act(async () => land(staged("image-11.png")));
      await waitFor(() => expect(attachmentStage).toHaveBeenCalledTimes(12));
      await act(async () => undefined);
      expect(attachmentDiscard).not.toHaveBeenCalled();
      act(() => endDraftAttachments(a));
    },
  );

  it("reads the draft's text in Preview too, for a picked image", async () => {
    const key = freshKey();
    const { container } = render(wrap(<Host draftKey={key} />));
    await tenReferenced(key);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [png("eleven.png")] } });
    });
    await waitFor(() => expect(texts()[key]).toContain("](image-11.png)"));
    expect(attachmentDiscard).toHaveBeenCalledWith(SESSION, [
      "image-8.png",
      "image-9.png",
      "image-10.png",
    ]);
    act(() => endDraftAttachments(key));
  });
});

describe("Preview's hosted images", () => {
  const URL1 =
    "https://github.com/user-attachments/assets/c162f463-c831-4173-8a80-4197acc4a8ac";
  const SRC = { repoPath: "C:/repos/demo", host: "github.com" };

  it("loads a draft's hosted URL through the loader when given a source", async () => {
    vi.mocked(ghHostedImage).mockResolvedValue({
      bytes: { base64: "AAAA", mime: "image/png", tooLarge: false, size: 3 },
      unavailable: null,
    });
    render(
      wrap(
        <MarkdownEditor
          aria-label="Comment"
          value={`![shot](${URL1})`}
          onChange={vi.fn()}
          hostedImages={SRC}
        />,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() =>
      expect(ghHostedImage).toHaveBeenCalledWith(
        SRC.repoPath,
        URL1,
        expect.anything(),
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("img", { name: "shot" }).getAttribute("src"),
      ).toBe("data:image/png;base64,AAAA"),
    );
  });

  it("makes no loader call without the prop (control)", async () => {
    render(
      wrap(
        <MarkdownEditor
          aria-label="Comment"
          value={`![shot](${URL1})`}
          onChange={vi.fn()}
        />,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByRole("img", { name: "shot" })).toBeTruthy();
    await act(async () => undefined);
    expect(ghHostedImage).not.toHaveBeenCalled();
  });
});
