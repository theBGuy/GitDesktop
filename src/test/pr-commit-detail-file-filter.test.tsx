import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFileFilterStore } from "@/components/use-file-list-filter";
import { PrCommitDetail } from "@/features/pulls/PrCommitDetail";
import {
  forgeCommitComments,
  forgePrCommitDiff,
  forgeStatus,
  gitObjectsPresent,
} from "@/lib/git/api";
import type { ForgeStatus, PrCommitOut } from "@/lib/git/types";
import { loadSettings, saveSettingsMerged } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeCommitComments: vi.fn(),
  forgePrCommitDiff: vi.fn(),
  forgeStatus: vi.fn(),
  gitObjectsPresent: vi.fn(),
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
// The stand-in pane names the file it shows in an attribute. A "slow" file
// never settles, so a pick of it holds the pane busy.
vi.mock("@/features/diff/DiffSurfaceLazy", async () => {
  const { useReportPaneSettled } = await import(
    "@/features/diff/diff-pane-hold"
  );
  function DiffContent({ filePath }: { filePath: string }) {
    useReportPaneSettled(!filePath.includes("slow"));
    return <div data-open-file={filePath} />;
  }
  return { DiffSurface: DiffContent, DiffContent };
});

Element.prototype.scrollIntoView = vi.fn();

const REPO = "/repo";
/** Non-zero hex, so the oid-width guard never reads a zero run. */
const A = "abcdef0123".repeat(4);
const B = `b${A.slice(1)}`;
const ALL_ON = new Proxy({}, { get: () => true });
const commit = (oid: string): PrCommitOut => ({
  oid,
  headline: `headline ${oid.slice(0, 4)}`,
  date: "2026-11-01T10:00:00Z",
  author: "Ada",
  messageBody: "",
});
const patch = (paths: string[]) =>
  paths
    .map(
      (p) =>
        `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-old\n+new\n`,
    )
    .join("");
const LONG = Array.from(
  { length: 42 },
  (_, i) => `src/file-${String(i).padStart(2, "0")}.ts`,
);

/** The files each commit's patch carries. */
let lists: Record<string, string[]> = {};

function renderView(oid: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = (o: string | null) => (
    <QueryClientProvider client={client}>
      {o === null ? null : (
        <PrCommitDetail
          repoPath={REPO}
          number={7}
          commit={commit(o)}
          onBack={() => undefined}
          canCommentCommits={false}
          remoteLabel="GitHub"
          lens="origin"
        />
      )}
    </QueryClientProvider>
  );
  const utils = render(view(oid));
  return {
    ...utils,
    show: (o: string | null) => utils.rerender(view(o)),
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
const expectOpen = (path: string) =>
  waitFor(() => expect(openFile()).toBe(path));
/** Every filter status sits outside every busy element, and there is one. */
const expectOneStatusOutsideBusy = () => {
  const all = document.querySelectorAll("[data-file-filter-status]");
  for (const s of all) expect(s.closest('[aria-busy="true"]')).toBeNull();
  expect(all).toHaveLength(1);
};

beforeEach(() => {
  vi.clearAllMocks();
  unmockedCommands.length = 0;
  useFileFilterStore.setState({ texts: {} });
  lists = {};
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(saveSettingsMerged).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(forgeStatus).mockResolvedValue({
    provider: "github",
    installed: true,
    authenticated: true,
    repo: "octo/repo",
    host: "github.com",
    login: "octo",
    capabilities: ALL_ON,
    implemented: ALL_ON,
  } as unknown as ForgeStatus);
  vi.mocked(forgeCommitComments).mockResolvedValue([]);
  vi.mocked(gitObjectsPresent).mockResolvedValue(false);
  vi.mocked(forgePrCommitDiff).mockImplementation(async (_r, _n, oid) =>
    patch(lists[oid] ?? []),
  );
});

afterEach(() => {
  expect(unmockedCommands).toEqual([]);
});

describe("PrCommitDetail file filter", () => {
  it("C-a C-f: the count lives in the field; typing filters the rows and keeps the pane", async () => {
    lists[A] = ["src/a.ts", "src/b.md", "lib/c.ts"];
    const user = userEvent.setup();
    renderView(A);
    await expectOpen("src/a.ts");
    expect(fieldGroup().textContent).toContain("3 files");
    expect(screen.queryByText(/changed file/)).toBeNull();
    await user.type(field(), "lib");
    expect(rendered()).toEqual(["lib/c.ts"]);
    expect(fieldGroup().textContent).toContain("1 of 3");
    await act(() => Promise.resolve());
    expect(openFile()).toBe("src/a.ts");
    expect(rail().querySelector("[aria-current]")).toBeNull();
  });

  it("C-b: list arrows walk the matches only", async () => {
    lists[A] = LONG;
    const user = userEvent.setup();
    renderView(A);
    await expectOpen("src/file-00.ts");
    await user.type(field(), "5.ts");
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

  it("C-d: another commit's mount keeps the text and opens its first match; Enter notes the interaction", async () => {
    lists[A] = ["a/x.ts", "b/y.md"];
    lists[B] = ["c/one.md", "d/two.ts", "e/three.ts"];
    const user = userEvent.setup();
    const { show } = renderView(A);
    await expectOpen("a/x.ts");
    await user.type(field(), "ts");
    show(null);
    show(B);
    await expectOpen("d/two.ts");
    expect(field().value).toBe("ts");
    expect(rendered()).toEqual(["d/two.ts", "e/three.ts"]);
    await user.click(field());
    const before = useUiStore.getState().interactionEpoch;
    await user.keyboard("{Enter}");
    // Enter's pick goes through the component's own pick helper.
    expect(useUiStore.getState().interactionEpoch).toBeGreaterThan(before);
    expect(document.activeElement?.getAttribute("data-path")).toBe("d/two.ts");
    await expectOpen("d/two.ts");
  });

  it("C-k: an untouched list follows a new first file; a typed filter pins the open file", async () => {
    lists[A] = ["b.ts", "c.ts"];
    const user = userEvent.setup();
    const { refetch } = renderView(A);
    await expectOpen("b.ts");
    lists[A] = ["a.ts", "b.ts", "c.ts"];
    await refetch();
    await expectOpen("a.ts");
    await user.type(field(), "c");
    expect(rendered()).toEqual(["c.ts"]);
    await act(() => Promise.resolve());
    expect(openFile()).toBe("a.ts");
    lists[A] = ["0.ts", "a.ts", "c.ts"];
    await refetch();
    await act(() => Promise.resolve());
    expect(openFile()).toBe("a.ts");
  });

  it("C-h: one status, outside the busy pane, before and after the diff loads", async () => {
    let land: (patchText: string) => void = () => undefined;
    vi.mocked(forgePrCommitDiff).mockImplementationOnce(
      () =>
        new Promise((r) => {
          land = r;
        }),
    );
    const user = userEvent.setup();
    renderView(A);
    await act(() => Promise.resolve());
    expect(screen.queryByRole("complementary")).toBeNull();
    expectOneStatusOutsideBusy();
    await act(async () => land(patch(["a.ts", "slow.ts"])));
    await expectOpen("a.ts");
    expectOneStatusOutsideBusy();
    const slow = rail().querySelector<HTMLElement>('[data-path="slow.ts"]');
    expect(slow).toBeTruthy();
    await user.click(slow as HTMLElement);
    // The held pane is busy until the slow file settles or its bound runs out.
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
    expectOneStatusOutsideBusy();
  });
});
