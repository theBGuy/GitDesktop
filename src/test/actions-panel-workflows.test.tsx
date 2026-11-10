import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
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
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ActionsPanel } from "@/features/actions/ActionsPanel";
import { forgeRepoWriteAccess, forgeStatus, gitStatus } from "@/lib/git/api";
import type { ForgeStatus, RepoStatus } from "@/lib/git/types";
import type { RunFilters, Workflow, WorkflowRun } from "@/lib/github/actions";
import { dispatchAction } from "@/lib/hotkeys/hotkeys";
import { unmockedCommands } from "./setup";

type FakeRead =
  | { runs: WorkflowRun[]; totalCount: number | null; hasMore?: boolean }
  | undefined;

const fake = vi.hoisted(() => ({
  version: 0,
  listeners: new Set<() => void>(),
  calls: [] as { enabled: boolean; filters: Record<string, unknown> }[],
  read: (_f: Record<string, unknown>): unknown => undefined,
  base: (): unknown => undefined,
  workflows: [] as unknown[] | undefined,
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

// jsdom lays nothing out; the row keys scroll the focused row into view.
beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => undefined;
});

function subscribe(l: () => void) {
  fake.listeners.add(l);
  return () => fake.listeners.delete(l);
}

function result(r: FakeRead) {
  return {
    data: r && {
      pages: [{ runs: r.runs, totalCount: r.totalCount, hasMore: !!r.hasMore }],
      pageParams: [1],
    },
    isPending: r === undefined,
    isSuccess: r !== undefined,
    isError: false,
    isPaused: false,
    isFetching: false,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    isPlaceholderData: false,
    hasNextPage: !!r?.hasMore,
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
  };
}

fake.runPages = function useFakeRunPages(...a: unknown[]) {
  const [, enabled, , filters] = a as [string, boolean, boolean, RunFilters];
  useSyncExternalStore(subscribe, () => fake.version);
  const f = { ...filters } as Record<string, unknown>;
  fake.calls.push({ enabled, filters: f });
  return result((enabled ? fake.read(f) : fake.base()) as FakeRead);
};
fake.useWorkflows = function useFakeWorkflows() {
  useSyncExternalStore(subscribe, () => fake.version);
  return {
    data: fake.workflows,
    isPending: fake.workflows === undefined,
    isError: false,
    refetch: vi.fn(),
  };
};

const lastFilters = () => fake.calls.filter((c) => c.enabled).at(-1)?.filters;

function forge(provider: "github" | "gitlab"): ForgeStatus {
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

const wf = (id: number, name: string, state = "active"): Workflow => ({
  id,
  name,
  path: `.github/workflows/${id}.yml`,
  state,
});

/** API order differs from the rendered order on purpose. */
const SEVEN = [
  wf(1, "Zeta"),
  wf(2, "alpha"),
  wf(3, "CI"),
  wf(4, "deploy"),
  wf(5, "Docs", "disabled_manually"),
  wf(6, "Lint"),
  wf(7, "Release"),
];

let nextId = 1;
function run(over: Partial<WorkflowRun>): WorkflowRun {
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
    workflowDatabaseId: 0,
    actor: null,
    ...over,
  } as WorkflowRun;
}

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ActionsPanel repoPath="C:/a" active />
    </QueryClientProvider>,
  );
}

const header = () => screen.findByRole("button", { name: /^Workflows/ });
const list = () => screen.getByRole("list", { name: /^Workflows/ });
const rowNames = () =>
  within(list())
    .getAllByRole("button")
    .map((b) => b.textContent);

beforeEach(() => {
  fake.calls.length = 0;
  fake.workflows = SEVEN;
  fake.read = () => ({ runs: [run({})], totalCount: 1 });
  // Page 1 is newest first: workflow 3's latest run is the red one.
  fake.base = () => ({
    runs: [
      run({ workflowDatabaseId: 3, conclusion: "failure" }),
      run({ workflowDatabaseId: 3, conclusion: "success" }),
      run({ workflowDatabaseId: 2 }),
    ],
    totalCount: 3,
  });
  vi.mocked(forgeStatus).mockResolvedValue(forge("github"));
  vi.mocked(gitStatus).mockResolvedValue({
    branch: { name: "main" },
    entries: [],
  } as unknown as RepoStatus);
  vi.mocked(forgeRepoWriteAccess).mockResolvedValue({
    canPush: true,
  } as never);
});

afterEach(() => cleanup());

describe("Workflows section", () => {
  it("0 workflows: the count is named and only All workflows lists", async () => {
    fake.workflows = [];
    renderPanel();
    expect(await header()).toHaveAccessibleName("Workflows, 0");
    expect(rowNames()).toEqual(["All workflows"]);
  });

  it("1 workflow lists after All workflows", async () => {
    fake.workflows = [wf(2, "alpha")];
    renderPanel();
    expect(await header()).toHaveAccessibleName("Workflows, 1");
    expect(rowNames()).toHaveLength(2);
  });

  it("7 workflows: six by name, disabled last behind Show all (7)", async () => {
    const user = userEvent.setup();
    renderPanel();
    expect(await header()).toHaveAccessibleName("Workflows, 7");
    const names = rowNames();
    expect(names[0]).toBe("All workflows");
    expect(
      names.slice(1, 7).map((n) => n?.replace(/^—/, "").split(" ")[0]),
    ).toEqual(["alpha", "CI", "deploy", "Lint", "Release", "Zeta"]);
    expect(names[7]).toBe("Show all (7)");
    await user.click(
      within(list()).getByRole("button", { name: "Show all (7)" }),
    );
    const docs = within(list()).getByRole("button", { name: /^Docs/ });
    expect(docs.textContent).toContain("disabled");
    expect(rowNames().at(-1)).toContain("Docs");
    expect(document.activeElement).toBe(docs);
  });

  it("100 workflows offer Show all (100)", async () => {
    fake.workflows = Array.from({ length: 100 }, (_, i) =>
      wf(i + 1, `wf${String(i).padStart(3, "0")}`),
    );
    renderPanel();
    await header();
    expect(
      within(list()).getByRole("button", { name: "Show all (100)" }),
    ).toBeInTheDocument();
  });

  it("each row names its latest facet-free run, or that none is loaded", async () => {
    renderPanel();
    await header();
    expect(
      within(list()).getByRole("button", { name: /^CI.*last run: Failed/ }),
    ).toBeInTheDocument();
    expect(
      within(list()).getByRole("button", { name: /^Zeta.*no run loaded/ }),
    ).toBeInTheDocument();
  });

  it("a never-loaded facet-free read leaves every row unloaded", async () => {
    fake.base = () => undefined;
    renderPanel();
    await header();
    const rows = within(list())
      .getAllByRole("button")
      .filter((b) => !/^(All workflows|Show all)/.test(b.textContent ?? ""));
    expect(rows).toHaveLength(6);
    for (const row of rows) expect(row.textContent).toContain("no run loaded");
  });

  it("under a Status facet every row reads the dash", async () => {
    const user = userEvent.setup();
    renderPanel();
    await header();
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: /^Filter runs/ }),
      ).not.toHaveAttribute("aria-disabled", "true"),
    );
    await user.click(screen.getByRole("combobox", { name: /^Filter runs/ }));
    await user.click(await screen.findByRole("option", { name: "Failed" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(lastFilters()).toEqual({ status: "failure" }));
    expect(within(list()).queryByText(/last run:/)).not.toBeInTheDocument();
    expect(within(list()).queryByText("no run loaded")).not.toBeInTheDocument();
  });

  it("arrows move focus only; Enter drills in and stays put; Home/End jump", async () => {
    const user = userEvent.setup();
    renderPanel();
    await header();
    const all = within(list()).getByRole("button", { name: /^All workflows/ });
    all.focus();
    await user.keyboard("{ArrowDown}");
    const alpha = within(list()).getByRole("button", { name: /^alpha/ });
    expect(document.activeElement).toBe(alpha);
    expect(lastFilters()).toEqual({});
    await user.keyboard("{ArrowDown}{Enter}");
    const ci = within(list()).getByRole("button", { name: /^CI/ });
    await waitFor(() => expect(lastFilters()).toEqual({ workflowId: 3 }));
    expect(ci).toHaveAttribute("aria-current", "true");
    expect(document.activeElement).toBe(ci);
    expect(await header()).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("button", { name: "Remove filter Workflow: CI" }),
    ).toBeInTheDocument();
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(
      within(list()).getByRole("button", { name: "Show all (7)" }),
    );
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(all);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(lastFilters()).toEqual({}));
    expect(all).toHaveAttribute("aria-current", "true");
  });

  it("collapses from its header and from the palette, counting while collapsed", async () => {
    const user = userEvent.setup();
    renderPanel();
    const toggle = await header();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("(7)");
    expect(toggle).toHaveAccessibleName("Workflows, 7");
    expect(screen.queryByRole("list", { name: /^Workflows/ })).toBeNull();
    act(() => {
      expect(dispatchAction("toggle-workflows-section")).toBe(true);
    });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("a pending read names no count", async () => {
    fake.workflows = undefined;
    renderPanel();
    expect(await header()).toHaveAccessibleName("Workflows");
    expect(screen.getByText("Loading workflows…")).toBeInTheDocument();
  });

  it("GitLab shows no Workflows section", async () => {
    vi.mocked(forgeStatus).mockResolvedValue(forge("gitlab"));
    renderPanel();
    await screen.findByRole("button", { name: /Open on GitLab/ });
    expect(
      screen.queryByRole("button", { name: /^Workflows/ }),
    ).not.toBeInTheDocument();
  });
});

describe("Workflows section fold-in", () => {
  /** Each render reads the facet-free entry, then the list's own filters. */
  const baseCall = () => fake.calls.at(-2);

  it("a workflow drill-in keeps the facet-free read live; no facet leaves it off", async () => {
    const user = userEvent.setup();
    renderPanel();
    await header();
    expect(baseCall()).toEqual({ enabled: false, filters: {} });
    await user.click(within(list()).getByRole("button", { name: /^CI/ }));
    await waitFor(() => expect(lastFilters()).toEqual({ workflowId: 3 }));
    expect(baseCall()).toEqual({ enabled: true, filters: {} });
  });

  it("a clipped workflow name gets its full name as a title", async () => {
    renderPanel();
    await header();
    const name = within(list()).getByText("deploy");
    Object.defineProperty(name, "scrollWidth", { value: 200 });
    Object.defineProperty(name, "clientWidth", { value: 50 });
    fireEvent.mouseEnter(name);
    expect(name).toHaveAttribute("title", "deploy");
  });

  it("a palette collapse over a focused row lands on the header", async () => {
    renderPanel();
    const toggle = await header();
    within(list())
      .getByRole("button", { name: /^alpha/ })
      .focus();
    act(() => {
      expect(dispatchAction("toggle-workflows-section")).toBe(true);
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(toggle);
  });

  describe("in the palette's order (dispatch while open, restore on unmount)", () => {
    /** A stand-in palette: a dialog holding focus over the opener. */
    function openPalette() {
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      const input = document.createElement("input");
      dialog.append(input);
      document.body.append(dialog);
      input.focus();
      return dialog;
    }
    const funnel = () => screen.getByRole("combobox", { name: "Filter runs" });

    it("a restore landing elsewhere moves on to the header", async () => {
      renderPanel();
      const toggle = await header();
      within(list())
        .getByRole("button", { name: /^alpha/ })
        .focus();
      const palette = openPalette();
      act(() => {
        expect(dispatchAction("toggle-workflows-section")).toBe(true);
      });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      palette.remove();
      funnel().focus();
      expect(document.activeElement).toBe(toggle);
    });

    it("a restore with nowhere to go lands on the header", async () => {
      renderPanel();
      const toggle = await header();
      within(list())
        .getByRole("button", { name: /^alpha/ })
        .focus();
      const palette = openPalette();
      act(() => {
        dispatchAction("toggle-workflows-section");
      });
      palette.remove();
      await waitFor(() => expect(document.activeElement).toBe(toggle));
    });

    const runWorkflow = () =>
      screen.getByRole("button", { name: "Run workflow…" });

    it.each([
      ["collapse", "false"],
      ["expand", "true"],
    ])(
      "a %s from the focused header keeps the same header and lands on it",
      async (_dir, expanded) => {
        renderPanel();
        const before = await header();
        if (expanded === "true")
          act(() => {
            dispatchAction("toggle-workflows-section");
          });
        before.focus();
        const palette = openPalette();
        act(() => {
          expect(dispatchAction("toggle-workflows-section")).toBe(true);
        });
        const after = await header();
        expect(after).toBe(before);
        expect(after).toHaveAttribute("aria-expanded", expanded);
        palette.remove();
        runWorkflow().focus();
        expect(document.activeElement).toBe(before);
      },
    );

    it("a palette opened from outside the rows keeps its own restore", async () => {
      renderPanel();
      await header();
      funnel().focus();
      const palette = openPalette();
      act(() => {
        dispatchAction("toggle-workflows-section");
      });
      palette.remove();
      funnel().focus();
      await new Promise((r) => requestAnimationFrame(r));
      expect(document.activeElement).toBe(funnel());
    });
  });
});
