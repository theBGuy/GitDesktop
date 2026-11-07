import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreesDialog } from "@/features/repository/WorktreesDialog";
import {
  composePickedPath,
  isAbsolutePath,
} from "@/features/repository/worktree-paths";
import { listUserWorktrees, type UserWorktree } from "@/lib/git/worktree";
import {
  deriveDefaultWorktreePath,
  folderKey,
  isBareMainRow,
  rowAtPath,
  sameCheckout,
} from "@/lib/git/worktree-default-path";
import { unmockedCommands } from "./setup";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitBranches: vi.fn(async () => []),
  // Shell reads these cases never need answered.
  gitStatus: vi.fn(() => new Promise(() => undefined)),
  gitDefaultBranch: vi.fn(() => new Promise(() => undefined)),
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

const REPO = "C:/repos/demo";

const MAIN: UserWorktree = {
  path: REPO,
  branch: "main",
  head: "a".repeat(40),
  isMain: true,
  isDetached: false,
  isLocked: false,
  lockReason: "",
} as UserWorktree;

beforeEach(() => {
  vi.mocked(listUserWorktrees).mockResolvedValue([MAIN]);
  vi.mocked(openDialog).mockReset();
});

afterAll(() => expect(unmockedCommands).toEqual([]));

async function openCreate() {
  const user = userEvent.setup();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <WorktreesDialog repoPath={REPO} open onOpenChange={() => undefined} />
    </QueryClientProvider>,
  );
  await user.click(await screen.findByRole("button", { name: "Add worktree" }));
  const branch = screen.getByLabelText("Branch name");
  const folder = screen.getByLabelText("Folder") as HTMLInputElement;
  const browse = screen.getByRole("button", {
    name: "Browse for the folder to create it in",
  });
  return { user, branch, folder, browse };
}

async function setBranch(
  user: ReturnType<typeof userEvent.setup>,
  input: HTMLElement,
  name: string,
) {
  await user.clear(input);
  await user.type(input, name);
}

describe("WorktreesDialog folder Browse", () => {
  it("derives the in-repo path exactly as the shared helper does", async () => {
    const { user, branch, folder } = await openCreate();
    await waitFor(() => expect(listUserWorktrees).toHaveBeenCalled());
    await setBranch(user, branch, "feat/login");
    expect(folder.value).toBe(
      deriveDefaultWorktreePath(REPO, [MAIN], "feat/login"),
    );
    expect(folder.value).toBe(".gitdesktop/worktrees/feat-login");
  });

  it("an empty branch keeps the folder empty and the branch hint", async () => {
    const { folder } = await openCreate();
    await waitFor(() => expect(listUserWorktrees).toHaveBeenCalled());
    expect(folder.value).toBe("");
    expect(
      screen.getByText("Enter a branch name and folder to continue."),
    ).toBeTruthy();
  });

  it("from a linked checkout the default sits under the main worktree", async () => {
    vi.mocked(listUserWorktrees).mockResolvedValue([
      { ...MAIN, path: "C:/repos/main" },
      { ...MAIN, path: REPO, branch: "other", isMain: false },
    ]);
    const { user, branch, folder } = await openCreate();
    await setBranch(user, branch, "feat/login");
    await waitFor(() =>
      expect(folder.value).toBe(
        "C:/repos/main/.gitdesktop/worktrees/feat-login",
      ),
    );
  });

  it("holds Create while the worktree list hasn't named the main checkout", async () => {
    vi.mocked(listUserWorktrees).mockImplementation(
      () => new Promise(() => undefined),
    );
    const { user, branch, folder } = await openCreate();
    await setBranch(user, branch, "feat/login");
    expect(folder.value).toBe("");
    expect(folder.placeholder).toBe("Finding the main worktree…");
    expect(screen.getByText("Finding the main worktree…")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Create worktree",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("a failed worktree list leaves the folder for the user to type", async () => {
    vi.mocked(listUserWorktrees).mockRejectedValue(new Error("read failed"));
    const { user, branch, folder } = await openCreate();
    await setBranch(user, branch, "feat/login");
    const create = screen.getByRole("button", {
      name: "Create worktree",
    }) as HTMLButtonElement;
    await waitFor(() =>
      expect(folder.placeholder).toBe("Path for the new worktree"),
    );
    expect(folder.value).toBe("");
    expect(
      screen.getByText("Enter a branch name and folder to continue."),
    ).toBeTruthy();
    expect(create.disabled).toBe(true);
    await user.type(folder, "E:/x/y");
    expect(create.disabled).toBe(false);
  });

  it("the Full path row resolves the folder and tracks edits", async () => {
    const { user, branch, folder } = await openCreate();
    await waitFor(() => expect(listUserWorktrees).toHaveBeenCalled());
    await setBranch(user, branch, "feat/login");
    const rowId = folder.getAttribute("aria-describedby");
    expect(rowId).toBeTruthy();
    const row = document.getElementById(rowId as string) as HTMLElement;
    expect(screen.getByText("Full path")).toBeTruthy();
    expect(row.textContent).toBe(
      "C:/repos/demo/.gitdesktop/worktrees/feat-login",
    );
    expect(row.tabIndex).toBe(-1);
    await user.clear(folder);
    expect(row.textContent).toBe("");
    await user.type(folder, "../review");
    expect(row.textContent).toBe("C:/repos/review");
  });

  it("clipped folder text and Full path show their tooltips", async () => {
    const { user, branch, folder } = await openCreate();
    await waitFor(() => expect(listUserWorktrees).toHaveBeenCalled());
    await setBranch(user, branch, "feat/login");
    fireEvent.mouseEnter(folder);
    expect(folder.getAttribute("title")).toBeNull();
    clip(folder);
    fireEvent.mouseEnter(folder);
    expect(folder.getAttribute("title")).toBe(
      ".gitdesktop/worktrees/feat-login",
    );
    const row = document.getElementById(
      folder.getAttribute("aria-describedby") as string,
    ) as HTMLElement;
    const pathText = row.firstElementChild as HTMLElement;
    clip(pathText.firstElementChild as HTMLElement);
    fireEvent.mouseEnter(pathText);
    expect(pathText.getAttribute("title")).toBe(
      "C:/repos/demo/.gitdesktop/worktrees/feat-login",
    );
  });

  it("a pick becomes the parent and the leaf keeps following the branch", async () => {
    const { user, branch, folder, browse } = await openCreate();
    await setBranch(user, branch, "feat/login");
    vi.mocked(openDialog).mockResolvedValue("D:\\picked");
    await user.click(browse);
    await waitFor(() => expect(folder.value).toBe("D:/picked/feat-login"));
    // Browse never latches the field: a branch edit re-derives the leaf.
    await setBranch(user, branch, "fix/x");
    expect(folder.value).toBe("D:/picked/fix-x");
  });

  it("a direct edit still latches the whole field", async () => {
    const { user, branch, folder } = await openCreate();
    await setBranch(user, branch, "feat/login");
    await user.clear(folder);
    await user.type(folder, "E:/typed/mine");
    await setBranch(user, branch, "fix/x");
    expect(folder.value).toBe("E:/typed/mine");
  });

  it("a pick after a direct edit keeps the typed leaf and the latch", async () => {
    const { user, branch, folder, browse } = await openCreate();
    await setBranch(user, branch, "feat/login");
    await user.clear(folder);
    await user.type(folder, "E:/typed/mine");
    vi.mocked(openDialog).mockResolvedValue("F:/other/");
    await user.click(browse);
    await waitFor(() => expect(folder.value).toBe("F:/other/mine"));
    await setBranch(user, branch, "fix/x");
    expect(folder.value).toBe("F:/other/mine");
  });

  it.each(["C:\\", "C:/"])(
    "a pick after typing the drive root %j takes the derived leaf",
    async (root) => {
      const { user, branch, folder, browse } = await openCreate();
      await setBranch(user, branch, "feat/login");
      await user.clear(folder);
      await user.type(folder, root);
      vi.mocked(openDialog).mockResolvedValue("D:/reviews");
      await user.click(browse);
      await waitFor(() => expect(folder.value).toBe("D:/reviews/feat-login"));
      expect(composePickedPath("D:/reviews", root, `${REPO}-pr-7`)).toBe(
        "D:/reviews/demo-pr-7",
      );
    },
  );

  it.each([
    // [path, absolute on Windows, absolute on macOS/Linux]
    ["C:\\x", true, false],
    ["c:/x", true, false],
    ["\\\\server\\share", true, false],
    ["//server/s", true, true],
    ["/home", false, true],
    ["\\x", false, false],
    ["C:x", false, false],
    ["../review", false, false],
    ["review", false, false],
    ["", false, false],
  ])("%j is absolute: Windows %s, elsewhere %s", (p, windows, posix) => {
    expect(isAbsolutePath(p, true)).toBe(windows);
    expect(isAbsolutePath(p, false)).toBe(posix);
  });

  it("a cancelled pick leaves the field as it was", async () => {
    const { user, branch, folder, browse } = await openCreate();
    await setBranch(user, branch, "feat/login");
    vi.mocked(openDialog).mockResolvedValue(null);
    await user.click(browse);
    expect(folder.value).toBe(".gitdesktop/worktrees/feat-login");
  });
  it("a pick before any branch keeps the field empty until a leaf derives", async () => {
    const { user, branch, folder, browse } = await openCreate();
    vi.mocked(openDialog).mockResolvedValue("D:/picked");
    await user.click(browse);
    await waitFor(() => expect(openDialog).toHaveBeenCalled());
    expect(folder.value).toBe("");
    await setBranch(user, branch, "feat/login");
    expect(folder.value).toBe("D:/picked/feat-login");
  });
});

/** jsdom lays nothing out, so a clip is stubbed: content wider than its box. */
function clip(el: HTMLElement) {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: 400 });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: 100 });
}

function row(over: Partial<UserWorktree>): UserWorktree {
  return { ...MAIN, ...over };
}

const BARE_MAIN = row({
  path: "C:/repos/app.git",
  head: "",
  branch: "",
  isMain: true,
  isDetached: false,
});

describe("rowAtPath", () => {
  const rows = [
    row({ path: "/r/main" }),
    row({ path: "/r/Review", isMain: false, head: "1".repeat(40) }),
    row({ path: "/r/review", isMain: false, head: "2".repeat(40) }),
  ];

  it("on a case-sensitive host picks the row written, not its case twin", () => {
    const linux = { windows: false, caseInsensitive: false };
    expect(rowAtPath(rows, "/r/review", linux)?.path).toBe("/r/review");
    expect(rowAtPath(rows, "/r/Review/", linux)?.path).toBe("/r/Review");
    expect(rowAtPath(rows, "/r/REVIEW", linux)).toBeUndefined();
  });

  it("on Windows folds case and separators", () => {
    expect(rowAtPath(rows, "\\r\\REVIEW", { windows: true })?.path).toBe(
      "/r/Review",
    );
  });

  it("holds keep folding everywhere, so they can only over-hold", () => {
    expect(folderKey("/r/Review")).toBe(folderKey("/r/review"));
  });
});

// The dialog's current-row marker, switch-to-self skip and rename no-op all
// compare through sameCheckout.
describe("sameCheckout", () => {
  const linux = { windows: false, caseInsensitive: false };
  it("on Linux a case-only rename is a real rename, on Windows a no-op", () => {
    expect(sameCheckout("/r/Review", "/r/review", linux)).toBe(false);
    expect(
      sameCheckout("C:/r/Review", "C:\\r\\review", { windows: true }),
    ).toBe(true);
  });

  it("on Linux a case twin of the open checkout is not the current row", () => {
    expect(sameCheckout("/r/review", "/r/Review", linux)).toBe(false);
    expect(sameCheckout("/r/Review/", "/r/Review", linux)).toBe(true);
  });
});

describe("deriveDefaultWorktreePath", () => {
  it.each<[string, UserWorktree[] | undefined, string, string | null]>([
    // [repoPath, rows, leaf, default]
    [REPO, [MAIN], "pr-7", ".gitdesktop/worktrees/pr-7"],
    [REPO, [MAIN], "feat/login", ".gitdesktop/worktrees/feat-login"],
    [REPO, [MAIN], "a\\b//c", ".gitdesktop/worktrees/a-b-c"],
    [REPO, [MAIN], "  x  ", ".gitdesktop/worktrees/x"],
    [REPO, [MAIN], "/", ".gitdesktop/worktrees/-"],
    [REPO, [MAIN], "", ""],
    [REPO, [MAIN], "   ", ""],
    ["C:\\repos\\demo", [MAIN], "pr-7", ".gitdesktop/worktrees/pr-7"],
    ["C:/repos/demo/", [MAIN], "pr-7", ".gitdesktop/worktrees/pr-7"],
    // A case-differing spelling of main gets the absolute form: same folder.
    [
      "c:/repos/demo/",
      [MAIN],
      "pr-7",
      "C:/repos/demo/.gitdesktop/worktrees/pr-7",
    ],
    [
      "C:/Repos/Demo",
      [MAIN],
      "pr-7",
      "C:/repos/demo/.gitdesktop/worktrees/pr-7",
    ],
    [
      "C:/repos/demo-linked",
      [MAIN, row({ path: "C:/repos/demo-linked", isMain: false })],
      "pr-7",
      "C:/repos/demo/.gitdesktop/worktrees/pr-7",
    ],
    [
      "C:/repos/demo-linked",
      [
        row({ path: "C:\\repos\\demo\\" }),
        row({ path: "C:/repos/demo-linked", isMain: false }),
      ],
      "pr-7",
      "C:/repos/demo/.gitdesktop/worktrees/pr-7",
    ],
    [
      "C:/repos/demo-linked",
      [MAIN, row({ path: "C:/repos/demo-linked", isMain: false })],
      "",
      "",
    ],
    [REPO, undefined, "pr-7", null],
    [REPO, undefined, "", null],
    ["C:/repos/app-wt", [BARE_MAIN], "pr-7", "C:/repos/app.git-pr-7"],
    [REPO, [], "feat/login", "C:/repos/demo-feat-login"],
  ])("%j with %j and leaf %j defaults to %j", (repoPath, rows, leaf, want) => {
    expect(deriveDefaultWorktreePath(repoPath, rows, leaf)).toBe(want);
  });

  // A linked checkout whose path differs from main's only by case.
  const caseRows = [
    row({ path: "/tmp/Repo" }),
    row({ path: "/tmp/repo", isMain: false }),
  ];
  // The volume's case rule is unknowable here, so a case-only match anchors
  // under main on every platform: right on both volume types.
  it.each<[string, boolean, boolean]>([
    ["Linux", false, false],
    ["macOS (either APFS flavor)", false, true],
    ["Windows", true, true],
  ])(
    "a case-only match on %s takes the absolute default",
    (_label, windows, caseInsensitive) => {
      expect(
        deriveDefaultWorktreePath("/tmp/repo", caseRows, "pr-7", {
          windows,
          caseInsensitive,
        }),
      ).toBe("/tmp/Repo/.gitdesktop/worktrees/pr-7");
    },
  );

  it("an exact match keeps the relative default", () => {
    expect(
      deriveDefaultWorktreePath("/tmp/Repo/", caseRows, "pr-7", {
        windows: false,
        caseInsensitive: true,
      }),
    ).toBe(".gitdesktop/worktrees/pr-7");
  });

  // Off Windows a `\` in a git-reported path is part of a folder name.
  it.each<[string, string, UserWorktree[], string]>([
    [
      "a linked checkout named team\\repo is not main's team/repo",
      "/tmp/team\\repo",
      [
        row({ path: "/tmp/team/repo" }),
        row({ path: "/tmp/team\\repo", isMain: false }),
      ],
      "/tmp/team/repo/.gitdesktop/worktrees/pr-7",
    ],
    [
      "a main with a backslash anchors under it verbatim",
      "/tmp/linked",
      [
        row({ path: "/tmp/a\\b/repo/" }),
        row({ path: "/tmp/linked", isMain: false }),
      ],
      "/tmp/a\\b/repo/.gitdesktop/worktrees/pr-7",
    ],
    [
      "a bare main's sibling splits on / only",
      "/tmp/wt",
      [row({ path: "/tmp/a\\b.git", head: "", branch: "", isDetached: false })],
      "/tmp/a\\b.git-pr-7",
    ],
  ])("on POSIX %s", (_label, repoPath, rows, want) => {
    for (const caseInsensitive of [false, true])
      expect(
        deriveDefaultWorktreePath(repoPath, rows, "pr-7", {
          windows: false,
          caseInsensitive,
        }),
      ).toBe(want);
  });

  it.each<[string, UserWorktree, boolean]>([
    ["a bare main", BARE_MAIN, true],
    ["a detached main", row({ isDetached: true, branch: "" }), false],
    // Null oid at SHA-256 width; isBareMainRow is width-free (oid-width guard).
    ["an unborn main", row({ head: "0".repeat(64), branch: "main" }), false],
    [
      "a non-main row with no head or branch",
      row({ isMain: false, head: "", branch: "" }),
      false,
    ],
  ])("isBareMainRow: %s is %s", (_name, w, want) => {
    expect(isBareMainRow(w)).toBe(want);
  });
});
