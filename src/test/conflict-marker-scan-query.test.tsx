import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictFileView } from "@/features/repository/ConflictFileView";
import { refusedReadFlag } from "@/features/repository/conflict-read-refusal";
import { getSecret, gitStage, gitStatus } from "@/lib/git/api";
import {
  conflictMarkerScan,
  conflictSides,
  type MarkerScan,
} from "@/lib/git/conflict";
import {
  MARKER_SCAN_TIMED_OUT,
  TOO_LARGE_REFUSAL,
} from "@/lib/git/conflict-prefilter";
import {
  refreshRepoOnFocus,
  useConflictMarkerScan,
  useMarkConflictResolved,
} from "@/lib/git/queries";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  getSecret: vi.fn(),
  gitStage: vi.fn(),
  gitStatus: vi.fn(),
}));
vi.mock("@/lib/git/conflict", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/conflict")>()),
  conflictSides: vi.fn(),
  conflictMarkerScan: vi.fn(),
}));

const REPO = "C:/repos/demo";
const PATH = "src/big.rs";
const BASE = "big.rs";

const SCAN_MARKED: MarkerScan = { exists: true, markers: true, binary: false };
const SCAN_CLEAN: MarkerScan = { exists: true, markers: false, binary: false };
/** The scan's spent budget and an ordinary io failure, as the wire sends them. */
const TIMED_OUT = { kind: "io", message: `io error: ${MARKER_SCAN_TIMED_OUT}` };
const DENIED = { kind: "io", message: "io error: Access is denied." };
const MARKERS_SENTENCE = "It still has conflict markers";

beforeEach(() => {
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
  vi.mocked(conflictSides).mockImplementation(async () => {
    throw {
      kind: "invalidArgument",
      message: `invalid argument: ${TOO_LARGE_REFUSAL}`,
    };
  });
  vi.mocked(conflictMarkerScan).mockReset();
  vi.mocked(getSecret).mockImplementation(async () => null);
  vi.mocked(gitStatus).mockImplementation(async () => ({
    branch: {} as never,
    entries: [{ path: PATH, staged: "conflicted", unstaged: "conflicted" }],
  }));
  vi.mocked(gitStage).mockImplementation(async () => undefined);
  useUiStore.setState(useUiStore.getInitialState(), true);
  useUiStore.setState({ repoPath: REPO });
  useConfirm.setState({ request: null, requestHold: null });
});

afterAll(() => expect(unmockedCommands).toEqual([]));

const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

/** A scan answer the test settles by hand. */
function deferredScan() {
  let resolve: (scan: MarkerScan) => void = () => undefined;
  const promise = new Promise<MarkerScan>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("the too-large strip's marker scan", () => {
  it("a window refocus re-scans, so markers removed outside the app stop being reported", async () => {
    let scan = SCAN_MARKED;
    vi.mocked(conflictMarkerScan).mockImplementation(async () => scan);
    const client = newClient();
    render(
      <QueryClientProvider client={client}>
        <ConflictFileView repoPath={REPO} path={PATH} />
      </QueryClientProvider>,
    );
    const button = await screen.findByRole("button", { name: "Mark resolved" });
    const strip = button.parentElement as HTMLElement;
    await waitFor(() => expect(strip.textContent).toContain(MARKERS_SENTENCE));
    scan = SCAN_CLEAN;
    refreshRepoOnFocus(client);
    await waitFor(() =>
      expect(strip.textContent).not.toContain(MARKERS_SENTENCE),
    );
    expect(conflictMarkerScan).toHaveBeenCalledTimes(2);
  });

  it("a conflict write settles without waiting on the scan, which re-reads after it", async () => {
    const later = deferredScan();
    vi.mocked(conflictMarkerScan)
      .mockImplementationOnce(async () => SCAN_MARKED)
      .mockImplementation(() => later.promise);
    const client = newClient();
    const { result } = renderHook(
      () => ({
        scan: useConflictMarkerScan(REPO, PATH, true),
        write: useMarkConflictResolved(REPO),
      }),
      { wrapper: wrapperFor(client) },
    );
    await waitFor(() => expect(result.current.scan.isSuccess).toBe(true));
    const settled = await Promise.race([
      result.current.write.mutateAsync(PATH).then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("waiting on the scan"), 1000)),
    ]);
    expect(settled).toBe("resolved");
    expect(gitStage).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(conflictMarkerScan).toHaveBeenCalledTimes(2));
    expect(result.current.scan.isFetching).toBe(true);
    later.resolve(SCAN_CLEAN);
    await waitFor(() => expect(result.current.scan.data).toEqual(SCAN_CLEAN));
  });

  it.each([
    ["a timed-out scan is not retried", TIMED_OUT, 1],
    ["an ordinary io failure retries once", DENIED, 2],
  ])("%s", async (_, error, calls) => {
    vi.mocked(conflictMarkerScan).mockRejectedValue(error);
    const { result } = renderHook(
      () => useConflictMarkerScan(REPO, PATH, true),
      { wrapper: wrapperFor(newClient()) },
    );
    await waitFor(() => expect(result.current.isError).toBe(true), {
      timeout: 2000,
    });
    expect(conflictMarkerScan).toHaveBeenCalledTimes(calls);
  });
});

describe("refusedReadFlag over a too-large refusal", () => {
  const tooLarge = {
    kind: "invalidArgument",
    message: `invalid argument: ${TOO_LARGE_REFUSAL}`,
  };

  it("a timed-out scan keeps the too-large cause", async () => {
    vi.mocked(conflictMarkerScan).mockRejectedValue(TIMED_OUT);
    await expect(
      refusedReadFlag(REPO, PATH, BASE, tooLarge),
    ).resolves.toStrictEqual({
      name: BASE,
      unchecked: true,
      cause: "tooLarge",
    });
  });

  it.each([
    ["an io failure", DENIED],
    ["another kind", { kind: "git", message: "fatal: bad object" }],
    ["a non-AppError", new Error("boom")],
  ])("%s carries no cause", async (_, error) => {
    vi.mocked(conflictMarkerScan).mockRejectedValue(error);
    await expect(
      refusedReadFlag(REPO, PATH, BASE, tooLarge),
    ).resolves.toStrictEqual({ name: BASE, unchecked: true });
  });
});
