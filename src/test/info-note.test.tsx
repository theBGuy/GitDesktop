import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InfoNote } from "@/components/info-note";

const BASE =
  "flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground";

function renderNote(reserve?: boolean) {
  const { container } = render(
    <InfoNote
      reserve={reserve}
      action={<button type="button">Don't show again</button>}
    >
      Select cards with a modifier click.
    </InfoNote>,
  );
  const root = container.firstElementChild as HTMLElement;
  return { container, root };
}

describe("InfoNote", () => {
  it("renders the live strip unchanged by default", () => {
    const { container, root } = renderNote();

    expect(root.getAttribute("aria-hidden")).toBeNull();
    expect(root.getAttribute("class")).toBe(BASE);
    expect(container.querySelector("svg")?.getAttribute("class")).toBe(
      "size-3.5 shrink-0",
    );
    expect(container.querySelector(".invisible")).toBeNull();
    const button = screen.getByRole("button", { name: "Don't show again" });
    expect(button.parentElement).toBe(root);
  });

  it("reserves the strip invisible and out of the a11y tree", () => {
    const { container, root } = renderNote(true);

    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(root.classList.contains("invisible")).toBe(false);
    expect(screen.queryByRole("button")).toBeNull();
    expect(
      container.querySelector("svg")?.classList.contains("invisible"),
    ).toBe(true);
    const text = screen.getByText("Select cards with a modifier click.");
    expect(text.classList.contains("invisible")).toBe(true);
    const wrapper = container.querySelector("button")?.parentElement;
    expect(wrapper).not.toBe(root);
    expect(wrapper?.classList.contains("invisible")).toBe(true);
    expect(wrapper?.classList.contains("contents")).toBe(true);
  });

  it("keeps the reserved text in the DOM so its wrapped height holds", () => {
    renderNote(true);

    expect(
      screen.getByText("Select cards with a modifier click."),
    ).toBeInTheDocument();
  });
});
