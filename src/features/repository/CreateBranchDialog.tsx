import { useSelector } from "@tanstack/react-store";
import { useEffectEvent, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { CREATE_PENDING_GENERATE_REASON } from "@/features/conversations/useAiStream";
import { branchNamePlaceholder } from "@/lib/ai/branch-prefixes";
import {
  branchNameError,
  branchNameHint,
  namingRequirement,
} from "@/lib/branch-rules/match";
import type { BranchRulesConfig } from "@/lib/branch-rules/types";
import { required, useAppForm } from "@/lib/form";
import { useCreateBranch } from "@/lib/git/queries";
import { refNameWarning, sanitizeRefName } from "@/lib/git/ref-name";
import type { FileEntry } from "@/lib/git/types";
import { useGenerateChord } from "@/lib/hotkeys/useGenerateChord";
import { promotionBlocksCheckout } from "@/lib/stores/worktree-removal";
import { toastError } from "@/lib/toast";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import {
  BaseBranchCombobox,
  useHasBaseOptions,
  useSeedBase,
} from "./BaseBranchCombobox";
import { PROMOTION_BLOCKS_CHECKOUT } from "./checkout-copy";
import {
  GenerateBranchNameButton,
  useBranchNameGenerateAction,
} from "./GenerateBranchNameButton";
import {
  type CommittedNameSource,
  useGenerateBranchName,
} from "./useGenerateBranchName";

/** Whitespace, glob syntax, and characters git refuses in a ref name: a hint
 *  entry carrying any of them is prose or a pattern, never a creatable name. */
const NOT_A_BRANCH_NAME = /[\s*?[\]{}~^:\\]|\.\.|^-/;

/**
 * Create-branch dialog: names a new branch (with optional AI generation from
 * the working-tree changes, or — when it branches from HEAD with a clean tree —
 * the current branch's committed work), picks its base, and switches to it.
 * Owns its own form + the create mutation + the branch-name generator — the
 * switcher only decides whether it's open and hands down the data it renders.
 * Seeds the base on open so it reflects the branch you were on when you
 * triggered it.
 */
export function CreateBranchDialog({
  repoPath,
  open,
  onOpenChange,
  rulesConfig,
  aiEnabled,
  aiConfigured,
  hasChanges,
  headExists,
  entries,
  allBranchNames,
  committedFallback,
  committedStatus,
  currentName,
  defaultName,
  onOpenSettings,
}: {
  repoPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rulesConfig: BranchRulesConfig;
  aiEnabled: boolean;
  aiConfigured: boolean;
  hasChanges: boolean;
  headExists: boolean;
  entries: FileEntry[];
  allBranchNames: string[];
  /** The checked-out branch's committed work vs the default branch (compared
   *  against the checked-out branch by name) — the AI name-generation fallback
   *  when the working tree is clean. Only applies when the new branch is based
   *  on HEAD; see below. */
  committedFallback: CommittedNameSource | null;
  /** How the committed-work lookup stands (pending/error are surfaced rather
   *  than read as "there is none"). */
  committedStatus: "ready" | "pending" | "error";
  currentName: string | null;
  defaultName: string | null;
  onOpenSettings: (section: "ai") => void;
}) {
  const createBranch = useCreateBranch(repoPath);
  const branchNameGen = useGenerateBranchName(repoPath);
  // The open session a create settles against: minted by the open seed, dropped
  // by every close this dialog makes (a host-side close is re-minted over by the
  // next seed), so a create that outlives a close-and-reopen leaves the reopened
  // dialog alone. Never minted in an `[open]` effect with a clearing cleanup: an
  // <Activity> hide runs that cleanup, stranding a hidden settle.
  const sessionRef = useRef<object | null>(null);
  // Every close path routes through here: the dialog stays mounted, so an
  // in-flight suggestion would otherwise land in the field on the next open.
  const closeDialog = () => {
    sessionRef.current = null;
    branchNameGen.cancel();
    onOpenChange(false);
  };

  // The base picker owns its own data; the dialog hides the whole field when
  // there's no offerable base to pick (unborn HEAD / fresh repo → submit with no
  // start point creates from HEAD). Gate on the SAME offerable predicates the
  // picker derives its groups from (via `useHasBaseOptions`) rather than raw
  // query counts, so the field can't render with an empty dropdown.
  const hasBases = useHasBaseOptions(repoPath, open, currentName);

  // The value to seed the base picker with on open — the first of
  // current/default the picker would actually offer, "" otherwise (⇒ HEAD).
  const seedBase = useSeedBase(repoPath, currentName, defaultName);

  // Whether the picked base is a remote-tracking ref → drives `--no-track` so
  // the new branch starts with NO upstream and its first push publishes it
  // under its own name.
  const [baseIsRemote, setBaseIsRemote] = useState(false);
  const baseTriggerId = useId();

  const createForm = useAppForm({
    defaultValues: { name: "", base: "" },
    onSubmit: async ({ value }) => {
      // This create always checks the branch out, so it moves HEAD.
      if (promotionBlocksCheckout(repoPath)) {
        toast.info(PROMOTION_BLOCKS_CHECKOUT);
        return;
      }
      // Hoisted out of the try: a `||` value block inside try/catch bails the
      // whole component out of the React Compiler. The form holds the SHORT name
      // the copy shows; the start point is its full ref, since a bare name
      // resolves to a same-named tag first. Every value is a picker row: a local
      // branch, or `<remote>/<branch>` when `baseIsRemote`.
      const startPoint = value.base
        ? `${baseIsRemote ? "refs/remotes" : "refs/heads"}/${value.base}`
        : undefined;
      const session = sessionRef.current;
      try {
        await createBranch.mutateAsync({
          name: sanitizeRefName(value.name),
          checkout: true,
          startPoint,
          // A remote base starts untracked so its first push publishes under
          // its own name (no upstream copied from `origin/…`).
          noTrack: baseIsRemote && Boolean(startPoint),
        });
        if (sessionRef.current === session) {
          sessionRef.current = null;
          onOpenChange(false);
        }
      } catch (e) {
        toastError(e);
      }
    },
  });
  // Drives the "Branches from …" copy in the dialog description.
  const createBase = useSelector(createForm.store, (s) => s.values.base);
  // The committed fallback describes HEAD's work, so it only describes the new
  // branch when the new branch starts at HEAD ("" ⇒ no start point ⇒ HEAD).
  // Branching off origin/main carries none of it. The working-tree path is
  // unaffected — uncommitted changes come along whatever the base.
  const baseIsHead = createBase === "" || createBase === currentName;

  // An active naming policy's example outranks the inferred convention: it is
  // the rule the Create button enforces. The placeholder takes the first hint
  // entry that is itself a name the rule accepts; globs and prose fall through
  // to the inferred convention.
  const policyExample =
    namingRequirement(rulesConfig) === null
      ? undefined
      : rulesConfig.naming.hint
          .split(",")
          .map((entry) => entry.trim())
          .find(
            (entry) =>
              entry !== "" &&
              !NOT_A_BRANCH_NAME.test(entry) &&
              branchNameError(rulesConfig, entry) === null,
          );
  const namePlaceholder = useMemo(
    () => policyExample ?? branchNamePlaceholder(allBranchNames),
    [policyExample, allBranchNames],
  );

  // NOTE: seeding resets must pass keepDefaultValues — otherwise reset()
  // rewrites the form's defaultValues, and react-form's per-render options
  // sync sees "different defaults + untouched form" and clobbers the seeded
  // values right back on the next render.
  const seedOnOpen = useEffectEvent(() => {
    sessionRef.current = {};
    // Seed only a value the picker would actually offer (see `useSeedBase`) — a
    // seeded base absent from the list would render in the trigger yet be
    // unselectable. `seedBase` already encodes that invariant.
    createForm.reset({ name: "", base: seedBase }, { keepDefaultValues: true });
    // Seeded base is an offerable local branch (current/default) → never a
    // remote value, so tracking stays on.
    setBaseIsRemote(false);
  });
  useSeedOnOpen(open, seedOnOpen);

  // One generate pair for the button and the chord — see
  // `useBranchNameGenerateAction`.
  const generateAction = useBranchNameGenerateAction({
    gen: branchNameGen,
    aiEnabled,
    aiConfigured,
    hasChanges,
    headExists,
    entries,
    recentBranches: allBranchNames,
    nameTarget: "new-branch",
    committedFallback: baseIsHead ? committedFallback : null,
    onName: (name) => createForm.setFieldValue("name", name),
  });
  // This dialog opens from the header over any tab, including Changes where the
  // global generate-commit-message action is live. The chord is swallowed here
  // whenever it may fire, generate-capable or not (the hook mirrors the global
  // listener's own guards), so nothing writes into the commit box behind it. A
  // running create holds it like the button: the name it would revise has
  // already been sent.
  const isSubmitting = useSelector(createForm.store, (s) => s.isSubmitting);
  const generateChord = useGenerateChord({
    enabled: generateAction.enabled && !isSubmitting,
    run: generateAction.run,
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) onOpenChange(true);
        else closeDialog();
      }}
    >
      <DialogContent onKeyDown={generateChord.onKeyDown}>
        <form
          // min-w-0: DialogContent is display:grid, so this grid item must be
          // allowed to shrink below its content — otherwise a long base branch
          // name (e.g. feature/ollama-cloud-provider-custom-endpoints) pushes
          // the form past the dialog's max-width and the text overflows.
          className="min-w-0 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            // Enter submits even while the submit button is disabled, so an
            // in-flight name generation has to be checked here too.
            if (branchNameGen.generating) return;
            createForm.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New branch</DialogTitle>
            <DialogDescription>
              Branches from{" "}
              <span className="font-mono wrap-break-word">
                {createBase || "HEAD"}
              </span>{" "}
              and switches to it.
            </DialogDescription>
          </DialogHeader>
          <createForm.AppField
            name="name"
            validators={{
              onChange: ({ value }) =>
                required(value) ??
                branchNameError(rulesConfig, sanitizeRefName(value)) ??
                undefined,
            }}
          >
            {(field) => (
              <field.TextField
                label="Branch name"
                placeholder={namePlaceholder}
                // Surface the branch-rules naming requirement (so a disabled
                // Create button is explained), else the sanitization hint.
                warning={(value) =>
                  branchNameHint(rulesConfig, sanitizeRefName(value)) ??
                  refNameWarning(value)
                }
              />
            )}
          </createForm.AppField>
          <GenerateBranchNameButton
            gen={branchNameGen}
            action={generateAction}
            hint={generateChord.hint}
            aiEnabled={aiEnabled}
            aiConfigured={aiConfigured}
            hasChanges={hasChanges}
            headExists={headExists}
            nameTarget="new-branch"
            committedFallback={baseIsHead ? committedFallback : null}
            // Resolved by definition when the fallback can't apply — the button
            // explains the picked base instead of waiting on a lookup it won't use.
            committedStatus={baseIsHead ? committedStatus : "ready"}
            basedElsewhere={baseIsHead ? null : createBase}
            heldReason={isSubmitting ? CREATE_PENDING_GENERATE_REASON : null}
            onSetupAi={() => {
              closeDialog();
              onOpenSettings("ai");
            }}
          />
          {hasBases && (
            <createForm.AppField name="base">
              {(field) => (
                <div className="space-y-2">
                  <Label htmlFor={baseTriggerId}>Base it on</Label>
                  <BaseBranchCombobox
                    repoPath={repoPath}
                    open={open}
                    currentName={currentName}
                    defaultName={defaultName}
                    triggerId={baseTriggerId}
                    value={field.state.value || null}
                    onValueChange={(v, isRemote) => {
                      field.handleChange(v);
                      setBaseIsRemote(isRemote);
                    }}
                  />
                </div>
              )}
            </createForm.AppField>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDialog}>
              Cancel
            </Button>
            <createForm.AppForm>
              <createForm.SubmitButton disabled={branchNameGen.generating}>
                Create branch
              </createForm.SubmitButton>
            </createForm.AppForm>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
