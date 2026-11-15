import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinkedIssuesField } from "@/features/pulls/LinkedIssuesField";
import { RemotePrView } from "@/features/pulls/RemotePrView";
import { attachmentDiscard, attachmentStage } from "@/lib/attachments/api";
import {
  forgeIssueList,
  forgeIssueView,
  forgePrApprovals,
  forgePrComment,
  forgePrEdit,
  forgePrRequestChanges,
  forgePrView,
  forgeStatus,
  gitBranches,
} from "@/lib/git/api";
import type {
  Branch,
  ForgeStatus,
  IssueInfo,
  PrDetails,
} from "@/lib/git/types";
import { dispatchAction } from "@/lib/hotkeys/handler-registry";
import { getJiraLink } from "@/lib/jira/store";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(),
  forgeIssueList: vi.fn(),
  forgeIssueView: vi.fn(),
  forgePrView: vi.fn(),
  forgePrApprovals: vi.fn(),
  forgePrComment: vi.fn(),
  forgePrRequestChanges: vi.fn(async () => undefined),
  forgePrEdit: vi.fn(),
  gitBranches: vi.fn(),
}));
// The generator is observed at its hook; a test drives its draft callback.
const generateFromDiff = vi.hoisted(() => vi.fn());
vi.mock("@/features/pulls/useGeneratePrDescription", () => ({
  useGeneratePrDescription: () => ({
    generate: vi.fn(),
    generateFromDiff,
    cancel: vi.fn(),
    generating: false,
    pickingLabels: false,
  }),
}));
// The close is observed at its hook: the state write itself is named only by
// the hook that re-files its row (scripts/remote-row-state-wiring.test.mjs).
const closePr = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/git/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/queries")>()),
  useClosePr: () => ({ mutateAsync: closePr, isPending: false }),
}));
// The gate's CLI probe is not under test: attaching stays open.
vi.mock("@/lib/attachments/use-attachment-support", () => ({
  useAttachmentSupport: () => null,
}));
vi.mock("@/lib/attachments/api", () => ({
  attachmentStage: vi.fn(),
  attachmentDiscard: vi.fn(async () => undefined),
}));
// The repo's Jira link drives the Bitbucket mention cluster: unlinked unless a
// test links one.
vi.mock("@/lib/jira/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jira/store")>()),
  getJiraLink: vi.fn(),
}));

const REPO = "C:/repo";
const ATTACHING = "Wait for the image to finish attaching.";

// GitLab carries the forge-only Request changes control beside the comment
// box, Close and Reopen; GitHub's lives in the Review menu.
const GITLAB = {
  provider: "gitlab",
  installed: true,
  authenticated: true,
  repo: "owner/repo",
  host: "gitlab.com",
  login: "me",
  capabilities: {},
  implemented: {
    mrComment: true,
    mrState: true,
    mrApprove: true,
    mrRequestChanges: true,
  },
} as unknown as ForgeStatus;

function pr(): PrDetails {
  return {
    id: "PR_7",
    number: 7,
    title: "Merge request seven",
    body: "",
    author: "someone",
    authorAvatarUrl: "",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feat",
    additions: 0,
    deletions: 0,
    url: "https://gitlab.com/owner/repo/-/merge_requests/7",
    commits: [],
    files: [],
    reviews: [],
    comments: [],
    checks: [],
    checksUnknown: false,
    checksTruncated: false,
    commentsUnknown: false,
    commentsTruncated: false,
    commitsUnknown: false,
    commitsTruncated: false,
    headSha: null,
    filesUnknown: false,
    filesTruncated: false,
    reviewersUnknown: false,
    labels: [],
    assignees: [],
    reviewers: [],
    completedReviewers: [],
    mergeCommitAllowed: null,
    squashMergeAllowed: null,
    rebaseMergeAllowed: null,
    stackMembers: [],
    stackUnknown: false,
    membersUnknown: false,
  } as unknown as PrDetails;
}

let SESSION = "";
let sessionSeq = 0x200;

function staged(n: number) {
  return {
    session: SESSION,
    name: `image-${n}.png`,
    mime: "image/png",
    size: 2,
    width: 1,
    height: 1,
  };
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

beforeEach(() => {
  sessionSeq += 1;
  SESSION = sessionSeq.toString(16).padStart(32, "0");
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(forgeStatus).mockResolvedValue(GITLAB);
  vi.mocked(forgePrView).mockImplementation(async () => pr());
  vi.mocked(forgePrApprovals).mockResolvedValue({
    viewerHasApproved: false,
    approvedBy: [],
    approvalsRequired: 0,
    approvalsLeft: 0,
    viewerRequestedChanges: false,
  });
  vi.mocked(forgePrComment).mockReset();
  closePr.mockClear();
  vi.mocked(forgePrRequestChanges).mockClear();
  vi.mocked(attachmentStage).mockReset();
  vi.mocked(attachmentDiscard).mockClear();
  vi.mocked(forgePrEdit).mockReset();
  // The open-issues page the chips resolve against: unread unless a test lists one.
  vi.mocked(forgeIssueList).mockReset();
  vi.mocked(forgeIssueList).mockRejectedValue(new Error("not listed"));
  vi.mocked(forgeIssueView).mockReset();
  vi.mocked(forgeIssueView).mockRejectedValue(new Error("not read"));
  vi.mocked(getJiraLink).mockResolvedValue(null);
  vi.mocked(gitBranches).mockResolvedValue(
    ["main", "next", "old"].map(
      (name) =>
        ({
          name,
          isCurrent: false,
          archived: false,
          keepLocal: false,
        }) as Branch,
    ),
  );
  generateFromDiff.mockReset();
  useConfirm.setState({ request: null, requestHold: null });
  useUiStore.setState({ repoPath: REPO });
  URL.createObjectURL = vi.fn(() => "blob:pr-1");
  URL.revokeObjectURL = vi.fn();
});

afterEach(cleanup);

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <RemotePrView repoPath={REPO} number={7} />
    </QueryClientProvider>,
  );
  return client;
}

const box = () =>
  screen.getByRole("textbox", {
    name: "Leave a comment",
  }) as HTMLTextAreaElement;
const button = (name: string | RegExp) => screen.getByRole("button", { name });

const statusSaysAttaching = () =>
  screen.getAllByRole("status").some((s) => s.textContent === ATTACHING);

const editBox = () =>
  screen.getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement;
const reasonOf = (el: Element) =>
  (el.getAttribute("aria-describedby")?.split(" ") ?? [])
    .map((id) => document.getElementById(id)?.textContent)
    .join(" ");

/** Mounts PR 7 and opens its Edit dialog. */
async function openPrEdit(extra: Record<string, boolean> = {}) {
  const implemented = (GITLAB as unknown as { implemented: object })
    .implemented;
  vi.mocked(forgeStatus).mockResolvedValue({
    ...GITLAB,
    implemented: { ...implemented, mrEdit: true, ...extra },
  } as unknown as ForgeStatus);
  const client = mount();
  await screen.findByText("Merge request seven", undefined, { timeout: 3000 });
  fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
  await waitFor(() => expect(editBox()).toBeInTheDocument());
  return client;
}

describe("RemotePrView edit attachments", () => {
  it("holds Generate only while a save carrying images is pending (AC30)", async () => {
    vi.mocked(attachmentStage).mockImplementation(async () => staged(1));
    await openPrEdit();
    // Control: before any save Generate is live.
    expect(button("Generate")).not.toHaveAttribute("aria-disabled", "true");
    // A save with no image leaves it live (the recorded owner decision).
    const plain = deferred<{ failedAttachments: string[] }>();
    vi.mocked(forgePrEdit).mockReturnValueOnce(plain.promise);
    fireEvent.click(button("Save"));
    await waitFor(() => expect(forgePrEdit).toHaveBeenCalledTimes(1));
    expect(vi.mocked(forgePrEdit).mock.calls[0][6]).toBeUndefined();
    expect(button("Generate")).not.toHaveAttribute("aria-disabled", "true");
    await act(async () => plain.reject(new Error("refused")));
    await waitFor(() => expect(button("Save")).not.toBeDisabled());

    fireEvent.paste(editBox(), {
      clipboardData: {
        files: [
          new File([new Uint8Array([1])], "a.png", { type: "image/png" }),
        ],
        types: ["Files"],
        getData: () => "",
      },
    });
    await waitFor(() => expect(editBox().value).toContain("](image-1.png)"));
    const save = deferred<{ failedAttachments: string[] }>();
    vi.mocked(forgePrEdit).mockReturnValueOnce(save.promise);
    fireEvent.click(button("Save"));
    await waitFor(() => expect(forgePrEdit).toHaveBeenCalledTimes(2));
    expect(vi.mocked(forgePrEdit).mock.calls[1][6]).toEqual({
      session: SESSION,
      names: ["image-1.png"],
    });
    await waitFor(() =>
      expect(button("Generate")).toHaveAttribute("aria-disabled", "true"),
    );
    expect(reasonOf(button("Generate"))).toBe("Applying this change…");
    await act(async () => save.resolve({ failedAttachments: [] }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  const BODY_DROPPED =
    "The description wasn't saved because image-1.png didn't upload. Your other changes were saved. Save again to retry.";
  const PARTIAL_LINE =
    "Saved, but image-1.png didn't upload. It's still attached here. Save again to add it.";
  const titleBox = () => screen.getByRole("textbox", { name: "Title" });
  const baseArg = (call: number) => vi.mocked(forgePrEdit).mock.calls[call][5];
  const politeLine = () =>
    screen.getByRole("dialog").querySelector("form > span[aria-live='polite']")
      ?.textContent ?? null;

  async function pasteImage() {
    fireEvent.paste(editBox(), {
      clipboardData: {
        files: [
          new File([new Uint8Array([1])], "a.png", { type: "image/png" }),
        ],
        types: ["Files"],
        getData: () => "",
      },
    });
    await waitFor(() => expect(editBox().value).toContain("](image-1.png)"));
  }

  async function pickBase(
    user: ReturnType<typeof userEvent.setup>,
    name: string,
  ) {
    await user.click(screen.getByRole("combobox", { name: "Base branch" }));
    await user.click(
      await screen.findByRole("option", { name: new RegExp(`^${name}`) }),
    );
  }

  /** The generate binding, pressed with focus on the Title. */
  async function generateChord() {
    act(() => titleBox().focus());
    await userEvent.keyboard("{Control>}g{/Control}");
    await act(async () => undefined);
  }

  it("sends a base a partial save applied only after a new pick (AC21)", async () => {
    vi.mocked(attachmentStage).mockImplementation(async () => staged(1));
    const user = userEvent.setup();
    await openPrEdit();
    await pickBase(user, "next");
    await pasteImage();
    vi.mocked(forgePrEdit).mockResolvedValueOnce({
      failedAttachments: ["image-1.png"],
      body: "x ![image](image-1.png)",
    } as never);
    fireEvent.click(button("Save"));
    await waitFor(() => expect(forgePrEdit).toHaveBeenCalledTimes(1));
    expect(baseArg(0)).toBe("next");
    await waitFor(() => expect(politeLine()).toBe(PARTIAL_LINE));
    vi.mocked(forgePrEdit).mockRejectedValueOnce(new Error("refused"));
    fireEvent.click(button("Save"));
    await waitFor(() => expect(forgePrEdit).toHaveBeenCalledTimes(2));
    expect(baseArg(1)).toBeUndefined();
    await waitFor(() => expect(button("Save")).not.toBeDisabled());
    await pickBase(user, "old");
    vi.mocked(forgePrEdit).mockResolvedValueOnce({
      failedAttachments: [],
      body: null,
    } as never);
    fireEvent.click(button("Save"));
    await waitFor(() => expect(forgePrEdit).toHaveBeenCalledTimes(3));
    expect(baseArg(2)).toBe("old");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("sends no base after an Err that says the other changes were saved (AC21)", async () => {
    const user = userEvent.setup();
    await openPrEdit();
    await pickBase(user, "next");
    vi.mocked(forgePrEdit).mockRejectedValueOnce({
      kind: "gh",
      message: BODY_DROPPED,
    });
    fireEvent.click(button("Save"));
    await waitFor(() => expect(forgePrEdit).toHaveBeenCalledTimes(1));
    expect(baseArg(0)).toBe("next");
    await waitFor(() => expect(button("Save")).not.toBeDisabled());
    vi.mocked(forgePrEdit).mockResolvedValueOnce({
      failedAttachments: [],
      body: null,
    } as never);
    fireEvent.click(button("Save"));
    await waitFor(() => expect(forgePrEdit).toHaveBeenCalledTimes(2));
    expect(baseArg(1)).toBeUndefined();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("re-seeds a partial save's read-back as text beside the issue chips (AC14)", async () => {
    vi.mocked(forgePrView).mockImplementation(async () => ({
      ...pr(),
      body: "Words\n\nCloses #3",
    }));
    vi.mocked(attachmentStage).mockImplementation(async () => staged(1));
    await openPrEdit({ issues: true });
    await pasteImage();
    vi.mocked(forgePrEdit).mockResolvedValueOnce({
      failedAttachments: ["image-1.png"],
      body: "x ![](image-1.png)\n\nCloses #3",
    } as never);
    fireEvent.click(button("Save"));
    await waitFor(() => expect(editBox().value).toBe("x ![](image-1.png)"));
    expect(editBox().value).not.toContain("Closes #3");
    expect(
      within(screen.getByRole("dialog")).getAllByText(/#3\b/).length,
    ).toBeGreaterThan(0);
    // The Edit dialog composes the chips on Save, and says so.
    expect(
      within(screen.getByRole("dialog")).getByText(
        "Added to the description when you save.",
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("dialog")).queryByText(
        "Added to the description on create.",
      ),
    ).toBeNull();
    fireEvent.click(button("Cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  const sentBody = (call: number) =>
    vi.mocked(forgePrEdit).mock.calls[call][3] as string;
  const chipButton = (n: number) =>
    screen.queryByRole("button", { name: new RegExp(`issue ${n}:`) });

  it("keeps the chip edits made while a partial save ran, and sends them next", async () => {
    vi.mocked(forgePrView).mockImplementation(async () => ({
      ...pr(),
      body: "Words\n\nCloses #3\nCloses #4",
    }));
    vi.mocked(attachmentStage).mockImplementation(async () => staged(1));
    await openPrEdit({ issues: true });
    await pasteImage();
    const pending = deferred<unknown>();
    vi.mocked(forgePrEdit).mockReturnValueOnce(pending.promise as never);
    fireEvent.click(button("Save"));
    await waitFor(() => expect(forgePrEdit).toHaveBeenCalledTimes(1));
    expect(sentBody(0)).toMatch(/\n\nCloses #3\nCloses #4$/);
    fireEvent.click(button("Remove #3"));
    fireEvent.click(button(/^Closes issue 4:/));
    await waitFor(() => expect(button(/^Relates to issue 4:/)).toBeTruthy());
    await act(async () =>
      pending.resolve({
        failedAttachments: ["image-1.png"],
        body: sentBody(0),
      }),
    );
    await waitFor(() => expect(politeLine()).toBe(PARTIAL_LINE));
    expect(editBox().value).not.toMatch(/#[34]/);
    expect(chipButton(3)).toBeNull();
    expect(button(/^Relates to issue 4:/)).toBeTruthy();
    vi.mocked(forgePrEdit).mockResolvedValueOnce({
      failedAttachments: [],
      body: null,
    } as never);
    fireEvent.click(button("Save"));
    await waitFor(() => expect(forgePrEdit).toHaveBeenCalledTimes(2));
    expect(sentBody(1)).toMatch(/\n\nRelates to #4$/);
    expect(sentBody(1)).not.toContain("#3");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("brings back no extracted chip removed before a partial save", async () => {
    vi.mocked(forgePrView).mockImplementation(async () => ({
      ...pr(),
      headRefName: "fix/42-thing",
    }));
    vi.mocked(forgeIssueList).mockResolvedValue([
      {
        number: 42,
        url: "",
        title: "Fix the thing",
        state: "OPEN",
        createdAt: "",
        updatedAt: "",
        author: null,
        labels: [],
      } satisfies IssueInfo,
    ]);
    vi.mocked(attachmentStage).mockImplementation(async () => staged(1));
    await openPrEdit({ issues: true });
    await waitFor(() => expect(chipButton(42)).toBeTruthy());
    fireEvent.click(button("Remove #42"));
    await waitFor(() => expect(chipButton(42)).toBeNull());
    await pasteImage();
    vi.mocked(forgePrEdit).mockResolvedValueOnce({
      failedAttachments: ["image-1.png"],
      body: "x ![](image-1.png)",
    } as never);
    fireEvent.click(button("Save"));
    await waitFor(() => expect(editBox().value).toBe("x ![](image-1.png)"));
    await act(async () => undefined);
    await act(async () => undefined);
    expect(chipButton(42)).toBeNull();
  });

  it("keeps ref lines the text itself ended with through a partial save", async () => {
    vi.mocked(forgePrView).mockImplementation(async () => ({
      ...pr(),
      body: "Words\n\nCloses #3",
    }));
    vi.mocked(attachmentStage).mockImplementation(async () => staged(1));
    await openPrEdit({ issues: true });
    await pasteImage();
    const typed = `${editBox().value}\n\nRelates to #5`;
    fireEvent.change(editBox(), { target: { value: typed } });
    const pending = deferred<unknown>();
    vi.mocked(forgePrEdit).mockReturnValueOnce(pending.promise as never);
    fireEvent.click(button("Save"));
    await waitFor(() => expect(forgePrEdit).toHaveBeenCalledTimes(1));
    expect(sentBody(0)).toBe(`${typed}\n\nCloses #3`);
    await act(async () =>
      pending.resolve({
        failedAttachments: ["image-1.png"],
        body: sentBody(0),
      }),
    );
    await waitFor(() => expect(politeLine()).toBe(PARTIAL_LINE));
    expect(editBox().value).toBe(typed);
    expect(button(/^Closes issue 3:/)).toBeTruthy();
    fireEvent.click(button("Cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the base pick and issue chips with a running save's draft on a reopen", async () => {
    vi.mocked(forgePrView).mockImplementation(async () => ({
      ...pr(),
      body: "Words\n\nCloses #3",
    }));
    const user = userEvent.setup();
    await openPrEdit({ issues: true });
    // Switching the chip's keyword is an edit a re-peel of the body would undo.
    fireEvent.click(button(/^Closes issue 3:/));
    await waitFor(() => expect(button(/^Relates to issue 3:/)).toBeTruthy());
    await pickBase(user, "next");
    const pending = deferred<{ failedAttachments: string[] }>();
    vi.mocked(forgePrEdit).mockReturnValueOnce(pending.promise);
    fireEvent.click(button("Save"));
    await waitFor(() => expect(forgePrEdit).toHaveBeenCalledTimes(1));
    expect(baseArg(0)).toBe("next");
    fireEvent.click(button("Cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    await waitFor(() => expect(editBox()).toBeInTheDocument());
    expect(editBox().value).toBe("Words");
    expect(button(/^Relates to issue 3:/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /^Closes issue 3:/ }),
    ).toBeNull();
    expect(
      screen.getByRole("combobox", { name: "Base branch" }),
    ).toHaveTextContent("next");
    // A running save's spinner prefixes its label ("Loading").
    const save = button(/^(Loading)?Save$/);
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(reasonOf(save)).toBe("Applying this change…");
    await act(async () => pending.resolve({ failedAttachments: [] }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(forgePrEdit).toHaveBeenCalledTimes(1);
  });

  it("keeps a save that failed while closed whole on the reopen, and Save again sends its images but not the base it applied", async () => {
    vi.mocked(forgePrView).mockImplementation(async () => ({
      ...pr(),
      body: "Words\n\nCloses #3",
    }));
    vi.mocked(attachmentStage).mockImplementation(async () => staged(1));
    const user = userEvent.setup();
    await openPrEdit({ issues: true });
    // The Closes #3 chip switches keyword, an edit a re-peel of the body would undo.
    fireEvent.click(button(/^Closes issue 3:/));
    await waitFor(() => expect(button(/^Relates to issue 3:/)).toBeTruthy());
    await pickBase(user, "next");
    await pasteImage();
    const typed = editBox().value;
    const refs = { session: SESSION, names: ["image-1.png"] };
    const pending = deferred<{ failedAttachments: string[] }>();
    vi.mocked(forgePrEdit).mockReturnValueOnce(pending.promise);
    fireEvent.click(button("Save"));
    await waitFor(() => expect(forgePrEdit).toHaveBeenCalledTimes(1));
    expect(baseArg(0)).toBe("next");
    expect(vi.mocked(forgePrEdit).mock.calls[0][6]).toEqual(refs);
    fireEvent.click(button("Cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () =>
      pending.reject({ kind: "gh", message: BODY_DROPPED }),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    await waitFor(() => expect(editBox()).toBeInTheDocument());
    expect(editBox().value).toBe(typed);
    expect(button("Remove image-1.png")).toBeTruthy();
    expect(button(/^Relates to issue 3:/)).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "Base branch" }),
    ).toHaveTextContent("next");
    expect(button("Save")).not.toHaveAttribute("aria-disabled", "true");
    vi.mocked(forgePrEdit).mockResolvedValueOnce({
      failedAttachments: [],
      body: null,
    } as never);
    fireEvent.click(button("Save"));
    await waitFor(() => expect(forgePrEdit).toHaveBeenCalledTimes(2));
    // The failed save applied the base before its description (onPartialSaved
    // recorded it), so the retry leaves the base out.
    expect(baseArg(1)).toBeUndefined();
    expect(vi.mocked(forgePrEdit).mock.calls[1][6]).toEqual(refs);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("starts a generation from the chord unless a save carrying images is pending (AC30)", async () => {
    vi.mocked(attachmentStage).mockImplementation(async () => staged(1));
    await openPrEdit();
    // Before any save.
    await generateChord();
    expect(generateFromDiff).toHaveBeenCalledTimes(1);
    // During a save without images.
    const plain = deferred<unknown>();
    vi.mocked(forgePrEdit).mockReturnValueOnce(plain.promise as never);
    fireEvent.click(button("Save"));
    await waitFor(() => expect(forgePrEdit).toHaveBeenCalledTimes(1));
    await generateChord();
    expect(generateFromDiff).toHaveBeenCalledTimes(2);
    await act(async () => plain.reject(new Error("refused")));
    await waitFor(() => expect(button("Save")).not.toBeDisabled());
    // During a save carrying an image.
    await pasteImage();
    const save = deferred<unknown>();
    vi.mocked(forgePrEdit).mockReturnValueOnce(save.promise as never);
    fireEvent.click(button("Save"));
    await waitFor(() => expect(forgePrEdit).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(button("Generate")).toHaveAttribute("aria-disabled", "true"),
    );
    await generateChord();
    expect(generateFromDiff).toHaveBeenCalledTimes(2);
    await act(async () => save.resolve({ failedAttachments: [] }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("lets a generation's write retire the partial-save line", async () => {
    vi.mocked(attachmentStage).mockImplementation(async () => staged(1));
    await openPrEdit();
    await pasteImage();
    vi.mocked(forgePrEdit).mockResolvedValueOnce({
      failedAttachments: ["image-1.png"],
      body: "x ![image](image-1.png)",
    } as never);
    fireEvent.click(button("Save"));
    await waitFor(() => expect(politeLine()).toBe(PARTIAL_LINE));
    await generateChord();
    expect(generateFromDiff).toHaveBeenCalledTimes(1);
    const onUpdate = generateFromDiff.mock.calls[0][4] as (d: object) => void;
    act(() =>
      onUpdate({
        title: "Generated",
        body: "Generated body",
        closes: [],
        relates: [],
        jiraMentions: [],
      }),
    );
    await waitFor(() => expect(politeLine()).toBe(""));
    fireEvent.click(button("Cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens the edit dialog's picker from the palette over a composer focused last (AC27)", async () => {
    const implemented = (GITLAB as unknown as { implemented: object })
      .implemented;
    vi.mocked(forgeStatus).mockResolvedValue({
      ...GITLAB,
      implemented: { ...implemented, mrEdit: true },
    } as unknown as ForgeStatus);
    mount();
    await screen.findByText("Merge request seven", undefined, {
      timeout: 3000,
    });
    await waitFor(() => expect(box()).toBeInTheDocument());
    act(() => box().focus());
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    await waitFor(() => expect(editBox()).toBeInTheDocument());
    const clicked: HTMLInputElement[] = [];
    const click = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(function (this: HTMLInputElement) {
        clicked.push(this);
      });
    try {
      expect(dispatchAction("attach-image")).toBe(true);
      expect(clicked).toHaveLength(1);
      expect(clicked[0].type).toBe("file");
      expect(screen.getByRole("dialog").contains(clicked[0])).toBe(true);
    } finally {
      click.mockRestore();
    }
  });
});

describe("RemotePrView edit follows the pull request", () => {
  const sentBody = (call: number) =>
    vi.mocked(forgePrEdit).mock.calls[call][3] as string;
  const sentBase = (call: number) => vi.mocked(forgePrEdit).mock.calls[call][5];
  const chipButton = (n: number) =>
    screen.queryByRole("button", { name: new RegExp(`issue ${n}:`) });
  const baseBox = () => screen.getByRole("combobox", { name: "Base branch" });
  const issue = (number: number, title: string): IssueInfo => ({
    number,
    url: "",
    title,
    state: "OPEN",
    createdAt: "",
    updatedAt: "",
    author: null,
    labels: [],
  });

  /** Re-reads PR 7's details, answering with `next` over the base shape. */
  async function reread(client: QueryClient, next: Partial<PrDetails>) {
    vi.mocked(forgePrView).mockImplementation(
      async () => ({ ...pr(), ...next }) as PrDetails,
    );
    // The details entry is the one whose data is PR 7 itself (the diff key
    // extends it and holds text).
    const query = client
      .getQueryCache()
      .findAll()
      .find(
        (q) =>
          (q.state.data as { id?: string } | undefined)?.id === "PR_7" &&
          q.getObserversCount() > 0,
      );
    expect(query).toBeDefined();
    await act(async () => {
      await client.refetchQueries({
        queryKey: query?.queryKey,
        exact: true,
      });
    });
  }

  /** A re-read that also moves the base, waited on until the untouched picker
   *  shows it: the commit that delivered `next` has run every follow. */
  async function rereadLanded(client: QueryClient, next: Partial<PrDetails>) {
    await reread(client, { ...next, baseRefName: "next" });
    await waitFor(() => expect(baseBox()).toHaveTextContent("next"));
  }

  async function saveAndClose() {
    vi.mocked(forgePrEdit).mockResolvedValueOnce({
      failedAttachments: [],
      body: null,
    } as never);
    fireEvent.click(button("Save"));
    await waitFor(() => expect(forgePrEdit).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  }

  it("follows the base into an untouched picker, and Save sends no base", async () => {
    const client = await openPrEdit();
    expect(baseBox()).toHaveTextContent("main");
    await reread(client, { baseRefName: "next" });
    await waitFor(() => expect(baseBox()).toHaveTextContent("next"));
    await saveAndClose();
    expect(sentBase(0)).toBeUndefined();
  });

  it("leaves a moved picker alone, and Save sends the pick", async () => {
    const user = userEvent.setup();
    const client = await openPrEdit();
    await user.click(baseBox());
    await user.click(await screen.findByRole("option", { name: /^old/ }));
    expect(baseBox()).toHaveTextContent("old");
    await reread(client, { baseRefName: "next" });
    expect(baseBox()).toHaveTextContent("old");
    await saveAndClose();
    expect(sentBase(0)).toBe("old");
  });

  it("follows the base into a picker moved and moved back to its seed", async () => {
    const user = userEvent.setup();
    const client = await openPrEdit();
    await user.click(baseBox());
    await user.click(await screen.findByRole("option", { name: /^old/ }));
    expect(baseBox()).toHaveTextContent("old");
    await user.click(baseBox());
    await user.click(await screen.findByRole("option", { name: /^main/ }));
    expect(baseBox()).toHaveTextContent("main");
    await reread(client, { baseRefName: "next" });
    await waitFor(() => expect(baseBox()).toHaveTextContent("next"));
    await saveAndClose();
    expect(sentBase(0)).toBeUndefined();
  });

  it("resets untouched chips to the re-read refs, and Save ends with them", async () => {
    vi.mocked(forgePrView).mockImplementation(async () => ({
      ...pr(),
      body: "Words\n\nCloses #3",
    }));
    const client = await openPrEdit({ issues: true });
    expect(chipButton(3)).toBeTruthy();
    await reread(client, { body: "Words\n\nCloses #5" });
    await waitFor(() => expect(chipButton(5)).toBeTruthy());
    expect(chipButton(3)).toBeNull();
    // The follow's reset probes the ref the open page lacks.
    expect(vi.mocked(forgeIssueView).mock.calls.some((c) => c[1] === 5)).toBe(
      true,
    );
    expect(editBox().value).toBe("Words");
    await saveAndClose();
    expect(sentBody(0)).toBe("Words\n\nCloses #5");
  });

  it("keeps the extracted chip through a follow on an untouched cluster", async () => {
    vi.mocked(forgePrView).mockImplementation(async () => ({
      ...pr(),
      headRefName: "fix/42-thing",
    }));
    vi.mocked(forgeIssueList).mockResolvedValue([issue(42, "Fix the thing")]);
    const client = await openPrEdit({ issues: true });
    await waitFor(() => expect(chipButton(42)).toBeTruthy());
    await reread(client, {
      headRefName: "fix/42-thing",
      body: "Words\n\nCloses #3",
    });
    await waitFor(() => expect(chipButton(3)).toBeTruthy());
    await waitFor(() => expect(chipButton(42)).toBeTruthy());
    expect(editBox().value).toBe("Words");
    await saveAndClose();
    expect(sentBody(0)).toMatch(/^Words\n\n/);
    expect(sentBody(0)).toContain("Closes #3");
    expect(sentBody(0)).toContain("Relates to #42");
  });

  it("never resets a cluster whose extracted chip was removed", async () => {
    vi.mocked(forgePrView).mockImplementation(async () => ({
      ...pr(),
      headRefName: "fix/42-thing",
    }));
    vi.mocked(forgeIssueList).mockResolvedValue([issue(42, "Fix the thing")]);
    const client = await openPrEdit({ issues: true });
    await waitFor(() => expect(chipButton(42)).toBeTruthy());
    fireEvent.click(button("Remove #42"));
    await waitFor(() => expect(chipButton(42)).toBeNull());
    await rereadLanded(client, {
      headRefName: "fix/42-thing",
      body: "Words\n\nCloses #3",
    });
    await act(async () => undefined);
    expect(editBox().value).toBe("Words");
    expect(chipButton(3)).toBeNull();
    expect(chipButton(42)).toBeNull();
    await saveAndClose();
    expect(sentBody(0)).toBe("Words");
  });

  it("never resets a cluster whose keyword was toggled", async () => {
    vi.mocked(forgePrView).mockImplementation(async () => ({
      ...pr(),
      body: "Words\n\nCloses #3",
    }));
    const client = await openPrEdit({ issues: true });
    fireEvent.click(button(/^Closes issue 3:/));
    await waitFor(() => expect(button(/^Relates to issue 3:/)).toBeTruthy());
    await rereadLanded(client, { body: "Words\n\nCloses #3\nCloses #5" });
    await act(async () => undefined);
    expect(chipButton(5)).toBeNull();
    expect(button(/^Relates to issue 3:/)).toBeTruthy();
    await saveAndClose();
    expect(sentBody(0)).toBe("Words\n\nRelates to #3");
  });

  it("never resets a cluster with a picked chip", async () => {
    vi.mocked(forgePrView).mockImplementation(async () => ({
      ...pr(),
      body: "Words\n\nCloses #3",
    }));
    vi.mocked(forgeIssueList).mockResolvedValue([
      issue(3, "Three"),
      issue(9, "Nine"),
    ]);
    const user = userEvent.setup();
    const client = await openPrEdit({ issues: true });
    await user.click(button("Link an issue"));
    await user.click(
      await screen.findByPlaceholderText("Search issues by # or title"),
    );
    await user.click(await screen.findByRole("option", { name: /#9/ }));
    await waitFor(() => expect(chipButton(9)).toBeTruthy());
    await rereadLanded(client, { body: "Words\n\nCloses #3\nCloses #5" });
    await act(async () => undefined);
    expect(chipButton(5)).toBeNull();
    expect(chipButton(3)).toBeTruthy();
    expect(chipButton(9)).toBeTruthy();
  });

  it("never resets a cluster an AI draft added a chip to", async () => {
    vi.mocked(forgePrView).mockImplementation(async () => ({
      ...pr(),
      body: "Words\n\nCloses #3",
    }));
    // The model's proposals land only from the candidates it was fed.
    vi.mocked(forgeIssueList).mockResolvedValue([
      issue(3, "Three"),
      issue(9, "Nine"),
    ]);
    const client = await openPrEdit({ issues: true });
    await waitFor(() => expect(button(/^Closes issue 3: Three/)).toBeTruthy());
    act(() => screen.getByRole("textbox", { name: "Title" }).focus());
    await userEvent.keyboard("{Control>}g{/Control}");
    await act(async () => undefined);
    expect(generateFromDiff).toHaveBeenCalledTimes(1);
    const onUpdate = generateFromDiff.mock.calls[0][4] as (d: object) => void;
    act(() =>
      onUpdate({
        title: "Generated",
        body: "Generated body",
        closes: [],
        relates: [9],
        jiraMentions: [],
      }),
    );
    await waitFor(() => expect(chipButton(9)).toBeTruthy());
    await rereadLanded(client, { body: "Words\n\nCloses #3\nCloses #5" });
    await act(async () => undefined);
    expect(chipButton(5)).toBeNull();
    expect(chipButton(3)).toBeTruthy();
    expect(chipButton(9)).toBeTruthy();
  });

  it("does not reset chips when a re-read carries the same refs", async () => {
    vi.mocked(forgePrView).mockImplementation(async () => ({
      ...pr(),
      body: "Words\n\nCloses #3",
    }));
    const client = await openPrEdit({ issues: true });
    fireEvent.change(editBox(), { target: { value: "Typed" } });
    await reread(client, {
      title: "Renamed elsewhere",
      body: "Words\n\nCloses #3",
    });
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue(
        "Renamed elsewhere",
      ),
    );
    // A reset would probe #3 again (it is on no open page).
    expect(forgeIssueView).not.toHaveBeenCalled();
    expect(button(/^Closes issue 3:/)).toBeTruthy();
  });

  it("follows the Jira cluster while untouched, never after a removal", async () => {
    const link = {
      siteHost: "acme.atlassian.net",
      projectKey: "ABC",
      projectName: "Acme",
    };
    vi.mocked(getJiraLink).mockResolvedValue(link);
    vi.mocked(forgePrView).mockImplementation(async () => ({
      ...pr(),
      body: "Words\n\nRelates to ABC-1",
    }));
    const bitbucket = {
      ...GITLAB,
      provider: "bitbucket",
      host: "bitbucket.org",
      implemented: { mrEdit: true },
    } as unknown as ForgeStatus;
    vi.mocked(forgeStatus).mockResolvedValue(bitbucket);
    let client = mount();
    await screen.findByText("Merge request seven", undefined, {
      timeout: 3000,
    });
    const openEdit = async () => {
      await waitFor(() => expect(getJiraLink).toHaveBeenCalled());
      fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
      await waitFor(() => expect(editBox()).toBeInTheDocument());
      await waitFor(() => expect(button("Remove ABC-1")).toBeTruthy());
    };
    await openEdit();
    expect(editBox().value).toBe("Words");
    await reread(client, { body: "Words\n\nRelates to ABC-2" });
    await waitFor(() => expect(button("Remove ABC-2")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Remove ABC-1" })).toBeNull();

    cleanup();
    vi.mocked(forgePrView).mockImplementation(async () => ({
      ...pr(),
      body: "Words\n\nRelates to ABC-1",
    }));
    client = mount();
    await screen.findByText("Merge request seven", undefined, {
      timeout: 3000,
    });
    await openEdit();
    fireEvent.click(button("Remove ABC-1"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Remove ABC-1" })).toBeNull(),
    );
    await rereadLanded(client, { body: "Words\n\nRelates to ABC-2" });
    await act(async () => undefined);
    expect(screen.queryByRole("button", { name: "Remove ABC-2" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove ABC-1" })).toBeNull();
  });

  it("keeps the chip row and the sent description through its own save and an ordinary failure", async () => {
    vi.mocked(forgePrView).mockImplementation(async () => ({
      ...pr(),
      headRefName: "fix/42-thing",
    }));
    vi.mocked(forgeIssueList).mockResolvedValue([issue(42, "Fix the thing")]);
    const client = await openPrEdit({ issues: true });
    await waitFor(() => expect(chipButton(42)).toBeTruthy());
    const chipNames = () =>
      screen
        .getAllByRole("button", { name: /issue \d+:/ })
        .map((b) => b.getAttribute("aria-label")?.split(":")[0]);
    expect(chipNames()).toEqual(["Relates to issue 42"]);
    const pending = deferred<unknown>();
    vi.mocked(forgePrEdit).mockReturnValueOnce(pending.promise as never);
    fireEvent.click(button("Save"));
    await waitFor(() => expect(forgePrEdit).toHaveBeenCalledTimes(1));
    expect(sentBody(0)).toBe("Relates to #42");
    // The save's own patch puts the composed description in the cache.
    await waitFor(() =>
      expect(
        client
          .getQueryCache()
          .findAll()
          .some(
            (q) =>
              (q.state.data as PrDetails | undefined)?.id === "PR_7" &&
              q.getObserversCount() > 0 &&
              (q.state.data as PrDetails).body === "Relates to #42",
          ),
      ).toBe(true),
    );
    await act(async () => undefined);
    await waitFor(() => expect(chipNames()).toEqual(["Relates to issue 42"]));
    await act(async () => pending.reject(new Error("refused")));
    await waitFor(() =>
      expect(button("Save")).not.toHaveAttribute("aria-disabled", "true"),
    );
    await waitFor(() => expect(chipButton(42)).toBeTruthy());
    expect(chipNames()).toEqual(["Relates to issue 42"]);
    vi.mocked(forgePrEdit).mockResolvedValueOnce({
      failedAttachments: [],
      body: null,
    } as never);
    fireEvent.click(button("Save"));
    await waitFor(() => expect(forgePrEdit).toHaveBeenCalledTimes(2));
    expect(sentBody(1)).toBe(sentBody(0));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("takes the Jira block up into chips when the link lands after Edit opened, and Save keeps the line", async () => {
    const link = {
      siteHost: "acme.atlassian.net",
      projectKey: "ABC",
      projectName: "Acme",
    };
    const linkRead = deferred<Awaited<ReturnType<typeof getJiraLink>>>();
    vi.mocked(getJiraLink).mockReturnValue(linkRead.promise);
    vi.mocked(forgePrView).mockImplementation(async () => ({
      ...pr(),
      body: "Words\n\nRelates to ABC-1",
    }));
    vi.mocked(forgeStatus).mockResolvedValue({
      ...GITLAB,
      provider: "bitbucket",
      host: "bitbucket.org",
      implemented: { mrEdit: true },
    } as unknown as ForgeStatus);
    mount();
    await screen.findByText("Merge request seven", undefined, {
      timeout: 3000,
    });
    await waitFor(() => expect(getJiraLink).toHaveBeenCalled());
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    await waitFor(() => expect(editBox()).toBeInTheDocument());
    // No cluster yet: the description holds the stored body whole.
    expect(editBox().value).toBe("Words\n\nRelates to ABC-1");
    expect(screen.queryByRole("button", { name: "Remove ABC-1" })).toBeNull();
    await act(async () => linkRead.resolve(link));
    await waitFor(() => expect(button("Remove ABC-1")).toBeTruthy());
    expect(editBox().value).toBe("Words");
    await saveAndClose();
    expect(sentBody(0)).toBe("Words\n\nRelates to ABC-1");
  });

  it("takes the issue block up into chips when the forge status lands after Edit opened, and Save keeps the line", async () => {
    // Pending status means no detected provider, which leaves Edit available.
    const status = deferred<ForgeStatus>();
    vi.mocked(forgeStatus).mockReturnValue(status.promise);
    vi.mocked(forgePrView).mockImplementation(async () => ({
      ...pr(),
      body: "Words\n\nCloses #3",
    }));
    mount();
    await screen.findByText("Merge request seven", undefined, {
      timeout: 3000,
    });
    await waitFor(() => expect(forgeStatus).toHaveBeenCalled());
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    await waitFor(() => expect(editBox()).toBeInTheDocument());
    expect(editBox().value).toBe("Words\n\nCloses #3");
    expect(chipButton(3)).toBeNull();
    const implemented = (GITLAB as unknown as { implemented: object })
      .implemented;
    await act(async () =>
      status.resolve({
        ...GITLAB,
        implemented: { ...implemented, mrEdit: true, issues: true },
      } as unknown as ForgeStatus),
    );
    await waitFor(() => expect(chipButton(3)).toBeTruthy());
    expect(editBox().value).toBe("Words");
    await saveAndClose();
    expect(sentBody(0)).toBe("Words\n\nCloses #3");
  });

  it("leaves the issue block with a description typed before the forge status lands, and Save sends it once", async () => {
    const status = deferred<ForgeStatus>();
    vi.mocked(forgeStatus).mockReturnValue(status.promise);
    vi.mocked(forgePrView).mockImplementation(async () => ({
      ...pr(),
      body: "Words\n\nCloses #3",
    }));
    mount();
    await screen.findByText("Merge request seven", undefined, {
      timeout: 3000,
    });
    await waitFor(() => expect(forgeStatus).toHaveBeenCalled());
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    await waitFor(() => expect(editBox()).toBeInTheDocument());
    const typed = "Words edited\n\nCloses #3";
    fireEvent.change(editBox(), { target: { value: typed } });
    expect(
      screen.queryByRole("button", { name: "Link an issue" }),
    ).not.toBeInTheDocument();
    const implemented = (GITLAB as unknown as { implemented: object })
      .implemented;
    await act(async () =>
      status.resolve({
        ...GITLAB,
        implemented: { ...implemented, mrEdit: true, issues: true },
      } as unknown as ForgeStatus),
    );
    // The cluster's field is on screen: the flip has reached the view.
    await waitFor(() => expect(button("Link an issue")).toBeTruthy());
    await act(async () => undefined);
    expect(chipButton(3)).toBeNull();
    // A reset would probe #3 (it is on no open page).
    expect(vi.mocked(forgeIssueView).mock.calls.some((c) => c[1] === 3)).toBe(
      false,
    );
    expect(editBox().value).toBe(typed);
    await saveAndClose();
    expect(sentBody(0)).toBe(typed);
  });

  it("leaves the Jira block with a description typed before the link lands, and Save sends it once", async () => {
    const linkRead = deferred<Awaited<ReturnType<typeof getJiraLink>>>();
    vi.mocked(getJiraLink).mockReturnValue(linkRead.promise);
    vi.mocked(forgePrView).mockImplementation(async () => ({
      ...pr(),
      body: "Words\n\nRelates to ABC-1",
    }));
    vi.mocked(forgeStatus).mockResolvedValue({
      ...GITLAB,
      provider: "bitbucket",
      host: "bitbucket.org",
      implemented: { mrEdit: true },
    } as unknown as ForgeStatus);
    mount();
    await screen.findByText("Merge request seven", undefined, {
      timeout: 3000,
    });
    await waitFor(() => expect(getJiraLink).toHaveBeenCalled());
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    await waitFor(() => expect(editBox()).toBeInTheDocument());
    const typed = "Words edited\n\nRelates to ABC-1";
    fireEvent.change(editBox(), { target: { value: typed } });
    expect(
      screen.queryByRole("button", { name: "Link an issue" }),
    ).not.toBeInTheDocument();
    await act(async () =>
      linkRead.resolve({
        siteHost: "acme.atlassian.net",
        projectKey: "ABC",
        projectName: "Acme",
      }),
    );
    await waitFor(() => expect(button("Link an issue")).toBeTruthy());
    await act(async () => undefined);
    expect(screen.queryByRole("button", { name: "Remove ABC-1" })).toBeNull();
    expect(editBox().value).toBe(typed);
    await saveAndClose();
    expect(sentBody(0)).toBe(typed);
  });

  it("holds a fresh form's Save through the host's re-read after a save that left the screen", async () => {
    await openPrEdit();
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
      target: { value: "Typed title" },
    });
    const save = deferred<unknown>();
    vi.mocked(forgePrEdit).mockReturnValueOnce(save.promise as never);
    fireEvent.click(button("Save"));
    await waitFor(() => expect(forgePrEdit).toHaveBeenCalledTimes(1));
    fireEvent.click(button("Cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const read = deferred<PrDetails>();
    let reads = 0;
    vi.mocked(forgePrView).mockImplementation(() => {
      reads += 1;
      return read.promise;
    });
    await act(async () => save.resolve({ failedAttachments: [], body: null }));
    await waitFor(() => expect(reads).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    await waitFor(() => expect(editBox()).toBeInTheDocument());
    const saveButton = () =>
      screen.getByRole("button", { name: /^(Loading)?Save$/ });
    expect(saveButton()).toHaveAttribute("aria-disabled", "true");
    expect(reasonOf(saveButton())).toBe("Applying this change…");
    await act(async () => read.resolve({ ...pr(), title: "Typed title" }));
    await waitFor(() =>
      expect(saveButton()).not.toHaveAttribute("aria-disabled", "true"),
    );
    expect(saveButton()).not.toBeDisabled();
  });
});

/** Mounts PR 7 and leaves one pasted image's stage in flight. */
async function stageInFlight() {
  mount();
  await screen.findByText("Merge request seven", undefined, { timeout: 3000 });
  await waitFor(() => expect(box()).toBeInTheDocument());
  const stage = deferred<ReturnType<typeof staged>>();
  vi.mocked(attachmentStage).mockReturnValueOnce(stage.promise);
  fireEvent.paste(box(), {
    clipboardData: {
      files: [
        new File([new Uint8Array([1])], "shot.png", { type: "image/png" }),
      ],
      types: ["Files"],
      getData: () => "",
    },
  });
  await waitFor(() => expect(attachmentStage).toHaveBeenCalledTimes(1));
  return stage;
}

const expectHeld = (el: HTMLElement) => {
  expect(el).toHaveAttribute("aria-disabled", "true");
  expect(el).toHaveAccessibleDescription(ATTACHING);
};

describe("a stage in flight holds every post of the pull request draft", () => {
  it("with no stage in flight, the riding Close is not held and opens its confirmation", async () => {
    mount();
    await screen.findByText("Merge request seven", undefined, {
      timeout: 3000,
    });
    await waitFor(() => expect(box()).toBeInTheDocument());
    fireEvent.change(box(), { target: { value: "Text" } });
    expect(button("Close with comment")).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
    fireEvent.click(button("Close with comment"));
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
  });

  it("holds Comment and the riding Close, and the keyboard submit notes why", async () => {
    const stage = await stageInFlight();
    fireEvent.change(box(), { target: { value: "No image yet" } });
    await waitFor(() => expectHeld(button("Comment")));
    expectHeld(button("Close with comment"));
    fireEvent.click(button("Comment"));
    fireEvent.click(button("Close with comment"));
    expect(statusSaysAttaching()).toBe(false);
    act(() => box().focus());
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(statusSaysAttaching()).toBe(true));
    await act(async () => undefined);
    expect(forgePrComment).not.toHaveBeenCalled();
    expect(closePr).not.toHaveBeenCalled();
    expect(useConfirm.getState().request).toBeNull();

    await act(async () => stage.resolve(staged(1)));
    expect(
      await screen.findByRole("button", { name: "Remove image-1.png" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(button("Comment")).not.toHaveAttribute("aria-disabled", "true"),
    );
    expect(button("Close with comment")).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(statusSaysAttaching()).toBe(false);
  });

  it("frees Comment and the riding Close when the stage is refused", async () => {
    const stage = await stageInFlight();
    fireEvent.change(box(), { target: { value: "Text" } });
    await waitFor(() => expectHeld(button("Close with comment")));
    await act(async () => stage.reject(new Error("refused")));
    await waitFor(() =>
      expect(button("Comment")).not.toHaveAttribute("aria-disabled", "true"),
    );
    expect(button("Close with comment")).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(forgePrComment).not.toHaveBeenCalled();
  });

  it("holds Request changes over an empty draft until the stage settles", async () => {
    const stage = await stageInFlight();
    await waitFor(() => expectHeld(button("Request changes")));
    fireEvent.click(button("Request changes"));
    await act(async () => undefined);
    expect(forgePrRequestChanges).not.toHaveBeenCalled();
    await act(async () => stage.reject(new Error("refused")));
    await waitFor(() =>
      expect(button("Request changes")).not.toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    );
  });
});

describe("linked-issue hint", () => {
  it("says the create wording when the caller names no save (the create dialogs)", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <LinkedIssuesField
          repoPath={REPO}
          lens="origin"
          chips={[
            {
              number: 3,
              title: "Three",
              state: "OPEN",
              keyword: "closes",
              source: "manual",
              aiSuggestedClose: false,
            },
          ]}
          onToggleKeyword={() => undefined}
          onRemove={() => undefined}
          onPick={() => undefined}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.getByText("Added to the description on create."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Added to the description when you save."),
    ).toBeNull();
  });

  it("says the save wording on the Jira field when asked for save", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <LinkedIssuesField
          variant="jira"
          repoPath={REPO}
          link={null}
          jiraChips={[
            {
              key: "ABC-1",
              summary: "One",
              statusCategory: "new",
              source: "manual",
            },
          ]}
          onRemove={() => undefined}
          onPick={() => undefined}
          appliedOn="save"
        />
      </QueryClientProvider>,
    );
    expect(
      screen.getByText("Added to the description when you save."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Added to the description on create."),
    ).toBeNull();
  });
});
