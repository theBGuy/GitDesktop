import { beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/last-checkout/subscribe";
import { useUiStore } from "@/lib/stores/ui";

// The module registers its subscription once, at import.
const h = vi.hoisted(() => ({
  record: vi.fn<(repo: string) => Promise<void>>(async () => undefined),
  ready: vi.fn<() => Promise<void>>(async () => undefined),
}));

vi.mock("@/lib/last-checkout/store", () => ({
  recordLastCheckout: (repo: string) => h.record(repo),
  lastCheckoutReady: () => h.ready(),
}));

// Read before the config clears mock calls between tests.
const readyCallsAtImport = h.ready.mock.calls.length;

beforeEach(() => {
  useUiStore.setState({ repoPath: null });
  h.record.mockClear();
});

describe("last-checkout subscription", () => {
  it("starts the shared startup load once, at import", () => {
    expect(readyCallsAtImport).toBe(1);
  });

  it("records one write per landing on a new path", () => {
    useUiStore.setState({ repoPath: "C:/repos/a" });
    useUiStore.setState({ repoPath: "C:/repos/b" });
    expect(h.record.mock.calls).toEqual([["C:/repos/a"], ["C:/repos/b"]]);
  });

  it("skips a close and a change that leaves the path alone", () => {
    useUiStore.setState({ repoPath: "C:/repos/a" });
    useUiStore.setState({ repoPath: "C:/repos/a" });
    useUiStore.setState({
      interactionEpoch: useUiStore.getState().interactionEpoch + 1,
    });
    useUiStore.setState({ repoPath: null });
    expect(h.record.mock.calls).toEqual([["C:/repos/a"]]);
  });
});
