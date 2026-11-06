import { vi } from "vitest";

/** @git-diff-view measures text on a 2D canvas, which jsdom leaves null. */
export function stubCanvas() {
  const measure = {
    font: "",
    measureText: (t: string) => ({ width: t.length }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => measure as unknown as CanvasRenderingContext2D,
  );
}
