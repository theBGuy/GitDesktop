import { beforeEach, describe, expect, it, vi } from "vitest";
import { repoIdentityUnmemoized } from "@/lib/git/repo-identity";
import { invoke } from "@/lib/tauri/invoke";

// The redirect's identity check must reach git on every call. Its export runs
// unmocked here over a mocked IPC seam and a spying memo: an answer routed
// through the memo would come back from the memo's fake, never the invoke.
const h = vi.hoisted(() => ({
  get: vi.fn<(key: string) => Promise<string>>(),
  peek: vi.fn<(key: string) => string | undefined>(),
  within: vi.fn<(key: string, maxAgeMs: number) => string | undefined>(),
}));

vi.mock("@/lib/tauri/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri/invoke")>()),
  invoke: vi.fn(),
}));
vi.mock("@/lib/git/identity-memo", () => ({
  ttlMemo: () => ({ get: h.get, peek: h.peek, within: h.within }),
}));

const PATH = "C:/repos/demo-wt";

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue("C:/repos/demo/.git");
  h.get.mockReset();
  h.get.mockResolvedValue("C:/memo/.git");
  h.peek.mockReset();
  h.within.mockReset();
});

describe("repoIdentityUnmemoized", () => {
  it("answers from git and never touches the memo", async () => {
    await expect(repoIdentityUnmemoized(PATH)).resolves.toBe(
      "C:/repos/demo/.git",
    );
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["git_repo_identity", { repoPath: PATH }],
    ]);
    expect(h.get).not.toHaveBeenCalled();
    expect(h.peek).not.toHaveBeenCalled();
    expect(h.within).not.toHaveBeenCalled();
  });

  it("rejects as the resolver does", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("ipc down"));
    await expect(repoIdentityUnmemoized(PATH)).rejects.toThrow("ipc down");
    expect(h.get).not.toHaveBeenCalled();
  });
});
