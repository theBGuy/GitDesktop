import {
  type InfiniteData,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDispatch, seedFields } from "@/features/actions/dispatch-inputs";
import {
  type CiRunPage,
  DISPATCH_INPUTS_REJECTED_LEAD,
  forgeCiRunPage,
  isDispatchInputsError,
  normalizeRunFilters,
  type RunFilters,
  useWorkflowRunPages,
  type WorkflowRun,
} from "@/lib/github/actions";
import { RUN_POLL_FAST_MS, RUN_POLL_SLOW_MS } from "@/lib/github/run-poll";
import { invoke } from "@/lib/tauri/invoke";

vi.mock("@/lib/tauri/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri/invoke")>()),
  invoke: vi.fn(),
}));

const REPO = "C:/repos/demo";
const OTHER_REPO = "C:/repos/other";
const PAGE_COMMAND = "forge_ci_run_page";

function run(id: number, status = "completed"): WorkflowRun {
  return {
    id,
    number: id,
    displayTitle: `run ${id}`,
    status,
    conclusion: status === "completed" ? "success" : "",
    workflowName: "CI",
    headBranch: "main",
    event: "push",
    createdAt: new Date().toISOString(),
    startedAt: "",
    updatedAt: "",
    url: "",
    headSha: "abc",
    workflowDatabaseId: 1,
    actor: null,
  };
}

const page = (runs: WorkflowRun[], hasMore = false): CiRunPage => ({
  runs,
  totalCount: null,
  hasMore,
});

type PageArgs = { page: number; filters: RunFilters | null };

/** Every page read the hook made, as the wire saw it. */
const pageCalls = (): PageArgs[] =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([cmd]) => cmd === PAGE_COMMAND)
    .map(([, args]) => args as PageArgs);

/** Answers each page read with the rows `answer` picks; a null answer never
 *  settles, so the hook sits on its placeholder. */
function answerPages(answer: (args: PageArgs) => CiRunPage | null) {
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    if (cmd !== PAGE_COMMAND) throw new Error(`unexpected command ${cmd}`);
    const reply = answer(args as PageArgs);
    return reply ?? new Promise(() => undefined);
  });
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderRunPages(
  qc: QueryClient,
  initial: { repo: string; filters: RunFilters },
) {
  return renderHook(
    ({ repo, filters }: { repo: string; filters: RunFilters }) =>
      useWorkflowRunPages(repo, true, true, filters),
    {
      initialProps: initial,
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: qc }, children),
    },
  );
}

const pagedKey = (repo: string, filters: RunFilters) =>
  ["repo", repo, "actions", "runs-paged", filters] as const;

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("normalizeRunFilters", () => {
  it("drops blank and non-positive facets and trims the rest", () => {
    expect(
      normalizeRunFilters({
        status: " ",
        branch: "main ",
        workflowId: 0,
        actor: undefined,
      }),
    ).toStrictEqual({ branch: "main" });
    expect(
      normalizeRunFilters({ branch: " main ", status: "", workflowId: 12 }),
    ).toStrictEqual({ branch: "main", workflowId: 12 });
  });

  it("keeps a positive safe-integer workflow id and the other facets", () => {
    expect(normalizeRunFilters({ workflowId: 5, event: "push" })).toStrictEqual(
      { workflowId: 5, event: "push" },
    );
    expect(normalizeRunFilters({ workflowId: 1.5 })).toStrictEqual({});
    expect(normalizeRunFilters({ workflowId: -3 })).toStrictEqual({});
    expect(
      normalizeRunFilters({ workflowId: Number.MAX_SAFE_INTEGER + 1 }),
    ).toStrictEqual({});
  });

  it("gives deep-equal results in a fixed key order for equal inputs", () => {
    const a = normalizeRunFilters({
      actor: "octocat",
      status: "success",
      event: "push",
      workflowId: 7,
      branch: "main",
    });
    const b = normalizeRunFilters({
      branch: "main",
      workflowId: 7,
      event: "push",
      status: "success",
      actor: "octocat",
    });
    expect(a).toStrictEqual(b);
    expect(a).not.toBe(b);
    expect(Object.keys(a)).toStrictEqual([
      "branch",
      "workflowId",
      "event",
      "status",
      "actor",
    ]);
  });
});

describe("forgeCiRunPage payload", () => {
  // The Rust RunFilters denies unknown fields, so a drifted spelling fails the
  // call; these are the camelCase keys it reads.
  it("sends the normalized facets under their camelCase wire names", async () => {
    vi.mocked(invoke).mockResolvedValue(page([]));
    await forgeCiRunPage(REPO, 40, 2, " dev ", {
      branch: "main",
      workflowId: 9,
      event: "push",
      status: "failure",
      actor: " octocat ",
    });
    expect(vi.mocked(invoke).mock.calls).toStrictEqual([
      [
        PAGE_COMMAND,
        {
          repoPath: REPO,
          limit: 40,
          page: 2,
          branch: "dev",
          filters: {
            branch: "main",
            workflowId: 9,
            event: "push",
            status: "failure",
            actor: "octocat",
          },
        },
      ],
    ]);
  });

  it("sends null filters when none are given", async () => {
    vi.mocked(invoke).mockResolvedValue(page([]));
    await forgeCiRunPage(REPO, 40, 1, "main");
    expect(vi.mocked(invoke).mock.calls).toStrictEqual([
      [
        PAGE_COMMAND,
        { repoPath: REPO, limit: 40, page: 1, branch: "main", filters: null },
      ],
    ]);
  });
});

describe("useWorkflowRunPages", () => {
  it("keys on the normalized facets and sends them as the filters argument", async () => {
    answerPages(() => page([run(1)]));
    const qc = client();
    const { result } = renderRunPages(qc, {
      repo: REPO,
      filters: { branch: " main ", status: "" },
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(
      qc.getQueryData(pagedKey(REPO, { branch: "main" })),
    ).not.toBeUndefined();
    expect(pageCalls()).toStrictEqual([
      {
        repoPath: REPO,
        limit: 40,
        page: 1,
        branch: null,
        filters: { branch: "main" },
      },
    ]);
  });

  it("serves the previous rows across a facet change, never across repos", async () => {
    answerPages(({ filters }) =>
      filters?.event === "push" ? page([run(1), run(2)]) : null,
    );
    const qc = client();
    const { result, rerender } = renderRunPages(qc, {
      repo: REPO,
      filters: { event: "push" },
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ repo: REPO, filters: { event: "schedule" } });
    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.data?.pages[0].runs.map((r) => r.id)).toStrictEqual([
      1, 2,
    ]);

    rerender({ repo: OTHER_REPO, filters: { event: "schedule" } });
    expect(result.current.isPlaceholderData).toBe(false);
    expect(result.current.data).toBeUndefined();
  });

  it("trims a departed multi-page entry to page 1 and marks it stale without refetching", async () => {
    answerPages(() => null);
    const qc = client();
    const departedKey = pagedKey(REPO, { status: "success" });
    qc.setQueryData<InfiniteData<CiRunPage, number>>(departedKey, {
      pages: [page([run(1)], true), page([run(2)], true), page([run(3)])],
      pageParams: [1, 2, 3],
    });
    const { result, rerender } = renderRunPages(qc, {
      repo: REPO,
      filters: { status: "success" },
    });
    expect(result.current.data?.pages).toHaveLength(3);
    // Past page 1 the entry never goes stale on its own: no read at mount.
    expect(pageCalls()).toStrictEqual([]);

    rerender({ repo: REPO, filters: { status: "failure" } });
    await waitFor(() =>
      expect(
        qc.getQueryData<InfiniteData<CiRunPage, number>>(departedKey)?.pages,
      ).toHaveLength(1),
    );
    const departed = qc.getQueryCache().find<InfiniteData<CiRunPage, number>>({
      queryKey: departedKey,
      exact: true,
    });
    expect(departed?.state.data?.pageParams).toStrictEqual([1]);
    expect(departed?.state.isInvalidated).toBe(true);
    // Only the new facet was read; the trimmed entry waits for a return.
    expect(pageCalls().map((c) => c.filters)).toStrictEqual([
      { status: "failure" },
    ]);
    // The rows already on screen keep every page they showed.
    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.data?.pages).toHaveLength(3);
  });

  it("leaves a departed single-page entry alone", async () => {
    answerPages(({ filters }) =>
      filters?.status === "success" ? page([run(1)]) : null,
    );
    const qc = client();
    const { result, rerender } = renderRunPages(qc, {
      repo: REPO,
      filters: { status: "success" },
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    rerender({ repo: REPO, filters: { status: "failure" } });
    const departed = qc.getQueryCache().find<InfiniteData<CiRunPage, number>>({
      queryKey: pagedKey(REPO, { status: "success" }),
      exact: true,
    });
    expect(departed?.state.isInvalidated).toBe(false);
    expect(departed?.state.data?.pages).toHaveLength(1);
  });

  describe("a Load more in flight when its facet is left", () => {
    /** Renders on `success` with `loaded` pages seeded, starts a Load more whose
     *  answer the test releases, then moves to `failure` (which never answers). */
    async function leaveDuringLoadMore(loaded: number) {
      let release: (reply: CiRunPage) => void = () => undefined;
      vi.mocked(invoke).mockImplementation(async (cmd, args) => {
        if (cmd !== PAGE_COMMAND) throw new Error(`unexpected command ${cmd}`);
        const { page: n, filters } = args as PageArgs;
        if (filters?.status === "success" && n === loaded + 1)
          return new Promise<CiRunPage>((resolve) => {
            release = resolve;
          });
        if (filters?.status === "success" && n === 1)
          return page([run(1)], true);
        return new Promise(() => undefined);
      });
      const qc = client();
      const departedKey = pagedKey(REPO, { status: "success" });
      qc.setQueryData<InfiniteData<CiRunPage, number>>(departedKey, {
        pages: Array.from({ length: loaded }, (_, i) =>
          page([run(i + 1)], true),
        ),
        pageParams: Array.from({ length: loaded }, (_, i) => i + 1),
      });
      const hook = renderRunPages(qc, {
        repo: REPO,
        filters: { status: "success" },
      });
      void hook.result.current.fetchNextPage();
      await waitFor(() =>
        expect(pageCalls().map((c) => c.page)).toContain(loaded + 1),
      );
      hook.rerender({ repo: REPO, filters: { status: "failure" } });
      release(page([run(99)]));
      // Let the released page's continuations run before reading the entry.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const departed = () =>
        qc.getQueryCache().find<InfiniteData<CiRunPage, number>>({
          queryKey: departedKey,
          exact: true,
        });
      return { ...hook, departed };
    }

    it("never lands its page over the trim, and a return refetches page 1", async () => {
      const { departed, rerender } = await leaveDuringLoadMore(2);
      expect(departed()?.state.data?.pages).toHaveLength(1);
      expect(departed()?.state.data?.pageParams).toStrictEqual([1]);
      expect(departed()?.state.isInvalidated).toBe(true);
      expect(departed()?.state.fetchStatus).toBe("idle");

      rerender({ repo: REPO, filters: { status: "success" } });
      await waitFor(() =>
        expect(
          pageCalls()
            .filter((c) => c.filters?.status === "success")
            .at(-1)?.page,
        ).toBe(1),
      );
    });

    it("never lands its page on a single-page entry either", async () => {
      const { departed } = await leaveDuringLoadMore(1);
      expect(departed()?.state.data?.pages).toHaveLength(1);
      expect(departed()?.state.fetchStatus).toBe("idle");
    });
  });

  it("never cancels a departed first-page read, so another observer's rows land", async () => {
    let release: (reply: CiRunPage) => void = () => undefined;
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd !== PAGE_COMMAND) throw new Error(`unexpected command ${cmd}`);
      if ((args as PageArgs).filters?.status === undefined)
        return new Promise<CiRunPage>((resolve) => {
          release = resolve;
        });
      return new Promise(() => undefined);
    });
    const qc = client();
    const runs = renderRunPages(qc, { repo: REPO, filters: {} });
    await waitFor(() => expect(pageCalls()).toHaveLength(1));
    // The facet-free glyph read joins the same entry while its first page loads.
    const glyphs = renderRunPages(qc, { repo: REPO, filters: {} });
    runs.rerender({ repo: REPO, filters: { status: "failure" } });
    release(page([run(1)]));
    await waitFor(() => expect(glyphs.result.current.isSuccess).toBe(true));
    expect(
      glyphs.result.current.data?.pages[0].runs.map((r) => r.id),
    ).toStrictEqual([1]);
    expect(
      pageCalls().filter((c) => c.filters?.status === undefined),
    ).toHaveLength(1);
  });

  describe("poll interval", () => {
    /** The live observer's refetchInterval, evaluated against its query. */
    async function intervalFor(filters: RunFilters, rows: WorkflowRun[]) {
      answerPages(() => page(rows));
      const qc = client();
      const { result } = renderRunPages(qc, { repo: REPO, filters });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      const query = qc.getQueryCache().find({
        queryKey: pagedKey(REPO, normalizeRunFilters(filters)),
        exact: true,
      });
      const interval = query?.observers[0]?.options.refetchInterval;
      if (typeof interval !== "function" || !query)
        throw new Error("no refetchInterval function on the observer");
      return { interval: () => interval(query as never), query };
    }

    it("keeps a slow poll under a status facet with no active row", async () => {
      const { interval } = await intervalFor({ status: "success" }, [run(1)]);
      expect(interval()).toBe(RUN_POLL_SLOW_MS);
    });

    it("stops with no active row and no status facet", async () => {
      const { interval } = await intervalFor({ branch: "main" }, [run(1)]);
      expect(interval()).toBe(false);
    });

    it("keeps the ladder's faster tick under a status facet with active rows", async () => {
      const { interval } = await intervalFor({ status: "in_progress" }, [
        run(1, "in_progress"),
      ]);
      expect(interval()).toBe(RUN_POLL_FAST_MS);
    });

    it("stops on an errored read even under a status facet", async () => {
      const { interval, query } = await intervalFor({ status: "success" }, [
        run(1),
      ]);
      query.setState({ status: "error" });
      expect(interval()).toBe(false);
    });
  });
});

describe("isDispatchInputsError", () => {
  it("matches a gh error carrying the inputs-rejected lead", () => {
    expect(
      isDispatchInputsError({
        kind: "gh",
        message:
          "Workflow inputs rejected: this workflow requires 'version' on \"main\".\n\n<raw>",
      }),
    ).toBe(true);
    expect(DISPATCH_INPUTS_REJECTED_LEAD).toBe("Workflow inputs rejected: ");
  });

  it.each<[string, unknown]>([
    [
      "the no-trigger gh message",
      { kind: "gh", message: "This workflow can't be run manually: …" },
    ],
    [
      "a non-gh kind with the lead",
      {
        kind: "invalidArgument",
        message: "invalid argument: Workflow inputs rejected: …",
      },
    ],
    ["a plain Error", new Error("Workflow inputs rejected: x")],
    ["null", null],
    ["a string", "Workflow inputs rejected: x"],
    ["a gh error with a non-string message", { kind: "gh", message: 1 }],
  ])("rejects %s", (_name, err) => {
    expect(isDispatchInputsError(err)).toBe(false);
  });
});

describe("buildDispatch", () => {
  const input = (name: string) => ({
    name,
    type: "string" as const,
    description: null,
    default: "v",
    required: false,
    options: [],
  });

  it("sends an input named __proto__ as its own key, typed or free", () => {
    const typed = buildDispatch(seedFields([input("__proto__")]), []);
    expect(typed.hold).toBeUndefined();
    expect(Object.keys(typed.record)).toStrictEqual(["__proto__"]);
    expect(JSON.stringify(typed.record)).toBe('{"__proto__":"v"}');

    const free = buildDispatch([], [{ id: 1, key: " __proto__ ", value: "x" }]);
    expect(Object.keys(free.record)).toStrictEqual(["__proto__"]);
    expect(Object.getPrototypeOf(free.record)).toBe(Object.prototype);
  });
});
