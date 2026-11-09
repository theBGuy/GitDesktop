import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SubmodulesDialog } from "@/features/repository/SubmodulesDialog";
import { claimRepoOpen } from "@/features/repository/useOpenRepoByPath";
import { useOpenSubmoduleAsRepo } from "@/features/repository/useOpenSubmoduleAsRepo";
import { gitSubmodules, validateRepo } from "@/lib/git/api";
import type { RepoInfo } from "@/lib/git/types";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { unmockedCommands } from "./setup";

// The own-root guard folds case and separators only on Windows, and
// `isWindows` is read once at import: jsdom's empty platform reads as not.
vi.mock("@/lib/hotkeys/binding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hotkeys/binding")>()),
  isWindows: true,
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  validateRepo: vi.fn(),
  gitSubmodules: vi.fn(),
}));
vi.mock("@/lib/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/toast")>()),
  toastError: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
const { openByPath } = vi.hoisted(() => ({
  openByPath: vi.fn(async () => undefined),
}));
vi.mock("@/features/repository/useOpenRepoByPath", async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import("@/features/repository/useOpenRepoByPath")
    >();
  return {
    ...real,
    claimRepoOpen: vi.fn(real.claimRepoOpen),
    useOpenRepoByPath: () => openByPath,
  };
});

afterAll(() => {
  expect(unmockedCommands).toEqual([]);
});

const REPO = "C:\\r";
const SUB = "vendor/sub";
const FULL = "C:\\r/vendor/sub";
const NOT_A_REPO = `${SUB} is not a git repository.`;
const info = (root: string): RepoInfo => ({ root, name: "x" });

beforeEach(() => {
  vi.clearAllMocks();
});

function hook(repoPath = REPO) {
  return renderHook(() => useOpenSubmoduleAsRepo(repoPath)).result.current;
}

/** A probe the test settles by hand. */
function heldProbe() {
  let settle!: { resolve: (v: RepoInfo) => void; reject: (e: unknown) => void };
  vi.mocked(validateRepo).mockReturnValue(
    new Promise<RepoInfo>((resolve, reject) => {
      settle = { resolve, reject };
    }),
  );
  return () => settle;
}

describe("useOpenSubmoduleAsRepo", () => {
  it("13: claims before the probe and hands the claim to the open", async () => {
    vi.mocked(validateRepo).mockResolvedValue(info("C:\\r\\vendor\\sub"));
    expect(await hook()(SUB)).toBe(true);
    expect(validateRepo).toHaveBeenCalledExactlyOnceWith(FULL);
    const claim = vi.mocked(claimRepoOpen);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(validateRepo).mock.invocationCallOrder[0],
    );
    expect(openByPath).toHaveBeenCalledExactlyOnceWith(
      FULL,
      "picker",
      claim.mock.results[0].value,
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("13: drops trailing separators off the repository path", async () => {
    vi.mocked(validateRepo).mockResolvedValue(info("C:\\r\\vendor\\sub"));
    await hook("C:\\r\\")(SUB);
    expect(validateRepo).toHaveBeenCalledExactlyOnceWith(FULL);
  });

  it("13: a notARepo rejection names the relative path and opens nothing", async () => {
    vi.mocked(validateRepo).mockRejectedValue({
      kind: "notARepo",
      message: `${FULL} is not a git repository`,
    });
    expect(await hook()(SUB)).toBe(false);
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(NOT_A_REPO);
    expect(toastError).not.toHaveBeenCalled();
    expect(openByPath).not.toHaveBeenCalled();
  });

  it("13: any other rejection reaches toastError and opens nothing", async () => {
    const err = { kind: "io", message: "denied" };
    vi.mocked(validateRepo).mockRejectedValue(err);
    expect(await hook()(SUB)).toBe(false);
    expect(toastError).toHaveBeenCalledExactlyOnceWith(err);
    expect(toast.error).not.toHaveBeenCalled();
    expect(openByPath).not.toHaveBeenCalled();
  });

  it("13: a probe answering with the open repository's own root is no repository", async () => {
    for (const root of ["C:\\r", "C:/r/", "c:\\R", "C:\\r\\"]) {
      vi.clearAllMocks();
      vi.mocked(validateRepo).mockResolvedValue(info(root));
      expect(await hook()(SUB), root).toBe(false);
      expect(toast.error, root).toHaveBeenCalledExactlyOnceWith(NOT_A_REPO);
      expect(openByPath, root).not.toHaveBeenCalled();
    }
  });

  it("13: a press retired while the probe ran does nothing, either way it settles", async () => {
    for (const outcome of ["resolve", "reject"] as const) {
      vi.clearAllMocks();
      const settle = heldProbe();
      const pending = hook()(SUB);
      useUiStore.getState().noteUserInteraction();
      await act(async () => {
        if (outcome === "resolve") settle().resolve(info("C:\\r\\vendor\\sub"));
        else settle().reject({ kind: "notARepo", message: "no" });
      });
      expect(await pending, outcome).toBe(false);
      expect(openByPath, outcome).not.toHaveBeenCalled();
      expect(toast.error, outcome).not.toHaveBeenCalled();
      expect(toastError, outcome).not.toHaveBeenCalled();
    }
  });
});

describe("SubmodulesDialog's Open as repository", () => {
  async function pressOpen() {
    vi.mocked(gitSubmodules).mockResolvedValue([
      {
        path: SUB,
        name: SUB,
        url: "https://example.invalid/sub.git",
        branch: null,
        sha: "a".repeat(40),
        describe: "v1",
        status: "ok",
      },
    ]);
    const onOpenChange = vi.fn();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <SubmodulesDialog
          repoPath={REPO}
          open
          onOpenChange={onOpenChange}
          onModeChange={vi.fn()}
        />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: `Actions for ${SUB}` }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: /Open as repository/ }),
    );
    // Lets the open's probe and its continuation settle.
    await act(async () => undefined);
    return onOpenChange;
  }

  it("13: closes after a successful open", async () => {
    vi.mocked(validateRepo).mockResolvedValue(info("C:\\r\\vendor\\sub"));
    const onOpenChange = await pressOpen();
    expect(openByPath).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("13: stays open after a failed probe and after the walk-up", async () => {
    for (const probe of [
      () =>
        vi
          .mocked(validateRepo)
          .mockRejectedValue({ kind: "notARepo", message: "no" }),
      () => vi.mocked(validateRepo).mockResolvedValue(info("C:/r")),
    ]) {
      vi.clearAllMocks();
      probe();
      const onOpenChange = await pressOpen();
      expect(toast.error).toHaveBeenCalledExactlyOnceWith(NOT_A_REPO);
      expect(openByPath).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
      cleanup();
    }
  });
});
