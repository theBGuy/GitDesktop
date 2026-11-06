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
import { type ComponentProps, Profiler } from "react";
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
import {
  CleanupBranchesDialog,
  defaultBranchReadFailed,
} from "@/features/repository/CleanupBranchesDialog";
import {
  type BranchContentMerged,
  type ContentCheckBase,
  type ContentVerdict,
  gitBranchContentMerged,
  gitBranchDivergence,
  gitContentCheckBase,
  gitDeleteBranch,
  gitSetBranchArchived,
  gitStatus,
} from "@/lib/git/api";
import type { Branch, FileEntry, RepoStatus } from "@/lib/git/types";
import { listWorktrees } from "@/lib/git/worktree";
import { useUiStore } from "@/lib/stores/ui";
import {
  type CleanupRemovalOutcome,
  removeWorktreeForCleanup,
} from "@/lib/stores/worktree-removal";
import { unmockedCommands } from "./setup";

// The api module is the seam: the content-check hook, its limiter, the
// divergence and status queries and react-query all run for real.
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitBranchDivergence: vi.fn(),
  gitContentCheckBase: vi.fn(),
  gitBranchContentMerged: vi.fn(),
  gitStatus: vi.fn(),
  gitSetBranchArchived: vi.fn(),
  gitDeleteBranch: vi.fn(),
}));
// promotionBlocksCheckout stays real; only the removal entry point is stubbed.
vi.mock("@/lib/stores/worktree-removal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stores/worktree-removal")>()),
  removeWorktreeForCleanup: vi.fn(),
}));
// The batch's fire-time checkout read before a plain Archive.
vi.mock("@/lib/git/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/worktree")>()),
  listWorktrees: vi.fn(),
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

// Row arrow-nav scrolls the next row into view (list-keyboard-nav.ts), and
// jsdom implements no scrollIntoView.
Element.prototype.scrollIntoView ??= () => undefined;

// The content-check limiter is module state shared by every test here, so each
// test uses its own repo path and branch names, and afterEach settles every
// check a test left in flight.

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const BASE: ContentCheckBase = {
  refName: "origin/main",
  sha: "a".repeat(40),
  tree: "b".repeat(40),
};
const DAY_MS = 86_400_000;
const OLD = 200;
const FRESH = 1;

interface VerdictCall {
  repo: string;
  branch: string;
  settled: boolean;
  resolve: (verdict: ContentVerdict) => void;
}
interface RemovalCall {
  args: Parameters<typeof removeWorktreeForCleanup>[1];
  resolve: (out: CleanupRemovalOutcome) => void;
}

let verdictCalls: VerdictCall[] = [];
let removalCalls: RemovalCall[] = [];
/** What gitContentCheckBase answers: a base, null (unsupported git), or a
 *  promise the test resolves. */
let baseAnswer: ContentCheckBase | null | Promise<ContentCheckBase | null> =
  BASE;
/** Ancestry-merged branch names per repo (divergence ahead 0, behind 3). */
let mergedByRepo = new Map<string, string[]>();
/** Worktree status answers by path; a missing path stays in flight, and a
 *  promise is one the test settles. */
let statusByPath = new Map<
  string,
  "clean" | "dirty" | "reject" | Promise<RepoStatus>
>();

function branch(name: string, days: number, archived = false): Branch {
  return {
    name,
    isCurrent: false,
    upstream: null,
    lastCommitDate: new Date(Date.now() - days * DAY_MS).toISOString(),
    archived,
    upstreamAhead: 0,
    upstreamBehind: 0,
    upstreamGone: false,
    upstreamRemote: null,
    upstreamRemoteRef: null,
  };
}

beforeEach(() => {
  verdictCalls = [];
  removalCalls = [];
  baseAnswer = BASE;
  mergedByRepo = new Map();
  statusByPath = new Map();
  onCommit = null;
  vi.clearAllMocks();
  useUiStore.setState(useUiStore.getInitialState(), true);
  vi.mocked(gitBranchDivergence).mockImplementation(async (repo) =>
    (mergedByRepo.get(repo) ?? []).map((name) => ({
      name,
      ahead: 0,
      behind: 3,
    })),
  );
  vi.mocked(gitContentCheckBase).mockImplementation(async () => baseAnswer);
  vi.mocked(gitBranchContentMerged).mockImplementation(
    (repo, _sha, _tree, name) => {
      const d = deferred<BranchContentMerged>();
      const call: VerdictCall = {
        repo,
        branch: name,
        settled: false,
        resolve: (verdict) => {
          call.settled = true;
          d.resolve({ branch: name, verdict, headSha: null });
        },
      };
      verdictCalls.push(call);
      return d.promise;
    },
  );
  vi.mocked(gitStatus).mockImplementation((path) => {
    const answer = statusByPath.get(path);
    if (answer === undefined) return new Promise<RepoStatus>(() => undefined);
    if (answer instanceof Promise) return answer;
    if (answer === "reject") return Promise.reject(new Error("status failed"));
    return Promise.resolve({
      branch: {} as RepoStatus["branch"],
      entries: answer === "dirty" ? [{} as FileEntry] : [],
    });
  });
  vi.mocked(gitSetBranchArchived).mockImplementation(async () => undefined);
  vi.mocked(gitDeleteBranch).mockImplementation(async () => undefined);
  vi.mocked(listWorktrees).mockResolvedValue([]);
  vi.mocked(removeWorktreeForCleanup).mockImplementation((_client, args) => {
    const d = deferred<CleanupRemovalOutcome>();
    removalCalls.push({ args, resolve: d.resolve });
    return d.promise;
  });
});

afterEach(async () => {
  // Unmount first (the hook cancels its queued checks), then settle whatever
  // still holds a limiter slot, until nothing new starts.
  cleanup();
  for (let round = 0; round < 200; round++) {
    const open = verdictCalls.filter((c) => !c.settled);
    if (open.length === 0) break;
    for (const c of open) c.resolve("unknown");
    await new Promise((r) => setTimeout(r, 0));
  }
  for (const r of removalCalls) r.resolve({ ok: false, reason: "drained" });
});

afterAll(() => {
  expect(unmockedCommands).toEqual([]);
});

type DialogProps = ComponentProps<typeof CleanupBranchesDialog>;

/** Called on every commit of the dialog, after its DOM updates and before its
 *  passive effects run, so a test can read what each frame painted. */
let onCommit: (() => void) | null = null;

interface Setup {
  repoPath: string;
  branches: Branch[];
  merged?: string[];
  prMerged?: Record<string, string>;
  prClosed?: Record<string, string>;
  worktrees?: Record<
    string,
    { path: string; isLocked?: boolean; isMain?: boolean }
  >;
  removing?: string[];
  defaultBranch?: string | null;
  defaultBranchFailed?: boolean;
  prCheckState?: DialogProps["prCheckState"];
  prCheckPaused?: boolean;
  /** The repo the app shows; defaults to `repoPath`. */
  liveRepo?: string;
}

function propsFor(s: Setup): DialogProps {
  const removing = new Set(s.removing ?? []);
  return {
    repoPath: s.repoPath,
    open: true,
    onClose: vi.fn(),
    branches: s.branches,
    // An explicit undefined is the loading default-branch read.
    defaultBranch: "defaultBranch" in s ? s.defaultBranch : "main",
    defaultBranchFailed: s.defaultBranchFailed ?? false,
    currentBranch: null,
    isProtected: () => false,
    worktreeFacts: new Map(
      Object.entries(s.worktrees ?? {}).map(([name, w]) => [
        name,
        {
          path: w.path,
          isLocked: w.isLocked ?? false,
          isMain: w.isMain ?? false,
        },
      ]),
    ),
    isWorktreeRemoving: (name) => removing.has(name),
    worktreeCheckState: "checked",
    rulesSettling: false,
    prMergedByBranch: new Map(Object.entries(s.prMerged ?? {})),
    prClosedByBranch: new Map(Object.entries(s.prClosed ?? {})),
    prCheckState: s.prCheckState ?? "checked",
    prCheckPaused: s.prCheckPaused ?? false,
  };
}

function renderDialog(s: Setup) {
  mergedByRepo.set(s.repoPath, s.merged ?? []);
  useUiStore.setState({ repoPath: s.liveRepo ?? s.repoPath });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let props = propsFor(s);
  const view = render(
    <QueryClientProvider client={client}>
      <Profiler id="cleanup" onRender={() => onCommit?.()}>
        <CleanupBranchesDialog {...props} />
      </Profiler>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  return {
    user,
    client,
    props: () => props,
    rerender(patch: Partial<DialogProps>) {
      props = { ...props, ...patch };
      view.rerender(
        <QueryClientProvider client={client}>
          <Profiler id="cleanup" onRender={() => onCommit?.()}>
            <CleanupBranchesDialog {...props} />
          </Profiler>
        </QueryClientProvider>,
      );
    },
  };
}

/** Lands each named branch's verdict as its check reaches the limiter; at most
 *  four run at once, so later names start only as earlier ones settle. */
async function landVerdicts(want: Record<string, ContentVerdict>) {
  const left = new Set(Object.keys(want));
  for (let round = 0; left.size > 0; round++) {
    if (round > 400)
      throw new Error(`never requested: ${[...left].join(", ")}`);
    const ready = verdictCalls.filter((c) => !c.settled && left.has(c.branch));
    await act(async () => {
      for (const c of ready) {
        c.resolve(want[c.branch]);
        left.delete(c.branch);
      }
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** Every verdict check the test hasn't landed yet answers `verdict`. */
async function landRest(names: string[], verdict: ContentVerdict) {
  await landVerdicts(Object.fromEntries(names.map((n) => [n, verdict])));
}

const listed = () =>
  Array.from(document.querySelectorAll("[data-row]")).map((el) =>
    el.getAttribute("data-row"),
  );
const boxOf = (name: string) => {
  const box = document.querySelector<HTMLElement>(
    `[data-row="${CSS.escape(name)}"]`,
  );
  if (box === null) throw new Error(`no row for ${name}`);
  return box;
};
const rowOf = (name: string) => {
  const row = boxOf(name).closest("label")?.parentElement;
  if (!row) throw new Error(`no row element for ${name}`);
  return row;
};
/** Whether `name`'s row reached the DOM in any commit `run` makes, a later
 *  commit in the same act removing it included, and whether that row carried
 *  a clean verdict. */
function rowsPainted(name: string, run: () => void) {
  const sel = `[data-row="${CSS.escape(name)}"]`;
  const observer = new MutationObserver(() => undefined);
  observer.observe(document.body, { childList: true, subtree: true });
  run();
  const added = observer.takeRecords().flatMap((r) => [...r.addedNodes]);
  observer.disconnect();
  const box =
    added.flatMap((n) => {
      if (!(n instanceof Element)) return [];
      return n.matches(sel) ? [n] : [...n.querySelectorAll(sel)];
    })[0] ?? document.querySelector(sel);
  const row = box?.closest("label")?.parentElement ?? null;
  return {
    painted: box !== null,
    verdict: row !== null && within(row).queryByText(/^in$/) !== null,
  };
}
const isChecked = (name: string) =>
  boxOf(name).getAttribute("aria-checked") === "true";
const mainDialog = () =>
  screen.getByRole("dialog", { name: "Clean up branches", hidden: true });
const primary = () =>
  within(mainDialog()).getByRole("button", {
    name: /^(Archive|Delete) \d+ branch/,
    hidden: true,
  });
const pressed = (name: string | RegExp) =>
  screen.getByRole("button", { name }).getAttribute("aria-pressed") === "true";

type CriteriaWant = { merged: boolean; closed: boolean; idle: boolean };
const CRITERION_BUTTON = {
  merged: "Merged",
  closed: "Closed PR",
  idle: "Idle for",
} as const;

async function setCriteria(
  user: ReturnType<typeof userEvent.setup>,
  want: CriteriaWant,
) {
  for (const key of ["merged", "closed", "idle"] as const) {
    if (pressed(CRITERION_BUTTON[key]) !== want[key])
      await user.click(
        screen.getByRole("button", { name: CRITERION_BUTTON[key] }),
      );
  }
}

const optIn = () =>
  screen.getByRole("checkbox", {
    name: "Include branches checked out in a worktree",
  });

describe("the list is the union of the enabled criteria", () => {
  it("lists exactly each combination's rows, and asks for a criterion when none is on", async () => {
    const { user } = renderDialog({
      repoPath: "C:/repos/union",
      branches: [
        branch("u1-anc", FRESH),
        branch("u1-prm", FRESH),
        branch("u1-cls", FRESH),
        branch("u1-idle", OLD),
        branch("u1-none", FRESH),
      ],
      merged: ["u1-anc"],
      prMerged: { "u1-prm": "#12" },
      prClosed: { "u1-cls": "#34" },
    });
    await waitFor(() => expect(listed()).toContain("u1-anc"));
    // Every criterion on, the worktree opt-in off.
    expect(pressed("Merged")).toBe(true);
    expect(pressed("Closed PR")).toBe(true);
    expect(pressed("Idle for")).toBe(true);
    expect(optIn()).toHaveAttribute("aria-checked", "false");

    const rows = {
      merged: ["u1-anc", "u1-prm"],
      closed: ["u1-cls"],
      idle: ["u1-idle"],
    };
    const combos: CriteriaWant[] = [];
    for (let bits = 7; bits >= 1; bits--)
      combos.push({
        merged: (bits & 4) !== 0,
        closed: (bits & 2) !== 0,
        idle: (bits & 1) !== 0,
      });
    for (const want of combos) {
      await setCriteria(user, want);
      const expected = (["merged", "closed", "idle"] as const)
        .filter((k) => want[k])
        .flatMap((k) => rows[k]);
      expect(new Set(listed())).toEqual(new Set(expected));
    }
    await setCriteria(user, { merged: false, closed: false, idle: false });
    expect(listed()).toEqual([]);
    expect(
      screen.getAllByText("Turn on Merged, Closed PR or Idle to list branches.")
        .length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", { name: /Select all|Deselect all/ }),
    ).toBeNull();
  });

  it("composes the no-match copy from the enabled criteria only", async () => {
    const { user } = renderDialog({
      repoPath: "C:/repos/nomatch",
      branches: [branch("u2-fresh", FRESH)],
    });
    // The default branch's name sits in its own mono span, so match the
    // paragraph's whole text.
    const paragraph = (text: string) =>
      screen.getByText(
        (_, el) => el?.tagName === "P" && el.textContent === text,
      );
    await waitFor(() =>
      paragraph(
        "No stale branches — nothing is merged into main, directly or through a recent pull request, nothing is matched to a pull request closed without merging, and nothing is idle for 60 days. Try a shorter window.",
      ),
    );
    await setCriteria(user, { merged: true, closed: false, idle: false });
    paragraph(
      "No stale branches — nothing is merged into main, directly or through a recent pull request.",
    );
    await setCriteria(user, { merged: false, closed: true, idle: false });
    paragraph(
      "No stale branches — nothing is matched to a pull request closed without merging.",
    );
    await setCriteria(user, { merged: false, closed: false, idle: true });
    paragraph(
      "No stale branches — nothing is idle for 60 days. Try a shorter window.",
    );
  });

  it("turns Idle on when a window is pressed while it is off", async () => {
    const { user } = renderDialog({
      repoPath: "C:/repos/window",
      branches: [branch("u3-70", 70)],
    });
    await waitFor(() => expect(listed()).toEqual(["u3-70"]));
    await user.click(screen.getByRole("button", { name: "90" }));
    expect(listed()).toEqual([]);
    await setCriteria(user, { merged: true, closed: true, idle: false });
    const thirty = screen.getByRole("button", { name: "30" });
    expect(thirty).toBeEnabled();
    await user.click(thirty);
    expect(pressed("Idle for")).toBe(true);
    expect(pressed("30")).toBe(true);
    expect(listed()).toEqual(["u3-70"]);
  });
});

describe("pre-checks", () => {
  it("seeds ancestry rows at once and verdict-gated rows only as verdicts land", async () => {
    renderDialog({
      repoPath: "C:/repos/policy",
      branches: [
        branch("p-anc", FRESH),
        branch("p-idle-clean", OLD),
        branch("p-idle-changes", OLD),
        branch("p-idle-unknown", OLD),
        branch("p-pr-clean", FRESH),
        branch("p-pr-changes", FRESH),
        branch("p-pr-unknown", FRESH),
      ],
      merged: ["p-anc"],
      prClosed: { "p-pr-clean": "#1", "p-pr-unknown": "#3" },
      prMerged: { "p-pr-changes": "#2" },
    });
    await waitFor(() => expect(isChecked("p-anc")).toBe(true));
    // Nothing verdict-gated is checked before its verdict lands.
    for (const n of listed().filter((n) => n !== "p-anc"))
      expect(isChecked(n as string)).toBe(false);
    expect(gitBranchContentMerged).not.toHaveBeenCalledWith(
      "C:/repos/policy",
      expect.anything(),
      expect.anything(),
      "p-anc",
    );
    await landVerdicts({
      "p-idle-clean": "clean",
      "p-idle-changes": "changes",
      "p-idle-unknown": "unknown",
      "p-pr-clean": "clean",
      "p-pr-changes": "changes",
      "p-pr-unknown": "unknown",
    });
    await waitFor(() => expect(isChecked("p-idle-clean")).toBe(true));
    expect(isChecked("p-anc")).toBe(true);
    expect(isChecked("p-idle-changes")).toBe(false);
    expect(isChecked("p-idle-unknown")).toBe(true);
    expect(isChecked("p-pr-clean")).toBe(true);
    expect(isChecked("p-pr-changes")).toBe(false);
    expect(isChecked("p-pr-unknown")).toBe(false);
  });

  it("never overrides a row the user touched before its verdict landed", async () => {
    const { user } = renderDialog({
      repoPath: "C:/repos/touched",
      branches: [branch("t-unchecked", OLD), branch("t-checked", OLD)],
    });
    await waitFor(() => expect(listed()).toHaveLength(2));
    await user.click(boxOf("t-unchecked"));
    await user.click(boxOf("t-unchecked"));
    await user.click(boxOf("t-checked"));
    expect(isChecked("t-unchecked")).toBe(false);
    expect(isChecked("t-checked")).toBe(true);
    await landVerdicts({ "t-unchecked": "clean", "t-checked": "changes" });
    await waitFor(() =>
      expect(screen.getAllByText(/^changes not in$/).length).toBe(1),
    );
    expect(isChecked("t-unchecked")).toBe(false);
    expect(isChecked("t-checked")).toBe(true);
  });

  // A row listed through a pull request alone never pre-checks on idleness
  // while the user has Idle off; turning Idle on adds it (untouched).
  describe("an idle fallback counts only while Idle is on", () => {
    it("when the check is unsupported", async () => {
      const base = deferred<ContentCheckBase | null>();
      baseAnswer = base.promise;
      const { user } = renderDialog({
        repoPath: "C:/repos/fallback-unsupported",
        branches: [branch("f1-closed-old", OLD)],
        prClosed: { "f1-closed-old": "#5" },
      });
      await waitFor(() => expect(listed()).toEqual(["f1-closed-old"]));
      await setCriteria(user, { merged: true, closed: true, idle: false });
      expect(listed()).toEqual(["f1-closed-old"]);
      await act(async () => base.resolve(null));
      // Unsupported: the verdict slot goes away.
      await waitFor(() =>
        expect(
          rowOf("f1-closed-old").querySelector(".animate-pulse"),
        ).toBeNull(),
      );
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(isChecked("f1-closed-old")).toBe(false);
      await setCriteria(user, { merged: true, closed: true, idle: true });
      await waitFor(() => expect(isChecked("f1-closed-old")).toBe(true));
      expect(gitBranchContentMerged).not.toHaveBeenCalled();
    });

    it("when the row's verdict is unknown", async () => {
      const { user } = renderDialog({
        repoPath: "C:/repos/fallback-unknown",
        branches: [branch("f2-closed-old", OLD)],
        prClosed: { "f2-closed-old": "#6" },
      });
      await waitFor(() => expect(listed()).toEqual(["f2-closed-old"]));
      await setCriteria(user, { merged: true, closed: true, idle: false });
      await landVerdicts({ "f2-closed-old": "unknown" });
      await waitFor(() =>
        expect(
          rowOf("f2-closed-old").querySelector(".animate-pulse"),
        ).toBeNull(),
      );
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(isChecked("f2-closed-old")).toBe(false);
      await setCriteria(user, { merged: true, closed: true, idle: true });
      await waitFor(() => expect(isChecked("f2-closed-old")).toBe(true));
    });
  });
});

describe("rows", () => {
  it("shows a word for every reason that applies, and a verdict only from a landed answer", async () => {
    statusByPath.set("C:/wt/b-stack", "clean");
    const { user } = renderDialog({
      repoPath: "C:/repos/badges",
      branches: [
        branch("b-stack", OLD),
        branch("b-anc", FRESH),
        branch("b-prm", FRESH),
        branch("b-unknown", OLD),
        branch("b-locked", OLD),
      ],
      merged: ["b-anc"],
      prMerged: { "b-prm": "#12" },
      prClosed: { "b-stack": "#34" },
      worktrees: {
        "b-stack": { path: "C:/wt/b-stack" },
        "b-locked": { path: "C:/wt/b-locked", isLocked: true },
      },
    });
    await user.click(optIn());
    await waitFor(() => expect(listed()).toContain("b-stack"));
    // Pending verdicts paint a skeleton, never a word.
    expect(rowOf("b-stack").querySelector(".animate-pulse")).not.toBeNull();
    await landVerdicts({
      "b-stack": "changes",
      "b-prm": "clean",
      "b-unknown": "unknown",
      "b-locked": "clean",
    });
    const stack = rowOf("b-stack");
    await waitFor(() =>
      expect(within(stack).getByText(/^changes not in$/)).toBeInTheDocument(),
    );
    for (const word of ["idle", "closed #34", "worktree"])
      expect(within(stack).getByText(word)).toBeInTheDocument();
    expect(within(stack).getByText("closed #34")).toHaveAttribute(
      "title",
      "Closed without merging — matched by branch name",
    );
    expect(
      within(stack)
        .getByText(/^changes not in$/)
        .closest("[title]"),
    ).toHaveAttribute("title", "Has changes not in origin/main");
    expect(within(rowOf("b-anc")).getByText("merged")).toBeInTheDocument();
    // Ancestry-merged rows skip the check: no verdict slot at all.
    expect(rowOf("b-anc").querySelector(".animate-pulse")).toBeNull();
    expect(within(rowOf("b-prm")).getByText("merged #12")).toHaveAttribute(
      "title",
      "Merged via pull request #12 — matched by branch name",
    );
    expect(within(rowOf("b-prm")).getByText(/^in$/)).toBeInTheDocument();
    expect(
      within(rowOf("b-locked")).getByText("worktree locked"),
    ).toBeInTheDocument();
    // An unknown verdict shows nothing, not even a skeleton.
    const unknown = rowOf("b-unknown");
    expect(within(unknown).queryByText(/^in$|^changes not in$/)).toBeNull();
    expect(unknown.querySelector(".animate-pulse")).toBeNull();
    // The compared ref reaches AT once settled.
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Contents compared with origin/main.",
      ),
    );
  });

  it("keeps a long name truncated in its own span", async () => {
    const long = `l-${"very-long-branch-name-".repeat(6)}end`;
    renderDialog({ repoPath: "C:/repos/long", branches: [branch(long, OLD)] });
    await waitFor(() => expect(listed()).toEqual([long]));
    const name = within(rowOf(long)).getByText(long);
    expect(name).toHaveClass("truncate", "min-w-0", "flex-1");
  });
});

describe("worktree rows", () => {
  function worktreeSetup(repoPath: string) {
    statusByPath.set("C:/wt/w-clean", "clean");
    statusByPath.set("C:/wt/w-dirty", "dirty");
    statusByPath.set("C:/wt/w-unreadable", "reject");
    return renderDialog({
      repoPath,
      branches: [
        branch("w-locked", 400),
        branch("w-clean", 300),
        branch("w-dirty", 250),
        branch("w-pending", 220),
        branch("w-unreadable", 210),
        branch("w-main", OLD),
        branch("w-removing", OLD),
        branch("w-plain", 100),
      ],
      worktrees: {
        "w-locked": { path: "C:/wt/w-locked", isLocked: true },
        "w-clean": { path: "C:/wt/w-clean" },
        "w-dirty": { path: "C:/wt/w-dirty" },
        "w-pending": { path: "C:/wt/w-pending" },
        "w-unreadable": { path: "C:/wt/w-unreadable" },
        "w-main": { path: "C:/wt/w-main", isMain: true },
        "w-removing": { path: "C:/wt/w-removing" },
      },
      removing: ["w-removing"],
    });
  }

  it("lists held rows only under the opt-in, never the main workspace's", async () => {
    const { user } = worktreeSetup("C:/repos/wt-list");
    await waitFor(() => expect(listed()).toContain("w-plain"));
    // A branch whose worktree is being removed is a plain Archive row.
    expect(new Set(listed())).toEqual(new Set(["w-removing", "w-plain"]));
    expect(within(rowOf("w-removing")).queryByText("worktree")).toBeNull();
    await user.click(optIn());
    expect(listed()).not.toContain("w-main");
    expect(listed()).toEqual(
      expect.arrayContaining([
        "w-locked",
        "w-clean",
        "w-dirty",
        "w-pending",
        "w-unreadable",
      ]),
    );
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    expect(listed()).not.toContain("w-removing");
    expect(listed()).not.toContain("w-main");
  });

  it("holds locked, dirty, pending and unreadable rows: focusable, explained, never toggled", async () => {
    const pendingRead = deferred<RepoStatus>();
    statusByPath.set("C:/wt/w-pending", pendingRead.promise);
    const { user } = worktreeSetup("C:/repos/wt-held");
    await user.click(optIn());
    await waitFor(() =>
      expect(
        screen.getByText(
          "Worktree has uncommitted changes, so it can't be removed.",
        ),
      ).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        screen.getByText(
          "Couldn't check the worktree for uncommitted changes.",
        ),
      ).toBeInTheDocument(),
    );
    const reasons: Record<string, string> = {
      "w-locked": "Worktree is locked, so it can't be removed.",
      "w-dirty": "Worktree has uncommitted changes, so it can't be removed.",
      "w-unreadable": "Couldn't check the worktree for uncommitted changes.",
      // AT only: its visible cue is the skeleton.
      "w-pending": "Checking this worktree for uncommitted changes…",
    };
    for (const [name, reason] of Object.entries(reasons)) {
      const box = boxOf(name);
      expect(box).toHaveAttribute("aria-disabled", "true");
      const id = box.getAttribute("aria-describedby");
      expect(id).toBeTruthy();
      expect(document.getElementById(id as string)).toHaveTextContent(reason);
    }
    expect(boxOf("w-clean")).not.toHaveAttribute("aria-disabled");

    // Row 0 is held, yet it is the list's tab stop.
    expect(listed()[0]).toBe("w-locked");
    // The accessible name carries the visible count (WCAG 2.5.3).
    const selectAll = screen.getByRole("button", {
      name: "Select all, 0 of 3 selected",
    });
    selectAll.focus();
    await user.tab();
    expect(document.activeElement).toBe(boxOf("w-locked"));
    // Space, a click on the box and a click on its label all refuse.
    await user.keyboard(" ");
    await user.click(boxOf("w-locked"));
    await user.click(within(rowOf("w-locked")).getByText("w-locked"));
    expect(isChecked("w-locked")).toBe(false);
    // Arrowing walks through held rows to the actionable ones.
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(boxOf("w-clean"));
    await user.keyboard(" ");
    expect(isChecked("w-clean")).toBe(true);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(boxOf("w-dirty"));
    await user.keyboard(" ");
    expect(isChecked("w-dirty")).toBe(false);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(boxOf("w-pending"));
    await user.keyboard(" ");
    expect(isChecked("w-pending")).toBe(false);

    // Select all grabs the actionable rows only.
    await user.click(screen.getByRole("button", { name: /Select all/ }));
    for (const name of Object.keys(reasons))
      expect(isChecked(name)).toBe(false);
    expect(isChecked("w-clean")).toBe(true);
    expect(isChecked("w-plain")).toBe(true);
    expect(screen.getByText("3 of 3 selected")).toBeInTheDocument();

    // The pending read lands clean: the hold lifts with neither press applied.
    await act(async () =>
      pendingRead.resolve({ branch: {} as RepoStatus["branch"], entries: [] }),
    );
    await waitFor(() =>
      expect(boxOf("w-pending")).not.toHaveAttribute("aria-disabled"),
    );
    expect(isChecked("w-pending")).toBe(false);
    expect(screen.getByText("3 of 4 selected")).toBeInTheDocument();
    await user.click(boxOf("w-pending"));
    expect(isChecked("w-pending")).toBe(true);
  });
});

describe("the batch", () => {
  it("acts only on visible checked rows", async () => {
    const { user } = renderDialog({
      repoPath: "C:/repos/visible",
      branches: [branch("v-a", OLD), branch("v-b", OLD), branch("v-c", FRESH)],
      prClosed: { "v-c": "#7" },
    });
    await landVerdicts({ "v-a": "clean", "v-b": "clean", "v-c": "clean" });
    await waitFor(() => expect(isChecked("v-c")).toBe(true));
    expect(screen.getByText("3 of 3 selected")).toBeInTheDocument();
    await setCriteria(user, { merged: true, closed: false, idle: true });
    expect(listed()).not.toContain("v-c");
    await user.click(primary());
    await waitFor(() => expect(gitSetBranchArchived).toHaveBeenCalledTimes(2));
    expect(gitSetBranchArchived).not.toHaveBeenCalledWith(
      "C:/repos/visible",
      "v-c",
      true,
    );
  });

  it("removes each worktree in turn, only after the row before it settles", async () => {
    statusByPath.set("C:/wt/i-w1", "clean");
    statusByPath.set("C:/wt/i-w2", "clean");
    const view = renderDialog({
      repoPath: "C:/repos/ordered",
      branches: [
        branch("i-w1", 300),
        branch("i-w2", 250),
        branch("i-plain", OLD),
      ],
      worktrees: {
        "i-w1": { path: "C:/wt/i-w1" },
        "i-w2": { path: "C:/wt/i-w2" },
      },
    });
    const { user } = view;
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await user.click(optIn());
    await landVerdicts({ "i-plain": "clean" });
    await waitFor(() =>
      expect(boxOf("i-w2")).not.toHaveAttribute("aria-disabled"),
    );
    expect(boxOf("i-w1")).not.toHaveAttribute("aria-disabled");
    // Worktree rows never pre-check.
    expect(isChecked("i-w1")).toBe(false);
    await user.click(boxOf("i-w1"));
    await user.click(boxOf("i-w2"));
    await waitFor(() => expect(isChecked("i-plain")).toBe(true));
    await user.click(primary());
    const confirm = await screen.findByRole("dialog", {
      name: "Delete branches?",
    });
    expect(confirm).toHaveTextContent(
      "Removes 2 worktrees and deletes 3 branches, including commits that exist only on them. Removing a worktree deletes its folder, including ignored files such as build output. This can't be undone.",
    );
    await user.click(
      within(confirm).getByRole("button", { name: "Delete 3 branches" }),
    );
    await waitFor(() => expect(removalCalls).toHaveLength(1));
    expect(removalCalls[0].args).toEqual({
      repoPath: "C:/repos/ordered",
      path: "C:/wt/i-w1",
      name: "i-w1",
      branch: "i-w1",
      then: "delete",
    });
    // The batch's own removal mark doesn't drop the row mid-run.
    view.rerender({ isWorktreeRemoving: (n) => n === "i-w1" });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(listed()).toContain("i-w1");
    expect(removalCalls).toHaveLength(1);
    // The removal's settle clears its own mark.
    view.rerender({ isWorktreeRemoving: () => false });
    await act(async () => {
      removalCalls[0].resolve({ ok: false, reason: "the worktree is locked" });
    });
    await waitFor(() => expect(removalCalls).toHaveLength(2));
    expect(removalCalls[1].args.path).toBe("C:/wt/i-w2");
    expect(gitDeleteBranch).not.toHaveBeenCalled();
    await act(async () => {
      removalCalls[1].resolve({ ok: true, branch: "keptMoved" });
    });
    await waitFor(() =>
      expect(gitDeleteBranch).toHaveBeenCalledWith(
        "C:/repos/ordered",
        "i-plain",
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByText("Couldn't delete: the worktree is locked"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(
        "Couldn't delete: the worktree was removed, but the branch gained new commits and was kept",
      ),
    ).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith("Deleted 1, 2 failed");
    expect(view.props().onClose).not.toHaveBeenCalled();
  });

  it("keeps acting on the repo it started in across a switch", async () => {
    const view = renderDialog({
      repoPath: "C:/repos/late-a",
      branches: [branch("late-1", OLD), branch("late-2", OLD)],
    });
    await landVerdicts({ "late-1": "clean", "late-2": "clean" });
    await waitFor(() => expect(isChecked("late-2")).toBe(true));
    const first = deferred<undefined>();
    vi.mocked(gitSetBranchArchived).mockImplementationOnce(() => first.promise);
    await view.user.click(primary());
    await waitFor(() => expect(gitSetBranchArchived).toHaveBeenCalledTimes(1));
    act(() => useUiStore.setState({ repoPath: "C:/repos/late-b" }));
    view.rerender({ repoPath: "C:/repos/late-b", branches: [] });
    await act(async () => first.resolve(undefined));
    await waitFor(() => expect(gitSetBranchArchived).toHaveBeenCalledTimes(2));
    for (const call of vi.mocked(gitSetBranchArchived).mock.calls)
      expect(call[0]).toBe("C:/repos/late-a");
  });
});

describe("confirms", () => {
  it("counts and acts on the snapshot taken when the confirm opened", async () => {
    const view = renderDialog({
      repoPath: "C:/repos/snapshot",
      branches: [
        branch("s-clean", OLD),
        branch("s-changes", 190),
        branch("s-late", 180),
      ],
    });
    const { user } = view;
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await landVerdicts({ "s-clean": "clean", "s-changes": "changes" });
    await waitFor(() => expect(isChecked("s-clean")).toBe(true));
    await user.click(boxOf("s-changes"));
    await user.click(primary());
    const confirm = await screen.findByRole("dialog", {
      name: "Delete branches?",
    });
    const body =
      "Permanently deletes 2 branches, including commits that exist only on them. 1 of the branches has changes not in origin/main. This can't be undone.";
    expect(confirm).toHaveTextContent(body);
    // A verdict landing under the confirm checks the row in the list only.
    await landVerdicts({ "s-late": "clean" });
    await waitFor(() => expect(isChecked("s-late")).toBe(true));
    expect(confirm).toHaveTextContent(body);
    const go = within(confirm).getByRole("button", {
      name: "Delete 2 branches",
    });
    await user.click(go);
    await waitFor(() => expect(view.props().onClose).toHaveBeenCalled());
    expect(gitDeleteBranch).toHaveBeenCalledTimes(2);
    const deleted = vi.mocked(gitDeleteBranch).mock.calls.map((c) => c[1]);
    expect(new Set(deleted)).toEqual(new Set(["s-clean", "s-changes"]));
  });

  it("closes the Delete confirm on a repo switch, and nothing runs", async () => {
    statusByPath.set("C:/wt/e-w", "clean");
    const view = renderDialog({
      repoPath: "C:/repos/pin-a",
      branches: [branch("e-old", OLD), branch("e-w", OLD)],
      worktrees: { "e-w": { path: "C:/wt/e-w" } },
    });
    const { user } = view;
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await user.click(optIn());
    await landVerdicts({ "e-old": "clean", "e-w": "clean" });
    await waitFor(() => expect(isChecked("e-old")).toBe(true));
    await waitFor(() =>
      expect(boxOf("e-w")).not.toHaveAttribute("aria-disabled"),
    );
    await user.click(boxOf("e-w"));
    await user.click(primary());
    await screen.findByRole("dialog", { name: "Delete branches?" });
    act(() => useUiStore.setState({ repoPath: "C:/repos/pin-b" }));
    view.rerender({ repoPath: "C:/repos/pin-b" });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    // A confirm that outlived the switch gets pressed: whatever it does must
    // not reach either repo.
    const stale = screen.queryByRole("dialog", { name: "Delete branches?" });
    if (stale)
      await user.click(
        within(stale).getByRole("button", { name: "Delete 2 branches" }),
      );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(gitDeleteBranch).not.toHaveBeenCalled();
    expect(removeWorktreeForCleanup).not.toHaveBeenCalled();
    expect(stale).toBeNull();
  });

  it("refuses a confirm whose repo is no longer the one on screen", async () => {
    const { user } = renderDialog({
      repoPath: "C:/repos/refuse-a",
      liveRepo: "C:/repos/refuse-b",
      branches: [branch("r-old", OLD)],
    });
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await landVerdicts({ "r-old": "clean" });
    await waitFor(() => expect(isChecked("r-old")).toBe(true));
    await user.click(primary());
    const confirm = await screen.findByRole("dialog", {
      name: "Delete branch?",
    });
    await user.click(
      within(confirm).getByRole("button", { name: "Delete 1 branch" }),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(gitDeleteBranch).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith(
      expect.stringContaining("nothing was deleted"),
    );
  });

  it("confirms Archive only when it removes a worktree, and cancel acts on nothing", async () => {
    statusByPath.set("C:/wt/a-w", "clean");
    const { user } = renderDialog({
      repoPath: "C:/repos/archive-wt",
      branches: [branch("a-w", OLD), branch("a-old", OLD)],
      worktrees: { "a-w": { path: "C:/wt/a-w" } },
    });
    await user.click(optIn());
    await landVerdicts({ "a-old": "clean", "a-w": "clean" });
    await waitFor(() =>
      expect(boxOf("a-w")).not.toHaveAttribute("aria-disabled"),
    );
    await waitFor(() => expect(isChecked("a-old")).toBe(true));
    await user.click(boxOf("a-w"));
    await user.click(primary());
    const confirm = await screen.findByRole("dialog", {
      name: "Remove worktree?",
    });
    expect(confirm).toHaveTextContent(
      "Removes 1 worktree, then archives 2 branches. Removing a worktree deletes its folder, including ignored files such as build output. Archived branches can be unarchived anytime.",
    );
    // The button says what the title asks.
    expect(
      within(confirm).getByRole("button", {
        name: "Remove and archive 2 branches",
      }),
    ).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Remove worktree?" }),
      ).toBeNull(),
    );
    expect(removeWorktreeForCleanup).not.toHaveBeenCalled();
    expect(gitSetBranchArchived).not.toHaveBeenCalled();
    // Without a worktree row, Archive runs at once.
    await user.click(boxOf("a-w"));
    await user.click(primary());
    await waitFor(() =>
      expect(gitSetBranchArchived).toHaveBeenCalledWith(
        "C:/repos/archive-wt",
        "a-old",
        true,
      ),
    );
    expect(
      screen.queryByRole("dialog", { name: "Remove worktree?" }),
    ).toBeNull();
  });
});

describe("reopening", () => {
  it("resets every control after a Delete run, and re-checks verdicts for this open", async () => {
    statusByPath.set("C:/wt/n-w", "clean");
    const view = renderDialog({
      repoPath: "C:/repos/reopen",
      branches: [
        branch("n-gone", OLD),
        branch("n-stays", 180),
        branch("n-w", OLD),
      ],
      worktrees: { "n-w": { path: "C:/wt/n-w" } },
    });
    const { user } = view;
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await user.click(optIn());
    await user.click(screen.getByRole("button", { name: "90" }));
    await setCriteria(user, { merged: true, closed: false, idle: true });
    await landVerdicts({
      "n-gone": "clean",
      "n-stays": "changes",
      "n-w": "clean",
    });
    await waitFor(() => expect(isChecked("n-gone")).toBe(true));
    await user.click(primary());
    const confirm = await screen.findByRole("dialog", {
      name: "Delete branch?",
    });
    await user.click(
      within(confirm).getByRole("button", { name: "Delete 1 branch" }),
    );
    await waitFor(() => expect(view.props().onClose).toHaveBeenCalled());

    view.rerender({ open: false });
    view.rerender({ open: true });
    await waitFor(() => expect(listed().length).toBeGreaterThan(0));
    expect(pressed(/^archive$/i)).toBe(true);
    expect(pressed(/^delete$/i)).toBe(false);
    expect(pressed("Merged")).toBe(true);
    expect(pressed("Closed PR")).toBe(true);
    expect(pressed("Idle for")).toBe(true);
    expect(pressed("60")).toBe(true);
    expect(optIn()).toHaveAttribute("aria-checked", "false");
    // The earlier open's verdicts never count here: the slot is pending again.
    expect(within(rowOf("n-stays")).queryByText(/^changes not in$/)).toBeNull();
    expect(rowOf("n-stays").querySelector(".animate-pulse")).not.toBeNull();
  });
});

describe("the status region", () => {
  it("ticks outside the live region and keeps the region's text steady", async () => {
    renderDialog({
      repoPath: "C:/repos/ticking",
      branches: [branch("k-1", OLD), branch("k-2", 190), branch("k-3", 180)],
    });
    const region = screen.getByRole("status");
    const tick = await screen.findByText(/^Checked 0 of 3 branches/);
    expect(tick.closest("p")).toHaveAttribute("aria-hidden", "true");
    expect(region.contains(tick)).toBe(false);
    expect(region).toHaveTextContent(
      "Checking branches for changes not in the default branch…",
    );
    const before = region.textContent;
    await landVerdicts({ "k-1": "clean" });
    await screen.findByText(/^Checked 1 of 3 branches/);
    expect(region.textContent).toBe(before);
    await landVerdicts({ "k-2": "changes" });
    await screen.findByText(/^Checked 2 of 3 branches/);
    expect(region.textContent).toBe(before);
    await landVerdicts({ "k-3": "clean" });
    await waitFor(() =>
      expect(region).toHaveTextContent("Contents compared with origin/main."),
    );
    expect(screen.queryByText(/^Checked \d+ of 3/)).toBeNull();
  });

  it("names a failed pull-request read", async () => {
    renderDialog({
      repoPath: "C:/repos/prfailed",
      branches: [branch("q-old", OLD)],
      prCheckState: "failed",
    });
    await waitFor(() => expect(listed()).toEqual(["q-old"]));
    expect(
      screen.getByText(
        "Pull requests couldn't be checked — a branch merged or closed through one may be missing.",
      ),
    ).toBeInTheDocument();
  });
});

describe("keyboard", () => {
  it("arrows across the criteria group and survives a flip that hides the active row", async () => {
    const view = renderDialog({
      repoPath: "C:/repos/keys",
      branches: [branch("y-idle", OLD), branch("y-closed", FRESH)],
      prClosed: { "y-closed": "#8" },
    });
    const { user } = view;
    await waitFor(() => expect(listed()).toHaveLength(2));
    screen.getByRole("button", { name: "Merged" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Closed PR" }),
    );
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Idle for" }),
    );
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "90" }),
    );
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Merged" }),
    );

    // y-closed is the last row; make it active, then hide it under focus: its
    // pull request no longer reads as closed.
    act(() => boxOf("y-idle").focus());
    await user.keyboard("{ArrowDown}");
    const active = boxOf("y-closed");
    expect(document.activeElement).toBe(active);
    // Chromium fires focusout as it removes the focused node, which the
    // dialog's focus manager answers; jsdom drops focus to <body> silently.
    act(() => {
      active.dispatchEvent(
        new FocusEvent("focusout", { bubbles: true, relatedTarget: null }),
      );
      view.rerender({ prClosedByBranch: new Map() });
    });
    expect(listed()).toEqual(["y-idle"]);
    await waitFor(() => expect(document.activeElement).toBe(mainDialog()));
    // It focuses the popup again a frame later; let that land first.
    await act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    expect(document.activeElement).toBe(mainDialog());
    expect(boxOf("y-idle")).toHaveAttribute("tabindex", "0");
    act(() => boxOf("y-idle").focus());
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(boxOf("y-idle"));
  });
});

describe("repo switch while open", () => {
  it("drops the previous repo's verdicts and seeds afresh", async () => {
    const view = renderDialog({
      repoPath: "C:/repos/switch-a",
      branches: [branch("x-a", OLD)],
    });
    await landVerdicts({ "x-a": "clean" });
    await waitFor(() => expect(isChecked("x-a")).toBe(true));
    act(() => useUiStore.setState({ repoPath: "C:/repos/switch-b" }));
    view.rerender({
      repoPath: "C:/repos/switch-b",
      branches: [branch("x-a", OLD), branch("x-b", OLD)],
    });
    await waitFor(() => expect(listed()).toContain("x-b"));
    // Same name, other repo: no verdict carried over, nothing pre-checked.
    expect(within(rowOf("x-a")).queryByText(/^in$/)).toBeNull();
    expect(isChecked("x-a")).toBe(false);
    expect(isChecked("x-b")).toBe(false);
    await landVerdicts({ "x-b": "clean" });
    await waitFor(() => expect(isChecked("x-b")).toBe(true));
    expect(
      verdictCalls.filter((c) => c.branch === "x-b").map((c) => c.repo),
    ).toEqual(["C:/repos/switch-b"]);
  });
});

describe("a long list", () => {
  it("counts up as 150 verdicts land, without reseeding or refetching", async () => {
    const names = Array.from(
      { length: 150 },
      (_, i) => `big-${String(i).padStart(3, "0")}`,
    );
    const { user } = renderDialog({
      repoPath: "C:/repos/long-list",
      branches: names.map((n, i) => branch(n, OLD + i)),
    });
    await screen.findByText(/^Checked 0 of 150 branches/);
    // Land whatever the limiter has started, a round at a time, reading the
    // visible count after each round; once a landing checked a row, the user
    // unchecks it while the rest still land.
    const counts: number[] = [];
    let unchecked: string | null = null;
    for (
      let round = 0;
      verdictCalls.filter((c) => c.settled).length < 150;
      round++
    ) {
      if (round > 400) throw new Error("verdicts stopped starting");
      await landRest(
        verdictCalls.filter((c) => !c.settled).map((c) => c.branch),
        "clean",
      );
      const tick = screen.queryByText(/^Checked \d+ of 150 branches/);
      const m = /^Checked (\d+) of 150/.exec(tick?.textContent ?? "");
      if (m) counts.push(Number(m[1]));
      const landed = verdictCalls.filter((c) => c.settled);
      if (unchecked === null && landed.length < 150) {
        const row = landed.find((c) => isChecked(c.branch));
        if (row) {
          unchecked = row.branch;
          await user.click(boxOf(unchecked));
          expect(isChecked(unchecked)).toBe(false);
        }
      }
    }
    expect(counts.some((n) => n > 0 && n < 150)).toBe(true);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(unchecked).not.toBeNull();
    await waitFor(() =>
      expect(screen.getByText("149 of 150 selected")).toBeInTheDocument(),
    );
    expect(isChecked(unchecked as string)).toBe(false);
    expect(gitBranchContentMerged).toHaveBeenCalledTimes(150);
  }, 60_000);
});

describe("across reseeds, reopens and batches", () => {
  it("re-applies settled verdict checks after a reseed", async () => {
    const { user } = renderDialog({
      repoPath: "C:/repos/reseed-reapply",
      branches: [branch("ra-anc", FRESH), branch("ra-idle", OLD)],
      merged: ["ra-anc"],
    });
    await waitFor(() => expect(isChecked("ra-anc")).toBe(true));
    await landVerdicts({ "ra-idle": "clean" });
    await waitFor(() => expect(isChecked("ra-idle")).toBe(true));
    // Merged off drops the ancestry row, so the pre-checked set changes.
    await setCriteria(user, { merged: false, closed: true, idle: true });
    expect(listed()).toEqual(["ra-idle"]);
    await waitFor(() => expect(isChecked("ra-idle")).toBe(true));
    await setCriteria(user, { merged: true, closed: true, idle: true });
    await waitFor(() => expect(isChecked("ra-anc")).toBe(true));
    expect(isChecked("ra-idle")).toBe(true);
  });

  it("drops a previous open's verdict checks until this open's land", async () => {
    const view = renderDialog({
      repoPath: "C:/repos/reopen-verdicts",
      branches: [
        branch("rv-closed", FRESH),
        branch("rv-mine", FRESH),
        branch("rv-again", FRESH),
      ],
      prClosed: { "rv-closed": "#21", "rv-mine": "#22", "rv-again": "#23" },
    });
    await landVerdicts({
      "rv-closed": "clean",
      "rv-mine": "changes",
      "rv-again": "clean",
    });
    await waitFor(() => expect(isChecked("rv-closed")).toBe(true));
    expect(isChecked("rv-again")).toBe(true);
    await view.user.click(boxOf("rv-mine"));
    expect(isChecked("rv-mine")).toBe(true);
    view.rerender({ open: false });
    view.rerender({ open: true });
    // Only the user's own check carries over; this open measures the rest.
    expect(isChecked("rv-closed")).toBe(false);
    expect(isChecked("rv-again")).toBe(false);
    expect(isChecked("rv-mine")).toBe(true);
    await landVerdicts({
      "rv-closed": "changes",
      "rv-mine": "changes",
      "rv-again": "clean",
    });
    await waitFor(() => expect(isChecked("rv-again")).toBe(true));
    expect(isChecked("rv-closed")).toBe(false);
    expect(isChecked("rv-mine")).toBe(true);
  });

  it("takes a kept branch out of the selection for the rest of the open", async () => {
    statusByPath.set("C:/wt/kp-w", "clean");
    const view = renderDialog({
      repoPath: "C:/repos/kept",
      branches: [branch("kp-anc", FRESH), branch("kp-w", OLD)],
      merged: ["kp-anc"],
      worktrees: { "kp-w": { path: "C:/wt/kp-w" } },
    });
    const { user } = view;
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await user.click(optIn());
    await landVerdicts({ "kp-w": "clean" });
    await waitFor(() =>
      expect(boxOf("kp-w")).not.toHaveAttribute("aria-disabled"),
    );
    await user.click(boxOf("kp-w"));
    expect(isChecked("kp-anc")).toBe(true);
    await user.click(primary());
    const confirm = await screen.findByRole("dialog", {
      name: "Delete branches?",
    });
    await user.click(
      within(confirm).getByRole("button", { name: "Delete 2 branches" }),
    );
    await waitFor(() => expect(removalCalls).toHaveLength(1));
    // The removal takes the worktree away before the batch settles, so the
    // row turns plain under its earlier "clean".
    view.rerender({ worktreeFacts: new Map() });
    await act(async () => {
      removalCalls[0].resolve({ ok: true, branch: "keptMoved" });
    });
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Deleted 1, 1 failed"),
    );
    expect(
      screen.getByText(
        "Couldn't delete: the worktree was removed, but the branch gained new commits and was kept",
      ),
    ).toBeInTheDocument();
    // It leaves the selection, and stays out through a reseed.
    expect(boxOf("kp-w")).not.toHaveAttribute("aria-disabled");
    expect(isChecked("kp-w")).toBe(false);
    await setCriteria(user, { merged: false, closed: true, idle: true });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(listed()).toEqual(["kp-w"]);
    expect(isChecked("kp-w")).toBe(false);
    expect(gitDeleteBranch).toHaveBeenCalledTimes(1);
  });

  it("takes a branch an Archive left unarchived out of the selection", async () => {
    statusByPath.set("C:/wt/ku-w", "clean");
    const view = renderDialog({
      repoPath: "C:/repos/kept-in-use",
      branches: [branch("ku-w", OLD)],
      worktrees: { "ku-w": { path: "C:/wt/ku-w" } },
    });
    const { user } = view;
    await user.click(optIn());
    await landVerdicts({ "ku-w": "clean" });
    await waitFor(() =>
      expect(boxOf("ku-w")).not.toHaveAttribute("aria-disabled"),
    );
    await user.click(boxOf("ku-w"));
    await user.click(primary());
    const confirm = await screen.findByRole("dialog", {
      name: "Remove worktree?",
    });
    await user.click(
      within(confirm).getByRole("button", {
        name: "Remove and archive 1 branch",
      }),
    );
    await waitFor(() => expect(removalCalls).toHaveLength(1));
    expect(removalCalls[0].args.then).toBe("archive");
    // The worktree is gone, so the row turns plain under its earlier "clean".
    view.rerender({ worktreeFacts: new Map() });
    await act(async () => {
      removalCalls[0].resolve({ ok: true, branch: "keptInUse" });
    });
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Archived 0, 1 failed"),
    );
    expect(
      screen.getByText(
        "Couldn't archive: the worktree was removed, but the branch was checked out again, so it was left unarchived",
      ),
    ).toBeInTheDocument();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(isChecked("ku-w")).toBe(false);
    expect(view.props().onClose).not.toHaveBeenCalled();
    expect(removeWorktreeForCleanup).toHaveBeenCalledTimes(1);
    expect(gitSetBranchArchived).not.toHaveBeenCalled();
    // Its tip never moved, so the verdict still stands, and a Delete the user
    // chooses on it counts no changes.
    expect(within(rowOf("ku-w")).queryByText(/^in$/)).not.toBeNull();
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await user.click(boxOf("ku-w"));
    await user.click(primary());
    const del = await screen.findByRole("dialog", { name: "Delete branch?" });
    expect(del).toHaveTextContent(
      "Permanently deletes 1 branch, including commits that exist only on it. This can't be undone.",
    );
    expect(del).not.toHaveTextContent(/changes not in/);
  });

  it("never carries an acted-on branch into the next open", async () => {
    const view = renderDialog({
      repoPath: "C:/repos/after-success",
      branches: [branch("ds-closed", FRESH)],
      prClosed: { "ds-closed": "#31" },
    });
    const { user } = view;
    await waitFor(() => expect(listed()).toEqual(["ds-closed"]));
    await user.click(boxOf("ds-closed"));
    await user.click(primary());
    await waitFor(() => expect(view.props().onClose).toHaveBeenCalled());
    expect(gitSetBranchArchived).toHaveBeenCalledWith(
      "C:/repos/after-success",
      "ds-closed",
      true,
    );
    view.rerender({ open: false });
    view.rerender({ open: true, branches: [branch("ds-closed", FRESH, true)] });
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(listed()).toEqual(["ds-closed"]));
    expect(isChecked("ds-closed")).toBe(false);
  });

  it("acts on the worktree rows the confirm counted", async () => {
    statusByPath.set("C:/wt/sn-b", "clean");
    const view = renderDialog({
      repoPath: "C:/repos/confirm-worktrees",
      branches: [branch("sn-b", OLD)],
    });
    const { user } = view;
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await user.click(optIn());
    await landVerdicts({ "sn-b": "clean" });
    await waitFor(() => expect(isChecked("sn-b")).toBe(true));
    await user.click(primary());
    const confirm = await screen.findByRole("dialog", {
      name: "Delete branch?",
    });
    expect(confirm).toHaveTextContent(
      "Permanently deletes 1 branch, including commits that exist only on it. This can't be undone.",
    );
    // The branch is checked out in a new worktree while the confirm is open.
    view.rerender({
      worktreeFacts: new Map([
        ["sn-b", { path: "C:/wt/sn-b", isLocked: false, isMain: false }],
      ]),
    });
    await waitFor(() =>
      expect(within(rowOf("sn-b")).getByText("worktree")).toBeInTheDocument(),
    );
    await user.click(
      within(confirm).getByRole("button", { name: "Delete 1 branch" }),
    );
    await waitFor(() =>
      expect(gitDeleteBranch).toHaveBeenCalledWith(
        "C:/repos/confirm-worktrees",
        "sn-b",
      ),
    );
    expect(removeWorktreeForCleanup).not.toHaveBeenCalled();
  });

  it("keeps the frozen rows and their verdicts through a run", async () => {
    statusByPath.set("C:/wt/fz-w", "clean");
    const view = renderDialog({
      repoPath: "C:/repos/frozen",
      branches: [branch("fz-w", OLD)],
      worktrees: { "fz-w": { path: "C:/wt/fz-w" } },
    });
    const { user } = view;
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await user.click(optIn());
    await landVerdicts({ "fz-w": "clean" });
    await waitFor(() =>
      expect(boxOf("fz-w")).not.toHaveAttribute("aria-disabled"),
    );
    await user.click(boxOf("fz-w"));
    await user.click(primary());
    const confirm = await screen.findByRole("dialog", {
      name: "Delete branch?",
    });
    await user.click(
      within(confirm).getByRole("button", { name: "Delete 1 branch" }),
    );
    await waitFor(() => expect(removalCalls).toHaveLength(1));
    // The run's own removal mark empties the live list while a pull-request
    // refetch runs.
    view.rerender({
      isWorktreeRemoving: (n) => n === "fz-w",
      prCheckState: "pending",
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(listed()).toEqual(["fz-w"]);
    expect(within(rowOf("fz-w")).getByText(/^in$/)).toBeInTheDocument();
    expect(rowOf("fz-w").querySelector(".animate-pulse")).toBeNull();
  });

  it("keeps a failed worktree row checked while its status re-reads", async () => {
    statusByPath.set("C:/wt/rt-w", "clean");
    const view = renderDialog({
      repoPath: "C:/repos/retry-worktree",
      branches: [branch("rt-w", OLD), branch("rt-plain", OLD)],
      worktrees: { "rt-w": { path: "C:/wt/rt-w" } },
    });
    const { user } = view;
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await user.click(optIn());
    await landVerdicts({ "rt-w": "clean", "rt-plain": "clean" });
    await waitFor(() =>
      expect(boxOf("rt-w")).not.toHaveAttribute("aria-disabled"),
    );
    await waitFor(() => expect(isChecked("rt-plain")).toBe(true));
    await user.click(boxOf("rt-w"));
    await user.click(primary());
    const confirm = await screen.findByRole("dialog", {
      name: "Delete branches?",
    });
    await user.click(
      within(confirm).getByRole("button", { name: "Delete 2 branches" }),
    );
    await waitFor(() => expect(removalCalls).toHaveLength(1));
    // The batch's end re-reads the worktree's status; it stays in flight.
    const reread = deferred<RepoStatus>();
    vi.mocked(gitStatus).mockImplementationOnce(() => reread.promise);
    await act(async () => {
      removalCalls[0].resolve({ ok: false, reason: "the worktree is locked" });
    });
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Deleted 1, 1 failed"),
    );
    expect(boxOf("rt-w")).toHaveAttribute("aria-disabled", "true");
    await act(async () =>
      reread.resolve({ branch: {} as RepoStatus["branch"], entries: [] }),
    );
    await waitFor(() =>
      expect(boxOf("rt-w")).not.toHaveAttribute("aria-disabled"),
    );
    expect(isChecked("rt-w")).toBe(true);
  });

  it("shows no verdict on a kept row, and its confirm counts it changed", async () => {
    statusByPath.set("C:/wt/kv-w", "clean");
    const view = renderDialog({
      repoPath: "C:/repos/kept-verdict",
      branches: [branch("kv-w", OLD)],
      worktrees: { "kv-w": { path: "C:/wt/kv-w" } },
    });
    const { user } = view;
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await user.click(optIn());
    await landVerdicts({ "kv-w": "clean" });
    await waitFor(() =>
      expect(boxOf("kv-w")).not.toHaveAttribute("aria-disabled"),
    );
    await user.click(boxOf("kv-w"));
    await user.click(primary());
    const confirm = await screen.findByRole("dialog", {
      name: "Delete branch?",
    });
    await user.click(
      within(confirm).getByRole("button", { name: "Delete 1 branch" }),
    );
    await waitFor(() => expect(removalCalls).toHaveLength(1));
    view.rerender({ worktreeFacts: new Map() });
    await act(async () => {
      removalCalls[0].resolve({ ok: true, branch: "keptMoved" });
    });
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Deleted 0, 1 failed"),
    );
    // Its "clean" measured the tip before it moved.
    expect(within(rowOf("kv-w")).queryByText(/^in$/)).toBeNull();
    expect(rowOf("kv-w").querySelector(".animate-pulse")).toBeNull();
    await user.click(boxOf("kv-w"));
    await user.click(primary());
    const again = await screen.findByRole("dialog", {
      name: "Delete branch?",
    });
    expect(again).toHaveTextContent(
      "Permanently deletes 1 branch, including commits that exist only on it. It has changes not in origin/main. This can't be undone.",
    );
  });

  it("never re-seeds a kept row that ancestry calls merged", async () => {
    statusByPath.set("C:/wt/ka-w", "clean");
    const view = renderDialog({
      repoPath: "C:/repos/kept-ancestry",
      branches: [branch("ka-w", FRESH)],
      merged: ["ka-w"],
      worktrees: { "ka-w": { path: "C:/wt/ka-w" } },
    });
    const { user } = view;
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await user.click(optIn());
    await waitFor(() =>
      expect(boxOf("ka-w")).not.toHaveAttribute("aria-disabled"),
    );
    await user.click(boxOf("ka-w"));
    await user.click(primary());
    const confirm = await screen.findByRole("dialog", {
      name: "Delete branch?",
    });
    await user.click(
      within(confirm).getByRole("button", { name: "Delete 1 branch" }),
    );
    await waitFor(() => expect(removalCalls).toHaveLength(1));
    // Its worktree gone, the row turns plain and joins the ancestry seed.
    view.rerender({ worktreeFacts: new Map() });
    await act(async () => {
      removalCalls[0].resolve({ ok: true, branch: "keptUnreadable" });
    });
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Deleted 0, 1 failed"),
    );
    expect(isChecked("ka-w")).toBe(false);
    // Merged off then on moves the pre-checked set twice: two reseeds.
    await setCriteria(user, { merged: false, closed: true, idle: true });
    expect(listed()).toEqual([]);
    await setCriteria(user, { merged: true, closed: true, idle: true });
    await waitFor(() => expect(listed()).toEqual(["ka-w"]));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(isChecked("ka-w")).toBe(false);
  });

  it("counts the frozen rows while a batch runs", async () => {
    const view = renderDialog({
      repoPath: "C:/repos/frozen-count",
      branches: [branch("fc-a", OLD), branch("fc-b", OLD)],
    });
    await landVerdicts({ "fc-a": "clean", "fc-b": "clean" });
    await waitFor(() =>
      expect(screen.getByText("2 of 2 selected")).toBeInTheDocument(),
    );
    const first = deferred<undefined>();
    vi.mocked(gitSetBranchArchived).mockImplementationOnce(() => first.promise);
    await view.user.click(primary());
    await waitFor(() => expect(gitSetBranchArchived).toHaveBeenCalledTimes(1));
    // A refetch mid-run drops a row from the live list.
    view.rerender({ branches: [branch("fc-b", OLD)] });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByText("2 of 2 selected")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "2 branches to review.",
    );
    await act(async () => first.resolve(undefined));
    await waitFor(() => expect(view.props().onClose).toHaveBeenCalled());
  });

  it("closes a fully successful run still frozen, and the next open lets go", async () => {
    statusByPath.set("C:/wt/fs-w", "clean");
    const view = renderDialog({
      repoPath: "C:/repos/frozen-close",
      branches: [branch("fs-w", OLD)],
      worktrees: { "fs-w": { path: "C:/wt/fs-w" } },
    });
    const { user } = view;
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await user.click(optIn());
    await landVerdicts({ "fs-w": "clean" });
    await waitFor(() =>
      expect(boxOf("fs-w")).not.toHaveAttribute("aria-disabled"),
    );
    await user.click(boxOf("fs-w"));
    await user.click(primary());
    const confirm = await screen.findByRole("dialog", {
      name: "Delete branch?",
    });
    await user.click(
      within(confirm).getByRole("button", { name: "Delete 1 branch" }),
    );
    await waitFor(() => expect(removalCalls).toHaveLength(1));
    // The run's own removal mark empties the live list in Delete mode.
    view.rerender({ isWorktreeRemoving: (n) => n === "fs-w" });
    await act(async () => {
      removalCalls[0].resolve({ ok: true, branch: "deleted" });
    });
    await waitFor(() => expect(view.props().onClose).toHaveBeenCalled());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    // The close paints the run's rows and verdicts, not the live list the
    // run's removal mark emptied.
    const closing = rowsPainted("fs-w", () => view.rerender({ open: false }));
    expect(closing).toEqual({ painted: true, verdict: true });
    // Reopened before the close finishes, the dialog's first frame (before the
    // seed clears the snapshot) already shows the live list: the deleted
    // branch never paints.
    const frames: { dialog: boolean; rows: (string | null)[] }[] = [];
    onCommit = () =>
      frames.push({
        dialog: document.querySelector('[role="dialog"]') !== null,
        rows: listed(),
      });
    view.rerender({
      open: true,
      branches: [],
      isWorktreeRemoving: () => false,
    });
    onCommit = null;
    expect(frames[0]?.dialog).toBe(true);
    expect(frames.flatMap((f) => f.rows)).not.toContain("fs-w");
    await waitFor(() => expect(listed()).toEqual([]));
    // The reopen let go of the snapshot, so a later close never repaints it.
    expect(
      rowsPainted("fs-w", () => view.rerender({ open: false })).painted,
    ).toBe(false);
  });
});

describe("reads the dialog gates on", () => {
  it("holds nothing on a parked pull-request read while it doesn't count", async () => {
    const { user } = renderDialog({
      repoPath: "C:/repos/parked-prs",
      branches: [branch("pp-fresh", FRESH)],
      prCheckState: "pending",
      prCheckPaused: true,
    });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        /Waiting for a connection/,
      ),
    );
    await setCriteria(user, { merged: false, closed: false, idle: true });
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === "P" &&
          el.textContent ===
            "No stale branches — nothing is idle for 60 days. Try a shorter window.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Waiting for a connection/)).toBeNull();
  });

  it("holds a worktree row on a cached status until this open's read lands", async () => {
    const view = renderDialog({
      repoPath: "C:/repos/cached-status",
      branches: [branch("cs-w", OLD)],
      worktrees: { "cs-w": { path: "C:/wt/cs-w" } },
    });
    const cached: RepoStatus = {
      branch: {} as RepoStatus["branch"],
      entries: [],
    };
    view.client.setQueryData(["repo", "C:/wt/cs-w", "status"], cached);
    await view.user.click(optIn());
    await waitFor(() => expect(listed()).toEqual(["cs-w"]));
    // Its refetch never answers here, so the cached "clean" must not count.
    expect(boxOf("cs-w")).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("button", { name: /Select all/ })).toBeNull();
  });

  it("holds a worktree row pending, not failed, while a cached failure re-reads", async () => {
    const view = renderDialog({
      repoPath: "C:/repos/cached-failure",
      branches: [branch("cf-w", OLD)],
      worktrees: { "cf-w": { path: "C:/wt/cf-w" } },
    });
    const key = ["repo", "C:/wt/cf-w", "status"];
    const cached: RepoStatus = {
      branch: {} as RepoStatus["branch"],
      entries: [],
    };
    view.client.setQueryData(key, cached);
    await view.client.prefetchQuery({
      queryKey: key,
      queryFn: () => Promise.reject(new Error("status failed")),
      staleTime: 0,
    });
    expect(view.client.getQueryState(key)?.status).toBe("error");
    await view.user.click(optIn());
    await waitFor(() => expect(listed()).toEqual(["cf-w"]));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    // Its re-read never answers here, and the earlier failure isn't this
    // open's answer.
    expect(boxOf("cf-w")).toHaveAttribute("aria-disabled", "true");
    expect(boxOf("cf-w")).toHaveAccessibleDescription(
      "Checking this worktree for uncommitted changes…",
    );
    expect(
      screen.queryByText(
        "Couldn't check the worktree for uncommitted changes.",
      ),
    ).toBeNull();
  });

  it("re-reads the worktree list when the opt-in turns on", async () => {
    const view = renderDialog({
      repoPath: "C:/repos/wt-reread",
      branches: [branch("wr-old", OLD)],
    });
    const key = ["repo", "C:/repos/wt-reread", "user-worktrees"];
    view.client.setQueryData(key, []);
    await waitFor(() => expect(listed()).toEqual(["wr-old"]));
    expect(view.client.getQueryState(key)?.isInvalidated).toBe(false);
    await view.user.click(optIn());
    expect(view.client.getQueryState(key)?.isInvalidated).toBe(true);
  });

  it("holds the list while the default branch loads", async () => {
    const view = renderDialog({
      repoPath: "C:/repos/default-loading",
      branches: [branch("main", OLD), branch("dl-old", OLD)],
      defaultBranch: undefined,
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(listed()).toEqual([]);
    expect(document.querySelector("[aria-busy]")).not.toBeNull();
    // Provisional rows exist, but the skeleton paints, so the line is AT-only.
    expect(
      screen
        .getByText("Checking which branch is the default…")
        .closest('[role="status"]'),
    ).toHaveClass("sr-only");
    expect(primary()).toHaveAttribute("aria-disabled", "true");
    view.rerender({ defaultBranch: "main" });
    await waitFor(() => expect(listed()).toEqual(["dl-old"]));
  });
});

const DEFAULT_FAILED =
  "Couldn't read the default branch, so no branches are listed.";

describe("a default-branch read that failed", () => {
  /** The failure's empty state, its live-region line and the held primary. */
  function expectFailedState() {
    expect(listed()).toEqual([]);
    const lines = screen.getAllByText(
      (_, el) => el?.tagName === "P" && el.textContent === DEFAULT_FAILED,
    );
    const inStatus = (p: HTMLElement) => p.closest('[role="status"]') !== null;
    expect(lines.filter(inStatus)).toHaveLength(1);
    expect(lines.filter((p) => !inStatus(p))).toHaveLength(1);
    expect(document.querySelector("[aria-busy]")).toBeNull();
    expect(screen.queryByText(/^Checking which/)).toBeNull();
    expect(primary()).toHaveAttribute("aria-disabled", "true");
    expect(primary()).toHaveAccessibleDescription(
      /Couldn't read the default branch, so no branches are listed\./,
    );
  }

  it("lists nothing and says why, stays failed through a refetch, and recovers in the open", async () => {
    const view = renderDialog({
      repoPath: "C:/repos/default-failed",
      branches: [branch("main", OLD), branch("df-old", OLD)],
      defaultBranch: null,
      defaultBranchFailed: true,
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expectFailedState();
    expect(gitContentCheckBase).not.toHaveBeenCalled();
    // A refetch of the never-loaded read hands the dialog undefined again.
    view.rerender({ defaultBranch: undefined });
    expectFailedState();
    // Another read still running doesn't bring a skeleton back.
    view.rerender({ prCheckState: "pending" });
    expectFailedState();
    expect(gitContentCheckBase).not.toHaveBeenCalled();
    view.rerender({
      defaultBranch: "main",
      defaultBranchFailed: false,
      prCheckState: "checked",
    });
    await waitFor(() => expect(listed()).toEqual(["df-old"]));
    // Throws "never requested" if the open latched the failure as null.
    await landVerdicts({ "df-old": "clean" });
    await waitFor(() => expect(isChecked("df-old")).toBe(true));
  });

  it("still lists a repo whose read answered with no default", async () => {
    baseAnswer = null;
    renderDialog({
      repoPath: "C:/repos/default-none",
      branches: [branch("main", OLD), branch("dn-old", OLD)],
      defaultBranch: null,
    });
    await waitFor(() =>
      expect(new Set(listed())).toEqual(new Set(["main", "dn-old"])),
    );
    expect(screen.queryByText(DEFAULT_FAILED)).toBeNull();
    await waitFor(() => expect(isChecked("dn-old")).toBe(true));
  });

  it("counts only a read that errored with nothing loaded as failed", () => {
    const refetching = {
      data: undefined,
      errorUpdateCount: 1,
      fetchStatus: "fetching" as const,
    };
    expect(
      [
        { data: undefined, errorUpdateCount: 0 },
        { data: undefined, errorUpdateCount: 1 },
        refetching,
        { data: null, errorUpdateCount: 0 },
        { data: "main", errorUpdateCount: 1 },
      ].map((q) => defaultBranchReadFailed(q)),
    ).toEqual([false, true, true, false, false]);
  });

  it("drops the caveats about what the list holds while nothing lists", async () => {
    const view = renderDialog({
      repoPath: "C:/repos/default-failed-caveats",
      branches: [branch("dfc-old", OLD)],
      defaultBranch: null,
      defaultBranchFailed: true,
      prCheckState: "failed",
    });
    view.rerender({ worktreeCheckState: "failed" });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(
      screen.queryByText(/^Worktree checkouts couldn't be read/),
    ).toBeNull();
    expect(screen.queryByText(/^Pull requests couldn't be checked/)).toBeNull();
    const status = screen.getByRole("status");
    expect(status).toHaveClass("sr-only");
    expect(status).toHaveTextContent(DEFAULT_FAILED);
  });
});

describe("new ancestry data within one open", () => {
  it("keeps the user's touches while divergence lands a newly merged branch", async () => {
    const divergence =
      deferred<Awaited<ReturnType<typeof gitBranchDivergence>>>();
    vi.mocked(gitBranchDivergence).mockImplementationOnce(
      () => divergence.promise,
    );
    const { user } = renderDialog({
      repoPath: "C:/repos/merge-touch",
      branches: [
        branch("mt-clean", OLD),
        branch("mt-changes", OLD),
        branch("mt-new", FRESH),
      ],
    });
    await landVerdicts({ "mt-clean": "clean", "mt-changes": "changes" });
    await waitFor(() => expect(isChecked("mt-clean")).toBe(true));
    await user.click(boxOf("mt-clean"));
    await user.click(boxOf("mt-changes"));
    expect(isChecked("mt-clean")).toBe(false);
    expect(isChecked("mt-changes")).toBe(true);
    await act(async () =>
      divergence.resolve([{ name: "mt-new", ahead: 0, behind: 3 }]),
    );
    await waitFor(() => expect(listed()).toContain("mt-new"));
    await waitFor(() => expect(isChecked("mt-new")).toBe(true));
    expect(isChecked("mt-clean")).toBe(false);
    expect(isChecked("mt-changes")).toBe(true);
  });

  it("keeps an unchecked row unchecked when a refetch moves the merged set, without a content check", async () => {
    baseAnswer = null;
    const view = renderDialog({
      repoPath: "C:/repos/merge-refetch",
      branches: [
        branch("mr-anc", FRESH),
        branch("mr-idle", OLD),
        branch("mr-new", FRESH),
      ],
      merged: ["mr-anc"],
    });
    await waitFor(() => expect(isChecked("mr-anc")).toBe(true));
    await waitFor(() => expect(isChecked("mr-idle")).toBe(true));
    await view.user.click(boxOf("mr-anc"));
    await view.user.click(boxOf("mr-idle"));
    mergedByRepo.set("C:/repos/merge-refetch", ["mr-anc", "mr-new"]);
    await act(async () => {
      await view.client.invalidateQueries({
        queryKey: ["repo", "C:/repos/merge-refetch", "divergence"],
      });
    });
    await waitFor(() => expect(isChecked("mr-new")).toBe(true));
    expect(isChecked("mr-anc")).toBe(false);
    expect(isChecked("mr-idle")).toBe(false);
  });

  it("keeps a verdict-checked branch through a reopen once ancestry calls it merged", async () => {
    const divergence =
      deferred<Awaited<ReturnType<typeof gitBranchDivergence>>>();
    vi.mocked(gitBranchDivergence).mockImplementationOnce(
      () => divergence.promise,
    );
    const view = renderDialog({
      repoPath: "C:/repos/merge-reopen",
      branches: [branch("mo-idle", OLD)],
    });
    await landVerdicts({ "mo-idle": "clean" });
    await waitFor(() => expect(isChecked("mo-idle")).toBe(true));
    // Every later read answers the same.
    mergedByRepo.set("C:/repos/merge-reopen", ["mo-idle"]);
    await act(async () =>
      divergence.resolve([{ name: "mo-idle", ahead: 0, behind: 3 }]),
    );
    await waitFor(() =>
      expect(within(rowOf("mo-idle")).queryByText("merged")).not.toBeNull(),
    );
    expect(isChecked("mo-idle")).toBe(true);
    view.rerender({ open: false });
    view.rerender({ open: true });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(within(rowOf("mo-idle")).queryByText("merged")).not.toBeNull();
    expect(isChecked("mo-idle")).toBe(true);
  });

  it("keeps a verdict-checked branch through a reopen once a post-batch refetch calls it merged", async () => {
    const view = renderDialog({
      repoPath: "C:/repos/prune-reopen",
      branches: [branch("pb-idle", OLD)],
    });
    await landVerdicts({ "pb-idle": "clean" });
    await waitFor(() => expect(isChecked("pb-idle")).toBe(true));
    vi.mocked(gitSetBranchArchived).mockRejectedValue(
      new Error("branch is busy"),
    );
    // The batch's own refetch, and every read after it, calls it merged.
    mergedByRepo.set("C:/repos/prune-reopen", ["pb-idle"]);
    await view.user.click(primary());
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Archived 0, 1 failed"),
    );
    await waitFor(() =>
      expect(within(rowOf("pb-idle")).queryByText("merged")).not.toBeNull(),
    );
    expect(isChecked("pb-idle")).toBe(true);
    view.rerender({ open: false });
    view.rerender({ open: true });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(within(rowOf("pb-idle")).queryByText("merged")).not.toBeNull();
    expect(isChecked("pb-idle")).toBe(true);
  });
});

describe("a confirmed name the list no longer offers", () => {
  it("skips one that became the default branch under a Delete confirm", async () => {
    const view = renderDialog({
      repoPath: "C:/repos/skip-default",
      branches: [branch("sd-a", OLD + 10), branch("sd-b", OLD)],
    });
    const { user } = view;
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await landRest(["sd-a", "sd-b"], "clean");
    await waitFor(() => expect(isChecked("sd-b")).toBe(true));
    await user.click(primary());
    const confirm = await screen.findByRole("dialog", {
      name: "Delete branches?",
    });
    view.rerender({ defaultBranch: "sd-b" });
    await user.click(
      within(confirm).getByRole("button", { name: "Delete 2 branches" }),
    );
    await waitFor(() => expect(view.props().onClose).toHaveBeenCalled());
    expect(vi.mocked(gitDeleteBranch).mock.calls).toEqual([
      ["C:/repos/skip-default", "sd-a"],
    ]);
    expect(toast.info).toHaveBeenCalledWith(
      "Skipped sd-b — it's now the default branch.",
    );
    expect(toast.success).toHaveBeenCalledWith("Deleted 1 branch");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("skips one checked out while an Archive batch runs, and still closes", async () => {
    const view = renderDialog({
      repoPath: "C:/repos/skip-current",
      branches: [branch("sc-a", OLD + 10), branch("sc-b", OLD)],
    });
    await landRest(["sc-a", "sc-b"], "clean");
    await waitFor(() => expect(isChecked("sc-b")).toBe(true));
    const first = deferred<undefined>();
    vi.mocked(gitSetBranchArchived).mockImplementationOnce(() => first.promise);
    await view.user.click(primary());
    await waitFor(() => expect(gitSetBranchArchived).toHaveBeenCalledTimes(1));
    view.rerender({ currentBranch: "sc-b" });
    await act(async () => first.resolve(undefined));
    await waitFor(() => expect(view.props().onClose).toHaveBeenCalled());
    expect(vi.mocked(gitSetBranchArchived).mock.calls).toEqual([
      ["C:/repos/skip-current", "sc-a", true],
    ]);
    expect(toast.info).toHaveBeenCalledWith(
      "Skipped sc-b — it's now checked out.",
    );
    expect(toast.success).toHaveBeenCalledWith("Archived 1 branch");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("skips a worktree row that became the default before its turn, keeping its worktree", async () => {
    statusByPath.set("C:/wt/dw-w", "clean");
    const view = renderDialog({
      repoPath: "C:/repos/skip-default-wt",
      branches: [branch("dw-w", OLD + 10), branch("dw-p", OLD)],
      worktrees: { "dw-w": { path: "C:/wt/dw-w" } },
    });
    const { user } = view;
    await user.click(optIn());
    await landRest(["dw-w", "dw-p"], "clean");
    await waitFor(() =>
      expect(boxOf("dw-w")).not.toHaveAttribute("aria-disabled"),
    );
    await waitFor(() => expect(isChecked("dw-p")).toBe(true));
    await user.click(boxOf("dw-w"));
    await user.click(primary());
    const confirm = await screen.findByRole("dialog", {
      name: "Remove worktree?",
    });
    view.rerender({ defaultBranch: "dw-w" });
    await user.click(
      within(confirm).getByRole("button", {
        name: "Remove and archive 2 branches",
      }),
    );
    await waitFor(() => expect(view.props().onClose).toHaveBeenCalled());
    expect(removeWorktreeForCleanup).not.toHaveBeenCalled();
    expect(vi.mocked(gitSetBranchArchived).mock.calls).toEqual([
      ["C:/repos/skip-default-wt", "dw-p", true],
    ]);
    expect(toast.info).toHaveBeenCalledWith(
      "Skipped dw-w — it's now the default branch.",
    );
  });

  it("skips a protected name that became the default rather than failing it", async () => {
    const view = renderDialog({
      repoPath: "C:/repos/skip-protected-default",
      branches: [branch("pd-a", OLD + 10), branch("pd-b", OLD)],
    });
    const { user } = view;
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await landRest(["pd-a", "pd-b"], "clean");
    await waitFor(() => expect(isChecked("pd-b")).toBe(true));
    await user.click(primary());
    const confirm = await screen.findByRole("dialog", {
      name: "Delete branches?",
    });
    view.rerender({ defaultBranch: "pd-b", isProtected: (n) => n === "pd-b" });
    await user.click(
      within(confirm).getByRole("button", { name: "Delete 2 branches" }),
    );
    await waitFor(() => expect(view.props().onClose).toHaveBeenCalled());
    expect(vi.mocked(gitDeleteBranch).mock.calls).toEqual([
      ["C:/repos/skip-protected-default", "pd-a"],
    ]);
    expect(toast.info).toHaveBeenCalledWith(
      "Skipped pd-b — it's now the default branch.",
    );
    expect(toast.error).not.toHaveBeenCalled();
    // Git refuses to delete a checked-out branch, so Delete reads no list.
    expect(listWorktrees).not.toHaveBeenCalled();
  });

  it("skips a plain row checked out in another worktree at its Archive", async () => {
    // A session folder holds it, which the user worktree list behind the
    // dialog's exclusion leaves out.
    vi.mocked(listWorktrees).mockResolvedValue([
      { id: "s1", path: "C:/wt/s1", branch: "ow-b", base: "" },
    ]);
    const view = renderDialog({
      repoPath: "C:/repos/skip-elsewhere",
      branches: [branch("ow-a", OLD + 10), branch("ow-b", OLD)],
    });
    await landRest(["ow-a", "ow-b"], "clean");
    await waitFor(() => expect(isChecked("ow-b")).toBe(true));
    await view.user.click(primary());
    await waitFor(() => expect(view.props().onClose).toHaveBeenCalled());
    expect(vi.mocked(gitSetBranchArchived).mock.calls).toEqual([
      ["C:/repos/skip-elsewhere", "ow-a", true],
    ]);
    expect(toast.info).toHaveBeenCalledWith(
      "Skipped ow-b — it's now checked out.",
    );
    expect(toast.success).toHaveBeenCalledWith("Archived 1 branch");
    // Read per row, at its turn.
    expect(vi.mocked(listWorktrees).mock.calls).toEqual([
      ["C:/repos/skip-elsewhere"],
      ["C:/repos/skip-elsewhere"],
    ]);
  });

  it("archives as before when the worktree list can't be read", async () => {
    vi.mocked(listWorktrees).mockRejectedValue(new Error("list failed"));
    const view = renderDialog({
      repoPath: "C:/repos/skip-elsewhere-open",
      branches: [branch("oo-a", OLD)],
    });
    await landRest(["oo-a"], "clean");
    await waitFor(() => expect(isChecked("oo-a")).toBe(true));
    await view.user.click(primary());
    await waitFor(() => expect(view.props().onClose).toHaveBeenCalled());
    expect(vi.mocked(gitSetBranchArchived).mock.calls).toEqual([
      ["C:/repos/skip-elsewhere-open", "oo-a", true],
    ]);
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("never skips a name for the default or current branch of a repo switched to mid-batch", async () => {
    const view = renderDialog({
      repoPath: "C:/repos/skip-switch-a",
      branches: [branch("ss-a", OLD + 10), branch("ss-b", OLD)],
    });
    await landRest(["ss-a", "ss-b"], "clean");
    await waitFor(() => expect(isChecked("ss-b")).toBe(true));
    const first = deferred<undefined>();
    vi.mocked(gitSetBranchArchived).mockImplementationOnce(() => first.promise);
    await view.user.click(primary());
    await waitFor(() => expect(gitSetBranchArchived).toHaveBeenCalledTimes(1));
    act(() => useUiStore.setState({ repoPath: "C:/repos/skip-switch-b" }));
    view.rerender({
      repoPath: "C:/repos/skip-switch-b",
      branches: [],
      defaultBranch: "ss-b",
      currentBranch: "ss-b",
    });
    await act(async () => first.resolve(undefined));
    await waitFor(() => expect(gitSetBranchArchived).toHaveBeenCalledTimes(2));
    expect(vi.mocked(gitSetBranchArchived).mock.calls).toEqual([
      ["C:/repos/skip-switch-a", "ss-a", true],
      ["C:/repos/skip-switch-a", "ss-b", true],
    ]);
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("leaves a skipped name unchecked after a partly failed batch, keeping only the failure", async () => {
    // A session folder holds pf-b, so its Archive skips at its turn.
    vi.mocked(listWorktrees).mockResolvedValue([
      { id: "s2", path: "C:/wt/s2", branch: "pf-b", base: "" },
    ]);
    vi.mocked(gitSetBranchArchived).mockImplementation(async (_repo, name) => {
      if (name === "pf-a") throw new Error("branch is busy");
    });
    const view = renderDialog({
      repoPath: "C:/repos/skip-partial",
      branches: [
        branch("pf-a", OLD + 20),
        branch("pf-b", OLD + 10),
        branch("pf-c", OLD),
      ],
    });
    await landRest(["pf-a", "pf-b", "pf-c"], "clean");
    await waitFor(() => expect(isChecked("pf-c")).toBe(true));
    await view.user.click(primary());
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Archived 1, 1 failed"),
    );
    expect(toast.info).toHaveBeenCalledWith(
      "Skipped pf-b — it's now checked out.",
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(isChecked("pf-a")).toBe(true);
    expect(isChecked("pf-b")).toBe(false);
    expect(isChecked("pf-c")).toBe(false);
  });
});

/** The paragraph whose whole text is `text` (the default branch's name sits in
 *  its own mono span). */
const paragraph = (text: string) =>
  screen.getByText((_, el) => el?.tagName === "P" && el.textContent === text);

describe("the no-match copy's pull-request claims", () => {
  it("names a closed pull request only on the merged aside's terms", async () => {
    const view = renderDialog({
      repoPath: "C:/repos/closed-claim",
      branches: [branch("cc-fresh", FRESH)],
    });
    const { user } = view;
    await waitFor(() =>
      expect(screen.getAllByText(/^No stale branches/).length).toBeGreaterThan(
        0,
      ),
    );
    const failedNote =
      " Pull requests couldn't be checked, so a branch whose pull request was closed may be missing here.";
    const want = {
      checked: {
        closed:
          "No stale branches — nothing is matched to a pull request closed without merging.",
        closedIdle:
          "No stale branches — nothing is matched to a pull request closed without merging and nothing is idle for 60 days. Try a shorter window.",
      },
      failed: {
        closed: `No stale branches.${failedNote}`,
        closedIdle: `No stale branches — nothing is idle for 60 days. Try a shorter window.${failedNote}`,
      },
      unavailable: {
        closed:
          "No stale branches. Pull requests aren't being read, so Closed PR can't match a branch.",
        closedIdle:
          "No stale branches — nothing is idle for 60 days. Try a shorter window.",
      },
    } as const;
    for (const state of ["checked", "failed", "unavailable"] as const) {
      view.rerender({ prCheckState: state });
      await setCriteria(user, { merged: false, closed: true, idle: false });
      paragraph(want[state].closed);
      await setCriteria(user, { merged: false, closed: true, idle: true });
      paragraph(want[state].closedIdle);
    }
    // Pending: the skeleton stands in for the empty state, which claims nothing.
    view.rerender({ prCheckState: "pending" });
    for (const idle of [false, true]) {
      await setCriteria(user, { merged: false, closed: true, idle });
      expect(screen.queryByText(/No stale branches/)).toBeNull();
      expect(document.querySelector("[aria-busy]")).not.toBeNull();
    }
  });

  it("suggests a shorter window only while one exists", async () => {
    const { user } = renderDialog({
      repoPath: "C:/repos/shortest-window",
      branches: [branch("sw-fresh", FRESH)],
    });
    await setCriteria(user, { merged: false, closed: false, idle: true });
    await waitFor(() =>
      paragraph(
        "No stale branches — nothing is idle for 60 days. Try a shorter window.",
      ),
    );
    await user.click(screen.getByRole("button", { name: "30" }));
    paragraph("No stale branches — nothing is idle for 30 days.");
  });
});

describe("the checking lines", () => {
  it("name only the criteria a pull-request read serves", async () => {
    const view = renderDialog({
      repoPath: "C:/repos/pr-lines",
      branches: [branch("pl-old", OLD)],
      prCheckState: "pending",
    });
    const lines = {
      both: [
        "Checking which branches are merged or closed through a pull request…",
        "Waiting for a connection to check which branches were merged or closed through a pull request…",
      ],
      closed: [
        "Checking which branches had a pull request closed…",
        "Waiting for a connection to check which branches had a pull request closed without merging…",
      ],
      merged: [
        "Checking which branches are merged…",
        "Waiting for a connection to check which branches were merged through a pull request…",
      ],
    } as const;
    for (const scope of ["both", "closed", "merged"] as const) {
      const [checking, waiting] = lines[scope];
      view.rerender({ prCheckPaused: false });
      await setCriteria(view.user, {
        merged: scope !== "closed",
        closed: scope !== "merged",
        idle: true,
      });
      await waitFor(() =>
        expect(screen.getByText(checking)).toBeInTheDocument(),
      );
      view.rerender({ prCheckPaused: true });
      expect(screen.getByText(waiting)).toBeInTheDocument();
    }
  });

  it("words the ancestry read under Idle alone without a merged check", async () => {
    vi.mocked(gitBranchDivergence).mockImplementation(
      () => new Promise<never>(() => undefined),
    );
    const { user } = renderDialog({
      repoPath: "C:/repos/contained-line",
      branches: [branch("ct-old", OLD)],
    });
    await setCriteria(user, { merged: false, closed: false, idle: true });
    expect(
      screen.getByText(
        "Checking which branches the default branch already contains…",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/which branches are merged/)).toBeNull();
    await setCriteria(user, { merged: true, closed: false, idle: true });
    expect(
      screen.getByText("Checking which branches are merged…"),
    ).toBeInTheDocument();
  });

  it("counts a single check in the singular", async () => {
    renderDialog({
      repoPath: "C:/repos/one-check",
      branches: [branch("oc-old", OLD)],
    });
    expect(
      await screen.findByText(/^Checked 0 of 1 branch for changes not in/),
    ).toBeInTheDocument();
  });
});

describe("row and window cues", () => {
  it("hands the badges' explanations to the row checkbox", async () => {
    renderDialog({
      repoPath: "C:/repos/row-detail",
      branches: [branch("rd-closed", FRESH)],
      prClosed: { "rd-closed": "#34" },
    });
    await landVerdicts({ "rd-closed": "clean" });
    await waitFor(() =>
      expect(boxOf("rd-closed")).toHaveAccessibleDescription(
        "Closed without merging — matched by branch name. Nothing on it is missing from origin/main",
      ),
    );
  });

  it("keeps the picked window marked by more than a fill while Idle is off", async () => {
    const { user } = renderDialog({
      repoPath: "C:/repos/window-cue",
      branches: [branch("wc-old", OLD)],
    });
    await setCriteria(user, { merged: true, closed: true, idle: false });
    expect(screen.getByRole("button", { name: "60" })).toHaveClass(
      "ring-1",
      "ring-inset",
      "ring-primary",
    );
    expect(screen.getByRole("button", { name: "30" })).not.toHaveClass(
      "ring-primary",
    );
  });
});

describe("after a batch", () => {
  it("keeps focus on the primary through a partly failed confirmed Delete", async () => {
    const view = renderDialog({
      repoPath: "C:/repos/focus-batch",
      branches: [branch("fb-a", OLD), branch("fb-b", OLD)],
    });
    const { user } = view;
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await landVerdicts({ "fb-a": "clean", "fb-b": "clean" });
    await waitFor(() => expect(isChecked("fb-b")).toBe(true));
    const first = deferred<undefined>();
    vi.mocked(gitDeleteBranch).mockImplementationOnce(() => first.promise);
    await user.click(primary());
    const confirm = await screen.findByRole("dialog", {
      name: "Delete branches?",
    });
    await user.click(
      within(confirm).getByRole("button", { name: "Delete 2 branches" }),
    );
    await waitFor(() => expect(gitDeleteBranch).toHaveBeenCalledTimes(1));
    const held = within(mainDialog()).getByRole("button", {
      name: /^Deleting…/,
      hidden: true,
    });
    // Held, never natively disabled, so the confirm's focus return lands on it.
    expect(held).not.toBeDisabled();
    expect(held).toHaveAttribute("aria-disabled", "true");
    await waitFor(() => expect(document.activeElement).toBe(held));
    await act(async () => first.reject(new Error("branch is busy")));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Deleted 1, 1 failed"),
    );
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(primary());
  });

  it("adds Select all to a checked row a pending status read holds", async () => {
    statusByPath.set("C:/wt/sa-w", "clean");
    const view = renderDialog({
      repoPath: "C:/repos/select-all-pending",
      branches: [
        branch("sa-w", OLD),
        branch("sa-plain", OLD),
        branch("sa-other", OLD),
      ],
      worktrees: { "sa-w": { path: "C:/wt/sa-w" } },
    });
    const { user } = view;
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await user.click(optIn());
    await landVerdicts({
      "sa-w": "clean",
      "sa-plain": "clean",
      "sa-other": "changes",
    });
    await waitFor(() =>
      expect(boxOf("sa-w")).not.toHaveAttribute("aria-disabled"),
    );
    await waitFor(() => expect(isChecked("sa-plain")).toBe(true));
    await user.click(boxOf("sa-w"));
    await user.click(primary());
    const confirm = await screen.findByRole("dialog", {
      name: "Delete branches?",
    });
    await user.click(
      within(confirm).getByRole("button", { name: "Delete 2 branches" }),
    );
    await waitFor(() => expect(removalCalls).toHaveLength(1));
    const reread = deferred<RepoStatus>();
    vi.mocked(gitStatus).mockImplementationOnce(() => reread.promise);
    await act(async () => {
      removalCalls[0].resolve({ ok: false, reason: "the worktree is locked" });
    });
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Deleted 1, 1 failed"),
    );
    // The deleted branch leaves the list on the refetch.
    view.rerender({ branches: [branch("sa-w", OLD), branch("sa-other", OLD)] });
    expect(boxOf("sa-w")).toHaveAttribute("aria-disabled", "true");
    expect(isChecked("sa-other")).toBe(false);
    // The confirm's close can still hide the dialog from role queries.
    await user.click(
      within(mainDialog()).getByRole("button", {
        name: "Select all, 0 of 1 selected",
        hidden: true,
      }),
    );
    await act(async () =>
      reread.resolve({ branch: {} as RepoStatus["branch"], entries: [] }),
    );
    await waitFor(() =>
      expect(boxOf("sa-w")).not.toHaveAttribute("aria-disabled"),
    );
    expect(isChecked("sa-w")).toBe(true);
    expect(isChecked("sa-other")).toBe(true);
  });

  /** Runs a Delete that removes `w`'s worktree but keeps its branch. */
  async function keepOne(repoPath: string, w: string, anc: string) {
    statusByPath.set(`C:/wt/${w}`, "clean");
    const view = renderDialog({
      repoPath,
      branches: [branch(anc, FRESH), branch(w, OLD)],
      merged: [anc],
      worktrees: { [w]: { path: `C:/wt/${w}` } },
    });
    const { user } = view;
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await user.click(optIn());
    await landVerdicts({ [w]: "clean" });
    await waitFor(() => expect(boxOf(w)).not.toHaveAttribute("aria-disabled"));
    await user.click(boxOf(w));
    await user.click(primary());
    const confirm = await screen.findByRole("dialog", {
      name: "Delete branches?",
    });
    await user.click(
      within(confirm).getByRole("button", { name: "Delete 2 branches" }),
    );
    await waitFor(() => expect(removalCalls).toHaveLength(1));
    view.rerender({ worktreeFacts: new Map() });
    await act(async () => {
      removalCalls[0].resolve({ ok: true, branch: "keptMoved" });
    });
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Deleted 1, 1 failed"),
    );
    expect(isChecked(w)).toBe(false);
    return view;
  }

  it("lets the next open's own verdict check a kept row", async () => {
    const view = await keepOne("C:/repos/kept-reopen", "kr-w", "kr-anc");
    view.rerender({ open: false });
    view.rerender({ open: true });
    await landVerdicts({ "kr-w": "clean" });
    await waitFor(() => expect(isChecked("kr-w")).toBe(true));
  });

  it("keeps a kept row the user toggled since unchecked into the next open", async () => {
    const view = await keepOne("C:/repos/kept-toggled", "kt-w", "kt-anc");
    await view.user.click(boxOf("kt-w"));
    await view.user.click(boxOf("kt-w"));
    expect(isChecked("kt-w")).toBe(false);
    view.rerender({ open: false });
    view.rerender({ open: true });
    await landVerdicts({ "kt-w": "clean" });
    await waitFor(() =>
      expect(within(rowOf("kt-w")).getByText(/^in$/)).toBeInTheDocument(),
    );
    expect(isChecked("kt-w")).toBe(false);
  });

  it("never shows a batch's failure lines in another repo", async () => {
    const view = renderDialog({
      repoPath: "C:/repos/fail-a",
      branches: [branch("fl-same", OLD), branch("fl-ok", OLD)],
    });
    await landVerdicts({ "fl-same": "clean", "fl-ok": "clean" });
    await waitFor(() => expect(isChecked("fl-ok")).toBe(true));
    expect(isChecked("fl-same")).toBe(true);
    const first = deferred<undefined>();
    vi.mocked(gitSetBranchArchived).mockImplementationOnce(() => first.promise);
    await view.user.click(primary());
    await waitFor(() => expect(gitSetBranchArchived).toHaveBeenCalledTimes(1));
    act(() => useUiStore.setState({ repoPath: "C:/repos/fail-b" }));
    view.rerender({
      repoPath: "C:/repos/fail-b",
      branches: [branch("fl-same", OLD)],
    });
    // A's batch settles after the switch, with fl-same failed. The seed's
    // repo-switch clear runs an effect later, so read every frame painted.
    let paintedFailure = false;
    onCommit = () => {
      if (document.body.textContent?.includes("Couldn't archive"))
        paintedFailure = true;
    };
    await act(async () => first.reject(new Error("branch is busy")));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Archived 1, 1 failed"),
    );
    await waitFor(() => expect(listed()).toEqual(["fl-same"]));
    onCommit = null;
    expect(paintedFailure).toBe(false);
    expect(screen.queryByText(/^Couldn't/)).toBeNull();
    expect(within(rowOf("fl-same")).queryByText("failed")).toBeNull();
  });
});

describe("Select all, a late rule and a reopen", () => {
  it("selects exactly the visible actionable rows after a criterion toggle", async () => {
    const { user } = renderDialog({
      repoPath: "C:/repos/select-visible",
      branches: [
        branch("sv-idle", OLD),
        branch("sv-closed", FRESH),
        branch("sv-anc", FRESH),
      ],
      merged: ["sv-anc"],
      prClosed: { "sv-closed": "#9" },
    });
    await landVerdicts({ "sv-idle": "changes", "sv-closed": "changes" });
    await waitFor(() => expect(listed()).toHaveLength(3));
    expect(isChecked("sv-anc")).toBe(true);
    await setCriteria(user, { merged: true, closed: false, idle: true });
    expect(new Set(listed())).toEqual(new Set(["sv-anc", "sv-idle"]));
    await user.click(screen.getByRole("button", { name: /^Select all/ }));
    expect(isChecked("sv-idle")).toBe(true);
    expect(screen.getByText("2 of 2 selected")).toBeInTheDocument();
    // The hidden row comes back as it was: unchecked.
    await setCriteria(user, { merged: true, closed: true, idle: true });
    expect(listed()).toContain("sv-closed");
    expect(isChecked("sv-closed")).toBe(false);
    expect(screen.getByText("2 of 3 selected")).toBeInTheDocument();
  });

  it("refuses a branch a rule protects before touching its worktree", async () => {
    statusByPath.set("C:/wt/pl-w", "clean");
    const view = renderDialog({
      repoPath: "C:/repos/protect-late",
      branches: [branch("pl-w", OLD), branch("pl-plain", OLD)],
      worktrees: { "pl-w": { path: "C:/wt/pl-w" } },
    });
    const { user } = view;
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await user.click(optIn());
    await landVerdicts({ "pl-w": "clean", "pl-plain": "clean" });
    await waitFor(() =>
      expect(boxOf("pl-w")).not.toHaveAttribute("aria-disabled"),
    );
    await waitFor(() => expect(isChecked("pl-plain")).toBe(true));
    await user.click(boxOf("pl-w"));
    await user.click(primary());
    const confirm = await screen.findByRole("dialog", {
      name: "Delete branches?",
    });
    // A rule lands while the confirm is open.
    view.rerender({ isProtected: (n) => n === "pl-w" });
    await user.click(
      within(confirm).getByRole("button", { name: "Delete 2 branches" }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Deleted 1, 1 failed"),
    );
    expect(removeWorktreeForCleanup).not.toHaveBeenCalled();
    expect(vi.mocked(gitDeleteBranch).mock.calls).toEqual([
      ["C:/repos/protect-late", "pl-plain"],
    ]);
  });

  it("shows no failure line after a reopen that follows a partly failed batch", async () => {
    const view = renderDialog({
      repoPath: "C:/repos/fail-reopen",
      branches: [branch("fr-bad", OLD), branch("fr-ok", OLD)],
    });
    await landVerdicts({ "fr-bad": "clean", "fr-ok": "clean" });
    await waitFor(() => expect(isChecked("fr-ok")).toBe(true));
    expect(isChecked("fr-bad")).toBe(true);
    vi.mocked(gitSetBranchArchived).mockImplementation(async (_repo, name) => {
      if (name === "fr-bad") throw new Error("branch is busy");
    });
    await view.user.click(primary());
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Archived 1, 1 failed"),
    );
    view.rerender({ branches: [branch("fr-bad", OLD)] });
    expect(await screen.findByText(/^Couldn't archive/)).toBeInTheDocument();
    view.rerender({ open: false });
    view.rerender({ open: true });
    await waitFor(() => expect(listed()).toEqual(["fr-bad"]));
    await waitFor(() => expect(screen.queryByText(/^Couldn't/)).toBeNull());
    expect(within(rowOf("fr-bad")).queryByText("failed")).toBeNull();
  });
});

describe("a running batch", () => {
  /** Starts a confirmed Delete of `names` in `repoPath` whose first delete is
   *  held until the returned release runs. */
  async function heldDelete(
    repoPath: string,
    names: [string, string],
    isProtected?: DialogProps["isProtected"],
  ) {
    const view = renderDialog({
      repoPath,
      branches: [branch(names[0], OLD + 10), branch(names[1], OLD)],
    });
    if (isProtected) view.rerender({ isProtected });
    const { user } = view;
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await landRest(names, "clean");
    await waitFor(() => expect(isChecked(names[1])).toBe(true));
    const first = deferred<undefined>();
    vi.mocked(gitDeleteBranch).mockImplementationOnce(() => first.promise);
    await user.click(primary());
    const confirm = await screen.findByRole("dialog", {
      name: "Delete branches?",
    });
    await user.click(
      within(confirm).getByRole("button", { name: "Delete 2 branches" }),
    );
    await waitFor(() => expect(gitDeleteBranch).toHaveBeenCalledTimes(1));
    return { view, release: () => act(async () => first.resolve(undefined)) };
  }

  it("refuses a branch whose rule lands while the batch runs", async () => {
    const { view, release } = await heldDelete("C:/repos/rule-mid-batch", [
      "rm-a",
      "rm-b",
    ]);
    view.rerender({ isProtected: (n) => n === "rm-b" });
    await release();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Deleted 1, 1 failed"),
    );
    expect(vi.mocked(gitDeleteBranch).mock.calls).toEqual([
      ["C:/repos/rule-mid-batch", "rm-a"],
    ]);
  });

  it("keeps the rules it started with across a repo switch", async () => {
    // The batch's own predicate protects rs-b only once the batch runs, so the
    // confirm still lists it.
    let ruleLanded = false;
    const { view, release } = await heldDelete(
      "C:/repos/rule-switch-a",
      ["rs-a", "rs-b"],
      (n) => ruleLanded && n === "rs-b",
    );
    ruleLanded = true;
    const asked: string[] = [];
    act(() => useUiStore.setState({ repoPath: "C:/repos/rule-switch-b" }));
    view.rerender({
      repoPath: "C:/repos/rule-switch-b",
      branches: [branch("rs-other", OLD)],
      isProtected: (n) => {
        asked.push(n);
        return false;
      },
    });
    await release();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Deleted 1, 1 failed"),
    );
    expect(vi.mocked(gitDeleteBranch).mock.calls).toEqual([
      ["C:/repos/rule-switch-a", "rs-a"],
    ]);
    expect(asked).not.toContain("rs-b");
  });

  it("holds Cancel with the running reason, focusable and inert", async () => {
    const view = renderDialog({
      repoPath: "C:/repos/cancel-held",
      branches: [branch("ch-a", OLD + 10), branch("ch-b", OLD)],
    });
    const { user } = view;
    await landRest(["ch-a", "ch-b"], "clean");
    await waitFor(() => expect(isChecked("ch-b")).toBe(true));
    const first = deferred<undefined>();
    vi.mocked(gitSetBranchArchived).mockImplementationOnce(() => first.promise);
    await user.click(primary());
    await waitFor(() => expect(gitSetBranchArchived).toHaveBeenCalledTimes(1));
    const cancel = within(mainDialog()).getByRole("button", {
      name: "Cancel",
      hidden: true,
    });
    expect(cancel).not.toBeDisabled();
    expect(cancel).toHaveAttribute("aria-disabled", "true");
    expect(cancel).toHaveAccessibleDescription(
      /Wait for the current batch to finish\./,
    );
    await user.click(cancel);
    act(() => cancel.focus());
    expect(document.activeElement).toBe(cancel);
    await user.keyboard("{Enter}");
    expect(view.props().onClose).not.toHaveBeenCalled();
    await act(async () => first.resolve(undefined));
  });
});

describe("pull-request caveats and waits", () => {
  it("names only the enabled criteria when the pull-request read failed", async () => {
    const { user } = renderDialog({
      repoPath: "C:/repos/pr-failed-scope",
      branches: [branch("ps-anc", FRESH), branch("ps-closed", FRESH)],
      merged: ["ps-anc"],
      prClosed: { "ps-closed": "#4" },
      prCheckState: "failed",
    });
    await waitFor(() => expect(listed()).toHaveLength(2));
    await setCriteria(user, { merged: true, closed: false, idle: false });
    expect(
      screen.getByText(
        "Pull requests couldn't be checked — a branch merged through one may be missing.",
      ),
    ).toBeInTheDocument();
    await setCriteria(user, { merged: false, closed: true, idle: false });
    expect(
      screen.getByText(
        "Pull requests couldn't be checked — a branch whose pull request was closed may be missing.",
      ),
    ).toBeInTheDocument();
  });

  it("never waits on a connection for a parked refetch of settled pull requests", async () => {
    vi.mocked(gitBranchDivergence).mockImplementation(
      () => new Promise(() => undefined),
    );
    renderDialog({
      repoPath: "C:/repos/parked-refetch",
      branches: [branch("pr-idle", OLD)],
      prCheckState: "checked",
      prCheckPaused: true,
    });
    await waitFor(() => expect(listed()).toEqual(["pr-idle"]));
    expect(
      screen.getByText("Checking which branches are merged…"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Waiting for a connection/)).toBeNull();
  });
});

describe("an offline first open", () => {
  it("names the running ancestry read over the parked pull-request wait", async () => {
    const ancestry =
      deferred<Awaited<ReturnType<typeof gitBranchDivergence>>>();
    vi.mocked(gitBranchDivergence).mockImplementation(() => ancestry.promise);
    renderDialog({
      repoPath: "C:/repos/offline-ancestry",
      branches: [branch("oa-anc", FRESH)],
      prCheckState: "pending",
      prCheckPaused: true,
    });
    const line = await screen.findByText("Checking which branches are merged…");
    expect(screen.queryByText(/^Waiting for a connection/)).toBeNull();
    // The skeleton paints, so the line reaches AT only.
    expect(document.querySelector("[aria-busy]")).not.toBeNull();
    expect(line.closest('[role="status"]')).toHaveClass("sr-only");
    // The ancestry read lands; the pull-request read is all that's left.
    await act(async () =>
      ancestry.resolve([{ name: "oa-anc", ahead: 0, behind: 3 }]),
    );
    await waitFor(() => expect(listed()).toEqual(["oa-anc"]));
    expect(
      screen
        .getByText(
          "Waiting for a connection to check which branches were merged or closed through a pull request…",
        )
        .closest('[role="status"]'),
    ).not.toHaveClass("sr-only");
    expect(
      screen.queryByText("Checking which branches are merged…"),
    ).toBeNull();
  });
});

describe("the measured ref", () => {
  it("names the ref the check compared with on badges and the Delete confirm", async () => {
    // Local main is behind: the check compared with origin/main.
    const { user } = renderDialog({
      repoPath: "C:/repos/measured-ref",
      branches: [branch("mr-clean", OLD + 10), branch("mr-changes", OLD)],
    });
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await landVerdicts({ "mr-clean": "clean", "mr-changes": "changes" });
    await waitFor(() => expect(isChecked("mr-clean")).toBe(true));
    const badge = (name: string, text: string) =>
      within(rowOf(name)).getAllByText(
        (_, el) => el?.tagName === "SPAN" && el.textContent === text,
      );
    expect(badge("mr-clean", "in origin/main").length).toBeGreaterThan(0);
    expect(
      badge("mr-changes", "changes not in origin/main").length,
    ).toBeGreaterThan(0);
    await user.click(boxOf("mr-changes"));
    await user.click(primary());
    const confirm = await screen.findByRole("dialog", {
      name: "Delete branches?",
    });
    expect(confirm).toHaveTextContent(
      "1 of the branches has changes not in origin/main.",
    );
  });
});

describe("frozen rows keep their measured ref", () => {
  const MEASURED = "Nothing on it is missing from origin/main";
  /** The row checkbox's accessible description, from its describedby ids. */
  const descriptionOf = (box: Element) =>
    (box.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");

  /** What each commit painted for `name`'s row while `run` ran: its text, its
   *  verdict badge's title, and its checkbox's description. */
  function rowFrames(name: string, run: () => void) {
    const frames: { text: string; titles: string[]; description: string }[] =
      [];
    onCommit = () => {
      const box = document.querySelector(`[data-row="${CSS.escape(name)}"]`);
      const row = box?.closest("label")?.parentElement;
      if (box && row)
        frames.push({
          text: row.textContent ?? "",
          titles: [...row.querySelectorAll("[title]")].map(
            (el) => el.getAttribute("title") ?? "",
          ),
          description: descriptionOf(box),
        });
    };
    run();
    onCommit = null;
    return frames;
  }

  /** Starts an Archive of two clean rows in repo A whose first call is held,
   *  then switches to repo B, whose base answers `nextBase`. */
  async function switchMidBatch(
    a: string,
    names: [string, string],
    nextBase: typeof baseAnswer,
  ) {
    const view = renderDialog({
      repoPath: a,
      branches: [branch(names[0], OLD + 10), branch(names[1], OLD)],
    });
    await landRest(names, "clean");
    await waitFor(() => expect(isChecked(names[1])).toBe(true));
    const first = deferred<undefined>();
    vi.mocked(gitSetBranchArchived).mockImplementationOnce(() => first.promise);
    await view.user.click(primary());
    await waitFor(() => expect(gitSetBranchArchived).toHaveBeenCalledTimes(1));
    baseAnswer = nextBase;
    act(() => useUiStore.setState({ repoPath: `${a}-b` }));
    view.rerender({
      repoPath: `${a}-b`,
      defaultBranch: "trunk",
      branches: [branch(`${names[0]}-other`, OLD)],
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(listed()).toEqual(names);
    return { view, release: () => act(async () => first.resolve(undefined)) };
  }

  it("across a repo switch mid-batch", async () => {
    // The new repo's base hasn't answered, so its live ref is its default.
    const { release } = await switchMidBatch(
      "C:/repos/frozen-ref-a",
      ["fr-1", "fr-2"],
      new Promise(() => undefined),
    );
    expect(rowOf("fr-2")).toHaveTextContent("in origin/main");
    expect(rowOf("fr-2")).not.toHaveTextContent("in trunk");
    expect(within(rowOf("fr-2")).getByTitle(MEASURED)).toBeInTheDocument();
    expect(descriptionOf(boxOf("fr-2"))).toContain(MEASURED);
    await release();
  });

  it("through the close a full success starts", async () => {
    const view = renderDialog({
      repoPath: "C:/repos/frozen-ref-close",
      branches: [branch("fc-1", OLD)],
    });
    await landVerdicts({ "fc-1": "clean" });
    await waitFor(() => expect(isChecked("fc-1")).toBe(true));
    await view.user.click(primary());
    await waitFor(() => expect(view.props().onClose).toHaveBeenCalled());
    const closing = rowFrames("fc-1", () => view.rerender({ open: false }));
    expect(closing.length).toBeGreaterThan(0);
    for (const frame of closing) {
      expect(frame.text).toContain("in origin/main");
      expect(frame.text).not.toContain("in main");
      expect(frame.titles).toContain(MEASURED);
      expect(frame.description).toContain(MEASURED);
    }
  });

  it("never lets the next repo's check speak while they show", async () => {
    const { release } = await switchMidBatch(
      "C:/repos/frozen-ticker",
      ["ft-1", "ft-2"],
      { ...BASE, refName: "origin/trunk" },
    );
    await waitFor(() =>
      expect(
        verdictCalls.some((c) => c.repo === "C:/repos/frozen-ticker-b"),
      ).toBe(true),
    );
    expect(document.body).not.toHaveTextContent("origin/trunk");
    await landVerdicts({ "ft-1-other": "clean" });
    expect(listed()).toEqual(["ft-1", "ft-2"]);
    expect(document.body).not.toHaveTextContent("origin/trunk");
    await release();
  });
});

describe("after a partial batch over a stale list", () => {
  it("never re-checks a branch the batch already acted on", async () => {
    const view = renderDialog({
      repoPath: "C:/repos/stale-retry",
      branches: [branch("sr-a", OLD + 10), branch("sr-b", OLD)],
    });
    await landVerdicts({ "sr-a": "clean", "sr-b": "clean" });
    await waitFor(() => expect(isChecked("sr-b")).toBe(true));
    expect(isChecked("sr-a")).toBe(true);
    vi.mocked(gitSetBranchArchived).mockImplementation(async (_repo, name) => {
      if (name === "sr-b") throw new Error("branch is busy");
    });
    await view.user.click(primary());
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Archived 1, 1 failed"),
    );
    // The branch list didn't refetch, so sr-a is still listed.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(listed()).toEqual(["sr-a", "sr-b"]);
    expect(isChecked("sr-a")).toBe(false);
    expect(isChecked("sr-b")).toBe(true);
    vi.mocked(gitSetBranchArchived).mockClear();
    await view.user.click(primary());
    await waitFor(() => expect(gitSetBranchArchived).toHaveBeenCalled());
    expect(vi.mocked(gitSetBranchArchived).mock.calls).toEqual([
      ["C:/repos/stale-retry", "sr-b", true],
    ]);
  });
});

describe("a failure caveat over the skeleton", () => {
  it("keeps the checking line out of sight while the caveat shows", async () => {
    renderDialog({
      repoPath: "C:/repos/caveat-skeleton",
      branches: [branch("main", OLD), branch("cs-old", OLD)],
      defaultBranch: undefined,
      prCheckState: "failed",
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(document.querySelector("[aria-busy]")).not.toBeNull();
    const caveat = screen.getByText(
      "Pull requests couldn't be checked — a branch merged or closed through one may be missing.",
    );
    expect(caveat).not.toHaveClass("sr-only");
    expect(caveat.closest('[role="status"]')).not.toHaveClass("sr-only");
    expect(
      screen.getByText("Checking which branch is the default…"),
    ).toHaveClass("sr-only");
  });
});

describe("a row that turns out to be checked out in a worktree", () => {
  /** Lists `x` and `y` in Delete mode with the opt-in on and no worktree
   *  holding either, lands their verdicts, then lets `touch` act before a
   *  worktree read shows `x` checked out in a linked worktree. */
  async function becomesWorktree(
    repoPath: string,
    [x, y]: [string, string],
    verdicts: Record<string, ContentVerdict>,
    touch: (user: ReturnType<typeof userEvent.setup>) => Promise<void>,
  ) {
    statusByPath.set(`C:/wt/${x}`, "clean");
    const view = renderDialog({
      repoPath,
      branches: [branch(x, OLD + 10), branch(y, OLD)],
    });
    const { user } = view;
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await user.click(optIn());
    await landVerdicts(verdicts);
    await waitFor(() => expect(isChecked(y)).toBe(true));
    await touch(user);
    view.rerender({
      worktreeFacts: new Map([
        [x, { path: `C:/wt/${x}`, isLocked: false, isMain: false }],
      ]),
    });
    await waitFor(() =>
      expect(within(rowOf(x)).getByText("worktree")).toBeInTheDocument(),
    );
    await waitFor(() => expect(boxOf(x)).not.toHaveAttribute("aria-disabled"));
    return view;
  }

  it("drops the check a verdict gave it while it was plain", async () => {
    const { user } = await becomesWorktree(
      "C:/repos/auto-to-worktree",
      ["aw-x", "aw-y"],
      { "aw-x": "clean", "aw-y": "clean" },
      async () => expect(isChecked("aw-x")).toBe(true),
    );
    expect(isChecked("aw-x")).toBe(false);
    await user.click(primary());
    const confirm = await screen.findByRole("dialog", {
      name: "Delete branch?",
    });
    expect(confirm).toHaveTextContent(
      "Permanently deletes 1 branch, including commits that exist only on it. This can't be undone.",
    );
  });

  it("keeps a check the user gave it", async () => {
    const { user } = await becomesWorktree(
      "C:/repos/user-to-worktree",
      ["uw-x", "uw-y"],
      { "uw-x": "changes", "uw-y": "clean" },
      async (u) => {
        expect(isChecked("uw-x")).toBe(false);
        await u.click(boxOf("uw-x"));
        expect(isChecked("uw-x")).toBe(true);
      },
    );
    expect(isChecked("uw-x")).toBe(true);
    await user.click(primary());
    const confirm = await screen.findByRole("dialog", {
      name: "Delete branches?",
    });
    expect(confirm).toHaveTextContent(
      "Removes 1 worktree and deletes 2 branches",
    );
  });
});
