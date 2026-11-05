import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { toast } from "sonner";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictResolveView } from "@/features/repository/ConflictResolveView";
import { aiExcludePatterns } from "@/lib/ai/ignore";
import { getSecret, readRepoInstructions } from "@/lib/git/api";
import {
  type ConflictSides,
  changedOnDiskCopy,
  conflictSides,
  diffContents,
  type ResolveConflictOutcome,
  resolveConflict,
} from "@/lib/git/conflict";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { useConflictResolve } from "@/lib/stores/conflict-resolve";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

// The api modules are the seam; everything else in them stays real, so the
// tests read changedOnDiskCopy's live wording.
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  getSecret: vi.fn(),
  readRepoInstructions: vi.fn(),
}));
vi.mock("@/lib/git/conflict", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/conflict")>()),
  conflictSides: vi.fn(),
  resolveConflict: vi.fn(),
  diffContents: vi.fn(),
}));
vi.mock("@/lib/ai/ignore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/ignore")>()),
  aiExcludePatterns: vi.fn(),
}));

// The stream hook reaches CLI agents and fetch; the view only reads its
// result. Stable functions: the view's teardown effect keys on `cancel`.
const stream = vi.hoisted(() => ({
  text: "",
  run: vi.fn(),
  cancel: vi.fn(),
  reset: vi.fn(),
}));
vi.mock("@/lib/ai/stream", () => ({
  useAiTextStream: () => ({
    run: stream.run,
    cancel: stream.cancel,
    reset: stream.reset,
    generating: false,
    text: stream.text,
    status: "",
  }),
}));

// The toaster's DOM needs the app Toaster and its timers; the copy each arm
// hands it is the contract. `@/lib/toast` stays real over this mock.
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
const PATH = "dir/a.txt";
const BASE = "a.txt";

const SIDES: ConflictSides = {
  working:
    "first\n<<<<<<< HEAD\nours line\n=======\ntheirs line\n>>>>>>> topic\nlast\n",
  base: "first\nbase line\nlast\n",
  ours: "first\nours line\nlast\n",
  theirs: "first\ntheirs line\nlast\n",
  aiIgnored: { ignored: false, unreadable: false },
  workingExists: true,
  workingUndecodable: false,
  undecodable: false,
  workingHash: "h1",
  workingMatchesSurvivor: null,
};
const NOT_CONFLICTED: ConflictSides = {
  ...SIDES,
  working: "first\nresolved elsewhere\nlast\n",
  base: null,
  ours: null,
  theirs: null,
  workingHash: "h2",
};
const CLEAN = "first\nours line\ntheirs line\nlast\n";
const MARKED =
  "first\n<<<<<<< HEAD\nours line\n=======\ntheirs line\n>>>>>>> topic\nlast\n";

const COPY = {
  rereadFailed: `${BASE} couldn't be re-read — nothing was written.`,
  notConflicted: `${BASE} is no longer conflicted — nothing was changed.`,
  partUndecodable: `Part of the conflict in ${BASE} isn't UTF-8 text, so the proposal wasn't applied. Resolve it in the conflict editor instead; its accepts keep the file's bytes exact.`,
  resolvedNext: `Resolved ${BASE} — next conflict`,
  resolved: `Resolved ${BASE}`,
  markersLeft: `Applied the proposal to ${BASE} but left it unstaged — conflict markers remain. Fix the rest by hand, then mark it resolved.`,
  closed:
    "You closed the repository before the check finished — nothing was written.",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Walk = Partial<
  Pick<
    ReturnType<typeof useConflictResolve.getState>,
    "activePath" | "queue" | "scopePath" | "prefiltering"
  >
>;
const OWNED_QUEUED: Walk = {
  scopePath: REPO,
  activePath: PATH,
  queue: ["dir/b.txt"],
  prefiltering: null,
};
const OWNED_HELD: Walk = {
  scopePath: REPO,
  activePath: PATH,
  queue: [],
  prefiltering: REPO,
};

beforeEach(() => {
  stream.text = CLEAN;
  stream.run.mockImplementation(async () => true);
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
  vi.mocked(getSecret).mockImplementation(async () => "sk-test-000000");
  vi.mocked(readRepoInstructions).mockImplementation(async () => null);
  vi.mocked(aiExcludePatterns).mockImplementation(async () => []);
  // A failed preview diff falls back to the proposed view, which keeps the
  // lazy diff surface unmounted.
  vi.mocked(diffContents).mockRejectedValue(new Error("no diff"));
  useUiStore.setState(useUiStore.getInitialState(), true);
  useUiStore.setState({ repoPath: REPO });
  useConflictResolve.setState(useConflictResolve.getInitialState(), true);
});

afterAll(() => expect(unmockedCommands).toEqual([]));

/** Renders the view beside the host's sink and two outside controls, and
 *  waits for its proposal. The settings and key reads are seeded: start() runs
 *  once per path and returns at once while the review model is unknown. */
async function renderReady(
  proposal: string,
  reread: () => Promise<ConflictSides>,
) {
  stream.text = proposal;
  vi.mocked(conflictSides)
    .mockImplementationOnce(async () => SIDES)
    .mockImplementationOnce(reread);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, structuredClone(DEFAULT_SETTINGS));
  client.setQueryData(settingsKeys.secret("anthropic"), {
    length: 14,
    masked: "sk-tes...0000",
  });
  const sink = createRef<HTMLDivElement>();
  render(
    <QueryClientProvider client={client}>
      <div ref={sink} tabIndex={-1} data-testid="host-sink" />
      <div tabIndex={-1} data-testid="blur-target" />
      <button type="button">Outside</button>
      <ConflictResolveView repoPath={REPO} path={PATH} focusSink={sink} />
    </QueryClientProvider>,
  );
  const accept = await screen.findByRole("button", {
    name: proposal === CLEAN ? "Accept & stage" : "Accept",
  });
  return { accept, sink: screen.getByTestId("host-sink") };
}

/** Presses Accept by pointer (user-event focuses it on mousedown) or by Enter
 *  (never Space: a Space keydown in the view takes over its landing). */
async function press(accept: HTMLElement, via: "pointer" | "keyboard") {
  const user = userEvent.setup();
  if (via === "pointer") {
    await user.click(accept);
  } else {
    act(() => accept.focus());
    await user.keyboard("{Enter}");
  }
}

/** Chromium blurs a button it disables; jsdom keeps its focus, which would let
 *  every landing assertion pass without a landing. Focus goes to <body>. */
function blurLikeChromium() {
  const target = screen.getByTestId("blur-target");
  act(() => {
    target.focus();
    target.blur();
  });
  expect(document.activeElement).toBe(document.body);
}

/** The focus protocol around one held step: the premise while held, the
 *  simulated blur, then the settle. */
async function holdThenSettle(accept: HTMLElement, settle: () => void) {
  expect(document.activeElement).toBe(accept);
  blurLikeChromium();
  await act(async () => settle());
}

function rereadArm(fresh: ConflictSides | Error) {
  const held = deferred<ConflictSides>();
  const settle = () =>
    fresh instanceof Error ? held.reject(fresh) : held.resolve(fresh);
  return { reread: () => held.promise, settle };
}

function mutationArm() {
  const held = deferred<ResolveConflictOutcome>();
  vi.mocked(resolveConflict).mockImplementation(() => held.promise);
  return held;
}

describe("ConflictResolveView Accept arms", () => {
  it("A1: a failed re-read lands on Accept (keyboard)", async () => {
    const arm = rereadArm(new Error("read failed"));
    const { accept } = await renderReady(CLEAN, arm.reread);
    await press(accept, "keyboard");
    await holdThenSettle(accept, arm.settle);
    await waitFor(() => expect(document.activeElement).toBe(accept));
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith(COPY.rereadFailed);
    expect(resolveConflict).not.toHaveBeenCalled();
  });

  it("A2: a file no longer conflicted hands focus to the host's sink", async () => {
    const arm = rereadArm(NOT_CONFLICTED);
    const { accept, sink } = await renderReady(CLEAN, arm.reread);
    await press(accept, "pointer");
    await holdThenSettle(accept, arm.settle);
    await waitFor(() => expect(document.activeElement).toBe(sink));
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith(COPY.notConflicted);
    expect(resolveConflict).not.toHaveBeenCalled();
  });

  // A file resolved outside the app into non-UTF-8 bytes reads with no stages
  // and `undecodable`: the not-conflicted refusal outranks the undecodable one.
  it("A2u: a file no longer conflicted and not UTF-8 still hands off", async () => {
    const arm = rereadArm({
      ...NOT_CONFLICTED,
      working: `first\n${String.fromCharCode(0xfffd)}\nlast\n`,
      workingUndecodable: true,
      undecodable: true,
    });
    const { accept, sink } = await renderReady(CLEAN, arm.reread);
    await press(accept, "pointer");
    await holdThenSettle(accept, arm.settle);
    await waitFor(() => expect(document.activeElement).toBe(sink));
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith(COPY.notConflicted);
    expect(resolveConflict).not.toHaveBeenCalled();
  });

  it("A3: an undecodable re-read whose file moved lands on Accept", async () => {
    const arm = rereadArm({ ...SIDES, undecodable: true, workingHash: "h2" });
    const { accept } = await renderReady(CLEAN, arm.reread);
    await press(accept, "pointer");
    await holdThenSettle(accept, arm.settle);
    await waitFor(() => expect(document.activeElement).toBe(accept));
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith(changedOnDiskCopy(BASE));
    expect(resolveConflict).not.toHaveBeenCalled();
  });

  it("A4: an undecodable re-read of an unmoved file lands on Accept", async () => {
    const arm = rereadArm({ ...SIDES, undecodable: true });
    const { accept } = await renderReady(CLEAN, arm.reread);
    await press(accept, "pointer");
    await holdThenSettle(accept, arm.settle);
    await waitFor(() => expect(document.activeElement).toBe(accept));
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith(COPY.partUndecodable);
    expect(resolveConflict).not.toHaveBeenCalled();
  });

  it("A5: a write refused as changed on disk lands on Accept (keyboard)", async () => {
    const held = mutationArm();
    const { accept } = await renderReady(CLEAN, async () => SIDES);
    await press(accept, "keyboard");
    await waitFor(() => expect(resolveConflict).toHaveBeenCalledTimes(1));
    await holdThenSettle(accept, () => held.resolve({ kind: "changedOnDisk" }));
    await waitFor(() => expect(document.activeElement).toBe(accept));
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith(changedOnDiskCopy(BASE));
  });

  it("A6: a clean accept the walk advances from hands off and advances", async () => {
    useConflictResolve.setState(OWNED_QUEUED);
    const held = mutationArm();
    const { accept, sink } = await renderReady(CLEAN, async () => SIDES);
    await press(accept, "pointer");
    await waitFor(() => expect(resolveConflict).toHaveBeenCalledTimes(1));
    await holdThenSettle(accept, () => held.resolve({ kind: "written" }));
    await waitFor(() => expect(document.activeElement).toBe(sink));
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith(COPY.resolvedNext);
    expect(useConflictResolve.getState().activePath).toBe("dir/b.txt");
  });

  // Unclean, yet the walk advances off the file, so the view leaves.
  it("A6u: a marker-keeping accept the walk advances from hands off and advances", async () => {
    useConflictResolve.setState(OWNED_QUEUED);
    const held = mutationArm();
    const { accept, sink } = await renderReady(MARKED, async () => SIDES);
    await press(accept, "pointer");
    await waitFor(() => expect(resolveConflict).toHaveBeenCalledTimes(1));
    await holdThenSettle(accept, () => held.resolve({ kind: "written" }));
    await waitFor(() => expect(document.activeElement).toBe(sink));
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(COPY.markersLeft);
    expect(resolveConflict).toHaveBeenCalledWith(
      REPO,
      PATH,
      expect.any(String),
      false,
      "h1",
    );
    expect(useConflictResolve.getState().activePath).toBe("dir/b.txt");
  });

  // No simulated blur: focus still sits on the disabled pressed button.
  it("A6p: a hand-off moves focus left on the pressed button", async () => {
    const held = mutationArm();
    const { accept, sink } = await renderReady(CLEAN, async () => SIDES);
    await press(accept, "pointer");
    await waitFor(() => expect(resolveConflict).toHaveBeenCalledTimes(1));
    expect(document.activeElement).toBe(accept);
    await act(async () => held.resolve({ kind: "written" }));
    await waitFor(() => expect(document.activeElement).toBe(sink));
    expect(toast.success).toHaveBeenCalledWith(COPY.resolved);
  });

  it("A6b: a clean accept outside any walk hands off", async () => {
    const held = mutationArm();
    const { accept, sink } = await renderReady(CLEAN, async () => SIDES);
    await press(accept, "pointer");
    await waitFor(() => expect(resolveConflict).toHaveBeenCalledTimes(1));
    await holdThenSettle(accept, () => held.resolve({ kind: "written" }));
    await waitFor(() => expect(document.activeElement).toBe(sink));
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith(COPY.resolved);
  });

  it("A6c: a clean accept the walk holds still hands off", async () => {
    useConflictResolve.setState(OWNED_HELD);
    const held = mutationArm();
    const { accept, sink } = await renderReady(CLEAN, async () => SIDES);
    await press(accept, "pointer");
    await waitFor(() => expect(resolveConflict).toHaveBeenCalledTimes(1));
    await holdThenSettle(accept, () => held.resolve({ kind: "written" }));
    await waitFor(() => expect(document.activeElement).toBe(sink));
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith(COPY.resolved);
    expect(useConflictResolve.getState().activePath).toBe(PATH);
  });

  it("A7: markers kept while the walk holds the file land on Accept", async () => {
    useConflictResolve.setState(OWNED_HELD);
    const held = mutationArm();
    const { accept } = await renderReady(MARKED, async () => SIDES);
    await press(accept, "pointer");
    await waitFor(() => expect(resolveConflict).toHaveBeenCalledTimes(1));
    await holdThenSettle(accept, () => held.resolve({ kind: "written" }));
    await waitFor(() => expect(document.activeElement).toBe(accept));
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(COPY.markersLeft);
    expect(resolveConflict).toHaveBeenCalledWith(
      REPO,
      PATH,
      expect.any(String),
      false,
      "h1",
    );
  });

  it("A7b: markers kept outside any walk hand off", async () => {
    useConflictResolve.setState({ scopePath: null, activePath: PATH });
    const held = mutationArm();
    const { accept, sink } = await renderReady(MARKED, async () => SIDES);
    await press(accept, "pointer");
    await waitFor(() => expect(resolveConflict).toHaveBeenCalledTimes(1));
    await holdThenSettle(accept, () => held.resolve({ kind: "written" }));
    await waitFor(() => expect(document.activeElement).toBe(sink));
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(COPY.markersLeft);
    expect(resolveConflict).toHaveBeenCalledWith(
      REPO,
      PATH,
      expect.any(String),
      false,
      "h1",
    );
  });

  it("A7c: markers kept while the walk is on another file hand off", async () => {
    useConflictResolve.setState({
      ...OWNED_HELD,
      activePath: "dir/other.txt",
    });
    const held = mutationArm();
    const { accept, sink } = await renderReady(MARKED, async () => SIDES);
    await press(accept, "pointer");
    await waitFor(() => expect(resolveConflict).toHaveBeenCalledTimes(1));
    await holdThenSettle(accept, () => held.resolve({ kind: "written" }));
    await waitFor(() => expect(document.activeElement).toBe(sink));
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(COPY.markersLeft);
    expect(resolveConflict).toHaveBeenCalledWith(
      REPO,
      PATH,
      expect.any(String),
      false,
      "h1",
    );
  });

  it("A8: a failed write toasts the error and lands on Accept", async () => {
    const held = mutationArm();
    const { accept } = await renderReady(CLEAN, async () => SIDES);
    await press(accept, "pointer");
    await waitFor(() => expect(resolveConflict).toHaveBeenCalledTimes(1));
    await holdThenSettle(accept, () =>
      held.reject({ kind: "io", message: "disk full" }),
    );
    await waitFor(() => expect(document.activeElement).toBe(accept));
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(toast.error).mock.calls[0][0])).toContain(
      "disk full",
    );
  });

  it("A9: closing the repo during the re-read refuses without writing or moving focus", async () => {
    const arm = rereadArm(NOT_CONFLICTED);
    const { accept } = await renderReady(CLEAN, arm.reread);
    await press(accept, "pointer");
    expect(document.activeElement).toBe(accept);
    blurLikeChromium();
    act(() => useUiStore.setState({ repoPath: null }));
    await act(async () => arm.settle());
    await waitFor(() => expect(toast.info).toHaveBeenCalledTimes(1));
    expect(toast.info).toHaveBeenCalledWith(COPY.closed);
    await waitFor(() => expect(accept).toBeEnabled());
    expect(document.activeElement).toBe(document.body);
    expect(resolveConflict).not.toHaveBeenCalled();
  });

  it("NS: a hand-off never takes focus the user moved outside the view", async () => {
    const held = mutationArm();
    const { accept } = await renderReady(CLEAN, async () => SIDES);
    await press(accept, "pointer");
    await waitFor(() => expect(resolveConflict).toHaveBeenCalledTimes(1));
    expect(document.activeElement).toBe(accept);
    const outside = screen.getByRole("button", { name: "Outside" });
    act(() => outside.focus());
    await act(async () => held.resolve({ kind: "written" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith(COPY.resolved);
    await waitFor(() => expect(accept).toBeEnabled());
    expect(document.activeElement).toBe(outside);
  });

  // A click that doesn't focus the button (WKWebView's default, or an AT
  // activation) presses with focus outside the view; the hand-off leaves it.
  it("NSp: a press made with focus outside the view leaves it there", async () => {
    const held = mutationArm();
    const { accept } = await renderReady(CLEAN, async () => SIDES);
    const outside = screen.getByRole("button", { name: "Outside" });
    act(() => outside.focus());
    fireEvent.click(accept);
    await waitFor(() => expect(resolveConflict).toHaveBeenCalledTimes(1));
    expect(document.activeElement).toBe(outside);
    await act(async () => held.resolve({ kind: "written" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith(COPY.resolved);
    await waitFor(() => expect(accept).toBeEnabled());
    expect(document.activeElement).toBe(outside);
  });
});
