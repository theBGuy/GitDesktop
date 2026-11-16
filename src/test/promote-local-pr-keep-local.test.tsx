import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { PromoteLocalPrDialog } from "@/features/pulls/PromoteLocalPrDialog";
import { keptLocalPromoteReason } from "@/features/repository/keep-local-copy";
import {
  BRANCH_PUSHED_FAILED_LEAD,
  mayHaveLanded,
  presentError,
} from "@/lib/error-summary";
import { forgePrComment, forgeStatus, gitBranches } from "@/lib/git/api";
import { prChecksRecheck, repoKeys } from "@/lib/git/queries";
import { recheckRunsAfterPush } from "@/lib/git/queries/push-writes";
import type { Branch } from "@/lib/git/types";
import { OFFLINE_WRITE_REASON } from "@/lib/offline-writes";
import { type LocalPr, updateLocalPr } from "@/lib/pulls/local";
import { usePrCreateStore } from "@/lib/stores/pr-create";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

// The create's push api is spied, never imported: only useCreatePr may name it
// (scripts/publish-hold-routes.test.mjs).
const forgePrCreate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitBranches: vi.fn(),
  // Never answered: the noun stays "pull request" and nothing gates on it.
  forgeStatus: vi.fn(() => new Promise(() => undefined)),
  forgePrCreate,
  forgePrComment: vi.fn(async () => ({ failedAttachments: [] })),
  pathIsDir: vi.fn(async () => true),
}));
// A failed create's notification keys its mute on the repo's identity.
vi.mock("@/lib/git/repo-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/repo-identity")>()),
  repoIdentity: async (repo: string) => repo,
}));
// Spied through; a case overrides the predicate by identity, so no Rust sentence
// is spelled here (its meaning is pinned where it is defined).
vi.mock("@/lib/error-summary", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/error-summary")>();
  return { ...real, mayHaveLanded: vi.fn(real.mayHaveLanded) };
});
// Spied through to the real arm, so the call's PR checks reads can be read.
vi.mock("@/lib/git/queries/push-writes", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/lib/git/queries/push-writes")>();
  return { ...real, recheckRunsAfterPush: vi.fn(real.recheckRunsAfterPush) };
});
vi.mock("@/lib/pulls/local", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pulls/local")>()),
  updateLocalPr: vi.fn(),
}));

const REPO = "C:/repo";
const C_PROMOTE = keptLocalPromoteReason("feat");

const PR: LocalPr = {
  id: "pr-1",
  title: "Feature",
  body: "",
  base: "main",
  head: "feat",
  status: "open",
  approved: false,
  labels: [],
  comments: [],
  createdAt: "2026-11-01T00:00:00Z",
};

const row = (name: string, keepLocal: boolean) =>
  ({ name, isCurrent: false, archived: false, keepLocal }) as Branch;

function renderDialog(
  props: { pr?: LocalPr; onOpenChange?: (open: boolean) => void } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <PromoteLocalPrDialog
        repoPath={REPO}
        pr={props.pr ?? PR}
        open
        onOpenChange={props.onOpenChange ?? (() => undefined)}
      />
    </QueryClientProvider>,
  );
  return client;
}

const publishButton = () =>
  // Unanchored: the running spinner leads the name with its own label.
  screen.getByRole("button", { name: /Publish to / });

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ repoPath: REPO });
  usePrCreateStore.setState({ byRepo: {} });
  vi.mocked(forgeStatus).mockReturnValue(new Promise(() => undefined));
  vi.mocked(gitBranches).mockResolvedValue([
    row("main", false),
    row("feat", true),
  ]);
  vi.spyOn(toast, "info").mockImplementation(() => "");
});

afterEach(() => {
  act(() => onlineManager.setOnline(true));
  vi.restoreAllMocks();
});

afterAll(() => {
  expect(unmockedCommands).toEqual([]);
});

describe("PromoteLocalPrDialog with a kept-local head", () => {
  it("holds Publish with the reason, and a press never closes the local PR", async () => {
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() =>
      expect(publishButton()).toHaveAccessibleDescription(C_PROMOTE),
    );
    expect(publishButton()).toHaveAttribute("aria-disabled", "true");
    await user.click(publishButton());
    expect(updateLocalPr).not.toHaveBeenCalled();
    expect(forgePrCreate).not.toHaveBeenCalled();
  });

  it("shows the reason as a visible line that is Publish's description, once", async () => {
    renderDialog();
    await waitFor(() =>
      expect(publishButton()).toHaveAccessibleDescription(C_PROMOTE),
    );
    const lines = screen.getAllByText(C_PROMOTE);
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line).toBeVisible();
    expect(line).not.toHaveClass("sr-only");
    expect(
      publishButton().getAttribute("aria-describedby")?.split(" "),
    ).toEqual([line.id]);
  });

  it("outranks offline", async () => {
    renderDialog();
    await waitFor(() =>
      expect(publishButton()).toHaveAccessibleDescription(C_PROMOTE),
    );
    act(() => onlineManager.setOnline(false));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(publishButton()).toHaveAccessibleDescription(C_PROMOTE);
    expect(screen.queryByText(OFFLINE_WRITE_REASON)).toBeNull();
  });

  it("an unmarked head is not held by it", async () => {
    vi.mocked(gitBranches).mockResolvedValue([
      row("main", false),
      row("feat", false),
    ]);
    renderDialog();
    await waitFor(() => expect(gitBranches).toHaveBeenCalled());
    expect(publishButton()).not.toHaveAttribute("aria-disabled");
    expect(publishButton()).not.toHaveAccessibleDescription(C_PROMOTE);
  });

  it("while its own promote runs, the running reason shows, not Keep local", async () => {
    vi.mocked(gitBranches).mockResolvedValue([
      row("main", false),
      row("feat", false),
    ]);
    // The local close never answers, so the run stays in flight.
    vi.mocked(updateLocalPr).mockReturnValue(new Promise(() => undefined));
    const user = userEvent.setup();
    const client = renderDialog();
    await waitFor(() => expect(gitBranches).toHaveBeenCalled());
    await user.click(publishButton());
    await waitFor(() => expect(updateLocalPr).toHaveBeenCalledTimes(1));

    // The head is marked while the run is in flight.
    vi.mocked(gitBranches).mockResolvedValue([
      row("main", false),
      row("feat", true),
    ]);
    await act(() =>
      client.invalidateQueries({ queryKey: repoKeys.branches(REPO) }),
    );
    expect(gitBranches).toHaveBeenCalledTimes(2);
    expect(
      client
        .getQueryData<Branch[]>(repoKeys.branches(REPO))
        ?.some((b) => b.name === "feat" && b.keepLocal),
    ).toBe(true);
    // react-query notifies observers on a scheduled tick after the fetch.
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(publishButton()).toHaveAccessibleDescription(
      "Creating the pull request…",
    );
    expect(screen.queryByText(C_PROMOTE)).toBeNull();
    expect(toast.info).not.toHaveBeenCalled();
  });
});

describe("PromoteLocalPrDialog over a PR whose number couldn't be read", () => {
  it.each([
    {
      variant: "with comments to carry",
      comments: [{ id: "c1", body: "Carry me", createdAt: PR.createdAt }],
      title:
        "Opened pull request, but its number couldn't be read. Its comments weren't carried over and the local pull request isn't linked to it.",
    },
    {
      variant: "with no comments",
      comments: [],
      title:
        "Opened pull request, but its number couldn't be read. The local pull request isn't linked to it.",
    },
  ])(
    "warns it opened $variant, links, comments on and selects nothing, and re-reads the lens's checks",
    async ({ comments, title: expected }) => {
      const url = "https://github.com/me/project/pull/new";
      vi.mocked(gitBranches).mockResolvedValue([
        row("main", false),
        row("feat", false),
      ]);
      vi.mocked(updateLocalPr).mockResolvedValue({ ...PR, status: "closed" });
      forgePrCreate.mockResolvedValue({ number: 0, url });
      const success = vi.spyOn(toast, "success").mockImplementation(() => "");
      const warning = vi.spyOn(toast, "warning").mockImplementation(() => "");
      const onOpenChange = vi.fn();
      useUiStore.setState({ selectedPr: { kind: "local", id: PR.id } });
      const user = userEvent.setup();
      renderDialog({ pr: { ...PR, comments }, onOpenChange });
      await waitFor(() => expect(gitBranches).toHaveBeenCalled());
      await user.click(publishButton());
      await waitFor(() => expect(warning).toHaveBeenCalledTimes(1));
      expect(success).not.toHaveBeenCalled();
      const [title, options] = warning.mock.calls[0];
      expect(title).toBe(expected);
      expect(options).toMatchObject({
        description: url,
        action: { label: "View" },
      });
      // The local close is the only local write: no back-link follows it.
      expect(updateLocalPr).toHaveBeenCalledTimes(1);
      expect(forgePrComment).not.toHaveBeenCalled();
      expect(recheckRunsAfterPush).toHaveBeenCalledWith(
        expect.anything(),
        REPO,
        prChecksRecheck(REPO, "origin"),
      );
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(useUiStore.getState().selectedPr).toEqual({
        kind: "local",
        id: PR.id,
      });
    },
  );
});

describe("PromoteLocalPrDialog when the create and the reopen both fail (T29)", () => {
  const rejection = { kind: "timeout", message: "may have landed" };
  const REOPEN = "The local PR couldn't be reopened — reopen it from its view.";

  /** The close lands, the forge create rejects, the reopen rejects too. */
  async function failBoth(rejected: unknown = rejection) {
    vi.mocked(gitBranches).mockResolvedValue([
      row("main", false),
      row("feat", false),
    ]);
    vi.mocked(updateLocalPr)
      .mockResolvedValueOnce({ ...PR, status: "closed" })
      .mockRejectedValueOnce(new Error("reopen refused"));
    forgePrCreate.mockRejectedValueOnce(rejected);
    const error = vi.spyOn(toast, "error").mockImplementation(() => "");
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => expect(gitBranches).toHaveBeenCalled());
    await user.click(publishButton());
    await waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(updateLocalPr).toHaveBeenCalledTimes(2);
    return error.mock.calls[0] as [string, { description?: string }];
  }

  it("titles the toast with the error alone when the write may have landed", async () => {
    vi.mocked(mayHaveLanded).mockImplementation((e) => e === rejection);
    const [title, options] = await failBoth();
    expect(title).toBe(presentError(rejection).summary);
    expect(options.description).toBe(REOPEN);
  });

  it("says the pull request wasn't created when the write can't have landed", async () => {
    vi.mocked(mayHaveLanded).mockImplementation(() => false);
    const [title, options] = await failBoth();
    expect(title).toBe(
      `Couldn't create the pull request: ${presentError(rejection).summary}`,
    );
    expect(options.description).toBe(REOPEN);
  });

  it("titles the toast with the pushed-branch line alone after the push landed", async () => {
    vi.mocked(mayHaveLanded).mockImplementation(() => false);
    const pushed = {
      kind: "gh",
      message: `${BRANCH_PUSHED_FAILED_LEAD}pull request failed: HTTP 422`,
    };
    const [title, options] = await failBoth(pushed);
    expect(title).toBe(presentError(pushed).summary);
    expect(title.startsWith(BRANCH_PUSHED_FAILED_LEAD)).toBe(true);
    expect(options.description).toBe(REOPEN);
  });
});
