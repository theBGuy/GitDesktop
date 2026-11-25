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
import { lazy, type ReactNode, Suspense, useLayoutEffect } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DiffContent, type DiffLineAnchor } from "@/features/diff/DiffSurface";
import {
  FileSlots,
  keyedPaneView,
  useFileSlots,
  usePaintedView,
} from "@/features/diff/file-slot";
import type { PaintedView } from "@/features/diff/painted-view";
import { type FileBytes, gitFileBase64 } from "@/lib/git/api";
import type { FileDiff } from "@/lib/git/types";
import { type AppSettings, loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { stubCanvas } from "./canvas-stub";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitFileBase64: vi.fn(),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/use-container-width", () => ({
  useContainerWidth: () => [() => undefined, null],
}));

Element.prototype.scrollIntoView = vi.fn();

// The chunk split the lazy diff wrappers make (DiffSurfaceLazy.tsx), whose
// consumers scripts/diff-pane-hold.test.mjs rosters: until it loads, the slot
// shows a fallback and no diff has mounted.
const LazyDiffContent = lazy(() =>
  import("@/features/diff/DiffSurface").then((m) => ({
    default: m.DiffContent,
  })),
);

let settings: AppSettings = DEFAULT_SETTINGS;
beforeAll(stubCanvas);
beforeEach(() => {
  unmockedCommands.length = 0;
  settings = DEFAULT_SETTINGS;
  vi.mocked(loadSettings).mockImplementation(async () => settings);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  expect(unmockedCommands).toEqual([]);
});

const header = (path: string) =>
  `diff --git a/${path} b/${path}\nindex 1111aaa..2222bbb 100644\n--- a/${path}\n+++ b/${path}\n`;
const ADDED = (path: string) =>
  `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n`;
const SHORT = `${header("a.txt")}@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n`;
const LINES_300 = Array.from({ length: 300 }, (_, i) => `+l${i + 1}\n`).join(
  "",
);
// Past the pane's 200-line cap: a hunk-only diff draws its first lines.
const LONG = `${ADDED("a.txt")}@@ -0,0 +1,300 @@\n${LINES_300}`;
const MEGA = `${ADDED("a.txt")}@@ -0,0 +1,2 @@\n+${"x".repeat(20_001)}\n+short\n`;
const MD = `${header("n.md")}@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n`;
// One changed line in a 30-line file: content mode collapses the rest into
// gaps above and below the hunk.
const OLD_30 = Array.from({ length: 30 }, (_, i) => `l${i + 1}\n`).join("");
const NEW_30 = OLD_30.replace("l15\n", "L15\n");
const GAPPED = `${header("a.txt")}@@ -12,7 +12,7 @@\n l12\n l13\n l14\n-l15\n+L15\n l16\n l17\n l18\n`;

const diff = (filePath: string, text: string): FileDiff => ({
  filePath,
  text,
  isBinary: false,
  isTruncated: false,
});
const bytes = (s: string): FileBytes => ({
  base64: btoa(s),
  mime: null,
  tooLarge: false,
  size: s.length,
});
/** An anchor whose row shows its own report key, so the DOM names it. */
const anchor = (side: "old" | "new", line: number): DiffLineAnchor => ({
  side,
  line,
  render: () => <span>{`${side}:${line}`}</span>,
});
/** The keys of the anchor rows mounted now, read off the DOM. */
const domKeys = () =>
  [...document.querySelectorAll("[data-diff-anchor]")]
    .map((el) => el.textContent ?? "")
    .sort();
const expands = () =>
  document.querySelectorAll<HTMLElement>('[title^="Expand"]');

/** A file-rail host: one target through the shared slots, its visible
 *  slot's painted report recorded on every commit. */
function harness(settingsNow: AppSettings = settings) {
  const seen: (PaintedView | null)[] = [];
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, settingsNow);
  function Host({
    path,
    child,
  }: {
    path: string;
    child: (path: string) => ReactNode;
  }) {
    const target = keyedPaneView("/repo", "commit-1", path, path);
    const slots = useFileSlots(target);
    const painted = usePaintedView(slots);
    useLayoutEffect(() => {
      seen.push(painted);
    });
    return (
      <FileSlots slots={slots} target={target}>
        {(view) => (view.kind === "file" ? child(view.file) : null)}
      </FileSlots>
    );
  }
  const ui = (path: string, child: (path: string) => ReactNode) => (
    <QueryClientProvider client={client}>
      <Host path={path} child={child} />
    </QueryClientProvider>
  );
  return {
    client,
    mount: (path: string, child: (path: string) => ReactNode) => {
      const view = render(ui(path, child));
      return (p: string, c: (path: string) => ReactNode) =>
        view.rerender(ui(p, c));
    },
    last: () => seen.at(-1) ?? null,
    seen,
  };
}

describe("a slot's painted report names the anchor rows mounted, never lines read off the patch", () => {
  it("leaves a line past the cap out until Show full diff mounts it", async () => {
    const anchors = [anchor("new", 5), anchor("new", 250)];
    const h = harness();
    h.mount("a.txt", (p) => (
      <DiffContent
        filePath={p}
        data={diff(p, LONG)}
        isPending={false}
        isError={false}
        lineAnchors={anchors}
      />
    ));
    await waitFor(() => expect(h.last()?.anchors).toEqual(["new:5"]));
    expect(h.last()).toMatchObject({
      path: "a.txt",
      patch: LONG,
      cut: "cap",
      whitespaceHidden: false,
    });
    expect(domKeys()).toEqual(["new:5"]);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Show full diff" }));
    await waitFor(() =>
      expect(h.last()?.anchors).toEqual(["new:250", "new:5"]),
    );
    expect(h.last()?.cut).toBeNull();
    expect(domKeys()).toEqual(["new:250", "new:5"]);
  });

  it("adds a gap line's anchor when its gap is expanded", async () => {
    vi.mocked(gitFileBase64).mockImplementation(async (_r, rev) =>
      bytes(rev === "A" ? OLD_30 : NEW_30),
    );
    const anchors = [anchor("new", 3), anchor("new", 15), anchor("new", 25)];
    const h = harness();
    h.mount("a.txt", (p) => (
      <DiffContent
        filePath={p}
        data={diff(p, GAPPED)}
        isPending={false}
        isError={false}
        repoPath="/repo"
        contentRevs={{ oldRev: "A", newRev: "B" }}
        lineAnchors={anchors}
      />
    ));
    await waitFor(() => expect(expands().length).toBeGreaterThan(0), {
      timeout: 10_000,
    });
    await waitFor(() => expect(h.last()?.anchors).toEqual(["new:15"]));
    expect(domKeys()).toEqual(["new:15"]);
    const user = userEvent.setup();
    for (let i = 0; i < 20 && expands().length > 0; i++)
      await user.click(expands()[0]);
    await waitFor(() =>
      expect(h.last()?.anchors).toEqual(["new:15", "new:25", "new:3"]),
    );
    expect(domKeys()).toEqual(["new:15", "new:25", "new:3"]);
  }, 30_000);

  it("keeps each key once in split mode and through a switch to unified", async () => {
    // A context line carries both sides' numbers: its old- and new-side
    // anchors are distinct keys on one row.
    const anchors = [anchor("old", 1), anchor("new", 1), anchor("new", 2)];
    const split = { ...DEFAULT_SETTINGS, diffViewMode: "split" as const };
    const h = harness(split);
    h.mount("a.txt", (p) => (
      <DiffContent
        filePath={p}
        data={diff(p, SHORT)}
        isPending={false}
        isError={false}
        lineAnchors={anchors}
      />
    ));
    const all = ["new:1", "new:2", "old:1"];
    await waitFor(() => expect(h.last()?.anchors).toEqual(all));
    expect(domKeys()).toEqual(all);
    const from = h.seen.length;
    act(() => {
      h.client.setQueryData(settingsKeys.settings, {
        ...split,
        diffViewMode: "unified",
      });
    });
    await waitFor(() => expect(domKeys()).toEqual(all));
    expect(h.last()?.anchors).toEqual(all);
    // No commit of the switch relayed fewer rows than stayed mounted.
    expect(h.seen.slice(from).every((v) => v?.anchors.length === 3)).toBe(true);
  });
});

describe("arms that mount no anchor rows report none", () => {
  it("reports nothing mounted under the mega-line placeholder, the rows after Show diff anyway", async () => {
    const anchors = [anchor("new", 2)];
    const h = harness();
    h.mount("a.txt", (p) => (
      <DiffContent
        filePath={p}
        data={diff(p, MEGA)}
        isPending={false}
        isError={false}
        lineAnchors={anchors}
      />
    ));
    await waitFor(() => expect(h.last()?.cut).toBe("mega-line"));
    expect(h.last()?.anchors).toEqual([]);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Show diff anyway" }));
    await waitFor(() => expect(h.last()?.anchors).toEqual(["new:2"]));
  });

  it("reports nothing mounted while Markdown Preview is up", async () => {
    vi.mocked(gitFileBase64).mockResolvedValue(bytes("a\nB\nc\n"));
    const anchors = [anchor("new", 2)];
    const h = harness();
    h.mount("n.md", (p) => (
      <DiffContent
        filePath={p}
        data={diff(p, MD)}
        isPending={false}
        isError={false}
        repoPath="/repo"
        previewRev="B"
        lineAnchors={anchors}
      />
    ));
    await waitFor(() => expect(h.last()?.anchors).toEqual(["new:2"]));
    const toggle = (name: "Raw" | "Preview") =>
      within(screen.getByRole("group", { name: "Markdown view" })).getByRole(
        "button",
        { name },
      );
    const user = userEvent.setup();
    await user.click(toggle("Preview"));
    await waitFor(() => expect(h.last()?.cut).toBe("preview"));
    expect(h.last()?.anchors).toEqual([]);
    await user.click(toggle("Raw"));
    await waitFor(() => expect(h.last()?.anchors).toEqual(["new:2"]));
  });

  it("reports a pending read and a paint waiting on its whole-file reads as pending, nothing mounted", async () => {
    const anchors = [anchor("new", 2)];
    const h = harness();
    const rerender = h.mount("a.txt", (p) => (
      <DiffContent
        filePath={p}
        data={undefined}
        isPending
        isError={false}
        lineAnchors={anchors}
      />
    ));
    await waitFor(() => expect(h.last()?.cut).toBe("pending"));
    expect(h.last()?.anchors).toEqual([]);
    vi.mocked(gitFileBase64).mockImplementation(
      () => new Promise<FileBytes>(() => undefined),
    );
    rerender("a.txt", (p) => (
      <DiffContent
        filePath={p}
        data={diff(p, SHORT)}
        isPending={false}
        isError={false}
        repoPath="/repo"
        contentRevs={{ oldRev: "A", newRev: "B" }}
        lineAnchors={anchors}
      />
    ));
    await act(async () => undefined);
    expect(h.last()).toMatchObject({ patch: SHORT, cut: "pending" });
    expect(h.last()?.anchors).toEqual([]);
    expect(domKeys()).toEqual([]);
  });

  it("reports nothing mounted once the renderer's error fallback replaces the rows", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const boom = { on: false };
    const throwing = (): DiffLineAnchor[] => [
      {
        side: "new",
        line: 2,
        render: () => {
          if (boom.on) throw new Error("renderer failed");
          return <span>new:2</span>;
        },
      },
    ];
    const h = harness();
    const rerender = h.mount("a.txt", (p) => (
      <DiffContent
        filePath={p}
        data={diff(p, SHORT)}
        isPending={false}
        isError={false}
        lineAnchors={throwing()}
      />
    ));
    await waitFor(() => expect(h.last()?.anchors).toEqual(["new:2"]));
    boom.on = true;
    rerender("a.txt", (p) => (
      <DiffContent
        filePath={p}
        data={diff(p, SHORT)}
        isPending={false}
        isError={false}
        lineAnchors={throwing()}
      />
    ));
    await waitFor(() =>
      expect(
        screen.queryByText("This file's diff couldn't be displayed."),
      ).not.toBeNull(),
    );
    expect(h.last()?.anchors).toEqual([]);
    expect(domKeys()).toEqual([]);
  });
});

describe("the slot relay", () => {
  it("relays nothing while the diff chunk's Suspense fallback is up", async () => {
    const h = harness();
    h.mount("a.txt", (p) => (
      <Suspense fallback={<span>Loading the diff</span>}>
        <LazyDiffContent
          filePath={p}
          data={diff(p, SHORT)}
          isPending={false}
          isError={false}
          lineAnchors={[anchor("new", 2)]}
        />
      </Suspense>
    ));
    expect(screen.queryByText("Loading the diff")).not.toBeNull();
    expect(h.last()).toBeNull();
    await waitFor(() => expect(h.last()?.anchors).toEqual(["new:2"]));
    expect(h.seen.some((v) => v === null)).toBe(true);
  });

  it("relays the held slot's rows while the next file prepares, then the promoted one's", async () => {
    const anchors = [anchor("new", 2)];
    const h = harness();
    const child = (p: string) =>
      p === "a.txt" ? (
        <DiffContent
          filePath={p}
          data={diff(p, SHORT)}
          isPending={false}
          isError={false}
          lineAnchors={anchors}
        />
      ) : (
        // Never settles: the bound promotes it.
        <DiffContent
          filePath={p}
          data={undefined}
          isPending
          isError={false}
          lineAnchors={anchors}
        />
      );
    const rerender = h.mount("a.txt", child);
    await waitFor(() => expect(h.last()?.anchors).toEqual(["new:2"]));
    await act(async () => undefined);
    rerender("b.txt", child);
    // Two slots now: the held a.txt in flow, b.txt preparing out of sight.
    expect(document.querySelectorAll("[inert]").length).toBe(2);
    expect(h.last()).toMatchObject({ path: "a.txt", anchors: ["new:2"] });
    await waitFor(
      () =>
        expect(h.last()).toMatchObject({
          path: "b.txt",
          cut: "pending",
          anchors: [],
        }),
      { timeout: 2_000 },
    );
    expect(domKeys()).toEqual([]);
  });
});
