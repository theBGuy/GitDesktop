import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSyncExternalStore } from "react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ActionsPanel } from "@/features/actions/ActionsPanel";
import { statusFacetLabel } from "@/features/actions/RunFilterChips";
import { STATUS_FACETS } from "@/features/actions/run-filters";
import { statusLabel } from "@/features/actions/status";
import { forgeRepoWriteAccess, forgeStatus, gitStatus } from "@/lib/git/api";
import { repoStatusOptions } from "@/lib/git/queries";
import type { ForgeStatus, RepoStatus } from "@/lib/git/types";
import type { RunFilters, WorkflowRun } from "@/lib/github/actions";
import { dispatchAction } from "@/lib/hotkeys/hotkeys";
import { ACTIONS } from "@/lib/hotkeys/registry";
import { unmockedCommands } from "./setup";

/** What the fake run read answers for one call: undefined = pending. */
type FakeRead =
  | {
      runs: WorkflowRun[];
      totalCount: number | null;
      hasMore?: boolean;
      placeholder?: boolean;
      paused?: boolean;
    }
  | { error: true }
  | undefined;

const fake = vi.hoisted(() => ({
  version: 0,
  listeners: new Set<() => void>(),
  calls: [] as {
    repo: string;
    enabled: boolean;
    filters: Record<string, unknown>;
  }[],
  read: (_repo: string, _filters: Record<string, unknown>): unknown =>
    undefined,
  base: (_repo: string): unknown => undefined,
  workflows: { data: [] as unknown[] | undefined, isPending: false },
  runPages: (..._a: unknown[]): unknown => undefined,
  useWorkflows: (..._a: unknown[]): unknown => undefined,
}));

vi.mock("@/lib/github/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github/actions")>()),
  useWorkflowRunPages: (...a: unknown[]) => fake.runPages(...a),
  useWorkflows: (...a: unknown[]) => fake.useWorkflows(...a),
}));

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(),
  gitStatus: vi.fn(),
  forgeRepoWriteAccess: vi.fn(),
}));

afterAll(() => expect(unmockedCommands).toEqual([]));

function result(r: FakeRead) {
  if (r === undefined)
    return {
      data: undefined,
      isPending: true,
      isSuccess: false,
      isError: false,
      isPaused: false,
      isFetching: true,
      isFetchingNextPage: false,
      isFetchNextPageError: false,
      isPlaceholderData: false,
      hasNextPage: false,
      refetch: vi.fn(),
      fetchNextPage: vi.fn(),
    };
  if ("error" in r)
    return {
      data: undefined,
      isPending: false,
      isSuccess: false,
      isError: true,
      isPaused: false,
      isFetching: false,
      isFetchingNextPage: false,
      isFetchNextPageError: false,
      isPlaceholderData: false,
      hasNextPage: false,
      refetch: vi.fn(),
      fetchNextPage: vi.fn(),
    };
  return {
    data: {
      pages: [{ runs: r.runs, totalCount: r.totalCount, hasMore: !!r.hasMore }],
      pageParams: [1],
    },
    isPending: false,
    isSuccess: true,
    isError: false,
    isPaused: !!r.paused,
    isFetching: !!r.placeholder,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    isPlaceholderData: !!r.placeholder,
    hasNextPage: !!r.hasMore,
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
  };
}

fake.runPages = function useFakeRunPages(...a: unknown[]) {
  const [repo, enabled, , filters] = a as [
    string,
    boolean,
    boolean,
    RunFilters,
  ];
  useSyncExternalStore(
    (l) => {
      fake.listeners.add(l);
      return () => fake.listeners.delete(l);
    },
    () => fake.version,
  );
  const f = { ...filters } as Record<string, unknown>;
  fake.calls.push({ repo, enabled, filters: f });
  return result((enabled ? fake.read(repo, f) : fake.base(repo)) as FakeRead);
};
fake.useWorkflows = function useFakeWorkflows() {
  useSyncExternalStore(
    (l) => {
      fake.listeners.add(l);
      return () => fake.listeners.delete(l);
    },
    () => fake.version,
  );
  return {
    ...fake.workflows,
    isError: false,
    refetch: vi.fn(),
  };
};

function bump() {
  act(() => {
    fake.version++;
    for (const l of fake.listeners) l();
  });
}

function setRead(read: (repo: string, f: Record<string, unknown>) => FakeRead) {
  fake.read = read;
  bump();
}

/** The filters the panel's live (enabled) read was last called with. */
function lastFilters(repo = REPO) {
  const live = fake.calls.filter((c) => c.enabled && c.repo === repo);
  return live[live.length - 1]?.filters;
}

const REPO = "C:/a";
const OTHER = "C:/b";

function forge(provider: "github" | "gitlab" | "bitbucket"): ForgeStatus {
  return {
    provider,
    installed: true,
    authenticated: true,
    repo: "o/r",
    host: `${provider}.com`,
    login: "me",
    capabilities: {},
    implemented: { ci: true, ciDispatch: true, ciRerun: true, ciCancel: true },
  } as unknown as ForgeStatus;
}

const onBranch = (name: string | null) =>
  ({ branch: { name }, entries: [] }) as unknown as RepoStatus;

let nextId = 1;
function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  const id = nextId++;
  return {
    id,
    number: id,
    displayTitle: `Run ${id}`,
    status: "completed",
    conclusion: "success",
    workflowName: "CI",
    headBranch: "main",
    event: "push",
    createdAt: "2026-11-01T00:00:00Z",
    startedAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    url: "",
    headSha: "abc",
    workflowDatabaseId: 1,
    actor: { name: "octo", id: "octo" },
    ...over,
  } as WorkflowRun;
}

const rows = (n: number, over: Partial<WorkflowRun> = {}) =>
  Array.from({ length: n }, () => run(over));

let client: QueryClient;

function renderPanel(repo = REPO) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <ActionsPanel repoPath={repo} active />
    </QueryClientProvider>,
  );
  return {
    ...view,
    switchTo: (next: string) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <ActionsPanel repoPath={next} active />
        </QueryClientProvider>,
      ),
  };
}

/** The funnel; Base UI gives a combobox trigger the combobox role. */
const funnel = () => screen.getByRole("combobox", { name: /^Filter runs/ });
const filterInput = () =>
  screen.getByPlaceholderText(/^Filter by (workflow|event)/);

async function openFilters(user: ReturnType<typeof userEvent.setup>) {
  await user.click(funnel());
  return screen.findByRole("listbox");
}

async function pickOption(
  user: ReturnType<typeof userEvent.setup>,
  name: string | RegExp,
) {
  await openFilters(user);
  await user.click(await screen.findByRole("option", { name }));
  await user.keyboard("{Escape}");
}

beforeEach(() => {
  fake.calls.length = 0;
  fake.read = () => ({ runs: rows(40), totalCount: 312, hasMore: true });
  fake.base = () => ({ runs: rows(3), totalCount: 3 });
  fake.workflows = { data: [], isPending: false };
  vi.mocked(forgeStatus).mockResolvedValue(forge("github"));
  vi.mocked(gitStatus).mockResolvedValue(onBranch("main"));
  vi.mocked(forgeRepoWriteAccess).mockResolvedValue({
    canPush: true,
  } as never);
});

afterEach(() => cleanup());

describe("facets reach the run read", () => {
  it("picking Status Failed calls the hook with { status: 'failure' }", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await pickOption(user, "Failed");
    await waitFor(() => expect(lastFilters()).toEqual({ status: "failure" }));
  });

  it("pressing a checked Status row clears its facet and keeps the popover open", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await openFilters(user);
    await user.click(await screen.findByRole("option", { name: "Failed" }));
    await waitFor(() => expect(lastFilters()).toEqual({ status: "failure" }));
    const row = screen.getByRole("option", { name: "Failed" });
    expect(row).toHaveAttribute("aria-selected", "true");
    await user.click(row);
    await waitFor(() => expect(lastFilters()).toEqual({}));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Failed" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(filterInput()).toHaveFocus();
    expect(
      screen.queryByRole("button", { name: "Remove filter Status: Failed" }),
    ).not.toBeInTheDocument();
  });

  it("Enter on a checked row toggles its facet off, the row keeping the highlight", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await openFilters(user);
    const row = await screen.findByRole("option", { name: "Failed" });
    // The Event group comes first; step down to the Status row.
    const steps =
      [
        ...screen.getByRole("listbox").querySelectorAll('[role="option"]'),
      ].indexOf(row) + 1;
    expect(steps).toBeGreaterThan(0);
    // One call: each separate user-event call adds its own trailing wait and
    // async-wrapper drain.
    await user.keyboard("{ArrowDown}".repeat(steps));
    expect(row).toHaveAttribute("data-highlighted");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(lastFilters()).toEqual({ status: "failure" }));
    await waitFor(() => expect(row).toHaveAttribute("aria-selected", "true"));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(lastFilters()).toEqual({}));
    expect(row).toHaveAttribute("aria-selected", "false");
    expect(row).toHaveAttribute("data-highlighted");
    expect(filterInput()).toHaveFocus();
    expect(filterInput()).toHaveAttribute("aria-activedescendant", row.id);
  });

  it("This branch on main sends { branch: 'main' } and renders no chip", async () => {
    const user = userEvent.setup();
    renderPanel();
    const toggle = await screen.findByRole("button", { name: "This branch" });
    await waitFor(() =>
      expect(toggle).not.toHaveAttribute("aria-disabled", "true"),
    );
    await user.click(toggle);
    await waitFor(() => expect(lastFilters()).toEqual({ branch: "main" }));
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.queryByRole("group", { name: "Active run filters" }),
    ).not.toBeInTheDocument();
    expect(funnel()).toHaveAccessibleName("Filter runs");
  });

  it("a detached HEAD under a pressed This branch sends no branch", async () => {
    const user = userEvent.setup();
    renderPanel();
    const toggle = await screen.findByRole("button", { name: "This branch" });
    await waitFor(() =>
      expect(toggle).not.toHaveAttribute("aria-disabled", "true"),
    );
    await user.click(toggle);
    await waitFor(() => expect(lastFilters()).toEqual({ branch: "main" }));
    act(() => {
      client.setQueryData(repoStatusOptions(REPO).queryKey, onBranch(null));
    });
    await waitFor(() => expect(lastFilters()).toEqual({}));
    expect(toggle).toHaveAttribute("aria-disabled", "true");
  });

  it("a branch picked by name sends it and leaves This branch unpressed", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await openFilters(user);
    await user.type(filterInput(), "x");
    await user.click(
      await screen.findByRole("option", { name: 'Filter by branch "x"' }),
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(lastFilters()).toEqual({ branch: "x" }));
    expect(screen.getByRole("button", { name: "This branch" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(funnel()).toHaveAccessibleName("Filter runs, 1 active");
  });
});

describe("chips", () => {
  it("names each chip's remove button and groups the row", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await pickOption(user, "Failed");
    const group = await screen.findByRole("group", {
      name: "Active run filters",
    });
    expect(
      within(group).getByRole("button", {
        name: "Remove filter Status: Failed",
      }),
    ).toBeInTheDocument();
  });

  it("an 80-character branch keeps its full value in the remove name", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    const long = `feature/${"x".repeat(72)}`;
    await openFilters(user);
    await user.click(filterInput());
    await user.paste(long);
    await user.click(
      await screen.findByRole("option", { name: `Filter by branch "${long}"` }),
    );
    await user.keyboard("{Escape}");
    expect(
      await screen.findByRole("button", {
        name: `Remove filter Branch: ${long}`,
      }),
    ).toBeInTheDocument();
  });

  async function threeChips(user: ReturnType<typeof userEvent.setup>) {
    renderPanel();
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await pickOption(user, "pull_request");
    await pickOption(user, "Failed");
    await openFilters(user);
    await user.type(filterInput(), "dev");
    await user.click(
      await screen.findByRole("option", { name: 'Filter by branch "dev"' }),
    );
    await user.keyboard("{Escape}");
    await screen.findByRole("button", { name: "Remove filter Branch: dev" });
  }

  it("removing the first of three chips lands on the next chip's remove", async () => {
    const user = userEvent.setup();
    await threeChips(user);
    await user.click(
      screen.getByRole("button", { name: "Remove filter Event: pull_request" }),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Remove filter Status: Failed" }),
      ),
    );
  });

  it("removing the last chip lands on the previous chip's remove", async () => {
    const user = userEvent.setup();
    await threeChips(user);
    await user.click(
      screen.getByRole("button", { name: "Remove filter Branch: dev" }),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Remove filter Status: Failed" }),
      ),
    );
  });

  it("removing the only chip lands on the funnel", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await pickOption(user, "Failed");
    await user.click(
      await screen.findByRole("button", {
        name: "Remove filter Status: Failed",
      }),
    );
    await waitFor(() => expect(document.activeElement).toBe(funnel()));
    expect(lastFilters()).toEqual({});
  });

  it("Clear filters in the chips row lands on the funnel", async () => {
    const user = userEvent.setup();
    await threeChips(user);
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(document.activeElement).toBe(funnel()));
    expect(lastFilters()).toEqual({});
  });

  it("the empty arm's Clear filters lands on the funnel", async () => {
    const user = userEvent.setup();
    fake.read = (_r, f) =>
      "status" in f
        ? { runs: [], totalCount: 0 }
        : { runs: rows(2), totalCount: 2 };
    renderPanel();
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await pickOption(user, "Failed");
    expect(
      await screen.findByText("No runs match these filters."),
    ).toBeInTheDocument();
    const clears = screen.getAllByRole("button", { name: "Clear filters" });
    await user.click(clears[clears.length - 1]);
    await waitFor(() => expect(document.activeElement).toBe(funnel()));
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe("providers", () => {
  it("a search matching no loaded row names the provider's noun", async () => {
    vi.mocked(forgeStatus).mockResolvedValue(forge("gitlab"));
    fake.read = () => ({ runs: rows(2, { actor: null }), totalCount: null });
    const user = userEvent.setup();
    renderPanel();
    const search = await screen.findByPlaceholderText(
      "Filter loaded pipelines",
    );
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await user.type(search, "zz-no-such-row");
    expect(
      await screen.findByText("No pipelines match this search."),
    ).toBeInTheDocument();
  });

  it("GitLab: no Workflow group, a note naming GitLab, free-entry actors only", async () => {
    vi.mocked(forgeStatus).mockResolvedValue(forge("gitlab"));
    fake.read = () => ({
      runs: rows(3, { actor: null, event: "merge_request_event" }),
      totalCount: null,
    });
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await openFilters(user);
    expect(
      screen.getByText(
        "Workflow filters aren't available for GitLab pipelines.",
      ),
    ).toBeInTheDocument();
    expect(filterInput()).toHaveAttribute(
      "placeholder",
      "Filter by event, status, branch…",
    );
    for (const name of ["Event", "Status", "Branch"])
      expect(screen.getByRole("group", { name })).toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Workflow" }),
    ).not.toBeInTheDocument();
    // GitLab's list carries no user, so Actor shows only once a name is typed.
    expect(
      screen.queryByRole("group", { name: "Actor" }),
    ).not.toBeInTheDocument();
    await user.type(filterInput(), "bob");
    const actor = await screen.findByRole("group", { name: "Actor" });
    expect(
      within(actor)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(['Filter by actor "bob"']);
    await user.keyboard("{Escape}");
    expect(
      screen.getByPlaceholderText("Filter loaded pipelines"),
    ).toBeVisible();
    expect(screen.queryByText(/^Workflows/)).not.toBeInTheDocument();
  });

  it("Bitbucket: loaded actors by uuid, no free actor, four fixed events", async () => {
    vi.mocked(forgeStatus).mockResolvedValue(forge("bitbucket"));
    fake.read = () => ({
      runs: rows(2, {
        actor: { name: "Ada Lovelace", id: "{uuid-1}" },
        event: "push",
      }),
      totalCount: 2,
    });
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await openFilters(user);
    const events = screen.getByRole("group", { name: "Event" });
    expect(
      within(events)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["PUSH", "MANUAL", "SCHEDULED", "PARENT_STEP"]);
    await user.type(filterInput(), "zed");
    expect(
      screen.queryByRole("option", { name: 'Filter by actor "zed"' }),
    ).not.toBeInTheDocument();
    await user.clear(filterInput());
    await user.click(screen.getByRole("option", { name: "Ada Lovelace" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(lastFilters()).toEqual({ actor: "{uuid-1}" }));
    expect(
      screen.getByRole("button", { name: "Remove filter Actor: Ada Lovelace" }),
    ).toBeInTheDocument();
  });

  it("GitHub: all five groups", async () => {
    fake.workflows = {
      data: [
        {
          id: 7,
          name: "CI",
          path: ".github/workflows/ci.yml",
          state: "active",
        },
      ],
      isPending: false,
    };
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await openFilters(user);
    for (const name of ["Workflow", "Event", "Status", "Branch", "Actor"])
      expect(screen.getByRole("group", { name })).toBeInTheDocument();
    expect(filterInput()).toHaveAttribute(
      "placeholder",
      "Filter by workflow, status, branch…",
    );
  });

  it("an unknown provider holds the funnel with its reason", async () => {
    vi.mocked(forgeStatus).mockReturnValue(new Promise(() => undefined));
    renderPanel();
    expect(funnel()).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("button", { name: "Run workflow…" }),
    ).toBeInTheDocument();
  });
});

describe("count line and paging", () => {
  async function withStatusFacet(
    read: (f: Record<string, unknown>) => FakeRead,
    sent = "failure",
  ) {
    fake.read = (_r, f) => read(f);
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await pickOption(user, "Failed");
    await waitFor(() => expect(lastFilters()).toEqual({ status: sent }));
  }

  it("a GitHub status facet past the window reads 1,000+", async () => {
    await withStatusFacet(() => ({
      runs: rows(40),
      totalCount: 2500,
      hasMore: true,
    }));
    expect(
      await screen.findByRole("button", { name: /Showing 40 of 1,000\+/ }),
    ).toBeInTheDocument();
  });

  it("a workflow-only filter shows the real total", async () => {
    fake.workflows = {
      data: [{ id: 7, name: "CI", path: "ci.yml", state: "active" }],
      isPending: false,
    };
    fake.read = (_r, f) =>
      "workflowId" in f
        ? { runs: rows(40), totalCount: 4159, hasMore: true }
        : { runs: rows(40), totalCount: 9000, hasMore: true };
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await pickOption(user, "CI");
    await waitFor(() => expect(lastFilters()).toEqual({ workflowId: 7 }));
    expect(
      await screen.findByRole("button", { name: /Showing 40 of 4,159$/ }),
    ).toBeInTheDocument();
  });

  it("GitLab under a status facet shows no total", async () => {
    vi.mocked(forgeStatus).mockResolvedValue(forge("gitlab"));
    await withStatusFacet(
      () => ({
        runs: rows(40, { actor: null }),
        totalCount: null,
        hasMore: true,
      }),
      "failed",
    );
    const more = await screen.findByRole("button", { name: /^Load more/ });
    expect(more.textContent).not.toMatch(/ of /);
  });

  it("holds Load more and marks the list busy while the rows are a placeholder", async () => {
    await withStatusFacet(() => ({
      runs: rows(40),
      totalCount: 312,
      hasMore: true,
      placeholder: true,
    }));
    const more = await screen.findByRole("button", { name: "Loading…" });
    expect(more).toHaveAttribute("aria-disabled", "true");
    expect(more.closest('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
  });

  it("a placeholder holding no rows shows skeletons under the busy region", async () => {
    await withStatusFacet(() => ({
      runs: [],
      totalCount: 0,
      placeholder: true,
    }));
    // The skeleton's own status sits outside its aria-busy box, so the busy
    // ancestor found here is the list region.
    const skeleton = await waitFor(() => {
      const found = screen
        .getAllByRole("status")
        .find((el) => /Loading workflow runs/.test(el.textContent ?? ""));
      expect(found).toBeDefined();
      return found as HTMLElement;
    });
    expect(skeleton.closest('[aria-busy="true"]')).not.toBeNull();
    expect(
      screen.queryByText("No runs match these filters."),
    ).not.toBeInTheDocument();
  });
});

describe("the facet announcement", () => {
  const announcement = () => screen.getByTestId("run-facet-announcement");

  it("announces the settled total once, never on a poll", async () => {
    let settled = false;
    fake.read = (_r, f) =>
      "status" in f
        ? settled
          ? { runs: rows(40), totalCount: 312, hasMore: true }
          : { runs: rows(40), totalCount: 9, hasMore: true, placeholder: true }
        : { runs: rows(40), totalCount: 9, hasMore: true };
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await pickOption(user, "Failed");
    expect(announcement()).toHaveTextContent("");
    settled = true;
    bump();
    await waitFor(() => expect(announcement()).toHaveTextContent("312 runs"));
    setRead(() => ({ runs: rows(40), totalCount: 400, hasMore: true }));
    expect(announcement()).toHaveTextContent("312 runs");
  });

  it("says 40+ on GitLab, where no total is reported", async () => {
    vi.mocked(forgeStatus).mockResolvedValue(forge("gitlab"));
    fake.read = () => ({
      runs: rows(40, { actor: null }),
      totalCount: null,
      hasMore: true,
    });
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await pickOption(user, "Failed");
    await waitFor(() =>
      expect(announcement()).toHaveTextContent("40+ pipelines"),
    );
  });

  it("says no runs match when the filters leave nothing", async () => {
    fake.read = (_r, f) =>
      "status" in f
        ? { runs: [], totalCount: 0 }
        : { runs: rows(2), totalCount: 2 };
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await pickOption(user, "Failed");
    await waitFor(() =>
      expect(announcement()).toHaveTextContent("No runs match these filters"),
    );
  });

  it("says 1 run in the singular", async () => {
    fake.read = (_r, f) =>
      "status" in f
        ? { runs: rows(1), totalCount: 1 }
        : { runs: rows(2), totalCount: 2 };
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await pickOption(user, "Failed");
    await waitFor(() => expect(announcement()).toHaveTextContent(/^1 run$/));
  });

  it("says 1 pipeline in the singular on GitLab", async () => {
    vi.mocked(forgeStatus).mockResolvedValue(forge("gitlab"));
    fake.read = () => ({ runs: rows(1, { actor: null }), totalCount: null });
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await pickOption(user, "Failed");
    await waitFor(() =>
      expect(announcement()).toHaveTextContent(/^1 pipeline$/),
    );
  });

  it("localizes a large total", async () => {
    fake.workflows = {
      data: [{ id: 7, name: "CI", path: "ci.yml", state: "active" }],
      isPending: false,
    };
    fake.read = (_r, f) =>
      "workflowId" in f
        ? { runs: rows(40), totalCount: 1234, hasMore: true }
        : { runs: rows(40), totalCount: 9000, hasMore: true };
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await pickOption(user, "CI");
    await waitFor(() =>
      expect(announcement()).toHaveTextContent(/^1,234 runs$/),
    );
  });

  it("a failed read replaces the last count with the failure", async () => {
    let fail = false;
    fake.read = () =>
      fail ? { error: true } : { runs: rows(40), totalCount: 312 };
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await pickOption(user, "Failed");
    await waitFor(() => expect(announcement()).toHaveTextContent("312 runs"));
    fail = true;
    await pickOption(user, "Cancelled");
    await waitFor(() =>
      expect(announcement()).toHaveTextContent(
        /^Couldn't load workflow runs with these filters$/,
      ),
    );
  });

  it("a repo switch with facets set announces nothing and derives empty facets", async () => {
    const user = userEvent.setup();
    const view = renderPanel();
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await pickOption(user, "Failed");
    await waitFor(() => expect(announcement()).toHaveTextContent("312 runs"));
    fake.read = () => ({ runs: rows(5), totalCount: 5 });
    view.switchTo(OTHER);
    await waitFor(() => expect(lastFilters(OTHER)).toEqual({}));
    expect(
      screen.queryByRole("group", { name: "Active run filters" }),
    ).not.toBeInTheDocument();
    expect(announcement()).toHaveTextContent("312 runs");
    view.switchTo(REPO);
    expect(
      await screen.findByRole("button", {
        name: "Remove filter Status: Failed",
      }),
    ).toBeInTheDocument();
    expect(lastFilters(REPO)).toEqual({ status: "failure" });
  });
});

describe("status labels", () => {
  it("GitHub statuses read through statusLabel, with requested and pending named", () => {
    const conclusions = new Set([
      "queued",
      "in_progress",
      "waiting",
      "completed",
    ]);
    for (const v of STATUS_FACETS.github) {
      const expected =
        v === "requested"
          ? "Requested"
          : v === "pending"
            ? "Pending"
            : conclusions.has(v)
              ? statusLabel(v, "")
              : statusLabel("completed", v);
      expect(statusFacetLabel("github", v)).toBe(expected);
    }
    expect(statusFacetLabel("gitlab", "waiting_for_resource")).toBe(
      "Waiting for resource",
    );
    expect(statusFacetLabel("bitbucket", "PASSED")).toBe("Passed");
    expect(statusFacetLabel("gitlab", "novel")).toBe("novel");
  });

  it("the popover's Status rows use those labels", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await openFilters(user);
    const group = screen.getByRole("group", { name: "Status" });
    expect(
      within(group)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(STATUS_FACETS.github.map((v) => statusFacetLabel("github", v)));
  });
});

describe("free entry", () => {
  async function typeQuery(text: string) {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await openFilters(user);
    await user.type(filterInput(), text);
    return user;
  }

  it("a branch with a space is refused by reason, with no free row", async () => {
    await typeQuery("feature x");
    expect(
      screen.getAllByText("Can't contain spaces or control characters").length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByRole("option", { name: /^Filter by branch/ }),
    ).not.toBeInTheDocument();
  });

  it("an actor with a space gets the same reason", async () => {
    await typeQuery("bob smith");
    expect(
      screen.queryByRole("option", { name: /^Filter by actor/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByText("Can't contain spaces or control characters"),
    ).toHaveLength(2);
  });

  it("an actor over 200 bytes is refused as too long", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await openFilters(user);
    await user.click(filterInput());
    await user.paste("a".repeat(201));
    expect(
      (await screen.findAllByText("Too long (over 200 bytes)")).length,
    ).toBeGreaterThan(0);
  });

  it("a branch past 200 bytes is still offered; only the actor is capped", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await openFilters(user);
    await user.click(filterInput());
    const long = "b".repeat(210);
    await user.paste(long);
    expect(
      await screen.findByRole("option", { name: `Filter by branch "${long}"` }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Too long (over 200 bytes)")).toHaveLength(1);
  });

  it("a branch starting with a hyphen is refused, an actor is not", async () => {
    await typeQuery("-x");
    expect(screen.getByText("Can't start with a hyphen")).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /^Filter by branch/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: 'Filter by actor "-x"' }),
    ).toBeInTheDocument();
  });

  it("a valid branch is offered as a free row", async () => {
    await typeQuery("feature/x");
    expect(
      await screen.findByRole("option", {
        name: 'Filter by branch "feature/x"',
      }),
    ).toBeInTheDocument();
  });
});

describe("palette", () => {
  it("registers the filter and link actions palette-only", () => {
    const expected: [string, string][] = [
      ["filter-runs", "Filter runs…"],
      ["clear-run-filters", "Clear filters"],
      ["toggle-workflows-section", "Show or hide workflows"],
      ["open-actions-github-caches", "Open Actions caches on GitHub"],
      ["open-actions-github-deployments", "Open Deployments on GitHub"],
      ["open-actions-github-attestations", "Open Attestations on GitHub"],
      ["open-actions-github-runners", "Open Runners on GitHub"],
      ["open-actions-github-usage", "Open Actions usage on GitHub"],
      ["open-actions-github-performance", "Open Actions performance on GitHub"],
      ["open-actions-gitlab-pipelines", "Open Pipelines & caches on GitLab"],
      ["open-actions-gitlab-environments", "Open Environments on GitLab"],
      [
        "open-actions-gitlab-ci-settings",
        "Open CI/CD settings (runners) on GitLab",
      ],
      ["open-actions-gitlab-ci-analytics", "Open CI/CD analytics on GitLab"],
      [
        "open-actions-bitbucket-pipelines",
        "Open Pipelines & caches on Bitbucket",
      ],
      ["open-actions-bitbucket-deployments", "Open Deployments on Bitbucket"],
    ];
    for (const [id, label] of expected)
      expect(ACTIONS.find((a) => a.id === id)).toMatchObject({
        label,
        category: "Actions",
        defaultBinding: null,
      });
  });

  it("Clear filters is live only while a facet is set", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    expect(dispatchAction("clear-run-filters")).toBe(false);
    await pickOption(user, "Failed");
    await waitFor(() => expect(lastFilters()).toEqual({ status: "failure" }));
    let ran = false;
    act(() => {
      ran = dispatchAction("clear-run-filters");
    });
    expect(ran).toBe(true);
    await waitFor(() => expect(lastFilters()).toEqual({}));
    await waitFor(() => expect(document.activeElement).toBe(funnel()));
  });

  it("another provider's link action is not live", async () => {
    renderPanel();
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    expect(dispatchAction("open-actions-gitlab-pipelines")).toBe(false);
  });

  it("Filter runs… opens the popover through the keyboard-activation click", async () => {
    renderPanel();
    await waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );
    act(() => {
      expect(dispatchAction("filter-runs")).toBe(true);
    });
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
    expect(funnel()).toHaveAttribute("aria-expanded", "true");
  });
});

describe("review fold-in", () => {
  const announcement = () => screen.getByTestId("run-facet-announcement");
  const funnelReady = () =>
    waitFor(() =>
      expect(funnel()).not.toHaveAttribute("aria-disabled", "true"),
    );

  it("an offline facet change keeps the list notice outside the busy region", async () => {
    fake.read = (_r, f) =>
      "status" in f
        ? { runs: rows(5), totalCount: 5, placeholder: true, paused: true }
        : { runs: rows(5), totalCount: 5 };
    const user = userEvent.setup();
    renderPanel();
    await funnelReady();
    await pickOption(user, "Failed");
    const busy = await waitFor(() => {
      const el = document.querySelector('[aria-busy="true"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(busy.querySelector('[role="status"]')).toBeNull();
    const spoken = screen
      .getAllByRole("status")
      .filter((el) => el !== announcement() && el.textContent?.trim());
    expect(spoken.length).toBeGreaterThan(0);
  });

  it("a second settle to the same text is announced afresh", async () => {
    const user = userEvent.setup();
    renderPanel();
    await funnelReady();
    await pickOption(user, "Failed");
    await waitFor(() => expect(announcement()).toHaveTextContent("312 runs"));
    const first = announcement().firstElementChild;
    expect(first).not.toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Remove filter Status: Failed" }),
    );
    await waitFor(() => expect(lastFilters()).toEqual({}));
    await waitFor(() =>
      expect(announcement().firstElementChild).not.toBe(first),
    );
    expect(announcement()).toHaveTextContent("312 runs");
  });

  it("GitLab says pipelines when no pipeline matches", async () => {
    vi.mocked(forgeStatus).mockResolvedValue(forge("gitlab"));
    fake.read = (_r, f) =>
      "status" in f
        ? { runs: [], totalCount: null }
        : { runs: rows(2, { actor: null }), totalCount: null };
    const user = userEvent.setup();
    renderPanel();
    await funnelReady();
    await pickOption(user, "Failed");
    expect(
      await screen.findByText("No pipelines match these filters."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(announcement()).toHaveTextContent(
        "No pipelines match these filters",
      ),
    );
  });

  it("This branch on a detached HEAD reads as no filter", async () => {
    fake.read = (_r, f) =>
      "branch" in f
        ? { runs: rows(2), totalCount: 2 }
        : { runs: [], totalCount: 0 };
    const user = userEvent.setup();
    renderPanel();
    const toggle = await screen.findByRole("button", { name: "This branch" });
    await waitFor(() =>
      expect(toggle).not.toHaveAttribute("aria-disabled", "true"),
    );
    await user.click(toggle);
    await waitFor(() => expect(lastFilters()).toEqual({ branch: "main" }));
    act(() => {
      client.setQueryData(repoStatusOptions(REPO).queryKey, onBranch(null));
    });
    await waitFor(() => expect(lastFilters()).toEqual({}));
    expect(await screen.findByText("No workflow runs yet")).toBeInTheDocument();
    expect(
      screen.queryByText("No runs match these filters."),
    ).not.toBeInTheDocument();
  });

  it("returning to a repo before its branch is read announces nothing", async () => {
    const user = userEvent.setup();
    const view = renderPanel();
    const toggle = await screen.findByRole("button", { name: "This branch" });
    await waitFor(() =>
      expect(toggle).not.toHaveAttribute("aria-disabled", "true"),
    );
    await user.click(toggle);
    await waitFor(() => expect(announcement()).toHaveTextContent("312 runs"));
    const first = announcement().firstElementChild;
    view.switchTo(OTHER);
    await waitFor(() => expect(lastFilters(OTHER)).toEqual({}));
    let release: ((s: RepoStatus) => void) | undefined;
    vi.mocked(gitStatus).mockImplementation((repo: string) =>
      repo === REPO
        ? new Promise<RepoStatus>((resolve) => {
            release = resolve;
          })
        : Promise.resolve(onBranch("main")),
    );
    act(() => {
      client.removeQueries({ queryKey: repoStatusOptions(REPO).queryKey });
    });
    view.switchTo(REPO);
    await waitFor(() => expect(release).toBeDefined());
    expect(lastFilters(REPO)).toEqual({});
    await act(async () => release?.(onBranch("main")));
    await waitFor(() => expect(lastFilters(REPO)).toEqual({ branch: "main" }));
    expect(announcement().firstElementChild).toBe(first);
  });

  it("each repo keeps its own facets across a switch", async () => {
    const user = userEvent.setup();
    const view = renderPanel();
    await funnelReady();
    await pickOption(user, "Failed");
    await waitFor(() => expect(lastFilters()).toEqual({ status: "failure" }));
    view.switchTo(OTHER);
    await waitFor(() => expect(lastFilters(OTHER)).toEqual({}));
    await funnelReady();
    await pickOption(user, "push");
    await waitFor(() => expect(lastFilters(OTHER)).toEqual({ event: "push" }));
    view.switchTo(REPO);
    expect(
      await screen.findByRole("button", {
        name: "Remove filter Status: Failed",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove filter Event: push" }),
    ).not.toBeInTheDocument();
    expect(lastFilters(REPO)).toEqual({ status: "failure" });
    view.switchTo(OTHER);
    expect(
      await screen.findByRole("button", { name: "Remove filter Event: push" }),
    ).toBeInTheDocument();
  });

  it("a read the filters made fail offers Clear filters beside Refresh", async () => {
    fake.read = (_r, f) =>
      "status" in f ? { error: true } : { runs: rows(2), totalCount: 2 };
    const user = userEvent.setup();
    renderPanel();
    await funnelReady();
    await pickOption(user, "Failed");
    // The sr-only announcement says the same; this asks for the visible line.
    expect(
      await screen.findByText(
        /Couldn't load workflow runs with these filters\. Refresh/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Refresh runs" }),
    ).toBeInTheDocument();
    const clears = screen.getAllByRole("button", { name: "Clear filters" });
    await user.click(clears[clears.length - 1]);
    await waitFor(() => expect(lastFilters()).toEqual({}));
    await waitFor(() => expect(document.activeElement).toBe(funnel()));
  });
});
