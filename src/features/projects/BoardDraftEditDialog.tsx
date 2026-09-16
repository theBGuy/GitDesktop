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

/** The edit's single-flight hold, in the board's own "Finishing…" register so this
 *  footer and the pending strip behind it name the same wait. */
const EDIT_PENDING_REASON = "Finishing your last card change…";

/**
 * Rewrite one DRAFT card: its title, its Markdown notes, and who it's assigned to.
 * The assignees REPLACE the draft's set, which is what the write itself does.
 *
 * Every starting value arrives as a prop, seeded by the panel at the moment the menu
 * row was clicked. This component holds no session of its own: it stays mounted
 * across open and close, and `<Activity>` replays effect setups on show, so anything
 * it worked out for itself would either churn on a tab switch or describe the card
 * the user opened two edits ago.
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
   *  either way; `onSubmit` awaits it, which drives the submit button's spinner. */
  onSave: (
    title: string,
    body: string,
    assigneeLogins: string[],
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
    onSubmit: ({ value }) =>
      onSave(
        value.title.trim(),
        value.body,
        assignees.map((user) => user.id),
      ),
  });
  // Held rather than hidden, and explained where the user is looking. The submit
  // chord's hint rides the same wrapper, which is what keeps the reason from being
  // overwritten by it while held.
  const { blockedReason, reasonId, wrapperTitle, describedBy } =
    useDisabledReason({
      disabled: pending,
      reason: EDIT_PENDING_REASON,
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
