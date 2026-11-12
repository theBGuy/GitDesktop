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
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteIssueView } from "@/features/issues/RemoteIssueView";
import { attachmentDiscard, attachmentStage } from "@/lib/attachments/api";
import { draftEntry, draftKeyFor } from "@/lib/attachments/store";
import {
  forgeIssueComment,
  forgeIssueEdit,
  forgeIssueView,
  forgeStatus,
} from "@/lib/git/api";
import type { ForgeStatus, IssueDetails } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
// The forge probe never answers: GitHub keeps its write controls and the
// attachment gate stays open (a pending read never closes it).
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(() => new Promise(() => undefined)),
  forgeIssueView: vi.fn(),
  forgeIssueComment: vi.fn(),
  forgeIssueEdit: vi.fn(),
}));
// The close is observed at its hook: the state write itself is named only by
// the hook that re-files its row (scripts/remote-row-state-wiring.test.mjs).
const closeIssue = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/git/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/queries")>()),
  useCloseIssue: () => ({ mutateAsync: closeIssue }),
}));
vi.mock("@/lib/attachments/api", () => ({
  attachmentStage: vi.fn(),
  attachmentDiscard: vi.fn(async () => undefined),
}));
vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sonner")>()),
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}));

const REPO = "C:/repo";
const TITLES: Record<number, string> = {
  7: "Issue seven",
  8: "Issue eight",
  9: "Issue nine",
};

function issue(number: number): IssueDetails {
  return {
    id: `I_${number}`,
    number,
    title: TITLES[number] ?? `Issue ${number}`,
    body: "",
    author: "someone",
    authorAvatarUrl: "",
    state: "OPEN",
    createdAt: "2026-01-01T00:00:00Z",
    url: `https://github.com/owner/repo/issues/${number}`,
    assignees: [],
    milestone: null,
    issueType: null,
    isPinned: false,
    locked: false,
    lockUnknown: false,
    activeLockReason: null,
    confidential: false,
    dueDate: null,
    // Issue nine carries one hosted comment, which stays quotable.
    comments:
      number === 9
        ? [
            {
              author: "someone",
              authorAvatarUrl: "",
              state: "",
              body: "hosted words",
              date: "2026-01-01T00:00:00Z",
              id: "C_1",
              url: "",
              viewerDidAuthor: false,
              isMinimized: false,
              minimizedReason: "",
              reviewId: "",
            },
          ]
        : [],
    labels: [],
  };
}

// The store is module state: each test stages into its own session.
let SESSION = "";
let sessionSeq = 0x100;

function staged(session: string | null, n: number) {
  return {
    session: session ?? SESSION,
    name: `image-${n}.png`,
    mime: "image/png",
    size: 2,
    width: 1,
    height: 1,
  };
}

beforeEach(() => {
  sessionSeq += 1;
  SESSION = sessionSeq.toString(16).padStart(32, "0");
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(forgeIssueView).mockImplementation(async (_repo, number) =>
    issue(number),
  );
  vi.mocked(forgeIssueComment).mockReset();
  closeIssue.mockClear();
  let n = 0;
  vi.mocked(attachmentStage).mockReset();
  vi.mocked(attachmentStage).mockImplementation(async (session) => {
    n += 1;
    return staged(session, n);
  });
  vi.mocked(attachmentDiscard).mockClear();
  vi.mocked(toast.error).mockClear();
  useConfirm.setState({ request: null, requestHold: null });
  // Write continuations refuse when the live repo moved.
  useUiStore.setState({ repoPath: REPO });
  let urls = 0;
  URL.createObjectURL = vi.fn(() => {
    urls += 1;
    return `blob:issue-${urls}`;
  });
  URL.revokeObjectURL = vi.fn();
});

afterEach(cleanup);

const png = () =>
  new File([new Uint8Array([1, 2])], "shot.png", { type: "image/png" });

function paste(target: Element, count: number) {
  const files = Array.from({ length: count }, png);
  fireEvent.paste(target, {
    clipboardData: { files, types: ["Files"], getData: () => "" },
  });
}

function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mount(number = 7) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = (n: number) => (
    <QueryClientProvider client={client}>
      <RemoteIssueView repoPath={REPO} number={n} />
    </QueryClientProvider>
  );
  const view = render(ui(number));
  return { client, show: (n: number) => view.rerender(ui(n)) };
}

const box = () =>
  screen.getByRole("textbox", {
    name: "Leave a comment",
  }) as HTMLTextAreaElement;

async function shown(number: number) {
  await screen.findByText(TITLES[number], undefined, { timeout: 3000 });
  await waitFor(() => expect(box()).toBeInTheDocument());
}

/** Stages `count` pasted images and waits for their references. */
async function stageImages(count: number) {
  paste(box(), count);
  await waitFor(() => expect(box().value).toContain(`](image-${count}.png)`));
}

const ATTACHING = "Wait for the image to finish attaching.";

/** Whether the editor's polite status region carries the held-submit note. */
const statusSaysAttaching = () =>
  screen.getAllByRole("status").some((s) => s.textContent === ATTACHING);

const key = (number: number) =>
  draftKeyFor("issue-comment", `${REPO}#origin#${number}`);

const editKey = (number: number) =>
  draftKeyFor("issue-edit", `${REPO}#origin#${number}`);
const editBox = () =>
  screen.getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement;

/** Opens the shown issue's Edit dialog. */
async function openEdit() {
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  await waitFor(() => expect(editBox()).toBeInTheDocument());
}

describe("RemoteIssueView edit attachments", () => {
  it("sends the edit's refs as the sixth argument and closes a clean save (AC12)", async () => {
    mount(7);
    await shown(7);
    await openEdit();
    paste(editBox(), 1);
    await waitFor(() => expect(editBox().value).toContain("](image-1.png)"));
    vi.mocked(forgeIssueEdit).mockResolvedValue({
      failedAttachments: [],
      body: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(forgeIssueEdit).toHaveBeenCalledTimes(1));
    expect(vi.mocked(forgeIssueEdit).mock.calls[0][5]).toEqual({
      session: SESSION,
      names: ["image-1.png"],
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toast.success).toHaveBeenCalledWith("Issue updated");
    expect(draftEntry(editKey(7))).toBeUndefined();
  });

  it("ends issue 7's edit images on a switch and never shows them on issue 8 (AC18)", async () => {
    const { show } = mount(7);
    await shown(7);
    await openEdit();
    paste(editBox(), 1);
    await waitFor(() => expect(editBox().value).toContain("](image-1.png)"));
    vi.mocked(attachmentDiscard).mockClear();
    show(8);
    await shown(8);
    await waitFor(() =>
      expect(attachmentDiscard).toHaveBeenCalledWith(SESSION, null),
    );
    expect(draftEntry(editKey(7))).toBeUndefined();
    await openEdit();
    expect(
      screen.queryAllByRole("button", { name: /^Remove image-/ }),
    ).toHaveLength(0);
    vi.mocked(forgeIssueEdit).mockReset();
    vi.mocked(forgeIssueEdit).mockResolvedValue({});
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(forgeIssueEdit).toHaveBeenCalledTimes(1));
    expect(vi.mocked(forgeIssueEdit).mock.calls[0][1]).toBe(8);
    expect(vi.mocked(forgeIssueEdit).mock.calls[0][5]).toBeUndefined();
  });

  it("re-reads the issue after a rejected edit (AC20)", async () => {
    mount(7);
    await shown(7);
    await openEdit();
    const reads = vi.mocked(forgeIssueView).mock.calls.length;
    vi.mocked(forgeIssueEdit).mockRejectedValue(new Error("edit refused"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await waitFor(() =>
      expect(vi.mocked(forgeIssueView).mock.calls.length).toBeGreaterThan(
        reads,
      ),
    );
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });
});

describe("RemoteIssueView comment attachments", () => {
  it("sends refs in first-occurrence order and lands a partial outcome on the issue it posted to", async () => {
    const { show } = mount(7);
    await shown(7);
    await stageImages(3);
    vi.mocked(attachmentDiscard).mockClear();
    // image-3's chip was removed: its reference is gone, its file still staged.
    const body = "B ![b](image-2.png) A ![a](image-1.png)";
    fireEvent.change(box(), { target: { value: body } });
    const post = deferred<{ failedAttachments: string[] }>();
    vi.mocked(forgeIssueComment).mockReturnValue(post.promise);
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(forgeIssueComment).toHaveBeenCalledTimes(1));
    expect(forgeIssueComment).toHaveBeenCalledWith(REPO, 7, body, "origin", {
      session: SESSION,
      names: ["image-2.png", "image-1.png"],
    });

    show(8);
    await shown(8);
    await act(async () => post.resolve({ failedAttachments: ["image-1.png"] }));
    await waitFor(() => expect(attachmentDiscard).toHaveBeenCalledTimes(1));
    expect(attachmentDiscard).toHaveBeenCalledWith(SESSION, [
      "image-2.png",
      "image-3.png",
    ]);
    // Nothing lands under the issue on screen.
    expect(box().value).toBe("");
    expect(screen.queryByText(/didn't upload/)).toBeNull();
    expect(draftEntry(key(8))).toBeUndefined();

    show(7);
    await shown(7);
    await waitFor(() => expect(box().value).toBe("![a](image-1.png)"));
    expect(
      screen.getAllByText(
        "Comment posted, but image-1.png didn't upload. It's still attached here, so you can post it in a follow-up comment.",
      ).length,
    ).toBeGreaterThan(0);
    expect(draftEntry(key(7))?.images.map((i) => i.name)).toEqual([
      "image-1.png",
    ]);
  });
});

describe("RemoteIssueView comment attachments", () => {
  it("restores the text and chips on a rejected post", async () => {
    mount(7);
    await shown(7);
    await stageImages(1);
    vi.mocked(attachmentDiscard).mockClear();
    const body = box().value;
    vi.mocked(forgeIssueComment).mockRejectedValue(new Error("network down"));
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(box().value).toBe(body));
    expect(
      screen.getByRole("button", { name: "Remove image-1.png" }),
    ).toBeInTheDocument();
    expect(draftEntry(key(7))?.posting).toEqual([]);
    expect(attachmentDiscard).not.toHaveBeenCalled();
  });

  it("keeps text, chips and session on a stale-session refusal, toasting Rust's sentence", async () => {
    mount(7);
    await shown(7);
    await stageImages(1);
    vi.mocked(attachmentDiscard).mockClear();
    const body = box().value;
    const sentence = "image-1.png is no longer attached. Attach it again.";
    vi.mocked(forgeIssueComment).mockRejectedValue({
      kind: "invalidArgument",
      message: `invalid argument: ${sentence}`,
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await waitFor(() => expect(box().value).toBe(body));
    expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).toContain(
      sentence,
    );
    expect(
      screen.getByRole("button", { name: "Remove image-1.png" }),
    ).toBeInTheDocument();
    expect(draftEntry(key(7))?.session).toBe(SESSION);
    expect(attachmentDiscard).not.toHaveBeenCalled();
  });

  it("sends the riding comment's refs and still closes after a partial outcome", async () => {
    mount(7);
    await shown(7);
    await stageImages(2);
    vi.mocked(attachmentDiscard).mockClear();
    const body = box().value;
    vi.mocked(forgeIssueComment).mockResolvedValue({
      failedAttachments: ["image-2.png"],
    });
    fireEvent.click(screen.getByRole("button", { name: /Close with comment/ }));
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
    act(() => useConfirm.getState().answer(true));
    await waitFor(() => expect(closeIssue).toHaveBeenCalledTimes(1));
    expect(forgeIssueComment).toHaveBeenCalledWith(REPO, 7, body, "origin", {
      session: SESSION,
      names: ["image-1.png", "image-2.png"],
    });
    expect(box().value).toBe("![image](image-2.png)");
    expect(attachmentDiscard).toHaveBeenCalledWith(SESSION, ["image-1.png"]);
  });
});

describe("a stage in flight holds the post of its draft", () => {
  it("holds Comment with its reason, posts nothing, and frees it once the stage lands", async () => {
    mount(7);
    await shown(7);
    const stage = deferred<ReturnType<typeof staged>>();
    vi.mocked(attachmentStage).mockReturnValueOnce(stage.promise);
    paste(box(), 1);
    await waitFor(() => expect(attachmentStage).toHaveBeenCalledTimes(1));
    fireEvent.change(box(), { target: { value: "No image yet" } });
    const comment = screen.getByRole("button", { name: "Comment" });
    await waitFor(() =>
      expect(comment).toHaveAccessibleDescription(
        "Wait for the image to finish attaching.",
      ),
    );
    fireEvent.click(comment);
    expect(statusSaysAttaching()).toBe(false);
    act(() => box().focus());
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(statusSaysAttaching()).toBe(true));
    expect(forgeIssueComment).not.toHaveBeenCalled();
    await act(async () => stage.resolve(staged(null, 1)));
    expect(
      await screen.findByRole("button", { name: "Remove image-1.png" }),
    ).toBeInTheDocument();
    expect(box().value).toContain("](image-1.png)");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Comment" }),
      ).not.toHaveAttribute("aria-disabled", "true"),
    );
  });

  it("frees Comment when the stage is refused", async () => {
    mount(7);
    await shown(7);
    const stage = deferred<ReturnType<typeof staged>>();
    vi.mocked(attachmentStage).mockReturnValueOnce(stage.promise);
    paste(box(), 1);
    await waitFor(() => expect(attachmentStage).toHaveBeenCalledTimes(1));
    fireEvent.change(box(), { target: { value: "Text" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Comment" })).toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    );
    await act(async () => stage.reject(new Error("refused")));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Comment" }),
      ).not.toHaveAttribute("aria-disabled", "true"),
    );
    expect(forgeIssueComment).not.toHaveBeenCalled();
  });
});

describe("a just-posted row offers no Quote reply", () => {
  it("withholds Quote on the row carrying a post token, keeps it on a hosted row", async () => {
    // The feed draws once the forge probe answers; it answers after the images
    // are staged and the post is in flight, so the attachment gate stays open.
    const status = deferred<ForgeStatus>();
    vi.mocked(forgeStatus).mockReturnValue(status.promise);
    mount(9);
    await shown(9);
    await stageImages(1);
    const post = deferred<{ failedAttachments: string[] }>();
    vi.mocked(forgeIssueComment).mockReturnValue(post.promise);
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(forgeIssueComment).toHaveBeenCalledTimes(1));
    await act(async () =>
      status.resolve({
        provider: "github",
        installed: true,
        authenticated: true,
        repo: "owner/repo",
        host: "github.com",
        login: "me",
        capabilities: {},
        implemented: {},
      } as unknown as ForgeStatus),
    );
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "Comment actions" }),
      ).toHaveLength(2),
    );
    const [hosted, optimistic] = screen.getAllByRole("button", {
      name: "Comment actions",
    });
    fireEvent.click(optimistic);
    expect(
      await screen.findByRole("menuitem", { name: "Copy markdown" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Quote reply" })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("menuitem", { name: "Copy markdown" }),
      ).toBeNull(),
    );
    fireEvent.click(hosted);
    expect(
      await screen.findByRole("menuitem", { name: "Quote reply" }),
    ).toBeInTheDocument();
    await act(async () => post.resolve({ failedAttachments: [] }));
    vi.mocked(forgeStatus).mockImplementation(
      () => new Promise(() => undefined),
    );
  });
});
