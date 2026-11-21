import { afterEach, describe, expect, it } from "vitest";
import { exploreOptionId } from "@/features/explore/explore-utils";
import { myWorkOptionId } from "@/features/mywork/mywork-utils";

afterEach(() => document.body.replaceChildren());

/** An element carrying `id`, attached so both lookups can find it. */
function mount(id: string) {
  const el = document.createElement("div");
  el.id = id;
  document.body.appendChild(el);
  return el;
}

describe.each([
  [
    "myWorkOptionId",
    myWorkOptionId,
    "https://github.com/acme/ui.kit/pull/3",
    "https://github.com/acme/ui_kit/pull/3",
  ],
  ["exploreOptionId", exploreOptionId, "acme/ui.kit", "acme/ui_kit"],
] as const)("%s", (_name, optionId, dotted, underscored) => {
  it("gives a dot and an underscore different ids", () => {
    expect(optionId(dotted)).not.toBe(optionId(underscored));
  });

  // A raw name spelling another's escape: `_` must itself be escaped.
  it("gives a name and the spelling of its escape different ids", () => {
    const a = optionId("o/ui.kit");
    const b = optionId("o/ui_002ekit");
    expect(a).not.toBe(b);
    const elA = mount(a);
    const elB = mount(b);
    expect(document.getElementById(a)).toBe(elA);
    expect(document.getElementById(b)).toBe(elB);
  });

  it.each([dotted, underscored, "acme/naïve repo#1", "acme/\u{1F600}"])(
    "finds %s by id and by an unescaped selector",
    (raw) => {
      const id = optionId(raw);
      const el = mount(id);
      expect(document.getElementById(id)).toBe(el);
      expect(document.querySelector(`#${id}`)).toBe(el);
    },
  );
});
