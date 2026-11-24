import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
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
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SubmodulesDialog } from "@/features/repository/SubmodulesDialog";
import {
  gitSubmoduleCommits,
  gitSubmoduleFetch,
  gitSubmodulePickPlan,
  gitSubmoduleRefs,
  gitSubmoduleRemove,
  gitSubmoduleSetCommit,
  gitSubmodules,
  gitSubmoduleUpdate,
} from "@/lib/git/api";
import type {
  Submodule,
  SubmoduleCommitPage,
  SubmoduleFetchResult,
  SubmodulePickBlock,
  SubmodulePickOutcome,
  SubmodulePickPlan,
  SubmodulePickRead,
  SubmoduleRefCommit,
  SubmoduleRefs,
  SubmoduleRemoveOutcome,
} from "@/lib/git/types";
import { OFFLINE_WRITE_REASON } from "@/lib/offline-writes";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { useOnline } from "@/lib/use-online";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/hotkeys/binding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hotkeys/binding")>()),
  isWindows: true,
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  validateRepo: vi.fn(),
  gitSubmodules: vi.fn(),
  gitSubmoduleRefs: vi.fn(),
  gitSubmoduleCommits: vi.fn(),
  gitSubmodulePickPlan: vi.fn(),
  gitSubmoduleSetCommit: vi.fn(),
  gitSubmoduleFetch: vi.fn(),
  gitSubmoduleRemove: vi.fn(),
  gitSubmoduleUpdate: vi.fn(),
}));
vi.mock("@/lib/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/toast")>()),
  toastError: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/features/repository/useOpenRepoByPath", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/repository/useOpenRepoByPath")
  >()),
  useOpenRepoByPath: () => vi.fn(async () => true),
}));
vi.mock("@/lib/use-online", () => ({ useOnline: vi.fn(() => true) }));

// jsdom has no layout: listKeyboardNav scrolls the row it focuses.
Element.prototype.scrollIntoView = vi.fn();

afterAll(() => {
  expect(unmockedCommands).toEqual([]);
});

const REPO = "C:\\r";
const OTHER = "C:\\o";
const SUB = "vendor/sub";
const SUB2 = "libs/core";
/** Recorded and checked out. */
const P = "b".repeat(40);
const A = "a".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);
const E = "e".repeat(40);

type Mode = "list" | "add" | "choose";

const sub = (
  path: string,
  status = "ok",
  unreadableReason: string | null = null,
): Submodule => ({
  path,
  name: path,
  url: "https://example.invalid/x.git",
  branch: null,
  sha: P,
  describe: "v1",
  status,
  unreadableReason,
});

const ref = (rev: string, name: string) => ({ rev, name, sha: P });

const refsOf = (over: Partial<SubmoduleRefs> = {}): SubmoduleRefs => ({
  checkout: "ok",
  reason: null,
  pointer: P,
  head: P,
  branch: null,
  detached: true,
  shallow: false,
  defaultRev: "refs/remotes/origin/main",
  branches: [ref("refs/heads/main", "main")],
  remoteBranches: [ref("refs/remotes/origin/main", "origin/main")],
  tags: [],
  truncated: false,
  brokenRefs: 0,
  ...over,
});

const commit = (
  sha: string,
  subject: string,
  onRemote: boolean | null = true,
): SubmoduleRefCommit => ({
  sha,
  subject,
  author: "Ann",
  authoredAt: "2026-11-01T00:00:00Z",
  onRemote,
});

const page = (
  commits: SubmoduleRefCommit[],
  over: Partial<SubmoduleCommitPage> = {},
): SubmoduleCommitPage => ({
  checkout: "ok",
  reason: null,
  commits,
  hasMore: false,
  shallow: false,
  tip: null,
  ...over,
});

const DEFAULT_ROWS = [
  commit(A, "Add feature"),
  commit(P, "Recorded one"),
  commit(C, "Older change"),
];

const REPLACED_COPY = `Something other than a submodule checkout sits where ${SUB} should be.`;

const READY: SubmodulePickPlan = { kind: "ready", checkout: "checkOut" };

const readOf = (
  sha: string,
  plan: SubmodulePickPlan = READY,
  over: Partial<SubmodulePickRead> = {},
): SubmodulePickRead => ({
  sha,
  commit: commit(sha, "x"),
  pointer: P,
  plan,
  relation: { kind: "forward", ahead: 1 },
  shallow: false,
  ...over,
});

const blocked = (
  why: SubmodulePickBlock,
  reason: string | null = null,
  paths: string[] = [],
): SubmodulePickPlan => ({ kind: "blocked", why, reason, paths });

let planFor: (sha: string) => SubmodulePickRead | Promise<SubmodulePickRead>;

function held<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const controls: {
  setMode?: (m: Mode | null) => void;
  setRepo?: (r: string) => void;
} = {};

/** RepositoryMenu's wiring: the mode doubles as the open flag. A parent that
 *  ignores mode changes keeps `initialMode` where it opened. */
function Harness({
  start,
  repo0,
  ignoreModes,
}: {
  start: Mode | null;
  repo0: string;
  ignoreModes: boolean;
}) {
  const [mode, setMode] = useState<Mode | null>(start);
  const [repo, setRepo] = useState(repo0);
  useEffect(() => {
    controls.setMode = setMode;
    controls.setRepo = setRepo;
  });
  return (
    <SubmodulesDialog
      repoPath={repo}
      open={mode !== null}
      initialMode={mode ?? "list"}
      onModeChange={ignoreModes ? () => undefined : setMode}
      onOpenChange={(o) => {
        if (!o) setMode(null);
      }}
    />
  );
}

let harnessClient: QueryClient | undefined;

function renderHarness(
  start: Mode | null = "list",
  repo = REPO,
  ignoreModes = false,
) {
  // A query that sets its own `retry` still takes the client's delay, so a
  // retried failure settles inside a waitFor's timeout.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  harnessClient = client;
  render(
    <QueryClientProvider client={client}>
      <Harness start={start} repo0={repo} ignoreModes={ignoreModes} />
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useOnline).mockReturnValue(true);
  useUiStore.setState({ repoPath: REPO });
  vi.mocked(gitSubmodules).mockResolvedValue([sub(SUB)]);
  vi.mocked(gitSubmoduleRefs).mockResolvedValue(refsOf());
  vi.mocked(gitSubmoduleCommits).mockResolvedValue(page(DEFAULT_ROWS));
  planFor = (sha) => readOf(sha);
  vi.mocked(gitSubmodulePickPlan).mockImplementation(async (_r, _p, sha) =>
    planFor(sha),
  );
  vi.mocked(gitSubmoduleSetCommit).mockResolvedValue({
    kind: "set",
    sha: P,
    checkout: "checkOut",
    nestedLeft: 0,
  });
  vi.mocked(gitSubmoduleFetch).mockResolvedValue({ shallow: false });
});

const search = () => screen.getByRole("textbox", { name: "Search commits" });
const applyButton = () =>
  screen.getByRole("button", { name: /Check out and stage/ });
const row = (sha: string) =>
  document.querySelector<HTMLElement>(`[data-pick-row="${sha}"]`);
const liveNote = () =>
  document.querySelector('[aria-live="polite"]')?.textContent ?? "";

async function waitApplyReady() {
  await waitFor(() =>
    expect(applyButton()).not.toHaveAttribute("aria-disabled", "true"),
  );
}

async function waitApplyReason(reason: string) {
  await waitFor(() => {
    expect(applyButton()).toHaveAttribute("aria-disabled", "true");
    expect(applyButton()).toHaveAccessibleDescription(reason);
  });
}

/** Opens the picker for `path` from its row's kebab. */
async function openPicker(path = SUB) {
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: `Actions for ${path}` }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Choose commit…" }),
  );
  await screen.findByRole("heading", { name: "Choose commit" });
  return user;
}

/** Renders the list, enters the picker, and waits for its rows. */
async function pickerWithRows(start: Mode = "list") {
  const client = renderHarness(start);
  const user = await openPicker();
  await waitFor(() => expect(row(P)).not.toBeNull());
  return { client, user };
}

describe("palette entry and modes", () => {
  it("T1 the palette entry lands on the picker when exactly one submodule is initialized", async () => {
    vi.mocked(gitSubmodules).mockResolvedValue([
      sub(SUB),
      sub("libs/off", "uninitialized"),
    ]);
    renderHarness("choose");
    expect(
      await screen.findByRole("heading", { name: "Choose commit" }),
    ).toBeInTheDocument();
    expect(search()).toBeInTheDocument();
    await waitFor(() =>
      expect(gitSubmoduleRefs).toHaveBeenCalledWith(REPO, SUB),
    );
  });

  it("T2 the palette entry lands on the list with none or two initialized, and when the list read fails", async () => {
    for (const setup of [
      () => vi.mocked(gitSubmodules).mockResolvedValue([]),
      () =>
        vi.mocked(gitSubmodules).mockResolvedValue([sub(SUB, "uninitialized")]),
      () =>
        vi
          .mocked(gitSubmodules)
          .mockResolvedValue([sub(SUB), sub(SUB2, "modified")]),
      () =>
        vi.mocked(gitSubmodules).mockRejectedValue({
          kind: "git",
          message: "boom",
          stderr: "boom",
        }),
    ]) {
      vi.clearAllMocks();
      setup();
      renderHarness("choose");
      expect(
        await screen.findByRole("heading", { name: "Submodules" }),
      ).toBeInTheDocument();
      await act(async () => undefined);
      expect(screen.queryByRole("heading", { name: "Choose commit" })).toBe(
        null,
      );
      expect(gitSubmoduleRefs).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("T3 a row's Choose commit opens that row's picker; an uninitialized row's item is disabled and says why", async () => {
    vi.mocked(gitSubmodules).mockResolvedValue([
      sub(SUB),
      sub(SUB2, "uninitialized"),
    ]);
    renderHarness("list");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: `Actions for ${SUB2}` }),
    );
    const item = await screen.findByRole("menuitem", {
      name: "Choose commit… (initialize this submodule first)",
    });
    expect(item).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    await openPicker(SUB);
    await waitFor(() =>
      expect(gitSubmoduleRefs).toHaveBeenCalledWith(REPO, SUB),
    );
    expect(gitSubmoduleRefs).not.toHaveBeenCalledWith(REPO, SUB2);
  });

  it("T6 a reopen after closing from the picker lands on the requested mode and reads nothing for the old target", async () => {
    for (const next of ["add", "list", "choose"] as const) {
      // Two initialized: a palette reopen resolves afresh onto the list.
      vi.mocked(gitSubmodules).mockResolvedValue([sub(SUB), sub(SUB2)]);
      await pickerWithRows();
      act(() => controls.setMode?.(null));
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      vi.mocked(gitSubmoduleRefs).mockClear();
      act(() => controls.setMode?.(next));
      expect(
        await screen.findByRole("heading", {
          name: next === "add" ? "Add submodule" : "Submodules",
        }),
      ).toBeInTheDocument();
      await act(async () => undefined);
      expect(gitSubmoduleRefs, next).not.toHaveBeenCalled();
      if (next === "list") {
        // The old target is gone, not just hidden: a palette request from the
        // reopened list resolves afresh (two initialized: the list stays).
        act(() => controls.setMode?.("choose"));
        await act(async () => undefined);
        expect(screen.queryByRole("heading", { name: "Choose commit" })).toBe(
          null,
        );
        expect(gitSubmoduleRefs, "choose after list").not.toHaveBeenCalled();
      }
      cleanup();
    }
  });

  it("T52 a request for another mode over the open picker drops its target, so a later Choose request resolves afresh", async () => {
    for (const leg of ["one", "several"] as const) {
      vi.mocked(gitSubmodules).mockResolvedValue([sub(SUB), sub(SUB2)]);
      const client = renderHarness("list");
      await openPicker(SUB2);
      act(() => controls.setMode?.("add"));
      await screen.findByRole("heading", { name: "Add submodule" });
      if (leg === "one") {
        // A fresh resolve reads a fresh list: only SUB is initialized now.
        vi.mocked(gitSubmodules).mockResolvedValue([
          sub(SUB),
          sub(SUB2, "uninitialized"),
        ]);
        client.removeQueries({ queryKey: ["repo", REPO, "submodules"] });
      }
      vi.mocked(gitSubmoduleRefs).mockClear();
      act(() => controls.setMode?.("choose"));
      if (leg === "one") {
        await screen.findByRole("heading", { name: "Choose commit" });
        await waitFor(() =>
          expect(gitSubmoduleRefs).toHaveBeenCalledWith(REPO, SUB),
        );
      } else {
        await screen.findByRole("heading", { name: "Submodules" });
        await act(async () => undefined);
        expect(screen.queryByRole("heading", { name: "Choose commit" })).toBe(
          null,
        );
      }
      expect(gitSubmoduleRefs, leg).not.toHaveBeenCalledWith(REPO, SUB2);
      cleanup();
    }
  });

  it("T45 the Add form opened after leaving the picker survives a repository switch", async () => {
    vi.mocked(gitSubmodules).mockImplementation(async (repo) =>
      repo === REPO ? [sub(SUB)] : [sub("only/one")],
    );
    // Routed: the caller's `initialMode` follows every change, so the re-seed
    // also runs. Ignored: it stays "list", so only leaving the picker and the
    // switch effect's mode gate keep the form.
    for (const ignoreModes of [false, true]) {
      useUiStore.setState({ repoPath: REPO });
      renderHarness("list", REPO, ignoreModes);
      const user = await openPicker();
      await waitFor(() => expect(row(P)).not.toBeNull());
      await user.click(screen.getByRole("button", { name: "Back" }));
      await screen.findByRole("heading", { name: "Submodules" });
      await user.click(screen.getByRole("button", { name: "Add submodule…" }));
      await user.click(
        await screen.findByRole("textbox", { name: "Repository URL" }),
      );
      await user.paste("https://example.invalid/y.git");
      act(() => {
        useUiStore.setState({ repoPath: OTHER });
        controls.setRepo?.(OTHER);
      });
      await act(async () => undefined);
      expect(
        screen.getByRole("heading", { name: "Add submodule" }),
        `ignoreModes=${ignoreModes}`,
      ).toBeInTheDocument();
      expect(
        screen.getByRole("textbox", { name: "Repository URL" }),
      ).toHaveValue("https://example.invalid/y.git");
      cleanup();
    }
  });

  it("T7 a repository switch drops the picker for the list and resolves nothing for the new repository", async () => {
    vi.mocked(gitSubmodules).mockImplementation(async (repo) =>
      repo === REPO ? [sub(SUB)] : [sub("only/one")],
    );
    await pickerWithRows();
    await waitFor(() => expect(document.activeElement).toBe(search()));
    vi.mocked(gitSubmoduleRefs).mockClear();
    act(() => {
      useUiStore.setState({ repoPath: OTHER });
      controls.setRepo?.(OTHER);
    });
    expect(
      await screen.findByRole("heading", { name: "Submodules" }),
    ).toBeInTheDocument();
    await screen.findByRole("button", { name: "Actions for only/one" });
    expect(gitSubmoduleRefs).not.toHaveBeenCalled();
    // The footer's Close, not the dialog's X (also named Close).
    expect(document.activeElement).toHaveTextContent(/^Close$/);
  });

  it("T79 a palette request still waiting on its list read drops to the list when the repository changes", async () => {
    const first = held<Submodule[]>();
    vi.mocked(gitSubmodules).mockImplementation((repo) =>
      repo === REPO ? first.promise : Promise.resolve([sub("only/one")]),
    );
    renderHarness("choose");
    await screen.findByRole("heading", { name: "Submodules" });
    act(() => {
      useUiStore.setState({ repoPath: OTHER });
      controls.setRepo?.(OTHER);
    });
    await waitFor(() => expect(gitSubmodules).toHaveBeenCalledWith(OTHER));
    await act(async () => undefined);
    expect(screen.queryByRole("heading", { name: "Choose commit" })).toBe(null);
    await screen.findByRole("button", { name: "Actions for only/one" });
    await act(async () => first.resolve([sub(SUB)]));
    expect(screen.queryByRole("heading", { name: "Choose commit" })).toBe(null);
    expect(gitSubmoduleRefs).not.toHaveBeenCalled();
  });

  it("T8 entering the picker puts the caret in the search box; leaving it lands on that submodule's row", async () => {
    const { user } = await pickerWithRows();
    await waitFor(() => expect(document.activeElement).toBe(search()));
    await user.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("heading", { name: "Submodules" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        document.querySelector(`[data-sub-row="${SUB}"]`),
      ),
    );
    expect(document.querySelector(`[data-sub-row="${SUB}"]`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("T28 Esc backs out to the list, and does not land on the list while a pick is applying", async () => {
    const { user } = await pickerWithRows();
    await user.keyboard("{Escape}");
    expect(
      await screen.findByRole("heading", { name: "Submodules" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    cleanup();

    const pending = held<SubmodulePickOutcome>();
    vi.mocked(gitSubmoduleSetCommit).mockReturnValue(pending.promise);
    const second = await pickerWithRows();
    await waitApplyReady();
    await second.user.click(applyButton());
    await waitApplyReason("Checking out and staging…");
    await second.user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("heading", { name: "Submodules" })).toBe(null);
    await act(async () => pending.resolve({ kind: "changed" }));
  });

  it("T43 Esc in the same tick as the press does not back out of a running pick", async () => {
    const pending = held<SubmodulePickOutcome>();
    vi.mocked(gitSubmoduleSetCommit).mockReturnValue(pending.promise);
    await pickerWithRows();
    await waitApplyReady();
    act(() => {
      fireEvent.click(applyButton());
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: "Escape",
      });
    });
    await act(async () => undefined);
    expect(gitSubmoduleSetCommit).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("heading", { name: "Submodules" })).toBe(null);
    await act(async () => pending.resolve({ kind: "changed" }));
  });
});

describe("the list's own states", () => {
  it("T4 a failed list read says so with Retry, never claims there are no submodules, holds Update all with its own reason and hides the footer menu", async () => {
    vi.mocked(gitSubmodules).mockRejectedValue({
      kind: "io",
      message: "disk gone",
    });
    renderHarness("list");
    expect(
      await screen.findByText("Couldn't read this repository's submodules."),
    ).toBeInTheDocument();
    expect(screen.getByText("disk gone")).toBeInTheDocument();
    expect(screen.queryByText("This repository has no submodules.")).toBe(null);
    const updateAll = screen.getByRole("button", { name: "Update all" });
    expect(updateAll).toHaveAccessibleDescription(
      "Submodules couldn't be read",
    );
    expect(
      screen.queryByRole("button", { name: "More submodule actions" }),
    ).toBe(null);
    const retry = screen.getByRole("button", { name: "Retry" });
    const again = held<Submodule[]>();
    vi.mocked(gitSubmodules).mockReturnValue(again.promise);
    act(() => retry.focus());
    await userEvent.setup().click(retry);
    expect(gitSubmodules).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Retry" })).toBe(null),
    );
    expect(document.activeElement).not.toBe(document.body);
    await act(async () => again.resolve([]));
    expect(
      await screen.findByText("This repository has no submodules."),
    ).toBeInTheDocument();
  });

  it("T5 a failed refresh keeps the rows under a refresh notice with Retry", async () => {
    const client = renderHarness("list");
    await screen.findByRole("button", { name: `Actions for ${SUB}` });
    vi.mocked(gitSubmodules).mockRejectedValue({ kind: "io", message: "x" });
    await act(() =>
      client.invalidateQueries({ queryKey: ["repo", REPO, "submodules"] }),
    );
    expect(
      await screen.findByText(
        "Couldn't refresh submodules — showing the last loaded results.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `Actions for ${SUB}` }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Retry loading submodules" }),
    ).toBeInTheDocument();
    // Outside the listbox: a listbox holds options only.
    expect(
      within(screen.getByRole("listbox", { name: "Submodules" })).queryByText(
        /Couldn't refresh/,
      ),
    ).toBe(null);
  });
});

describe("the picker frame", () => {
  it("T9 each unusable checkout kind, and a failed refs read, says so and holds the button", async () => {
    const cases: [SubmoduleRefs["checkout"], string, string | null][] = [
      [
        "notInitialized",
        `${SUB} isn't initialized. Initialize it from the list first.`,
        null,
      ],
      [
        "missing",
        `${SUB}'s folder is missing. Initialize it from the list first.`,
        null,
      ],
      ["replaced", REPLACED_COPY, null],
      ["unreadable", `${SUB} couldn't be read.`, "index locked"],
    ];
    for (const [checkout, text, reason] of cases) {
      vi.mocked(gitSubmoduleRefs).mockResolvedValue(
        refsOf({ checkout, reason, branches: [], remoteBranches: [] }),
      );
      renderHarness("list");
      await openPicker();
      expect(
        await screen.findByText(text, { selector: "p" }),
      ).toBeInTheDocument();
      if (reason) expect(screen.getByText(reason)).toBeInTheDocument();
      await waitApplyReason(text);
      expect(screen.queryByRole("textbox", { name: "Search commits" })).toBe(
        null,
      );
      cleanup();
    }
    vi.mocked(gitSubmoduleRefs).mockRejectedValue({
      kind: "io",
      message: "no refs",
    });
    renderHarness("list");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: `Actions for ${SUB}` }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Choose commit…" }),
    );
    expect(
      await screen.findByText(`Couldn't read ${SUB}'s branches and tags.`),
    ).toBeInTheDocument();
    expect(screen.getByText("no refs")).toBeInTheDocument();
    await waitApplyReason(`${SUB}'s branches and tags couldn't be read`);
  });

  it("T10 the default ref follows the tracked branch, then the first remote branch, branch, tag, then the checked-out commit", async () => {
    const cases: [Partial<SubmoduleRefs>, string, string][] = [
      [
        {
          defaultRev: "refs/remotes/origin/dev",
          remoteBranches: [
            ref("refs/remotes/origin/a", "origin/a"),
            ref("refs/remotes/origin/dev", "origin/dev"),
          ],
        },
        "refs/remotes/origin/dev",
        "origin/dev",
      ],
      [
        {
          defaultRev: null,
          remoteBranches: [ref("refs/remotes/origin/a", "origin/a")],
        },
        "refs/remotes/origin/a",
        "origin/a",
      ],
      [{ defaultRev: null, remoteBranches: [] }, "refs/heads/main", "main"],
      [
        {
          defaultRev: null,
          remoteBranches: [],
          branches: [],
          tags: [ref("refs/tags/v2", "v2"), ref("refs/tags/v1", "v1")],
        },
        "refs/tags/v2",
        "v2",
      ],
      [
        { defaultRev: null, remoteBranches: [], branches: [], head: C },
        C,
        "Checked-out commit",
      ],
    ];
    for (const [over, rev, label] of cases) {
      vi.mocked(gitSubmoduleRefs).mockResolvedValue(refsOf(over));
      vi.mocked(gitSubmoduleCommits).mockClear();
      renderHarness("list");
      await openPicker();
      await waitFor(() =>
        expect(gitSubmoduleCommits).toHaveBeenCalledWith(
          REPO,
          SUB,
          rev,
          0,
          50,
          null,
        ),
      );
      expect(
        screen.getByRole("combobox", { name: "Commits from" }),
      ).toHaveTextContent(label);
      cleanup();
    }
  });

  it("T11 a name two groups share is told apart on the trigger; a truncated or broken ref list says so", async () => {
    vi.mocked(gitSubmoduleRefs).mockResolvedValue(
      refsOf({
        defaultRev: "refs/tags/v1",
        branches: [ref("refs/heads/v1", "v1")],
        tags: [ref("refs/tags/v1", "v1")],
        truncated: true,
        brokenRefs: 3,
      }),
    );
    renderHarness("list");
    const user = await openPicker();
    const trigger = await screen.findByRole("combobox", {
      name: "Commits from",
    });
    await waitFor(() => expect(trigger).toHaveTextContent("v1, tag"));
    await user.click(trigger);
    expect(
      await screen.findByText(
        "Showing 500 per group. Paste a commit id below to reach any other commit.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("3 refs point at missing commits and aren't listed."),
    ).toBeInTheDocument();
    cleanup();

    vi.mocked(gitSubmoduleRefs).mockResolvedValue(refsOf({ brokenRefs: 1 }));
    renderHarness("list");
    const again = await openPicker();
    await again.click(
      await screen.findByRole("combobox", { name: "Commits from" }),
    );
    expect(
      await screen.findByText(
        "1 ref points at a missing commit and isn't listed.",
      ),
    ).toBeInTheDocument();
  });

  it("T35 the header line reads the recorded and checked-out commits, Records no commit and nothing checked out", async () => {
    const cases: [string | null, string | null, string][] = [
      [P, C, "Records bbbbbbb · checked out ccccccc"],
      [null, C, "Records no commit · checked out ccccccc"],
      [P, null, "Records bbbbbbb · nothing checked out"],
      [null, null, "Records no commit · nothing checked out"],
    ];
    for (const [pointer, head, line] of cases) {
      vi.mocked(gitSubmoduleRefs).mockResolvedValue(refsOf({ pointer, head }));
      renderHarness("list");
      await openPicker();
      expect(await screen.findByText(line)).toBeInTheDocument();
      cleanup();
    }
  });
});

describe("the commit list", () => {
  it("T12 an unborn submodule says it has no commits and never shows loading rows", async () => {
    vi.mocked(gitSubmoduleRefs).mockResolvedValue(
      refsOf({
        defaultRev: null,
        branches: [],
        remoteBranches: [],
        tags: [],
        head: null,
        pointer: null,
      }),
    );
    renderHarness("list");
    await openPicker();
    expect(
      await screen.findByText(`${SUB} has no commits yet.`, { selector: "p" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading commits…")).toBe(null);
    await waitApplyReason(`${SUB} has no commits yet.`);
    expect(gitSubmoduleCommits).not.toHaveBeenCalled();
  });

  it("T80 an unborn submodule still lists and applies a pasted id the lookup resolved", async () => {
    vi.mocked(gitSubmoduleRefs).mockResolvedValue(
      refsOf({
        defaultRev: null,
        branches: [],
        remoteBranches: [],
        tags: [],
        head: null,
      }),
    );
    renderHarness("list");
    const user = await openPicker();
    const unbornLine = `${SUB} has no commits yet.`;
    await screen.findByText(unbornLine, { selector: "p" });
    await user.click(search());
    await user.paste(E);
    await waitFor(() =>
      expect(row(E)).toHaveAttribute("aria-selected", "true"),
    );
    expect(screen.queryByText(unbornLine)).toBe(null);
    await waitFor(() =>
      expect(liveNote()).toContain(`Moves ${SUB} forward 1 commit.`),
    );
    await waitApplyReady();
    await user.click(applyButton());
    await waitFor(() =>
      expect(gitSubmoduleSetCommit).toHaveBeenCalledExactlyOnceWith(
        REPO,
        SUB,
        E,
        P,
      ),
    );
  });

  it("T13 an empty ref and an empty search say so; a failed commit read offers Retry", async () => {
    vi.mocked(gitSubmoduleCommits).mockResolvedValue(page([]));
    renderHarness("list");
    const user = await openPicker();
    expect(
      await screen.findByText("No commits on origin/main."),
    ).toBeInTheDocument();
    await waitApplyReason("No commits to pick from");
    await user.type(search(), "zzz");
    expect(
      await screen.findByText('No commits on origin/main match "zzz".'),
    ).toBeInTheDocument();
    cleanup();

    vi.mocked(gitSubmoduleCommits).mockRejectedValue({
      kind: "io",
      message: "log failed",
    });
    renderHarness("list");
    const again = await openPicker();
    expect(await screen.findByText("log failed")).toBeInTheDocument();
    await waitApplyReason("Commits couldn't be loaded");
    vi.mocked(gitSubmoduleCommits).mockResolvedValue(page(DEFAULT_ROWS));
    await again.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(row(A)).not.toBeNull());
  });

  it("T14 the recorded commit is highlighted when it is on the page, else the first row", async () => {
    await pickerWithRows();
    expect(row(P)).toHaveAttribute("aria-selected", "true");
    expect(row(P)).toHaveAttribute("tabindex", "0");
    expect(row(A)).toHaveAttribute("tabindex", "-1");
    cleanup();

    vi.mocked(gitSubmoduleCommits).mockResolvedValue(
      page([commit(A, "Add feature"), commit(C, "Older change")]),
    );
    renderHarness("list");
    await openPicker();
    await waitFor(() =>
      expect(row(A)).toHaveAttribute("aria-selected", "true"),
    );
  });

  it("T15 arrows, Home and End move the highlight; ArrowDown from the search box enters the list", async () => {
    await pickerWithRows();
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    expect(document.activeElement).toBe(row(P));
    fireEvent.keyDown(row(P) as HTMLElement, { key: "ArrowDown" });
    expect(row(C)).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(row(C));
    fireEvent.keyDown(row(C) as HTMLElement, { key: "Home" });
    expect(row(A)).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(row(A));
    fireEvent.keyDown(row(A) as HTMLElement, { key: "End" });
    expect(row(C)).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(row(C) as HTMLElement, { key: "ArrowUp" });
    expect(row(P)).toHaveAttribute("aria-selected", "true");
    // A chorded Home is the window listener's.
    fireEvent.keyDown(row(P) as HTMLElement, { key: "Home", altKey: true });
    expect(row(P)).toHaveAttribute("aria-selected", "true");
  });

  it("T29 a new search keeps the old rows on screen but refuses to apply or page over them", async () => {
    vi.mocked(gitSubmoduleCommits).mockResolvedValue(
      page(DEFAULT_ROWS, { hasMore: true }),
    );
    const { user } = await pickerWithRows();
    await waitApplyReady();
    const next = held<SubmoduleCommitPage>();
    vi.mocked(gitSubmoduleCommits).mockReturnValue(next.promise);
    await user.type(search(), "zz");
    await waitFor(() =>
      expect(gitSubmoduleCommits).toHaveBeenCalledWith(
        REPO,
        SUB,
        "refs/remotes/origin/main",
        0,
        50,
        "zz",
      ),
    );
    expect(row(P)).not.toBeNull();
    await waitApplyReason("Loading commits…");
    const more = screen.getByRole("button", { name: "Load more" });
    expect(more).toHaveAccessibleDescription("Loading commits…");
    fireEvent.keyDown(row(P) as HTMLElement, { key: "Enter" });
    fireEvent.click(more);
    expect(gitSubmoduleSetCommit).not.toHaveBeenCalled();
    expect(gitSubmoduleCommits).toHaveBeenCalledTimes(2);
    await act(async () => next.resolve(page([commit(D, "zz match")])));
  });

  it("T30 Load more asks for the next page and keeps focus when the last page removes it", async () => {
    const first = Array.from({ length: 50 }, (_, i) =>
      commit(i.toString(16).padStart(40, "0"), `Commit ${i}`),
    );
    vi.mocked(gitSubmoduleCommits).mockImplementation(
      async (_r, _p, _rev, skip) =>
        skip === 0
          ? page(first, { hasMore: true })
          : page([commit(P, "Recorded one")]),
    );
    renderHarness("list");
    const user = await openPicker();
    const more = await screen.findByRole("button", { name: "Load more" });
    await user.click(more);
    await waitFor(() =>
      expect(gitSubmoduleCommits).toHaveBeenCalledWith(
        REPO,
        SUB,
        "refs/remotes/origin/main",
        50,
        50,
        null,
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Load more" })).toBe(null),
    );
    expect(row(P)).not.toBeNull();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("T33 a focused commit row that leaves the list hands focus to the search box", async () => {
    const { user } = await pickerWithRows();
    act(() => row(C)?.focus());
    vi.mocked(gitSubmoduleCommits).mockResolvedValue(
      page([commit(A, "Add feature")]),
    );
    // Typing moves focus; put it back on the row while the new search loads.
    await user.type(search(), "add");
    act(() => row(C)?.focus());
    await waitFor(() => expect(row(C)).toBeNull());
    expect(document.activeElement).toBe(search());
  });

  it("T38 a failed refresh and a failed Load more keep the commits on screen and say so", async () => {
    vi.mocked(gitSubmoduleCommits).mockResolvedValue(
      page(DEFAULT_ROWS, { hasMore: true }),
    );
    const { client, user } = await pickerWithRows();
    vi.mocked(gitSubmoduleCommits).mockRejectedValue({
      kind: "io",
      message: "x",
    });
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(
      await screen.findByText(
        "Couldn't load more commits — showing the ones already loaded.",
      ),
    ).toBeInTheDocument();
    expect(row(P)).not.toBeNull();
    await act(() =>
      client.refetchQueries({
        queryKey: ["repo", REPO, "submodule-pick", SUB, "commits"],
      }),
    );
    expect(
      await screen.findByText(
        "Couldn't refresh commits — showing the last loaded results.",
      ),
    ).toBeInTheDocument();
    expect(row(P)).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Retry loading commits" }),
    ).toBeInTheDocument();
  });

  it("T24 a pasted sha pins its commit above the list; ambiguous, non-commit and rejected ids say so; a full id not fetched yet pins a row and points at Fetch", async () => {
    planFor = (sha) => {
      switch (sha) {
        case "ddddddd":
          return readOf(D, READY, { commit: commit(D, "Pinned one") });
        case "abcd":
          return readOf("", blocked("ambiguous", "3 commits start with abcd"), {
            sha: null,
            commit: null,
          });
        case "fffffff":
          return readOf("", blocked("notACommit"), { sha: null, commit: null });
        case "9".repeat(64):
          throw {
            kind: "invalidArgument",
            message: "invalid argument: bad id",
          };
        case E:
          return readOf(E, blocked("notFetched"), { commit: null });
        default:
          return readOf(sha);
      }
    };
    const { user } = await pickerWithRows();
    // Pasted, as a sha is: one input event per id, never a keystroke apiece.
    const paste = async (text: string) => {
      await user.clear(search());
      await user.paste(text);
    };
    await paste("ddddddd");
    await waitFor(() =>
      expect(screen.getAllByRole("option")[0]).toHaveAttribute(
        "data-pick-row",
        D,
      ),
    );
    expect(screen.getAllByRole("option")[0]).toHaveAttribute(
      "aria-selected",
      "true",
    );

    for (const [text, line] of [
      ["abcd", "More than one commit starts with that id. Paste more of it."],
      ["fffffff", "That id isn't a commit."],
      ["9".repeat(64), "Couldn't look up that commit id."],
    ] as const) {
      await paste(text);
      expect(
        await screen.findByText((t) => t.startsWith(line), { selector: "p" }),
        text,
      ).toBeInTheDocument();
      expect(row(D)).toBeNull();
    }

    await paste(E.toUpperCase());
    await waitFor(() => expect(row(E)).not.toBeNull());
    expect(row(E)).toHaveTextContent("eeeeeee · not fetched yet");
    await waitFor(() =>
      expect(liveNote()).toContain(
        `${SUB} doesn't have this commit yet. Fetch, then try again.`,
      ),
    );
    expect(gitSubmodulePickPlan).toHaveBeenCalledWith(REPO, SUB, E);
    expect(screen.getByRole("button", { name: "Fetch" })).toHaveClass(
      "bg-primary",
    );
  });

  it("T49 a failed first page beside a pinned pasted id still says so with Retry", async () => {
    planFor = (sha) =>
      sha === "ddddddd"
        ? readOf(D, READY, { commit: commit(D, "Pinned one") })
        : readOf(sha);
    const { user } = await pickerWithRows();
    vi.mocked(gitSubmoduleCommits).mockImplementation(
      async (_r, _p, _rev, _skip, _limit, q) => {
        if (q === "ddddddd") throw { kind: "io", message: "log failed" };
        return page(DEFAULT_ROWS);
      },
    );
    await user.click(search());
    await user.paste("ddddddd");
    expect(await screen.findByText("log failed")).toBeInTheDocument();
    expect(
      screen.getByText("Couldn't load the commits on origin/main."),
    ).toBeInTheDocument();
    expect(row(D)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    // The pinned commit stays pickable.
    await waitApplyReady();
  });

  it("T53 a pasted id stopped before it resolves says why on its line and on the button", async () => {
    const lead = "A merge is in progress in this repository.";
    planFor = (sha) =>
      sha === "ddddddd"
        ? readOf(
            "",
            blocked("midOperation", `${lead} Finish or abort it first.`),
            { sha: null, commit: null },
          )
        : readOf(sha);
    const { user } = await pickerWithRows();
    vi.mocked(gitSubmoduleCommits).mockImplementation(
      async (_r, _p, _rev, _skip, _limit, q) =>
        q === "ddddddd" ? page([]) : page(DEFAULT_ROWS),
    );
    await user.click(search());
    await user.paste("ddddddd");
    expect(
      await screen.findByText(lead, { selector: "p" }),
    ).toBeInTheDocument();
    await waitApplyReason(lead);
    expect(row(D)).toBeNull();
  });

  it("T70 a Load more page that finds the checkout unusable says so with that page's reason", async () => {
    vi.mocked(gitSubmoduleCommits).mockImplementation(
      async (_r, _p, _rev, skip) =>
        skip === 0
          ? page(DEFAULT_ROWS, { hasMore: true })
          : page([], { checkout: "unreadable", reason: "bad object HEAD" }),
    );
    const { user } = await pickerWithRows();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    const text = `${SUB} couldn't be read.`;
    expect(
      await screen.findByText(text, { selector: "p" }),
    ).toBeInTheDocument();
    expect(screen.getByText("bad object HEAD")).toBeInTheDocument();
    await waitApplyReason(text);
    expect(row(P)).toBeNull();
  });

  it("T94 the not-usable panel's Retry reads its verdict's source again, and a usable answer brings the list back", async () => {
    let broken = true;
    vi.mocked(gitSubmoduleCommits).mockImplementation(
      async (_r, _p, _rev, skip) => {
        if (skip === 0) return page(DEFAULT_ROWS, { hasMore: true });
        return broken
          ? page([], { checkout: "unreadable", reason: "bad object HEAD" })
          : page([commit(D, "Older still")]);
      },
    );
    const { user } = await pickerWithRows();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    const text = `${SUB} couldn't be read.`;
    await screen.findByText(text, { selector: "p" });
    await waitApplyReason(text);
    broken = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(row(D)).not.toBeNull());
    expect(row(P)).not.toBeNull();
    expect(screen.queryByText(text)).toBe(null);
    expect(document.activeElement).not.toBe(document.body);
    await waitApplyReady();
    cleanup();

    // A refs verdict re-reads the refs.
    const notInitialized = refsOf({
      checkout: "notInitialized",
      branches: [],
      remoteBranches: [],
    });
    const copy = `${SUB} isn't initialized. Initialize it from the list first.`;
    vi.mocked(gitSubmoduleRefs).mockResolvedValue(notInitialized);
    vi.mocked(gitSubmoduleCommits).mockResolvedValue(page(DEFAULT_ROWS));
    renderHarness("list");
    const again = await openPicker();
    await screen.findByText(copy, { selector: "p" });
    vi.mocked(gitSubmoduleRefs).mockResolvedValue(refsOf());
    await again.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(row(P)).not.toBeNull());
    expect(screen.queryByText(copy)).toBe(null);
    await waitApplyReady();
  });

  it("T96 Load more walks the first page's tip though the ref moved, and a refetch reads the ref again from the first page", async () => {
    const MAIN = "refs/remotes/origin/main";
    let mainTip = A;
    vi.mocked(gitSubmoduleCommits).mockImplementation(
      async (_r, _p, rev, skip) => {
        if (skip === 0)
          return page(DEFAULT_ROWS, { hasMore: true, tip: mainTip });
        // The ref now names another history; the first page's tip still
        // names the one it listed.
        return rev === MAIN
          ? page([commit(E, "Moved ref's commit")], { tip: E })
          : page([commit(D, `Older under ${rev.slice(0, 1)}`)], { tip: rev });
      },
    );
    const { client, user } = await pickerWithRows();
    mainTip = C;
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(row(D)).not.toBeNull());
    expect(row(E)).toBeNull();
    expect(gitSubmoduleCommits).toHaveBeenLastCalledWith(
      REPO,
      SUB,
      A,
      3,
      50,
      null,
    );
    vi.mocked(gitSubmoduleCommits).mockClear();
    await act(() => client.invalidateQueries());
    await waitFor(() => expect(gitSubmoduleCommits).toHaveBeenCalledTimes(2));
    expect(vi.mocked(gitSubmoduleCommits).mock.calls).toEqual([
      [REPO, SUB, MAIN, 0, 50, null],
      [REPO, SUB, C, 3, 50, null],
    ]);
  });

  it("T71 a new search typed over one that matched nothing holds Apply as loading", async () => {
    const next = held<SubmoduleCommitPage>();
    vi.mocked(gitSubmoduleCommits).mockImplementation(
      async (_r, _p, _rev, _skip, _limit, q) => {
        if (q === "zz") return page([]);
        if (q === "zzz") return next.promise;
        return page(DEFAULT_ROWS);
      },
    );
    const { user } = await pickerWithRows();
    await user.type(search(), "zz");
    await screen.findByText('No commits on origin/main match "zz".');
    await waitApplyReason("No commits to pick from");
    await user.type(search(), "z");
    await waitFor(() =>
      expect(gitSubmoduleCommits).toHaveBeenCalledWith(
        REPO,
        SUB,
        "refs/remotes/origin/main",
        0,
        50,
        "zzz",
      ),
    );
    await waitApplyReason("Loading commits…");
    await act(async () => next.resolve(page(DEFAULT_ROWS)));
    await waitApplyReady();
  });

  it("T72 a pasted id that matches no commit at all says so on its own line", async () => {
    planFor = (sha) =>
      sha === "1234567"
        ? readOf("", blocked("notFound"), { sha: null, commit: null })
        : readOf(sha);
    const { user } = await pickerWithRows();
    vi.mocked(gitSubmoduleCommits).mockImplementation(
      async (_r, _p, _rev, _skip, _limit, q) =>
        q === "1234567" ? page([]) : page(DEFAULT_ROWS),
    );
    await user.click(search());
    await user.paste("1234567");
    expect(
      await screen.findByText(`No commit in ${SUB} matches that id.`, {
        selector: "p",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('No commits on origin/main match "1234567".'),
    ).toBeInTheDocument();
  });
});

describe("a pasted id that resolves to nothing", () => {
  const PASTED = "1234567";
  const UNRESOLVED: [string, SubmodulePickPlan, string][] = [
    ["notFound", blocked("notFound"), `No commit in ${SUB} matches that id.`],
    [
      "ambiguous",
      blocked("ambiguous", "3 commits start with 1234567"),
      "More than one commit starts with that id. Paste more of it.",
    ],
    ["notACommit", blocked("notACommit"), "That id isn't a commit."],
  ];

  /** The lookup for `text` answers `plan` with no sha; its message search
   *  lists `hits`, each with a Ready plan. */
  async function pasteUnresolved(
    text: string,
    plan: SubmodulePickPlan,
    hits = [commit(D, `Revert ${PASTED}`)],
  ) {
    planFor = (sha) =>
      sha === text
        ? readOf("", plan, { sha: null, commit: null })
        : readOf(sha);
    vi.mocked(gitSubmoduleCommits).mockImplementation(
      async (_r, _p, _rev, _skip, _limit, q) =>
        q === text ? page(hits) : page(DEFAULT_ROWS),
    );
    const { user } = await pickerWithRows();
    await user.click(search());
    await user.paste(text);
    await waitFor(() => expect(row(D)).not.toBeNull());
    return user;
  }

  const selected = () =>
    screen
      .queryAllByRole("option")
      .filter((o) => o.getAttribute("aria-selected") === "true");

  it.each(UNRESOLVED)(
    "T97 %s: no listed row is highlighted and Apply holds with the lookup line's sentence until a row is picked",
    async (_why, plan, sentence) => {
      const user = await pasteUnresolved(PASTED, plan);
      await waitApplyReason(sentence);
      expect(selected()).toEqual([]);
      expect(document.activeElement).toBe(search());
      fireEvent.click(applyButton());
      fireEvent.keyDown(row(D) as HTMLElement, { key: "Enter" });
      await act(async () => undefined);
      expect(gitSubmoduleSetCommit).not.toHaveBeenCalled();

      // ArrowDown from the box is an explicit pick of the first row.
      await user.keyboard("{ArrowDown}");
      expect(row(D)).toHaveAttribute("aria-selected", "true");
      expect(document.activeElement).toBe(row(D));
      await waitApplyReady();
      await user.click(applyButton());
      await act(async () => undefined);
      expect(gitSubmoduleSetCommit).toHaveBeenCalledExactlyOnceWith(
        REPO,
        SUB,
        D,
        P,
      );
    },
  );

  it("T98 a click on a row, or ArrowUp from the box, is an explicit pick", async () => {
    const user = await pasteUnresolved(PASTED, blocked("notFound"), [
      commit(D, `Revert ${PASTED}`),
      commit(E, `Cherry-pick ${PASTED}`),
    ]);
    await waitApplyReason(`No commit in ${SUB} matches that id.`);
    await user.keyboard("{ArrowUp}");
    expect(row(E)).toHaveAttribute("aria-selected", "true");
    await waitApplyReady();
    await user.click(row(D) as HTMLElement);
    expect(row(D)).toHaveAttribute("aria-selected", "true");
    await waitApplyReady();
    fireEvent.keyDown(row(D) as HTMLElement, { key: "Enter" });
    await act(async () => undefined);
    expect(gitSubmoduleSetCommit).toHaveBeenCalledExactlyOnceWith(
      REPO,
      SUB,
      D,
      P,
    );
  });

  it("T99 a pick made before the paste does not survive it", async () => {
    planFor = (sha) =>
      sha === PASTED
        ? readOf("", blocked("notFound"), { sha: null, commit: null })
        : readOf(sha);
    vi.mocked(gitSubmoduleCommits).mockImplementation(
      async (_r, _p, _rev, _skip, _limit, q) =>
        q === PASTED
          ? page([commit(C, "Older change"), commit(D, `Revert ${PASTED}`)])
          : page(DEFAULT_ROWS),
    );
    const { user } = await pickerWithRows();
    await user.click(row(C) as HTMLElement);
    expect(row(C)).toHaveAttribute("aria-selected", "true");
    await user.click(search());
    await user.paste(PASTED);
    await waitFor(() => expect(row(D)).not.toBeNull());
    await waitApplyReason(`No commit in ${SUB} matches that id.`);
    expect(selected()).toEqual([]);
    fireEvent.click(applyButton());
    await act(async () => undefined);
    expect(gitSubmoduleSetCommit).not.toHaveBeenCalled();
  });

  it("T100 a plain word search that is also hex keeps its first row highlighted and applies it", async () => {
    const user = await pasteUnresolved("added", blocked("notFound"));
    await waitFor(() =>
      expect(row(D)).toHaveAttribute("aria-selected", "true"),
    );
    await waitApplyReady();
    await user.click(applyButton());
    await act(async () => undefined);
    expect(gitSubmoduleSetCommit).toHaveBeenCalledExactlyOnceWith(
      REPO,
      SUB,
      D,
      P,
    );
  });

  it("T101 a pasted id with a digit that resolves still pins and applies its commit", async () => {
    planFor = (sha) =>
      sha === PASTED
        ? readOf(E, READY, { commit: commit(E, "Pinned one") })
        : readOf(sha);
    vi.mocked(gitSubmoduleCommits).mockImplementation(
      async (_r, _p, _rev, _skip, _limit, q) =>
        q === PASTED
          ? page([commit(D, `Revert ${PASTED}`)])
          : page(DEFAULT_ROWS),
    );
    const { user } = await pickerWithRows();
    await user.click(search());
    await user.paste(PASTED);
    await waitFor(() =>
      expect(screen.getAllByRole("option")[0]).toHaveAttribute(
        "data-pick-row",
        E,
      ),
    );
    expect(row(E)).toHaveAttribute("aria-selected", "true");
    await waitApplyReady();
    await user.click(applyButton());
    await act(async () => undefined);
    expect(gitSubmoduleSetCommit).toHaveBeenCalledExactlyOnceWith(
      REPO,
      SUB,
      E,
      P,
    );
  });
});

describe("the note and the gate", () => {
  /** Re-reads the plan for the highlighted commit under a new `planFor`. */
  async function replan(
    client: QueryClient,
    next: (sha: string) => SubmodulePickRead,
  ) {
    planFor = next;
    await act(() =>
      client.refetchQueries({
        queryKey: ["repo", REPO, "submodule-pick", SUB, "plan"],
      }),
    );
    // The observer's notification is batched onto a later task; without this a
    // check could pass on the previous case's note.
    await act(() => new Promise((r) => setTimeout(r, 0)));
  }

  it("T18 the note says what each plan would do", async () => {
    const { client } = await pickerWithRows();
    // The first plan read lands past the highlight's debounce; each replan
    // below then refetches that one settled read.
    await waitFor(() =>
      expect(liveNote()).toContain(`Moves ${SUB} forward 1 commit.`),
    );
    const cases: [Partial<SubmodulePickRead>, string][] = [
      [{ plan: { kind: "current" } }, `${SUB} already points at this commit.`],
      [
        { plan: { kind: "ready", checkout: "alreadyThere" } },
        `Stages bbbbbbb, which ${SUB} already has checked out.`,
      ],
      [
        { relation: { kind: "forward", ahead: 1 } },
        `Moves ${SUB} forward 1 commit.`,
      ],
      [
        { relation: { kind: "forward", ahead: 3 } },
        `Moves ${SUB} forward 3 commits.`,
      ],
      [
        { relation: { kind: "rewind", behind: 2 } },
        `Moves ${SUB} back 2 commits.`,
      ],
      [
        { relation: { kind: "diverged", ahead: 1, behind: 1 }, shallow: false },
        `Moves ${SUB} to a commit on a different line of history.`,
      ],
      // No two adjacent cases share a note, so each check needs a new answer.
      [
        { relation: { kind: "diverged", ahead: 1, behind: 1 }, shallow: true },
        `Moves ${SUB} to bbbbbbb.`,
      ],
      [
        { relation: { kind: "same" } },
        `Checks ${SUB} out at bbbbbbb, the commit this repository already records.`,
      ],
      [
        { relation: { kind: "diverged", ahead: 1, behind: 1 }, shallow: null },
        `Moves ${SUB} to bbbbbbb.`,
      ],
      [
        { relation: { kind: "rewind", behind: 1 } },
        `Moves ${SUB} back 1 commit.`,
      ],
      [{ relation: { kind: "unknown" } }, `Moves ${SUB} to bbbbbbb.`],
    ];
    for (const [over, note] of cases) {
      await replan(client, (sha) => readOf(sha, READY, over));
      await waitFor(() => expect(liveNote(), note).toContain(note));
      if (over.plan?.kind === "current") await waitApplyReason(note);
      else await waitApplyReady();
    }
  }, 20_000);

  it("T19 every blocked reason disables the button and explains itself", async () => {
    const { client } = await pickerWithRows();
    const paths = (n: number) =>
      Array.from({ length: n }, (_, i) => `src/file${i}.ts`);
    const cases: [
      SubmodulePickPlan,
      string,
      string[],
      Partial<SubmodulePickRead>?,
      RegExp[]?,
    ][] = [
      // The fifth member lists what the live note must NOT say.
      // The plan read names only the first path git would overwrite (or the
      // ignored ones), so its list never reads as complete.
      [
        blocked("wouldOverwrite", null, paths(1)),
        `${SUB} has local changes this commit would overwrite.`,
        [
          "src/file0.ts",
          "and possibly others",
          `Commit or stash them inside ${SUB} first.`,
        ],
      ],
      [
        blocked("wouldOverwrite", null, paths(3)),
        `${SUB} has local changes this commit would overwrite.`,
        ["src/file2.ts", "and possibly others"],
      ],
      [
        blocked("wouldOverwrite", "error: Your local changes", paths(12)),
        `${SUB} has local changes this commit would overwrite.`,
        [
          "and 7 more, possibly others",
          "error: Your local changes",
          "src/file4.ts",
        ],
      ],
      [
        blocked("wouldOverwrite", null, paths(20)),
        `${SUB} has local changes this commit would overwrite.`,
        ["and more"],
        undefined,
        [/and \d+ more/],
      ],
      [
        blocked("untrackedInTheWay", "error: untracked files", paths(2)),
        `${SUB} has untracked files in the way of this commit.`,
        [
          `Move or delete them inside ${SUB} first, or stash them with untracked files included.`,
          "src/file1.ts",
          "and possibly others",
          "error: untracked files",
        ],
      ],
      [
        blocked("ignoredInTheWay", null, paths(1)),
        `${SUB} has ignored files where this commit adds or removes files.`,
        [`Move or delete them inside ${SUB} first.`, "src/file0.ts"],
      ],
      [
        blocked("detachedOrphan"),
        `${SUB} has commits only its detached HEAD holds.`,
        ["Create a branch for them inside"],
      ],
      [
        blocked("detachedUnverified", "probe failed"),
        `Can't confirm that the commits ${SUB} has checked out are saved on a branch.`,
        ["probe failed"],
      ],
      [
        blocked("detachedUnverified", "probe failed"),
        `Can't confirm that the commits ${SUB} has checked out are saved on a branch, because its history is shallow.`,
        ["Use Fetch full history under the list, then try again."],
        { shallow: true },
      ],
      [
        blocked("notFetched"),
        `${SUB} doesn't have this commit yet.`,
        ["Fetch, then try again."],
      ],
      [
        blocked(
          "midOperation",
          "invalid argument: A merge is in progress. Finish or abort it first.",
        ),
        "A merge is in progress.",
        ["A merge is in progress. Finish or abort it first."],
      ],
      [
        blocked("midOperation"),
        "Another operation is in progress in this repository.",
        [
          "Another operation is in progress in this repository. Finish or abort it first.",
        ],
      ],
      [
        blocked("submoduleMidOperation"),
        `A conflict, merge, rebase, cherry-pick or revert is in progress inside ${SUB}.`,
        ["Finish or abort it there first."],
      ],
      [
        blocked("submoduleMidOperation", "a rebase"),
        `Finish or abort a rebase inside ${SUB} first.`,
        [],
      ],
      [
        blocked("submoduleMidOperation", "unresolved conflicts"),
        `Resolve the conflicts inside ${SUB} first.`,
        [],
      ],
      [
        blocked("noPointer"),
        `This repository has no commit recorded for ${SUB} to change.`,
        [],
      ],
      [blocked("notInitialized"), `${SUB} isn't initialized.`, []],
      [
        blocked("unusable", "a link sits there"),
        `${SUB} can't be used as a submodule checkout.`,
        ["a link sits there"],
      ],
      [blocked("notFound"), `No commit in ${SUB} matches that id.`, []],
      [
        blocked("ambiguous", "3 commits start with ab12"),
        "More than one commit starts with that id.",
        ["3 commits start with ab12"],
      ],
      [blocked("notACommit"), "That id isn't a commit.", []],
      [
        blocked("checkFailed", "git died"),
        "Couldn't check whether this commit is safe to check out.",
        ["git died"],
      ],
    ];
    for (const [plan, lead, extra, over, absent = []] of cases) {
      await replan(client, (sha) => readOf(sha, plan, over));
      await waitApplyReason(lead);
      expect(liveNote()).toContain(lead);
      for (const x of extra) expect(liveNote(), x).toContain(x);
      for (const x of absent) expect(liveNote(), String(x)).not.toMatch(x);
    }
  }, 20_000);

  it("T44 an unusable submodule with no reason shows the sentence alone", async () => {
    planFor = (sha) => readOf(sha, blocked("unusable", null));
    await pickerWithRows();
    const lead = `${SUB} can't be used as a submodule checkout.`;
    await waitApplyReason(lead);
    expect(liveNote()).toBe(lead);
  });

  it("T51 a note that offers a fetch emphasises that fetch control, and only then", async () => {
    const fetchVariant = (name: string) =>
      screen.getByRole("button", { name }).classList.contains("bg-primary");
    planFor = (sha) =>
      readOf(sha, blocked("detachedUnverified"), { shallow: true });
    const { client } = await pickerWithRows();
    await waitFor(() => expect(fetchVariant("Fetch full history")).toBe(true));
    expect(fetchVariant("Fetch")).toBe(false);
    await replan(client, (sha) => readOf(sha, blocked("notFetched")));
    await waitFor(() => expect(fetchVariant("Fetch")).toBe(true));
    await replan(client, (sha) => readOf(sha, READY, { shallow: true }));
    await waitApplyReady();
    expect(fetchVariant("Fetch")).toBe(false);
    expect(fetchVariant("Fetch full history")).toBe(false);
  });

  it("T20 not on a remote shows only for a measured false and never blocks", async () => {
    vi.mocked(gitSubmoduleCommits).mockResolvedValue(
      page([
        commit(A, "Add feature", false),
        commit(P, "Recorded one", null),
        commit(C, "Older change", true),
      ]),
    );
    planFor = (sha) =>
      readOf(sha, READY, {
        commit: commit(sha, "x", sha === A ? false : null),
      });
    const { user } = await pickerWithRows();
    expect(row(A)).toHaveTextContent("not on a remote");
    expect(row(P)).not.toHaveTextContent("not on a remote");
    expect(row(C)).not.toHaveTextContent("not on a remote");
    await waitApplyReady();
    expect(liveNote()).not.toContain("No remote branch or tag");
    await user.click(row(A) as HTMLElement);
    await waitFor(() =>
      expect(liveNote()).toContain(
        "No remote branch or tag fetched here contains it, so other clones may not be able to check it out until it's pushed.",
      ),
    );
    await waitApplyReady();
  });

  it("T31 arrowing through rows never writes the pending text into the live note", async () => {
    await pickerWithRows();
    await waitFor(() => expect(liveNote()).toContain("forward 1 commit"));
    const before = liveNote();
    fireEvent.keyDown(row(P) as HTMLElement, { key: "ArrowDown" });
    expect(
      screen.getByText("Checking this commit…", { selector: "p" }),
    ).toBeInTheDocument();
    expect(liveNote()).toBe(before);
    expect(liveNote()).not.toContain("Checking");
    await waitApplyReady();
    expect(liveNote()).not.toContain("Checking");
  });

  it("T36 a failed check of the highlighted commit says so on the button and offers Check again", async () => {
    planFor = () => {
      throw { kind: "invalidArgument", message: "invalid argument: no" };
    };
    const { user } = await pickerWithRows();
    await waitApplyReason("This commit couldn't be checked");
    expect(applyButton()).not.toHaveAccessibleDescription(
      "Checking this commit…",
    );
    expect(liveNote()).toContain("Couldn't check this commit.");
    const calls = vi.mocked(gitSubmodulePickPlan).mock.calls.length;
    planFor = (sha) => readOf(sha);
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(vi.mocked(gitSubmodulePickPlan).mock.calls.length).toBe(calls + 1);
    await waitApplyReady();
  });

  it("T41 while the list, the refs or the commits are loading, empty or failed, the button says which", async () => {
    const refsHeld = held<SubmoduleRefs>();
    vi.mocked(gitSubmoduleRefs).mockReturnValue(refsHeld.promise);
    renderHarness("list");
    await openPicker();
    await waitApplyReason("Loading commits…");
    const commitsHeld = held<SubmoduleCommitPage>();
    vi.mocked(gitSubmoduleCommits).mockReturnValue(commitsHeld.promise);
    await act(async () => refsHeld.resolve(refsOf()));
    await waitApplyReason("Loading commits…");
    // The skeleton rows' own status line.
    expect(
      screen.getByText("Loading commits…", { selector: '[role="status"]' }),
    ).toBeInTheDocument();
    await act(async () => commitsHeld.reject({ kind: "io", message: "x" }));
    await waitApplyReason("Commits couldn't be loaded");
    cleanup();

    vi.mocked(gitSubmoduleRefs).mockRejectedValue({ kind: "io", message: "x" });
    renderHarness("list");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: `Actions for ${SUB}` }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Choose commit…" }),
    );
    await waitApplyReason(`${SUB}'s branches and tags couldn't be read`);
    cleanup();

    vi.mocked(gitSubmoduleRefs).mockResolvedValue(refsOf());
    vi.mocked(gitSubmoduleCommits).mockResolvedValue(page([]));
    renderHarness("list");
    await openPicker();
    await waitApplyReason("No commits to pick from");
  });
});

describe("applying", () => {
  it("T16 Enter applies the highlighted commit once with the plan's sha and pointer; a repeating Enter and a second press in flight do not", async () => {
    await pickerWithRows();
    act(() => row(A)?.focus());
    await waitApplyReady();
    // No fresh press yet: a held key's repeat never applies.
    // Each refusal is read after the mutation's async start would have run.
    fireEvent.keyDown(row(A) as HTMLElement, { key: "Enter", repeat: true });
    await act(async () => undefined);
    expect(gitSubmoduleSetCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(row(A) as HTMLElement, { key: "Enter", altKey: true });
    await act(async () => undefined);
    expect(gitSubmoduleSetCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(search(), { key: "Enter" });
    await act(async () => undefined);
    expect(gitSubmoduleSetCommit).not.toHaveBeenCalled();

    const pending = held<SubmodulePickOutcome>();
    vi.mocked(gitSubmoduleSetCommit).mockReturnValue(pending.promise);
    act(() => {
      fireEvent.keyDown(row(A) as HTMLElement, { key: "Enter" });
      fireEvent.keyDown(row(A) as HTMLElement, { key: "Enter" });
    });
    fireEvent.click(applyButton());
    // The mutationFn runs after the mutation's own onMutate chain.
    await act(async () => undefined);
    expect(gitSubmoduleSetCommit).toHaveBeenCalledExactlyOnceWith(
      REPO,
      SUB,
      A,
      P,
    );
    await waitApplyReason("Checking out and staging…");
    expect(
      screen.getByRole("listbox", { name: "Commits on origin/main" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("combobox", { name: "Commits from" }),
    ).toHaveAccessibleDescription("Checking out and staging…");
    await act(async () => pending.resolve({ kind: "changed" }));
  });

  it("T17 Enter inside the debounce window does not apply the previously highlighted commit", async () => {
    await pickerWithRows();
    await waitApplyReady();
    act(() => row(P)?.focus());
    fireEvent.keyDown(row(P) as HTMLElement, { key: "ArrowDown" });
    fireEvent.keyDown(row(C) as HTMLElement, { key: "Enter" });
    await act(async () => undefined);
    expect(gitSubmoduleSetCommit).not.toHaveBeenCalled();
    expect(applyButton()).toHaveAccessibleDescription("Checking this commit…");
  });

  it("T77 a pasted id inside the search debounce never applies the commit highlighted before it", async () => {
    const { user } = await pickerWithRows();
    await waitApplyReady();
    // The id's search matches no message, so only its pinned row lists.
    vi.mocked(gitSubmoduleCommits).mockImplementation(
      async (_r, _p, _rev, _skip, _limit, q) =>
        q === E ? page([]) : page(DEFAULT_ROWS),
    );
    // One tick: the paste, the press, and ArrowDown then Enter into the list.
    act(() => {
      fireEvent.change(search(), { target: { value: E } });
    });
    expect(applyButton()).toHaveAccessibleDescription("Loading commits…");
    fireEvent.click(applyButton());
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Enter",
    });
    await act(async () => undefined);
    expect(gitSubmoduleSetCommit).not.toHaveBeenCalled();
    // Once the search catches up, the pasted commit is the one applied.
    await waitFor(() =>
      expect(row(E)).toHaveAttribute("aria-selected", "true"),
    );
    await waitApplyReady();
    await user.click(applyButton());
    await waitFor(() =>
      expect(gitSubmoduleSetCommit).toHaveBeenCalledExactlyOnceWith(
        REPO,
        SUB,
        E,
        P,
      ),
    );
  });

  it("T21 each setter outcome reports itself", async () => {
    // The highlighted commit moves the pointer: the read records D.
    planFor = (sha) => readOf(sha, READY, { pointer: D });
    type Case = {
      outcome: SubmodulePickOutcome | Error;
      check: () => void;
      leaves: boolean;
    };
    const cases: Case[] = [
      {
        outcome: { kind: "set", sha: P, checkout: "checkOut", nestedLeft: 0 },
        check: () =>
          expect(toast.success).toHaveBeenCalledWith(
            `${SUB} now points at bbbbbbb, staged for you to commit.`,
            undefined,
          ),
        leaves: true,
      },
      {
        outcome: {
          kind: "set",
          sha: P,
          checkout: "checkOut",
          nestedLeft: null,
        },
        check: () =>
          expect(toast.success).toHaveBeenCalledWith(
            `${SUB} now points at bbbbbbb, staged for you to commit.`,
            undefined,
          ),
        leaves: true,
      },
      {
        outcome: { kind: "set", sha: P, checkout: "checkOut", nestedLeft: 2 },
        check: () =>
          expect(toast.success).toHaveBeenCalledWith(
            `${SUB} now points at bbbbbbb, staged for you to commit.`,
            {
              description: `Its own submodules still need updating; use ${SUB}'s Update in this list.`,
            },
          ),
        leaves: true,
      },
      {
        outcome: {
          kind: "set",
          sha: P,
          checkout: "alreadyThere",
          nestedLeft: 0,
        },
        check: () =>
          expect(toast.success).toHaveBeenCalledWith(
            `${SUB} now points at bbbbbbb, staged for you to commit.`,
            undefined,
          ),
        leaves: true,
      },
      {
        outcome: { kind: "changed" },
        check: () =>
          expect(toast.info).toHaveBeenCalledWith(
            `${SUB} changed while this ran; nothing was staged.`,
            {
              description:
                "bbbbbbb wasn't checked out. Look again before picking.",
            },
          ),
        leaves: false,
      },
      {
        outcome: {
          kind: "blocked",
          why: "wouldOverwrite",
          reason: "error: changes would be overwritten",
          paths: ["lib/a.c", "lib/b.c", "lib/old-name.c"],
        },
        check: () => {
          expect(toast.error).not.toHaveBeenCalled();
          expect(liveNote()).toContain("lib/old-name.c");
          expect(liveNote()).toContain("error: changes would be overwritten");
          // The setter's list is git's whole one.
          expect(liveNote()).not.toContain("possibly others");
          expect(applyButton()).toHaveAccessibleDescription(
            `${SUB} has local changes this commit would overwrite.`,
          );
        },
        leaves: false,
      },
      {
        outcome: { kind: "checkoutFailed", reason: "hook failed." },
        check: () =>
          expect(toast.error).toHaveBeenCalledWith(
            `Checking out bbbbbbb in ${SUB} didn't finish. Nothing was staged.`,
            {
              description: `hook failed. ${SUB}'s own checkout may have changed.`,
            },
          ),
        leaves: false,
      },
      {
        outcome: { kind: "checkoutFailed", reason: "hook failed" },
        check: () =>
          expect(toast.error).toHaveBeenCalledWith(
            `Checking out bbbbbbb in ${SUB} didn't finish. Nothing was staged.`,
            {
              description: `hook failed. ${SUB}'s own checkout may have changed.`,
            },
          ),
        leaves: false,
      },
      ...(
        [
          [
            "pointerMoved",
            null,
            "but the new commit isn't staged.",
            `Its recorded commit changed while the checkout ran. Stage ${SUB} in Changes to finish.`,
          ],
          [
            "stageFailed",
            "index.lock held",
            "but the new commit isn't staged.",
            `Stage ${SUB} in Changes to finish. index.lock held.`,
          ],
          [
            "stageUnconfirmed",
            "index read timed out",
            "but staging it couldn't be confirmed.",
            `The staged commit couldn't be read back, so it may or may not have landed. Check ${SUB} in Changes and stage it there if it isn't. index read timed out.`,
          ],
        ] as const
      ).map(
        ([why, reason, tail, description]): Case => ({
          outcome: { kind: "checkedOutNotStaged", sha: P, why, reason },
          check: () =>
            expect(toast.warning).toHaveBeenCalledWith(
              `${SUB} is checked out at bbbbbbb, ${tail}`,
              { description, duration: 10_000 },
            ),
          leaves: false,
        }),
      ),
      {
        outcome: new Error("boom"),
        check: () => expect(toastError).toHaveBeenCalledTimes(1),
        leaves: false,
      },
    ];
    for (const { outcome, check, leaves } of cases) {
      vi.clearAllMocks();
      if (outcome instanceof Error)
        vi.mocked(gitSubmoduleSetCommit).mockRejectedValue(outcome);
      else vi.mocked(gitSubmoduleSetCommit).mockResolvedValue(outcome);
      const { user } = await pickerWithRows();
      await waitApplyReady();
      await user.click(applyButton());
      await waitFor(check);
      if (leaves)
        expect(
          await screen.findByRole("heading", { name: "Submodules" }),
        ).toBeInTheDocument();
      else expect(search()).toBeInTheDocument();
      cleanup();
    }
  }, 30_000);

  it("T21b the success toast says staged only when the pointer moved, whatever the checkout did", async () => {
    const recorded = `${SUB} is checked out at bbbbbbb, the commit this repository already records.`;
    const moved = `${SUB} now points at bbbbbbb, staged for you to commit.`;
    for (const [pointer, plan, checkout, headline] of [
      [P, READY, "checkOut", recorded],
      [P, READY, "alreadyThere", recorded],
      [C, { kind: "ready", checkout: "alreadyThere" }, "alreadyThere", moved],
      [C, READY, "checkOut", moved],
    ] as const) {
      vi.clearAllMocks();
      planFor = (sha) => readOf(sha, plan, { pointer });
      vi.mocked(gitSubmoduleSetCommit).mockResolvedValue({
        kind: "set",
        sha: P,
        checkout,
        nestedLeft: 0,
      });
      const { user } = await pickerWithRows();
      await waitApplyReady();
      await user.click(applyButton());
      await waitFor(() =>
        expect(toast.success, `${pointer} ${checkout}`).toHaveBeenCalledWith(
          headline,
          undefined,
        ),
      );
      cleanup();
    }
  });

  it("T39 a block that arrives after the highlight moved on is toasted", async () => {
    const pending = held<SubmodulePickOutcome>();
    vi.mocked(gitSubmoduleSetCommit).mockReturnValue(pending.promise);
    const { user } = await pickerWithRows();
    await waitApplyReady();
    await user.click(applyButton());
    fireEvent.keyDown(row(P) as HTMLElement, { key: "ArrowDown" });
    expect(row(C)).toHaveAttribute("aria-selected", "true");
    await act(async () =>
      pending.resolve({
        kind: "blocked",
        why: "detachedOrphan",
        reason: null,
        paths: [],
      }),
    );
    expect(toast.error).toHaveBeenCalledWith(
      `Didn't check out bbbbbbb in ${SUB}.`,
      { description: `${SUB} has commits only its detached HEAD holds.` },
    );
  });

  it("T40 after the recorded commit changed, the button waits for the fresh check before it can apply", async () => {
    vi.mocked(gitSubmoduleSetCommit).mockResolvedValue({ kind: "changed" });
    const { user } = await pickerWithRows();
    // The settled note, not the gate, so the first press lands even when the
    // gate's own checking arm is the thing under test.
    await waitFor(() => expect(liveNote()).toContain("forward 1 commit"));
    await waitApplyReady();
    const fresh = held<SubmodulePickRead>();
    planFor = () => fresh.promise;
    await user.click(applyButton());
    await waitFor(() => expect(toast.info).toHaveBeenCalled());
    // Read off the note line, which never consults the gate: an Enter while it
    // shows must not resend the pointer that just lost.
    await screen.findByText("Checking this commit…", { selector: "p" });
    fireEvent.keyDown(row(P) as HTMLElement, { key: "Enter" });
    await act(async () => undefined);
    expect(gitSubmoduleSetCommit).toHaveBeenCalledTimes(1);
    await waitApplyReason("Checking this commit…");
    await new Promise((r) => setTimeout(r, 5));
    await act(async () => fresh.resolve(readOf(P, READY, { pointer: C })));
    await waitApplyReady();
    vi.mocked(gitSubmoduleSetCommit).mockClear();
    await user.click(applyButton());
    expect(gitSubmoduleSetCommit).toHaveBeenCalledWith(REPO, SUB, P, C);
  });

  it("T81 a checkout moved after it landed warns with what HEAD and the recorded commit now read, keeps the picker, and holds Apply for a fresh check", async () => {
    const headline = `${SUB} moved after bbbbbbb was checked out.`;
    for (const [pointer, head, description] of [
      [
        P,
        D,
        "It's now at ddddddd. Its recorded commit is bbbbbbb, the one you picked. Look again before picking.",
      ],
      [
        C,
        D,
        "It's now at ddddddd. Its recorded commit is ccccccc. Look again before picking.",
      ],
      [
        null,
        D,
        "It's now at ddddddd. This repository no longer records a commit for it. Look again before picking.",
      ],
      [
        E,
        D,
        "It's now at ddddddd. Its recorded commit is eeeeeee. Look again before picking.",
      ],
      [
        C,
        null,
        "Its folder no longer holds that checkout. Its recorded commit is ccccccc. Look again before picking.",
      ],
    ] as const) {
      vi.clearAllMocks();
      // The press sends P against a recorded C, so the picked commit and the
      // one it replaced read different pointers.
      planFor = (sha) => readOf(sha, READY, { pointer: C });
      vi.mocked(gitSubmoduleSetCommit).mockResolvedValue({
        kind: "movedAfter",
        sha: P,
        pointer,
        head,
      });
      const { user } = await pickerWithRows();
      await waitApplyReady();
      const fresh = held<SubmodulePickRead>();
      planFor = () => fresh.promise;
      await user.click(applyButton());
      await waitFor(() =>
        expect(toast.warning, `${pointer} ${head}`).toHaveBeenCalledWith(
          headline,
          { description, duration: 10_000 },
        ),
      );
      expect(search()).toBeInTheDocument();
      await waitApplyReason("Checking this commit…");
      await new Promise((r) => setTimeout(r, 5));
      await act(async () => fresh.resolve(readOf(P, READY, { pointer: C })));
      await waitApplyReady();
      expect(gitSubmoduleSetCommit).toHaveBeenCalledTimes(1);
      cleanup();
    }
  }, 30_000);

  it("T82 a checkout whose state couldn't be read back warns with the read's line, keeps the picker, and holds Apply for a fresh check", async () => {
    planFor = (sha) => readOf(sha, READY, { pointer: C });
    vi.mocked(gitSubmoduleSetCommit).mockResolvedValue({
      kind: "readBackFailed",
      sha: P,
      reason: "index read timed out",
    });
    const { user } = await pickerWithRows();
    await waitApplyReady();
    const fresh = held<SubmodulePickRead>();
    planFor = () => fresh.promise;
    await user.click(applyButton());
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        `bbbbbbb was checked out in ${SUB}, but its state couldn't be read back.`,
        {
          description: `index read timed out. Check ${SUB} in Changes, then look again before picking.`,
          duration: 10_000,
        },
      ),
    );
    expect(search()).toBeInTheDocument();
    await waitApplyReason("Checking this commit…");
    fireEvent.keyDown(row(P) as HTMLElement, { key: "Enter" });
    await act(async () => undefined);
    expect(gitSubmoduleSetCommit).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 5));
    await act(async () => fresh.resolve(readOf(P, READY, { pointer: C })));
    await waitApplyReady();
  });

  it("T83 a pasted id whose lookup is still out holds Apply over a message-search row naming it, then applies the pinned id", async () => {
    const { user } = await pickerWithRows();
    await waitApplyReady();
    // A cherry-picked copy whose message names the pasted id lists, and its
    // own plan lands, before the lookup answers.
    vi.mocked(gitSubmoduleCommits).mockImplementation(
      async (_r, _p, _rev, _skip, _limit, q) =>
        q === E
          ? page([commit(D, "(cherry picked from commit e)")])
          : page(DEFAULT_ROWS),
    );
    const lookup = held<SubmodulePickRead>();
    planFor = (sha) =>
      sha === E
        ? lookup.promise
        : readOf(sha, READY, { relation: { kind: "rewind", behind: 2 } });
    act(() => {
      fireEvent.change(search(), { target: { value: E } });
    });
    await waitFor(() =>
      expect(row(D)).toHaveAttribute("aria-selected", "true"),
    );
    await waitFor(() => expect(liveNote()).toContain("back 2 commits"));
    expect(applyButton()).toHaveAttribute("aria-disabled", "true");
    expect(applyButton()).toHaveAccessibleDescription("Loading commits…");
    fireEvent.click(applyButton());
    fireEvent.keyDown(row(D) as HTMLElement, { key: "Enter" });
    await act(async () => undefined);
    expect(gitSubmoduleSetCommit).not.toHaveBeenCalled();
    await act(async () => lookup.resolve(readOf(E)));
    await waitFor(() =>
      expect(row(E)).toHaveAttribute("aria-selected", "true"),
    );
    await waitApplyReady();
    await user.click(applyButton());
    await waitFor(() =>
      expect(gitSubmoduleSetCommit).toHaveBeenCalledExactlyOnceWith(
        REPO,
        SUB,
        E,
        P,
      ),
    );
  });

  it("T93 a pasted id whose lookup failed holds Apply over a message-search row naming it, and its Retry applies the pasted id", async () => {
    const { user } = await pickerWithRows();
    await waitApplyReady();
    // A revert whose message names the pasted id lists, and its own plan lands,
    // while the lookup of the id itself fails.
    vi.mocked(gitSubmoduleCommits).mockImplementation(
      async (_r, _p, _rev, _skip, _limit, q) =>
        q === E
          ? page([commit(D, `Revert "x" This reverts commit ${E}.`)])
          : page(DEFAULT_ROWS),
    );
    let lookupFails = true;
    planFor = (sha) => {
      if (sha === E && lookupFails)
        throw { kind: "io", message: "lookup broke" };
      return readOf(sha, READY, { relation: { kind: "rewind", behind: 2 } });
    };
    act(() => {
      fireEvent.change(search(), { target: { value: E } });
    });
    await waitFor(() =>
      expect(row(D)).toHaveAttribute("aria-selected", "true"),
    );
    await waitFor(() => expect(liveNote()).toContain("back 2 commits"));
    await waitApplyReason("Couldn't look up that commit id.");
    expect(
      screen.getByText(
        (t) => t.startsWith("Couldn't look up that commit id."),
        {
          selector: '[role="status"]',
        },
      ),
    ).toHaveTextContent("lookup broke");
    fireEvent.click(applyButton());
    fireEvent.keyDown(row(D) as HTMLElement, { key: "Enter" });
    await act(async () => undefined);
    expect(gitSubmoduleSetCommit).not.toHaveBeenCalled();
    lookupFails = false;
    await user.click(
      screen.getByRole("button", { name: "Retry looking up that commit id" }),
    );
    await waitFor(() =>
      expect(row(E)).toHaveAttribute("aria-selected", "true"),
    );
    await waitApplyReady();
    await user.click(applyButton());
    await waitFor(() =>
      expect(gitSubmoduleSetCommit).toHaveBeenCalledExactlyOnceWith(
        REPO,
        SUB,
        E,
        P,
      ),
    );
  });

  it("T84 the list reads once per open: a first open, a reopen before the closing dialog unmounted, and a reopen over cached rows", async () => {
    renderHarness("list");
    await screen.findByRole("button", { name: `Actions for ${SUB}` });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(gitSubmodules).toHaveBeenCalledTimes(1);
    const before = document.querySelector(`[data-sub-row="${SUB}"]`);
    expect(before).not.toBeNull();
    // Close and reopen inside the exit animation: the list stays mounted.
    act(() => controls.setMode?.(null));
    act(() => controls.setMode?.("list"));
    await waitFor(() => expect(gitSubmodules).toHaveBeenCalledTimes(2));
    expect(document.querySelector(`[data-sub-row="${SUB}"]`)).toBe(before);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(gitSubmodules).toHaveBeenCalledTimes(2);
    // A reopen after the unmount, over cached rows: still one read.
    act(() => controls.setMode?.(null));
    await waitFor(() =>
      expect(document.querySelector(`[data-sub-row="${SUB}"]`)).toBeNull(),
    );
    act(() => controls.setMode?.("list"));
    await screen.findByRole("button", { name: `Actions for ${SUB}` });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(gitSubmodules).toHaveBeenCalledTimes(3);
  });

  it("T85 a pasted id pasted again holds Apply while its cached lookup re-reads, then applies the settled answer", async () => {
    const F = `eeeeeee${"f".repeat(33)}`;
    const { user } = await pickerWithRows();
    await waitApplyReady();
    vi.mocked(gitSubmoduleCommits).mockImplementation(
      async (_r, _p, _rev, _skip, _limit, q) =>
        q === null ? page(DEFAULT_ROWS) : page([]),
    );
    planFor = (sha) => readOf(sha === "eeeeeee" ? E : sha);
    const paste = (text: string) =>
      act(() => {
        fireEvent.change(search(), { target: { value: text } });
      });
    paste("eeeeeee");
    await waitFor(() =>
      expect(row(E)).toHaveAttribute("aria-selected", "true"),
    );
    await waitApplyReady();
    planFor = (sha) => readOf(sha === "ddddddd" ? D : sha);
    paste("ddddddd");
    await waitFor(() =>
      expect(row(D)).toHaveAttribute("aria-selected", "true"),
    );
    await waitApplyReady();
    // A fetch since made the first prefix name another commit.
    const lookup = held<SubmodulePickRead>();
    planFor = (sha) => (sha === "eeeeeee" ? lookup.promise : readOf(sha));
    paste("eeeeeee");
    await waitFor(() =>
      expect(row(E)).toHaveAttribute("aria-selected", "true"),
    );
    await new Promise((r) => setTimeout(r, 400));
    expect(applyButton()).toHaveAttribute("aria-disabled", "true");
    expect(applyButton()).toHaveAccessibleDescription("Loading commits…");
    fireEvent.click(applyButton());
    fireEvent.keyDown(row(E) as HTMLElement, { key: "Enter" });
    await act(async () => undefined);
    expect(gitSubmoduleSetCommit).not.toHaveBeenCalled();
    await act(async () => lookup.resolve(readOf(F)));
    await waitFor(() =>
      expect(row(F)).toHaveAttribute("aria-selected", "true"),
    );
    await waitApplyReady();
    await user.click(applyButton());
    await waitFor(() =>
      expect(gitSubmoduleSetCommit).toHaveBeenCalledExactlyOnceWith(
        REPO,
        SUB,
        F,
        P,
      ),
    );
  });

  it("T86 a first plan read running across a fetch's settle is read again, and its pre-fetch answer never says the fetch didn't bring the commit", async () => {
    const after = `${SUB} still doesn't have this commit after fetching.`;
    const fetching = held<SubmoduleFetchResult>();
    vi.mocked(gitSubmoduleFetch).mockReturnValue(fetching.promise);
    const { user } = await pickerWithRows();
    await waitApplyReady();
    await user.click(screen.getByRole("button", { name: "Fetch" }));
    // Row C's first plan read starts inside the open picker, before the fetch
    // finishes, and answers from before it.
    const stale = held<SubmodulePickRead>();
    planFor = (sha) => (sha === C ? stale.promise : readOf(sha));
    await user.click(row(C) as HTMLElement);
    await waitFor(() =>
      expect(gitSubmodulePickPlan).toHaveBeenCalledWith(REPO, SUB, C),
    );
    const fresh = held<SubmodulePickRead>();
    planFor = (sha) => (sha === C ? fresh.promise : readOf(sha));
    await act(async () => fetching.resolve({ shallow: false }));
    await new Promise((r) => setTimeout(r, 5));
    await act(async () => stale.resolve(readOf(C, blocked("notFetched"))));
    await waitFor(() =>
      expect(
        vi.mocked(gitSubmodulePickPlan).mock.calls.filter((c) => c[2] === C),
      ).toHaveLength(2),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(`Fetched ${SUB}.`),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(liveNote()).not.toContain(after);
    await new Promise((r) => setTimeout(r, 5));
    await act(async () => fresh.resolve(readOf(C, blocked("notFetched"))));
    await waitFor(() => expect(liveNote()).toContain(after));
  });

  it("T87 a reopen inside the exit animation over a list read still running from the last open reads again once it lands", async () => {
    const first = held<Submodule[]>();
    vi.mocked(gitSubmodules).mockReturnValueOnce(first.promise);
    renderHarness("list");
    await waitFor(() => expect(gitSubmodules).toHaveBeenCalledTimes(1));
    const dialog = screen.getByRole("dialog");
    act(() => controls.setMode?.(null));
    act(() => controls.setMode?.("list"));
    expect(screen.getByRole("dialog")).toBe(dialog);
    const second = held<Submodule[]>();
    vi.mocked(gitSubmodules).mockReturnValueOnce(second.promise);
    // The old read sampled the submodule before an outside repair.
    await act(async () => first.resolve([sub(SUB, "uninitialized")]));
    await waitFor(() => expect(gitSubmodules).toHaveBeenCalledTimes(2));
    await act(async () => second.resolve([sub(SUB)]));
    await screen.findByRole("button", { name: `Actions for ${SUB}` });
    await waitFor(() =>
      expect(screen.queryByText("Not initialized")).toBe(null),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(gitSubmodules).toHaveBeenCalledTimes(2);
  });

  it("T88 a pasted id's pinned row outranks a row picked before the paste, and a row picked after it lands outranks the pin", async () => {
    const cherry = commit(D, "(cherry picked from commit e)");
    vi.mocked(gitSubmoduleCommits).mockImplementation(
      async (_r, _p, _rev, _skip, _limit, q) =>
        q === E ? page([cherry]) : page([...DEFAULT_ROWS, cherry]),
    );
    const { user } = await pickerWithRows();
    await user.click(row(D) as HTMLElement);
    await waitApplyReady();
    const lookup = held<SubmodulePickRead>();
    planFor = (sha) => (sha === E ? lookup.promise : readOf(sha));
    act(() => {
      fireEvent.change(search(), { target: { value: E } });
    });
    await waitFor(() =>
      expect(gitSubmodulePickPlan).toHaveBeenCalledWith(REPO, SUB, E),
    );
    await act(async () => lookup.resolve(readOf(E)));
    await waitFor(() =>
      expect(row(E)).toHaveAttribute("aria-selected", "true"),
    );
    vi.mocked(gitSubmoduleSetCommit).mockResolvedValueOnce({ kind: "changed" });
    await waitApplyReady();
    await user.click(applyButton());
    await waitFor(() =>
      expect(gitSubmoduleSetCommit).toHaveBeenCalledExactlyOnceWith(
        REPO,
        SUB,
        E,
        P,
      ),
    );
    act(() => row(E)?.focus());
    fireEvent.keyDown(row(E) as HTMLElement, { key: "ArrowDown" });
    expect(row(D)).toHaveAttribute("aria-selected", "true");
    await waitApplyReady();
    await user.click(applyButton());
    await waitFor(() =>
      expect(gitSubmoduleSetCommit).toHaveBeenLastCalledWith(REPO, SUB, D, P),
    );
    expect(gitSubmoduleSetCommit).toHaveBeenCalledTimes(2);
  });

  it("T89 Enter in the same tick a pasted id's lookup starts re-reading applies nothing", async () => {
    vi.mocked(gitSubmoduleCommits).mockImplementation(
      async (_r, _p, _rev, _skip, _limit, q) =>
        q === E ? page([]) : page(DEFAULT_ROWS),
    );
    const { client } = await pickerWithRows();
    act(() => {
      fireEvent.change(search(), { target: { value: E } });
    });
    await waitFor(() =>
      expect(row(E)).toHaveAttribute("aria-selected", "true"),
    );
    await waitApplyReady();
    const reread = held<SubmodulePickRead>();
    planFor = (sha) => (sha === E ? reread.promise : readOf(sha));
    act(() => {
      void client.invalidateQueries({
        queryKey: ["repo", REPO, "submodule-pick", SUB, "plan", E],
        exact: true,
      });
      fireEvent.keyDown(row(E) as HTMLElement, { key: "Enter" });
    });
    await act(async () => undefined);
    expect(gitSubmoduleSetCommit).not.toHaveBeenCalled();
    await act(async () => reread.resolve(readOf(E)));
  });

  it("T90 a pick read that turns inactive while a fetch's settle waits on another read is read again after it lands", async () => {
    const fetching = held<SubmoduleFetchResult>();
    vi.mocked(gitSubmoduleFetch).mockReturnValue(fetching.promise);
    const { client, user } = await pickerWithRows();
    await waitApplyReady();
    const probeKey = ["repo", REPO, "submodule-pick", SUB, "probe"];
    const answers = [held<string>(), held<string>(), held<string>()];
    let reads = 0;
    const probe = {
      queryKey: probeKey,
      queryFn: () => answers[reads++].promise,
      staleTime: Number.POSITIVE_INFINITY,
      networkMode: "always" as const,
    };
    const observer = new QueryObserver(client, probe);
    const stop = observer.subscribe(() => undefined);
    await act(async () => answers[0].resolve("before"));
    await waitFor(() =>
      expect(observer.getCurrentResult().data).toBe("before"),
    );
    // Active with data and refetching when the settle starts: not waited on.
    void observer.refetch();
    const other = held<string>();
    void client.prefetchQuery({
      queryKey: ["repo", REPO, "submodule-pick", SUB, "other"],
      queryFn: () => other.promise,
      networkMode: "always",
    });
    await user.click(screen.getByRole("button", { name: "Fetch" }));
    await act(async () => fetching.resolve({ shallow: false }));
    stop();
    await act(async () => other.resolve("x"));
    await act(async () => answers[1].resolve("stale"));
    await act(async () => undefined);
    expect(reads).toBe(2);
    expect(client.getQueryState(probeKey)?.isInvalidated).toBe(true);
    const again = new QueryObserver(client, probe);
    const stopAgain = again.subscribe(() => undefined);
    await waitFor(() => expect(reads).toBe(3));
    await act(async () => answers[2].resolve("after"));
    stopAgain();
  });

  it("T91 a row picked over a pasted id's pin wins for that paste only: the same id pasted again applies once its lookup lands", async () => {
    const cherry = commit(D, "(cherry picked from commit e)");
    vi.mocked(gitSubmoduleCommits).mockImplementation(
      async (_r, _p, _rev, _skip, _limit, q) =>
        q === E ? page([cherry]) : page([...DEFAULT_ROWS, cherry]),
    );
    const { user } = await pickerWithRows();
    const paste = (text: string) =>
      act(() => {
        fireEvent.change(search(), { target: { value: text } });
      });
    paste(E);
    await waitFor(() =>
      expect(row(E)).toHaveAttribute("aria-selected", "true"),
    );
    await waitApplyReady();
    await user.click(row(D) as HTMLElement);
    expect(row(D)).toHaveAttribute("aria-selected", "true");
    paste("");
    await waitFor(() => expect(row(E)).toBe(null));
    expect(row(D)).toHaveAttribute("aria-selected", "true");
    const lookupsOfE = () =>
      vi.mocked(gitSubmodulePickPlan).mock.calls.filter((c) => c[2] === E)
        .length;
    const before = lookupsOfE();
    const lookup = held<SubmodulePickRead>();
    planFor = (sha) => (sha === E ? lookup.promise : readOf(sha));
    paste(E);
    await waitFor(() => expect(lookupsOfE()).toBeGreaterThan(before));
    await act(async () => lookup.resolve(readOf(E)));
    await waitFor(() =>
      expect(row(E)).toHaveAttribute("aria-selected", "true"),
    );
    await waitApplyReady();
    await user.click(applyButton());
    await waitFor(() =>
      expect(gitSubmoduleSetCommit).toHaveBeenCalledExactlyOnceWith(
        REPO,
        SUB,
        E,
        P,
      ),
    );
  });

  it("T92 Enter after a pasted id's lookup answered again, or failed again over its answer, before the picker re-rendered applies nothing", async () => {
    vi.mocked(gitSubmoduleCommits).mockImplementation(
      async (_r, _p, _rev, _skip, _limit, q) =>
        q === E ? page([]) : page(DEFAULT_ROWS),
    );
    const { client } = await pickerWithRows();
    act(() => {
      fireEvent.change(search(), { target: { value: E } });
    });
    await waitFor(() =>
      expect(row(E)).toHaveAttribute("aria-selected", "true"),
    );
    await waitApplyReady();
    const key = ["repo", REPO, "submodule-pick", SUB, "plan", E];
    // The same commit again: only the answer's stamp tells it apart.
    act(() => {
      const at = client.getQueryState(key)?.dataUpdatedAt ?? 0;
      client.setQueryData(key, readOf(E), { updatedAt: at + 1 });
      fireEvent.keyDown(row(E) as HTMLElement, { key: "Enter" });
    });
    await act(async () => undefined);
    expect(gitSubmoduleSetCommit).not.toHaveBeenCalled();
    await waitApplyReady();
    act(() => {
      const query = client.getQueryCache().find({ queryKey: key, exact: true });
      const error = new Error("lookup failed");
      query?.setState({
        ...query.state,
        status: "error",
        error,
        errorUpdatedAt: Date.now(),
        errorUpdateCount: query.state.errorUpdateCount + 1,
        fetchFailureCount: 1,
        fetchFailureReason: error,
      });
      fireEvent.keyDown(row(E) as HTMLElement, { key: "Enter" });
    });
    await act(async () => undefined);
    expect(gitSubmoduleSetCommit).not.toHaveBeenCalled();
  });

  it("T46 Check again on a held failed check asks the plan afresh and lets its answer through", async () => {
    vi.mocked(gitSubmoduleSetCommit).mockResolvedValue({
      kind: "blocked",
      why: "checkFailed",
      reason: "git died",
      paths: [],
    });
    const { user } = await pickerWithRows();
    await waitApplyReady();
    await user.click(applyButton());
    await waitApplyReason(
      "Couldn't check whether this commit is safe to check out.",
    );
    expect(liveNote()).toContain("git died");
    const fresh = held<SubmodulePickRead>();
    planFor = () => fresh.promise;
    await user.click(screen.getByRole("button", { name: "Check again" }));
    // The refused answer is not re-offered while the new one is out.
    await waitApplyReason("Checking this commit…");
    await new Promise((r) => setTimeout(r, 5));
    await act(async () => fresh.resolve(readOf(P)));
    await waitApplyReady();
    expect(liveNote()).toContain(`Moves ${SUB} forward 1 commit.`);
    expect(liveNote()).not.toContain("git died");
  });

  it("T47 a failed check after the recorded commit changed says so instead of waiting", async () => {
    vi.mocked(gitSubmoduleSetCommit).mockResolvedValue({ kind: "changed" });
    const { user } = await pickerWithRows();
    await waitApplyReady();
    planFor = () => {
      throw { kind: "io", message: "plan gone" };
    };
    await user.click(applyButton());
    await waitFor(() => expect(toast.info).toHaveBeenCalled());
    await waitApplyReason("This commit couldn't be checked");
    expect(liveNote()).toContain("Couldn't check this commit.");
    expect(liveNote()).toContain("plan gone");
    planFor = (sha) => readOf(sha);
    await user.click(screen.getByRole("button", { name: "Check again" }));
    await waitApplyReady();
  });

  it("T50 a held block leaves when a search drops its commit and does not come back with it", async () => {
    vi.mocked(gitSubmoduleSetCommit).mockResolvedValue({
      kind: "blocked",
      why: "wouldOverwrite",
      reason: null,
      paths: ["lib/a.c"],
    });
    const { user } = await pickerWithRows();
    await waitApplyReady();
    await user.click(applyButton());
    await waitApplyReason(
      `${SUB} has local changes this commit would overwrite.`,
    );
    vi.mocked(gitSubmoduleCommits).mockImplementation(
      async (_r, _p, _rev, _skip, _limit, q) =>
        q === "zz" ? page([commit(D, "zz match")]) : page(DEFAULT_ROWS),
    );
    await user.type(search(), "zz");
    await waitFor(() => expect(row(P)).toBeNull());
    await user.clear(search());
    await waitFor(() =>
      expect(row(P)).toHaveAttribute("aria-selected", "true"),
    );
    await waitApplyReady();
    expect(liveNote()).not.toContain("local changes");
  });

  it("T25 a pick that settles after the dialog closed still reports, names the repository after a switch, toasts a block, and neither reopens nor navigates", async () => {
    planFor = (sha) => readOf(sha, READY, { pointer: D });
    for (const [settle, outcome, check] of [
      [
        "close",
        { kind: "set", sha: P, checkout: "checkOut", nestedLeft: 0 },
        () =>
          expect(toast.success).toHaveBeenCalledWith(
            `${SUB} now points at bbbbbbb, staged for you to commit.`,
            undefined,
          ),
      ],
      [
        "switch",
        { kind: "set", sha: P, checkout: "checkOut", nestedLeft: 0 },
        () =>
          expect(toast.success).toHaveBeenCalledWith(
            `${SUB} now points at bbbbbbb in r, staged for you to commit.`,
            undefined,
          ),
      ],
      [
        "close",
        { kind: "blocked", why: "notFound", reason: null, paths: [] },
        () =>
          expect(toast.error).toHaveBeenCalledWith(
            `Didn't check out bbbbbbb in ${SUB}.`,
            { description: `No commit in ${SUB} matches that id.` },
          ),
      ],
    ] as const) {
      vi.clearAllMocks();
      const pending = held<SubmodulePickOutcome>();
      vi.mocked(gitSubmoduleSetCommit).mockReturnValue(pending.promise);
      const { user } = await pickerWithRows();
      await waitApplyReady();
      await user.click(applyButton());
      if (settle === "close") act(() => controls.setMode?.(null));
      else
        act(() => {
          useUiStore.setState({ repoPath: OTHER });
          controls.setRepo?.(OTHER);
        });
      await act(async () => pending.resolve(outcome as SubmodulePickOutcome));
      check();
      if (settle === "close")
        await waitFor(() =>
          expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
        );
      else
        expect(screen.queryByRole("heading", { name: "Choose commit" })).toBe(
          null,
        );
      useUiStore.setState({ repoPath: REPO });
      cleanup();
    }
  });

  it("T32 a pick on one row does not hold another row's picker", async () => {
    vi.mocked(gitSubmodules).mockResolvedValue([sub(SUB), sub(SUB2)]);
    const pending = held<SubmodulePickOutcome>();
    vi.mocked(gitSubmoduleSetCommit).mockReturnValue(pending.promise);
    const { user } = await pickerWithRows();
    await waitApplyReady();
    await user.click(applyButton());
    await waitApplyReason("Checking out and staging…");
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    act(() => controls.setMode?.("list"));
    await openPicker(SUB2);
    await waitFor(() => expect(row(P)).not.toBeNull());
    await waitApplyReady();
    await act(async () => pending.resolve({ kind: "changed" }));
  });
});

describe("fetching", () => {
  it("T22 Fetch and Fetch full history call the fetch with the right flag and are held offline with the reason", async () => {
    vi.mocked(gitSubmoduleCommits).mockResolvedValue(
      page(DEFAULT_ROWS, { shallow: true }),
    );
    const { user } = await pickerWithRows();
    await user.click(screen.getByRole("button", { name: "Fetch" }));
    await waitFor(() =>
      expect(gitSubmoduleFetch).toHaveBeenCalledWith(REPO, SUB, false),
    );
    expect(
      screen.getByText(
        "This submodule's history is shallow, so older commits aren't listed.",
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(`Fetched ${SUB}.`),
    );
    await user.click(
      screen.getByRole("button", { name: "Fetch full history" }),
    );
    await waitFor(() =>
      expect(gitSubmoduleFetch).toHaveBeenCalledWith(REPO, SUB, true),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        `Fetched ${SUB}'s full history.`,
      ),
    );
    cleanup();

    vi.mocked(useOnline).mockReturnValue(false);
    vi.mocked(gitSubmoduleFetch).mockClear();
    await pickerWithRows();
    for (const name of ["Fetch", "Fetch full history"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveAccessibleDescription(OFFLINE_WRITE_REASON);
      fireEvent.click(button);
    }
    expect(gitSubmoduleFetch).not.toHaveBeenCalled();
  });

  it("T23 a commit still missing after a successful fetch says so instead of asking for another fetch, and not before the plan has been read again", async () => {
    planFor = (sha) => readOf(sha, blocked("notFetched"));
    const { user } = await pickerWithRows();
    const first = `${SUB} doesn't have this commit yet. Fetch, then try again.`;
    await waitFor(() => expect(liveNote()).toContain(first));
    const again = held<SubmodulePickRead>();
    planFor = () => again.promise;
    await user.click(screen.getByRole("button", { name: "Fetch" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(`Fetched ${SUB}.`),
    );
    expect(liveNote()).toContain(first);
    await new Promise((r) => setTimeout(r, 5));
    await act(async () => again.resolve(readOf(P, blocked("notFetched"))));
    await waitFor(() =>
      expect(liveNote()).toContain(
        `${SUB} still doesn't have this commit after fetching. Its remote may not share it on any branch.`,
      ),
    );
  });

  it("T34 a fetch that settles moves neither focus nor the highlight", async () => {
    const { user } = await pickerWithRows();
    await user.click(row(C) as HTMLElement);
    const fetchButton = screen.getByRole("button", { name: "Fetch" });
    await user.click(fetchButton);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    await act(async () => undefined);
    expect(document.activeElement).toBe(fetchButton);
    expect(row(C)).toHaveAttribute("aria-selected", "true");
  });

  it("T42 Apply holds while a fetch of this submodule runs and returns when it settles", async () => {
    const fetching = held<SubmoduleFetchResult>();
    vi.mocked(gitSubmoduleFetch).mockReturnValue(fetching.promise);
    const { user } = await pickerWithRows();
    await waitApplyReady();
    await user.click(screen.getByRole("button", { name: "Fetch" }));
    expect(
      screen.getByRole("button", { name: /Fetch$/ }),
    ).toHaveAccessibleDescription("Fetching…");
    await waitApplyReason("Fetching…");
    fireEvent.click(applyButton());
    fireEvent.keyDown(row(P) as HTMLElement, { key: "Enter" });
    await act(async () => undefined);
    expect(gitSubmoduleSetCommit).not.toHaveBeenCalled();
    await act(async () => fetching.resolve({ shallow: false }));
    await waitApplyReady();
    fireEvent.click(applyButton());
    await act(async () => undefined);
    expect(gitSubmoduleSetCommit).toHaveBeenCalledTimes(1);
  });

  it("T73 Fetch full history over a remote that is itself shallow says older history is still missing", async () => {
    vi.mocked(gitSubmoduleCommits).mockResolvedValue(
      page(DEFAULT_ROWS, { shallow: true }),
    );
    vi.mocked(gitSubmoduleFetch).mockResolvedValue({ shallow: true });
    const { user } = await pickerWithRows();
    await user.click(
      screen.getByRole("button", { name: "Fetch full history" }),
    );
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        `Fetched what ${SUB}'s remote has; it is itself shallow, so older history is still missing.`,
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("T78 Fetch full history whose shallow re-read failed says only that it fetched", async () => {
    vi.mocked(gitSubmoduleCommits).mockResolvedValue(
      page(DEFAULT_ROWS, { shallow: true }),
    );
    vi.mocked(gitSubmoduleFetch).mockResolvedValue({ shallow: null });
    const { user } = await pickerWithRows();
    await user.click(
      screen.getByRole("button", { name: "Fetch full history" }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledExactlyOnceWith(`Fetched ${SUB}.`),
    );
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("T74 a running fetch still holds both fetch controls after the picker is left and opened again", async () => {
    const fetching = held<SubmoduleFetchResult>();
    vi.mocked(gitSubmoduleFetch).mockReturnValue(fetching.promise);
    vi.mocked(gitSubmoduleCommits).mockResolvedValue(
      page(DEFAULT_ROWS, { shallow: true }),
    );
    const { user } = await pickerWithRows();
    await user.click(
      screen.getByRole("button", { name: "Fetch full history" }),
    );
    await user.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("heading", { name: "Submodules" });
    await openPicker();
    await waitFor(() => expect(row(P)).not.toBeNull());
    // The running one's spinner leads its name with "Loading".
    for (const name of [/^Fetch$/, /Fetch full history$/])
      expect(
        screen.getByRole("button", { name }),
        String(name),
      ).toHaveAccessibleDescription("Fetching…");
    expect(gitSubmoduleFetch).toHaveBeenCalledTimes(1);
    await act(async () => fetching.resolve({ shallow: false }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Fetch" }),
      ).not.toHaveAccessibleDescription("Fetching…"),
    );
  });
});

describe("focus rescues", () => {
  it("T37 each retry in the picker keeps focus off the page body when its own press removes it", async () => {
    // refs Retry, host = the picker body.
    vi.mocked(gitSubmoduleRefs).mockRejectedValue({ kind: "io", message: "x" });
    renderHarness("list");
    let user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: `Actions for ${SUB}` }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Choose commit…" }),
    );
    // Each press follows the entry frame; T75 covers a press that beats it.
    const retry = await screen.findByRole("button", { name: "Retry" });
    await act(frames);
    const refsHeld = held<SubmoduleRefs>();
    vi.mocked(gitSubmoduleRefs).mockReturnValue(refsHeld.promise);
    await user.click(retry);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Retry" })).toBe(null),
    );
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toHaveAttribute("tabindex", "-1");
    await act(async () => refsHeld.resolve(refsOf()));
    cleanup();

    // commits Retry, host = the bordered list box.
    vi.mocked(gitSubmoduleRefs).mockResolvedValue(refsOf());
    vi.mocked(gitSubmoduleCommits).mockRejectedValue({
      kind: "io",
      message: "x",
    });
    renderHarness("list");
    user = await openPicker();
    const commitsRetry = await screen.findByRole("button", { name: "Retry" });
    await act(frames);
    const commitsHeld = held<SubmoduleCommitPage>();
    vi.mocked(gitSubmoduleCommits).mockReturnValue(commitsHeld.promise);
    await user.click(commitsRetry);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Retry" })).toBe(null),
    );
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toHaveAttribute("tabindex", "-1");
    await act(async () => commitsHeld.resolve(page(DEFAULT_ROWS)));
    cleanup();

    // the failed plan read's Check again, host = the note.
    vi.mocked(gitSubmoduleCommits).mockResolvedValue(page(DEFAULT_ROWS));
    planFor = () => {
      throw { kind: "invalidArgument", message: "no" };
    };
    ({ user } = await pickerWithRows());
    const readAgain = await screen.findByRole("button", {
      name: "Check again",
    });
    const planHeld = held<SubmodulePickRead>();
    planFor = () => planHeld.promise;
    await user.click(readAgain);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Check again" })).toBe(null),
    );
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toHaveAttribute("tabindex", "-1");
    await act(async () => planHeld.resolve(readOf(P)));
    cleanup();

    // checkFailed's Check again: it leaves when the answer lands.
    planFor = (sha) => readOf(sha, blocked("checkFailed", "git died"));
    ({ user } = await pickerWithRows());
    const checkAgain = await screen.findByRole("button", {
      name: "Check again",
    });
    const checkHeld = held<SubmodulePickRead>();
    planFor = () => checkHeld.promise;
    await user.click(checkAgain);
    await new Promise((r) => setTimeout(r, 5));
    await act(async () => checkHeld.resolve(readOf(P)));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Check again" })).toBe(null),
    );
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toHaveAttribute("tabindex", "-1");
  });
});

/** Holds back the picker's own entry frame, as a slow runner's late paint
 *  does: only frames the picker's module asks for wait for `release`. */
function holdEntryFrame() {
  const held: FrameRequestCallback[] = [];
  const raf = window.requestAnimationFrame.bind(window);
  const spy = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((cb) => {
      if (!new Error().stack?.includes("ChooseSubmoduleCommit.tsx"))
        return raf(cb);
      held.push(cb);
      return 0;
    });
  return {
    held,
    release: () => {
      for (const cb of held.splice(0)) cb(performance.now());
    },
    restore: () => spy.mockRestore(),
  };
}

describe("the entry frame", () => {
  it("T75 a press that lands before the entry frame keeps focus where the press left it", async () => {
    vi.mocked(gitSubmoduleRefs).mockRejectedValue({ kind: "io", message: "x" });
    renderHarness("list");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: `Actions for ${SUB}` }),
    );
    const entry = holdEntryFrame();
    try {
      await user.click(
        await screen.findByRole("menuitem", { name: "Choose commit…" }),
      );
      const retry = await screen.findByRole("button", { name: "Retry" });
      expect(entry.held).toHaveLength(1);
      const refsHeld = held<SubmoduleRefs>();
      vi.mocked(gitSubmoduleRefs).mockReturnValue(refsHeld.promise);
      await user.click(retry);
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Retry" })).toBe(null),
      );
      const landed = document.activeElement;
      expect(landed).toHaveAttribute("tabindex", "-1");
      expect(search()).toBeInTheDocument();
      act(() => entry.release());
      expect(document.activeElement).toBe(landed);
      await act(async () => refsHeld.resolve(refsOf()));
    } finally {
      entry.restore();
    }
  });
});

describe("focus when the search box leaves", () => {
  it("T48 a refs answer that removes the focused search box keeps focus in the picker", async () => {
    const unusable = refsOf({
      checkout: "replaced",
      reason: null,
      branches: [],
      remoteBranches: [],
    });
    for (const settle of [
      (h: ReturnType<typeof held<SubmoduleRefs>>) => h.resolve(unusable),
      (h: ReturnType<typeof held<SubmoduleRefs>>) =>
        h.reject({ kind: "io", message: "x" }),
    ]) {
      const refsHeld = held<SubmoduleRefs>();
      vi.mocked(gitSubmoduleRefs).mockReturnValue(refsHeld.promise);
      renderHarness("list");
      await openPicker();
      await waitFor(() => expect(document.activeElement).toBe(search()));
      await act(async () => settle(refsHeld));
      await waitFor(() =>
        expect(screen.queryByRole("textbox", { name: "Search commits" })).toBe(
          null,
        ),
      );
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toHaveAttribute("tabindex", "-1");
      cleanup();
    }

    // An answer in before the entry frame: the body takes the landing.
    vi.mocked(gitSubmoduleRefs).mockResolvedValue(unusable);
    renderHarness("list");
    await openPicker();
    await screen.findByText(REPLACED_COPY, {
      selector: "p",
    });
    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute("tabindex", "-1"),
    );
  });

  it("T54 a refs answer that removes the list with focus on Fetch keeps focus in the picker", async () => {
    const refsHeld = held<SubmoduleRefs>();
    vi.mocked(gitSubmoduleRefs).mockReturnValue(refsHeld.promise);
    renderHarness("list");
    await openPicker();
    await waitFor(() => expect(document.activeElement).toBe(search()));
    const fetchButton = screen.getByRole("button", { name: "Fetch" });
    act(() => fetchButton.focus());
    expect(document.activeElement).toBe(fetchButton);
    await act(async () =>
      refsHeld.resolve(
        refsOf({ checkout: "replaced", branches: [], remoteBranches: [] }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Fetch" })).toBe(null),
    );
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toHaveAttribute("tabindex", "-1");
    expect(document.activeElement).toContainElement(
      screen.getByText(REPLACED_COPY, {
        selector: "p",
      }),
    );
  });
});

/** The live drive measured WebView2 firing `focusout` as a focused element
 *  leaves the DOM, which Base UI's dialog answers by re-focusing its popup a
 *  frame later; jsdom fires nothing, so this replays that event at removal. */
function fireFocusOutOnRemoval() {
  const remove = Node.prototype.removeChild;
  const removedFocused: Element[] = [];
  Node.prototype.removeChild = function <T extends Node>(this: Node, child: T) {
    const active = document.activeElement;
    if (active !== null && active !== document.body && child.contains(active)) {
      removedFocused.push(active);
      active.dispatchEvent(
        new FocusEvent("focusout", { bubbles: true, relatedTarget: null }),
      );
    }
    return remove.call(this, child) as T;
  };
  const restore = () => {
    Node.prototype.removeChild = remove;
  };
  return { restore, removedFocused };
}

/** Outlasts Base UI's restore frame, which runs after the picker's entry one. */
const frames = () =>
  new Promise<void>((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => r())),
  );

describe("focus across a removed control", () => {
  it("T56 a palette entry over a cold list lands in the search box although focus sat on the list's footer", async () => {
    const list = held<Submodule[]>();
    vi.mocked(gitSubmodules).mockReturnValue(list.promise);
    renderHarness("choose");
    const add = await screen.findByRole("button", { name: "Add submodule…" });
    act(() => add.focus());
    expect(document.activeElement).toBe(add);
    const focused: EventTarget[] = [];
    const onFocusIn = (e: FocusEvent) => {
      if (e.target !== null) focused.push(e.target);
    };
    document.addEventListener("focusin", onFocusIn);
    const { restore, removedFocused } = fireFocusOutOnRemoval();
    try {
      await act(async () => list.resolve([sub(SUB)]));
      await screen.findByRole("heading", { name: "Choose commit" });
      await waitFor(() => expect(focused).toContain(search()));
      await act(frames);
      await act(() => new Promise((r) => setTimeout(r, 50)));
      // The swap removed no focused element, and nothing takes focus back
      // once the search box has it.
      expect(removedFocused).toEqual([]);
      expect(focused.slice(focused.indexOf(search()))).toEqual([search()]);
      expect(document.activeElement).toBe(search());
    } finally {
      restore();
      document.removeEventListener("focusin", onFocusIn);
    }
  });

  it("T57 Fetch full history's success removes its notice and focus lands in the search box", async () => {
    vi.mocked(gitSubmoduleCommits).mockResolvedValue(
      page(DEFAULT_ROWS, { shallow: true }),
    );
    const { user } = await pickerWithRows();
    const full = screen.getByRole("button", { name: "Fetch full history" });
    vi.mocked(gitSubmoduleCommits).mockResolvedValue(page(DEFAULT_ROWS));
    const fetching = held<SubmoduleFetchResult>();
    vi.mocked(gitSubmoduleFetch).mockReturnValue(fetching.promise);
    const { restore } = fireFocusOutOnRemoval();
    try {
      await user.click(full);
      expect(document.activeElement).toBe(full);
      await act(async () => fetching.resolve({ shallow: false }));
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "Fetch full history" }),
        ).toBe(null),
      );
      await act(frames);
      expect(document.activeElement).toBe(search());
    } finally {
      restore();
    }
  });

  it("T58 a refs answer that removes the list empties the hidden live region, a pasted id's pinned row included", async () => {
    const note = `${SUB} doesn't have this commit yet. Fetch, then try again.`;
    for (const pasted of [false, true]) {
      planFor = (sha) =>
        readOf(sha, blocked("notFetched"), pasted ? { commit: null } : {});
      const { client, user } = await pickerWithRows();
      if (pasted) {
        await user.click(search());
        await user.paste(E);
        await waitFor(() => expect(row(E)).not.toBeNull());
      }
      await waitFor(() => expect(liveNote()).toContain(note));
      vi.mocked(gitSubmoduleRefs).mockResolvedValue(
        refsOf({ checkout: "replaced", branches: [], remoteBranches: [] }),
      );
      await act(() => client.invalidateQueries());
      await screen.findByText(REPLACED_COPY, {
        selector: "p",
      });
      expect(screen.queryByRole("button", { name: "Fetch" })).toBe(null);
      expect(liveNote(), `pasted=${pasted}`).toBe("");
      expect(screen.queryByText(note)).toBe(null);
      cleanup();
      vi.mocked(gitSubmoduleRefs).mockResolvedValue(refsOf());
    }
  });
});

const notInit = refsOf({
  checkout: "notInitialized",
  branches: [],
  remoteBranches: [],
});
const notInitCopy = `${SUB} isn't initialized. Initialize it from the list first.`;

/** Esc backs out of the picker, then closes the dialog. */
async function closeDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard("{Escape}");
  await screen.findByRole("heading", { name: "Submodules" });
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: "Submodules" })).toBe(null),
  );
}

/** Says the submodule isn't initialized: the not-usable box and the plan note. */
const notInitLead = `${SUB} isn't initialized`;

/** Moves every cached pick answer a minute into the past, so a fresh answer
 *  that resolves in the reopen's millisecond can't share a pre-open stamp.
 *  `setState` keeps a cached error, which `setQueryData` would clear. */
function agePickCache() {
  const cached =
    harnessClient
      ?.getQueryCache()
      .findAll({ queryKey: ["repo", REPO, "submodule-pick"] }) ?? [];
  for (const q of cached)
    if (q.state.dataUpdatedAt > 0)
      q.setState({ ...q.state, dataUpdatedAt: q.state.dataUpdatedAt - 60_000 });
}

/** Reopens the closed dialog's picker from the kebab with the refs re-read
 *  held, recording every node added, and every text changed in place, from
 *  then on that holds `needle`, so a one-commit flash counts too. `age`
 *  false keeps the cached stamps where they are. */
async function reopen(needle = notInitLead, age = true) {
  if (age) agePickCache();
  const reread = held<SubmoduleRefs>();
  vi.mocked(gitSubmoduleRefs).mockReturnValue(reread.promise);
  let copyAdded = false;
  const watch = new MutationObserver((records) => {
    for (const r of records) {
      if (
        r.type === "characterData" &&
        r.target.parentNode?.textContent?.includes(needle)
      )
        copyAdded = true;
      for (const n of r.addedNodes)
        if (n.textContent?.includes(needle)) copyAdded = true;
    }
  });
  watch.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  act(() => controls.setMode?.("list"));
  const user = await openPicker();
  return { user, reread, watch, copyAdded: () => copyAdded };
}

describe("a reopen over a cached unusable answer", () => {
  const bodyHost = () =>
    screen.getByText(notInitCopy, { selector: "p" }).closest("[tabindex]");

  /** Opens the picker over a not-initialized answer, closes the dialog with
   *  Esc twice, and reopens it from the kebab with the re-read held. */
  async function reopenOverCachedNotInit() {
    vi.mocked(gitSubmoduleRefs).mockResolvedValue(notInit);
    const client = renderHarness("list");
    const first = await openPicker();
    await screen.findByText(notInitCopy, { selector: "p" });
    await closeDialog(first);
    return { client, ...(await reopen()) };
  }

  /** Opens the picker over a fresh not-initialized answer that lands before
   *  the entry frame, so entry parks on the body. The frame waits for the
   *  answer: a slow runner can otherwise paint first. */
  async function parkedOnBody() {
    vi.mocked(gitSubmoduleRefs).mockResolvedValue(notInit);
    const client = renderHarness("list");
    const entry = holdEntryFrame();
    let user: ReturnType<typeof userEvent.setup>;
    try {
      user = await openPicker();
      await screen.findByText(notInitCopy, { selector: "p" });
      expect(entry.held).toHaveLength(1);
      act(() => entry.release());
    } finally {
      entry.restore();
    }
    await waitFor(() => expect(document.activeElement).toBe(bodyHost()));
    return { client, user };
  }

  it("T59 the re-read of a cached not-usable answer shows the loading frame, and its usable answer lands focus in the search box", async () => {
    const { reread, watch, copyAdded } = await reopenOverCachedNotInit();
    expect(copyAdded()).toBe(false);
    expect(screen.queryAllByText(notInitCopy)).toEqual([]);
    expect(search()).toBeInTheDocument();
    expect(
      screen.getByText("Loading commits…", { selector: '[role="status"]' }),
    ).toBeInTheDocument();
    await waitApplyReason("Loading commits…");
    await act(frames);
    expect(screen.queryAllByText(notInitCopy)).toEqual([]);
    expect(document.activeElement).toBe(search());
    await act(async () => reread.resolve(refsOf()));
    await waitFor(() => expect(row(P)).not.toBeNull());
    expect(screen.queryAllByText(notInitCopy)).toEqual([]);
    expect(copyAdded()).toBe(false);
    watch.disconnect();
    expect(document.activeElement).toBe(search());
  });

  it("T60 a re-read that is still not usable says so, and focus stays on the picker body", async () => {
    const { reread, watch } = await reopenOverCachedNotInit();
    watch.disconnect();
    await waitFor(() => expect(document.activeElement).toBe(search()));
    await act(async () => reread.resolve(notInit));
    await screen.findByText(notInitCopy, { selector: "p" });
    expect(screen.queryByRole("textbox", { name: "Search commits" })).toBe(
      null,
    );
    await waitFor(() => expect(document.activeElement).toBe(bodyHost()));
    await waitApplyReason(notInitCopy);
  });

  it("T95 a fresh answer stamped in the same millisecond as another key's cached answer is read here", async () => {
    vi.mocked(gitSubmoduleRefs).mockResolvedValue(notInit);
    const client = renderHarness("list");
    const first = await openPicker();
    await screen.findByText(notInitCopy, { selector: "p" });
    await closeDialog(first);
    // The refs answer's own stamp moves away; another key's cached answer
    // holds the stamp the fresh refs answer will carry.
    agePickCache();
    const stamp = Date.now();
    client.setQueryData(
      ["repo", REPO, "submodule-pick", SUB, "plan", A],
      readOf(A),
      { updatedAt: stamp },
    );
    const { reread, watch } = await reopen(notInitLead, false);
    watch.disconnect();
    const now = vi.spyOn(Date, "now").mockReturnValue(stamp);
    try {
      await act(async () => reread.resolve(notInit));
    } finally {
      now.mockRestore();
    }
    expect(
      client.getQueryState(["repo", REPO, "submodule-pick", SUB, "refs"])
        ?.dataUpdatedAt,
    ).toBe(stamp);
    await screen.findByText(notInitCopy, { selector: "p" });
    await waitApplyReason(notInitCopy);
  });

  it("T61 an entry parked on the body moves into the search box when it first mounts", async () => {
    const { client } = await parkedOnBody();
    vi.mocked(gitSubmoduleRefs).mockResolvedValue(refsOf());
    await act(() => client.invalidateQueries());
    await waitFor(() => expect(row(P)).not.toBeNull());
    expect(document.activeElement).toBe(search());
  });

  it("T62 a user who moved focus, or typed, while entry was parked keeps their focus", async () => {
    for (const gesture of ["move", "type"] as const) {
      const { client, user } = await parkedOnBody();
      const back = screen.getByRole("button", { name: "Back" });
      if (gesture === "move") act(() => back.focus());
      else await user.keyboard("x");
      const kept = document.activeElement;
      expect(kept, gesture).toBe(gesture === "move" ? back : bodyHost());
      vi.mocked(gitSubmoduleRefs).mockResolvedValue(refsOf());
      await act(() => client.invalidateQueries());
      await waitFor(() => expect(row(P)).not.toBeNull());
      await act(frames);
      expect(document.activeElement, gesture).toBe(kept);
      cleanup();
    }
  });

  it("T65 an entry parked on the body that fell to <body> still moves into the search box", async () => {
    const { client } = await parkedOnBody();
    act(() => (document.activeElement as HTMLElement).blur());
    expect(document.activeElement).toBe(document.body);
    vi.mocked(gitSubmoduleRefs).mockResolvedValue(refsOf());
    await act(() => client.invalidateQueries());
    await waitFor(() => expect(row(P)).not.toBeNull());
    expect(document.activeElement).toBe(search());
  });
});

describe("a failed re-read over a cached unusable answer", () => {
  const failedCopy = `Couldn't read ${SUB}'s branches and tags.`;
  const loadingStatus = () =>
    screen.queryByText("Loading commits…", { selector: '[role="status"]' });

  /** The picker over a cached not-initialized answer whose re-read failed. */
  async function failedOverCache() {
    vi.mocked(gitSubmoduleRefs).mockResolvedValue(notInit);
    renderHarness("list");
    const first = await openPicker();
    await screen.findByText(notInitCopy, { selector: "p" });
    await closeDialog(first);
    const opened = await reopen();
    await act(async () => opened.reread.reject({ kind: "io", message: "x" }));
    await screen.findByText(failedCopy);
    return opened;
  }

  it("T63 a failed re-read shows the failed state with Retry, never the cached copy, and Retry reads afresh", async () => {
    for (const answer of ["ok", "notInitialized"] as const) {
      const { user, watch, copyAdded } = await failedOverCache();
      expect(copyAdded(), answer).toBe(false);
      expect(screen.queryAllByText(notInitCopy)).toEqual([]);
      expect(loadingStatus()).toBe(null);
      const again = held<SubmoduleRefs>();
      vi.mocked(gitSubmoduleRefs).mockReturnValue(again.promise);
      await user.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(loadingStatus()).not.toBe(null));
      expect(screen.queryByText(failedCopy)).toBe(null);
      expect(screen.queryByRole("button", { name: "Retry" })).toBe(null);
      // The rescue lands the unmounted Retry's focus on the picker body.
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toContainElement(search());
      expect(copyAdded(), answer).toBe(false);
      watch.disconnect();
      await act(async () =>
        again.resolve(answer === "ok" ? refsOf() : notInit),
      );
      if (answer === "ok") {
        await waitFor(() => expect(row(P)).not.toBeNull());
        expect(document.activeElement).toContainElement(search());
      } else {
        await screen.findByText(notInitCopy, { selector: "p" });
        expect(document.activeElement).toHaveAttribute("tabindex", "-1");
      }
      expect(screen.queryByText(failedCopy)).toBe(null);
      cleanup();
    }
  });

  it("T64 a mount over a cached error on top of the not-usable answer shows the loading frame while its re-read runs", async () => {
    const { user, watch } = await failedOverCache();
    watch.disconnect();
    await closeDialog(user);
    const second = await reopen();
    expect(second.copyAdded()).toBe(false);
    expect(screen.queryByText(failedCopy)).toBe(null);
    expect(screen.queryByRole("button", { name: "Retry" })).toBe(null);
    expect(loadingStatus()).not.toBe(null);
    await waitApplyReason("Loading commits…");
    expect(screen.queryByText(failedCopy)).toBe(null);
    await act(async () => second.reread.resolve(refsOf()));
    await waitFor(() => expect(row(P)).not.toBeNull());
    expect(second.copyAdded()).toBe(false);
    second.watch.disconnect();
  });
});

describe("a reopen over verdicts cached before it", () => {
  const notInitPage = page([], { checkout: "notInitialized" });
  const readyNote = `Moves ${SUB} forward 1 commit.`;
  const loadingStatus = () =>
    screen.queryByText("Loading commits…", { selector: '[role="status"]' });
  const checkingLine = () =>
    screen.queryByText("Checking this commit…", { selector: "p" });
  const refsLanded = () => screen.findByText(/^Records /);
  const wait = (ms: number) =>
    act(() => new Promise<void>((r) => setTimeout(r, ms)));

  /** A Fetch while the checkout is broken caches a not-usable refs answer,
   *  commits page and plan for P; the dialog is closed and the picker reopened
   *  with all three re-reads held. */
  async function reopenOverThreeVerdicts() {
    vi.mocked(gitSubmoduleRefs).mockResolvedValue(refsOf());
    vi.mocked(gitSubmoduleCommits).mockResolvedValue(page(DEFAULT_ROWS));
    planFor = (sha) => readOf(sha);
    const client = renderHarness("list");
    const first = await openPicker();
    await waitFor(() => expect(liveNote()).toContain(readyNote));
    vi.mocked(gitSubmoduleRefs).mockResolvedValue(notInit);
    vi.mocked(gitSubmoduleCommits).mockResolvedValue(notInitPage);
    planFor = (sha) =>
      readOf(sha, blocked("notInitialized"), { sha: null, commit: null });
    await first.click(screen.getByRole("button", { name: "Fetch" }));
    await screen.findByText(notInitCopy, { selector: "p" });
    await waitFor(() => {
      const cached = client.getQueryData<{ pages: SubmoduleCommitPage[] }>([
        "repo",
        REPO,
        "submodule-pick",
        SUB,
        "commits",
        "refs/remotes/origin/main",
        null,
      ]);
      expect(cached?.pages[0]?.checkout).toBe("notInitialized");
      const plan = client.getQueryData<SubmodulePickRead>([
        "repo",
        REPO,
        "submodule-pick",
        SUB,
        "plan",
        P,
      ]);
      expect(plan?.plan).toEqual(blocked("notInitialized"));
    });
    await closeDialog(first);
    const commits = held<SubmoduleCommitPage>();
    vi.mocked(gitSubmoduleCommits).mockReturnValue(commits.promise);
    const plan = held<SubmodulePickRead>();
    planFor = () => plan.promise;
    vi.mocked(gitSubmoduleCommits).mockClear();
    vi.mocked(gitSubmodulePickPlan).mockClear();
    return { ...(await reopen()), commits, plan };
  }

  it("T66 a reopen after a Fetch cached three not-usable answers paints none of them", async () => {
    const { user, reread, commits, plan, watch, copyAdded } =
      await reopenOverThreeVerdicts();
    await act(async () => reread.resolve(refsOf()));
    await refsLanded();
    // a: the cached page reads as loading and the search box keeps its text.
    expect(copyAdded()).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(search()));
    await user.keyboard("ab");
    expect(search()).toHaveValue("ab");
    await wait(250);
    expect(loadingStatus()).not.toBe(null);
    await waitApplyReason("Loading commits…");
    expect(copyAdded()).toBe(false);
    // b: the rows land; the cached plan reads as checking and says nothing.
    await act(async () => commits.resolve(page(DEFAULT_ROWS)));
    await waitFor(() => expect(row(P)).not.toBeNull());
    await waitFor(() =>
      expect(gitSubmodulePickPlan).toHaveBeenCalledWith(REPO, SUB, P),
    );
    await wait(0);
    expect(checkingLine()).not.toBe(null);
    expect(liveNote()).not.toContain("isn't initialized");
    await waitApplyReason("Checking this commit…");
    expect(copyAdded()).toBe(false);
    expect(search()).toHaveValue("ab");
    // c: the fresh plan speaks.
    await act(async () => plan.resolve(readOf(P)));
    await waitFor(() => expect(liveNote()).toContain(readyNote));
    await waitApplyReady();
    expect(copyAdded()).toBe(false);
    watch.disconnect();
  });

  it("T66b over the cached page, a fresh not-usable answer still shows and a failed re-read shows its failure", async () => {
    for (const arm of ["fresh", "failed"] as const) {
      const { reread, commits, watch, copyAdded } =
        await reopenOverThreeVerdicts();
      await act(async () => reread.resolve(refsOf()));
      await refsLanded();
      await waitFor(() =>
        expect(gitSubmoduleCommits).toHaveBeenCalledWith(
          REPO,
          SUB,
          "refs/remotes/origin/main",
          0,
          50,
          null,
        ),
      );
      if (arm === "fresh") {
        watch.disconnect();
        await act(async () => commits.resolve(notInitPage));
        await screen.findByText(notInitCopy, { selector: "p" });
        await waitApplyReason(notInitCopy);
      } else {
        await act(async () => commits.reject({ kind: "io", message: "x" }));
        await screen.findByText("Couldn't load the commits on origin/main.");
        expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
        expect(loadingStatus()).toBe(null);
        await waitApplyReason("Commits couldn't be loaded");
        expect(copyAdded(), arm).toBe(false);
        watch.disconnect();
      }
      cleanup();
    }
  });

  it("T67 typing while the commits re-read runs never shows the cached page's verdict", async () => {
    const { user, reread, watch, copyAdded } = await reopenOverThreeVerdicts();
    await act(async () => reread.resolve(refsOf()));
    await refsLanded();
    await waitFor(() => expect(document.activeElement).toBe(search()));
    await user.keyboard("zz");
    // The new search's first read is held too: its placeholder is the cached
    // not-usable page.
    await waitFor(() =>
      expect(gitSubmoduleCommits).toHaveBeenCalledWith(
        REPO,
        SUB,
        "refs/remotes/origin/main",
        0,
        50,
        "zz",
      ),
    );
    await wait(0);
    expect(copyAdded()).toBe(false);
    expect(search()).toHaveValue("zz");
    expect(loadingStatus()).not.toBe(null);
    await waitApplyReason("Loading commits…");
    expect(copyAdded()).toBe(false);
    watch.disconnect();
  });

  it("T68 a would-overwrite note read before the reopen is neither shown nor announced, while rows paint at once", async () => {
    const lead = `${SUB} has local changes this commit would overwrite.`;
    planFor = (sha) => readOf(sha, blocked("wouldOverwrite", null, ["a.txt"]));
    const { user } = await pickerWithRows();
    await waitFor(() => expect(liveNote()).toContain(lead));
    await closeDialog(user);
    const plan = held<SubmodulePickRead>();
    planFor = () => plan.promise;
    vi.mocked(gitSubmodulePickPlan).mockClear();
    const { reread, watch, copyAdded } = await reopen(lead);
    // The cached rows paint with the picker, and entry lands in the search box.
    expect(row(P)).not.toBeNull();
    await act(frames);
    expect(document.activeElement).toBe(search());
    await act(async () => reread.resolve(refsOf()));
    await waitFor(() =>
      expect(gitSubmodulePickPlan).toHaveBeenCalledWith(REPO, SUB, P),
    );
    await wait(0);
    expect(checkingLine()).not.toBe(null);
    expect(liveNote()).not.toContain("local changes");
    await waitApplyReason("Checking this commit…");
    expect(copyAdded()).toBe(false);
    await act(async () => plan.resolve(readOf(P)));
    await waitFor(() => expect(liveNote()).toContain(readyNote));
    expect(copyAdded()).toBe(false);
    watch.disconnect();
  });

  it("T76 a reopen over a cached Load more page that found the checkout unusable shows the loading frame, then the list", async () => {
    const text = `${SUB} couldn't be read.`;
    vi.mocked(gitSubmoduleCommits).mockImplementation(
      async (_r, _p, _rev, skip) =>
        skip === 0
          ? page(DEFAULT_ROWS, { hasMore: true })
          : page([], { checkout: "unreadable", reason: "bad object HEAD" }),
    );
    const { user } = await pickerWithRows();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText(text, { selector: "p" });
    await closeDialog(user);
    const commits = held<SubmoduleCommitPage>();
    vi.mocked(gitSubmoduleCommits).mockImplementation((_r, _p, _rev, skip) =>
      skip === 0 ? commits.promise : Promise.resolve(page([])),
    );
    const second = await reopen(text);
    expect(second.copyAdded()).toBe(false);
    expect(screen.queryByText(text)).toBe(null);
    expect(loadingStatus()).not.toBe(null);
    await act(async () => second.reread.resolve(refsOf()));
    await refsLanded();
    await waitApplyReason("Loading commits…");
    expect(second.copyAdded()).toBe(false);
    await act(async () => commits.resolve(page(DEFAULT_ROWS)));
    await waitFor(() => expect(row(P)).not.toBeNull());
    expect(screen.queryByText(text)).toBe(null);
    expect(second.copyAdded()).toBe(false);
    second.watch.disconnect();
  });

  it("T69 a pasted id's lookup read before the reopen never shows its block", async () => {
    const lead = `${SUB} isn't initialized.`;
    const blockedRead = () =>
      readOf(C, blocked("notInitialized"), { sha: null, commit: null });
    planFor = (sha) => (sha === C ? blockedRead() : readOf(sha));
    const { user } = await pickerWithRows();
    await user.click(search());
    await user.paste(C);
    await waitApplyReason(lead);
    await closeDialog(user);
    const lookup = held<SubmodulePickRead>();
    planFor = (sha) => (sha === C ? lookup.promise : readOf(sha));
    vi.mocked(gitSubmodulePickPlan).mockClear();
    const second = await reopen(lead);
    await act(async () => second.reread.resolve(refsOf()));
    await second.user.click(search());
    await second.user.paste(C);
    await waitFor(() =>
      expect(gitSubmodulePickPlan).toHaveBeenCalledWith(REPO, SUB, C),
    );
    await wait(0);
    expect(screen.queryByText(lead)).toBe(null);
    expect(applyButton()).not.toHaveAccessibleDescription(lead);
    expect(second.copyAdded()).toBe(false);
    // A lookup answered in this open still says so.
    second.watch.disconnect();
    await act(async () => lookup.resolve(blockedRead()));
    await waitApplyReason(lead);
  });
});

describe("the held ref trigger", () => {
  it("T55 while a pick runs the ref trigger opens nothing, changes nothing, and its reason is the hover title across it", async () => {
    const pending = held<SubmodulePickOutcome>();
    vi.mocked(gitSubmoduleSetCommit).mockReturnValue(pending.promise);
    const { user } = await pickerWithRows();
    const trigger = screen.getByRole("combobox", { name: "Commits from" });
    const label = () =>
      trigger.querySelector<HTMLElement>("span.truncate") as HTMLElement;
    const clipped = (el: HTMLElement) => {
      Object.defineProperty(el, "scrollWidth", {
        configurable: true,
        value: 500,
      });
      Object.defineProperty(el, "clientWidth", {
        configurable: true,
        value: 50,
      });
    };
    // Unheld, a clipped label titles itself.
    clipped(label());
    await user.hover(label());
    expect(label()).toHaveAttribute("title", "origin/main");

    await waitApplyReady();
    await user.click(applyButton());
    await waitApplyReason("Checking out and staging…");
    expect(trigger).toHaveAttribute("aria-disabled", "true");
    expect(trigger).toHaveAccessibleDescription("Checking out and staging…");
    expect(trigger).toHaveAttribute("title", "Checking out and staging…");
    clipped(label());
    await user.hover(label());
    expect(label()).not.toHaveAttribute("title");

    vi.mocked(gitSubmoduleCommits).mockClear();
    const popup = () =>
      screen.queryByRole("listbox", { name: "Branches and tags" });
    await user.click(trigger);
    expect(popup(), "click").toBe(null);
    // The letter first: a key typed into a running typeahead would join it.
    for (const key of ["m", "{Enter}", " ", "{ArrowDown}"]) {
      act(() => trigger.focus());
      await user.keyboard(key);
      await act(async () => undefined);
      expect(popup(), key).toBe(null);
      expect(trigger, key).toHaveAttribute("aria-expanded", "false");
      expect(trigger, key).toHaveTextContent("origin/main");
    }
    expect(gitSubmoduleCommits).not.toHaveBeenCalled();

    // Settled, the same gestures work: the typeahead letter switches the ref.
    await act(async () => pending.resolve({ kind: "changed" }));
    await waitFor(() =>
      expect(trigger).not.toHaveAttribute("aria-disabled", "true"),
    );
    // The trigger's typeahead string resets 750 ms after its last key (Base UI
    // 1.9's useTypeahead `resetMs`); before that this "m" would join it.
    await new Promise((r) => setTimeout(r, 800));
    act(() => trigger.focus());
    await user.keyboard("m");
    await waitFor(() => expect(trigger).toHaveTextContent(/^main/));
  });
});

describe("invalidation", () => {
  const LOCAL_KEYS = [
    ["repo", REPO, "status"],
    ["repo", "C:/r/vendor/sub", "log"],
    ["repo", "c:\\R\\vendor\\sub\\", "branches"],
  ] as const;
  const UNTOUCHED_KEYS = [
    ["repo", "C:/r/vendor/sub2", "log"],
    // Networked, under the PARENT's root.
    ["repo", REPO, "prs"],
    // Networked, under the SUBMODULE's root: only the filter's localness test
    // leaves it alone.
    ["repo", "C:\\r\\vendor\\sub", "prs"],
  ] as const;

  async function seed(client: QueryClient) {
    for (const key of LOCAL_KEYS)
      await client.fetchQuery({
        queryKey: key,
        queryFn: async () => 1,
        networkMode: "always",
      });
    for (const key of UNTOUCHED_KEYS)
      await client.fetchQuery({
        queryKey: key,
        queryFn: async () => 1,
        ...(key[2] === "prs" ? {} : { networkMode: "always" as const }),
      });
  }

  function expectInvalidated(client: QueryClient) {
    for (const key of LOCAL_KEYS)
      expect(client.getQueryState(key)?.isInvalidated, key.join(" ")).toBe(
        true,
      );
    for (const key of UNTOUCHED_KEYS)
      expect(client.getQueryState(key)?.isInvalidated, key.join(" ")).toBe(
        false,
      );
  }

  it("T26 a pick invalidates the parent's local reads and the submodule's own local reads under another spelling, and no sibling's or networked read", async () => {
    const { client, user } = await pickerWithRows();
    await act(() => seed(client));
    await waitApplyReady();
    await user.click(applyButton());
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expectInvalidated(client);
  });

  it("T27 a fetch invalidates the same sets", async () => {
    const { client, user } = await pickerWithRows();
    await act(() => seed(client));
    await user.click(screen.getByRole("button", { name: "Fetch" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expectInvalidated(client);
  });
});

describe("the list re-reads on every open", () => {
  /** Renders the closed dialog over a list cached a few seconds ago (inside
   *  its staleTime), with the open's re-read held. */
  function overCachedList(cached: Submodule[]) {
    const client = renderHarness(null);
    client.setQueryData(["repo", REPO, "submodules"], cached, {
      updatedAt: Date.now() - 5_000,
    });
    const reread = held<Submodule[]>();
    vi.mocked(gitSubmodules).mockReturnValue(reread.promise);
    return { client, reread };
  }

  it("L1 a submodule repaired outside the app shows initialized on the next open, and its Choose commit is enabled", async () => {
    const { reread } = overCachedList([sub(SUB, "uninitialized")]);
    act(() => controls.setMode?.("list"));
    // The cached row paints while the re-read runs.
    expect(await screen.findByText("Not initialized")).toBeInTheDocument();
    expect(gitSubmodules).toHaveBeenCalledTimes(1);
    await act(async () => reread.resolve([sub(SUB)]));
    await waitFor(() =>
      expect(screen.queryByText("Not initialized")).toBe(null),
    );
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: `Actions for ${SUB}` }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Choose commit…" }),
    ).not.toHaveAttribute("aria-disabled", "true");
  });

  it("L2 a palette entry over a cached list naming no initialized submodule waits for the re-read, which opens the picker", async () => {
    const { reread } = overCachedList([sub(SUB, "uninitialized")]);
    act(() => controls.setMode?.("choose"));
    expect(
      screen.getByRole("heading", { name: "Submodules" }),
    ).toBeInTheDocument();
    await act(async () => reread.resolve([sub(SUB)]));
    expect(
      await screen.findByRole("heading", { name: "Choose commit" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(gitSubmoduleRefs).toHaveBeenCalledWith(REPO, SUB),
    );
  });

  it("L3 a palette entry over a cached list naming exactly one initialized submodule paints the picker with no frame of list rows", async () => {
    const { reread } = overCachedList([sub(SUB), sub(SUB2, "uninitialized")]);
    // A synchronous act flushes the commit and its layout effects, as the
    // browser does before it paints.
    act(() => controls.setMode?.("choose"));
    expect(
      screen.getByRole("heading", { name: "Choose commit" }),
    ).toBeInTheDocument();
    expect(document.querySelector("[data-sub-row]")).toBe(null);
    await act(async () => reread.resolve([sub(SUB), sub(SUB2)]));
    await waitFor(() =>
      expect(gitSubmoduleRefs).toHaveBeenCalledWith(REPO, SUB),
    );
    expect(
      screen.getByRole("heading", { name: "Choose commit" }),
    ).toBeInTheDocument();
  });

  it("L4 a failed re-read over a cached list resolves from the cached rows and shows them under the refresh notice", async () => {
    const { reread } = overCachedList([sub(SUB), sub(SUB2)]);
    act(() => controls.setMode?.("choose"));
    await act(async () => reread.reject({ kind: "io", message: "x" }));
    expect(
      await screen.findByText(
        "Couldn't refresh submodules — showing the last loaded results.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `Actions for ${SUB}` }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `Actions for ${SUB2}` }),
    ).toBeInTheDocument();
    // Resolved and latched: a later answer naming one initialized submodule
    // leaves the list where it is.
    vi.mocked(gitSubmodules).mockResolvedValue([sub(SUB)]);
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Retry loading submodules" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: `Actions for ${SUB2}` }),
      ).toBe(null),
    );
    expect(screen.queryByRole("heading", { name: "Choose commit" })).toBe(null);
    expect(gitSubmoduleRefs).not.toHaveBeenCalled();
  });

  it("L5 a press or key in the list while a palette entry waits keeps the list, so a late answer never closes the menu it opened", async () => {
    for (const gesture of ["press", "key"] as const) {
      const { reread } = overCachedList([sub(SUB, "uninitialized")]);
      act(() => controls.setMode?.("choose"));
      const kebab = await screen.findByRole("button", {
        name: `Actions for ${SUB}`,
      });
      const user = userEvent.setup();
      if (gesture === "press") await user.click(kebab);
      else {
        act(() => kebab.focus());
        await user.keyboard("{Enter}");
      }
      expect(
        await screen.findByRole("menuitem", { name: /^Choose commit…/ }),
        gesture,
      ).toBeInTheDocument();
      // The re-read now names exactly one initialized submodule.
      await act(async () => reread.resolve([sub(SUB)]));
      await act(() => new Promise((r) => setTimeout(r, 0)));
      expect(
        screen.getByRole("menuitem", { name: /^Choose commit…/ }),
        gesture,
      ).toBeInTheDocument();
      // An open menu may hide the rest of the dialog from the role queries.
      expect(
        screen.getByRole("heading", { name: "Submodules", hidden: true }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "Choose commit", hidden: true }),
      ).toBe(null);
      expect(gitSubmoduleRefs).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("L6 a failed re-read over a cached empty list shows the failure, never that there are no submodules", async () => {
    const { reread } = overCachedList([]);
    act(() => controls.setMode?.("list"));
    await act(async () => reread.reject({ kind: "io", message: "x" }));
    expect(
      await screen.findByText("Couldn't read this repository's submodules."),
    ).toBeInTheDocument();
    expect(screen.queryByText("This repository has no submodules.")).toBe(null);
    expect(
      screen.queryByText(
        "Couldn't refresh submodules — showing the last loaded results.",
      ),
    ).toBe(null);
    expect(
      screen.getByRole("button", { name: "Update all" }),
    ).toHaveAccessibleDescription("Submodules couldn't be read");
  });
});

const UNREADABLE_WHY = "not a git repository: vendor/sub/../.git/modules/sub";

describe("removing", () => {
  const removed = (
    over: Partial<SubmoduleRemoveOutcome> = {},
  ): SubmoduleRemoveOutcome => ({
    refusedDirty: false,
    refusedUnreadable: null,
    moduleDataDeleted: false,
    moduleDataError: null,
    ...over,
  });

  /** Opens Remove from the row's kebab, confirms the first prompt, and waits
   *  for the escalation prompt the refusal raises. */
  async function refusedAsUnreadable(list?: Submodule[]) {
    useConfirm.setState({ request: null, requestHold: null });
    if (list !== undefined) vi.mocked(gitSubmodules).mockResolvedValue(list);
    // A once-answer an earlier test left unread would answer this one first.
    vi.mocked(gitSubmoduleRemove)
      .mockReset()
      .mockResolvedValueOnce(
        removed({
          refusedUnreadable:
            "its .git names this repository's own git directory.",
        }),
      )
      .mockResolvedValueOnce(removed());
    renderHarness();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: `Actions for ${SUB}` }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Remove…" }));
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
    act(() => useConfirm.getState().answer(true, false));
    await waitFor(() =>
      expect(useConfirm.getState().request?.confirmLabel).toBe("Remove anyway"),
    );
    expect(gitSubmoduleRemove).toHaveBeenCalledTimes(1);
    expect(gitSubmoduleRemove).toHaveBeenLastCalledWith(
      REPO,
      SUB,
      false,
      false,
    );
  }

  it("R1 a submodule git can't read asks to remove it anyway, naming why", async () => {
    await refusedAsUnreadable();
    const request = useConfirm.getState().request;
    expect(request?.title).toBe(`Remove ${SUB}?`);
    expect(request?.body).toBe(
      `Git couldn't read ${SUB}: its .git names this repository's own git directory. Its local changes can't be checked, and removing it deletes everything in its folder.`,
    );
    expect(request?.confirmVariant).toBe("destructive");
  });

  it("R2 cancelling the unreadable prompt sends nothing more", async () => {
    await refusedAsUnreadable();
    act(() => useConfirm.getState().answer(false));
    await waitFor(() => expect(useConfirm.getState().request).toBeNull());
    await act(() => Promise.resolve());
    expect(gitSubmoduleRemove).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("R3 Remove anyway retries with force", async () => {
    await refusedAsUnreadable();
    act(() => useConfirm.getState().answer(true));
    await waitFor(() => expect(gitSubmoduleRemove).toHaveBeenCalledTimes(2));
    expect(gitSubmoduleRemove).toHaveBeenLastCalledWith(REPO, SUB, true, false);
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Submodule removed — staged for you to commit.",
      ),
    );
  });

  it("R4 an Unreadable row's Remove… reaches the same prompt and its forced retry", async () => {
    await refusedAsUnreadable([sub(SUB, "unreadable", UNREADABLE_WHY)]);
    act(() => useConfirm.getState().answer(true));
    await waitFor(() => expect(gitSubmoduleRemove).toHaveBeenCalledTimes(2));
    expect(gitSubmoduleRemove).toHaveBeenLastCalledWith(REPO, SUB, true, false);
  });
});

describe("a submodule git can't read", () => {
  it("U1 its row reads Unreadable with git's reason, and neither Update nor the row's own press sends anything", async () => {
    vi.mocked(gitSubmodules).mockResolvedValue([
      sub(SUB, "unreadable", UNREADABLE_WHY),
    ]);
    renderHarness();
    const option = await screen.findByRole("option", { name: /vendor/ });
    expect(within(option).getByText("Unreadable")).toBeInTheDocument();
    expect(option).toHaveTextContent(
      `bbbbbbb · Git can't read it: ${UNREADABLE_WHY}`,
    );
    expect(option).toHaveAttribute("title", "Git can't read this submodule");
    expect(option).toHaveAttribute("aria-disabled", "true");
    const update = screen.getByRole("button", { name: "Update" });
    expect(update).toHaveAttribute("aria-disabled", "true");
    expect(update).toHaveAccessibleDescription("Git can't read this submodule");
    fireEvent.click(option);
    fireEvent.click(update);
    await act(async () => undefined);
    expect(gitSubmoduleUpdate).not.toHaveBeenCalled();
  });

  it("U2 its menu holds every action that runs git inside it, with the reason on the label, and keeps the rest", async () => {
    vi.mocked(gitSubmodules).mockResolvedValue([
      sub(SUB, "unreadable", UNREADABLE_WHY),
    ]);
    renderHarness();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: `Actions for ${SUB}` }),
    );
    for (const label of [
      "Update to latest",
      "Choose commit…",
      "Open as repository",
    ])
      expect(
        await screen.findByRole("menuitem", {
          name: `${label} (git can't read this submodule)`,
        }),
        label,
      ).toHaveAttribute("aria-disabled", "true");
    for (const label of ["Edit URL…", "Set branch…", "Remove…"])
      expect(
        screen.getByRole("menuitem", { name: label }),
        label,
      ).not.toHaveAttribute("aria-disabled", "true");
  });

  it("U3 a readable row beside it keeps Update", async () => {
    vi.mocked(gitSubmodules).mockResolvedValue([
      sub(SUB, "unreadable", UNREADABLE_WHY),
      sub(SUB2),
    ]);
    vi.mocked(gitSubmoduleUpdate).mockResolvedValue(undefined as never);
    renderHarness();
    const readable = await screen.findByRole("option", { name: /libs/ });
    expect(readable).not.toHaveAttribute("aria-disabled");
    fireEvent.click(readable);
    await waitFor(() =>
      expect(gitSubmoduleUpdate).toHaveBeenCalledWith(REPO, SUB2, false),
    );
  });

  it("U4 the palette entry counts only submodules git can read", async () => {
    vi.mocked(gitSubmodules).mockResolvedValue([
      sub(SUB2, "unreadable", UNREADABLE_WHY),
      sub(SUB),
    ]);
    renderHarness("choose");
    expect(
      await screen.findByRole("heading", { name: "Choose commit" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(gitSubmoduleRefs).toHaveBeenCalledWith(REPO, SUB),
    );
    expect(gitSubmoduleRefs).not.toHaveBeenCalledWith(REPO, SUB2);
  });
});
