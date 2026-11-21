import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ChangesPanel } from "@/features/repository/ChangesPanel";
import {
  forgeStatus,
  getSecret,
  gitDefaultBranch,
  gitOpState,
  gitStage,
  gitStashCount,
  gitStatus,
  gitWorkingLineStats,
} from "@/lib/git/api";
import {
  type ConflictSides,
  conflictMarkerScan,
  conflictSides,
  type MarkerScan,
} from "@/lib/git/conflict";
import {
  BINARY_REFUSAL,
  TOO_LARGE_REFUSAL,
} from "@/lib/git/conflict-prefilter";
import type { FileEntry, RepoStatus } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(),
  getSecret: vi.fn(),
  gitDefaultBranch: vi.fn(),
  gitOpState: vi.fn(),
  gitStage: vi.fn(),
  gitStashCount: vi.fn(),
  gitStatus: vi.fn(),
  gitWorkingLineStats: vi.fn(),
}));
vi.mock("@/lib/git/conflict", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/conflict")>()),
  conflictSides: vi.fn(),
  conflictMarkerScan: vi.fn(),
}));

const REPO = "C:/repos/demo";

/** A sides read rejected exactly as the wire sends it. */
const invalid = (detail: string) => ({
  kind: "invalidArgument" as const,
  message: `invalid argument: ${detail}`,
});
const TOO_LARGE = invalid(TOO_LARGE_REFUSAL);
const BINARY = invalid(BINARY_REFUSAL);

const STAGES = {
  base: "a\n",
  ours: "b\n",
  theirs: "c\n",
  aiIgnored: { ignored: false, unreadable: false },
  workingExists: true,
  workingUndecodable: false,
  undecodable: false,
  workingHash: "h1",
  workingMatchesSurvivor: null,
};
const MARKED: ConflictSides = {
  ...STAGES,
  working: "<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> topic\n",
};

/** Per path: what the sides read rejects with or answers, and the scan's
 *  answer (an object without `exists` is a rejection). */
let reads: Record<string, ConflictSides | object>;
let scans: Record<string, MarkerScan | object>;
let entries: FileEntry[];

const conflictedEntry = (path: string): FileEntry =>
  ({ path, staged: "conflicted", unstaged: "conflicted" }) as FileEntry;

beforeEach(() => {
  reads = {};
  scans = {};
  entries = [];
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
  vi.mocked(conflictSides).mockImplementation(async (_repo, path) => {
    const read = reads[path];
    if (read !== undefined && "working" in read) return read as ConflictSides;
    throw read;
  });
  vi.mocked(conflictMarkerScan).mockImplementation(async (_repo, path) => {
    const scan = scans[path];
    if (scan !== undefined && "exists" in scan) return scan as MarkerScan;
    throw scan ?? { kind: "io", message: "no scan" };
  });
  vi.mocked(gitStatus).mockImplementation(
    async (): Promise<RepoStatus> => ({
      branch: {} as RepoStatus["branch"],
      entries,
    }),
  );
  vi.mocked(gitStage).mockImplementation(async () => undefined);
  // The panel's other reads, answered as a plain local repo with no forge.
  vi.mocked(forgeStatus).mockRejectedValue({ kind: "io", message: "offline" });
  vi.mocked(getSecret).mockResolvedValue(null);
  vi.mocked(gitDefaultBranch).mockResolvedValue(null);
  vi.mocked(gitOpState).mockResolvedValue({
    merging: true,
    rebasing: false,
    cherryPicking: false,
    reverting: false,
    editPaused: false,
    rebaseStop: null,
  });
  vi.mocked(gitStashCount).mockResolvedValue(0);
  vi.mocked(gitWorkingLineStats).mockResolvedValue({
    staged: [],
    unstaged: [],
  });
  // A laid-out viewport (what the virtualizer reads), so the list renders rows.
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
  useUiStore.setState(useUiStore.getInitialState(), true);
  useUiStore.setState({ repoPath: REPO });
  useConfirm.setState({ request: null, requestHold: null });
});

afterEach(() => {
  useConfirm.getState().answer(false);
  vi.restoreAllMocks();
});

afterAll(() => expect(unmockedCommands).toEqual([]));

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, structuredClone(DEFAULT_SETTINGS));
  render(
    <QueryClientProvider client={client}>
      <ChangesPanel repoPath={REPO} active />
    </QueryClientProvider>,
  );
}

const confirmRequest = () => useConfirm.getState().request;

/** The mixed set: a big clean file, a big marked one, a small marked one and
 *  a small binary one. */
function mixedSet() {
  entries = ["big-clean.lock", "big-marked.json", "small.ts", "logo.png"].map(
    conflictedEntry,
  );
  reads = {
    "big-clean.lock": TOO_LARGE,
    "big-marked.json": TOO_LARGE,
    "small.ts": MARKED,
    "logo.png": BINARY,
  };
  scans = {
    "big-clean.lock": { exists: true, markers: false, binary: false },
    "big-marked.json": { exists: true, markers: true, binary: false },
  };
}

const MIXED_BODY =
  "big-marked.json, small.ts still have conflict markers. logo.png looks like a binary file, so it wasn't checked for conflict markers. Staging them marks those conflicts resolved with any markers in the files, and they'll be committed unless you remove them first.";

describe("the Changes list's stage gate checks too-large files with the scan", () => {
  it("AC2: Stage all asks once, naming only the marked and binary files", async () => {
    mixedSet();
    renderPanel();
    const stageAll = await screen.findByRole("button", { name: "Stage all" });
    await waitFor(() => expect(stageAll).toBeEnabled());
    await userEvent.setup().click(stageAll);
    await waitFor(() => expect(confirmRequest()).not.toBeNull());
    expect(confirmRequest()?.title).toBe(
      "Stage files with possible conflict markers?",
    );
    expect(confirmRequest()?.body).toBe(MIXED_BODY);
    expect(conflictMarkerScan).toHaveBeenCalledTimes(2);
    expect(gitStage).not.toHaveBeenCalled();
    await act(async () => useConfirm.getState().answer(true));
    await waitFor(() => expect(gitStage).toHaveBeenCalledTimes(1));
  });

  it("AC2: a row's stage button on a clean too-large file stages without asking", async () => {
    mixedSet();
    renderPanel();
    const button = await screen.findByRole("button", {
      name: "Stage big-clean.lock",
    });
    await userEvent.setup().click(button);
    await waitFor(() => expect(gitStage).toHaveBeenCalledTimes(1));
    expect(confirmRequest()).toBeNull();
  });

  it("AC2: a row's stage button on a marked too-large file asks the marker question", async () => {
    mixedSet();
    renderPanel();
    const button = await screen.findByRole("button", {
      name: "Stage big-marked.json",
    });
    await userEvent.setup().click(button);
    await waitFor(() => expect(confirmRequest()).not.toBeNull());
    expect(confirmRequest()?.title).toBe(
      "Stage big-marked.json with conflict markers?",
    );
    expect(gitStage).not.toHaveBeenCalled();
  });

  it("AC2: an unclassified read failure keeps the uncaused clause", async () => {
    entries = [conflictedEntry("odd.txt")];
    reads = { "odd.txt": { kind: "git", message: "fatal: bad object" } };
    renderPanel();
    const button = await screen.findByRole("button", {
      name: "Stage odd.txt",
    });
    await userEvent.setup().click(button);
    await waitFor(() => expect(confirmRequest()).not.toBeNull());
    expect(confirmRequest()?.body).toBe(
      "odd.txt couldn't be checked for conflict markers. Staging it marks the conflict resolved with any markers in the file, and they'll be committed unless you remove them first.",
    );
    expect(conflictMarkerScan).not.toHaveBeenCalled();
  });
});
