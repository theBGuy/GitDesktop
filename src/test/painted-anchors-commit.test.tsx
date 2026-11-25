// A pane's line anchors mount only on the build of the diff they were built
// for. A same-path commit switch hands the next commit's anchors in the same
// urgent render as its diff, while the rows still draw the previous commit's
// deferred text: anchors that rode the live value would land on those rows.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useLayoutEffect, useState } from "react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { DiffContent } from "@/features/diff/DiffSurface";
import type { FileDiff } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
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

const COMMITS = ["alpha", "beta"] as const;
type Commit = (typeof COMMITS)[number];
/** One commit's diff of n.txt: its new line 2 reads `<commit>word`. */
const diff = (commit: Commit): FileDiff => ({
  filePath: "n.txt",
  isBinary: false,
  isTruncated: false,
  text: `diff --git a/n.txt b/n.txt\n--- a/n.txt\n+++ b/n.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+${commit}word\n c\n`,
});

/** Each anchor mounted while the rows draw another commit's diff, checked
 *  once a task's microtasks drain (a browser paints between tasks). */
function watchMisplaced() {
  const misplaced: string[] = [];
  const check = () => {
    const shown = document.body.textContent ?? "";
    for (const row of document.querySelectorAll("[data-diff-anchor]")) {
      const owner = row.textContent?.replace("Anchor of ", "") as Commit;
      const other = COMMITS.find((c) => c !== owner);
      if (!shown.includes(`${owner}word`) || shown.includes(`${other}word`))
        misplaced.push(`${row.textContent} over ${shown.match(/\w+word/)}`);
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

it("never mounts the next commit's anchors on the previous commit's rows of the same path", async () => {
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
  let open: (commit: Commit) => void = () => undefined;
  function Pane() {
    const [commit, setCommit] = useState<Commit>("alpha");
    useLayoutEffect(() => {
      open = setCommit;
    });
    return (
      <DiffContent
        filePath="n.txt"
        data={diff(commit)}
        isPending={false}
        isError={false}
        lineAnchors={[
          {
            side: "new",
            line: 2,
            render: () => <span>Anchor of {commit}</span>,
          },
        ]}
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
  await waitFor(() => expect(shown()).toBe("Anchor of alpha"));
  const watch = watchMisplaced();
  // Outside act, so the urgent render and the deferred one land in tasks of
  // their own. Back and forth, since whether a task ends between the two
  // depends on the scheduler.
  for (const commit of ["beta", "alpha", "beta", "alpha", "beta"] as const) {
    open(commit);
    const other = COMMITS.find((c) => c !== commit);
    await waitFor(() => expect(shown()).toBe(`Anchor of ${commit}`));
    await waitFor(() =>
      expect(document.body.textContent).not.toContain(`${other}word`),
    );
  }
  watch.stop();
  expect(watch.misplaced).toEqual([]);
}, 30_000);
