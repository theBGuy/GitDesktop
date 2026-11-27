import { describe, expect, it } from "vitest";
import { branchTipPairs, tipInPairs } from "@/lib/git/branch-tip-pairs";

const SHA = "a".repeat(40);

describe("branchTipPairs", () => {
  it("keeps an own __proto__ key, drops non-string values, and sorts by code unit", () => {
    // JSON.parse makes an own key; an object literal would set the prototype.
    const tips = JSON.parse(
      `{"a":"${SHA}","__proto__":"${SHA}","B":"${SHA}","n":null,"x":7}`,
    );
    expect(branchTipPairs(tips)).toEqual([
      ["B", SHA],
      ["__proto__", SHA],
      ["a", SHA],
    ]);
  });

  it("gives equal answers equal pairs", () => {
    expect(branchTipPairs({ b: SHA, a: SHA })).toEqual(
      branchTipPairs({ a: SHA, b: SHA }),
    );
  });
});

describe("tipInPairs", () => {
  const pairs = branchTipPairs(JSON.parse(`{"__proto__":"${SHA}"}`));

  it("finds an exact name", () => {
    expect(tipInPairs(pairs, "__proto__")).toBe(SHA);
  });

  it("answers undefined for a missing name and for an Object.prototype key", () => {
    expect(tipInPairs(pairs, "feat/a")).toBeUndefined();
    expect(tipInPairs([], "constructor")).toBeUndefined();
    expect(tipInPairs([], "__proto__")).toBeUndefined();
  });
});
