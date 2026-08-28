import { PlusIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { SelectClipText } from "@/components/select-clip-text";
import { Button } from "@/components/ui/button";
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
import { clipTitleFromText } from "@/lib/clip-title";
import { useForgeStatus } from "@/lib/git/queries";
import {
  useBbCustomPipelines,
  useRunWorkflow,
  useWorkflowDispatchable,
  useWorkflows,
} from "@/lib/github/actions";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import { isPipelineProvider } from "./status";

/** Only an explicit false refuses a workflow: a missing key — probe pending,
 *  errored, or unable to tell — keeps it offered, so a failed probe never hides
 *  a workflow the user could in fact run. */
const hasNoManualTrigger = (
  probed: Record<string, boolean> | undefined,
  id: string,
) => probed?.[id] === false;

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
  const [inputs, setInputs] = useState<
    { id: number; key: string; value: string }[]
  >([]);

  // Reset the form each time the dialog opens.
  useSeedOnOpen(open, () => {
    setGitRef(defaultRef);
    setDebouncedRef(defaultRef.trim());
    setInputs([]);
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
  const probed = probeCurrent ? dispatchProbe.data : undefined;

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

  // Awaited, not per-call callbacks: leaving the repo view mid-dispatch unmounts
  // this panel, and react-query drops per-call callbacks once the observer has no
  // listeners.
  async function submit() {
    if ((!isPipelines && !workflow) || !gitRef.trim()) return;
    const record: Record<string, string> = {};
    for (const { key, value } of inputs) {
      const k = key.trim();
      if (k) record[k] = value;
    }
    const dispatchedFrom = session.current;
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
    }
  }

  const noneDispatchable =
    !isPipelines && !workflows.isPending && dispatchable.length === 0;
  const selectedNoTrigger =
    !isPipelines && workflow !== "" && hasNoManualTrigger(probed, workflow);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
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

        <div className="space-y-4">
          {!isPipelines && (
            <div className="space-y-2">
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
                <SelectTrigger id={`${idBase}-workflow`} className="w-full">
                  <SelectValue
                    placeholder={
                      workflows.isPending ? "Loading…" : "Select a workflow"
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

          <div className="space-y-2">
            <Label htmlFor={`${idBase}-ref`}>Branch or tag</Label>
            <Input
              id={`${idBase}-ref`}
              value={gitRef}
              onChange={(e) => setGitRef(e.target.value)}
              placeholder="main"
              autoComplete="off"
            />
          </div>

          <div
            className="space-y-2"
            role="group"
            aria-labelledby={`${idBase}-inputs-label`}
          >
            <div className="flex items-center justify-between">
              <Label id={`${idBase}-inputs-label`}>
                {isPipelines ? "Variables" : "Inputs"}{" "}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </Label>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() =>
                  setInputs((prev) => [
                    ...prev,
                    { id: nextId.current++, key: "", value: "" },
                  ])
                }
              >
                <PlusIcon data-icon="inline-start" />
                {isPipelines ? "Add variable" : "Add input"}
              </Button>
            </div>
            {inputs.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {isPipelines
                  ? "Add CI/CD variables to pass to the pipeline."
                  : "Add key/value pairs if the workflow defines inputs."}
              </p>
            ) : (
              <div className="space-y-2">
                {inputs.map((row) => (
                  <div key={row.id} className="flex items-center gap-2">
                    <Input
                      value={row.key}
                      onChange={(e) =>
                        setInputs((prev) =>
                          prev.map((r) =>
                            r.id === row.id ? { ...r, key: e.target.value } : r,
                          ),
                        )
                      }
                      placeholder="name"
                      className="h-8 flex-1"
                      autoComplete="off"
                    />
                    <Input
                      value={row.value}
                      onChange={(e) =>
                        setInputs((prev) =>
                          prev.map((r) =>
                            r.id === row.id
                              ? { ...r, value: e.target.value }
                              : r,
                          ),
                        )
                      }
                      placeholder="value"
                      className="h-8 flex-1"
                      autoComplete="off"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={
                        isPipelines ? "Remove variable" : "Remove input"
                      }
                      onClick={() =>
                        setInputs((prev) => prev.filter((r) => r.id !== row.id))
                      }
                    >
                      <XIcon />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={
              (!isPipelines && !workflow) ||
              selectedNoTrigger ||
              !gitRef.trim() ||
              runWorkflow.isPending
            }
            onClick={submit}
          >
            {isPipelines ? "Run pipeline" : "Run workflow"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
