// Pins the LOCAL merge strip's arm ladder (localMergeStripArm in
// src/features/pulls/merge-strip-arm.ts): a running update and an unfinished
// resolve outrank the prediction, a failed read reads "failed" over whatever it
// retained, an answer that cannot be a prediction reads "unchecked" and never
// "behind", a conflict outranks behind and withholds Update branch, and no
// pending read ever reads as "no conflicts" or as zero behind.
//
// Not testable here: how LocalPrView gates each read and what the strip draws
// for an arm. Those are the Vitest suites' job.
//
// The import reaches straight into `src/` under Node's type stripping, so the
// module must stay free of runtime imports.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  localMergeStripArm,
  PREVIEW_NO_CONFLICT,
} from "../src/features/pulls/merge-strip-arm.ts";

/** A settled preview with this status. */
const settled = (status) => ({
  enabled: true,
  isPending: false,
  isError: false,
  data: { status },
});

/** A preview still on its first load. */
const pendingPreview = {
  enabled: true,
  isPending: true,
  isError: false,
  data: undefined,
};

/** An answered comparison with this behind count. */
const behindBy = (n) => ({ enabled: true, isPending: false, behindBy: n });

/** An open, ordinary, clean PR with every read answered; each test overrides
 *  what it is about. */
function inputs(over = {}) {
  return {
    isOpen: true,
    preview: settled("clean"),
    comparison: behindBy(0),
    promotionKind: null,
    promotionSettling: false,
    updating: false,
    resolve: null,
    ...over,
  };
}

const arm = (over) => localMergeStripArm(inputs(over)).arm;

test("a closed or merged PR has no line", () => {
  const closed = {
    arm: null,
    offerUpdate: false,
    offerResolve: false,
    awaitingPromotion: false,
  };
  assert.deepEqual(localMergeStripArm(inputs({ isOpen: false })), closed);
  assert.deepEqual(
    localMergeStripArm(
      inputs({
        isOpen: false,
        updating: true,
        preview: settled("conflict"),
        comparison: behindBy(3),
        promotionSettling: true,
        resolve: { unfinished: true },
      }),
    ),
    closed,
  );
});

test("a running update outranks every read", () => {
  assert.equal(
    arm({
      updating: true,
      preview: settled("conflict"),
      resolve: { unfinished: true },
    }),
    "updating",
  );
});

test("an unfinished resolve shows above the prediction and needs no read", () => {
  const resolve = { unfinished: true };
  assert.equal(arm({ resolve, preview: pendingPreview }), "resume");
  assert.equal(arm({ resolve, preview: settled("conflict") }), "resume");
});

test("a settled conflict shows while the comparison loads", () => {
  assert.equal(
    arm({
      preview: settled("conflict"),
      comparison: { enabled: true, isPending: true, behindBy: undefined },
    }),
    "conflicted",
  );
});

test("a pending comparison is not zero behind", () => {
  assert.equal(
    arm({
      comparison: { enabled: true, isPending: true, behindBy: undefined },
    }),
    "checking",
  );
});

test("a pending preview holds the line over a known behind count", () => {
  assert.equal(
    arm({ preview: pendingPreview, comparison: behindBy(3) }),
    "checking",
  );
});

test("conflict outranks behind and withholds the update", () => {
  const r = localMergeStripArm(
    inputs({ preview: settled("conflict"), comparison: behindBy(3) }),
  );
  assert.equal(r.arm, "conflicted");
  assert.equal(r.offerUpdate, false);
});

test("an errored check reads failed, whatever it retained", () => {
  const errored = (data) => ({
    enabled: true,
    isPending: false,
    isError: true,
    data,
  });
  assert.equal(arm({ preview: errored(undefined) }), "failed", "no data");
  assert.equal(
    arm({ preview: errored({ status: "clean" }) }),
    "failed",
    "retained clean",
  );
  assert.equal(
    arm({ preview: errored({ status: "unknown" }) }),
    "failed",
    "retained unknown",
  );
});

test("a settled answer that cannot be a prediction reads unchecked", () => {
  assert.equal(arm({ preview: settled("unknown") }), "unchecked", "unknown");
  assert.equal(
    arm({
      preview: {
        enabled: false,
        isPending: false,
        isError: false,
        data: undefined,
      },
    }),
    "unchecked",
    "disabled",
  );
  assert.equal(
    arm({ preview: settled("diverged") }),
    "unchecked",
    "unrecognised status",
  );
});

test("an unrecognised status never reads behind", () => {
  const unrecognised = {
    preview: settled("diverged"),
    comparison: behindBy(3),
  };
  assert.equal(arm(unrecognised), "unchecked");
  assert.equal(arm({ ...unrecognised, promotionKind: "default" }), "unchecked");
  // The check can't predict, so Update branch stays reachable (unless a promotion).
  const plain = localMergeStripArm(inputs(unrecognised));
  assert.equal(plain.arm, "unchecked");
  assert.equal(plain.offerUpdate, true);
  const promo = localMergeStripArm(
    inputs({ ...unrecognised, promotionKind: "default" }),
  );
  assert.equal(promo.offerUpdate, false);
});

test("failed and unchecked keep the update reachable when behind", () => {
  const failedPreview = {
    enabled: true,
    isPending: false,
    isError: true,
    data: undefined,
  };
  const cases = [
    ["failed", failedPreview],
    ["unchecked", settled("unknown")],
  ];
  for (const [expected, preview] of cases) {
    const r = localMergeStripArm(inputs({ preview, comparison: behindBy(2) }));
    assert.equal(r.arm, expected);
    assert.equal(r.offerUpdate, true, expected);
    const promo = localMergeStripArm(
      inputs({ preview, comparison: behindBy(2), promotionKind: "default" }),
    );
    assert.equal(promo.arm, expected);
    assert.equal(promo.offerUpdate, false, `${expected} on a promotion`);
    for (const n of [0, undefined]) {
      const none = localMergeStripArm(
        inputs({
          preview,
          comparison: { enabled: true, isPending: false, behindBy: n },
        }),
      );
      assert.equal(none.arm, expected);
      assert.equal(none.offerUpdate, false, `${expected} behind ${n}`);
    }
  }
});

test("behind, and the promotion gap in its place", () => {
  const r = localMergeStripArm(inputs({ comparison: behindBy(3) }));
  assert.equal(r.arm, "behind");
  assert.equal(r.offerUpdate, true);
  for (const promotionKind of ["default", "configured"]) {
    const p = localMergeStripArm(
      inputs({ comparison: behindBy(3), promotionKind }),
    );
    assert.equal(p.arm, "promotion-gap", promotionKind);
    assert.equal(p.offerUpdate, false, promotionKind);
  }
});

test("every no-conflict status reads clean", () => {
  assert.equal(PREVIEW_NO_CONFLICT.size, 3);
  for (const status of PREVIEW_NO_CONFLICT) {
    const r = localMergeStripArm(inputs({ preview: settled(status) }));
    assert.deepEqual(
      r,
      {
        arm: "clean",
        offerUpdate: false,
        offerResolve: false,
        awaitingPromotion: false,
      },
      status,
    );
  }
  // A FAILED comparison has settled with no count: the prediction still stands.
  assert.equal(
    arm({
      comparison: { enabled: true, isPending: false, behindBy: undefined },
    }),
    "clean",
  );
});

test("resolve is offered only when supplied and not a promotion", () => {
  const conflict = { preview: settled("conflict") };
  assert.equal(
    localMergeStripArm(inputs({ ...conflict, resolve: null })).offerResolve,
    false,
  );
  assert.equal(
    localMergeStripArm(inputs({ ...conflict, resolve: { unfinished: false } }))
      .offerResolve,
    true,
  );
  const promo = localMergeStripArm(
    inputs({
      ...conflict,
      resolve: { unfinished: false },
      promotionKind: "configured",
    }),
  );
  assert.equal(promo.arm, "conflicted");
  assert.equal(promo.offerResolve, false);
});

test("promotion inputs still loading hold the offered action", () => {
  assert.equal(
    localMergeStripArm(
      inputs({ promotionSettling: true, comparison: behindBy(3) }),
    ).awaitingPromotion,
    true,
  );
  assert.equal(
    localMergeStripArm(
      inputs({
        promotionSettling: true,
        promotionKind: "default",
        comparison: behindBy(3),
      }),
    ).awaitingPromotion,
    false,
  );
  // Clean: nothing is offered, so nothing waits.
  assert.equal(
    localMergeStripArm(inputs({ promotionSettling: true })).awaitingPromotion,
    false,
  );
  // An offered resolve waits too.
  assert.equal(
    localMergeStripArm(
      inputs({
        promotionSettling: true,
        preview: settled("conflict"),
        resolve: { unfinished: false },
      }),
    ).awaitingPromotion,
    true,
  );
});

// Negative controls: each alternative ladder drops one rule the real ladder
// keeps, and must DISAGREE with it on the case that rule exists for, or the
// test above isn't pinning that rule.

test("negative control: reading a pending comparison as zero claims clean", () => {
  const pendingAsZero = (input) =>
    localMergeStripArm({
      ...input,
      comparison: { ...input.comparison, isPending: false },
    }).arm;
  const c = inputs({
    comparison: { enabled: true, isPending: true, behindBy: undefined },
  });
  assert.equal(pendingAsZero(c), "clean");
  assert.notEqual(pendingAsZero(c), localMergeStripArm(c).arm);
});

test("negative control: ranking behind over conflict offers the update", () => {
  const behindFirst = (input) => {
    const behind = input.comparison.behindBy ?? 0;
    return behind > 0 && input.promotionKind === null
      ? { arm: "behind", offerUpdate: true }
      : localMergeStripArm(input);
  };
  const c = inputs({ preview: settled("conflict"), comparison: behindBy(3) });
  assert.equal(behindFirst(c).offerUpdate, true);
  assert.notEqual(
    behindFirst(c).offerUpdate,
    localMergeStripArm(c).offerUpdate,
  );
});

test("negative control: keeping a retained answer over a failed refresh claims clean", () => {
  const keepsRetained = (input) =>
    localMergeStripArm({
      ...input,
      preview: {
        ...input.preview,
        isError: input.preview.isError && input.preview.data === undefined,
      },
    }).arm;
  const c = inputs({
    preview: {
      enabled: true,
      isPending: false,
      isError: true,
      data: { status: "clean" },
    },
  });
  assert.equal(keepsRetained(c), "clean");
  assert.notEqual(keepsRetained(c), localMergeStripArm(c).arm);
});

test("negative control: ranking the unknown status over the error rung hides Retry", () => {
  const unknownFirst = (input) =>
    input.preview.data?.status === "unknown"
      ? "unchecked"
      : localMergeStripArm(input).arm;
  const c = inputs({
    preview: {
      enabled: true,
      isPending: false,
      isError: true,
      data: { status: "unknown" },
    },
  });
  assert.equal(unknownFirst(c), "unchecked");
  assert.notEqual(unknownFirst(c), localMergeStripArm(c).arm);
});

test("negative control: an ungated behind rung reads behind on an unrecognised status", () => {
  const ungated = (input) => {
    const status = input.preview.data?.status;
    const behind = input.comparison.behindBy ?? 0;
    return status !== "conflict" &&
      status !== "unknown" &&
      !input.preview.isError &&
      behind > 0 &&
      input.promotionKind === null
      ? { arm: "behind", offerUpdate: true }
      : localMergeStripArm(input);
  };
  const c = inputs({ preview: settled("diverged"), comparison: behindBy(3) });
  assert.deepEqual(ungated(c), { arm: "behind", offerUpdate: true });
  assert.notEqual(ungated(c).arm, localMergeStripArm(c).arm);
});
