import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalPrView } from "@/features/pulls/LocalPrView";
import {
  loadBranchRules,
  loadSharedBranchRules,
} from "@/lib/branch-rules/store";
import { EMPTY_BRANCH_RULES } from "@/lib/branch-rules/types";
import {
  forgeIssueList,
  forgeIssueView,
  forgeStatus,
  gitCompareBranches,
  gitConflictPreview,
  gitDefaultBranch,
  gitStatus,
} from "@/lib/git/api";
import type {
  CommitSummary,
  ForgeStatus,
  IssueDetails,
  IssueInfo,
  RepoStatus,
} from "@/lib/git/types";
import { type LocalPr, listLocalPrs, updateLocalPr } from "@/lib/pulls/local";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

vi.mock("sonner", () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  },
}));
vi.mock("@/lib/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/toast")>()),
  toastError: vi.fn(),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitConflictPreview: vi.fn(),
  gitCompareBranches: vi.fn(),
  gitDefaultBranch: vi.fn(),
  gitStatus: vi.fn(),
  gitBranchDiffFiles: vi.fn(async () => []),
  gitMergeBase: vi.fn(() => new Promise(() => undefined)),
  getSecret: vi.fn(async () => null),
  gitBranches: vi.fn(() => new Promise(() => undefined)),
  forgeStatus: vi.fn(),
  forgeIssueList: vi.fn(),
  forgeIssueView: vi.fn(() => new Promise(() => undefined)),
}));
// Plugin-store reads bypass the rejecting transport, so each is mocked here.
vi.mock("@/lib/pulls/local", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pulls/local")>()),
  listLocalPrs: vi.fn(),
  updateLocalPr: vi.fn(),
}));
vi.mock("@/lib/branch-rules/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/branch-rules/store")>()),
  loadBranchRules: vi.fn(),
  loadSharedBranchRules: vi.fn(),
}));
vi.mock("@/features/pulls/ResolveConflictsView", () => ({
  ResolveConflictsView: () => <p>Resolve view</p>,
}));
// The generator is observed at its hook; a test drives its draft callback.
const generate = vi.hoisted(() => vi.fn());
vi.mock("@/features/pulls/useGeneratePrDescription", () => ({
  useGeneratePrDescription: () => ({
    generate,
    generateFromDiff: vi.fn(),
    cancel: vi.fn(),
    generating: false,
    pickingLabels: false,
  }),
}));

const REPO = "C:/repo";

function makePr(over: Partial<LocalPr> = {}): LocalPr {
  return {
    id: "a",
    title: "PR A",
    body: "",
    base: "main",
    head: "feature",
    status: "open",
    approved: false,
    labels: [],
    comments: [],
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const issue = (number: number, title: string): IssueInfo => ({
  number,
  url: "",
  title,
  state: "OPEN",
  createdAt: "",
  updatedAt: "",
  author: null,
  labels: [],
});

const status = (issues: boolean) =>
  ({
    provider: "github",
    installed: true,
    authenticated: true,
    repo: "owner/repo",
    host: "github.com",
    login: "me",
    capabilities: {},
    implemented: { issues },
  }) as unknown as ForgeStatus;

let records: LocalPr[] = [];

function renderView(id = "a") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = (pid: string) => (
    <QueryClientProvider client={client}>
      <LocalPrView repoPath={REPO} id={pid} />
    </QueryClientProvider>
  );
  const select = (pid: string) =>
    act(() => useUiStore.setState({ selectedPr: { kind: "local", id: pid } }));
  select(id);
  const result = render(ui(id));
  return {
    client,
    showPr: (pid: string) => {
      select(pid);
      result.rerender(ui(pid));
    },
  };
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));
const editBox = () =>
  screen.getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement;
const chipButton = (n: number) =>
  screen.queryByRole("button", { name: new RegExp(`issue ${n}:`) });
const linkShown = () =>
  screen.queryByRole("button", { name: "Link an issue" }) !== null;
const savedBody = (id: string) => records.find((p) => p.id === id)?.body;

/** Re-answers the forge status with issues on or off and waits for the field
 *  to follow. */
async function restatus(client: QueryClient, issues: boolean) {
  vi.mocked(forgeStatus).mockResolvedValue(status(issues));
  await act(async () => {
    await client.refetchQueries({
      predicate: (q) =>
        (q.state.data as { implemented?: unknown } | undefined)?.implemented !==
        undefined,
    });
  });
  await waitFor(() => expect(linkShown()).toBe(issues));
  await settle();
}

async function openEdit(title: RegExp) {
  await screen.findByRole("heading", { name: title });
  await waitFor(() => expect(forgeStatus).toHaveBeenCalled());
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  await waitFor(() => expect(editBox()).toBeInTheDocument());
}

async function saveAndClose(writes: number) {
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(updateLocalPr).toHaveBeenCalledTimes(writes));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

beforeEach(() => {
  vi.clearAllMocks();
  records = [makePr({ body: "Fix it\n\nCloses #3" })];
  useUiStore.setState({ repoPath: REPO, selectedPr: null });
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(listLocalPrs).mockImplementation(async () => records);
  vi.mocked(updateLocalPr).mockImplementation(async (_repo, id, mutate) => {
    records = records.map((p) => (p.id === id ? mutate(p) : p));
    return records.find((p) => p.id === id) as LocalPr;
  });
  vi.mocked(loadBranchRules).mockResolvedValue(EMPTY_BRANCH_RULES);
  vi.mocked(loadSharedBranchRules).mockResolvedValue(EMPTY_BRANCH_RULES);
  vi.mocked(gitConflictPreview).mockResolvedValue({
    status: "clean",
    conflicts: [],
  });
  vi.mocked(gitCompareBranches).mockResolvedValue({ ahead: [], behind: [] });
  vi.mocked(gitDefaultBranch).mockResolvedValue("main");
  vi.mocked(gitStatus).mockResolvedValue({
    branch: { name: "feature" },
    entries: [],
  } as unknown as RepoStatus);
  vi.mocked(forgeStatus).mockResolvedValue(status(true));
  // The open-issues page the chips resolve against: never answered unless a
  // test lists one.
  vi.mocked(forgeIssueList).mockReturnValue(new Promise(() => undefined));
});

afterAll(() => expect(unmockedCommands).toEqual([]));

describe("LocalPrView Edit keeps the reference block its chips hold", () => {
  it("writes the peeled block back when linked issues go away before Save", async () => {
    const { client } = renderView();
    await openEdit(/PR A/);
    await waitFor(() => expect(chipButton(3)).toBeTruthy());
    expect(editBox().value).toBe("Fix it");
    await restatus(client, false);
    await saveAndClose(1);
    expect(savedBody("a")).toBe("Fix it\n\nCloses #3");
  });

  it("writes the typed block once when linked issues arrive after the open", async () => {
    vi.mocked(forgeStatus).mockResolvedValue(status(false));
    const { client } = renderView();
    await openEdit(/PR A/);
    expect(editBox().value).toBe("Fix it\n\nCloses #3");
    await restatus(client, true);
    expect(chipButton(3)).toBeNull();
    await saveAndClose(1);
    expect(savedBody("a")).toBe("Fix it\n\nCloses #3");
  });

  it("carries no chip from another pull request's open into this one's Save", async () => {
    records = [
      makePr({ body: "A\n\nCloses #3" }),
      makePr({ id: "b", title: "PR B", body: "B" }),
    ];
    const { client, showPr } = renderView();
    await openEdit(/PR A/);
    await waitFor(() => expect(chipButton(3)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await restatus(client, false);
    showPr("b");
    await openEdit(/PR B/);
    await restatus(client, true);
    expect(chipButton(3)).toBeNull();
    await saveAndClose(1);
    expect(savedBody("b")).toBe("B");
  });

  it("composes the same body on a retry after a failed save", async () => {
    vi.mocked(updateLocalPr).mockRejectedValueOnce(new Error("disk full"));
    const { client } = renderView();
    await openEdit(/PR A/);
    await waitFor(() => expect(chipButton(3)).toBeTruthy());
    await restatus(client, false);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateLocalPr).toHaveBeenCalledTimes(1));
    await settle();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const failedWrite = vi.mocked(updateLocalPr).mock.calls[0][2];
    expect(failedWrite(makePr()).body).toBe("Fix it\n\nCloses #3");
    await saveAndClose(2);
    expect(savedBody("a")).toBe("Fix it\n\nCloses #3");
  });

  it("takes no chip from a generation chunk that lands after linked issues went away", async () => {
    // #9 is fed as a candidate, so a chunk the gate let through would add it.
    vi.mocked(forgeIssueList).mockResolvedValue([
      issue(3, "Three"),
      issue(9, "Nine"),
    ]);
    vi.mocked(gitCompareBranches).mockResolvedValue({
      ahead: [
        {
          hash: "1".padStart(40, "0"),
          subject: "work",
          author: "me",
          date: "2026-01-01T00:00:00Z",
        } as unknown as CommitSummary,
      ],
      behind: [],
    });
    const { client } = renderView();
    await openEdit(/PR A/);
    await waitFor(() => expect(chipButton(3)).toBeTruthy());
    const generateButton = await screen.findByRole("button", {
      name: "Generate",
    });
    await waitFor(() => expect(generateButton).toBeEnabled());
    fireEvent.click(generateButton);
    expect(generate).toHaveBeenCalledTimes(1);
    const onUpdate = generate.mock.calls[0][3] as (d: object) => void;
    await restatus(client, false);
    act(() =>
      onUpdate({
        title: "Generated",
        body: "Generated body",
        closes: [9],
        relates: [],
        jiraMentions: [],
      }),
    );
    await settle();
    await saveAndClose(1);
    expect(savedBody("a")).toBe("Generated body\n\nCloses #3");
  });

  it("writes no line for an extracted issue whose probe lands after linked issues went away", async () => {
    // #42 comes from a commit subject and isn't on the open page, so a probe
    // resolves it; the probe answers only once the field has gone.
    vi.mocked(forgeIssueList).mockResolvedValue([issue(3, "Three")]);
    vi.mocked(gitCompareBranches).mockResolvedValue({
      ahead: [
        {
          hash: "1".padStart(40, "0"),
          subject: "fix: thing (#42)",
          author: "me",
          date: "2026-01-01T00:00:00Z",
        } as unknown as CommitSummary,
      ],
      behind: [],
    });
    let answer: (issue: IssueDetails) => void = () => undefined;
    vi.mocked(forgeIssueView).mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    );
    const { client } = renderView();
    await openEdit(/PR A/);
    await waitFor(() => expect(chipButton(3)).toBeTruthy());
    await waitFor(() => expect(forgeIssueView).toHaveBeenCalledTimes(1));
    expect(vi.mocked(forgeIssueView).mock.calls[0][1]).toBe(42);
    await restatus(client, false);
    await act(async () => {
      answer({
        number: 42,
        title: "Forty-two",
        state: "OPEN",
        url: "https://github.com/owner/repo/issues/42",
      } as IssueDetails);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settle();
    await saveAndClose(1);
    expect(savedBody("a")).toBe("Fix it\n\nCloses #3");
  });
});
