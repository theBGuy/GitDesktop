import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
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
import {
  IMAGE_CAPTION_REASON,
  type MarkdownHostedImages,
  REPO_IMAGE_DOC_BUDGET_BYTES,
  RUN_ATTR,
} from "@/components/markdown/markdown-images";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { attachmentStage } from "@/lib/attachments/api";
import { stageAttachment } from "@/lib/attachments/store";
import { ghHostedImage, type HostedImage } from "@/lib/hosted-images/api";
import {
  hostedImageOptions,
  reconnectStore,
} from "@/lib/hosted-images/queries";
import { unmockedCommands } from "./setup";

// The loader's one IPC seam; no test reaches Rust, gh or the network.
vi.mock("@/lib/hosted-images/api", () => ({ ghHostedImage: vi.fn() }));
// The browser arm's seam: the plugin bypasses the test transport.
vi.mock("@tauri-apps/plugin-opener", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/plugin-opener")>()),
  openUrl: vi.fn(async () => undefined),
}));
vi.mock("@/lib/attachments/api", () => ({
  attachmentStage: vi.fn(),
  attachmentDiscard: vi.fn(async () => undefined),
}));

const T = "c162f463-c831-4173-8a80-4197acc4a8ac";
const T2 = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";
const URL1 = `https://github.com/user-attachments/assets/${T}`;
const URL2 = `https://github.com/user-attachments/assets/${T2}`;
const GHE = `https://acme.ghe.com/user-attachments/assets/${T}`;
const REPO = "C:/repos/demo";
const SRC: MarkdownHostedImages = { repoPath: REPO, host: "github.com" };

const shown = (base64 = "AAAA"): HostedImage => ({
  bytes: { base64, mime: "image/png", tooLarge: false, size: 3 },
  unavailable: null,
});
const kind = (k: NonNullable<HostedImage["unavailable"]>): HostedImage => ({
  bytes: null,
  unavailable: k,
});
const dataUrl = (base64 = "AAAA") => `data:image/png;base64,${base64}`;

/** URLs the frontend never routes (the shared fixture table's "no" rows). */
const NOT_OWNED = [
  `http://github.com/user-attachments/assets/${T}`,
  `${URL1}?x=1`,
  `${URL1}#f`,
  `${URL1}/`,
  `https://u@github.com/user-attachments/assets/${T}`,
  `https://github.com:443/user-attachments/assets/${T}`,
  `https://GitHub.com/user-attachments/assets/${T}`,
  `https://github.com/user-attachments/assets/${T.toUpperCase()}`,
  `https://github.com.evil.com/user-attachments/assets/${T}`,
  `https://ghe.com/user-attachments/assets/${T}`,
  `https://a.b.ghe.com/user-attachments/assets/${T}`,
  `https://github.com/o/r/assets/123/${T}`,
  `https://github.acme.com/user-attachments/assets/${T}`,
  `https://g${String.fromCharCode(0x456)}thub.com/user-attachments/assets/${T}`,
  `https://xn--gthub-n2e.com/user-attachments/assets/${T}`,
  `https://github.com./user-attachments/assets/${T}`,
  `https://github.com/user%2Dattachments/assets/${T}`,
  `https://github.com//user-attachments/assets/${T}`,
  // Grammar yes, but another host than the source's.
  GHE,
];

let client: QueryClient;
let urlSeq = 0;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(ghHostedImage).mockReset();
  vi.mocked(openUrl).mockClear();
  URL.createObjectURL = vi.fn(() => {
    urlSeq += 1;
    return `blob:hosted-${urlSeq}`;
  });
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  onlineManager.setOnline(true);
});

afterAll(() => expect(unmockedCommands).toEqual([]));

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={client}>{ui}</QueryClientProvider>
);

function md(body: string, hostedImages?: MarkdownHostedImages) {
  return render(wrap(<Markdown hostedImages={hostedImages}>{body}</Markdown>));
}

const img = (root: ParentNode, i = 0) => {
  const el = root.querySelectorAll("img")[i];
  if (!el) throw new Error(`no image ${i}`);
  return el;
};

/** A read the test settles by hand. */
function deferred() {
  let resolve: (v: HostedImage) => void = () => undefined;
  const promise = new Promise<HostedImage>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const caption = (name: string, reason: keyof typeof IMAGE_CAPTION_REASON) =>
  `${name} · ${IMAGE_CAPTION_REASON[reason]}`;

/** Lets every pending read's continuation write. */
const flush = () => act(async () => undefined);

describe("without the hosted source", () => {
  it("leaves an allowlisted URL on the webview and reads nothing", async () => {
    const { container } = md(`![a](${URL1})\n\n![b](docs/x.png)`);
    await flush();
    expect(img(container).getAttribute("src")).toBe(URL1);
    expect(img(container).hasAttribute("data-repo-src")).toBe(false);
    expect(ghHostedImage).not.toHaveBeenCalled();
    // The run key has no hosted suffix.
    expect(
      container
        .querySelector("[data-repo-image-caption]")
        ?.getAttribute(RUN_ATTR),
    ).toBe("0");
  });

  it("a render after one with the source serializes as before it", async () => {
    vi.mocked(ghHostedImage).mockResolvedValue(shown());
    const body = `![a](${URL1}) <img src="${URL2}">`;
    const before = md(body).container.innerHTML;
    cleanup();
    md(body, SRC);
    await flush();
    cleanup();
    expect(md(body).container.innerHTML).toBe(before);
  });
});

describe("with the hosted source", () => {
  it("hides the image until its read settles, then shows it as data:", async () => {
    const read = deferred();
    vi.mocked(ghHostedImage).mockReturnValue(read.promise);
    const { container } = md(`![a](${URL1})`, SRC);
    const el = img(container);
    expect(el.hasAttribute("src")).toBe(false);
    expect(el.dataset.repoSrc).toBe(URL1);
    expect(ghHostedImage).toHaveBeenCalledWith(REPO, URL1);
    read.resolve(shown("iVBO"));
    await waitFor(() => expect(el.getAttribute("src")).toBe(dataUrl("iVBO")));
    expect(el.dataset.repoSrc).toBe(URL1);
  });

  it("trims edge whitespace and routes the URL", async () => {
    vi.mocked(ghHostedImage).mockResolvedValue(shown());
    const { container } = md(`<img src=" ${URL1} ">`, SRC);
    await waitFor(() =>
      expect(img(container).getAttribute("src")).toBe(dataUrl()),
    );
    expect(ghHostedImage).toHaveBeenCalledWith(REPO, URL1);
  });

  it.each([
    [
      "tooLarge bytes",
      { base64: null, mime: null, tooLarge: true, size: null },
      "tooLarge",
    ],
    [
      "unsniffed bytes",
      { base64: null, mime: null, tooLarge: false, size: 9 },
      "notImage",
    ],
  ] as const)(
    "%s caption by the file's own reason",
    async (_, bytes, reason) => {
      vi.mocked(ghHostedImage).mockResolvedValue({ bytes, unavailable: null });
      md(`![shot](${URL1})`, SRC);
      expect(await screen.findByText(caption("shot", reason))).toBeTruthy();
    },
  );

  it.each([
    ["signedOut", "webSignedOut"],
    ["refused", "webFailed"],
  ] as const)(
    "a %s verdict captions once, asked once, with Open in browser",
    async (k, reason) => {
      vi.mocked(ghHostedImage).mockResolvedValue(kind(k));
      md(`![](${URL1})`, SRC);
      expect(await screen.findByText(caption("Image", reason))).toBeTruthy();
      const link = screen.getByRole("link", { name: "Open in browser" });
      expect(link.getAttribute("href")).toBe(URL1);
      fireEvent.click(link);
      expect(openUrl).toHaveBeenCalledWith(URL1);
      expect(ghHostedImage).toHaveBeenCalledTimes(1);
    },
  );

  it("a rejected invoke captions as a failed load", async () => {
    vi.mocked(ghHostedImage).mockRejectedValue(new Error("ipc"));
    md(`![x](${URL1})`, SRC);
    expect(await screen.findByText(caption("x", "webFailed"))).toBeTruthy();
    expect(ghHostedImage).toHaveBeenCalledTimes(1);
  });

  it("keeps a minute's images cached, no longer", () => {
    expect(hostedImageOptions(REPO, "github.com", URL1, () => "").gcTime).toBe(
      60_000,
    );
  });

  it("a walk never paints a non-bytes verdict from a read already in flight", async () => {
    const first = deferred();
    vi.mocked(ghHostedImage)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(shown());
    const { container } = md(`![a](${URL1})`, SRC);
    act(() => {
      client.setQueryData(["repo", REPO, "forge-status"], {
        authenticated: true,
        login: "octo",
      });
    });
    // The sign-in's walk joined the first read rather than starting its own.
    expect(ghHostedImage).toHaveBeenCalledTimes(1);
    first.resolve(kind("signedOut"));
    await waitFor(() =>
      expect(img(container).getAttribute("src")).toBe(dataUrl()),
    );
    expect(ghHostedImage).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(caption("a", "webSignedOut"))).toBeNull();
  });

  it("never names a hosted image by its asset uuid", async () => {
    vi.mocked(ghHostedImage).mockResolvedValue(kind("signedOut"));
    const { container } = md(`![  ](${URL1})`, SRC);
    expect(
      await screen.findByText(caption("Image", "webSignedOut")),
    ).toBeTruthy();
    expect(container.textContent).not.toContain(T);
  });

  it.each([
    ["a link", `[![a](${URL1})](${URL1})`],
    ["a button", `<button><img alt="a" src="${URL1}"></button>`],
    ["a label", `<label><img alt="a" src="${URL1}"></label>`],
  ])("inside %s, the caption carries no link of its own", async (_, body) => {
    vi.mocked(ghHostedImage).mockResolvedValue(kind("signedOut"));
    const { container } = md(body, SRC);
    await screen.findByText(caption("a", "webSignedOut"));
    expect(
      container.querySelectorAll("[data-repo-image-caption] a"),
    ).toHaveLength(0);
  });

  it.each(NOT_OWNED)("leaves a URL it doesn't own alone: %s", async (url) => {
    const { container } = md(`<img src="${url}">`, SRC);
    await flush();
    expect(img(container).getAttribute("src")).toBe(url);
    expect(img(container).hasAttribute("data-repo-src")).toBe(false);
    expect(ghHostedImage).not.toHaveBeenCalled();
  });

  it("routes a tenant's URL under that tenant's source", async () => {
    vi.mocked(ghHostedImage).mockResolvedValue(shown());
    const { container } = md(`![](${GHE})`, {
      repoPath: REPO,
      host: "acme.ghe.com",
    });
    await waitFor(() =>
      expect(img(container).getAttribute("src")).toBe(dataUrl()),
    );
  });

  it("resolves a picture's owned source and image, keeping third-party candidates", async () => {
    vi.mocked(ghHostedImage).mockImplementation(async (_, url) =>
      shown(url === URL1 ? "AAAA" : "BBBB"),
    );
    const { container } = md(
      `<picture><source srcset="${URL1}"><img src="${URL2}"></picture>` +
        `<img srcset="${URL1} 1x, https://example.com/a.png 2x">`,
      SRC,
    );
    await waitFor(() =>
      expect(img(container).getAttribute("src")).toBe(dataUrl("BBBB")),
    );
    expect(container.querySelector("source")?.getAttribute("srcset")).toBe(
      dataUrl("AAAA"),
    );
    expect(img(container, 1).getAttribute("srcset")).toBe(
      `${dataUrl("AAAA")} 1x, https://example.com/a.png 2x`,
    );
    expect(ghHostedImage).toHaveBeenCalledTimes(2);
  });

  it("reads one URL once across bodies and within one, joining a read in flight", async () => {
    const read = deferred();
    vi.mocked(ghHostedImage).mockReturnValue(read.promise);
    const { container } = render(
      wrap(
        <>
          <Markdown
            hostedImages={SRC}
          >{`![a](${URL1}) ![b](${URL1})`}</Markdown>
          <Markdown hostedImages={SRC}>{`![c](${URL1})`}</Markdown>
        </>,
      ),
    );
    read.resolve(shown());
    await waitFor(() =>
      expect(
        [...container.querySelectorAll("img")].map((i) =>
          i.getAttribute("src"),
        ),
      ).toEqual([dataUrl(), dataUrl(), dataUrl()]),
    );
    expect(ghHostedImage).toHaveBeenCalledTimes(1);
  });

  it("charges hosted bytes to the body budget", async () => {
    const base64 = "A".repeat(
      Math.ceil((REPO_IMAGE_DOC_BUDGET_BYTES * 4) / 3) + 8,
    );
    vi.mocked(ghHostedImage).mockResolvedValue(shown(base64));
    md(`![big](${URL1})`, SRC);
    expect(await screen.findByText(caption("big", "tooLarge"))).toBeTruthy();
  });

  it("shows a staged name's local copy and a hosted URL's data: in one row", async () => {
    vi.mocked(attachmentStage).mockResolvedValue({
      session: "0".repeat(31) + "9",
      name: "image-1.png",
      mime: "image/png",
      size: 4,
      width: 4,
      height: 4,
    });
    vi.mocked(ghHostedImage).mockResolvedValue(shown());
    const owner = {};
    const draftKey = "issue-comment|/hosted#origin#1";
    await stageAttachment({
      draftKey,
      owner,
      file: new File([new Uint8Array([137, 80, 78, 71])], "a.png", {
        type: "image/png",
      }),
      source: "paste",
      blockedReason: null,
    });
    const { container } = render(
      wrap(
        <Markdown stagedImages={{ draftKey, owner }} hostedImages={SRC}>
          {`![a](image-1.png) ![b](${URL1})`}
        </Markdown>,
      ),
    );
    await waitFor(() =>
      expect(img(container, 1).getAttribute("src")).toBe(dataUrl()),
    );
    expect(img(container).getAttribute("src")).toMatch(/^blob:hosted-/);
  });

  it("re-walks for a new repo under the same text, never for the same props", async () => {
    vi.mocked(ghHostedImage).mockResolvedValue(shown());
    const body = `![a](${URL1})`;
    const view = render(wrap(<Markdown hostedImages={SRC}>{body}</Markdown>));
    await waitFor(() =>
      expect(img(view.container).getAttribute("src")).toBe(dataUrl()),
    );
    const first = img(view.container).getAttribute(RUN_ATTR);
    view.rerender(wrap(<Markdown hostedImages={{ ...SRC }}>{body}</Markdown>));
    await flush();
    expect(img(view.container).getAttribute(RUN_ATTR)).toBe(first);
    view.rerender(
      wrap(
        <Markdown
          hostedImages={{ repoPath: "C:/repos/other", host: "github.com" }}
        >
          {body}
        </Markdown>,
      ),
    );
    await flush();
    expect(img(view.container).getAttribute(RUN_ATTR)).not.toBe(first);
    expect(img(view.container).getAttribute("src")).toBe(dataUrl());
    expect(ghHostedImage).toHaveBeenCalledTimes(1);
  });

  it("a read settling after unmount or a text change writes nothing and stays cached", async () => {
    const errors = vi.spyOn(console, "error");
    const one = deferred();
    vi.mocked(ghHostedImage).mockReturnValueOnce(one.promise);
    const view = md(`![a](${URL1})`, SRC);
    const stale = img(view.container);
    view.rerender(wrap(<Markdown hostedImages={SRC}>{"plain text"}</Markdown>));
    view.unmount();
    one.resolve(shown());
    await flush();
    expect(stale.hasAttribute("src")).toBe(false);
    expect(errors).not.toHaveBeenCalled();
    expect(client.getQueryData(["hosted-image", "github.com", URL1])).toEqual({
      ...shown(),
      askedUnder: expect.any(String),
    });
    errors.mockRestore();
  });

  it("a sign-in re-walks, and focus on the caption's link lands on the body", async () => {
    vi.mocked(ghHostedImage).mockResolvedValueOnce(kind("signedOut"));
    const { container } = md(`![a](${URL1})`, SRC);
    const link = await screen.findByRole("link", { name: "Open in browser" });
    link.focus();
    expect(document.activeElement).toBe(link);
    vi.mocked(ghHostedImage).mockResolvedValueOnce(shown());
    act(() => {
      client.setQueryData(["repo", REPO, "forge-status"], {
        provider: "github",
        authenticated: true,
        login: "octo",
      });
    });
    await waitFor(() =>
      expect(img(container).getAttribute("src")).toBe(dataUrl()),
    );
    expect(document.activeElement).not.toBe(document.body);
    expect(container.contains(document.activeElement)).toBe(true);
    expect(ghHostedImage).toHaveBeenCalledTimes(2);
  });

  /** Shows URL1, then re-walks with its cached bytes evicted and `next`. */
  async function rewalkShown(next: HostedImage[]) {
    vi.mocked(ghHostedImage).mockResolvedValueOnce(shown());
    const { container } = md(`![a](${URL1})`, SRC);
    await waitFor(() =>
      expect(img(container).getAttribute("src")).toBe(dataUrl()),
    );
    client.removeQueries({ queryKey: ["hosted-image"] });
    for (const r of next) vi.mocked(ghHostedImage).mockResolvedValueOnce(r);
    act(() => {
      client.setQueryData(["repo", REPO, "forge-status"], {
        authenticated: false,
        login: null,
      });
    });
    return container;
  }

  it.each(["refused", "signedOut"] as const)(
    "a shown image survives a %s re-walk",
    async (k) => {
      const container = await rewalkShown([kind(k)]);
      await waitFor(() => expect(ghHostedImage).toHaveBeenCalledTimes(2));
      await flush();
      expect(img(container).getAttribute("src")).toBe(dataUrl());
    },
  );

  it("a shown image goes to a caption once GitHub says it's missing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const container = await rewalkShown([
      kind("missing"),
      kind("missing"),
      kind("missing"),
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByText(caption("a", "webMissing"))).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("re-asking a fresh upload", () => {
  it("a 404 then bytes shows the image and never the caption", async () => {
    vi.useFakeTimers();
    vi.mocked(ghHostedImage)
      .mockResolvedValueOnce(kind("missing"))
      .mockResolvedValueOnce(shown());
    const { container } = md(`![a](${URL1})`, SRC);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    expect(img(container).hasAttribute("src")).toBe(false);
    expect(screen.queryByText(caption("a", "webMissing"))).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(img(container).getAttribute("src")).toBe(dataUrl());
    expect(ghHostedImage).toHaveBeenCalledTimes(2);
  });

  it("three missing verdicts caption once", async () => {
    vi.useFakeTimers();
    vi.mocked(ghHostedImage).mockResolvedValue(kind("missing"));
    md(`![a](${URL1})`, SRC);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3900);
    });
    expect(screen.queryByText(/· /)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.getAllByText(caption("a", "webMissing"))).toHaveLength(1);
    expect(ghHostedImage).toHaveBeenCalledTimes(3);
  });

  it("a failed verdict is asked once and captions at once", async () => {
    vi.useFakeTimers();
    vi.mocked(ghHostedImage).mockResolvedValue(kind("failed"));
    md(`![a](${URL1})`, SRC);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getAllByText(caption("a", "webFailed"))).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getAllByText(caption("a", "webFailed"))).toHaveLength(1);
    expect(ghHostedImage).toHaveBeenCalledTimes(1);
  });
});

describe("arrival and connectivity", () => {
  it("re-parses and routes once the host arrives", async () => {
    vi.mocked(ghHostedImage).mockResolvedValue(shown());
    const body = `![a](${URL1})`;
    const view = render(wrap(<Markdown>{body}</Markdown>));
    expect(img(view.container).getAttribute("src")).toBe(URL1);
    view.rerender(wrap(<Markdown hostedImages={SRC}>{body}</Markdown>));
    await waitFor(() =>
      expect(img(view.container).getAttribute("src")).toBe(dataUrl()),
    );
  });

  it("offline, the image stays hidden and reads once the connection returns", async () => {
    vi.mocked(ghHostedImage).mockResolvedValue(shown());
    onlineManager.setOnline(false);
    const { container } = md(`![a](${URL1})`, SRC);
    await flush();
    expect(ghHostedImage).not.toHaveBeenCalled();
    expect(img(container).hasAttribute("src")).toBe(false);
    act(() => onlineManager.setOnline(true));
    await waitFor(() =>
      expect(img(container).getAttribute("src")).toBe(dataUrl()),
    );
  });

  it("a failed verdict read while the link was dying is asked again on reconnect", async () => {
    vi.mocked(ghHostedImage)
      .mockResolvedValueOnce(kind("failed"))
      .mockResolvedValueOnce(shown());
    const { container } = md(`![a](${URL1})`, SRC);
    expect(await screen.findByText(caption("a", "webFailed"))).toBeTruthy();
    act(() => onlineManager.setOnline(false));
    await flush();
    expect(ghHostedImage).toHaveBeenCalledTimes(1);
    act(() => onlineManager.setOnline(true));
    await waitFor(() =>
      expect(img(container).getAttribute("src")).toBe(dataUrl()),
    );
    expect(ghHostedImage).toHaveBeenCalledTimes(2);
  });

  it("a loaded image stays shown across a reconnect and is not read again", async () => {
    vi.mocked(ghHostedImage).mockResolvedValue(shown());
    const { container } = md(`![a](${URL1})`, SRC);
    await waitFor(() =>
      expect(img(container).getAttribute("src")).toBe(dataUrl()),
    );
    const el = img(container);
    const before = el.getAttribute(RUN_ATTR);
    act(() => onlineManager.setOnline(false));
    expect(el.getAttribute("src")).toBe(dataUrl());
    act(() => onlineManager.setOnline(true));
    expect(el.getAttribute("src")).toBe(dataUrl());
    await flush();
    expect(img(container)).toBe(el);
    expect(el.getAttribute("src")).toBe(dataUrl());
    // The reconnect did re-walk the unit.
    expect(el.getAttribute(RUN_ATTR)).not.toBe(before);
    expect(ghHostedImage).toHaveBeenCalledTimes(1);
  });

  it("only a body with the hosted source watches connectivity", async () => {
    const subscribe = vi.spyOn(reconnectStore, "subscribe");
    const { container } = md(`![b](docs/x.png)`);
    await flush();
    expect(subscribe).not.toHaveBeenCalled();
    act(() => onlineManager.setOnline(false));
    act(() => onlineManager.setOnline(true));
    await flush();
    expect(
      container
        .querySelector("[data-repo-image-caption]")
        ?.getAttribute(RUN_ATTR),
    ).toBe("0");
    cleanup();
    vi.mocked(ghHostedImage).mockResolvedValue(shown());
    md(`![a](${URL1})`, SRC);
    expect(subscribe).toHaveBeenCalled();
    subscribe.mockRestore();
  });
});

describe("the viewer", () => {
  /** Loads `el` at a size the viewer takes, then opens it. */
  function openViewer(el: HTMLImageElement) {
    Object.defineProperty(el, "naturalWidth", { value: 400 });
    Object.defineProperty(el, "naturalHeight", { value: 300 });
    fireEvent.load(el);
    fireEvent.click(el);
  }

  it.each([
    ["a github.com repo", SRC, URL1],
    [
      "an acme.ghe.com repo",
      { repoPath: "C:/repos/ghe", host: "acme.ghe.com" },
      GHE,
    ],
  ])(
    "viewer offers Open in browser for a hosted image (%s)",
    async (_, source, url) => {
      vi.mocked(ghHostedImage).mockResolvedValue(shown());
      const { container } = md(`![](${url})`, source);
      await waitFor(() =>
        expect(img(container).getAttribute("src")).toBe(dataUrl()),
      );
      openViewer(img(container));
      fireEvent.click(
        await screen.findByRole("button", { name: /Open in browser/ }),
      );
      await waitFor(() => expect(openUrl).toHaveBeenCalledWith(url));
    },
  );

  it("a picture whose own image is missing opens the source it shows", async () => {
    vi.mocked(ghHostedImage).mockImplementation(async (_, url) =>
      url === URL1 ? shown() : kind("signedOut"),
    );
    const { container } = md(
      `<picture><source srcset="${URL1}"><img src="${URL2}"></picture>`,
      SRC,
    );
    await waitFor(() =>
      expect(img(container).getAttribute("src")).toBe(dataUrl()),
    );
    openViewer(img(container));
    fireEvent.click(
      await screen.findByRole("button", { name: /Open in browser/ }),
    );
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith(URL1));
  });

  it("a srcset-only hosted image opens its URL", async () => {
    vi.mocked(ghHostedImage).mockResolvedValue(shown());
    const { container } = md(`<img alt="s" srcset="${URL2} 2x">`, SRC);
    await waitFor(() =>
      expect(img(container).getAttribute("srcset")).toBe(`${dataUrl()} 2x`),
    );
    openViewer(img(container));
    fireEvent.click(
      await screen.findByRole("button", { name: /Open in browser/ }),
    );
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith(URL2));
  });

  it.each([
    ["", "Image"],
    ["shot", "shot"],
  ])(
    "names a hosted image by its alt or Image, never its uuid (alt %j)",
    async (alt, name) => {
      vi.mocked(ghHostedImage).mockResolvedValue(shown());
      const { container } = md(`![${alt}](${URL1})`, SRC);
      await waitFor(() =>
        expect(img(container).getAttribute("src")).toBe(dataUrl()),
      );
      openViewer(img(container));
      const dialog = await screen.findByRole("dialog", { name });
      expect(dialog.textContent).not.toContain(T);
    },
  );

  /** A body with a repository and no hosted source; repo reads answer bytes. */
  function repoBody(body: string) {
    vi.spyOn(client, "fetchQuery").mockResolvedValue(shown().bytes as never);
    return render(
      wrap(
        <Markdown
          repoImages={{ repoPath: REPO, rev: null, baseDir: "", refreshKey: 0 }}
        >
          {body}
        </Markdown>,
      ),
    );
  }

  it("a repository image's viewer has no Open in browser", async () => {
    const { container } = repoBody(`![r](docs/r.png)`);
    await waitFor(() =>
      expect(img(container).getAttribute("src")).toBe(dataUrl()),
    );
    openViewer(img(container));
    await screen.findByRole("dialog");
    expect(
      screen.queryByRole("button", { name: /Open in browser/ }),
    ).toBeNull();
  });

  it("without the source, a hosted srcset candidate gives no web URL", async () => {
    const { container } = repoBody(
      `<img alt="s" srcset="${URL1} 1x, docs/shot.png 2x">`,
    );
    await waitFor(() =>
      expect(img(container).getAttribute("srcset")).toBe(
        `${URL1} 1x, ${dataUrl()} 2x`,
      ),
    );
    openViewer(img(container));
    await screen.findByRole("dialog");
    expect(
      screen.queryByRole("button", { name: /Open in browser/ }),
    ).toBeNull();
    expect(ghHostedImage).not.toHaveBeenCalled();
  });

  it("viewer without webUrl behaves as today", async () => {
    const view = render(
      <ImageLightbox
        images={[{ src: "https://example.com/a.png", alt: "a" }]}
        index={0}
        onIndexChange={() => undefined}
        open
        onOpenChange={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Open in browser/ }));
    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith("https://example.com/a.png"),
    );
    view.rerender(
      <ImageLightbox
        images={[{ src: dataUrl(), alt: "a" }]}
        index={0}
        onIndexChange={() => undefined}
        open
        onOpenChange={() => undefined}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Open in browser/ }),
    ).toBeNull();
  });
});

describe("one source key, two walks", () => {
  /** Answers every read with `k` after `ms`; returns each call's start time
   *  relative to the call. */
  function slowVerdict(k: NonNullable<HostedImage["unavailable"]>, ms: number) {
    const start = Date.now();
    const at: number[] = [];
    vi.mocked(ghHostedImage).mockImplementation(() => {
      at.push(Date.now() - start);
      return new Promise((r) => setTimeout(() => r(kind(k)), ms));
    });
    return at;
  }
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const strict = (body: string) =>
    render(
      <StrictMode>
        {wrap(<Markdown hostedImages={SRC}>{body}</Markdown>)}
      </StrictMode>,
    );

  it("a cold open under StrictMode asks a failed verdict once", async () => {
    vi.useFakeTimers();
    const at = slowVerdict("failed", 80);
    strict(`![a](${URL1})`);
    await advance(5000);
    expect(screen.getAllByText(caption("a", "webFailed"))).toHaveLength(1);
    expect(at).toEqual([0]);
  });

  it("a cold open under StrictMode runs one missing chain, captioned at about 4 s", async () => {
    vi.useFakeTimers();
    const at = slowVerdict("missing", 80);
    strict(`![a](${URL1})`);
    await advance(4200);
    expect(screen.queryByText(caption("a", "webMissing"))).toBeNull();
    await advance(100);
    expect(screen.getAllByText(caption("a", "webMissing"))).toHaveLength(1);
    await advance(10_000);
    expect(at).toEqual([0, 1080, 4160]);
  });

  it.each([
    ["failed", "webFailed", 1, 200],
    ["missing", "webMissing", 3, 4400],
  ] as const)(
    "a second body walking 80 ms later joins a %s read",
    async (k, reason, calls, captionAt) => {
      vi.useFakeTimers();
      const at = slowVerdict(k, 100);
      md(`![a](${URL1})`, SRC);
      await advance(80);
      render(wrap(<Markdown hostedImages={SRC}>{`![b](${URL1})`}</Markdown>));
      await advance(captionAt - 80);
      expect(screen.getAllByText(caption("a", reason))).toHaveLength(1);
      expect(screen.getAllByText(caption("b", reason))).toHaveLength(1);
      await advance(10_000);
      expect(at).toHaveLength(calls);
    },
  );

  it("a non-bytes verdict stays settled for 10 s, then a reopen asks again", async () => {
    vi.useFakeTimers();
    const at = slowVerdict("failed", 10);
    const body = `![a](${URL1})`;
    md(body, SRC).unmount();
    await advance(50);
    expect(at).toHaveLength(1);
    await advance(9000);
    md(body, SRC);
    await advance(50);
    expect(screen.getAllByText(caption("a", "webFailed"))).toHaveLength(1);
    expect(at).toHaveLength(1);
    cleanup();
    await advance(2000);
    md(body, SRC);
    await advance(50);
    expect(at).toHaveLength(2);
  });
});

describe("a read parked offline", () => {
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  it.each([
    ["missing", "webMissing", [0, 1000, 4000], 4000],
    ["failed", "webFailed", [0], 0],
  ] as const)(
    "a %s read resumed by the reconnect is taken by the new walk without a second ask",
    async (k, reason, offsets, captionAt) => {
      vi.useFakeTimers();
      const at: number[] = [];
      let online = 0;
      vi.mocked(ghHostedImage).mockImplementation(async () => {
        at.push(Date.now() - online);
        return kind(k);
      });
      onlineManager.setOnline(false);
      md(`![a](${URL1})`, SRC);
      await advance(500);
      expect(ghHostedImage).not.toHaveBeenCalled();
      online = Date.now();
      act(() => onlineManager.setOnline(true));
      if (captionAt > 0) {
        await advance(captionAt - 100);
        expect(screen.queryByText(caption("a", reason))).toBeNull();
      }
      await advance(200);
      expect(screen.getAllByText(caption("a", reason))).toHaveLength(1);
      await advance(10_000);
      expect(at).toEqual(offsets);
    },
  );
});

describe("bytes never go stale", () => {
  it("a remount past the verdict window and inside the minute asks nothing", async () => {
    vi.useFakeTimers();
    vi.mocked(ghHostedImage).mockResolvedValue(shown());
    const body = `![a](${URL1})`;
    const first = md(body, SRC);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(img(first.container).getAttribute("src")).toBe(dataUrl());
    first.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    const again = md(body, SRC);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(img(again.container).getAttribute("src")).toBe(dataUrl());
    expect(ghHostedImage).toHaveBeenCalledTimes(1);
  });
});
