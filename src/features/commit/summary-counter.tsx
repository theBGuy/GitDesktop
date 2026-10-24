import { WarningIcon } from "@phosphor-icons/react";
import { useId } from "react";
import { cn } from "@/lib/utils";

/** The commit summary's character budget (the guide's "72-character budget indicator"). */
export const SUMMARY_BUDGET = 72;

/**
 * The summary input's half of the counter. Past the budget its gutter widens
 * for the glyph, and it references the counter's words only while over. Callers
 * merge `inputProps.className` with their own classes.
 */
export function useSummaryBudget(length: number) {
  const over = length > SUMMARY_BUDGET;
  const counterId = useId();
  return {
    over,
    counterId,
    inputProps: {
      className: over ? "pr-16" : "pr-12",
      "aria-describedby": over ? counterId : undefined,
    },
  };
}

/**
 * The counter in the summary input's right gutter (render it inside the
 * input's `relative` wrapper): `n/72`, plus a glyph and words for assistive
 * tech once over budget.
 */
export function SummaryCounter({
  length,
  over,
  counterId,
}: {
  length: number;
  over: boolean;
  counterId: string;
}) {
  return (
    <>
      <span
        className={cn(
          "pointer-events-none absolute top-1/2 right-2 inline-flex -translate-y-1/2 items-center gap-0.5 text-[10px] tabular-nums",
          over ? "text-warning" : "text-muted-foreground",
        )}
      >
        {over && <WarningIcon weight="fill" className="size-2.5" aria-hidden />}
        {length > 0 && `${length}/${SUMMARY_BUDGET}`}
      </span>
      {over && (
        <span id={counterId} className="sr-only">
          {`${length} characters, ${length - SUMMARY_BUDGET} over the ${SUMMARY_BUDGET}-character summary budget`}
        </span>
      )}
      {/* Mounted unconditionally: a role="status" announces only text that
          arrives while it is in the DOM, so crossing the budget speaks once
          and later keystrokes, which leave this text unchanged, stay quiet. */}
      <span role="status" className="sr-only">
        {over ? `Summary is over ${SUMMARY_BUDGET} characters` : ""}
      </span>
    </>
  );
}
