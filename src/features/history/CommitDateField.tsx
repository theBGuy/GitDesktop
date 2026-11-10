import { CalendarBlankIcon, WarningCircleIcon } from "@phosphor-icons/react";
import {
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CommitDate } from "@/lib/git/types";
import { formatRelativeTime } from "@/lib/time";
import { ARIA_DISABLED_CLASS } from "@/lib/use-disabled-reason";
import { cn } from "@/lib/utils";
import {
  describeCommitDate,
  formatCommitDate,
  nowCommitDate,
  readCommitDate,
  withPickedDate,
  withPickedTime,
} from "./commit-date";

/** Whether this webview renders native date and time inputs: an unsupported
 *  type reads back as "text". A member of an object, so a test can stub it. */
export const nativePickers = {
  supported(): boolean {
    if (typeof document === "undefined") return false;
    const probe = (type: string) => {
      const el = document.createElement("input");
      el.setAttribute("type", type);
      return el.type === type;
    };
    return probe("date") && probe("time");
  },
};

/**
 * One typed commit date: canonical text in, lenient text accepted, rewritten to
 * canonical on blur. The line under it is the error or how the text reads.
 * While `heldReason` is set every control stays rendered and focusable but
 * inert, so a rewrite starting never strands focus in a field.
 */
export function CommitDateField({
  label,
  value,
  onChange,
  original,
  date,
  error,
  nowMs,
  offsetNote = "the commit's current offset",
  note,
  heldReason,
  onReset,
  reserveReset = false,
  trailing,
}: {
  label: string;
  value: string;
  onChange: (text: string) => void;
  /** The value the field falls back to: its offset fills an omitted one, and
   *  the picker starts from it while the text is in error. */
  original: CommitDate;
  /** The field's current value, null while in error. */
  date: CommitDate | null;
  error: string | null;
  nowMs: number;
  /** What the "Reads as" line names when the offset was left out. */
  offsetNote?: string;
  /** A secondary line under the reading. */
  note?: string | null;
  heldReason: string | null;
  /** No prop, no Reset button. */
  onReset?: () => void;
  /** Keeps an empty Reset-wide slot where this field has no Reset, so its
   *  input lines up with a field above it that has one. */
  reserveReset?: boolean;
  /** Rendered after Now in place of Reset. */
  trailing?: ReactNode;
}) {
  const inputId = useId();
  const lineId = useId();
  const reasonId = useId();
  const pickerId = useId();
  const [canPick] = useState(() => nativePickers.supported());
  const [pickerOpen, setPickerOpen] = useState(false);
  const dateInputRef = useRef<HTMLInputElement>(null);
  const revealPending = useRef(false);
  const held = heldReason !== null;

  // Revealing the row opens the date picker where the engine allows it; a
  // throw (no user activation) or a missing method leaves the inputs on screen.
  useLayoutEffect(() => {
    if (!pickerOpen || !revealPending.current) return;
    revealPending.current = false;
    const el = dateInputRef.current;
    if (el === null || typeof el.showPicker !== "function") return;
    try {
      el.showPicker();
    } catch {
      // The two inputs stay rendered: they are the fallback.
    }
  }, [pickerOpen]);

  const read = readCommitDate(value, original.offsetMinutes);
  const assumed = error === null && read.ok && read.offsetAssumed;
  // The picker edits whatever the field holds now, else the original value.
  const base = date ?? original;
  const canonicalBase = formatCommitDate(base);

  function pick(next: CommitDate | null) {
    if (next !== null) onChange(formatCommitDate(next));
  }

  const line = (() => {
    if (error !== null) {
      return (
        <span className="flex items-start gap-1 text-destructive">
          <WarningCircleIcon aria-hidden className="mt-px size-3 shrink-0" />
          {error}
        </span>
      );
    }
    if (date === null) return null;
    const relative = formatRelativeTime(
      new Date(date.epochSeconds * 1000).toISOString(),
      nowMs,
    );
    const offsetPart = assumed ? ` (${offsetNote})` : "";
    return (
      <span className="text-muted-foreground">
        Reads as {describeCommitDate(date)}
        {offsetPart} · {relative}
      </span>
    );
  })();

  return (
    <div className="@container/date-field space-y-1">
      <div className="flex items-center gap-2">
        <Label htmlFor={inputId} className="w-28 shrink-0 text-xs font-normal">
          {label}
        </Label>
        {/* Where the row has room, the input never narrows below a whole
            canonical date (25 characters at the input's font, plus padding),
            so the value never opens scrolled; a narrower host, such as Edit
            history's inline editor at the window's minimum width, lets it
            shrink instead, so the buttons never clip. A trailing action is
            wider than Reset, so that row needs more room for the floor. */}
        <span
          className={cn(
            "min-w-0 flex-1 font-mono text-xs",
            trailing === undefined
              ? "@min-[30rem]/date-field:min-w-[calc(25ch+1.5rem)]"
              : "@min-[33rem]/date-field:min-w-[calc(25ch+1.5rem)]",
            held && "cursor-not-allowed",
          )}
          title={heldReason ?? undefined}
        >
          <Input
            id={inputId}
            value={value}
            spellCheck={false}
            autoComplete="off"
            readOnly={held}
            aria-disabled={held || undefined}
            aria-invalid={error !== null || undefined}
            aria-describedby={held ? `${lineId} ${reasonId}` : lineId}
            className={cn(
              ARIA_DISABLED_CLASS,
              "h-7 font-mono text-xs tabular-nums",
            )}
            onChange={(e) => onChange(e.target.value)}
            onBlur={() => {
              const r = readCommitDate(value, original.offsetMinutes);
              if (!r.ok) return;
              const canonical = formatCommitDate(r.date);
              if (canonical !== value) onChange(canonical);
            }}
          />
        </span>
        {canPick && (
          <DisabledReasonButton
            type="button"
            variant="outline"
            size="icon-xs"
            className="shrink-0"
            aria-label={`Pick the ${label.toLowerCase()} with the calendar`}
            aria-expanded={pickerOpen}
            aria-controls={pickerOpen ? pickerId : undefined}
            disabled={held}
            reason={heldReason}
            onClick={() => {
              revealPending.current = !pickerOpen;
              setPickerOpen((o) => !o);
            }}
          >
            <CalendarBlankIcon />
          </DisabledReasonButton>
        )}
        <DisabledReasonButton
          type="button"
          variant="ghost"
          size="xs"
          className="shrink-0"
          disabled={held}
          reason={heldReason}
          onClick={() =>
            onChange(
              formatCommitDate(
                nowCommitDate(Date.now(), -new Date().getTimezoneOffset()),
              ),
            )
          }
        >
          Now
        </DisabledReasonButton>
        {onReset !== undefined ? (
          <DisabledReasonButton
            type="button"
            variant="ghost"
            size="xs"
            className="shrink-0"
            disabled={held}
            reason={heldReason}
            onClick={onReset}
          >
            Reset
          </DisabledReasonButton>
        ) : (
          reserveReset && (
            <span
              aria-hidden
              className={cn(
                buttonVariants({ variant: "ghost", size: "xs" }),
                "invisible shrink-0",
              )}
            >
              Reset
            </span>
          )
        )}
        {trailing}
      </div>
      {canPick && pickerOpen && (
        <div id={pickerId} className="flex flex-wrap items-center gap-2 pl-30">
          <Input
            ref={dateInputRef}
            type="date"
            min="1970-01-01"
            max="2099-12-31"
            aria-label={`${label}, calendar date`}
            value={canonicalBase.slice(0, 10)}
            readOnly={held}
            aria-disabled={held || undefined}
            className={cn(ARIA_DISABLED_CLASS, "h-7 w-auto text-xs")}
            onChange={(e) => {
              // A cleared native input reports "", which picks nothing.
              if (e.target.value !== "")
                pick(withPickedDate(base, e.target.value));
            }}
          />
          <Input
            type="time"
            step={1}
            aria-label={`${label}, time`}
            value={canonicalBase.slice(11, 19)}
            readOnly={held}
            aria-disabled={held || undefined}
            className={cn(ARIA_DISABLED_CLASS, "h-7 w-auto text-xs")}
            onChange={(e) => {
              if (e.target.value !== "")
                pick(withPickedTime(base, e.target.value));
            }}
          />
        </div>
      )}
      <p id={lineId} className="pl-30 text-[11px]">
        {line}
      </p>
      {note ? (
        <p className="pl-30 text-[11px] text-muted-foreground">{note}</p>
      ) : null}
      {held && (
        <span id={reasonId} className="sr-only">
          {heldReason}
        </span>
      )}
    </div>
  );
}

/** "Same as author date", captioned in the label column while ticked;
 *  unticked, the committer field below carries that caption. */
export function SameAsAuthorCheckbox({
  checked,
  onChange,
  heldReason,
}: {
  checked: boolean;
  onChange: (same: boolean) => void;
  heldReason: string | null;
}) {
  const id = useId();
  const reasonId = useId();
  const held = heldReason !== null;
  return (
    <div
      className={cn("flex items-center gap-2", held && "cursor-not-allowed")}
      title={heldReason ?? undefined}
    >
      <span aria-hidden className="w-28 shrink-0 text-xs">
        {checked ? "Committer date" : ""}
      </span>
      <Checkbox
        id={id}
        checked={checked}
        readOnly={held}
        aria-disabled={held || undefined}
        aria-label="Same as author date (committer date)"
        aria-describedby={held ? reasonId : undefined}
        onCheckedChange={(c) => {
          if (!held) onChange(c === true);
        }}
      />
      {/* The visible caption comes and goes with the tick, so the checkbox's
          own name says which date it sets. */}
      <Label htmlFor={id} className="text-xs font-normal">
        Same as author date
      </Label>
      {held && (
        <span id={reasonId} className="sr-only">
          {heldReason}
        </span>
      )}
    </div>
  );
}
