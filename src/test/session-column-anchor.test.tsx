import {
  defaultScheduler,
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Activity,
  type ComponentProps,
  createElement,
  type ReactNode,
  useRef,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitDiffView as GitDiffViewImpl } from "@/features/diff/DiffSurface";
import { RESTORE_BOUND_MS } from "@/features/diff/diff-rows";
import { drawnLayout } from "@/features/diff/drawn-layout";
import { AgentTranscript } from "@/features/sessions/AgentTranscript";
import { SessionConversation } from "@/features/sessions/SessionConversation";
import type { AgentSession } from "@/features/sessions/store";
import {
  type ColumnBox,
  ColumnLayoutAnchorContext,
  ColumnLayoutMark,
  columnScrollTop,
  pickColumnAnchor,
  type StepLayout,
  useColumnLayoutAnchor,
} from "@/features/sessions/use-column-layout-anchor";
import { gitSessionFileDiff } from "@/lib/git/api";
import type { FileDiff } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys, useSettings } from "@/lib/settings/queries";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitSessionFileDiff: vi.fn(),
}));

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));

vi.mock("@/features/sessions/SessionComposer", () => ({
  SessionComposer: () => null,
}));

type DiffViewProps = ComponentProps<typeof GitDiffViewImpl>;

/** Every `scrollerRef` the diff view stand-in was rendered with, and whether
 *  a grammar the stand-in's held arm waits on has landed. */
const seen = vi.hoisted(() => ({
  refs: [] as unknown[],
  grammar: false,
  listeners: new Set<() => void>(),
}));

/** The held arm's grammar lands: every waiting stand-in draws its rows. */
const landGrammar = () =>
  act(() => {
    seen.grammar = true;
    for (const listener of seen.listeners) listener();
  });

// The diff view is a stand-in: the host's wiring is what these tests read. It
// is laid out by the layout it draws (`data-h`), as the real rows are: the
// setting's mode, or Unified where the host forces it. A text whose hunk adds
// `+<arm>` draws GitDiffView's rowless arm of that name instead, which keeps
// its height on a switch (no `data-h`: the box is 40px).
vi.mock("@/features/diff/DiffSurfaceLazy", async (importOriginal) => {
  const { useSettings: useSettingsMode } = await import(
    "@/lib/settings/queries"
  );
  const { Suspense, useState, useSyncExternalStore } = await import("react");
  const { DiffErrorBoundary } = await import(
    "@/features/diff/DiffErrorBoundary"
  );
  const { DiffPlaceholder } = await import("@/features/diff/DiffPlaceholder");
  const { LazyPanelFallback } = await import(
    "@/components/lazy-panel-fallback"
  );
  const pending = new Promise<never>(() => undefined);
  const Suspended = (): never => {
    throw pending;
  };
  const Throws = (): never => {
    throw new Error("renderer threw");
  };
  const subscribe = (listener: () => void) => {
    seen.listeners.add(listener);
    return () => seen.listeners.delete(listener);
  };
  return {
    ...(await importOriginal<
      typeof import("@/features/diff/DiffSurfaceLazy")
    >()),
    GitDiffView: function GitDiffViewStandIn(props: DiffViewProps) {
      seen.refs.push(props.scrollerRef);
      const mode = useSettingsMode().data?.diffViewMode ?? "unified";
      const [anyway, setAnyway] = useState(false);
      const landed = useSyncExternalStore(subscribe, () => seen.grammar);
      const arm = /^\+(blocked|error|suspense|grammar|unbuilt)$/m.exec(
        props.text,
      )?.[1];
      if (arm === "blocked" && !anyway)
        return (
          <DiffPlaceholder
            message="Looks like a generated or minified file"
            action={
              <button type="button" onClick={() => setAnyway(true)}>
                Show diff anyway
              </button>
            }
          />
        );
      if (arm === "error")
        return (
          <DiffErrorBoundary resetKey={props.filePath}>
            <Throws />
          </DiffErrorBoundary>
        );
      if (arm === "suspense")
        return (
          <Suspense fallback={<LazyPanelFallback name="the diff" rows={[]} />}>
            <Suspended />
          </Suspense>
        );
      if (arm === "grammar" && !landed) return null;
      if (arm === "unbuilt")
        return <DiffPlaceholder message="No changes to show" />;
      const split = mode === "split" && props.forceUnified !== true;
      return (
        <div data-testid="diff-view" data-h={split ? 100 : 200}>
          {props.text}
        </div>
      );
    },
  };
});

const TEXT =
  "diff --git a/x b/x\nindex 1111aaa..2222bbb 100644\n--- a/x\n+++ b/x\n" +
  "@@ -1 +1 @@\n-target\n+other\n";
const diffOf = (text: string): FileDiff => ({
  filePath: "x",
  text,
  isBinary: false,
  isTruncated: false,
});

function newClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
  return client;
}

const wrap = (client: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };

/** Flips the setting with its observers notified in the same act, so the
 *  switch commits before the next line. */
const flipTo = (client: QueryClient, mode: "split" | "unified") =>
  act(() => {
    notifyManager.setScheduler((cb) => cb());
    try {
      client.setQueryData(settingsKeys.settings, {
        ...DEFAULT_SETTINGS,
        diffViewMode: mode,
      });
    } finally {
      notifyManager.setScheduler(defaultScheduler);
    }
  });

/** Resize observers the code under test made: setup.ts's shim never fires. */
let observers: FakeResizeObserver[] = [];

class FakeResizeObserver {
  readonly callback: ResizeObserverCallback;
  readonly targets = new Set<Element>();
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    observers.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
}

/** A re-laid layout: every observer still watching a mounted element hears. */
function resize() {
  for (const observer of observers)
    if ([...observer.targets].some((target) => target.isConnected))
      observer.callback([], observer as unknown as ResizeObserver);
}

/** The column's scrollTop. */
let top = 0;
/** The width a step's measured box reports when its ref attaches (its first
 *  measurement): Split fits unless a test narrows it. */
let paneWidth = 1000;

/** The wiring test's column: each step box sits after GAP px of narration,
 *  as tall as the diff view inside it says. */
const GAP = 300;
function transcriptBox(el: HTMLElement): ColumnBox {
  let y = 0;
  for (const box of document.querySelectorAll("[data-transcript-diff]")) {
    const h = Number(
      box.querySelector("[data-h]")?.getAttribute("data-h") ?? 40,
    );
    y += GAP;
    if (box === el) return { top: y, bottom: y + h };
    y += h;
  }
  return { top: 0, bottom: 0 };
}

beforeEach(() => {
  vi.clearAllMocks();
  seen.refs = [];
  seen.grammar = false;
  seen.listeners.clear();
  top = 0;
  paneWidth = 1000;
  observers = [];
  vi.mocked(loadSettings).mockImplementation(async () => DEFAULT_SETTINGS);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Lays boxes out by content coordinates against the column's scrollTop:
 *  `data-y`/`data-h` where set, else the transcript model above. Frames are
 *  requested but never run: nothing here waits on one. */
function stubLayout() {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const y = this.dataset.y;
      if (y !== undefined)
        return {
          top: Number(y) - top,
          bottom: Number(y) - top + Number(this.dataset.h),
        } as DOMRect;
      if (this.hasAttribute("data-transcript-diff")) {
        const box = transcriptBox(this);
        return { top: box.top - top, bottom: box.bottom - top } as DOMRect;
      }
      if (this.matches(".max-h-96.overflow-auto"))
        return { top: 0, bottom: 0, width: paneWidth } as DOMRect;
      return { top: 0, bottom: 0 } as DOMRect;
    },
  );
}

/** Gives `scroller` a scrollTop backed by `top`, a content height (3000px
 *  unless `height` says otherwise) and a 400px viewport (0 while an <Activity>
 *  hides it). A write past the bottom reads back as written: nothing clamps.
 *  The returned scroll is silent: no scroll event, as when one lands before
 *  its event does. */
function asScroller(scroller: HTMLElement, height: () => number = () => 3000) {
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v;
    },
  });
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    get: height,
  });
  Object.defineProperty(scroller, "clientHeight", {
    configurable: true,
    get: () => (scroller.style.display === "none" ? 0 : 400),
  });
  return (y: number) => {
    top = y;
  };
}

/** A column whose content is 2600px of narration plus its step boxes as laid
 *  out, so a switch that changes a box's height changes the column's. Read
 *  through the document, so a spy on the column's own query counts the code
 *  under test alone. */
const boxedHeight = (scroller: HTMLElement) => () => {
  let height = 2600;
  for (const box of document.querySelectorAll("[data-transcript-diff]")) {
    if (!scroller.contains(box)) continue;
    const rect = box.getBoundingClientRect();
    height += rect.bottom - rect.top;
  }
  return height;
};

/** A scroll event nobody's input started (scroll anchoring, a jump). */
const scrollEvent = (el: HTMLElement) =>
  act(() => {
    el.dispatchEvent(new Event("scroll"));
  });

/** A hold puts the column back on `y` after a scroll it did not cause. */
function expectHeldAt(el: HTMLElement, y: number) {
  top = y + 37;
  scrollEvent(el);
  expect(top).toBe(y);
}

/** Nothing holds the column: a scroll and a re-lay leave it where it lands. */
function expectNoHold(el: HTMLElement) {
  top = 1234;
  scrollEvent(el);
  act(resize);
  expect(top).toBe(1234);
}

describe("a transcript step's diff hands its scroller to the line anchor", () => {
  it("passes the measured box, one ref object across renders, null once closed", async () => {
    const user = userEvent.setup();
    let answer = TEXT;
    vi.mocked(gitSessionFileDiff).mockImplementation(async () =>
      diffOf(answer),
    );
    const client = newClient();
    render(
      <AgentTranscript
        segments={[{ type: "tool", tool: "edit", target: "/repo/x" }]}
        baseDir="/repo"
        editDiffBase="b"
      />,
      { wrapper: wrap(client) },
    );
    const toggle = screen.getByRole("button", { expanded: false });
    await user.click(toggle);
    await screen.findByTestId("diff-view");
    const box = document.querySelector(".max-h-96.overflow-auto");
    expect(box).not.toBeNull();
    const ref = seen.refs[0] as { current: HTMLElement | null } | undefined;
    expect(ref?.current).toBe(box);
    // A new build re-renders the view under the same ref object.
    answer = `${TEXT}+again\n`;
    await act(() => client.invalidateQueries());
    await waitFor(() =>
      expect(screen.getByTestId("diff-view").textContent).toContain("again"),
    );
    expect(seen.refs.length).toBeGreaterThan(1);
    for (const r of seen.refs) expect(r).toBe(ref);
    await user.click(toggle);
    expect(ref?.current).toBeNull();
  });

  it("marks no box on a transcript without step diffs (plan, research)", () => {
    render(
      <AgentTranscript
        segments={[{ type: "tool", tool: "edit", target: "/repo/x" }]}
        baseDir="/repo"
      />,
      { wrapper: wrap(newClient()) },
    );
    expect(document.querySelector("[data-transcript-diff]")).toBeNull();
  });
});

describe("pickColumnAnchor / columnScrollTop", () => {
  const boxes: ColumnBox[] = [
    { top: 300, bottom: 500 },
    { top: 800, bottom: 1000 },
  ];

  it("keeps the edge's proportional place in the box it falls inside", () => {
    const anchor = pickColumnAnchor(boxes, 900);
    expect(anchor).toEqual({
      index: 1,
      edge: "top",
      offset: -100,
      height: 200,
    });
    // Halfway into a 200px box stays halfway into the 100px box it becomes.
    expect(
      columnScrollTop(
        { top: 700, bottom: 800 },
        { edge: "top", offset: -100, height: 200 },
      ),
    ).toBe(750);
  });

  it("scales the edge's depth up when the box grows", () => {
    expect(
      columnScrollTop(
        { top: 800, bottom: 1000 },
        { edge: "top", offset: -50, height: 100 },
      ),
    ).toBe(900);
  });

  it("keeps the offset of a box whose height did not change", () => {
    expect(
      columnScrollTop(
        { top: 850, bottom: 1050 },
        { edge: "top", offset: -100, height: 200 },
      ),
    ).toBe(950);
  });

  it("lands on the top of a box that collapsed", () => {
    expect(
      columnScrollTop(
        { top: 700, bottom: 700 },
        { edge: "top", offset: -100, height: 200 },
      ),
    ).toBe(700);
  });

  it("keeps the bottom of the last box above narration at the edge", () => {
    const anchor = pickColumnAnchor(boxes, 600);
    expect(anchor).toEqual({
      index: 0,
      edge: "bottom",
      offset: -100,
      height: 200,
    });
    expect(
      columnScrollTop(
        { top: 300, bottom: 400 },
        { edge: "bottom", offset: -100, height: 200 },
      ),
    ).toBe(500);
  });

  it("takes a box whose top sits exactly at the edge", () => {
    expect(pickColumnAnchor(boxes, 800)).toEqual({
      index: 1,
      edge: "top",
      offset: 0,
      height: 200,
    });
  });

  it("answers null with no box at or above the edge", () => {
    expect(pickColumnAnchor(boxes, 299)).toBeNull();
    expect(pickColumnAnchor([], 500)).toBeNull();
  });
});

type Mode = "split" | "unified";
type Verdict = "pending" | "narrow" | "wide";
/** A hand-laid step box: `k` keys it (index otherwise), `w` is its width
 *  verdict (none: wide, so it draws the setting). */
type Box = { y: number; h: number; k?: string; w?: Verdict };
type Layout = Record<Mode, Box[]>;

/** What a box's mark reports, as AgentTranscript derives it. */
const markOf = (w: Verdict | undefined, mode: Mode): StepLayout =>
  w === "pending" ? "pending" : drawnLayout(w === "narrow", mode);

/** Two step boxes shorter than their max-h-96 box, narration between. */
const LAYOUT: Layout = {
  unified: [
    { y: 300, h: 200 },
    { y: 800, h: 200 },
  ],
  split: [
    { y: 300, h: 100 },
    { y: 700, h: 100 },
  ],
};

function Column({
  layout,
  jumping,
}: {
  layout: Layout;
  jumping: { current: boolean };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const column = useColumnLayoutAnchor(ref, jumping);
  const mode = useSettings().data?.diffViewMode ?? "unified";
  return (
    <div ref={ref} data-testid="column">
      <ColumnLayoutAnchorContext value={column}>
        {layout[mode].map((b, i) => (
          <div key={b.k ?? i} data-transcript-diff="" data-y={b.y} data-h={b.h}>
            <ColumnLayoutMark layout={markOf(b.w, mode)} />
          </div>
        ))}
      </ColumnLayoutAnchorContext>
    </div>
  );
}

function mountColumn({
  layout = LAYOUT,
  mode,
}: {
  layout?: Layout;
  mode?: Mode;
} = {}) {
  stubLayout();
  const client = newClient();
  if (mode !== undefined)
    client.setQueryData(settingsKeys.settings, {
      ...DEFAULT_SETTINGS,
      diffViewMode: mode,
    });
  const jumping = { current: false };
  const view = render(
    <QueryClientProvider client={client}>
      {createElement(Activity, {
        mode: "visible",
        children: <Column layout={layout} jumping={jumping} />,
      })}
    </QueryClientProvider>,
  );
  const column = view.getByTestId("column");
  const scrollTo = asScroller(column, boxedHeight(column));
  const show = (layout: Layout, hidden = false) =>
    view.rerender(
      <QueryClientProvider client={client}>
        {createElement(Activity, {
          mode: hidden ? "hidden" : "visible",
          children: <Column layout={layout} jumping={jumping} />,
        })}
      </QueryClientProvider>,
    );
  return { client, column, jumping, scrollTo, show };
}

const releaseHold = () =>
  act(() => {
    document.body.dispatchEvent(new Event("keydown", { bubbles: true }));
  });

/** The split layout re-laid after the switch: its second box 50px lower. */
const RELAID: Layout = {
  ...LAYOUT,
  split: [
    { y: 300, h: 100 },
    { y: 750, h: 100 },
  ],
};

describe("useColumnLayoutAnchor", () => {
  // Unified box 800-1000 with the edge at 900 becomes Split's 700-800: the
  // edge lands halfway into it, so the box stays on screen.
  it("keeps the edge's proportional place in the box it falls inside", () => {
    const { client, scrollTo } = mountColumn();
    scrollTo(900);
    flipTo(client, "split");
    expect(top).toBe(750);
  });

  it("scales the edge's place up when the switch grows the box", () => {
    const { client, scrollTo } = mountColumn();
    flipTo(client, "split");
    releaseHold();
    scrollTo(750);
    flipTo(client, "unified");
    expect(top).toBe(900);
  });

  it("keeps the bottom of the box above narration at the edge", () => {
    const { client, scrollTo } = mountColumn();
    scrollTo(600);
    flipTo(client, "split");
    expect(top).toBe(500);
  });

  it("leaves scrollTop alone with no box at or above the edge", () => {
    const { client, column, scrollTo } = mountColumn();
    scrollTo(100);
    flipTo(client, "split");
    expect(top).toBe(100);
    expectNoHold(column);
  });

  // Split shortens both boxes, so the 3000px column becomes 2800px.
  it("stays at the bottom while it sits there", () => {
    const { client, column, scrollTo } = mountColumn();
    scrollTo(2600);
    flipTo(client, "split");
    expect(top).toBe(2800);
    expectHeldAt(column, 2800);
  });

  it("keeps the bottom when late rows regrow the column to its height before the switch", () => {
    const { client, scrollTo, show } = mountColumn();
    scrollTo(2600);
    flipTo(client, "split");
    expect(top).toBe(2800);
    // Split's boxes re-lay back to Unified's 400px total: the column is 3000px
    // again, as tall as the capture read.
    show({
      ...LAYOUT,
      split: [
        { y: 300, h: 200 },
        { y: 700, h: 200 },
      ],
    });
    act(resize);
    expect(top).toBe(3000);
  });

  it("stays at the bottom while the host animates the column there", () => {
    const { client, jumping, scrollTo } = mountColumn();
    scrollTo(900);
    jumping.current = true;
    flipTo(client, "split");
    expect(top).toBe(2800);
  });

  it("round-trips a second switch made inside the hold", () => {
    const { client, scrollTo } = mountColumn();
    scrollTo(900);
    flipTo(client, "split");
    expect(top).toBe(750);
    flipTo(client, "unified");
    expect(top).toBe(900);
    flipTo(client, "split");
    expect(top).toBe(750);
  });

  it("re-places a box that re-lays after the switch", () => {
    const { client, scrollTo, show } = mountColumn();
    scrollTo(900);
    flipTo(client, "split");
    show(RELAID);
    act(resize);
    expect(top).toBe(800);
  });

  it("re-places on a bare scroll event and keeps holding", () => {
    const { client, column, scrollTo, show } = mountColumn();
    scrollTo(900);
    flipTo(client, "split");
    top = 650;
    scrollEvent(column);
    expect(top).toBe(750);
    show(RELAID);
    act(resize);
    expect(top).toBe(800);
  });

  it.each(["wheel", "touchmove", "keydown", "pointerdown"])(
    "a %s anywhere ends the hold",
    (type) => {
      const { client, scrollTo, show } = mountColumn();
      scrollTo(900);
      flipTo(client, "split");
      act(() => {
        document.body.dispatchEvent(new Event(type, { bubbles: true }));
      });
      show(RELAID);
      act(resize);
      expect(top).toBe(750);
    },
  );

  it("ends the hold at the bound", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { client, scrollTo, show } = mountColumn();
    scrollTo(900);
    flipTo(client, "split");
    act(() => vi.advanceTimersByTime(RESTORE_BOUND_MS));
    show(RELAID);
    act(resize);
    expect(top).toBe(750);
  });

  it("restores on re-show after a switch made while hidden", () => {
    const { client, scrollTo, show } = mountColumn();
    scrollTo(900);
    show(LAYOUT, true);
    flipTo(client, "split");
    show(LAYOUT);
    expect(top).toBe(750);
  });

  it("leaves the column where it was on a re-show with no switch", () => {
    const { column, scrollTo, show } = mountColumn();
    scrollTo(900);
    show(LAYOUT, true);
    show(LAYOUT);
    expect(top).toBe(900);
    expectNoHold(column);
  });

  it("reads the boxes at a switch alone: never on a scroll, a mutation or a frame", async () => {
    const { client, column, scrollTo } = mountColumn();
    const query = vi.spyOn(column, "querySelectorAll");
    scrollTo(900);
    scrollEvent(column);
    for (const y of [1100, 1200]) {
      const box = document.createElement("div");
      box.setAttribute("data-transcript-diff", "");
      box.dataset.y = String(y);
      box.dataset.h = "50";
      column.append(box);
      await act(async () => undefined);
    }
    act(resize);
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    flipTo(client, "split");
    expect(query).toHaveBeenCalledTimes(1);
    expect(top).toBe(750);
  });
});

const EMPTY: Layout = { unified: [], split: [] };

/** One step box at 300 with width verdict `w`, as tall as what it draws:
 *  100px in Split, 200px in Unified (narrow boxes draw Unified). */
const boxAt = (w: Verdict | undefined, k = "a"): Layout => ({
  split: [{ y: 300, h: w === "narrow" ? 200 : 100, k, w }],
  unified: [{ y: 300, h: 200, k, w }],
});

// What only these cells show; the matrix below covers the rest of the
// triggers and the non-triggers.
describe("useColumnLayoutAnchor: a restore follows a box already drawn", () => {
  it("restores when an open box widens back over the floor", () => {
    const { scrollTo, show } = mountColumn({
      layout: boxAt("narrow"),
      mode: "split",
    });
    scrollTo(400);
    show(boxAt("wide"));
    expect(top).toBe(350);
  });

  it("restores when a box re-measured on a re-show crossed the floor", () => {
    const { scrollTo, show } = mountColumn({
      layout: boxAt("wide"),
      mode: "split",
    });
    scrollTo(350);
    show(boxAt("wide"), true);
    show(boxAt("wide"));
    expect(top).toBe(350);
    show(boxAt("narrow"));
    expect(top).toBe(400);
  });

  it("restores a box opened after the last narrow one closed, once it narrows", () => {
    const { scrollTo, show } = mountColumn({
      layout: boxAt("narrow", "x"),
      mode: "split",
    });
    show(EMPTY);
    show(boxAt("pending", "y"));
    show(boxAt("wide", "y"));
    scrollTo(350);
    show(boxAt("narrow", "y"));
    expect(top).toBe(400);
  });

  it("holds nothing on a switch over boxes their width holds in Unified", () => {
    const { client, column, scrollTo } = mountColumn({
      layout: boxAt("narrow"),
      mode: "split",
    });
    scrollTo(900);
    flipTo(client, "unified");
    expect(top).toBe(900);
    expectNoHold(column);
  });
});

/** A matrix step: GAP px of narration ahead of it, 100px tall in Split and
 *  200px in Unified (a narrow step draws Unified). */
interface Step {
  k: string;
  w: Verdict;
}
const A: Step = { k: "a", w: "wide" };
const B: Step = { k: "b", w: "wide" };

/** `steps` laid out under each setting. */
function laidOut(steps: readonly Step[]): Layout {
  const under = (mode: Mode) => {
    let y = 0;
    return steps.map((step): Box => {
      y += GAP;
      const h = drawnLayout(step.w === "narrow", mode) === "split" ? 100 : 200;
      const box = { y, h, k: step.k, w: step.w };
      y += h;
      return box;
    });
  };
  return { unified: under("unified"), split: under("split") };
}

const extent = (b: Box): ColumnBox => ({ top: b.y, bottom: b.y + b.h });

/** Where a restore puts the edge: the box the edge fell against before the
 *  switch, among those still there after it, keeps its place. */
function expectedTop(pre: readonly Box[], post: readonly Box[], y: number) {
  const kept = pre.filter((b) => post.some((p) => p.k === b.k));
  const picked = pickColumnAnchor(kept.map(extent), y);
  const k = picked === null ? undefined : kept[picked.index]?.k;
  const box = post.find((p) => p.k === k);
  return picked === null || box === undefined
    ? y
    : columnScrollTop(extent(box), picked);
}

type Mounted = ReturnType<typeof mountColumn>;

interface Trigger {
  /** The setting at mount and after the switch. */
  from: Mode;
  to: Mode;
  /** What the switch does to the steps (before any it removes). */
  steps: (steps: Step[]) => Step[];
  /** Switches the column so the switch's own commit renders `post`. */
  run: (m: Mounted, pre: Step[], post: Step[]) => void;
}

const narrowed = (steps: Step[]) =>
  steps.map((s) => (s.w === "wide" ? { ...s, w: "narrow" as const } : s));

const TRIGGERS: Record<string, Trigger> = {
  "a setting flip": {
    from: "unified",
    to: "split",
    steps: (steps) => steps,
    run: (m, pre, post) => {
      m.show({ unified: laidOut(pre).unified, split: laidOut(post).split });
      flipTo(m.client, "split");
    },
  },
  "a width crossing": {
    from: "split",
    to: "split",
    steps: narrowed,
    run: (m, _pre, post) => m.show(laidOut(post)),
  },
  "a re-show after a hidden flip": {
    from: "unified",
    to: "split",
    steps: (steps) => steps,
    run: (m, pre, post) => {
      m.show(laidOut(pre), true);
      flipTo(m.client, "split");
      m.show(laidOut(post));
    },
  },
  "a re-show, then a crossing": {
    from: "split",
    to: "split",
    steps: narrowed,
    run: (m, pre, post) => {
      m.show(laidOut(pre), true);
      m.show(laidOut(pre));
      m.show(laidOut(post));
    },
  },
};

interface State {
  /** The edge sits at the column's bottom rather than mid-b. */
  pinned?: boolean;
  /** The edge is there from mount on, with no scroll since. */
  fromMount?: boolean;
  /** Commits between the scroll and the switch; returns the steps shown. */
  before?: (m: Mounted) => Step[];
  /** A step the switch's own commit removes. */
  leaves?: string;
}

const STATES: Record<string, State> = {
  "a silent scroll": {},
  "a silent scroll to the bottom": { pinned: true },
  "the anchor step closed in an earlier commit": {
    before: (m) => {
      m.show(laidOut([A]));
      return [A];
    },
  },
  "the anchor step closing in the switch's commit": { leaves: "b" },
  "a step first measured in the commit before": {
    before: (m) => {
      m.show(laidOut([{ k: "c", w: "pending" }, A, B]));
      m.show(laidOut([{ k: "c", w: "wide" }, A, B]));
      return [{ k: "c", w: "wide" }, A, B];
    },
  },
  "nothing since mount": { fromMount: true },
};

const CELLS = Object.entries(TRIGGERS).flatMap(([trigger, t]) =>
  Object.entries(STATES).map(([state, s]) => [trigger, state, t, s] as const),
);

// The oracle is computed from the layout the reader saw before the switch, so
// each cell's number follows its own geometry.
describe("useColumnLayoutAnchor: every trigger over every last state", () => {
  it.each(CELLS)("%s after %s", (_trigger, _state, t, s) => {
    const mid = laidOut([A, B])[t.from][1];
    const y = s.pinned ? 2600 : (mid?.y ?? 0) + (mid?.h ?? 0) / 2;
    if (s.fromMount) top = y;
    const m = mountColumn({ layout: laidOut([A, B]), mode: t.from });
    if (!s.fromMount) m.scrollTo(y);
    const pre = s.before?.(m) ?? [A, B];
    const post = t.steps(pre).filter((step) => step.k !== s.leaves);
    t.run(m, pre, post);
    if (s.pinned) {
      // Every trigger changes the boxes' heights, so the bottom moved.
      const height = (boxes: Box[]) => boxes.reduce((h, b) => h + b.h, 2600);
      const bottom = height(laidOut(post)[t.to]);
      expect(bottom).not.toBe(height(laidOut(pre)[t.from]));
      // The hold writes the bottom unless the column already sits there.
      expect(top).toBe(Math.abs(bottom - 400 - y) > 1 ? bottom : y);
      expectHeldAt(m.column, bottom);
      return;
    }
    const want = expectedTop(laidOut(pre)[t.from], laidOut(post)[t.to], y);
    expect(top).toBe(want);
    expectHeldAt(m.column, want);
  });

  // Each holds no place: the reader's scroll stays where it lands.
  it.each([
    {
      name: "a step's first measurement, narrow in a Split column",
      mode: "split" as const,
      from: EMPTY,
      steps: [boxAt("pending"), boxAt("narrow")],
    },
    {
      name: "a step opening already measured",
      mode: "split" as const,
      from: EMPTY,
      steps: [boxAt("narrow")],
    },
    {
      name: "the last narrow step closing",
      mode: "split" as const,
      from: boxAt("narrow"),
      steps: [EMPTY],
    },
    {
      name: "a crossing under Unified",
      mode: "unified" as const,
      from: boxAt("wide"),
      steps: [boxAt("narrow")],
    },
  ])("holds nothing on $name", ({ mode, from, steps }) => {
    const { column, scrollTo, show } = mountColumn({ layout: from, mode });
    scrollTo(350);
    for (const layout of steps) show(layout);
    expect(top).toBe(350);
    expectNoHold(column);
  });
});

/** Two boxes keyed a and b, so closing one keeps the other's element. */
const TWO: Layout = {
  unified: [
    { y: 300, h: 200, k: "a" },
    { y: 800, h: 200, k: "b" },
  ],
  split: [
    { y: 300, h: 100, k: "a" },
    { y: 700, h: 100, k: "b" },
  ],
};
const ONLY_A: Layout = {
  unified: [{ y: 300, h: 200, k: "a" }],
  split: [{ y: 300, h: 100, k: "a" }],
};

// A restore reads the column the reader saw before the switch, among the
// boxes still there after it: a step closing, a step above moving the rest, a
// hold ending, or a second route's switch landing inside a hold.
describe("useColumnLayoutAnchor: a restore reads the boxes still there", () => {
  it("keeps a box still there when the anchor step closed before the switch", () => {
    const { client, scrollTo, show } = mountColumn({ layout: TWO });
    scrollTo(900);
    show(ONLY_A);
    flipTo(client, "split");
    // a's bottom stays 400px above the edge: Split's a ends at 400.
    expect(top).toBe(800);
  });

  it("follows a box that a step closing above it moved", () => {
    const { client, scrollTo, show } = mountColumn({ layout: TWO });
    scrollTo(900);
    // a closes: b moves up to 300 with no scroll and no resize of its own.
    show({
      unified: [{ y: 300, h: 200, k: "b" }],
      split: [{ y: 300, h: 100, k: "b" }],
    });
    flipTo(client, "split");
    // The edge now sits 400px under b's bottom, which Split puts at 400.
    expect(top).toBe(800);
  });

  it("reads the column afresh after a hold whose step closed during it", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { client, scrollTo, show } = mountColumn({ layout: TWO });
    scrollTo(900);
    flipTo(client, "split");
    expect(top).toBe(750);
    show(ONLY_A);
    act(() => vi.advanceTimersByTime(RESTORE_BOUND_MS));
    flipTo(client, "unified");
    // a's bottom stays 350px above the edge: Unified's a ends at 500.
    expect(top).toBe(850);
  });

  it("holds a box still there when a switch lands during a crossing's hold whose box left", () => {
    const wide = (h: number, w: Verdict = "wide") => ({ y: 300, h, k: "a", w });
    const { client, scrollTo, show } = mountColumn({
      layout: {
        unified: [wide(200), { y: 800, h: 200, k: "b", w: "wide" }],
        split: [wide(100), { y: 700, h: 100, k: "b", w: "wide" }],
      },
      mode: "split",
    });
    scrollTo(750);
    show({
      unified: [wide(200), { y: 800, h: 200, k: "b", w: "narrow" }],
      split: [wide(100), { y: 700, h: 200, k: "b", w: "narrow" }],
    });
    expect(top).toBe(800);
    show({ unified: [wide(200)], split: [wide(100)] });
    flipTo(client, "unified");
    // a's bottom was 400px above the edge when the switch came.
    expect(top).toBe(900);
    // a re-lays taller under the new hold: its bottom keeps the edge 400px down.
    show({ unified: [wide(300)], split: [wide(100)] });
    act(resize);
    expect(top).toBe(1000);
  });

  it("holds a box still there when a crossing lands during a switch's hold whose box left", () => {
    const a = (h: number, w: Verdict = "wide") => ({ y: 300, h, k: "a", w });
    const { client, scrollTo, show } = mountColumn({ layout: TWO });
    scrollTo(900);
    flipTo(client, "split");
    expect(top).toBe(750);
    show({ unified: [a(200)], split: [a(100)] });
    show({ unified: [a(200, "narrow")], split: [a(200, "narrow")] });
    // a's bottom was 350px above the edge when the crossing came.
    expect(top).toBe(850);
    // a re-lays taller under the new hold: its bottom keeps the edge 350px down.
    show({ unified: [a(300, "narrow")], split: [a(300, "narrow")] });
    act(resize);
    expect(top).toBe(950);
  });

  it("holds a box still there when the anchor box leaves in the switch's own commit", () => {
    const { client, scrollTo, show } = mountColumn({
      layout: { unified: TWO.unified, split: ONLY_A.split },
    });
    scrollTo(900);
    flipTo(client, "split");
    // a's bottom stays 400px above the edge: Split's a ends at 400.
    expect(top).toBe(800);
    // a re-lays taller under the hold: its bottom keeps the edge 400px down.
    show({ unified: TWO.unified, split: [{ y: 300, h: 200, k: "a" }] });
    act(resize);
    expect(top).toBe(900);
  });
});

/** A finished session whose turn holds edit steps on x and y. */
const TWO_STEPS = {
  id: "s1",
  repoPath: "/repo",
  worktreePath: "/repo",
  branch: "gd/session/s1",
  base: "b0",
  headHash: "b0",
  running: false,
  kept: false,
  turns: [
    {
      prompt: "go",
      narration: "done",
      status: "done",
      statusText: "",
      commitHash: null,
      costUsd: null,
      error: null,
      segments: [
        { type: "text", text: "First." },
        { type: "tool", tool: "edit", target: "/repo/x" },
        { type: "text", text: "Then." },
        { type: "tool", tool: "edit", target: "/repo/y" },
      ],
    },
  ],
} as unknown as AgentSession;

/** Every open step's measured box reports `width`. */
function measureSteps(width: number) {
  paneWidth = width;
  act(() => {
    for (const observer of observers)
      for (const target of observer.targets)
        if (target.matches(".max-h-96.overflow-auto"))
          observer.callback(
            [
              {
                target,
                borderBoxSize: [{ inlineSize: width, blockSize: 0 }],
                contentRect: { width },
              } as unknown as ResizeObserverEntry,
            ],
            observer as unknown as ResizeObserver,
          );
  });
}

describe("the session column as its steps open and close", () => {
  async function mountSession(mode: Mode) {
    stubLayout();
    vi.mocked(gitSessionFileDiff).mockImplementation(async () => diffOf(TEXT));
    const client = newClient();
    flipTo(client, mode);
    const { container } = render(
      <SessionConversation
        session={TWO_STEPS}
        repoPath="/repo"
        terminalOpen={false}
      />,
      { wrapper: wrap(client) },
    );
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto");
    if (!scroller) throw new Error("no column scroller");
    const [x, y] = screen.getAllByRole("button", { expanded: false });
    if (!x || !y) throw new Error("no steps");
    return { scroller, scrollTo: asScroller(scroller), x, y };
  }

  // The measured box mounts unmeasured and takes its width in the commit
  // right after (useContainerWidth's ref), as in the app.
  it("holds nothing when a step opens narrow in a Split column", async () => {
    paneWidth = 500;
    const user = userEvent.setup();
    const { scroller, x } = await mountSession("split");
    // Pinned to the bottom of the 3000px column.
    top = 2600;
    await user.click(x);
    expect(
      (await screen.findByTestId("diff-view")).getAttribute("data-h"),
    ).toBe("200");
    // A scroll nobody's input started stays where it lands: no hold.
    top = 2000;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(top).toBe(2000);
  });

  it("restores a step that narrows past the floor after a narrow one closed", async () => {
    paneWidth = 500;
    const user = userEvent.setup();
    const { scrollTo, x, y } = await mountSession("split");
    await user.click(x);
    await screen.findByTestId("diff-view");
    await user.click(x);
    await waitFor(() => expect(screen.queryByTestId("diff-view")).toBeNull());
    paneWidth = 1000;
    await user.click(y);
    await waitFor(() =>
      expect(screen.getByTestId("diff-view").getAttribute("data-h")).toBe(
        "100",
      ),
    );
    // Split: y's box is 300-400, the edge halfway into it.
    scrollTo(350);
    measureSteps(500);
    await waitFor(() =>
      expect(screen.getByTestId("diff-view").getAttribute("data-h")).toBe(
        "200",
      ),
    );
    act(resize);
    // Unified: y's box is 300-500, the edge halfway into it.
    expect(top).toBe(400);
  });
});

describe("the session column across a switch", () => {
  it("keeps the step box the column's edge falls inside", async () => {
    stubLayout();
    const user = userEvent.setup();
    vi.mocked(gitSessionFileDiff).mockImplementation(async () => diffOf(TEXT));
    const client = newClient();
    const { container } = render(
      <SessionConversation
        session={TWO_STEPS}
        repoPath="/repo"
        terminalOpen={false}
      />,
      { wrapper: wrap(client) },
    );
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto");
    if (!scroller) throw new Error("no column scroller");
    const scrollTo = asScroller(scroller);
    for (const step of screen.getAllByRole("button", { expanded: false }))
      await user.click(step);
    await waitFor(() =>
      expect(screen.getAllByTestId("diff-view")).toHaveLength(2),
    );
    // Unified: boxes at 300-500 and 800-1000; the edge 100px into the second.
    scrollTo(900);
    flipTo(client, "split");
    act(resize);
    // Split: the second box is 700-800, the edge halfway into it.
    expect(top).toBe(750);
  });

  it("keeps it when the column narrows past Split's floor and the steps draw Unified", async () => {
    stubLayout();
    const user = userEvent.setup();
    vi.mocked(gitSessionFileDiff).mockImplementation(async () => diffOf(TEXT));
    const client = newClient();
    flipTo(client, "split");
    const { container } = render(
      <SessionConversation
        session={TWO_STEPS}
        repoPath="/repo"
        terminalOpen={false}
      />,
      { wrapper: wrap(client) },
    );
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto");
    if (!scroller) throw new Error("no column scroller");
    const scrollTo = asScroller(scroller);
    for (const step of screen.getAllByRole("button", { expanded: false }))
      await user.click(step);
    await waitFor(() =>
      expect(screen.getAllByTestId("diff-view")).toHaveLength(2),
    );
    // Split: boxes at 300-400 and 700-800; the edge halfway into the second.
    scrollTo(750);
    // Each step's measured box reports a width under Split's floor.
    measureSteps(500);
    await waitFor(() =>
      expect(
        screen.getAllByTestId("diff-view").map((v) => v.getAttribute("data-h")),
      ).toEqual(["200", "200"]),
    );
    act(resize);
    // Unified: the second box is 800-1000, the edge halfway into it.
    expect(top).toBe(900);
  });
});

/** A step read the stand-in draws as GitDiffView's rowless `arm`. */
const armDiff = (arm: string) => diffOf(TEXT.replace("+other", `+${arm}`));

/** A step that draws no diff rows, and the exact text its box settles on
 *  (null: nothing beyond the step's own chrome). */
type Rowless = [name: string, answer: FileDiff, settled: string | null];

const BLOCKED: Rowless = [
  "a blocked mega-line step",
  armDiff("blocked"),
  "Looks like a generated or minified file",
];
const GRAMMAR: Rowless = ["a grammar hold", armDiff("grammar"), null];

/** Mounts TWO_STEPS under `mode`, its column laid out by its
 *  boxes, each step's read answering by its file, and opens `open` in order,
 *  resolving once each opened box shows what it settles on. */
async function openSteps(
  answers: Record<"x" | "y", Rowless | FileDiff>,
  open: readonly ("x" | "y")[],
  mode: Mode = "unified",
) {
  stubLayout();
  const of = (k: "x" | "y") => {
    const answer = answers[k];
    return Array.isArray(answer) ? answer : (["rows", answer, null] as const);
  };
  vi.mocked(gitSessionFileDiff).mockImplementation(
    async (_repo, path) => of(path.endsWith("y") ? "y" : "x")[1],
  );
  const client = newClient();
  flipTo(client, mode);
  const user = userEvent.setup();
  const view = render(
    <SessionConversation
      session={TWO_STEPS}
      repoPath="/repo"
      terminalOpen={false}
    />,
    { wrapper: wrap(client) },
  );
  const scroller =
    view.container.querySelector<HTMLElement>(".overflow-y-auto");
  if (!scroller) throw new Error("no column scroller");
  const scrollTo = asScroller(scroller, boxedHeight(scroller));
  const [x, y] = screen.getAllByRole("button", { expanded: false });
  if (!x || !y) throw new Error("no steps");
  for (const k of open) {
    await user.click(k === "x" ? x : y);
    const [arm, , settled] = of(k);
    if (arm === "rows") await screen.findByTestId("diff-view");
    else if (settled !== null) await screen.findByText(settled);
    else
      await waitFor(() => {
        expect(gitSessionFileDiff).toHaveBeenCalled();
        expect(screen.queryAllByText("Loading diff…")).toHaveLength(0);
      });
  }
  /** 30px above the bottom: inside the pinned band, so a pinned restore
   *  that wrote the bottom would move it. */
  const nearBottom = () => {
    scrollTo(scroller.scrollHeight - scroller.clientHeight - 30);
    return top;
  };
  return {
    client,
    scroller,
    scrollTo,
    nearBottom,
    user,
  };
}

describe("the session column over steps that draw no diff rows", () => {
  // Every InlineDiff arm but the rows (no mark), and every GitDiffView arm
  // inside the rows arm that draws no rows (marked): none changes height on a
  // switch.
  const ARMS: Rowless[] = [
    [
      "a binary step",
      { ...diffOf(""), isBinary: true },
      "Binary file — no text diff.",
    ],
    [
      "a mode-only step",
      diffOf("diff --git a/x b/x\nold mode 100644\nnew mode 100755\n"),
      "File is now executable.",
    ],
    ["an empty step", diffOf(""), "No changes to show."],
    [
      "a whitespace-only step",
      { ...diffOf(""), whitespaceOnly: true },
      "Only whitespace changed in this file.",
    ],
    BLOCKED,
    [
      "a renderer error fallback",
      armDiff("error"),
      "This file's diff couldn't be displayed.",
    ],
    ["a chunk Suspense fallback", armDiff("suspense"), "Loading the diff…"],
    GRAMMAR,
    ["a rowless build", armDiff("unbuilt"), "No changes to show"],
  ];
  it.each(ARMS)("keeps %s's column put on a switch", async (...arm) => {
    if (arm[0] === "a renderer error fallback")
      vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { client, nearBottom, scroller } = await openSteps(
      { x: arm, y: arm },
      ["x"],
    );
    const at = nearBottom();
    flipTo(client, "split");
    act(resize);
    expect(top).toBe(at);
    expectNoHold(scroller);
  });

  it("keeps a blocked step's column put at the exact bottom", async () => {
    const { client, scroller, scrollTo } = await openSteps(
      { x: BLOCKED, y: BLOCKED },
      ["x"],
    );
    const bottom = scroller.scrollHeight - scroller.clientHeight;
    scrollTo(bottom);
    flipTo(client, "split");
    act(resize);
    expect(top).toBe(bottom);
  });

  it("keeps the place in a blocked step shown anyway", async () => {
    const { client, scrollTo, user } = await openSteps(
      { x: BLOCKED, y: BLOCKED },
      ["x"],
    );
    await user.click(screen.getByRole("button", { name: "Show diff anyway" }));
    await screen.findByTestId("diff-view");
    // Unified: x's box is 300-500, the edge halfway into it.
    scrollTo(400);
    flipTo(client, "split");
    expect(top).toBe(350);
  });

  it("restores nothing when a step blocked at the switch is shown anyway", async () => {
    const { client, nearBottom, scroller, user } = await openSteps(
      { x: BLOCKED, y: BLOCKED },
      ["x"],
    );
    const at = nearBottom();
    flipTo(client, "split");
    await user.click(screen.getByRole("button", { name: "Show diff anyway" }));
    await screen.findByTestId("diff-view");
    act(resize);
    expect(top).toBe(at);
    expectNoHold(scroller);
  });

  it("moves no column scrolled up when a held grammar lands after the switch", async () => {
    const { client, scroller, scrollTo } = await openSteps(
      { x: GRAMMAR, y: BLOCKED },
      ["x"],
    );
    // Above x's box at 300: no box at or above the edge.
    scrollTo(100);
    flipTo(client, "split");
    landGrammar();
    await screen.findByTestId("diff-view");
    act(resize);
    expect(top).toBe(100);
    expectNoHold(scroller);
  });

  it("follows the bottom of a column whose rows changed beside a blocked step", async () => {
    const { client, nearBottom, scroller } = await openSteps(
      { x: BLOCKED, y: diffOf(TEXT) },
      ["x", "y"],
    );
    const at = nearBottom();
    const was = scroller.scrollHeight;
    flipTo(client, "split");
    act(resize);
    // y's rows shrink from 200 to 100px in Split.
    expect(scroller.scrollHeight).toBe(was - 100);
    expect(top).not.toBe(at);
    expect(top).toBe(scroller.scrollHeight);
  });

  // SessionConversation's stream effect replays on a re-show and re-pins a
  // stuck column itself, so the hook is read alone: a marked box that keeps its
  // 40px in both layouts, as a blocked step's does.
  it("keeps a blocked step's column put on a re-show after a hidden flip", () => {
    const blocked: Layout = {
      unified: [{ y: 300, h: 40 }],
      split: [{ y: 300, h: 40 }],
    };
    const { client, column, scrollTo, show } = mountColumn({ layout: blocked });
    scrollTo(2210);
    show(blocked, true);
    flipTo(client, "split");
    show(blocked);
    act(resize);
    expect(top).toBe(2210);
    expectNoHold(column);
  });

  it("keeps a blocked step's column put when its width crosses Split's floor", async () => {
    const { nearBottom, scroller } = await openSteps(
      { x: BLOCKED, y: BLOCKED },
      ["x"],
      "split",
    );
    const at = nearBottom();
    measureSteps(500);
    act(resize);
    expect(top).toBe(at);
    expectNoHold(scroller);
  });
});

describe("the session column's own jumps", () => {
  /** TWO_STEPS with `turns` copies of its turn. */
  const withTurns = (turns: number) =>
    ({
      ...TWO_STEPS,
      turns: Array.from({ length: turns }, (_, i) => ({
        ...TWO_STEPS.turns[0],
        prompt: `go ${i}`,
      })),
    }) as unknown as AgentSession;

  /** Mounts one turn, opens its x step and scrolls the reader into x's box
   *  (Unified 300-500) with the scroll event, so the column is not stuck. */
  async function readStep() {
    stubLayout();
    vi.mocked(gitSessionFileDiff).mockImplementation(async () => diffOf(TEXT));
    const user = userEvent.setup();
    const client = newClient();
    const view = render(
      <SessionConversation
        session={withTurns(1)}
        repoPath="/repo"
        terminalOpen={false}
      />,
      { wrapper: wrap(client) },
    );
    const scroller =
      view.container.querySelector<HTMLElement>(".overflow-y-auto");
    if (!scroller) throw new Error("no column scroller");
    asScroller(scroller);
    const [x] = screen.getAllByRole("button", { expanded: false });
    if (!x) throw new Error("no step");
    await user.click(x);
    await screen.findByTestId("diff-view");
    top = 400;
    scrollEvent(scroller);
    /** The reader sends a second turn: the column jumps to its end, and no
     *  scroll event has reported it yet. */
    const sendTurn = () =>
      view.rerender(
        <SessionConversation
          session={withTurns(2)}
          repoPath="/repo"
          terminalOpen={false}
        />,
      );
    return { client, scroller, sendTurn };
  }

  it("stays at the bottom across a switch right after the jump to a new turn", async () => {
    const { client, sendTurn } = await readStep();
    sendTurn();
    expect(top).toBe(3000);
    flipTo(client, "split");
    expect(top).toBe(3000);
  });

  it("lands on a new turn sent while a switch holds the column", async () => {
    const { client, scroller, sendTurn } = await readStep();
    flipTo(client, "split");
    // Halfway into x's 200px box stays halfway into its 100px one.
    expect(top).toBe(350);
    sendTurn();
    expect(top).toBe(3000);
    // The jump's own scroll event arrives after it.
    scrollEvent(scroller);
    expect(top).toBe(3000);
  });
});

describe("the session column during a live turn", () => {
  /** A running session whose live turn shows `segments`. */
  const live = (segments: unknown[]) =>
    ({
      id: "s1",
      repoPath: "/repo",
      worktreePath: "/repo",
      branch: "gd/session/s1",
      base: "b0",
      headHash: "b0",
      running: true,
      kept: false,
      turns: [
        {
          prompt: "go",
          narration: "Working.",
          status: "running",
          statusText: "",
          commitHash: null,
          costUsd: null,
          error: null,
          segments,
        },
      ],
    }) as unknown as AgentSession;
  const first = [{ type: "text", text: "Working." }];
  const stepped = [...first, { type: "tool", tool: "read", target: "/repo/a" }];

  /** Mounts the column over `first`, laid out `height` px tall with a 400px
   *  viewport, and returns how to append the step. */
  function mountLive() {
    let height = 3000;
    const view = render(
      <SessionConversation
        session={live(first)}
        repoPath="/repo"
        terminalOpen={false}
      />,
      { wrapper: wrap(newClient()) },
    );
    const scroller =
      view.container.querySelector<HTMLElement>(".overflow-y-auto");
    if (!scroller) throw new Error("no column scroller");
    asScroller(scroller);
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: () => height,
    });
    /** A user scroll to `y`. */
    const scrollTo = (y: number) => {
      top = y;
      act(() => {
        scroller.dispatchEvent(new Event("scroll"));
      });
    };
    const appendStep = () => {
      height += 34;
      view.rerender(
        <SessionConversation
          session={live(stepped)}
          repoPath="/repo"
          terminalOpen={false}
        />,
      );
    };
    return { scrollTo, appendStep };
  }

  it("follows a step appended to the live turn while pinned to the bottom", () => {
    const { scrollTo, appendStep } = mountLive();
    scrollTo(2600);
    appendStep();
    expect(top).toBe(3034);
  });

  it("leaves a reader scrolled up where they are when a step is appended", () => {
    const { scrollTo, appendStep } = mountLive();
    scrollTo(1000);
    appendStep();
    expect(top).toBe(1000);
  });
});
