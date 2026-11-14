import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitFocusRelease,
  FOCUS_RELEASE_WAIT_MS,
} from "@/lib/await-focus-release";

let clock = 0;
let queue: Map<number, FrameRequestCallback>;
let nextId = 0;

beforeEach(() => {
  clock = 1_000;
  queue = new Map();
  nextId = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    nextId += 1;
    queue.set(nextId, cb);
    return nextId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    queue.delete(id);
  });
});

afterEach(() => vi.restoreAllMocks());

/** Runs one frame `stepMs` after the last. */
function frame(stepMs: number) {
  clock += stepMs;
  const due = [...queue.values()];
  queue.clear();
  for (const cb of due) cb(clock);
}

function setup(over: { aborted?: () => boolean } = {}) {
  let held = true;
  const onRelease = vi.fn();
  const onTimeout = vi.fn();
  const cancel = awaitFocusRelease({
    held: () => held,
    aborted: over.aborted ?? (() => false),
    onRelease,
    onTimeout,
  });
  return {
    release: () => {
      held = false;
    },
    onRelease,
    onTimeout,
    cancel,
  };
}

describe("awaitFocusRelease", () => {
  it("waits a frame, then releases once focus is free", () => {
    const s = setup();
    expect(queue.size).toBe(1);
    // Many short frames stay inside the bound: it is time, not a frame count.
    for (let i = 0; i < 100; i++) frame(3);
    expect(s.onRelease).not.toHaveBeenCalled();
    s.release();
    frame(3);
    expect(s.onRelease).toHaveBeenCalledTimes(1);
    expect(s.onTimeout).not.toHaveBeenCalled();
    expect(queue.size).toBe(0);
  });

  it("times out once the bound passes with focus still held", () => {
    const s = setup();
    frame(FOCUS_RELEASE_WAIT_MS - 1);
    expect(queue.size).toBe(1);
    frame(1);
    expect(s.onTimeout).toHaveBeenCalledTimes(1);
    expect(s.onRelease).not.toHaveBeenCalled();
    expect(queue.size).toBe(0);
  });

  it("stops silently when aborted, before reading focus", () => {
    let aborted = false;
    const s = setup({ aborted: () => aborted });
    frame(3);
    aborted = true;
    s.release();
    frame(3);
    expect(s.onRelease).not.toHaveBeenCalled();
    expect(s.onTimeout).not.toHaveBeenCalled();
    expect(queue.size).toBe(0);
  });

  it("cancels the pending frame, and a later cancel is a no-op", () => {
    const s = setup();
    frame(3);
    s.cancel();
    expect(queue.size).toBe(0);
    s.release();
    frame(3);
    expect(s.onRelease).not.toHaveBeenCalled();
    s.cancel();
    expect(window.cancelAnimationFrame).toHaveBeenCalledTimes(1);
  });
});
