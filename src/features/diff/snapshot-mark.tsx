import { Component } from "react";

/** A diff's line keeper, for a host that changes the layout above the rows in
 *  a commit of its own: `read` from a `SnapshotMark` on that change, `restore`
 *  from the layout effect that follows it. */
export interface LineKeeper {
  read(): void;
  restore(): void;
}

/** Calls `read` in the commit that changes `on`, before React mutates the DOM
 *  (`getSnapshotBeforeUpdate` runs ahead of every host change in the commit),
 *  so it sees the layout the reader was looking at. A mount reads nothing.
 *  A class, since no hook runs before a commit's DOM changes. */
export class SnapshotMark extends Component<{
  on: string;
  read: () => void;
}> {
  getSnapshotBeforeUpdate(prev: Readonly<{ on: string }>) {
    if (prev.on !== this.props.on) this.props.read();
    return null;
  }

  componentDidUpdate() {
    // Present because React warns about a snapshot with no receiver; the read
    // already ran in getSnapshotBeforeUpdate.
  }

  render() {
    return null;
  }
}
