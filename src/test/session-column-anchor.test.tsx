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
import { AgentTranscript } from "@/features/sessions/AgentTranscript";
import { SessionConversation } from "@/features/sessions/SessionConversation";
import type { AgentSession } from "@/features/sessions/store";
import {
  type ColumnBox,
  columnScrollTop,
  pickColumnAnchor,
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

/** Every `scrollerRef` the diff view stand-in was rendered with. */
const seen = vi.hoisted(() => ({ refs: [] as unknown[] }));

// The diff view is a stand-in: the host's wiring is what these tests read. It
// is laid out by the setting's mode (`data-h`), as the real rows are.
vi.mock("@/features/diff/DiffSurfaceLazy", async (importOriginal) => {
  const { useSettings: useSettingsMode } = await import(
    "@/lib/settings/queries"
  );
  return {
    ...(await importOriginal<
      typeof import("@/features/diff/DiffSurfaceLazy")
    >()),
    GitDiffView: function GitDiffViewStandIn(props: DiffViewProps) {
      seen.refs.push(props.scrollerRef);
      const mode = useSettingsMode().data?.diffViewMode ?? "unified";
      return (
        <div data-testid="diff-view" data-h={mode === "split" ? 100 : 200}>
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
let frames: FrameRequestCallback[] = [];

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
  top = 0;
  frames = [];
  observers = [];
  vi.mocked(loadSettings).mockImplementation(async () => DEFAULT_SETTINGS);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Lays boxes out by content coordinates against the column's scrollTop:
 *  `data-y`/`data-h` where set, else the transcript model above. */
function stubLayout() {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
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
      return { top: 0, bottom: 0 } as DOMRect;
    },
  );
}

/** Gives `scroller` a scrollTop backed by `top`, a 3000px content height and
 *  a 400px viewport (0 while an <Activity> hides it). */
function asScroller(scroller: HTMLElement) {
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v;
    },
  });
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    get: () => 3000,
  });
  Object.defineProperty(scroller, "clientHeight", {
    configurable: true,
    get: () => (scroller.style.display === "none" ? 0 : 400),
  });
  /** A user scroll: the event, then the sampling frame. */
  return (y: number) => {
    top = y;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
      const due = frames;
      frames = [];
      for (const frame of due) frame(0);
    });
  };
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
type Layout = Record<Mode, { y: number; h: number }[]>;

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
  stick,
}: {
  layout: Layout;
  stick: { current: boolean };
}) {
  const ref = useRef<HTMLDivElement>(null);
  useColumnLayoutAnchor(ref, stick);
  const mode = useSettings().data?.diffViewMode ?? "unified";
  return (
    <div ref={ref} data-testid="column">
      {layout[mode].map((b, i) => (
        <div key={i} data-transcript-diff="" data-y={b.y} data-h={b.h} />
      ))}
    </div>
  );
}

function mountColumn(stuck = false) {
  stubLayout();
  const client = newClient();
  const stick = { current: stuck };
  const view = render(
    <QueryClientProvider client={client}>
      {createElement(Activity, {
        mode: "visible",
        children: <Column layout={LAYOUT} stick={stick} />,
      })}
    </QueryClientProvider>,
  );
  const scrollTo = asScroller(view.getByTestId("column"));
  const show = (layout: Layout, hidden = false) =>
    view.rerender(
      <QueryClientProvider client={client}>
        {createElement(Activity, {
          mode: hidden ? "hidden" : "visible",
          children: <Column layout={layout} stick={stick} />,
        })}
      </QueryClientProvider>,
    );
  return { client, scrollTo, show, unmount: view.unmount };
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
    const { client, scrollTo } = mountColumn();
    scrollTo(100);
    flipTo(client, "split");
    expect(top).toBe(100);
  });

  it("stays at the bottom while pinned there", () => {
    const { client, scrollTo } = mountColumn(true);
    scrollTo(900);
    flipTo(client, "split");
    expect(top).toBe(3000);
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
    const { client, scrollTo, show } = mountColumn();
    scrollTo(900);
    flipTo(client, "split");
    scrollTo(650);
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

  it("restores on re-show after a switch made while hidden", async () => {
    const { client, scrollTo, show } = mountColumn();
    scrollTo(900);
    show(LAYOUT, true);
    flipTo(client, "split");
    show(LAYOUT);
    await act(async () => undefined);
    expect(top).toBe(750);
  });

  it("leaves the column where it was on a re-show with no switch", async () => {
    const { scrollTo, show } = mountColumn();
    scrollTo(900);
    show(LAYOUT, true);
    show(LAYOUT);
    await act(async () => undefined);
    expect(top).toBe(900);
    // Nothing holds it either: a box re-laid now leaves the column alone.
    show({
      ...LAYOUT,
      unified: [
        { y: 300, h: 200 },
        { y: 850, h: 200 },
      ],
    });
    act(resize);
    expect(top).toBe(900);
  });

  it("queries the boxes once per frame however many mutations land in it", async () => {
    mountColumn();
    const column = screen.getByTestId("column");
    const query = vi.spyOn(column, "querySelectorAll");
    const added: HTMLElement[] = [];
    for (const y of [1100, 1200, 1300, 1400, 1500]) {
      const box = document.createElement("div");
      box.setAttribute("data-transcript-diff", "");
      box.dataset.y = String(y);
      box.dataset.h = "50";
      column.append(box);
      added.push(box);
      // Each append's mutation record is delivered on its own.
      await act(async () => undefined);
    }
    expect(query).not.toHaveBeenCalled();
    act(() => {
      const due = frames;
      frames = [];
      for (const frame of due) frame(0);
    });
    expect(query).toHaveBeenCalledTimes(1);
    // Every box added in the frame is watched for its next resize.
    expect(
      observers.some((o) => added.every((box) => o.targets.has(box))),
    ).toBe(true);
  });

  it("cancels a pending scroll frame on unmount after a resize read the anchor", () => {
    const { unmount } = mountColumn();
    const column = screen.getByTestId("column");
    top = 900;
    act(() => {
      column.dispatchEvent(new Event("scroll"));
    });
    const pending = vi
      .mocked(window.requestAnimationFrame)
      .mock.results.at(-1)?.value;
    expect(pending).toBeGreaterThan(0);
    act(resize);
    unmount();
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(pending);
  });
});

describe("the session column across a switch", () => {
  it("keeps the step box the column's edge falls inside", async () => {
    stubLayout();
    const user = userEvent.setup();
    vi.mocked(gitSessionFileDiff).mockImplementation(async () => diffOf(TEXT));
    const session = {
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
    const client = newClient();
    const { container } = render(
      <SessionConversation
        session={session}
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
