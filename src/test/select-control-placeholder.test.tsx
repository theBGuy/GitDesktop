import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SelectControl } from "@/components/form/fields";

const ITEMS = { main: "main", feat: "feat" };

/** The closed control as its call sites render it; `placeholder` only when the
 *  case passes one. */
function renderControl(value: string, placeholder?: string) {
  render(
    <SelectControl
      label="Branch"
      items={ITEMS}
      value={value}
      onValueChange={() => undefined}
      {...(placeholder === undefined ? {} : { placeholder })}
    />,
  );
  const trigger = screen.getByRole("combobox", { name: "Branch" });
  const valueSpan = trigger.querySelector('[data-slot="select-value"]');
  if (valueSpan === null) throw new Error("no select value span");
  return { trigger, valueSpan };
}

describe("SelectControl without a placeholder", () => {
  it("shows the chosen item's label with no placeholder state", () => {
    const { trigger, valueSpan } = renderControl("feat");
    expect(valueSpan.textContent).toBe("feat");
    expect(trigger).not.toHaveAttribute("data-placeholder");
    expect(valueSpan).not.toHaveAttribute("data-placeholder");
  });

  it("shows no text for an empty value, in the placeholder state", () => {
    const { trigger, valueSpan } = renderControl("");
    expect(valueSpan.textContent).toBe("");
    expect(trigger).toHaveAttribute("data-placeholder");
    expect(valueSpan).toHaveAttribute("data-placeholder");
  });
});

describe("SelectControl with a placeholder", () => {
  it("shows the placeholder for an empty value", () => {
    const { trigger, valueSpan } = renderControl("", "Choose a branch");
    expect(valueSpan.textContent).toBe("Choose a branch");
    expect(trigger).toHaveAttribute("data-placeholder");
    expect(valueSpan).toHaveAttribute("data-placeholder");
  });

  it("shows the chosen item's label in place of the placeholder", () => {
    const { trigger, valueSpan } = renderControl("main", "Choose a branch");
    expect(valueSpan.textContent).toBe("main");
    expect(trigger).not.toHaveAttribute("data-placeholder");
    expect(valueSpan).not.toHaveAttribute("data-placeholder");
  });
});
