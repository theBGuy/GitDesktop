import { act, renderHook } from "@testing-library/react";
import { type ReactNode, useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadState } from "@/features/projects/board-return";
import {
  type BoardReturnInput,
  useBoardReturn,
} from "@/features/projects/use-board-return";
import { TabPanel } from "@/features/repository/TabPanel";
import {
  __resetNavHistoryForTests,
  type BoardAnchor,
} from "@/lib/stores/nav-history";
import { useUiStore } from "@/lib/stores/ui";

// The board return through its hook: consumed once while active and epoch-checked,
// dropped by a pick that is not its own, a repo switch or a hide, ended by every
// claim, refocus or landing, and never taking focus from the user. The panel is a
// mutable stand-in whose callbacks write it the way ProjectsBoardPanel's do; a
// `commit()` re-renders the hook over its current state.

/** The gone text the stand-in hands the hook for each layout. */
const GONE_TEXT = {
  board: "gone from the board",
  table: "gone from the table",
  roadmap: "gone from the roadmap",
};

const REPO = "C:/repos/alpha";
const OTHER = "C:/repos/beta";

const st = () => useUiStore.getState();

const anchorOf = (over: Partial<BoardAnchor> = {}): BoardAnchor => ({
  projectId: "P1",
  viewId: "V1",
  itemId: "I1",
  showArchived: false,
  ...over,
});

interface PanelState {
  active: boolean;
  gate: "open" | "pending" | "closed";
  catalog: ReadState;
  projectIds: string[];
  projectId: string | null;
  views: ReadState;
  viewIds: string[];
  activeViewId: string | null;
  fields: ReadState;
  items: ReadState;
  itemsFetching: boolean;
  archivedShown: boolean;
  seedPending: boolean;
  layoutDrawn: boolean;
  rows: boolean;
  /** Which rows layout draws while `rows` is set. */
  rowsLayout: "table" | "roadmap";
  rowCursor: boolean;
  /** The drawn cards (board) or item rows (rows layout), in order. */
  cards: string[];
  /** A collapsed section header drawn ahead of the item rows. */
  header: string | null;
  /** Cards drawn only while Show archived is on. */
  archived: string[];
  /** Each project's cards, drawn by a project switch. */
  boardCards: Record<string, string[]>;
  gen: number;
}

let root: HTMLElement;
let toolbar: HTMLButtonElement;
let landing: HTMLButtonElement;
let body: HTMLElement;

function makePanel(over: Partial<PanelState> = {}) {
  const state: PanelState = {
    active: true,
    gate: "open",
    catalog: "ready",
    projectIds: ["P1", "P2"],
    projectId: "P1",
    views: "ready",
    viewIds: ["V1", "V2"],
    activeViewId: "V1",
    fields: "ready",
    items: "ready",
    itemsFetching: false,
    archivedShown: false,
    seedPending: false,
    layoutDrawn: true,
    rows: false,
    rowsLayout: "table",
    rowCursor: false,
    cards: ["I1", "I2", "I3"],
    header: null,
    archived: [],
    boardCards: {},
    gen: 0,
    ...over,
  };
  const log: string[] = [];
  const spy = <A extends unknown[]>(name: string, run?: (...a: A) => void) =>
    vi.fn((...a: A) => {
      log.push(`${name}(${a.map((x) => JSON.stringify(x)).join(", ")})`);
      run?.(...a);
    });
  const calls = {
    switchProject: spy<[string]>("switchProject", (id) => {
      state.gen += 1;
      state.projectId = id;
      state.activeViewId = null;
      state.cards = state.boardCards[id] ?? [];
    }),
    pickView: spy<[string | null]>("pickView", (id) => {
      state.gen += 1;
      state.activeViewId = id;
    }),
    setArchived: spy<[boolean]>("setArchived", (shown) => {
      state.archivedShown = shown;
    }),
    claimCard: spy<[string, { focus: boolean }]>("claimCard"),
    seedRowCursor: spy<[string]>("seedRowCursor"),
    refocus: spy<[]>("refocus"),
    focusLanding: spy<[]>("focusLanding"),
    announce: spy<[string]>("announce"),
  };
  const drawn = () =>
    state.archivedShown ? [...state.cards, ...state.archived] : state.cards;
  // Keeps the nodes that stay drawn, so focus on one survives a commit; a removed
  // node takes its focus with it, to body.
  const node = (key: string, id: string | null, index: number) => {
    const el = document.createElement("div");
    el.dataset.key = key;
    if (!state.rows && id !== null) {
      el.dataset.cardIndex = String(index);
      el.dataset.itemId = id;
      el.tabIndex = 0;
      return el;
    }
    el.dataset.rowKey = key;
    if (id !== null) el.dataset.itemId = id;
    const cell = document.createElement("div");
    cell.dataset.tableCell = "";
    cell.tabIndex = 0;
    el.append(cell);
    return el;
  };
  const draw = () => {
    const want: [string, string | null][] = [
      ...(state.header === null
        ? []
        : [[state.header, null] as [string, null]]),
      ...drawn().map((id): [string, string] => [`item:${id}`, id]),
    ];
    const keys = new Set(want.map(([key]) => key));
    for (const el of [...body.children])
      if (!keys.has((el as HTMLElement).dataset.key ?? "")) el.remove();
    want.forEach(([key, id], index) => {
      if (body.querySelector(`[data-key="${key}"]`) === null)
        body.append(node(key, id, index));
    });
  };
  draw();
  const input = (): BoardReturnInput => ({
    active: state.active,
    repoPath: REPO,
    goneMessage: GONE_TEXT[state.rows ? state.rowsLayout : "board"],
    root: () => root,
    grid: () => (state.rows ? body : null),
    gate: state.gate,
    catalog: state.catalog,
    projectIds: state.projectIds,
    projectId: state.projectId,
    views: state.views,
    viewIds: state.viewIds,
    activeViewId: state.activeViewId,
    fields: state.fields,
    items: state.items,
    itemsFetching: state.itemsFetching,
    archivedShown: state.archivedShown,
    seedPending: state.seedPending,
    layoutDrawn: state.layoutDrawn,
    rows: state.rows,
    rowsDrawn: state.rows && (drawn().length > 0 || state.header !== null),
    rowCursor: state.rowCursor,
    firstRowKey: state.header ?? (drawn()[0] ? `item:${drawn()[0]}` : null),
    firstItemId: drawn()[0] ?? null,
    hasCard: (id) => drawn().includes(id),
    pickGeneration: () => state.gen,
    ...calls,
  });
  /** Where a card or item row's focusable node is now. */
  const spot = (id: string) =>
    body.querySelector<HTMLElement>(
      state.rows
        ? `[data-item-id="${id}"] [data-table-cell]`
        : `[data-item-id="${id}"]`,
    );
  return { state, calls, log, input, draw, spot };
}

type Panel = ReturnType<typeof makePanel>;

function mount(
  panel: Panel,
  wrapper?: (p: { children: ReactNode }) => ReactNode,
) {
  const hook = renderHook(() => useBoardReturn(panel.input()), { wrapper });
  /** A panel commit over its current state. */
  const commit = (change?: () => void) =>
    act(() => {
      change?.();
      panel.draw();
      hook.rerender();
    });
  return { ...hook, commit };
}

/** What a goBack onto the Projects entry arms: the request at the restore's epoch. */
function arm(anchor: BoardAnchor, epochOffset = 0) {
  act(() => {
    const epoch = st().interactionEpoch + 1;
    useUiStore.setState({
      interactionEpoch: epoch,
      boardReturn: { anchor, epoch: epoch + epochOffset },
    });
  });
}

beforeEach(() => {
  useUiStore.setState(useUiStore.getInitialState(), true);
  __resetNavHistoryForTests();
  useUiStore.setState({ repoPath: REPO });
  root = document.createElement("div");
  root.tabIndex = -1;
  toolbar = document.createElement("button");
  toolbar.textContent = "Add item";
  landing = document.createElement("button");
  landing.dataset.bodyLanding = "";
  body = document.createElement("div");
  body.setAttribute("role", "grid");
  root.append(toolbar, landing, body);
  document.body.append(root);
});

afterEach(() => {
  root.remove();
  useUiStore.setState(useUiStore.getInitialState(), true);
  __resetNavHistoryForTests();
});

describe("the return lands on the anchor", () => {
  it("claims the anchor's card on the same mount, once, and consumes the request", () => {
    const panel = makePanel();
    const { commit, result } = mount(panel);
    arm(anchorOf());
    expect(st().boardReturn).toBeNull();
    commit();
    commit();
    expect(panel.calls.claimCard).toHaveBeenCalledTimes(1);
    expect(panel.calls.claimCard).toHaveBeenCalledWith("I1", { focus: true });
    expect(panel.calls.announce).not.toHaveBeenCalled();
    expect(result.current.heldAnchor).toBeNull();
  });

  it("re-applies the project, the view and Show archived after a remount, then claims", () => {
    const panel = makePanel({
      projectId: "P2",
      activeViewId: null,
      cards: ["J1"],
      boardCards: { P1: ["I0"] },
      archived: ["I1"],
    });
    const { commit } = mount(panel);
    arm(anchorOf({ showArchived: true }));
    commit();
    expect(panel.log).toEqual([
      'switchProject("P1")',
      'pickView("V1")',
      "setArchived(true)",
      'claimCard("I1", {"focus":true})',
    ]);
  });

  it("a card the settled board no longer draws: the first drawn card, announced", () => {
    const panel = makePanel({ cards: ["I2", "I3"] });
    mount(panel);
    arm(anchorOf());
    expect(panel.log).toEqual([
      'claimCard("I2", {"focus":true})',
      'announce("gone from the board")',
    ]);
  });

  it("an anchor with no card lands quietly on the board's first card", () => {
    const panel = makePanel();
    mount(panel);
    arm(anchorOf({ itemId: null }));
    expect(panel.log).toEqual(['claimCard("I1", {"focus":true})']);
  });

  it("an anchor with no card on an empty board takes the body landing quietly", () => {
    const panel = makePanel({ cards: [] });
    mount(panel);
    act(() => landing.focus());
    arm(anchorOf({ itemId: null }));
    expect(panel.log).toEqual(["focusLanding()"]);
  });

  it("waits for the items read, then claims", () => {
    const panel = makePanel({ items: "loading", layoutDrawn: false });
    const { commit, result } = mount(panel);
    arm(anchorOf());
    commit();
    expect(panel.log).toEqual([]);
    expect(result.current.heldAnchor).toEqual(anchorOf());
    commit(() => {
      panel.state.items = "ready";
      panel.state.layoutDrawn = true;
    });
    expect(panel.log).toEqual(['claimCard("I1", {"focus":true})']);
    expect(result.current.heldAnchor).toBeNull();
  });

  it("a read that fails ends the return at once; a later retry claims nothing", () => {
    const panel = makePanel({ items: "loading", layoutDrawn: false });
    const { commit, result } = mount(panel);
    arm(anchorOf());
    commit(() => {
      panel.state.items = "dead";
    });
    expect(result.current.heldAnchor).toBeNull();
    commit(() => {
      panel.state.items = "ready";
      panel.state.layoutDrawn = true;
    });
    expect(panel.log).toEqual([]);
  });

  it("a forge read that closes the gate ends the return", () => {
    const panel = makePanel({ gate: "pending" });
    const { commit } = mount(panel);
    arm(anchorOf());
    commit(() => {
      panel.state.gate = "closed";
    });
    commit(() => {
      panel.state.gate = "open";
    });
    expect(panel.log).toEqual([]);
  });

  it("a claim under a refetch is re-checked once: removed, with focus on body, takes the gone arm", () => {
    const panel = makePanel({ itemsFetching: true });
    const { commit } = mount(panel);
    arm(anchorOf());
    expect(panel.log).toEqual(['claimCard("I1", {"focus":true})']);
    commit(() => {
      panel.state.itemsFetching = false;
      panel.state.cards = ["I2"];
    });
    commit();
    expect(panel.log).toEqual([
      'claimCard("I1", {"focus":true})',
      'claimCard("I2", {"focus":true})',
      'announce("gone from the board")',
    ]);
  });

  it("a claim under a refetch whose card survives ends with no second claim", () => {
    const panel = makePanel({ itemsFetching: true });
    const { commit, result } = mount(panel);
    arm(anchorOf());
    commit(() => {
      panel.state.itemsFetching = false;
    });
    commit();
    expect(panel.calls.claimCard).toHaveBeenCalledTimes(1);
    expect(result.current.heldAnchor).toBeNull();
  });

  it("a claim under a refetch ends silently once the user moved focus to another card", () => {
    const panel = makePanel({ itemsFetching: true });
    const { commit, result } = mount(panel);
    arm(anchorOf());
    act(() => panel.spot("I2")?.focus());
    commit(() => {
      panel.state.itemsFetching = false;
      panel.state.cards = ["I2", "I3"];
    });
    commit();
    expect(panel.log).toEqual(['claimCard("I1", {"focus":true})']);
    expect(result.current.heldAnchor).toBeNull();
  });

  it("on rows, a claimed row the refetch removes is announced and the grid keeps its own landing", () => {
    const panel = makePanel({
      rows: true,
      rowCursor: true,
      itemsFetching: true,
    });
    const { commit } = mount(panel);
    arm(anchorOf());
    commit(() => {
      panel.state.cards = ["I2", "I3"];
    });
    // The grid's own recovery lands on a neighbouring cell before the fetch settles.
    act(() => panel.spot("I2")?.focus());
    commit(() => {
      panel.state.itemsFetching = false;
    });
    expect(panel.log).toEqual([
      'claimCard("I1", {"focus":true})',
      'announce("gone from the table")',
    ]);
  });

  it("on a roadmap, the gone row is announced in the roadmap's words", () => {
    const panel = makePanel({
      rows: true,
      rowsLayout: "roadmap",
      rowCursor: true,
      itemsFetching: true,
    });
    const { commit } = mount(panel);
    arm(anchorOf());
    commit(() => {
      panel.state.cards = ["I2", "I3"];
    });
    act(() => panel.spot("I2")?.focus());
    commit(() => {
      panel.state.itemsFetching = false;
    });
    expect(panel.log).toEqual([
      'claimCard("I1", {"focus":true})',
      'announce("gone from the roadmap")',
    ]);
  });

  it("a claim refused focus whose card the refetch removes still announces", () => {
    const panel = makePanel({ itemsFetching: true, seedPending: true });
    const { commit } = mount(panel);
    arm(anchorOf());
    // The user tabs to the toolbar while the return waits.
    act(() => toolbar.focus());
    commit(() => {
      panel.state.seedPending = false;
    });
    commit(() => {
      panel.state.itemsFetching = false;
      panel.state.cards = ["I2"];
    });
    commit();
    expect(panel.log).toEqual([
      'claimCard("I1", {"focus":false})',
      'announce("gone from the board")',
    ]);
    expect(document.activeElement).toBe(toolbar);
  });

  it("on rows with no table cursor, a no-card refocus first seeds the first drawn row", () => {
    const panel = makePanel({ rows: true, cards: [], header: "group:B1" });
    mount(panel);
    arm(anchorOf({ itemId: null }));
    expect(panel.log).toEqual(['seedRowCursor("group:B1")', "refocus()"]);
  });

  it("on rows with a table cursor, a no-card refocus writes no cursor", () => {
    const panel = makePanel({ rows: true, rowCursor: true });
    mount(panel);
    arm(anchorOf({ itemId: null }));
    expect(panel.log).toEqual(["refocus()"]);
  });

  it("a Show archived toggle the user makes while the return waits stands", () => {
    const panel = makePanel({ items: "loading", layoutDrawn: false });
    const { commit } = mount(panel);
    arm(anchorOf());
    commit(() => {
      panel.state.archivedShown = true;
    });
    commit(() => {
      panel.state.items = "ready";
      panel.state.layoutDrawn = true;
    });
    expect(panel.calls.setArchived).not.toHaveBeenCalled();
    expect(panel.log).toEqual(['claimCard("I1", {"focus":true})']);
  });
});

describe("the return never steals", () => {
  it("a request whose epoch moved is cleared unacted and never held", () => {
    const panel = makePanel();
    const held: (BoardAnchor | null)[] = [];
    renderHook(() => {
      const out = useBoardReturn(panel.input());
      held.push(out.heldAnchor);
      return out;
    });
    arm(anchorOf(), -1);
    expect(st().boardReturn).toBeNull();
    expect(panel.log).toEqual([]);
    expect(held.every((anchor) => anchor === null)).toBe(true);
  });

  it("is consumed only while the panel is active", () => {
    const panel = makePanel({ active: false });
    const { commit } = mount(panel);
    arm(anchorOf());
    commit();
    expect(st().boardReturn).not.toBeNull();
    expect(panel.log).toEqual([]);
    commit(() => {
      panel.state.active = true;
    });
    expect(st().boardReturn).toBeNull();
    expect(panel.log).toEqual(['claimCard("I1", {"focus":true})']);
  });

  it("a board or view pick that is not the hook's drops the held return", () => {
    const panel = makePanel({ items: "loading", layoutDrawn: false });
    const { commit, result } = mount(panel);
    arm(anchorOf());
    commit(() => {
      panel.state.gen += 1;
    });
    expect(result.current.heldAnchor).toBeNull();
    commit(() => {
      panel.state.items = "ready";
      panel.state.layoutDrawn = true;
    });
    expect(panel.log).toEqual([]);
  });

  it("a repo switch drops the held return", () => {
    const panel = makePanel({ items: "loading", layoutDrawn: false });
    const { commit } = mount(panel);
    arm(anchorOf());
    commit(() => useUiStore.setState({ repoPath: OTHER }));
    commit(() => {
      useUiStore.setState({ repoPath: REPO });
      panel.state.items = "ready";
      panel.state.layoutDrawn = true;
    });
    expect(panel.log).toEqual([]);
  });

  it("an Activity hide drops the held return", () => {
    const control: { set?: (mode: "visible" | "hidden") => void } = {};
    function Host({ children }: { children: ReactNode }) {
      const [mode, setMode] = useState<"visible" | "hidden">("visible");
      useLayoutEffect(() => {
        control.set = setMode;
      });
      return <TabPanel active={mode === "visible"}>{children}</TabPanel>;
    }
    const panel = makePanel({ items: "loading", layoutDrawn: false });
    const { commit } = mount(panel, Host);
    arm(anchorOf());
    commit();
    act(() => control.set?.("hidden"));
    act(() => control.set?.("visible"));
    commit(() => {
      panel.state.items = "ready";
      panel.state.layoutDrawn = true;
    });
    expect(panel.log).toEqual([]);
  });

  it("a claim never takes focus from a toolbar control, and still announces a gone card", () => {
    const panel = makePanel({ cards: ["I2"], seedPending: true });
    const { commit } = mount(panel);
    arm(anchorOf());
    act(() => toolbar.focus());
    commit(() => {
      panel.state.seedPending = false;
    });
    expect(panel.log).toEqual([
      'claimCard("I2", {"focus":false})',
      'announce("gone from the board")',
    ]);
    expect(document.activeElement).toBe(toolbar);
  });

  it("focus on another card is the user's: cursor only, no announcement, and the return ends", () => {
    const panel = makePanel({ itemsFetching: true, seedPending: true });
    const { commit, result } = mount(panel);
    arm(anchorOf());
    act(() => panel.spot("I2")?.focus());
    commit(() => {
      panel.state.seedPending = false;
    });
    expect(panel.log).toEqual(['claimCard("I1", {"focus":false})']);
    expect(result.current.heldAnchor).toBeNull();
    commit(() => {
      panel.state.itemsFetching = false;
      panel.state.cards = ["I2"];
    });
    commit();
    expect(panel.log).toEqual(['claimCard("I1", {"focus":false})']);
  });

  it("takes focus from a body-landing control", () => {
    const panel = makePanel({ cards: ["I1"] });
    mount(panel);
    act(() => landing.focus());
    arm(anchorOf());
    expect(panel.log).toEqual(['claimCard("I1", {"focus":true})']);
  });

  it("takes focus from the element focused at consume, a toolbar control included", () => {
    const panel = makePanel({ items: "loading", layoutDrawn: false });
    const { commit } = mount(panel);
    act(() => toolbar.focus());
    arm(anchorOf());
    commit(() => {
      panel.state.items = "ready";
      panel.state.layoutDrawn = true;
    });
    expect(panel.log).toEqual(['claimCard("I1", {"focus":true})']);
  });
});
