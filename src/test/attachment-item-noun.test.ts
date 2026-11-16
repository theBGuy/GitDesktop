import { describe, expect, it } from "vitest";
import {
  createdWarning,
  updatedToast,
  updatedWarning,
} from "@/lib/attachments/comment-post";

// The pull/merge request sentences name the item with the noun the caller's
// forge uses; the defaults stay GitHub's.
describe("create and edit warnings name the forge's item", () => {
  it("says merge request in an edit's toast and warning", () => {
    expect(updatedToast("pr", "merge request")).toBe("Merge request updated");
    expect(updatedWarning("pr", ["image-1.png"], "merge request")).toBe(
      "Merge request updated, but image-1.png didn't upload. Edit the description to add it again.",
    );
    expect(
      updatedWarning("pr", ["image-1.png", "image-2.png"], "merge request"),
    ).toBe(
      "Merge request updated, but 2 images didn't upload. Edit the description to add them again.",
    );
  });

  it("keeps the default nouns without one", () => {
    expect(updatedToast("pr")).toBe("Pull request updated");
    expect(updatedToast("issue")).toBe("Issue updated");
    expect(updatedWarning("pr", ["image-1.png"], "pull request")).toBe(
      updatedWarning("pr", ["image-1.png"]),
    );
  });

  it("says merge request in a create's follow-up, image and combined warnings", () => {
    const opts = { noun: "merge request" };
    expect(createdWarning("pr", ["image-1.png"], null, opts)).toBe(
      "Merge request created, but image-1.png didn't upload. Edit the description to add it again.",
    );
    expect(createdWarning("pr", [], "labels failed", opts)).toBe(
      "Merge request created, but its labels and assignees weren't applied. Add them from the merge request.",
    );
    expect(createdWarning("pr", ["image-1.png"], "labels failed", opts)).toBe(
      "Merge request created, but its labels and assignees weren't applied. Add them from the merge request. Also, image-1.png didn't upload. Edit the description to add it again.",
    );
  });

  it("keeps the issue sentences, which take no noun", () => {
    expect(createdWarning("issue", ["image-1.png"], null)).toBe(
      "Issue created, but image-1.png didn't upload. Edit the description to add it again.",
    );
    expect(createdWarning("issue", [], "x")).toBe(
      "Issue created, but some of its details weren't applied. Check its labels, assignees, milestone and type.",
    );
  });
});
