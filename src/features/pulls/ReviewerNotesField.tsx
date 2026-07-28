import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { useReviewNote } from "@/lib/review-notes/queries";
import { deleteReviewNote } from "@/lib/review-notes/store";

/** The subset of a `form.AppField` child this field needs: the bound
 *  `MarkdownField` component plus enough of the field api to read the current
 *  value and to imperatively set/clear it. Kept structural so it fits either
 *  Create-PR dialog's differently-typed form. */
interface NotesField {
  MarkdownField: (props: {
    placeholder?: string;
    rows?: number;
    textareaClassName?: string;
  }) => ReactNode;
  state: { value: string };
  handleChange: (value: string) => void;
}

const PLACEHOLDER =
  "Deliberate calls, tradeoffs, and context reviewers should ground against…";

/**
 * The collapsed "Notes for reviewers" disclosure shared by both Create-PR
 * dialogs. Gated on AI being enabled by the caller (rendered only then). Seeds
 * itself from a per-branch note deposit (`useReviewNote`) written earlier — by
 * this app or the MCP server — and auto-expands when it does, so the author sees
 * the recovered context. Seeding NEVER clobbers hand-typed content: it applies a
 * deposit only while the field is pristine (empty, or still exactly the last
 * value we seeded), tracked via `lastSeedRef`. A head-branch switch on a pristine
 * field re-seeds from the new branch's deposit (or clears back to empty when the
 * new branch has none).
 */
export function ReviewerNotesField({
  repoPath,
  head,
  field,
}: {
  repoPath: string;
  /** The live head branch the PR merges — keys the note deposit lookup. */
  head: string | null;
  /** The form's bound `notes` field (from `<form.AppField name="notes">`). */
  field: NotesField;
}) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  // The exact value we last applied from a deposit. While the field still equals
  // this (or is empty), it's "pristine" and safe to re-seed; once the user edits
  // it to anything else, seeding stands down — an effect that re-fires must never
  // override an explicit edit.
  const lastSeedRef = useRef<string | null>(null);
  // The deposit currently reflected in the field, so the provenance line + Clear
  // only show for a prefilled (not hand-typed) value. Cleared the moment the user
  // diverges from the seed.
  const [seededAt, setSeededAt] = useState<string | null>(null);

  const note = useReviewNote(repoPath, head);
  const value = field.state.value;

  // Apply the resolved deposit to the field, but ONLY while pristine (empty, or
  // still exactly the last value we seeded) — never over a hand-typed edit. Read
  // as a non-retriggering effect event so the seed reacts to the deposit/branch,
  // not to every keystroke in `value`.
  const applyDeposit = useEffectEvent(
    (body: string, savedAt: string | null) => {
      const pristine = value === "" || value === lastSeedRef.current;
      if (!pristine) return;
      if (body) {
        if (value !== body) {
          field.handleChange(body);
          lastSeedRef.current = body;
        }
        setSeededAt(savedAt);
        setOpen(true);
      } else if (
        lastSeedRef.current !== null &&
        value === lastSeedRef.current
      ) {
        // Pristine field still showing a prior branch's seed, new branch has no
        // deposit — clear it out.
        field.handleChange("");
        lastSeedRef.current = null;
        setSeededAt(null);
      }
    },
  );

  // Seed whenever a deposit is (or becomes) available. A head-branch switch
  // re-keys `useReviewNote`, so `note.isSuccess`/`note.data` already reflect the
  // new branch — no separate `head` dep needed. `applyDeposit` is a stable
  // effect event, so it's intentionally not a dependency. The pristine guard
  // lives inside `applyDeposit`.
  useEffect(() => {
    if (!note.isSuccess) return;
    applyDeposit(note.data?.body ?? "", note.data?.savedAt ?? null);
  }, [note.isSuccess, note.data?.body, note.data?.savedAt]);

  // Once the user edits away from the seeded value, drop the provenance affordance
  // (it no longer reflects what's in the box).
  useEffect(() => {
    if (seededAt !== null && value !== lastSeedRef.current) {
      setSeededAt(null);
    }
  }, [value, seededAt]);

  function clear() {
    field.handleChange("");
    lastSeedRef.current = null;
    setSeededAt(null);
    setOpen(false);
    // Best-effort: consume the deposit so it won't re-seed. A failure is silent —
    // the note is app-data, not the PR.
    if (head) void deleteReviewNote(repoPath, head).catch(() => undefined);
  }

  return (
    <div className="text-xs">
      <button
        type="button"
        className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? (
          <CaretDownIcon className="size-3" />
        ) : (
          <CaretRightIcon className="size-3" />
        )}
        Notes for reviewers
      </button>
      {open && (
        <div id={regionId} className="mt-2 space-y-1.5">
          <field.MarkdownField
            placeholder={PLACEHOLDER}
            rows={4}
            textareaClassName="ph-no-capture max-h-48 min-h-20 resize-y font-mono"
          />
          {seededAt && (
            <div className="flex items-center justify-between gap-2 text-muted-foreground">
              <span>
                Prefilled from a note saved <RelativeTime date={seededAt} />
              </span>
              <Button type="button" variant="ghost" size="xs" onClick={clear}>
                Clear
              </Button>
            </div>
          )}
          <p className="text-muted-foreground">
            Posted as the first comment when the PR is created and given to the
            AI review as context.
          </p>
        </div>
      )}
    </div>
  );
}
