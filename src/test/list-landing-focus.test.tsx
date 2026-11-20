import { act, cleanup, render, screen } from "@testing-library/react";
import { type ComponentProps, useDeferredValue } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationListPanel } from "@/features/conversations/ConversationListPanel";
import { detailKeyOf } from "@/features/conversations/detail-key";
import { useUiStore } from "@/lib/stores/ui";

type Item = { id: string; title: string };
type PanelProps = ComponentProps<
  typeof ConversationListPanel<Item, Item, "open" | "closed">
>;

const noop = () => undefined;

/** A settled, ready, empty list. */
function baseProps(): PanelProps {
  return {
    repoPath: "C:/repo",
    feature: "issues",
    stateFilter: "open",
    onStateFilter: noop,
    newMenu: {
      ghLabel: "Issue…",
      ghDisabled: false,
      onGh: noop,
      localLabel: "Local issue…",
      onLocal: noop,
    },
    filterSlot: null,
    filterRef: { current: null },
    filterText: "",
    onFilterText: noop,
    onListKeyDown: noop,
    stateLocal: [],
    visibleLocal: [],
    localKey: (l) => l.id,
    isLocalActive: () => false,
    onSelectLocal: noop,
    renderLocalRow: (l) => l.title,
    archivedLocalCount: 0,
    showArchived: false,
    onToggleArchived: noop,
    localCollapsed: false,
    remoteCollapsed: false,
    onToggleLocal: noop,
    onToggleRemote: noop,
    ghPending: false,
    ghProbeFailed: false,
    ghReady: true,
    listPending: false,
    stateRemote: [],
    visibleRemote: [],
    remoteKey: (r) => r.id,
    isRemoteActive: () => false,
    onSelectRemote: noop,
    onRemoteHover: noop,
    renderRemoteRow: (r) => r.title,
    remoteSkeletonRows: 2,
    remoteFetching: false,
    localNoun: "issues",
    remoteNoun: "issues",
  };
}

/** RepositoryView's shape: one deferred selection feeds both the detail and
 *  the list's key. */
function Shell() {
  const selected = useUiStore((s) => s.selectedIssue);
  const shown = useDeferredValue(selected) ?? selected;
  const detailKey = detailKeyOf(shown);
  return (
    <>
      <ConversationListPanel {...baseProps()} detailKey={detailKey} />
      {shown && <button type="button">detail</button>}
    </>
  );
}

/** The list's tabIndex -1 host, which owns the arrow-key handler. */
const listHost = () => screen.getByText("Local").closest('[tabindex="-1"]');

function outsideInput() {
  const input = document.createElement("input");
  document.body.appendChild(input);
  input.focus();
  return input;
}

/** The real clear paths are urgent store writes, never transitions. */
const select = (issue: { kind: "remote"; id: string } | null) =>
  act(() => useUiStore.setState({ selectedIssue: issue }));

beforeEach(() => {
  useUiStore.setState({ selectedIssue: { kind: "remote", id: "7" } });
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  useUiStore.setState({ selectedIssue: null });
});

describe("the list takes focus when the detail closes", () => {
  it("lands on the list host when a clear unmounts the focused detail", () => {
    render(<Shell />);
    expect(listHost()).not.toBeNull();
    const detail = screen.getByRole("button", { name: "detail" });
    detail.focus();
    select(null);
    expect(detail.isConnected).toBe(false);
    expect(document.activeElement).toBe(listHost());
  });

  it("leaves focus on a visible element outside", () => {
    render(<Shell />);
    const input = outsideInput();
    select(null);
    expect(screen.queryByRole("button", { name: "detail" })).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it("moves nothing when another item is shown", () => {
    render(<Shell />);
    expect(document.activeElement).toBe(document.body);
    select({ kind: "remote", id: "8" });
    expect(document.activeElement).toBe(document.body);
  });

  it("moves nothing when an item is shown from none", () => {
    useUiStore.setState({ selectedIssue: null });
    render(<Shell />);
    select({ kind: "remote", id: "7" });
    expect(document.activeElement).toBe(document.body);
  });

  it("moves nothing when the key is omitted", () => {
    const { rerender } = render(<ConversationListPanel {...baseProps()} />);
    rerender(<ConversationListPanel {...baseProps()} />);
    expect(document.activeElement).toBe(document.body);
  });

  it("moves nothing when the key is omitted after being set", () => {
    const { rerender } = render(
      <ConversationListPanel {...baseProps()} detailKey="x" />,
    );
    rerender(<ConversationListPanel {...baseProps()} />);
    expect(document.activeElement).toBe(document.body);
  });

  it("lands on the list host when the prop turns null with focus on <body>", () => {
    const { rerender } = render(
      <ConversationListPanel {...baseProps()} detailKey="x" />,
    );
    expect(document.activeElement).toBe(document.body);
    rerender(<ConversationListPanel {...baseProps()} detailKey={null} />);
    expect(document.activeElement).toBe(listHost());
  });
});
