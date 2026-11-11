// Keep local's copy. Import-free: scripts/keep-local-copy.test.mjs loads it under
// Node's type stripping, which resolves no bundler aliases. The sync bar's reason
// and the held-item suffix live in sync-controls-state.ts, which builds them.

/** The row and picker chip's visible text. */
export const KEPT_LOCAL_CHIP_TEXT = "kept local";

/** The chip's hover text and accessible label. */
export const KEPT_LOCAL_CHIP_LABEL =
  "Kept local. GitDesktop won't push or publish this branch.";

/** The branch menu's checkbox item. */
export const KEEP_LOCAL_ITEM = "Keep local";

export function keepLocalOnTitle(branch: string): string {
  return `${branch} is kept local`;
}

/** The turned-on toast's description; MCP is an AI feature, so Hide AI drops it. */
export const KEEP_LOCAL_ON_DESCRIPTION: Record<"ai" | "noAi", string> = {
  ai: "GitDesktop and its MCP server won't push or publish it.",
  noAi: "GitDesktop won't push or publish it.",
};

export function keepLocalOffTitle(branch: string): string {
  return `${branch} can be pushed again`;
}

/** Create PR's held submit, for a kept-local head. */
export function keptLocalPrReason(head: string): string {
  return `${head} is kept local, so it can't be pushed. Turn off Keep local in the branch menu, or create a local pull request instead.`;
}

/** Promote local PR's held Publish, for a kept-local head. */
export function keptLocalPromoteReason(head: string): string {
  return `${head} is kept local, so it can't be pushed. Turn off Keep local in the branch menu to publish this pull request.`;
}

/** The Publish repository dialog's held submit, for a kept-local HEAD. */
export function keptLocalPublishRepoReason(branch: string): string {
  return `${branch} is kept local. Turn off Keep local in the branch menu to publish this repository.`;
}

/** The palette action's refusal on a detached HEAD. */
export const KEEP_LOCAL_PALETTE_NO_BRANCH =
  "There's no current branch to keep local (detached HEAD).";

/** The palette action's refusal on a gd/session branch. */
export const KEEP_LOCAL_PALETTE_SESSION =
  "gd/session branches are never pushed, so there is nothing to keep local.";

// ── Terminal push guard (the managed pre-push hook) ─────────────────────────

/** The row menu's hook item, by what the status read answered. `checking` is the
 *  disabled waiting slot; `unknown` follows a failed read and opens its dialog. */
export const KEEP_LOCAL_HOOK_ITEM: Record<
  "block" | "on" | "checking" | "unknown",
  string
> = {
  block: "Block terminal pushes too…",
  on: "Terminal push guard (on)…",
  checking: "Terminal push guard (checking…)",
  unknown: "Terminal push guard…",
};

/** Every dialog state's title except the not-installed one. */
export const KEEP_LOCAL_HOOK_TITLE = "Terminal push guard";

/** The not-installed state's title. */
export const KEEP_LOCAL_HOOK_OFFER_TITLE = "Block terminal pushes too?";

/** The not-installed state's body; MCP is an AI feature, so Hide AI drops it. */
export const KEEP_LOCAL_HOOK_OFFER_BODY: Record<"ai" | "noAi", string> = {
  ai: "GitDesktop and its MCP server already refuse to push a branch marked Keep local. A pre-push hook makes git push stop as well, in a terminal or in an agent's own shell.",
  noAi: "GitDesktop already refuses to push a branch marked Keep local. A pre-push hook makes git push stop as well when it runs in a terminal.",
};

/** The first bullet splits around the hook's path, which renders as a path. */
export const KEEP_LOCAL_HOOK_CLONE_LEAD = "It lives in this clone only (";
export const KEEP_LOCAL_HOOK_CLONE_TAIL = "). Other clones don't get it.";

/** The hook file the status's `hooksPath` resolves to. */
export function keepLocalHookFile(hooksPath: string): string {
  return `${hooksPath}/pre-push`;
}

export const KEEP_LOCAL_HOOK_NO_VERIFY = "git push --no-verify skips it.";

/** The installed state's body. */
export const KEEP_LOCAL_HOOK_ON_BODY =
  "A pre-push hook in this clone stops git push for branches marked Keep local. It covers this clone only, and git push --no-verify skips it.";

type KeepLocalHookBlock = "hookManager" | "customHooksPath" | "foreignHook";

/** Why the hook can't be installed; `manager` is set for `hookManager` only. */
export const KEEP_LOCAL_HOOK_BLOCKED: Record<
  KeepLocalHookBlock,
  (manager: string | null) => string
> = {
  hookManager: (manager) =>
    `This repository's hooks are managed by ${manager ?? "a hook manager"}, so GitDesktop won't add a pre-push hook of its own.`,
  foreignHook: () =>
    "This clone already has a pre-push hook, so GitDesktop won't replace it.",
  customHooksPath: () =>
    "This repository keeps its hooks in a custom folder, so GitDesktop won't add a pre-push hook there.",
};

/** The can't-install state's lead-in to the check's code block. */
export const KEEP_LOCAL_HOOK_SNIPPET_LEAD =
  "Add this check to your pre-push hook to get the same guard:";

/** The can't-install state's line over Remove, while GitDesktop's own hook file
 *  is still in a hooks folder git no longer reads. */
export const KEEP_LOCAL_HOOK_INERT =
  "A GitDesktop hook from an earlier install is still in this clone, but it no longer runs because the hooks folder changed.";

/** The check's code block's accessible name. */
export const KEEP_LOCAL_HOOK_SNIPPET_LABEL =
  "Check to add to your pre-push hook";

/** The failed-status state's body. */
export const KEEP_LOCAL_HOOK_UNREAD = "Couldn't check this clone's hooks.";

/** The no-data state's busy line. */
export const KEEP_LOCAL_HOOK_CHECKING = "Checking this clone's hooks…";

export const KEEP_LOCAL_HOOK_BUTTONS = {
  cancel: "Cancel",
  install: "Install hook",
  remove: "Remove hook",
  close: "Close",
  copy: "Copy check",
  retry: "Retry",
} as const;

export const KEEP_LOCAL_HOOK_INSTALLED = "Terminal push guard installed";
export const KEEP_LOCAL_HOOK_REMOVED = "Terminal push guard removed";
export const KEEP_LOCAL_HOOK_COPIED = "Check copied";

/** A write that came back in a state other than its done one: the toast title
 *  when its dialog is gone, the inline line's lead while it is open. */
export const KEEP_LOCAL_HOOK_NOT_DONE: Record<"install" | "remove", string> = {
  install: "Terminal push guard not installed",
  remove: "Terminal push guard not removed",
};

/** What the clone holds after such a write; `blocked` reuses its reason. */
export const KEEP_LOCAL_HOOK_AFTER_WRITE: Record<
  "absent" | "installed",
  string
> = {
  absent: "This clone has no pre-push hook file.",
  installed: "The hook is still in this clone.",
};
