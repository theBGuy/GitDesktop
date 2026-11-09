import { toast } from "sonner";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deletedNothingToOpen,
  fileMenuOpens,
  hintSlots,
  type OpenChangedFileAction,
  openChangedFileAction,
  runOpenChangedFile,
} from "@/features/repository/open-changed-file";
import { claimRepoOpen } from "@/features/repository/useOpenRepoByPath";
import {
  openWithDefault,
  openWithProgram,
  type PathKind,
  pathKind,
  revealInExplorer,
} from "@/lib/git/api";
import { conflictSides } from "@/lib/git/conflict";
import type { ChangeKind, FileEntry } from "@/lib/git/types";
import { refuseIfSwitched } from "@/lib/stores/notifications";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { unmockedCommands } from "./setup";

vi.mock("sonner", () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  },
}));
vi.mock("@/lib/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/toast")>()),
  toastError: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  openWithProgram: vi.fn(async () => undefined),
  openWithDefault: vi.fn(async () => undefined),
  revealInExplorer: vi.fn(async () => undefined),
  pathKind: vi.fn(),
}));
// The probe no longer reads the conflict sides; mocked so a call is visible.
vi.mock("@/lib/git/conflict", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/conflict")>()),
  conflictSides: vi.fn(),
}));
vi.mock("@/lib/stores/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stores/notifications")>()),
  refuseIfSwitched: vi.fn(() => false),
}));

const REPO = "C:\\repo";
const EDITOR = "C:\\code.exe";
/** The submodule opener the executor's third argument takes. */
const openSub = vi.fn(async (_subPath: string) => true);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(refuseIfSwitched).mockImplementation(() => false);
  vi.mocked(openWithProgram).mockImplementation(async () => undefined);
  vi.mocked(openWithDefault).mockImplementation(async () => undefined);
  vi.mocked(revealInExplorer).mockImplementation(async () => undefined);
  vi.mocked(pathKind).mockReset();
});

afterAll(() => {
  expect(unmockedCommands).toEqual([]);
});

/** Neither probe ran: the existence probe nor the old conflict-sides read. */
function expectNoProbe() {
  expect(pathKind).not.toHaveBeenCalled();
  expect(conflictSides).not.toHaveBeenCalled();
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const entry = (
  path: string,
  staged: ChangeKind | null,
  unstaged: ChangeKind | null,
  origPath?: string,
): FileEntry => ({ path, staged, unstaged, ...(origPath && { origPath }) });

const decide = (
  e: FileEntry,
  over: {
    editorPath?: string;
    windows?: boolean;
    via?: "editor" | "default";
  } = {},
) =>
  openChangedFileAction({
    entry: e,
    repoPath: over.windows === false ? "/home/u/repo" : REPO,
    editorPath: over.editorPath ?? "",
    windows: over.windows ?? true,
    via: over.via,
  });

/** No open of any kind was attempted. */
function expectNoLaunch() {
  expect(openWithProgram).not.toHaveBeenCalled();
  expect(openWithDefault).not.toHaveBeenCalled();
}

// Every kind with a working file, on each side it can be listed on.
const OPENABLE: FileEntry[] = [
  entry("src/a b/c.ts", null, "modified"),
  entry("src/a b/c.ts", "modified", null),
  entry("src/a b/c.ts", "added", null),
  entry("src/a b/c.ts", null, "added"),
  entry("src/a b/c.ts", null, "untracked"),
  entry("src/a b/c.ts", "renamed", null, "old/name.ts"),
  entry("src/a b/c.ts", null, "renamed", "old/name.ts"),
  entry("src/a b/c.ts", "copied", null, "old/name.ts"),
  entry("src/a b/c.ts", "typechange", null),
  entry("src/a b/c.ts", null, "typechange"),
  entry("src/a b/c.ts", "modified", "modified"),
];

// Worktree deletions: `.D`, `MD`, `AD`, `RD`.
const STATIC_REFUSE: FileEntry[] = [
  entry("gone.ts", null, "deleted"),
  entry("gone.ts", "modified", "deleted"),
  entry("gone.ts", "added", "deleted"),
  entry("gone.ts", "renamed", "deleted", "was.ts"),
];

// The working file may or may not exist.
const PROBE_CLASS: FileEntry[] = [
  entry("notes.md", "deleted", null),
  entry("merge.ts", null, "conflicted"),
];

describe("openChangedFileAction", () => {
  it("A1: an openable entry opens in the editor when one is set, else the default program", () => {
    for (const e of OPENABLE) {
      expect(decide(e, { editorPath: EDITOR }), JSON.stringify(e)).toEqual({
        kind: "editor",
        program: EDITOR,
        relPath: "src/a b/c.ts",
        absolutePath: "C:\\repo\\src\\a b\\c.ts",
        probeWorkingFile: false,
      });
      expect(decide(e), JSON.stringify(e)).toEqual({
        kind: "default",
        relPath: "src/a b/c.ts",
        absolutePath: "C:\\repo\\src\\a b\\c.ts",
        probeWorkingFile: false,
      });
      expect(decide(e, { windows: false }), JSON.stringify(e)).toEqual({
        kind: "default",
        relPath: "src/a b/c.ts",
        absolutePath: "/home/u/repo/src/a b/c.ts",
        probeWorkingFile: false,
      });
    }
  });

  it("A1: a path with quotes and colons keeps them, with the platform separator", () => {
    const odd = entry('a "b"/c:d.txt', null, "modified");
    expect(decide(odd)).toMatchObject({
      absolutePath: 'C:\\repo\\a "b"\\c:d.txt',
    });
    expect(decide(odd, { windows: false })).toMatchObject({
      absolutePath: '/home/u/repo/a "b"/c:d.txt',
    });
  });

  it("A1: a menu item's own program wins; the editor item without an editor opens the default", () => {
    const e = entry("a.ts", null, "modified");
    expect(decide(e, { editorPath: EDITOR, via: "editor" }).kind).toBe(
      "editor",
    );
    expect(decide(e, { editorPath: EDITOR, via: "default" }).kind).toBe(
      "default",
    );
    expect(decide(e, { editorPath: "", via: "editor" }).kind).toBe("default");
    expect(decide(e, { editorPath: "", via: "default" }).kind).toBe("default");
  });

  it("A2: a worktree deletion refuses on every row, whatever the program", () => {
    for (const e of STATIC_REFUSE)
      for (const editorPath of ["", EDITOR])
        for (const via of [undefined, "editor", "default"] as const)
          expect(decide(e, { editorPath, via }), JSON.stringify(e)).toEqual({
            kind: "refuse",
            reason: deletedNothingToOpen("gone.ts"),
          });
  });

  it("A3: a conflict or a staged deletion opens after a probe, for every trigger", () => {
    for (const e of PROBE_CLASS)
      for (const editorPath of ["", EDITOR])
        for (const via of [undefined, "editor", "default"] as const) {
          const action = decide(e, { editorPath, via });
          expect(action.kind, JSON.stringify(e)).not.toBe("refuse");
          expect(action).toMatchObject({
            relPath: e.path,
            probeWorkingFile: true,
          });
        }
  });

  it("deletedNothingToOpen names the path", () => {
    expect(deletedNothingToOpen("x/y.ts")).toBe(
      "x/y.ts was deleted, so there's nothing to open.",
    );
  });
});

const EDITOR_ARM: OpenChangedFileAction = {
  kind: "editor",
  program: EDITOR,
  relPath: "a.ts",
  absolutePath: "C:\\repo\\a.ts",
  probeWorkingFile: false,
};
const DEFAULT_ARM: OpenChangedFileAction = {
  kind: "default",
  relPath: "a.ts",
  absolutePath: "C:\\repo\\a.ts",
  probeWorkingFile: false,
};
const REFUSE_ARM: OpenChangedFileAction = {
  kind: "refuse",
  reason: deletedNothingToOpen("a.ts"),
};
const FOLDER_ARM: OpenChangedFileAction = {
  kind: "folder",
  relPath: "sub/",
  absolutePath: "C:\\repo\\sub",
};

describe("L7: an untracked folder (git's trailing-slash path)", () => {
  // The decision for `path`, untracked, under each trigger and editor setting.
  const UNTRACKED_DIRS: [string, string, boolean, string][] = [
    ["sub/", REPO, true, "C:\\repo\\sub"],
    ["a b/nested repo/", REPO, true, "C:\\repo\\a b\\nested repo"],
    ["sub/", "/home/u/repo", false, "/home/u/repo/sub"],
  ];
  it.each(UNTRACKED_DIRS)(
    "%s is a folder on every trigger, revealed at its own path",
    (path, repoPath, windows, absolutePath) => {
      for (const via of [undefined, "editor", "default"] as const)
        for (const editorPath of ["", EDITOR])
          expect(
            openChangedFileAction({
              entry: entry(path, null, "untracked"),
              repoPath,
              editorPath,
              windows,
              via,
            }),
          ).toEqual({ kind: "folder", relPath: path, absolutePath });
    },
  );

  it("a path without the trailing slash stays a file", () => {
    expect(decide(entry("sub", null, "untracked")).kind).toBe("default");
  });

  it("fileMenuOpens offers no Open item and no hint", () => {
    expect(fileMenuOpens(FOLDER_ARM)).toEqual({
      showFileOpens: false,
      hintOn: null,
    });
  });

  it("the executor reveals the folder and launches nothing", async () => {
    await runOpenChangedFile(FOLDER_ARM, REPO, openSub);
    expect(revealInExplorer).toHaveBeenCalledExactlyOnceWith("C:\\repo\\sub");
    expectNoLaunch();
    expect(openSub).not.toHaveBeenCalled();
    expectNoProbe();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("a failed reveal reaches toastError", async () => {
    const boom = new Error("no explorer");
    vi.mocked(revealInExplorer).mockRejectedValueOnce(boom);
    await runOpenChangedFile(FOLDER_ARM, REPO, openSub);
    await vi.waitFor(() =>
      expect(toastError).toHaveBeenCalledExactlyOnceWith(boom),
    );
  });
});

describe("fileMenuOpens / hintSlots", () => {
  it("A7: refuse hides the Open items; each open arm hints its own item", () => {
    expect(fileMenuOpens(REFUSE_ARM)).toEqual({
      showFileOpens: false,
      hintOn: null,
    });
    expect(fileMenuOpens(EDITOR_ARM)).toEqual({
      showFileOpens: true,
      hintOn: "editor",
    });
    expect(fileMenuOpens(DEFAULT_ARM)).toEqual({
      showFileOpens: true,
      hintOn: "default",
    });
  });

  it("hintSlots lights exactly the hinted item", () => {
    expect(hintSlots(null)).toEqual({
      editor: false,
      default: false,
      submodule: false,
    });
    expect(hintSlots("editor")).toEqual({
      editor: true,
      default: false,
      submodule: false,
    });
    expect(hintSlots("default")).toEqual({
      editor: false,
      default: true,
      submodule: false,
    });
    expect(hintSlots("submodule")).toEqual({
      editor: false,
      default: false,
      submodule: true,
    });
  });
});

describe("runOpenChangedFile", () => {
  it("A1: an open arm launches exactly its program, with no probe", async () => {
    await runOpenChangedFile(EDITOR_ARM, REPO, openSub);
    expect(openWithProgram).toHaveBeenCalledExactlyOnceWith(
      EDITOR,
      "C:\\repo\\a.ts",
    );
    expect(openWithDefault).not.toHaveBeenCalled();
    vi.clearAllMocks();
    await runOpenChangedFile(DEFAULT_ARM, REPO, openSub);
    expect(openWithDefault).toHaveBeenCalledExactlyOnceWith("C:\\repo\\a.ts");
    expect(openWithProgram).not.toHaveBeenCalled();
    expectNoProbe();
    expect(refuseIfSwitched).not.toHaveBeenCalled();
  });

  it("A2: a static refusal toasts its reason, probing and launching nothing", async () => {
    for (const e of STATIC_REFUSE.slice(0, 3)) {
      vi.clearAllMocks();
      await runOpenChangedFile(
        decide(e, { editorPath: EDITOR }),
        REPO,
        openSub,
      );
      expect(toast.info).toHaveBeenCalledExactlyOnceWith(
        deletedNothingToOpen("gone.ts"),
      );
      expectNoProbe();
      expectNoLaunch();
    }
  });

  it("A3: a probe-class open launches a file or link, toasts when it is gone, reveals a folder, opens on a failed probe", async () => {
    for (const e of PROBE_CLASS) {
      const action = decide(e, { editorPath: EDITOR });
      const abs = `C:\\repo\\${e.path}`;

      for (const kind of ["file", "symlink"] as const) {
        vi.clearAllMocks();
        vi.mocked(pathKind).mockResolvedValueOnce(kind);
        await runOpenChangedFile(action, REPO, openSub);
        expect(pathKind).toHaveBeenCalledExactlyOnceWith(REPO, e.path);
        expect(conflictSides).not.toHaveBeenCalled();
        expect(openWithProgram).toHaveBeenCalledExactlyOnceWith(EDITOR, abs);
        expect(toast.info).not.toHaveBeenCalled();
        expect(revealInExplorer).not.toHaveBeenCalled();
      }

      vi.clearAllMocks();
      vi.mocked(pathKind).mockResolvedValueOnce("missing");
      await runOpenChangedFile(action, REPO, openSub);
      expect(toast.info).toHaveBeenCalledExactlyOnceWith(
        deletedNothingToOpen(e.path),
      );
      expectNoLaunch();

      vi.clearAllMocks();
      vi.mocked(pathKind).mockResolvedValueOnce("dir");
      await runOpenChangedFile(action, REPO, openSub);
      expect(revealInExplorer).toHaveBeenCalledExactlyOnceWith(abs);
      expectNoLaunch();
      expect(toast.info).not.toHaveBeenCalled();

      vi.clearAllMocks();
      vi.mocked(pathKind).mockRejectedValueOnce(new Error("refused"));
      await runOpenChangedFile(decide(e), REPO, openSub);
      expect(openWithDefault).toHaveBeenCalledExactlyOnceWith(abs);
      expect(toast.info).not.toHaveBeenCalled();
      expect(openSub).not.toHaveBeenCalled();
    }
  });

  it("A3: a repo switch during the probe opens nothing, in every outcome, on both probe arms", async () => {
    for (const e of PROBE_CLASS) {
      const action = decide(e, { editorPath: EDITOR });
      for (const answer of ["file", "dir", "rejects", "missing"] as const) {
        const label = `${e.path} ${answer}`;
        vi.clearAllMocks();
        vi.mocked(refuseIfSwitched).mockReturnValueOnce(true);
        if (answer === "rejects")
          vi.mocked(pathKind).mockRejectedValueOnce(new Error("x"));
        else vi.mocked(pathKind).mockResolvedValueOnce(answer);
        await runOpenChangedFile(action, REPO, openSub);
        expect(pathKind, label).toHaveBeenCalledExactlyOnceWith(REPO, e.path);
        expect(revealInExplorer, label).not.toHaveBeenCalled();
        expect(refuseIfSwitched, label).toHaveBeenCalledExactlyOnceWith(
          REPO,
          "the file didn't open",
          "while checking the file",
        );
        expectNoLaunch();
        // refuseIfSwitched's own note is the only toast (mocked here).
        expect(toast.info, label).not.toHaveBeenCalled();
      }
    }
  });

  it("A3: a repeat while the probe is pending is dropped; one after it settles probes again", async () => {
    const action = decide(PROBE_CLASS[1]);
    const held = deferred<PathKind>();
    vi.mocked(pathKind).mockReturnValueOnce(held.promise);
    const first = runOpenChangedFile(action, REPO, openSub);
    await runOpenChangedFile(action, REPO, openSub);
    await runOpenChangedFile(
      decide(PROBE_CLASS[1], { via: "default" }),
      REPO,
      openSub,
    );
    expect(pathKind).toHaveBeenCalledTimes(1);
    expectNoLaunch();
    held.resolve("file");
    await first;
    expect(openWithDefault).toHaveBeenCalledTimes(1);

    vi.mocked(pathKind).mockResolvedValueOnce("file");
    await runOpenChangedFile(action, REPO, openSub);
    expect(pathKind).toHaveBeenCalledTimes(2);
    expect(openWithDefault).toHaveBeenCalledTimes(2);
  });

  it("A3: the in-flight drop is per repo and path", async () => {
    const held = deferred<PathKind>();
    vi.mocked(pathKind)
      .mockReturnValueOnce(held.promise)
      .mockResolvedValue("file");
    const first = runOpenChangedFile(decide(PROBE_CLASS[1]), REPO, openSub);
    await runOpenChangedFile(decide(PROBE_CLASS[0]), REPO, openSub);
    await runOpenChangedFile(
      decide(PROBE_CLASS[1], { windows: false }),
      "/home/u/repo",
      openSub,
    );
    expect(pathKind).toHaveBeenCalledTimes(3);
    held.resolve("file");
    await first;
    expect(openWithDefault).toHaveBeenCalledTimes(3);
  });

  it("A3: a probe that outlives its row acts on the captured path and calls nothing else", async () => {
    for (const exists of [true, false]) {
      vi.clearAllMocks();
      const row = entry("moved.ts", "deleted", null);
      const list = [row];
      const action = decide(row);
      const held = deferred<PathKind>();
      vi.mocked(pathKind).mockReturnValueOnce(held.promise);
      const run = runOpenChangedFile(action, REPO, openSub);
      // The row is renamed and the list emptied while the probe is out.
      row.path = "elsewhere.ts";
      row.staged = null;
      row.unstaged = "modified";
      list.length = 0;
      held.resolve(exists ? "file" : "missing");
      await run;
      expect(pathKind).toHaveBeenCalledExactlyOnceWith(REPO, "moved.ts");
      if (exists) {
        expect(openWithDefault).toHaveBeenCalledExactlyOnceWith(
          "C:\\repo\\moved.ts",
        );
        expect(toast.info).not.toHaveBeenCalled();
      } else {
        expectNoLaunch();
        expect(toast.info).toHaveBeenCalledExactlyOnceWith(
          deletedNothingToOpen("moved.ts"),
        );
      }
      expect(openWithProgram).not.toHaveBeenCalled();
      expect(openSub).not.toHaveBeenCalled();
      expect(toastError).not.toHaveBeenCalled();
      expect(refuseIfSwitched).toHaveBeenCalledTimes(1);
    }
  });

  it("A4: a failed launch reaches toastError with the error", async () => {
    const boom = new Error("no such program");
    vi.mocked(openWithProgram).mockRejectedValueOnce(boom);
    await runOpenChangedFile(EDITOR_ARM, REPO, openSub);
    await vi.waitFor(() =>
      expect(toastError).toHaveBeenCalledExactlyOnceWith(boom),
    );
    vi.clearAllMocks();
    const nope = new Error("no handler");
    vi.mocked(openWithDefault).mockRejectedValueOnce(nope);
    await runOpenChangedFile(DEFAULT_ARM, REPO, openSub);
    await vi.waitFor(() =>
      expect(toastError).toHaveBeenCalledExactlyOnceWith(nope),
    );
  });
});

// Submodule rows, spelled as status.rs emits the measured records.
const NONE = {
  commitChanged: false,
  trackedModified: false,
  untracked: false,
  worktreeIsGitlink: true,
};
/** The same token where the worktree holds a file, or nothing (a deletion). */
const OFF_GITLINK = { ...NONE, worktreeIsGitlink: false };
const sub = (
  staged: ChangeKind | null,
  unstaged: ChangeKind | null,
  flags = NONE,
  path = "vendor/sub",
): FileEntry => ({ path, staged, unstaged, submodule: flags });
const SUBMODULE_ROWS: [string, FileEntry][] = [
  ["S..U (row 1)", sub(null, "modified", { ...NONE, untracked: true })],
  ["S.M. (row 2)", sub(null, "modified", { ...NONE, trackedModified: true })],
  ["SC.. (row 3)", sub(null, "modified", { ...NONE, commitChanged: true })],
  [
    "SCMU (row 4)",
    sub(null, "modified", {
      commitChanged: true,
      trackedModified: true,
      untracked: true,
      worktreeIsGitlink: true,
    }),
  ],
  ["M. (row 12, 7b)", sub("modified", null)],
  [
    "MM (row 13)",
    sub("modified", "modified", { ...NONE, commitChanged: true }),
  ],
  ["A. (row 17)", sub("added", null)],
  ["UU (row 14)", sub(null, "conflicted")],
  ["D. after git rm (row 8)", sub("deleted", null, OFF_GITLINK, "sub")],
  ["D. after rm --cached (row 8b)", sub("deleted", null, OFF_GITLINK, "sub")],
  ["T with a file (row 16)", sub(null, "typechange", OFF_GITLINK)],
  ["T. with a file", sub("typechange", null, OFF_GITLINK)],
  [
    "T with a repo (row 16b)",
    sub(null, "typechange", { ...NONE, commitChanged: true }),
  ],
  ["T. with a repo", sub("typechange", null)],
];

describe("submodule rows", () => {
  it.each(SUBMODULE_ROWS)(
    "%s opens the submodule, its file fallback never probing",
    (_n, entry) => {
      for (const editorPath of ["", EDITOR]) {
        const base = { entry, repoPath: REPO, editorPath, windows: true };
        const absolutePath = `C:\\repo\\${entry.path.replaceAll("/", "\\")}`;
        expect(openChangedFileAction(base)).toEqual({
          kind: "submodule",
          relPath: entry.path,
          asFile:
            editorPath === ""
              ? {
                  kind: "default",
                  relPath: entry.path,
                  absolutePath,
                  probeWorkingFile: false,
                }
              : {
                  kind: "editor",
                  program: EDITOR,
                  relPath: entry.path,
                  absolutePath,
                  probeWorkingFile: false,
                },
          // A file sits on disk only where the worktree mode left the gitlink
          // and the row is no deletion.
          typechange:
            entry.submodule?.worktreeIsGitlink === false &&
            entry.staged !== "deleted",
        });
        for (const via of ["editor", "default"] as const) {
          const action = openChangedFileAction({ ...base, via });
          expect(action.kind).toBe(
            via === "editor" && editorPath !== "" ? "editor" : "default",
          );
          expect(action).toMatchObject({ probeWorkingFile: false });
        }
      }
    },
  );

  it("a folder-gone row (.D, row 9) keeps A's static refuse", () => {
    const entry = sub(null, "deleted");
    expect(
      openChangedFileAction({
        entry,
        repoPath: REPO,
        editorPath: "",
        windows: true,
      }),
    ).toEqual({ kind: "refuse", reason: deletedNothingToOpen(entry.path) });
  });

  it("the ? sub/ record of row 8b is not a submodule row", () => {
    const entry: FileEntry = {
      path: "sub/",
      staged: null,
      unstaged: "untracked",
    };
    expect(
      openChangedFileAction({
        entry,
        repoPath: REPO,
        editorPath: "",
        windows: true,
      }).kind,
    ).toBe("folder");
  });

  const SUB_ARM = decide(sub(null, "modified", { ...NONE, untracked: true }));
  const SUB_ABS = "C:\\repo\\vendor\\sub";
  const SUB_ROW_SELECTED = {
    path: "vendor/sub",
    staged: false,
    untracked: false,
  };

  it("fileMenuOpens hints the submodule item and offers no file opens", () => {
    expect(fileMenuOpens(SUB_ARM)).toEqual({
      showFileOpens: false,
      hintOn: "submodule",
    });
  });

  it("fileMenuOpens offers a typechange row's file opens, hinting the double-click's program", () => {
    for (const row of [
      sub(null, "typechange", OFF_GITLINK),
      sub("typechange", null, OFF_GITLINK),
    ]) {
      expect(fileMenuOpens(decide(row))).toEqual({
        showFileOpens: true,
        hintOn: "default",
      });
      expect(fileMenuOpens(decide(row, { editorPath: EDITOR }))).toEqual({
        showFileOpens: true,
        hintOn: "editor",
      });
    }
    // A file that became a submodule keeps a gitlink worktree: Open submodule.
    for (const row of [sub(null, "typechange"), sub("typechange", null)])
      for (const editorPath of ["", EDITOR])
        expect(fileMenuOpens(decide(row, { editorPath }))).toEqual({
          showFileOpens: false,
          hintOn: "submodule",
        });
  });

  it("a file that became a submodule double-clicks into the submodule", async () => {
    vi.clearAllMocks();
    vi.mocked(pathKind).mockResolvedValueOnce("dir");
    await runOpenChangedFile(decide(sub(null, "typechange")), REPO, openSub);
    expect(openSub).toHaveBeenCalledExactlyOnceWith("vendor/sub");
    expectNoLaunch();
  });

  it("the executor opens a folder (or an unprobed path) as the submodule, and nothing else", async () => {
    for (const answer of ["dir", "rejects"] as const) {
      vi.clearAllMocks();
      if (answer === "rejects")
        vi.mocked(pathKind).mockRejectedValueOnce(new Error("x"));
      else vi.mocked(pathKind).mockResolvedValueOnce(answer);
      await runOpenChangedFile(SUB_ARM, REPO, openSub);
      expect(pathKind, answer).toHaveBeenCalledExactlyOnceWith(
        REPO,
        "vendor/sub",
      );
      expect(openSub, answer).toHaveBeenCalledExactlyOnceWith("vendor/sub");
      expect(conflictSides).not.toHaveBeenCalled();
      expectNoLaunch();
      expect(toast.info).not.toHaveBeenCalled();
    }
  });

  it("a file (or link) that replaced the submodule opens as a file, through its program", async () => {
    // Row 16: `T` keeps the submodule token over a regular file on disk.
    const replaced = sub(null, "typechange", OFF_GITLINK);
    for (const kind of ["file", "symlink"] as const) {
      vi.clearAllMocks();
      vi.mocked(pathKind).mockResolvedValueOnce(kind);
      await runOpenChangedFile(decide(replaced), REPO, openSub);
      expect(openWithDefault, kind).toHaveBeenCalledExactlyOnceWith(SUB_ABS);
      expect(openSub, kind).not.toHaveBeenCalled();

      vi.clearAllMocks();
      vi.mocked(pathKind).mockResolvedValueOnce(kind);
      await runOpenChangedFile(
        decide(replaced, { editorPath: EDITOR }),
        REPO,
        openSub,
      );
      expect(openWithProgram, kind).toHaveBeenCalledExactlyOnceWith(
        EDITOR,
        SUB_ABS,
      );
      expect(openWithDefault).not.toHaveBeenCalled();
      expect(openSub, kind).not.toHaveBeenCalled();
    }
  });

  it("a missing submodule path refuses with the deleted note", async () => {
    vi.mocked(pathKind).mockResolvedValueOnce("missing");
    await runOpenChangedFile(SUB_ARM, REPO, openSub);
    expect(toast.info).toHaveBeenCalledExactlyOnceWith(
      deletedNothingToOpen("vendor/sub"),
    );
    expect(openSub).not.toHaveBeenCalled();
    expectNoLaunch();
  });

  it("a repo switch during the probe opens nothing, saying so for the submodule", async () => {
    for (const answer of ["dir", "file", "missing"] as const) {
      vi.clearAllMocks();
      vi.mocked(refuseIfSwitched).mockReturnValueOnce(true);
      vi.mocked(pathKind).mockResolvedValueOnce(answer);
      await runOpenChangedFile(SUB_ARM, REPO, openSub);
      expect(refuseIfSwitched, answer).toHaveBeenCalledExactlyOnceWith(
        REPO,
        "the submodule didn't open",
        "while checking the submodule",
      );
      expect(openSub, answer).not.toHaveBeenCalled();
      expectNoLaunch();
      expect(toast.info, answer).not.toHaveBeenCalled();
    }
  });

  it("a second double-click on the same row during the probe opens the submodule once", async () => {
    const held = deferred<PathKind>();
    vi.mocked(pathKind).mockReturnValueOnce(held.promise);
    const first = runOpenChangedFile(SUB_ARM, REPO, openSub);
    // The second click re-selects the row (an epoch bump), then double-clicks.
    useUiStore.getState().selectFile(SUB_ROW_SELECTED);
    await runOpenChangedFile(SUB_ARM, REPO, openSub);
    held.resolve("dir");
    await first;
    expect(pathKind).toHaveBeenCalledTimes(1);
    expect(openSub).toHaveBeenCalledExactlyOnceWith("vendor/sub");
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("a click on another row during the probe retires the open", async () => {
    useUiStore.getState().selectFile(SUB_ROW_SELECTED);
    const held = deferred<PathKind>();
    vi.mocked(pathKind).mockReturnValueOnce(held.promise);
    const run = runOpenChangedFile(SUB_ARM, REPO, openSub);
    useUiStore
      .getState()
      .selectFile({ path: "a.ts", staged: false, untracked: false });
    held.resolve("dir");
    await run;
    expect(openSub).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("a later double-click on another submodule row wins while both probes are pending", async () => {
    const a = deferred<PathKind>();
    const b = deferred<PathKind>();
    vi.mocked(pathKind)
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise);
    const other = decide(sub(null, "modified", NONE, "vendor/other"));
    const first = runOpenChangedFile(SUB_ARM, REPO, openSub);
    const second = runOpenChangedFile(other, REPO, openSub);
    a.resolve("dir");
    await first;
    b.resolve("dir");
    await second;
    expect(openSub).toHaveBeenCalledExactlyOnceWith("vendor/other");
  });

  it("a newer open claimed during the probe wins: the submodule is not opened", async () => {
    const held = deferred<PathKind>();
    vi.mocked(pathKind).mockReturnValueOnce(held.promise);
    const run = runOpenChangedFile(SUB_ARM, REPO, openSub);
    claimRepoOpen();
    held.resolve("dir");
    await run;
    expect(openSub).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("a repeat while the submodule probe is pending is dropped", async () => {
    const held = deferred<PathKind>();
    vi.mocked(pathKind).mockReturnValueOnce(held.promise);
    const first = runOpenChangedFile(SUB_ARM, REPO, openSub);
    await runOpenChangedFile(SUB_ARM, REPO, openSub);
    expect(pathKind).toHaveBeenCalledTimes(1);
    held.resolve("dir");
    await first;
    expect(openSub).toHaveBeenCalledTimes(1);
  });
});
