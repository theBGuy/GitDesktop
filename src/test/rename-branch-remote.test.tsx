import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler, type ReactNode } from "react";
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
import { useBranchCommitDraft } from "@/features/commit/useCommitSubmit";
import {
  type RemoteRenameOffer,
  RenameBranchDialog,
} from "@/features/repository/RenameBranchDialog";
import { GIT_PUSH_TIMEOUT_MESSAGE, presentError } from "@/lib/error-summary";
import {
  forgePrsOnRemoteBranch,
  gitBranches,
  gitRemoteRenameCheck,
  gitRenameBranch,
} from "@/lib/git/api";
import { remoteRenameCheckOptions, usePush } from "@/lib/git/queries";
import type {
  RemoteBranchPulls,
  RemoteRenameCheck,
  RemoteRenameOutcome,
  RemoteRenameRefusal,
} from "@/lib/git/types";
import { OFFLINE_WRITE_REASON } from "@/lib/offline-writes";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { commitDraftKey, useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

// The remote rename callee is reached only through its spy: publish-hold-routes
// lets no file but its one hook import it by name.
const renameRemoteSpy = vi.hoisted(() => vi.fn());
const gitRenameBranchRemote = renameRemoteSpy;
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitRemoteRenameCheck: vi.fn(),
  forgePrsOnRemoteBranch: vi.fn(),
  gitRenameBranchRemote: renameRemoteSpy,
  gitRenameBranch: vi.fn(),
  gitBranches: vi.fn(),
  gitPush: vi.fn(() => new Promise(() => undefined)),
}));
// A stand-in generator: the chord's dispatch is what these tests read.
const generateSpy = vi.hoisted(() => vi.fn(async () => undefined));
const cancelGenerate = vi.hoisted(() => () => undefined);
vi.mock(
  "@/features/repository/useGenerateBranchName",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/features/repository/useGenerateBranchName")
    >()),
    useGenerateBranchName: () => ({
      generate: generateSpy,
      cancel: cancelGenerate,
      generating: false,
    }),
  }),
);
// A second worktree of the dialog's repository.
const SIBLING = vi.hoisted(() => "C:/repos/ren-wt");
const identityOf = vi.hoisted(
  () => (path: string) => `${path === SIBLING ? "C:/repos/ren" : path}/.git`,
);
vi.mock("@/lib/git/repo-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/repo-identity")>()),
  peekRepoIdentity: identityOf,
  repoIdentityStrict: (path: string) => Promise.resolve(identityOf(path)),
}));
// The real promotion check unless a test flags a promote.
const promote = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/stores/worktree-removal", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/stores/worktree-removal")>();
  return {
    ...actual,
    promotionBlocksCheckout: (repoPath: string) =>
      promote.on || actual.promotionBlocksCheckout(repoPath),
  };
});

const REPO = "C:/repos/ren";
const OTHER = "C:/repos/elsewhere";
const TIP = "1111111111111111111111111111111111111111";
const TIP_B = "2222222222222222222222222222222222222222";
/** `text` closed by one period, as the dialog closes a summary. */
const closed = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);
const ORIGIN: RemoteRenameOffer = { remote: "origin", blocked: null };
/** One code point, two UTF-16 units. */
const ASTRAL = String.fromCodePoint(0x1f600);
/** A git failure longer than any line the dialog shows: four lines, the
 *  second one long. */
const LONG_UNREACHABLE = `fatal: one\nfatal: ${"x".repeat(1000)}\nfatal: three\nfatal: four`;
const LONG_UNREACHABLE_SHOWN = `Couldn't reach origin: one. ${"x".repeat(294)}…`;

afterAll(() => {
  expect(unmockedCommands).toEqual([]);
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const clear: RemoteRenameCheck = { status: "clear", oldTip: TIP };
const none: RemoteBranchPulls = {
  status: "checked",
  provider: "github",
  items: [],
  unchecked: [],
};
const refused = (refusal: RemoteRenameRefusal): RemoteRenameCheck => ({
  status: "refused",
  refusal,
});

let spies: Record<
  "success" | "warning" | "info" | "error",
  ReturnType<typeof vi.spyOn>
>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
  vi.mocked(gitRemoteRenameCheck).mockResolvedValue(clear);
  vi.mocked(forgePrsOnRemoteBranch).mockResolvedValue(none);
  vi.mocked(gitRenameBranchRemote).mockResolvedValue({
    status: "renamed",
    warning: null,
  });
  vi.mocked(gitRenameBranch).mockResolvedValue({ warning: null } as never);
  vi.mocked(gitBranches).mockResolvedValue([{ name: "feat" }] as never);
  spies = {
    success: vi.spyOn(toast, "success"),
    warning: vi.spyOn(toast, "warning"),
    info: vi.spyOn(toast, "info"),
    error: vi.spyOn(toast, "error"),
  };
  useUiStore.setState({ repoPath: REPO });
});
afterEach(() => {
  promote.on = false;
  onlineManager.setOnline(true);
  for (const s of Object.values(spies)) s.mockRestore();
});

type Props = {
  target: string | null;
  remoteRename: RemoteRenameOffer;
  repoPath: string;
  ai: boolean;
  /** False once a branch re-read no longer lists the target's upstream. */
  upstream: boolean;
};

/** Called after every commit under the dialog, portal included. */
let onCommit: (() => void) | null = null;
afterEach(() => {
  onCommit = null;
});

function renderDialog(
  initial: Partial<Props> = {},
  extra: () => ReactNode = () => null,
) {
  const user = userEvent.setup();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let props: Props = {
    target: "feat",
    remoteRename: ORIGIN,
    repoPath: REPO,
    ai: false,
    upstream: true,
    ...initial,
  };
  const onClose = vi.fn(() => rerenderWith({ target: null }));
  const view = () => (
    <QueryClientProvider client={queryClient}>
      <Profiler id="rename" onRender={() => onCommit?.()}>
        <RenameBranchDialog
          repoPath={props.repoPath}
          target={props.target}
          targetUpstream={
            !props.upstream ||
            (props.remoteRename === null && props.target === null)
              ? null
              : { remote: "origin", branch: props.target ?? "feat" }
          }
          remoteRename={props.remoteRename}
          currentName="main"
          onClose={onClose}
          aiEnabled={props.ai}
          aiConfigured={props.ai}
          hasChanges={false}
          headExists
          entries={[]}
          allBranchNames={["main", "feat"]}
          committedFallback={
            props.ai
              ? {
                  base: "main",
                  baseRev: "main",
                  compare: "feat",
                  subjects: ["x"],
                }
              : null
          }
          committedStatus="ready"
          onOpenSettings={() => undefined}
        />
      </Profiler>
      {extra()}
    </QueryClientProvider>
  );
  const { rerender } = render(view());
  function rerenderWith(next: Partial<Props>) {
    props = { ...props, ...next };
    rerender(view());
  }
  return {
    user,
    queryClient,
    onClose,
    rerenderWith: (p: Partial<Props>) => act(() => rerenderWith(p)),
    /** A repository switch as the app makes one: the store and the prop the
     *  view reads from it move in one commit. */
    switchRepo: (next: string) =>
      act(() => {
        useUiStore.setState({ repoPath: next });
        rerenderWith({ repoPath: next });
      }),
  };
}

type User = ReturnType<typeof userEvent.setup>;
const box = () => screen.getByRole("checkbox", { name: /Also rename on/ });
const nameField = () => screen.getByLabelText("New name");
// Ends with the label: a pending button's spinner leads its name.
const submit = () => screen.getByRole("button", { name: /Rename( anyway)?$/ });
/** The box's live region (the pending button's spinner is a status too). */
const status = () => {
  const region = screen
    .getAllByRole("status")
    .find((el) => el.closest("button") === null);
  if (!region) throw new Error("no status region");
  return region;
};
/** The unticked helper line, which renders outside the live region. */
const helper = () => screen.getByText(/ keeps its name and /);
/** The footer's Cancel, which reads Close while the remote step runs (the
 *  dialog's own X is also named Close). */
const footerClose = () =>
  screen
    .getAllByRole("button", { name: "Close" })
    .find(
      (b) => b.textContent === "Close" && b.querySelector(".sr-only") === null,
    ) ?? null;

async function rename(user: User, to = "feat2") {
  await user.clear(nameField());
  await user.type(nameField(), to);
}

/** Ticks the box and waits for the clear check over an empty lookup. */
async function tickClear(user: User) {
  await user.click(box());
  await screen.findByText(
    /^Pushes feat2 to origin, then deletes origin\//,
    undefined,
    {
      timeout: 2000,
    },
  );
}

/** The box's description is the reason alone; the dash before it is still
 *  shown, hidden from assistive tech. */
function expectBoxReason(reason: string) {
  expect(box()).toHaveAccessibleDescription(reason);
  const described = document.getElementById(
    box().getAttribute("aria-describedby") ?? "",
  );
  const dash = described?.previousElementSibling;
  expect(dash).toHaveAttribute("aria-hidden", "true");
  expect(dash).toHaveTextContent("—");
  expect(described?.parentElement).toHaveTextContent(`— ${reason}`);
}

/** Every held state: focusable, aria-disabled, never natively disabled. */
function expectHeld() {
  expect(submit()).not.toHaveAttribute("disabled");
  expect(submit()).toHaveAttribute("aria-disabled", "true");
}

describe("the box", () => {
  it("is absent without an offer, and the dialog reads as before", () => {
    renderDialog({ remoteRename: null });
    expect(screen.queryByRole("checkbox")).toBe(null);
    expect(
      screen.getByText(/Renaming changes only the local name/),
    ).toBeInTheDocument();
  });

  it("replaces the local-only sentence and starts unticked on every open", async () => {
    const { user, rerenderWith } = renderDialog();
    expect(screen.queryByText(/Renaming changes only the local name/)).toBe(
      null,
    );
    expect(box()).not.toBeChecked();
    expect(helper()).toHaveTextContent(
      "origin/feat keeps its name and the renamed branch keeps tracking it.",
    );
    expect(status()).not.toContainElement(helper());
    expect(status()).toBeEmptyDOMElement();
    await user.click(box());
    expect(box()).toBeChecked();
    rerenderWith({ target: "other" });
    await waitFor(() => expect(box()).not.toBeChecked());
  });

  it("never runs the remote step while unticked", async () => {
    const { user } = renderDialog();
    await rename(user);
    expect(helper()).toHaveTextContent(
      "origin/feat keeps its name and feat2 keeps tracking it.",
    );
    expect(status()).not.toContainElement(helper());
    await user.click(submit());
    await waitFor(() =>
      expect(gitRenameBranch).toHaveBeenCalledWith(REPO, "feat", "feat2"),
    );
    expect(gitRenameBranchRemote).not.toHaveBeenCalled();
    expect(gitRemoteRenameCheck).not.toHaveBeenCalled();
  });

  it.each<[string, RemoteRenameOffer, string]>([
    [
      "remoteDefault",
      { remote: "origin", blocked: "remoteDefault" },
      "feat is the default branch on origin",
    ],
    [
      "keepLocal",
      { remote: "origin", blocked: "keepLocal" },
      "feat is marked Keep local",
    ],
    [
      "pushesElsewhere",
      { remote: "origin", blocked: "pushesElsewhere", pushRemote: "fork" },
      "feat pushes to fork, not origin",
    ],
  ])(
    "is held for %s with its visible reason",
    async (_n, remoteRename, why) => {
      const { user } = renderDialog({ remoteRename });
      expect(box()).toHaveAttribute("aria-disabled", "true");
      expect(box()).toHaveAccessibleName("Also rename on origin");
      expectBoxReason(why);
      await user.click(box());
      expect(box()).not.toBeChecked();
    },
  );

  it("drops back to a local rename when it goes offline while ticked", async () => {
    const { user } = renderDialog();
    await rename(user);
    await tickClear(user);
    act(() => onlineManager.setOnline(false));
    expectBoxReason("you're offline");
    // Said in the live region, so the drop-back is announced.
    expect(status()).toHaveTextContent(
      "origin/feat keeps its name and feat2 keeps tracking it.",
    );
    await user.click(submit());
    await waitFor(() => expect(gitRenameBranch).toHaveBeenCalled());
    expect(gitRenameBranchRemote).not.toHaveBeenCalled();
  });

  it("keeps a ticked box ticked while the local-only rename it fell back to runs", async () => {
    const done = deferred<{ warning: null }>();
    vi.mocked(gitRenameBranch).mockReturnValue(done.promise as never);
    const { user } = renderDialog();
    await rename(user);
    await tickClear(user);
    act(() => onlineManager.setOnline(false));
    await user.click(submit());
    await waitFor(() => expect(gitRenameBranch).toHaveBeenCalled());
    expect(box()).toBeChecked();
    expect(box()).toHaveAttribute("aria-disabled", "true");
    expectBoxReason("Wait for the rename to finish");
    await user.click(box());
    expect(box()).toBeChecked();
    await act(async () => done.resolve({ warning: null }));
  });

  it("toggles on a Space pressed on it", async () => {
    const { user } = renderDialog();
    // After the dialog's own initial focus, which would otherwise land later.
    await waitFor(() => expect(nameField()).toHaveFocus());
    act(() => box().focus());
    await user.keyboard(" ");
    expect(box()).toBeChecked();
  });

  it("ignores the keyup of a Space pressed elsewhere", async () => {
    renderDialog();
    act(() => box().focus());
    act(() => {
      box().dispatchEvent(
        new KeyboardEvent("keyup", { key: " ", bubbles: true }),
      );
    });
    expect(box()).not.toBeChecked();
  });

  it("forgets the reads when unticked", async () => {
    const { user, queryClient } = renderDialog();
    await rename(user);
    await tickClear(user);
    const key = remoteRenameCheckOptions(
      REPO,
      "origin",
      "feat",
      "feat2",
    ).queryKey;
    expect(queryClient.getQueryData(key)).toEqual(clear);
    await user.click(box());
    expect(box()).not.toBeChecked();
    expect(queryClient.getQueryData(key)).toBe(undefined);
    // The still-mounted, disabled observer re-creates an empty entry at once,
    // so the data is what must be gone.
    expect(
      queryClient.getQueryCache().find({ queryKey: key })?.state.data,
    ).toBe(undefined);
  });

  it("hands focus to the name field when it disappears while focused", async () => {
    const { rerenderWith } = renderDialog();
    act(() => box().focus());
    rerenderWith({ remoteRename: null });
    expect(screen.queryByRole("checkbox")).toBe(null);
    expect(nameField()).toHaveFocus();
  });
});

/** Re-reads every query of `repo` the way a refocus does, then lets it settle. */
async function refetchRepo(queryClient: QueryClient, repo = REPO) {
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ["repo", repo] });
  });
}

const readCalls = () =>
  vi.mocked(gitRemoteRenameCheck).mock.calls.length +
  vi.mocked(forgePrsOnRemoteBranch).mock.calls.length;

describe("the tick and the reads belong to one open dialog", () => {
  it("runs no read once the dialog is cancelled", async () => {
    const { user, queryClient } = renderDialog();
    await rename(user);
    await tickClear(user);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));
    const before = readCalls();
    await refetchRepo(queryClient);
    expect(readCalls()).toBe(before);
  });

  it("runs no read after a completed remote rename, and reopens unticked", async () => {
    const { user, queryClient, rerenderWith } = renderDialog();
    await rename(user);
    await tickClear(user);
    await user.click(submit());
    await waitFor(() => expect(spies.success).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));
    const before = readCalls();
    await refetchRepo(queryClient);
    expect(readCalls()).toBe(before);
    rerenderWith({ target: "feat" });
    await waitFor(() => expect(box()).not.toBeChecked());
    expect(readCalls()).toBe(before);
    rerenderWith({ target: null });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));
    rerenderWith({ target: "topic" });
    await waitFor(() => expect(box()).not.toBeChecked());
    expect(screen.queryByText(/^Renaming /)).toBe(null);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(submit()).toHaveTextContent(/^Rename$/);
  });

  it("drops the tick when the repository changes under the open dialog", async () => {
    const { user, rerenderWith } = renderDialog();
    await rename(user);
    await tickClear(user);
    rerenderWith({ repoPath: OTHER });
    expect(box()).not.toBeChecked();
    await new Promise((r) => setTimeout(r, 500));
    expect(
      vi.mocked(gitRemoteRenameCheck).mock.calls.some((c) => c[0] === OTHER),
    ).toBe(false);
    expect(
      vi.mocked(forgePrsOnRemoteBranch).mock.calls.some((c) => c[0] === OTHER),
    ).toBe(false);
  });

  it.each([
    [
      "the host drops the target",
      false,
      "Didn't rename feat: origin/feat no longer exists.",
    ],
    [
      "the repository switches",
      true,
      "Didn't rename feat in ren: origin/feat no longer exists.",
    ],
  ] as const)(
    "toasts a refusal that settles after %s",
    async (_n, switches, text) => {
      const act$ = deferred<RemoteRenameOutcome>();
      vi.mocked(gitRenameBranchRemote).mockReturnValue(act$.promise);
      const { user, rerenderWith, switchRepo } = renderDialog();
      await rename(user);
      await tickClear(user);
      await user.click(submit());
      await waitFor(() => expect(footerClose()).not.toBe(null));
      if (switches) switchRepo(OTHER);
      else rerenderWith({ target: null });
      await act(async () =>
        act$.resolve({ status: "refused", refusal: { code: "remoteGone" } }),
      );
      await waitFor(() => expect(spies.info).toHaveBeenCalledTimes(1));
      expect(spies.info).toHaveBeenCalledWith(text);
    },
  );

  it("drops the tick when the offer leaves and comes back", async () => {
    const { user, rerenderWith } = renderDialog();
    await rename(user);
    await tickClear(user);
    rerenderWith({ remoteRename: null });
    rerenderWith({ remoteRename: ORIGIN });
    expect(box()).not.toBeChecked();
  });
});

describe("a running remote rename stays on screen", () => {
  it("keeps the box, the running line and Close when a re-read drops the offer", async () => {
    const act$ = deferred<RemoteRenameOutcome>();
    vi.mocked(gitRenameBranchRemote).mockReturnValue(act$.promise);
    const { user, rerenderWith } = renderDialog();
    await rename(user);
    await tickClear(user);
    await user.click(submit());
    await waitFor(() => expect(footerClose()).not.toBe(null));
    const focused = document.activeElement;
    rerenderWith({ remoteRename: null });
    expect(box()).toBeChecked();
    expect(box()).toHaveAttribute("aria-disabled", "true");
    expect(status()).toHaveTextContent("Renaming feat to feat2 on origin…");
    expect(footerClose()).not.toBe(null);
    expect(document.activeElement).toBe(focused);
    await act(async () => act$.resolve({ status: "renamed", warning: null }));
  });

  it("shows the running state when reopened on the new name", async () => {
    const act$ = deferred<RemoteRenameOutcome>();
    vi.mocked(gitRenameBranchRemote).mockReturnValue(act$.promise);
    const { user, onClose, rerenderWith } = renderDialog();
    await rename(user);
    await tickClear(user);
    await user.click(submit());
    await waitFor(() => expect(footerClose()).not.toBe(null));
    await user.click(footerClose() as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));
    rerenderWith({ target: "feat2", remoteRename: null });
    await waitFor(() =>
      expect(status()).toHaveTextContent("Renaming feat to feat2 on origin…"),
    );
    expect(box()).toBeChecked();
    expectHeld();
    expect(submit()).toHaveAccessibleDescription(
      "Wait for the rename to finish",
    );
    const closes = onClose.mock.calls.length;
    await act(async () => act$.resolve({ status: "renamed", warning: null }));
    // The settle closes it like the pressing dialog.
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(closes + 1));
  });

  it("keeps what it showed at the press when the re-read drops the old name", async () => {
    vi.mocked(forgePrsOnRemoteBranch).mockResolvedValue({
      status: "checked",
      provider: "github",
      items: [
        {
          number: 7,
          title: "Feature",
          url: "u",
          isDraft: false,
          scope: "repository",
          repo: "a/b",
        },
      ],
      unchecked: [],
    });
    const act$ = deferred<RemoteRenameOutcome>();
    vi.mocked(gitRenameBranchRemote).mockReturnValue(act$.promise);
    const { user, rerenderWith } = renderDialog();
    await rename(user);
    await user.click(box());
    await waitFor(
      () => expect(submit()).toHaveAttribute("aria-disabled", "false"),
      { timeout: 2000 },
    );
    expect(submit()).toHaveTextContent(/Rename anyway$/);
    await user.click(submit());
    await waitFor(() => expect(footerClose()).not.toBe(null));
    rerenderWith({ remoteRename: null, upstream: false });
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
      "Renames feat. feat tracks origin/feat.",
    );
    expect(submit()).toHaveTextContent(/Rename anyway$/);
    expectHeld();
    expect(box()).toBeChecked();
    expect(box()).toHaveAttribute("aria-disabled", "true");
    expect(status()).toHaveTextContent("Renaming feat to feat2 on origin…");
    expect(footerClose()).not.toBe(null);
    await act(async () => act$.resolve({ status: "renamed", warning: null }));
  });
});

/** One commit's view of the open popup; null once it is gone. */
type Frame = {
  closed: boolean;
  description: string;
  running: boolean;
  box: string | null;
  held: boolean;
  enabled: string[];
  /** The name field's value. */
  name: string | null;
} | null;

function frame(closed: boolean): Frame {
  const dialog = document.querySelector('[role="dialog"]');
  if (dialog === null) return null;
  const submits = [...dialog.querySelectorAll("button")].filter((b) =>
    /Rename( anyway)?$/.test(b.textContent?.trim() ?? ""),
  );
  const isHeld = (b: HTMLButtonElement) =>
    b.disabled || b.getAttribute("aria-disabled") === "true";
  return {
    closed,
    description:
      document.getElementById(dialog.getAttribute("aria-describedby") ?? "")
        ?.textContent ?? "",
    running:
      dialog.textContent?.includes("Renaming feat to feat2 on origin…") ??
      false,
    box:
      dialog.querySelector('[role="checkbox"]')?.getAttribute("aria-checked") ??
      null,
    held: submits.length === 1 && isHeld(submits[0]),
    enabled: submits
      .filter((b) => !isHeld(b))
      .map((b) => b.textContent?.trim() ?? ""),
    name: screen.queryByLabelText<HTMLInputElement>("New name")?.value ?? null,
  };
}

describe("a settled rename leaves without a reset frame", () => {
  it.each<[string, RemoteRenameOutcome]>([
    ["renamed", { status: "renamed", warning: null }],
    [
      "old name kept",
      { status: "oldKept", warning: null, cause: { reason: "moved" } },
    ],
    [
      "push failed",
      {
        status: "pushFailed",
        warning: null,
        error: { kind: "git", message: "rejected" } as never,
      },
    ],
  ])(
    "%s keeps the running presentation until the popup is gone",
    async (_n, outcome) => {
      const act$ = deferred<RemoteRenameOutcome>();
      vi.mocked(gitRenameBranchRemote).mockReturnValue(act$.promise);
      const { user, onClose, rerenderWith } = renderDialog();
      await rename(user);
      await tickClear(user);
      await user.click(submit());
      await waitFor(() => expect(footerClose()).not.toBe(null));
      rerenderWith({ remoteRename: null, upstream: false });
      const frames: Frame[] = [];
      onCommit = () => {
        frames.push(frame(onClose.mock.calls.length > 0));
      };
      await act(async () => act$.resolve(outcome));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));
      expect(onClose).toHaveBeenCalledTimes(1);
      const shown = frames.filter((f) => f !== null);
      // The retained closing frame: closed by the settle, the popup still up.
      expect(shown.filter((f) => f.closed).length).toBeGreaterThan(0);
      for (const f of shown)
        expect(f).toEqual({
          closed: f.closed,
          description: "Renames feat. feat tracks origin/feat.",
          running: true,
          box: "true",
          held: true,
          enabled: [],
          name: "feat2",
        });
    },
  );

  it.each<[string, RemoteRenameOffer]>([
    ["with the box unticked", ORIGIN],
    ["without a box", null],
  ])(
    "a local-only rename %s keeps Rename held until the popup is gone",
    async (_n, remoteRename) => {
      const done = deferred<{ warning: null }>();
      vi.mocked(gitRenameBranch).mockReturnValue(done.promise as never);
      const { user, onClose } = renderDialog({ remoteRename });
      await rename(user);
      const frames: Frame[] = [];
      onCommit = () => {
        frames.push(frame(onClose.mock.calls.length > 0));
      };
      await user.click(submit());
      await waitFor(() =>
        expect(gitRenameBranch).toHaveBeenCalledWith(REPO, "feat", "feat2"),
      );
      await act(async () => done.resolve({ warning: null }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(spies.success).toHaveBeenCalledWith("Renamed to feat2", {
        description: undefined,
      });
      // From the commit the press holds Rename in (the click's own pointer
      // commits come before it).
      const shown = frames.filter((f) => f !== null);
      const pressed = shown.findIndex((f) => f.held);
      expect(pressed).toBeGreaterThanOrEqual(0);
      expect(shown.filter((f) => f.closed).length).toBeGreaterThan(0);
      for (const f of shown.slice(pressed))
        expect(f).toMatchObject({ held: true, enabled: [], name: "feat2" });
    },
  );

  it("gives the form back when a local-only rename fails", async () => {
    vi.mocked(gitRenameBranch).mockRejectedValue({
      kind: "git",
      message: "cannot lock ref",
    });
    const { user, onClose } = renderDialog();
    await rename(user);
    await user.click(submit());
    await waitFor(() => expect(spies.error).toHaveBeenCalled());
    await waitFor(() =>
      expect(submit()).not.toHaveAttribute("aria-disabled", "true"),
    );
    expect(submit()).not.toHaveAttribute("disabled");
    expect(onClose).not.toHaveBeenCalled();
    expect(nameField()).toHaveValue("feat2");
  });

  it("holds the box through a local-only rename and runs no read for it", async () => {
    const done = deferred<{ warning: null }>();
    vi.mocked(gitRenameBranch).mockReturnValue(done.promise as never);
    const { user } = renderDialog();
    await rename(user);
    await user.click(submit());
    await waitFor(() => expect(gitRenameBranch).toHaveBeenCalled());
    expect(box()).toHaveAttribute("aria-disabled", "true");
    expectBoxReason("Wait for the rename to finish");
    await user.click(box());
    expect(box()).not.toBeChecked();
    box().focus();
    await user.keyboard(" ");
    expect(box()).not.toBeChecked();
    expect(gitRemoteRenameCheck).not.toHaveBeenCalled();
    expect(forgePrsOnRemoteBranch).not.toHaveBeenCalled();
    await act(async () => done.reject({ kind: "git", message: "locked" }));
    await waitFor(() =>
      expect(box()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await user.click(box());
    expect(box()).toBeChecked();
  });

  it("holds Rename and the box through a local-only rename when an older remote rename settles first", async () => {
    const act$ = deferred<RemoteRenameOutcome>();
    vi.mocked(gitRenameBranchRemote).mockReturnValue(act$.promise);
    const local$ = deferred<{ warning: null }>();
    vi.mocked(gitRenameBranch).mockReturnValue(local$.promise as never);
    const { user, rerenderWith } = renderDialog();
    await rename(user);
    await tickClear(user);
    await user.click(submit());
    await waitFor(() => expect(footerClose()).not.toBe(null));
    await user.click(footerClose() as HTMLElement);
    rerenderWith({ target: "topic" });
    await waitFor(() => expect(nameField()).toHaveValue("topic"));
    await rename(user, "topic2");
    await user.click(submit());
    await waitFor(() =>
      expect(gitRenameBranch).toHaveBeenCalledWith(REPO, "topic", "topic2"),
    );
    // The older submit's settle clears form-core's one `isSubmitting`.
    await act(async () => act$.resolve({ status: "renamed", warning: null }));
    await waitFor(() => expect(spies.success).toHaveBeenCalled());
    expectHeld();
    expect(submit()).toHaveAccessibleDescription(
      "Wait for the rename to finish",
    );
    expectBoxReason("Wait for the rename to finish");
    await act(async () => local$.resolve({ warning: null }));
  });

  it("holds only the repository a local-only rename runs in", async () => {
    const local$ = deferred<{ warning: null }>();
    vi.mocked(gitRenameBranch).mockReturnValue(local$.promise as never);
    const { user, rerenderWith, switchRepo } = renderDialog();
    await rename(user);
    await user.click(submit());
    await waitFor(() =>
      expect(gitRenameBranch).toHaveBeenCalledWith(REPO, "feat", "feat2"),
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    switchRepo(OTHER);
    rerenderWith({ target: "feat" });
    await rename(user, "feat3");
    await waitFor(() =>
      expect(submit()).toHaveAttribute("aria-disabled", "false"),
    );
    expect(box()).not.toHaveAttribute("aria-disabled", "true");
    // Back where it runs, the same dialog holds again.
    switchRepo(REPO);
    await waitFor(() => expectHeld());
    expect(submit()).toHaveAccessibleDescription(
      "Wait for the rename to finish",
    );
    await act(async () => local$.resolve({ warning: null }));
  });
});

describe("the check and the lookup", () => {
  it("holds Rename while either read is pending, then offers the plain rename", async () => {
    const check = deferred<RemoteRenameCheck>();
    const pulls = deferred<RemoteBranchPulls>();
    vi.mocked(gitRemoteRenameCheck).mockReturnValue(check.promise);
    vi.mocked(forgePrsOnRemoteBranch).mockReturnValue(pulls.promise);
    const { user } = renderDialog();
    await rename(user);
    await user.click(box());
    expect(status()).toHaveTextContent("Checking origin…");
    expectHeld();
    await act(async () => check.resolve(clear));
    expect(status()).toHaveTextContent("Checking origin…");
    await act(async () => pulls.resolve(none));
    await waitFor(
      () =>
        expect(status()).toHaveTextContent(
          "Pushes feat2 to origin, then deletes origin/feat.",
        ),
      { timeout: 2000 },
    );
    expect(status()).toHaveTextContent("No open pull request uses feat.");
    expect(submit()).toHaveTextContent(/^Rename$/);
    expect(forgePrsOnRemoteBranch).toHaveBeenCalledTimes(1);
    expect(gitRemoteRenameCheck).toHaveBeenLastCalledWith(
      REPO,
      "feat",
      "feat2",
      "origin",
    );
  });

  it("never submits on Enter while checking", async () => {
    // The check answers, so the press has a tip: only the hold stops it.
    vi.mocked(forgePrsOnRemoteBranch).mockReturnValue(
      deferred<RemoteBranchPulls>().promise,
    );
    const { user, queryClient } = renderDialog();
    await rename(user);
    await user.click(box());
    // The check's answer is in, so the press would have a tip to send.
    const key = remoteRenameCheckOptions(
      REPO,
      "origin",
      "feat",
      "feat2",
    ).queryKey;
    await waitFor(() => expect(queryClient.getQueryData(key)).toEqual(clear), {
      timeout: 2000,
    });
    expect(status()).toHaveTextContent("Checking origin…");
    await user.type(nameField(), "{Enter}");
    expect(gitRenameBranchRemote).not.toHaveBeenCalled();
    expect(gitRenameBranch).not.toHaveBeenCalled();
  });

  it("never submits on a held Enter's repeats once the check clears, only on a fresh press", async () => {
    const check = deferred<RemoteRenameCheck>();
    const pulls = deferred<RemoteBranchPulls>();
    vi.mocked(gitRemoteRenameCheck).mockReturnValue(check.promise);
    vi.mocked(forgePrsOnRemoteBranch).mockReturnValue(pulls.promise);
    const { user } = renderDialog();
    await rename(user);
    await user.click(box());
    await waitFor(() => expect(gitRemoteRenameCheck).toHaveBeenCalled(), {
      timeout: 2000,
    });
    nameField().focus();
    // Pressed while checking, and still held when the check clears.
    await user.keyboard("{Enter>}");
    await act(async () => {
      check.resolve(clear);
      pulls.resolve(none);
    });
    await within(status()).findByText(
      "Pushes feat2 to origin, then deletes origin/feat.",
      undefined,
      { timeout: 2000 },
    );
    const repeat = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      nameField().dispatchEvent(repeat);
      // A browser submits the form implicitly on an Enter nothing prevented.
      if (!repeat.defaultPrevented)
        (nameField() as HTMLInputElement).form?.requestSubmit();
    });
    expect(repeat.defaultPrevented).toBe(true);
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(gitRenameBranchRemote).not.toHaveBeenCalled();
    expect(gitRenameBranch).not.toHaveBeenCalled();
    await user.keyboard("{/Enter}{Enter}");
    await waitFor(() =>
      expect(gitRenameBranchRemote).toHaveBeenCalledWith(
        REPO,
        "feat",
        "feat2",
        "origin",
        TIP,
      ),
    );
  });

  it.each([
    ["unchanged", null],
    ["empty", ""],
  ] as const)(
    "names the renamed branch when the field is %s",
    async (_n, to) => {
      const { user } = renderDialog();
      if (to !== null) await user.clear(nameField());
      await user.click(box());
      await within(status()).findByText(
        "Pushes the renamed branch to origin, then deletes origin/feat.",
        undefined,
        { timeout: 2000 },
      );
    },
  );

  it("keeps its answer on screen through a background re-read", async () => {
    const { user, queryClient } = renderDialog();
    await rename(user);
    await tickClear(user);
    const again = deferred<RemoteRenameCheck>();
    vi.mocked(gitRemoteRenameCheck).mockReturnValue(again.promise);
    const pullsAgain = deferred<RemoteBranchPulls>();
    vi.mocked(forgePrsOnRemoteBranch).mockReturnValue(pullsAgain.promise);
    const calls = vi.mocked(gitRemoteRenameCheck).mock.calls.length;
    act(() => {
      void queryClient.invalidateQueries({ queryKey: ["repo", REPO] });
    });
    await waitFor(() =>
      expect(vi.mocked(gitRemoteRenameCheck).mock.calls.length).toBe(calls + 1),
    );
    expect(status()).toHaveTextContent(
      "Pushes feat2 to origin, then deletes origin/feat.",
    );
    expect(status()).not.toHaveTextContent("Checking origin…");
    expect(submit()).toHaveAttribute("aria-disabled", "false");
    await act(async () => {
      again.resolve(clear);
      pullsAgain.resolve(none);
    });
  });

  /** Started from outside the modal: another worktree's push of `feat`. */
  let startSiblingPush: (() => void) | null = null;
  function SiblingPusher() {
    const siblingPush = usePush(SIBLING);
    startSiblingPush = () =>
      void siblingPush.mutateAsync({ setUpstream: false, branch: "feat" });
    return null;
  }

  const openOne: RemoteBranchPulls = {
    status: "checked",
    provider: "github",
    items: [
      {
        number: 7,
        title: "Opened meanwhile",
        url: "u",
        isDraft: false,
        scope: "repository",
        repo: "a/b",
      },
    ],
    unchecked: [],
  };

  it("re-reads the lookup at a plain Rename and asks for Rename anyway when a request appeared", async () => {
    const { user } = renderDialog();
    await rename(user);
    await tickClear(user);
    expect(submit()).toHaveTextContent(/^Rename$/);
    const fresh = deferred<RemoteBranchPulls>();
    vi.mocked(forgePrsOnRemoteBranch).mockReturnValue(fresh.promise);
    await user.click(submit());
    // Held through the re-read as through the act.
    expect(status()).toHaveTextContent("Renaming feat to feat2 on origin…");
    expectHeld();
    await act(async () => fresh.resolve(openOne));
    await waitFor(() => expect(submit()).toHaveTextContent("Rename anyway"));
    expect(status()).toHaveTextContent("Opened meanwhile");
    expect(submit()).toHaveAttribute("aria-disabled", "false");
    expect(gitRenameBranchRemote).not.toHaveBeenCalled();
    // The pressing dialog shows the answer itself.
    expect(spies.info).not.toHaveBeenCalled();
    // An Enter still held from the press never presses the confirm.
    const repeat = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      submit().dispatchEvent(repeat);
    });
    expect(repeat.defaultPrevented).toBe(true);
  });

  it("renames once when a plain Rename's re-read finds no request", async () => {
    const { user } = renderDialog();
    await rename(user);
    await tickClear(user);
    const lookups = vi.mocked(forgePrsOnRemoteBranch).mock.calls.length;
    await user.click(submit());
    await waitFor(() => expect(gitRenameBranchRemote).toHaveBeenCalledTimes(1));
    expect(gitRenameBranchRemote).toHaveBeenCalledWith(
      REPO,
      "feat",
      "feat2",
      "origin",
      TIP,
    );
    const lookupOrder = vi.mocked(forgePrsOnRemoteBranch).mock
      .invocationCallOrder;
    expect(lookupOrder.length).toBe(lookups + 1);
    expect(lookupOrder[lookups]).toBeLessThan(
      vi.mocked(gitRenameBranchRemote).mock.invocationCallOrder[0],
    );
  });

  it("never renames when a plain Rename's re-read fails, and offers Retry", async () => {
    const { user } = renderDialog();
    await rename(user);
    await tickClear(user);
    vi.mocked(forgePrsOnRemoteBranch)
      .mockRejectedValueOnce({ kind: "git", message: "fatal: boom" })
      .mockReturnValue(deferred<RemoteBranchPulls>().promise);
    await user.click(submit());
    await within(status()).findByText(/^Couldn't check origin: /, undefined, {
      timeout: 2000,
    });
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expectHeld();
    expect(gitRenameBranchRemote).not.toHaveBeenCalled();
    expect(spies.info).not.toHaveBeenCalled();
  });

  it.each<
    [
      string,
      (d: ReturnType<typeof deferred<RemoteBranchPulls>>) => void,
      string,
    ]
  >([
    [
      "needs the confirm",
      (d) => d.resolve(openOne),
      "Didn't rename feat: the open-request check on origin now needs your confirmation. Open Rename again to see it.",
    ],
    [
      "fails",
      (d) => d.reject({ kind: "git", message: "fatal: boom" }),
      "Didn't rename feat: couldn't check origin for open requests. Open Rename again to retry.",
    ],
  ])(
    "toasts a plain Rename whose dialog was closed during a re-read that %s",
    async (_n, settle, text) => {
      const { user, rerenderWith } = renderDialog();
      await rename(user);
      await tickClear(user);
      const fresh = deferred<RemoteBranchPulls>();
      vi.mocked(forgePrsOnRemoteBranch).mockReturnValue(fresh.promise);
      await user.click(submit());
      expect(status()).toHaveTextContent("Renaming feat to feat2 on origin…");
      rerenderWith({ target: null });
      await act(async () => settle(fresh));
      await waitFor(() => expect(spies.info).toHaveBeenCalledWith(text));
      expect(spies.info).toHaveBeenCalledTimes(1);
      expect(gitRenameBranchRemote).not.toHaveBeenCalled();
    },
  );

  it("toasts a plain Rename whose dialog was reopened on another branch during the re-read, and leaves that dialog alone", async () => {
    const { user, onClose, rerenderWith } = renderDialog();
    await rename(user);
    await tickClear(user);
    const fresh = deferred<RemoteBranchPulls>();
    vi.mocked(forgePrsOnRemoteBranch).mockReturnValue(fresh.promise);
    await user.click(submit());
    rerenderWith({ target: null });
    rerenderWith({ target: "topic" });
    await waitFor(() => expect(nameField()).toHaveValue("topic"));
    const closes = onClose.mock.calls.length;
    await act(async () => fresh.resolve(openOne));
    await waitFor(() =>
      expect(spies.info).toHaveBeenCalledWith(
        "Didn't rename feat: the open-request check on origin now needs your confirmation. Open Rename again to see it.",
      ),
    );
    expect(gitRenameBranchRemote).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(closes);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(nameField()).toHaveValue("topic");
    expect(nameField()).not.toHaveAttribute("readonly");
    expect(box()).not.toBeChecked();
  });

  it.each<
    [
      string,
      (d: ReturnType<typeof deferred<RemoteBranchPulls>>) => void,
      () => Promise<unknown>,
    ]
  >([
    [
      "needs the confirm",
      (d) => d.resolve(openOne),
      () => waitFor(() => expect(submit()).toHaveTextContent("Rename anyway")),
    ],
    [
      "fails",
      (d) => d.reject({ kind: "git", message: "fatal: boom" }),
      () =>
        within(status()).findByText(/^Couldn't check origin: /, undefined, {
          timeout: 2000,
        }),
    ],
  ])(
    "shows the running rename in a dialog reopened on the same branch during a re-read that %s, then gives it the answer",
    async (_n, settle, answered) => {
      const { user, onClose, rerenderWith } = renderDialog();
      await rename(user);
      await tickClear(user);
      const fresh = deferred<RemoteBranchPulls>();
      vi.mocked(forgePrsOnRemoteBranch).mockReturnValue(fresh.promise);
      await user.click(submit());
      rerenderWith({ target: null });
      rerenderWith({ target: "feat" });
      await waitFor(() => expect(nameField()).toHaveValue("feat2"));
      expect(status()).toHaveTextContent("Renaming feat to feat2 on origin…");
      expect(box()).toBeChecked();
      expect(nameField()).toHaveAttribute("readonly");
      expectHeld();
      const closes = onClose.mock.calls.length;
      await act(async () => settle(fresh));
      await answered();
      expect(box()).toBeChecked();
      expect(nameField()).toHaveValue("feat2");
      expect(nameField()).not.toHaveAttribute("readonly");
      expect(gitRenameBranchRemote).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledTimes(closes);
      expect(spies.info).not.toHaveBeenCalled();
    },
  );

  it("holds a dialog reopened on another branch during the re-read, then renames the pressed branch", async () => {
    const { user, onClose, rerenderWith } = renderDialog();
    await rename(user);
    await tickClear(user);
    const fresh = deferred<RemoteBranchPulls>();
    vi.mocked(forgePrsOnRemoteBranch).mockReturnValue(fresh.promise);
    await user.click(submit());
    rerenderWith({ target: null });
    rerenderWith({ target: "topic" });
    await waitFor(() => expect(nameField()).toHaveValue("topic"));
    expect(box()).not.toBeChecked();
    expect(box()).toHaveAttribute("aria-readonly", "true");
    expectBoxReason("Another branch is being renamed on its remote");
    const closes = onClose.mock.calls.length;
    await act(async () => fresh.resolve(none));
    await waitFor(() => expect(gitRenameBranchRemote).toHaveBeenCalledTimes(1));
    expect(gitRenameBranchRemote).toHaveBeenCalledWith(
      REPO,
      "feat",
      "feat2",
      "origin",
      TIP,
    );
    expect(onClose).toHaveBeenCalledTimes(closes);
    expect(nameField()).toHaveValue("topic");
  });

  it.each<[string, () => void, string]>([
    [
      "the connection dropped",
      () => onlineManager.setOnline(false),
      OFFLINE_WRITE_REASON,
    ],
    [
      "another worktree started a push of the branch",
      () => startSiblingPush?.(),
      "Another worktree is pushing this branch. Wait for that push to finish.",
    ],
    [
      "a promote started",
      () => {
        promote.on = true;
      },
      "A worktree is being promoted to your main workspace. Try again once it finishes.",
    ],
  ])(
    "never renames when %s during a plain Rename's re-read",
    async (_n, during, message) => {
      const { user } = renderDialog({}, () => <SiblingPusher />);
      await rename(user);
      await tickClear(user);
      const fresh = deferred<RemoteBranchPulls>();
      vi.mocked(forgePrsOnRemoteBranch).mockReturnValue(fresh.promise);
      await user.click(submit());
      await act(async () => during());
      await act(async () => fresh.resolve(none));
      await waitFor(() => expect(spies.info).toHaveBeenCalledWith(message));
      expect(spies.info).toHaveBeenCalledTimes(1);
      expect(gitRenameBranchRemote).not.toHaveBeenCalled();
      expect(
        screen.queryByText("Renaming feat to feat2 on origin…"),
      ).toBeNull();
    },
  );

  it("never renames once the repository was switched away and back during a plain Rename's re-read", async () => {
    const { user, rerenderWith, switchRepo } = renderDialog();
    await rename(user);
    await tickClear(user);
    const fresh = deferred<RemoteBranchPulls>();
    vi.mocked(forgePrsOnRemoteBranch).mockReturnValue(fresh.promise);
    await user.click(submit());
    // The switch closes the dialog, as the branch menu does.
    await switchRepo(OTHER);
    rerenderWith({ target: null });
    await switchRepo(REPO);
    await act(async () => fresh.resolve(none));
    await waitFor(() =>
      expect(spies.info).toHaveBeenCalledWith(
        "You switched repositories before the rename started — nothing was renamed.",
      ),
    );
    expect(spies.info).toHaveBeenCalledTimes(1);
    expect(gitRenameBranchRemote).not.toHaveBeenCalled();
  });

  it("never renames in the repository switched to during a plain Rename's re-read", async () => {
    const { user, switchRepo } = renderDialog();
    await rename(user);
    await tickClear(user);
    const fresh = deferred<RemoteBranchPulls>();
    vi.mocked(forgePrsOnRemoteBranch).mockReturnValue(fresh.promise);
    await user.click(submit());
    await switchRepo(OTHER);
    await act(async () => fresh.resolve(none));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(gitRenameBranchRemote).not.toHaveBeenCalled();
    expect(spies.info).toHaveBeenCalledWith(
      "You switched repositories before the rename started — nothing was renamed in ren.",
    );
  });

  it("never checks the previous session's name right after a reseed", async () => {
    const { user, rerenderWith } = renderDialog();
    await rename(user);
    // Past the debounce, so the typed name is the settled one.
    await act(() => new Promise((r) => setTimeout(r, 500)));
    vi.mocked(gitRemoteRenameCheck).mockClear();
    // A retarget reseeds the field while the old name is still settling.
    rerenderWith({ target: "other" });
    expect(nameField()).toHaveValue("other");
    act(() => box().click());
    expect(box()).toBeChecked();
    await within(status()).findByText(
      "Pushes the renamed branch to origin, then deletes origin/other.",
      undefined,
      { timeout: 2000 },
    );
    expect(gitRemoteRenameCheck).toHaveBeenCalled();
    for (const c of vi.mocked(gitRemoteRenameCheck).mock.calls)
      expect(c.slice(1, 3)).toEqual(["other", null]);
  });

  it("never re-runs the lookup on a name edit", async () => {
    const { user } = renderDialog();
    await rename(user);
    await tickClear(user);
    await user.type(nameField(), "x");
    await screen.findByText(/^Pushes feat2x to origin/, undefined, {
      timeout: 2000,
    });
    expect(forgePrsOnRemoteBranch).toHaveBeenCalledTimes(1);
  });

  it("renames on the remote with the tip the check read", async () => {
    const { user } = renderDialog();
    await rename(user);
    await tickClear(user);
    await user.click(submit());
    await waitFor(() =>
      expect(gitRenameBranchRemote).toHaveBeenCalledWith(
        REPO,
        "feat",
        "feat2",
        "origin",
        TIP,
      ),
    );
    expect(gitRenameBranch).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(spies.success).toHaveBeenCalledWith(
        "Renamed to feat2 here and on origin",
        { description: undefined },
      ),
    );
  });

  it.each<[string, RemoteRenameRefusal, string]>([
    [
      "remoteAhead",
      { code: "remoteAhead" },
      "origin/feat has commits this branch doesn't have. Pull first, or untick to rename only here.",
    ],
    [
      "newExists",
      { code: "newExists" },
      "feat2 already exists on origin. Choose another name, or untick to rename only here.",
    ],
    [
      "unreachable",
      { code: "unreachable", detail: "Could not read from remote repository." },
      "Couldn't reach origin: Could not read from remote repository. Untick to rename only here.",
    ],
    [
      "unreachable bare",
      { code: "unreachable", detail: "unable to access" },
      "Couldn't reach origin: unable to access. Untick to rename only here.",
    ],
    [
      "unreachable ending in a colon",
      { code: "unreachable", detail: "fatal: Policy check failed:" },
      "Couldn't reach origin: Policy check failed. Untick to rename only here.",
    ],
    [
      "pushesElsewhere",
      { code: "pushesElsewhere", pushRemote: "fork" },
      "feat pushes to fork, not origin. Untick to rename only here.",
    ],
    [
      "unreachable long",
      { code: "unreachable", detail: LONG_UNREACHABLE },
      `${LONG_UNREACHABLE_SHOWN} Untick to rename only here.`,
    ],
    [
      "mirror",
      { code: "mirror" },
      "origin is a mirror remote, so GitDesktop won't push to it. Untick to rename only here.",
    ],
    [
      "pushUrlDiffers",
      { code: "pushUrlDiffers" },
      "origin pushes to a different address than it fetches from, so GitDesktop can't check it first. Untick to rename only here.",
    ],
    [
      "caseOnly",
      { code: "caseOnly" },
      "A rename that changes only letter case can't be done on origin, because this computer's file system ignores letter case in branch names. Untick to rename only here.",
    ],
    [
      "newNotFetched",
      { code: "newNotFetched" },
      "This clone fetches only certain branches from origin, and feat2 isn't one of them. Untick to rename only here.",
    ],
    [
      "remoteDefault",
      { code: "remoteDefault" },
      "feat is the default branch on origin. Untick to rename only here.",
    ],
    [
      "remoteGone",
      { code: "remoteGone" },
      "origin/feat no longer exists. Untick to rename only here.",
    ],
    [
      "notTracking",
      { code: "notTracking" },
      "feat no longer tracks origin/feat. Untick to rename only here.",
    ],
    [
      "keepLocal",
      { code: "keepLocal" },
      "feat is marked Keep local. Untick to rename only here.",
    ],
  ])(
    "refused %s: its own sentence holds Rename and Enter",
    async (_n, refusal, text) => {
      vi.mocked(gitRemoteRenameCheck).mockResolvedValue(refused(refusal));
      const { user } = renderDialog();
      await rename(user);
      await user.click(box());
      await within(status()).findByText(text, undefined, { timeout: 2000 });
      expectHeld();
      expect(submit()).toHaveAccessibleDescription(text);
      await user.type(nameField(), "{Enter}");
      await user.click(submit());
      expect(gitRenameBranchRemote).not.toHaveBeenCalled();
      expect(gitRenameBranch).not.toHaveBeenCalled();
    },
  );

  it("re-checks after the act answers moved and sends the tip it then read", async () => {
    vi.mocked(gitRenameBranchRemote).mockResolvedValueOnce({
      status: "refused",
      refusal: { code: "moved" },
    });
    const { user } = renderDialog();
    await rename(user);
    await tickClear(user);
    const recheck = deferred<RemoteRenameCheck>();
    vi.mocked(gitRemoteRenameCheck).mockReturnValueOnce(recheck.promise);
    await user.click(submit());
    await within(status()).findByText(
      "origin/feat changed since it was checked. Checking again…",
    );
    expectHeld();
    await act(async () => recheck.resolve({ status: "clear", oldTip: TIP_B }));
    await waitFor(() =>
      expect(within(status()).queryByText(/changed since it was checked/)).toBe(
        null,
      ),
    );
    await waitFor(() =>
      expect(submit()).toHaveAttribute("aria-disabled", "false"),
    );
    await user.click(submit());
    await waitFor(() =>
      expect(gitRenameBranchRemote).toHaveBeenLastCalledWith(
        REPO,
        "feat",
        "feat2",
        "origin",
        TIP_B,
      ),
    );
  });

  it("lets a newer clear check at the same tip retire a transient act refusal", async () => {
    vi.mocked(gitRenameBranchRemote).mockResolvedValueOnce({
      status: "refused",
      refusal: { code: "unreachable", detail: "unable to access" },
    });
    const { user } = renderDialog();
    await rename(user);
    await tickClear(user);
    const recheck = deferred<RemoteRenameCheck>();
    vi.mocked(gitRemoteRenameCheck).mockReturnValueOnce(recheck.promise);
    await user.click(submit());
    await within(status()).findByText(
      "Couldn't reach origin: unable to access. Untick to rename only here.",
    );
    await act(async () => recheck.resolve(clear));
    await screen.findByText(/^Pushes feat2 to origin, then deletes origin\//);
    await waitFor(() =>
      expect(submit()).toHaveAttribute("aria-disabled", "false"),
    );
  });

  it("explains a held Rename with the field's own message", async () => {
    const { user } = renderDialog();
    await user.clear(nameField());
    await waitFor(() =>
      expect(submit()).toHaveAccessibleDescription("Required"),
    );
    expectHeld();
    await user.type(nameField(), "feat");
    await waitFor(() =>
      expect(submit()).toHaveAccessibleDescription("Unchanged"),
    );
  });

  it("holds the remote step while another branch's push runs here", async () => {
    // Started from outside the modal, as the branch list's own push would be.
    let startPush: (() => void) | null = null;
    function Pusher() {
      const push = usePush(REPO);
      startPush = () =>
        void push.mutateAsync({ setUpstream: false, branch: "other" });
      return null;
    }
    const { user } = renderDialog({}, () => <Pusher />);
    await rename(user);
    await tickClear(user);
    act(() => startPush?.());
    await waitFor(() =>
      expect(submit()).toHaveAccessibleDescription("A push is running."),
    );
    expectHeld();
  });

  it("offers Retry beside a failed read and lands focus on the name field", async () => {
    vi.mocked(gitRemoteRenameCheck).mockRejectedValueOnce({
      kind: "git",
      message: "fatal: boom",
    });
    const { user } = renderDialog();
    await rename(user);
    await user.click(box());
    const retry = await screen.findByRole(
      "button",
      { name: "Retry" },
      { timeout: 2000 },
    );
    // The region announces the failure; the action sits beside it.
    expect(status()).toHaveTextContent(/^Couldn't check origin: /);
    expect(status()).not.toContainElement(retry);
    const checks = vi.mocked(gitRemoteRenameCheck).mock.calls.length;
    await user.click(retry);
    await screen.findByText(/^Pushes feat2 to origin, then deletes origin\//);
    expect(vi.mocked(gitRemoteRenameCheck).mock.calls.length).toBe(checks + 1);
    expect(nameField()).toHaveFocus();
  });

  it("says why a read failed and holds Rename", async () => {
    vi.mocked(gitRemoteRenameCheck).mockRejectedValue({
      kind: "git",
      message: "fatal: boom",
    });
    const { user } = renderDialog();
    await rename(user);
    await user.click(box());
    await within(status()).findByText(/^Couldn't check origin: /, undefined, {
      timeout: 2000,
    });
    expectHeld();
  });

  it("requires Rename anyway for open requests, and Enter never submits it", async () => {
    vi.mocked(forgePrsOnRemoteBranch).mockResolvedValue({
      status: "checked",
      provider: "gitlab",
      items: [
        {
          number: 214,
          title: "Add login form",
          url: "u",
          isDraft: false,
          scope: "repository",
          repo: "a/b",
        },
        {
          number: 9,
          title: "Upstream copy",
          url: "u",
          isDraft: false,
          scope: "parent",
          repo: "up/b",
        },
      ],
      unchecked: [],
    });
    const { user } = renderDialog();
    await rename(user);
    await user.click(box());
    await screen.findByText(
      "Open merge requests on",
      { exact: false },
      { timeout: 2000 },
    );
    expect(status()).toHaveTextContent("!214Add login form");
    const list = screen.getByRole("list", { name: "Open merge requests" });
    expect(list).toHaveAttribute("tabindex", "0");
    expect(status()).toHaveTextContent("Add login formwill be closed");
    expect(status()).toHaveTextContent("in up/b: will be closed");
    expect(submit()).toHaveTextContent("Rename anyway");
    await user.type(nameField(), "{Enter}");
    expect(gitRenameBranchRemote).not.toHaveBeenCalled();
    await user.click(submit());
    await waitFor(() => expect(gitRenameBranchRemote).toHaveBeenCalled());
  });

  it("says a Bitbucket request loses its source branch, which is all Bitbucket does", async () => {
    vi.mocked(forgePrsOnRemoteBranch).mockResolvedValue({
      status: "checked",
      provider: "bitbucket",
      items: [
        {
          number: 14,
          title: "Retry backoff",
          url: "u",
          isDraft: false,
          scope: "repository",
          repo: "a/b",
        },
      ],
      unchecked: [],
    });
    const { user } = renderDialog();
    await rename(user);
    await user.click(box());
    await screen.findByText(
      "Open pull requests on",
      { exact: false },
      { timeout: 2000 },
    );
    expect(status()).toHaveTextContent(
      "#14Retry backoffloses its source branch",
    );
    expect(status()).not.toHaveTextContent("merged");
    expect(status()).not.toHaveTextContent("closed");
    expect(submit()).toHaveTextContent("Rename anyway");
  });

  it("never submits Rename anyway on a chorded Enter, and still runs the generate chord", async () => {
    vi.mocked(forgePrsOnRemoteBranch).mockResolvedValue({
      status: "checked",
      provider: "github",
      items: [
        {
          number: 7,
          title: "Login",
          url: "u",
          isDraft: false,
          scope: "repository",
          repo: "a/b",
        },
      ],
      unchecked: [],
    });
    const { user } = renderDialog({ ai: true });
    await rename(user);
    await user.click(box());
    await waitFor(() => expect(submit()).toHaveTextContent("Rename anyway"), {
      timeout: 2000,
    });
    act(() => nameField().focus());
    // jsdom never submits implicitly on a chorded Enter, so the swallow that
    // stops a webview from doing so is read where the keydown ends.
    const prevented: boolean[] = [];
    const record = (e: KeyboardEvent) => {
      if (e.key === "Enter") prevented.push(e.defaultPrevented);
    };
    window.addEventListener("keydown", record);
    for (const chord of [
      "{Control>}{Enter}{/Control}",
      "{Alt>}{Enter}{/Alt}",
      "{Meta>}{Enter}{/Meta}",
    ])
      await user.keyboard(chord);
    window.removeEventListener("keydown", record);
    expect(prevented).toEqual([true, true, true]);
    expect(gitRenameBranchRemote).not.toHaveBeenCalled();
    expect(gitRenameBranch).not.toHaveBeenCalled();
    await user.keyboard("{Control>}g{/Control}");
    expect(generateSpy).toHaveBeenCalledTimes(1);
  });

  it.each<[string, RemoteBranchPulls, RegExp]>([
    [
      "an unchecked scope",
      {
        status: "checked",
        provider: "github",
        items: [],
        unchecked: [
          {
            scope: "parent",
            error: { kind: "gh", message: "signed out" } as never,
          },
        ],
      },
      /Couldn't check the parent repository for open pull requests: .*A pull request from feat would be closed\./,
    ],
    [
      "an unidentified forge",
      { status: "unidentified", host: "github-work" },
      /Couldn't check origin for open pull or merge requests: GitDesktop can't identify the forge at github-work\.A pull or merge request from feat would lose its source branch\./,
    ],
  ])("requires Rename anyway for %s", async (_n, answer, text) => {
    vi.mocked(forgePrsOnRemoteBranch).mockResolvedValue(answer);
    const { user } = renderDialog();
    await rename(user);
    await user.click(box());
    await waitFor(() => expect(status()).toHaveTextContent(text), {
      timeout: 2000,
    });
    expect(submit()).toHaveTextContent("Rename anyway");
    await user.type(nameField(), "{Enter}");
    expect(gitRenameBranchRemote).not.toHaveBeenCalled();
  });

  const uncheckedBoth = (
    repository: string,
    parent: string,
  ): RemoteBranchPulls => ({
    status: "checked",
    provider: "github",
    items: [],
    unchecked: [
      { scope: "repository", error: { kind: "gh", message: repository } },
      { scope: "parent", error: { kind: "gh", message: parent } },
    ] as never,
  });
  const uncheckedLinesShown = () =>
    within(status()).queryAllByText(/^Couldn't check /);

  it("reads one line when both scopes fail for the same reason, and still requires Rename anyway", async () => {
    vi.mocked(forgePrsOnRemoteBranch).mockResolvedValue(
      uncheckedBoth("GitHub CLI (gh) not found", "GitHub CLI (gh) not found"),
    );
    const { user } = renderDialog();
    await rename(user);
    await user.click(box());
    await waitFor(() => expect(uncheckedLinesShown()).not.toEqual([]), {
      timeout: 2000,
    });
    expect(uncheckedLinesShown().map((p) => p.textContent)).toEqual([
      "Couldn't check origin for open pull requests: GitHub CLI (gh) not found.",
    ]);
    expect(submit()).toHaveTextContent("Rename anyway");
  });

  it("keeps a line per scope for different reasons, each closed by one period", async () => {
    vi.mocked(forgePrsOnRemoteBranch).mockResolvedValue(
      uncheckedBoth("The lookup stopped early.", "GitHub CLI (gh) not found"),
    );
    const { user } = renderDialog();
    await rename(user);
    await user.click(box());
    await waitFor(() => expect(uncheckedLinesShown()).not.toEqual([]), {
      timeout: 2000,
    });
    expect(uncheckedLinesShown().map((p) => p.textContent)).toEqual([
      "Couldn't check origin for open pull requests: The lookup stopped early.",
      "Couldn't check the parent repository for open pull requests: GitHub CLI (gh) not found.",
    ]);
    expect(submit()).toHaveTextContent("Rename anyway");
  });

  it("skips the lookup's lines for a remote with no forge", async () => {
    vi.mocked(forgePrsOnRemoteBranch).mockResolvedValue({ status: "noForge" });
    const { user } = renderDialog();
    await rename(user);
    await tickClear(user);
    expect(status()).not.toHaveTextContent("open");
    expect(submit()).toHaveTextContent(/^Rename$/);
  });
});

describe("the outcome", () => {
  const err = { kind: "git", message: "rejected" } as never;
  it.each<
    [
      string,
      RemoteRenameOutcome,
      "success" | "warning",
      string,
      RegExp | string,
    ]
  >([
    [
      "renamed",
      { status: "renamed", warning: "W." },
      "success",
      "Renamed to feat2 here and on origin",
      /^W\.$/,
    ],
    [
      "pushFailed",
      { status: "pushFailed", warning: null, error: err },
      "warning",
      "Renamed to feat2 here. Couldn't push it to origin.",
      /feat2 still tracks origin\/feat\.$/,
    ],
    [
      "pushFailed timeout",
      {
        status: "pushFailed",
        warning: null,
        error: { kind: "timeout", message: "timed out after 120s" } as never,
      },
      "warning",
      "Renamed to feat2 here. Couldn't confirm the push to origin.",
      closed(
        presentError({ kind: "timeout", message: "timed out after 120s" })
          .summary,
      ),
    ],
    [
      "pushFailed at git's push timeout",
      {
        status: "pushFailed",
        warning: null,
        error: {
          kind: "timeout",
          message: GIT_PUSH_TIMEOUT_MESSAGE,
        } as never,
      },
      "warning",
      "Renamed to feat2 here. Couldn't confirm the push to origin.",
      closed(
        presentError({ kind: "timeout", message: GIT_PUSH_TIMEOUT_MESSAGE })
          .summary,
      ),
    ],
    [
      "notInPush",
      { status: "oldKept", warning: null, cause: { reason: "notInPush" } },
      "warning",
      "Renamed to feat2, but origin/feat is still there",
      "feat2 changed while the rename ran, so the pushed copy doesn't include everything on origin/feat. Fetch and compare the two before deleting feat on origin.",
    ],
    [
      "moved",
      { status: "oldKept", warning: null, cause: { reason: "moved" } },
      "warning",
      "Renamed to feat2, but origin/feat is still there",
      "origin/feat changed while the rename ran, so it wasn't deleted. Fetch and check what changed before deleting it from the branch menu's Remote group.",
    ],
    [
      "rejected",
      {
        status: "oldKept",
        warning: null,
        cause: { reason: "rejected", detail: "error: denying ref deletion" },
      },
      "warning",
      "Renamed to feat2, but origin/feat is still there",
      /^denying ref deletion\. Delete feat on origin from the branch menu's Remote group, or on GitHub\.$/,
    ],
    [
      "rejected by a hook in two lines",
      {
        status: "oldKept",
        warning: null,
        cause: {
          reason: "rejected",
          detail:
            "deletes are not allowed here\nerror: hook declined to update refs/heads/part11",
        },
      },
      "warning",
      "Renamed to feat2, but origin/feat is still there",
      /^deletes are not allowed here\. hook declined to update refs\/heads\/part11\. Delete feat on origin from the branch menu's Remote group, or on GitHub\.$/,
    ],
    [
      "rejected in three lines, each closed once",
      {
        status: "oldKept",
        warning: null,
        cause: {
          reason: "rejected",
          detail: "error: one\nremote: two.\nfatal: remote: three!",
        },
      },
      "warning",
      "Renamed to feat2, but origin/feat is still there",
      /^one\. two\. remote: three! Delete feat on origin from the branch menu's Remote group, or on GitHub\.$/,
    ],
    [
      "rejected at exactly the cap",
      {
        status: "oldKept",
        warning: null,
        cause: { reason: "rejected", detail: "y".repeat(300) },
      },
      "warning",
      "Renamed to feat2, but origin/feat is still there",
      new RegExp(
        `^${"y".repeat(300)}\\. Delete feat on origin from the branch menu's Remote group, or on GitHub\\.$`,
      ),
    ],
    [
      "rejected with a line that runs on",
      {
        status: "oldKept",
        warning: null,
        cause: { reason: "rejected", detail: "first:\nsecond" },
      },
      "warning",
      "Renamed to feat2, but origin/feat is still there",
      /^first: second\. Delete feat on origin from the branch menu's Remote group, or on GitHub\.$/,
    ],
    [
      "rejected with lines ending in a semicolon and a comma",
      {
        status: "oldKept",
        warning: null,
        cause: { reason: "rejected", detail: "a;\nb,\nc" },
      },
      "warning",
      "Renamed to feat2, but origin/feat is still there",
      /^a; b, c\. Delete feat on origin from the branch menu's Remote group, or on GitHub\.$/,
    ],
    [
      "rejected with lines already closed",
      {
        status: "oldKept",
        warning: null,
        cause: { reason: "rejected", detail: "why?\nso…\nend." },
      },
      "warning",
      "Renamed to feat2, but origin/feat is still there",
      /^why\? so… end\. Delete feat on origin from the branch menu's Remote group, or on GitHub\.$/,
    ],
    [
      "rejected with no reason",
      {
        status: "oldKept",
        warning: null,
        cause: { reason: "rejected", detail: " \n " },
      },
      "warning",
      "Renamed to feat2, but origin/feat is still there",
      /^origin refused the delete\. Delete feat on origin from the branch menu's Remote group, or on GitHub\.$/,
    ],
    [
      "rejected with a reason that is only a run-on mark",
      {
        status: "oldKept",
        warning: null,
        cause: { reason: "rejected", detail: "error: :" },
      },
      "warning",
      "Renamed to feat2, but origin/feat is still there",
      /^origin refused the delete\. Delete feat on origin from the branch menu's Remote group, or on GitHub\.$/,
    ],
    [
      "rejected with a long reason",
      {
        status: "oldKept",
        warning: null,
        cause: {
          reason: "rejected",
          detail: `remote: one\n\nremote: two\nremote: three\nremote: ${"x".repeat(5000)}`,
        },
      },
      "warning",
      "Renamed to feat2, but origin/feat is still there",
      /^one\. two\. three… Delete feat on origin/,
    ],
    [
      "rejected with one very long line",
      {
        status: "oldKept",
        warning: null,
        cause: { reason: "rejected", detail: "y".repeat(1000) },
      },
      "warning",
      "Renamed to feat2, but origin/feat is still there",
      new RegExp(`^${"y".repeat(299)}… Delete feat on origin`),
    ],
    [
      "rejected whose last kept line ends in a period",
      {
        status: "oldKept",
        warning: null,
        cause: {
          reason: "rejected",
          detail: "remote: a\nremote: b\nremote: c.\nremote: d",
        },
      },
      "warning",
      "Renamed to feat2, but origin/feat is still there",
      /^a\. b\. c… Delete feat on origin/,
    ],
    [
      "rejected cut on a period",
      {
        status: "oldKept",
        warning: null,
        cause: {
          reason: "rejected",
          detail: `${"y".repeat(298)}. ${"z".repeat(50)}`,
        },
      },
      "warning",
      "Renamed to feat2, but origin/feat is still there",
      new RegExp(`^${"y".repeat(298)}… Delete feat on origin`),
    ],
    [
      "rejected with an astral character at the cut",
      {
        status: "oldKept",
        warning: null,
        cause: {
          reason: "rejected",
          detail: `${"y".repeat(298)}${ASTRAL}${"z".repeat(50)}`,
        },
      },
      "warning",
      "Renamed to feat2, but origin/feat is still there",
      new RegExp(`^${"y".repeat(298)}${ASTRAL}… Delete feat on origin`),
    ],
    [
      "unverified",
      { status: "oldKept", warning: null, cause: { reason: "unverified" } },
      "warning",
      "Renamed to feat2, but origin/feat is still there",
      "Couldn't confirm that origin/feat2 includes everything on origin/feat, so feat wasn't deleted there. Fetch and compare the two before deleting feat on origin.",
    ],
    [
      "failed",
      {
        status: "oldKept",
        warning: null,
        cause: { reason: "failed", error: err },
      },
      "warning",
      "Renamed to feat2, but origin/feat may still be there",
      `${closed(presentError(err).summary)} Fetch to see whether feat is still on origin; if it is, check it before deleting it from the branch menu's Remote group.`,
    ],
  ])(
    "%s raises its own toast and closes the dialog",
    async (_n, outcome, kind, title, description) => {
      vi.mocked(gitRenameBranchRemote).mockResolvedValue(outcome);
      const { user, onClose } = renderDialog();
      await rename(user);
      await tickClear(user);
      await user.click(submit());
      await waitFor(() => expect(spies[kind]).toHaveBeenCalled());
      const [t, opts] = spies[kind].mock.calls[0] as [
        string,
        { description?: string },
      ];
      expect(t).toBe(title);
      if (typeof description === "string")
        expect(opts.description).toBe(description);
      else expect(opts.description ?? "").toMatch(description);
      expect(onClose).toHaveBeenCalled();
    },
  );

  it("keeps an open session's refusal under the box and re-checks once", async () => {
    vi.mocked(gitRenameBranchRemote).mockResolvedValue({
      status: "refused",
      refusal: { code: "notTracking" },
    });
    const { user, onClose } = renderDialog();
    await rename(user);
    await tickClear(user);
    const checks = vi.mocked(gitRemoteRenameCheck).mock.calls.length;
    // The re-check answers the same refusal, which keeps the hold.
    vi.mocked(gitRemoteRenameCheck).mockResolvedValue(
      refused({ code: "notTracking" }),
    );
    await user.click(submit());
    await within(status()).findByText(
      "feat no longer tracks origin/feat. Untick to rename only here.",
    );
    expect(vi.mocked(gitRemoteRenameCheck).mock.calls.length).toBe(checks + 1);
    expectHeld();
    expect(spies.info).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("runs on after a dismissal, shows running on reopen, and names the repository it settled in", async () => {
    const act$ = deferred<RemoteRenameOutcome>();
    vi.mocked(gitRenameBranchRemote).mockReturnValue(act$.promise);
    const { user, rerenderWith } = renderDialog();
    await rename(user);
    await tickClear(user);
    await user.click(submit());
    await waitFor(() => expect(footerClose()).not.toBe(null));
    expect(status()).toHaveTextContent("Renaming feat to feat2 on origin…");
    await user.click(footerClose() as HTMLElement);
    rerenderWith({ target: "feat" });
    await waitFor(() => expect(footerClose()).not.toBe(null));
    expect(nameField()).toHaveValue("feat2");
    expect(nameField()).toHaveAttribute("readonly");
    expect(box()).toBeChecked();
    expectBoxReason("Wait for the rename to finish");
    expectHeld();
    await user.click(footerClose() as HTMLElement);
    // Read once the close has unmounted the dialog: only the settle is measured.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));
    const focused = document.activeElement;
    act(() => useUiStore.setState({ repoPath: OTHER }));
    await act(async () => act$.resolve({ status: "renamed", warning: null }));
    await waitFor(() =>
      expect(spies.success).toHaveBeenCalledWith(
        "Renamed to feat2 in ren and on origin",
        { description: undefined },
      ),
    );
    expect(document.activeElement).toBe(focused);
  });

  it.each<[string, RemoteRenameOutcome]>([
    ["renamed", { status: "renamed", warning: null }],
    [
      "oldKept",
      { status: "oldKept", warning: null, cause: { reason: "moved" } },
    ],
    [
      "pushFailed",
      {
        status: "pushFailed",
        warning: null,
        error: { kind: "git", message: "rejected" } as never,
      },
    ],
  ])(
    "closes a dialog reopened on the old name when its run settles %s",
    async (_n, outcome) => {
      const act$ = deferred<RemoteRenameOutcome>();
      vi.mocked(gitRenameBranchRemote).mockReturnValue(act$.promise);
      const { user, onClose, rerenderWith } = renderDialog();
      await rename(user);
      await tickClear(user);
      await user.click(submit());
      await waitFor(() => expect(footerClose()).not.toBe(null));
      await user.click(footerClose() as HTMLElement);
      rerenderWith({ target: "feat" });
      await waitFor(() => expect(footerClose()).not.toBe(null));
      const closes = onClose.mock.calls.length;
      await act(async () => act$.resolve(outcome));
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(closes + 1));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));
    },
  );

  it("keeps a dialog reopened on the old name open on a refusal, the refusal under its box", async () => {
    const act$ = deferred<RemoteRenameOutcome>();
    vi.mocked(gitRenameBranchRemote).mockReturnValue(act$.promise);
    const { user, onClose, rerenderWith } = renderDialog();
    await rename(user);
    await tickClear(user);
    await user.click(submit());
    await waitFor(() => expect(footerClose()).not.toBe(null));
    await user.click(footerClose() as HTMLElement);
    rerenderWith({ target: "feat" });
    await waitFor(() => expect(footerClose()).not.toBe(null));
    const closes = onClose.mock.calls.length;
    // The re-check stays out, so only the act's refusal can show.
    const recheck$ = deferred<RemoteRenameCheck>();
    vi.mocked(gitRemoteRenameCheck).mockReturnValue(recheck$.promise);
    await act(async () =>
      act$.resolve({ status: "refused", refusal: { code: "remoteGone" } }),
    );
    await within(status()).findByText(
      "origin/feat no longer exists. Untick to rename only here.",
    );
    expect(box()).toBeChecked();
    expect(nameField()).toHaveValue("feat2");
    expectHeld();
    expect(onClose).toHaveBeenCalledTimes(closes);
    expect(spies.info).not.toHaveBeenCalled();
    // A newer clear answer retires it.
    await act(async () => recheck$.resolve(clear));
    await screen.findByText(/^Pushes feat2 to origin, then deletes origin\//);
    expect(
      screen.queryByText(
        "origin/feat no longer exists. Untick to rename only here.",
      ),
    ).toBe(null);
  });

  it("toasts a refusal to a dialog reopened on the new name and leaves it open", async () => {
    const act$ = deferred<RemoteRenameOutcome>();
    vi.mocked(gitRenameBranchRemote).mockReturnValue(act$.promise);
    const { user, onClose, rerenderWith } = renderDialog();
    await rename(user);
    await tickClear(user);
    await user.click(submit());
    await waitFor(() => expect(footerClose()).not.toBe(null));
    await user.click(footerClose() as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));
    rerenderWith({ target: "feat2", remoteRename: null });
    await waitFor(() => expect(footerClose()).not.toBe(null));
    const closes = onClose.mock.calls.length;
    await act(async () =>
      act$.resolve({ status: "refused", refusal: { code: "remoteGone" } }),
    );
    await waitFor(() =>
      expect(spies.info).toHaveBeenCalledWith(
        "Didn't rename feat: origin/feat no longer exists.",
      ),
    );
    expect(onClose).toHaveBeenCalledTimes(closes);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("toasts a refusal to a dialog reopened on the old name once another branch's dialog dropped the press's check", async () => {
    const act$ = deferred<RemoteRenameOutcome>();
    vi.mocked(gitRenameBranchRemote).mockReturnValue(act$.promise);
    const { user, onClose, queryClient, rerenderWith } = renderDialog();
    await rename(user);
    await tickClear(user);
    const checkKey = remoteRenameCheckOptions(
      REPO,
      "origin",
      "feat",
      "feat2",
    ).queryKey;
    await user.click(submit());
    await waitFor(() => expect(footerClose()).not.toBe(null));
    await user.click(footerClose() as HTMLElement);
    rerenderWith({ target: "topic" });
    await waitFor(() =>
      expect(queryClient.getQueryState(checkKey)).toBe(undefined),
    );
    rerenderWith({ target: null });
    rerenderWith({ target: "feat" });
    // The reopen re-creates the entry with no answer while the run holds it.
    await waitFor(() =>
      expect(queryClient.getQueryState(checkKey)?.dataUpdatedAt).toBe(0),
    );
    const closes = onClose.mock.calls.length;
    const recheck$ = deferred<RemoteRenameCheck>();
    vi.mocked(gitRemoteRenameCheck).mockReturnValue(recheck$.promise);
    await act(async () =>
      act$.resolve({ status: "refused", refusal: { code: "remoteGone" } }),
    );
    await waitFor(() =>
      expect(spies.info).toHaveBeenCalledWith(
        "Didn't rename feat: origin/feat no longer exists.",
      ),
    );
    expect(onClose).toHaveBeenCalledTimes(closes);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("leaves a dialog reopened on another branch open when the run settles", async () => {
    const act$ = deferred<RemoteRenameOutcome>();
    vi.mocked(gitRenameBranchRemote).mockReturnValue(act$.promise);
    const { user, onClose, rerenderWith } = renderDialog();
    await rename(user);
    await tickClear(user);
    await user.click(submit());
    await waitFor(() => expect(footerClose()).not.toBe(null));
    await user.click(footerClose() as HTMLElement);
    rerenderWith({ target: "topic" });
    await waitFor(() => expect(nameField()).toHaveValue("topic"));
    const closes = onClose.mock.calls.length;
    await act(async () => act$.resolve({ status: "renamed", warning: null }));
    await waitFor(() => expect(spies.success).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalledTimes(closes);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("moves the commit draft when the status poll first reports the new name", async () => {
    let branch = "feat";
    function Draft() {
      useBranchCommitDraft(REPO, branch);
      return null;
    }
    const act$ = deferred<RemoteRenameOutcome>();
    vi.mocked(gitRenameBranchRemote).mockReturnValue(act$.promise);
    const { user, rerenderWith } = renderDialog({}, () => <Draft />);
    act(() => useUiStore.getState().setCommitTitle("Draft title"));
    await rename(user);
    await tickClear(user);
    await user.click(submit());
    await waitFor(() => expect(footerClose()).not.toBe(null));
    // The poll reports HEAD under the new name while the push still runs.
    branch = "feat2";
    rerenderWith({});
    expect(useUiStore.getState().commitTitle).toBe("Draft title");
    act(() => useUiStore.getState().setCommitTitle("Edited title"));
    await act(async () => act$.resolve({ status: "renamed", warning: null }));
    await waitFor(() => expect(spies.success).toHaveBeenCalled());
    expect(useUiStore.getState().commitTitle).toBe("Edited title");
    expect(
      useUiStore.getState().commitDrafts[commitDraftKey(REPO, "feat2")]?.title,
    ).toBe("Edited title");
  });

  it("keeps a draft saved under the new name when the act rejects", async () => {
    let branch = "feat";
    function Draft() {
      useBranchCommitDraft(REPO, branch);
      return null;
    }
    const act$ = deferred<RemoteRenameOutcome>();
    vi.mocked(gitRenameBranchRemote).mockReturnValue(act$.promise);
    const { user, rerenderWith } = renderDialog({}, () => <Draft />);
    act(() => {
      useUiStore.setState({ commitDrafts: {}, activeDraftKey: null });
      const ui = useUiStore.getState();
      ui.loadCommitDraft(commitDraftKey(REPO, "feat2"));
      ui.setCommitTitle("New name's draft");
      ui.loadCommitDraft(commitDraftKey(REPO, "feat"));
      ui.setCommitTitle("Old name's draft");
    });
    await rename(user);
    await tickClear(user);
    await user.click(submit());
    await waitFor(() => expect(footerClose()).not.toBe(null));
    // HEAD reaches the existing new name while the act still runs.
    branch = "feat2";
    rerenderWith({});
    expect(useUiStore.getState().commitTitle).toBe("New name's draft");
    await act(async () => act$.reject({ kind: "git", message: "fatal: boom" }));
    await waitFor(() => expect(spies.error).toHaveBeenCalled());
    const drafts = useUiStore.getState().commitDrafts;
    expect(drafts[commitDraftKey(REPO, "feat")]?.title).toBe(
      "Old name's draft",
    );
    expect(drafts[commitDraftKey(REPO, "feat2")]?.title).toBe(
      "New name's draft",
    );
  });

  it("moves the old name's draft when the fields left it before the poll reports the new name", async () => {
    let branch = "feat";
    function Draft() {
      useBranchCommitDraft(REPO, branch);
      return null;
    }
    const act$ = deferred<RemoteRenameOutcome>();
    vi.mocked(gitRenameBranchRemote).mockReturnValue(act$.promise);
    const { user, rerenderWith } = renderDialog({}, () => <Draft />);
    act(() => {
      useUiStore.setState({ commitDrafts: {}, activeDraftKey: null });
      const ui = useUiStore.getState();
      ui.loadCommitDraft(commitDraftKey(REPO, "feat"));
      ui.setCommitTitle("Draft title");
    });
    await rename(user);
    await tickClear(user);
    await user.click(submit());
    await waitFor(() => expect(footerClose()).not.toBe(null));
    // A repository round trip leaves no live key.
    act(() => useUiStore.setState({ activeDraftKey: null, commitTitle: "" }));
    branch = "feat2";
    rerenderWith({});
    expect(useUiStore.getState().commitTitle).toBe("Draft title");
    act(() => useUiStore.getState().setCommitTitle("Edited title"));
    await act(async () => act$.resolve({ status: "renamed", warning: null }));
    await waitFor(() => expect(spies.success).toHaveBeenCalled());
    expect(useUiStore.getState().commitTitle).toBe("Edited title");
    expect(
      useUiStore.getState().commitDrafts[commitDraftKey(REPO, "feat")],
    ).toBe(undefined);
  });

  it("leaves a dialog reopened after a switch open, focus included, when the older run settles", async () => {
    const act$ = deferred<RemoteRenameOutcome>();
    vi.mocked(gitRenameBranchRemote).mockReturnValue(act$.promise);
    const { user, onClose, rerenderWith, switchRepo } = renderDialog();
    await rename(user);
    await tickClear(user);
    await user.click(submit());
    await waitFor(() => expect(footerClose()).not.toBe(null));
    await user.click(footerClose() as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));
    switchRepo(OTHER);
    // The same name in the next repository: its own branch, never this run.
    rerenderWith({ target: "feat" });
    await waitFor(() => expect(nameField()).toHaveFocus());
    expect(nameField()).toHaveValue("feat");
    expect(box()).not.toBeChecked();
    expect(box()).not.toHaveAttribute("aria-disabled", "true");
    const closes = onClose.mock.calls.length;
    await act(async () => act$.resolve({ status: "renamed", warning: null }));
    await waitFor(() =>
      expect(spies.success).toHaveBeenCalledWith(
        "Renamed to feat2 in ren and on origin",
        { description: undefined },
      ),
    );
    expect(onClose).toHaveBeenCalledTimes(closes);
    expect(nameField()).toHaveFocus();
  });

  it("closes once a rejected act leaves the old name gone", async () => {
    vi.mocked(gitRenameBranchRemote).mockRejectedValue({
      kind: "git",
      message: "fatal: boom",
    });
    vi.mocked(gitBranches).mockResolvedValue([{ name: "feat2" }] as never);
    const { user, onClose } = renderDialog();
    await rename(user);
    await tickClear(user);
    await user.click(submit());
    await waitFor(() => expect(spies.error).toHaveBeenCalled());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("holds the form through a rejected act's branch read and closes without giving it back", async () => {
    const act$ = deferred<RemoteRenameOutcome>();
    vi.mocked(gitRenameBranchRemote).mockReturnValue(act$.promise);
    const read$ = deferred<never>();
    const { user, onClose } = renderDialog();
    await rename(user);
    await tickClear(user);
    await user.click(submit());
    await waitFor(() => expect(footerClose()).not.toBe(null));
    vi.mocked(gitBranches).mockReturnValue(read$.promise);
    await act(async () => act$.reject({ kind: "git", message: "fatal: boom" }));
    await waitFor(() => expect(spies.error).toHaveBeenCalled());
    await waitFor(() => expect(gitBranches).toHaveBeenCalled());
    expect(status()).toHaveTextContent("Renaming feat to feat2 on origin…");
    expect(footerClose()).not.toBe(null);
    expectHeld();
    const frames: Frame[] = [];
    onCommit = () => {
      frames.push(frame(onClose.mock.calls.length > 0));
    };
    await act(async () => read$.resolve([{ name: "feat2" }] as never));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));
    const shown = frames.filter((f) => f !== null);
    expect(shown.filter((f) => f.closed).length).toBeGreaterThan(0);
    for (const f of shown)
      expect(f).toMatchObject({ running: true, held: true });
  });

  it("leaves a dialog opened during a rejected act's branch read open", async () => {
    const act$ = deferred<RemoteRenameOutcome>();
    vi.mocked(gitRenameBranchRemote).mockReturnValue(act$.promise);
    const read$ = deferred<never>();
    const { user, onClose, rerenderWith } = renderDialog();
    await rename(user);
    await tickClear(user);
    await user.click(submit());
    await waitFor(() => expect(footerClose()).not.toBe(null));
    vi.mocked(gitBranches).mockReturnValue(read$.promise);
    await act(async () => act$.reject({ kind: "git", message: "fatal: boom" }));
    await waitFor(() => expect(gitBranches).toHaveBeenCalled());
    await user.click(footerClose() as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));
    rerenderWith({ target: "feat2", remoteRename: null });
    await waitFor(() => expect(nameField()).toHaveValue("feat2"));
    const closes = onClose.mock.calls.length;
    await act(async () => read$.resolve([{ name: "feat2" }] as never));
    expect(onClose).toHaveBeenCalledTimes(closes);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("keeps a dialog reopened on the old name ticked when its run's act rejects", async () => {
    const act$ = deferred<RemoteRenameOutcome>();
    vi.mocked(gitRenameBranchRemote).mockReturnValue(act$.promise);
    const { user, onClose, rerenderWith } = renderDialog();
    await rename(user);
    await tickClear(user);
    await user.click(submit());
    await waitFor(() => expect(footerClose()).not.toBe(null));
    await user.click(footerClose() as HTMLElement);
    rerenderWith({ target: "feat" });
    await waitFor(() => expect(footerClose()).not.toBe(null));
    const closes = onClose.mock.calls.length;
    await act(async () => act$.reject({ kind: "git", message: "fatal: boom" }));
    await waitFor(() => expect(spies.error).toHaveBeenCalled());
    await waitFor(() => expect(footerClose()).toBe(null));
    expect(box()).toBeChecked();
    expect(nameField()).toHaveValue("feat2");
    expect(onClose).toHaveBeenCalledTimes(closes);
  });

  it("names the repository on a rejected act that settles after a switch", async () => {
    const act$ = deferred<RemoteRenameOutcome>();
    vi.mocked(gitRenameBranchRemote).mockReturnValue(act$.promise);
    const { user, switchRepo } = renderDialog();
    await rename(user);
    await tickClear(user);
    await user.click(submit());
    await waitFor(() => expect(footerClose()).not.toBe(null));
    switchRepo(OTHER);
    await act(async () => act$.reject({ kind: "git", message: "fatal: boom" }));
    await waitFor(() => expect(spies.error).toHaveBeenCalled());
    expect(spies.error.mock.calls[0][1]).toMatchObject({
      description: "In ren",
    });
  });

  it.each<[RemoteRenameRefusal, string]>([
    [
      { code: "remoteGone" },
      "Didn't rename feat: origin/feat no longer exists.",
    ],
    [
      { code: "moved" },
      "Didn't rename feat: origin/feat changed since it was checked.",
    ],
    [
      { code: "unreachable", detail: LONG_UNREACHABLE },
      `Didn't rename feat: ${LONG_UNREACHABLE_SHOWN}`,
    ],
  ])(
    "toasts only the reason of a refusal that settles after a dismissal",
    async (refusal, text) => {
      const act$ = deferred<RemoteRenameOutcome>();
      vi.mocked(gitRenameBranchRemote).mockReturnValue(act$.promise);
      const { user } = renderDialog();
      await rename(user);
      await tickClear(user);
      await user.click(submit());
      await waitFor(() => expect(footerClose()).not.toBe(null));
      await user.click(footerClose() as HTMLElement);
      await act(async () => act$.resolve({ status: "refused", refusal }));
      await waitFor(() => expect(spies.info).toHaveBeenCalledWith(text));
    },
  );

  it("toasts a failed act and leaves the dialog open", async () => {
    vi.mocked(gitRenameBranchRemote).mockRejectedValue({
      kind: "git",
      message: "fatal: boom",
    });
    const { user, onClose } = renderDialog();
    await rename(user);
    await tickClear(user);
    await user.click(submit());
    await waitFor(() => expect(spies.error).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // The form is usable again.
    await waitFor(() =>
      expect(submit()).toHaveAttribute("aria-disabled", "false"),
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(box()).toBeChecked();
    expect(box()).not.toHaveAttribute("aria-disabled", "true");
  });

  it("holds the box and Rename while another branch is renamed on its remote", async () => {
    // A second dialog in the same client starts the other branch's rename
    // while this one is open and ticked.
    let otherTarget: string | null = null;
    const otherDialog = () => (
      <RenameBranchDialog
        repoPath={REPO}
        target={otherTarget}
        targetUpstream={{ remote: "origin", branch: "topic" }}
        remoteRename={ORIGIN}
        currentName="main"
        onClose={() => undefined}
        aiEnabled={false}
        aiConfigured={false}
        hasChanges={false}
        headExists
        entries={[]}
        allBranchNames={["main", "topic"]}
        committedFallback={null}
        committedStatus="ready"
        onOpenSettings={() => undefined}
      />
    );
    const { user, rerenderWith } = renderDialog({}, otherDialog);
    await rename(user);
    await tickClear(user);
    const other = deferred<RemoteRenameOutcome>();
    vi.mocked(gitRenameBranchRemote).mockReturnValue(other.promise);
    otherTarget = "topic";
    rerenderWith({});
    // The open modal hides the dialog under it from the accessibility tree.
    const second = () => screen.getByRole("dialog");
    await waitFor(() =>
      expect(within(second()).getByLabelText("New name")).toHaveValue("topic"),
    );
    await user.type(within(second()).getByLabelText("New name"), "2");
    await user.click(within(second()).getByRole("checkbox"));
    const otherSubmit = within(second()).getByRole("button", {
      name: /Rename$/,
    });
    await waitFor(
      () => expect(otherSubmit).toHaveAttribute("aria-disabled", "false"),
      { timeout: 2000 },
    );
    await user.click(otherSubmit);
    await waitFor(() =>
      expect(gitRenameBranchRemote).toHaveBeenCalledWith(
        REPO,
        "topic",
        "topic2",
        "origin",
        TIP,
      ),
    );
    otherTarget = null;
    rerenderWith({});
    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
    expectBoxReason("Another branch is being renamed on its remote");
    expectHeld();
    expect(submit()).toHaveAccessibleDescription(
      "Another branch is being renamed on its remote",
    );
    await user.click(submit());
    expect(gitRenameBranchRemote).toHaveBeenCalledTimes(1);
    await act(async () => other.resolve({ status: "renamed", warning: null }));
  });
});
