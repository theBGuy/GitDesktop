import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FileFilterSurface,
  useFileFilterStore,
} from "@/components/use-file-list-filter";
import { BranchDiffView } from "@/features/compare/BranchDiffView";
import {
  gitBranchDiffFiles,
  gitBranchFileDiff,
  gitMergeBase,
} from "@/lib/git/api";
import type { DiffStatEntry, FileDiff } from "@/lib/git/types";
import { useHotkeysListener } from "@/lib/hotkeys/hotkeys";
import { loadSettings, saveSettingsMerged } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitBranchDiffFiles: vi.fn(),
  gitBranchFileDiff: vi.fn(),
  gitMergeBase: vi.fn(),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
  saveSettingsMerged: vi.fn(),
}));
// A wide row, so the rail is expanded and its field rendered.
vi.mock("@/lib/use-container-width", () => ({
  useContainerWidth: () => [() => undefined, 900],
}));
// The stand-in pane names the file it shows, and whether its read is enabled.
vi.mock("@/features/diff/DiffSurfaceLazy", async () => {
  const { useReportPaneSettled } = await import(
    "@/features/diff/diff-pane-hold"
  );
  function DiffSurface({
    filePath,
    diff,
  }: {
    filePath: string;
    diff?: { isEnabled: boolean };
  }) {
    useReportPaneSettled(true);
    return (
      <div data-open-file={filePath} data-read-enabled={diff?.isEnabled} />
    );
  }
  return { DiffSurface, DiffContent: DiffSurface };
});

Element.prototype.scrollIntoView = vi.fn();

const REPO = "/repo";
const entry = (path: string): DiffStatEntry => ({
  path,
  added: 1,
  deleted: 1,
  isBinary: false,
  binaryKind: null,
});
const diffOf = (path: string): FileDiff => ({
  filePath: path,
  isBinary: false,
  isTruncated: false,
  text: `diff --git a/${path} b/${path}\n`,
});
const THIRTEEN = [
  "src/alpha.ts",
  "src/beta.ts",
  "src/gamma.ts",
  "lib/alpha-2.ts",
  "docs/delta.md",
  "docs/epsilon.md",
  "test/zeta.ts",
  "test/eta.ts",
  "test/theta.ts",
  "a/iota.ts",
  "a/kappa.ts",
  "a/lambda.ts",
  "a/mu.ts",
];
const LONG = Array.from(
  { length: 42 },
  (_, i) => `src/file-${String(i).padStart(2, "0")}.ts`,
);

/** The files each `base` serves; a missing base never settles. */
let lists: Record<string, string[] | Promise<string[]>> = {};

function Listener() {
  useHotkeysListener();
  return null;
}

function renderView(
  base: string,
  surface: FileFilterSurface = "local-pr-files",
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = (b: string, s: FileFilterSurface) => (
    <QueryClientProvider client={client}>
      <Listener />
      <button type="button">Outside</button>
      <BranchDiffView
        repoPath={REPO}
        base={b}
        compare="head"
        filterSurface={s}
      />
    </QueryClientProvider>
  );
  const utils = render(view(base, surface));
  return {
    client,
    ...utils,
    switchTo: (b: string, s: FileFilterSurface = surface) =>
      utils.rerender(view(b, s)),
    refetch: () => act(() => client.refetchQueries()),
  };
}

const field = () =>
  screen.getByRole<HTMLInputElement>("textbox", {
    name: "Filter changed files",
  });
const fieldGroup = () =>
  field().closest('[data-slot="input-group"]') as HTMLElement;
const rail = () => screen.getByRole("complementary");
const rendered = () =>
  Array.from(
    rail().querySelectorAll<HTMLElement>("[data-path]"),
    (el) => el.dataset.path,
  );
const openFile = () =>
  Array.from(document.querySelectorAll("[data-open-file]"))
    .find((el) => el.closest("[inert]") === null)
    ?.getAttribute("data-open-file");
const openPane = () =>
  Array.from(document.querySelectorAll("[data-open-file]")).find(
    (el) => el.closest("[inert]") === null,
  );
const status = () =>
  document.querySelector<HTMLElement>("[data-file-filter-status]");
const host = () =>
  document.querySelector<HTMLElement>('[tabindex="-1"].h-full');
const expectOpen = (path: string) =>
  waitFor(() => expect(openFile()).toBe(path));

beforeEach(() => {
  vi.clearAllMocks();
  unmockedCommands.length = 0;
  useFileFilterStore.setState({ texts: {} });
  lists = {};
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(saveSettingsMerged).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(gitBranchDiffFiles).mockImplementation(async (_r, base) => {
    const served = await lists[base];
    if (served === undefined) return new Promise(() => undefined);
    return served.map(entry);
  });
  vi.mocked(gitBranchFileDiff).mockImplementation(async (_r, _b, _c, path) =>
    diffOf(path),
  );
  vi.mocked(gitMergeBase).mockResolvedValue({
    mergeBase: "1234567abc",
    compareRev: "abc1234567",
  });
});

afterEach(() => {
  expect(unmockedCommands).toEqual([]);
});

describe("BranchDiffView file filter", () => {
  it("C-a C-g C-j: filters the rows, keeps the pane and the header's full count", async () => {
    lists.one = THIRTEEN;
    const user = userEvent.setup();
    const { container } = renderView("one");
    await expectOpen("src/alpha.ts");
    expect(fieldGroup().textContent).toContain("13 files");
    await user.type(field(), "eta");
    expect(rendered()).toEqual([
      "src/beta.ts",
      "test/zeta.ts",
      "test/eta.ts",
      "test/theta.ts",
    ]);
    expect(fieldGroup().textContent).toContain("4 of 13");
    expect(openFile()).toBe("src/alpha.ts");
    // The view header keeps describing the whole comparison.
    expect(container.querySelector("header")?.textContent).toContain(
      "13 files",
    );
    const listbox = screen.getByRole("listbox", { name: "Changed files" });
    const options = Array.from(listbox.querySelectorAll("[data-path]"));
    expect(options.every((o) => o.getAttribute("role") === "option")).toBe(
      true,
    );
    expect(listbox.querySelector('[aria-selected="true"]')).toBeNull();
  });

  it("C-b: list arrows walk the matches only", async () => {
    lists.one = LONG;
    const user = userEvent.setup();
    renderView("one");
    await expectOpen("src/file-00.ts");
    await user.type(field(), "5.ts");
    expect(rendered()).toEqual([
      "src/file-05.ts",
      "src/file-15.ts",
      "src/file-25.ts",
      "src/file-35.ts",
    ]);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.getAttribute("data-path")).toBe(
      "src/file-05.ts",
    );
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.getAttribute("data-path")).toBe(
      "src/file-15.ts",
    );
    await expectOpen("src/file-15.ts");
  });

  it("C-c C-h: a new comparison's placeholder window changes nothing; the settled list opens its first match", async () => {
    lists.one = ["a/x.ts", "b/y.ts", "c/z.md"];
    let land: (paths: string[]) => void = () => undefined;
    lists.two = new Promise((r) => {
      land = r;
    });
    const user = userEvent.setup();
    const { switchTo } = renderView("one");
    await expectOpen("a/x.ts");
    await user.type(field(), "t");
    expect(status()?.textContent).toBe("Showing 2 of 3 files");
    switchTo("two");
    await act(() => Promise.resolve());
    // The previous comparison's rows, dimmed and busy.
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(status()?.closest('[aria-busy="true"]')).toBeNull();
    await user.type(field(), "y");
    expect(rendered()).toEqual([]);
    expect(status()?.textContent).toBe("Showing 2 of 3 files");
    expect(openFile()).toBe("a/x.ts");
    await act(async () => land(["d/one.ts", "e/two.md", "f/ty.ts"]));
    await expectOpen("f/ty.ts");
    expect(status()?.textContent).toBe("Showing 1 of 3 files");
    lists.three = ["g/a.md", "h/b.md"];
    switchTo("three");
    await expectOpen("g/a.md");
    expect(rendered()).toEqual([]);
  });

  it("C-i: the compare surface claims Mod+F tab-wide; surfaces keep separate text", async () => {
    lists.one = THIRTEEN;
    const user = userEvent.setup();
    const { switchTo } = renderView("one", "compare");
    await expectOpen("src/alpha.ts");
    await user.type(field(), "beta");
    await act(() => (document.activeElement as HTMLElement).blur());
    await user.keyboard("{Control>}f{/Control}");
    expect(document.activeElement).toBe(field());
    switchTo("one", "session");
    await waitFor(() => expect(field().value).toBe(""));
    await act(() => (document.activeElement as HTMLElement).blur());
    await user.keyboard("{Control>}f{/Control}");
    expect(document.activeElement).toBe(document.body);
    expect(useFileFilterStore.getState().texts).toEqual({ compare: "beta" });
  });

  it("C-l: the list emptying under the field or a row lands focus on the host", async () => {
    lists.one = THIRTEEN;
    const user = userEvent.setup();
    const { refetch } = renderView("one");
    await expectOpen("src/alpha.ts");
    await user.type(field(), "a");
    lists.one = [];
    await refetch();
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    expect(document.activeElement).toBe(host());

    lists.one = THIRTEEN;
    await refetch();
    await waitFor(() => expect(rendered().length).toBeGreaterThan(0));
    await user.click(field());
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.getAttribute("data-path")).toBeTruthy();
    lists.one = [];
    await refetch();
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    expect(document.activeElement).toBe(host());

    lists.one = THIRTEEN;
    await refetch();
    await waitFor(() => expect(rendered().length).toBeGreaterThan(0));
    const outside = screen.getByRole("button", { name: "Outside" });
    await act(() => outside.focus());
    lists.one = [];
    await refetch();
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    expect(document.activeElement).toBe(outside);
  });

  it("C-l: a new comparison settling empty under a focused placeholder row lands focus on the host", async () => {
    lists.one = THIRTEEN;
    let land: (paths: string[]) => void = () => undefined;
    lists.two = new Promise((r) => {
      land = r;
    });
    const { switchTo } = renderView("one");
    await expectOpen("src/alpha.ts");
    switchTo("two");
    await act(() => Promise.resolve());
    // The previous comparison's rows stand in while the new one loads.
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
    const row = rail().querySelector<HTMLElement>('[data-path="src/beta.ts"]');
    expect(row).toBeTruthy();
    await act(() => row?.focus());
    expect(document.activeElement).toBe(row);
    await act(async () => land([]));
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    expect(document.activeElement).toBe(host());
  });

  it("the open file's read stays enabled while the filter hides its row", async () => {
    lists.one = THIRTEEN;
    const user = userEvent.setup();
    renderView("one");
    await expectOpen("src/alpha.ts");
    await waitFor(() =>
      expect(openPane()?.getAttribute("data-read-enabled")).toBe("true"),
    );
    await user.type(field(), "eta");
    expect(rendered()).not.toContain("src/alpha.ts");
    await act(() => Promise.resolve());
    expect(openFile()).toBe("src/alpha.ts");
    expect(openPane()?.getAttribute("data-read-enabled")).toBe("true");
  });

  it("C-k: an untouched list follows a new first file; a typed filter pins the open file", async () => {
    lists.one = ["b.ts", "c.ts"];
    const user = userEvent.setup();
    const { refetch } = renderView("one");
    await expectOpen("b.ts");
    lists.one = ["a.ts", "b.ts", "c.ts"];
    await refetch();
    await expectOpen("a.ts");
    await user.type(field(), "c");
    expect(rendered()).toEqual(["c.ts"]);
    await act(() => Promise.resolve());
    expect(openFile()).toBe("a.ts");
    lists.one = ["0.ts", "a.ts", "c.ts"];
    await refetch();
    await act(() => Promise.resolve());
    expect(openFile()).toBe("a.ts");
  });
});
