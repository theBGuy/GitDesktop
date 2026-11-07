import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { toast } from "sonner";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogHost } from "@/components/confirm-dialog-host";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import {
  checkoutRunningReason,
  PrWorktreeCheckout,
  type PrWorktreeCheckoutHandle,
  resolveTarget,
  supportsWorktreeCheckout,
} from "@/features/pulls/PrWorktreeCheckout";
import { PROMOTION_BLOCKS_CHECKOUT } from "@/features/repository/checkout-copy";
import {
  ghAccounts,
  ghPrCheckout,
  ghPrCheckoutWorktree,
  isWorktreeDiverged,
  type WorktreeDiverged,
} from "@/lib/git/api";
import * as api from "@/lib/git/api/pr-actions";
import {
  pendingWriteOfKind,
  useCheckoutPr,
  useCheckoutPrWorktree,
  usePendingPrWrites,
  worktreeKey,
} from "@/lib/git/queries";
import type { RemoteLens } from "@/lib/git/types";
import { listUserWorktrees, type UserWorktree } from "@/lib/git/worktree";
import { ACTIONS } from "@/lib/hotkeys/registry";
import { OFFLINE_WRITE_REASON } from "@/lib/offline-writes";
import { useUiStore } from "@/lib/stores/ui";
import {
  promotionBlocksCheckout,
  useIsRemovingWorktree,
  useWorktreeRemovalStore,
  type WorktreeRemoval,
} from "@/lib/stores/worktree-removal";
import { getTransport, installTransport } from "@/lib/transport";
import { unmockedCommands } from "./setup";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  // Off the real cap, so the discard label pins that it interpolates the constant.
  DIVERGED_COMMIT_CAP: 25,
  ghAccounts: vi.fn(),
  ghPrCheckout: vi.fn(async () => undefined),
  ghPrCheckoutWorktree: vi.fn(),
}));
vi.mock("@/lib/git/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/worktree")>()),
  listUserWorktrees: vi.fn(),
}));
// The fixtures are Windows paths, so absolute-path checks answer as Windows.
vi.mock("@/lib/hotkeys/binding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hotkeys/binding")>()),
  isWindows: true,
}));
vi.mock("@/lib/stores/worktree-removal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stores/worktree-removal")>()),
  promotionBlocksCheckout: vi.fn(() => false),
  useIsRemovingWorktree: vi.fn(() => false),
}));
const { openWorktree } = vi.hoisted(() => ({
  openWorktree: vi.fn(async (_path: string) => undefined),
}));
vi.mock("@/features/repository/useOpenRepoByPath", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/repository/useOpenRepoByPath")
  >()),
  useOpenWorktree: () => openWorktree,
}));

const REPO = "C:/repos/demo";
const toastInfo = vi.spyOn(toast, "info");
const toastSuccess = vi.spyOn(toast, "success");
const toastErrorSpy = vi.spyOn(toast, "error");
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const SAVED_EDITS_LINE =
  "Edits saved to its tracked files before you confirm are discarded as well.";

function worktree(over: Partial<UserWorktree>): UserWorktree {
  return {
    path: REPO,
    branch: "main",
    head: HEAD_A,
    isMain: true,
    isDetached: false,
    isLocked: false,
    lockReason: "",
    ...over,
  } as UserWorktree;
}

function diverged(over: Partial<WorktreeDiverged> = {}): WorktreeDiverged {
  return {
    kind: "worktreeDiverged",
    path: `${REPO}-pr-7`,
    head: HEAD_A,
    commits: [{ sha: "1234567890abcdef", subject: "wip: local tweak" }],
    more: false,
    dirty: false,
    ...over,
  };
}

function Harness({
  number = 7,
  lens = "origin",
  staleReason,
  runningReason,
  apiRef,
  show = true,
}: {
  show?: boolean;
  number?: number;
  lens?: RemoteLens;
  staleReason?: string;
  runningReason?: string;
  apiRef?: React.Ref<PrWorktreeCheckoutHandle>;
}) {
  const checkout = useCheckoutPr(REPO);
  return (
    <>
      <button type="button">Elsewhere</button>
      {show && (
        <PrWorktreeCheckout
          ref={apiRef}
          repoPath={REPO}
          number={number}
          lens={lens}
          prNumber={number}
          headRefName="feat/x"
          staleReason={staleReason}
          runningReason={runningReason}
          pending={false}
          detailsStale={staleReason !== undefined}
        >
          <DisabledReasonButton
            variant="outline"
            size="xs"
            onClick={() =>
              void checkout.mutateAsync({ number, lens: "origin" })
            }
          >
            Checkout
          </DisabledReasonButton>
        </PrWorktreeCheckout>
      )}
      <ConfirmDialogHost />
    </>
  );
}

function setup(props: Parameters<typeof Harness>[0] = {}) {
  const user = userEvent.setup();
  const client = new QueryClient({
    // Queries only: react-query mutations don't retry by default, and the
    // mutation-defaults guard passes only a bare `queries` entry.
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <Harness {...props} />
    </QueryClientProvider>,
  );
  const rerender = (next: Parameters<typeof Harness>[0]) =>
    view.rerender(
      <QueryClientProvider client={client}>
        <Harness {...next} />
      </QueryClientProvider>,
    );
  return { user, rerender, client };
}

const caret = () =>
  screen.getByRole("button", { name: "Checkout options for #7" });
const folder = () => screen.getByLabelText("Folder") as HTMLInputElement;

async function openFromMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(caret());
  await user.click(
    await screen.findByRole("menuitem", { name: /Check out in a worktree/ }),
  );
  await waitFor(() => expect(document.activeElement).toBe(folder()));
}

/** Presses Enter under each platform's chord (Control, then Meta) and reports, per
 *  press, whether it reached the window undefaulted: the app-wide hotkey
 *  layer's view of it. */
async function chordedEntersReachWindow(
  user: ReturnType<typeof userEvent.setup>,
): Promise<boolean[]> {
  const reached: boolean[] = [];
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") reached.push(!e.defaultPrevented);
  };
  window.addEventListener("keydown", onKey);
  try {
    await user.keyboard("{Control>}{Enter}{/Control}");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
  } finally {
    window.removeEventListener("keydown", onKey);
  }
  return reached;
}

beforeEach(() => {
  useUiStore.setState({
    repoPath: REPO,
    selectedPr: { kind: "remote", id: "7" },
  });
  vi.mocked(ghAccounts).mockReset();
  vi.mocked(ghAccounts).mockResolvedValue({ version: "2.98.0", accounts: [] });
  vi.mocked(ghPrCheckout).mockClear();
  vi.mocked(ghPrCheckoutWorktree).mockReset();
  vi.mocked(ghPrCheckoutWorktree).mockResolvedValue(undefined);
  vi.mocked(listUserWorktrees).mockResolvedValue([worktree({})]);
  vi.mocked(openDialog).mockReset();
  openWorktree.mockClear();
  toastInfo.mockClear();
  toastSuccess.mockClear();
  toastErrorSpy.mockClear();
  vi.mocked(promotionBlocksCheckout).mockReturnValue(false);
  vi.mocked(useIsRemovingWorktree).mockReturnValue(false);
  useWorktreeRemovalStore.setState({ byRepo: {} });
});

afterAll(() => expect(unmockedCommands).toEqual([]));

describe("PR split checkout", () => {
  it("renders both halves, and the plain half checks out once", async () => {
    const { user } = setup();
    expect(caret()).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Checkout" }));
    expect(ghPrCheckout).toHaveBeenCalledTimes(1);
    expect(ghPrCheckout).toHaveBeenCalledWith(REPO, 7, "origin");
    expect(ghPrCheckoutWorktree).not.toHaveBeenCalled();
  });

  it("the menu item opens the popover prefilled with the PR's sibling folder", async () => {
    const { user } = setup();
    await openFromMenu(user);
    expect(folder().value).toBe("C:/repos/demo-pr-7");
    expect(screen.getByText("feat/x")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check out" }));
    await waitFor(() =>
      expect(ghPrCheckoutWorktree).toHaveBeenCalledWith(
        REPO,
        7,
        "origin",
        "C:/repos/demo-pr-7",
        false,
        undefined,
      ),
    );
  });

  it("a keyboard-only walk reaches the reset confirm and retries pinned", async () => {
    vi.mocked(ghPrCheckoutWorktree).mockRejectedValueOnce(diverged());
    const { user } = setup();
    await user.tab();
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(caret());
    await user.keyboard("{Enter}");
    const item = await screen.findByRole("menuitem", {
      name: /Check out in a worktree/,
    });
    if (document.activeElement !== item) await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(document.activeElement).toBe(item));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement).toBe(folder()));
    await user.tab();
    expect(document.activeElement).toHaveAccessibleName(
      "Browse for the folder to create it in",
    );
    await user.tab();
    expect(document.activeElement).toHaveAccessibleName("Cancel");
    await user.tab();
    expect(document.activeElement).toHaveAccessibleName("Check out");
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", {
      name: "Reset this worktree to the PR?",
    });
    const confirm = within(dialog).getByRole("button", {
      name: "Discard 1 commit and reset",
    });
    for (let i = 0; i < 4 && document.activeElement !== confirm; i++)
      await user.tab();
    expect(document.activeElement).toBe(confirm);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(ghPrCheckoutWorktree).toHaveBeenCalledTimes(2));
    expect(vi.mocked(ghPrCheckoutWorktree).mock.calls[1]).toEqual([
      REPO,
      7,
      "origin",
      "C:/repos/demo-pr-7",
      true,
      HEAD_A,
    ]);
  });

  it("a held Enter from the menu never runs the checkout", async () => {
    const { user } = setup();
    await user.click(caret());
    await screen.findByRole("menuitem", { name: /Check out in a worktree/ });
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter>5/}");
    await waitFor(() => expect(document.activeElement).toBe(folder()));
    // The key still held when the field takes focus repeats onto it.
    fireEvent.keyDown(folder(), { key: "Enter", repeat: true });
    await act(async () => undefined);
    expect(ghPrCheckoutWorktree).not.toHaveBeenCalled();
  });

  it("a chorded Enter on the menu item passes through without opening", async () => {
    const { user } = setup();
    await user.click(caret());
    const item = await screen.findByRole("menuitem", {
      name: /Check out in a worktree/,
    });
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(document.activeElement).toBe(item));
    const reached = await chordedEntersReachWindow(user);
    await new Promise((r) => setTimeout(r, 50));
    expect(reached).toEqual([true, true]);
    expect(screen.queryByLabelText("Folder")).toBeNull();
    expect(screen.getByRole("menuitem", { hidden: true })).toBe(item);
  });

  it("a chorded Enter in the folder field passes through without checking out", async () => {
    const { user } = setup();
    await openFromMenu(user);
    expect(await chordedEntersReachWindow(user)).toEqual([true, true]);
    await act(async () => undefined);
    expect(ghPrCheckoutWorktree).not.toHaveBeenCalled();
  });

  it("an existing worktree flips the popover to Open and Update", async () => {
    vi.mocked(listUserWorktrees).mockResolvedValue([
      worktree({}),
      // The repository's own checkout is never offered, whatever it's on.
      worktree({ path: "c:\\repos\\DEMO", branch: "feat/x", isMain: false }),
      worktree({
        path: "D:/elsewhere/demo-review",
        branch: "feat/x",
        isMain: false,
      }),
    ]);
    const { user } = setup();
    await user.click(caret());
    await user.click(
      await screen.findByRole("menuitem", { name: /Check out in a worktree/ }),
    );
    const update = await screen.findByRole("button", { name: "Update to PR" });
    expect(screen.queryByLabelText("Folder")).toBeNull();
    expect(
      screen.getByText("This pull request already has a worktree."),
    ).toBeInTheDocument();
    await user.click(update);
    await waitFor(() =>
      expect(ghPrCheckoutWorktree).toHaveBeenCalledWith(
        REPO,
        7,
        "origin",
        "D:/elsewhere/demo-review",
        false,
        undefined,
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Update to PR" })).toBeNull(),
    );
    await user.click(caret());
    await user.click(
      await screen.findByRole("menuitem", { name: /Check out in a worktree/ }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Open worktree" }),
    );
    expect(openWorktree).toHaveBeenCalledWith("D:/elsewhere/demo-review");
  });

  it("a divergence names every listed commit, the cut, and the dirty tree", async () => {
    const commits = Array.from({ length: 20 }, (_, i) => ({
      sha: `${String(i).padStart(2, "0")}${"c".repeat(38)}`,
      subject: `commit ${i}`,
    }));
    vi.mocked(ghPrCheckoutWorktree).mockRejectedValueOnce(
      diverged({
        path: "C:/a/very/long/path/that/keeps/going/and/going/for/the/middle/truncation/demo-pr-7",
        commits,
        more: true,
        dirty: true,
      }),
    );
    const { user } = setup();
    await openFromMenu(user);
    await user.click(screen.getByRole("button", { name: "Check out" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Reset this worktree to the PR?",
    });
    expect(
      within(dialog).getByText("Reset this worktree to the PR?"),
    ).toBeInTheDocument();
    const rows = within(dialog).getAllByRole("listitem");
    expect(rows).toHaveLength(20);
    expect(rows[0]).toHaveTextContent("00ccccc");
    expect(rows[0]).toHaveTextContent("commit 0");
    expect(within(dialog).getByText("…and more")).toBeInTheDocument();
    expect(
      within(dialog).getByText("Its uncommitted changes are discarded too."),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(SAVED_EDITS_LINE)).toBeInTheDocument();
    // The label reads the (mocked) cap; the real one matches the Rust twin.
    expect(api.DIVERGED_COMMIT_CAP).toBe(20);
    await user.click(
      within(dialog).getByRole("button", {
        name: "Discard more than 25 commits and reset",
      }),
    );
    await waitFor(() => expect(ghPrCheckoutWorktree).toHaveBeenCalledTimes(2));
    expect(vi.mocked(ghPrCheckoutWorktree).mock.calls[1]?.[4]).toBe(true);
    expect(vi.mocked(ghPrCheckoutWorktree).mock.calls[1]?.[5]).toBe(HEAD_A);
  });

  it("a fresh divergence on the retry asks again over the fresh payload", async () => {
    vi.mocked(ghPrCheckoutWorktree)
      .mockRejectedValueOnce(diverged())
      .mockRejectedValueOnce(
        diverged({
          head: HEAD_B,
          commits: [
            { sha: "feedface00", subject: "newer work" },
            { sha: "deadbeef00", subject: "wip: local tweak" },
          ],
        }),
      );
    const { user } = setup();
    await openFromMenu(user);
    await user.click(screen.getByRole("button", { name: "Check out" }));
    await user.click(
      await screen.findByRole("button", { name: "Discard 1 commit and reset" }),
    );
    const again = await screen.findByRole("button", {
      name: "Discard 2 commits and reset",
    });
    expect(screen.getByText("newer work")).toBeInTheDocument();
    // Never an automatic retry: the second refusal waits for an answer.
    expect(ghPrCheckoutWorktree).toHaveBeenCalledTimes(2);
    await user.click(again);
    await waitFor(() => expect(ghPrCheckoutWorktree).toHaveBeenCalledTimes(3));
    expect(vi.mocked(ghPrCheckoutWorktree).mock.calls[2]?.[5]).toBe(HEAD_B);
  });

  it("a cancelled confirm runs nothing and lands on the caret", async () => {
    vi.mocked(ghPrCheckoutWorktree).mockRejectedValueOnce(diverged());
    const { user } = setup();
    await openFromMenu(user);
    await user.click(screen.getByRole("button", { name: "Check out" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Reset this worktree to the PR?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(caret()));
    expect(ghPrCheckoutWorktree).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["2.98.0", false],
    ["2.98", false],
    ["", false],
    ["2.40.0", true],
  ])("gh %j holds the worktree flavor: %s", async (version, held) => {
    vi.mocked(ghAccounts).mockResolvedValue({ version, accounts: [] });
    const apiRef = createRef<PrWorktreeCheckoutHandle>();
    const { user } = setup({ apiRef });
    await user.click(caret());
    const item = await screen.findByRole("menuitem", {
      name: /Check out in a worktree/,
    });
    const reason = `Needs GitHub CLI 2.98 or newer (you have ${version})`;
    await waitFor(() => expect(ghAccounts).toHaveBeenCalled());
    await act(async () => undefined);
    if (held) {
      expect(item).toHaveAttribute("aria-disabled", "true");
      expect(item).toHaveTextContent(reason);
    } else {
      expect(item).not.toHaveAttribute("aria-disabled", "true");
    }
    await user.keyboard("{Escape}");
    // The palette route skips the menu; the popover's primary holds the same way.
    act(() => apiRef.current?.openFromPalette());
    const primary = await screen.findByRole("button", { name: "Check out" });
    if (held) {
      expect(primary).toHaveAttribute("aria-disabled", "true");
      expect(primary).toHaveAccessibleDescription(reason);
    } else {
      expect(primary).not.toHaveAttribute("aria-disabled", "true");
    }
  });

  it("an unread gh version leaves the item enabled", async () => {
    vi.mocked(ghAccounts).mockImplementation(
      () => new Promise(() => undefined),
    );
    const { user } = setup();
    await user.click(caret());
    const item = await screen.findByRole("menuitem", {
      name: /Check out in a worktree/,
    });
    expect(item).not.toHaveAttribute("aria-disabled", "true");
  });

  it("parses missing version parts as zero", () => {
    expect(supportsWorktreeCheckout("2.98")).toBe(true);
    expect(supportsWorktreeCheckout("2.97.9")).toBe(false);
    expect(supportsWorktreeCheckout("3.0.0")).toBe(true);
  });

  it("Browse composes the picked parent with the still-derived leaf", async () => {
    vi.mocked(openDialog).mockResolvedValue("D:\\reviews");
    const { user } = setup();
    await openFromMenu(user);
    await user.click(
      screen.getByRole("button", {
        name: "Browse for the folder to create it in",
      }),
    );
    await waitFor(() => expect(folder().value).toBe("D:/reviews/demo-pr-7"));
  });

  it("menu-route Cancel and Escape land on the caret", async () => {
    const { user } = setup();
    await openFromMenu(user);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(caret()));
    await openFromMenu(user);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(caret()));
  });

  it("palette-route Cancel returns focus to where it was", async () => {
    const apiRef = createRef<PrWorktreeCheckoutHandle>();
    const { user } = setup({ apiRef });
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    act(() => elsewhere.focus());
    act(() => apiRef.current?.openFromPalette());
    await waitFor(() => expect(document.activeElement).toBe(folder()));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(elsewhere));
  });

  it("a success closes the popover and lands on the caret", async () => {
    const { user } = setup();
    await openFromMenu(user);
    await user.click(screen.getByRole("button", { name: "Check out" }));
    await waitFor(() => expect(screen.queryByLabelText("Folder")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(caret()));
  });

  it("the popover closes when the rendered PR changes", async () => {
    const { user, rerender } = setup();
    await openFromMenu(user);
    rerender({ number: 8 });
    await waitFor(() => expect(screen.queryByLabelText("Folder")).toBeNull());
  });

  it("a held caret explains why and opens nothing", async () => {
    const { user } = setup({ staleReason: "Loading this pull request…" });
    expect(caret()).toHaveAttribute("aria-disabled", "true");
    expect(caret()).toHaveAccessibleDescription("Loading this pull request…");
    await user.click(caret());
    expect(screen.queryByRole("menuitem")).toBeNull();
  });
});

type ToastAction = { label: string; onClick: () => void };

/** The action riding the `call`-th success toast. */
function toastAction(call: number): ToastAction {
  const opts = toastSuccess.mock.calls[call]?.[1] as
    | { action?: ToastAction }
    | undefined;
  if (!opts?.action) throw new Error(`success toast ${call} has no action`);
  return opts.action;
}

const RESET_DIALOG = { name: "Reset this worktree to the PR?" };
const REVIEW_TREE = "D:/elsewhere/demo-review";

/** Opens from the menu once the worktree list has landed: the body latches
 *  the match the popover opens with. */
async function openLoadedFromMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(caret());
  const item = await screen.findByRole("menuitem", {
    name: /Check out in a worktree/,
  });
  await waitFor(() => expect(listUserWorktrees).toHaveBeenCalled());
  await act(async () => undefined);
  await user.click(item);
}

/** Answers the reset confirm with Cancel: the confirm store outlives a test. */
async function cancelConfirm(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
) {
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", RESET_DIALOG)).toBeNull(),
  );
}

function withReviewTree() {
  vi.mocked(listUserWorktrees).mockResolvedValue([
    worktree({}),
    worktree({ path: REVIEW_TREE, branch: "feat/x", isMain: false }),
  ]);
}

function deferredRejection() {
  let reject!: (e: unknown) => void;
  vi.mocked(ghPrCheckoutWorktree).mockImplementationOnce(
    () =>
      new Promise((_, rej) => {
        reject = rej;
      }),
  );
  return (e: unknown) => reject(e);
}

describe("PR split checkout edges", () => {
  it("offline holds Check out with the offline reason", async () => {
    onlineManager.setOnline(false);
    try {
      const { user } = setup();
      await openFromMenu(user);
      const primary = screen.getByRole("button", { name: "Check out" });
      expect(primary).toHaveAttribute("aria-disabled", "true");
      expect(primary).toHaveAccessibleDescription(OFFLINE_WRITE_REASON);
      await user.click(primary);
      expect(ghPrCheckoutWorktree).not.toHaveBeenCalled();
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it("offline holds Update to PR but leaves Open worktree", async () => {
    withReviewTree();
    const { user } = setup();
    await openLoadedFromMenu(user);
    await screen.findByRole("button", { name: "Update to PR" });
    act(() => onlineManager.setOnline(false));
    try {
      const update = screen.getByRole("button", { name: "Update to PR" });
      expect(update).toHaveAttribute("aria-disabled", "true");
      expect(update).toHaveAccessibleDescription(OFFLINE_WRITE_REASON);
      expect(
        screen.getByRole("button", { name: "Open worktree" }),
      ).not.toHaveAttribute("aria-disabled", "true");
    } finally {
      act(() => onlineManager.setOnline(true));
    }
  });

  it("a divergence landing after the repo moved toasts instead of asking", async () => {
    const reject = deferredRejection();
    const { user } = setup();
    await openFromMenu(user);
    await user.click(screen.getByRole("button", { name: "Check out" }));
    await waitFor(() => expect(ghPrCheckoutWorktree).toHaveBeenCalledTimes(1));
    act(() => useUiStore.setState({ repoPath: "C:/repos/other" }));
    await act(async () => reject(diverged()));
    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith(
        expect.stringContaining("nothing was discarded"),
      ),
    );
    expect(screen.queryByRole("dialog", RESET_DIALOG)).toBeNull();
    expect(ghPrCheckoutWorktree).toHaveBeenCalledTimes(1);
  });

  it("a divergence landing after the host unmounted toasts instead of asking", async () => {
    const reject = deferredRejection();
    const { user, rerender } = setup();
    await openFromMenu(user);
    await user.click(screen.getByRole("button", { name: "Check out" }));
    await waitFor(() => expect(ghPrCheckoutWorktree).toHaveBeenCalledTimes(1));
    rerender({ show: false });
    await act(async () => reject(diverged()));
    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith(
        expect.stringContaining("nothing was discarded"),
      ),
    );
    expect(screen.queryByRole("dialog", RESET_DIALOG)).toBeNull();
  });

  it("a promote claiming the repository refuses the checkout", async () => {
    vi.mocked(promotionBlocksCheckout).mockReturnValue(true);
    const { user } = setup();
    await openFromMenu(user);
    await user.click(screen.getByRole("button", { name: "Check out" }));
    expect(toastInfo).toHaveBeenCalledWith(PROMOTION_BLOCKS_CHECKOUT);
    expect(ghPrCheckoutWorktree).not.toHaveBeenCalled();
  });

  // Fire-time holds are a bounded matrix: run()'s per-pass block re-checks four
  // predicates (offline, promotion, removal, a running checkout) after either
  // await a condition can arise in (Update's head read, the reset confirm). Each
  // of the eight cells has one pin, "…during Update's head read…" or "…while the
  // reset confirm waits…"; a new predicate or await adds its whole row or column.
  it.each([
    [
      "a removal",
      "This worktree is being removed.",
      () =>
        useWorktreeRemovalStore.setState({
          byRepo: { [REPO]: { [REVIEW_TREE]: {} as WorktreeRemoval } },
        }),
    ],
    [
      "a promotion",
      PROMOTION_BLOCKS_CHECKOUT,
      () => vi.mocked(promotionBlocksCheckout).mockReturnValue(true),
    ],
  ])(
    "%s claimed during Update's head read refuses the write",
    async (_, reason, claim) => {
      const rows = [
        worktree({}),
        worktree({ path: REVIEW_TREE, branch: "feat/x", isMain: false }),
      ];
      let hold = false;
      const waiting: ((r: UserWorktree[]) => void)[] = [];
      vi.mocked(listUserWorktrees).mockImplementation(() =>
        hold
          ? new Promise((res) => {
              waiting.push(res);
            })
          : Promise.resolve(rows),
      );
      const { user } = setup();
      await openLoadedFromMenu(user);
      const update = await screen.findByRole("button", {
        name: "Update to PR",
      });
      hold = true;
      await user.click(update);
      await waitFor(() => expect(waiting.length).toBeGreaterThan(0));
      act(() => claim());
      await act(async () => {
        for (const answer of waiting) answer(rows);
      });
      await waitFor(() => expect(toastInfo).toHaveBeenCalledWith(reason));
      expect(ghPrCheckoutWorktree).not.toHaveBeenCalled();
    },
  );

  it("a plain checkout started during Update's head read refuses the write", async () => {
    const rows = [
      worktree({}),
      worktree({ path: REVIEW_TREE, branch: "feat/x", isMain: false }),
    ];
    let hold = false;
    const waiting: ((r: UserWorktree[]) => void)[] = [];
    vi.mocked(listUserWorktrees).mockImplementation(() =>
      hold
        ? new Promise((res) => {
            waiting.push(res);
          })
        : Promise.resolve(rows),
    );
    let finishPlain: (() => void) | undefined;
    vi.mocked(ghPrCheckout).mockImplementationOnce(
      () =>
        new Promise((res) => {
          finishPlain = () => res(undefined);
        }),
    );
    const { user } = setup();
    await openLoadedFromMenu(user);
    const update = await screen.findByRole("button", { name: "Update to PR" });
    hold = true;
    await user.click(update);
    await waitFor(() => expect(waiting.length).toBeGreaterThan(0));
    // The harness's plain half carries no hold of its own, so only the
    // worktree run's fire-time read of the shared checkout kind can see it.
    fireEvent.click(
      screen.getByRole("button", { name: "Checkout", hidden: true }),
    );
    await waitFor(() => expect(ghPrCheckout).toHaveBeenCalledTimes(1));
    await act(async () => {
      for (const answer of waiting) answer(rows);
    });
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(ghPrCheckoutWorktree).not.toHaveBeenCalled();
    await act(async () => finishPlain?.());
  });

  it("a plain checkout started while the reset confirm waits refuses the forced retry", async () => {
    withReviewTree();
    vi.mocked(ghPrCheckoutWorktree).mockRejectedValueOnce(
      diverged({ path: REVIEW_TREE }),
    );
    let finishPlain: (() => void) | undefined;
    vi.mocked(ghPrCheckout).mockImplementationOnce(
      () =>
        new Promise((res) => {
          finishPlain = () => res(undefined);
        }),
    );
    const { user } = setup();
    await openLoadedFromMenu(user);
    await user.click(
      await screen.findByRole("button", { name: "Update to PR" }),
    );
    const dialog = await screen.findByRole("dialog", RESET_DIALOG);
    fireEvent.click(
      screen.getByRole("button", { name: "Checkout", hidden: true }),
    );
    await waitFor(() => expect(ghPrCheckout).toHaveBeenCalledTimes(1));
    await user.click(
      within(dialog).getByRole("button", {
        name: "Discard 1 commit and reset",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", RESET_DIALOG)).toBeNull(),
    );
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(ghPrCheckoutWorktree).toHaveBeenCalledTimes(1);
    expect(ghPrCheckoutWorktree).toHaveBeenCalledWith(
      REPO,
      7,
      "origin",
      REVIEW_TREE,
      false,
      undefined,
    );
    await act(async () => finishPlain?.());
  });

  it("a removal claimed while the reset confirm waits refuses the forced retry", async () => {
    vi.mocked(ghPrCheckoutWorktree).mockRejectedValueOnce(diverged());
    const { user } = setup();
    await openFromMenu(user);
    await user.click(screen.getByRole("button", { name: "Check out" }));
    const dialog = await screen.findByRole("dialog", RESET_DIALOG);
    act(() =>
      useWorktreeRemovalStore.setState({
        byRepo: { [REPO]: { [`${REPO}-pr-7`]: {} as WorktreeRemoval } },
      }),
    );
    await user.click(
      within(dialog).getByRole("button", {
        name: "Discard 1 commit and reset",
      }),
    );
    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith("This worktree is being removed."),
    );
    expect(ghPrCheckoutWorktree).toHaveBeenCalledTimes(1);
  });

  it("going offline during Update's head read refuses the write", async () => {
    const rows = [
      worktree({}),
      worktree({ path: REVIEW_TREE, branch: "feat/x", isMain: false }),
    ];
    let hold = false;
    const waiting: ((r: UserWorktree[]) => void)[] = [];
    vi.mocked(listUserWorktrees).mockImplementation(() =>
      hold
        ? new Promise((res) => {
            waiting.push(res);
          })
        : Promise.resolve(rows),
    );
    const { user } = setup();
    await openLoadedFromMenu(user);
    const update = await screen.findByRole("button", { name: "Update to PR" });
    hold = true;
    await user.click(update);
    await waitFor(() => expect(waiting.length).toBeGreaterThan(0));
    try {
      act(() => onlineManager.setOnline(false));
      await act(async () => {
        for (const answer of waiting) answer(rows);
      });
      await waitFor(() =>
        expect(toastInfo).toHaveBeenCalledWith(OFFLINE_WRITE_REASON),
      );
    } finally {
      act(() => onlineManager.setOnline(true));
    }
    // Past the reconnect: a write parked offline would fire now.
    await act(() => new Promise((r) => setTimeout(r, 100)));
    expect(ghPrCheckoutWorktree).not.toHaveBeenCalled();
  });

  it("going offline while the reset confirm waits refuses the forced retry", async () => {
    vi.mocked(ghPrCheckoutWorktree).mockRejectedValueOnce(diverged());
    const { user } = setup();
    await openFromMenu(user);
    await user.click(screen.getByRole("button", { name: "Check out" }));
    const dialog = await screen.findByRole("dialog", RESET_DIALOG);
    try {
      act(() => onlineManager.setOnline(false));
      await user.click(
        within(dialog).getByRole("button", {
          name: "Discard 1 commit and reset",
        }),
      );
      await waitFor(() =>
        expect(toastInfo).toHaveBeenCalledWith(OFFLINE_WRITE_REASON),
      );
    } finally {
      act(() => onlineManager.setOnline(true));
    }
    // Past the reconnect: a retry parked offline would fire now.
    await act(() => new Promise((r) => setTimeout(r, 100)));
    expect(ghPrCheckoutWorktree).toHaveBeenCalledTimes(1);
  });

  it("a promotion claimed while the reset confirm waits refuses the forced retry", async () => {
    vi.mocked(ghPrCheckoutWorktree).mockRejectedValueOnce(diverged());
    const { user } = setup();
    await openFromMenu(user);
    await user.click(screen.getByRole("button", { name: "Check out" }));
    const dialog = await screen.findByRole("dialog", RESET_DIALOG);
    vi.mocked(promotionBlocksCheckout).mockReturnValue(true);
    await user.click(
      within(dialog).getByRole("button", {
        name: "Discard 1 commit and reset",
      }),
    );
    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith(PROMOTION_BLOCKS_CHECKOUT),
    );
    expect(ghPrCheckoutWorktree).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["git's spelling", REPO, `${REPO}-pr-7`, "C:/repos/demo-pr-7"],
    ["a trailing separator", REPO, `${REPO}-pr-7`, "C:/repos/demo-pr-7/"],
    [
      "another checkout's bucket",
      "C:/repos/demo-linked",
      `${REPO}-pr-7`,
      "C:\\repos\\demo-pr-7",
    ],
  ])(
    "a removal of the create target under %s refuses it",
    async (_, bucket, removing, typed) => {
      useWorktreeRemovalStore.setState({
        byRepo: { [bucket]: { [removing]: {} as WorktreeRemoval } },
      });
      const { user } = setup();
      await openFromMenu(user);
      await user.clear(folder());
      await user.type(folder(), typed);
      await user.click(screen.getByRole("button", { name: "Check out" }));
      await waitFor(() =>
        expect(toastInfo).toHaveBeenCalledWith(
          "This worktree is being removed.",
        ),
      );
      expect(ghPrCheckoutWorktree).not.toHaveBeenCalled();
    },
  );

  it("a worktree being removed holds Open and Update with its reason", async () => {
    vi.mocked(useIsRemovingWorktree).mockReturnValue(true);
    withReviewTree();
    const { user } = setup();
    await openLoadedFromMenu(user);
    for (const name of ["Open worktree", "Update to PR"]) {
      const button = await screen.findByRole("button", { name });
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).toHaveAccessibleDescription(
        "This worktree is being removed.",
      );
    }
  });

  it("create and reset each toast their own success copy", async () => {
    const { user } = setup();
    await openFromMenu(user);
    await user.click(screen.getByRole("button", { name: "Check out" }));
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "Checked out #7 in a worktree",
        expect.anything(),
      ),
    );
    vi.mocked(ghPrCheckoutWorktree).mockRejectedValueOnce(diverged());
    await openFromMenu(user);
    await user.click(screen.getByRole("button", { name: "Check out" }));
    await user.click(
      await screen.findByRole("button", { name: "Discard 1 commit and reset" }),
    );
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "Worktree reset to the PR",
        expect.anything(),
      ),
    );
  });

  it("an update that moved the worktree says it updated", async () => {
    let head = HEAD_A;
    vi.mocked(listUserWorktrees).mockImplementation(async () => [
      worktree({}),
      worktree({ path: REVIEW_TREE, branch: "feat/x", isMain: false, head }),
    ]);
    vi.mocked(ghPrCheckoutWorktree).mockImplementation(async () => {
      head = HEAD_B;
    });
    const { user } = setup();
    await openLoadedFromMenu(user);
    await user.click(
      await screen.findByRole("button", { name: "Update to PR" }),
    );
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "Worktree updated to the PR",
        expect.anything(),
      ),
    );
  });

  it("an update that moved nothing says it was already up to date", async () => {
    // The measured case: the list the popover opened on predates local commits
    // (old head), every read after it answers the current one, and the update
    // moves nothing. Comparing against the opened-on row would claim a move.
    let reads = 0;
    vi.mocked(listUserWorktrees).mockImplementation(async () => {
      reads += 1;
      const head = reads === 1 ? HEAD_A : HEAD_B;
      return [
        worktree({}),
        worktree({ path: REVIEW_TREE, branch: "feat/x", isMain: false, head }),
      ];
    });
    const { user } = setup();
    await openLoadedFromMenu(user);
    await user.click(
      await screen.findByRole("button", { name: "Update to PR" }),
    );
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "Worktree already up to date.",
        expect.anything(),
      ),
    );
  });

  it("every success toast offers to open the worktree it wrote", async () => {
    const { user } = setup();
    await openFromMenu(user);
    await user.click(screen.getByRole("button", { name: "Check out" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    vi.mocked(ghPrCheckoutWorktree).mockRejectedValueOnce(diverged());
    await openFromMenu(user);
    await user.clear(folder());
    await user.type(folder(), "E:/typed/review");
    await user.click(screen.getByRole("button", { name: "Check out" }));
    await user.click(
      await screen.findByRole("button", { name: "Discard 1 commit and reset" }),
    );
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(2));
    expect(toastSuccess.mock.calls[0]?.[0]).toBe(
      "Checked out #7 in a worktree",
    );
    expect(toastSuccess.mock.calls[1]?.[0]).toBe("Worktree reset to the PR");
    for (const call of [0, 1])
      expect(toastAction(call).label).toBe("Open worktree");
    // The path each run wrote, pinned at success: the field moved on since.
    act(() => toastAction(0).onClick());
    expect(openWorktree).toHaveBeenLastCalledWith("C:/repos/demo-pr-7");
    act(() => toastAction(1).onClick());
    expect(openWorktree).toHaveBeenLastCalledWith("E:/typed/review");
  });

  it("the update toast's action opens that worktree, unless it is leaving", async () => {
    withReviewTree();
    const { user } = setup();
    await openLoadedFromMenu(user);
    await user.click(
      await screen.findByRole("button", { name: "Update to PR" }),
    );
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    const action = toastAction(0);
    expect(action.label).toBe("Open worktree");
    // A removal can start between the toast and the click.
    act(() =>
      useWorktreeRemovalStore.setState({
        byRepo: { [REPO]: { [REVIEW_TREE]: {} as WorktreeRemoval } },
      }),
    );
    act(() => action.onClick());
    expect(openWorktree).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledWith("This worktree is being removed.");
    act(() => useWorktreeRemovalStore.setState({ byRepo: {} }));
    act(() => action.onClick());
    expect(openWorktree).toHaveBeenCalledWith(REVIEW_TREE);
  });

  it("Open worktree refuses a removal another checkout started", async () => {
    withReviewTree();
    const { user } = setup();
    await openLoadedFromMenu(user);
    const open = await screen.findByRole("button", { name: "Open worktree" });
    // Keyed under the other checkout's bucket, in Windows spelling: the
    // render-time hook (mocked idle) never sees it, so only the click can.
    act(() =>
      useWorktreeRemovalStore.setState({
        byRepo: {
          "C:/repos/demo-linked": {
            "d:\\elsewhere\\demo-review\\": {} as WorktreeRemoval,
          },
        },
      }),
    );
    await user.click(open);
    expect(toastInfo).toHaveBeenCalledWith("This worktree is being removed.");
    expect(openWorktree).not.toHaveBeenCalled();
  });

  it("an update joins no stale in-flight list read for its head compare", async () => {
    const fresh = [
      worktree({}),
      worktree({
        path: REVIEW_TREE,
        branch: "feat/x",
        isMain: false,
        head: HEAD_B,
      }),
    ];
    let held: ((r: UserWorktree[]) => void) | undefined;
    let holdNext = false;
    vi.mocked(listUserWorktrees).mockImplementation(() => {
      if (!holdNext) return Promise.resolve(fresh);
      holdNext = false;
      return new Promise((res) => {
        held = res;
      });
    });
    const { user, client } = setup();
    await openLoadedFromMenu(user);
    const update = await screen.findByRole("button", { name: "Update to PR" });
    // A background refetch that read the worktree before a local commit moved
    // it, still in flight when Update is pressed.
    holdNext = true;
    act(() => void client.invalidateQueries({ queryKey: worktreeKey(REPO) }));
    await waitFor(() => expect(held).toBeDefined());
    await user.click(update);
    await act(async () =>
      held?.([
        worktree({}),
        worktree({ path: REVIEW_TREE, branch: "feat/x", isMain: false }),
      ]),
    );
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(toastSuccess).toHaveBeenCalledWith(
      "Worktree already up to date.",
      expect.anything(),
    );
  });

  it("the gh version is read only while the menu or popover is open", async () => {
    const { user, client } = setup();
    await act(async () => undefined);
    expect(ghAccounts).not.toHaveBeenCalled();
    await openFromMenu(user);
    await waitFor(() => expect(ghAccounts).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByLabelText("Folder")).toBeNull());
    expect(screen.queryByRole("menuitem")).toBeNull();
    const reads = vi.mocked(ghAccounts).mock.calls.length;
    // Only a still-mounted observer would refetch an invalidated key.
    await act(() => client.invalidateQueries({ queryKey: ["gh-accounts"] }));
    expect(ghAccounts).toHaveBeenCalledTimes(reads);
  });

  it("a cold palette opening reads the gh version once", async () => {
    const apiRef = createRef<PrWorktreeCheckoutHandle>();
    setup({ apiRef });
    await act(async () => undefined);
    expect(ghAccounts).not.toHaveBeenCalled();
    act(() => apiRef.current?.openFromPalette());
    await waitFor(() => expect(document.activeElement).toBe(folder()));
    await waitFor(() => expect(ghAccounts).toHaveBeenCalledTimes(1));
  });

  it("a padded folder meets the removal its trimmed spelling names", async () => {
    useWorktreeRemovalStore.setState({
      byRepo: { [REPO]: { [`${REPO}-pr-7`]: {} as WorktreeRemoval } },
    });
    const { user } = setup();
    await openFromMenu(user);
    await user.clear(folder());
    await user.type(folder(), " C:/repos/demo-pr-7 ");
    await user.click(screen.getByRole("button", { name: "Check out" }));
    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith("This worktree is being removed."),
    );
    expect(ghPrCheckoutWorktree).not.toHaveBeenCalled();
  });

  it("a padded folder checks out, and pins, the trimmed spelling", async () => {
    const { user } = setup();
    await openFromMenu(user);
    await user.clear(folder());
    await user.type(folder(), " E:/typed/review ");
    await user.click(screen.getByRole("button", { name: "Check out" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(ghPrCheckoutWorktree).toHaveBeenCalledWith(
      REPO,
      7,
      "origin",
      "E:/typed/review",
      false,
      undefined,
    );
    act(() => toastAction(0).onClick());
    expect(openWorktree).toHaveBeenCalledWith("E:/typed/review");
  });

  it("Tab cycles inside the open popover", async () => {
    const { user } = setup();
    await openFromMenu(user);
    const names = [
      "Browse for the folder to create it in",
      "Cancel",
      "Check out",
    ];
    for (const name of names) {
      await user.tab();
      expect(document.activeElement).toHaveAccessibleName(name);
    }
    // Past the last control, the popup's focus guard hands focus back to the
    // first, on the next frame.
    await user.tab();
    await waitFor(() => expect(document.activeElement).toBe(folder()));
    await user.tab({ shift: true });
    await waitFor(() =>
      expect(document.activeElement).toHaveAccessibleName("Check out"),
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(caret()));
  });

  it("Tab cycles inside the existing-worktree popover", async () => {
    withReviewTree();
    const { user } = setup();
    await openLoadedFromMenu(user);
    const open = await screen.findByRole("button", { name: "Open worktree" });
    await waitFor(() => expect(document.activeElement).toBe(open));
    for (const name of [
      "Update to PR",
      "Close",
      "Check out into a new folder…",
      "Open worktree",
    ]) {
      await user.tab();
      await waitFor(() =>
        expect(document.activeElement).toHaveAccessibleName(name),
      );
    }
  });

  it("a press outside still closes the popover", async () => {
    const { user } = setup();
    await openFromMenu(user);
    // The trap hides the rest of the page from assistive tech, not from the
    // pointer.
    await user.click(
      screen.getByRole("button", { name: "Elsewhere", hidden: true }),
    );
    await waitFor(() => expect(screen.queryByLabelText("Folder")).toBeNull());
  });

  it.each([
    [
      "Escape",
      (u: ReturnType<typeof userEvent.setup>) => u.keyboard("{Escape}"),
    ],
    [
      "a press outside",
      (u: ReturnType<typeof userEvent.setup>) =>
        u.click(
          screen.getByRole("button", { name: "Elsewhere", hidden: true }),
        ),
    ],
    [
      "its Close button",
      (u: ReturnType<typeof userEvent.setup>) =>
        u.click(screen.getByRole("button", { name: "Close" })),
    ],
  ])(
    "closing the popover with %s mid-update retires the reset confirm",
    async (_, dismiss) => {
      withReviewTree();
      const reject = deferredRejection();
      const { user } = setup();
      await openLoadedFromMenu(user);
      await user.click(
        await screen.findByRole("button", { name: "Update to PR" }),
      );
      await waitFor(() =>
        expect(ghPrCheckoutWorktree).toHaveBeenCalledTimes(1),
      );
      await dismiss(user);
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "Update to PR" }),
        ).toBeNull(),
      );
      await act(async () => reject(diverged({ path: REVIEW_TREE })));
      await waitFor(() =>
        expect(toastInfo).toHaveBeenCalledWith(
          "You left #7 before its worktree could be reset, so nothing was discarded.",
        ),
      );
      expect(screen.queryByRole("dialog", RESET_DIALOG)).toBeNull();
      expect(ghPrCheckoutWorktree).toHaveBeenCalledTimes(1);
    },
  );

  it("a run whose popover the user closed still toasts its success", async () => {
    let resolve!: () => void;
    vi.mocked(ghPrCheckoutWorktree).mockImplementationOnce(
      () =>
        new Promise<void>((res) => {
          resolve = res;
        }),
    );
    const { user } = setup();
    await openFromMenu(user);
    await user.click(screen.getByRole("button", { name: "Check out" }));
    await waitFor(() => expect(ghPrCheckoutWorktree).toHaveBeenCalledTimes(1));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByLabelText("Folder")).toBeNull());
    await act(async () => resolve());
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "Checked out #7 in a worktree",
        expect.anything(),
      ),
    );
  });

  it("a malformed divergence keeps the ordinary error toast", async () => {
    // An uppercase head is a spelling the backend's forced retry refuses.
    vi.mocked(ghPrCheckoutWorktree).mockRejectedValueOnce(
      diverged({ head: "A".repeat(40) }),
    );
    const { user } = setup();
    await openFromMenu(user);
    await user.click(screen.getByRole("button", { name: "Check out" }));
    await waitFor(() => expect(toastErrorSpy).toHaveBeenCalled());
    expect(screen.queryByRole("dialog", RESET_DIALOG)).toBeNull();
  });

  it("a lens switch closes the popover", async () => {
    const { user, rerender } = setup();
    await openFromMenu(user);
    rerender({ lens: "upstream" });
    await waitFor(() => expect(screen.queryByLabelText("Folder")).toBeNull());
  });

  it("a divergence landing after a lens switch toasts instead of asking", async () => {
    const reject = deferredRejection();
    const { user, rerender } = setup();
    await openFromMenu(user);
    await user.click(screen.getByRole("button", { name: "Check out" }));
    await waitFor(() => expect(ghPrCheckoutWorktree).toHaveBeenCalledTimes(1));
    // The same number in the other lens is a different pull request.
    rerender({ lens: "upstream" });
    await act(async () => reject(diverged()));
    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith(
        expect.stringContaining("nothing was discarded"),
      ),
    );
    expect(screen.queryByRole("dialog", RESET_DIALOG)).toBeNull();
    expect(ghPrCheckoutWorktree).toHaveBeenCalledTimes(1);
  });

  it("a relative folder's toast action opens the worktree's own path", async () => {
    // "../review" resolves against the repository, C:/repos/demo.
    const created = worktree({
      path: "C:/repos/review",
      branch: "feat/x",
      isMain: false,
    });
    let wrote = false;
    vi.mocked(listUserWorktrees).mockImplementation(async () =>
      wrote ? [worktree({}), created] : [worktree({})],
    );
    vi.mocked(ghPrCheckoutWorktree).mockImplementation(async () => {
      wrote = true;
    });
    const { user } = setup();
    await openFromMenu(user);
    await user.clear(folder());
    await user.type(folder(), "../review");
    await user.click(screen.getByRole("button", { name: "Check out" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(vi.mocked(ghPrCheckoutWorktree).mock.calls[0]?.[3]).toBe(
      "../review",
    );
    act(() => toastAction(0).onClick());
    expect(openWorktree).toHaveBeenLastCalledWith("C:/repos/review");
  });

  it.each([
    ["a row at the resolved folder opens it", true],
    ["no row at the resolved folder offers nothing", false],
  ])(
    "a relative folder never opens a same-named namesake: %s",
    async (_, written) => {
      // A fork PR's bare head name matches the user's own `feat/x` worktree, at
      // the very commit the PR points at, in another folder.
      const own = worktree({
        path: "C:/repos/mine",
        branch: "feat/x",
        isMain: false,
        head: HEAD_A,
      });
      const created = worktree({
        path: "C:/repos/review",
        branch: "owner/feat/x",
        isMain: false,
        head: HEAD_A,
      });
      let wrote = false;
      vi.mocked(listUserWorktrees).mockImplementation(async () =>
        wrote && written ? [worktree({}), own, created] : [worktree({}), own],
      );
      vi.mocked(ghPrCheckoutWorktree).mockImplementation(async () => {
        wrote = true;
      });
      const { user } = setup();
      // The namesake latches the existing state; its escape route reaches the
      // create form.
      await openLoadedFromMenu(user);
      await user.click(
        await screen.findByRole("button", {
          name: "Check out into a new folder…",
        }),
      );
      await waitFor(() => expect(document.activeElement).toBe(folder()));
      await user.clear(folder());
      await user.type(folder(), "../review");
      await user.click(screen.getByRole("button", { name: "Check out" }));
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
      const opts = toastSuccess.mock.calls[0]?.[1] as {
        action?: { onClick: () => void };
      };
      if (!written) {
        expect(opts.action).toBeUndefined();
        return;
      }
      act(() => opts.action?.onClick());
      expect(openWorktree).toHaveBeenLastCalledWith("C:/repos/review");
    },
  );

  it.each([
    ["C:/repos/demo", "../review", "C:/repos/review"],
    ["C:/repos/demo", "./sub/../x", "C:/repos/demo/x"],
    ["C:/repos/demo", "..\\..\\..\\..\\x", "C:/x"],
    ["//srv/share/demo", "../x", "//srv/share/x"],
    ["C:/repos/demo", "D:/abs/x", "D:/abs/x"],
    ["C:/repos/demo", "C:\\abs\\x", "C:\\abs\\x"],
    ["C:/repos/demo", "\\reviews", "C:/reviews"],
    ["C:/repos/demo", "/reviews", "C:/reviews"],
    ["//srv/share/demo", "/x", "//srv/share/x"],
    ["C:/repos/demo", "C:reviews", "C:reviews"],
  ])("resolveTarget(%s, %s) is %s", (repo, typed, want) => {
    expect(resolveTarget(repo, typed)).toBe(want);
  });

  it("a root-relative folder opens the drive's folder, not the repository's", async () => {
    const atRoot = worktree({
      path: "C:/reviews",
      branch: "owner/feat/x",
      isMain: false,
    });
    const inRepo = worktree({
      path: "C:/repos/demo/reviews",
      branch: "other",
      isMain: false,
    });
    vi.mocked(listUserWorktrees).mockResolvedValue([
      worktree({}),
      inRepo,
      atRoot,
    ]);
    const { user } = setup();
    await openFromMenu(user);
    await user.clear(folder());
    await user.type(folder(), "\\reviews");
    await user.click(screen.getByRole("button", { name: "Check out" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    act(() => toastAction(0).onClick());
    expect(openWorktree).toHaveBeenLastCalledWith("C:/reviews");
  });

  it("the existing state can switch to a new folder", async () => {
    withReviewTree();
    const { user } = setup();
    await openLoadedFromMenu(user);
    await user.click(
      await screen.findByRole("button", {
        name: "Check out into a new folder…",
      }),
    );
    await waitFor(() => expect(document.activeElement).toBe(folder()));
    expect(folder().value).toBe("C:/repos/demo-pr-7");
    expect(screen.queryByRole("button", { name: "Update to PR" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Check out" }));
    await waitFor(() =>
      expect(ghPrCheckoutWorktree).toHaveBeenCalledWith(
        REPO,
        7,
        "origin",
        "C:/repos/demo-pr-7",
        false,
        undefined,
      ),
    );
  });

  it("Escape and Cancel still close after switching to a new folder", async () => {
    withReviewTree();
    const { user } = setup();
    const toNewFolder = async () => {
      await openLoadedFromMenu(user);
      await user.click(
        await screen.findByRole("button", {
          name: "Check out into a new folder…",
        }),
      );
      await waitFor(() => expect(document.activeElement).toBe(folder()));
    };
    await toNewFolder();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(caret()));
    await toNewFolder();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(caret()));
    expect(ghPrCheckoutWorktree).not.toHaveBeenCalled();
  });

  it.each([
    [
      1,
      "1 untracked file at a path the pull request tracks is overwritten too.",
    ],
    [
      3,
      "3 untracked files at paths the pull request tracks are overwritten too.",
    ],
  ])(
    "%i untracked file(s) the reset overwrites get their line",
    async (n, line) => {
      vi.mocked(ghPrCheckoutWorktree).mockRejectedValueOnce(
        diverged({ dirty: true, untracked: n }),
      );
      const { user } = setup();
      await openFromMenu(user);
      await user.click(screen.getByRole("button", { name: "Check out" }));
      const dialog = await screen.findByRole("dialog", RESET_DIALOG);
      expect(within(dialog).getByText(line)).toBeInTheDocument();
      const text = dialog.textContent ?? "";
      expect(text).toContain("Its uncommitted changes are discarded too.");
      expect(text.indexOf(line)).toBeGreaterThan(
        text.indexOf("Its uncommitted changes are discarded too."),
      );
      await cancelConfirm(user, dialog);
    },
  );

  it.each([
    ["zero", { untracked: 0 }],
    ["absent", {}],
  ])("an untracked count of %s adds no line", async (_, extra) => {
    vi.mocked(ghPrCheckoutWorktree).mockRejectedValueOnce({
      ...diverged(),
      ...extra,
    });
    const { user } = setup();
    await openFromMenu(user);
    await user.click(screen.getByRole("button", { name: "Check out" }));
    const dialog = await screen.findByRole("dialog", RESET_DIALOG);
    expect(within(dialog).queryByText(/untracked/)).toBeNull();
    // Unmeasured edits saved while the confirm is open are named regardless.
    expect(
      within(dialog).queryByText("Its uncommitted changes are discarded too."),
    ).toBeNull();
    expect(within(dialog).getByText(SAVED_EDITS_LINE)).toBeInTheDocument();
    await cancelConfirm(user, dialog);
  });

  it("a relative folder no row answers toasts without an action", async () => {
    const { user } = setup();
    await openFromMenu(user);
    await user.clear(folder());
    await user.type(folder(), "../review");
    await user.click(screen.getByRole("button", { name: "Check out" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    const opts = toastSuccess.mock.calls[0]?.[1] as { action?: unknown };
    expect(opts.action).toBeUndefined();
  });

  it("a pick answering an earlier opening is dropped", async () => {
    let answer!: (picked: string) => void;
    vi.mocked(openDialog).mockImplementation(
      () =>
        new Promise((res) => {
          answer = res;
        }),
    );
    const { user } = setup();
    await openFromMenu(user);
    await user.click(
      screen.getByRole("button", {
        name: "Browse for the folder to create it in",
      }),
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByLabelText("Folder")).toBeNull());
    await openFromMenu(user);
    await act(async () => answer("D:/reviews"));
    expect(folder().value).toBe("C:/repos/demo-pr-7");
  });

  /** Starts a create, closes the popover, reopens it from the palette and edits
   *  the new draft, leaving the first run in flight. */
  async function reopenOverRun(
    user: ReturnType<typeof userEvent.setup>,
    apiRef: React.RefObject<PrWorktreeCheckoutHandle | null>,
  ) {
    await openFromMenu(user);
    await user.click(screen.getByRole("button", { name: "Check out" }));
    await waitFor(() => expect(ghPrCheckoutWorktree).toHaveBeenCalledTimes(1));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByLabelText("Folder")).toBeNull());
    act(() => apiRef.current?.openFromPalette());
    await waitFor(() => expect(document.activeElement).toBe(folder()));
    await user.clear(folder());
    await user.type(folder(), "E:/next/draft");
  }

  it("a run settling after a reopen leaves the new popover open", async () => {
    let settle!: () => void;
    vi.mocked(ghPrCheckoutWorktree).mockImplementationOnce(
      () =>
        new Promise<void>((res) => {
          settle = res;
        }),
    );
    const apiRef = createRef<PrWorktreeCheckoutHandle>();
    const { user } = setup({ apiRef });
    await reopenOverRun(user, apiRef);
    await act(async () => settle());
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    // Long enough for a close to finish unmounting the popup.
    await act(() => new Promise((res) => setTimeout(res, 200)));
    expect(folder().value).toBe("E:/next/draft");
  });

  it("a divergence landing after a reopen toasts instead of asking", async () => {
    const reject = deferredRejection();
    const apiRef = createRef<PrWorktreeCheckoutHandle>();
    const { user } = setup({ apiRef });
    await reopenOverRun(user, apiRef);
    await act(async () => reject(diverged()));
    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith(
        expect.stringContaining("nothing was discarded"),
      ),
    );
    expect(screen.queryByRole("dialog", RESET_DIALOG)).toBeNull();
    expect(folder().value).toBe("E:/next/draft");
    expect(ghPrCheckoutWorktree).toHaveBeenCalledTimes(1);
  });

  it("a divergence landing before the view catches up with a switch toasts", async () => {
    const reject = deferredRejection();
    const { user } = setup();
    await openFromMenu(user);
    await user.click(screen.getByRole("button", { name: "Check out" }));
    await waitFor(() => expect(ghPrCheckoutWorktree).toHaveBeenCalledTimes(1));
    // The selection moved; the deferred view still renders #7.
    act(() => useUiStore.setState({ selectedPr: { kind: "remote", id: "8" } }));
    await act(async () => reject(diverged()));
    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith(
        expect.stringContaining("nothing was discarded"),
      ),
    );
    expect(screen.queryByRole("dialog", RESET_DIALOG)).toBeNull();
  });

  it("a worktree checkout holds under the shared checkout write kind", async () => {
    let settle!: () => void;
    vi.mocked(ghPrCheckoutWorktree).mockImplementationOnce(
      () =>
        new Promise<void>((res) => {
          settle = res;
        }),
    );
    function Probe() {
      const run = useCheckoutPrWorktree(REPO);
      const running = pendingWriteOfKind(usePendingPrWrites(REPO), "checkout");
      return (
        <>
          <button
            type="button"
            onClick={() =>
              void run
                .mutateAsync({
                  number: 7,
                  lens: "origin",
                  path: "C:/repos/demo-pr-7",
                  force: false,
                })
                .catch(() => undefined)
            }
          >
            Run
          </button>
          <output>{checkoutRunningReason(running, false) ?? "idle"}</output>
        </>
      );
    }
    const user = userEvent.setup();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("idle");
    await user.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Checking out #7…"),
    );
    await act(async () => settle());
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("idle"),
    );
  });

  it("the palette registers the pinned worktree action", () => {
    expect(ACTIONS.find((a) => a.id === "pr-checkout-worktree")).toMatchObject({
      label: "Check out pull request in a worktree…",
      category: "Pull requests",
      defaultBinding: null,
    });
  });

  it("a running checkout holds the item and Check out with its reason", async () => {
    const reason = "Checking out #9…";
    const apiRef = createRef<PrWorktreeCheckoutHandle>();
    const { user } = setup({ apiRef, runningReason: reason });
    await user.click(caret());
    const item = await screen.findByRole("menuitem", {
      name: /Check out in a worktree/,
    });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveTextContent(reason);
    await user.keyboard("{Escape}");
    act(() => apiRef.current?.openFromPalette());
    const primary = await screen.findByRole("button", { name: "Check out" });
    expect(primary).toHaveAttribute("aria-disabled", "true");
    expect(primary).toHaveAccessibleDescription(reason);
    await user.click(primary);
    expect(ghPrCheckoutWorktree).not.toHaveBeenCalled();
  });

  it("a running checkout holds Update to PR with its reason", async () => {
    const reason = "Checking out #9…";
    withReviewTree();
    const apiRef = createRef<PrWorktreeCheckoutHandle>();
    const { user } = setup({ apiRef, runningReason: reason });
    await user.click(caret());
    await screen.findByRole("menuitem", { name: /Check out in a worktree/ });
    await waitFor(() => expect(listUserWorktrees).toHaveBeenCalled());
    await act(async () => undefined);
    await user.keyboard("{Escape}");
    act(() => apiRef.current?.openFromPalette());
    const update = await screen.findByRole("button", { name: "Update to PR" });
    expect(update).toHaveAttribute("aria-disabled", "true");
    expect(update).toHaveAccessibleDescription(reason);
    await user.click(update);
    expect(ghPrCheckoutWorktree).not.toHaveBeenCalled();
  });

  it("the guard refuses payloads it can't act on", () => {
    expect(isWorktreeDiverged(diverged())).toBe(true);
    expect(isWorktreeDiverged(diverged({ head: "A".repeat(40) }))).toBe(false);
    expect(isWorktreeDiverged(diverged({ head: "abc" }))).toBe(false);
    expect(isWorktreeDiverged(diverged({ commits: [] }))).toBe(false);
    expect(isWorktreeDiverged({ ...diverged(), more: "yes" })).toBe(false);
    expect(isWorktreeDiverged({ ...diverged(), kind: "other" })).toBe(false);
  });

  it("a held Enter landing on Open or Update is ignored", async () => {
    withReviewTree();
    const { user } = setup();
    await openLoadedFromMenu(user);
    for (const name of ["Open worktree", "Update to PR"]) {
      const button = await screen.findByRole("button", { name });
      const held = createEvent.keyDown(button, { key: "Enter", repeat: true });
      fireEvent(button, held);
      expect(held.defaultPrevented).toBe(true);
    }
    expect(openWorktree).not.toHaveBeenCalled();
    expect(ghPrCheckoutWorktree).not.toHaveBeenCalled();
  });

  it("rows landing while the popover is open never flip its body", async () => {
    let resolve!: (rows: UserWorktree[]) => void;
    vi.mocked(listUserWorktrees).mockImplementation(
      () =>
        new Promise((res) => {
          resolve = res;
        }),
    );
    const apiRef = createRef<PrWorktreeCheckoutHandle>();
    setup({ apiRef });
    act(() => apiRef.current?.openFromPalette());
    await waitFor(() => expect(document.activeElement).toBe(folder()));
    await waitFor(() => expect(listUserWorktrees).toHaveBeenCalled());
    await act(async () =>
      resolve([
        worktree({}),
        worktree({ path: REVIEW_TREE, branch: "feat/x", isMain: false }),
      ]),
    );
    expect(folder()).toBeInTheDocument();
    expect(document.activeElement).toBe(folder());
    expect(screen.queryByRole("button", { name: "Update to PR" })).toBeNull();
  });
});

describe("ghPrCheckoutWorktree wire shape", () => {
  it("sends exactly the command's camelCase argument keys", async () => {
    const previous = getTransport();
    const calls: { cmd: string; args: unknown }[] = [];
    installTransport({
      invoke: async (cmd: string, args?: unknown) => {
        calls.push({ cmd, args });
        return undefined;
      },
    } as Parameters<typeof installTransport>[0]);
    try {
      await api.ghPrCheckoutWorktree(
        REPO,
        7,
        "origin",
        "C:/repos/demo-pr-7",
        true,
        HEAD_A,
      );
    } finally {
      installTransport(previous);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("gh_pr_checkout_worktree");
    expect(Object.keys(calls[0]?.args as object).sort()).toEqual([
      "expectedHead",
      "force",
      "lens",
      "number",
      "path",
      "repoPath",
    ]);
    expect(calls[0]?.args).toMatchObject({ force: true, expectedHead: HEAD_A });
  });
});
