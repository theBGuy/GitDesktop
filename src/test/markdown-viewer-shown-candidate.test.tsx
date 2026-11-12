import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
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
import type { MarkdownHostedImages } from "@/components/markdown/markdown-images";
import { attachmentStage } from "@/lib/attachments/api";
import { stageAttachment } from "@/lib/attachments/store";
import { ghHostedImage, type HostedImage } from "@/lib/hosted-images/api";
import { unmockedCommands } from "./setup";

// The loader's IPC seams; no test reaches Rust, gh or the network.
vi.mock("@/lib/hosted-images/api", () => ({ ghHostedImage: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/plugin-opener")>()),
  openUrl: vi.fn(async () => undefined),
}));
vi.mock("@/lib/attachments/api", () => ({
  attachmentStage: vi.fn(),
  attachmentDiscard: vi.fn(async () => undefined),
}));

const URL1 =
  "https://github.com/user-attachments/assets/c162f463-c831-4173-8a80-4197acc4a8ac";
const URL2 =
  "https://github.com/user-attachments/assets/0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";
const REPO = "C:/repos/demo";
const SRC: MarkdownHostedImages = { repoPath: REPO, host: "github.com" };
const DARK = "(prefers-color-scheme: dark)";

const shown = (base64: string): HostedImage => ({
  bytes: { base64, mime: "image/png", tooLarge: false, size: 3 },
  unavailable: null,
});
const dataUrl = (base64 = "AAAA") => `data:image/png;base64,${base64}`;

let client: QueryClient;
let urlSeq = 0;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(ghHostedImage).mockReset();
  vi.mocked(openUrl).mockClear();
  URL.createObjectURL = vi.fn(() => {
    urlSeq += 1;
    return `blob:shown-${urlSeq}`;
  });
  URL.revokeObjectURL = vi.fn();
});

// The repository spy sits on the per-test client, so it leaves with it.
afterEach(() => {
  cleanup();
});

afterAll(() => expect(unmockedCommands).toEqual([]));

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={client}>{ui}</QueryClientProvider>
);
const img = (root: ParentNode) => {
  const el = root.querySelector("img");
  if (!el) throw new Error("no image");
  return el;
};

/** Loads `el` at a size the viewer takes, with the browser's pick stubbed
 *  (jsdom picks no candidate), then opens it. */
function openShown(el: HTMLImageElement, currentSrc: string) {
  Object.defineProperty(el, "currentSrc", {
    value: currentSrc,
    configurable: true,
  });
  Object.defineProperty(el, "naturalWidth", { value: 400 });
  Object.defineProperty(el, "naturalHeight", { value: 300 });
  fireEvent.load(el);
  fireEvent.click(el);
}

/** The open viewer's image src. */
async function viewerSrc() {
  const dialog = await screen.findByRole("dialog");
  return dialog.querySelector("img")?.getAttribute("src");
}

async function openInBrowser() {
  fireEvent.click(
    await screen.findByRole("button", { name: /Open in browser/ }),
  );
}

/** A body with a repository whose reads answer distinct bytes per path. */
function repoBody(body: string) {
  vi.spyOn(client, "fetchQuery").mockImplementation((async (options: {
    queryKey: readonly unknown[];
  }) => {
    const key = JSON.stringify(options.queryKey);
    return shown(key.includes("dark.png") ? "DDDD" : "LLLL").bytes;
  }) as never);
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

describe("the viewer opens the candidate the body shows", () => {
  it("a plain srcset-only image opens the density it shows", async () => {
    const { container } = render(
      wrap(
        <Markdown>{`<img srcset="https://example.com/a.png 1x, https://example.com/b.png 2x">`}</Markdown>,
      ),
    );
    const el = img(container);
    openShown(el, "https://example.com/b.png");
    expect(await screen.findByRole("dialog", { name: "b.png" })).toBeTruthy();
    expect(await viewerSrc()).toBe("https://example.com/b.png");
    expect(el.getAttribute("aria-label")).toBe("View image: b.png");
    await openInBrowser();
    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith("https://example.com/b.png"),
    );
  });

  it("a plain picture opens its theme variant", async () => {
    const { container } = render(
      wrap(
        <Markdown>{`<picture><source media="${DARK}" srcset="https://example.com/dark.png"><img src="https://example.com/light.png"></picture>`}</Markdown>,
      ),
    );
    openShown(img(container), "https://example.com/dark.png");
    expect(await viewerSrc()).toBe("https://example.com/dark.png");
    await openInBrowser();
    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith("https://example.com/dark.png"),
    );
  });

  it("a hosted picture opens, and links, the variant it shows", async () => {
    vi.mocked(ghHostedImage).mockImplementation(async (_, url) =>
      shown(url === URL1 ? "AAAA" : "BBBB"),
    );
    const { container } = render(
      wrap(
        <Markdown hostedImages={SRC}>
          {`<picture><source media="${DARK}" srcset="${URL1}"><img src="${URL2}"></picture>`}
        </Markdown>,
      ),
    );
    await waitFor(() =>
      expect(img(container).getAttribute("src")).toBe(dataUrl("BBBB")),
    );
    openShown(img(container), dataUrl("AAAA"));
    expect(await viewerSrc()).toBe(dataUrl("AAAA"));
    await openInBrowser();
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith(URL1));
  });

  it("with no pick yet, a hosted picture opens its image as before", async () => {
    vi.mocked(ghHostedImage).mockImplementation(async (_, url) =>
      shown(url === URL1 ? "AAAA" : "BBBB"),
    );
    const { container } = render(
      wrap(
        <Markdown hostedImages={SRC}>
          {`<picture><source media="${DARK}" srcset="${URL1}"><img src="${URL2}"></picture>`}
        </Markdown>,
      ),
    );
    await waitFor(() =>
      expect(img(container).getAttribute("src")).toBe(dataUrl("BBBB")),
    );
    openShown(img(container), "");
    expect(await viewerSrc()).toBe(dataUrl("BBBB"));
    await openInBrowser();
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith(URL2));
  });

  it("a hosted srcset-only image opens a non-empty src", async () => {
    vi.mocked(ghHostedImage).mockResolvedValue(shown("AAAA"));
    const { container } = render(
      wrap(
        <Markdown
          hostedImages={SRC}
        >{`<img alt="s" srcset="${URL2} 2x">`}</Markdown>,
      ),
    );
    await waitFor(() =>
      expect(img(container).getAttribute("srcset")).toBe(`${dataUrl()} 2x`),
    );
    openShown(img(container), dataUrl());
    expect(await viewerSrc()).toBe(dataUrl());
    await openInBrowser();
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith(URL2));
  });

  it("a repository picture is named by the variant it shows", async () => {
    const { container } = repoBody(
      `<picture><source media="${DARK}" srcset="docs/dark.png"><img src="docs/light.png"></picture>`,
    );
    await waitFor(() =>
      expect(img(container).getAttribute("src")).toBe(dataUrl("LLLL")),
    );
    const el = img(container);
    openShown(el, dataUrl("DDDD"));
    expect(
      await screen.findByRole("dialog", { name: "dark.png" }),
    ).toBeTruthy();
    expect(await viewerSrc()).toBe(dataUrl("DDDD"));
    expect(el.getAttribute("aria-label")).toBe("View image: dark.png");
    expect(
      screen.queryByRole("button", { name: /Open in browser/ }),
    ).toBeNull();
  });

  it("a picture falling back from a failed hosted image opens the URL on screen", async () => {
    vi.mocked(ghHostedImage).mockResolvedValue({
      bytes: null,
      unavailable: "signedOut",
    });
    const { container } = render(
      wrap(
        <Markdown hostedImages={SRC}>
          {`<picture><source srcset="https://example.com/a.png"><img src="${URL1}"></picture>`}
        </Markdown>,
      ),
    );
    await waitFor(() =>
      expect(img(container).getAttribute("src")).toBe(
        "https://example.com/a.png",
      ),
    );
    openShown(img(container), "https://example.com/a.png");
    expect(await viewerSrc()).toBe("https://example.com/a.png");
    await openInBrowser();
    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith("https://example.com/a.png"),
    );
    expect(openUrl).not.toHaveBeenCalledWith(URL1);
  });

  it("a staged srcset candidate is named by its staged name", async () => {
    vi.mocked(attachmentStage).mockResolvedValue({
      session: `${"0".repeat(31)}9`,
      name: "image-1.png",
      mime: "image/png",
      size: 4,
      width: 4,
      height: 4,
    });
    const owner = {};
    const draftKey = "issue-comment|/shown#origin#1";
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
        <Markdown stagedImages={{ draftKey, owner }}>
          {`<img srcset="image-1.png 1x, https://example.com/x.png 2x">\n\n[file](image-1.png)`}
        </Markdown>,
      ),
    );
    await waitFor(() =>
      expect(img(container).getAttribute("srcset")).toMatch(/^blob:shown-/),
    );
    const blob = img(container).getAttribute("srcset")?.split(" ")[0] ?? "";
    const el = img(container);
    openShown(el, blob);
    expect(
      await screen.findByRole("dialog", { name: "image-1.png" }),
    ).toBeTruthy();
    expect(await viewerSrc()).toBe(blob);
    expect(el.getAttribute("aria-label")).toBe("View image: image-1.png");
  });
});
