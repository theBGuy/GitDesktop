import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps, createRef } from "react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitDiffView as GitDiffViewImpl } from "@/features/diff/DiffSurface";
import { ConflictResolveView } from "@/features/repository/ConflictResolveView";
import { aiExcludePatterns } from "@/lib/ai/ignore";
import { getSecret, readRepoInstructions } from "@/lib/git/api";
import {
  type ConflictSides,
  conflictSides,
  diffContents,
} from "@/lib/git/conflict";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { useConflictResolve } from "@/lib/stores/conflict-resolve";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

// The harness of conflict-accept-arms.test.tsx, reaching phase "ready" on the
// Diff view; the diff view is a stand-in recording what the host hands it.
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  getSecret: vi.fn(),
  readRepoInstructions: vi.fn(),
}));
vi.mock("@/lib/git/conflict", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/conflict")>()),
  conflictSides: vi.fn(),
  resolveConflict: vi.fn(),
  diffContents: vi.fn(),
}));
vi.mock("@/lib/ai/ignore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/ignore")>()),
  aiExcludePatterns: vi.fn(),
}));

const stream = vi.hoisted(() => ({
  text: "",
  run: vi.fn(),
  cancel: vi.fn(),
  reset: vi.fn(),
}));
vi.mock("@/lib/ai/stream", () => ({
  useAiTextStream: () => ({
    run: stream.run,
    cancel: stream.cancel,
    reset: stream.reset,
    generating: false,
    text: stream.text,
    status: "",
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    dismiss: vi.fn(),
  },
}));

type DiffViewProps = ComponentProps<typeof GitDiffViewImpl>;

/** Every `scrollerRef` the diff view stand-in was rendered with. */
const seen = vi.hoisted(() => ({ refs: [] as unknown[] }));
vi.mock("@/features/diff/DiffSurfaceLazy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/diff/DiffSurfaceLazy")>()),
  GitDiffView: (props: DiffViewProps) => {
    seen.refs.push(props.scrollerRef);
    return <div data-testid="diff-view">{props.text}</div>;
  },
}));

const REPO = "C:/repos/demo";
const PATH = "dir/a.txt";
const SIDES: ConflictSides = {
  working:
    "first\n<<<<<<< HEAD\nours line\n=======\ntheirs line\n>>>>>>> topic\nlast\n",
  base: "first\nbase line\nlast\n",
  ours: "first\nours line\nlast\n",
  theirs: "first\ntheirs line\nlast\n",
  aiIgnored: { ignored: false, unreadable: false },
  workingExists: true,
  workingUndecodable: false,
  undecodable: false,
  workingHash: "h1",
  workingMatchesSurvivor: null,
};
const CLEAN = "first\nours line\ntheirs line\nlast\n";
const PREVIEW =
  "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n" +
  "@@ -1,3 +1,4 @@\n first\n ours line\n+theirs line\n last\n";

beforeEach(() => {
  seen.refs = [];
  stream.text = CLEAN;
  stream.run.mockImplementation(async () => true);
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
  vi.mocked(getSecret).mockImplementation(async () => "sk-test-000000");
  vi.mocked(readRepoInstructions).mockImplementation(async () => null);
  vi.mocked(aiExcludePatterns).mockImplementation(async () => []);
  vi.mocked(conflictSides).mockImplementation(async () => SIDES);
  vi.mocked(diffContents).mockResolvedValue(PREVIEW);
  useUiStore.setState(useUiStore.getInitialState(), true);
  useUiStore.setState({ repoPath: REPO });
  useConflictResolve.setState(useConflictResolve.getInitialState(), true);
});

afterAll(() => expect(unmockedCommands).toEqual([]));

describe("the AI conflict resolution's Diff view", () => {
  it("hands the body scroller to the line anchor, one ref object across views", async () => {
    const user = userEvent.setup();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(
      settingsKeys.settings,
      structuredClone(DEFAULT_SETTINGS),
    );
    client.setQueryData(settingsKeys.secret("anthropic"), {
      length: 14,
      masked: "sk-tes...0000",
    });
    const sink = createRef<HTMLDivElement>();
    render(
      <QueryClientProvider client={client}>
        <div ref={sink} tabIndex={-1} />
        <ConflictResolveView repoPath={REPO} path={PATH} focusSink={sink} />
      </QueryClientProvider>,
    );
    await screen.findByTestId("diff-view");
    const body = document.querySelector(".min-h-0.flex-1.overflow-auto");
    expect(body).not.toBeNull();
    const ref = seen.refs[0] as { current: HTMLElement | null } | undefined;
    expect(ref?.current).toBe(body);
    // Another view and back remounts the diff view under the same ref.
    await user.click(screen.getByRole("button", { name: "Proposed" }));
    await user.click(screen.getByRole("button", { name: "Diff" }));
    await screen.findByTestId("diff-view");
    expect(seen.refs.length).toBeGreaterThan(1);
    for (const r of seen.refs) expect(r).toBe(ref);
    expect(ref?.current).toBe(body);
  });
});
