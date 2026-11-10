import { describe, expect, it } from "vitest";
import { statusFacetLabel } from "@/features/actions/RunFilterChips";
import { STATUS_FACETS } from "@/features/actions/run-filters";
import { statusLabel } from "@/features/actions/status";

describe("GitLab status facet labels", () => {
  it("name finished statuses exactly as the run rows do", () => {
    // The (status, conclusion) pairs map_ci_status in forge/gitlab.rs gives rows.
    const rows: [string, string, string][] = [
      ["success", "completed", "success"],
      ["failed", "completed", "failure"],
      ["canceled", "completed", "cancelled"],
      ["skipped", "completed", "skipped"],
      ["manual", "completed", "action_required"],
    ];
    for (const [value, status, conclusion] of rows)
      expect(statusFacetLabel("gitlab", value)).toBe(
        statusLabel(status, conclusion),
      );
    expect(statusFacetLabel("gitlab", "canceled")).toBe("Cancelled");
    expect(statusFacetLabel("gitlab", "success")).toBe("Succeeded");
  });

  it("keep every option distinct", () => {
    const labels = STATUS_FACETS.gitlab.map((v) =>
      statusFacetLabel("gitlab", v),
    );
    expect(new Set(labels).size).toBe(labels.length);
  });
});
