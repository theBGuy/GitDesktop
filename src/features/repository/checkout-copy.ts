// Shared by every branch-row surface (the switcher, the compare picker, the
// base picker), so it lives apart from all three: hosting it in one of them
// would make the other two import a component module to read copy.

/** Last path segment (folder name). Git reports worktree paths forward-slashed
 *  on every platform (`UserWorktree.path`), and a backslash is a legal
 *  character in a POSIX directory name, so splitting on one truncates it. */
export const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

/** How a branch row NAMES the checkout holding its branch — chip, tooltip, open
 *  item, after-the-fact toast, and the phrases that say a row is held because of
 *  it. Git counts the main workspace as a worktree and this row can point at it
 *  when you're standing in a linked one, but users don't call it one; routing
 *  the naming through one record keeps a later phrase from drifting back.
 *  "Rename worktree…" and "Delete worktree…" are deliberately NOT routed here:
 *  they name the git operation, and their held-reason carries the naming instead.
 *  `noun` is bare, for badges and parenthetical reasons; `blockedTitle` is the
 *  sentence-capitalized chip-tooltip form of `blocked`, for rows that name the
 *  holding checkout without offering to open it. */
export const ROW_CHECKOUT_COPY = {
  linked: {
    noun: "worktree",
    open: "Open worktree",
    title: (path: string) =>
      `Checked out in worktree ${baseName(path)} (${path}) — this row opens it`,
    opened: (path: string) => `Opened worktree ${baseName(path)}`,
    blocked: "checked out in another worktree",
    blockedTitle: (path: string) => `Checked out in another worktree (${path})`,
    held: "in a worktree",
  },
  main: {
    noun: "main workspace",
    open: "Open main workspace",
    title: (path: string) =>
      `Checked out in the main workspace (${path}) — this row opens it`,
    opened: (_path: string) => "Opened the main workspace",
    blocked: "checked out in the main workspace",
    blockedTitle: (path: string) =>
      `Checked out in the main workspace (${path})`,
    held: "in the main workspace",
  },
} as const;

/** Which {@link ROW_CHECKOUT_COPY} arm a listed worktree speaks in. */
export const rowCheckoutCopy = (isMain: boolean | undefined) =>
  ROW_CHECKOUT_COPY[isMain ? "main" : "linked"];
