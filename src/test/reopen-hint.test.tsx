import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDENTITY_TTL_MS } from "@/lib/git/repo-identity";
import type { UserWorktree } from "@/lib/git/worktree";
import { useReopenHint } from "@/lib/last-checkout/hint";
import type { LastCheckoutEntry } from "@/lib/last-checkout/store";

// The snapshot is module state behind useSyncExternalStore; the mock keeps the
// same contract (a stable array replaced on write, then a notify).
const h = vi.hoisted(() => ({
  records: [] as readonly LastCheckoutEntry[],
  listeners: new Set<() => void>(),
  ready: vi.fn<() => Promise<void>>(),
  list: vi.fn<
    (repo: string, opts?: { prune?: boolean }) => Promise<UserWorktree[]>
  >(),
  hung: [] as ((e: Error) => void)[],
  // The identity memo per EXACT key, with each answer's age.
  memo: new Map<string, { identity: string; ageMs: number }>(),
}));

vi.mock("@/lib/last-checkout/store", () => ({
  getLastCheckoutSnapshot: () => h.records,
  lastCheckoutReady: () => h.ready(),
  subscribeLastCheckout: (listener: () => void) => {
    h.listeners.add(listener);
    return () => {
      h.listeners.delete(listener);
    };
  },
}));
vi.mock("@/lib/git/identity-memo", () => ({
  ttlMemo: () => ({
    get: () =>
      Promise.reject(new Error("the memo's resolve is not under test")),
    peek: (key: string) => h.memo.get(key)?.identity,
    within: (key: string, maxAgeMs: number) => {
      const hit = h.memo.get(key);
      return hit && hit.ageMs < maxAgeMs ? hit.identity : undefined;
    },
  }),
}));
vi.mock("@/lib/git/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/worktree")>()),
  listUserWorktrees: (repo: string, opts?: { prune?: boolean }) =>
    h.list(repo, opts),
}));

const MAIN = "C:\\repos\\demo";
const WT = "C:/repos/demo-wt";
const WT2 = "C:/repos/demo-hotfix";
const OTHER = "C:\\repos\\other";

const entry = (extra: Partial<LastCheckoutEntry> = {}): LastCheckoutEntry => ({
  identity: "C:/repos/demo/.git",
  path: WT,
  mainPath: "C:/repos/demo",
  at: 1,
  ...extra,
});

function wt(path: string, isMain = false): UserWorktree {
  return {
    path,
    branch: "b",
    head: "a".repeat(40),
    isMain,
    isDetached: false,
    isLocked: false,
    lockReason: "",
    lastActivityMs: null,
  };
}

function setRecords(next: readonly LastCheckoutEntry[]) {
  act(() => {
    h.records = next;
    for (const listener of h.listeners) listener();
  });
}

type Props = { rowPath: string; currentPath: string | null; hold: boolean };

function render(initialProps: Props) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    ({ rowPath, currentPath, hold }: Props) =>
      useReopenHint(rowPath, currentPath, hold),
    { initialProps, wrapper },
  );
}

const idle: Props = { rowPath: MAIN, currentPath: null, hold: false };

beforeEach(() => {
  h.records = [entry()];
  h.listeners.clear();
  h.memo.clear();
  h.ready.mockReset();
  h.ready.mockResolvedValue(undefined);
  h.list.mockReset();
  // Unanswered by default. The peek read's concurrency limiter is module state,
  // so afterEach fails every read still out, or its slot would outlive the test.
  h.list.mockImplementation(
    () => new Promise((_resolve, reject) => h.hung.push(reject)),
  );
});

afterEach(async () => {
  while (h.hung.length > 0) {
    for (const fail of h.hung.splice(0)) fail(new Error("test over"));
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
});

describe("useReopenHint", () => {
  it("retries a failed startup load when it mounts over an empty snapshot", () => {
    h.records = [];
    render(idle);
    expect(h.ready).toHaveBeenCalledOnce();
  });

  it("leaves a loaded snapshot alone", () => {
    render(idle);
    expect(h.ready).not.toHaveBeenCalled();
  });

  it("ranks a record stamped past the slack below a trusted one", () => {
    h.records = [
      entry({
        identity: "C:/repos/demo-alias/.git",
        path: WT2,
        at: Date.now() + 2 * 24 * 60 * 60 * 1000,
      }),
      entry(),
    ];
    const { result } = render(idle);
    expect(result.current).toEqual({ path: WT, name: "demo-wt" });
  });

  it("shows the record before any worktree list answers", () => {
    const { result } = render(idle);
    expect(result.current).toEqual({ path: WT, name: "demo-wt" });
  });

  it("keeps the hint while the list names the worktree", async () => {
    h.list.mockResolvedValue([wt("C:/repos/demo", true), wt(WT)]);
    const { result } = render(idle);
    await waitFor(() => expect(h.list).toHaveBeenCalled());
    await act(async () => undefined);
    expect(result.current).toEqual({ path: WT, name: "demo-wt" });
  });

  it("reads the list without pruning, since painting a row is no act", async () => {
    render(idle);
    await waitFor(() => expect(h.list).toHaveBeenCalled());
    expect(h.list.mock.calls).toStrictEqual([[MAIN, { prune: false }]]);
  });

  it("hides once an answered list proves the worktree gone", async () => {
    h.list.mockResolvedValue([wt("C:/repos/demo", true)]);
    const { result } = render(idle);
    await waitFor(() => expect(result.current).toBeNull());
  });

  it("keeps the hint when the list read fails", async () => {
    h.list.mockRejectedValue(new Error("git failed"));
    const { result } = render(idle);
    await waitFor(() => expect(h.list).toHaveBeenCalled());
    await act(async () => undefined);
    expect(result.current).toEqual({ path: WT, name: "demo-wt" });
  });

  it("is null, with no list read, when the worktree is the open checkout", async () => {
    const { result } = render({ ...idle, currentPath: "c:\\Repos\\Demo-WT" });
    await act(async () => undefined);
    expect(result.current).toBeNull();
    expect(h.list).not.toHaveBeenCalled();
  });

  it("is null for the open repo's own row", async () => {
    const { result } = render({ ...idle, currentPath: "c:/repos/DEMO" });
    await act(async () => undefined);
    expect(result.current).toBeNull();
  });

  it("reads no worktree list for a row without a record", async () => {
    const { result } = render({ ...idle, rowPath: OTHER });
    await act(async () => undefined);
    expect(result.current).toBeNull();
    expect(h.list).not.toHaveBeenCalled();
  });

  it("reads no worktree list for a row whose record is main", async () => {
    h.records = [entry({ path: "C:/repos/demo" })];
    const { result } = render(idle);
    await act(async () => undefined);
    expect(result.current).toBeNull();
    expect(h.list).not.toHaveBeenCalled();
  });

  it("freezes across record writes while held and releases after", () => {
    const { result, rerender } = render(idle);
    rerender({ ...idle, hold: true });
    setRecords([entry({ path: WT2, at: 2 })]);
    expect(result.current).toEqual({ path: WT, name: "demo-wt" });
    setRecords([entry({ path: "C:/repos/demo", at: 3 })]);
    expect(result.current).toEqual({ path: WT, name: "demo-wt" });
    rerender(idle);
    expect(result.current).toBeNull();
  });

  it("latches its first value when it mounts already held", () => {
    const { result } = render({ ...idle, hold: true });
    setRecords([entry({ path: WT2, at: 2 })]);
    expect(result.current).toEqual({ path: WT, name: "demo-wt" });
  });

  it("re-latches when a held row is re-targeted to another repo", () => {
    h.records = [
      entry(),
      entry({
        identity: "C:/repos/other/.git",
        path: "C:/repos/other-wt",
        mainPath: "C:/repos/other",
      }),
    ];
    const { result, rerender } = render({ ...idle, hold: true });
    rerender({ ...idle, rowPath: OTHER, hold: true });
    expect(result.current).toEqual({
      path: "C:/repos/other-wt",
      name: "other-wt",
    });
  });
});

describe("useReopenHint latching and list edges", () => {
  it("re-latches on a hold edge after the record changed while idle", () => {
    const { result, rerender } = render(idle);
    setRecords([entry({ path: WT2, at: 2 })]);
    rerender({ ...idle, hold: true });
    setRecords([entry({ path: "C:/repos/demo-third", at: 3 })]);
    expect(result.current?.path).toBe(WT2);
    rerender(idle);
    expect(result.current?.path).toBe("C:/repos/demo-third");
    rerender({ ...idle, hold: true });
    setRecords([entry({ path: "C:/repos/demo-fourth", at: 4 })]);
    expect(result.current?.path).toBe("C:/repos/demo-third");
    rerender(idle);
    expect(result.current?.path).toBe("C:/repos/demo-fourth");
  });

  it.each<[string, UserWorktree[]]>([
    ["names a different main", [wt("C:/repos/elsewhere", true), wt(WT)]],
    ["names no main", [wt(WT)]],
  ])("hides once an answered list %s", async (_name, list) => {
    h.list.mockResolvedValue(list);
    const { result } = render(idle);
    await waitFor(() => expect(result.current).toBeNull());
  });

  it("is null for an empty row path and reads no list", async () => {
    h.records = [entry({ mainPath: "" })];
    const { result } = render({ ...idle, rowPath: "" });
    await act(async () => undefined);
    expect(result.current).toBeNull();
    expect(h.list).not.toHaveBeenCalled();
  });
});

describe("useReopenHint memo agreement", () => {
  const FOREIGN = "C:/elsewhere/foreign/.git";

  it("is null, with no list read, when the memo names another repo for the path", () => {
    h.memo.set(WT, { identity: FOREIGN, ageMs: 0 });
    const { result } = render(idle);
    expect(result.current).toBeNull();
    expect(h.list).not.toHaveBeenCalled();
  });

  it("keeps the hint when the memo agrees up to case and slashes", () => {
    h.memo.set(WT, { identity: "c:\\REPOS\\demo\\.git", ageMs: 0 });
    const { result } = render(idle);
    expect(result.current).toEqual({ path: WT, name: "demo-wt" });
  });

  it("is null when the contradiction is one ms inside the TTL", () => {
    h.memo.set(WT, { identity: FOREIGN, ageMs: IDENTITY_TTL_MS - 1 });
    const { result } = render(idle);
    expect(result.current).toBeNull();
  });

  it("hides within one tick of the memo turning against it", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const { result } = render(idle);
      expect(result.current).toEqual({ path: WT, name: "demo-wt" });
      h.memo.set(WT, { identity: FOREIGN, ageMs: 0 });
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(result.current).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the hint when the contradiction is older than the TTL", () => {
    h.memo.set(WT, { identity: FOREIGN, ageMs: IDENTITY_TTL_MS });
    const { result } = render(idle);
    expect(result.current).toEqual({ path: WT, name: "demo-wt" });
  });
});
