import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Thread } from "@/features/conversations/Thread";
import { attachmentDiscard, attachmentStage } from "@/lib/attachments/api";
import {
  landCommentPost,
  REQUEST_CHANGES_IMAGES_REASON,
  referencesStaged,
} from "@/lib/attachments/comment-post";
import {
  beginAttachmentPost,
  draftEntry,
  draftKeyFor,
  hasHeldCopies,
  stageAttachment,
  stagedImageUrl,
  sweepOtherOwners,
} from "@/lib/attachments/store";
import { forgeIssueComment, forgeIssueView } from "@/lib/git/api";
import { useCommentIssue, useIssueDetails } from "@/lib/git/queries";
import type { IssueDetails } from "@/lib/git/types";
import { hostedImageKey } from "@/lib/hosted-images/queries";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  // The thread rows' host lookup; it never answers here.
  forgeStatus: vi.fn(() => new Promise(() => undefined)),
  forgeIssueView: vi.fn(),
  forgeIssueComment: vi.fn(),
}));
vi.mock("@/lib/attachments/api", () => ({
  attachmentStage: vi.fn(),
  attachmentDiscard: vi.fn(async () => undefined),
}));

const REPO = "C:/reconcile";
const KEY = draftKeyFor("issue-comment", `${REPO}#origin#7`);

function issue(bodies: string[]): IssueDetails {
  return {
    id: "I_7",
    number: 7,
    title: "Seven",
    body: "",
    author: "someone",
    authorAvatarUrl: "",
    state: "OPEN",
    createdAt: "2026-01-01T00:00:00Z",
    url: "https://github.com/owner/repo/issues/7",
    assignees: [],
    milestone: null,
    issueType: null,
    isPinned: false,
    locked: false,
    lockUnknown: false,
    activeLockReason: null,
    confidential: false,
    dueDate: null,
    comments: bodies.map((body, i) => ({
      author: "me",
      authorAvatarUrl: "",
      state: "",
      body,
      date: "2026-01-01T00:00:00Z",
      id: `C_${i}`,
      url: "",
      viewerDidAuthor: true,
      isMinimized: false,
      minimizedReason: "",
      reviewId: "",
    })),
    labels: [],
  } as IssueDetails;
}

interface Deferred {
  resolve: (v: IssueDetails) => void;
  reject: (e: unknown) => void;
}

// Every detail read waits here until the test answers it.
let reads: Deferred[] = [];
let SESSION = "";
let sessionSeq = 0x200;
const nextSession = () => {
  sessionSeq += 1;
  SESSION = sessionSeq.toString(16).padStart(32, "0");
  return SESSION;
};

beforeEach(() => {
  nextSession();
  reads = [];
  vi.mocked(forgeIssueView).mockImplementation(
    () =>
      new Promise<IssueDetails>((resolve, reject) => {
        reads.push({ resolve, reject });
      }),
  );
  let n = 0;
  vi.mocked(attachmentStage).mockReset();
  vi.mocked(attachmentStage).mockImplementation(async (session) => {
    n += 1;
    return {
      session: session ?? SESSION,
      name: `image-${n}.png`,
      mime: "image/png",
      size: 2,
      width: 1,
      height: 1,
    };
  });
  vi.mocked(attachmentDiscard).mockClear();
  let urls = 0;
  URL.createObjectURL = vi.fn(() => {
    urls += 1;
    return `blob:held-${urls}`;
  });
  URL.revokeObjectURL = vi.fn();
  // Every case starts from a thread no earlier case's owner holds.
  sweepOtherOwners("issue-comment", {});
});

afterAll(() => expect(unmockedCommands).toEqual([]));

async function setup(initial: string[] = []) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () => ({
      details: useIssueDetails(REPO, 7, "origin"),
      comment: useCommentIssue(REPO, "origin"),
    }),
    { wrapper },
  );
  await waitFor(() => expect(reads).toHaveLength(1));
  await act(async () => reads[0].resolve(issue(initial)));
  await waitFor(() => expect(hook.result.current.details.data).toBeDefined());
  const owner = {};
  OWNER = owner;
  const stage = () =>
    stageAttachment({
      draftKey: KEY,
      owner,
      file: new File([new Uint8Array([1, 2])], "x.png"),
      source: "paste",
      blockedReason: null,
    });
  /** A post through the real mutation and the view's settle helper. */
  const post = async (body: string, failed: string[] = []) => {
    vi.mocked(forgeIssueComment).mockResolvedValueOnce({
      failedAttachments: failed,
    });
    const ticket = beginAttachmentPost(KEY, body, true);
    let outcome: unknown;
    await act(async () => {
      outcome = await hook.result.current.comment.mutateAsync({
        number: 7,
        body,
        author: "me",
        attachments: ticket?.refs,
        postToken: ticket?.token,
      });
    });
    landCommentPost(KEY, ticket, body, outcome);
    if (!ticket) throw new Error("no ticket");
    return ticket.token;
  };
  return { client, hook, stage, post };
}

const posted = (token: string, name: string) =>
  stagedImageUrl({ postToken: token }, name);
let OWNER: object = {};
const drafted = (name: string) =>
  stagedImageUrl({ draftKey: KEY, owner: OWNER }, name);
const detailKey = ["repo", REPO, "issue", "origin", 7];
const urlOf = (name: string) =>
  draftEntry(KEY)?.images.find((i) => i.name === name)?.url ?? "";

describe("held copies through the comment reconcile", () => {
  it("keeps both posts' images until the thread settles without them", async () => {
    const { client, stage, post } = await setup();
    await stage();
    const url1 = urlOf("image-1.png");
    const t1 = await post("![one](image-1.png)");
    expect(draftEntry(KEY)).toBeUndefined();
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(url1);
    expect(posted(t1, "image-1.png")).toBe(url1);
    // The optimistic row carries the body exactly as posted, plus its token.
    const row = client.getQueryData<IssueDetails>(detailKey)?.comments.at(-1);
    expect(row?.body).toBe("![one](image-1.png)");
    expect(row?.postToken).toBe(t1);
    // The reconciling read is in flight; a second post cancels it, which
    // settles the cached data with the first synthetic row still there.
    await waitFor(() => expect(reads).toHaveLength(2));
    nextSession();
    await stage();
    const url2 = urlOf("image-2.png");
    const t2 = await post("![two](image-2.png)");
    expect(hasHeldCopies(t1)).toBe(true);
    expect(hasHeldCopies(t2)).toBe(true);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(url1);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(url2);
    await waitFor(() => expect(reads).toHaveLength(3));
    await act(async () =>
      reads[2].resolve(issue(["hosted one", "hosted two"])),
    );
    await waitFor(() => expect(hasHeldCopies(t1)).toBe(false));
    expect(hasHeldCopies(t2)).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(url1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(url2);
    expect(posted(t1, "image-1.png")).toBeNull();
  });

  it("frees nothing on a failed refetch, and the owner sweep frees it", async () => {
    const { stage, post } = await setup();
    await stage();
    const url1 = urlOf("image-1.png");
    const t1 = await post("![one](image-1.png)");
    await waitFor(() => expect(reads).toHaveLength(2));
    await act(async () => reads[1].reject(new Error("offline")));
    expect(hasHeldCopies(t1)).toBe(true);
    expect(posted(t1, "image-1.png")).toBe(url1);
    sweepOtherOwners("issue-comment", {});
    expect(hasHeldCopies(t1)).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(url1);
  });
});

describe("a partial post and its follow-up keep their own images", () => {
  /** The image src each cached comment renders, in thread order. */
  async function renderedSrcs(client: QueryClient): Promise<string[][]> {
    const data = client.getQueryData<IssueDetails>(detailKey);
    const srcs: string[][] = [];
    for (const comment of data?.comments ?? []) {
      const { container, unmount } = render(
        <QueryClientProvider client={client}>
          <Thread thread={comment} />
        </QueryClientProvider>,
      );
      srcs.push(
        Array.from(container.querySelectorAll("img")).map(
          (img) => img.getAttribute("src") ?? "",
        ),
      );
      unmount();
    }
    return srcs;
  }

  it("a re-issued name never shows under the earlier comment", async () => {
    const { client, stage, post } = await setup();
    await stage();
    await stage();
    const url1 = urlOf("image-1.png");
    const url2 = urlOf("image-2.png");
    const t1 = await post("![a](image-1.png) ![b](image-2.png)", [
      "image-2.png",
    ]);
    expect(draftEntry(KEY)?.images.map((i) => i.name)).toEqual(["image-2.png"]);
    expect(posted(t1, "image-1.png")).toBe(url1);
    expect(drafted("image-2.png")).toBe(url2);
    // Rust freed image-1.png on Ok, so the next paste into the session is
    // named image-1.png again.
    vi.mocked(attachmentStage).mockResolvedValueOnce({
      session: SESSION,
      name: "image-1.png",
      mime: "image/png",
      size: 2,
      width: 1,
      height: 1,
    });
    await stage();
    const url3 = urlOf("image-1.png");
    expect(url3).not.toBe(url1);
    expect(drafted("image-1.png")).toBe(url3);
    expect(posted(t1, "image-1.png")).toBe(url1);
    expect(await renderedSrcs(client)).toEqual([[url1]]);
    await waitFor(() => expect(reads).toHaveLength(2));
    const t2 = await post("![b](image-2.png) ![c](image-1.png)");
    expect(draftEntry(KEY)).toBeUndefined();
    expect(await renderedSrcs(client)).toEqual([[url1], [url2, url3]]);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(url1);
    await waitFor(() => expect(reads).toHaveLength(3));
    await act(async () => reads[2].resolve(issue(["a", "b"])));
    await waitFor(() => expect(hasHeldCopies(t1)).toBe(false));
    expect(hasHeldCopies(t2)).toBe(false);
    for (const url of [url1, url2, url3])
      expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
  });
});

describe("Request changes' hold rule (helper level)", () => {
  it("holds only a draft that references a staged image", () => {
    const images = [{ name: "image-1.png" }];
    expect(referencesStaged("see ![x](image-1.png)", images)).toBe(true);
    expect(referencesStaged("no images here", images)).toBe(false);
    expect(referencesStaged("typed ![x](image-9.png)", images)).toBe(false);
    expect(referencesStaged("see ![x](image-1.png)", [])).toBe(false);
    expect(REQUEST_CHANGES_IMAGES_REASON).toBe(
      "Post your draft as a comment first. Request changes can't carry images.",
    );
  });
});

describe("a seed lands only on a row the post made", () => {
  const URL1 =
    "https://github.com/user-attachments/assets/c162f463-c831-4173-8a80-4197acc4a8ac";
  const URL2 =
    "https://github.com/user-attachments/assets/0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";
  const seeded = (client: QueryClient, url: string) =>
    client.getQueryData(hostedImageKey("github.com", url)) !== undefined;

  it("an older comment with the same template is never seeded", async () => {
    const { client, stage, post } = await setup([`![image](${URL1})`]);
    await stage();
    const token = await post("![image](image-1.png)");
    await waitFor(() => expect(reads).toHaveLength(2));
    // Let the posted file finish encoding before the landing decides.
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    // The landing holds only the older comment, not yet the new one.
    await act(async () => reads[1].resolve(issue([`![image](${URL1})`])));
    await waitFor(() => expect(hasHeldCopies(token)).toBe(false));
    expect(seeded(client, URL1)).toBe(false);
  });

  it("with the new comment beside it, only the new one is seeded", async () => {
    const { client, stage, post } = await setup([`![image](${URL1})`]);
    await stage();
    const token = await post("![image](image-1.png)");
    await waitFor(() => expect(reads).toHaveLength(2));
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    await act(async () =>
      reads[1].resolve(issue([`![image](${URL1})`, `![image](${URL2})`])),
    );
    await waitFor(() => expect(hasHeldCopies(token)).toBe(false));
    expect(seeded(client, URL2)).toBe(true);
    expect(seeded(client, URL1)).toBe(false);
  });
});
