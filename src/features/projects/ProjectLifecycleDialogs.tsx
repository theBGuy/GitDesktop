import { useSelector } from "@tanstack/react-store";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useState,
} from "react";
import { LabeledGroup } from "@/components/form/labeled-group";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { clipTitleFromText } from "@/lib/clip-title";
import { required, useAppForm } from "@/lib/form";
import type {
  ProjectFieldDef,
  ProjectPatch,
  ProjectViewLayout,
} from "@/lib/git/types";
import { eventToBinding, SUBMIT_HINT } from "@/lib/hotkeys/binding";
import {
  ARIA_DISABLED_CLASS,
  useDisabledReason,
} from "@/lib/use-disabled-reason";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import { cn } from "@/lib/utils";
import { isTitleDef, nextVisibleFieldIds } from "./board-model";

/** The layouts a view can be created or saved in, in GitHub's own order. */
export const VIEW_LAYOUTS: readonly ProjectViewLayout[] = [
  "table",
  "board",
  "roadmap",
];
export const VIEW_LAYOUT_LABEL: Record<ProjectViewLayout, string> = {
  table: "Table",
  board: "Board",
  roadmap: "Roadmap",
};

const SAVING_REASON = "Saving…";

/**
 * The footer every dialog here shares: a held reason on the left, Cancel, and the
 * submit. The reasoned hold keeps the submit FOCUSABLE, the contract
 * BoardDraftEditDialog documents; the plain empty-field disable `SubmitButton`
 * ORs in stays a native one.
 */
function HeldFooter({
  heldReason,
  onCancel,
  submit,
}: {
  heldReason: string | null;
  onCancel: () => void;
  submit: (props: {
    focusableWhenDisabled: boolean;
    disabled: boolean;
    "aria-describedby": string | undefined;
    className: string;
  }) => ReactNode;
}) {
  const { blockedReason, reasonId, wrapperTitle, describedBy } =
    useDisabledReason({
      disabled: heldReason !== null,
      reason: heldReason,
      title: SUBMIT_HINT,
    });
  return (
    <DialogFooter>
      {blockedReason !== null && (
        <span
          id={reasonId}
          className="mr-auto self-center text-[11px] text-muted-foreground"
        >
          {blockedReason}
        </span>
      )}
      <Button type="button" variant="outline" onClick={onCancel}>
        Cancel
      </Button>
      <span
        className={cn("inline-flex", blockedReason && "cursor-not-allowed")}
        title={wrapperTitle}
      >
        {submit({
          focusableWhenDisabled: !!blockedReason,
          disabled: heldReason !== null,
          "aria-describedby": describedBy,
          className: ARIA_DISABLED_CLASS,
        })}
      </span>
    </DialogFooter>
  );
}

/**
 * The submit wiring every dialog here shares: mod+enter from anywhere in the
 * dialog, and the form's own submit (Enter in a field), both refused while the
 * footer's hold stands. The chord rides DialogContent rather than the <form>:
 * the X close is the form's SIBLING, so a form-level handler would miss the
 * chord pressed there.
 */
function heldSubmitHandlers(
  form: { handleSubmit: () => unknown },
  heldReason: string | null,
) {
  return {
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (eventToBinding(e) !== "mod+enter") return;
      e.preventDefault();
      if (heldReason === null) form.handleSubmit();
    },
    onSubmit: (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (heldReason !== null) return;
      form.handleSubmit();
    },
  };
}

/**
 * A new project, created under the catalog's owner and linked to this repository
 * when the catalog could read it; the description names which, so the dialog
 * never promises a link the write won't make. Title only, as GitHub's own create
 * asks: the description is one Edit details away once the board exists.
 *
 * `onCreate` owns both outcomes: it closes the dialog on success, only if this
 * run is still the one on screen, and leaves it open on failure.
 */
export function NewProjectDialog({
  open,
  pending,
  target,
  ownerHeldReason,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  /** A project write is in flight — from this run or one the user closed over. */
  pending: boolean;
  /** Where the project lands: the repository it's linked to (null when the
   *  catalog couldn't read it, so the create is unlinked) and the account it's
   *  created under, by the names the catalog read with their ids. */
  target: { repository: string | null; owner: string | null };
  /** Why no owner is known to create the project under (the catalog lost it
   *  while the dialog was open), or undefined when one is. */
  ownerHeldReason: string | undefined;
  onOpenChange: (open: boolean) => void;
  onCreate: (title: string) => Promise<void>;
}) {
  const form = useAppForm({
    defaultValues: { title: "" },
    onSubmit: ({ value }) => onCreate(value.title.trim()),
  });
  const submitting = useSelector(form.store, (s) => s.isSubmitting);
  // keepDefaultValues: otherwise the per-render options sync clobbers the reset
  // values back to empty on an untouched form.
  useSeedOnOpen(open, () =>
    form.reset({ title: "" }, { keepDefaultValues: true }),
  );
  const heldReason =
    pending || submitting ? SAVING_REASON : (ownerHeldReason ?? null);
  const submit = heldSubmitHandlers(form, heldReason);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" onKeyDown={submit.onKeyDown}>
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={submit.onSubmit}
        >
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              {target.repository !== null
                ? `Linked to ${target.repository}, starting with a table view you can build on.`
                : `Created under ${target.owner ?? "the repository owner"}'s account and not linked to this repository, which couldn't be read.`}
            </DialogDescription>
          </DialogHeader>
          <form.AppField
            name="title"
            validators={{ onChange: ({ value }) => required(value) }}
          >
            {(field) => (
              <field.TextField
                label="Title"
                placeholder="Name the project"
                autoFocus
              />
            )}
          </form.AppField>
          <form.AppForm>
            <HeldFooter
              heldReason={heldReason}
              onCancel={() => onOpenChange(false)}
              submit={(props) => (
                <form.SubmitButton {...props}>Create project</form.SubmitButton>
              )}
            />
          </form.AppForm>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A project's title and short description. Seeded from the project at the open
 * transition; only the details that changed are written, so an edit never
 * rewrites a field the user didn't touch.
 */
export function EditProjectDialog({
  open,
  pending,
  seedTitle,
  seedDescription,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  pending: boolean;
  seedTitle: string;
  seedDescription: string;
  onOpenChange: (open: boolean) => void;
  onSave: (patch: ProjectPatch) => Promise<void>;
}) {
  const form = useAppForm({
    defaultValues: { title: "", description: "" },
    onSubmit: ({ value }) => {
      const patch: ProjectPatch = {};
      const title = value.title.trim();
      const description = value.description.trim();
      if (title !== seedTitle) patch.title = title;
      if (description !== seedDescription) patch.shortDescription = description;
      return onSave(patch);
    },
  });
  const submitting = useSelector(form.store, (s) => s.isSubmitting);
  const unchanged = useSelector(
    form.store,
    (s) =>
      s.values.title.trim() === seedTitle &&
      s.values.description.trim() === seedDescription,
  );
  useSeedOnOpen(open, () =>
    form.reset(
      { title: seedTitle, description: seedDescription },
      { keepDefaultValues: true },
    ),
  );
  const heldReason = (() => {
    switch (true) {
      case pending || submitting:
        return SAVING_REASON;
      case unchanged:
        return "Change the title or description to save";
      default:
        return null;
    }
  })();
  const submit = heldSubmitHandlers(form, heldReason);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" onKeyDown={submit.onKeyDown}>
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={submit.onSubmit}
        >
          <DialogHeader>
            <DialogTitle>Edit project details</DialogTitle>
            <DialogDescription>
              Changes the project for everyone who can see it.
            </DialogDescription>
          </DialogHeader>
          <form.AppField
            name="title"
            validators={{ onChange: ({ value }) => required(value) }}
          >
            {(field) => <field.TextField label="Title" autoFocus />}
          </form.AppField>
          <form.AppField name="description">
            {(field) => (
              <field.TextField
                label="Short description"
                placeholder="What the project is for, in a line"
              />
            )}
          </form.AppField>
          <form.AppForm>
            <HeldFooter
              heldReason={heldReason}
              onCancel={() => onOpenChange(false)}
              submit={(props) => (
                <form.SubmitButton {...props}>Save details</form.SubmitButton>
              )}
            />
          </form.AppForm>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A new saved view (name and layout), or a rename of one (name alone). One
 * dialog for both, as the status update editor is: the mode rides a prop the
 * panel keeps through the close, so the title doesn't flip mid-animation.
 */
export function ViewNameDialog({
  mode,
  open,
  pending,
  seedName,
  onOpenChange,
  onSubmit,
}: {
  mode: "create" | "rename";
  open: boolean;
  pending: boolean;
  seedName: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string, layout: ProjectViewLayout) => Promise<void>;
}) {
  const [layout, setLayout] = useState<ProjectViewLayout>("table");
  const form = useAppForm({
    defaultValues: { name: "" },
    onSubmit: ({ value }) => onSubmit(value.name.trim(), layout),
  });
  const submitting = useSelector(form.store, (s) => s.isSubmitting);
  const unchanged = useSelector(
    form.store,
    (s) => mode === "rename" && s.values.name.trim() === seedName,
  );
  useSeedOnOpen(open, () => {
    form.reset({ name: seedName }, { keepDefaultValues: true });
    setLayout("table");
  });
  const heldReason = (() => {
    switch (true) {
      case pending || submitting:
        return SAVING_REASON;
      case unchanged:
        return "Change the name to save";
      default:
        return null;
    }
  })();
  const submit = heldSubmitHandlers(form, heldReason);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" onKeyDown={submit.onKeyDown}>
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={submit.onSubmit}
        >
          <DialogHeader>
            <DialogTitle>
              {mode === "create" ? "New view" : "Rename view"}
            </DialogTitle>
            <DialogDescription>
              {mode === "create"
                ? "A saved view everyone on the project can pick. It starts with no filter."
                : "Renames the view for everyone on the project."}
            </DialogDescription>
          </DialogHeader>
          <form.AppField
            name="name"
            validators={{ onChange: ({ value }) => required(value) }}
          >
            {(field) => (
              <field.TextField
                label="Name"
                placeholder="Name the view"
                autoFocus
              />
            )}
          </form.AppField>
          {mode === "create" && (
            <LabeledGroup label="Layout">
              <RadioGroup
                className="gap-1"
                value={layout}
                onValueChange={(next) => {
                  const picked = VIEW_LAYOUTS.find((l) => l === next);
                  if (picked !== undefined) setLayout(picked);
                }}
              >
                {VIEW_LAYOUTS.map((l) => (
                  <label
                    key={l}
                    className="flex cursor-pointer items-center gap-2 text-xs"
                  >
                    <Radio value={l} />
                    {VIEW_LAYOUT_LABEL[l]}
                  </label>
                ))}
              </RadioGroup>
            </LabeledGroup>
          )}
          <form.AppForm>
            <HeldFooter
              heldReason={heldReason}
              onCancel={() => onOpenChange(false)}
              submit={(props) => (
                <form.SubmitButton {...props}>
                  {mode === "create" ? "Create view" : "Rename view"}
                </form.SubmitButton>
              )}
            />
          </form.AppForm>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Which of the project's fields a saved view shows. Title is always on (a view
 * hiding it is unprobed), and the shown fields follow the project's own field
 * order, which is how GitHub stores them ({@link nextVisibleFieldIds}).
 */
export function ViewFieldsDialog({
  open,
  pending,
  viewName,
  currentIds,
  defs,
  defsHeldReason,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  pending: boolean;
  viewName: string;
  currentIds: readonly string[];
  defs: readonly ProjectFieldDef[];
  /** Why the field definitions can't be offered yet, or undefined once they can. */
  defsHeldReason: string | undefined;
  onOpenChange: (open: boolean) => void;
  onSave: (visibleFieldIds: string[]) => Promise<void>;
}) {
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const form = useAppForm({
    defaultValues: {},
    onSubmit: () => onSave(nextVisibleFieldIds(currentIds, defs, checked)),
  });
  const submitting = useSelector(form.store, (s) => s.isSubmitting);
  useSeedOnOpen(open, () => setChecked(new Set(currentIds)));
  const next = nextVisibleFieldIds(currentIds, defs, checked);
  // By SET, and against the current set NORMALIZED the way `next` is (Title
  // injected): the order is GitHub's to decide, and a view stored without Title
  // (or with no fields at all) must not open with Save live on no change.
  const currentSet = new Set(currentIds);
  for (const def of defs) if (isTitleDef(def)) currentSet.add(def.id);
  const unchanged =
    next.length === currentSet.size && next.every((id) => currentSet.has(id));
  // A plain if/else chain: the React Compiler bails on a switch(true) here.
  let heldReason: string | null = null;
  if (pending || submitting) heldReason = SAVING_REASON;
  else if (defsHeldReason !== undefined) heldReason = defsHeldReason;
  else if (unchanged) heldReason = "Check or uncheck a field to save";
  const submit = heldSubmitHandlers(form, heldReason);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] min-w-0 flex-col sm:max-w-lg"
        onKeyDown={submit.onKeyDown}
      >
        <form
          className="flex min-h-0 min-w-0 flex-col gap-4"
          onSubmit={submit.onSubmit}
        >
          <DialogHeader>
            <DialogTitle>Fields in {viewName}</DialogTitle>
            <DialogDescription>
              Pick the fields this view shows, for everyone on the project. They
              follow the project's own field order.
            </DialogDescription>
          </DialogHeader>
          {defsHeldReason !== undefined ? (
            <p className="text-xs text-muted-foreground">{defsHeldReason}</p>
          ) : (
            <LabeledGroup
              label="Shown fields"
              // The bottom padding holds the last checkbox's enlarged hit area
              // (it overhangs its row by 8px), so a list that fits scrolls not at all.
              className="min-h-0 overflow-y-auto pr-1 pb-2"
            >
              {defs.map((def) => {
                const title = isTitleDef(def);
                return (
                  <label
                    key={def.id}
                    className="flex min-w-0 cursor-pointer items-center gap-2 text-xs has-disabled:cursor-default"
                  >
                    <Checkbox
                      checked={title || checked.has(def.id)}
                      disabled={title}
                      onCheckedChange={(on) =>
                        setChecked((prev) => {
                          const nextSet = new Set(prev);
                          if (on === true) nextSet.add(def.id);
                          else nextSet.delete(def.id);
                          return nextSet;
                        })
                      }
                    />
                    <span
                      className="min-w-0 truncate"
                      onMouseEnter={clipTitleFromText}
                    >
                      {def.name}
                    </span>
                    {title && (
                      <span className="shrink-0 text-muted-foreground">
                        always shown
                      </span>
                    )}
                  </label>
                );
              })}
            </LabeledGroup>
          )}
          <form.AppForm>
            <HeldFooter
              heldReason={heldReason}
              onCancel={() => onOpenChange(false)}
              submit={(props) => (
                <form.SubmitButton {...props}>Save fields</form.SubmitButton>
              )}
            />
          </form.AppForm>
        </form>
      </DialogContent>
    </Dialog>
  );
}
