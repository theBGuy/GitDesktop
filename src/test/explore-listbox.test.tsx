import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { ExploreScreen } from "@/features/explore/ExploreScreen";
import { exploreOptionId } from "@/features/explore/explore-utils";
import type { ForgeRepo } from "@/lib/git/types";

// One object for every render: the screen derives its rows from `data`, and a
// fresh object per render would re-derive them forever. The search read never
// answers, so Popular shows its skeletons.
const reads = vi.hoisted(() => ({
  features: { data: undefined },
  search: { data: undefined, isPending: true },
  own: {
    data: {
      repos: [
        {
          fullName: "acme/widgets",
          owner: "acme",
          name: "widgets",
          private: false,
          archived: false,
          fork: false,
          cloneUrl: "https://github.com/acme/widgets.git",
          sshUrl: "git@github.com:acme/widgets.git",
          description: null,
          pushedAt: "2026-01-01T00:00:00Z",
        } as unknown as ForgeRepo,
        // Listed after acme/widgets (fixture order), so FIRST stays first.
        {
          fullName: "acme/zebra",
          owner: "acme",
          name: "zebra",
          private: false,
          archived: false,
          fork: false,
          cloneUrl: "https://github.com/acme/zebra.git",
          sshUrl: "git@github.com:acme/zebra.git",
          description: null,
          pushedAt: "2026-01-01T00:00:00Z",
        } as unknown as ForgeRepo,
      ],
      ownedNamespaces: [] as string[],
    },
    isPending: false,
    isError: false,
    error: null,
  },
}));

vi.mock("@/lib/git/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/queries")>()),
  useForgeProviderFeatures: () => reads.features,
  useForgeRepos: () => reads.own,
  useForgeSearchRepos: () => reads.search,
}));

// jsdom lays nothing out, so the virtualized list (@tanstack/virtual-core sizes
// its viewport from the scroll element's clientWidth/clientHeight) paints no
// row; a fixed client size gives it a viewport.
const CLIENT_SIZE = { clientWidth: 800, clientHeight: 600 } as const;
beforeAll(() => {
  for (const [k, v] of Object.entries(CLIENT_SIZE)) {
    Object.defineProperty(HTMLElement.prototype, k, {
      configurable: true,
      get: () => v,
    });
  }
});
afterAll(() => {
  for (const k of Object.keys(CLIENT_SIZE)) {
    Reflect.deleteProperty(HTMLElement.prototype, k);
  }
});
afterEach(cleanup);

function renderScreen({ strict = false } = {}) {
  const screenTree = (
    <QueryClientProvider client={new QueryClient()}>
      <ExploreScreen />
    </QueryClientProvider>
  );
  render(strict ? <StrictMode>{screenTree}</StrictMode> : screenTree);
}

const list = () => screen.getByRole("listbox", { name: "Search results" });
const searchBox = () =>
  screen.getByRole("combobox", { name: "Search repositories" });

/** preventDefault calls a native press on `el` received, the row's own handler
 *  and the list's guard both counted. */
function press(el: Element, button: number) {
  const evt = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    button,
  });
  const spy = vi.spyOn(evt, "preventDefault");
  el.dispatchEvent(evt);
  return spy.mock.calls.length;
}

// jsdom has no scroller rule to reproduce; this pins the attribute the Tab-order
// fix rests on.
it("the results listbox is no Tab stop of its own", () => {
  renderScreen();
  expect(list()).toHaveAttribute("tabindex", "-1");
});

it("leaves a row's press to the row", () => {
  renderScreen();
  expect(press(screen.getAllByRole("option")[0], 0)).toBe(1);
});

it("keeps a press on an owner heading off the list", () => {
  renderScreen();
  const heading = within(list()).getByText("acme", { selector: "p" });
  expect(press(heading, 0)).toBeGreaterThanOrEqual(1);
});

it("keeps a press on the list itself off the list", () => {
  renderScreen();
  expect(press(list(), 0)).toBeGreaterThanOrEqual(1);
});

it("a middle press on the list is kept off it too", () => {
  renderScreen();
  expect(press(list(), 1)).toBeGreaterThanOrEqual(1);
});

const FIRST = exploreOptionId("acme/widgets");
const SECOND = exploreOptionId("acme/zebra");

it("arrows a list that mounted warm", () => {
  renderScreen();
  fireEvent.keyDown(searchBox(), { key: "ArrowDown" });
  expect(searchBox()).toHaveAttribute("aria-activedescendant", FIRST);
});

it("arrows the warm own-repos list after a visit to Popular", async () => {
  const user = userEvent.setup();
  renderScreen();
  await user.click(screen.getByRole("tab", { name: "Popular" }));
  expect(screen.queryByRole("listbox", { name: "Search results" })).toBeNull();
  // Popular's loading state: the list's cleanup cleared the rows it published.
  expect(searchBox()).toHaveAttribute("aria-expanded", "false");
  expect(searchBox()).not.toHaveAttribute("aria-controls");
  fireEvent.keyDown(searchBox(), { key: "ArrowDown" });
  expect(searchBox()).not.toHaveAttribute("aria-activedescendant");
  await user.click(screen.getByRole("tab", { name: "Your repositories" }));
  fireEvent.keyDown(searchBox(), { key: "ArrowDown" });
  expect(searchBox()).toHaveAttribute("aria-activedescendant", FIRST);
});

it("arrows under StrictMode, on mount and after a visit to Popular", async () => {
  const user = userEvent.setup();
  renderScreen({ strict: true });
  fireEvent.keyDown(searchBox(), { key: "ArrowDown" });
  expect(searchBox()).toHaveAttribute("aria-activedescendant", FIRST);
  await user.click(screen.getByRole("tab", { name: "Popular" }));
  await user.click(screen.getByRole("tab", { name: "Your repositories" }));
  // A real move from the first row, which has a next row.
  expect(searchBox()).toHaveAttribute("aria-activedescendant", FIRST);
  fireEvent.keyDown(searchBox(), { key: "ArrowDown" });
  expect(searchBox()).toHaveAttribute("aria-activedescendant", SECOND);
});
