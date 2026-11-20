import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { toast } from "sonner";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { CreateIssueDialog } from "@/features/issues/CreateIssueDialog";
import { forgeIssueCreate } from "@/lib/git/api";
import { remotesOptions } from "@/lib/git/queries";
import type { RemoteLens } from "@/lib/git/types";
import {
  cachedLensVerdict,
  cachedRepoLens,
  lensKey,
} from "@/lib/repo-lens/queries";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
// Every read the open dialog reaches (forge status, remote URL, remotes,
// labels, milestones, issue types, write access, token scopes) stays pending,
// so the lens caches seeded below are the only answers (an empty remotes cache
// stays empty); the create is driven by hand. The afterAll proves the list.
vi.mock("@/lib/git/api", async (importOriginal) => {
  const pending = () => new Promise(() => undefined);
  return {
    ...(await importOriginal<typeof import("@/lib/git/api")>()),
    forgeStatus: vi.fn(pending),
    gitRemoteUrl: vi.fn(pending),
    gitRemotes: vi.fn(pending),
    forgeRepoLabels: vi.fn(pending),
    forgeMilestones: vi.fn(pending),
    ghIssueTypes: vi.fn(pending),
    forgeRepoWriteAccess: vi.fn(pending),
    ghTokenScopes: vi.fn(pending),
    forgeIssueCreate: vi.fn(),
  };
});
vi.mock("@/lib/attachments/use-attachment-support", () => ({
  useAttachmentSupport: () => null,
}));
vi.mock("@/features/issues/useGenerateIssueDraft", () => ({
  useGenerateIssueDraft: () => ({
    generate: vi.fn(async () => undefined),
    cancel: vi.fn(),
    generating: false,
  }),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sonner")>()),
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}));

const REPO = "C:/repo";
const URL_12 = "https://github.com/parent/repo/issues/12";
const selectIssue = vi.fn();

beforeEach(() => {
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(forgeIssueCreate).mockReset();
  vi.mocked(toast.success).mockClear();
  selectIssue.mockClear();
  useUiStore.setState({ repoPath: REPO, selectIssue });
});

afterEach(() => cleanup());
afterAll(() => expect(unmockedCommands).toEqual([]));

/** A GitHub fork whose gated lens follows the stored choice; without
 *  `remotes` the remotes cache stays empty, so the lens has no verdict. */
function seedFork(client: QueryClient, lens: RemoteLens, remotes = true) {
  client.setQueryData(["repo", REPO, "forge-status"], {
    provider: "github",
    authenticated: true,
  });
  if (remotes)
    client.setQueryData(remotesOptions(REPO).queryKey, ["origin", "upstream"]);
  client.setQueryData(lensKey(REPO), lens);
}

type Controls = {
  setOpen: (open: boolean) => void;
  setLens: (lens: RemoteLens) => void;
};

function Harness({
  controls,
  initialLens,
}: {
  controls: Controls;
  initialLens: RemoteLens;
}) {
  const [open, setOpen] = useState(true);
  const [lens, setLens] = useState<RemoteLens>(initialLens);
  controls.setOpen = setOpen;
  controls.setLens = setLens;
  return (
    <CreateIssueDialog
      repoPath={REPO}
      lens={lens}
      open={open}
      onOpenChange={setOpen}
      host="issues-panel"
    />
  );
}

type HoldOptions = {
  /** The surface's lens at mount (default "upstream"). */
  mount?: RemoteLens;
  /** The stored lens choice (default: the mount lens). */
  stored?: RemoteLens;
  /** Whether the remotes cache holds an answer (default true). */
  remotes?: boolean;
  /** A lens switch made after mount and before submit. */
  switchFirst?: RemoteLens;
};

/** Submits a create under the surface's lens and holds it until `settle`. */
async function holdCreate(options: HoldOptions = {}) {
  const mount = options.mount ?? "upstream";
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  seedFork(client, options.stored ?? mount, options.remotes ?? true);
  let answer: (v: { number: number; url: string }) => void = () => undefined;
  vi.mocked(forgeIssueCreate).mockReturnValue(
    new Promise((res) => {
      answer = res;
    }),
  );
  const controls: Controls = {
    setOpen: () => undefined,
    setLens: () => undefined,
  };
  render(
    <QueryClientProvider client={client}>
      <Harness controls={controls} initialLens={mount} />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getAllByRole("textbox", { name: "Title" })[0], {
    target: { value: "A new issue" },
  });
  const switchLens = (lens: RemoteLens) =>
    act(() => {
      client.setQueryData(lensKey(REPO), lens);
      controls.setLens(lens);
    });
  if (options.switchFirst !== undefined) switchLens(options.switchFirst);
  const submitLens = options.switchFirst ?? mount;
  // The upstream lens names its target, still loading here (gitRemoteUrl pends).
  const name =
    submitLens === "upstream"
      ? "Create in the upstream repository"
      : "Create issue";
  const submit = screen.getByRole("button", { name });
  expect(submit).toBeEnabled();
  fireEvent.click(submit);
  await waitFor(() => expect(forgeIssueCreate).toHaveBeenCalled());
  // The user closes the dialog while the create runs, as Esc would.
  act(() => controls.setOpen(false));
  return {
    client,
    /** Switch the surface's lens, as the Fork/Upstream switcher does. */
    switchLens,
    settle: async () => {
      await act(async () => answer({ number: 12, url: URL_12 }));
      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith(
          "Opened issue #12",
          expect.objectContaining({ description: URL_12 }),
        ),
      );
    },
  };
}

describe("a create's settle opens the new issue only under its own lens", () => {
  it("skips the select when the lens moved off the submit-time lens", async () => {
    const run = await holdCreate();
    run.switchLens("origin");
    await run.settle();
    expect(selectIssue).not.toHaveBeenCalled();
  });

  it("still selects when the lens is unchanged", async () => {
    const run = await holdCreate();
    await run.settle();
    expect(selectIssue).toHaveBeenCalledWith({ kind: "remote", id: "12" });
  });

  it("creates under a lens switched to before submit, and selects under it", async () => {
    const run = await holdCreate({ mount: "upstream", switchFirst: "origin" });
    // The lens is forgeIssueCreate's eighth argument.
    expect(vi.mocked(forgeIssueCreate).mock.calls[0][7]).toBe("origin");
    await run.settle();
    expect(selectIssue).toHaveBeenCalledWith({ kind: "remote", id: "12" });
  });

  it("skips the select while the lens has no verdict, even when its default matches", async () => {
    // Stored "upstream" with no remotes answer: the gated read defaults to
    // "origin" (the submit lens) while the verdict is still open.
    const run = await holdCreate({
      mount: "origin",
      stored: "upstream",
      remotes: false,
    });
    expect(cachedRepoLens(run.client, REPO)).toBe("origin");
    expect(cachedLensVerdict(run.client, REPO)).toBeNull();
    await run.settle();
    expect(selectIssue).not.toHaveBeenCalled();
  });
});
