import { describe, expect, it } from "vitest";
import {
  deliveryOutcome,
  VANISHED_LOCAL_PR_DETAIL,
} from "@/lib/automations/runner";

describe("deliveryOutcome", () => {
  it("records a vanished local PR as failed, naming why", () => {
    expect(deliveryOutcome("general", false, undefined)).toEqual({
      action: "general",
      code: "failed",
      detail: VANISHED_LOCAL_PR_DETAIL,
    });
  });

  it("never carries a result id onto the failed outcome", () => {
    expect(deliveryOutcome("general", false, "r-1")).toEqual({
      action: "general",
      code: "failed",
      detail: VANISHED_LOCAL_PR_DETAIL,
    });
  });

  it("records a delivered run as delivered, with its result id when present", () => {
    expect(deliveryOutcome("general", true, "r-1")).toEqual({
      action: "general",
      code: "delivered",
      resultId: "r-1",
    });
    expect(deliveryOutcome("general", true, undefined)).toEqual({
      action: "general",
      code: "delivered",
    });
  });
});
