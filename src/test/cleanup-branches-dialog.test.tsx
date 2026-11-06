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
import { CleanupBranchesDialog } from "@/features/repository/CleanupBranchesDialog";
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
/** Worktree status answers by path; a missing path stays in flight. */
let statusByPath = new Map<string, "clean" | "dirty" | "reject">();

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
    if (answer === "reject") return Promise.reject(new Error("status failed"));
    return Promise.resolve({
      branch: {} as RepoStatus["branch"],
      entries: answer === "dirty" ? [{} as FileEntry] : [],
    });
  });
  vi.mocked(gitSetBranchArchived).mockImplementation(async () => undefined);
  vi.mocked(gitDeleteBranch).mockImplementation(async () => undefined);
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
    defaultBranch: s.defaultBranch === undefined ? "main" : s.defaultBranch,
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
    // O1: every criterion on, the worktree opt-in off.
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

  it("turns Idle on when a window is pressed while it is off (N10)", async () => {
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
    // I2: nothing verdict-gated is checked before its verdict lands.
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

  it("never overrides a row the user touched before its verdict landed (I1)", async () => {
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
    // D14: an unknown verdict shows nothing, not even a skeleton.
    const unknown = rowOf("b-unknown");
    expect(within(unknown).queryByText(/^in$|^changes not in$/)).toBeNull();
    expect(unknown.querySelector(".animate-pulse")).toBeNull();
    // N5: the compared ref reaches AT once settled.
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
    // D8: a branch whose worktree is being removed is a plain Archive row.
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

  it("holds locked, dirty, pending and unreadable rows: focusable, explained, never toggled (D17)", async () => {
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
    const reasons: Record<string, string | null> = {
      "w-locked": "Worktree is locked, so it can't be removed.",
      "w-dirty": "Worktree has uncommitted changes, so it can't be removed.",
      "w-unreadable": "Couldn't check the worktree for uncommitted changes.",
      "w-pending": null,
    };
    for (const [name, reason] of Object.entries(reasons)) {
      const box = boxOf(name);
      expect(box).toHaveAttribute("aria-disabled", "true");
      if (reason === null) {
        expect(box).not.toHaveAttribute("aria-describedby");
        continue;
      }
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

    // Select all grabs the actionable rows only.
    await user.click(screen.getByRole("button", { name: /Select all/ }));
    for (const name of Object.keys(reasons))
      expect(isChecked(name)).toBe(false);
    expect(isChecked("w-clean")).toBe(true);
    expect(isChecked("w-plain")).toBe(true);
    expect(screen.getByText("3 of 3 selected")).toBeInTheDocument();
  });
});

describe("the batch", () => {
  it("acts only on visible checked rows (I3)", async () => {
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

  it("removes each worktree in turn, only after the row before it settles (I5)", async () => {
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
    // N11: the batch's own removal mark doesn't drop the row mid-run.
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
  it("counts and acts on the snapshot taken when the confirm opened (F2)", async () => {
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
      "Permanently deletes 2 branches, including commits that exist only on them. 1 of the branches has changes not in main. This can't be undone.";
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

  it("closes the Delete confirm on a repo switch, and nothing runs (E1)", async () => {
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
  it("resets every control after a Delete run, and re-checks verdicts for this open (N2)", async () => {
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
  it("ticks outside the live region and keeps the region's text steady (I4)", async () => {
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
    const { user } = renderDialog({
      repoPath: "C:/repos/keys",
      branches: [branch("y-idle", OLD), branch("y-closed", FRESH)],
      prClosed: { "y-closed": "#8" },
    });
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

    // y-closed is the last row; make it active, then hide it.
    act(() => boxOf("y-idle").focus());
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(boxOf("y-closed"));
    await user.click(screen.getByRole("button", { name: "Closed PR" }));
    expect(listed()).toEqual(["y-idle"]);
    expect(document.activeElement).not.toBe(document.body);
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
    renderDialog({
      repoPath: "C:/repos/long-list",
      branches: names.map((n, i) => branch(n, OLD + i)),
    });
    await screen.findByText(/^Checked 0 of 150 branches/);
    // Land whatever the limiter has started, a round at a time, reading the
    // visible count after each round.
    const counts: number[] = [];
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
    }
    expect(counts.some((n) => n > 0 && n < 150)).toBe(true);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    await waitFor(() =>
      expect(screen.getByText("150 of 150 selected")).toBeInTheDocument(),
    );
    expect(gitBranchContentMerged).toHaveBeenCalledTimes(150);
  }, 60_000);
});

describe("across reseeds, reopens and batches", () => {
  it("re-applies settled verdict checks after a reseed (F2)", async () => {
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

  it("drops a previous open's verdict checks until this open's land (P3-1)", async () => {
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

  it("takes a kept branch out of the selection for the rest of the open (P3-2)", async () => {
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

  it("never carries an acted-on branch into the next open (D1)", async () => {
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

  it("acts on the worktree rows the confirm counted (F10)", async () => {
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

  it("keeps the frozen rows and their verdicts through a run (P3-7)", async () => {
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

  it("keeps a failed worktree row checked while its status re-reads (B1)", async () => {
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

  it("shows no verdict on a kept row, and its confirm counts it changed (B2)", async () => {
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
      "Permanently deletes 1 branch, including commits that exist only on it. It has changes not in main. This can't be undone.",
    );
  });

  it("never re-seeds a kept row that ancestry calls merged (B3)", async () => {
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

  it("counts the frozen rows while a batch runs (R4)", async () => {
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

  it("closes a fully successful run still frozen, and the next open lets go (R5)", async () => {
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
  it("holds nothing on a parked pull-request read while it doesn't count (P3-3)", async () => {
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

  it("holds a worktree row on a cached status until this open's read lands (P3-5)", async () => {
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

  it("holds a worktree row pending, not failed, while a cached failure re-reads (B5)", async () => {
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
    expect(boxOf("cf-w")).not.toHaveAttribute("aria-describedby");
    expect(
      screen.queryByText(
        "Couldn't check the worktree for uncommitted changes.",
      ),
    ).toBeNull();
  });

  it("re-reads the worktree list when the opt-in turns on (OBS)", async () => {
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
});
