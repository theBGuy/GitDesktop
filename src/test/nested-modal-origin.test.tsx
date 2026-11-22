import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fromOtherModal } from "@/lib/hotkeys/open-modal";

// fromOtherModal rests on where the real primitives portal: a picker a dialog
// opens lands inside that dialog's portal node, a nested dialog in its own.

function Outer({ children }: { children: React.ReactNode }) {
  return (
    <Dialog open>
      <DialogContent data-testid="outer">
        <DialogTitle>Outer</DialogTitle>
        <DialogDescription>Outer dialog</DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  );
}

describe("fromOtherModal over the real primitives", () => {
  it("keeps a Select popup opened inside a dialog as that dialog's own", async () => {
    render(
      <Outer>
        <Select defaultValue="a" open>
          <SelectTrigger aria-label="Pick">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="a">Alpha</SelectItem>
            <SelectItem value="b">Beta</SelectItem>
          </SelectContent>
        </Select>
      </Outer>,
    );
    const outer = screen.getByTestId("outer");
    const option = await screen.findByRole("option", { name: "Beta" });
    expect(outer.contains(option)).toBe(false);
    expect(fromOtherModal(option, outer)).toBe(false);
  });

  it("marks a dialog opened inside a dialog as another modal", async () => {
    render(
      <Outer>
        <Dialog open>
          <DialogContent data-testid="inner">
            <DialogTitle>Inner</DialogTitle>
            <DialogDescription>Inner dialog</DialogDescription>
            <button type="button">Inside</button>
          </DialogContent>
        </Dialog>
      </Outer>,
    );
    const outer = screen.getByTestId("outer");
    const inner = await screen.findByTestId("inner");
    const button = screen.getByRole("button", { name: "Inside" });
    expect(fromOtherModal(button, outer)).toBe(true);
    expect(fromOtherModal(button, inner)).toBe(false);
  });

  it("marks a key from inside a drawer as another modal's to the page", async () => {
    render(
      <>
        <div data-testid="page">
          <button type="button">Page</button>
        </div>
        <Drawer open>
          <DrawerContent>
            <DrawerTitle>Drawer</DrawerTitle>
            <DrawerDescription>Drawer body</DrawerDescription>
            <button type="button">In drawer</button>
          </DrawerContent>
        </Drawer>
      </>,
    );
    const inDrawer = await screen.findByRole("button", { name: "In drawer" });
    const content = inDrawer.closest('[data-slot="drawer-content"]');
    if (content === null) throw new Error("no drawer content");
    // The wrapper's portal slot never reaches the DOM.
    expect(document.querySelector('[data-slot="drawer-portal"]')).toBeNull();
    expect(fromOtherModal(inDrawer, screen.getByTestId("page"))).toBe(true);
    expect(fromOtherModal(inDrawer, content)).toBe(false);
  });
});

type Stub = { closest(sel: string): unknown };

function stubIn(portal: object | null): Stub {
  return { closest: (sel) => (sel.includes("-portal") ? portal : null) };
}

describe("fromOtherModal (pure)", () => {
  const a = {};
  const b = {};
  it("same portal is the container's own event", () => {
    expect(fromOtherModal(stubIn(a), stubIn(a))).toBe(false);
  });
  it("a different portal is another modal's", () => {
    expect(fromOtherModal(stubIn(b), stubIn(a))).toBe(true);
  });
  it("a page-level container hears a modal's event as another modal's", () => {
    expect(fromOtherModal(stubIn(a), stubIn(null))).toBe(true);
    expect(fromOtherModal(stubIn(null), stubIn(null))).toBe(false);
  });
  it("a null or non-element target is never another modal's", () => {
    expect(fromOtherModal(null, stubIn(a))).toBe(false);
    expect(fromOtherModal({}, stubIn(a))).toBe(false);
  });
});
