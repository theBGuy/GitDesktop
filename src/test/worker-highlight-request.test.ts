import { renderHook } from "@testing-library/react";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { HighlightWorkRequest } from "@/features/diff/highlight-worker-shared";
import { useWorkerHighlight } from "@/features/diff/use-worker-highlight";

// The hook's module keeps ONE worker for the process, so every test reads the
// requests this stand-in collected.
const posted: HighlightWorkRequest[] = [];
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessageerror: ((e: unknown) => void) | null = null;
  postMessage(req: HighlightWorkRequest) {
    posted.push(req);
  }
}
vi.stubGlobal("Worker", FakeWorker);
afterAll(() => vi.unstubAllGlobals());

const args = (text: string) => ({
  enabled: true,
  filePath: "big.tsx",
  text,
  lang: "tsx",
  content: null,
  tmGrammar: null,
});

describe("the highlight worker's request", () => {
  it("carries the patch with each blank context row's space restored", () => {
    // A CRLF patch whose blank context row lost its space arrives as "\r" alone,
    // which the worker's diff parser refuses.
    const text = "@@ -1,3 +1,3 @@\r\n a\r\n\r\n-b\r\n+c\r\n";
    posted.length = 0;
    const { rerender } = renderHook(
      (t: string) => useWorkerHighlight(args(t)),
      {
        initialProps: text,
      },
    );
    expect(posted.map((r) => r.hunkText)).toEqual([
      "@@ -1,3 +1,3 @@\r\n a\r\n \r\n-b\r\n+c\r\n",
    ]);
    // The same text on a later render posts nothing more.
    rerender(text);
    expect(posted).toHaveLength(1);
  });

  it("sends a patch with nothing to restore as it came", () => {
    const text = "@@ -1,2 +1,2 @@\n a\n-b\n+c\n";
    posted.length = 0;
    renderHook(() => useWorkerHighlight(args(text)));
    expect(posted).toHaveLength(1);
    expect(posted[0].hunkText).toBe(text);
  });
});
