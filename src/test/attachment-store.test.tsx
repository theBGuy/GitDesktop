import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "@/components/markdown/markdown";
import { IMAGE_CAPTION_REASON } from "@/components/markdown/markdown-images";
import { TabPanel } from "@/features/repository/TabPanel";
import { attachmentDiscard, attachmentStage } from "@/lib/attachments/api";
import { landCommentPost } from "@/lib/attachments/comment-post";
import {
  attachmentStoreSizes,
  beginAttachmentPost,
  draftEntry,
  endDraftAttachments,
  hasHeldCopies,
  noteAttachBlocked,
  settleAttachmentPost,
  stageAttachment,
  stagedImageUrl,
  startAttachGesture,
  sweepOtherOwners,
  watchPostedCopies,
} from "@/lib/attachments/store";
import { useAttachmentOwner } from "@/lib/attachments/use-draft-attachments";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/attachments/api", () => ({
  attachmentStage: vi.fn(),
  attachmentDiscard: vi.fn(async () => undefined),
}));

// The store is module state that outlives each test, so every test stages
// into its own session and key: a lookup must never match an earlier test's entry.
let SESSION = "";
let sessionSeq = 0;
const calls: string[] = [];
let seq = 0;
let urlSeq = 0;

beforeEach(() => {
  sessionSeq += 1;
  SESSION = sessionSeq.toString(16).padStart(32, "0");
  calls.length = 0;
  let n = 0;
  vi.mocked(attachmentStage).mockReset();
  vi.mocked(attachmentStage).mockImplementation(async (session) => {
    n += 1;
    calls.push(`stage:${session}`);
    return {
      session: session ?? SESSION,
      name: `image-${n}.png`,
      mime: "image/png",
      size: 1,
      width: 1,
      height: 1,
    };
  });
  vi.mocked(attachmentDiscard).mockReset();
  vi.mocked(attachmentDiscard).mockImplementation(async (s, names) => {
    calls.push(`discard:${s}:${names === null ? "all" : names.join(",")}`);
  });
  URL.createObjectURL = vi.fn(() => {
    urlSeq += 1;
    return `blob:s-${urlSeq}`;
  });
  URL.revokeObjectURL = vi.fn();
});

afterAll(() => expect(unmockedCommands).toEqual([]));

const png = () => new File([new Uint8Array([1, 2])], "x.png");
/** Lets every queued discard reach the mock before a test reads `calls`. */
const flushChains = () => new Promise((r) => setTimeout(r, 20));
const key = (surface = "issue-comment") => {
  seq += 1;
  return `${surface}|/repo#origin#${seq}`;
};
const stage = (draftKey: string, owner: object) =>
  stageAttachment({
    draftKey,
    owner,
    file: png(),
    source: "paste",
    blockedReason: null,
  });

describe("attachment store", () => {
  it("chains stages so the second carries the first's session", async () => {
    const k = key();
    const owner = {};
    await Promise.all([stage(k, owner), stage(k, owner)]);
    expect(calls).toEqual(["stage:null", `stage:${SESSION}`]);
    expect(draftEntry(k)?.images.map((i) => i.name)).toEqual([
      "image-1.png",
      "image-2.png",
    ]);
  });

  it("replaces a record whose name a stage returns again, revoking its URL", async () => {
    const k = key();
    const owner = {};
    vi.mocked(attachmentStage).mockImplementation(async () => ({
      session: SESSION,
      name: "image-1.png",
      mime: "image/png",
      size: 1,
      width: 1,
      height: 1,
    }));
    await stage(k, owner);
    const first = draftEntry(k)?.images[0].url;
    await stage(k, owner);
    expect(draftEntry(k)?.images).toHaveLength(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(first);
  });

  it("discards a stage that resolves after Clear, and Clear's discard runs last", async () => {
    const k = key();
    const owner = {};
    await stage(k, owner);
    calls.length = 0;
    let resolve: (v: Awaited<ReturnType<typeof attachmentStage>>) => void =
      () => undefined;
    vi.mocked(attachmentStage).mockImplementationOnce((session) => {
      calls.push(`stage:${session}`);
      return new Promise((r) => {
        resolve = r;
      });
    });
    const late = stage(k, owner);
    await vi.waitFor(() => expect(attachmentStage).toHaveBeenCalledTimes(2));
    endDraftAttachments(k);
    expect(draftEntry(k)).toBeUndefined();
    resolve({
      session: SESSION,
      name: "image-2.png",
      mime: "image/png",
      size: 1,
      width: 1,
      height: 1,
    });
    expect(await late).toBeNull();
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls).toEqual([
      `stage:${SESSION}`,
      `discard:${SESSION}:image-2.png`,
      `discard:${SESSION}:all`,
    ]);
    expect(draftEntry(k)).toBeUndefined();
  });

  it("never calls Rust for a stage still encoding when Clear runs", async () => {
    const k = key();
    const owner = {};
    await stage(k, owner);
    calls.length = 0;
    const late = stage(k, owner);
    endDraftAttachments(k);
    expect(await late).toBeNull();
    await vi.waitFor(() => expect(calls).toEqual([`discard:${SESSION}:all`]));
    expect(attachmentStage).toHaveBeenCalledTimes(1);
  });

  it("drops a stage resolving into a posting draft", async () => {
    const k = key();
    const owner = {};
    await stage(k, owner);
    expect(
      beginAttachmentPost(k, "![image](image-1.png)", true),
    ).not.toBeNull();
    expect(await stage(k, owner)).toBeNull();
    expect(draftEntry(k)?.images).toHaveLength(1);
    expect(calls.at(-1)).toBe(`discard:${SESSION}:image-2.png`);
  });

  it("sweeps other owners' entries and held copies, never its own", async () => {
    const k = key();
    const a = {};
    await stage(k, a);
    sweepOtherOwners("issue-comment", a);
    expect(draftEntry(k)).toBeDefined();
    sweepOtherOwners("pr-comment", {});
    expect(draftEntry(k)).toBeDefined();
    sweepOtherOwners("issue-comment", {});
    expect(draftEntry(k)).toBeUndefined();
    await vi.waitFor(() => expect(calls.at(-1)).toBe(`discard:${SESSION}:all`));
  });

  it("an Activity hide and re-show of the same owner releases nothing", async () => {
    const k = key();
    let owner: object = {};
    const effects: string[] = [];
    function Probe() {
      owner = useAttachmentOwner("issue-comment", true);
      useEffect(() => {
        effects.push("connect");
        return () => {
          effects.push("disconnect");
        };
      }, []);
      return null;
    }
    const ui = (active: boolean) => (
      <TabPanel active={active}>
        <Probe />
      </TabPanel>
    );
    const { rerender } = render(ui(true));
    await stage(k, owner);
    const url = draftEntry(k)?.images[0].url;
    calls.length = 0;
    rerender(ui(false));
    rerender(ui(true));
    // The hide really ran the effects' cleanup, and the show replayed them.
    expect(effects).toEqual(["connect", "disconnect", "connect"]);
    expect(draftEntry(k)?.images).toHaveLength(1);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(url);
    await flushChains();
    expect(calls).toEqual([]);
  });

  it("holds a landed post's images until no row of the thread carries its token", async () => {
    const k = key();
    const owner = {};
    await stage(k, owner);
    const url = draftEntry(k)?.images[0].url;
    const ticket = beginAttachmentPost(k, "![image](image-1.png)", true);
    if (!ticket) throw new Error("no ticket");
    expect(ticket.token).toMatch(/^[0-9a-f]{32}$/);
    const post = { postToken: ticket.token };
    // In flight, the post resolves through the posting entry.
    expect(stagedImageUrl(post, "image-1.png")).toBe(url);
    const client = new QueryClient();
    const detailKey = ["repo", "/repo", "issue", "origin", 1];
    watchPostedCopies(
      client,
      detailKey,
      ticket.token,
      "![image](image-1.png)",
      new Set(),
    );
    settleAttachmentPost(ticket, { posted: true, failed: [] });
    expect(draftEntry(k)).toBeUndefined();
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(url);
    expect(stagedImageUrl(post, "image-1.png")).toBe(url);
    // The draft's own source never reaches a posted copy.
    expect(stagedImageUrl({ draftKey: k, owner }, "image-1.png")).toBeNull();
    client.setQueryData(detailKey, {
      comments: [
        {
          id: "optimistic:1",
          body: "![image](image-1.png)",
          postToken: ticket.token,
        },
      ],
    });
    expect(hasHeldCopies(ticket.token)).toBe(true);
    // Text naming the image holds nothing: only the row carrying the token does.
    client.setQueryData(detailKey, {
      comments: [{ id: "C_1", body: `![image](image-1.png) ${ticket.token}` }],
    });
    await vi.waitFor(() => expect(hasHeldCopies(ticket.token)).toBe(false));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
    expect(stagedImageUrl(post, "image-1.png")).toBeNull();
  });

  it("decides on a landing, never on the invalidate right after its subscribe", async () => {
    const k = key();
    await stage(k, {});
    const url = draftEntry(k)?.images[0].url;
    const ticket = beginAttachmentPost(k, "![image](image-1.png)", true);
    if (!ticket) throw new Error("no ticket");
    const client = new QueryClient();
    const detailKey = ["repo", "/repo", "issue", "origin", 2];
    // A refetch landed mid-post: the cached data already lacks the marker.
    client.setQueryData(detailKey, { comments: [{ body: "hosted" }] });
    watchPostedCopies(
      client,
      detailKey,
      ticket.token,
      "![image](image-1.png)",
      new Set(),
    );
    await client.invalidateQueries({ queryKey: detailKey });
    settleAttachmentPost(ticket, { posted: true, failed: [] });
    expect(hasHeldCopies(ticket.token)).toBe(true);
    client.setQueryData(detailKey, { comments: [{ body: "hosted" }] });
    await vi.waitFor(() => expect(hasHeldCopies(ticket.token)).toBe(false));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
  });

  it("a landing that beats the settle makes the settle revoke at once", async () => {
    const k = key();
    await stage(k, {});
    const url = draftEntry(k)?.images[0].url;
    const ticket = beginAttachmentPost(k, "![image](image-1.png)", true);
    if (!ticket) throw new Error("no ticket");
    const client = new QueryClient();
    const detailKey = ["repo", "/repo", "issue", "origin", 3];
    watchPostedCopies(
      client,
      detailKey,
      ticket.token,
      "![image](image-1.png)",
      new Set(),
    );
    client.setQueryData(detailKey, { comments: [{ body: "hosted" }] });
    settleAttachmentPost(ticket, { posted: true, failed: [] });
    expect(hasHeldCopies(ticket.token)).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
  });

  it("keeps the failed image staged and the posted one held on a partial post", async () => {
    const k = key();
    const owner = {};
    await stage(k, owner);
    await stage(k, owner);
    const ticket = beginAttachmentPost(
      k,
      "![a](image-1.png) ![b](image-2.png)",
      true,
    );
    if (!ticket) throw new Error("no ticket");
    expect(
      settleAttachmentPost(ticket, { posted: true, failed: ["image-2.png"] }),
    ).toBe(true);
    expect(draftEntry(k)?.images.map((i) => i.name)).toEqual(["image-2.png"]);
    expect(draftEntry(k)?.notice).toEqual({ failed: ["image-2.png"] });
    const post = { postToken: ticket.token };
    expect(stagedImageUrl(post, "image-1.png")).not.toBeNull();
    // The failed image is the draft's again, never the posted row's.
    expect(stagedImageUrl(post, "image-2.png")).toBeNull();
    expect(
      stagedImageUrl({ draftKey: k, owner }, "image-2.png"),
    ).not.toBeNull();
    // Another owner's render of the same key reaches nothing.
    expect(
      stagedImageUrl({ draftKey: k, owner: {} }, "image-2.png"),
    ).toBeNull();
    await vi.waitFor(() =>
      expect(calls.at(-1)).toBe(`discard:${SESSION}:image-1.png`),
    );
  });

  it("a release asked for mid-post is deferred to the settle", async () => {
    const k = key();
    const owner = {};
    await stage(k, owner);
    const ticket = beginAttachmentPost(k, "![image](image-1.png)", true);
    if (!ticket) throw new Error("no ticket");
    endDraftAttachments(k);
    expect(draftEntry(k)?.images).toHaveLength(1);
    settleAttachmentPost(ticket, { posted: false, failed: [] });
    expect(draftEntry(k)).toBeUndefined();
  });

  it("a second mount of the surface releases the first's entry and held copies", async () => {
    const k = key();
    let owner: object = {};
    function Probe() {
      owner = useAttachmentOwner("issue-comment", true);
      return null;
    }
    const first = render(<Probe />);
    const a = owner;
    await stage(k, a);
    await stage(k, a);
    const ticket = beginAttachmentPost(
      k,
      "![a](image-1.png) ![b](image-2.png)",
      true,
    );
    if (!ticket) throw new Error("no ticket");
    settleAttachmentPost(ticket, { posted: true, failed: ["image-2.png"] });
    expect(draftEntry(k)?.images).toHaveLength(1);
    expect(hasHeldCopies(ticket.token)).toBe(true);
    first.unmount();
    render(<Probe />);
    expect(owner).not.toBe(a);
    expect(draftEntry(k)).toBeUndefined();
    expect(hasHeldCopies(ticket.token)).toBe(false);
  });
});

describe("a posting entry a new owner displaces", () => {
  async function displaced(count: number) {
    const k = key();
    const a = {};
    for (let i = 0; i < count; i++) await stage(k, a);
    const urls = draftEntry(k)?.images.map((i) => i.url) ?? [];
    const body = urls.map((_, i) => `![x](image-${i + 1}.png)`).join(" ");
    const ticket = beginAttachmentPost(k, body, true);
    if (!ticket) throw new Error("no ticket");
    // A remount's sweep defers the end; the new owner's blocked press then
    // takes the key while the post is still in flight.
    const b = {};
    sweepOtherOwners("issue-comment", b);
    noteAttachBlocked(k, b, "Busy.");
    expect(draftEntry(k)?.owner).toBe(b);
    const posted = (name: string) =>
      stagedImageUrl({ postToken: ticket.token }, name);
    expect(posted("image-1.png")).toBe(urls[0]);
    calls.length = 0;
    return { k, ticket, urls, body, posted, b };
  }

  it("(a) landed: holds the posted copies and discards the session", async () => {
    const { k, ticket, urls, posted, b } = await displaced(1);
    expect(settleAttachmentPost(ticket, { posted: true, failed: [] })).toBe(
      false,
    );
    expect(hasHeldCopies(ticket.token)).toBe(true);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(urls[0]);
    expect(posted("image-1.png")).toBe(urls[0]);
    expect(draftEntry(k)?.owner).toBe(b);
    await vi.waitFor(() => expect(calls).toEqual([`discard:${SESSION}:all`]));
  });

  it("(b) landed with failures: the failed image ends with the displaced draft", async () => {
    const { k, ticket, urls, body } = await displaced(2);
    expect(
      landCommentPost(k, ticket, body, { failedAttachments: ["image-2.png"] }),
    ).toBeNull();
    expect(hasHeldCopies(ticket.token)).toBe(true);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(urls[0]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(urls[1]);
    await vi.waitFor(() => expect(calls).toEqual([`discard:${SESSION}:all`]));
  });

  it("(c) rejected: every URL revoked and the session discarded", async () => {
    const { ticket, urls, posted } = await displaced(2);
    settleAttachmentPost(ticket, { posted: false, failed: [] });
    expect(hasHeldCopies(ticket.token)).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(urls[0]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(urls[1]);
    expect(posted("image-1.png")).toBeNull();
    await vi.waitFor(() => expect(calls).toEqual([`discard:${SESSION}:all`]));
  });
});

describe("Markdown resolves staged names only through its own source", () => {
  it("shows the source's image and never reads the repo for it; a name it lacks falls through", async () => {
    const k = key();
    const owner = {};
    await stage(k, owner);
    const url = draftEntry(k)?.images[0].url;
    const client = new QueryClient();
    // A repo read answers "absent" here, so the repo-backed mount never reaches
    // the transport.
    const fetchQuery = vi
      .spyOn(client, "fetchQuery")
      .mockResolvedValue(null as never);
    const source = { draftKey: k, owner };
    const body = "![one](image-1.png) ![two](image-9.png)";
    const { unmount } = render(
      <QueryClientProvider client={client}>
        <Markdown stagedImages={source}>{body}</Markdown>
      </QueryClientProvider>,
    );
    expect(screen.getByRole("img", { name: "one" })).toHaveAttribute(
      "src",
      url,
    );
    expect(
      screen.getByText(`two · ${IMAGE_CAPTION_REASON.noRepo}`),
    ).toBeInTheDocument();
    unmount();
    render(
      <QueryClientProvider client={client}>
        <Markdown
          stagedImages={source}
          repoImages={{
            repoPath: "/repo",
            rev: null,
            baseDir: "",
            refreshKey: 0,
          }}
        >
          {`${body} ![three](docs/three.png)`}
        </Markdown>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(fetchQuery).toHaveBeenCalledTimes(2));
    const reads = JSON.stringify(fetchQuery.mock.calls);
    expect(reads).toContain("image-9.png");
    expect(reads).toContain("docs/three.png");
    expect(reads).not.toContain("image-1.png");
    expect(screen.getByRole("img", { name: "one" })).toHaveAttribute(
      "src",
      url,
    );
  });

  it("without the prop a staged name behaves as before: a caption, or a repo read (control)", async () => {
    const k = key();
    await stage(k, {});
    const client = new QueryClient();
    const fetchQuery = vi
      .spyOn(client, "fetchQuery")
      .mockResolvedValue(null as never);
    const { container, unmount } = render(
      <QueryClientProvider client={client}>
        <Markdown>{"![one](image-1.png)"}</Markdown>
      </QueryClientProvider>,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(
      screen.getByText(`one · ${IMAGE_CAPTION_REASON.noRepo}`),
    ).toBeInTheDocument();
    unmount();
    render(
      <QueryClientProvider client={client}>
        <Markdown
          repoImages={{
            repoPath: "/repo",
            rev: null,
            baseDir: "",
            refreshKey: 0,
          }}
        >
          {"![one](image-1.png)"}
        </Markdown>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(fetchQuery).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(fetchQuery.mock.calls)).toContain("image-1.png");
  });
});

describe("no collection outgrows its posts", () => {
  const detailKey = (n: number) => ["repo", "/repo", "issue", "origin", n];

  it("a refetch after a rejected post's settle leaves nothing retired", async () => {
    const before = attachmentStoreSizes();
    const k = key();
    await stage(k, {});
    const ticket = beginAttachmentPost(k, "![image](image-1.png)", true);
    if (!ticket) throw new Error("no ticket");
    const client = new QueryClient();
    // The reconcile arms the watcher on an error too.
    watchPostedCopies(
      client,
      detailKey(40),
      ticket.token,
      "![image](image-1.png)",
      new Set(),
    );
    settleAttachmentPost(ticket, { posted: false, failed: [] });
    client.setQueryData(detailKey(40), { comments: [] });
    expect(attachmentStoreSizes().retired).toBe(before.retired);
    expect(attachmentStoreSizes().held).toBe(before.held);
    expect(hasHeldCopies(ticket.token)).toBe(false);
  });

  it("a landing that beats a settle holding nothing is consumed by that settle", async () => {
    const before = attachmentStoreSizes();
    const k = key();
    await stage(k, {});
    const ticket = beginAttachmentPost(k, "![image](image-1.png)", true);
    if (!ticket) throw new Error("no ticket");
    const client = new QueryClient();
    watchPostedCopies(
      client,
      detailKey(41),
      ticket.token,
      "![image](image-1.png)",
      new Set(),
    );
    client.setQueryData(detailKey(41), { comments: [] });
    expect(attachmentStoreSizes().retired).toBe(before.retired + 1);
    // Every image failed: nothing to hold, and the token still goes.
    settleAttachmentPost(ticket, { posted: true, failed: ["image-1.png"] });
    expect(attachmentStoreSizes().retired).toBe(before.retired);
    expect(draftEntry(k)?.notice).toEqual({ failed: ["image-1.png"] });
  });
});

describe("the cap reclaims staged files the text no longer references", () => {
  const refs = (...ns: number[]) =>
    ns.map((n) => `![image](image-${n}.png)`).join("\n");
  const stageText = (k: string, owner: object, text: string | null) =>
    stageAttachment({
      draftKey: k,
      owner,
      file: png(),
      source: "paste",
      blockedReason: null,
      text: () => text,
    });
  /** Ten staged in an earlier gesture, so none is fresh for the next one. */
  async function tenStaged(k: string, owner: object) {
    startAttachGesture(k, owner);
    for (let i = 0; i < 10; i++) await stage(k, owner);
    startAttachGesture(k, owner);
    calls.length = 0;
  }
  const names = (k: string) => draftEntry(k)?.images.map((i) => i.name);
  const done = async (k: string) => {
    endDraftAttachments(k);
    await flushChains();
  };

  it("discards the unreferenced three before the eleventh stage, which lands", async () => {
    const k = key();
    const owner = {};
    await tenStaged(k, owner);
    const staged = await stageText(k, owner, refs(1, 2, 3, 4, 5, 6, 7));
    expect(staged?.name).toBe("image-11.png");
    expect(calls).toEqual([
      `discard:${SESSION}:image-8.png,image-9.png,image-10.png`,
      `stage:${SESSION}`,
    ]);
    expect(names(k)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 11].map((n) => `image-${n}.png`),
    );
    expect(draftEntry(k)?.reclaimed).toEqual([
      "image-8.png",
      "image-9.png",
      "image-10.png",
    ]);
    await done(k);
  });

  it("discards nothing when all ten are referenced, and Rust's refusal shows (control)", async () => {
    const k = key();
    const owner = {};
    await tenStaged(k, owner);
    vi.mocked(attachmentStage).mockRejectedValueOnce(
      new Error("You can attach up to 10 images at a time."),
    );
    const staged = await stageText(
      k,
      owner,
      refs(1, 2, 3, 4, 5, 6, 7, 8, 9, 10),
    );
    expect(staged).toBeNull();
    expect(calls).toEqual([]);
    expect(names(k)).toHaveLength(10);
    expect(draftEntry(k)?.status?.text).toBe(
      "You can attach up to 10 images at a time.",
    );
    await done(k);
  });

  it("never reclaims a name staged in the current gesture, whose reference may still be on its way", async () => {
    const k = key();
    const owner = {};
    startAttachGesture(k, owner);
    for (let i = 0; i < 9; i++) await stage(k, owner);
    startAttachGesture(k, owner);
    calls.length = 0;
    // One gesture of two files; the text never shows the first's reference.
    const text = refs(1, 2, 3, 4, 5, 6, 7, 8, 9);
    await Promise.all([stageText(k, owner, text), stageText(k, owner, text)]);
    expect(calls).toEqual([`stage:${SESSION}`, `stage:${SESSION}`]);
    expect(names(k)).toContain("image-10.png");
    await done(k);
  });

  it("keeps the fresh names while another gesture's stage is still in flight", async () => {
    const k = key();
    const owner = {};
    startAttachGesture(k, owner);
    for (let i = 0; i < 9; i++) await stage(k, owner);
    startAttachGesture(k, owner);
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const real = vi.mocked(attachmentStage).getMockImplementation();
    if (!real) throw new Error("no stage mock");
    vi.mocked(attachmentStage)
      .mockImplementationOnce(real)
      .mockImplementationOnce(async (s, h, d) => {
        await held;
        return real(s, h, d);
      });
    // Gesture A: image-10 lands, then its second file is still in flight when
    // gesture B starts, so image-10 stays fresh for B.
    await stageText(k, owner, null);
    const second = stageText(k, owner, null);
    await flushChains();
    startAttachGesture(k, owner);
    release();
    await second;
    calls.length = 0;
    await stageText(k, owner, refs(1, 2, 3, 4, 5, 6, 7, 8, 9));
    expect(calls).toEqual([`stage:${SESSION}`]);
    await done(k);
  });

  it("keeps every record when the discard fails, and the stage still runs", async () => {
    const k = key();
    const owner = {};
    await tenStaged(k, owner);
    vi.mocked(attachmentDiscard).mockRejectedValueOnce(new Error("io"));
    vi.mocked(attachmentStage).mockRejectedValueOnce(
      new Error("You can attach up to 10 images at a time."),
    );
    expect(await stageText(k, owner, refs(1))).toBeNull();
    expect(vi.mocked(attachmentStage)).toHaveBeenCalledTimes(11);
    expect(names(k)).toHaveLength(10);
    expect(draftEntry(k)?.reclaimed).toEqual([]);
    expect(draftEntry(k)?.status?.text).toBe(
      "You can attach up to 10 images at a time.",
    );
    await done(k);
  });

  it("reclaims nothing over a text it can't read", async () => {
    const k = key();
    const owner = {};
    await tenStaged(k, owner);
    await stageText(k, owner, null);
    expect(calls).toEqual([`stage:${SESSION}`]);
    await done(k);
  });

  it("sends a reclaimed name the text references again, alone or beside live names", async () => {
    const k = key();
    const owner = {};
    await tenStaged(k, owner);
    await stageText(k, owner, refs(1, 2, 3, 4, 5, 6, 7));
    const alone = beginAttachmentPost(k, refs(9), false);
    expect(alone?.refs).toEqual({ session: SESSION, names: ["image-9.png"] });
    if (!alone) throw new Error("no ticket");
    // Rust refuses it as no longer attached: nothing was posted.
    settleAttachmentPost(alone, { posted: false, failed: [] });
    expect(names(k)).toHaveLength(8);
    const mixed = beginAttachmentPost(k, refs(9, 1, 11), false);
    expect(mixed?.refs.names).toEqual([
      "image-9.png",
      "image-1.png",
      "image-11.png",
    ]);
    if (!mixed) throw new Error("no ticket");
    settleAttachmentPost(mixed, { posted: false, failed: [] });
    // A staged-shaped name this draft never staged sends nothing (control).
    expect(beginAttachmentPost(k, refs(42), false)).toBeNull();
    await done(k);
  });

  it("keeps a reclaimed name a stage returns in another case, and sends it when referenced", async () => {
    const k = key();
    const owner = {};
    await tenStaged(k, owner);
    await stageText(k, owner, refs(1, 2, 3, 4, 5, 6, 7));
    vi.mocked(attachmentStage).mockImplementationOnce(async (s) => ({
      session: s ?? SESSION,
      name: "IMAGE-9.png",
      mime: "image/png",
      size: 1,
      width: 1,
      height: 1,
    }));
    startAttachGesture(k, owner);
    await stageText(k, owner, null);
    expect(draftEntry(k)?.reclaimed).toEqual([
      "image-8.png",
      "image-9.png",
      "image-10.png",
    ]);
    // The old reference still reaches Rust, which refuses it; never dropped.
    const ticket = beginAttachmentPost(k, refs(9), false);
    expect(ticket?.refs.names).toEqual(["image-9.png"]);
    if (!ticket) throw new Error("no ticket");
    settleAttachmentPost(ticket, { posted: false, failed: [] });
    await done(k);
  });

  it("remembers a reclaimed case variant beside the other case, and sends each it references", async () => {
    const k = key();
    const owner = {};
    await tenStaged(k, owner);
    await stageText(k, owner, refs(1, 2, 3, 4, 5, 6, 7));
    vi.mocked(attachmentStage).mockImplementationOnce(async (s) => ({
      session: s ?? SESSION,
      name: "IMAGE-9.png",
      mime: "image/png",
      size: 1,
      width: 1,
      height: 1,
    }));
    startAttachGesture(k, owner);
    await stageText(k, owner, null);
    await stageText(k, owner, null);
    // The variant's reference is gone from the text, so the next cap reclaim
    // takes it.
    startAttachGesture(k, owner);
    await stageText(k, owner, refs(1, 2, 3, 4, 5, 6, 7, 11, 12));
    expect(draftEntry(k)?.reclaimed).toEqual([
      "image-8.png",
      "image-9.png",
      "image-10.png",
      "IMAGE-9.png",
    ]);
    const variant = beginAttachmentPost(k, "![image](IMAGE-9.png)", false);
    expect(variant?.refs.names).toEqual(["IMAGE-9.png"]);
    if (!variant) throw new Error("no ticket");
    settleAttachmentPost(variant, { posted: false, failed: [] });
    // Both cases go to Rust, whose duplicate-name refusal answers the post.
    const both = beginAttachmentPost(
      k,
      `${refs(9)}\n![image](IMAGE-9.png)`,
      false,
    );
    expect(both?.refs.names).toEqual(["image-9.png", "IMAGE-9.png"]);
    if (!both) throw new Error("no ticket");
    settleAttachmentPost(both, { posted: false, failed: [] });
    await done(k);
  });

  it("issues the lowest free name after a reclaim, which is live again while the others stay reclaimed", async () => {
    const k = key();
    const owner = {};
    await tenStaged(k, owner);
    // Rust names a new file from the lowest free gap.
    vi.mocked(attachmentStage).mockImplementationOnce(async (s) => ({
      session: s ?? SESSION,
      name: "image-8.png",
      mime: "image/png",
      size: 1,
      width: 1,
      height: 1,
    }));
    const staged = await stageText(k, owner, refs(1, 2, 3, 4, 5, 6, 7));
    expect(staged?.name).toBe("image-8.png");
    expect(draftEntry(k)?.reclaimed).toEqual(["image-9.png", "image-10.png"]);
    const live = beginAttachmentPost(k, refs(8), false);
    expect(live?.refs.names).toEqual(["image-8.png"]);
    if (!live) throw new Error("no ticket");
    settleAttachmentPost(live, { posted: false, failed: [] });
    const reclaimed = beginAttachmentPost(k, refs(9), false);
    expect(reclaimed?.refs.names).toEqual(["image-9.png"]);
    if (!reclaimed) throw new Error("no ticket");
    settleAttachmentPost(reclaimed, { posted: false, failed: [] });
    await done(k);
  });
});
