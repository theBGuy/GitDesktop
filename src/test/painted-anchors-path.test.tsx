// A pane's line anchors mount only on a build of the path they were built
// for: their keys carry no path, and a path change in an urgent render keeps
// the previous file's rows up for a frame (the pane builds off deferred
// values), so anchors handed in that frame would land on another file's rows.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useLayoutEffect, useState } from "react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { DiffContent } from "@/features/diff/DiffSurface";
import type { FileDiff } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { bodies, renderBody } from "./anchor-bodies";
import { stubCanvas } from "./canvas-stub";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/use-container-width", () => ({
  useContainerWidth: () => [() => undefined, null],
}));

beforeAll(stubCanvas);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const diff = (filePath: string, word: string): FileDiff => ({
  filePath,
  isBinary: false,
  isTruncated: false,
  text: `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n@@ -1,3 +1,3 @@\n a\n-b\n+${word}\n c\n`,
});

/** Each anchor row whose file isn't the one its pane's rows draw, checked
 *  once a task's microtasks drain (a browser paints between tasks). */
function watchMisplaced() {
  const misplaced: string[] = [];
  const check = () => {
    for (const row of document.querySelectorAll("[data-diff-anchor]")) {
      const pane = row.closest("[aria-label^='Diff of ']");
      const owner = row.textContent?.replace("Anchor of ", "");
      if (pane?.getAttribute("aria-label") !== `Diff of ${owner}`)
        misplaced.push(
          `${row.textContent} in ${pane?.getAttribute("aria-label")}`,
        );
    }
  };
  const observer = new MutationObserver(() => {
    let hops = 0;
    const atTaskEnd = () => {
      if (++hops < 2000) queueMicrotask(atTaskEnd);
      else check();
    };
    queueMicrotask(atTaskEnd);
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  return { misplaced, stop: () => observer.disconnect() };
}

it("never mounts one file's anchors on another file's rows", async () => {
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
  let open: (path: string) => void = () => undefined;
  function Pane() {
    const [path, setPath] = useState("a.txt");
    useLayoutEffect(() => {
      open = setPath;
    });
    return (
      <DiffContent
        filePath={path}
        data={diff(path, path === "a.txt" ? "B" : "G")}
        isPending={false}
        isError={false}
        renderAnchor={renderBody}
        lineAnchors={bodies([
          { side: "new", line: 2, render: () => <span>Anchor of {path}</span> },
        ])}
      />
    );
  }
  render(
    <QueryClientProvider client={client}>
      <Pane />
    </QueryClientProvider>,
  );
  const shown = () =>
    document.querySelector("[data-diff-anchor]")?.textContent ?? null;
  await waitFor(() => expect(shown()).toBe("Anchor of a.txt"));
  const watch = watchMisplaced();
  // Outside act, so the urgent render and the deferred one land in tasks of
  // their own.
  open("g.txt");
  await waitFor(() => expect(shown()).toBe("Anchor of g.txt"));
  watch.stop();
  expect(watch.misplaced).toEqual([]);
}, 30_000);
