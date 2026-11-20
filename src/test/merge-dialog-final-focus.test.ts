import { afterEach, describe, expect, it } from "vitest";
import { mergeDialogFinalFocus } from "@/features/pulls/MergePrDialog";

const attached = () => document.body.appendChild(document.createElement("div"));
const detached = () => document.createElement("div");

/** A focusable frame (the view's `tabIndex={-1}` root) with a tabbable child,
 *  the shape Base UI would otherwise resolve to that child. */
function frame() {
  const root = attached();
  root.tabIndex = -1;
  root.appendChild(document.createElement("button"));
  return root;
}

/** A popup holding the focused control, as at close time. */
function popupWithFocus() {
  const popup = attached();
  const button = popup.appendChild(document.createElement("button"));
  button.focus();
  return popup;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("the merge dialog's close-time focus", () => {
  it("keeps the default return while the footer is in the document", () => {
    const view = frame();
    const popup = popupWithFocus();
    expect(mergeDialogFinalFocus(attached(), view, popup)).toBe(true);
    expect(document.activeElement).not.toBe(view);
  });

  it("focuses the frame itself once the footer is gone, and returns nothing", () => {
    for (const footer of [null, detached()]) {
      const view = frame();
      const popup = popupWithFocus();
      expect(mergeDialogFinalFocus(footer, view, popup)).toBe(false);
      expect(document.activeElement).toBe(view);
    }
  });

  it("rescues focus that fell to <body>", () => {
    const view = frame();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    expect(mergeDialogFinalFocus(null, view, null)).toBe(false);
    expect(document.activeElement).toBe(view);
  });

  it("keeps the default return when the frame is gone too", () => {
    for (const footer of [null, detached()])
      for (const fallback of [null, detached()])
        expect(mergeDialogFinalFocus(footer, fallback, popupWithFocus())).toBe(
          true,
        );
  });

  it("leaves focus the user moved out of the dialog where it is", () => {
    const view = frame();
    const popup = attached();
    const elsewhere = attached().appendChild(document.createElement("input"));
    elsewhere.focus();
    expect(mergeDialogFinalFocus(null, view, popup)).toBe(false);
    expect(document.activeElement).toBe(elsewhere);
  });
});
