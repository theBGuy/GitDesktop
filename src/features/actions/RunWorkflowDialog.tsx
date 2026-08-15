import { PlusIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useForgeStatus } from "@/lib/git/queries";
import {
  useBbCustomPipelines,
  useRunWorkflow,
  useWorkflows,
} from "@/lib/github/actions";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";

export function RunWorkflowDialog({
  repoPath,
  open,
  onOpenChange,
  defaultRef,
}: {
  repoPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultRef: string;
}) {
  // Per-mount base for the field ids (label↔control association).
  const idBase = useId();
  // GitLab and Bitbucket have no per-workflow dispatch — one pipeline config per
  // project — so the form is just ref + variables: the workflow picker hides (and
  // its GitHub-only `gh workflow list` query never fires), and "inputs" become
  // CI/CD variables on the new pipeline.
  const provider = useForgeStatus(repoPath).data?.provider;
  const isPipelineProvider = provider === "gitlab" || provider === "bitbucket";
  const isBitbucket = provider === "bitbucket";
  const workflows = useWorkflows(repoPath, open && !isPipelineProvider);
  // Bitbucket custom-pipeline selectors (from the working-tree
  // `bitbucket-pipelines.yml`). When present, they're offered above the ref
  // alongside "Default" (the branch pipeline). Other providers never fetch.
  const customPipelines = useBbCustomPipelines(repoPath, open && isBitbucket);
  const pipelineNames = customPipelines.data ?? [];
  const hasCustomPipelines = isBitbucket && pipelineNames.length > 0;
  const runWorkflow = useRunWorkflow(repoPath);
  const selectRun = useUiStore((s) => s.selectRun);

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
  // Stable row ids keep input focus/state correct when rows are removed.
  const nextId = useRef(0);
  const [inputs, setInputs] = useState<
    { id: number; key: string; value: string }[]
  >([]);

  // Reset the form each time the dialog opens, defaulting to the first workflow.
  useEffect(() => {
    if (!open) return;
    setGitRef(defaultRef);
    setInputs([]);
    setPipeline("");
  }, [open, defaultRef]);
  useEffect(() => {
    if (open && !workflow && dispatchable.length > 0) {
      setWorkflow(String(dispatchable[0].id));
    }
  }, [open, workflow, dispatchable]);

  function submit() {
    if ((!isPipelineProvider && !workflow) || !gitRef.trim()) return;
    const record: Record<string, string> = {};
    for (const { key, value } of inputs) {
      const k = key.trim();
      if (k) record[k] = value;
    }
    runWorkflow.mutate(
      {
        // Bitbucket rides a custom-pipeline selector (or "" for the default) through
        // the `workflow` arg; GitLab always sends "" (byte-identical); GitHub sends
        // the selected workflow id.
        workflow: isBitbucket ? pipeline : isPipelineProvider ? "" : workflow,
        gitRef: gitRef.trim(),
        inputs: record,
      },
      {
        onSuccess: () => {
          toast.success(
            isPipelineProvider ? "Pipeline started" : "Workflow dispatched",
            {
              description:
                "It may take a few seconds to appear in the runs list.",
            },
          );
          // Clear any stale selection so the new run is easy to spot.
          selectRun(null);
          onOpenChange(false);
        },
        onError: toastError,
      },
    );
  }

  const noneDispatchable =
    !isPipelineProvider && !workflows.isPending && dispatchable.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isPipelineProvider ? "Run pipeline" : "Run workflow"}
          </DialogTitle>
          <DialogDescription>
            {isPipelineProvider ? (
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
          {!isPipelineProvider && (
            <div className="space-y-2">
              <Label htmlFor={`${idBase}-workflow`}>Workflow</Label>
              <Select
                items={workflowItems}
                value={workflow}
                onValueChange={(v) => v && setWorkflow(v)}
                disabled={dispatchable.length === 0}
              >
                <SelectTrigger id={`${idBase}-workflow`} className="w-full">
                  <SelectValue
                    placeholder={
                      workflows.isPending ? "Loading…" : "Select a workflow"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {dispatchable.map((w) => (
                    <SelectItem key={w.id} value={String(w.id)}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {noneDispatchable && (
                <p className="text-xs text-muted-foreground">
                  No active workflows found. A workflow needs a{" "}
                  <code className="font-mono">workflow_dispatch</code> trigger
                  to be run manually.
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
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(pipelineItems).map(([name, label]) => (
                    <SelectItem key={name} value={name}>
                      {label}
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
                {isPipelineProvider ? "Variables" : "Inputs"}{" "}
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
                {isPipelineProvider ? "Add variable" : "Add input"}
              </Button>
            </div>
            {inputs.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {isPipelineProvider
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
                        isPipelineProvider ? "Remove variable" : "Remove input"
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
              (!isPipelineProvider && !workflow) ||
              !gitRef.trim() ||
              runWorkflow.isPending
            }
            onClick={submit}
          >
            {isPipelineProvider ? "Run pipeline" : "Run workflow"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
