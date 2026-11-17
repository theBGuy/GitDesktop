import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Activity, createElement } from "react";
import { toast } from "sonner";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ConfirmDialogHost } from "@/components/confirm-dialog-host";
import { SubmitReviewDialog } from "@/features/pulls/SubmitReviewDialog";
import { forgePrReviewSubmit } from "@/lib/git/api";
import { OFFLINE_WRITE_REASON } from "@/lib/offline-writes";
import type { PrNoun } from "@/lib/pulls/pr-state";
import type { ReviewDraft } from "@/lib/pulls/review-drafts";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgePrReviewSubmit: vi.fn(),
}));
vi.mock("@/lib/git/host", () => ({ useForgeGhHost: () => null }));
// Hoisted with the mock that reads it; fixed arrays, so the drafts keep identity.
const { DRAFTS, NO_DRAFTS, shownDrafts } = vi.hoisted(() => {
  const DRAFTS: ReviewDraft[] = [
    {
      id: "d1",
      path: "src/a.ts",
      line: 3,
      side: "new",
      body: "Rename this.",
      createdAt: "2026-11-01T00:00:00Z",
    },
  ];
  return {
    DRAFTS,
    NO_DRAFTS: [] as ReviewDraft[],
    shownDrafts: { list: DRAFTS },
  };
});
vi.mock("@/lib/pulls/review-drafts", () => ({
  useReviewDrafts: () => ({ data: shownDrafts.list }),
  useClearReviewDrafts: () => ({
    isPending: false,
    mutateAsync: async () => undefined,
  }),
}));
// The editor stands in as a textarea: the dialog only reads value/onChange.
vi.mock("@/components/markdown-editor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
    "aria-label": label,
  }: {
    value: string;
    onChange: (v: string) => void;
    "aria-label": string;
  }) => (
    <textarea
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
vi.mock("sonner", () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    dismiss: vi.fn(),
  },
}));

const REPO = "C:/repos/review";
const TITLE = "Submit this review again?";
const BODY =
  "The last attempt may have posted some or all of this review on Bitbucket. Submitting again can post the same comments twice. Check the pull request first.";
const GITLAB_BODY =
  "The last attempt may have posted some or all of this review on GitLab. Submitting again can post the same comments twice. Check the merge request first.";
const HEDGE =
  "Bitbucket didn't answer in time, so your change may still have gone through. Check before trying again.\nBitbucket request failed: error sending request for url (https://api.bitbucket.org/2.0/x): request timed out";
const PARTIAL =
  "Posted 2 of 5 review comments before the failure; the review was not submitted. Check the pull request on Bitbucket before retrying. (Bitbucket API error (500): boom)";
const NOTHING_POSTED =
  "The review summary couldn't be posted, so the review was not submitted: Bitbucket API error (500): boom";
const REFUSAL = "Bitbucket API error (403): forbidden";
const VERDICT_STEP =
  "The review was posted, but the approve step failed: only re-run the approve action on Bitbucket. (Bitbucket API error (403): forbidden)";

const failures = {
  timeout: { kind: "timeout", message: HEDGE },
  partial: { kind: "bitbucket", message: PARTIAL },
  nothingPosted: { kind: "bitbucket", message: NOTHING_POSTED },
  refusal: { kind: "bitbucket", message: REFUSAL },
  verdictStep: { kind: "bitbucket", message: VERDICT_STEP },
} as const;

/** Queues the submit's next outcomes, in order; later calls succeed. */
function outcomes(...errors: (keyof typeof failures)[]) {
  const queue = [...errors];
  vi.mocked(forgePrReviewSubmit).mockImplementation(async () => {
    const next = queue.shift();
    if (next !== undefined) throw failures[next];
    return { posted: 1, total: 1, verdictApplied: false };
  });
}

beforeEach(() => {
  useUiStore.setState(useUiStore.getInitialState(), true);
  useUiStore.setState({ repoPath: REPO });
  useConfirm.setState({ request: null, requestHold: null });
  shownDrafts.list = DRAFTS;
});

afterEach(() => useConfirm.getState().answer(false));

afterAll(() => expect(unmockedCommands).toEqual([]));

function renderDialog({
  withHost = false,
  remoteLabel = "Bitbucket",
  prNoun = "pull request",
}: {
  withHost?: boolean;
  remoteLabel?: string;
  prNoun?: PrNoun;
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onOpenChange = vi.fn();
  // Inside a tab's <Activity>, as RemotePrView is; `visible` false hides the tab.
  const tree = (open: boolean, shown = true, visible = true) => (
    <QueryClientProvider client={client}>
      {createElement(Activity, {
        mode: visible ? "visible" : "hidden",
        children: shown && (
          <SubmitReviewDialog
            repoPath={REPO}
            number={7}
            open={open}
            onOpenChange={onOpenChange}
            caps={{ canApprove: true, canRequestChanges: true }}
            remoteLabel={remoteLabel}
            prNoun={prNoun}
            lens="origin"
          />
        ),
      })}
      {withHost && <ConfirmDialogHost />}
    </QueryClientProvider>
  );
  const { rerender } = render(tree(true));
  return {
    user: userEvent.setup(),
    onOpenChange,
    setOpen: (open: boolean) => rerender(tree(open)),
    unmountDialog: () => rerender(tree(true, false)),
    setTabVisible: (visible: boolean) => rerender(tree(true, true, visible)),
  };
}

const submitButton = () =>
  screen.getByRole("button", { name: "Submit review" });
const request = () => useConfirm.getState().request;
const answer = (ok: boolean) =>
  act(async () => useConfirm.getState().answer(ok));
const calls = () => vi.mocked(forgePrReviewSubmit).mock.calls.length;

/** Presses Submit and waits for the failure's text to show. */
async function failOnce(
  user: ReturnType<typeof userEvent.setup>,
  text: string,
) {
  const before = calls();
  await user.click(submitButton());
  await waitFor(() => expect(calls()).toBe(before + 1));
  await screen.findByText(text.split("\n")[0], { exact: false });
}

function expectAsked(body = BODY) {
  const r = request();
  expect(r).not.toBeNull();
  expect(r?.title).toBe(TITLE);
  expect(r?.body).toBe(body);
  expect(r?.confirmLabel).toBe("Submit again");
  expect(r?.confirmVariant).toBe("default");
}

describe("Submit review after an attempt that may have posted", () => {
  it("asks before a second submit after a timed-out post", async () => {
    outcomes("timeout");
    const { user } = renderDialog();
    await failOnce(user, HEDGE);
    expect(request()).toBeNull();
    await user.click(submitButton());
    expectAsked();
    expect(calls()).toBe(1);
  });

  it("Cancel sends nothing and keeps the error and the summary", async () => {
    outcomes("timeout");
    const { user } = renderDialog();
    await user.type(
      screen.getByRole("textbox", { name: "Review summary" }),
      "Looks close.",
    );
    await failOnce(user, HEDGE);
    await user.click(submitButton());
    expectAsked();
    await answer(false);
    await act(() => Promise.resolve());
    expect(calls()).toBe(1);
    expect(
      screen.getByText(HEDGE.split("\n")[0], { exact: false }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Review summary" })).toHaveValue(
      "Looks close.",
    );
  });

  it("Confirm submits the same review again", async () => {
    outcomes("timeout");
    const { user, onOpenChange } = renderDialog();
    await user.type(
      screen.getByRole("textbox", { name: "Review summary" }),
      "Looks close.",
    );
    await failOnce(user, HEDGE);
    await user.click(submitButton());
    expectAsked();
    expect(calls()).toBe(1);
    await answer(true);
    await waitFor(() => expect(calls()).toBe(2));
    const [first, second] = vi.mocked(forgePrReviewSubmit).mock.calls;
    expect(second).toEqual(first);
    expect(second?.[1].summary).toBe("Looks close.");
    await waitFor(() =>
      expect(onOpenChange.mock.calls.map((c) => c[0])).toContain(false),
    );
  });

  it("Confirm sends the summary as it reads after the prompt", async () => {
    outcomes("timeout");
    const { user } = renderDialog();
    const editor = screen.getByRole("textbox", { name: "Review summary" });
    await user.type(editor, "Looks close.");
    await failOnce(user, HEDGE);
    await user.click(submitButton());
    expectAsked();
    fireEvent.change(editor, { target: { value: "Ship it." } });
    await answer(true);
    await waitFor(() => expect(calls()).toBe(2));
    const [first, second] = vi.mocked(forgePrReviewSubmit).mock.calls;
    expect(first?.[1].summary).toBe("Looks close.");
    expect(second?.[1].summary).toBe("Ship it.");
  });

  it("a verdict-only review whose verdict step failed submits again with no prompt", async () => {
    shownDrafts.list = NO_DRAFTS;
    outcomes("verdictStep");
    const { user } = renderDialog();
    await user.click(screen.getByRole("radio", { name: /Approve/ }));
    await failOnce(user, VERDICT_STEP);
    await user.click(submitButton());
    await waitFor(() => expect(calls()).toBe(2));
    expect(request()).toBeNull();
    expect(vi.mocked(forgePrReviewSubmit).mock.calls[1]?.[1]).toMatchObject({
      verdict: "approve",
      comments: [],
    });
  });

  it("the same verdict-step failure with a pending comment asks first", async () => {
    outcomes("verdictStep");
    const { user } = renderDialog();
    await user.click(screen.getByRole("radio", { name: /Approve/ }));
    await failOnce(user, VERDICT_STEP);
    await user.click(submitButton());
    expectAsked();
    expect(calls()).toBe(1);
  });

  it("names the merge request on GitLab", async () => {
    outcomes("timeout");
    const { user } = renderDialog({
      remoteLabel: "GitLab",
      prNoun: "merge request",
    });
    await failOnce(user, HEDGE);
    await user.click(submitButton());
    expectAsked(GITLAB_BODY);
  });

  it("a plain refusal submits again with no prompt", async () => {
    outcomes("refusal");
    const { user } = renderDialog();
    await failOnce(user, REFUSAL);
    await user.click(submitButton());
    await waitFor(() => expect(calls()).toBe(2));
    expect(request()).toBeNull();
  });

  it("a Bitbucket failure after some comments posted asks first", async () => {
    outcomes("partial");
    const { user } = renderDialog();
    await failOnce(user, PARTIAL);
    await user.click(submitButton());
    expectAsked();
    expect(calls()).toBe(1);
  });

  it("a failed summary step, before anything posted, submits with no prompt", async () => {
    outcomes("nothingPosted");
    const { user } = renderDialog();
    await failOnce(user, NOTHING_POSTED);
    await user.click(submitButton());
    await waitFor(() => expect(calls()).toBe(2));
    expect(request()).toBeNull();
  });

  it("a later failure that posted nothing ends the prompt", async () => {
    outcomes("timeout", "nothingPosted");
    const { user } = renderDialog();
    await failOnce(user, HEDGE);
    await user.click(submitButton());
    expectAsked();
    await answer(true);
    await screen.findByText(NOTHING_POSTED);
    expect(calls()).toBe(2);
    await user.click(submitButton());
    await waitFor(() => expect(calls()).toBe(3));
    expect(request()).toBeNull();
  });

  it("closing the dialog ends the prompt", async () => {
    outcomes("timeout");
    const { user, setOpen } = renderDialog();
    await failOnce(user, HEDGE);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    setOpen(false);
    setOpen(true);
    await user.click(submitButton());
    await waitFor(() => expect(calls()).toBe(2));
    expect(request()).toBeNull();
  });

  it("sends nothing when the dialog unmounts under the prompt", async () => {
    outcomes("timeout");
    const { user, unmountDialog } = renderDialog();
    await failOnce(user, HEDGE);
    await user.click(submitButton());
    expectAsked();
    unmountDialog();
    expect(request()).toBeNull();
    await answer(true);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(calls()).toBe(1);
  });

  it("sends nothing when the parent closes the dialog under the prompt", async () => {
    outcomes("timeout");
    const { user, setOpen } = renderDialog();
    await failOnce(user, HEDGE);
    await user.click(submitButton());
    expectAsked();
    setOpen(false);
    expect(request()).toBeNull();
    await answer(true);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(calls()).toBe(1);
  });

  it("leaves another surface's prompt alone after its own was answered", async () => {
    outcomes("timeout");
    const { user, unmountDialog } = renderDialog();
    await failOnce(user, HEDGE);
    await user.click(submitButton());
    expectAsked();
    // Answered and replaced in one task, so the dialog's await hasn't resumed
    // when it unmounts.
    const mine = request();
    let other: boolean | undefined;
    act(() => {
      mine?.resolve(false, false);
      void useConfirm
        .getState()
        .ask({ title: "Other", body: "Other", confirmLabel: "Go" })
        .then((ok) => {
          other = ok;
        });
    });
    unmountDialog();
    await act(() => Promise.resolve());
    expect(request()?.title).toBe("Other");
    expect(other).toBeUndefined();
  });

  it("keeps tracking its newer prompt once the older one resolves", async () => {
    outcomes("timeout");
    const { user, unmountDialog } = renderDialog();
    await failOnce(user, HEDGE);
    await user.click(submitButton());
    const first = request();
    // No host renders here, so nothing blocks a second press under the prompt.
    await user.click(submitButton());
    const second = request();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    await act(() => Promise.resolve());
    unmountDialog();
    expect(request()).toBeNull();
  });

  it("asks after a post that failed while its tab was hidden", async () => {
    let fail: ((e: unknown) => void) | undefined;
    vi.mocked(forgePrReviewSubmit).mockImplementation(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const { user, setTabVisible } = renderDialog();
    await user.click(submitButton());
    await waitFor(() => expect(calls()).toBe(1));
    setTabVisible(false);
    await act(async () => fail?.(failures.timeout));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    setTabVisible(true);
    vi.mocked(forgePrReviewSubmit).mockResolvedValue({
      posted: 1,
      total: 1,
      verdictApplied: false,
    });
    await user.click(submitButton());
    expectAsked();
    expect(calls()).toBe(1);
  });

  it("a close by the parent ends the prompt for the reopened dialog", async () => {
    outcomes("timeout");
    const { user, setOpen } = renderDialog();
    await failOnce(user, HEDGE);
    setOpen(false);
    setOpen(true);
    await user.click(submitButton());
    await waitFor(() => expect(calls()).toBe(2));
    expect(request()).toBeNull();
  });

  it("sends nothing when a confirm lands while offline", async () => {
    outcomes("timeout");
    const { user } = renderDialog();
    await failOnce(user, HEDGE);
    await user.click(submitButton());
    expectAsked();
    act(() => onlineManager.setOnline(false));
    try {
      await answer(true);
      expect(toast.info).toHaveBeenCalledWith(OFFLINE_WRITE_REASON);
    } finally {
      act(() => onlineManager.setOnline(true));
    }
    // A parked post would fire on reconnect; a refused one never does.
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(calls()).toBe(1);
  });

  it("opens from Enter on Submit, and Cancel returns focus to Submit", async () => {
    outcomes("timeout");
    const { user, onOpenChange } = renderDialog({ withHost: true });
    await failOnce(user, HEDGE);
    act(() => submitButton().focus());
    await user.keyboard("{Enter}");
    const confirm = await screen.findByRole("dialog", { name: TITLE });
    await waitFor(() =>
      expect(confirm.contains(document.activeElement)).toBe(true),
    );
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(request()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(submitButton()));
    expect(calls()).toBe(1);
    expect(onOpenChange.mock.calls.map((c) => c[0])).not.toContain(false);
    expect(
      screen.getByText(HEDGE.split("\n")[0], { exact: false }),
    ).toBeInTheDocument();
  });
});
