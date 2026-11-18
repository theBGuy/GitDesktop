import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DetailRail,
  DetailRailFilterStatus,
  DetailRailRow,
} from "@/components/detail-rail";
import {
  type DetailRailFilter,
  fileFilterQuery,
  matchesFileFilter,
  useFileFilterStore,
  useFileListFilter,
} from "@/components/use-file-list-filter";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
  saveSettingsMerged: vi.fn(),
}));

vi.mock("@/lib/use-container-width", () => ({
  useContainerWidth: () => [() => undefined, 900],
}));

type File = { path: string };
const F = (...paths: string[]): File[] => paths.map((path) => ({ path }));
const paths = (files: File[]) => files.map((f) => f.path);

// A list long enough that the first match sits far from the first file.
const LONG = F(
  ...Array.from({ length: 45 }, (_, i) =>
    i === 30
      ? "docs/target-1.md"
      : i === 40
        ? "docs/target-2.md"
        : `src/file-${String(i).padStart(2, "0")}.ts`,
  ),
);

const pinSpy = vi.fn<(path: string, textAtCall: string) => void>();
const textOf = (scope: string) =>
  useFileFilterStore.getState().texts[scope] ?? "";

/** A consumer in miniature: owns its pick, as every wired consumer does. */
function useConsumer({
  scope = "s",
  files,
  settled = true,
}: {
  scope?: string;
  files: File[];
  settled?: boolean;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const filter = useFileListFilter({
    scope,
    files,
    settled,
    picked,
    onPick: (path) => {
      pinSpy(path, textOf(scope));
      setPicked(path);
    },
  });
  return { ...filter, picked, setPicked };
}

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ repoPath: "/repo-a" });
  useFileFilterStore.setState({ texts: {} });
});

afterEach(() => {
  expect(unmockedCommands).toEqual([]);
});

describe("the match rule", () => {
  it("H01 matches a trimmed, case-insensitive substring of the full path", () => {
    const leaves = F("src/a/index.ts", "src/b/index.ts", "test/a/index.ts");
    const mixed = F("README.md", "src/Utils/Path.ts");
    const spaced = F("docs/my notes/read me.md", "docs/notes.md");
    const match = (files: File[], text: string) =>
      paths(
        files.filter((f) => matchesFileFilter(f.path, fileFilterQuery(text))),
      );
    expect(match(leaves, "b/index")).toEqual(["src/b/index.ts"]);
    expect(match(leaves, "index")).toEqual(paths(leaves));
    expect(match(mixed, "readme")).toEqual(["README.md"]);
    expect(match(mixed, "UTILS/p")).toEqual(["src/Utils/Path.ts"]);
    expect(match(spaced, "my notes")).toEqual(["docs/my notes/read me.md"]);
    expect(fileFilterQuery(" notes ")).toBe("notes");
    expect(match(spaced, " notes ")).toEqual(paths(spaced));
    expect(match(spaced, "s/read me")).toEqual(["docs/my notes/read me.md"]);
    expect(fileFilterQuery("   ")).toBe("");

    useFileFilterStore.getState().setText("s", "Utils/P");
    const { result } = renderHook(() => useConsumer({ files: mixed }));
    expect(paths(result.current.visible)).toEqual(["src/Utils/Path.ts"]);
    expect(result.current.rail.active).toBe(true);
    expect(result.current.rail.matchCount).toBe(1);
    expect(result.current.rail.totalCount).toBe(2);
  });

  it("H02 hands back the files array itself while the query is empty", () => {
    const files = F("a.ts", "b.ts");
    useFileFilterStore.getState().setText("s", "   ");
    const { result } = renderHook(() => useConsumer({ files }));
    expect(result.current.visible).toBe(files);
    expect(result.current.rail.active).toBe(false);
    expect(result.current.rail.text).toBe("   ");
  });
});

describe("the open path", () => {
  it("H03 pins the open path before the first edit, and never over a valid pick", () => {
    const files = F("a.ts", "b.ts", "c.ts");
    const { result } = renderHook(() => useConsumer({ files }));
    expect(result.current.openPath).toBe("a.ts");
    act(() => result.current.rail.setText("c"));
    // Once, with the store still holding the old text: the pin came first.
    expect(pinSpy.mock.calls).toEqual([["a.ts", ""]]);
    expect(result.current.openPath).toBe("a.ts");
    expect(result.current.picked).toBe("a.ts");
    expect(paths(result.current.visible)).toEqual(["c.ts"]);
    expect(result.current.activeIndex).toBe(-1);
    expect(result.current.rail.openRowPath).toBeNull();
    expect(result.current.rail.firstPath).toBe("c.ts");

    // A valid pick is already the open path: no further pin.
    pinSpy.mockClear();
    act(() => result.current.rail.setText(""));
    expect(pinSpy).not.toHaveBeenCalled();
  });

  it("H03 pins a first-match default when the text is cleared", () => {
    useFileFilterStore.getState().setText("s", "b");
    const { result } = renderHook(() =>
      useConsumer({ files: F("a.ts", "b.ts", "c.ts") }),
    );
    expect(result.current.openPath).toBe("b.ts");
    act(() => result.current.rail.setText(""));
    expect(pinSpy.mock.calls).toEqual([["b.ts", "b"]]);
    expect(result.current.openPath).toBe("b.ts");
    expect(textOf("s")).toBe("");
  });

  it("H04 opens the first match under a persisted text, else the first file", () => {
    useFileFilterStore.getState().setText("s", "target");
    const { result } = renderHook(() => useConsumer({ files: LONG }));
    expect(result.current.openPath).toBe("docs/target-1.md");
    expect(paths(result.current.visible)).toEqual([
      "docs/target-1.md",
      "docs/target-2.md",
    ]);
    expect(result.current.activeIndex).toBe(0);
    expect(result.current.rail.openRowPath).toBe("docs/target-1.md");

    act(() => useFileFilterStore.getState().setText("s", "zzz"));
    expect(result.current.visible).toEqual([]);
    expect(result.current.openPath).toBe("src/file-00.ts");
    expect(result.current.rail.firstPath).toBeNull();
    expect(pinSpy).not.toHaveBeenCalled();
  });

  it("H05 derives as today on an unsettled list and pins nothing there", () => {
    useFileFilterStore.getState().setText("s", "target");
    // The placeholder: the previous identity's rows, whose first file also
    // exists in the list that settles.
    const placeholder = F("src/file-00.ts", "docs/target-0.md");
    const { result, rerender } = renderHook(
      (props: { files: File[]; settled: boolean }) => useConsumer(props),
      { initialProps: { files: placeholder, settled: false } },
    );
    expect(result.current.openPath).toBe("src/file-00.ts");
    act(() => result.current.rail.setText("targ"));
    expect(pinSpy).not.toHaveBeenCalled();
    expect(result.current.openPath).toBe("src/file-00.ts");
    expect(result.current.rail.settled).toBe(false);

    rerender({ files: LONG, settled: true });
    expect(result.current.openPath).toBe("docs/target-1.md");
    expect(result.current.rail.settled).toBe(true);
  });

  it("H06 follows a new first file while untouched, and drops a pick that left the list", () => {
    const { result, rerender } = renderHook(
      (props: { files: File[] }) => useConsumer(props),
      { initialProps: { files: F("b.ts", "c.ts") } },
    );
    expect(result.current.openPath).toBe("b.ts");
    rerender({ files: F("a.ts", "b.ts", "c.ts") });
    expect(result.current.openPath).toBe("a.ts");
    expect(pinSpy).not.toHaveBeenCalled();

    rerender({ files: F("x1", "y", "x2") });
    act(() => result.current.setPicked("x2"));
    act(() => useFileFilterStore.getState().setText("s", "x"));
    expect(result.current.openPath).toBe("x2");
    rerender({ files: F("x1", "y") });
    expect(result.current.openPath).toBe("x1");
    expect(result.current.activeIndex).toBe(0);
  });

  it("H09 a repo-switch clear pins nothing", () => {
    useFileFilterStore.getState().setText("s", "b");
    const { result } = renderHook(() =>
      useConsumer({ files: F("a.ts", "b.ts") }),
    );
    expect(result.current.openPath).toBe("b.ts");
    act(() => useUiStore.setState({ repoPath: "/repo-b" }));
    expect(result.current.rail.text).toBe("");
    expect(pinSpy).not.toHaveBeenCalled();
    expect(result.current.picked).toBeNull();
  });
});

describe("the text store", () => {
  it("H08 keeps one text per scope, across a remount, until the repo changes", () => {
    const one = renderHook(() =>
      useConsumer({ scope: "one", files: F("a.ts") }),
    );
    const two = renderHook(() =>
      useConsumer({ scope: "two", files: F("a.ts") }),
    );
    expect(one.result.current.rail.scope).toBe("one");
    expect(two.result.current.rail.scope).toBe("two");
    act(() => one.result.current.rail.setText("a"));
    expect(one.result.current.rail.text).toBe("a");
    expect(two.result.current.rail.text).toBe("");

    one.unmount();
    const again = renderHook(() =>
      useConsumer({ scope: "one", files: F("a.ts") }),
    );
    expect(again.result.current.rail.text).toBe("a");

    act(() => two.result.current.rail.setText("b"));
    act(() => useUiStore.setState({ repoPath: "/repo-b" }));
    expect(useFileFilterStore.getState().texts).toEqual({});
    expect(again.result.current.rail.text).toBe("");
    expect(two.result.current.rail.text).toBe("");
  });
});

// The host-owned shape: a parent owns the pick and its reset and calls the
// hook; a presentational child renders the rail from plain props.
function RailChild({
  rail,
  visible,
  openPath,
}: {
  rail: DetailRailFilter;
  visible: File[];
  openPath: string | null;
}) {
  return (
    <>
      <DetailRailFilterStatus filter={rail} />
      <DetailRailRow>
        <DetailRail ariaLabel="Changed files" role="listbox" filter={rail}>
          {visible.map((f) => (
            <div
              key={f.path}
              role="option"
              aria-selected={f.path === openPath}
              data-path={f.path}
              tabIndex={-1}
            />
          ))}
        </DetailRail>
        <main data-open-file={openPath ?? ""} />
      </DetailRailRow>
    </>
  );
}

function Host({ identity, files }: { identity: string; files: File[] }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [pickedFor, setPickedFor] = useState(identity);
  if (pickedFor !== identity) {
    setPickedFor(identity);
    setPicked(null);
  }
  const filter = useFileListFilter({
    scope: "host-owned",
    files,
    settled: true,
    picked,
    onPick: setPicked,
  });
  return (
    <RailChild
      rail={filter.rail}
      visible={filter.visible}
      openPath={filter.openPath}
    />
  );
}

describe("a host-owned selection", () => {
  it("H07 drives a presentational rail through props alone", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
    vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
    const user = userEvent.setup();
    const ui = (identity: string, files: File[]) => (
      <QueryClientProvider client={client}>
        <Host identity={identity} files={files} />
      </QueryClientProvider>
    );
    const { container, rerender } = render(ui("one", F("a.ts", "b.ts")));
    const open = () =>
      container.querySelector("main")?.getAttribute("data-open-file");
    expect(open()).toBe("a.ts");

    await user.type(
      screen.getByRole("textbox", { name: "Filter changed files" }),
      "b",
    );
    expect(open()).toBe("a.ts");
    expect(screen.getAllByRole("option").map((o) => o.dataset.path)).toEqual([
      "b.ts",
    ]);

    rerender(ui("two", F("a.ts", "c.ts", "b.ts")));
    expect(open()).toBe("b.ts");
  });
});
