import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
} from "@/components/markdown/markdown-images";
import { ghHostedImage, type HostedImage } from "@/lib/hosted-images/api";
import {
  HOSTED_IMAGE_RETRY_DELAYS_MS,
  hostedImageKey,
  seedHostedImage,
} from "@/lib/hosted-images/queries";
import { unmockedCommands } from "./setup";

// The loader's one IPC seam; no test reaches Rust, gh or the network.
vi.mock("@/lib/hosted-images/api", () => ({ ghHostedImage: vi.fn() }));

const uuid = (n: number) =>
  `c162f463-c831-4173-8a80-4197acc4a8${n.toString(16).padStart(2, "0")}`;
const asset = (n: number) =>
  `https://github.com/user-attachments/assets/${uuid(n)}`;
const URL1 = asset(1);
const KEY = hostedImageKey("github.com", URL1);
const SRC: MarkdownHostedImages = {
  repoPath: "C:/repos/demo",
  host: "github.com",
};

const shown = (base64 = "AAAA"): HostedImage => ({
  bytes: { base64, mime: "image/png", tooLarge: false, size: 3 },
  unavailable: null,
});
const kind = (k: NonNullable<HostedImage["unavailable"]>): HostedImage => ({
  bytes: null,
  unavailable: k,
});
const dataUrl = (base64 = "AAAA") => `data:image/png;base64,${base64}`;
const caption = (name: string, reason: keyof typeof IMAGE_CAPTION_REASON) =>
  `${name} · ${IMAGE_CAPTION_REASON[reason]}`;

/** A read the test settles by hand, with the signal it was handed. */
interface Pending {
  url: string;
  signal: AbortSignal | undefined;
  resolve: (v: HostedImage) => void;
}

/** Every read hangs until the test settles it. */
function hangingReads(): Pending[] {
  const reads: Pending[] = [];
  vi.mocked(ghHostedImage).mockImplementation(
    (_repo, url, signal) =>
      new Promise((resolve) => {
        reads.push({ url, signal, resolve });
      }),
  );
  return reads;
}

let client: QueryClient;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(ghHostedImage).mockReset();
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
const md = (body: string, source = SRC) =>
  render(wrap(<Markdown hostedImages={source}>{body}</Markdown>));
const srcs = (root: ParentNode) =>
  [...root.querySelectorAll("img")].map((i) => i.getAttribute("src"));
/** Lets every queued release check and read continuation run. */
const flush = () => act(async () => undefined);

describe("a hosted read nobody waits for is withdrawn", () => {
  it("unmounting aborts the read, caches nothing, and a remount asks again", async () => {
    const reads = hangingReads();
    const view = md(`![a](${URL1})`);
    expect(reads).toHaveLength(1);
    expect(reads[0].signal?.aborted).toBe(false);
    view.unmount();
    await flush();
    expect(reads[0].signal?.aborted).toBe(true);
    expect(client.getQueryState(KEY)).toMatchObject({
      status: "pending",
      error: null,
      fetchStatus: "idle",
      data: undefined,
    });
    const again = md(`![a](${URL1})`);
    expect(reads).toHaveLength(2);
    reads[1].resolve(shown());
    await waitFor(() => expect(srcs(again.container)).toEqual([dataUrl()]));
  });

  it("a second body showing the same URL keeps the read", async () => {
    const reads = hangingReads();
    const one = md(`![a](${URL1})`);
    const two = md(`![b](${URL1})`);
    expect(reads).toHaveLength(1);
    one.unmount();
    await flush();
    expect(reads[0].signal?.aborted).toBe(false);
    reads[0].resolve(shown());
    await waitFor(() => expect(srcs(two.container)).toEqual([dataUrl()]));
    expect(reads).toHaveLength(1);
  });

  it("under StrictMode one body asks once and keeps its read", async () => {
    const reads = hangingReads();
    const { container } = render(
      <StrictMode>
        {wrap(<Markdown hostedImages={SRC}>{`![a](${URL1})`}</Markdown>)}
      </StrictMode>,
    );
    await flush();
    expect(reads).toHaveLength(1);
    expect(reads[0].signal?.aborted).toBe(false);
    reads[0].resolve(shown());
    await waitFor(() => expect(srcs(container)).toEqual([dataUrl()]));
  });

  it("a missing verdict's re-ask stops once the body leaves mid-pause", async () => {
    vi.useFakeTimers();
    vi.mocked(ghHostedImage).mockResolvedValue(kind("missing"));
    const view = md(`![a](${URL1})`);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(ghHostedImage).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOSTED_IMAGE_RETRY_DELAYS_MS[0] + 500);
    });
    expect(ghHostedImage).toHaveBeenCalledTimes(1);
  });

  it("a seed landing mid-read survives the withdrawal", async () => {
    const reads = hangingReads();
    const view = md(`![a](${URL1})`);
    expect(reads).toHaveLength(1);
    const seed = shown("SEED").bytes;
    if (seed === null) throw new Error("no seed bytes");
    seedHostedImage(client, "github.com", URL1, seed);
    view.unmount();
    await flush();
    expect(client.getQueryData(KEY)).toMatchObject({ bytes: seed });
  });

  it("reads still queued when the body leaves never start", async () => {
    const reads = hangingReads();
    const body = [1, 2, 3, 4, 5, 6]
      .map((n) => `![${n}](${asset(n)})`)
      .join(" ");
    const view = md(body);
    expect(reads).toHaveLength(4);
    view.unmount();
    for (const r of reads) r.resolve(shown());
    await flush();
    expect(ghHostedImage).toHaveBeenCalledTimes(4);
  });

  it("a read parked offline and left before the link returns never runs", async () => {
    vi.mocked(ghHostedImage).mockResolvedValue(shown());
    onlineManager.setOnline(false);
    const view = md(`![a](${URL1})`);
    await flush();
    expect(client.getQueryState(KEY)?.fetchStatus).toBe("paused");
    // The provider stays mounted, so the client still hears the reconnect.
    view.rerender(wrap(<p>left</p>));
    await flush();
    act(() => onlineManager.setOnline(true));
    await flush();
    expect(ghHostedImage).not.toHaveBeenCalled();
  });
});

describe("the re-ask under another source key is held", () => {
  it.each(["settles", "unmounts"] as const)(
    "while the body whose verdict it re-asks %s",
    async (leave) => {
      const reads = hangingReads();
      const other: MarkdownHostedImages = { ...SRC, repoPath: "C:/repos/a" };
      // B walks first, so the shared read runs under B's source key.
      const b = md(`![b](${URL1})`);
      const a = md(`![a](${URL1})`, other);
      expect(reads).toHaveLength(1);
      if (leave === "unmounts") {
        b.unmount();
        await flush();
        expect(reads[0].signal?.aborted).toBe(false);
      }
      reads[0].resolve(kind("failed"));
      await flush();
      // A asks again under its own key; B's release check runs meanwhile.
      expect(reads).toHaveLength(2);
      expect(reads[1].signal?.aborted).toBe(false);
      reads[1].resolve(shown());
      await waitFor(() => expect(srcs(a.container)).toEqual([dataUrl()]));
      expect(screen.queryByText(caption("a", "webFailed"))).toBeNull();
    },
  );
});
