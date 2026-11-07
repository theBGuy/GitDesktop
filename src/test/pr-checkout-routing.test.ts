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
): PrBranchFacts => ({
  provider,
  headRefName: "feat/x",
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
