import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createRef, type ReactNode } from "react";
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
import { ConflictResolveView } from "@/features/repository/ConflictResolveView";
import { aiExcludePatterns } from "@/lib/ai/ignore";
import {
  getSecret,
  gitStage,
  gitStatus,
  readRepoInstructions,
} from "@/lib/git/api";
import {
  type ConflictSides,
  conflictMarkerScan,
  conflictSides,
} from "@/lib/git/conflict";
import { TOO_LARGE_REFUSAL } from "@/lib/git/conflict-prefilter";
import type { RepoStatus } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { useConfirm } from "@/lib/stores/confirm";
import { useConflictResolve } from "@/lib/stores/conflict-resolve";
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
  readRepoInstructions: vi.fn(),
}));
vi.mock("@/lib/git/conflict", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/conflict")>()),
  conflictSides: vi.fn(),
  conflictMarkerScan: vi.fn(),
}));
vi.mock("@/lib/ai/ignore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/ignore")>()),
  aiExcludePatterns: vi.fn(),
}));
// ConflictResolveView's stream hook reaches CLI agents and fetch; stable
// functions, since its teardown effect keys on `cancel`.
const stream = vi.hoisted(() => ({
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
    text: "",
    status: "",
  }),
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
const PATH = "src/a.rs";
const READING = "Reading the conflict…";
const IO_COPY = "Couldn't read this file. It may be locked";

const IO = { kind: "io" as const, message: "locked" };
const invalid = (detail: string) => ({
  kind: "invalidArgument" as const,
  message: `invalid argument: ${detail}`,
});
const LINKED = invalid(
  `Can't resolve the conflict in ${PATH} — it's reached through a symbolic link or junction. Nothing was changed.`,
);
const TOO_LARGE = invalid(TOO_LARGE_REFUSAL);

const MARKED: ConflictSides = {
  working: "<<<<<<< HEAD\nfn a() { 1 }\n=======\nfn a() { 2 }\n>>>>>>> topic\n",
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** What every sides read answers until a test changes it: a rejection with
 *  the error, or the sides. */
let disk: ConflictSides | object;

beforeEach(() => {
  disk = IO;
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
  vi.mocked(conflictSides).mockReset();
  // The too-large strip's advisory scan; never what these cases assert.
  vi.mocked(conflictMarkerScan).mockImplementation(async () => ({
    exists: true,
    markers: true,
    binary: false,
  }));
  vi.mocked(conflictSides).mockImplementation(async () => {
    if ("working" in disk) return disk as ConflictSides;
    throw disk;
  });
  // A configured review model, so "Resolve with AI" renders whenever the view
  // offers it: its absence during a re-read is then the hold's doing.
  vi.mocked(getSecret).mockImplementation(async () => "sk-test-000000");
  vi.mocked(readRepoInstructions).mockImplementation(async () => null);
  vi.mocked(aiExcludePatterns).mockImplementation(async () => []);
  vi.mocked(gitStatus).mockImplementation(
    async (): Promise<RepoStatus> => ({
      branch: {} as RepoStatus["branch"],
      entries: [{ path: PATH, staged: "conflicted", unstaged: "conflicted" }],
    }),
  );
  vi.mocked(gitStage).mockImplementation(async () => undefined);
  stream.run.mockImplementation(async () => false);
  useUiStore.setState(useUiStore.getInitialState(), true);
  useUiStore.setState({ repoPath: REPO });
  useConfirm.setState({ request: null, requestHold: null });
  useConflictResolve.setState(useConflictResolve.getInitialState(), true);
});

afterEach(() => {
  // Unmount on the fake clock: setup.ts's cleanup runs after this hook, and the
  // last query observer leaving would arm a real gc timer that outlives the case.
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

afterAll(() => expect(unmockedCommands).toEqual([]));

/** Fakes timeouts and intervals (the poll, the io retry delay, A5's 2500 ms
 *  advance); rAF, performance and setImmediate stay real for React and Base UI.
 *  waitFor moves the fake clock, detecting it through the jest stub. */
function installFakeClock() {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.stubGlobal("jest", { advanceTimersByTime: vi.advanceTimersByTime });
}

function newClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, structuredClone(DEFAULT_SETTINGS));
  client.setQueryData(settingsKeys.secret("anthropic"), {
    length: 14,
    masked: "sk-tes...0000",
  });
  return client;
}

function renderView() {
  const client = newClient();
  const sink = createRef<HTMLDivElement>();
  const tree = (repoPath: string, path: string): ReactNode => (
    <QueryClientProvider client={client}>
      <div ref={sink} tabIndex={-1} />
      <ConflictFileView repoPath={repoPath} path={path} focusSink={sink} />
    </QueryClientProvider>
  );
  const view = render(tree(REPO, PATH));
  return {
    client,
    container: view.container,
    rerender: (repoPath: string, path: string) =>
      view.rerender(tree(repoPath, path)),
    /** Re-reads the conflict file exactly as a poll tick or a show does, and
     *  outwaits react-query's batched notify so the view renders the fetch. */
    reread: () =>
      act(async () => {
        void client.refetchQueries({
          queryKey: ["repo", REPO, "conflict-file", PATH],
        });
        if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(50);
        else await new Promise((r) => setTimeout(r, 50));
      }),
  };
}

/** Records whether the spinner line is ever inserted under `root`, frames
 *  that a later commit removes included. */
function watchSpinner(root: HTMLElement) {
  let seen = false;
  const check = (records: MutationRecord[]) => {
    for (const record of records) {
      if (record.target.textContent?.includes(READING)) seen = true;
      for (const node of record.addedNodes)
        if (node.textContent?.includes(READING)) seen = true;
    }
  };
  const observer = new MutationObserver(check);
  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  return () => {
    check(observer.takeRecords());
    observer.disconnect();
    return seen;
  };
}

const errorCopy = () =>
  screen.queryByText((content) => content.includes(IO_COPY));
const acceptAll = (side: "current" | "incoming") =>
  screen.getByRole("button", { name: `Accept all ${side}` });

describe("ConflictFileView holds its read error across re-reads", () => {
  it("A1/A3: a poll re-read in flight keeps the error, and a success replaces it", async () => {
    installFakeClock();
    const view = renderView();
    await screen.findByText((content) => content.includes(IO_COPY));
    const stop = watchSpinner(view.container);

    // The next poll tick's read stays in flight until released.
    const before = vi.mocked(conflictSides).mock.calls.length;
    const held = deferred<ConflictSides>();
    vi.mocked(conflictSides).mockImplementationOnce(() => held.promise);
    await waitFor(
      () =>
        expect(vi.mocked(conflictSides).mock.calls.length).toBeGreaterThan(
          before,
        ),
      { timeout: 4000 },
    );
    expect(screen.queryByText(READING)).not.toBeInTheDocument();
    expect(errorCopy()).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Resolve with AI" }),
    ).not.toBeInTheDocument();

    // A failed re-read, its `io` retry included, keeps the copy in place.
    const failedAt = vi.mocked(conflictSides).mock.calls.length;
    await act(async () => held.reject(IO));
    await waitFor(() =>
      expect(vi.mocked(conflictSides).mock.calls.length).toBeGreaterThan(
        failedAt,
      ),
    );
    await waitFor(() => expect(errorCopy()).toBeInTheDocument());

    // A successful read lands the regions in the commit that drops the error.
    const healed = deferred<ConflictSides>();
    vi.mocked(conflictSides).mockImplementationOnce(() => healed.promise);
    await view.reread();
    expect(errorCopy()).toBeInTheDocument();
    await act(async () => healed.resolve(MARKED));
    await screen.findAllByRole("button", { name: "Accept current" });
    expect(errorCopy()).not.toBeInTheDocument();
    expect(stop()).toBe(false);
    // Positive control for the AI assertion above: the button renders here.
    expect(
      screen.getByRole("button", { name: "Resolve with AI" }),
    ).toBeInTheDocument();
  });

  it("A3: a later failure with data kept shows the error as before", async () => {
    disk = MARKED;
    const view = renderView();
    await screen.findAllByRole("button", { name: "Accept current" });
    disk = IO;
    const stop = watchSpinner(view.container);
    await view.reread();
    await waitFor(() => expect(errorCopy()).toBeInTheDocument());
    expect(stop()).toBe(false);
  });

  it("A2: a path refusal keeps both Accept all buttons held through a re-read", async () => {
    disk = LINKED;
    const view = renderView();
    await screen.findByText((content) =>
      content.includes("Resolve it in your editor or a terminal."),
    );
    await waitFor(() =>
      expect(acceptAll("current")).toHaveAttribute("aria-disabled", "true"),
    );
    const held = deferred<ConflictSides>();
    vi.mocked(conflictSides).mockImplementationOnce(() => held.promise);
    await view.reread();
    expect(vi.mocked(conflictSides)).toHaveBeenLastCalledWith(REPO, PATH, []);
    expect(screen.queryByText(READING)).not.toBeInTheDocument();
    expect(acceptAll("current")).toHaveAttribute("aria-disabled", "true");
    expect(acceptAll("incoming")).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.queryByRole("button", { name: "Resolve with AI" }),
    ).not.toBeInTheDocument();
    await act(async () => held.reject(LINKED));
  });

  it("A2: a too-large refusal keeps its Mark resolved strip through a re-read", async () => {
    disk = TOO_LARGE;
    const view = renderView();
    await screen.findByRole("button", { name: "Mark resolved" });
    const held = deferred<ConflictSides>();
    vi.mocked(conflictSides).mockImplementationOnce(() => held.promise);
    await view.reread();
    expect(screen.queryByText(READING)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Mark resolved" }),
    ).toBeInTheDocument();
    await act(async () => held.reject(TOO_LARGE));
  });

  it.each([
    ["another path", REPO, "src/b.rs"],
    ["the same path in another repo", "C:/repos/other", PATH],
  ])(
    "A4: %s starts on the spinner, never the first one's error",
    async (_, repoPath, path) => {
      const view = renderView();
      await screen.findByText((content) => content.includes(IO_COPY));
      vi.mocked(conflictSides).mockImplementation(
        () => new Promise<ConflictSides>(() => undefined),
      );
      act(() => view.rerender(repoPath, path));
      expect(await screen.findByText(READING)).toBeInTheDocument();
      expect(errorCopy()).not.toBeInTheDocument();
      expect(vi.mocked(conflictSides)).toHaveBeenLastCalledWith(
        repoPath,
        path,
        [],
      );
    },
  );
});

describe("ConflictResolveView reads its sides once", () => {
  it("A5: a failed sides read settles on Try again and never re-reads by itself", async () => {
    installFakeClock();
    const client = newClient();
    render(
      <QueryClientProvider client={client}>
        <ConflictResolveView repoPath={REPO} path={PATH} />
      </QueryClientProvider>,
    );
    expect(
      await screen.findByText("Couldn't get a resolution. Try again."),
    ).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalled();
    expect(conflictSides).toHaveBeenCalledTimes(1);
    // Longer than ConflictFileView's poll interval: nothing here polls.
    await act(() => vi.advanceTimersByTimeAsync(2500));
    expect(conflictSides).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(READING)).not.toBeInTheDocument();
  });
});
