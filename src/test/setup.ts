import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { installTransport } from "@/lib/transport";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// RTL registers its auto-cleanup and its act environment only through global
// hooks, which `globals: false` withholds; without the flag React stays silent
// about updates that land outside act().
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

// view-transition.ts reads matchMedia at module load, and jsdom has none.
window.matchMedia ??= (query: string): MediaQueryList => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => undefined,
  removeListener: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => false,
});

// Base UI's ScrollArea observes its viewport, and jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe = () => undefined;
  unobserve = () => undefined;
  disconnect = () => undefined;
};

// Base UI waits out an element's animations (ScrollArea, Dialog), and jsdom
// implements no Web Animations API.
Element.prototype.getAnimations ??= () => [];

/** Backend commands a test reached without mocking its api module. */
export const unmockedCommands: string[] = [];

// A stray backend call rejects loudly instead of hanging on a missing Tauri.
installTransport({
  invoke(cmd) {
    unmockedCommands.push(cmd);
    return Promise.reject(new Error(`unmocked command: ${cmd}`));
  },
});
