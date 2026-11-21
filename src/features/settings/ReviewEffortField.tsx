import { useId, useState } from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EffortNote } from "@/features/sessions/AgentPickers";
import {
  combineEffortStates,
  effortSelectItems,
  type ReviewEffortTarget,
  useEffortControl,
} from "@/lib/ai/effort-levels";
import { REVIEW_EFFORTS, type ReviewEffort } from "@/lib/ai/review-effort";
import { ARIA_DISABLED_CLASS } from "@/lib/use-disabled-reason";
import { cn } from "@/lib/utils";

/** The Review effort picker's no-level row: this picker spells it as the CLI's
 *  own default. */
const AUTO_ITEM = { key: "auto", label: "Default — the CLI's own setting" };

const isReviewEffort = (v: unknown): v is ReviewEffort =>
  (REVIEW_EFFORTS as readonly unknown[]).includes(v);

/**
 * Settings > AI's Review effort: one setting driving up to two reviewers, so it
 * asks once per target and holds a level only when no reviewer could use it. A
 * renderer of `targets` (derived by `reviewEffortTargets`): it never writes the
 * form on its own, so an answer never dirties the draft, and a stored level the
 * model lacks is kept.
 */
export function ReviewEffortField({
  value,
  onChange,
  targets,
}: {
  value: ReviewEffort;
  onChange: (v: ReviewEffort) => void;
  targets: ReviewEffortTarget[];
}) {
  const sent = value === "auto" ? "" : value;
  // Two fixed calls: hooks can't run in a loop over the 0-2 targets.
  const first = useEffortControl(targets[0]?.inputs ?? null, sent);
  const second = useEffortControl(targets[1]?.inputs ?? null, sent);
  const control = combineEffortStates(
    targets.map((t, i) => ({
      label: t.label,
      state: i === 0 ? first : second,
    })),
  );
  const items = effortSelectItems(AUTO_ITEM, control);
  const held = control.allBlocked;
  const noteId = useId();
  // Held by readOnly + a gated open state, never Base UI's `disabled`: that sets
  // the trigger's tabIndex to -1, taking the picker and its reason out of reach.
  const [open, setOpen] = useState(false);
  if (held && open) setOpen(false);
  const blockedOf = (level: string) =>
    control.blocked[level === "auto" ? "" : level];

  return (
    <div className="space-y-2">
      <Label htmlFor="review-effort">Review effort</Label>
      <Select
        items={items}
        value={value}
        // Defense in depth: Base UI also commits through paths with no disabled
        // check (its hidden-input autofill), so a blocked level is refused here.
        onValueChange={(v) => {
          if (!isReviewEffort(v) || v === value || blockedOf(v) !== undefined) {
            return;
          }
          onChange(v);
        }}
        readOnly={held}
        open={open}
        onOpenChange={(next) => {
          if (!held) setOpen(next);
        }}
      >
        <SelectTrigger
          id="review-effort"
          className={cn("w-full", ARIA_DISABLED_CLASS)}
          aria-disabled={held || undefined}
          aria-describedby={control.line ? noteId : undefined}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {REVIEW_EFFORTS.map((id) => (
            <SelectItem
              key={id}
              value={id}
              disabled={blockedOf(id) !== undefined}
            >
              {items[id]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <EffortNote id={noteId} line={control.line} />
      <p className="text-xs text-muted-foreground">
        How hard the reviewing agent thinks, for reviews and security audits
        alike. Lower is a quicker, lighter pass; Codex and the API providers
        always run at their own defaults.
      </p>
    </div>
  );
}
