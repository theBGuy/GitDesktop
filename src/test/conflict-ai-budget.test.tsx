import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { toast } from "sonner";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictFileView } from "@/features/repository/ConflictFileView";
import { ConflictResolveView } from "@/features/repository/ConflictResolveView";
import { buildConflictPrompt } from "@/lib/ai/conflict-prompt";
import { aiExcludePatterns } from "@/lib/ai/ignore";
import { getSecret, gitStatus, readRepoInstructions } from "@/lib/git/api";
import { type ConflictSides, conflictSides } from "@/lib/git/conflict";
import {
  BINARY_REFUSAL,
  TOO_LARGE_REFUSAL,
} from "@/lib/git/conflict-prefilter";
import type { RepoStatus } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { useConflictResolve } from "@/lib/stores/conflict-resolve";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  getSecret: vi.fn(),
  gitStatus: vi.fn(),
  readRepoInstructions: vi.fn(),
}));
vi.mock("@/lib/git/conflict", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/conflict")>()),
  conflictSides: vi.fn(),
}));
vi.mock("@/lib/ai/ignore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/ignore")>()),
  aiExcludePatterns: vi.fn(),
}));
// The stream hook reaches CLI agents and fetch; stable functions, since the
// view's teardown effect keys on `cancel`.
const stream = vi.hoisted(() => ({
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
    text: "",
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

const REPO = "C:/repos/demo";
const PATH = "src/big.json";

/** A sides read rejected exactly as the wire sends it. */
const invalid = (detail: string) => ({
  kind: "invalidArgument" as const,
  message: `invalid argument: ${detail}`,
});
const TOO_LARGE = invalid(TOO_LARGE_REFUSAL);
const BINARY = invalid(BINARY_REFUSAL);
const IO = { kind: "io" as const, message: "io error: permission denied" };

const MARKERS = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\n";
const SIDES: ConflictSides = {
  working: `a\n${MARKERS}`,
  base: "a\nbase\n",
  ours: "a\nours\n",
  theirs: "a\ntheirs\n",
  aiIgnored: { ignored: false, unreadable: false },
  workingExists: true,
  workingUndecodable: false,
  undecodable: false,
  workingHash: "h1",
  workingMatchesSurvivor: null,
};
/** A conflicted working file of exactly `n` UTF-16 code units. */
const workingOf = (n: number) => `${"x".repeat(n - MARKERS.length)}${MARKERS}`;

const COPY = {
  gate: "This file is too large to send to a model whole, so it isn't sent. Resolve it in the conflict editor, or in your own editor.",
  tooLarge:
    "This file is too large to show or to send to a model. Take a side with Accept all current or Accept all incoming, or resolve it in your editor, then Mark resolved.",
  binary:
    "This looks like a binary file, so there's no text for a model to merge. Take a side with Accept all current or Accept all incoming, or resolve it in your editor, then Mark resolved.",
  aiHeld:
    "Too large for AI: a version of this file is over 80,000 characters. Resolve it region by region instead.",
  aiHeldWhole:
    "Too large for AI: a version of this file is over 80,000 characters.",
  excluded: /matches your AI ignore patterns/,
};

beforeEach(() => {
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
  vi.mocked(conflictSides).mockReset();
  vi.mocked(getSecret).mockImplementation(async () => "sk-test-000000");
  vi.mocked(readRepoInstructions).mockImplementation(async () => null);
  vi.mocked(aiExcludePatterns).mockImplementation(async () => []);
  vi.mocked(gitStatus).mockImplementation(
    async (): Promise<RepoStatus> => ({
      branch: {} as RepoStatus["branch"],
      entries: [{ path: PATH, staged: "conflicted", unstaged: "conflicted" }],
    }),
  );
  stream.run.mockReset();
  stream.run.mockImplementation(async () => false);
  useUiStore.setState(useUiStore.getInitialState(), true);
  useUiStore.setState({ repoPath: REPO });
  useConflictResolve.setState(useConflictResolve.getInitialState(), true);
});

afterAll(() => expect(unmockedCommands).toEqual([]));

function newClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, structuredClone(DEFAULT_SETTINGS));
  client.setQueryData(settingsKeys.secret("anthropic"), {
    length: 14,
    masked: "sk-tes...0000",
  });
  return client;
}

/** Renders the resolve view; `sink()` is its own focus sink, the first child
 *  of its root. */
function renderResolve() {
  const view = render(
    <QueryClientProvider client={newClient()}>
      <ConflictResolveView repoPath={REPO} path={PATH} />
    </QueryClientProvider>,
  );
  const sink = () => {
    const el = view.container.querySelector(".ph-no-capture")
      ?.firstElementChild as HTMLElement | null;
    expect(el?.tagName).toBe("SPAN");
    expect(el).toHaveAttribute("tabindex", "-1");
    return el as HTMLElement;
  };
  return { sink };
}

const tryAgain = () => screen.queryByRole("button", { name: /Try again/ });

describe("buildConflictPrompt", () => {
  const input = (sides: ConflictSides) => ({
    path: PATH,
    sides,
    repoInstructions: null,
    globalInstructions: "",
  });

  it("sends every version whole at the budget, never a truncation note", () => {
    const at = "y".repeat(80_000);
    const { prompt } = buildConflictPrompt(
      input({ ...SIDES, working: at, ours: at, theirs: at, base: at }),
    );
    expect(prompt).not.toMatch(/truncated/);
    expect(prompt.split(at)).toHaveLength(5);
  });

  it.each(["working", "ours", "theirs", "base"] as const)(
    "throws when %s is over the budget",
    (side) => {
      expect(() =>
        buildConflictPrompt(input({ ...SIDES, [side]: "z".repeat(80_001) })),
      ).toThrow(/prompt budget/);
    },
  );
});

describe("ConflictResolveView's prompt budget", () => {
  it("at exactly 80,000 code units the file goes to the model", async () => {
    vi.mocked(conflictSides).mockResolvedValue({
      ...SIDES,
      working: workingOf(80_000),
    });
    renderResolve();
    await waitFor(() => expect(stream.run).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(COPY.gate)).not.toBeInTheDocument();
  });

  it.each([
    ["a working file of 80,001", { working: workingOf(80_001) }],
    [
      "a modify/delete whose survivor is 90,000",
      { working: "", ours: null, theirs: "t".repeat(90_000) },
    ],
    ["astral text of 80,002", { base: "\u{1F600}".repeat(40_001) }],
  ])("%s blocks before any model call", async (_, over) => {
    vi.mocked(conflictSides).mockResolvedValue({ ...SIDES, ...over });
    renderResolve();
    expect(await screen.findByText(COPY.gate)).toBeInTheDocument();
    expect(tryAgain()).not.toBeInTheDocument();
    expect(stream.run).not.toHaveBeenCalled();
    expect(readRepoInstructions).not.toHaveBeenCalled();
  });
});

describe("ConflictResolveView on a refused sides read", () => {
  it.each([
    ["too large", TOO_LARGE, COPY.tooLarge],
    ["binary", BINARY, COPY.binary],
  ] as const)(
    "a %s refusal blocks with its copy, no toast and no Try again, focus on the sink",
    async (_, refusal, copy) => {
      // The press that reaches it: Try again after a failure that could heal.
      vi.mocked(conflictSides)
        .mockRejectedValueOnce(IO)
        .mockRejectedValueOnce(refusal);
      const view = renderResolve();
      const retry = await screen.findByRole("button", { name: /Try again/ });
      expect(toast.error).toHaveBeenCalledTimes(1);
      await userEvent.setup().click(retry);
      expect(await screen.findByText(copy)).toBeInTheDocument();
      expect(screen.queryByText(COPY.excluded)).not.toBeInTheDocument();
      expect(tryAgain()).not.toBeInTheDocument();
      expect(toast.error).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(view.sink());
      expect(stream.run).not.toHaveBeenCalled();
    },
  );

  it("an unclassified failure keeps its toast and Try again", async () => {
    vi.mocked(conflictSides).mockRejectedValue(IO);
    renderResolve();
    expect(
      await screen.findByRole("button", { name: /Try again/ }),
    ).toBeEnabled();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(COPY.tooLarge)).not.toBeInTheDocument();
    expect(screen.queryByText(COPY.excluded)).not.toBeInTheDocument();
  });
});

describe("Resolve all's prefilter", () => {
  it("queues only the file within the budget and counts the rest", async () => {
    const paths = ["small.ts", "big.json", "huge.log", "logo.png"];
    vi.mocked(conflictSides).mockImplementation(async (_repo, path) => {
      switch (path) {
        case "small.ts":
          return SIDES;
        case "big.json":
          return { ...SIDES, working: workingOf(300_000) };
        case "huge.log":
          throw TOO_LARGE;
        default:
          throw BINARY;
      }
    });
    act(() => useConflictResolve.getState().startAll(paths, REPO));
    await waitFor(() =>
      expect(useConflictResolve.getState().activePath).toBe("small.ts"),
    );
    expect(useConflictResolve.getState().queue).toEqual([]);
    expect(toast.info).toHaveBeenCalledWith(
      "Resolving 1 of 4 files with AI. Skipped 3 files: 1 is binary, 2 are too large for AI.",
    );
  });
});

describe("ConflictFileView's Resolve with AI", () => {
  function renderFile() {
    const sink = createRef<HTMLDivElement>();
    render(
      <QueryClientProvider client={newClient()}>
        <div ref={sink} tabIndex={-1} />
        <ConflictFileView repoPath={REPO} path={PATH} focusSink={sink} />
      </QueryClientProvider>,
    );
  }

  it("holds over a 300 KB file with regions with the budget's reason", async () => {
    vi.mocked(conflictSides).mockResolvedValue({
      ...SIDES,
      working: `${"x".repeat(300_000)}\n${MARKERS}`,
    });
    renderFile();
    const button = await screen.findByRole("button", {
      name: "Resolve with AI",
    });
    await screen.findAllByRole("button", { name: "Accept current" });
    await waitFor(() =>
      expect(button).toHaveAccessibleDescription(COPY.aiHeld),
    );
    expect(button).toHaveAttribute("aria-disabled", "true");
  });

  it("holds an arm without regions with the budget's first sentence only", async () => {
    // The current side removed the file and the incoming one grew it past the
    // budget: a deletion arm, with no regions to point at.
    vi.mocked(conflictSides).mockResolvedValue({
      ...SIDES,
      ours: null,
      theirs: "y".repeat(90_000),
      working: "y".repeat(90_000),
    });
    renderFile();
    const button = await screen.findByRole("button", {
      name: "Resolve with AI",
    });
    await waitFor(() =>
      expect(button).toHaveAccessibleDescription(COPY.aiHeldWhole),
    );
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.queryByRole("button", { name: "Accept current" }),
    ).not.toBeInTheDocument();
  });

  it("stays enabled over a small file", async () => {
    vi.mocked(conflictSides).mockResolvedValue(SIDES);
    renderFile();
    const button = await screen.findByRole("button", {
      name: "Resolve with AI",
    });
    await screen.findAllByRole("button", { name: "Accept current" });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-disabled", "true");
    expect(button).not.toHaveAccessibleDescription(COPY.aiHeld);
  });
});
