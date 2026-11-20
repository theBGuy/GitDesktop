import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BoardBulkFieldsDialog } from "@/features/projects/BoardBulkFieldsDialog";
import {
  INVALID_DRAFT,
  NUMBER_RANGE_MESSAGE,
  type ScalarDef,
  ScalarInput,
  scalarDraft,
} from "@/features/projects/ProjectFieldControls";
import type { BoardItem } from "@/lib/git/types";

const NUMBER_DEF: ScalarDef = {
  kind: "number",
  id: "PVTF_points",
  name: "Points",
  isIssueField: false,
};
const TEXT_DEF: ScalarDef = {
  kind: "text",
  id: "PVTF_notes",
  name: "Notes",
  isIssueField: false,
};
const DATE_DEF: ScalarDef = {
  kind: "date",
  id: "PVTF_due",
  name: "Due",
  isIssueField: false,
};

const EXACT_MESSAGE =
  "Out of range: GitHub stores numbers from -2,147,483,647 to 2,147,483,647";

describe("scalarDraft's number bound", () => {
  it.each(["2147483647", "-2147483647", "2147483646.5", "1e-10"])(
    "commits %s as exactly Number(raw)",
    (raw) => {
      const draft = scalarDraft(NUMBER_DEF, raw, false);
      expect(draft).toEqual({
        value: {
          kind: "number",
          fieldId: NUMBER_DEF.id,
          fieldName: NUMBER_DEF.name,
          isIssueField: false,
          number: Number(raw),
        },
        update: { kind: "number", fieldId: NUMBER_DEF.id, number: Number(raw) },
      });
    },
  );

  it.each([
    "2147483647.5",
    "2147483648",
    "-2147483648",
    "9007199254740992",
    "1e400",
  ])("refuses %s", (raw) => {
    expect(scalarDraft(NUMBER_DEF, raw, false)).toBe(INVALID_DRAFT);
  });

  // The bound applies to the parsed number, as in the MCP write tool, so an entry
  // that rounds onto it is accepted and commits the bound itself.
  it("commits 2147483647.00000001 as 2147483647", () => {
    expect(scalarDraft(NUMBER_DEF, "2147483647.00000001", false)).toMatchObject(
      { update: { kind: "number", number: 2147483647 } },
    );
  });

  it("reads whitespace as a clear and badInput as unparseable", () => {
    expect(scalarDraft(NUMBER_DEF, "  ", false)).toBeNull();
    expect(scalarDraft(NUMBER_DEF, "", true)).toBe(INVALID_DRAFT);
  });

  it("leaves text and date fields unbounded", () => {
    expect(scalarDraft(TEXT_DEF, "99999999999", false)).toMatchObject({
      update: { kind: "text", text: "99999999999" },
    });
    expect(scalarDraft(DATE_DEF, "2026-12-15", false)).toMatchObject({
      update: { kind: "date", date: "2026-12-15" },
    });
  });
});

function renderInput(def: ScalarDef) {
  const onEdit = vi.fn();
  render(<ScalarInput id="field" def={def} onEdit={onEdit} />);
  const role = def.kind === "number" ? "spinbutton" : "textbox";
  return { input: screen.getByRole(role), onEdit };
}

describe("ScalarInput's range message", () => {
  it("names the range, marks the input invalid and announces it", async () => {
    const { input } = renderInput(NUMBER_DEF);
    expect(NUMBER_RANGE_MESSAGE).toBe(EXACT_MESSAGE);
    // Mounted with the control, so the message is inserted into a live region
    // assistive tech already watches.
    const live = document.querySelectorAll('[aria-live="polite"]');
    expect(live).toHaveLength(1);
    expect(live[0]).toBeEmptyDOMElement();
    await userEvent.type(input, "3000000000");

    const message = screen.getByText(EXACT_MESSAGE);
    expect(input).toHaveAttribute("aria-invalid", "true");
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    const region = document.getElementById(describedBy ?? "");
    expect(region).toBe(live[0]);
    expect(region).toContainElement(message);
    expect(region).toHaveAttribute("aria-live", "polite");

    await userEvent.clear(input);
    await userEvent.type(input, "2147483647");
    expect(screen.queryByText(EXACT_MESSAGE)).toBeNull();
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).not.toHaveAttribute("aria-describedby");
  });

  it("covers the negative side too", async () => {
    const { input } = renderInput(NUMBER_DEF);
    await userEvent.type(input, "-2147483648");
    expect(screen.getByText(EXACT_MESSAGE)).toBeInTheDocument();
  });

  it("never renders for a text field, nor mounts an empty live region", async () => {
    const { input } = renderInput(TEXT_DEF);
    await userEvent.type(input, "99999999999");
    expect(screen.queryByText(EXACT_MESSAGE)).toBeNull();
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(document.querySelector("[aria-live]")).toBeNull();
  });

  it("stays hidden while the field is locked, even over an out-of-range value", () => {
    const onEdit = vi.fn();
    render(
      <ScalarInput
        id="points"
        def={NUMBER_DEF}
        defaultValue="3000000000"
        lockedReason="You can't edit this field"
        onEdit={onEdit}
      />,
    );
    const input = screen.getByRole("spinbutton");
    expect(input).toHaveValue(3000000000);
    expect(screen.queryByText(EXACT_MESSAGE)).toBeNull();
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).not.toHaveAttribute("aria-describedby");
  });

  it("never renders for a date field", () => {
    const onEdit = vi.fn();
    const { container } = render(
      <ScalarInput id="due" def={DATE_DEF} onEdit={onEdit} />,
    );
    expect(screen.queryByText(EXACT_MESSAGE)).toBeNull();
    expect(container.querySelector("[aria-live]")).toBeNull();
  });
});

const CARD: BoardItem = {
  itemId: "PVTI_1",
  isArchived: false,
  content: {
    kind: "issue",
    id: "I_1",
    number: 7,
    title: "Card one",
    state: "OPEN",
    stateReason: null,
    repoNameWithOwner: "o/r",
    assignees: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    viewerCanSetFields: false,
  },
  fieldValues: [],
  addedAt: "2026-01-01T00:00:00Z",
};

describe("bulk fields dialog, out-of-range number", () => {
  it("holds Apply until the entry is in range, then applies it", async () => {
    const onApply = vi.fn().mockResolvedValue(true);
    render(
      <BoardBulkFieldsDialog
        open
        cards={[CARD]}
        eligibleCount={1}
        fieldDefs={[NUMBER_DEF]}
        defsTruncated={false}
        defsPending={false}
        defsPendingReason=""
        defsError={null}
        onRetryDefs={vi.fn()}
        pending={false}
        heldReason={undefined}
        noun="card"
        onOpenChange={vi.fn()}
        onApply={onApply}
      />,
    );
    await userEvent.click(screen.getByRole("radio", { name: "Set to" }));
    const input = screen.getByRole("spinbutton");
    await userEvent.type(input, "3000000000");

    expect(screen.getByText(EXACT_MESSAGE)).toBeInTheDocument();
    const apply = screen.getByRole("button", { name: /Apply/ });
    expect(apply).toHaveAttribute("aria-disabled", "true");
    expect(screen.getAllByText("Nothing to apply yet").length).toBeGreaterThan(
      0,
    );
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(onApply).not.toHaveBeenCalled();

    await userEvent.clear(input);
    await userEvent.type(input, "2147483647");
    expect(screen.queryByText(EXACT_MESSAGE)).toBeNull();
    expect(apply).not.toHaveAttribute("aria-disabled");
    // The same chord the out-of-range entry held, so its refusal above is the gate's.
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith(
      [{ kind: "number", fieldId: NUMBER_DEF.id, number: 2147483647 }],
      [],
    );
  });
});
