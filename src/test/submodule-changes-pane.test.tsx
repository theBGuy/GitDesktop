import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DiffViewer } from "@/features/diff/DiffViewer";
import { SubmoduleChangesPane } from "@/features/repository/SubmoduleChangesPane";
import {
  gitBlobSizes,
  gitDiffFile,
  gitStatus,
  gitSubmoduleChanges,
} from "@/lib/git/api";
import { repoKeys } from "@/lib/git/queries";
import type {
  FileEntry,
  RepoStatus,
  SubmoduleChanges,
  SubmoduleCommit,
} from "@/lib/git/types";
import { dispatchAction } from "@/lib/hotkeys/handler-registry";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { stubCanvas } from "./canvas-stub";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitStatus: vi.fn(),
  gitDiffFile: vi.fn(),
  gitBlobSizes: vi.fn(),
  gitSubmoduleChanges: vi.fn(),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/hotkeys/handler-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hotkeys/handler-registry")>()),
  dispatchAction: vi.fn(),
}));
const { openSub } = vi.hoisted(() => ({
  openSub: vi.fn(async (_subPath: string) => true),
}));
vi.mock("@/features/repository/useOpenSubmoduleAsRepo", () => ({
  useOpenSubmoduleAsRepo: () => openSub,
}));

beforeAll(stubCanvas);
afterAll(() => {
  expect(unmockedCommands).toEqual([]);
});

const A = `aaaaaaa${"1".repeat(33)}`;
const B = `bbbbbbb${"2".repeat(33)}`;
const PATH = "vendor/sub";

const commits = (n: number, tag: string): SubmoduleCommit[] =>
  Array.from({ length: n }, (_, i) => ({
    sha: `${String(i).padStart(7, "0")}${tag.repeat(33)}`,
    subject: `${tag} subject ${i}`,
  }));
const inner = (n: number, unstaged: FileEntry["unstaged"]): FileEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    path: `f${i}.txt`,
    staged: null,
    unstaged,
  }));

/** An `ok` unstaged read on branch main whose pair is equal: nothing to say. */
function payload(over: Partial<SubmoduleChanges> = {}): SubmoduleChanges {
  return {
    path: PATH,
    staged: false,
    checkout: "ok",
    reason: null,
    branch: "main",
    detached: false,
    head: B,
    fromSha: B,
    toSha: B,
    rangeKnown: true,
    ahead: [],
    aheadCount: 0,
    behind: [],
    behindCount: 0,
    files: [],
    filesTotal: 0,
    ...over,
  };
}

function client() {
  const c = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  c.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
  return c;
}

function renderPane(
  data: SubmoduleChanges | Error,
  staged = data instanceof Error ? false : data.staged,
  origPath?: string,
) {
  if (data instanceof Error)
    vi.mocked(gitSubmoduleChanges).mockRejectedValue(data);
  else vi.mocked(gitSubmoduleChanges).mockResolvedValue(data);
  const c = client();
  render(
    <QueryClientProvider client={c}>
      <SubmoduleChangesPane
        repoPath="/repo"
        path={PATH}
        staged={staged}
        origPath={origPath}
      />
    </QueryClientProvider>,
  );
  return c;
}

const NO_CHECKOUT_SENTENCE =
  "This submodule has no checkout on disk. Initialize it from Submodules in the repository menu.";
const STAGE_LINE =
  /^(The next commit|Stage this row|Staging this row|Nothing to stage)/;
/** Every line of the stage note: its first sentence matches STAGE_LINE and
 *  the rest render as sibling `<p>`s in the same group, one per sentence. */
const stageLines = () =>
  screen
    .queryAllByText(STAGE_LINE)
    .flatMap((el) =>
      Array.from(el.parentElement?.children ?? [], (p) => p.textContent ?? ""),
    );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(gitBlobSizes).mockResolvedValue({ oldSize: null, newSize: 7 });
});

describe("SubmoduleChangesPane states (criterion 11)", () => {
  it("loading: a named skeleton under the header", async () => {
    vi.mocked(gitSubmoduleChanges).mockReturnValue(
      new Promise(() => undefined),
    );
    render(
      <QueryClientProvider client={client()}>
        <SubmoduleChangesPane repoPath="/repo" path={PATH} staged={false} />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Loading submodule changes…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open submodule" })).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Submodule changes" }),
    ).toBeTruthy();
  });

  it("a rejected read with nothing loaded says so, and Retry refetches", async () => {
    renderPane(new Error("boom"));
    expect(
      await screen.findByText("Couldn't read this submodule."),
    ).toBeTruthy();
    vi.mocked(gitSubmoduleChanges).mockResolvedValue(payload());
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByText("No changes in this submodule right now."),
    ).toBeTruthy();
    expect(gitSubmoduleChanges).toHaveBeenCalledTimes(2);
  });

  it("unreadable: the reason, a Retry that refetches and keeps focus off the body", async () => {
    renderPane(
      payload({
        checkout: "unreadable",
        reason: "fatal: not a git repository: ../.git/modules/sub",
        branch: null,
        head: null,
        toSha: null,
      }),
    );
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(
      screen.getByText(
        "Couldn't read this submodule: fatal: not a git repository: ../.git/modules/sub",
      ),
    ).toBeTruthy();
    expect(stageLines()).toEqual([]);
    vi.mocked(gitSubmoduleChanges).mockResolvedValue(payload());
    retry.focus();
    await userEvent.setup().keyboard("{Enter}");
    const settled = await screen.findByText(
      "No changes in this submodule right now.",
    );
    expect(gitSubmoduleChanges).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    // The child body's root (the settled line's parent, inside the scroller),
    // never the outer host that wraps the scroller.
    const body = settled.parentElement as HTMLElement;
    expect(body.getAttribute("tabindex")).toBe("-1");
    expect(
      body.closest('section[aria-label="Submodule changes"]'),
    ).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(body));
  });

  it("section headings are h3s that name their lists", async () => {
    renderPane(
      payload({
        files: [{ path: "x.txt", staged: null, unstaged: "untracked" }],
        filesTotal: 1,
      }),
    );
    const heading = await screen.findByRole("heading", {
      level: 3,
      name: "Untracked files inside",
    });
    expect(screen.queryAllByRole("heading", { level: 4 })).toEqual([]);
    const list = screen.getByRole("list", { name: "Untracked files inside" });
    expect(list.getAttribute("aria-labelledby")).toBe(heading.id);
  });

  it("notInitialized and missing: badge, sentence, Open Submodules, Open submodule held", async () => {
    for (const [checkout, badge] of [
      ["notInitialized", "Not initialized"],
      ["missing", "Folder missing"],
    ] as const) {
      renderPane(payload({ checkout, branch: null, head: null, toSha: null }));
      expect(await screen.findByText(badge), checkout).toBeTruthy();
      expect(screen.getByText(NO_CHECKOUT_SENTENCE)).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Open submodule" }),
      ).toHaveAccessibleDescription("This submodule has no checkout on disk");
      expect(stageLines(), checkout).toEqual([]);
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Open Submodules" }));
      expect(dispatchAction).toHaveBeenLastCalledWith("submodules");
      cleanup();
    }
  });

  it("row 7b: a staged pointer with no checkout shows the sentence, the pair and the stage line", async () => {
    renderPane(
      payload({
        staged: true,
        checkout: "notInitialized",
        branch: null,
        head: null,
        fromSha: A,
        toSha: B,
        rangeKnown: false,
      }),
    );
    expect(await screen.findByText(NO_CHECKOUT_SENTENCE)).toBeTruthy();
    expect(screen.getByText("Commit changed · aaaaaaa → bbbbbbb")).toBeTruthy();
    expect(
      screen.getByText(
        "The commits between these two can't be listed without a checkout of the submodule.",
      ),
    ).toBeTruthy();
    expect(stageLines()).toEqual([
      "The next commit records this submodule at bbbbbbb.",
    ]);
  });

  it("row 8: a staged removal shows only its heading and stage line", async () => {
    renderPane(
      payload({
        staged: true,
        checkout: "missing",
        branch: null,
        head: null,
        fromSha: A,
        toSha: null,
      }),
    );
    expect(await screen.findByText("Folder missing")).toBeTruthy();
    expect(screen.getByText("Submodule removed · was aaaaaaa")).toBeTruthy();
    expect(stageLines()).toEqual(["The next commit removes this submodule."]);
    expect(screen.queryByText(/Initialize it/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Open Submodules" }),
    ).toBeNull();
  });

  it("replaced: its badge and sentence, no Open Submodules, stage line 4", async () => {
    renderPane(
      payload({ checkout: "replaced", branch: null, head: null, toSha: null }),
    );
    expect(await screen.findByText("Replaced by a file")).toBeTruthy();
    expect(
      screen.getByText(
        "A file now sits where this submodule's folder was, so it has no checkout on disk.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Open Submodules" }),
    ).toBeNull();
    expect(stageLines()).toEqual([
      "Stage this row to record the file in place of the submodule.",
    ]);
  });

  it("ok: the HEAD badge reads the branch, the detached commit, or no commits", async () => {
    for (const [over, badge] of [
      [{}, "on main"],
      [{ branch: null, detached: true }, "Detached at bbbbbbb"],
      [{ head: null, toSha: null }, "No commits yet"],
    ] as const) {
      renderPane(payload(over));
      expect(await screen.findByText(badge)).toBeTruthy();
      cleanup();
    }
  });
});

describe("SubmoduleChangesPane sections and stage lines", () => {
  it("lists new commits with overflow, and the 'forward' line", async () => {
    renderPane(
      payload({
        fromSha: A,
        ahead: commits(50, "c"),
        aheadCount: 73,
      }),
    );
    expect(
      await screen.findByText("New commits · aaaaaaa → bbbbbbb"),
    ).toBeTruthy();
    expect(screen.getByText("c subject 0")).toBeTruthy();
    expect(screen.getByText("and 23 more")).toBeTruthy();
    expect(stageLines()).toEqual([
      "Stage this row to move this repository's record forward to bbbbbbb.",
    ]);
  });

  it("a rewound pointer lists the commits no longer included, and the 'back' line", async () => {
    renderPane(
      payload({ fromSha: A, behind: commits(2, "d"), behindCount: 2 }),
    );
    expect(
      await screen.findByText("Commits no longer included · aaaaaaa → bbbbbbb"),
    ).toBeTruthy();
    expect(screen.getByText("d subject 1")).toBeTruthy();
    expect(stageLines()).toEqual([
      "Stage this row to move this repository's record back to bbbbbbb.",
    ]);
  });

  it("diverged or unknown ranges record the target commit", async () => {
    for (const over of [
      {
        ahead: commits(1, "e"),
        aheadCount: 1,
        behind: commits(1, "f"),
        behindCount: 1,
      },
      { rangeKnown: false },
    ]) {
      renderPane(payload({ fromSha: A, ...over }));
      await screen.findAllByText(/aaaaaaa → bbbbbbb/);
      expect(stageLines()).toEqual([
        "Stage this row to record bbbbbbb for this submodule.",
      ]);
      cleanup();
    }
    renderPane(payload({ fromSha: A, rangeKnown: false }));
    expect(
      await screen.findByText(
        "The commits between these two can't be listed from this checkout.",
      ),
    ).toBeTruthy();
  });

  it("untracked-only files: heading, letters, overflow, and line 8", async () => {
    renderPane(payload({ files: inner(100, "untracked"), filesTotal: 240 }));
    expect(await screen.findByText("Untracked files inside")).toBeTruthy();
    expect(screen.getByText("and 140 more")).toBeTruthy();
    expect(stageLines()).toEqual([
      "Nothing to stage here yet: the submodule still points at the same commit.",
      "Open it to commit these files.",
    ]);
  });

  it("mixed files say uncommitted changes, and tag a nested submodule", async () => {
    renderPane(
      payload({
        files: [
          { path: "a.txt", staged: null, unstaged: "modified" },
          {
            path: "deep/leaf",
            staged: null,
            unstaged: "modified",
            submodule: {
              commitChanged: true,
              trackedModified: false,
              untracked: false,
              worktreeIsGitlink: true,
            },
          },
        ],
        filesTotal: 2,
      }),
    );
    expect(await screen.findByText("Uncommitted changes inside")).toBeTruthy();
    expect(screen.getByText("Submodule")).toBeTruthy();
  });

  it("one path listed twice (a staged deletion and an untracked file) keeps both rows", async () => {
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      renderPane(
        payload({
          files: [
            { path: "f.txt", staged: "deleted", unstaged: null },
            { path: "f.txt", staged: null, unstaged: "untracked" },
          ],
          filesTotal: 2,
        }),
      );
      expect(
        await screen.findByText("Uncommitted changes inside"),
      ).toBeTruthy();
      expect(screen.getAllByText("f.txt")).toHaveLength(2);
      const keyWarnings = errors.mock.calls.filter((args) =>
        args.some((a) => String(a).includes("same key")),
      );
      expect(keyWarnings).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it("new commits with dirty files: both sections and line 9", async () => {
    renderPane(
      payload({
        fromSha: A,
        ahead: commits(1, "g"),
        aheadCount: 1,
        files: inner(1, "untracked"),
        filesTotal: 1,
      }),
    );
    expect(await screen.findByText("Untracked files inside")).toBeTruthy();
    expect(screen.getByText("New commits · aaaaaaa → bbbbbbb")).toBeTruthy();
    expect(stageLines()).toEqual([
      "Staging this row records only the commit the submodule points at.",
      "Open the submodule to stage and commit its files.",
    ]);
  });

  it("no commit checked out with one file: line 6", async () => {
    renderPane(
      payload({
        head: null,
        toSha: null,
        files: inner(1, "untracked"),
        filesTotal: 1,
      }),
    );
    expect(await screen.findByText("No commits yet")).toBeTruthy();
    expect(stageLines()).toEqual([
      "Nothing to stage here yet: no commit is checked out in this submodule.",
      "Open it to commit this file.",
    ]);
  });

  it("a repository folder in a file's place: line 7", async () => {
    renderPane(payload({ fromSha: null, rangeKnown: true }));
    await screen.findByText("on main");
    expect(
      screen.getByText(
        "A repository now sits where this file was, with no uncommitted changes inside.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText("No changes in this submodule right now."),
    ).toBeNull();
    expect(stageLines()).toEqual([
      "Stage this row to record a submodule here in place of the file.",
    ]);
  });

  it("staged sides: a new submodule and a recorded move", async () => {
    renderPane(payload({ staged: true, fromSha: null, toSha: B }));
    expect(await screen.findByText("New submodule · bbbbbbb")).toBeTruthy();
    expect(stageLines()).toEqual([
      "The next commit adds this submodule at bbbbbbb.",
    ]);
    cleanup();
    renderPane(
      payload({
        staged: true,
        fromSha: A,
        ahead: commits(1, "h"),
        aheadCount: 1,
      }),
    );
    await screen.findByText("New commits · aaaaaaa → bbbbbbb");
    expect(stageLines()).toEqual([
      "The next commit records this submodule at bbbbbbb.",
    ]);
  });

  it("a staged rename's stage line names the move", async () => {
    renderPane(
      payload({
        staged: true,
        fromSha: A,
        ahead: commits(1, "h"),
        aheadCount: 1,
      }),
      true,
      "vendor/old",
    );
    await screen.findByText("New commits · aaaaaaa → bbbbbbb");
    expect(stageLines()).toEqual([
      "The next commit records this submodule at bbbbbbb, moved from vendor/old.",
    ]);
  });

  it("long subjects and paths render as text", async () => {
    const subject = "s".repeat(90);
    renderPane(
      payload({
        fromSha: A,
        ahead: [{ sha: B, subject }],
        aheadCount: 1,
        files: [
          { path: `${"p/".repeat(59)}x`, staged: null, unstaged: "added" },
        ],
        filesTotal: 1,
      }),
    );
    expect(await screen.findByText(subject)).toBeTruthy();
  });
});

describe("SubmoduleChangesPane behaviour (criterion 12)", () => {
  it("a failed refresh keeps the loaded content under a notice with Retry", async () => {
    const c = renderPane(
      payload({ files: inner(1, "untracked"), filesTotal: 1 }),
    );
    expect(await screen.findByText("Untracked files inside")).toBeTruthy();
    vi.mocked(gitSubmoduleChanges).mockRejectedValue(new Error("flaky"));
    await act(async () => {
      await c.refetchQueries();
    });
    const retry = await screen.findByRole("button", {
      name: "Retry loading this submodule",
    });
    expect(screen.getByText("Untracked files inside")).toBeTruthy();
    vi.mocked(gitSubmoduleChanges).mockResolvedValue(payload());
    await userEvent.setup().click(retry);
    expect(
      await screen.findByText("No changes in this submodule right now."),
    ).toBeTruthy();
  });

  it("Open submodule hands the submodule-relative path to the hook", async () => {
    renderPane(payload());
    await screen.findByText("on main");
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Open submodule" }));
    expect(openSub).toHaveBeenCalledExactlyOnceWith(PATH);
  });
});

describe("DiffViewer dispatch (criterion 10)", () => {
  const SUBMODULE_ROW: FileEntry = {
    path: PATH,
    staged: null,
    unstaged: "modified",
    submodule: {
      commitChanged: false,
      trackedModified: false,
      untracked: true,
      worktreeIsGitlink: true,
    },
  };
  const status = (entries: FileEntry[]) =>
    ({
      branch: { name: "main", detached: false, oid: null, upstream: null },
      entries,
    }) as unknown as RepoStatus;

  function renderViewer(entries: FileEntry[], path: string, staged = false) {
    vi.mocked(gitStatus).mockResolvedValue(status(entries));
    vi.mocked(gitDiffFile).mockResolvedValue({
      filePath: path,
      text: `diff --git a/${path} b/${path}\nindex 1111aaa..2222bbb 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`,
      isBinary: false,
      isTruncated: false,
    });
    vi.mocked(gitSubmoduleChanges).mockResolvedValue(
      payload({ files: inner(1, "untracked"), filesTotal: 1 }),
    );
    const c = client();
    // Seeded first: a selection ahead of the first status answer is a frame
    // no app writer produces.
    c.setQueryData(repoKeys.status("/repo"), status(entries));
    useUiStore.setState({
      selectedFile: { path, staged, untracked: false },
    });
    render(
      <QueryClientProvider client={c}>
        <DiffViewer repoPath="/repo" />
      </QueryClientProvider>,
    );
    return c;
  }

  it("a submodule row mounts the pane and never reads a text diff", async () => {
    renderViewer([SUBMODULE_ROW], PATH);
    expect(await screen.findByText("Untracked files inside")).toBeTruthy();
    expect(gitSubmoduleChanges).toHaveBeenCalledWith(
      "/repo",
      PATH,
      false,
      undefined,
    );
    expect(gitDiffFile).not.toHaveBeenCalled();
  });

  it("a staged rename reads with its old path, where HEAD records the gitlink", async () => {
    const moved = "vendor/moved";
    renderViewer(
      [
        {
          path: moved,
          staged: "renamed",
          unstaged: null,
          origPath: PATH,
          submodule: {
            commitChanged: false,
            trackedModified: false,
            untracked: false,
            worktreeIsGitlink: true,
          },
        },
      ],
      moved,
      true,
    );
    await waitFor(() =>
      expect(gitSubmoduleChanges).toHaveBeenCalledWith(
        "/repo",
        moved,
        true,
        PATH,
      ),
    );
    expect(gitSubmoduleChanges).not.toHaveBeenCalledWith(
      "/repo",
      moved,
      true,
      undefined,
    );
    expect(gitDiffFile).not.toHaveBeenCalled();
  });

  it("a staged copy reads with no old path: its source stays where it was", async () => {
    const copy = "vendor/copy";
    renderViewer(
      [
        {
          path: copy,
          staged: "copied",
          unstaged: null,
          origPath: PATH,
          submodule: {
            commitChanged: false,
            trackedModified: false,
            untracked: false,
            worktreeIsGitlink: true,
          },
        },
      ],
      copy,
      true,
    );
    await waitFor(() =>
      expect(gitSubmoduleChanges).toHaveBeenCalledWith(
        "/repo",
        copy,
        true,
        undefined,
      ),
    );
    expect(gitSubmoduleChanges).not.toHaveBeenCalledWith(
      "/repo",
      copy,
      true,
      PATH,
    );
    expect(gitDiffFile).not.toHaveBeenCalled();
  });

  it("the control: an ordinary row reads its text diff", async () => {
    renderViewer([{ path: "x", staged: null, unstaged: "modified" }], "x");
    await waitFor(() => expect(gitDiffFile).toHaveBeenCalled());
    expect(gitSubmoduleChanges).not.toHaveBeenCalled();
  });

  // A repository replaced the file over a staged edit: the index holds a plain
  // file, so only the worktree side is a submodule.
  const REPLACED_OVER_EDIT: FileEntry = {
    path: PATH,
    staged: "modified",
    unstaged: "typechange",
    submodule: {
      commitChanged: true,
      trackedModified: false,
      untracked: false,
      worktreeIsGitlink: true,
    },
  };

  it("MT SC..: the staged row reads its text diff", async () => {
    renderViewer([REPLACED_OVER_EDIT], PATH, true);
    await waitFor(() =>
      expect(gitDiffFile).toHaveBeenCalledWith(
        "/repo",
        PATH,
        true,
        false,
        false,
      ),
    );
    expect(gitSubmoduleChanges).not.toHaveBeenCalled();
  });

  it("MT SC..: the unstaged row mounts the pane", async () => {
    renderViewer([REPLACED_OVER_EDIT], PATH, false);
    await waitFor(() =>
      expect(gitSubmoduleChanges).toHaveBeenCalledWith(
        "/repo",
        PATH,
        false,
        undefined,
      ),
    );
    expect(gitDiffFile).not.toHaveBeenCalled();
  });

  it("a row that leaves status keeps the pane", async () => {
    const c = renderViewer([SUBMODULE_ROW], PATH);
    expect(await screen.findByText("Untracked files inside")).toBeTruthy();
    vi.mocked(gitStatus).mockResolvedValue(status([]));
    act(() => {
      c.setQueryData(repoKeys.status("/repo"), status([]));
    });
    expect(screen.getByRole("button", { name: "Open submodule" })).toBeTruthy();
    expect(gitDiffFile).not.toHaveBeenCalled();
  });
});
