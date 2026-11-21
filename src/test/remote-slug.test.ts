import { describe, expect, it } from "vitest";
import { slugFromRemoteUrl } from "@/lib/repo-lens/queries";

describe("slugFromRemoteUrl", () => {
  it.each([
    "https://github.com/owner/repo",
    "https://github.com/owner/repo.git",
    "https://github.com/owner/repo/",
    "https://github.com/owner/repo.git/",
    "https://github.com/owner/repo.git//",
    "git@github.com:owner/repo.git",
    "git@github.com:owner/repo.git/",
    "ssh://git@github.com/owner/repo.git/",
  ])("reads owner/repo from %s", (url) => {
    expect(slugFromRemoteUrl(url)).toBe("owner/repo");
  });

  it.each([
    ["https://github.com/owner/repo.GIT", "owner/repo.GIT"],
    ["git@github.com:owner/repo.Git/", "owner/repo.Git"],
  ])(
    "keeps a non-lowercase .git suffix on %s, agreeing with Rust remote_path",
    (url, slug) => {
      expect(slugFromRemoteUrl(url)).toBe(slug);
    },
  );

  it("keeps the last two segments of a GitLab subgroup path", () => {
    expect(slugFromRemoteUrl("https://gitlab.com/group/sub/repo.git/")).toBe(
      "sub/repo",
    );
  });

  it.each(["https://github.com/owner", ""])("answers null for %j", (url) => {
    expect(slugFromRemoteUrl(url)).toBeNull();
  });

  it.each([
    "https://github.com",
    "https://github.com/",
    "https://github.com//",
    "https://github.com///",
  ])("answers null for the host-only %j", (url) => {
    expect(slugFromRemoteUrl(url)).toBeNull();
  });

  // The scheme strip skips both (it needs a letters-only scheme and a
  // non-empty authority); the host-only test must not take them for a host.
  it.each(["file:///srv/git/o/r.git", "git+ssh://host/o/r"])(
    "still reads o/r from %s",
    (url) => {
      expect(slugFromRemoteUrl(url)).toBe("o/r");
    },
  );
});
