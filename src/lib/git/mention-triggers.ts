import type { ForgeProvider } from "./types";

/** A character that opens the suggestion popover when typed at a word boundary. */
export type MentionTrigger = "@" | "#" | "!";

/**
 * Which triggers each forge autolinks in a comment body. GitHub resolves `#N` from a
 * single number space covering issues AND PRs; GitLab numbers them separately (`#`
 * issues, `!` merge requests). Bitbucket autolinks neither a bare `#N` nor a plain
 * `@nickname` written through its API — its mentions need `@{accountId}`, which
 * `forge_assignable_users` has no Bitbucket arm to supply, so it offers none.
 *
 * A leaf module so both the composer autocomplete and the markdown renderer can read
 * one table without either pulling in the other's dependencies.
 */
export const TRIGGERS: Record<ForgeProvider, readonly MentionTrigger[]> = {
  github: ["@", "#"],
  gitlab: ["@", "#", "!"],
  bitbucket: [],
};
