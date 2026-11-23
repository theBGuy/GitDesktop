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
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SubmodulesDialog } from "@/features/repository/SubmodulesDialog";
import {
  gitSubmoduleCommits,
  gitSubmoduleFetch,
  gitSubmodulePickPlan,
  gitSubmoduleRefs,
  gitSubmoduleSetCommit,
  gitSubmodules,
} from "@/lib/git/api";
import type {
  Submodule,
  SubmoduleCommitPage,
  SubmodulePickBlock,
  SubmodulePickOutcome,
  SubmodulePickPlan,
  SubmodulePickRead,
  SubmoduleRefCommit,
  SubmoduleRefs,
} from "@/lib/git/types";
import { OFFLINE_WRITE_REASON } from "@/lib/offline-writes";
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

const sub = (path: string, status = "ok"): Submodule => ({
  path,
  name: path,
  url: "https://example.invalid/x.git",
  branch: null,
  sha: P,
  describe: "v1",
  status,
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
  ...over,
});

const DEFAULT_ROWS = [
  commit(A, "Add feature"),
  commit(P, "Recorded one"),
  commit(C, "Older change"),
];

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
  vi.mocked(gitSubmoduleFetch).mockResolvedValue(undefined);
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
      ["replaced", `A file sits where ${SUB} should be.`, null],
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
        await screen.findByText((t) => t.startsWith(line)),
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
    ][] = [
      // The plan read names only the first path git would overwrite (or the
      // ignored ones), so its list never reads as complete.
      [
        blocked("wouldOverwrite", null, paths(1)),
        `${SUB} has local changes this commit would overwrite.`,
        ["src/file0.ts", "and possibly others"],
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
    for (const [plan, lead, extra, over] of cases) {
      await replan(client, (sha) => readOf(sha, plan, over));
      await waitApplyReason(lead);
      expect(liveNote()).toContain(lead);
      for (const x of extra) expect(liveNote(), x).toContain(x);
    }
    expect(liveNote()).not.toContain("and 13 more");
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
    expect(liveNote()).not.toContain("Not on any remote");
    await user.click(row(A) as HTMLElement);
    await waitFor(() =>
      expect(liveNote()).toContain(
        "Not on any remote branch or tag as of the last fetch.",
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

  it("T21 each setter outcome reports itself", async () => {
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
              description: `Its own submodules still point at their old commits; ${SUB}'s Update in this list moves them.`,
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
            `${SUB} points at bbbbbbb.`,
            undefined,
          ),
        leaves: true,
      },
      {
        outcome: { kind: "changed" },
        check: () =>
          expect(toast.info).toHaveBeenCalledWith(
            `${SUB}'s recorded commit changed. Review the list and try again.`,
            { description: "bbbbbbb wasn't checked out." },
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
            `Its recorded commit changed while the checkout ran. Stage ${SUB} in Changes to finish.`,
          ],
          ["stageFailed", `Stage ${SUB} in Changes to finish. index.lock`],
          [
            "stageUnconfirmed",
            `Staging timed out, so it may or may not have landed. Check ${SUB} in Changes and stage it there if it isn't.`,
          ],
        ] as const
      ).map(
        ([why, description]): Case => ({
          outcome: {
            kind: "checkedOutNotStaged",
            sha: P,
            why,
            reason: why === "stageFailed" ? "index.lock" : null,
          },
          check: () =>
            expect(toast.warning).toHaveBeenCalledWith(
              `${SUB} is checked out at bbbbbbb, but the new commit isn't staged.`,
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

  it("T42 Apply stays available while a fetch runs", async () => {
    const fetching = held<void>();
    vi.mocked(gitSubmoduleFetch).mockReturnValue(fetching.promise);
    const { user } = await pickerWithRows();
    await waitApplyReady();
    await user.click(screen.getByRole("button", { name: "Fetch" }));
    expect(
      screen.getByRole("button", { name: /Fetch$/ }),
    ).toHaveAccessibleDescription("Fetching…");
    await waitApplyReady();
    await user.click(applyButton());
    expect(gitSubmoduleSetCommit).toHaveBeenCalledTimes(1);
    await act(async () => fetching.resolve());
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
    const refsHeld = held<SubmoduleRefs>();
    vi.mocked(gitSubmoduleRefs).mockReturnValue(refsHeld.promise);
    await user.click(await screen.findByRole("button", { name: "Retry" }));
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
    const commitsHeld = held<SubmoduleCommitPage>();
    vi.mocked(gitSubmoduleCommits).mockReturnValue(commitsHeld.promise);
    await user.click(await screen.findByRole("button", { name: "Retry" }));
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
    await screen.findByText(`A file sits where ${SUB} should be.`, {
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
      screen.getByText(`A file sits where ${SUB} should be.`, {
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
    const fetching = held<void>();
    vi.mocked(gitSubmoduleFetch).mockReturnValue(fetching.promise);
    const { restore } = fireFocusOutOnRemoval();
    try {
      await user.click(full);
      expect(document.activeElement).toBe(full);
      await act(async () => fetching.resolve());
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
      await screen.findByText(`A file sits where ${SUB} should be.`, {
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
 *  then on that holds `needle`, so a one-commit flash counts too. */
async function reopen(needle = notInitLead) {
  agePickCache();
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
   *  the entry frame, so entry parks on the body. */
  async function parkedOnBody() {
    vi.mocked(gitSubmoduleRefs).mockResolvedValue(notInit);
    const client = renderHarness("list");
    const user = await openPicker();
    await screen.findByText(notInitCopy, { selector: "p" });
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
});
