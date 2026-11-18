import { describe, expect, it } from "vitest";
import {
  type CardOpenContext,
  cardDestination,
  cardLandingTarget,
  cardWebUrl,
  type OpenableContent,
  openedInSideStatus,
  openedInStatus,
  openRowLabels,
  sameRepoSlug,
} from "@/features/projects/card-destination";
import type { BoardItem, BoardItemContent } from "@/lib/git/types";
import type { RecentRepo } from "@/lib/settings/api";

function issue(repoNameWithOwner: string, number = 12): OpenableContent {
  return {
    kind: "issue",
    id: `I_${number}`,
    number,
    title: "An issue",
    state: "OPEN",
    stateReason: null,
    repoNameWithOwner,
    assignees: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    viewerCanSetFields: false,
  };
}

function pr(repoNameWithOwner: string, number = 12): OpenableContent {
  return {
    kind: "pullRequest",
    id: `PR_${number}`,
    number,
    title: "A pull request",
    state: "OPEN",
    isDraft: false,
    repoNameWithOwner,
    assignees: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function item(content: BoardItemContent): BoardItem {
  return {
    itemId: "PVTI_1",
    isArchived: false,
    content,
    fieldValues: [],
    addedAt: "2026-01-01T00:00:00Z",
  };
}

const WIDGETS_CLONE: RecentRepo = {
  path: "C:/src/widgets",
  name: "widgets",
  lastOpenedAt: "2026-01-01T00:00:00Z",
  owner: "acme",
  host: "github.com",
  repoName: "widgets",
  provider: "github",
};

const UPSTREAM_CLONE: RecentRepo = {
  ...WIDGETS_CLONE,
  path: "C:/src/harbor-upstream",
  name: "harbor-upstream",
  owner: "upstream-org",
  repoName: "harbor",
};

function ctx(over: Partial<CardOpenContext> = {}): CardOpenContext {
  return {
    repoSlug: "me/harbor",
    otherSide: { lens: "upstream", slug: "upstream-org/harbor" },
    forgeHost: "github.com",
    recents: [WIDGETS_CLONE],
    ...over,
  };
}

describe("sameRepoSlug", () => {
  it("compares case-insensitively", () => {
    expect(sameRepoSlug("Me/Harbor", "me/harbor")).toBe(true);
    expect(sameRepoSlug("me/harbor", "me/harbour")).toBe(false);
  });
});

describe("cardDestination: an unread active slug, this repository, the other fork side, a clone, then the browser", () => {
  it("an unresolved active slug takes the browser, even with a matching clone", () => {
    expect(
      cardDestination(issue("acme/widgets"), ctx({ repoSlug: null })),
    ).toEqual({ kind: "browser" });
    expect(
      cardDestination(issue("me/harbor"), ctx({ repoSlug: null })),
    ).toEqual({
      kind: "browser",
    });
  });

  it("the active repository opens here, case-insensitively", () => {
    expect(cardDestination(issue("ME/Harbor"), ctx())).toEqual({
      kind: "here",
    });
    expect(cardDestination(pr("me/harbor"), ctx())).toEqual({ kind: "here" });
  });

  it("the other fork side opens through the lens", () => {
    expect(cardDestination(issue("Upstream-Org/harbor"), ctx())).toEqual({
      kind: "lens",
      lens: "upstream",
    });
    expect(
      cardDestination(
        pr("me/harbor"),
        ctx({
          repoSlug: "upstream-org/harbor",
          otherSide: { lens: "origin", slug: "me/harbor" },
        }),
      ),
    ).toEqual({ kind: "lens", lens: "origin" });
  });

  it("another repository with an openable clone opens in that clone", () => {
    const content = pr("acme/widgets", 7);
    const target = cardLandingTarget(content, "github.com");
    expect(cardDestination(content, ctx())).toEqual({
      kind: "clone",
      target,
      candidates: [WIDGETS_CLONE],
    });
  });

  it("another repository without a clone takes the browser", () => {
    expect(cardDestination(issue("acme/gadgets"), ctx())).toEqual({
      kind: "browser",
    });
    expect(
      cardDestination(issue("acme/widgets"), ctx({ recents: [] })),
    ).toEqual({
      kind: "browser",
    });
  });

  it("a clone whose stored provider is another forge takes the browser", () => {
    const gitlab: RecentRepo = { ...WIDGETS_CLONE, provider: "gitlab" };
    expect(
      cardDestination(issue("acme/widgets"), ctx({ recents: [gitlab] })),
    ).toEqual({ kind: "browser" });
  });

  it("an unprobed recents row, with no owner or host, takes the browser", () => {
    const { owner: _owner, host: _host, ...unprobed } = WIDGETS_CLONE;
    expect(
      cardDestination(issue("acme/widgets"), ctx({ recents: [unprobed] })),
    ).toEqual({ kind: "browser" });
  });

  it("two matching clones come back as candidates in recents order", () => {
    const second: RecentRepo = {
      ...WIDGETS_CLONE,
      path: "D:/work/widgets",
      name: "widgets-2",
    };
    for (const recents of [
      [WIDGETS_CLONE, second],
      [second, WIDGETS_CLONE],
    ]) {
      expect(
        cardDestination(issue("acme/widgets"), ctx({ recents })),
      ).toMatchObject({ kind: "clone", candidates: recents });
    }
  });

  it("a card with no provable target takes the browser", () => {
    expect(
      cardDestination(issue("acme/widgets"), ctx({ forgeHost: "" })),
    ).toEqual({ kind: "browser" });
    expect(cardDestination(issue("widgets"), ctx())).toEqual({
      kind: "browser",
    });
  });

  it("matching both the active slug and the other side: here", () => {
    expect(
      cardDestination(
        issue("me/harbor"),
        ctx({ otherSide: { lens: "upstream", slug: "ME/harbor" } }),
      ),
    ).toEqual({ kind: "here" });
  });

  it("matching the other side and a recents clone: lens", () => {
    const recents = [UPSTREAM_CLONE];
    expect(
      cardDestination(issue("upstream-org/harbor"), ctx({ recents })),
    ).toEqual({ kind: "lens", lens: "upstream" });
  });

  it("no other side, or its slug unresolved, falls through to recents", () => {
    const recents = [UPSTREAM_CLONE];
    const content = issue("upstream-org/harbor");
    for (const otherSide of [null, { lens: "upstream" as const, slug: null }]) {
      expect(
        cardDestination(content, ctx({ otherSide, recents })),
      ).toMatchObject({
        kind: "clone",
        candidates: [UPSTREAM_CLONE],
      });
      expect(cardDestination(content, ctx({ otherSide, recents: [] }))).toEqual(
        { kind: "browser" },
      );
    }
  });
});

describe("cardLandingTarget", () => {
  it("fills all eight fields", () => {
    expect(cardLandingTarget(pr("Acme/Widgets", 34), "github.com")).toEqual({
      provider: "github",
      host: "github.com",
      authority: "github.com",
      repoOwner: "Acme",
      repoName: "Widgets",
      repoFullName: "Acme/Widgets",
      number: 34,
      isPullRequest: true,
    });
    expect(
      cardLandingTarget(issue("acme/widgets"), "github.com"),
    ).toMatchObject({
      isPullRequest: false,
      number: 12,
    });
  });

  it("gives no target for a slug that isn't exactly owner/name", () => {
    for (const slug of [
      "widgets",
      "acme/widgets/extra",
      "/widgets",
      "acme/",
      "",
    ]) {
      expect(cardLandingTarget(issue(slug), "github.com")).toBeNull();
    }
  });

  it.each([
    ["github.com", "github.com", "github.com"],
    ["GHE.Acme.com", "ghe.acme.com", "ghe.acme.com"],
    ["ghe.acme.com:8443", "ghe.acme.com", "ghe.acme.com:8443"],
    ["[2001:db8::1]", "[2001:db8::1]", "[2001:db8::1]"],
  ])("forge host %s: host %s, authority %s", (forgeHost, host, authority) => {
    expect(cardLandingTarget(issue("acme/widgets"), forgeHost)).toMatchObject({
      host,
      authority,
    });
  });

  it("gives no target for an empty forge host", () => {
    expect(cardLandingTarget(issue("acme/widgets"), "")).toBeNull();
  });
});

describe("cardWebUrl", () => {
  it("spells the issue and pull request pages", () => {
    expect(cardWebUrl(issue("acme/widgets"), "github.com")).toBe(
      "https://github.com/acme/widgets/issues/12",
    );
    expect(cardWebUrl(pr("acme/widgets"), "github.com")).toBe(
      "https://github.com/acme/widgets/pull/12",
    );
  });
});

describe("openRowLabels", () => {
  it("here: Open, then Open on GitHub", () => {
    expect(openRowLabels(item(issue("me/harbor")), ctx())).toEqual({
      primary: "Open",
      secondary: "Open on GitHub",
    });
  });

  it("lens: the side word, then Open on GitHub", () => {
    expect(openRowLabels(item(issue("upstream-org/harbor")), ctx())).toEqual({
      primary: "Open in Upstream",
      secondary: "Open on GitHub",
    });
    expect(
      openRowLabels(
        item(pr("me/harbor")),
        ctx({
          repoSlug: "upstream-org/harbor",
          otherSide: { lens: "origin", slug: "me/harbor" },
        }),
      ),
    ).toEqual({ primary: "Open in Fork", secondary: "Open on GitHub" });
  });

  it("clone: the card's own repository name, never the folder", () => {
    const renamed: RecentRepo = { ...WIDGETS_CLONE, name: "widgets-checkout" };
    expect(
      openRowLabels(item(pr("acme/widgets")), ctx({ recents: [renamed] })),
    ).toEqual({ primary: "Open in widgets", secondary: "Open on GitHub" });
  });

  it("browser: the single row Open on GitHub", () => {
    expect(openRowLabels(item(issue("acme/gadgets")), ctx())).toEqual({
      primary: "Open on GitHub",
      secondary: null,
    });
    expect(
      openRowLabels(item(issue("acme/widgets")), ctx({ repoSlug: null })),
    ).toEqual({ primary: "Open on GitHub", secondary: null });
  });

  it("no rows for undefined, draft and redacted", () => {
    expect(openRowLabels(undefined, ctx())).toBeNull();
    expect(openRowLabels(item({ kind: "redacted" }), ctx())).toBeNull();
    const draft: BoardItemContent = {
      kind: "draft",
      id: "DI_1",
      title: "A note",
      body: "",
      assignees: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    expect(openRowLabels(item(draft), ctx())).toBeNull();
  });
});

describe("arrival statuses", () => {
  it("names the repository", () => {
    expect(openedInStatus("harbor")).toBe("Opened in harbor");
  });

  it("names the side with the word its menu row ends in", () => {
    expect(openedInSideStatus("upstream")).toBe("Opened in Upstream");
    expect(openedInSideStatus("origin")).toBe("Opened in Fork");
    const sides = [
      {
        lens: "upstream" as const,
        content: issue("upstream-org/harbor"),
        c: ctx(),
      },
      {
        lens: "origin" as const,
        content: issue("me/harbor"),
        c: ctx({
          repoSlug: "upstream-org/harbor",
          otherSide: { lens: "origin", slug: "me/harbor" },
        }),
      },
    ];
    for (const { lens, content, c } of sides) {
      const row = openRowLabels(item(content), c)?.primary ?? "";
      const word = row.split(" ").at(-1);
      expect(openedInSideStatus(lens).endsWith(` ${word}`)).toBe(true);
    }
  });
});
