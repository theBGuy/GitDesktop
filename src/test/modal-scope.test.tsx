import { render } from "@testing-library/react";
import { Activity, createElement, StrictMode, useLayoutEffect } from "react";
import { describe, expect, it } from "vitest";
import {
  type ModalScope,
  topModalScope,
  useMintedModalScope,
} from "@/lib/hotkeys/modal-scope";

// The scope ranking through the real hook: a scope keeps the number it got at
// its first setup, so an <Activity> re-show and StrictMode's second setup
// never move it ahead of a scope minted after it.

type Scopes = Map<string, ModalScope>;

function Scope({ name, scopes }: { name: string; scopes: Scopes }) {
  const scope = useMintedModalScope();
  useLayoutEffect(() => {
    scopes.set(name, scope);
  }, [name, scope, scopes]);
  return null;
}

type Mode = "visible" | "hidden";

// Layout effects run in tree order, so A mints before B in one commit.
function Pair({
  scopes,
  a = "visible",
  b = "visible",
}: {
  scopes: Scopes;
  a?: Mode;
  b?: Mode;
}) {
  return (
    <>
      {createElement(Activity, {
        mode: a,
        children: <Scope name="A" scopes={scopes} />,
      })}
      {createElement(Activity, {
        mode: b,
        children: <Scope name="B" scopes={scopes} />,
      })}
    </>
  );
}

describe("modal scope ranking", () => {
  // Control: minting a fresh number on every setup (dropping the firstSetup
  // lookup) ranks the re-shown A above B.
  it("a re-shown scope keeps its first number, so B still ranks above A", () => {
    const scopes: Scopes = new Map();
    const { rerender } = render(<Pair scopes={scopes} />);
    expect(topModalScope()).toBe(scopes.get("B"));

    rerender(<Pair scopes={scopes} a="hidden" />);
    expect(topModalScope()).toBe(scopes.get("B"));

    rerender(<Pair scopes={scopes} a="visible" />);
    expect(topModalScope()).toBe(scopes.get("B"));
    expect(topModalScope()).not.toBe(scopes.get("A"));
  });

  // Control: keeping a scope connected through its cleanup leaves the hidden
  // B on top.
  it("hiding the top scope's host removes it, and showing it restores it", () => {
    const scopes: Scopes = new Map();
    const { rerender, unmount } = render(<Pair scopes={scopes} />);
    expect(topModalScope()).toBe(scopes.get("B"));

    rerender(<Pair scopes={scopes} b="hidden" />);
    expect(topModalScope()).toBe(scopes.get("A"));

    rerender(<Pair scopes={scopes} b="visible" />);
    expect(topModalScope()).toBe(scopes.get("B"));

    unmount();
    expect(topModalScope()).toBeNull();
  });

  // Control: a fresh number per setup reds the re-show leg. StrictMode's
  // doubled mount setup alone stays green under it, since both scopes re-mint
  // in tree order; no mutation found reds that leg by itself.
  it("under StrictMode the later scope ranks above the earlier one, across a hide and re-show of the earlier", () => {
    const scopes: Scopes = new Map();
    const { rerender } = render(
      <StrictMode>
        <Pair scopes={scopes} />
      </StrictMode>,
    );
    expect(topModalScope()).toBe(scopes.get("B"));

    rerender(
      <StrictMode>
        <Pair scopes={scopes} a="hidden" />
      </StrictMode>,
    );
    rerender(
      <StrictMode>
        <Pair scopes={scopes} a="visible" />
      </StrictMode>,
    );
    expect(topModalScope()).toBe(scopes.get("B"));
  });
});
