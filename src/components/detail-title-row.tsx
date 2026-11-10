import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A PR or issue detail header's title row: the title, then every header action
 *  and state badge in one group beside the title's first line, right-aligned, that
 *  wraps below it as one unit when the row is too narrow. */
export function DetailTitleRow({
  heading,
  headingAs: Heading = "h2",
  headingClassName,
  children,
}: {
  /** The heading's content: text plus the #number or key span. */
  heading: ReactNode;
  /** `div` while a loading frame's heading holds only its skeleton (the PR and issue
   *  loading frames); `h2` otherwise (default). */
  headingAs?: "h2" | "div";
  /** View-owned classes merged after the layout classes (Jira's fade). */
  headingClassName?: string;
  /** Every header action and state badge, in display order. */
  children?: ReactNode;
}) {
  // The title's 12.5rem basis is the width it keeps beside the actions: once title,
  // gap and group overflow the row the group wraps below as one right-aligned unit,
  // and alone and still too wide it wraps inside itself.
  return (
    <div
      data-slot="detail-title-row"
      className="flex flex-wrap items-start gap-2"
    >
      <Heading
        data-slot="detail-title"
        className={cn(
          "min-w-0 flex-[1_1_12.5rem] text-sm font-medium break-words",
          headingClassName,
        )}
      >
        {heading}
      </Heading>
      <div
        data-slot="detail-title-actions"
        className="ml-auto flex min-w-0 flex-initial flex-wrap items-center justify-end gap-2 empty:hidden"
      >
        {children}
      </div>
    </div>
  );
}
