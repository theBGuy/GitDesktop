import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AssigneesPopover } from "@/features/issues/IssueMetaPickers";
import { required, useAppForm } from "@/lib/form";
import type { ForgeUserRef, RemoteLens } from "@/lib/git/types";
import { SUBMIT_HINT } from "@/lib/hotkeys/binding";
import {
  ARIA_DISABLED_CLASS,
  useDisabledReason,
} from "@/lib/use-disabled-reason";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import { cn } from "@/lib/utils";
import { CARD_WRITE_REASON } from "./board-model";

/** Whether two login lists name the same people, order ignored. Set-equality rather
 *  than a dirty flag so opening the picker and closing it unchanged still counts as
 *  untouched — what matters is whether the SET moved, not whether it was visited. */
function sameLoginSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const held = new Set(a);
  return b.every((login) => held.has(login));
}

/**
 * Rewrite one DRAFT card: title, Markdown notes, and assignees, which REPLACE the
 * draft's set rather than adding to it.
 *
 * Every starting value arrives as a prop the panel seeded at the menu click: this
 * dialog stays mounted across open and close and `<Activity>` replays its effect
 * setups on show, so a value it derived for itself would describe an earlier card.
 */
export function BoardDraftEditDialog({
  repoPath,
  lens,
  open,
  pending,
  seedTitle,
  seedBody,
  seedAssigneeLogins,
  onOpenChange,
  onSave,
}: {
  repoPath: string;
  /** The fork/upstream lens the board was read under — which repo's collaborators
   *  the assignee picker offers. */
  lens: RemoteLens;
  open: boolean;
  /** A card write is in flight for this repo's boards — from THIS run or one the
   *  user closed over. Single-flight, the contract every card row keeps: this
   *  dialog outlives its own submissions, so its form can't be what knows one is
   *  still going. */
  pending: boolean;
  seedTitle: string;
  seedBody: string;
  /** The draft's current assignees as LOGINS, which is the id space the assignable
   *  users surface answers in on GitHub — so a seeded chip and a picked one compare
   *  as the same person. */
  seedAssigneeLogins: string[];
  onOpenChange: (open: boolean) => void;
  /** Write the edit. The panel owns it — so the board can report a write this
   *  dialog was closed over, and so the CLOSE on success is decided by whoever knows
   *  whether this run is still the one on screen. Resolves when the write settles
   *  either way; `onSubmit` awaits it, which drives the submit button's spinner.
   *
   *  `assigneeLogins` is `undefined` when the user didn't change the picker, which
   *  is what stops the write touching assignees at all. */
  onSave: (
    title: string,
    body: string,
    assigneeLogins: string[] | undefined,
  ) => Promise<void>;
}) {
  // Beside the form rather than in it: the picker deals in whole user records and
  // the form's fields are the two text ones. The write sends the IDS, which on
  // GitHub are the logins.
  const [assignees, setAssignees] = useState<ForgeUserRef[]>([]);
  const form = useAppForm({
    defaultValues: { title: "", body: "" },
    // Awaited but not acted on: the panel owns both outcomes — it closes this dialog
    // on success (and only if the run that submitted is still the one on screen),
    // and leaves it open on failure, where the edit still is.
    onSubmit: ({ value }) => {
      const picked = assignees.map((user) => user.id);
      // An UNCHANGED set sends `undefined`, never the seed back again. The seed is
      // read through a capped `assignees(first:N)` selection, so a draft with more
      // assignees than the cap arrives here already truncated — and replacing the
      // set with that truncation is how a title-only edit would delete the people it
      // never showed. Only a set the user actually moved is worth sending.
      const touched = !sameLoginSet(picked, seedAssigneeLogins);
      return onSave(
        value.title.trim(),
        value.body,
        touched ? picked : undefined,
      );
    },
  });
  // Held rather than hidden, and explained where the user is looking. The reason is
  // the board's shared one rather than a copy spelled here, so this footer and the
  // strip behind it can't drift apart. The submit chord's hint rides the same
  // wrapper, which keeps the reason from being overwritten by it while held.
  const { blockedReason, reasonId, wrapperTitle, describedBy } =
    useDisabledReason({
      disabled: pending,
      reason: CARD_WRITE_REASON,
      title: SUBMIT_HINT,
    });

  // keepDefaultValues: otherwise the per-render options sync clobbers the reset
  // values back to empty on an untouched form. The avatar URL is left empty on
  // purpose — `ForgeUserAvatar` derives GitHub's from the login, which is all a
  // seeded chip carries.
  useSeedOnOpen(open, () => {
    form.reset(
      { title: seedTitle, body: seedBody },
      { keepDefaultValues: true },
    );
    setAssignees(
      seedAssigneeLogins.map((login) => ({
        id: login,
        label: login,
        avatarUrl: "",
        isBot: false,
      })),
    );
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] flex-col sm:max-w-2xl"
        // mod+enter submits from anywhere in the dialog, the Notes textarea
        // included. Captured on DialogContent (the Popup) rather than the <form>:
        // the X close renders as a SIBLING of the form inside the Popup, so a chord
        // pressed with focus on X would bypass a form-level handler and reach the
        // global mod+enter action. ALWAYS swallow the chord here; submit only under
        // the gate the button takes.
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            if (!pending) form.handleSubmit();
          }
        }}
      >
        <form
          className="flex min-h-0 min-w-0 flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            // The same gate the button takes, so Enter can't walk around it.
            if (pending) return;
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Edit draft</DialogTitle>
            <DialogDescription>
              Changes the note on the board. Drafts live on the project alone,
              so nothing outside it changes.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            <form.AppField
              name="title"
              validators={{ onChange: ({ value }) => required(value) }}
            >
              {(field) => (
                <field.TextField label="Title" placeholder="Name the note" />
              )}
            </form.AppField>
            <form.AppField name="body">
              {(field) => (
                <field.MarkdownField
                  label="Notes"
                  placeholder="Markdown, rendered on the card"
                  rows={8}
                  textareaClassName="max-h-72 min-h-24 resize-y font-mono"
                />
              )}
            </form.AppField>
            {/* `enabled` on the dialog being open: the panel lives under
                `<Activity>`, which defers a hidden tab's effects but not its
                queries, so a closed dialog must not keep the collaborator read
                alive behind the board. */}
            <AssigneesPopover
              repoPath={repoPath}
              enabled={open}
              value={assignees}
              lens={lens}
              onChange={setAssignees}
            />
          </div>
          <DialogFooter>
            {blockedReason !== null && (
              <span
                id={reasonId}
                className="mr-auto self-center text-[11px] text-muted-foreground"
              >
                {blockedReason}
              </span>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <form.AppForm>
              {/* The reasoned hold keeps the button FOCUSABLE — a natively-disabled
                  control leaves the tab order, and a description nothing can reach
                  explains nothing. `focusableWhenDisabled` rides `blockedReason`
                  alone, so the plain `!canSubmit || isSubmitting` disable that
                  `SubmitButton` ORs in stays a native one: there is no reason to
                  announce for an empty title. Activation is refused by the Button's
                  own handler layer and again by the form's `pending` guard. */}
              <span
                className={cn(
                  "inline-flex",
                  blockedReason && "cursor-not-allowed",
                )}
                title={wrapperTitle}
              >
                <form.SubmitButton
                  focusableWhenDisabled={!!blockedReason}
                  disabled={pending}
                  aria-describedby={describedBy}
                  className={ARIA_DISABLED_CLASS}
                >
                  Save draft
                </form.SubmitButton>
              </span>
            </form.AppForm>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
