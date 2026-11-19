import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DetailRail,
  DetailRailFilterStatus,
  DetailRailRow,
} from "@/components/detail-rail";
import { PanelActivityBoundary } from "@/components/panel-portal";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  useFileFilterStore,
  useFileListFilter,
} from "@/components/use-file-list-filter";
import { getAvailableSnapshot } from "@/lib/hotkeys/handler-registry";
import { dispatchAction, useHotkeysListener } from "@/lib/hotkeys/hotkeys";
import { focusInOpenModal } from "@/lib/hotkeys/open-modal";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import {
  type AppSettings,
  loadSettings,
  saveSettingsMerged,
} from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
  saveSettingsMerged: vi.fn(),
}));

/** The width every measured row reports; null = not yet measured. */
const pane = vi.hoisted(() => ({ width: 900 as number | null }));
vi.mock("@/lib/use-container-width", () => ({
  useContainerWidth: () => [() => undefined, pane.width],
}));

// jsdom has no scrollIntoView; the spy is also the AC-12 observable.
const scrollSpy = vi.fn();
Element.prototype.scrollIntoView = scrollSpy;

type File = { path: string };
const F = (...paths: string[]): File[] => paths.map((path) => ({ path }));

const THIRTEEN = F(
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
);
const LONG = F(
  ...Array.from({ length: 42 }, (_, i) =>
    i === 30
      ? "src/[id]/page.tsx"
      : i === 36
        ? 'docs/say "hi".md'
        : `src/file-${String(i).padStart(2, "0")}.ts`,
  ),
);

const pickSpy = vi.fn<(path: string) => void>();
const parentKeys = vi.fn<(key: string) => void>();
let stored: AppSettings = DEFAULT_SETTINGS;

function Listener() {
  useHotkeysListener();
  return null;
}

interface HarnessProps {
  files: File[];
  settled?: boolean;
  claim?: boolean;
  withFilter?: boolean;
  identity?: string;
  listener?: boolean;
  panelActive?: boolean;
  portal?: boolean;
  /** Renders a diff control that consumes every K keydown itself. */
  consumer?: boolean;
  /** Renders a row action in the list whose press opens a portalled dialog. */
  rowDialog?: boolean;
  /** Renders an open modal dialog over the tab, holding a button. */
  modal?: boolean;
}

/** A row action owning its dialog's open state, as FileRowActions does. */
function RowDialog() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Row action
      </button>
      {open
        ? createPortal(
            <button type="button">Dialog action</button>,
            document.body,
          )
        : null}
    </>
  );
}

/** A consumer in miniature: owns its pick and its reset, renders the rows from
 *  `visible`, and drives `listKeyboardNav` from the same list. */
function Harness({
  files,
  settled = true,
  claim = false,
  withFilter = true,
  identity = "one",
  listener = false,
  panelActive = true,
  portal = false,
  consumer = false,
  rowDialog = false,
  modal = false,
}: HarnessProps) {
  const [picked, setPicked] = useState<string | null>(null);
  const [pickedFor, setPickedFor] = useState(identity);
  if (pickedFor !== identity) {
    setPickedFor(identity);
    setPicked(null);
  }
  const pick = (path: string) => {
    pickSpy(path);
    setPicked(path);
  };
  const filter = useFileListFilter({
    scope: "rail",
    claimFocusFilter: claim,
    files,
    settled,
    picked,
    onPick: pick,
  });
  const rows = withFilter ? filter.visible : files;
  const nav = listKeyboardNav({
    items: rows,
    activeIndex: withFilter ? filter.activeIndex : -1,
    onActivate: (f) => pick(f.path),
    rowKey: (f) => f.path,
    rowAttr: "data-path",
  });
  return (
    <PanelActivityBoundary active={panelActive}>
      {listener ? <Listener /> : null}
      <div role="group" onKeyDown={(e) => parentKeys(e.key)}>
        <button type="button">Outside</button>
        {withFilter ? <DetailRailFilterStatus filter={filter.rail} /> : null}
        <div aria-busy={!settled}>
          <DetailRailRow>
            <DetailRail
              ariaLabel="Changed files"
              role="listbox"
              filter={withFilter ? filter.rail : undefined}
              header={withFilter ? undefined : <span>Header count</span>}
            >
              <div role="group" data-rows="" onKeyDown={nav}>
                {rows.map((f) => (
                  <button
                    key={f.path}
                    type="button"
                    tabIndex={-1}
                    data-path={f.path}
                    aria-current={
                      f.path === filter.openPath ? "true" : undefined
                    }
                    onClick={() => pick(f.path)}
                  >
                    {f.path}
                  </button>
                ))}
              </div>
              {rowDialog ? <RowDialog /> : null}
            </DetailRail>
            <main data-open-file={filter.openPath ?? ""}>
              <p>Plain diff text, a sentence.</p>
              <button type="button">Diff action</button>
              <textarea aria-label="Line comment" />
              {consumer ? (
                <button
                  type="button"
                  onKeyDown={(e) => {
                    if (e.key.toLowerCase() === "k") e.preventDefault();
                  }}
                >
                  Composer
                </button>
              ) : null}
              {portal
                ? createPortal(
                    <button type="button">Portalled</button>,
                    document.body,
                  )
                : null}
            </main>
          </DetailRailRow>
        </div>
      </div>
      {modal ? (
        <Dialog open>
          <DialogContent>
            <DialogTitle>Create tag</DialogTitle>
            <button type="button">Dialog button</button>
          </DialogContent>
        </Dialog>
      ) : null}
    </PanelActivityBoundary>
  );
}

function renderRail(props: HarnessProps, { loaded = true } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (loaded) client.setQueryData(settingsKeys.settings, stored);
  const ui = (p: HarnessProps) => (
    <QueryClientProvider client={client}>
      <Harness {...p} />
    </QueryClientProvider>
  );
  const utils = render(ui(props));
  return {
    client,
    ...utils,
    rerenderWith: (p: HarnessProps) => utils.rerender(ui(p)),
  };
}

const field = () =>
  screen.getByRole<HTMLInputElement>("textbox", {
    name: "Filter changed files",
  });
const queryField = () =>
  screen.queryByRole("textbox", { name: "Filter changed files" });
const row = (path: string) =>
  document.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
const rendered = () =>
  Array.from(
    document.querySelectorAll<HTMLElement>("[data-rows] [data-path]"),
    (el) => el.dataset.path,
  );
const openFile = () =>
  document.querySelector("main")?.getAttribute("data-open-file");
const status = () =>
  document.querySelector<HTMLElement>("[data-file-filter-status]");
const fieldClear = () =>
  within(
    field().closest<HTMLElement>('[data-slot="input-group"]') as HTMLElement,
  ).getByRole("button", { name: "Clear filter" });
const emptyStateClear = () =>
  within(
    screen.getByText("No files match the filter").parentElement as HTMLElement,
  ).getByRole("button", { name: "Clear filter" });
const caret = (name: "Expand file list" | "Collapse file list") =>
  screen.getByRole("button", { name });
const focusOn = (el: HTMLElement | null) => act(() => el?.focus());
const toBody = () =>
  act(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });

// A capture listener keeps each event and reads `defaultPrevented` once the
// dispatch is over: it sees an event a handler stopped, and whatever the
// window listener did after it.
let seen: KeyboardEvent[] = [];
const onWindowKey = (e: KeyboardEvent) => {
  seen.push(e);
};
const watchKeys = () => window.addEventListener("keydown", onWindowKey, true);
const lastPrevented = (key: string) =>
  seen.filter((e) => e.key === key).at(-1)?.defaultPrevented;
const MOD_F = "{Control>}f{/Control}";

beforeEach(() => {
  vi.clearAllMocks();
  stored = DEFAULT_SETTINGS;
  vi.mocked(loadSettings).mockImplementation(async () => stored);
  vi.mocked(saveSettingsMerged).mockImplementation(async (settings) => {
    stored = { ...stored, ...settings };
    return stored;
  });
  pane.width = 900;
  seen = [];
  useUiStore.setState({ repoPath: "/repo-a" });
  useFileFilterStore.setState({ texts: {} });
});

afterEach(() => {
  window.removeEventListener("keydown", onWindowKey, true);
  expect(unmockedCommands).toEqual([]);
});

describe("layout and copy", () => {
  it("R01 leaves a rail without a filter exactly as it was", async () => {
    const user = userEvent.setup();
    const { container } = renderRail({ files: THIRTEEN, withFilter: false });
    watchKeys();
    const strip = caret("Collapse file list").parentElement as HTMLElement;
    expect(strip.className).toBe(
      "flex h-7 shrink-0 items-center justify-end gap-2 border-b px-0.5",
    );
    expect(screen.getByText("Header count")).toBeTruthy();
    expect(queryField()).toBeNull();
    const rowDiv = container.querySelector("aside")
      ?.parentElement as HTMLElement;
    expect(rowDiv.className).toBe("flex min-h-0 flex-1");
    expect(rowDiv.hasAttribute("tabindex")).toBe(false);
    expect(document.querySelector("[data-file-filter-status]")).toBeNull();

    await focusOn(row("src/beta.ts"));
    await user.keyboard(MOD_F);
    expect(lastPrevented("f")).toBe(false);

    await user.click(caret("Collapse file list"));
    await waitFor(() => caret("Expand file list"));
    expect(
      (caret("Expand file list").parentElement as HTMLElement).className,
    ).toBe("flex h-7 shrink-0 items-center");
    expect(
      screen.queryByRole("button", { name: /Show the file list/ }),
    ).toBeNull();
  });

  it("R02 names the field and counts against the total", async () => {
    const user = userEvent.setup();
    const { unmount } = renderRail({ files: THIRTEEN });
    expect(field().placeholder).toBe("Filter");
    expect(screen.getByText("13 files")).toBeTruthy();
    const group = field().closest('[data-slot="input-group"]') as HTMLElement;
    expect(group.classList.contains("h-7")).toBe(true);
    expect(field().classList.contains("h-full")).toBe(true);
    expect(field().classList.contains("pl-[7px]")).toBe(true);
    // AC-2: the path row's box, and the caret after the field in the strip.
    const strip = caret("Collapse file list").parentElement as HTMLElement;
    for (const c of ["border-b", "py-1.5", "pl-1", "pr-0.5", "gap-1"])
      expect(strip.classList.contains(c)).toBe(true);
    expect(strip.classList.contains("h-7")).toBe(false);
    expect(strip.firstElementChild).toBe(group);
    await user.type(field(), "alpha");
    expect(screen.getByText("2 of 13")).toBeTruthy();
    await user.type(field(), "zzz");
    expect(screen.getByText("0 of 13")).toBeTruthy();
    unmount();

    useFileFilterStore.setState({ texts: {} });
    const one = renderRail({ files: F("src/only.ts") });
    expect(screen.getByText("1 file")).toBeTruthy();
    one.unmount();
    const none = renderRail({ files: [] });
    expect(screen.getByText("0 files")).toBeTruthy();
    none.unmount();

    useFileFilterStore.getState().setText("rail", "zzz");
    stored = { ...DEFAULT_SETTINGS, diffFileListCollapsed: true };
    renderRail({ files: F("src/only.ts") });
    const box = caret("Expand file list").parentElement as HTMLElement;
    expect(box.className).toBe("flex h-7 shrink-0 items-center");
    expect(box.parentElement?.classList.contains("py-1.5")).toBe(true);
    expect(
      screen.getByRole("button", {
        name: "Show the file list (filter applied: 0 of 1 file)",
      }).title,
    ).toBe("Show the file list (filter applied: 0 of 1 file)");
  });

  it("R03 keeps the field outside the list role and hides, never unmounts, the list", async () => {
    const user = userEvent.setup();
    renderRail({ files: THIRTEEN });
    expect(field().closest('[role="listbox"]')).toBeNull();
    const listBefore = screen.getByRole("listbox", { name: "Changed files" });
    const rowsBefore = listBefore.querySelector("[data-rows]");
    await user.type(field(), "zzz");
    expect(screen.getByText("No files match the filter")).toBeTruthy();
    const list = screen.getByRole("listbox", { name: "Changed files" });
    expect(list.classList.contains("hidden")).toBe(true);
    expect(list.querySelector("[data-rows]")).not.toBeNull();
    expect(list).toBe(listBefore);
    expect(list.querySelector("[data-rows]")).toBe(rowsBefore);
    expect(openFile()).toBe("src/alpha.ts");
  });
});

describe("field keys", () => {
  it("R04 Enter picks and focuses the first match, and stands down otherwise", async () => {
    const user = userEvent.setup();
    renderRail({ files: LONG });
    await user.type(field(), "page");
    pickSpy.mockClear();
    await user.keyboard("{Enter}");
    expect(pickSpy.mock.calls).toEqual([["src/[id]/page.tsx"]]);
    expect(document.activeElement).toBe(row("src/[id]/page.tsx"));
    expect(openFile()).toBe("src/[id]/page.tsx");

    await user.clear(field());
    await user.type(field(), '"hi');
    pickSpy.mockClear();
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(pickSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field());
    await user.keyboard("{Enter}");
    expect(pickSpy.mock.calls).toEqual([['docs/say "hi".md']]);
    expect(document.activeElement).toBe(row('docs/say "hi".md'));

    await user.type(field(), "zzz");
    pickSpy.mockClear();
    await user.keyboard("{Enter}");
    expect(pickSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field());
  });

  it("R05 Arrow Down enters the list, and the list walks rendered rows only", async () => {
    const user = userEvent.setup();
    renderRail({ files: LONG });
    await user.click(row("src/file-05.ts") as HTMLElement);
    await user.type(field(), "file-0");
    pickSpy.mockClear();
    await user.keyboard("{ArrowDown}");
    expect(pickSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(row("src/file-05.ts"));

    await user.clear(field());
    await user.type(field(), "[[");
    expect(rendered()).toEqual(["src/[id]/page.tsx"]);
    await user.clear(field());
    await user.type(field(), "file-3");
    expect(rendered()).toEqual([
      "src/file-31.ts",
      "src/file-32.ts",
      "src/file-33.ts",
      "src/file-34.ts",
      "src/file-35.ts",
      "src/file-37.ts",
      "src/file-38.ts",
      "src/file-39.ts",
    ]);
    pickSpy.mockClear();
    await user.keyboard("{ArrowDown}");
    expect(pickSpy.mock.calls).toEqual([["src/file-31.ts"]]);
    expect(document.activeElement).toBe(row("src/file-31.ts"));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(row("src/file-32.ts"));
    await user.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}");
    expect(document.activeElement).toBe(row("src/file-31.ts"));
    expect(pickSpy.mock.calls.at(-1)).toEqual(["src/file-31.ts"]);

    await user.click(field());
    await user.type(field(), "zzz");
    pickSpy.mockClear();
    await user.keyboard("{ArrowDown}");
    expect(pickSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field());
  });

  it("R06 Escape clears and stays put; an empty field leaves Escape alone", async () => {
    const user = userEvent.setup();
    renderRail({ files: THIRTEEN });
    watchKeys();
    await user.type(field(), "abc");
    parentKeys.mockClear();
    await user.keyboard("{Escape}");
    expect(field().value).toBe("");
    expect(document.activeElement).toBe(field());
    expect(parentKeys.mock.calls.flat()).not.toContain("Escape");
    expect(lastPrevented("Escape")).toBe(true);

    await user.keyboard("{Escape}");
    expect(parentKeys.mock.calls.flat()).toContain("Escape");
    expect(lastPrevented("Escape")).toBe(false);

    await user.type(field(), "alpha");
    fireEvent.keyDown(field(), { key: "Escape", isComposing: true });
    expect(field().value).toBe("alpha");

    pickSpy.mockClear();
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(pickSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field());
  });

  it("R06b Arrow Down while composing stays in the field", async () => {
    const user = userEvent.setup();
    renderRail({ files: THIRTEEN });
    watchKeys();
    await user.type(field(), "alpha");
    expect(rendered()).toContain("src/alpha.ts");
    pickSpy.mockClear();
    fireEvent.keyDown(field(), { key: "ArrowDown", isComposing: true });
    expect(lastPrevented("ArrowDown")).toBe(false);
    expect(pickSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field());
  });

  it("R04b Enter while composing stays in the field over a match", async () => {
    const user = userEvent.setup();
    renderRail({ files: THIRTEEN });
    watchKeys();
    await user.type(field(), "alpha");
    expect(rendered()).toContain("src/alpha.ts");
    pickSpy.mockClear();
    fireEvent.keyDown(field(), { key: "Enter", isComposing: true });
    expect(lastPrevented("Enter")).toBe(false);
    expect(pickSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field());
  });

  it("R04c Enter and Arrow Down pick nothing from an unsettled list", async () => {
    const user = userEvent.setup();
    const { rerenderWith } = renderRail({ files: THIRTEEN, settled: false });
    watchKeys();
    await user.type(field(), "beta");
    expect(rendered()).toEqual(["src/beta.ts"]);
    pickSpy.mockClear();
    await user.keyboard("{Enter}");
    expect(lastPrevented("Enter")).toBe(false);
    await user.keyboard("{ArrowDown}");
    expect(lastPrevented("ArrowDown")).toBe(false);
    expect(pickSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field());

    // The open row is rendered: Arrow Down still moves onto it, picking nothing.
    await user.clear(field());
    await user.type(field(), "alpha");
    pickSpy.mockClear();
    await user.keyboard("{ArrowDown}");
    expect(pickSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(row("src/alpha.ts"));

    rerenderWith({ files: THIRTEEN, settled: true });
    await user.click(field());
    await user.clear(field());
    await user.type(field(), "beta");
    pickSpy.mockClear();
    await user.keyboard("{Enter}");
    expect(pickSpy.mock.calls).toEqual([["src/beta.ts"]]);
    expect(document.activeElement).toBe(row("src/beta.ts"));
  });
});

describe("clearing", () => {
  it("R07 every clear scrolls the open row into view; the x and Clear filter refocus the field", async () => {
    const user = userEvent.setup();
    const { rerenderWith } = renderRail({ files: THIRTEEN });
    expect(scrollSpy).not.toHaveBeenCalled();
    rerenderWith({ files: [...THIRTEEN, ...F("z/new.ts")] });
    expect(scrollSpy).not.toHaveBeenCalled();

    const scrolledOpenRow = () => {
      expect(scrollSpy).toHaveBeenCalledTimes(1);
      expect(scrollSpy.mock.calls[0]).toEqual([{ block: "nearest" }]);
      expect(scrollSpy.mock.contexts[0]).toBe(row("src/alpha.ts"));
      scrollSpy.mockClear();
    };

    await user.type(field(), "beta");
    await user.click(fieldClear());
    expect(document.activeElement).toBe(field());
    expect(field().value).toBe("");
    scrolledOpenRow();

    await user.type(field(), "zzz");
    await user.click(emptyStateClear());
    expect(document.activeElement).toBe(field());
    scrolledOpenRow();

    await user.type(field(), "mu");
    await user.keyboard("{Escape}");
    scrolledOpenRow();
    expect(document.activeElement).toBe(field());

    await user.type(field(), "q");
    await user.keyboard("{Backspace}");
    scrolledOpenRow();
    expect(document.activeElement).toBe(field());

    await user.type(field(), "eta");
    const outside = screen.getByRole("button", { name: "Outside" });
    act(() => outside.focus());
    act(() => useUiStore.setState({ repoPath: "/repo-b" }));
    expect(field().value).toBe("");
    scrolledOpenRow();
    expect(openFile()).toBe("src/alpha.ts");
    expect(document.activeElement).toBe(outside);
  });
});

describe("the status", () => {
  it("R08 announces filtering, and holds a clear's text while the settled total is unchanged", async () => {
    const user = userEvent.setup();
    const { rerenderWith } = renderRail({ files: THIRTEEN });
    expect(status()?.textContent).toBe("");
    await user.type(field(), "alpha");
    expect(status()?.textContent).toBe("Showing 2 of 13 files");
    const fourteen = [...THIRTEEN, ...F("z/alpha-3.ts")];
    rerenderWith({ files: fourteen });
    expect(status()?.textContent).toBe("Showing 3 of 14 files");
    await user.click(fieldClear());
    expect(status()?.textContent).toBe("Showing all 14 files");
    rerenderWith({ files: [...fourteen] });
    expect(status()?.textContent).toBe("Showing all 14 files");
    rerenderWith({ files: THIRTEEN });
    expect(status()?.textContent).toBe("");
  });

  it("R08b drops a clear's text once the settled total changes, and keeps it otherwise", async () => {
    const user = userEvent.setup();
    const twelve = THIRTEEN.slice(0, 12);
    const { rerenderWith } = renderRail({ files: THIRTEEN });
    await user.type(field(), "alpha");
    await user.click(fieldClear());
    expect(status()?.textContent).toBe("Showing all 13 files");
    rerenderWith({ files: [...THIRTEEN] });
    expect(status()?.textContent).toBe("Showing all 13 files");
    rerenderWith({ files: twelve });
    expect(status()?.textContent).toBe("");
    rerenderWith({ files: [...twelve] });
    expect(status()?.textContent).toBe("");
    await user.type(field(), "alpha");
    expect(status()?.textContent).toBe("Showing 2 of 12 files");
  });

  it("R08c an unsettled list of another size leaves a clear's text until it settles", async () => {
    const user = userEvent.setup();
    const { rerenderWith } = renderRail({ files: THIRTEEN });
    await user.type(field(), "alpha");
    await user.click(fieldClear());
    expect(status()?.textContent).toBe("Showing all 13 files");
    const placeholder = F("p/one.ts", "p/two.ts", "p/three.ts");
    rerenderWith({ files: placeholder, settled: false, identity: "two" });
    expect(status()?.textContent).toBe("Showing all 13 files");
    rerenderWith({ files: placeholder, settled: true, identity: "two" });
    expect(status()?.textContent).toBe("");
  });

  it("R08 holds its text while the list is unsettled, outside the busy region", async () => {
    const user = userEvent.setup();
    const { rerenderWith } = renderRail({ files: THIRTEEN });
    await user.type(field(), "alpha");
    const placeholder = F(
      "p/alpha.ts",
      "p/one.ts",
      "p/two.ts",
      "p/three.ts",
      "p/four.ts",
    );
    rerenderWith({ files: placeholder, settled: false, identity: "two" });
    expect(status()?.textContent).toBe("Showing 2 of 13 files");
    await user.type(field(), "x");
    expect(status()?.textContent).toBe("Showing 2 of 13 files");
    await user.clear(field());
    await user.type(field(), "alpha");
    rerenderWith({ files: placeholder, settled: true, identity: "two" });
    expect(status()?.textContent).toBe("Showing 1 of 5 files");
  });

  it("R08 stays empty over a zero-file list, and speaks of one file", async () => {
    const user = userEvent.setup();
    useFileFilterStore.getState().setText("rail", "alpha");
    const none = renderRail({ files: [] });
    expect(status()?.textContent).toBe("");
    none.unmount();

    useFileFilterStore.setState({ texts: {} });
    renderRail({ files: F("src/only.ts") });
    await user.type(field(), "zzz");
    expect(status()?.textContent).toBe("Showing 0 of 1 file");
    await user.click(fieldClear());
    expect(status()?.textContent).toBe("Showing 1 file");
  });
});

describe("collapsed", () => {
  it("R09 shows the funnel only under an active filter; it expands to the field", async () => {
    const user = userEvent.setup();
    stored = { ...DEFAULT_SETTINGS, diffFileListCollapsed: true };
    const plain = renderRail({ files: THIRTEEN });
    expect(caret("Expand file list")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Show the file list/ }),
    ).toBeNull();
    plain.unmount();

    useFileFilterStore.getState().setText("rail", "alpha");
    renderRail({ files: THIRTEEN });
    const funnel = screen.getByRole("button", {
      name: "Show the file list (filter applied: 2 of 13 files)",
    });
    await user.click(funnel);
    await waitFor(() => expect(document.activeElement).toBe(field()));
    expect(vi.mocked(saveSettingsMerged)).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(saveSettingsMerged).mock.calls[0][0].diffFileListCollapsed,
    ).toBe(false);
  });

  it("R09 a narrow row's funnel expands without a write", async () => {
    const user = userEvent.setup();
    pane.width = 400;
    useFileFilterStore.getState().setText("rail", "alpha");
    renderRail({ files: THIRTEEN });
    await user.click(
      screen.getByRole("button", { name: /Show the file list/ }),
    );
    await waitFor(() => expect(document.activeElement).toBe(field()));
    expect(saveSettingsMerged).not.toHaveBeenCalled();
  });
});

describe("the focus-filter shortcut", () => {
  it("R10 answers from anywhere in the row, the diff's plain text included", async () => {
    const user = userEvent.setup();
    renderRail({ files: THIRTEEN });
    watchKeys();
    const from = async (el: HTMLElement | null) => {
      await focusOn(el);
      await user.keyboard(MOD_F);
      expect(document.activeElement).toBe(field());
      expect(lastPrevented("f")).toBe(true);
    };
    await from(row("src/beta.ts"));
    await from(caret("Collapse file list"));
    await from(screen.getByRole("button", { name: "Diff action" }));
    await from(screen.getByRole("textbox", { name: "Line comment" }));

    await user.click(screen.getByText("Plain diff text, a sentence."));
    expect(document.activeElement).not.toBe(document.body);
    await user.keyboard(MOD_F);
    expect(document.activeElement).toBe(field());

    await user.type(field(), "abc");
    await user.keyboard(MOD_F);
    expect([field().selectionStart, field().selectionEnd]).toEqual([0, 3]);
  });

  it("R10 expands a collapsed rail first", async () => {
    const user = userEvent.setup();
    stored = { ...DEFAULT_SETTINGS, diffFileListCollapsed: true };
    renderRail({ files: THIRTEEN });
    await focusOn(screen.getByRole("button", { name: "Diff action" }));
    await user.keyboard(MOD_F);
    await waitFor(() => expect(document.activeElement).toBe(field()));
  });

  it("R10c a focus move made before the expanding commit keeps focus", async () => {
    stored = { ...DEFAULT_SETTINGS, diffFileListCollapsed: true };
    renderRail({ files: THIRTEEN, claim: true });
    const diffButton = screen.getByRole("button", { name: "Diff action" });
    const outside = screen.getByRole("button", { name: "Outside" });
    await focusOn(diffButton);
    // A synchronous press: the settings re-render lands a timer task later.
    act(() => {
      dispatchAction("focus-filter");
    });
    expect(caret("Expand file list")).toBeTruthy();
    act(() => outside.focus());
    await waitFor(() => expect(caret("Collapse file list")).toBeTruthy());
    expect(document.activeElement).toBe(outside);
    expect(document.activeElement).not.toBe(field());
  });

  it("R10d a press from the collapsed caret ends on the field", async () => {
    const user = userEvent.setup();
    stored = { ...DEFAULT_SETTINGS, diffFileListCollapsed: true };
    renderRail({ files: THIRTEEN });
    await focusOn(caret("Expand file list"));
    await user.keyboard(MOD_F);
    await waitFor(() => expect(document.activeElement).toBe(field()));
  });

  it("R10e a press from the collapsed caret selects the stored text", async () => {
    const user = userEvent.setup();
    stored = { ...DEFAULT_SETTINGS, diffFileListCollapsed: true };
    useFileFilterStore.getState().setText("rail", "alpha");
    renderRail({ files: THIRTEEN });
    await focusOn(caret("Expand file list"));
    await user.keyboard(MOD_F);
    await waitFor(() => expect(document.activeElement).toBe(field()));
    expect([field().selectionStart, field().selectionEnd]).toEqual([0, 5]);
  });

  it("R10 follows a rebound binding and goes inert when cleared", async () => {
    const user = userEvent.setup();
    stored = {
      ...DEFAULT_SETTINGS,
      hotkeys: { "focus-filter": "mod+shift+k" },
    } as AppSettings;
    const rebound = renderRail({ files: THIRTEEN });
    watchKeys();
    await focusOn(row("src/beta.ts"));
    await user.keyboard(MOD_F);
    expect(lastPrevented("f")).toBe(false);
    expect(document.activeElement).toBe(row("src/beta.ts"));
    await user.keyboard("{Control>}{Shift>}k{/Shift}{/Control}");
    expect(document.activeElement).toBe(field());
    rebound.unmount();

    stored = {
      ...DEFAULT_SETTINGS,
      hotkeys: { "focus-filter": null },
    } as AppSettings;
    renderRail({ files: THIRTEEN });
    await focusOn(row("src/beta.ts"));
    await user.keyboard(MOD_F);
    expect(lastPrevented("f")).toBe(false);
    expect(document.activeElement).toBe(row("src/beta.ts"));
  });

  it("R10f answers a shared chord only when the filter is its first holder", async () => {
    const user = userEvent.setup();
    const CHORD = "{Control>}{Shift>}k{/Shift}{/Control}";
    // command-palette comes before focus-filter in ACTIONS: it owns the chord.
    stored = {
      ...DEFAULT_SETTINGS,
      hotkeys: {
        "command-palette": "mod+shift+k",
        "focus-filter": "mod+shift+k",
      },
    } as AppSettings;
    const before = renderRail({ files: THIRTEEN });
    watchKeys();
    await focusOn(row("src/beta.ts"));
    await user.keyboard(CHORD);
    expect(lastPrevented("k")).toBe(false);
    expect(document.activeElement).toBe(row("src/beta.ts"));
    before.unmount();

    // focus-comment comes after focus-filter: the filter owns the chord.
    stored = {
      ...DEFAULT_SETTINGS,
      hotkeys: {
        "focus-comment": "mod+shift+k",
        "focus-filter": "mod+shift+k",
      },
    } as AppSettings;
    renderRail({ files: THIRTEEN });
    await focusOn(row("src/beta.ts"));
    await user.keyboard(CHORD);
    expect(lastPrevented("k")).toBe(true);
    expect(document.activeElement).toBe(field());
  });

  it("R11 ignores a portalled node and focus outside the row", async () => {
    const user = userEvent.setup();
    renderRail({ files: THIRTEEN, portal: true });
    watchKeys();
    await focusOn(screen.getByRole("button", { name: "Portalled" }));
    await user.keyboard(MOD_F);
    expect(lastPrevented("f")).toBe(false);
    expect(document.activeElement).not.toBe(field());

    await focusOn(screen.getByRole("button", { name: "Outside" }));
    await user.keyboard(MOD_F);
    expect(lastPrevented("f")).toBe(false);
    expect(document.activeElement).not.toBe(field());
  });

  it("R12 a claiming mount answers from <body>, expanded", async () => {
    const user = userEvent.setup();
    renderRail({ files: THIRTEEN, claim: true, listener: true });
    watchKeys();
    await toBody();
    await user.keyboard(MOD_F);
    expect(document.activeElement).toBe(field());
    expect(lastPrevented("f")).toBe(true);
  });

  it("R12 a claiming mount answers from <body>, collapsed on a narrow row", async () => {
    const user = userEvent.setup();
    pane.width = 400;
    renderRail({ files: THIRTEEN, claim: true, listener: true });
    expect(caret("Expand file list")).toBeTruthy();
    await toBody();
    await user.keyboard(MOD_F);
    await waitFor(() => expect(document.activeElement).toBe(field()));
  });

  it("R12 no claim registers nothing; a hidden panel's claim does not run", async () => {
    const user = userEvent.setup();
    const plain = renderRail({ files: THIRTEEN, listener: true });
    watchKeys();
    expect(getAvailableSnapshot().has("focus-filter")).toBe(false);
    await toBody();
    await user.keyboard(MOD_F);
    expect(lastPrevented("f")).toBe(false);
    expect(document.activeElement).toBe(document.body);
    plain.unmount();

    renderRail({
      files: THIRTEEN,
      claim: true,
      listener: true,
      panelActive: false,
    });
    expect(getAvailableSnapshot().has("focus-filter")).toBe(false);
    await toBody();
    await user.keyboard(MOD_F);
    expect(document.activeElement).toBe(document.body);
  });

  it.each([
    ["expanded", "Collapse file list", false],
    ["collapsed", "Expand file list", true],
  ] as const)(
    "R12b a claiming mount stands down while focus is in an open modal, %s",
    async (_, caretLabel, collapsed) => {
      stored = { ...DEFAULT_SETTINGS, diffFileListCollapsed: collapsed };
      // The modal marks the tab aria-hidden, out of reach of role queries.
      const byLabel = () =>
        document.querySelector(`[aria-label="${caretLabel}"]`);
      renderRail({ files: THIRTEEN, claim: true, modal: true });
      const inDialog = await screen.findByRole("button", {
        name: "Dialog button",
      });
      await focusOn(inDialog);
      expect(focusInOpenModal()).toBe(true);
      expect(byLabel()).not.toBeNull();
      act(() => {
        dispatchAction("focus-filter");
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(document.activeElement).toBe(inDialog);
      expect(byLabel()).not.toBeNull();
      expect(saveSettingsMerged).not.toHaveBeenCalled();
    },
  );
});

describe("focus landings", () => {
  it("R13 collapsing with the field focused lands on the caret", async () => {
    const user = userEvent.setup();
    renderRail({ files: THIRTEEN });
    await user.click(field());
    act(() => {
      dispatchAction("toggle-diff-file-list");
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(caret("Expand file list")),
    );
  });

  it("R14 a removed focused row lands on the field; focus elsewhere stays", async () => {
    const user = userEvent.setup();
    const { rerenderWith } = renderRail({ files: THIRTEEN });
    await user.click(row("src/beta.ts") as HTMLElement);
    expect(document.activeElement).toBe(row("src/beta.ts"));
    const withoutBeta = THIRTEEN.filter((f) => f.path !== "src/beta.ts");
    rerenderWith({ files: withoutBeta });
    expect(document.activeElement).toBe(field());

    const diffButton = screen.getByRole("button", { name: "Diff action" });
    await focusOn(diffButton);
    rerenderWith({ files: withoutBeta.slice(1) });
    expect(document.activeElement).toBe(diffButton);
    pane.width = 400;
    rerenderWith({ files: withoutBeta.slice(1) });
    expect(document.activeElement).toBe(diffButton);
  });

  it("R14 a narrow crossing with the field focused lands on the caret", async () => {
    const user = userEvent.setup();
    const { rerenderWith } = renderRail({ files: THIRTEEN });
    await user.click(field());
    pane.width = 400;
    // A fresh array: the compiler-memoized harness re-renders the row only then.
    rerenderWith({ files: [...THIRTEEN] });
    expect(document.activeElement).toBe(caret("Expand file list"));
  });

  it("R15 answers before settings load, with no write", async () => {
    const user = userEvent.setup();
    vi.mocked(loadSettings).mockImplementation(
      () => new Promise<AppSettings>(() => undefined),
    );
    renderRail({ files: THIRTEEN }, { loaded: false });
    expect(caret("Collapse file list")).toBeTruthy();
    await focusOn(row("src/beta.ts"));
    await user.keyboard(MOD_F);
    expect(document.activeElement).toBe(field());
    expect(saveSettingsMerged).not.toHaveBeenCalled();
  });

  it("R16a a rejected collapse write re-expands onto the caret", async () => {
    const user = userEvent.setup();
    let rejectWrite: (e: Error) => void = () => undefined;
    vi.mocked(saveSettingsMerged).mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectWrite = reject;
        }),
    );
    renderRail({ files: THIRTEEN });
    await user.click(field());
    act(() => {
      dispatchAction("toggle-diff-file-list");
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(caret("Expand file list")),
    );
    await act(async () => {
      rejectWrite(new Error("disk full"));
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(caret("Collapse file list")),
    );
  });

  it("R16b a Mod+F expand whose write rejects leaves no claim behind", async () => {
    const user = userEvent.setup();
    stored = { ...DEFAULT_SETTINGS, diffFileListCollapsed: true };
    vi.mocked(saveSettingsMerged).mockRejectedValue(new Error("disk full"));
    const { client } = renderRail({ files: THIRTEEN });
    const diffButton = screen.getByRole("button", { name: "Diff action" });
    await focusOn(diffButton);
    await user.keyboard(MOD_F);
    // The expand was attempted: the rejection, not inaction, leaves it collapsed.
    expect(saveSettingsMerged).toHaveBeenCalledWith(
      expect.objectContaining({ diffFileListCollapsed: false }),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(caret("Expand file list")).toBeTruthy();
    expect(document.activeElement).toBe(diffButton);
    act(() => {
      client.setQueryData(settingsKeys.settings, {
        ...stored,
        diffFileListCollapsed: false,
      });
    });
    await waitFor(() => caret("Collapse file list"));
    expect(document.activeElement).toBe(diffButton);
  });
});

describe("held keys", () => {
  it("R17 a repeated Enter after a clear picks nothing and stays put", async () => {
    const user = userEvent.setup();
    renderRail({ files: THIRTEEN });
    await user.type(field(), "alpha");
    await user.click(fieldClear());
    expect(document.activeElement).toBe(field());
    pickSpy.mockClear();
    const notPrevented = fireEvent.keyDown(field(), {
      key: "Enter",
      repeat: true,
    });
    expect(notPrevented).toBe(true);
    expect(pickSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field());
  });

  it("R18 a repeated Escape is swallowed whatever the text, and changes none", async () => {
    const user = userEvent.setup();
    renderRail({ files: THIRTEEN });
    watchKeys();
    const docKeys = vi.fn<(key: string) => void>();
    const onDocKey = (e: KeyboardEvent) => docKeys(e.key);
    document.addEventListener("keydown", onDocKey);
    try {
      fireEvent.keyDown(field(), { key: "Escape", repeat: true });
      expect(lastPrevented("Escape")).toBe(true);
      expect(docKeys).not.toHaveBeenCalled();
      expect(parentKeys).not.toHaveBeenCalled();

      await user.type(field(), "abc");
      fireEvent.keyDown(field(), { key: "Escape", repeat: true });
      expect(lastPrevented("Escape")).toBe(true);
      expect(field().value).toBe("abc");
      expect(docKeys.mock.calls.flat()).not.toContain("Escape");

      fireEvent.keyDown(field(), {
        key: "Escape",
        repeat: true,
        isComposing: true,
      });
      expect(lastPrevented("Escape")).toBe(false);

      await user.clear(field());
      fireEvent.keyDown(field(), { key: "Escape" });
      expect(lastPrevented("Escape")).toBe(false);
      // The composing repeat and the plain one; neither repeat before them.
      expect(
        docKeys.mock.calls.flat().filter((k) => k === "Escape"),
      ).toHaveLength(2);
    } finally {
      document.removeEventListener("keydown", onDocKey);
    }
  });
});

describe("the removal rescue", () => {
  it("R19 keeps its node through a blur that leaves it active", async () => {
    const { rerenderWith } = renderRail({ files: THIRTEEN });
    await focusOn(row("src/beta.ts"));
    fireEvent.focusOut(row("src/beta.ts") as HTMLElement);
    expect(document.activeElement).toBe(row("src/beta.ts"));
    const withoutBeta = THIRTEEN.filter((f) => f.path !== "src/beta.ts");
    rerenderWith({ files: withoutBeta });
    expect(document.activeElement).toBe(field());

    await focusOn(row("src/gamma.ts"));
    const outside = screen.getByRole("button", { name: "Outside" });
    await focusOn(outside);
    rerenderWith({
      files: withoutBeta.filter((f) => f.path !== "src/gamma.ts"),
    });
    expect(document.activeElement).toBe(outside);
  });

  it("R19b forgets a row focus left for <body> before the row goes", async () => {
    const { rerenderWith } = renderRail({ files: THIRTEEN });
    await focusOn(row("src/beta.ts"));
    expect(document.activeElement).toBe(row("src/beta.ts"));
    await toBody();
    expect(document.activeElement).toBe(document.body);
    rerenderWith({
      files: THIRTEEN.filter((f) => f.path !== "src/beta.ts"),
    });
    expect(row("src/beta.ts")).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});

describe("a consumed shortcut", () => {
  it("R20 a modified binding a child already prevented stays the child's", async () => {
    const user = userEvent.setup();
    stored = {
      ...DEFAULT_SETTINGS,
      hotkeys: { "focus-filter": "mod+shift+k" },
    } as AppSettings;
    renderRail({ files: THIRTEEN, consumer: true });
    const composer = screen.getByRole("button", { name: "Composer" });
    await focusOn(composer);
    await user.keyboard("{Control>}{Shift>}k{/Shift}{/Control}");
    expect(document.activeElement).toBe(composer);
  });
});

describe("the status across an unsettled clear", () => {
  it("R21 a clear made while unsettled is announced once the list settles", async () => {
    const user = userEvent.setup();
    const { rerenderWith } = renderRail({ files: THIRTEEN });
    await user.type(field(), "alpha");
    expect(status()?.textContent).toBe("Showing 2 of 13 files");
    const placeholder = F("p/alpha.ts", "p/one.ts", "p/two.ts");
    rerenderWith({ files: placeholder, settled: false, identity: "two" });
    await user.clear(field());
    expect(status()?.textContent).toBe("Showing 2 of 13 files");
    rerenderWith({ files: THIRTEEN, settled: true, identity: "two" });
    expect(status()?.textContent).toBe("Showing all 13 files");
  });
});

// What the active element was while a leaving rail's subtree tore down: a
// child's cleanup runs after its rail's own, before any DOM is removed.
let activeAtTeardown: Element | null = null;
function TeardownProbe() {
  useLayoutEffect(
    () => () => {
      activeAtTeardown = document.activeElement;
    },
    [],
  );
  return null;
}

/** A rail-bearing view in miniature, to swap in one slot. */
function MiniRail({ scope, label }: { scope: string; label: string }) {
  const [picked, setPicked] = useState<string | null>(null);
  const filter = useFileListFilter({
    scope,
    files: THIRTEEN,
    settled: true,
    picked,
    onPick: setPicked,
  });
  return (
    <DetailRailRow>
      <DetailRail ariaLabel={label} filter={filter.rail}>
        <TeardownProbe />
        {filter.visible.map((f) => (
          <button key={f.path} type="button" tabIndex={-1} data-path={f.path}>
            {f.path}
          </button>
        ))}
      </DetailRail>
    </DetailRailRow>
  );
}

interface SwapProps {
  show: "A" | "B" | "none";
  scopeB?: string;
}

function renderSwap(props: SwapProps, { strict = false } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, stored);
  const ui = ({ show, scopeB = "session" }: SwapProps) => {
    const tree = (
      <QueryClientProvider client={client}>
        {show === "A" ? <MiniRail scope="session" label="Rail A" /> : null}
        {show === "B" ? <MiniRail scope={scopeB} label="Rail B" /> : null}
      </QueryClientProvider>
    );
    return strict ? <StrictMode>{tree}</StrictMode> : tree;
  };
  const utils = render(ui(props));
  return { client, swapTo: (p: SwapProps) => utils.rerender(ui(p)) };
}

const railNamed = (name: string) =>
  screen.queryByRole("complementary", { name });

describe("the field handoff", () => {
  const typeInA = async () => {
    const user = userEvent.setup();
    await user.type(field(), "alpha");
    field().setSelectionRange(0, 0);
    expect(railNamed("Rail A")).not.toBeNull();
  };
  const fieldHoldsFocusAtEnd = () => {
    expect(railNamed("Rail B")).not.toBeNull();
    expect(document.activeElement).toBe(field());
    expect(field().value).toBe("alpha");
    expect([field().selectionStart, field().selectionEnd]).toEqual([5, 5]);
  };

  it("R22a a same-scope rail swapped in one commit takes the field", async () => {
    const { swapTo } = renderSwap({ show: "A" });
    await typeInA();
    const leaving = field();
    activeAtTeardown = null;
    swapTo({ show: "B" });
    expect(activeAtTeardown).toBe(leaving);
    expect(leaving.isConnected).toBe(false);
    fieldHoldsFocusAtEnd();
  });

  it("R22b another scope takes nothing", async () => {
    const { swapTo } = renderSwap({ show: "A" });
    await typeInA();
    swapTo({ show: "B", scopeB: "history" });
    expect(railNamed("Rail B")).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it("R22c a focused row hands nothing over", async () => {
    const { swapTo } = renderSwap({ show: "A" });
    await focusOn(row("src/beta.ts"));
    swapTo({ show: "B" });
    expect(railNamed("Rail B")).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it("R22d a rail mounting in a later commit takes nothing", async () => {
    const { swapTo } = renderSwap({ show: "A" });
    await typeInA();
    swapTo({ show: "none" });
    await act(async () => {
      await Promise.resolve();
    });
    swapTo({ show: "B" });
    expect(railNamed("Rail B")).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it("R22e a collapsed successor lands on its caret", async () => {
    const { client, swapTo } = renderSwap({ show: "A" });
    await typeInA();
    client.setQueryData(settingsKeys.settings, {
      ...stored,
      diffFileListCollapsed: true,
    });
    swapTo({ show: "B" });
    expect(document.activeElement).toBe(caret("Expand file list"));
  });

  it("R22f StrictMode's replayed effects land the same way", async () => {
    const { swapTo } = renderSwap({ show: "A" }, { strict: true });
    await typeInA();
    swapTo({ show: "B" });
    fieldHoldsFocusAtEnd();
  });
});

describe("a list hidden under focus", () => {
  it("R23a a poll leaving nothing to match moves focus from a row action to the field", async () => {
    const user = userEvent.setup();
    const { rerenderWith } = renderRail({ files: THIRTEEN, rowDialog: true });
    await user.type(field(), "alpha");
    const action = screen.getByRole("button", { name: "Row action" });
    act(() => action.focus());
    expect(document.activeElement).toBe(action);
    rerenderWith({ files: F("x/none.ts"), rowDialog: true });
    expect(screen.getByText("No files match the filter")).toBeTruthy();
    expect(action.isConnected).toBe(true);
    expect(document.activeElement).toBe(field());
  });

  it("R23b a row action's portalled dialog keeps focus as the list hides", async () => {
    const user = userEvent.setup();
    const { rerenderWith } = renderRail({ files: THIRTEEN, rowDialog: true });
    await user.type(field(), "alpha");
    await user.click(screen.getByRole("button", { name: "Row action" }));
    const dialogAction = screen.getByRole("button", { name: "Dialog action" });
    act(() => dialogAction.focus());
    expect(document.activeElement).toBe(dialogAction);
    // Every prop is replaced, so the row action stays mounted only with it.
    rerenderWith({ files: F("x/none.ts"), rowDialog: true });
    expect(screen.getByText("No files match the filter")).toBeTruthy();
    expect(dialogAction.isConnected).toBe(true);
    expect(document.activeElement).toBe(dialogAction);
  });
});
