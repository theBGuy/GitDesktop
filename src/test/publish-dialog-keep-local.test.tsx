import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
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
import { PublishDialog } from "@/features/repository/PublishDialog";
import { gitBranches, gitStatus } from "@/lib/git/api";
import type { Branch, BranchHead } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
// The publish callee is reached only through its spy: publish-hold-routes lets
// no file but its one hook import it by name.
const publishRepo = vi.hoisted(() => vi.fn());
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitStatus: vi.fn(),
  gitBranches: vi.fn(),
  forgePublishRepo: publishRepo,
}));
// The publish key carries the repo identity; one table answers both reads.
vi.mock("@/lib/git/repo-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/repo-identity")>()),
  peekRepoIdentity: (path: string) => (path === REPO ? ID : undefined),
  repoIdentityStrict: (path: string) =>
    path === REPO ? Promise.resolve(ID) : new Promise<string>(() => undefined),
}));

const REPO = "C:/repos/spike";
const ID = "C:/repos/spike/.git";
const KEPT_REASON =
  "spike/x is kept local. Turn off Keep local in the branch menu to publish this repository.";

afterAll(() => expect(unmockedCommands).toEqual([]));

const row = (name: string, keepLocal: boolean): Branch => ({
  name,
  isCurrent: false,
  upstream: null,
  lastCommitDate: "2026-11-01T10:00:00Z",
  archived: false,
  upstreamAhead: 0,
  upstreamBehind: 0,
  upstreamGone: false,
  upstreamRemote: null,
  upstreamRemoteRef: null,
  keepLocal,
  upstreamIsRemoteDefault: false,
});

const head = (name: string | null): BranchHead => ({
  name,
  detached: name === null,
  oid: "abcdef0123456789abcdef0123456789abcdef01",
  upstream: null,
  ahead: 0,
  behind: 0,
  upstreamGone: false,
  upstreamRemote: null,
  upstreamBranch: null,
  pushNameMismatch: false,
  upstreamIsRemoteDefault: null,
  pushRemote: null,
  pushBranch: null,
});

/** HEAD on `headName` (null = detached) over a list where only `spike/x` is
 *  marked Keep local. */
function renderDialog(headName: string | null) {
  vi.mocked(gitStatus).mockResolvedValue({
    branch: head(headName),
    entries: [],
  });
  vi.mocked(gitBranches).mockResolvedValue([
    row("spike/x", true),
    row("main", false),
  ]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <PublishDialog
        repoPath={REPO}
        provider="gitlab"
        defaultName="spike"
        open
        onOpenChange={() => undefined}
      />
    </QueryClientProvider>,
  );
}

const submit = () => screen.getByRole("button", { name: "Publish" });
// Both reads answered and react-query's notify flushed, so a release row reads
// the settled render rather than the moment before the branch list landed.
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
  publishRepo.mockImplementation(() => new Promise(() => undefined));
  useUiStore.setState({ repoPath: REPO });
});
afterEach(() => onlineManager.setOnline(true));

describe("Publish repository dialog under Keep local", () => {
  it("a kept-local HEAD holds the submit with its reason, a typed name too", async () => {
    const user = userEvent.setup();
    renderDialog("spike/x");
    await waitFor(() =>
      expect(submit()).toHaveAccessibleDescription(KEPT_REASON),
    );
    expect(submit()).toHaveAttribute("aria-disabled", "true");
    const name = screen.getByRole("textbox", { name: /name/i });
    await user.clear(name);
    await user.type(name, "spike-repo{Enter}");
    await user.click(submit());
    expect(submit()).toHaveAccessibleDescription(KEPT_REASON);
    expect(publishRepo).not.toHaveBeenCalled();
  });

  it("the Keep local reason outranks the offline one", async () => {
    onlineManager.setOnline(false);
    renderDialog("spike/x");
    await waitFor(() =>
      expect(submit()).toHaveAccessibleDescription(KEPT_REASON),
    );
    expect(submit()).toHaveAttribute("aria-disabled", "true");
  });

  it("an unmarked HEAD is not held by it", async () => {
    renderDialog("main");
    await waitFor(() => expect(gitBranches).toHaveBeenCalled());
    await settle();
    expect(submit()).not.toHaveAttribute("aria-disabled");
    expect(submit()).not.toHaveAccessibleDescription(KEPT_REASON);
  });

  it("a detached HEAD is not held by it", async () => {
    renderDialog(null);
    await waitFor(() => expect(gitBranches).toHaveBeenCalled());
    await settle();
    expect(submit()).not.toHaveAttribute("aria-disabled");
    expect(submit()).not.toHaveAccessibleDescription(KEPT_REASON);
  });
});
