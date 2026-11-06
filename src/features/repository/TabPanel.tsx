import { Activity, type ReactNode } from "react";
import {
  PanelActivityBoundary,
  PanelPortalBoundary,
} from "@/components/panel-portal";

// Every repo tab panel goes through this: the <Activity> + boundary pairing
// is the invariant, and wrapping <Activity> alone re-mints the stranded-popup
// bug. Module scope is required — declared inside RepositoryView it would be
// a new component type each render, remounting every panel and losing the
// state <Activity> exists to preserve (filters, selections, scroll). A hidden
// <Activity> connects no effects, so hidden panels hold no live query
// observers and fetch nothing while hidden; the real cost is the RE-SHOW
// refetch of anything past its staleTime. Heavy tabs keep their
// `active`-style query gates as a backstop.
export function TabPanel({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Activity mode={active ? "visible" : "hidden"}>
      <PanelActivityBoundary active={active}>
        <PanelPortalBoundary>{children}</PanelPortalBoundary>
      </PanelActivityBoundary>
    </Activity>
  );
}
