import {
  CaretDownIcon,
  CaretRightIcon,
  PlusIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { DIALOG_SCROLL } from "@/components/dialog-scroll";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { SelectClipText } from "@/components/select-clip-text";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useRetryFocusRescue } from "@/features/conversations/ConversationListPanel";
import {
  DEGRADED_ACTION_CLASS,
  offlinePendingMessage,
  refreshFailed,
} from "@/features/conversations/remote-section-state";
import { clipTitleFromText } from "@/lib/clip-title";
import { useForgeStatus } from "@/lib/git/queries";
import {
  type DispatchProbe,
  dispatchableKey,
  isDispatchInputsError,
  useBbCustomPipelines,
  useRunWorkflow,
  useWorkflowDispatchable,
  useWorkflows,
  type WorkflowInput,
} from "@/lib/github/actions";
import {
  ACT_PENDING_REASON,
  pendingWriteReason,
  refuseWhileOffline,
  useOfflineHold,
} from "@/lib/offline-writes";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import { cn } from "@/lib/utils";
import {
  absorbRows,
  buildDispatch,
  CHOICE_NONE,
  type DispatchField,
  type DispatchRow,
  numberWarning,
  reseedFields,
  seedFields,
} from "./dispatch-inputs";
import { isPipelineProvider } from "./status";

/** Only an explicit false refuses a workflow: a missing key — probe pending,
 *  errored, or unable to tell — keeps it offered, so a failed probe never hides
 *  a workflow the user could in fact run. */
const hasNoManualTrigger = (
  probed: Record<string, DispatchProbe> | undefined,
  id: string,
) => probed?.[id]?.declared === false;

/** The typed fields shown for one workflow, stamped with the open session and the
 *  landed `inputs` array they were built from. Held across the ref debounce and
 *  across failed re-reads: the probe keeps no placeholder between refs, so without
 *  it every keystroke in the ref field would unmount the fields and their edits. */
interface HeldSchema {
  token: object;
  workflowId: string;
  ref: string;
  source: WorkflowInput[];
  fields: DispatchField[];
  /** "Inputs updated for <ref>" after a landing unmounted the focused field. */
  note: string | null;
}

type InputsArm =
  | "noRef"
  | "noWorkflow"
  | "reading"
  | "unread"
  | "none"
  | "fields"
  | "checking"
  | "stale";

const INPUTS_STATUS: Record<
  InputsArm,
  (ref: string, note: string | null) => string | null
> = {
  noRef: () => "Enter a branch or tag to read this workflow's inputs.",
  noWorkflow: () => null,
  reading: () => "Reading inputs…",
  unread: (ref) =>
    `Couldn't read this workflow's inputs at ${ref}; add them by name.`,
  none: (_ref, note) =>
    note
      ? `${note}. This workflow declares no inputs.`
      : "This workflow declares no inputs.",
  fields: (_ref, note) => note,
  checking: (ref) => `Checking inputs on ${ref}…`,
  stale: (ref) =>
    `Couldn't re-read inputs on ${ref}; showing the last known inputs`,
};

/** Keyed by kind as well as name, so a type change remounts the control. */
const fieldKey = (f: DispatchField) => `${f.input.type}:${f.input.name}`;

const HOST_FOCUS = Symbol("inputs-host");

export function RunWorkflowDialog({
  repoPath,
  open,
  onOpenChange,
  defaultRef,
  initialWorkflow,
}: {
  repoPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultRef: string;
  /** Preselect this workflow (a stringified workflow id) on each open, once the
   *  workflow list confirms it's still offered — GitHub only. Omitted, the picker
   *  keeps its previous selection. */
  initialWorkflow?: string;
}) {
  // Per-mount base for the field ids (label↔control association).
  const idBase = useId();
  const additionalPanelId = `${idBase}-additional`;
  const queryClient = useQueryClient();
  // GitLab and Bitbucket have no per-workflow dispatch — one pipeline config per
  // project — so the form is just ref + variables: the workflow picker hides (and
  // its GitHub-only `gh workflow list` query never fires), and "inputs" become
  // CI/CD variables on the new pipeline.
  const provider = useForgeStatus(repoPath).data?.provider;
  const isPipelines = isPipelineProvider(provider);
  const isBitbucket = provider === "bitbucket";
  const workflows = useWorkflows(repoPath, open && !isPipelines);
  // Bitbucket custom-pipeline selectors (from the working-tree
  // `bitbucket-pipelines.yml`). When present, they're offered above the ref
  // alongside "Default" (the branch pipeline). Other providers never fetch.
  const customPipelines = useBbCustomPipelines(repoPath, open && isBitbucket);
  const pipelineNames = customPipelines.data ?? [];
  const hasCustomPipelines = isBitbucket && pipelineNames.length > 0;
  const runWorkflow = useRunWorkflow(repoPath);
  const selectRun = useUiStore((s) => s.selectRun);
  // Identity of the current open session: a fresh object on each open, null while
  // closed or unmounted. A mounted ref can't stand in for it — the panel renders
  // this dialog unconditionally, so closing it leaves the component mounted. Any
  // lifecycle that re-runs this effect also ends the session, landing the safe
  // arm: the toast still fires, only the navigation is skipped.
  const session = useRef<object | null>(null);
  useEffect(() => {
    session.current = open ? {} : null;
    return () => {
      session.current = null;
    };
  }, [open]);

  // Only active workflows are dispatchable.
  const dispatchable = (workflows.data ?? []).filter(
    (w) => w.state === "active",
  );
  // value → label map so the trigger shows the workflow name, not its id.
  const workflowItems = Object.fromEntries(
    dispatchable.map((w) => [String(w.id), w.name]),
  );
  // value → label map so the closed trigger shows "Default" for "", not a blank.
  // The popup renders from it too, so the two can never drift.
  const pipelineItems: Record<string, string> = {
    "": "Default",
    ...Object.fromEntries(pipelineNames.map((n) => [n, n])),
  };

  const [workflow, setWorkflow] = useState("");
  // "" = the branch's default pipeline; a name = a custom selector. Bitbucket only.
  const [pipeline, setPipeline] = useState("");
  const [gitRef, setGitRef] = useState(defaultRef);
  // The ref the dispatch probe runs against. Debounced locally rather than via
  // useDebouncedValue: the dialog stays mounted across open/close, so the seed
  // below must re-point it SYNCHRONOUSLY — the default ref has to probe on open
  // instead of waiting out a timer.
  const [debouncedRef, setDebouncedRef] = useState(defaultRef.trim());
  // The caller's preselect, held until the workflow list lands. Applying it in the
  // open seed would put a raw id in the closed trigger: SelectValue renders the
  // value string for anything the `items` map doesn't carry, and a since-disabled
  // workflow never joins that map at all.
  const pendingInitial = useRef<string | null>(null);
  // Whether the current selection was chosen by the preselect rather than by a
  // person. On a cold list the workflow query resolves before the slower
  // per-workflow probe, so that first pick is made trigger-blind; only a pick marked
  // here may be revised once the probe lands.
  const autoPicked = useRef(false);
  // The ref the standing selection was made under. The seed writes it too, so the
  // open's own seeded ref never reads as a change.
  const pickedUnderRef = useRef(defaultRef.trim());
  // Stable row ids keep input focus/state correct when rows are removed.
  const nextId = useRef(0);
  const [rows, setRows] = useState<DispatchRow[]>([]);
  const [held, setHeld] = useState<HeldSchema | null>(null);
  // A fresh object per open: a schema held under an earlier open never shows.
  const [openToken, setOpenToken] = useState<object>(() => ({}));
  // The user's own toggle of "Additional inputs"; null follows the arm's default.
  const [additionalToggle, setAdditionalToggle] = useState<boolean | null>(
    null,
  );
  const inputsHost = useRef<HTMLDivElement | null>(null);
  const pendingFieldFocus = useRef<string | typeof HOST_FOCUS | null>(null);
  // The index a removed row held, so focus lands on its successor once it's gone.
  const pendingRowFocus = useRef<number | null>(null);

  // Reset the form each time the dialog opens.
  useSeedOnOpen(open, () => {
    setGitRef(defaultRef);
    setDebouncedRef(defaultRef.trim());
    setRows([]);
    setHeld(null);
    setOpenToken({});
    setAdditionalToggle(null);
    setPipeline("");
    // No list for this repo yet means a carried-over selection can't be vouched for,
    // and the closed trigger renders an unknown value as its raw id — clear it so the
    // "Loading…" placeholder shows instead. A disabled query keeps its cache while the
    // observer stays mounted, so only a new repo key or a gcTime eviction lands here;
    // a valid pick survives every ordinary reopen.
    if (!workflows.data) setWorkflow("");
    pickedUnderRef.current = defaultRef.trim();
    // Armed here, consumed by the preselect effect below (which runs later in this
    // same commit) once the workflow list can vouch for the id.
    pendingInitial.current = initialWorkflow ?? null;
  });
  useEffect(() => {
    const t = setTimeout(() => {
      const next = gitRef.trim();
      setDebouncedRef(next);
      if (next === pickedUnderRef.current) return;
      pickedUnderRef.current = next;
      // An auto-pick is only defensible for the ref it was made under, and the seeded
      // ref at open is not a change: a LATER ref whose probe refuses the standing
      // selection shows the hint instead of silently swapping the picker, so toggling
      // the ref can't flip-flop what is selected.
      autoPicked.current = false;
    }, 400);
    return () => clearTimeout(t);
  }, [gitRef]);

  const dispatchProbe = useWorkflowDispatchable(
    repoPath,
    debouncedRef,
    open && !isPipelines,
  );
  // Verdicts are ref-scoped, and the debounce lets the input run ahead of the ref
  // they were probed for: a mid-debounce mismatch reads as no-verdict, never as
  // refusal. Gated at the one read, so every consumer below fails open together.
  const probeCurrent = gitRef.trim() === debouncedRef;
  const probed =
    probeCurrent && !dispatchProbe.isPlaceholderData
      ? dispatchProbe.data
      : undefined;
  // The current ref's schema for the selected workflow: a list, null (unknown),
  // or undefined (no verdict yet, or the map lacks the workflow).
  const landedInputs =
    !isPipelines && workflow !== "" ? probed?.[workflow]?.inputs : undefined;

  // Declared ahead of the landing effect and run after every commit, so a
  // landing's focus target is consumed in the NEXT commit, once it is mounted.
  useLayoutEffect(() => {
    const target = pendingFieldFocus.current;
    pendingFieldFocus.current = null;
    const host = inputsHost.current;
    if (target === null || !host) return;
    if (target === HOST_FOCUS) {
      host.focus({ preventScroll: true });
      return;
    }
    const field = [
      ...host.querySelectorAll<HTMLElement>("[data-dispatch-field]"),
    ].find((el) => el.dataset.dispatchField === target);
    field?.querySelector<HTMLElement>("[data-dispatch-control]")?.focus();
  });
  // Applies a landed schema: a fresh seed for a newly shown workflow, otherwise
  // the re-seed that keeps edits; free rows naming a declared input move into it.
  const landSchema = useEffectEvent((inputs: WorkflowInput[]) => {
    const prev =
      held !== null && held.token === openToken && held.workflowId === workflow
        ? held
        : null;
    const seeded = prev
      ? reseedFields(prev.fields, inputs)
      : seedFields(inputs);
    const { fields, rows: kept, absorbed } = absorbRows(seeded, rows);
    let note: string | null = null;
    const active = document.activeElement;
    if (active && inputsHost.current?.contains(active)) {
      const rowId = active
        .closest("[data-dispatch-row]")
        ?.getAttribute("data-dispatch-row");
      const shown = active
        .closest("[data-dispatch-field]")
        ?.getAttribute("data-dispatch-field");
      const into = rowId == null ? undefined : absorbed.get(Number(rowId));
      if (into !== undefined) {
        const target = fields.find((f) => f.input.name === into);
        if (target) pendingFieldFocus.current = fieldKey(target);
      } else if (shown != null && !fields.some((f) => fieldKey(f) === shown)) {
        pendingFieldFocus.current = HOST_FOCUS;
        note = `Inputs updated for ${debouncedRef}`;
      }
    }
    // A user working in the free rows keeps the panel: collapsing it under them
    // would drop focus to the page.
    if (
      pendingFieldFocus.current === null &&
      additionalToggle === null &&
      kept.length === 0 &&
      fields.length > 0 &&
      active &&
      document.getElementById(additionalPanelId)?.contains(active)
    ) {
      setAdditionalToggle(true);
    }
    setHeld({
      token: openToken,
      workflowId: workflow,
      ref: debouncedRef,
      source: inputs,
      fields,
      note,
    });
    if (kept !== rows) setRows(kept);
  });
  // A layout effect, so a reopen over a cached schema paints its fields at once.
  // Only a landed list replaces the held schema: an absent key, a failed or parked
  // read, or an unparsed file keeps the last known fields and their edits.
  useLayoutEffect(() => {
    if (!open || isPipelines) return;
    const current =
      held !== null && held.token === openToken && held.workflowId === workflow;
    if (!Array.isArray(landedInputs)) {
      // A schema held for another workflow or an earlier open never comes back:
      // returning to that workflow re-seeds it fresh.
      if (held !== null && !current) setHeld(null);
      return;
    }
    if (current && held.source === landedInputs) return;
    landSchema(landedInputs);
  }, [open, isPipelines, landedInputs, held, openToken, workflow]);
  useLayoutEffect(() => {
    const at = pendingRowFocus.current;
    pendingRowFocus.current = null;
    if (at === null) return;
    const next = rows[at] ?? rows[at - 1];
    document
      .getElementById(
        next ? `${idBase}-row-${next.id}-name` : `${idBase}-add-row`,
      )
      ?.focus();
  }, [rows, idBase]);

  useEffect(() => {
    // Only a landed list can judge an id. While the query is pending or errored
    // (including the never-enabled pipeline-provider case) nothing is touched, so a
    // valid selection survives every open.
    if (!open || workflows.isPending || !workflows.data) return;
    const offered = (id: string) =>
      dispatchable.some((w) => String(w.id) === id);

    // Consumed once per open, whether or not it resolves: a refetch must never
    // re-apply it over a selection the user has since made. A preselect the loaded
    // list doesn't offer (workflow disabled or deleted since the run) is dropped
    // for the ordinary default rather than shown as an unrunnable id.
    const wanted = pendingInitial.current;
    pendingInitial.current = null;
    if (wanted && offered(wanted)) {
      // Replacing a carried-over selection is the point — the caller asked for this
      // workflow, and nothing in this open has been touched yet. Named intent counts
      // as a person's pick, so the probe may not revise it.
      autoPicked.current = false;
      setWorkflow(wanted);
      return;
    }
    // Keep the selection only while it is still offered AND is either a person's pick
    // or an auto-pick the probe hasn't refused. The selection outlives repo switches,
    // so an unoffered id (another repo's, or disabled/deleted since) renders raw in
    // the closed trigger and dispatches an id gh can't resolve.
    if (
      workflow &&
      offered(workflow) &&
      !(autoPicked.current && hasNoManualTrigger(probed, workflow))
    ) {
      return;
    }
    if (dispatchable.length === 0) {
      setWorkflow("");
      return;
    }
    // Prefer a runnable workflow; with every one refused, the first still gets
    // picked so the picker shows what it refuses (the Run button stays disabled) —
    // and re-picking the same id bails out of setState, so this can't loop.
    const pick =
      dispatchable.find((w) => !hasNoManualTrigger(probed, String(w.id))) ??
      dispatchable[0];
    autoPicked.current = true;
    setWorkflow(String(pick.id));
  }, [
    open,
    workflow,
    dispatchable,
    probed,
    workflows.isPending,
    workflows.data,
  ]);

  const heldHere =
    held !== null && held.token === openToken && held.workflowId === workflow
      ? held
      : null;
  const shownFields = heldHere?.fields ?? [];
  // A typed-fields dispatch: the record it sends, or why it can't go yet.
  const typedDispatch = isPipelines ? null : buildDispatch(shownFields, rows);

  const setFieldValue = (name: string, value: string) =>
    setHeld((h) =>
      h
        ? {
            ...h,
            fields: h.fields.map((f) =>
              f.input.name === name ? { ...f, value, dirty: true } : f,
            ),
          }
        : h,
    );

  // Awaited, not per-call callbacks: leaving the repo view mid-dispatch unmounts
  // this panel, and react-query drops per-call callbacks once the observer has no
  // listeners.
  async function submit() {
    if ((!isPipelines && !workflow) || !gitRef.trim()) return;
    if (typedDispatch?.hold !== undefined) return;
    const record: Record<string, string> = typedDispatch?.record ?? {};
    if (!typedDispatch) {
      for (const { key, value } of rows) {
        const k = key.trim();
        if (k) record[k] = value;
      }
    }
    const dispatchedFrom = session.current;
    // The probe this dispatch could prove stale; pipelines run no probe.
    const probedRef = isPipelines ? null : gitRef.trim();
    // Bitbucket rides a custom-pipeline selector (or "" for the default) through
    // the `workflow` arg; GitLab always sends "" (byte-identical); GitHub sends
    // the selected workflow id.
    const workflowArg = (() => {
      switch (true) {
        case isBitbucket:
          return pipeline;
        case isPipelines:
          return "";
        default:
          return workflow;
      }
    })();
    if (refuseWhileOffline()) return;
    try {
      await runWorkflow.mutateAsync({
        workflow: workflowArg,
        gitRef: gitRef.trim(),
        inputs: record,
      });
      toast.success(isPipelines ? "Pipeline started" : "Workflow dispatched", {
        description: "It may take a few seconds to appear in the runs list.",
      });
      // The toast reports the dispatch wherever the user went; the navigation only
      // applies to the dialog they are still in, so it is gated on the session that
      // started it — a close, a reopen, or a tab switch mid-dispatch would
      // otherwise wipe the run they picked meanwhile or close a reopened dialog.
      if (dispatchedFrom !== null && session.current === dispatchedFrom) {
        // Clear any stale selection so the new run is easy to spot.
        selectRun(null);
        onOpenChange(false);
      }
    } catch (e) {
      toastError(e);
      // GitHub refusing the inputs means the held schema is stale. The cache is one
      // entry per ref, so every workflow's verdict there is re-probed, not just this
      // one; other failures say nothing about the schema and keep the verdict.
      if (probedRef !== null && isDispatchInputsError(e)) {
        void queryClient.invalidateQueries({
          queryKey: dispatchableKey(repoPath, probedRef),
        });
      }
    }
  }

  // Only a read whose latest answer succeeded may call the picker empty: after
  // a failure the cached empty list is unknown, not empty.
  const emptyUnknown = workflows.isError && dispatchable.length === 0;
  // A list parked before it ever loaded (or over a failure that left nothing to
  // pick) would say "Loading…" until reconnect: it says it waits instead.
  const workflowsParked =
    workflows.isPaused && (workflows.data === undefined || emptyUnknown);
  // A failure being refetched has nothing to judge yet, so it still loads.
  const workflowsLoading =
    !workflowsParked &&
    (workflows.isPending ||
      (workflows.isFetching && (workflows.data === undefined || emptyUnknown)));
  // A settled failure with nothing to pick: the list is unknown, never empty.
  const workflowsFailed =
    !isPipelines && dispatchable.length === 0 && refreshFailed(workflows);
  const noneDispatchable =
    !isPipelines && workflows.isSuccess && dispatchable.length === 0;
  // The Retry below unmounts on press: a never-loaded list resets to pending,
  // and a cached empty one keeps `isError` while fetching, which loads. The
  // field's own box survives either way and takes the focus.
  const workflowsRescue = useRetryFocusRescue(workflowsFailed);
  // The one status line (offline or failed) the picker points at for AT.
  const workflowHintId = `${idBase}-workflow-hint`;
  const selectedNoTrigger =
    !isPipelines && workflow !== "" && hasNoManualTrigger(probed, workflow);
  // A refusal landing hides the Inputs content under a focused field; the host
  // outlives it and takes the focus.
  const inputsRescue = useRetryFocusRescue(!selectedNoTrigger);

  const refTrim = gitRef.trim();
  // A verdict for the current ref that carries no schema for this workflow.
  const probeUnread =
    probeCurrent &&
    !Array.isArray(landedInputs) &&
    (probed !== undefined || dispatchProbe.isError || dispatchProbe.isPaused);
  const inputsArm: InputsArm = (() => {
    switch (true) {
      case refTrim === "":
        return "noRef";
      case workflow === "":
        return "noWorkflow";
      // A failed refetch keeps its cached list, which must not read as fresh.
      case heldHere !== null && probeCurrent && dispatchProbe.isError:
        return "stale";
      case heldHere !== null && Array.isArray(landedInputs):
        return shownFields.length > 0 ? "fields" : "none";
      case heldHere !== null && probeUnread:
        return "stale";
      case heldHere !== null:
        return "checking";
      case probeUnread:
        return "unread";
      default:
        return "reading";
    }
  })();
  const inputsStatus = INPUTS_STATUS[inputsArm](
    refTrim,
    heldHere?.note ?? null,
  );
  // Collapsed by default only over typed fields with no free row; the user's own
  // toggle wins from then on, so it never collapses under rows on its own.
  const additionalOpen =
    additionalToggle ?? (rows.length > 0 || shownFields.length === 0);

  // Managing rows pins the disclosure open: removing the last row must not
  // collapse the panel holding the Add input button that takes the focus. A new
  // row takes the focus on its name field.
  const addRow = () => {
    setAdditionalToggle(true);
    pendingRowFocus.current = rows.length;
    setRows((prev) => [...prev, { id: nextId.current++, key: "", value: "" }]);
  };
  const changeRow = (id: number, patch: Partial<DispatchRow>) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const removeRow = (id: number) => {
    setAdditionalToggle(true);
    pendingRowFocus.current = rows.findIndex((r) => r.id === id);
    setRows((prev) => prev.filter((r) => r.id !== id));
  };

  // Starting CI holds offline rather than park: a parked dispatch would start a
  // run whenever the connection returns, long after the user left the dialog.
  // Every hold carries a reason, ranked running-first, so a flip between them
  // never drops focus to a native disable.
  const offlineHold = useOfflineHold();
  const runHeldReason = (() => {
    switch (true) {
      case runWorkflow.isPending:
        return pendingWriteReason(runWorkflow.isPaused, ACT_PENDING_REASON);
      case offlineHold !== undefined:
        return offlineHold;
      // Only a read that succeeded may say there is nothing to run; a failed one
      // says so, matching the field's own notice.
      case !isPipelines && !workflow && workflowsLoading:
        return "Loading workflows…";
      case !isPipelines && !workflow && workflowsFailed:
        return "Couldn't load workflows";
      case !isPipelines && !workflow && noneDispatchable:
        return "No active workflows to run here";
      case !isPipelines && !workflow:
        return "Choose a workflow";
      case selectedNoTrigger:
        return "This workflow has no manual trigger on this branch or tag";
      case !gitRef.trim():
        return "Enter a branch or tag";
      default:
        return typedDispatch?.hold;
    }
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="pr-8">
            {isPipelines ? "Run pipeline" : "Run workflow"}
          </DialogTitle>
          <DialogDescription>
            {isPipelines ? (
              "Run a new pipeline on a branch or tag."
            ) : (
              <>
                Manually trigger a workflow that has a{" "}
                <code className="font-mono">workflow_dispatch</code> trigger, on
                a branch or tag.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {/* Header and footer stay pinned; a long input list scrolls. */}
        <div className={cn(DIALOG_SCROLL, "min-h-0 flex-1 space-y-4")}>
          {!isPipelines && (
            <div
              ref={workflowsRescue.hostRef}
              tabIndex={-1}
              className="space-y-2 outline-none"
            >
              <Label htmlFor={`${idBase}-workflow`}>Workflow</Label>
              <Select
                items={workflowItems}
                value={workflow}
                onValueChange={(v) => {
                  if (!v) return;
                  // A hand-picked workflow is final: the probe landing later may
                  // disable the Run button but never re-picks for the user.
                  autoPicked.current = false;
                  setWorkflow(v);
                }}
                disabled={dispatchable.length === 0}
              >
                <SelectTrigger
                  id={`${idBase}-workflow`}
                  aria-describedby={
                    workflowsParked || workflowsFailed
                      ? workflowHintId
                      : undefined
                  }
                  className="w-full"
                >
                  <SelectValue
                    placeholder={
                      workflowsLoading ? "Loading…" : "Select a workflow"
                    }
                    onMouseEnter={clipTitleFromText}
                  />
                </SelectTrigger>
                <SelectContent>
                  {dispatchable.map((w) => {
                    const refused = hasNoManualTrigger(probed, String(w.id));
                    return (
                      <SelectItem
                        key={w.id}
                        value={String(w.id)}
                        disabled={refused}
                      >
                        {/* The reason rides inside the SOLE SelectClipText child:
                            a sibling span would be pushed past the popup's clip
                            edge. The `items` map keeps the plain name, which a
                            disabled row can never reach anyway. */}
                        <SelectClipText>
                          {refused ? `${w.name} (no manual trigger)` : w.name}
                        </SelectClipText>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              {workflowsParked && (
                <p
                  id={workflowHintId}
                  className="text-xs text-muted-foreground"
                >
                  {offlinePendingMessage("workflows")}
                </p>
              )}
              {workflowsFailed && (
                <p
                  id={workflowHintId}
                  className="text-xs text-muted-foreground"
                >
                  Couldn't load workflows.{" "}
                  <button
                    ref={workflowsRescue.retryRef}
                    type="button"
                    aria-label="Retry loading workflows"
                    onClick={() => void workflows.refetch()}
                    className={DEGRADED_ACTION_CLASS}
                  >
                    Retry
                  </button>
                </p>
              )}
              {noneDispatchable && (
                <p className="text-xs text-muted-foreground">
                  No active workflows found. A workflow needs a{" "}
                  <code className="font-mono">workflow_dispatch</code> trigger
                  to be run manually.
                </p>
              )}
              {/* At most one hint shows; an empty picker outranks a refused pick. */}
              {selectedNoTrigger && !noneDispatchable && (
                <p className="text-xs text-muted-foreground">
                  This workflow can't be run manually: it has no{" "}
                  <code className="font-mono">workflow_dispatch</code> trigger
                  on the chosen branch or tag.
                </p>
              )}
            </div>
          )}

          {hasCustomPipelines && (
            <div className="space-y-2">
              <Label htmlFor={`${idBase}-pipeline`}>Pipeline</Label>
              <Select
                items={pipelineItems}
                value={pipeline}
                onValueChange={(v) => setPipeline(v ?? "")}
              >
                <SelectTrigger id={`${idBase}-pipeline`} className="w-full">
                  <SelectValue onMouseEnter={clipTitleFromText} />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(pipelineItems).map(([name, label]) => (
                    <SelectItem key={name} value={name}>
                      <SelectClipText>{label}</SelectClipText>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Over an emptied Inputs host the scroller's gap would only add
              16px of overflow below this field, so it drops it. */}
          <div className={cn("space-y-2", selectedNoTrigger && "mb-0")}>
            <Label htmlFor={`${idBase}-ref`}>Branch or tag</Label>
            <Input
              id={`${idBase}-ref`}
              value={gitRef}
              onChange={(e) => setGitRef(e.target.value)}
              placeholder="main"
              autoComplete="off"
            />
          </div>

          {isPipelines ? (
            <div
              className="space-y-2"
              role="group"
              aria-labelledby={`${idBase}-inputs-label`}
            >
              <div className="flex items-center justify-between">
                <Label id={`${idBase}-inputs-label`}>
                  Variables{" "}
                  <span className="font-normal text-muted-foreground">
                    (optional)
                  </span>
                </Label>
                <Button
                  id={`${idBase}-add-row`}
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={addRow}
                >
                  <PlusIcon data-icon="inline-start" />
                  Add variable
                </Button>
              </div>
              {rows.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Add CI/CD variables to pass to the pipeline.
                </p>
              ) : (
                <FreeRows
                  rows={rows}
                  noun="variable"
                  idBase={idBase}
                  onChange={changeRow}
                  onRemove={removeRow}
                />
              )}
            </div>
          ) : (
            // Survives every arm swap, a refused workflow included: a swap that
            // unmounts the focused field lands focus here.
            <div
              ref={(node) => {
                inputsHost.current = node;
                inputsRescue.hostRef(node);
              }}
              tabIndex={-1}
              className="outline-none"
              role={selectedNoTrigger ? undefined : "group"}
              aria-labelledby={
                selectedNoTrigger ? undefined : `${idBase}-inputs-label`
              }
            >
              {!selectedNoTrigger && (
                <div ref={inputsRescue.retryRef} className="space-y-3">
                  <div className="space-y-1">
                    <Label id={`${idBase}-inputs-label`}>Inputs</Label>
                    {/* Always mounted: a live region announces only text that
                        arrives after it is in the DOM. */}
                    <p
                      role="status"
                      className={cn(
                        "text-xs text-muted-foreground",
                        inputsStatus === null && "sr-only",
                      )}
                    >
                      {inputsStatus}
                    </p>
                  </div>
                  {inputsArm === "reading" && (
                    <div aria-busy="true" className="space-y-3">
                      {[0, 1].map((n) => (
                        <div key={n} aria-hidden="true" className="space-y-1.5">
                          <Skeleton className="h-3 w-24" />
                          <Skeleton className="h-8 w-full" />
                        </div>
                      ))}
                    </div>
                  )}
                  {shownFields.map((f, i) => (
                    <TypedField
                      key={fieldKey(f)}
                      field={f}
                      controlId={`${idBase}-field-${i}`}
                      onChange={(v) => setFieldValue(f.input.name, v)}
                    />
                  ))}
                  <div className="space-y-2">
                    <button
                      type="button"
                      aria-expanded={additionalOpen}
                      aria-controls={additionalPanelId}
                      onClick={() => setAdditionalToggle(!additionalOpen)}
                      className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      {additionalOpen ? (
                        <CaretDownIcon className="size-3" />
                      ) : (
                        <CaretRightIcon className="size-3" />
                      )}
                      Additional inputs
                      {rows.length > 0 && (
                        <>
                          <span aria-hidden="true"> ·</span>
                          <span className="sr-only">,</span> {rows.length}
                        </>
                      )}
                    </button>
                    <div
                      id={additionalPanelId}
                      hidden={!additionalOpen}
                      className="space-y-2"
                    >
                      {rows.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          {shownFields.length > 0
                            ? "Add an input the workflow doesn't declare."
                            : "Add key/value pairs if the workflow defines inputs."}
                        </p>
                      ) : (
                        <FreeRows
                          rows={rows}
                          noun="input"
                          idBase={idBase}
                          onChange={changeRow}
                          onRemove={removeRow}
                        />
                      )}
                      <Button
                        id={`${idBase}-add-row`}
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={addRow}
                      >
                        <PlusIcon data-icon="inline-start" />
                        Add input
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <DisabledReasonButton
            disabled={runHeldReason !== undefined}
            reason={runHeldReason}
            onClick={submit}
          >
            {isPipelines ? "Run pipeline" : "Run workflow"}
          </DisabledReasonButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One declared input's labelled control. Descriptions are repo text rendered as
 *  a plain text node, never markdown. */
function TypedField({
  field,
  controlId,
  onChange,
}: {
  field: DispatchField;
  controlId: string;
  onChange: (value: string) => void;
}) {
  const { input } = field;
  const descId = `${controlId}-desc`;
  const warnId = `${controlId}-warn`;
  const warning = input.type === "number" ? numberWarning(field.value) : null;
  const describedBy =
    [input.description ? descId : null, warning ? warnId : null]
      .filter((id) => id !== null)
      .join(" ") || undefined;
  const description = input.description ? (
    <p
      id={descId}
      className="text-xs whitespace-pre-line text-muted-foreground"
    >
      {input.description}
    </p>
  ) : null;
  const required = input.required ? ("true" as const) : undefined;

  if (input.type === "boolean") {
    // Booleans always send, so they are never marked required. The description
    // sits outside the label so the checkbox's name stays the input's name.
    return (
      <div data-dispatch-field={fieldKey(field)} className="space-y-1">
        <label className="flex cursor-pointer items-center gap-2 text-xs">
          <Checkbox
            data-dispatch-control=""
            checked={field.value === "true"}
            onCheckedChange={(c) => onChange(c === true ? "true" : "false")}
            aria-describedby={describedBy}
          />
          <span className="min-w-0 font-mono wrap-anywhere">{input.name}</span>
        </label>
        {description}
      </div>
    );
  }

  const control = (() => {
    switch (input.type) {
      case "choice": {
        // Values are option indexes: option strings may repeat or spell "none",
        // and the map only labels the closed trigger (SelectValue shows raw values).
        const items: Record<string, string> = Object.fromEntries(
          field.options.map((o, i) => [String(i), o]),
        );
        if (field.none) items[CHOICE_NONE] = "(none)";
        return (
          <Select
            items={items}
            value={field.value === "" ? null : field.value}
            onValueChange={(v) => {
              // Base UI re-fires on a same-value re-pick; that is no edit.
              if (v === null || v === field.value) return;
              onChange(v);
            }}
          >
            <SelectTrigger
              id={controlId}
              data-dispatch-control=""
              aria-required={required}
              aria-describedby={describedBy}
              className="w-full"
            >
              <SelectValue
                placeholder="Choose…"
                onMouseEnter={clipTitleFromText}
              />
            </SelectTrigger>
            <SelectContent>
              {field.none && (
                <SelectItem value={CHOICE_NONE}>
                  <SelectClipText>(none)</SelectClipText>
                </SelectItem>
              )}
              {field.options.map((o, i) => (
                <SelectItem key={o} value={String(i)}>
                  <SelectClipText>{o}</SelectClipText>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      }
      case "string":
      case "number":
      case "environment":
        return (
          <Input
            id={controlId}
            data-dispatch-control=""
            value={field.value}
            onChange={(e) => onChange(e.target.value)}
            aria-required={required}
            aria-describedby={describedBy}
            // Never type="number": it would reject or rewrite text GitHub accepts.
            inputMode={input.type === "number" ? "decimal" : undefined}
            placeholder={
              input.type === "environment" ? "Environment name" : undefined
            }
            autoComplete="off"
          />
        );
    }
  })();

  return (
    <div data-dispatch-field={fieldKey(field)} className="space-y-1">
      <div className="flex items-baseline gap-1.5">
        {/* A flex item's min-content is its longest word: an unbroken name would
            widen the dialog body unless it may wrap anywhere. */}
        <Label htmlFor={controlId} className="min-w-0 font-mono wrap-anywhere">
          {input.name}
        </Label>
        {input.required && (
          <span className="text-xs text-muted-foreground">(required)</span>
        )}
      </div>
      {description}
      {control}
      {warning && (
        <p id={warnId} className="text-xs text-warning">
          {warning}
        </p>
      )}
    </div>
  );
}

const ROW_COPY: Record<
  "input" | "variable",
  { name: string; newValue: string; remove: string }
> = {
  input: {
    name: "Input name",
    newValue: "Value for new input",
    remove: "Remove input",
  },
  variable: {
    name: "Variable name",
    newValue: "Value for new variable",
    remove: "Remove variable",
  },
};

/** Free-form name/value rows: workflow inputs the schema doesn't declare, or a
 *  pipeline's CI/CD variables. */
function FreeRows({
  rows,
  noun,
  idBase,
  onChange,
  onRemove,
}: {
  rows: DispatchRow[];
  noun: "input" | "variable";
  idBase: string;
  onChange: (id: number, patch: Partial<DispatchRow>) => void;
  onRemove: (id: number) => void;
}) {
  const copy = ROW_COPY[noun];
  return (
    <div className="space-y-2">
      {rows.map((row) => {
        const key = row.key.trim();
        return (
          <div
            key={row.id}
            data-dispatch-row={row.id}
            className="flex items-center gap-2"
          >
            <Input
              id={`${idBase}-row-${row.id}-name`}
              aria-label={copy.name}
              value={row.key}
              onChange={(e) => onChange(row.id, { key: e.target.value })}
              placeholder="name"
              className="h-8 flex-1"
              autoComplete="off"
            />
            <Input
              aria-label={key ? `Value for ${key}` : copy.newValue}
              value={row.value}
              onChange={(e) => onChange(row.id, { value: e.target.value })}
              placeholder="value"
              className="h-8 flex-1"
              autoComplete="off"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={key ? `${copy.remove} ${key}` : copy.remove}
              onClick={() => onRemove(row.id)}
            >
              <XIcon />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
