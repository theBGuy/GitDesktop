import { Activity, type ReactNode } from "react";
import {
  PanelActivityBoundary,
  PanelPortalBoundary,
} from "@/components/panel-portal";

// Every repo tab panel goes through this: the <Activity> + boundary pairing is
// the invariant, since a bare <Activity> re-mints the stranded-popup bug.
// Module scope is required: a component declared inside another is a new type
// each render, remounting every panel and losing its state. Hidden panels
// connect no effects, so they fetch nothing; the cost is the re-show refetch
// past staleTime, and heavy tabs keep `active` query gates as a backstop.
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
