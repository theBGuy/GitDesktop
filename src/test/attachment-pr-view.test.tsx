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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemotePrView } from "@/features/pulls/RemotePrView";
import { attachmentDiscard, attachmentStage } from "@/lib/attachments/api";
import {
  forgePrApprovals,
  forgePrComment,
  forgePrRequestChanges,
  forgePrView,
  forgeStatus,
} from "@/lib/git/api";
import type { ForgeStatus, PrDetails } from "@/lib/git/types";
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
  forgePrView: vi.fn(),
  forgePrApprovals: vi.fn(),
  forgePrComment: vi.fn(),
  forgePrRequestChanges: vi.fn(async () => undefined),
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
}

const box = () =>
  screen.getByRole("textbox", {
    name: "Leave a comment",
  }) as HTMLTextAreaElement;
const button = (name: string | RegExp) => screen.getByRole("button", { name });

const statusSaysAttaching = () =>
  screen.getAllByRole("status").some((s) => s.textContent === ATTACHING);

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
