import { act, renderHook } from "@testing-library/react";
import { type ReactNode, useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadState } from "@/features/projects/board-return";
import {
  type BoardAnchorQuery,
  type BoardReturnInput,
  boardAnchorAnswer,
  useBoardReturn,
} from "@/features/projects/use-board-return";
import { TabPanel } from "@/features/repository/TabPanel";
import {
  __resetNavHistoryForTests,
  type BoardAnchor,
  registerNavAnchorProvider,
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
  /** The repository the panel renders for: the store's, un-deferred. */
  repoPath: string;
  /** The raw board cursor's card id, as last written. */
  boardCursorId: string | null;
  /** The raw table cursor's row key, as last written. */
  tableCursorKey: string | null;
  /** The raw table cursor's column, as last written. */
  tableCursorCol: number | null;
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
    repoPath: REPO,
    boardCursorId: null,
    tableCursorKey: null,
    tableCursorCol: null,
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
    repoPath: state.repoPath,
    boardCursorId: state.boardCursorId,
    tableCursorKey: state.tableCursorKey,
    tableCursorCol: state.tableCursorCol,
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

  it("waits for the views read when the anchor's view is already active, then claims", () => {
    const panel = makePanel({ views: "loading" });
    const { commit } = mount(panel);
    arm(anchorOf());
    commit();
    expect(panel.log).toEqual([]);
    commit(() => {
      panel.state.views = "ready";
    });
    expect(panel.log).toEqual(['claimCard("I1", {"focus":true})']);
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

  it("a claim never takes focus from a toolbar control the user moved to after the return was consumed, and still announces a gone card", () => {
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

  it("a second request consumed while a return waits on its reads replaces it, and only the second claims", () => {
    const panel = makePanel({ items: "loading", layoutDrawn: false });
    const { commit, result } = mount(panel);
    arm(anchorOf());
    expect(result.current.heldAnchor).toEqual(anchorOf());
    const next = anchorOf({ itemId: "I3" });
    arm(next);
    expect(result.current.heldAnchor).toEqual(next);
    expect(result.current.retiredAnchor).toBeNull();
    commit(() => {
      panel.state.items = "ready";
      panel.state.layoutDrawn = true;
    });
    commit();
    expect(panel.log).toEqual(['claimCard("I3", {"focus":true})']);
  });

  it("the same across a repository: one commit moves the repository, the epoch and the request", () => {
    const panel = makePanel({ items: "loading", layoutDrawn: false });
    const { commit, result } = mount(panel);
    arm(anchorOf());
    expect(result.current.heldAnchor).toEqual(anchorOf());
    const next = anchorOf({ itemId: "I3" });
    commit(() => {
      panel.state.repoPath = OTHER;
      const epoch = st().interactionEpoch + 1;
      useUiStore.setState({
        repoPath: OTHER,
        interactionEpoch: epoch,
        boardReturn: { anchor: next, epoch },
      });
    });
    expect(result.current.heldAnchor).toEqual(next);
    expect(result.current.retiredAnchor).toBeNull();
    commit(() => {
      panel.state.items = "ready";
      panel.state.layoutDrawn = true;
    });
    commit();
    expect(panel.log).toEqual(['claimCard("I3", {"focus":true})']);
  });
});

describe("the return across a repository or fork-side switch", () => {
  /** Another repository's (or fork side's) visit left this panel on its board:
   *  P2, no view, and Show archived flipped on. */
  const visited = (over: Partial<PanelState> = {}) =>
    makePanel({
      repoPath: OTHER,
      projectId: "P2",
      activeViewId: null,
      archivedShown: true,
      cards: ["J1"],
      boardCards: { P1: ["I1", "I2"] },
      ...over,
    });

  /** The cross-segment restore's one set, and the commit that shows the panel
   *  for the restored repository, in one act. */
  const restore = (
    panel: Panel,
    commit: ReturnType<typeof mount>["commit"],
    anchor: BoardAnchor,
    panelChange?: () => void,
  ) =>
    commit(() => {
      const epoch = st().interactionEpoch + 1;
      useUiStore.setState({
        repoPath: REPO,
        interactionEpoch: epoch,
        boardReturn: { anchor, epoch },
      });
      panel.state.repoPath = REPO;
      panel.state.active = true;
      panelChange?.();
    });

  beforeEach(() => {
    useUiStore.setState({ repoPath: OTHER });
  });

  it("RT1: a hidden panel carrying another board's state re-applies the anchor's project, view and Show archived, then claims", () => {
    const panel = visited({ active: false });
    const { commit } = mount(panel);
    restore(panel, commit, anchorOf());
    expect(panel.log).toEqual([
      'switchProject("P1")',
      'pickView("V1")',
      "setArchived(false)",
      'claimCard("I1", {"focus":true})',
    ]);
    expect(st().boardReturn).toBeNull();
  });

  it("RT2: the same with the panel active across the repository change", () => {
    const panel = visited();
    const { commit } = mount(panel);
    restore(panel, commit, anchorOf());
    expect(panel.log).toEqual([
      'switchProject("P1")',
      'pickView("V1")',
      "setArchived(false)",
      'claimCard("I1", {"focus":true})',
    ]);
  });

  it("RT3: a request armed while the panel still renders the other repository is dropped", () => {
    const panel = visited();
    const { commit } = mount(panel);
    restore(panel, commit, anchorOf(), () => {
      panel.state.repoPath = OTHER;
    });
    commit(() => {
      panel.state.repoPath = REPO;
    });
    commit();
    expect(panel.log).toEqual([]);
  });

  it("RT4: a catalog still loading for the restored repository waits, then claims", () => {
    const panel = visited({
      projectId: "P1",
      activeViewId: "V1",
      archivedShown: false,
      cards: ["I1"],
    });
    const { commit, result } = mount(panel);
    restore(panel, commit, anchorOf(), () => {
      panel.state.catalog = "loading";
    });
    expect(panel.log).toEqual([]);
    expect(result.current.heldAnchor).toEqual(anchorOf());
    commit(() => {
      panel.state.catalog = "ready";
    });
    expect(panel.log).toEqual(['claimCard("I1", {"focus":true})']);
  });

  it("RT4: a catalog that fails for the restored repository ends with no focus move and no announcement", () => {
    const panel = visited();
    const { commit, result } = mount(panel);
    act(() => toolbar.focus());
    restore(panel, commit, anchorOf(), () => {
      panel.state.catalog = "loading";
    });
    commit(() => {
      panel.state.catalog = "dead";
    });
    commit();
    expect(panel.log).toEqual([]);
    expect(result.current.heldAnchor).toBeNull();
    expect(document.activeElement).toBe(toolbar);
  });

  it("RT5: an anchor whose project the restored repository doesn't list lands on the first card, with no gone text", () => {
    const panel = visited({ projectIds: ["P2"] });
    const { commit } = mount(panel);
    restore(panel, commit, anchorOf());
    expect(panel.log.some((l) => l.startsWith("announce"))).toBe(false);
    expect(panel.log).toEqual(['claimCard("J1", {"focus":true})']);
  });

  it("RT6: a fork-side return, the repository unchanged, waits for the catalog, then re-applies the anchor's board and claims", () => {
    // The lens lives outside the hook: to it, the other side is only the board
    // state that side's visit left in the same repository's panel. The panel was
    // hidden while away, and on show its catalog reads as loading, then ready.
    useUiStore.setState({ repoPath: REPO });
    const panel = visited({ repoPath: REPO, active: false });
    const { commit, result } = mount(panel);
    commit(() => {
      const epoch = st().interactionEpoch + 1;
      useUiStore.setState({
        interactionEpoch: epoch,
        boardReturn: { anchor: anchorOf(), epoch },
      });
      panel.state.active = true;
      panel.state.catalog = "loading";
    });
    expect(st().repoPath).toBe(REPO);
    expect(st().boardReturn).toBeNull();
    expect(panel.log).toEqual([]);
    expect(result.current.heldAnchor).toEqual(anchorOf());
    commit(() => {
      panel.state.catalog = "ready";
    });
    expect(panel.log).toEqual([
      'switchProject("P1")',
      'pickView("V1")',
      "setArchived(false)",
      'claimCard("I1", {"focus":true})',
    ]);
    expect(st().boardReturn).toBeNull();
  });
});

/** The press that moves the interaction epoch alone: no panel commit of its own. */
const press = () => act(() => st().noteUserInteraction());

const flush = () => new Promise((r) => setTimeout(r, 0));

type Hook = ReturnType<typeof mount>;

/** The board cursor's card as the live board resolves it: drawn, on a settled board. */
const liveCursorItem = (panel: Panel) => {
  const id = panel.state.boardCursorId;
  return panel.state.layoutDrawn && id !== null && panel.input().hasCard(id)
    ? id
    : null;
};

/** The Projects anchor provider as the panel builds it, over the stand-in and the
 *  hook's last render; `opener.id` is spent by a read, as the panel's opener is. */
function providerFor(panel: Panel, hook: Hook) {
  const opener = { id: null as string | null };
  const query = (): BoardAnchorQuery => ({
    opener: opener.id,
    armed: st().boardReturn?.anchor ?? null,
    held: hook.result.current.heldAnchor,
    retired: hook.result.current.retiredAnchor,
    epoch: st().interactionEpoch,
    pickGeneration: panel.state.gen,
    catalogUnread:
      panel.state.projectId === null && panel.state.catalog !== "ready",
    projectId: panel.state.projectId,
    viewId: panel.state.activeViewId,
    cursorItemId: liveCursorItem(panel),
    showArchived: panel.state.archivedShown,
  });
  const read = () => {
    const answer = boardAnchorAnswer(query());
    opener.id = null;
    return answer;
  };
  /** What the live board alone would answer now. */
  const live = () => boardAnchorAnswer({ ...query(), retired: null });
  return { opener, read, live };
}

/** A return held on the cold board with both raw cursors written, then the press
 *  and one panel commit: retired by the epoch alone. */
function retireOne(
  over: Partial<PanelState> = {},
  wrapper?: (p: { children: ReactNode }) => ReactNode,
) {
  const panel = makePanel({
    items: "loading",
    layoutDrawn: false,
    boardCursorId: "I2",
    tableCursorKey: "item:I2",
    tableCursorCol: 0,
    ...over,
  });
  const hook = mount(panel, wrapper);
  arm(anchorOf());
  hook.commit();
  expect(hook.result.current.heldAnchor).toEqual(anchorOf());
  press();
  hook.commit();
  const provider = providerFor(panel, hook);
  expect(hook.result.current.retiredAnchor?.anchor).toEqual(anchorOf());
  expect(provider.read()).toEqual(anchorOf());
  return { panel, hook, ...provider };
}

describe("a return retired by the epoch alone keeps its anchor for that departure", () => {
  it("drops the held return, answers its anchor, and never acts, then or after the reads settle", () => {
    const { panel, hook, read } = retireOne();
    expect(hook.result.current.heldAnchor).toBeNull();
    expect(hook.result.current.retiredAnchor).toEqual({
      anchor: anchorOf(),
      epoch: st().interactionEpoch,
      pickBaseline: 0,
    });
    expect(panel.log).toEqual([]);
    hook.commit(() => {
      panel.state.items = "ready";
      panel.state.layoutDrawn = true;
    });
    hook.commit();
    expect(panel.log).toEqual([]);
    expect(read()).toEqual(anchorOf());
  });

  it("data arriving with the marks unchanged keeps it answering and acts on nothing", () => {
    const { panel, hook, read, live } = retireOne();
    hook.commit(() => {
      panel.state.items = "ready";
      panel.state.layoutDrawn = true;
      panel.state.cards = ["I3", "I2"];
    });
    expect(live()).toEqual(anchorOf({ itemId: "I2" }));
    expect(read()).toEqual(anchorOf());
    expect(panel.log).toEqual([]);
  });

  it("a request refused at the consume for the epoch alone is never held and answers at the consume-time epoch", () => {
    const panel = makePanel({ boardCursorId: "I2", tableCursorKey: "item:I2" });
    const hook = mount(panel);
    arm(anchorOf(), -1);
    expect(hook.result.current.heldAnchor).toBeNull();
    expect(hook.result.current.retiredAnchor).toEqual({
      anchor: anchorOf(),
      epoch: st().interactionEpoch,
      pickBaseline: 0,
    });
    expect(providerFor(panel, hook).read()).toEqual(anchorOf());
    expect(panel.log).toEqual([]);
  });

  it("a request refused at the consume in the commit that ends an older record answers its own anchor", () => {
    const { panel, hook, read } = retireOne();
    const next = anchorOf({ itemId: "I3" });
    arm(next, -1);
    expect(hook.result.current.heldAnchor).toBeNull();
    expect(hook.result.current.retiredAnchor).toEqual({
      anchor: next,
      epoch: st().interactionEpoch,
      pickBaseline: 0,
    });
    expect(read()).toEqual(next);
    expect(panel.log).toEqual([]);
  });
});

describe("a retired anchor's endings", () => {
  it("an Activity hide ends it, and the show does not revive it", () => {
    const control: { set?: (mode: "visible" | "hidden") => void } = {};
    function Host({ children }: { children: ReactNode }) {
      const [mode, setMode] = useState<"visible" | "hidden">("visible");
      useLayoutEffect(() => {
        control.set = setMode;
      });
      return <TabPanel active={mode === "visible"}>{children}</TabPanel>;
    }
    const { hook, read } = retireOne({}, Host);
    act(() => control.set?.("hidden"));
    act(() => control.set?.("visible"));
    hook.commit();
    expect(hook.result.current.retiredAnchor).toBeNull();
    expect(read()).toEqual(anchorOf({ itemId: null }));
  });

  it("the panel going inactive ends it, and active again does not revive it", () => {
    const { panel, hook, read } = retireOne();
    hook.commit(() => {
      panel.state.active = false;
    });
    expect(hook.result.current.retiredAnchor).toBeNull();
    hook.commit(() => {
      panel.state.active = true;
    });
    expect(hook.result.current.retiredAnchor).toBeNull();
    expect(read()).toEqual(anchorOf({ itemId: null }));
  });

  it("a pick ends it at the read with no commit between, then for good", () => {
    const { panel, hook, read } = retireOne();
    panel.state.gen += 1;
    expect(read()).toEqual(anchorOf({ itemId: null }));
    hook.commit();
    expect(hook.result.current.retiredAnchor).toBeNull();
    hook.commit(() => {
      panel.state.gen -= 1;
    });
    expect(hook.result.current.retiredAnchor).toBeNull();
    expect(read()).toEqual(anchorOf({ itemId: null }));
  });

  it("a repository change ends it, and changing back does not revive it", () => {
    const { panel, hook, read } = retireOne();
    hook.commit(() => {
      useUiStore.setState({ repoPath: OTHER });
      panel.state.repoPath = OTHER;
    });
    expect(hook.result.current.retiredAnchor).toBeNull();
    hook.commit(() => {
      useUiStore.setState({ repoPath: REPO });
      panel.state.repoPath = REPO;
    });
    expect(hook.result.current.retiredAnchor).toBeNull();
    expect(read()).toEqual(anchorOf({ itemId: null }));
  });

  it("a later consume ends it, so once that return ends the old anchor does not answer", () => {
    const { panel, hook, read } = retireOne();
    const next = anchorOf({ itemId: "I3" });
    act(() =>
      useUiStore.setState({
        boardReturn: { anchor: next, epoch: st().interactionEpoch },
      }),
    );
    expect(hook.result.current.heldAnchor).toEqual(next);
    expect(read()).toEqual(next);
    hook.commit(() => {
      panel.state.items = "ready";
      panel.state.layoutDrawn = true;
    });
    expect(panel.log).toEqual(['claimCard("I3", {"focus":true})']);
    expect(hook.result.current.heldAnchor).toBeNull();
    expect(hook.result.current.retiredAnchor).toBeNull();
    expect(read()).toEqual(anchorOf({ itemId: "I2" }));
  });

  it("a further epoch move ends it at the read with no commit between, then for good", () => {
    const { hook, read } = retireOne();
    press();
    expect(read()).toEqual(anchorOf({ itemId: null }));
    hook.commit();
    expect(hook.result.current.retiredAnchor).toBeNull();
  });

  it("the board cursor moved ends it, and moving back does not revive it", () => {
    const { panel, hook, read } = retireOne();
    hook.commit(() => {
      panel.state.boardCursorId = "I3";
    });
    expect(hook.result.current.retiredAnchor).toBeNull();
    hook.commit(() => {
      panel.state.boardCursorId = "I2";
    });
    expect(hook.result.current.retiredAnchor).toBeNull();
    expect(read()).toEqual(anchorOf({ itemId: null }));
  });

  it("the table cursor moved ends it, and moving back does not revive it", () => {
    const { panel, hook, read } = retireOne();
    hook.commit(() => {
      panel.state.tableCursorKey = "item:I3";
    });
    expect(hook.result.current.retiredAnchor).toBeNull();
    hook.commit(() => {
      panel.state.tableCursorKey = "item:I2";
    });
    expect(hook.result.current.retiredAnchor).toBeNull();
    expect(read()).toEqual(anchorOf({ itemId: null }));
  });

  it("the table cursor's column moved ends it, and moving back does not revive it", () => {
    const { panel, hook, read } = retireOne();
    hook.commit(() => {
      panel.state.tableCursorCol = 1;
    });
    expect(hook.result.current.retiredAnchor).toBeNull();
    hook.commit(() => {
      panel.state.tableCursorCol = 0;
    });
    expect(hook.result.current.retiredAnchor).toBeNull();
    expect(read()).toEqual(anchorOf({ itemId: null }));
  });

  it("a Show archived toggle ends it, and toggling back does not revive it", () => {
    const { panel, hook, read } = retireOne();
    hook.commit(() => {
      panel.state.archivedShown = true;
    });
    expect(hook.result.current.retiredAnchor).toBeNull();
    hook.commit(() => {
      panel.state.archivedShown = false;
    });
    expect(hook.result.current.retiredAnchor).toBeNull();
    expect(read()).toEqual(anchorOf({ itemId: null }));
  });

  it("the raw view id changed with no pick ends it, and setting it back does not revive it", () => {
    const { panel, hook, read } = retireOne();
    hook.commit(() => {
      panel.state.activeViewId = null;
    });
    expect(panel.state.gen).toBe(0);
    expect(hook.result.current.retiredAnchor).toBeNull();
    hook.commit(() => {
      panel.state.activeViewId = "V1";
    });
    expect(hook.result.current.retiredAnchor).toBeNull();
    expect(read()).toEqual(anchorOf({ itemId: null }));
  });

  it("the user's move in the first commit after the press: no record", () => {
    const panel = makePanel({
      items: "loading",
      layoutDrawn: false,
      boardCursorId: "I2",
      tableCursorKey: "item:I2",
    });
    const hook = mount(panel);
    arm(anchorOf());
    hook.commit();
    press();
    hook.commit(() => {
      panel.state.boardCursorId = "I3";
    });
    expect(hook.result.current.heldAnchor).toBeNull();
    expect(hook.result.current.retiredAnchor).toBeNull();
    hook.commit(() => {
      panel.state.boardCursorId = "I2";
    });
    expect(hook.result.current.retiredAnchor).toBeNull();
  });
});

/** Mounts the hook and keeps every render's retired anchor: a record the next
 *  commit clears still shows here. */
function mountSeen(panel: Panel) {
  const seen: ReturnType<typeof useBoardReturn>["retiredAnchor"][] = [];
  const hook = renderHook(() => {
    const out = useBoardReturn(panel.input());
    seen.push(out.retiredAnchor);
    return out;
  });
  const commit = (change?: () => void) =>
    act(() => {
      change?.();
      panel.draw();
      hook.rerender();
    });
  return { ...hook, commit, seen };
}

describe("a drop not for the epoch alone retires nothing", () => {
  it("the epoch and the pick generation moved in one commit", () => {
    const panel = makePanel({
      items: "loading",
      layoutDrawn: false,
      boardCursorId: "I2",
      tableCursorKey: "item:I2",
    });
    const hook = mountSeen(panel);
    arm(anchorOf());
    hook.commit();
    expect(hook.result.current.heldAnchor).toEqual(anchorOf());
    hook.commit(() => {
      st().noteUserInteraction();
      panel.state.gen += 1;
    });
    expect(hook.result.current.heldAnchor).toBeNull();
    expect(hook.seen.every((anchor) => anchor === null)).toBe(true);
    expect(providerFor(panel, hook).read()).toEqual(anchorOf({ itemId: null }));
  });

  it("a consume refused for the repository", () => {
    const panel = makePanel({ boardCursorId: "I2", tableCursorKey: "item:I2" });
    const hook = mountSeen(panel);
    act(() => useUiStore.setState({ repoPath: OTHER }));
    arm(anchorOf(), -1);
    expect(st().boardReturn).toBeNull();
    expect(hook.result.current.heldAnchor).toBeNull();
    expect(hook.seen.every((anchor) => anchor === null)).toBe(true);
    expect(panel.log).toEqual([]);
  });
});

describe("boardAnchorAnswer", () => {
  const A = (itemId: string) => anchorOf({ projectId: "PA", itemId });
  /** Every arm but the live board's misses. */
  const none: BoardAnchorQuery = {
    opener: null,
    armed: null,
    held: null,
    retired: null,
    epoch: 5,
    pickGeneration: 2,
    catalogUnread: false,
    projectId: "P1",
    viewId: "V1",
    cursorItemId: "I9",
    showArchived: true,
  };
  const retired = { anchor: A("R"), epoch: 5, pickBaseline: 2 };
  const OPENED = anchorOf({ itemId: "I4", showArchived: true });
  const LIVE = anchorOf({ itemId: "I9", showArchived: true });
  const cases: [string, Partial<BoardAnchorQuery>, unknown][] = [
    ["1: an opener", { opener: "I4" }, OPENED],
    [
      "1: an opener with no project",
      { opener: "I4", projectId: null, armed: A("X") },
      null,
    ],
    ["2: an armed request", { armed: A("X") }, A("X")],
    ["3: a held return", { held: A("H") }, A("H")],
    ["4: a retired return at the live epoch and pick", { retired }, A("R")],
    ["4 misses: the epoch moved", { retired: { ...retired, epoch: 4 } }, LIVE],
    [
      "4 misses: a pick followed",
      { retired: { ...retired, pickBaseline: 1 } },
      LIVE,
    ],
    [
      "5: the catalog unread",
      { catalogUnread: true, projectId: null },
      undefined,
    ],
    ["6: no project", { projectId: null }, null],
    ["7: the live board", {}, LIVE],
    ["1 over 2", { opener: "I4", armed: A("X") }, OPENED],
    ["2 over 3", { armed: A("X"), held: A("H") }, A("X")],
    ["3 over 4", { held: A("H"), retired }, A("H")],
    ["4 over 5", { retired, catalogUnread: true, projectId: null }, A("R")],
    ["5 over 6", { catalogUnread: true, projectId: null }, undefined],
    // Arms 6 and 7 never both match: 7 needs a project. 5 over 7 instead.
    ["5 over 7", { catalogUnread: true }, undefined],
  ];
  it.each(cases)("%s", (_name, over, want) => {
    expect(boardAnchorAnswer({ ...none, ...over })).toEqual(want);
  });
});

describe("the departure a retired return describes", () => {
  it("a cross-repository Forward pressed while the return waits records the card the return was bringing back", async () => {
    const original = anchorOf();
    st().openRepo({ root: REPO, name: "alpha" });
    st().setRepoTab("projects");
    const panel = makePanel({ boardCursorId: null, tableCursorKey: null });
    const hook = mount(panel);
    const provider = providerFor(panel, hook);
    let unregister = registerNavAnchorProvider("projects", provider.read);
    act(() =>
      st().openIssue({
        repoPath: OTHER,
        repoName: "beta",
        number: 2,
        carryHistory: true,
        beforeSelect: () => {
          provider.opener.id = "I1";
        },
      }),
    );
    expect(st().repoPath).toBe(OTHER);
    unregister();
    hook.commit(() => {
      panel.state.active = false;
      panel.state.repoPath = OTHER;
    });
    act(() => st().goBack());
    expect(st().repoPath).toBe(REPO);
    expect(st().boardReturn?.anchor).toEqual(original);
    hook.commit(() => {
      panel.state.active = true;
      panel.state.repoPath = REPO;
      panel.state.items = "loading";
      panel.state.layoutDrawn = false;
    });
    unregister = registerNavAnchorProvider("projects", provider.read);
    expect(hook.result.current.heldAnchor).toEqual(original);
    const pending: ((ok: boolean) => void)[] = [];
    const validate = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          pending.push(resolve);
        }),
    );
    act(() => st().goForward({ validate }));
    expect(st().repoPath).toBe(REPO);
    expect(validate).toHaveBeenCalledTimes(1);
    hook.commit();
    expect(hook.result.current.heldAnchor).toBeNull();
    expect(provider.live()).toEqual({ ...original, itemId: null });
    await act(async () => {
      for (const resolve of pending.splice(0)) resolve(true);
      await flush();
    });
    expect(st().repoPath).toBe(OTHER);
    unregister();
    const entry = st().navHistory.segments[0]?.entries.find(
      (e) => e.tab === "projects",
    );
    expect(st().navHistory.segments[0]?.repoPath).toBe(REPO);
    expect(entry?.anchor).toEqual(original);
    expect(panel.log).toEqual([]);
  });
});
