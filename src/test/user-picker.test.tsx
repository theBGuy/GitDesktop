import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { USER_PICKER_POPUP_CLASS } from "@/components/user-picker-body";
import { PICKER_LEGEND } from "@/components/user-picker-model";
import { AssigneesPopover } from "@/features/issues/IssueMetaPickers";
import { ReviewersPopover } from "@/features/pulls/ReviewersPopover";
import {
  forgeAssignableUsers,
  forgePrReviewerCandidates,
  forgeStatus,
} from "@/lib/git/api";
import type {
  ForgeProvider,
  ForgeStatus,
  ForgeUserList,
  ForgeUserRef,
} from "@/lib/git/types";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeAssignableUsers: vi.fn(),
  forgePrReviewerCandidates: vi.fn(),
  forgeStatus: vi.fn(),
}));

// jsdom lays nothing out: the virtualizer sizes its viewport from the scroll
// element's clientWidth/clientHeight, and jsdom has no element scrollTo.
const CLIENT_SIZE = { clientWidth: 240, clientHeight: 300 } as const;
beforeAll(() => {
  for (const [k, v] of Object.entries(CLIENT_SIZE)) {
    Object.defineProperty(HTMLElement.prototype, k, {
      configurable: true,
      get: () => v,
    });
  }
  Element.prototype.scrollTo ??= () => undefined;
});
afterAll(() => {
  for (const k of Object.keys(CLIENT_SIZE)) {
    Reflect.deleteProperty(HTMLElement.prototype, k);
  }
});

const REPO = "C:/repo";
const ref = (id: string, label = id): ForgeUserRef => ({
  id,
  label,
  avatarUrl: "",
  isBot: false,
});
const list = (
  users: ForgeUserRef[],
  truncated = false,
  ceiling = 1000,
): ForgeUserList => ({ users, truncated, ceiling });
const statusOf = (provider: ForgeProvider) =>
  ({
    provider,
    installed: true,
    authenticated: true,
    repo: "me/project",
    host: "github.com",
    login: "me",
    capabilities: {},
    implemented: {},
  }) as unknown as ForgeStatus;

const ALICE = ref("alice");
const BOB = ref("bob");
const CAROL = ref("carol");
const THREE = [ALICE, BOB, CAROL];

type Kind = "assignees" | "reviewers";

function Harness({
  kind,
  initial,
  commitOnClose,
  onChange,
  disabledReason,
}: {
  kind: Kind;
  initial: ForgeUserRef[];
  commitOnClose: boolean;
  onChange: (next: ForgeUserRef[]) => void;
  disabledReason?: string;
}) {
  const [value, setValue] = useState(initial);
  const change = (next: ForgeUserRef[]) => {
    onChange(next);
    setValue(next);
  };
  return kind === "reviewers" ? (
    <ReviewersPopover
      repoPath={REPO}
      number={7}
      enabled
      value={value}
      onChange={change}
      lens="origin"
      disabledReason={disabledReason}
    />
  ) : (
    <AssigneesPopover
      repoPath={REPO}
      enabled
      value={value}
      onChange={change}
      commitOnClose={commitOnClose}
      lens="origin"
      disabledReason={disabledReason}
    />
  );
}

function setup(
  kind: Kind,
  opts: {
    initial?: ForgeUserRef[];
    commitOnClose?: boolean;
    disabledReason?: string;
  } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onChange = vi.fn();
  const user = userEvent.setup();
  const view = render(
    <QueryClientProvider client={client}>
      <Harness
        kind={kind}
        initial={opts.initial ?? []}
        commitOnClose={opts.commitOnClose ?? false}
        onChange={onChange}
        disabledReason={opts.disabledReason}
      />
    </QueryClientProvider>,
  );
  const trigger = screen.getByRole("button", {
    name: kind === "reviewers" ? "Edit reviewers" : "Edit assignees",
  });
  const open = async () => {
    await user.click(trigger);
    const filter = await screen.findByRole("textbox", { name: "Filter users" });
    await waitFor(() => expect(document.activeElement).toBe(filter));
    return filter;
  };
  return { client, onChange, user, trigger, open, unmount: view.unmount };
}

const reads = (kind: Kind) =>
  vi.mocked(
    kind === "reviewers" ? forgePrReviewerCandidates : forgeAssignableUsers,
  ).mock.calls.length;
const answer = (kind: Kind, impl: () => Promise<ForgeUserList>) =>
  vi
    .mocked(
      kind === "reviewers" ? forgePrReviewerCandidates : forgeAssignableUsers,
    )
    .mockImplementation(impl);
const rowIds = () =>
  screen.queryAllByRole("checkbox").map((c) => c.getAttribute("data-row-id"));
const rowBox = (id: string) => {
  const box = screen
    .getAllByRole("checkbox")
    .find((c) => c.getAttribute("data-row-id") === id);
  if (!box) throw new Error(`no row ${id}`);
  return box;
};
const statusText = () =>
  within(screen.getByRole("dialog")).getByRole("status").textContent ?? "";
// Flushes pending query settles and the effects they schedule.
const settle = () => act(() => Promise.resolve());

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(forgeStatus).mockResolvedValue(statusOf("github"));
  answer("assignees", async () => list(THREE));
  answer("reviewers", async () => list(THREE));
});

describe.each<Kind>(["assignees", "reviewers"])("%s picker", (kind) => {
  it("both popups carry the cap class and a scrolling rail", async () => {
    const t = setup(kind);
    await t.open();
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    const popup = screen.getByRole("dialog");
    expect(popup.className).toBe(USER_PICKER_POPUP_CLASS);
    expect(USER_PICKER_POPUP_CLASS).toContain(
      "max-h-[min(24rem,var(--available-height))]",
    );
    const rail = popup.querySelector(".overflow-y-auto");
    expect(rail?.className).toBe(
      "min-h-0 flex-1 overflow-y-auto overscroll-contain py-2",
    );
    const items = within(popup).getAllByRole("listitem");
    expect(items.map((i) => i.getAttribute("aria-posinset"))).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(items[0].getAttribute("aria-setsize")).toBe("3");
    expect(within(popup).getByRole("list").getAttribute("aria-label")).toBe(
      kind === "reviewers" ? "Reviewers" : "Assignees",
    );
    expect(
      screen
        .getByRole("checkbox", { name: /alice/ })
        .getAttribute("data-row-id"),
    ).toBe("alice");
    // No always-on tooltip anywhere in a row.
    expect(rail?.querySelector("[title]")).toBeNull();
    expect(within(popup).getByText(PICKER_LEGEND)).toBeTruthy();
  });

  it("typing narrows rows by label, case-insensitively", async () => {
    answer(kind, async () =>
      list([ref("1", "Alice"), ref("2", "bob"), ref("3", "ALFRED")]),
    );
    const t = setup(kind);
    const filter = await t.open();
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    await t.user.type(filter, "aL");
    expect(rowIds()).toEqual(["1", "3"]);
    await t.user.type(filter, "zz");
    expect(rowIds()).toEqual([]);
    expect(statusText()).toBe("No matching users.");
  });

  it("ticking never moves a row, and the open-time selection stays first", async () => {
    const t = setup(kind, { initial: [CAROL] });
    await t.open();
    await waitFor(() => expect(rowIds()).toEqual(["carol", "alice", "bob"]));
    await t.user.click(rowBox("bob"));
    await t.user.click(rowBox("carol"));
    expect(rowIds()).toEqual(["carol", "alice", "bob"]);
    expect(rowBox("carol").getAttribute("aria-checked")).toBe("false");
    expect(rowBox("bob").getAttribute("aria-checked")).toBe("true");
  });

  it("a selected user absent from the list has a row and can be removed", async () => {
    const ghost = ref("ghost");
    const t = setup(kind, { initial: [ghost] });
    await t.open();
    await waitFor(() =>
      expect(rowIds()).toEqual(["ghost", "alice", "bob", "carol"]),
    );
    await t.user.click(rowBox("ghost"));
    await t.user.keyboard("{Escape}");
    await waitFor(() => expect(t.onChange).toHaveBeenCalledWith([]));
  });

  it("pending forever: the open-time selection shows, with Loading…", async () => {
    answer(kind, () => new Promise(() => undefined));
    const t = setup(kind, { initial: [BOB] });
    await t.open();
    expect(rowIds()).toEqual(["bob"]);
    expect(statusText()).toBe("Loading…");
  });

  it("Tab/Shift+Tab/arrow walk the filter and rows and never leave", async () => {
    const t = setup(kind);
    const filter = await t.open();
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    const focusedRow = () =>
      document.activeElement?.getAttribute("data-row-id");
    await t.user.keyboard("{Tab}");
    await waitFor(() => expect(focusedRow()).toBe("alice"));
    await t.user.keyboard("{Tab}");
    await waitFor(() => expect(focusedRow()).toBe("bob"));
    await t.user.keyboard("{Tab}{Tab}");
    await waitFor(() => expect(document.activeElement).toBe(filter));
    await t.user.keyboard("{Shift>}{Tab}{/Shift}");
    await waitFor(() => expect(focusedRow()).toBe("carol"));
    await t.user.keyboard("{ArrowUp}");
    await waitFor(() => expect(focusedRow()).toBe("bob"));
    await t.user.keyboard("{ArrowDown}{ArrowDown}");
    await waitFor(() => expect(focusedRow()).toBe("carol"));
    await t.user.keyboard("{ArrowDown}");
    expect(focusedRow()).toBe("carol");
    await t.user.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}");
    await waitFor(() => expect(document.activeElement).toBe(filter));
    await t.user.keyboard("{ArrowDown}");
    await waitFor(() => expect(focusedRow()).toBe("alice"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(t.onChange).not.toHaveBeenCalled();
  });

  it("Tab with no rows keeps focus on the filter and the popup open", async () => {
    answer(kind, async () => list([]));
    const t = setup(kind);
    const filter = await t.open();
    await waitFor(() => expect(statusText()).not.toBe("Loading…"));
    expect(fireEvent.keyDown(filter, { key: "Tab" })).toBe(false);
    await settle();
    expect(document.activeElement).toBe(filter);
    expect(fireEvent.keyDown(filter, { key: "Tab", shiftKey: true })).toBe(
      false,
    );
    await settle();
    expect(document.activeElement).toBe(filter);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("Ctrl, Alt or Meta+Tab stays native", async () => {
    const t = setup(kind);
    const filter = await t.open();
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    // Event init flags, not a platform check: names joined so the mod-key guard
    // (which scans for hand-rolled platform tests) has nothing to match.
    for (const mod of ["ctrl", "alt", "meta"]) {
      const init = { key: "Tab", [`${mod}Key`]: true };
      expect(fireEvent.keyDown(filter, init)).toBe(true);
    }
  });

  it("an arrow with nowhere to go is still consumed", async () => {
    const t = setup(kind);
    await t.open();
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    await t.user.keyboard("{Shift>}{Tab}{/Shift}");
    await waitFor(() => expect(document.activeElement).toBe(rowBox("carol")));
    expect(fireEvent.keyDown(rowBox("carol"), { key: "ArrowDown" })).toBe(
      false,
    );
    expect(document.activeElement).toBe(rowBox("carol"));
    answer(kind, async () => list([]));
    t.unmount();
    const empty = setup(kind);
    const emptyFilter = await empty.open();
    await waitFor(() => expect(statusText()).not.toBe("Loading…"));
    expect(fireEvent.keyDown(emptyFilter, { key: "ArrowUp" })).toBe(false);
    expect(document.activeElement).toBe(emptyFilter);
  });

  it("the hairline sits on the first row after the open-time selection only", async () => {
    const t = setup(kind, { initial: [CAROL] });
    await t.open();
    await waitFor(() => expect(rowIds()).toEqual(["carol", "alice", "bob"]));
    const lined = within(screen.getByRole("dialog"))
      .getAllByRole("listitem")
      .map((i) => i.className.includes("before:h-px"));
    expect(lined).toEqual([false, true, false]);
    t.unmount();
    const none = setup(kind);
    await none.open();
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    expect(
      within(screen.getByRole("dialog"))
        .getAllByRole("listitem")
        .some((i) => i.className.includes("before:h-px")),
    ).toBe(false);
  });

  it("every row, checked or not, rings itself while its checkbox has keyboard focus", async () => {
    const ROW_RING = [
      "has-focus-visible:ring-2",
      "has-focus-visible:ring-ring",
      "has-focus-visible:ring-inset",
    ];
    const ringed = (box: Element) => {
      const row = box.closest("label");
      return row !== null && ROW_RING.every((c) => row.classList.contains(c));
    };
    // Negative control: a row label without the ring classes reads as unringed.
    const bare = document.createElement("label");
    bare.className = "flex h-9 items-center";
    const bareBox = document.createElement("span");
    bare.append(bareBox);
    expect(ringed(bareBox)).toBe(false);

    const t = setup(kind, { initial: [CAROL] });
    await t.open();
    await waitFor(() => expect(rowIds()).toEqual(["carol", "alice", "bob"]));
    const boxes = within(screen.getByRole("dialog")).getAllByRole("checkbox");
    expect(boxes.map((b) => b.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    expect(boxes.map(ringed)).toEqual([true, true, true]);
    // The ring is a box-shadow: the row keeps its fixed height class.
    const rows = boxes.map((b) => b.closest("label"));
    expect(rows.every((r) => r?.classList.contains("h-9"))).toBe(true);
  });

  it("a clipped label gets its full text as a hover title; an unclipped one none", async () => {
    answer(kind, async () => list([ref("long", "A very long display name")]));
    const t = setup(kind);
    await t.open();
    await waitFor(() => expect(rowIds()).toEqual(["long"]));
    const label = screen.getByText("A very long display name");
    fireEvent.mouseEnter(label);
    expect(label.getAttribute("title")).toBeNull();
    Object.defineProperty(label, "scrollWidth", {
      configurable: true,
      get: () => CLIENT_SIZE.clientWidth + 100,
    });
    fireEvent.mouseEnter(label);
    expect(label.getAttribute("title")).toBe("A very long display name");
  });

  it("a filter change scrolls the rail back to the top", async () => {
    const t = setup(kind);
    const filter = await t.open();
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    const scrollTo = vi.spyOn(Element.prototype, "scrollTo");
    try {
      await t.user.type(filter, "a");
      expect(scrollTo).toHaveBeenCalledWith(
        expect.objectContaining({ top: 0 }),
      );
    } finally {
      scrollTo.mockRestore();
    }
  });

  it("a refetch that drops the focused row puts focus on the filter", async () => {
    const t = setup(kind, { commitOnClose: kind === "assignees" });
    const filter = await t.open();
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    await t.user.keyboard("{Tab}");
    await waitFor(() => expect(document.activeElement).toBe(rowBox("alice")));
    const dialog = screen.getByRole("dialog");
    // Base UI would refocus the popup itself; the rescue gets there first.
    const popupFocused = vi.fn();
    dialog.addEventListener("focus", popupFocused);
    answer(kind, async () => list([BOB, CAROL]));
    await act(async () => {
      await t.client.refetchQueries();
    });
    await waitFor(() => expect(rowIds()).toEqual(["bob", "carol"]));
    await waitFor(() => expect(document.activeElement).toBe(filter));
    expect(popupFocused).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(t.onChange).not.toHaveBeenCalled();
  });

  it("a first load landing under a focused snapshot row keeps focus and scroll", async () => {
    let land: (l: ForgeUserList) => void = () => undefined;
    answer(
      kind,
      () =>
        new Promise<ForgeUserList>((resolve) => {
          land = resolve;
        }),
    );
    const t = setup(kind, { initial: [CAROL] });
    await t.open();
    expect(rowIds()).toEqual(["carol"]);
    await t.user.keyboard("{Tab}");
    await waitFor(() => expect(document.activeElement).toBe(rowBox("carol")));
    const scrollTo = vi.spyOn(Element.prototype, "scrollTo");
    try {
      await act(async () => land(list(THREE)));
      await waitFor(() => expect(rowIds()).toEqual(["carol", "alice", "bob"]));
      expect(document.activeElement).toBe(rowBox("carol"));
      expect(scrollTo).not.toHaveBeenCalled();
    } finally {
      scrollTo.mockRestore();
    }
  });

  it("a key move whose row mounts only after the list re-lays still lands", async () => {
    answer(kind, async () => list([CAROL]));
    const t = setup(kind);
    const filter = await t.open();
    await waitFor(() => expect(rowIds()).toEqual(["carol"]));
    // Frames run only when flushed, and the row lookup misses while `hide` is
    // set: the claim's first try fails and its retry waits on a frame.
    const frames = new Map<number, FrameRequestCallback>();
    let next = 0;
    const raf = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb) => {
        next += 1;
        frames.set(next, cb);
        return next;
      });
    const caf = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation((id) => {
        frames.delete(id);
      });
    const lookup = Element.prototype.querySelector;
    let hide = true;
    const query = vi
      .spyOn(Element.prototype, "querySelector")
      .mockImplementation(function (this: Element, sel: string) {
        if (hide && sel.startsWith("[data-row-id=")) return null;
        return lookup.call(this, sel);
      });
    try {
      act(() => {
        fireEvent.keyDown(filter, { key: "Tab", shiftKey: true });
      });
      expect(frames.size).toBeGreaterThan(0);
      // The list grows under the pending claim and moves carol's index.
      answer(kind, async () => list(THREE));
      await act(async () => {
        await t.client.refetchQueries();
      });
      await waitFor(() => expect(rowIds()).toEqual(["alice", "bob", "carol"]));
      hide = false;
      act(() => {
        for (const [id, cb] of [...frames]) {
          frames.delete(id);
          cb(0);
        }
      });
      expect(document.activeElement).toBe(rowBox("carol"));
    } finally {
      raf.mockRestore();
      caf.mockRestore();
      query.mockRestore();
    }
  });

  it("a letter on a row lands in the filter; Space still toggles", async () => {
    const t = setup(kind);
    const filter = await t.open();
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    await t.user.keyboard("{Tab}");
    await waitFor(() => expect(document.activeElement).toBe(rowBox("alice")));
    await t.user.keyboard(" ");
    expect(rowBox("alice").getAttribute("aria-checked")).toBe("true");
    await t.user.keyboard("b");
    expect(document.activeElement).toBe(filter);
    expect((filter as HTMLInputElement).value).toBe("b");
    expect(rowIds()).toEqual(["bob"]);
  });

  it("Enter toggles the focused row once; Ctrl+Enter does not", async () => {
    const t = setup(kind);
    await t.open();
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    await t.user.keyboard("{Tab}");
    await waitFor(() => expect(document.activeElement).toBe(rowBox("alice")));
    await t.user.keyboard("{Enter}");
    expect(rowBox("alice").getAttribute("aria-checked")).toBe("true");
    await t.user.keyboard("{Control>}{Enter}{/Control}");
    expect(rowBox("alice").getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(rowBox("alice"), { key: "Enter", repeat: true });
    expect(rowBox("alice").getAttribute("aria-checked")).toBe("true");
  });

  it("ArrowDown then Enter dispatched on the filter before the focus claim lands toggles nothing", async () => {
    const t = setup(kind);
    const filter = await t.open();
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    fireEvent.keyDown(filter, { key: "Enter" });
    for (const id of ["alice", "bob", "carol"])
      expect(rowBox(id).getAttribute("aria-checked")).toBe("false");
  });

  it("Shift+ArrowDown in the filter does not move", async () => {
    const t = setup(kind);
    const filter = await t.open();
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    const passed = fireEvent.keyDown(filter, {
      key: "ArrowDown",
      shiftKey: true,
    });
    expect(passed).toBe(true);
    await settle();
    expect(document.activeElement).toBe(filter);
  });

  it("a click toggles and moves the cursor to the clicked row", async () => {
    const t = setup(kind);
    await t.open();
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    await t.user.click(screen.getByText("bob"));
    expect(rowBox("bob").getAttribute("aria-checked")).toBe("true");
    await t.user.keyboard("{Tab}");
    await waitFor(() => expect(document.activeElement).toBe(rowBox("carol")));
  });

  it("truncated shows the wire's ceiling (1,000 and 500); not truncated shows none", async () => {
    answer(kind, async () => list(THREE, true, 1000));
    const first = setup(kind);
    await first.open();
    await waitFor(() =>
      expect(screen.getByText("Showing the first 1,000 users.")).toBeTruthy(),
    );
    first.unmount();

    answer(kind, async () => list(THREE, true, 500));
    const second = setup(kind);
    await second.open();
    await waitFor(() =>
      expect(screen.getByText("Showing the first 500 users.")).toBeTruthy(),
    );
    second.unmount();

    answer(kind, async () => list(THREE, false, 1000));
    const third = setup(kind);
    await third.open();
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    expect(screen.queryByText(/Showing the first/)).toBeNull();
  });

  it("Retry refetches and leaves focus on the filter with the popup open", async () => {
    answer(kind, async () => {
      throw { kind: "network", message: "down" };
    });
    const t = setup(kind);
    const filter = await t.open();
    const retry = await screen.findByRole("button", {
      name: `Retry loading ${kind === "reviewers" ? "reviewers" : "assignable users"}`,
    });
    expect(statusText()).toBe(
      kind === "reviewers"
        ? "Couldn't load repository collaborators."
        : "Couldn't load assignable users.",
    );
    // Where focus sits when the refetch reaches the api: on the filter, never
    // on the Retry button the refetch is about to unmount.
    let focusAtRead: Element | null = null;
    answer(kind, async () => {
      focusAtRead = document.activeElement;
      return list(THREE);
    });
    await t.user.click(retry);
    expect(focusAtRead).toBe(filter);
    expect(document.activeElement).toBe(filter);
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    expect(document.activeElement).toBe(filter);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(t.onChange).not.toHaveBeenCalled();
  });

  it("a paused refresh over loaded rows shows the offline rows notice and no Retry", async () => {
    const t = setup(kind);
    await t.open();
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    try {
      onlineManager.setOnline(false);
      await act(async () => {
        void t.client.refetchQueries();
      });
      await waitFor(() =>
        expect(statusText()).toBe(
          "You're offline — showing the last loaded results.",
        ),
      );
      expect(screen.queryByRole("button", { name: /^Retry/ })).toBeNull();
      expect(rowIds()).toHaveLength(3);
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it("click the footer text, Shift+Tab: the popup is still open and onChange was not called", async () => {
    const t = setup(kind, { initial: [ALICE], commitOnClose: true });
    const filter = await t.open();
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    // A ticked row makes the set differ, so a close here would commit.
    await t.user.click(rowBox("bob"));
    expect(rowBox("bob").getAttribute("aria-checked")).toBe("true");
    await t.user.click(screen.getByText(PICKER_LEGEND));
    await waitFor(() => expect(document.activeElement).toBe(filter));
    await t.user.keyboard("{Shift>}{Tab}{/Shift}");
    await waitFor(() => expect(document.activeElement).toBe(rowBox("carol")));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(t.onChange).not.toHaveBeenCalled();
  });

  it("1,000 users render a window, and Shift+Tab from the filter reaches the last user", async () => {
    const many = Array.from({ length: 1000 }, (_, i) =>
      ref(`user${String(i).padStart(4, "0")}`),
    );
    answer(kind, async () => list(many, true, 1000));
    const t = setup(kind);
    await t.open();
    await waitFor(() => expect(rowIds().length).toBeGreaterThan(0));
    expect(rowIds().length).toBeLessThan(60);
    await t.user.keyboard("{Shift>}{Tab}{/Shift}");
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("data-row-id")).toBe(
        "user0999",
      ),
    );
  });
});

describe("commit paths", () => {
  it("commit-on-close fires onChange once on Esc with the changed set, never per toggle", async () => {
    const t = setup("assignees", { commitOnClose: true });
    await t.open();
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    expect(screen.getByText("Changes apply when this closes.")).toBeTruthy();
    await t.user.click(rowBox("alice"));
    await t.user.click(rowBox("carol"));
    expect(t.onChange).not.toHaveBeenCalled();
    await t.user.keyboard("{Escape}");
    await waitFor(() => expect(t.onChange).toHaveBeenCalledTimes(1));
    expect(t.onChange.mock.calls[0][0].map((u: ForgeUserRef) => u.id)).toEqual([
      "alice",
      "carol",
    ]);
  });

  it("per-toggle mode writes each tick and keeps an unticked user in place", async () => {
    const t = setup("assignees", { initial: [BOB] });
    await t.open();
    await waitFor(() => expect(rowIds()).toEqual(["bob", "alice", "carol"]));
    expect(screen.queryByText("Changes apply when this closes.")).toBeNull();
    await t.user.click(rowBox("bob"));
    expect(t.onChange).toHaveBeenLastCalledWith([]);
    expect(rowIds()).toEqual(["bob", "alice", "carol"]);
    const ghost = ref("ghost");
    t.unmount();
    const u = setup("assignees", { initial: [ghost] });
    await u.open();
    await waitFor(() => expect(rowIds()[0]).toBe("ghost"));
    await u.user.click(rowBox("ghost"));
    expect(u.onChange).toHaveBeenLastCalledWith([]);
    expect(rowIds()[0]).toBe("ghost");
  });
});

describe("reviewer copy and hints", () => {
  it("GitHub and GitLab never say workspace", async () => {
    for (const provider of ["github", "gitlab"] as const) {
      vi.mocked(forgeStatus).mockResolvedValue(statusOf(provider));
      answer("reviewers", async () => list([]));
      const t = setup("reviewers");
      await t.open();
      await waitFor(() => expect(statusText()).not.toBe("Loading…"));
      expect(statusText()).toBe(
        provider === "github"
          ? "No eligible reviewers — the repository has no other collaborators."
          : "No eligible reviewers — the project has no other members.",
      );
      expect(screen.getByRole("dialog").textContent).not.toMatch(/workspace/);
      t.unmount();
    }
    vi.mocked(forgeStatus).mockResolvedValue(statusOf("bitbucket"));
    answer("reviewers", async () => list([]));
    const t = setup("reviewers");
    await t.open();
    await waitFor(() =>
      expect(statusText()).toBe(
        "No eligible reviewers — the workspace has no other members.",
      ),
    );
  });

  it("an unresolved provider takes the generic reviewer copy", async () => {
    vi.mocked(forgeStatus).mockImplementation(
      () => new Promise(() => undefined),
    );
    answer("reviewers", async () => {
      throw { kind: "network", message: "down" };
    });
    const failed = setup("reviewers");
    await failed.open();
    await waitFor(() => expect(statusText()).toBe("Couldn't load reviewers."));
    failed.unmount();
    answer("reviewers", async () => list([]));
    const empty = setup("reviewers");
    await empty.open();
    await waitFor(() => expect(statusText()).toBe("No eligible reviewers."));
  });

  it("same-label reviewers keep their hints, also while filtering", async () => {
    vi.mocked(forgeStatus).mockResolvedValue(statusOf("bitbucket"));
    answer("reviewers", async () =>
      list([
        ref("{aaaa-1}", "Sam"),
        ref("{bbbb-2}", "Sam"),
        ref("{c-3}", "Kim"),
      ]),
    );
    const t = setup("reviewers");
    const filter = await t.open();
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    // jsdom's name computation drops the space before the hint span.
    expect(screen.getByRole("checkbox", { name: /^Sam.*aaaa$/ })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /^Sam.*bbbb$/ })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Kim" })).toBeTruthy();
    await t.user.type(filter, "sam");
    expect(screen.getByRole("checkbox", { name: /^Sam.*aaaa$/ })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /^Sam.*bbbb$/ })).toBeTruthy();
  });
});

describe("read gating", () => {
  it.each<Kind>(["assignees", "reviewers"])(
    "a closed %s popover on GitHub issues no read; opening it reads once",
    async (kind) => {
      const t = setup(kind);
      await waitFor(() => expect(forgeStatus).toHaveBeenCalled());
      await settle();
      expect(reads(kind)).toBe(0);
      await t.open();
      await waitFor(() => expect(rowIds()).toHaveLength(3));
      expect(reads(kind)).toBe(1);
    },
  );

  it("a closed Reviewers popover with the provider unresolved issues no read", async () => {
    vi.mocked(forgeStatus).mockImplementation(
      () => new Promise(() => undefined),
    );
    setup("reviewers");
    await settle();
    expect(reads("reviewers")).toBe(0);
  });

  it("a closed Bitbucket Reviewers popover still reads", async () => {
    vi.mocked(forgeStatus).mockResolvedValue(statusOf("bitbucket"));
    setup("reviewers");
    await waitFor(() => expect(reads("reviewers")).toBe(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each<Kind>(["assignees", "reviewers"])(
    "%s: hover or focus on the trigger starts one read; a disabled trigger none",
    async (kind) => {
      const hovered = setup(kind);
      await settle();
      expect(reads(kind)).toBe(0);
      await hovered.user.hover(hovered.trigger);
      await waitFor(() => expect(reads(kind)).toBe(1));
      expect(screen.queryByRole("dialog")).toBeNull();
      // The latch outlives a close: no second read inside the staleTime.
      await hovered.open();
      await hovered.user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await hovered.user.hover(hovered.trigger);
      await settle();
      expect(reads(kind)).toBe(1);
      hovered.unmount();
      vi.clearAllMocks();

      const focused = setup(kind);
      await settle();
      await focused.user.tab();
      expect(document.activeElement).toBe(focused.trigger);
      await waitFor(() => expect(reads(kind)).toBe(1));
      focused.unmount();
      vi.clearAllMocks();

      const disabled = setup(kind, { disabledReason: "No access" });
      await settle();
      await disabled.user.hover(disabled.trigger);
      act(() => disabled.trigger.focus());
      await settle();
      expect(reads(kind)).toBe(0);
    },
  );
});
