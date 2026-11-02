// Pins the tag detail pane's paint rules (src/features/tags/tag-detail-phase.ts):
// the local view shows at once unless the release LIST already says this tag
// has a release, a plain paint is never followed by a skeleton for the same
// tag, only THIS tag's own release reaches the release arm, and a paused
// (offline) read shows neither a line nor a skeleton. Inputs are the query
// flags TagDetailView feeds in; `paints` replays the view's per-tag latch.
//
// The source pins at the bottom hold TagDetailView.tsx's plain-arm dialog
// openers (Create release, Delete tag) on the same first-load flag: a release
// landing mid-dialog would swap arms and unmount the dialog.
//
// Not testable here: the focus rescues across the swap and the Retry, and what
// react-query actually reports for each read shape. Those need the live app.
//
// The import reaches straight into `src/` under Node's type stripping, so the
// module must stay free of runtime imports.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { tagReleasePhase } from "../src/features/tags/tag-detail-phase.ts";

/** A ready forge with nothing in flight and nothing answered. */
function input(over = {}) {
  return {
    ghReady: true,
    listLoading: false,
    listHasRelease: false,
    detailFirstLoad: false,
    detailFetching: false,
    detailErrored: false,
    heldRelease: false,
    createReleaseOpen: false,
    paintedLocal: false,
    ...over,
  };
}

/** The detail's first answer for this tag, actively in flight. */
const DETAIL_IN_FLIGHT = { detailFirstLoad: true, detailFetching: true };
/** The detail answered "no release" (or failed) and is idle. */
const DETAIL_MISSED = { detailErrored: true };

const PLAIN = {
  phase: "plain",
  checkingLine: false,
  errorLine: false,
  latchLocal: true,
};
const CHECKING = { ...PLAIN, checkingLine: true };
const ERRORED = { ...PLAIN, errorLine: true };
const SKELETON = {
  phase: "skeleton",
  checkingLine: false,
  errorLine: false,
  latchLocal: false,
};
const RELEASE = { ...SKELETON, phase: "release" };

/** Replays a run of renders the way TagDetailView does: the latch resets when
 *  the tag key changes and sets on any render whose phase asks for it. */
function paints(frames) {
  let key;
  let painted = false;
  return frames.map(({ tagKey, ...over }) => {
    if (tagKey !== key) {
      key = tagKey;
      painted = false;
    }
    const out = tagReleasePhase(input({ ...over, paintedLocal: painted }));
    if (out.latchLocal) painted = true;
    return out.phase + (out.checkingLine ? "+line" : "");
  });
}

test("forge-status pending, unreachable, or not set up: plain, no line", () => {
  // Every non-ready probe shape leaves both reads disabled.
  assert.deepEqual(tagReleasePhase(input({ ghReady: false })), PLAIN);
});

test("list first fetch in flight: plain with the checking line", () => {
  assert.deepEqual(
    tagReleasePhase(input({ listLoading: true, ...DETAIL_IN_FLIGHT })),
    CHECKING,
  );
});

test("list and detail paused offline: plain, no line, no skeleton", () => {
  assert.deepEqual(tagReleasePhase(input()), PLAIN);
});

test("list errored: silent plain; its focus refetch re-checks with the line", () => {
  assert.deepEqual(tagReleasePhase(input(DETAIL_IN_FLIGHT)), PLAIN);
  assert.deepEqual(tagReleasePhase(input(DETAIL_MISSED)), PLAIN);
  assert.deepEqual(
    tagReleasePhase(input({ listLoading: true, ...DETAIL_MISSED })),
    PLAIN,
    "a detail that already missed outranks the list's re-check",
  );
  assert.deepEqual(tagReleasePhase(input({ listLoading: true })), CHECKING);
});

test("list answered WITHOUT the tag: plain at once, never a skeleton", () => {
  assert.deepEqual(tagReleasePhase(input(DETAIL_IN_FLIGHT)), PLAIN);
  // Past the list's 100-release cap the detail still lands and swaps in.
  assert.deepEqual(tagReleasePhase(input({ heldRelease: true })), RELEASE);
});

test("list answered WITH the tag, detail first load, unlatched: skeleton", () => {
  assert.deepEqual(
    tagReleasePhase(input({ listHasRelease: true, ...DETAIL_IN_FLIGHT })),
    SKELETON,
  );
});

test("same but latched: plain with the line, then one swap", () => {
  assert.deepEqual(
    tagReleasePhase(
      input({ listHasRelease: true, paintedLocal: true, ...DETAIL_IN_FLIGHT }),
    ),
    CHECKING,
  );
  assert.deepEqual(
    tagReleasePhase(
      input({ listHasRelease: true, paintedLocal: true, heldRelease: true }),
    ),
    RELEASE,
  );
});

test("same but Create release open: plain, the dialog keeps its draft", () => {
  assert.deepEqual(
    tagReleasePhase(
      input({
        listHasRelease: true,
        createReleaseOpen: true,
        ...DETAIL_IN_FLIGHT,
      }),
    ),
    CHECKING,
  );
});

test("detail errored over a listed release: error line; Retry re-checks", () => {
  assert.deepEqual(
    tagReleasePhase(input({ listHasRelease: true, ...DETAIL_MISSED })),
    ERRORED,
  );
  // A retry after an error is fetching with no error and is never a first load.
  assert.deepEqual(
    tagReleasePhase(input({ listHasRelease: true, detailFetching: true })),
    CHECKING,
  );
  // A retry pressed offline parks with no line at all.
  assert.deepEqual(tagReleasePhase(input({ listHasRelease: true })), PLAIN);
  // An errored detail mid-refetch keeps neither line.
  assert.deepEqual(
    tagReleasePhase(
      input({
        listHasRelease: true,
        detailErrored: true,
        detailFetching: true,
      }),
    ),
    PLAIN,
  );
});

test("detail answered with this tag's release: the release arm", () => {
  for (const over of [
    {},
    { listHasRelease: true },
    { listLoading: true, detailFetching: true },
    { createReleaseOpen: true },
    { paintedLocal: true },
  ])
    assert.deepEqual(
      tagReleasePhase(input({ heldRelease: true, ...over })),
      RELEASE,
    );
});

test("identity: another tag's placeholder never reaches the release arm", () => {
  // The placeholder fails the tag-name gate, so heldRelease stays false.
  assert.deepEqual(tagReleasePhase(input(DETAIL_IN_FLIGHT)), PLAIN);
  assert.deepEqual(tagReleasePhase(input({ ghReady: false })), PLAIN);
  assert.deepEqual(
    tagReleasePhase(input({ listHasRelease: true, ...DETAIL_IN_FLIGHT })),
    SKELETON,
    "a released-to-released switch skeletons rather than dim the old release",
  );
  // A sign-out while THIS tag's release shows keeps its own last answer.
  assert.deepEqual(
    tagReleasePhase(input({ ghReady: false, heldRelease: true })),
    RELEASE,
  );
});

test("detail is truth: an answered miss hides the line while the list checks", () => {
  assert.deepEqual(
    tagReleasePhase(input({ listLoading: true, ...DETAIL_MISSED })),
    PLAIN,
  );
});

test("not ready: no line or error line whatever the read flags say", () => {
  for (const over of [
    { listLoading: true },
    { listHasRelease: true, ...DETAIL_MISSED },
    { listHasRelease: true, detailFetching: true },
  ])
    assert.deepEqual(tagReleasePhase(input({ ghReady: false, ...over })), {
      ...PLAIN,
    });
});

test("cold open of a plain tag paints one state, the line coming and going", () => {
  assert.deepEqual(
    paints([
      { tagKey: "r#v1", listLoading: true, ...DETAIL_IN_FLIGHT },
      { tagKey: "r#v1", ...DETAIL_IN_FLIGHT },
      { tagKey: "r#v1", ...DETAIL_MISSED },
    ]),
    ["plain+line", "plain", "plain"],
  );
});

test("cold open of a released tag: local with the line, then one swap", () => {
  // Whichever read answers first.
  assert.deepEqual(
    paints([
      { tagKey: "r#v1", listLoading: true, ...DETAIL_IN_FLIGHT },
      { tagKey: "r#v1", listHasRelease: true, ...DETAIL_IN_FLIGHT },
      { tagKey: "r#v1", listHasRelease: true, heldRelease: true },
    ]),
    ["plain+line", "plain+line", "release"],
  );
  assert.deepEqual(
    paints([
      { tagKey: "r#v1", listLoading: true, ...DETAIL_IN_FLIGHT },
      { tagKey: "r#v1", listLoading: true, heldRelease: true },
      { tagKey: "r#v1", listHasRelease: true, heldRelease: true },
    ]),
    ["plain+line", "release", "release"],
  );
});

test("warm list, cold detail: skeleton, then the release", () => {
  assert.deepEqual(
    paints([
      { tagKey: "r#v1", listHasRelease: true, ...DETAIL_IN_FLIGHT },
      { tagKey: "r#v1", listHasRelease: true, heldRelease: true },
    ]),
    ["skeleton", "release"],
  );
});

test("whole-path latch: a paused detail then reconnect never skeletons", () => {
  assert.deepEqual(
    paints([
      { tagKey: "r#v1", listHasRelease: true },
      { tagKey: "r#v1", listHasRelease: true, ...DETAIL_IN_FLIGHT },
      { tagKey: "r#v1", listHasRelease: true, heldRelease: true },
    ]),
    ["plain", "plain+line", "release"],
  );
});

test("whole-path latch: forge-status pending then ready never skeletons", () => {
  assert.deepEqual(
    paints([
      { tagKey: "r#v1", ghReady: false },
      { tagKey: "r#v1", listHasRelease: true, ...DETAIL_IN_FLIGHT },
      { tagKey: "r#v1", listHasRelease: true, heldRelease: true },
    ]),
    ["plain", "plain+line", "release"],
  );
});

test("whole-path latch: a query reset re-zeroing isFetched can't skeleton", () => {
  assert.deepEqual(
    paints([
      { tagKey: "r#v1", listHasRelease: true, ...DETAIL_MISSED },
      { tagKey: "r#v1", listHasRelease: true, ...DETAIL_IN_FLIGHT },
    ]),
    ["plain", "plain+line"],
  );
});

test("remote-only release row (no local tag): the same rules", () => {
  assert.deepEqual(
    paints([
      { tagKey: "r#draft", listHasRelease: true, ...DETAIL_IN_FLIGHT },
      { tagKey: "r#draft", listHasRelease: true, heldRelease: true },
    ]),
    ["skeleton", "release"],
  );
});

test("tag and repo switches reset the latch", () => {
  assert.deepEqual(
    paints([
      { tagKey: "r#v1", listLoading: true, ...DETAIL_IN_FLIGHT },
      // Released-to-released: a fresh key skeletons, never the old release.
      { tagKey: "r#v2", listHasRelease: true, ...DETAIL_IN_FLIGHT },
      { tagKey: "r#v2", listHasRelease: true, heldRelease: true },
      // Released-to-plain with the list answered: the plain view at once.
      { tagKey: "r#v3", ...DETAIL_IN_FLIGHT },
      { tagKey: "other#v3", listHasRelease: true, ...DETAIL_IN_FLIGHT },
    ]),
    ["plain+line", "skeleton", "release", "plain", "skeleton"],
  );
});

test("every input combination keeps the invariants", () => {
  const keys = Object.keys(input());
  for (let bits = 0; bits < 1 << keys.length; bits++) {
    const i = Object.fromEntries(
      keys.map((k, n) => [k, (bits >> n) % 2 === 1]),
    );
    const out = tagReleasePhase(i);
    const at = JSON.stringify(i);
    assert.equal(out.phase === "release", i.heldRelease, at);
    if (i.paintedLocal) assert.notEqual(out.phase, "skeleton", at);
    if (out.phase === "skeleton") assert.ok(i.listHasRelease, at);
    assert.equal(out.latchLocal, out.phase === "plain", at);
    if (out.phase !== "plain" || !i.ghReady) {
      assert.equal(out.checkingLine, false, at);
      assert.equal(out.errorLine, false, at);
    }
    assert.ok(!(out.checkingLine && out.errorLine), at);
    // A paused read (neither fetching) never shows the checking line.
    if (!i.listLoading && !i.detailFetching)
      assert.equal(out.checkingLine, false, at);
  }
});

// --- source pins on TagDetailView.tsx -------------------------------------

const SOURCE = new URL(
  "../src/features/tags/TagDetailView.tsx",
  import.meta.url,
);
const squash = (s) => s.replace(/\s+/g, "");
const ELLIPSIS = String.fromCharCode(0x2026);

function sourceProblems(raw) {
  const flat = squash(raw);
  const problems = [];
  const need = (cond, what) => {
    if (!cond) problems.push(what);
  };
  // One flag feeds the phase model and both holds.
  need(
    flat.includes(
      "constdetailFirstLoad=release.isFetching&&!release.isFetched;",
    ),
    "detailFirstLoad derived from the release read",
  );
  need(
    /tagReleasePhase\(\{[^}]*\bdetailFirstLoad,/.test(flat),
    "detailFirstLoad fed to tagReleasePhase",
  );
  // The checking line and the holds' reason share one string.
  need(
    flat.includes(
      '{checkingLine&&(<pclassName="text-[11px]text-muted-foreground">{CHECKING_RELEASE_COPY}</p>)}',
    ),
    "checking line renders CHECKING_RELEASE_COPY",
  );
  // The write block keeps precedence over the hold's reason.
  need(
    flat.includes(
      "disabled={writeBlocked||detailFirstLoad}reason={writeReason??(detailFirstLoad?CHECKING_RELEASE_COPY:undefined)}onClick={()=>setCreateReleaseOpen(true)}",
    ),
    "Create release holds through the first release read",
  );
  need(
    flat.includes(
      "disabled={detailFirstLoad}reason={detailFirstLoad?CHECKING_RELEASE_COPY:undefined}onClick={()=>{setDeleteTagRemote(false);setDeleteTagOpen(true);}}",
    ),
    "Delete tag holds through the first release read",
  );
  return problems;
}

test("TagDetailView.tsx holds both plain-arm dialog openers", () => {
  assert.deepEqual(sourceProblems(readFileSync(SOURCE, "utf8")), []);
});

test("the source pins catch their mutants", () => {
  const real = readFileSync(SOURCE, "utf8").replace(/\r\n/g, "\n");
  const mutants = [
    // Create release without the hold
    ["disabled={writeBlocked || detailFirstLoad}", "disabled={writeBlocked}"],
    // Create release's reason dropping the hold arm
    [
      "writeReason ??\n                (detailFirstLoad ? CHECKING_RELEASE_COPY : undefined)",
      "writeReason",
    ],
    // Delete tag without the hold
    ["          disabled={detailFirstLoad}\n", ""],
    // Delete tag's reason gone
    [
      "          reason={detailFirstLoad ? CHECKING_RELEASE_COPY : undefined}\n",
      "",
    ],
    // the checking line re-spelling its copy
    [
      "            {CHECKING_RELEASE_COPY}\n",
      `            Checking for a release${ELLIPSIS}\n`,
    ],
  ];
  for (const [from, to] of mutants) {
    assert.ok(real.includes(from), `mutant anchor missing: ${from}`);
    const problems = sourceProblems(real.replace(from, () => to));
    assert.ok(problems.length > 0, `mutant not caught: ${from}`);
  }
});
