import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
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
import { ConflictFileView } from "@/features/repository/ConflictFileView";
import { markerStagePrompt } from "@/features/repository/conflict-confirms";
import { getSecret, gitStage, gitStatus } from "@/lib/git/api";
import { type ConflictSides, conflictSides } from "@/lib/git/conflict";
import {
  BINARY_REFUSAL,
  TOO_LARGE_REFUSAL,
} from "@/lib/git/conflict-prefilter";
import type { RepoStatus } from "@/lib/git/types";
import { dispatchAction } from "@/lib/hotkeys/hotkeys";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  getSecret: vi.fn(),
  gitStage: vi.fn(),
  gitStatus: vi.fn(),
}));
vi.mock("@/lib/git/conflict", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/conflict")>()),
  conflictSides: vi.fn(),
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

const REPO = "C:/repos/demo";
const PATH = "src/big.rs";
const BASE = "big.rs";

/** A sides read rejected exactly as the wire sends it. */
const invalid = (detail: string) => ({
  kind: "invalidArgument" as const,
  message: `invalid argument: ${detail}`,
});
const TOO_LARGE = invalid(TOO_LARGE_REFUSAL);
const BINARY = invalid(BINARY_REFUSAL);

const STAGES = {
  base: "fn a() {}\n",
  ours: "fn a() { 1 }\n",
  theirs: "fn a() { 2 }\n",
  aiIgnored: { ignored: false, unreadable: false },
  workingExists: true,
  workingUndecodable: false,
  undecodable: false,
  workingHash: "h1",
  workingMatchesSurvivor: null,
};
/** Resolved on disk outside the app, stages still present. */
const CLEAN: ConflictSides = { ...STAGES, working: "fn a() { 3 }\n" };
const MARKED: ConflictSides = {
  ...STAGES,
  working: "<<<<<<< HEAD\nfn a() { 1 }\n=======\nfn a() { 2 }\n>>>>>>> topic\n",
};

const COPY = {
  tooLarge:
    "This file is too large to show here, so its conflict can't be resolved region by region.",
  binary:
    "This looks like a binary file, so its conflict can't be merged as text.",
  tail: "Take a side with Accept all current / incoming, or resolve it outside GitDesktop and then Mark resolved to stage it exactly as it is on disk. You'll be asked first, because GitDesktop can't check this file for conflict markers.",
  reread: "Couldn't re-read the file — nothing was marked resolved.",
  notConflicted: `${BASE} is no longer conflicted — nothing was changed.`,
  resolved: `Resolved ${BASE}`,
};

/** What the sides read answers: the error it rejects with, or the sides. */
let disk: ConflictSides | object;
let conflicted: boolean;

function status(): RepoStatus {
  return {
    branch: {} as RepoStatus["branch"],
    entries: conflicted
      ? [{ path: PATH, staged: "conflicted", unstaged: "conflicted" }]
      : [{ path: PATH, staged: "modified", unstaged: null }],
  };
}

beforeEach(() => {
  disk = TOO_LARGE;
  conflicted = true;
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
  vi.mocked(conflictSides).mockImplementation(async () => {
    if ("working" in disk) return disk as ConflictSides;
    throw disk;
  });
  // Read by the AI button's gate; no key keeps the button off.
  vi.mocked(getSecret).mockImplementation(async () => null);
  vi.mocked(gitStatus).mockImplementation(async () => status());
  vi.mocked(gitStage).mockImplementation(async () => {
    conflicted = false;
  });
  useUiStore.setState(useUiStore.getInitialState(), true);
  useUiStore.setState({ repoPath: REPO });
  useConfirm.setState({ request: null, requestHold: null });
});

afterEach(() => useConfirm.getState().answer(false));

afterAll(() => expect(unmockedCommands).toEqual([]));

function renderView() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const sink = createRef<HTMLDivElement>();
  render(
    <QueryClientProvider client={client}>
      <div ref={sink} tabIndex={-1} data-testid="host-sink" />
      <div tabIndex={-1} data-testid="blur-target" />
      <ConflictFileView repoPath={REPO} path={PATH} focusSink={sink} />
    </QueryClientProvider>,
  );
}

/** The refusal arm's button, once the mount's own read has landed. */
async function markButton() {
  const button = await screen.findByRole("button", { name: "Mark resolved" });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
}

/** Chromium blurs a button it disables; jsdom keeps its focus. */
function blurLikeChromium() {
  const target = screen.getByTestId("blur-target");
  act(() => {
    target.focus();
    target.blur();
  });
  expect(document.activeElement).toBe(document.body);
}

const confirmRequest = () => useConfirm.getState().request;

describe("Mark resolved on a too-large or binary refusal", () => {
  it.each([
    ["tooLarge", TOO_LARGE, COPY.tooLarge],
    ["binary", BINARY, COPY.binary],
  ] as const)(
    "A1.1: the %s refusal offers Mark resolved with its copy",
    async (_, error, lead) => {
      disk = error;
      renderView();
      const button = await markButton();
      const strip = button.parentElement as HTMLElement;
      expect(strip.textContent).toBe(`${lead} ${COPY.tail}Mark resolved`);
    },
  );

  it.each([
    [
      "a linked leaf",
      invalid(
        `Can't resolve the conflict in ${PATH} — it's a symbolic link. Nothing was changed.`,
      ),
      "Accept all current or incoming can still resolve it",
    ],
    [
      "a linked ancestor",
      invalid(
        `Can't resolve the conflict in ${PATH} — it's reached through a symbolic link or junction. Nothing was changed.`,
      ),
      "Resolve it in your editor or a terminal.",
    ],
    [
      "an unknown invalidArgument",
      invalid(`invalid path: ${PATH}`),
      "Couldn't read this file, so it can't be shown here.",
    ],
    [
      "an io failure",
      { kind: "io", message: "locked" },
      "Couldn't read this file. It may be locked",
    ],
    [
      "another kind",
      { kind: "git", message: "fatal: bad object" },
      "Couldn't read this file, so it can't be shown here.",
    ],
  ])(
    "A1.1/A1.5: %s offers no Mark resolved, here or in the palette",
    async (_, error, text) => {
      disk = error;
      renderView();
      await screen.findByText((content) => content.includes(text), undefined, {
        timeout: 3000,
      });
      expect(
        screen.queryByRole("button", { name: "Mark resolved" }),
      ).not.toBeInTheDocument();
      expect(dispatchAction("mark-conflict-resolved")).toBe(false);
    },
  );

  it.each([
    ["tooLarge", TOO_LARGE],
    ["binary", BINARY],
  ] as const)(
    "A1.5: the palette action is live on the %s refusal",
    async (_, error) => {
      disk = error;
      renderView();
      await markButton();
      let ran = false;
      act(() => {
        ran = dispatchAction("mark-conflict-resolved");
      });
      expect(ran).toBe(true);
      await waitFor(() => expect(confirmRequest()).not.toBeNull());
      expect(gitStage).not.toHaveBeenCalled();
    },
  );

  it("A1.2: the press always asks the unchecked question first; Cancel stages nothing", async () => {
    renderView();
    const button = await markButton();
    await userEvent.setup().click(button);
    await waitFor(() => expect(confirmRequest()).not.toBeNull());
    expect(gitStatus).toHaveBeenCalledWith(REPO);
    expect(gitStage).not.toHaveBeenCalled();
    const expected = markerStagePrompt(
      [{ name: BASE, unchecked: true }],
      false,
    );
    const request = confirmRequest();
    expect(request?.title).toBe(expected.title);
    expect(request?.body).toBe(expected.body);
    expect(request?.confirmLabel).toBe(expected.confirmLabel);
    expect(request?.confirmVariant).toBe("destructive");
    expect(request?.title).toBe(
      `Stage ${BASE} with possible conflict markers?`,
    );
    expect(request?.confirmLabel).toBe("Stage anyway");
    act(() => useConfirm.getState().answer(false));
    await waitFor(() => expect(button).toBeEnabled());
    expect(gitStage).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("A1.2/A1.6: Confirm stages the file as it is on disk and lands on the button", async () => {
    renderView();
    const button = await markButton();
    await userEvent.setup().click(button);
    await waitFor(() => expect(confirmRequest()).not.toBeNull());
    blurLikeChromium();
    await act(async () => useConfirm.getState().answer(true));
    await waitFor(() => expect(gitStage).toHaveBeenCalledTimes(1));
    expect(gitStage).toHaveBeenCalledWith(REPO, [`:(literal)${PATH}`]);
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(COPY.resolved),
    );
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it("A1.3: a path no longer conflicted at the click changes nothing", async () => {
    renderView();
    const button = await markButton();
    conflicted = false;
    await userEvent.setup().click(button);
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(COPY.notConflicted),
    );
    expect(confirmRequest()).toBeNull();
    expect(gitStage).not.toHaveBeenCalled();
  });

  it("A1.3: a failed status read at the click changes nothing", async () => {
    renderView();
    const button = await markButton();
    vi.mocked(gitStatus).mockRejectedValue({ kind: "io", message: "locked" });
    await userEvent.setup().click(button);
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(COPY.reread));
    expect(confirmRequest()).toBeNull();
    expect(gitStage).not.toHaveBeenCalled();
  });

  it("A1.3: a click-time io failure keeps today's re-read refusal", async () => {
    renderView();
    const button = await markButton();
    disk = { kind: "io", message: "locked" };
    await userEvent.setup().click(button);
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(COPY.reread));
    expect(gitStatus).not.toHaveBeenCalled();
    expect(confirmRequest()).toBeNull();
    expect(gitStage).not.toHaveBeenCalled();
  });

  it("A1.4: a click-time read with no markers stages without asking", async () => {
    renderView();
    const button = await markButton();
    disk = CLEAN;
    await userEvent.setup().click(button);
    await waitFor(() => expect(gitStage).toHaveBeenCalledTimes(1));
    expect(confirmRequest()).toBeNull();
    expect(gitStatus).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(COPY.resolved),
    );
  });

  it("A1.4: a click-time read with markers asks the checked question", async () => {
    renderView();
    const button = await markButton();
    disk = MARKED;
    await userEvent.setup().click(button);
    await waitFor(() => expect(confirmRequest()).not.toBeNull());
    const expected = markerStagePrompt(
      [{ name: BASE, unchecked: false }],
      false,
    );
    expect(confirmRequest()?.title).toBe(expected.title);
    expect(confirmRequest()?.body).toBe(expected.body);
    expect(gitStage).not.toHaveBeenCalled();
    await act(async () => useConfirm.getState().answer(true));
    await waitFor(() => expect(gitStage).toHaveBeenCalledTimes(1));
  });
});

/** Parses to no region yet keeps a marker: the fallback's `unparsed` arm. */
const UNPARSED: ConflictSides = {
  ...STAGES,
  working: "<<<<<<< HEAD\nfn a() { 1 }\n",
};

/** Stands in for the shared confirm's popup, which keeps focus on its Cancel
 *  through its exit animation; outside the pane, as the real one portals. */
function closingConfirm() {
  const popup = document.createElement("div");
  popup.setAttribute("role", "alertdialog");
  const cancel = document.createElement("button");
  cancel.textContent = "Cancel";
  popup.append(cancel);
  document.body.append(popup);
  act(() => cancel.focus());
  return {
    cancel,
    close: () =>
      act(() => {
        cancel.blur();
        popup.remove();
      }),
  };
}

const frames = (n: number) =>
  act(async () => {
    for (let i = 0; i < n; i++)
      await new Promise((r) => requestAnimationFrame(r));
  });

describe("Mark resolved's Cancel keeps keyboard focus", () => {
  it.each([
    ["the too-large refusal", TOO_LARGE],
    ["a marker-bearing fallback", UNPARSED],
  ] as const)("Cancel on %s lands back on the button", async (_, read) => {
    disk = read;
    renderView();
    const button = await markButton();
    await userEvent.setup().click(button);
    await waitFor(() => expect(confirmRequest()).not.toBeNull());
    blurLikeChromium();
    const popup = closingConfirm();
    act(() => useConfirm.getState().answer(false));
    // While the popup holds focus the landing waits instead of dropping.
    await frames(2);
    expect(document.activeElement).toBe(popup.cancel);
    popup.close();
    await waitFor(() => expect(document.activeElement).toBe(button));
    expect(gitStage).not.toHaveBeenCalled();
  });

  it("a control the user focuses while the confirm closes keeps focus", async () => {
    disk = UNPARSED;
    renderView();
    const button = await markButton();
    await userEvent.setup().click(button);
    await waitFor(() => expect(confirmRequest()).not.toBeNull());
    blurLikeChromium();
    const popup = closingConfirm();
    act(() => useConfirm.getState().answer(false));
    await frames(2);
    const elsewhere = screen.getByTestId("host-sink");
    popup.close();
    act(() => elsewhere.focus());
    // The wait re-checks on the next frame and re-arms; two frames cover both.
    await frames(3);
    expect(document.activeElement).toBe(elsewhere);
  });

  it("the refusal's button stays focusable and explains the click-time hold", async () => {
    renderView();
    const button = await markButton();
    vi.mocked(conflictSides).mockImplementationOnce(
      () => new Promise<ConflictSides>(() => undefined),
    );
    await userEvent.setup().click(button);
    await waitFor(() =>
      expect(button).toHaveAttribute("aria-disabled", "true"),
    );
    expect(button).not.toHaveAttribute("disabled");
    expect(button).toHaveAccessibleDescription("Checking the file…");
    expect(document.activeElement).toBe(button);
  });
});
