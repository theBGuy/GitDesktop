import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
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
import { encodeBase64 } from "@/lib/attachments/encode";
import {
  attachmentStoreSizes,
  beginAttachmentPost,
  draftEntry,
  HELD_RELEASE_DELAY_MS,
  hasHeldCopies,
  settleAttachmentPost,
  stageAttachment,
  stagedImageUrl,
  sweepOtherOwners,
  watchPostedCopies,
} from "@/lib/attachments/store";
import { ghHostedImage } from "@/lib/hosted-images/api";
import { hostedImageKey } from "@/lib/hosted-images/queries";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/hosted-images/api", () => ({ ghHostedImage: vi.fn() }));
// The file reader behind both staging and a post's seeds, observed as is.
vi.mock("@/lib/attachments/encode", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/lib/attachments/encode")>();
  return { ...real, encodeBase64: vi.fn(real.encodeBase64) };
});
vi.mock("@/lib/attachments/api", () => ({
  attachmentStage: vi.fn(),
  attachmentDiscard: vi.fn(async () => undefined),
}));

const URL1 =
  "https://github.com/user-attachments/assets/c162f463-c831-4173-8a80-4197acc4a8ac";
const URL2 =
  "https://github.com/user-attachments/assets/0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";
const SRC: MarkdownHostedImages = { repoPath: "C:/seed", host: "github.com" };
/** The first four bytes of a PNG, as the staged file and as base64. */
const PNG = [137, 80, 78, 71];
const PNG_DATA = "data:image/png;base64,iVBORw==";

let seq = 0;
/** The raster the next stage reports, as the Rust sniff would. */
let staged = { width: 1, height: 1 };
let urlSeq = 0;
let client: QueryClient;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(ghHostedImage).mockReset();
  vi.mocked(ghHostedImage).mockResolvedValue({
    bytes: null,
    unavailable: "failed",
  });
  let n = 0;
  staged = { width: 1, height: 1 };
  vi.mocked(attachmentStage).mockReset();
  vi.mocked(attachmentStage).mockImplementation(async (session) => {
    n += 1;
    return {
      session: session ?? "5eed".padStart(32, "0"),
      name: `image-${n}.png`,
      mime: "image/png",
      size: PNG.length,
      ...staged,
    };
  });
  URL.createObjectURL = vi.fn(() => {
    urlSeq += 1;
    return `blob:seed-${urlSeq}`;
  });
  URL.revokeObjectURL = vi.fn();
  vi.mocked(encodeBase64).mockClear();
  // Every case starts from a store no earlier case still holds anything in.
  sweepOtherOwners("issue-comment", {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

afterAll(() => expect(unmockedCommands).toEqual([]));

/** Waits on every file read so far, the posted files' seed reads included,
 *  then one microtask more, so each read's `.then` has stored its bytes. */
async function encoded() {
  const files = vi.mocked(encodeBase64).mock.results.map((r) => r.value);
  const settled = await Promise.allSettled(files);
  await Promise.resolve();
  expect(settled.map((s) => s.status)).not.toContain("rejected");
}

/** A seedable image's two reads: its stage's and its post's seed. */
const readsPerImage = 2;

/**
 * Stages `count` images into a fresh issue-comment draft, posts `body`, lets
 * the files encode, settles with `failed`, and arms the watcher with the
 * comment ids the thread showed before the post (`before`).
 */
async function landed(
  count: number,
  body: string,
  failed: string[] = [],
  { seedable = true, before = [] as string[] } = {},
) {
  seq += 1;
  const draftKey = `issue-comment|C:/seed#origin#${seq}`;
  const owner = {};
  for (let i = 0; i < count; i++)
    await stageAttachment({
      draftKey,
      owner,
      file: new File([new Uint8Array(PNG)], "a.png", { type: "image/png" }),
      source: "paste",
      blockedReason: null,
    });
  const urls = draftEntry(draftKey)?.images.map((i) => i.url) ?? [];
  const ticket = beginAttachmentPost(draftKey, body, seedable);
  if (!ticket) throw new Error("no ticket");
  await encoded();
  settleAttachmentPost(ticket, { posted: true, failed });
  const detailKey = ["repo", "C:/seed", "issue", "origin", seq];
  const stop = watchPostedCopies(
    client,
    detailKey,
    ticket.token,
    body,
    new Set(before),
  );
  const land = (...bodies: string[]) =>
    client.setQueryData(detailKey, {
      comments: bodies.map((b, i) => ({ id: `C_${i}`, body: b })),
    });
  /** Lands rows with ids of the test's choosing (`id` absent: none). */
  const landRows = (...rows: { id?: unknown; body: string }[]) =>
    client.setQueryData(detailKey, { comments: rows });
  return { token: ticket.token, urls, land, landRows, stop };
}

const hostedEntries = () =>
  client.getQueryCache().findAll({ queryKey: ["hosted-image"] });

function renderServer(body: string) {
  return render(
    <QueryClientProvider client={client}>
      <Markdown hostedImages={SRC}>{body}</Markdown>
    </QueryClientProvider>,
  );
}

describe("seeding the server copy of a post", () => {
  it("shows the posted image from the post's own bytes, asking GitHub nothing", async () => {
    const { land } = await landed(1, "see ![shot](image-1.png)");
    land(`see ![shot](${URL1})`);
    const query = client
      .getQueryCache()
      .find({ queryKey: hostedImageKey("github.com", URL1) });
    expect(query?.gcTime).toBe(60_000);
    const { container } = renderServer(`see ![shot](${URL1})`);
    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        PNG_DATA,
      ),
    );
    expect(ghHostedImage).not.toHaveBeenCalled();
  });

  it("compares with CRLF as LF and the ends trimmed", async () => {
    const { land } = await landed(1, "one\n![shot](image-1.png)\n");
    land(`  one\r\n![shot](${URL1})`);
    expect(
      client.getQueryData(hostedImageKey("github.com", URL1)),
    ).toMatchObject({ bytes: { base64: "iVBORw==", mime: "image/png" } });
  });

  it("seeds the posted image and writes nothing for the one that failed", async () => {
    const { land } = await landed(2, "![a](image-1.png) ![b](image-2.png)", [
      "image-2.png",
    ]);
    land(`![a](${URL1}) ![b](image-2.png)`);
    expect(hostedEntries().map((q) => q.queryKey)).toEqual([
      hostedImageKey("github.com", URL1),
    ]);
    expect(client.getQueryData(hostedImageKey("github.com", URL1))).toEqual({
      bytes: {
        base64: "iVBORw==",
        mime: "image/png",
        tooLarge: false,
        size: 4,
      },
      unavailable: null,
      askedUnder: null,
    });
  });

  it.each([
    ["differs by one character", [`see ![shot](${URL1}).`]],
    ["matches two comments", [`see ![shot](${URL1})`, `see ![shot](${URL1})`]],
  ])(
    "seeds nothing when the server copy %s, and the read runs",
    async (_, bodies) => {
      const { land } = await landed(1, "see ![shot](image-1.png)");
      expect(encodeBase64).toHaveBeenCalledTimes(readsPerImage);
      land(...bodies);
      expect(hostedEntries()).toHaveLength(0);
      renderServer(`see ![shot](${URL1})`);
      await waitFor(() => expect(ghHostedImage).toHaveBeenCalledTimes(1));
    },
  );

  it.each([
    [
      "a URL outside the hosted grammar",
      "![a](image-1.png)",
      "![a](https://example.com/x.png)",
    ],
    [
      "one name taking two URLs",
      "![a](image-1.png) ![b](image-1.png)",
      `![a](${URL1}) ![b](${URL2})`,
    ],
  ])("seeds nothing for %s", async (_, posted, server) => {
    const { land } = await landed(1, posted);
    expect(encodeBase64).toHaveBeenCalledTimes(readsPerImage);
    land(server);
    expect(hostedEntries()).toHaveLength(0);
  });

  it("leaves an entry that already holds bytes alone", async () => {
    const mine = {
      bytes: { base64: "QUJD", mime: "image/png", tooLarge: false, size: 3 },
      unavailable: null,
      askedUnder: "earlier",
    };
    client.setQueryData(hostedImageKey("github.com", URL1), mine);
    const { land } = await landed(1, "![a](image-1.png)");
    land(`![a](${URL1})`);
    expect(client.getQueryData(hostedImageKey("github.com", URL1))).toBe(mine);
  });

  it("returns the store to its baseline and revokes every copy after the release", async () => {
    const before = attachmentStoreSizes();
    const { land, urls } = await landed(
      2,
      "![a](image-1.png) ![b](image-2.png)",
    );
    land(`![a](${URL1}) ![b](${URL2})`);
    expect(hostedEntries()).toHaveLength(2);
    await waitFor(() => expect(attachmentStoreSizes()).toEqual(before));
    expect(urls).toHaveLength(2);
    for (const url of urls)
      expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
  });
});

describe("releasing held copies after the row swap", () => {
  it("keeps the optimistic row's images resolvable past the landing, then frees them", async () => {
    const before = attachmentStoreSizes();
    const { land, token, urls, stop } = await landed(1, "![a](image-1.png)");
    land(`![a](${URL1})`);
    // The view may unmount between the decision and the release.
    stop();
    expect(stagedImageUrl({ postToken: token }, "image-1.png")).toBe(urls[0]);
    await new Promise((r) => setTimeout(r, HELD_RELEASE_DELAY_MS - 100));
    expect(stagedImageUrl({ postToken: token }, "image-1.png")).toBe(urls[0]);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(urls[0]);
    await waitFor(() => expect(hasHeldCopies(token)).toBe(false));
    expect(stagedImageUrl({ postToken: token }, "image-1.png")).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(urls[0]);
    expect(attachmentStoreSizes()).toEqual(before);
  });
});

describe("only a row the post made takes a seed", () => {
  it("a landing holding only an older identical comment seeds nothing", async () => {
    const { landRows } = await landed(1, "![image](image-1.png)", [], {
      before: ["C_old"],
    });
    expect(encodeBase64).toHaveBeenCalledTimes(readsPerImage);
    landRows({ id: "C_old", body: `![image](${URL1})` });
    expect(hostedEntries()).toHaveLength(0);
  });

  it("beside the new server copy, only the new one is seeded", async () => {
    const { landRows } = await landed(1, "![image](image-1.png)", [], {
      before: ["C_old"],
    });
    landRows(
      { id: "C_old", body: `![image](${URL1})` },
      { id: "C_new", body: `![image](${URL2})` },
    );
    expect(hostedEntries().map((q) => q.queryKey)).toEqual([
      hostedImageKey("github.com", URL2),
    ]);
  });

  it.each([
    ["no id", { body: `![image](${URL1})` }],
    ["an empty id", { id: "", body: `![image](${URL1})` }],
    ["a numeric id", { id: 7, body: `![image](${URL1})` }],
  ])("a row with %s is never seeded", async (_, row) => {
    const { landRows } = await landed(1, "![image](image-1.png)");
    expect(encodeBase64).toHaveBeenCalledTimes(readsPerImage);
    landRows(row);
    expect(hostedEntries()).toHaveLength(0);
  });
});

describe("a post that can show no hosted URL", () => {
  it("reads no file and seeds nothing", async () => {
    const reader = vi.mocked(encodeBase64);
    reader.mockClear();
    const { land } = await landed(1, "![a](image-1.png)", [], {
      seedable: false,
    });
    // The one read is the stage's own.
    expect(reader).toHaveBeenCalledTimes(1);
    land(`![a](${URL1})`);
    expect(hostedEntries()).toHaveLength(0);
  });

  it("with a hosted source, reads the file once more for its seed", async () => {
    const reader = vi.mocked(encodeBase64);
    reader.mockClear();
    const { land } = await landed(1, "![a](image-1.png)");
    expect(reader).toHaveBeenCalledTimes(2);
    land(`![a](${URL1})`);
    expect(hostedEntries()).toHaveLength(1);
  });
});

describe("a raster the loader would refuse", () => {
  it.each([
    [8193, 10, false],
    [10, 8193, false],
    [7000, 7000, false],
    [0, 10, false],
    [8192, 4000, true],
    [8000, 5000, true],
  ])("%i x %i seeded: %s", async (width, height, seeds) => {
    staged = { width, height };
    const { land } = await landed(1, "![a](image-1.png)");
    // A refused raster is never read for a seed: only the stage's read ran.
    expect(encodeBase64).toHaveBeenCalledTimes(seeds ? readsPerImage : 1);
    land(`![a](${URL1})`);
    expect(hostedEntries()).toHaveLength(seeds ? 1 : 0);
  });
});

describe("seeded bytes never go stale", () => {
  it("a remount past the verdict window and inside the minute asks nothing", async () => {
    const { land } = await landed(1, "see ![shot](image-1.png)");
    land(`see ![shot](${URL1})`);
    const body = `see ![shot](${URL1})`;
    const first = renderServer(body);
    await waitFor(() =>
      expect(first.container.querySelector("img")?.getAttribute("src")).toBe(
        PNG_DATA,
      ),
    );
    first.unmount();
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 20_000);
    const again = renderServer(body);
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    expect(again.container.querySelector("img")?.getAttribute("src")).toBe(
      PNG_DATA,
    );
    expect(ghHostedImage).not.toHaveBeenCalled();
  });
});
