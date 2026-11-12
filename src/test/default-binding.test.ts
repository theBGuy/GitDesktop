import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { eventToBinding, isMac } from "@/lib/hotkeys/binding";
import {
  defaultBindingOf,
  effectiveBindings,
} from "@/lib/hotkeys/default-binding";
import {
  ACTIONS,
  type ActionId,
  resolveDefaultBinding,
} from "@/lib/hotkeys/registry";

const NAV_IDS = new Set<string>(["go-back", "go-forward"]);

function action(id: ActionId) {
  const found = ACTIONS.find((a) => a.id === id);
  if (!found) throw new Error(`no action ${id}`);
  return found;
}

describe("resolveDefaultBinding", () => {
  it("gives Back and Forward their per-platform chords", () => {
    expect(resolveDefaultBinding(action("go-back"), true)).toBe("mod+[");
    expect(resolveDefaultBinding(action("go-forward"), true)).toBe("mod+]");
    expect(resolveDefaultBinding(action("go-back"), false)).toBe("alt+left");
    expect(resolveDefaultBinding(action("go-forward"), false)).toBe(
      "alt+right",
    );
  });

  it("gives every other action the same default on both platforms", () => {
    for (const a of ACTIONS) {
      if (NAV_IDS.has(a.id)) continue;
      expect(resolveDefaultBinding(a, true), a.id).toBe(
        resolveDefaultBinding(a, false),
      );
    }
  });

  it("returns the row's own value off macOS and for ids the table lacks", () => {
    expect(
      resolveDefaultBinding({ id: "go-back", defaultBinding: "z" }, false),
    ).toBe("z");
    expect(
      resolveDefaultBinding({ id: "open-settings", defaultBinding: "q" }, true),
    ).toBe("q");
    // Own keys only: a prototype member's name is no table entry.
    for (const id of ["constructor", "toString", "__proto__"]) {
      expect(resolveDefaultBinding({ id, defaultBinding: "x" }, true), id).toBe(
        "x",
      );
      expect(
        resolveDefaultBinding({ id, defaultBinding: null }, true),
        id,
      ).toBeNull();
    }
  });

  it("resolves no two actions to the same default on either platform", () => {
    for (const mac of [true, false]) {
      const seen = new Map<string, string>();
      for (const a of ACTIONS) {
        const def = resolveDefaultBinding(a, mac);
        if (def === null) continue;
        expect(seen.get(def), `${a.id} on mac=${mac}`).toBeUndefined();
        seen.set(def, a.id);
      }
    }
  });

  // The macOS defaults only fire while the key-event converter spells Cmd+[ and
  // Cmd+] the way the table does; jsdom never takes the mac path, so this pins it.
  it("matches what the key-event converter makes of Cmd+[ and Cmd+]", async () => {
    const user = userEvent.setup();
    const seen: (string | null)[] = [];
    const record = (e: KeyboardEvent) => {
      if (e.key === "[" || e.key === "]") seen.push(eventToBinding(e));
    };
    document.addEventListener("keydown", record);
    try {
      await user.keyboard("{Meta>}[[{/Meta}{Meta>}]{/Meta}");
    } finally {
      document.removeEventListener("keydown", record);
    }
    expect(seen).toEqual([
      resolveDefaultBinding(action("go-back"), true),
      resolveDefaultBinding(action("go-forward"), true),
    ]);
  });

  it("defaultBindingOf reads this platform's default", () => {
    for (const a of ACTIONS) {
      expect(defaultBindingOf(a), a.id).toBe(resolveDefaultBinding(a, isMac));
    }
  });
});

describe("effectiveBindings", () => {
  const backDefault = defaultBindingOf(action("go-back"));

  it("gives every action its default with no overrides", () => {
    for (const overrides of [undefined, {}]) {
      const map = effectiveBindings(overrides);
      expect(map.size).toBe(ACTIONS.length);
      for (const a of ACTIONS) expect(map.get(a.id)).toBe(defaultBindingOf(a));
    }
  });

  it("lets another action's override take the chord; the default yields", () => {
    expect(backDefault).not.toBeNull();
    const map = effectiveBindings({ "show-branches": backDefault });
    expect(map.get("show-branches")).toBe(backDefault);
    expect(map.get("go-back")).toBeNull();
    expect(map.get("go-forward")).toBe(defaultBindingOf(action("go-forward")));
  });

  it("gives the default back once the override is removed", () => {
    expect(effectiveBindings({}).get("go-back")).toBe(backDefault);
  });

  it("leaves an action Unbound when it is reset while another override holds its default", () => {
    // go-back had its own override; resetting it deletes that override, and
    // the default it falls back to is the chord show-branches now holds.
    const before = effectiveBindings({
      "show-branches": backDefault,
      "go-back": "mod+shift+left",
    });
    expect(before.get("go-back")).toBe("mod+shift+left");
    const reset = effectiveBindings({ "show-branches": backDefault });
    expect(reset.get("go-back")).toBeNull();
    expect(reset.get("show-branches")).toBe(backDefault);
  });

  it("returns an action's own override as stored, null included", () => {
    expect(effectiveBindings({ "go-back": "x" }).get("go-back")).toBe("x");
    expect(effectiveBindings({ "go-back": null }).get("go-back")).toBeNull();
  });

  it("lets a null override shadow nothing", () => {
    const map = effectiveBindings({ "show-branches": null });
    expect(map.get("show-branches")).toBeNull();
    expect(map.get("go-back")).toBe(backDefault);
  });

  it("lets an override under an id that is no action shadow nothing", () => {
    const map = effectiveBindings({ "no-such-action": backDefault });
    expect(map.get("go-back")).toBe(backDefault);
    expect(map.has("no-such-action" as ActionId)).toBe(false);
    // Only own keys are overrides: an inherited one is not.
    const inherited = Object.create({ "go-back": "x", "show-branches": "y" });
    expect(effectiveBindings(inherited).get("go-back")).toBe(backDefault);
  });
});
