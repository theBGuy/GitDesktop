// Pins the fire-time push re-checks on the routes that move or remove a branch
// ref (rename, local delete, archive, reset to upstream, pull-drop, the
// stash-reapply reruns) or delete branches in bulk (Clean up), and the Ctrl+B
// modal gate. A dialog opened before a push started still submits after it, so
// each submit reads the pending pushes live; render state alone predates them.
//
// The source checker is a pure function over file text, so the suite feeds it
// the real files (must pass) and in-memory mutants with a check removed (must
// fail). It fails closed: a missing file, anchor or needle is a failure.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pushesBranch } from "../src/features/repository/branch-sync-state.ts";
import { elementInOpenModal } from "../src/lib/hotkeys/modal-gate.ts";

const R = "src/features/repository/";
const DERIVED =
  "`A push is already running — ${fallback} is checked out and ${deleteTarget} was kept.`";

/** Each pin: a handler anchor in `file`, and needles that must appear in its
 *  body IN ORDER. `mutate` lists the needles whose removal must fail the pin. */
const PINS = [
  {
    name: "rename submit",
    file: `${R}RenameBranchDialog.tsx`,
    anchor: "onSubmit: async ({ value }) =>",
    seq: [
      "if (!target) return;",
      "refuseWhileBranchPushes(queryClient, repoPath, target, currentName)",
      "promotionBlocksCheckout(repoPath)",
      "await renameBranch.mutateAsync",
    ],
    mutate: [
      "refuseWhileBranchPushes(queryClient, repoPath, target, currentName)",
    ],
  },
  {
    name: "rename helper",
    file: `${R}RenameBranchDialog.tsx`,
    anchor: "function refuseWhileBranchPushes(",
    seq: [
      "branchPushKey(repoPath)",
      "pushesBranch(pushes, branch, currentName)",
      "toast.info(BRANCH_PUSH_ACTIVE_MESSAGE)",
    ],
    mutate: ["pushesBranch(pushes, branch, currentName)"],
  },
  {
    name: "local delete",
    file: `${R}BranchSwitcher.tsx`,
    anchor: "async function doDelete() {",
    seq: [
      "isDeletionBlocked(rulesConfig, deleteTarget)",
      "if (refuseWhileBranchPushes(deleteTarget)) return;",
      "try {",
      "await listUserWorktrees(repoPath)",
      '"before the delete started"',
      "if (refuseWhileBranchPushes(deleteTarget)) return;",
      "await checkout.mutateAsync(fallback)",
      "`before ${deleteTarget} was deleted`",
      "refuseWhileBranchPushes(",
      DERIVED,
      "await deleteBranch.mutateAsync(deleteTarget)",
    ],
    mutate: ["if (refuseWhileBranchPushes(deleteTarget)) return;", DERIVED],
  },
  {
    name: "archive",
    file: `${R}BranchSwitcher.tsx`,
    anchor: "async function setArchived(name: string, archived: boolean) {",
    seq: [
      "if (archived && refuseWhileBranchPushes(name)) return;",
      "await setBranchArchived.mutateAsync",
    ],
    mutate: ["if (archived && refuseWhileBranchPushes(name)) return;"],
  },
  {
    name: "switcher reset to upstream",
    file: `${R}BranchSwitcher.tsx`,
    anchor: "async function doResetToUpstream(",
    seq: [
      "useConfirm.getState().ask",
      'if (refuseIfSwitched(resetIn, "nothing was reset")) return;',
      "if (refuseWhileBranchPushes(branch.name)) return;",
      "branchRewriteStatusOptions(repoPath, branch.name)",
      'if (refuseIfSwitched(resetIn, "nothing was reset")) return;',
      "if (refuseWhileBranchPushes(branch.name)) return;",
      "await hardReset.mutateAsync",
    ],
    mutate: ["if (refuseWhileBranchPushes(branch.name)) return;"],
  },
  {
    name: "switcher helper",
    file: `${R}BranchSwitcher.tsx`,
    anchor: "function refuseWhileBranchPushes(",
    seq: [
      "publishDetectRef.current",
      "branchPushKey(repoPath)",
      "detect.branch === branch",
      "!branchPushing(branch)",
      "!pushesBranch(live, branch, currentNameRef.current)",
      "toast.info(message)",
    ],
    mutate: [
      "detect.branch === branch",
      "!branchPushing(branch)",
      "!pushesBranch(live, branch, currentNameRef.current)",
    ],
  },
  {
    name: "show-branches modal gate",
    file: `${R}BranchSwitcher.tsx`,
    anchor: '"show-branches",',
    seq: ["if (focusInOpenModal()) return;", "setOpen(true)"],
    mutate: ["if (focusInOpenModal()) return;"],
  },
  {
    name: "sync reset to upstream",
    file: `${R}SyncControls.tsx`,
    anchor: "async function doResetToUpstream() {",
    seq: [
      "useConfirm.getState().ask",
      'if (refuseIfSwitched(resetIn, "nothing was reset")) return;',
      "if (headNameRef.current !== branch) {",
      "if (refuseWhileBranchPushes(branch)) return;",
      "branchRewriteStatusOptions(repoPath, branch)",
      'if (refuseIfSwitched(resetIn, "nothing was reset")) return;',
      "if (refuseWhileBranchPushes(branch)) return;",
      "await hardReset.mutateAsync",
    ],
    mutate: ["if (refuseWhileBranchPushes(branch)) return;"],
  },
  {
    name: "sync helper",
    file: `${R}SyncControls.tsx`,
    anchor: "function refuseWhileBranchPushes(branch: string): boolean {",
    seq: [
      "branchPushKey(repoPath)",
      "pushesBranch(pushes, branch, headNameRef.current ?? null)",
      "toast.info(BRANCH_PUSH_ACTIVE_MESSAGE)",
    ],
    mutate: ["pushesBranch(pushes, branch, headNameRef.current ?? null)"],
  },
  {
    name: "clean up batch",
    file: `${R}CleanupBranchesDialog.tsx`,
    anchor: "async function runBatch() {",
    seq: [
      "if (refuseWhilePushRuns(queryClient, repoPath)) return;",
      "setFailed(new Map());",
      "for (let i = 0; i < names.length; i++) {",
      "if (refuseWhilePushRuns(queryClient, repoPath)) {",
      "processed = i;",
      "break;",
      "await api.gitSetBranchArchived",
      "const ok = processed - fails.size;",
      "if (processed < names.length) {",
      "} else if (ok > 0) toast.success(`${verb} ${pluralBranches(ok)}`);",
      "return;",
      "if (fails.size === 0) {",
      "onClose();",
    ],
    mutate: [
      "if (refuseWhilePushRuns(queryClient, repoPath)) return;",
      "if (refuseWhilePushRuns(queryClient, repoPath)) {",
      "const ok = processed - fails.size;",
      "if (processed < names.length) {",
    ],
  },
  {
    name: "pull-drop decide",
    file: `${R}usePullDropGuard.tsx`,
    anchor: "async function decide(decision: PullDecision) {",
    seq: [
      "toast.info(PROMOTION_BLOCKS_CHECKOUT);",
      "if (refuseWhileBranchPushes(queryClient, repoPath, refusal.branch)) return;",
      "setRunning(decision);",
    ],
    mutate: [
      "if (refuseWhileBranchPushes(queryClient, repoPath, refusal.branch)) return;",
    ],
  },
  {
    name: "pull-drop helper",
    file: `${R}usePullDropGuard.tsx`,
    anchor: "function refuseWhileBranchPushes(",
    seq: [
      "repoKeys.branches(repoPath)",
      "b.isCurrent",
      "branchPushKey(repoPath)",
      "pushesBranch(pushes, branch, currentName)",
      "toast.info(BRANCH_PUSH_ACTIVE_MESSAGE)",
    ],
    mutate: ["pushesBranch(pushes, branch, currentName)"],
  },
  {
    name: "stash-reapply rerun",
    file: `${R}useStashReapplyRecovery.tsx`,
    anchor: "async function runRecovery(req: StashReapplyRequest) {",
    seq: [
      "refuseOutsideRepo(repoPath, req)",
      'if (req.run.op === "pull" && refuseWhileOffline()) return;',
      "if (refuseWhileRunPushes(queryClient, repoPath, req.run)) return;",
      "await runCompound(req.run)",
    ],
    mutate: [
      "if (refuseWhileRunPushes(queryClient, repoPath, req.run)) return;",
    ],
  },
  {
    name: "stash-reapply helper",
    file: `${R}useStashReapplyRecovery.tsx`,
    anchor: "function refuseWhileRunPushes(",
    seq: [
      'if (run.op === "pull" || run.op === "merge")',
      "return refuseWhilePushRuns(queryClient, repoPath);",
      "repoKeys.branches(repoPath)",
      'run.op === "pullRebaseDecided" ? run.branch : currentName',
      "branch === null",
      "isBranchPushActive(queryClient, repoPath)",
      "pushesBranch(",
      "toast.info(BRANCH_PUSH_ACTIVE_MESSAGE)",
    ],
    mutate: [
      "return refuseWhilePushRuns(queryClient, repoPath);",
      "isBranchPushActive(queryClient, repoPath)",
      'run.op === "pullRebaseDecided" ? run.branch : currentName',
    ],
  },
];

/** The brace-matched body that follows `anchor`, or null when either is
 *  missing. Sources are CRLF-normalized first. */
function bodyAfter(text, anchor) {
  const at = text.indexOf(anchor);
  if (at < 0) return null;
  const open = text.indexOf("{", at + anchor.length - 1);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  return null;
}

/** Failures for `pins` over `sources` (file → text); empty means every pin
 *  holds. */
function checkPins(pins, sources) {
  const fails = [];
  for (const pin of pins) {
    const text = sources[pin.file];
    if (typeof text !== "string") {
      fails.push(`${pin.name}: missing file ${pin.file}`);
      continue;
    }
    const body = bodyAfter(text.replace(/\r\n/g, "\n"), pin.anchor);
    if (body === null) {
      fails.push(`${pin.name}: anchor not found: ${pin.anchor}`);
      continue;
    }
    let from = 0;
    for (const needle of pin.seq) {
      const at = body.indexOf(needle, from);
      if (at < 0) {
        fails.push(`${pin.name}: missing or out of order: ${needle}`);
        break;
      }
      from = at + needle.length;
    }
  }
  return fails;
}

const FILES = [...new Set(PINS.map((p) => p.file))];
const realSources = () =>
  Object.fromEntries(
    FILES.map((f) => [
      f,
      readFileSync(new URL(`../${f}`, import.meta.url), "utf8"),
    ]),
  );

test("pushesBranch: own, other, HEAD and unknown-current pushes", () => {
  const own = [{ branch: "feat" }];
  const other = [{ branch: "main" }];
  const head = [{ branch: null }];
  assert.equal(pushesBranch(own, "feat", "main"), true);
  assert.equal(pushesBranch(other, "feat", "feat"), false);
  assert.equal(pushesBranch(head, "feat", "feat"), true);
  assert.equal(pushesBranch(head, "feat", "main"), false);
  assert.equal(pushesBranch(head, "feat", null), true);
  assert.equal(pushesBranch([], "feat", null), false);
  assert.equal(pushesBranch([...other, ...own], "feat", "main"), true);
});

test("branch-sync-state stays runtime-import-free", () => {
  const src = readFileSync(
    new URL(`../${R}branch-sync-state.ts`, import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(src, /^\s*import\s/m);
});

test("every route re-checks the running push where it fires", () => {
  assert.deepEqual(checkPins(PINS, realSources()), []);
});

test("each file's helper is the one pushesBranch caller in it", () => {
  const sources = realSources();
  for (const file of FILES) {
    if (file.endsWith("CleanupBranchesDialog.tsx")) continue;
    const calls = sources[file].split("pushesBranch(").length - 1;
    assert.equal(calls, 1, `${file}: ${calls} pushesBranch( calls`);
  }
});

// One mutant per OCCURRENCE of each needle in the pin's body, so a doubled
// check (a boundary re-run after an await) is proven at each of its sites.
test("mutants with a check removed fail", () => {
  const sources = realSources();
  let doubled = 0;
  for (const pin of PINS) {
    const text = sources[pin.file].replace(/\r\n/g, "\n");
    const body = bodyAfter(text, pin.anchor);
    assert.ok(body !== null, pin.anchor);
    const at = text.indexOf(body);
    for (const needle of pin.mutate) {
      const parts = body.split(needle);
      assert.ok(parts.length > 1, needle);
      if (parts.length > 2) doubled++;
      for (let k = 1; k < parts.length; k++) {
        const cut =
          parts.slice(0, k).join(needle) + parts.slice(k).join(needle);
        const mutant = {
          ...sources,
          [pin.file]: text.slice(0, at) + cut + text.slice(at + body.length),
        };
        assert.notDeepEqual(
          checkPins([pin], mutant),
          [],
          `${pin.name}: removing occurrence ${k} of ${needle} still passes`,
        );
      }
    }
  }
  // doDelete's and both doResetToUpstream's second boundaries.
  assert.equal(doubled, 3, "doubled needles");
});

test("fails closed on a missing file or anchor", () => {
  const sources = realSources();
  const [pin] = PINS;
  assert.notDeepEqual(checkPins([pin], {}), []);
  assert.notDeepEqual(
    checkPins([{ ...pin, anchor: "no such anchor" }], sources),
    [],
  );
});

// A minimal element tree: attribute-compound selector lists, `closest` from
// the node itself up, `querySelector` over descendants.
function matches(node, sel) {
  return sel.split(",").some((compound) => {
    const parts = [...compound.trim().matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
    if (parts.length === 0) throw new Error(`unparsed selector: ${compound}`);
    return parts.every(([, k, v]) =>
      v === undefined ? k in node.attrs : node.attrs[k] === v,
    );
  });
}
function el(attrs, ...children) {
  const node = {
    attrs,
    parent: null,
    children,
    closest(sel) {
      for (let n = node; n; n = n.parent) if (matches(n, sel)) return n;
      return null;
    },
    querySelector(sel) {
      const stack = [...node.children];
      while (stack.length) {
        const n = stack.shift();
        if (matches(n, sel)) return n;
        stack.push(...n.children);
      }
      return null;
    },
  };
  for (const c of children) c.parent = node;
  return node;
}

test("elementInOpenModal: open slots, nested portaled popups, closed and other slots", () => {
  const input = el({});
  el(
    { "data-slot": "dialog-portal" },
    el({ "data-slot": "dialog-content", "data-open": "" }, input),
  );
  assert.equal(elementInOpenModal(input), true);

  // A picker's search input inside a modal: portaled beside the content.
  const search = el({});
  el(
    { "data-slot": "dialog-portal" },
    el({ "data-slot": "dialog-content", "data-open": "" }),
    el({}, el({ "data-slot": "popover-content", "data-open": "" }, search)),
  );
  assert.equal(elementInOpenModal(search), true);

  // The command palette is itself a dialog-content.
  const paletteInput = el({});
  el(
    { "data-slot": "dialog-portal" },
    el({ "data-slot": "dialog-content", "data-open": "" }, paletteInput),
  );
  assert.equal(elementInOpenModal(paletteInput), true);

  const closedInput = el({});
  el(
    { "data-slot": "dialog-portal" },
    el({ "data-slot": "dialog-content", "data-closed": "" }, closedInput),
  );
  assert.equal(elementInOpenModal(closedInput), false);

  // The switcher's own popover sets role="dialog" but is no matched slot.
  const popoverInput = el({});
  el(
    { "data-slot": "popover-content", role: "dialog", "data-open": "" },
    popoverInput,
  );
  assert.equal(elementInOpenModal(popoverInput), false);

  assert.equal(elementInOpenModal(null), false);

  const sheetInput = el({});
  el({ "data-slot": "sheet-content", "data-open": "" }, sheetInput);
  assert.equal(elementInOpenModal(sheetInput), true);

  const drawerInput = el({});
  el({ "data-slot": "drawer-content", "data-state": "open" }, drawerInput);
  assert.equal(elementInOpenModal(drawerInput), true);

  // Vaul spells open as data-state; a bare data-open is not its open state.
  const drawerClosed = el({});
  el(
    { "data-slot": "drawer-content", "data-state": "closed", "data-open": "" },
    drawerClosed,
  );
  assert.equal(elementInOpenModal(drawerClosed), false);
});

test("modal-gate selector strings name every slot and portal", () => {
  const src = readFileSync(
    new URL("../src/lib/hotkeys/modal-gate.ts", import.meta.url),
    "utf8",
  );
  for (const s of [
    '[data-slot="dialog-content"][data-open]',
    '[data-slot="sheet-content"][data-open]',
    '[data-slot="drawer-content"][data-state="open"]',
    '[data-slot="dialog-portal"]',
    '[data-slot="sheet-portal"]',
    '[data-slot="drawer-portal"]',
  ])
    assert.ok(src.includes(s), s);
  assert.doesNotMatch(src, /\[role=/);
});
