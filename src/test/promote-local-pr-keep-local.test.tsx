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
import { forgeStatus, gitBranches } from "@/lib/git/api";
import { repoKeys } from "@/lib/git/queries";
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
}));
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

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <PromoteLocalPrDialog
        repoPath={REPO}
        pr={PR}
        open
        onOpenChange={() => undefined}
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
