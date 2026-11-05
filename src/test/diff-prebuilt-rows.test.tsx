import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GitDiffView, type LineWidget } from "@/features/diff/DiffSurface";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));

const PATH = "src/lib/deep/nested/rows.txt";

// A both-sides change, then a pure add and a pure delete (placeholder sides
// in split).
const TEXT = `${[
  `diff --git a/${PATH} b/${PATH}`,
  `--- a/${PATH}`,
  `+++ b/${PATH}`,
  "@@ -1,3 +1,3 @@",
  " keep 1",
  "-old 2",
  "+new 2",
  " keep 3",
  "@@ -20,4 +20,4 @@",
  " keep 20",
  "+added 21",
  " keep 22",
  "-removed 23",
  " keep 24",
].join("\n")}\n`;

// @git-diff-view measures text on a 2D canvas, which jsdom leaves null.
beforeAll(() => {
  const measure = {
    font: "",
    measureText: (t: string) => ({ width: t.length }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => measure as unknown as CanvasRenderingContext2D,
  );
});

// Number spans seen in each commit's layout phase, before passive effects
// (where the library builds rows it wasn't handed) run. Line-number spans,
// never `tr[data-line]`, which hunk rows carry too.
let commits: { unified: number; split: number }[] = [];

function LayoutProbe({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (root === null) return;
    commits.push({
      unified: root.querySelectorAll(
        "span[data-line-new-num], span[data-line-old-num]",
      ).length,
      split: root.querySelectorAll("td[data-side] span[data-line-num]").length,
    });
  });
  return <div ref={ref}>{children}</div>;
}

let client: QueryClient;
beforeEach(() => {
  commits = [];
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

function view(props: { forceUnified?: boolean; lineWidget?: LineWidget }) {
  return (
    <QueryClientProvider client={client}>
      <LayoutProbe>
        <GitDiffView filePath={PATH} text={TEXT} {...props} />
      </LayoutProbe>
    </QueryClientProvider>
  );
}

const widget: LineWidget = { enabled: true, render: () => null };

describe("RenderedDiff prebuilt rows", () => {
  it("commits its rows with the build, not after the library's effect", () => {
    client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
    render(view({}));
    expect(commits[0].unified).toBeGreaterThan(0);
  });

  it("the line-comment (multi-select) view commits rows with the build too", () => {
    client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
    render(view({ lineWidget: widget }));
    expect(commits[0].unified).toBeGreaterThan(0);
  });

  it("a split/unified switch commits the other layout's rows at once", async () => {
    client.setQueryData(settingsKeys.settings, {
      ...DEFAULT_SETTINGS,
      diffViewMode: "split" as const,
    });
    const { rerender } = render(view({ forceUnified: true }));
    expect(commits[0].unified).toBeGreaterThan(0);
    await act(async () => rerender(view({ forceUnified: false })));
    expect(commits[1].split).toBeGreaterThan(0);
    expect(commits[1].unified).toBe(0);
    // The multi-select twin switches the same way.
    commits = [];
    await act(async () =>
      rerender(view({ forceUnified: true, lineWidget: widget })),
    );
    await act(async () =>
      rerender(view({ forceUnified: false, lineWidget: widget })),
    );
    expect(commits.at(-1)?.split).toBeGreaterThan(0);
  });
});
