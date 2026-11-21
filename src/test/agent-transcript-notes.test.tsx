import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { AgentTranscript } from "@/features/sessions/AgentTranscript";
import type { TranscriptSegment } from "@/lib/ai/agent";
import { unmockedCommands } from "./setup";

const RESET =
  "GitDesktop could not continue the earlier opencode conversation, so this turn started a new one. The agent does not remember the earlier turns.";

function wrap({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const show = (segments: TranscriptSegment[]) =>
  render(
    <AgentTranscript segments={segments} baseDir="/repo" fileLinks={false} />,
    { wrapper: wrap },
  );

describe("AgentTranscript note rows", () => {
  it("shows a note's sentence as plain text between the other segments", () => {
    const { container } = show([
      { type: "text", text: "Before the note." },
      { type: "note", text: RESET },
      { type: "tool", tool: "run", target: "pnpm build" },
      { type: "text", text: "After the note." },
    ]);
    const note = screen.getByText(RESET);
    expect(note.tagName).toBe("SPAN");
    // A note is a calm static row: nothing to press, no hover text, not announced.
    const row = note.parentElement as HTMLElement;
    expect(row.querySelector("button")).toBeNull();
    expect(row.hasAttribute("title")).toBe(false);
    expect(row.closest("[aria-live]")).toBeNull();
    expect(row.querySelector("[role]")).toBeNull();

    const text = container.textContent ?? "";
    const order = [
      "Before the note.",
      RESET,
      "pnpm build",
      "After the note.",
    ].map((s) => text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(unmockedCommands).toEqual([]);
  });

  it("renders nothing for a blank or non-string note read back from disk", () => {
    const { container } = show([
      { type: "text", text: "Prose." },
      { type: "note", text: "   " },
      { type: "note", text: 42 as unknown as string },
      { type: "note" } as unknown as TranscriptSegment,
    ]);
    const rows = container.firstElementChild?.children ?? [];
    expect(rows.length).toBe(1);
    expect(screen.getByText("Prose.")).toBeTruthy();
  });

  it("keeps markup in a note as literal text", () => {
    show([{ type: "note", text: "**not bold** <b>x</b>" }]);
    expect(screen.getByText("**not bold** <b>x</b>")).toBeTruthy();
  });
});
