import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
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
import { MyWorkScreen } from "@/features/mywork/MyWorkScreen";
import { copyText } from "@/lib/clipboard";
import { forgePrHeadRef, repoOriginPath, validateRepo } from "@/lib/git/api";
import type { MyWorkItem, RepoInfo, RepoOrigin } from "@/lib/git/types";
import { listUserWorktrees } from "@/lib/git/worktree";
import type { RecentRepo } from "@/lib/settings/api";
import { useUiStore } from "@/lib/stores/ui";

const data = vi.hoisted(() => ({
  items: [] as MyWorkItem[],
  recents: [] as RecentRepo[],
}));

vi.mock("@/lib/git/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/queries")>()),
  useMyWorkSources: () => ({
    data: { github: true, gitlab: false, bitbucket: false },
    isPending: false,
    isSuccess: true,
    isError: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  }),
  useForgeMyWork: (provider: string) =>
    provider === "github"
      ? {
          data: { items: data.items, truncated: false },
          isPending: false,
          isSuccess: true,
          isError: false,
          isPaused: false,
          isFetching: false,
          isPlaceholderData: false,
          error: null,
          refetch: vi.fn(),
        }
      : {
          data: undefined,
          isPending: true,
          isSuccess: false,
          isError: false,
          isPaused: false,
          isFetching: false,
          isPlaceholderData: false,
          error: null,
          refetch: vi.fn(),
        },
}));
vi.mock("@/lib/settings/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/queries")>()),
  useSettings: () => ({ data: { recentRepos: data.recents } }),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  validateRepo: vi.fn(),
  repoOriginPath: vi.fn(),
  forgePrHeadRef: vi.fn(),
}));
vi.mock("@/lib/git/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/worktree")>()),
  listUserWorktrees: vi.fn(),
}));
// Always granted, so these cases see only the screen's own generation: whether
// the menu's browser open takes a repo claim is not observable here.
vi.mock("@/features/repository/useOpenRepoByPath", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/repository/useOpenRepoByPath")
  >()),
  claimRepoOpen: () => () => true,
}));
// The opener plugin calls Tauri directly, past the test transport.
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/lib/clipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clipboard")>()),
  copyText: vi.fn(),
}));
vi.mock("@/lib/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/toast")>()),
  toastError: vi.fn(),
}));

const validate = vi.mocked(validateRepo);
const origin = vi.mocked(repoOriginPath);
const headRef = vi.mocked(forgePrHeadRef);
const worktrees = vi.mocked(listUserWorktrees);
const opened = vi.mocked(openUrl);
const copied = vi.mocked(copyText);
const openPr = vi.fn();
const openIssue = vi.fn();

const item = (
  repoName: string,
  number: number,
  isPullRequest: boolean,
  updatedAt: string,
): MyWorkItem => ({
  number,
  title: `${repoName} ${number}`,
  isPullRequest,
  isDraft: false,
  repoFullName: `acme/${repoName}`,
  repoOwner: "acme",
  repoName,
  host: "github.com",
  url: `https://github.com/acme/${repoName}/${isPullRequest ? "pull" : "issues"}/${number}`,
  updatedAt,
  provider: "github",
});

const recent = (repoName: string): RecentRepo => ({
  path: `C:/src/${repoName}`,
  name: repoName,
  lastOpenedAt: "2026-01-01T00:00:00Z",
  host: "github.com",
  owner: "acme",
  repoName,
  provider: "github",
});

const proven = (path: string): RepoOrigin => ({
  host: "github.com",
  authority: "github.com",
  path: `acme/${path.split("/").at(-1)}`,
  provider: "github",
});

beforeEach(() => {
  vi.useFakeTimers();
  validate.mockReset().mockImplementation(
    async (p): Promise<RepoInfo> => ({
      root: p,
      name: p.split("/").at(-1) ?? p,
    }),
  );
  origin.mockReset().mockImplementation(async (p) => proven(p));
  headRef.mockReset();
  worktrees.mockReset().mockResolvedValue([]);
  opened.mockReset().mockResolvedValue(undefined);
  copied.mockReset();
  openPr.mockReset();
  openIssue.mockReset();
  useUiStore.setState({ view: "mywork", openPr, openIssue });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderScreen() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MyWorkScreen />
    </QueryClientProvider>,
  );
  const input = screen.getByRole("combobox", { name: "Filter your work" });
  input.focus();
  return input;
}

/** The spoken wait: the screen's one sr-only status element. */
const spoken = () => {
  const el = document.querySelector('[role="status"].sr-only');
  if (!el) throw new Error("the wait's status element is not mounted");
  return el.textContent;
};

const rowOf = (it: MyWorkItem) => {
  const el = document.querySelector(`[data-my-work-url="${it.url}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`no row for ${it.url}`);
  return el;
};

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** Right-clicks a row and picks a menu entry by name. */
async function pickFromMenu(row: HTMLElement, name: string) {
  fireEvent.contextMenu(row);
  await advance(0);
  screen.getByRole("menu");
  fireEvent.click(screen.getByRole("menuitem", { name }));
  await advance(0);
}

// jsdom lays nothing out, so the virtualized list (@tanstack/virtual-core sizes
// its viewport from the scroll element's clientWidth/clientHeight) paints no
// row; a fixed client size gives it a viewport.
describe("My work rows", () => {
  const CLIENT_SIZE = { clientWidth: 800, clientHeight: 600 } as const;
  beforeAll(() => {
    for (const [k, v] of Object.entries(CLIENT_SIZE)) {
      Object.defineProperty(HTMLElement.prototype, k, {
        configurable: true,
        get: () => v,
      });
    }
  });
  afterAll(() => {
    for (const k of Object.keys(CLIENT_SIZE)) {
      Reflect.deleteProperty(HTMLElement.prototype, k);
    }
  });

  describe("W: the row menu's browser open retires a pending local open", () => {
    const alpha = item("alpha", 1, true, "2026-01-03T00:00:00Z");
    const beta = item("beta", 2, false, "2026-01-02T00:00:00Z");
    let settleAlpha: () => void = () => undefined;

    beforeEach(() => {
      data.items = [alpha, beta];
      data.recents = [recent("alpha"), recent("beta")];
      validate.mockImplementation((p) =>
        p === "C:/src/alpha"
          ? new Promise<RepoInfo>((resolve) => {
              settleAlpha = () => resolve({ root: p, name: "alpha" });
            })
          : Promise.resolve({ root: p, name: p.split("/").at(-1) ?? p }),
      );
    });

    it.each([
      ["the pending row", alpha],
      ["another row", beta],
    ] as const)("from %s", async (_label, target) => {
      const input = renderScreen();
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "Enter" });
      await advance(300);
      expect(spoken()).toBe("Opening alpha pull request 1\u2026");
      expect(rowOf(alpha)).toHaveAttribute("aria-busy", "true");

      await pickFromMenu(rowOf(target), "Open on GitHub");
      expect(opened).toHaveBeenCalledTimes(1);
      expect(opened).toHaveBeenCalledWith(target.url);
      expect(spoken()).toBe("");
      expect(rowOf(alpha)).toHaveAttribute("aria-busy", "false");

      // Inside the resolver's budget, to a landing it would otherwise take.
      await advance(100);
      await act(async () => {
        settleAlpha();
        await vi.advanceTimersByTimeAsync(0);
      });
      await advance(1500);
      expect(openPr).not.toHaveBeenCalled();
      expect(openIssue).not.toHaveBeenCalled();
      expect(opened).toHaveBeenCalledTimes(1);
      expect(spoken()).toBe("");
    });

    it("Open in main workspace still opens the local clone", async () => {
      // A proven head in a linked worktree: a plain open would land there.
      worktrees.mockResolvedValue([
        {
          path: "C:/src/alpha",
          branch: "main",
          head: "",
          isMain: true,
          isDetached: false,
          isLocked: false,
          lockReason: "",
          lastActivityMs: null,
        },
        {
          path: "C:/src/alpha-feat",
          branch: "feat",
          head: "",
          isMain: false,
          isDetached: false,
          isLocked: false,
          lockReason: "",
          lastActivityMs: null,
        },
      ]);
      headRef.mockResolvedValue({
        headRefName: "feat",
        headRepoFullName: "acme/alpha",
      });
      renderScreen();
      await pickFromMenu(rowOf(beta), "Copy link");
      expect(copied).toHaveBeenCalledWith(beta.url, "Link copied");
      validate.mockImplementation(async (p) => ({ root: p, name: "alpha" }));
      await pickFromMenu(rowOf(alpha), "Open in main workspace");
      expect(openPr).toHaveBeenCalledTimes(1);
      expect(openPr).toHaveBeenCalledWith(
        expect.objectContaining({ repoPath: "C:/src/alpha", ref: "1" }),
      );
      expect(opened).not.toHaveBeenCalled();
    });
  });

  it("L: the listbox is no Tab stop of its own", () => {
    data.items = [item("widgets", 12, true, "2026-01-02T00:00:00Z")];
    data.recents = [];
    renderScreen();
    expect(screen.getByRole("listbox")).toHaveAttribute("tabindex", "-1");
  });

  describe("P: the list's press guard", () => {
    const row = item("widgets", 12, true, "2026-01-02T00:00:00Z");
    beforeEach(() => {
      data.items = [row];
      data.recents = [];
    });
    /** preventDefault calls a native press on `el` received, the row's own
     *  handler and the list's guard both counted. */
    const press = (el: Element, button: number) => {
      const evt = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button,
      });
      const spy = vi.spyOn(evt, "preventDefault");
      el.dispatchEvent(evt);
      return spy.mock.calls.length;
    };

    it("leaves a row's press to the row", () => {
      renderScreen();
      expect(press(rowOf(row), 0)).toBe(1);
    });

    it("keeps a press on the list itself off the list", () => {
      renderScreen();
      expect(press(screen.getByRole("listbox"), 0)).toBeGreaterThanOrEqual(1);
    });

    it("a middle press on the list is kept off it too", () => {
      renderScreen();
      expect(press(screen.getByRole("listbox"), 1)).toBeGreaterThanOrEqual(1);
    });

    it("keeps a press on the virtualizer's spacer off the list", () => {
      renderScreen();
      const spacer = screen.getByRole("listbox").firstElementChild;
      expect(spacer).not.toBeNull();
      expect(spacer?.getAttribute("role")).toBeNull();
      expect(press(spacer as Element, 0)).toBeGreaterThanOrEqual(1);
    });

    it("leaves a press inside a row to the row alone", () => {
      renderScreen();
      const glyph = rowOf(row).querySelector("span");
      expect(glyph).not.toBeNull();
      expect(press(glyph as Element, 0)).toBe(1);
    });
  });

  describe("D: one multi-click gesture opens a row once", () => {
    const remote = item("widgets", 12, true, "2026-01-02T00:00:00Z");

    it("a double click on a browser-only row opens one page", async () => {
      data.items = [remote];
      data.recents = [];
      renderScreen();
      fireEvent.click(rowOf(remote), { detail: 1 });
      fireEvent.click(rowOf(remote), { detail: 2 });
      await advance(0);
      expect(opened).toHaveBeenCalledTimes(1);
      expect(opened).toHaveBeenCalledWith(remote.url);
    });

    it("a triple click on a browser-only row opens one page", async () => {
      data.items = [remote];
      data.recents = [];
      renderScreen();
      for (const detail of [1, 2, 3]) {
        fireEvent.click(rowOf(remote), { detail });
      }
      await advance(0);
      expect(opened).toHaveBeenCalledTimes(1);
    });

    it("a double click on a local row resolves once", async () => {
      data.items = [remote];
      data.recents = [recent("widgets")];
      renderScreen();
      fireEvent.click(rowOf(remote), { detail: 1 });
      fireEvent.click(rowOf(remote), { detail: 2 });
      await advance(0);
      expect(validate).toHaveBeenCalledTimes(1);
      expect(openPr).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["a single click", 1],
      ["a keyboard-synthesized click", 0],
    ] as const)("%s opens once", async (_label, detail) => {
      data.items = [remote];
      data.recents = [];
      renderScreen();
      fireEvent.click(rowOf(remote), { detail });
      await advance(0);
      expect(opened).toHaveBeenCalledTimes(1);
      expect(opened).toHaveBeenCalledWith(remote.url);
    });

    it("a shift-click still opens the main workspace", async () => {
      data.items = [remote];
      data.recents = [recent("widgets")];
      worktrees.mockResolvedValue([
        {
          path: "C:/src/widgets",
          branch: "main",
          head: "",
          isMain: true,
          isDetached: false,
          isLocked: false,
          lockReason: "",
          lastActivityMs: null,
        },
        {
          path: "C:/src/widgets-feat",
          branch: "feat",
          head: "",
          isMain: false,
          isDetached: false,
          isLocked: false,
          lockReason: "",
          lastActivityMs: null,
        },
      ]);
      headRef.mockResolvedValue({
        headRefName: "feat",
        headRepoFullName: "acme/widgets",
      });
      renderScreen();
      fireEvent.click(rowOf(remote), { detail: 1, shiftKey: true });
      await advance(0);
      expect(openPr).toHaveBeenCalledTimes(1);
      expect(openPr).toHaveBeenLastCalledWith(
        expect.objectContaining({ repoPath: "C:/src/widgets" }),
      );
      expect(headRef).not.toHaveBeenCalled();
    });

    it("Enter on the filter box still opens", async () => {
      data.items = [remote];
      data.recents = [];
      const input = renderScreen();
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "Enter" });
      await advance(0);
      expect(opened).toHaveBeenCalledTimes(1);
      expect(opened).toHaveBeenCalledWith(remote.url);
    });
  });
});
