import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mergeBranchRules,
  mergeDeleteStartsTicked,
} from "@/lib/branch-rules/match";
import {
  loadSharedBranchRules,
  normalizeBranchRules,
  saveSharedBranchRules,
} from "@/lib/branch-rules/store";
import { EMPTY_BRANCH_RULES } from "@/lib/branch-rules/types";
import { readRepoBranchRules, writeRepoBranchRules } from "@/lib/git/api";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  readRepoBranchRules: vi.fn(),
  writeRepoBranchRules: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(readRepoBranchRules).mockReset();
  vi.mocked(writeRepoBranchRules).mockReset().mockResolvedValue(undefined);
});

describe("deleteHeadAfterMerge in the branch-rules model", () => {
  it("normalizes a record saved before the field existed to false", () => {
    const old = { naming: { enabled: false }, protections: [] };
    expect(normalizeBranchRules(old).deleteHeadAfterMerge).toBe(false);
    // A pre-field record reads back equal to the empty config, so the dialog
    // isn't dirty on open.
    expect(JSON.stringify(normalizeBranchRules({}))).toBe(
      JSON.stringify(EMPTY_BRANCH_RULES),
    );
  });

  it.each([
    ["yes", "yes"],
    ["1", 1],
    ["null", null],
    ["false", false],
  ])("reads junk value %s as false", (_label, value) => {
    const cfg = normalizeBranchRules({ deleteHeadAfterMerge: value });
    expect(cfg.deleteHeadAfterMerge).toBe(false);
  });

  it("reads a literal true as true", () => {
    const cfg = normalizeBranchRules({ deleteHeadAfterMerge: true });
    expect(cfg.deleteHeadAfterMerge).toBe(true);
  });

  it("ignores a hand-edited shared value when loading the shared file", async () => {
    vi.mocked(readRepoBranchRules).mockResolvedValue(
      JSON.stringify({ deleteHeadAfterMerge: true }),
    );
    const shared = await loadSharedBranchRules("C:/repo");
    expect(shared.deleteHeadAfterMerge).toBe(false);
  });

  it("takes the personal value in the effective rules, never the shared one", () => {
    const on = { ...EMPTY_BRANCH_RULES, deleteHeadAfterMerge: true };
    expect(mergeBranchRules(on, EMPTY_BRANCH_RULES).deleteHeadAfterMerge).toBe(
      false,
    );
    expect(mergeBranchRules(EMPTY_BRANCH_RULES, on).deleteHeadAfterMerge).toBe(
      true,
    );
  });

  it("writes the shared file without the key, pretty-printed with a trailing newline", async () => {
    await saveSharedBranchRules("C:/repo", {
      ...EMPTY_BRANCH_RULES,
      promotionBranches: ["staging"],
      deleteHeadAfterMerge: true,
    });
    expect(writeRepoBranchRules).toHaveBeenCalledTimes(1);
    const written = vi.mocked(writeRepoBranchRules).mock.calls[0][1];
    expect(written).not.toContain("deleteHeadAfterMerge");
    expect(written.endsWith("}\n")).toBe(true);
    expect(JSON.parse(written)).toEqual({
      naming: EMPTY_BRANCH_RULES.naming,
      protections: [],
      promotionBranches: ["staging"],
    });
    expect(written).toContain('\n  "promotionBranches": [\n    "staging"\n  ]');
  });
});

type Seed = Parameters<typeof mergeDeleteStartsTicked>[0];

// Rules settled, default branch known, head neither default nor blocked.
const BASE: Seed = {
  pref: false,
  rulesSettled: true,
  defaultBranchKnown: true,
  headIsDefault: false,
  deletionBlocked: false,
  promotion: false,
  crossRepository: false,
  forgeDeleteFlag: undefined,
};

const FLAGS: { label: string; flag: Seed["forgeDeleteFlag"] }[] = [
  { label: "true", flag: true },
  { label: "false", flag: false },
  { label: "null", flag: null },
  { label: "absent", flag: undefined },
];

const ON = { pref: true };
const RULES_PENDING = { rulesSettled: false };
const DEFAULT_PENDING = { defaultBranchKnown: false };
const FORK = { crossRepository: true };
const KIND_UNKNOWN = { crossRepository: undefined };

describe("mergeDeleteStartsTicked", () => {
  // [row, overrides, expected]
  const rows: [string, Partial<Seed>, boolean][] = [
    // A1: rules pending turns the setting arm off; the forge arm still decides.
    [
      "A1 on, rules pending, flag null",
      { ...ON, ...RULES_PENDING, forgeDeleteFlag: null },
      false,
    ],
    ["A1 on, rules pending, flag absent", { ...ON, ...RULES_PENDING }, false],
    [
      "A1 on, rules pending, flag true",
      { ...ON, ...RULES_PENDING, forgeDeleteFlag: true },
      true,
    ],
    [
      "A1 off, rules pending, flag true",
      { ...RULES_PENDING, forgeDeleteFlag: true },
      true,
    ],
    [
      "A1 off, rules pending, flag false",
      { ...RULES_PENDING, forgeDeleteFlag: false },
      false,
    ],
    // A2: an unknown default branch (pending, failed or null) does the same.
    [
      "A2 on, default pending, flag null",
      { ...ON, ...DEFAULT_PENDING, forgeDeleteFlag: null },
      false,
    ],
    [
      "A2 on, default pending, flag true",
      { ...ON, ...DEFAULT_PENDING, forgeDeleteFlag: true },
      true,
    ],
    [
      "A2 off, default pending, flag true",
      { ...DEFAULT_PENDING, forgeDeleteFlag: true },
      true,
    ],
    [
      "A2 off, default pending, flag null",
      { ...DEFAULT_PENDING, forgeDeleteFlag: null },
      false,
    ],
    // A3/A4: a KNOWN default or KNOWN block refuses on both arms.
    [
      "A3 on, head is default, flag true",
      { ...ON, headIsDefault: true, forgeDeleteFlag: true },
      false,
    ],
    [
      "A3 off, head is default, flag true",
      { headIsDefault: true, forgeDeleteFlag: true },
      false,
    ],
    [
      "A3 on, head is default, rules pending, flag true",
      { ...ON, ...RULES_PENDING, headIsDefault: true, forgeDeleteFlag: true },
      false,
    ],
    [
      "A4 on, blocked, flag true",
      { ...ON, deletionBlocked: true, forgeDeleteFlag: true },
      false,
    ],
    [
      "A4 off, blocked, flag true",
      { deletionBlocked: true, forgeDeleteFlag: true },
      false,
    ],
    [
      "A4 on, blocked, default pending, flag true",
      {
        ...ON,
        ...DEFAULT_PENDING,
        deletionBlocked: true,
        forgeDeleteFlag: true,
      },
      false,
    ],
    // A promotion branch refuses the setting only; its own flag still applies.
    ["promotion, on, flag absent", { ...ON, promotion: true }, false],
    [
      "promotion, on, flag null",
      { ...ON, promotion: true, forgeDeleteFlag: null },
      false,
    ],
    [
      "promotion, on, flag true",
      { ...ON, promotion: true, forgeDeleteFlag: true },
      true,
    ],
    // A6: a fork takes the forge flag only.
    ["A6 on, fork, flag true", { ...ON, ...FORK, forgeDeleteFlag: true }, true],
    [
      "A6 on, fork, flag false",
      { ...ON, ...FORK, forgeDeleteFlag: false },
      false,
    ],
    [
      "A6 on, fork, flag null",
      { ...ON, ...FORK, forgeDeleteFlag: null },
      false,
    ],
    ["A6 on, fork, flag absent", { ...ON, ...FORK }, false],
    // A7: an unknown head kind is never same-repo.
    [
      "A7 on, kind unknown, flag true",
      { ...ON, ...KIND_UNKNOWN, forgeDeleteFlag: true },
      true,
    ],
    [
      "A7 on, kind unknown, flag false",
      { ...ON, ...KIND_UNKNOWN, forgeDeleteFlag: false },
      false,
    ],
    [
      "A7 on, kind unknown, flag null",
      { ...ON, ...KIND_UNKNOWN, forgeDeleteFlag: null },
      false,
    ],
    ["A7 on, kind unknown, flag absent", { ...ON, ...KIND_UNKNOWN }, false],
  ];

  it.each(rows)("%s", (_label, over, expected) => {
    expect(mergeDeleteStartsTicked({ ...BASE, ...over })).toBe(expected);
  });

  // A5: pref on + same-repo ticks whatever the flag says.
  it.each(FLAGS)("A5 on, same-repo, flag $label: ticked", ({ flag }) => {
    expect(
      mergeDeleteStartsTicked({ ...BASE, ...ON, forgeDeleteFlag: flag }),
    ).toBe(true);
  });

  // A8/A9 (and A9b: a failed personal read stands in as pref false): pref off
  // follows the forge flag on every head kind.
  for (const crossRepository of [false, true, undefined]) {
    it.each(FLAGS)(
      `A8/A9 off, crossRepository ${String(crossRepository)}, flag $label`,
      ({ flag }) => {
        expect(
          mergeDeleteStartsTicked({
            ...BASE,
            crossRepository,
            forgeDeleteFlag: flag,
          }),
        ).toBe(flag === true);
      },
    );
  }
});
