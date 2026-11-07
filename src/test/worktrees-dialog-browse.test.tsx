import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreesDialog } from "@/features/repository/WorktreesDialog";
import {
  composePickedPath,
  deriveSiblingPath,
  isAbsolutePath,
} from "@/features/repository/worktree-paths";
import { listUserWorktrees, type UserWorktree } from "@/lib/git/worktree";
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
  it("derives the sibling path exactly as the shared helper does", async () => {
    const { user, branch, folder } = await openCreate();
    await setBranch(user, branch, "feat/login");
    expect(folder.value).toBe(deriveSiblingPath(REPO, "feat/login"));
    expect(folder.value).toBe("C:/repos/demo-feat-login");
  });

  it("a pick becomes the parent and the leaf keeps following the branch", async () => {
    const { user, branch, folder, browse } = await openCreate();
    await setBranch(user, branch, "feat/login");
    vi.mocked(openDialog).mockResolvedValue("D:\\picked");
    await user.click(browse);
    await waitFor(() => expect(folder.value).toBe("D:/picked/demo-feat-login"));
    // Browse never latches the field: a branch edit re-derives the leaf.
    await setBranch(user, branch, "fix/x");
    expect(folder.value).toBe("D:/picked/demo-fix-x");
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
      await waitFor(() =>
        expect(folder.value).toBe("D:/reviews/demo-feat-login"),
      );
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
    expect(folder.value).toBe("C:/repos/demo-feat-login");
  });
  it("a pick before any branch keeps the field empty until a leaf derives", async () => {
    const { user, branch, folder, browse } = await openCreate();
    vi.mocked(openDialog).mockResolvedValue("D:/picked");
    await user.click(browse);
    await waitFor(() => expect(openDialog).toHaveBeenCalled());
    expect(folder.value).toBe("");
    await setBranch(user, branch, "feat/login");
    expect(folder.value).toBe("D:/picked/demo-feat-login");
  });
});
