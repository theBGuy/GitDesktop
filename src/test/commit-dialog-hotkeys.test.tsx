import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { CommitDialog } from "@/features/commit/CommitDialog";
import { hasLiveHandler } from "@/lib/hotkeys/handler-registry";
import { useHotkeysListener } from "@/lib/hotkeys/hotkeys";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

// CommitDialog with its real useCommitSubmit; the reads and writes under it are
// stubbed at their hook seams. jsdom is not macOS: mod is Ctrl.
const REPO = "C:/repo";
const commitWrite = vi.hoisted(() =>
  vi.fn(async () => ({ hash: "abcdef1234567", raced: null })),
);
const generate = vi.hoisted(() => vi.fn());
let sidebarCollapsed = false;

vi.mock("@/lib/git/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/queries")>()),
  useRepoStatus: () => ({
    data: {
      branch: { name: "main", oid: "1111111" },
      entries: [{ path: "a.txt", staged: "modified", unstaged: null }],
    },
  }),
  useCommit: () => ({ mutateAsync: commitWrite, isPending: false }),
  useWorkingLineStats: () => ({ data: undefined }),
  refuseWhilePinnedBranchPushes: () => false,
}));
vi.mock("@/lib/branch-rules/queries", () => ({
  useEffectiveBranchRules: () => ({}),
  useEffectiveBranchRulesSettling: () => false,
}));
vi.mock("@/lib/branch-rules/match", () => ({
  requiresPullRequest: () => false,
}));
vi.mock("@/features/commit/useGenerateCommitMessage", () => ({
  useGenerateCommitMessage: () => ({
    generate,
    cancel: () => undefined,
    generating: false,
  }),
}));
vi.mock("@/features/commit/CoAuthorPicker", () => ({
  CoAuthorPicker: () => null,
}));
vi.mock("@/lib/automations/runner", () => ({
  triggerAutomations: () => undefined,
}));
vi.mock("@/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics")>()),
  track: () => undefined,
}));
vi.mock("@/lib/settings/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/queries")>()),
  useAiEnabled: () => true,
  useAiConfigured: () => true,
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));

beforeEach(() => {
  sidebarCollapsed = false;
  commitWrite.mockClear();
  generate.mockClear();
  vi.mocked(loadSettings).mockImplementation(async () => ({
    ...structuredClone(DEFAULT_SETTINGS),
    sidebarCollapsed,
  }));
  useUiStore.setState(useUiStore.getInitialState(), true);
  act(() => useUiStore.setState({ repoTab: "changes" }));
});

/** After the mount: the hook loads the branch's draft on mount, which would
 *  replace a title typed before it. */
const typeTitle = () =>
  act(() => useUiStore.getState().setCommitTitle("Fix the thing"));

afterEach(() => {
  act(() => useUiStore.setState(useUiStore.getInitialState(), true));
});

afterAll(() => expect(unmockedCommands).toEqual([]));

function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function Listener() {
  useHotkeysListener();
  return null;
}

function OtherDialog({ open }: { open: boolean }) {
  return (
    <Dialog open={open}>
      <DialogContent>
        <DialogTitle>Other dialog</DialogTitle>
        <DialogDescription>Body</DialogDescription>
      </DialogContent>
    </Dialog>
  );
}

function ui(other: boolean) {
  return (
    <Providers>
      <Listener />
      <CommitDialog repoPath={REPO} />
      <OtherDialog open={other} />
    </Providers>
  );
}

/** Presses `keys` (user-event syntax) at the focused element; whether the
 *  app listener left the main key's keydown default-prevented. */
async function press(keys: string) {
  let prevented: boolean | undefined;
  const spy = (e: KeyboardEvent) => {
    if (e.key !== "Control") prevented = e.defaultPrevented;
  };
  window.addEventListener("keydown", spy);
  try {
    await userEvent.setup().keyboard(keys);
  } finally {
    window.removeEventListener("keydown", spy);
  }
  return prevented;
}
const modEnter = () => press("{Control>}{Enter}{/Control}");
const modG = () => press("{Control>}g{/Control}");

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

describe("CommitDialog's own chords", () => {
  it("M11 open: the generate chord runs Generate and Mod+Enter commits once", async () => {
    act(() => useUiStore.getState().openCommitDialog());
    render(ui(false));
    await screen.findByRole("dialog", { name: "Commit" });
    typeTitle();
    expect(await modG()).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await modEnter()).toBe(true);
    await waitFor(() => expect(commitWrite).toHaveBeenCalledTimes(1));
    await settle();
    expect(commitWrite).toHaveBeenCalledTimes(1);
  });

  it("M11 open with a second dialog over it: neither chord runs", async () => {
    act(() => useUiStore.getState().openCommitDialog());
    const { rerender } = render(ui(false));
    await screen.findByRole("dialog", { name: "Commit" });
    typeTitle();
    rerender(ui(true));
    await screen.findByText("Other dialog");
    await modG();
    await modEnter();
    await settle();
    expect(generate).not.toHaveBeenCalled();
    expect(commitWrite).not.toHaveBeenCalled();
  });

  it("M11 closed with the fallback arm on: commits with no dialog, nothing under another dialog", async () => {
    sidebarCollapsed = true;
    const { rerender } = render(ui(true));
    await screen.findByText("Other dialog");
    await waitFor(() => expect(loadSettings).toHaveBeenCalled());
    await settle();
    typeTitle();
    await modEnter();
    await settle();
    expect(commitWrite).not.toHaveBeenCalled();
    rerender(ui(false));
    await waitFor(() => expect(screen.queryByText("Other dialog")).toBeNull());
    await modEnter();
    await waitFor(() => expect(commitWrite).toHaveBeenCalledTimes(1));
  });

  it("M11 closed, no dialog: both actions still hold a live handler", async () => {
    render(ui(false));
    await settle();
    typeTitle();
    expect(hasLiveHandler("commit")).toBe(true);
    expect(hasLiveHandler("generate-commit-message")).toBe(true);
    await modEnter();
    await settle();
    expect(commitWrite).not.toHaveBeenCalled();
  });
});
