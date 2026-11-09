import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { DiffContent, DiffSurface } from "@/features/diff/DiffSurface";
import { DiffViewer } from "@/features/diff/DiffViewer";
import {
  WHITESPACE_ANNOUNCEMENT,
  WHITESPACE_COMPOSER_HELD,
  WHITESPACE_ONLY_MESSAGE,
  WHITESPACE_STRIP_COPY,
} from "@/features/diff/whitespace-mode";
import { toDraft } from "@/features/settings/settings-form";
import {
  gitBlobSizes,
  gitBranchFileDiff,
  gitCommitDetails,
  gitCommitFileDiff,
  gitCommitFiles,
  gitDiffFile,
  gitOrphanedStashFileDiff,
  gitSessionFileDiff,
  gitStatus,
  gitSubmoduleChanges,
} from "@/lib/git/api";
import {
  classifyHeaderOnlyDiff,
  modeChangeMessage,
} from "@/lib/git/diff-split";
import {
  repoKeys,
  useBranchFileDiff,
  useCommitFileDiff,
  useFileDiff,
  useOrphanedStashFileDiff,
  usePrefetchCommit,
  usePrefetchCommitFileDiff,
  useSessionFileDiff,
} from "@/lib/git/queries";
import type { FileDiff, RepoStatus, SubmoduleChanges } from "@/lib/git/types";
import {
  type AppSettings,
  loadSettings,
  saveSettingsPatch,
} from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import {
  useHideWhitespace,
  useSetHideWhitespace,
} from "@/lib/settings/hide-whitespace";
import { settingsKeys } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { stubCanvas } from "./canvas-stub";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitStatus: vi.fn(),
  gitDiffFile: vi.fn(),
  gitBlobSizes: vi.fn(),
  gitSessionFileDiff: vi.fn(),
  gitCommitFileDiff: vi.fn(),
  gitBranchFileDiff: vi.fn(),
  gitOrphanedStashFileDiff: vi.fn(),
  gitCommitDetails: vi.fn(),
  gitCommitFiles: vi.fn(),
  gitSubmoduleChanges: vi.fn(),
}));

vi.mock("@/features/repository/useOpenSubmoduleAsRepo", () => ({
  useOpenSubmoduleAsRepo: () => async () => true,
}));

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
  saveSettingsPatch: vi.fn(),
}));

vi.mock("@/lib/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/toast")>()),
  toastError: vi.fn(),
}));

beforeAll(stubCanvas);

const TEXT =
  "diff --git a/x b/x\nindex 1111aaa..2222bbb 100644\n--- a/x\n+++ b/x\n" +
  "@@ -1 +1 @@\n-target\n+other\n";
const RENAME =
  "diff --git a/old b/x\nsimilarity index 80%\nrename from old\nrename to x\n" +
  "index 1111aaa..2222bbb 100644\n";
const diffOf = (text: string, filePath = "x"): FileDiff => ({
  filePath,
  text,
  isBinary: false,
  isTruncated: false,
});

/** The settings store the mocked api reads and writes. */
let stored: AppSettings = DEFAULT_SETTINGS;

function newClient(hide: boolean | null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (hide !== null) {
    stored = { ...DEFAULT_SETTINGS, diffHideWhitespace: hide };
    client.setQueryData(settingsKeys.settings, stored);
  }
  return client;
}

const wrap = (client: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };

function changes(hide: boolean, answer: (iw: boolean) => FileDiff) {
  vi.mocked(gitDiffFile).mockImplementation(
    async (_repo, _path, _staged, _untracked, iw = false) => answer(iw),
  );
  const client = newClient(hide);
  const utils = render(<DiffViewer repoPath="/repo" />, {
    wrapper: wrap(client),
  });
  return { client, ...utils };
}

/** An answer stamped the way readViewDiff stamps one read under `hide`. */
const stamped = (diff: FileDiff, hide: boolean): FileDiff => ({
  ...diff,
  whitespaceHidden: hide,
});

function SurfaceHarness({ keep = false }: { keep?: boolean }) {
  const hide = stored.diffHideWhitespace === true;
  const diff = useQuery({
    queryKey: ["surface", hide],
    queryFn: async () => stamped(diffOf(TEXT), hide),
    placeholderData: keep ? (prev) => prev : undefined,
  });
  return <DiffSurface filePath="x" diff={diff} />;
}

const flips = () =>
  vi.mocked(saveSettingsPatch).mock.calls.map(([patch]) => patch);

beforeEach(() => {
  vi.clearAllMocks();
  stored = DEFAULT_SETTINGS;
  vi.mocked(loadSettings).mockImplementation(async () => stored);
  vi.mocked(saveSettingsPatch).mockImplementation(async (patch) => {
    stored = { ...stored, ...patch };
    return stored;
  });
  vi.mocked(gitBlobSizes).mockResolvedValue({ oldSize: null, newSize: 7 });
  vi.mocked(gitStatus).mockResolvedValue({
    branch: { name: "main", detached: false, oid: null, upstream: null },
    entries: [{ path: "x", staged: null, unstaged: "modified" }],
  } as unknown as RepoStatus);
  useUiStore.setState({
    selectedFile: { path: "x", staged: false, untracked: false },
  });
});

describe("Changes with whitespace hidden", () => {
  it("reads with -w, shows the strip and holds every hunk write", async () => {
    changes(true, () => diffOf(TEXT));
    expect(
      await screen.findByText(WHITESPACE_STRIP_COPY.unstaged),
    ).toBeTruthy();
    expect(vi.mocked(gitDiffFile).mock.calls.map((c) => c[4])).toContain(true);
    expect(vi.mocked(gitDiffFile).mock.calls.every((c) => c[4] === true)).toBe(
      true,
    );
    // The hunk buttons ride rows jsdom never lays out; their held state and
    // reason are pinned in scripts/hide-whitespace.test.mjs.
    expect(screen.queryByText(/Drag across the line numbers to/)).toBeNull();
  });

  it("Show whitespace on the strip turns the mode off", async () => {
    const user = userEvent.setup();
    changes(true, () => diffOf(TEXT));
    const strip = await screen.findByText(WHITESPACE_STRIP_COPY.unstaged);
    expect(strip.closest('[role="status"],[aria-live]')).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show whitespace" }));
    await waitFor(() =>
      expect(flips()).toEqual([{ diffHideWhitespace: false }]),
    );
    await waitFor(() =>
      expect(vi.mocked(gitDiffFile).mock.calls.map((c) => c[4])).toContain(
        false,
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText(WHITESPACE_STRIP_COPY.unstaged)).toBeNull(),
    );
    await screen.findByText(/Drag across the line numbers to/);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("says when only whitespace changed, and brings the hunk back", async () => {
    const user = userEvent.setup();
    changes(true, (iw) => diffOf(iw ? "" : TEXT));
    expect(await screen.findByText(WHITESPACE_ONLY_MESSAGE)).toBeTruthy();
    expect(screen.queryByText("No changes to show")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show whitespace" }));
    await screen.findByText(/Drag across the line numbers to/);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("keeps No changes to show for a diff empty in both reads", async () => {
    changes(true, () => diffOf(""));
    expect(await screen.findByText("No changes to show")).toBeTruthy();
    expect(screen.queryByText(WHITESPACE_ONLY_MESSAGE)).toBeNull();
  });

  it("a rename whose content change was whitespace says so, with its ends", async () => {
    changes(true, (iw) =>
      diffOf(
        iw ? RENAME : `${RENAME}--- a/old\n+++ b/x\n@@ -1 +1 @@\n-a\n+ a\n`,
      ),
    );
    expect(await screen.findByText(WHITESPACE_ONLY_MESSAGE)).toBeTruthy();
    expect(screen.getByText("From")).toBeTruthy();
    expect(screen.getByText("To")).toBeTruthy();
    expect(screen.queryByText(/Renamed with no content changes/)).toBeNull();
  });

  it("shows no strip over the read-only fallback (a binary diff)", async () => {
    changes(true, () => ({
      ...diffOf("Binary files a/x and b/x differ\n"),
      isBinary: true,
    }));
    await screen.findByText(/Binary file/);
    expect(screen.queryByText(WHITESPACE_STRIP_COPY.unstaged)).toBeNull();
  });
});

describe("the view-options gear", () => {
  it("names its state, writes the patch once the menu closes, keeps focus", async () => {
    const user = userEvent.setup();
    changes(false, () => diffOf(TEXT));
    const gear = await screen.findByRole("button", { name: "View options" });
    const group = screen.getByRole("group", { name: "Diff view mode" });
    expect(
      gear.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await user.click(gear);
    const item = await screen.findByRole("menuitemcheckbox", {
      name: "Hide whitespace changes",
    });
    expect(item.getAttribute("aria-checked")).toBe("false");
    await user.click(item);
    await waitFor(() =>
      expect(flips()).toEqual([{ diffHideWhitespace: true }]),
    );
    await waitFor(() =>
      expect(screen.queryByRole("menuitemcheckbox")).toBeNull(),
    );
    expect(
      await screen.findByRole("button", {
        name: "View options, whitespace changes hidden",
      }),
    ).toBeTruthy();
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  });

  it("is on every DiffSurface host and absent from a bare DiffContent", async () => {
    newClient(false);
    const client = newClient(true);
    const { unmount } = render(<SurfaceHarness />, { wrapper: wrap(client) });
    expect(
      await screen.findByRole("button", { name: /View options/ }),
    ).toBeTruthy();
    for (const status of screen.queryAllByRole("status"))
      expect(status.textContent).not.toContain(WHITESPACE_ANNOUNCEMENT.hidden);
    unmount();
    render(
      <DiffContent
        filePath="x"
        data={diffOf(TEXT)}
        isPending={false}
        isError={false}
      />,
      { wrapper: wrap(client) },
    );
    expect(screen.queryByRole("button", { name: /View options/ })).toBeNull();
  });

  it("a held key never flips it; a fresh press does", async () => {
    const user = userEvent.setup();
    render(<SurfaceHarness />, { wrapper: wrap(newClient(false)) });
    await user.click(
      await screen.findByRole("button", { name: "View options" }),
    );
    const item = await screen.findByRole("menuitemcheckbox");
    fireEvent.keyDown(item, { key: "Enter", repeat: true });
    expect(flips()).toEqual([]);
    expect(screen.getByRole("menuitemcheckbox")).toBeTruthy();
    fireEvent.keyDown(item, { key: "Enter" });
    await waitFor(() =>
      expect(flips()).toEqual([{ diffHideWhitespace: true }]),
    );
  });

  it("L1: a held key's repeat never opens the closed gear; a fresh press does", async () => {
    const user = userEvent.setup();
    render(<SurfaceHarness />, { wrapper: wrap(newClient(false)) });
    const gear = await screen.findByRole("button", { name: "View options" });
    gear.focus();
    // A cancelled keydown is what keeps the browser from activating the
    // button, so the repeat must come back default-prevented.
    for (const key of ["Enter", " "])
      expect(fireEvent.keyDown(gear, { key, repeat: true }), key).toBe(false);
    expect(screen.queryByRole("menuitemcheckbox")).toBeNull();
    expect(fireEvent.keyDown(gear, { key: "Enter" })).toBe(true);
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("menuitemcheckbox")).toBeTruthy();
  });

  it("holds the flip while a line composer is open in the pane", async () => {
    const user = userEvent.setup();
    const info = vi.spyOn(toast, "info");
    const { container } = render(<SurfaceHarness />, {
      wrapper: wrap(newClient(false)),
    });
    await screen.findByRole("button", { name: "View options" });
    const scroller = container.querySelector(".overflow-auto");
    const composer = document.createElement("div");
    composer.setAttribute("data-diff-line-widget", "");
    scroller?.append(composer);
    await user.click(screen.getByRole("button", { name: "View options" }));
    await user.click(await screen.findByRole("menuitemcheckbox"));
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith(WHITESPACE_COMPOSER_HELD),
    );
    expect(flips()).toEqual([]);
    composer.remove();
    await user.click(screen.getByRole("button", { name: "View options" }));
    await user.click(await screen.findByRole("menuitemcheckbox"));
    await waitFor(() =>
      expect(flips()).toEqual([{ diffHideWhitespace: true }]),
    );
  });
});

describe("the whitespace-only state", () => {
  const only: FileDiff = {
    ...diffOf("", "x"),
    whitespaceOnly: true,
    whitespaceHidden: true,
  };
  it("never shows under another file's path", () => {
    const { container } = render(
      <DiffContent
        filePath="y"
        data={only}
        isPending={false}
        isError={false}
      />,
      { wrapper: wrap(newClient(true)) },
    );
    expect(screen.queryByText(WHITESPACE_ONLY_MESSAGE)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Show whitespace" }),
    ).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });
  it("shows for its own file", () => {
    render(
      <DiffContent
        filePath="x"
        data={only}
        isPending={false}
        isError={false}
      />,
      { wrapper: wrap(newClient(true)) },
    );
    expect(screen.getByText(WHITESPACE_ONLY_MESSAGE)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Show whitespace" }),
    ).toBeTruthy();
  });
  it("a retained whitespace-only -w answer with the mode off lands like another file's", () => {
    const { container } = render(
      <DiffContent
        filePath="x"
        data={only}
        isPending={false}
        isError={false}
        whitespaceControl
      />,
      { wrapper: wrap(newClient(false)) },
    );
    expect(screen.queryByText(WHITESPACE_ONLY_MESSAGE)).toBeNull();
    expect(screen.queryByText("No changes to show")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Show whitespace" }),
    ).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });
  it("a retained plain answer keeps painting with the mode on", () => {
    const { container } = render(
      <DiffContent
        filePath="x"
        data={stamped(diffOf(TEXT), false)}
        isPending={false}
        isError={false}
        whitespaceControl
      />,
      { wrapper: wrap(newClient(true)) },
    );
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(container.textContent).toContain("target");
  });
  it("a retained -w answer with hunks keeps painting with the mode off", () => {
    const { container } = render(
      <DiffContent
        filePath="x"
        data={stamped(diffOf(TEXT), true)}
        isPending={false}
        isError={false}
        whitespaceControl
      />,
      { wrapper: wrap(newClient(false)) },
    );
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(container.textContent).toContain("target");
  });
  it("a whitespace host's UNSTAMPED answer renders normally with the mode on", () => {
    const { container } = render(
      <DiffContent
        filePath="x"
        data={diffOf(TEXT)}
        isPending={false}
        isError={false}
        whitespaceControl
      />,
      { wrapper: wrap(newClient(true)) },
    );
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(container.textContent).toContain("target");
  });
  // Whitespace-only with the mode off, so only the control gate keeps it from
  // reading as stale.
  it("a host without the control never lands a whitespace-only answer with the mode off", () => {
    const { container } = render(
      <DiffContent
        filePath="x"
        data={only}
        isPending={false}
        isError={false}
      />,
      { wrapper: wrap(newClient(false)) },
    );
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });
});

describe("the announcement", () => {
  const announced = (text: string) =>
    screen.queryAllByRole("status").filter((s) => s.textContent?.includes(text))
      .length;

  it("announces a flip once, in the staging arm's status span", async () => {
    const { client } = changes(false, () => diffOf(TEXT));
    await screen.findByText(/Drag across the line numbers to/);
    client.setQueryData(settingsKeys.settings, {
      ...stored,
      diffHideWhitespace: true,
    });
    await waitFor(() =>
      expect(announced(WHITESPACE_ANNOUNCEMENT.hidden)).toBe(1),
    );
    client.setQueryData(settingsKeys.settings, {
      ...stored,
      diffHideWhitespace: false,
    });
    await waitFor(() =>
      expect(announced(WHITESPACE_ANNOUNCEMENT.shown)).toBe(1),
    );
    expect(announced(WHITESPACE_ANNOUNCEMENT.hidden)).toBe(0);
  });

  it("L2: a flip whose diff reloads mounts the status span empty, then fills it once", async () => {
    const { client } = changes(false, () => diffOf(TEXT));
    await screen.findByText(/Drag across the line numbers to/);
    // Every text each status element held, in the order the observer saw it.
    const history = new Map<Element, string[]>();
    const record = () => {
      for (const s of screen.queryAllByRole("status")) {
        const seen = history.get(s) ?? [];
        const text = s.textContent ?? "";
        if (seen.at(-1) !== text) seen.push(text);
        history.set(s, seen);
      }
    };
    const observer = new MutationObserver(record);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    const before = new Set(screen.queryAllByRole("status"));
    act(() =>
      client.setQueryData(settingsKeys.settings, {
        ...stored,
        diffHideWhitespace: true,
      }),
    );
    await waitFor(() =>
      expect(announced(WHITESPACE_ANNOUNCEMENT.hidden)).toBe(1),
    );
    observer.disconnect();
    const [span] = screen
      .queryAllByRole("status")
      .filter((s) => s.textContent?.includes(WHITESPACE_ANNOUNCEMENT.hidden));
    // The key wasn't cached, so the arm (and its span) remounted.
    expect(before.has(span)).toBe(false);
    expect(history.get(span)).toEqual(["", WHITESPACE_ANNOUNCEMENT.hidden]);
  });

  it("announces nothing on a mount with the mode already on", async () => {
    changes(true, () => diffOf(TEXT));
    await screen.findByText(WHITESPACE_STRIP_COPY.unstaged);
    expect(announced(WHITESPACE_ANNOUNCEMENT.hidden)).toBe(0);
    expect(announced(WHITESPACE_ANNOUNCEMENT.shown)).toBe(0);
  });
});

describe("the view-diff hooks key and read by the mode", () => {
  const answer = async () => diffOf(TEXT);
  const cases = [
    [
      "useFileDiff",
      gitDiffFile,
      () => useFileDiff("/r", { path: "x", staged: false, untracked: false }),
    ],
    [
      "useSessionFileDiff",
      gitSessionFileDiff,
      () => useSessionFileDiff("/r", "x", "b", true, false),
    ],
    [
      "useCommitFileDiff",
      gitCommitFileDiff,
      () => useCommitFileDiff("/r", "h", "x"),
    ],
    [
      "useBranchFileDiff",
      gitBranchFileDiff,
      () => useBranchFileDiff("/r", "a", "b", "x"),
    ],
    [
      "useOrphanedStashFileDiff",
      gitOrphanedStashFileDiff,
      () => useOrphanedStashFileDiff("/r", "s", "x"),
    ],
  ] as const;
  for (const [name, api, hook] of cases)
    for (const hide of [true, false])
      it(`${name} with the mode ${hide ? "on" : "off"}`, async () => {
        const fn = api as unknown as Mock<() => Promise<FileDiff>>;
        fn.mockImplementation(answer);
        const client = newClient(hide);
        const { result } = renderHook(hook, { wrapper: wrap(client) });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(fn.mock.calls).toHaveLength(1);
        expect((fn.mock.calls[0] as unknown[]).at(-1)).toBe(hide);
        const keys = client
          .getQueryCache()
          .getAll()
          .map((q) => q.queryKey)
          .filter((k) => k[0] !== "settings");
        expect(keys.some((k) => k.at(-1) === hide)).toBe(true);
      });

  it("a hover prefetch warms the key the view will read", async () => {
    vi.mocked(gitCommitFileDiff).mockImplementation(answer);
    const client = newClient(true);
    const { result } = renderHook(() => usePrefetchCommitFileDiff("/r"), {
      wrapper: wrap(client),
    });
    await result.current("h", "x");
    expect(vi.mocked(gitCommitFileDiff).mock.calls[0]?.at(-1)).toBe(true);
    const keys = client
      .getQueryCache()
      .getAll()
      .map((q) => q.queryKey);
    expect(keys.some((k) => k.includes("h") && k.at(-1) === true)).toBe(true);
  });
});

describe("the setting", () => {
  it("stays out of the Settings screen's draft", () => {
    expect("diffHideWhitespace" in toDraft(DEFAULT_SETTINGS)).toBe(false);
  });

  it("the setter: guards, cancel-then-patch, field-only write, scoped rollback", async () => {
    const empty = newClient(null);
    const bare = renderHook(() => useSetHideWhitespace(), {
      wrapper: wrap(empty),
    });
    bare.result.current(true);
    expect(flips()).toEqual([]);

    const client = newClient(false);
    const { result } = renderHook(() => useSetHideWhitespace(), {
      wrapper: wrap(client),
    });
    result.current(false);
    expect(flips()).toEqual([]);

    let seenAtCancel: boolean | undefined;
    const cancel = vi
      .spyOn(client, "cancelQueries")
      .mockImplementation(async () => {
        seenAtCancel = client.getQueryData<AppSettings>(
          settingsKeys.settings,
        )?.diffHideWhitespace;
      });
    result.current(true);
    expect(cancel).toHaveBeenCalledWith({
      queryKey: settingsKeys.settings,
      exact: true,
    });
    expect(seenAtCancel).toBe(false);
    expect(
      client.getQueryData<AppSettings>(settingsKeys.settings)
        ?.diffHideWhitespace,
    ).toBe(true);
    // Exactly one write so far, so neither guarded call above wrote.
    await waitFor(() =>
      expect(flips()).toEqual([{ diffHideWhitespace: true }]),
    );
    await waitFor(() => expect(stored.diffHideWhitespace).toBe(true));

    vi.mocked(saveSettingsPatch).mockRejectedValueOnce(new Error("disk"));
    const before = client.getQueryData<AppSettings>(settingsKeys.settings);
    result.current(false);
    // Another field written between the flip and the rejection survives the
    // rollback, which restores the whitespace field alone.
    const other = !before?.diffFileListCollapsed;
    client.setQueryData<AppSettings>(settingsKeys.settings, (s) =>
      s === undefined ? s : { ...s, diffFileListCollapsed: other },
    );
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    await waitFor(() =>
      expect(client.getQueryData<AppSettings>(settingsKeys.settings)).toEqual({
        ...before,
        diffFileListCollapsed: other,
      }),
    );

    let rejectFirst: (e: Error) => void = () => undefined;
    vi.mocked(saveSettingsPatch).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectFirst = reject;
        }),
    );
    result.current(false);
    result.current(true);
    result.current(false);
    await waitFor(() => expect(flips()).toHaveLength(5));
    await waitFor(() => expect(stored.diffHideWhitespace).toBe(false));
    rejectFirst(new Error("late"));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(2));
    expect(
      client.getQueryData<AppSettings>(settingsKeys.settings)
        ?.diffHideWhitespace,
    ).toBe(false);
  });

  /** Holds each write until the test settles it, in flip order. */
  function heldWrites() {
    const held: {
      resolve: (s: AppSettings) => void;
      reject: (e: Error) => void;
    }[] = [];
    vi.mocked(saveSettingsPatch).mockImplementation(
      () =>
        new Promise<AppSettings>((resolve, reject) => {
          held.push({ resolve, reject });
        }),
    );
    return held;
  }

  const cached = (client: QueryClient) =>
    client.getQueryData<AppSettings>(settingsKeys.settings)?.diffHideWhitespace;

  it("the setter: two failing flips land the settled value without a refetch", async () => {
    const client = newClient(false);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const held = heldWrites();
    const { result } = renderHook(() => useSetHideWhitespace(), {
      wrapper: wrap(client),
    });
    result.current(true);
    result.current(false);
    await waitFor(() => expect(held).toHaveLength(2));
    expect(cached(client)).toBe(false);

    held[0]?.reject(new Error("first"));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    // A stale rejection restores nothing.
    expect(cached(client)).toBe(false);

    held[1]?.reject(new Error("second"));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(2));
    // The settled value (disk's), never the first flip's optimistic `true`.
    expect(cached(client)).toBe(false);
    expect(
      invalidate.mock.calls.some(
        ([filters]) =>
          JSON.stringify(filters?.queryKey) ===
          JSON.stringify(settingsKeys.settings),
      ),
    ).toBe(false);
  });

  it("the setter: a successful write advances the settled value", async () => {
    const client = newClient(false);
    const held = heldWrites();
    const { result } = renderHook(() => useSetHideWhitespace(), {
      wrapper: wrap(client),
    });
    result.current(true);
    result.current(false);
    await waitFor(() => expect(held).toHaveLength(2));

    held[0]?.resolve({ ...stored, diffHideWhitespace: true });
    // The settings chain lands writes in flip order: drain the success first.
    await new Promise((r) => setTimeout(r, 0));
    held[1]?.reject(new Error("second"));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(cached(client)).toBe(true));
  });
});

const viewOptions = () => screen.getByRole("button", { name: /View options/ });
const otherModeKey = (hide: boolean) =>
  [...repoKeys.diff("/repo", "x", false), false, hide] as const;

describe("a flip served from the cache (Changes)", () => {
  const sink = (container: HTMLElement) =>
    container.querySelector(".relative.h-full > span[tabindex='-1']");

  it("Show whitespace keeps the staging view and lands on the pane's sink", async () => {
    const user = userEvent.setup();
    vi.mocked(gitDiffFile).mockImplementation(async () => diffOf(TEXT));
    const client = newClient(true);
    client.setQueryData(otherModeKey(false), diffOf(TEXT));
    const { container } = render(<DiffViewer repoPath="/repo" />, {
      wrapper: wrap(client),
    });
    await screen.findByText(WHITESPACE_STRIP_COPY.unstaged);
    const gear = viewOptions();
    await user.click(screen.getByRole("button", { name: "Show whitespace" }));
    await waitFor(() =>
      expect(screen.queryByText(WHITESPACE_STRIP_COPY.unstaged)).toBeNull(),
    );
    expect(gear.isConnected).toBe(true);
    expect(viewOptions()).toBe(gear);
    expect(sink(container)).not.toBeNull();
    expect(document.activeElement).toBe(sink(container));
  });

  it("a flip on with the -w answer cached keeps the view and the focus", async () => {
    vi.mocked(gitDiffFile).mockImplementation(async () => diffOf(TEXT));
    const client = newClient(false);
    client.setQueryData(otherModeKey(true), {
      ...diffOf(TEXT),
      whitespaceHidden: true,
    });
    render(<DiffViewer repoPath="/repo" />, { wrapper: wrap(client) });
    await screen.findByText(/Drag across the line numbers to/);
    const gear = viewOptions();
    act(() => gear.focus());
    act(() =>
      client.setQueryData(settingsKeys.settings, {
        ...stored,
        diffHideWhitespace: true,
      }),
    );
    await screen.findByText(WHITESPACE_STRIP_COPY.unstaged);
    expect(viewOptions()).toBe(gear);
    expect(document.activeElement).toBe(gear);
  });
});

const WS_ONLY: FileDiff = {
  ...diffOf(""),
  whitespaceOnly: true,
  whitespaceHidden: true,
};

function ModeHarness({
  keep,
  answer,
}: {
  keep: boolean;
  answer: (hide: boolean) => FileDiff;
}) {
  const hide = useHideWhitespace();
  const diff = useQuery({
    queryKey: ["mode-surface", hide],
    queryFn: async () => answer(hide),
    placeholderData: keep ? (prev) => prev : undefined,
  });
  return <DiffSurface filePath="x" diff={diff} />;
}

async function flipFromGear(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "View options" }));
  await user.click(await screen.findByRole("menuitemcheckbox"));
}

describe("flipping on from the gear of a read-only host", () => {
  for (const seeded of [false, true])
    it(`into a whitespace-only file lands on its arm (${seeded ? "pre-seeded" : "cold"})`, async () => {
      const user = userEvent.setup();
      const client = newClient(false);
      if (seeded) client.setQueryData(["mode-surface", true], WS_ONLY);
      render(
        <ModeHarness
          keep
          answer={(hide) => (hide ? WS_ONLY : stamped(diffOf(TEXT), false))}
        />,
        { wrapper: wrap(client) },
      );
      await flipFromGear(user);
      const message = await screen.findByText(WHITESPACE_ONLY_MESSAGE);
      expect(screen.queryByRole("button", { name: /View options/ })).toBeNull();
      await waitFor(() =>
        expect(document.activeElement).not.toBe(document.body),
      );
      const active = document.activeElement as HTMLElement;
      expect(active.getAttribute("tabindex")).toBe("-1");
      expect(active.contains(message)).toBe(true);
    });

  it("without a placeholder, the toolbar's round trip keeps focus in the pane", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ModeHarness
        keep={false}
        answer={(hide) => stamped(diffOf(TEXT), hide)}
      />,
      { wrapper: wrap(newClient(false)) },
    );
    await flipFromGear(user);
    await screen.findByRole("button", {
      name: "View options, whitespace changes hidden",
    });
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(container.contains(document.activeElement)).toBe(true);
  });
});

describe("a submodule row with the mode on", () => {
  it("mounts no gear and no strip, and reads no -w diff", async () => {
    const sub = "vendor/sub";
    const head = "b".repeat(40);
    const status = {
      branch: { name: "main", detached: false, oid: null, upstream: null },
      entries: [
        {
          path: sub,
          staged: null,
          unstaged: "modified",
          submodule: {
            commitChanged: false,
            trackedModified: false,
            untracked: true,
          },
        },
      ],
    } as unknown as RepoStatus;
    vi.mocked(gitStatus).mockResolvedValue(status);
    vi.mocked(gitDiffFile).mockImplementation(async () => diffOf(TEXT, sub));
    vi.mocked(gitSubmoduleChanges).mockResolvedValue({
      path: sub,
      staged: false,
      checkout: "ok",
      reason: null,
      branch: "main",
      detached: false,
      head,
      fromSha: head,
      toSha: head,
      rangeKnown: true,
      ahead: [],
      aheadCount: 0,
      behind: [],
      behindCount: 0,
      files: [{ path: "f0.txt", staged: null, unstaged: "untracked" }],
      filesTotal: 1,
    } as unknown as SubmoduleChanges);
    const client = newClient(true);
    client.setQueryData(repoKeys.status("/repo"), status);
    useUiStore.setState({
      selectedFile: { path: sub, staged: false, untracked: false },
    });
    render(<DiffViewer repoPath="/repo" />, { wrapper: wrap(client) });
    expect(await screen.findByText("Untracked files inside")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /View options/ })).toBeNull();
    for (const copy of Object.values(WHITESPACE_STRIP_COPY))
      expect(screen.queryByText(copy)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Show whitespace" }),
    ).toBeNull();
    expect(
      vi.mocked(gitDiffFile).mock.calls.some((c) => c.at(-1) === true),
    ).toBe(false);
  });
});

describe("the announcement, on then quickly off", () => {
  it("never says hidden while the mode is off", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(gitDiffFile).mockImplementation(
      async (_repo, _path, _staged, _untracked, iw = false) => {
        if (iw) await held;
        return diffOf(TEXT);
      },
    );
    const client = newClient(false);
    render(<DiffViewer repoPath="/repo" />, { wrapper: wrap(client) });
    await screen.findByText(/Drag across the line numbers to/);
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      for (const s of screen.queryAllByRole("status"))
        seen.push(s.textContent ?? "");
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    act(() =>
      client.setQueryData(settingsKeys.settings, {
        ...stored,
        diffHideWhitespace: true,
      }),
    );
    await waitFor(() =>
      expect(vi.mocked(gitDiffFile).mock.calls.some((c) => c[4] === true)).toBe(
        true,
      ),
    );
    act(() =>
      client.setQueryData(settingsKeys.settings, {
        ...stored,
        diffHideWhitespace: false,
      }),
    );
    await screen.findByText(/Drag across the line numbers to/);
    await act(async () => release());
    await act(async () => undefined);
    observer.disconnect();
    expect(seen.some((t) => t.includes(WHITESPACE_ANNOUNCEMENT.hidden))).toBe(
      false,
    );
    const statuses = screen.queryAllByRole("status");
    expect(
      statuses.some((s) =>
        s.textContent?.includes(WHITESPACE_ANNOUNCEMENT.hidden),
      ),
    ).toBe(false);
    expect(
      statuses.filter((s) =>
        s.textContent?.includes(WHITESPACE_ANNOUNCEMENT.shown),
      ).length,
    ).toBeLessThanOrEqual(1);
  });
});

describe("a mode change and the commit prefetch under the mode", () => {
  it("a -w mode-only header says its mode sentence once, above the button", () => {
    const text = "diff --git a/x b/x\nold mode 100644\nnew mode 100755\n";
    const header = classifyHeaderOnlyDiff(text);
    expect(header?.kind).toBe("mode");
    const sentence = header === null ? null : modeChangeMessage(header);
    if (sentence === null) throw new Error("no mode sentence");
    render(
      <DiffContent
        filePath="x"
        data={{ ...diffOf(text), whitespaceOnly: true, whitespaceHidden: true }}
        isPending={false}
        isError={false}
      />,
      { wrapper: wrap(newClient(true)) },
    );
    expect(screen.getByText(WHITESPACE_ONLY_MESSAGE)).toBeTruthy();
    const lines = screen.getAllByText(sentence);
    expect(lines).toHaveLength(1);
    const button = screen.getByRole("button", { name: "Show whitespace" });
    expect(
      lines[0].compareDocumentPosition(button) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  for (const hide of [true, false])
    it(`usePrefetchCommit warms the first file's diff with the mode ${hide ? "on" : "off"}`, async () => {
      vi.mocked(gitCommitDetails).mockResolvedValue({} as never);
      vi.mocked(gitCommitFiles).mockResolvedValue([{ path: "x" }] as never);
      vi.mocked(gitCommitFileDiff).mockImplementation(async () => diffOf(TEXT));
      const client = newClient(hide);
      const { result } = renderHook(() => usePrefetchCommit("/r", false), {
        wrapper: wrap(client),
      });
      await result.current("h");
      await waitFor(() =>
        expect(vi.mocked(gitCommitFileDiff).mock.calls[0]?.at(-1)).toBe(hide),
      );
      expect(
        client
          .getQueryCache()
          .getAll()
          .some((q) => q.queryKey.includes("h") && q.queryKey.at(-1) === hide),
      ).toBe(true);
    });
});
