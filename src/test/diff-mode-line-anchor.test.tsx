import { act, render } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useModeLineAnchor } from "@/features/diff/DiffSurface";
import { RESTORE_BOUND_MS } from "@/features/diff/diff-rows";

// The split/unified line anchor's runtime wiring, over hand-laid rows: jsdom
// has no layout, so each row carries its content-coordinate box (data-y,
// data-h) and the rect stub below reads it against the scroller's scrollTop.
// Split rows are 20px tall, unified rows 30px, so a kept scrollTop shows
// another line after a switch.

type Mode = "split" | "unified";
const ROW_H: Record<Mode, number> = { split: 20, unified: 30 };

const range = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => from + i);

function Rows({ mode, lines }: { mode: Mode; lines: number[] }) {
  const h = ROW_H[mode];
  return (
    <table>
      <tbody>
        {lines.map((n, i) =>
          mode === "split" ? (
            <tr key={n} data-line="" data-y={i * h} data-h={h}>
              <td data-side="old">
                <span data-line-num={n} />
              </td>
              <td data-side="new">
                <span data-line-num={n} />
              </td>
            </tr>
          ) : (
            <tr key={n} data-line="" data-y={i * h} data-h={h}>
              <td>
                <span data-line-old-num={n} data-line-new-num={n} />
              </td>
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}

interface HarnessProps {
  mode: Mode;
  lines: number[];
  /** False while the layout's rows haven't rendered yet. */
  ready?: boolean;
  content: object;
}

function Harness({ mode, lines, ready = true, content }: HarnessProps) {
  const ref = useRef<HTMLDivElement>(null);
  useModeLineAnchor(ref, mode, "src/a.ts", content);
  return (
    <div ref={ref} data-testid="scroller">
      {ready && <Rows mode={mode} lines={lines} />}
      <button type="button" data-testid="inside" />
    </div>
  );
}

/** The resize observers the hook made: setup.ts's shim never fires, and a
 *  re-laid layout is what these tests need to drive. */
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

/** A layout re-laid under the scroller: every observer still watching a
 *  mounted element hears of it. */
function resize() {
  for (const observer of observers)
    if ([...observer.targets].some((target) => target.isConnected))
      observer.callback([], observer as unknown as ResizeObserver);
}

let top = 0;
let frames: FrameRequestCallback[] = [];

beforeEach(() => {
  top = 0;
  frames = [];
  observers = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const y = this.dataset.y;
      const rowTop = y === undefined ? 0 : Number(y) - top;
      const bottom = y === undefined ? 0 : rowTop + Number(this.dataset.h);
      return { top: rowTop, bottom } as DOMRect;
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(props: HarnessProps) {
  const view = render(<Harness {...props} />);
  const scroller = view.getByTestId("scroller");
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v;
    },
  });
  /** A user scroll: the event, then the sampling frame. */
  const scrollTo = (y: number) => {
    top = y;
    scroller.dispatchEvent(new Event("scroll"));
    const due = frames;
    frames = [];
    for (const frame of due) frame(0);
  };
  const update = (next: HarnessProps) => view.rerender(<Harness {...next} />);
  return { ...view, scroller, scrollTo, update };
}

/** Lets mutation observers and other microtasks run. */
const settle = () => act(async () => undefined);

const LINES = range(1, 40);

describe("useModeLineAnchor", () => {
  it("restores the top line when the new layout's rows are in the same commit", () => {
    const content = {};
    const view = mount({ mode: "split", lines: LINES, content });
    // Split line 11 sits at 200.
    view.scrollTo(200);
    view.update({ mode: "unified", lines: LINES, content });
    expect(top).toBe(300);
  });

  it("re-reads the anchor when a new build lands under the same path and mode", () => {
    const view = mount({ mode: "split", lines: LINES, content: {} });
    view.scrollTo(200);
    // Another commit of the same file: its rows start at line 6, so 200 now
    // shows line 16, with no scroll event.
    const shifted = range(6, 40);
    const next = {};
    view.update({ mode: "split", lines: shifted, content: next });
    view.update({ mode: "unified", lines: shifted, content: next });
    // Line 16 is unified row 10 (300); the old anchor's line 11 is row 5.
    expect(top).toBe(300);
  });

  it("keeps the anchor through a scroll during an armed wait", async () => {
    const content = {};
    const view = mount({ mode: "split", lines: LINES, content });
    view.scrollTo(200);
    view.update({ mode: "unified", lines: LINES, ready: false, content });
    await settle();
    // The rowless commit's clamp.
    view.scrollTo(0);
    view.update({ mode: "unified", lines: LINES, content });
    await settle();
    expect(top).toBe(300);
    // Back to split with no scroll in between: the kept anchor restores.
    view.update({ mode: "split", lines: LINES, content });
    expect(top).toBe(200);
  });

  it.each([
    ["a wheel", () => new WheelEvent("wheel", { bubbles: true })],
    ["a focusin", () => new FocusEvent("focusin", { bubbles: true })],
  ])("cancels an armed restore on %s inside the scroller", async (_, event) => {
    const content = {};
    const view = mount({ mode: "split", lines: LINES, content });
    view.scrollTo(200);
    view.update({ mode: "unified", lines: LINES, ready: false, content });
    await settle();
    top = 0;
    view.getByTestId("inside").dispatchEvent(event());
    view.update({ mode: "unified", lines: LINES, content });
    await settle();
    expect(top).toBe(0);
  });

  it("a build replacing the one a restore waits on disarms it", async () => {
    const view = mount({ mode: "split", lines: LINES, content: {} });
    view.scrollTo(200);
    view.update({ mode: "unified", lines: LINES, ready: false, content: {} });
    await settle();
    // Another build lands while the wait is armed; its rows come later.
    const next = {};
    view.update({ mode: "unified", lines: LINES, ready: false, content: next });
    await settle();
    view.update({ mode: "unified", lines: LINES, content: next });
    await settle();
    // The old build's snapshot (line 11, unified 300) never lands.
    expect(top).toBe(200);
  });
});

/** A row of a hand-laid layout: its line numbers per side and its height. */
interface SpecRow {
  old?: number;
  new?: number;
  h: number;
}

function SpecRows({ mode, rows }: { mode: Mode; rows: SpecRow[] }) {
  let y = 0;
  const laid = rows.map((row) => {
    const at = y;
    y += row.h;
    return { ...row, at };
  });
  return (
    <table>
      <tbody>
        {laid.map((row) => (
          <tr key={row.at} data-line="" data-y={row.at} data-h={row.h}>
            {mode === "split" ? (
              <>
                <td data-side="old">
                  {row.old !== undefined && <span data-line-num={row.old} />}
                </td>
                <td data-side="new">
                  {row.new !== undefined && <span data-line-num={row.new} />}
                </td>
              </>
            ) : (
              <td>
                {row.old !== undefined && <span data-line-old-num={row.old} />}
                {row.new !== undefined && <span data-line-new-num={row.new} />}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A layout that writes scrollTop in its own layout effect when `content`
 *  changes, as the browser can clamp an expand's commit before the parent's
 *  effects read it. */
function ClampOnBuild({ content, to }: { content: object; to?: number }) {
  useLayoutEffect(() => {
    // Each new build clamps once: the effect keys on the build it ran for.
    if (to !== undefined && content) top = to;
  }, [content, to]);
  return null;
}

interface SpecProps {
  mode: Mode;
  rows: Record<Mode, SpecRow[]>;
  content: object;
  clampTo?: number;
  onKeep?: (keepLine: () => void) => void;
  /** A new value replaces the scroller's content root. */
  rootKey?: number;
}

function SpecHarness({
  mode,
  rows,
  content,
  clampTo,
  onKeep,
  rootKey,
}: SpecProps) {
  const ref = useRef<HTMLDivElement>(null);
  const keepLine = useModeLineAnchor(ref, mode, "src/a.ts", content);
  useLayoutEffect(() => onKeep?.(keepLine), [onKeep, keepLine]);
  return (
    <div ref={ref} data-testid="scroller">
      <SpecRows key={rootKey} mode={mode} rows={rows[mode]} />
      <ClampOnBuild content={content} to={clampTo} />
    </div>
  );
}

/** Mounts a spec layout; `max` clamps scrollTop writes per mode like a
 *  scroller whose content ends. */
function mountSpec(props: SpecProps, max?: Partial<Record<Mode, number>>) {
  let mode = props.mode;
  const view = render(<SpecHarness {...props} />);
  const scroller = view.getByTestId("scroller");
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.min(v, max?.[mode] ?? Number.POSITIVE_INFINITY);
    },
  });
  const runFrames = () => {
    const due = frames;
    frames = [];
    for (const frame of due) frame(0);
  };
  return {
    scroller,
    /** A user scroll: its input, the event, then the sampling frame. */
    userScroll(y: number) {
      scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
      top = y;
      scroller.dispatchEvent(new Event("scroll"));
      runFrames();
    },
    /** The scroll a restore's own write fires: no input precedes it. */
    restoreScroll() {
      scroller.dispatchEvent(new Event("scroll"));
      runFrames();
    },
    /** A scroll no input started (a script, a screen reader). */
    quietScroll(y: number) {
      top = y;
      scroller.dispatchEvent(new Event("scroll"));
      runFrames();
    },
    update(next: Partial<SpecProps>) {
      props = { ...props, ...next };
      mode = props.mode;
      view.rerender(<SpecHarness {...props} />);
    },
  };
}

const both = (from: number, to: number, h: number): SpecRow[] =>
  range(from, to - from + 1).map((n) => ({ old: n, new: n, h }));

describe("useModeLineAnchor across restores", () => {
  it("a pane never scrolled stays at the top across a switch", () => {
    // The first numbered row sits under a hunk row that is taller in split.
    const rows = {
      unified: [{ h: 30 }, ...both(1, 20, 30)],
      split: [{ h: 40 }, ...both(1, 20, 20)],
    };
    const view = mountSpec({ mode: "unified", rows, content: {} });
    // First build: the content re-sample reads the pane at scrollTop 0.
    view.update({ content: {} });
    view.update({ mode: "split" });
    expect(top).toBe(0);
  });

  it("unified to split to unified with no input returns the original line", async () => {
    // Lines 6-7 changed: unified lays the deletions before the additions,
    // split pairs them on one row.
    const rows = {
      unified: [
        ...both(1, 5, 30),
        { old: 6, h: 30 },
        { old: 7, h: 30 },
        { new: 6, h: 30 },
        { new: 7, h: 30 },
        ...both(8, 20, 30),
      ],
      split: [...both(1, 7, 20), ...both(8, 20, 20)],
    };
    const view = mountSpec({ mode: "unified", rows, content: {} });
    // Added line 6 (unified row 7) at the top.
    view.userScroll(210);
    view.update({ mode: "split" });
    expect(top).toBe(100);
    view.restoreScroll();
    view.update({ mode: "unified" });
    expect(top).toBe(210);
    // A user scroll in between re-reads the pair row, so unified then
    // shows its deleted side first.
    view.update({ mode: "split" });
    // The row list cached for sampling drops on its observer's microtask.
    await settle();
    view.userScroll(100);
    view.update({ mode: "unified" });
    expect(top).toBe(150);
  });

  it("a restore clamped at the scroll end keeps the original line", () => {
    const rows = { unified: both(1, 40, 30), split: both(1, 40, 20) };
    const view = mountSpec(
      { mode: "unified", rows, content: {} },
      { split: 500, unified: 900 },
    );
    // Line 30 at the top; split can't scroll past 500 (line 26).
    view.userScroll(870);
    view.update({ mode: "split" });
    expect(top).toBe(500);
    view.restoreScroll();
    view.update({ mode: "unified" });
    expect(top).toBe(870);
  });

  it("layouts whose rows differ in height don't walk the line", () => {
    // Wrapped split rows are twice the unified height.
    const rows = { unified: both(1, 40, 19), split: both(1, 40, 38) };
    const view = mountSpec({ mode: "split", rows, content: {} });
    // Line 11 with 30px of its 38px scrolled past.
    view.userScroll(410);
    for (let i = 0; i < 3; i++) {
      view.update({ mode: "unified" });
      // 15px of the 19px row, never past it onto line 12.
      expect(top).toBe(205);
      view.restoreScroll();
      view.update({ mode: "split" });
      expect(top).toBe(410);
      view.restoreScroll();
    }
  });

  it.each([
    ["the same content root", 0],
    ["a replaced content root", 1],
  ])(
    "re-places the line when the new layout's rows settle after the restore, in %s",
    async (_, rootKey) => {
      const rows = { unified: both(1, 40, 19), split: both(1, 40, 38) };
      const view = mountSpec({
        mode: "unified",
        rows,
        content: {},
        rootKey: 0,
      });
      // Line 25 at the top.
      view.userScroll(456);
      view.update({ mode: "split" });
      expect(top).toBe(912);
      // The context rows above it settle from their first, wrapped height: a
      // re-lay with no scroll event. Its rows remount, so it's found by line.
      view.update({
        rows: { ...rows, split: [...both(1, 20, 19), ...both(21, 40, 38)] },
        rootKey,
      });
      await settle();
      resize();
      expect(top).toBe(20 * 19 + 4 * 38);
      // Input hands the position back: a later re-lay moves nothing.
      view.scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
      view.update({ rows: { ...rows, split: both(1, 40, 19) } });
      await settle();
      resize();
      expect(top).toBe(20 * 19 + 4 * 38);
    },
  );

  it("a scroll with no input samples again once the restore's bound ends", async () => {
    const rows = { unified: both(1, 40, 30), split: both(1, 40, 20) };
    const view = mountSpec({ mode: "unified", rows, content: {} });
    // Line 11 at the top.
    view.userScroll(300);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      view.update({ mode: "split" });
      expect(top).toBe(200);
      // The row list cached for sampling drops on its observer's microtask.
      await settle();
      // Inside the bound a scroll no input started is the layout's own.
      view.quietScroll(400);
      expect(top).toBe(200);
      vi.advanceTimersByTime(RESTORE_BOUND_MS);
      // Past it, a script's or a screen reader's scroll moves the line.
      view.quietScroll(400);
      view.update({ mode: "unified" });
      expect(top).toBe(600);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an expand restores the line keepLine read, after a clamp in its own commit", () => {
    let keepLine: () => void = () => undefined;
    const rows = { unified: both(1, 40, 30), split: both(1, 40, 20) };
    const view = mountSpec({
      mode: "unified",
      rows,
      content: {},
      clampTo: 0,
      onKeep: (keep) => {
        keepLine = keep;
      },
    });
    view.userScroll(300);
    keepLine();
    view.update({
      rows: { unified: both(1, 80, 30), split: both(1, 80, 20) },
      content: {},
    });
    // Line 11 back at the top, though the commit clamped to 0 first.
    expect(top).toBe(300);
  });

  it("a new build with no keepLine re-reads the pane as the commit left it", () => {
    const rows = { unified: both(1, 40, 30), split: both(1, 40, 20) };
    const view = mountSpec({
      mode: "unified",
      rows,
      content: {},
      clampTo: 0,
    });
    view.userScroll(300);
    view.update({ content: {} });
    expect(top).toBe(0);
  });
});
