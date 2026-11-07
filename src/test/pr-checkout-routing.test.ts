import { describe, expect, it } from "vitest";
import { plainCheckoutTarget } from "@/features/pulls/PrWorktreeCheckout";
import { usePrCapabilities } from "@/features/pulls/usePrCapabilities";
import {
  checkedOutNames,
  checkoutRoute,
  type PrBranchFacts,
  prLocalBranch,
} from "@/lib/git/checkout-route";
import type { ForgeProvider, ForgeStatus } from "@/lib/git/types";

type Provider = ForgeProvider | undefined;

describe("checkoutRoute", () => {
  it.each<[Provider, string | undefined, "gh" | "native"]>([
    ["github", "2.98.0", "gh"],
    ["github", "2.94.0", "gh"],
    ["github", "", "gh"],
    ["github", undefined, "gh"],
    ["gitlab", "2.98.0", "native"],
    ["bitbucket", "2.98.0", "native"],
    [undefined, "2.94.0", "gh"],
    [undefined, undefined, "gh"],
  ])("plain on %s with gh %j → %s", (provider, version, route) => {
    expect(checkoutRoute("plain", provider, version)).toBe(route);
  });

  it.each<[string | undefined, "gh" | "native"]>([
    ["2.98", "gh"],
    ["2.98.0", "gh"],
    ["2.98.1-rc1", "gh"],
    ["3.0.0", "gh"],
    // Parts parse as the backend's u64: past u64::MAX is unparseable, the
    // maximum itself reads, and leading zeros don't count against the width.
    ["2.98.18446744073709551616", "native"],
    ["18446744073709551616.0.0", "native"],
    ["2.98.18446744073709551615", "gh"],
    ["2.99.000000000000000000000001", "gh"],
    ["2.97.9", "native"],
    ["2.94.0", "native"],
    ["", "native"],
    ["x.y", "native"],
    ["garbage", "native"],
    [undefined, "native"],
  ])("worktree on github with gh %j → %s", (version, route) => {
    expect(checkoutRoute("worktree", "github", version)).toBe(route);
  });

  it.each<[Provider, string | undefined]>([
    ["gitlab", "2.98.0"],
    ["gitlab", undefined],
    ["bitbucket", "3.0.0"],
    ["bitbucket", undefined],
    [undefined, "2.98.0"],
    [undefined, undefined],
  ])("worktree on %s with gh %j → native", (provider, version) => {
    expect(checkoutRoute("worktree", provider, version)).toBe("native");
  });
});

const facts = (
  provider: Provider,
  crossRepository: boolean | null | undefined,
  headRepositoryOwner: string | null | undefined,
  headRefName = "feat/x",
  defaultBranchName: string | null = "main",
): PrBranchFacts => ({
  provider,
  headRefName,
  defaultBranchName,
  crossRepository,
  headRepositoryOwner,
});

describe("prLocalBranch", () => {
  it.each<
    [
      Provider,
      boolean | null | undefined,
      string | null | undefined,
      string | null,
    ]
  >([
    ["github", true, "alice", "alice/feat/x"],
    ["bitbucket", true, "ws", "ws/feat/x"],
    [undefined, true, "alice", "alice/feat/x"],
    ["github", true, null, null],
    ["github", true, "  ", null],
    ["gitlab", true, null, null],
    ["github", false, "base", "feat/x"],
    ["bitbucket", false, "base", "feat/x"],
    ["github", undefined, "base", "feat/x"],
    ["github", null, "base", "feat/x"],
    ["gitlab", false, null, "feat/x"],
    ["gitlab", undefined, null, "feat/x"],
    ["github", false, null, null],
    ["github", false, "  ", null],
    ["bitbucket", false, null, null],
    [undefined, false, null, null],
    [undefined, undefined, undefined, null],
  ])("%s cross=%j owner=%j → %j", (provider, cross, owner, want) => {
    expect(prLocalBranch(facts(provider, cross, owner))).toBe(want);
  });
});

describe("checkedOutNames", () => {
  const names = (f: PrBranchFacts) => [...checkedOutNames(f)].sort();

  it.each<[Provider, boolean | null, string | null, string[]]>([
    // gh names a GitHub fork's plain checkout bare, the native engine owner/head.
    ["github", true, "alice", ["alice/feat/x", "feat/x"]],
    [undefined, true, "alice", ["alice/feat/x", "feat/x"]],
    ["bitbucket", true, "ws", ["ws/feat/x"]],
    ["github", false, "base", ["feat/x"]],
    ["github", false, null, []],
    ["bitbucket", false, null, []],
    ["gitlab", false, null, ["feat/x"]],
    ["gitlab", true, null, []],
    ["github", true, "  ", []],
  ])("%s cross=%j owner=%j → %j", (provider, cross, owner, want) => {
    expect(names(facts(provider, cross, owner))).toEqual(want);
  });

  it("a GitHub fork's gh-named bare branch and its native name both chip", () => {
    const set = checkedOutNames(facts("github", true, "alice"));
    expect(set.has("feat/x")).toBe(true);
    expect(set.has("alice/feat/x")).toBe(true);
  });

  it("a Bitbucket fork never chips on the user's own same-named branch", () => {
    expect(checkedOutNames(facts("bitbucket", true, "ws")).has("feat/x")).toBe(
      false,
    );
  });

  // gh owner-prefixes a fork head named like the default branch, so the bare
  // name there is the user's own branch.
  it.each<[Provider]>([["github"], [undefined]])(
    "a %s fork whose head is the default branch chips only on owner/head",
    (provider) => {
      expect(names(facts(provider, true, "alice", "main"))).toEqual([
        "alice/main",
      ]);
    },
  );

  it("a fork head other than the default branch still chips bare on gh", () => {
    // A head equal to the PR's base but not the default stays bare.
    expect(names(facts("github", true, "alice", "release"))).toEqual([
      "alice/release",
      "release",
    ]);
  });

  it("an unknown default branch never chips on the bare head", () => {
    expect(names(facts("github", true, "alice", "feat", null))).toEqual([
      "alice/feat",
    ]);
    // The user's own `main` with the default still unresolved: bare absent, so
    // the header can't claim "Checked out" and the checkout action stays.
    expect(names(facts("github", true, "alice", "main", null))).toEqual([
      "alice/main",
    ]);
  });

  it.each<[Provider, boolean, string | null, string[]]>([
    ["bitbucket", true, "ws", ["ws/main"]],
    ["gitlab", false, null, ["main"]],
  ])(
    "the native route is unchanged by a head named like the default (%s)",
    (provider, cross, owner, want) => {
      expect(names(facts(provider, cross, owner, "main"))).toEqual(want);
    },
  );
});

describe("plainCheckoutTarget", () => {
  it.each<
    [
      Provider,
      boolean | null,
      string | null,
      "pull request" | "merge request",
      string,
    ]
  >([
    // gh names a GitHub fork's plain checkout by its bare head.
    ["github", true, "alice", "pull request", "feat/x"],
    ["github", false, "base", "pull request", "feat/x"],
    [undefined, true, "alice", "pull request", "feat/x"],
    // The native engine names a fork `owner/head`.
    ["bitbucket", true, "ws", "pull request", "ws/feat/x"],
    ["gitlab", false, null, "merge request", "feat/x"],
    // No name the engine is sure to use: the PR by number instead.
    ["gitlab", true, null, "merge request", "MR #7"],
    ["bitbucket", false, null, "pull request", "PR #7"],
  ])("%s cross=%j owner=%j (%s) → %j", (provider, cross, owner, noun, want) => {
    expect(plainCheckoutTarget(facts(provider, cross, owner), 7, noun)).toBe(
      want,
    );
  });

  it.each<[Provider, boolean, string | null, string, string | null, string]>([
    // gh may prefix a fork head named like the default branch, or one whose
    // default is unknown: the PR by number.
    ["github", true, "alice", "main", "main", "PR #7"],
    [undefined, true, "alice", "main", "main", "PR #7"],
    ["github", true, "alice", "feat", null, "PR #7"],
    // A same-repo head is never prefixed, default branch or not.
    ["github", false, "base", "main", "main", "main"],
    ["github", false, "base", "feat", null, "feat"],
    // The native engine's name doesn't depend on the default branch.
    ["bitbucket", true, "ws", "main", "main", "ws/main"],
  ])(
    "%s cross=%j owner=%j head=%j default=%j → %j",
    (provider, cross, owner, head, def, want) => {
      expect(
        plainCheckoutTarget(
          facts(provider, cross, owner, head, def),
          7,
          "pull request",
        ),
      ).toBe(want);
    },
  );
});

function forgeData(
  ready: boolean,
  pullRequests: boolean,
): ForgeStatus | undefined {
  return {
    installed: ready,
    authenticated: ready,
    repo: ready ? { owner: "o", name: "r" } : null,
    implemented: { pullRequests },
  } as unknown as ForgeStatus;
}

describe("usePrCapabilities.canCheckout", () => {
  const can = (forge: ForgeStatus | undefined, provider: Provider) =>
    usePrCapabilities(forge, provider).canCheckout;

  it.each<[ForgeStatus | undefined]>([
    [undefined],
    [forgeData(false, false)],
    [forgeData(true, false)],
    [forgeData(true, true)],
  ])("github and an unknown provider render whatever forge says (%#)", (f) => {
    expect(can(f, "github")).toBe(true);
    expect(can(f, undefined)).toBe(true);
  });

  it.each<["gitlab" | "bitbucket"]>([["gitlab"], ["bitbucket"]])(
    "%s renders only when its pull requests are ready",
    (provider) => {
      expect(can(undefined, provider)).toBe(false);
      expect(can(forgeData(false, true), provider)).toBe(false);
      expect(can(forgeData(true, false), provider)).toBe(false);
      expect(can(forgeData(true, true), provider)).toBe(true);
    },
  );
});
