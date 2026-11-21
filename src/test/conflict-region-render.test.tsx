import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ConflictFileView } from "@/features/repository/ConflictFileView";
import { getSecret, gitStatus } from "@/lib/git/api";
import {
  type ConflictSides,
  conflictSides,
  resolveConflict,
} from "@/lib/git/conflict";
import type { RepoStatus } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

// A passthrough spy on highlight.js: the count of whole-text passes is what a
// re-mount costs, and identity or render counts can't be asserted under the
// React Compiler.
const hl = vi.hoisted(() => ({
  highlight: null as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock("highlight.js/lib/common", async (importOriginal) => {
  const mod = await importOriginal<typeof import("highlight.js/lib/common")>();
  const real = mod.default;
  hl.highlight = vi.fn((code: string, options: { language: string }) =>
    real.highlight(code, options),
  );
  return { default: { ...real, highlight: hl.highlight } };
});
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  getSecret: vi.fn(),
  gitStatus: vi.fn(),
}));
vi.mock("@/lib/git/conflict", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/conflict")>()),
  conflictSides: vi.fn(),
  resolveConflict: vi.fn(),
}));

const REPO = "C:/repos/demo";
const PATH = "src/lib.rs";

/** A realistic chunk of Rust, repeated to reach a size. */
const CHUNK = `/// Returns the sum of the values that pass the filter.
pub fn total(values: &[u64], keep: impl Fn(u64) -> bool) -> u64 {
    values.iter().copied().filter(|v| keep(*v)).sum()
}
`;

function region(n: number): string {
  return `<<<<<<< HEAD\nlet ours_${n} = ${n};\n=======\nlet theirs_${n} = ${n};\n>>>>>>> topic\n`;
}

/** Five regions, each between distinct context blocks. */
function fiveRegions(): string {
  let text = "";
  for (let n = 1; n <= 5; n++) text += `fn ctx_${n}() {}\n${region(n)}`;
  return `${text}fn tail() {}\n`;
}

/** One region inside context padded to about `chars` characters. */
function sized(chars: number): string {
  const repeat = CHUNK.repeat(Math.ceil(chars / CHUNK.length / 2));
  return `${repeat}${region(1)}${repeat}`;
}

const sides = (working: string): ConflictSides => ({
  working,
  base: "fn a() {}\n",
  ours: "fn a() { 1 }\n",
  theirs: "fn a() { 2 }\n",
  aiIgnored: { ignored: false, unreadable: false },
  workingExists: true,
  workingUndecodable: false,
  undecodable: false,
  workingHash: `h${working.length}`,
  workingMatchesSurvivor: null,
});

let disk: string;

beforeEach(() => {
  disk = fiveRegions();
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
  vi.mocked(getSecret).mockImplementation(async () => null);
  vi.mocked(conflictSides).mockImplementation(async () => sides(disk));
  vi.mocked(resolveConflict).mockImplementation(async (_r, _p, content) => {
    disk = content;
    return { kind: "written" };
  });
  vi.mocked(gitStatus).mockImplementation(
    async (): Promise<RepoStatus> => ({
      branch: {} as RepoStatus["branch"],
      entries: [{ path: PATH, staged: "conflicted", unstaged: "conflicted" }],
    }),
  );
  useUiStore.setState(useUiStore.getInitialState(), true);
  useUiStore.setState({ repoPath: REPO });
  useConfirm.setState({ request: null, requestHold: null });
});

afterEach(() => {
  useConfirm.getState().answer(false);
  // Unmount on the fake clock, before setup.ts's cleanup arms a real gc timer.
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Fakes timeouts and intervals (the poll); rAF stays real for React and Base
 *  UI. waitFor moves the fake clock, detecting it through the jest stub. */
function installFakeClock() {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.stubGlobal("jest", { advanceTimersByTime: vi.advanceTimersByTime });
}

/** The sides reads made while the fake clock moves `ms`. */
async function readsOver(ms: number): Promise<number> {
  const before = vi.mocked(conflictSides).mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  return vi.mocked(conflictSides).mock.calls.length - before;
}

afterAll(() => expect(unmockedCommands).toEqual([]));

function renderView() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const sink = createRef<HTMLDivElement>();
  const view = render(
    <QueryClientProvider client={client}>
      <div ref={sink} tabIndex={-1} />
      <ConflictFileView repoPath={REPO} path={PATH} focusSink={sink} />
    </QueryClientProvider>,
  );
  return { client, container: view.container };
}

/** The first region's Accept current, once the mount's read has landed. */
async function firstAcceptCurrent() {
  const [button] = await screen.findAllByRole("button", {
    name: "Accept current",
  });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
}

describe("the region view's render cost stays bounded", () => {
  it("AC4: a file over 400,000 characters renders plain", async () => {
    disk = sized(500_000);
    expect(disk.length).toBeGreaterThan(400_000);
    const { container } = renderView();
    await firstAcceptCurrent();
    expect(container.querySelector(".gd-code")).toBeNull();
    expect(hl.highlight).not.toHaveBeenCalled();
    expect(container.textContent).toContain("pub fn total(values");
  });

  it("AC4: a file under the budget highlights", async () => {
    disk = sized(300_000);
    expect(disk.length).toBeLessThan(400_000);
    const { container } = renderView();
    await firstAcceptCurrent();
    expect(container.querySelector(".gd-code")).not.toBeNull();
    expect(hl.highlight).toHaveBeenCalled();
  });

  it("AC5: accepting the first region re-highlights only the merged context", async () => {
    renderView();
    const button = await firstAcceptCurrent();
    // Six contexts plus two sides per region.
    expect(hl.highlight).toHaveBeenCalledTimes(16);
    hl.highlight.mockClear();
    await userEvent.setup().click(button);
    await screen.findByText("Conflict 1 of 4");
    await waitFor(async () => expect(await firstAcceptCurrent()).toBeEnabled());
    expect(resolveConflict).toHaveBeenCalledTimes(1);
    expect(hl.highlight).toHaveBeenCalledTimes(1);
    expect(hl.highlight.mock.calls[0][0]).toBe(
      "fn ctx_1() {}\nlet ours_1 = 1;\nfn ctx_2() {}",
    );
  });

  it("S3-1: a small file polls every 2 s", async () => {
    installFakeClock();
    renderView();
    await firstAcceptCurrent();
    expect(await readsOver(6_100)).toBe(3);
  });

  it("S3-1: a file whose versions pass 256,000 characters polls every 10 s", async () => {
    installFakeClock();
    disk = sized(300_000);
    renderView();
    await firstAcceptCurrent();
    expect(await readsOver(9_900)).toBe(0);
    expect(await readsOver(200)).toBe(1);
  });

  it("AC6: a settled resolve leaves the mutation cache", async () => {
    const { client } = renderView();
    const button = await firstAcceptCurrent();
    await userEvent.setup().click(button);
    await screen.findByText("Conflict 1 of 4");
    expect(resolveConflict).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(client.getMutationCache().getAll()).toEqual([]));
  });
});
