// Pins Keep local's owner-approved copy character for character, and that no
// string claims to cover "every push" (a terminal push isn't covered unless the
// pre-push guard is installed). The imports reach straight into src/ under
// Node's type stripping, so both modules must stay import-free.
import assert from "node:assert/strict";
import { test } from "node:test";

import * as copy from "../src/features/repository/keep-local-copy.ts";
import {
  KEPT_LOCAL_PULL_REASON,
  KEPT_LOCAL_SUFFIX,
  keptLocalReason,
} from "../src/features/repository/sync-controls-state.ts";

test("the chip, the menu item and the held-item suffix", () => {
  assert.equal(copy.KEPT_LOCAL_CHIP_TEXT, "kept local");
  assert.equal(
    copy.KEPT_LOCAL_CHIP_LABEL,
    "Kept local. GitDesktop won't push or publish this branch.",
  );
  assert.equal(copy.KEEP_LOCAL_ITEM, "Keep local");
  assert.equal(KEPT_LOCAL_SUFFIX, " (kept local)");
});

test("the toggle's toasts, with and without the AI wording", () => {
  assert.equal(copy.keepLocalOnTitle("feat/x"), "feat/x is kept local");
  assert.deepEqual(copy.KEEP_LOCAL_ON_DESCRIPTION, {
    ai: "GitDesktop and its MCP server won't push or publish it.",
    noAi: "GitDesktop won't push or publish it.",
  });
  assert.equal(copy.keepLocalOffTitle("feat/x"), "feat/x can be pushed again");
});

test("the held-push reasons", () => {
  assert.equal(
    keptLocalReason("feat/x", "push"),
    "feat/x is kept local. Turn off Keep local in the branch menu to push it.",
  );
  assert.equal(
    keptLocalReason("feat/x", "publish"),
    "feat/x is kept local. Turn off Keep local in the branch menu to publish it.",
  );
  assert.equal(
    KEPT_LOCAL_PULL_REASON.untracked("feat/x", ""),
    "Pull — feat/x is kept local and has no upstream branch to pull from",
  );
  assert.equal(
    KEPT_LOCAL_PULL_REASON.gone("feat/x", "origin/feat/x"),
    "Pull — feat/x is kept local and its upstream origin/feat/x was deleted on the remote, so there is nothing to pull",
  );
  assert.equal(
    copy.keptLocalPrReason("feat/x"),
    "feat/x is kept local, so it can't be pushed. Turn off Keep local in the branch menu, or create a local pull request instead.",
  );
  assert.equal(
    copy.keptLocalPromoteReason("feat/x"),
    "feat/x is kept local, so it can't be pushed. Turn off Keep local in the branch menu to publish this pull request.",
  );
  assert.equal(
    copy.keptLocalPublishRepoReason("main"),
    "main is kept local. Turn off Keep local in the branch menu to publish this repository.",
  );
});

// The kept-local gone marker is built by rowSyncIndicator; its row lives in
// scripts/sync-controls-state.test.mjs.
test("the palette refusals", () => {
  assert.equal(
    copy.KEEP_LOCAL_PALETTE_NO_BRANCH,
    "There's no current branch to keep local (detached HEAD).",
  );
  assert.equal(
    copy.KEEP_LOCAL_PALETTE_SESSION,
    "gd/session branches are never pushed, so there is nothing to keep local.",
  );
});

test("the terminal push guard's menu item", () => {
  assert.deepEqual(copy.KEEP_LOCAL_HOOK_ITEM, {
    block: "Block terminal pushes too…",
    on: "Terminal push guard (on)…",
    checking: "Terminal push guard (checking…)",
    unknown: "Terminal push guard…",
  });
});

test("the guard dialog's not-installed state", () => {
  assert.equal(copy.KEEP_LOCAL_HOOK_OFFER_TITLE, "Block terminal pushes too?");
  assert.deepEqual(copy.KEEP_LOCAL_HOOK_OFFER_BODY, {
    ai: "GitDesktop and its MCP server already refuse to push a branch marked Keep local. A pre-push hook makes git push stop as well, in a terminal or in an agent's own shell.",
    noAi: "GitDesktop already refuses to push a branch marked Keep local. A pre-push hook makes git push stop as well when it runs in a terminal.",
  });
  // The dialog renders the bullet as lead, the file as a path, then tail.
  assert.equal(
    `${copy.KEEP_LOCAL_HOOK_CLONE_LEAD}${copy.keepLocalHookFile("C:/r/.git/hooks")}${copy.KEEP_LOCAL_HOOK_CLONE_TAIL}`,
    "It lives in this clone only (C:/r/.git/hooks/pre-push). Other clones don't get it.",
  );
  assert.equal(
    copy.KEEP_LOCAL_HOOK_NO_VERIFY,
    "git push --no-verify skips it.",
  );
  assert.equal(copy.KEEP_LOCAL_HOOK_BUTTONS.cancel, "Cancel");
  assert.equal(copy.KEEP_LOCAL_HOOK_BUTTONS.install, "Install hook");
});

test("the guard dialog's installed, blocked and unread states", () => {
  assert.equal(copy.KEEP_LOCAL_HOOK_TITLE, "Terminal push guard");
  assert.equal(
    copy.KEEP_LOCAL_HOOK_ON_BODY,
    "A pre-push hook in this clone stops git push for branches marked Keep local. It covers this clone only, and git push --no-verify skips it.",
  );
  assert.equal(copy.KEEP_LOCAL_HOOK_BUTTONS.remove, "Remove hook");
  assert.equal(copy.KEEP_LOCAL_HOOK_BUTTONS.close, "Close");
  assert.equal(
    copy.KEEP_LOCAL_HOOK_SNIPPET_LEAD,
    "Add this check to your pre-push hook to get the same guard:",
  );
  assert.equal(copy.KEEP_LOCAL_HOOK_BUTTONS.copy, "Copy check");
  for (const manager of ["husky", "pre-commit", "lefthook"])
    assert.equal(
      copy.KEEP_LOCAL_HOOK_BLOCKED.hookManager(manager),
      `This repository's hooks are managed by ${manager}, so GitDesktop won't add a pre-push hook of its own.`,
    );
  assert.equal(
    copy.KEEP_LOCAL_HOOK_BLOCKED.hookManager(null),
    "This repository's hooks are managed by a hook manager, so GitDesktop won't add a pre-push hook of its own.",
  );
  assert.equal(
    copy.KEEP_LOCAL_HOOK_SNIPPET_LABEL,
    "Check to add to your pre-push hook",
  );
  assert.equal(
    copy.KEEP_LOCAL_HOOK_BLOCKED.foreignHook(null),
    "This clone already has a pre-push hook, so GitDesktop won't replace it.",
  );
  assert.equal(
    copy.KEEP_LOCAL_HOOK_BLOCKED.customHooksPath(null),
    "This repository keeps its hooks in a custom folder, so GitDesktop won't add a pre-push hook there.",
  );
  assert.equal(
    copy.KEEP_LOCAL_HOOK_UNREAD,
    "Couldn't check this clone's hooks.",
  );
  assert.equal(copy.KEEP_LOCAL_HOOK_BUTTONS.retry, "Retry");
  assert.equal(
    copy.KEEP_LOCAL_HOOK_INERT,
    "A GitDesktop hook from an earlier install is still in this clone, but it no longer runs because the hooks folder changed.",
  );
});

test("the guard's toasts", () => {
  assert.equal(copy.KEEP_LOCAL_HOOK_INSTALLED, "Terminal push guard installed");
  assert.equal(copy.KEEP_LOCAL_HOOK_REMOVED, "Terminal push guard removed");
  assert.equal(copy.KEEP_LOCAL_HOOK_COPIED, "Check copied");
});

test("a guard write that didn't take", () => {
  assert.deepEqual(copy.KEEP_LOCAL_HOOK_NOT_DONE, {
    install: "Terminal push guard not installed",
    remove: "Terminal push guard not removed",
  });
  assert.deepEqual(copy.KEEP_LOCAL_HOOK_AFTER_WRITE, {
    absent: "This clone has no pre-push hook file.",
    installed: "The hook is still in this clone.",
  });
});

/** Every string the module exports: constants, Record values, and each builder
 *  called with a placeholder. */
function exportedStrings() {
  const out = [];
  const visit = (v) => {
    if (typeof v === "string") out.push(v);
    else if (typeof v === "function") visit(v("X"));
    else if (v && typeof v === "object")
      for (const x of Object.values(v)) visit(x);
  };
  for (const v of Object.values(copy)) visit(v);
  visit(keptLocalReason("X", "push"));
  visit(keptLocalReason("X", "publish"));
  return out;
}

test("no string claims to cover every push", () => {
  const strings = exportedStrings();
  assert.ok(strings.length >= 12, "the copy module looks empty");
  for (const s of strings)
    for (const banned of [/every push/i, /all pushes/i])
      assert.doesNotMatch(s, banned);
});

test("the quantifier check catches a string that claims every push", () => {
  const strings = [
    ...exportedStrings(),
    "GitDesktop refuses every push of it.",
  ];
  assert.ok(strings.some((s) => /every push/i.test(s)));
});
