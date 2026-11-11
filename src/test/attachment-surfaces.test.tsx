import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentComposer as Composer } from "@/features/conversations/CommentComposer";
import { useRepoDrop } from "@/features/welcome/useRepoDrop";
import {
  partialCommentNotice,
  partialCreateWarning,
  withFailedReferences,
} from "@/lib/attachments/comment-post";
import type { DraftAttachmentsHandle } from "@/lib/attachments/use-draft-attachments";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";

const drop = vi.hoisted(() => ({
  handler: null as null | ((e: unknown) => Promise<void>),
  claim: vi.fn(() => () => true),
  watermark: vi.fn((): (() => boolean) => () => true),
  validate: vi.fn(async (path: string) => ({ path })),
  open: vi.fn(async () => undefined),
  toast: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: (fn: (e: unknown) => Promise<void>) => {
      drop.handler = fn;
      return Promise.resolve(() => undefined);
    },
  }),
}));
vi.mock("@/features/repository/useOpenRepoByPath", () => ({
  claimRepoOpen: drop.claim,
  repoOpenWatermark: drop.watermark,
  useOpenRecordedRepo: () => drop.open,
}));
vi.mock("@/lib/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/toast")>()),
  toastError: drop.toastError,
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  validateRepo: drop.validate,
}));
vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  return {
    ...actual,
    toast: Object.assign(drop.toast, { error: vi.fn(), success: vi.fn() }),
  };
});

// The collapse preference is a persisted setting: each case seeds it.
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
});

afterEach(cleanup);

function handle(over: Partial<DraftAttachmentsHandle> = {}) {
  const h: DraftAttachmentsHandle = {
    draftKey: "issue-comment|C:/repo#origin#7",
    owner: {},
    images: [],
    gateReason: null,
    holdReason: null,
    status: null,
    notice: null,
    posting: 0,
    stage: vi.fn(async () => null),
    startAttach: vi.fn(() => () => true),
    appendReference: vi.fn(),
    noteBlocked: vi.fn(),
    noteEdited: vi.fn(),
    heldNoteStale: false,
    retireHeldNote: vi.fn(),
    attaching: false,
    noteSubmitHeld: vi.fn(),
    withHold: (reason) => ({ ...h, holdReason: reason ?? h.holdReason }),
    ...over,
  };
  return h;
}

function wrap(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

function mount(
  props: Partial<Parameters<typeof Composer>[0]> & {
    attachments?: DraftAttachmentsHandle;
  },
) {
  return render(
    wrap(
      <Composer
        value=""
        onChange={() => undefined}
        onSubmit={() => undefined}
        submitLabel="Comment"
        ariaLabel="Leave a comment"
        placeholder="Leave a comment…"
        {...props}
      />,
    ),
  );
}

describe("CommentComposer attachments", () => {
  it("forwards attachments to the expanded editor, and adds nothing without them", () => {
    const { unmount } = mount({ attachments: handle() });
    expect(screen.getByRole("button", { name: "Attach image" })).toBeTruthy();
    unmount();
    mount({});
    expect(screen.queryByRole("button", { name: "Attach image" })).toBeNull();
    expect(document.querySelector("[aria-live]")).toBeNull();
  });

  it("offers no attach route while collapsed", async () => {
    vi.mocked(loadSettings).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      commentComposerCollapsed: true,
    });
    mount({ attachments: handle() });
    // Expanded until the preference loads; collapsed, the hidden editor keeps
    // no Attach button and no file input in the DOM at all.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Attach image", hidden: true }),
      ).toBeNull(),
    );
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(screen.getByRole("textbox", { hidden: true })).toBeInTheDocument();
  });

  it("renders the partial-failure strip for one and several images, and nothing without a notice", () => {
    const { rerender } = mount({ attachments: handle() });
    expect(screen.queryByText(/didn't upload/)).toBeNull();
    const one = partialCommentNotice(["image-2.png"]);
    expect(one).toBe(
      "Comment posted, but image-2.png didn't upload. It's still attached here, so you can post it in a follow-up comment.",
    );
    rerender(
      wrap(
        <Composer
          value=""
          onChange={() => undefined}
          onSubmit={() => undefined}
          submitLabel="Comment"
          ariaLabel="Leave a comment"
          placeholder="Leave a comment…"
          attachments={handle({ notice: { failed: ["image-2.png"] } })}
        />,
      ),
    );
    // Visible strip plus the always-mounted polite region carry the sentence.
    expect(screen.getAllByText(one)).toHaveLength(2);
    const live = screen
      .getAllByText(one)
      .find((el) => el.getAttribute("aria-live") === "polite");
    expect(live).toBeTruthy();
    expect(partialCommentNotice(["a.png", "b.png", "c.png"])).toBe(
      "Comment posted, but 3 images didn't upload. They're still attached here, so you can post them in a follow-up comment.",
    );
  });

  it("shows the read-only rider, adding the draft sentence only with a draft and Clear", () => {
    const reason = "This conversation is locked.";
    const { rerender } = mount({ readOnlyReason: reason });
    expect(screen.queryByText(/Your draft is kept/)).toBeNull();
    rerender(
      wrap(
        <Composer
          value="draft text"
          onChange={() => undefined}
          onSubmit={() => undefined}
          onClear={() => undefined}
          submitLabel="Comment"
          ariaLabel="Leave a comment"
          placeholder="Leave a comment…"
          readOnlyReason={reason}
        />,
      ),
    );
    expect(screen.getByText(/Your draft is kept; Clear discards it\./)).toBe(
      screen.getByText(/Your draft is kept/),
    );
    // The rider is plain text: never a second live region for the reason.
    const rider = screen.getByText(/Your draft is kept/).closest("p");
    expect(rider?.getAttribute("aria-live")).toBeNull();
    expect(rider?.getAttribute("role")).toBeNull();
  });

  it("lays the composer's hold over the handle", () => {
    mount({
      attachments: handle(),
      busy: true,
      reason: "Uploading 1 image and posting…",
      value: "x",
    });
    expect(
      screen.getByRole("button", { name: "Attach image" }),
    ).toHaveAccessibleDescription("Uploading 1 image and posting…");
  });
});

describe("post copy helpers", () => {
  it("builds the Create PR warning and the failed-references merge", () => {
    expect(partialCreateWarning(["image-1.png"])).toBe(
      "Pull request created, but image-1.png didn't upload. Add it in a comment on the pull request.",
    );
    expect(partialCreateWarning(["a.png", "b.png"])).toBe(
      "Pull request created, but 2 images didn't upload. Add them in a comment on the pull request.",
    );
    expect(withFailedReferences("", "![image](image-2.png)")).toBe(
      "![image](image-2.png)",
    );
    expect(withFailedReferences("typed\n", "![image](image-2.png)")).toBe(
      "typed\n\n![image](image-2.png)",
    );
  });
});

describe("useRepoDrop image hint", () => {
  function Host() {
    useRepoDrop();
    return null;
  }
  const NOT_A_REPO = {
    kind: "notARepo",
    message: "Not a Git repository",
  };
  beforeEach(() => {
    drop.claim.mockClear();
    drop.watermark.mockClear();
    drop.validate.mockReset();
    drop.validate.mockImplementation(async (path: string) => ({ path }));
    drop.open.mockClear();
    drop.toast.mockClear();
    drop.toastError.mockClear();
  });

  async function dropPath(path: string) {
    render(wrap(<Host />));
    await drop.handler?.({ payload: { type: "drop", paths: [path] } });
  }

  it.each(["C:/shots/photo.png", "C:/shots/PHOTO.PNG", "/x/a.webp"])(
    "hints for the image file %s, never claiming or naming the error",
    async (path) => {
      drop.validate.mockRejectedValueOnce(NOT_A_REPO);
      await dropPath(path);
      expect(drop.toast).toHaveBeenCalledWith(
        "To add an image to a comment, paste it or use Attach image.",
      );
      expect(drop.toastError).not.toHaveBeenCalled();
      expect(drop.claim).not.toHaveBeenCalled();
      expect(drop.open).not.toHaveBeenCalled();
    },
  );

  it("names any other refusal of an image-named path, with no hint", async () => {
    const missing = { kind: "gitNotFound", message: "git was not found" };
    drop.validate.mockRejectedValueOnce(missing);
    await dropPath("C:/repos/diagram.png");
    expect(drop.toastError).toHaveBeenCalledWith(missing);
    expect(drop.toast).not.toHaveBeenCalled();
    expect(drop.claim).not.toHaveBeenCalled();
  });

  it("opens a repository whose folder name ends in an image extension", async () => {
    await dropPath("C:/repos/diagram.png");
    expect(drop.validate).toHaveBeenCalledWith("C:/repos/diagram.png");
    expect(drop.claim).toHaveBeenCalledTimes(1);
    expect(drop.open).toHaveBeenCalledWith(
      { path: "C:/repos/diagram.png" },
      expect.any(Function),
    );
    expect(drop.toast).not.toHaveBeenCalled();
  });

  it("yields to an open that arrived while it asked", async () => {
    drop.watermark.mockReturnValueOnce(() => false);
    await dropPath("C:/repos/diagram.png");
    expect(drop.claim).not.toHaveBeenCalled();
    expect(drop.open).not.toHaveBeenCalled();
  });

  it("names the error for a plain folder that is no repository", async () => {
    drop.validate.mockRejectedValueOnce(NOT_A_REPO);
    await dropPath("C:/x/project");
    expect(drop.claim).toHaveBeenCalledTimes(1);
    expect(drop.toastError).toHaveBeenCalledWith(NOT_A_REPO);
    expect(drop.toast).not.toHaveBeenCalled();
  });

  it.each(["C:/repos/project", "C:/x/photo.png.txt", "C:/x/logo.svg"])(
    "keeps today's path for %s",
    async (path) => {
      await dropPath(path);
      expect(drop.toast).not.toHaveBeenCalled();
      expect(drop.claim).toHaveBeenCalledTimes(1);
      expect(drop.validate).toHaveBeenCalledWith(path);
      expect(drop.open).toHaveBeenCalledTimes(1);
    },
  );
});
