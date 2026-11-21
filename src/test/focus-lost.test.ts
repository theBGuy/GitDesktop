import { afterEach, describe, expect, it, vi } from "vitest";
import { focusIsLost } from "@/lib/focus-lost";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function focusedButton(parent: HTMLElement = document.body) {
  const button = document.createElement("button");
  parent.appendChild(button);
  button.focus();
  return button;
}

/** A focused button whose parent is then hidden the way `<Activity>` hides its
 *  top-level host nodes (jsdom refuses focus INTO a hidden subtree, but keeps
 *  focus that was already there). */
function focusedThenHidden() {
  const div = document.createElement("div");
  document.body.appendChild(div);
  const button = focusedButton(div);
  div.style.setProperty("display", "none", "important");
  return button;
}

describe("focusIsLost", () => {
  it("is true with focus on <body>", () => {
    expect(document.activeElement).toBe(document.body);
    expect(focusIsLost()).toBe(true);
  });

  it("is true with no active element", () => {
    vi.spyOn(Document.prototype, "activeElement", "get").mockReturnValue(null);
    expect(focusIsLost()).toBe(true);
  });

  it("is true for a detached active element", () => {
    const detached = document.createElement("button");
    vi.spyOn(Document.prototype, "activeElement", "get").mockReturnValue(
      detached,
    );
    expect(focusIsLost()).toBe(true);
  });

  it("is true for an element under a display:none ancestor", () => {
    const button = focusedThenHidden();
    expect(document.activeElement).toBe(button);
    expect(focusIsLost()).toBe(true);
  });

  it("is false for a focused visible input", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);
    expect(focusIsLost()).toBe(false);
  });

  it("asks checkVisibility where it exists: false means lost", () => {
    const button = focusedButton();
    const check = vi.fn(() => false);
    Object.defineProperty(Element.prototype, "checkVisibility", {
      configurable: true,
      value: check,
    });
    try {
      expect(focusIsLost()).toBe(true);
      expect(check).toHaveBeenCalled();
      expect(check.mock.contexts[0]).toBe(button);
    } finally {
      Reflect.deleteProperty(Element.prototype, "checkVisibility");
    }
  });

  it("asks checkVisibility where it exists: true wins over a hidden ancestor", () => {
    focusedThenHidden();
    Object.defineProperty(Element.prototype, "checkVisibility", {
      configurable: true,
      value: () => true,
    });
    try {
      expect(focusIsLost()).toBe(false);
    } finally {
      Reflect.deleteProperty(Element.prototype, "checkVisibility");
    }
  });
});
