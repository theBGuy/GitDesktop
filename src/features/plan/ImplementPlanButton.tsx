import { Popover } from "@base-ui/react/popover";
import { PlayIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { usePanelPortalContainer } from "@/components/panel-portal";
import { Button } from "@/components/ui/button";
import {
  AgentPicker,
  EffortNote,
  EffortPicker,
  ModelPicker,
} from "@/features/sessions/AgentPickers";
import { clearAgentSelection } from "@/features/sessions/agentSelect";
import { useSessionsStore } from "@/features/sessions/store";
import { type AgentKind, extractContextPack } from "@/lib/ai/agent";
import { useEffortControl } from "@/lib/ai/effort-levels";
import { buildImplementPrompt } from "@/lib/ai/prompt";
import { useSettings } from "@/lib/settings/queries";
import { type PlanRun, usePlanStore } from "./store";

/**
 * The plan's primary action: start a write-capable agent session that implements
 * the plan — directly, no detour through the Delegate composer. A small popover
 * lets you set the agent / model / effort first (defaulting to the planning
 * agent), then **Start session** kicks it off in an isolated worktree and selects
 * it. The plan stays in the sidebar.
 */
export function ImplementPlanButton({ run }: { run: PlanRun }) {
  const start = useSessionsStore((s) => s.start);
  const markImplemented = usePlanStore((s) => s.markImplemented);
  const [open, setOpen] = useState(false);
  const [agent, setAgent] = useState<AgentKind>(run.agent);
  const [model, setModel] = useState(run.model);
  const [effort, setEffort] = useState(run.effort);
  const portalContainer = usePanelPortalContainer();

  const onStart = async () => {
    if (!run.draft) return;
    setOpen(false);
    // Deselect the plan (it stays in the list) so the new session takes the canvas.
    clearAgentSelection();
    const sessionId = await start(
      run.repoPath,
      buildImplementPrompt({
        title: run.draft.title,
        body: run.draft.body,
        // The plan run's OWN reads — the paths its plan body cites (not unioned with
        // the upstream research pack; the plan already digested that).
        contextPack: extractContextPack(run.segments ?? []),
      }),
      model,
      agent,
      effort,
    );
    // Link the plan to its session so the sidebar row mirrors its status.
    if (sessionId) markImplemented(run.id, sessionId);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger render={<Button size="sm" />}>
        <PlayIcon weight="fill" data-icon="inline-start" />
        Implement
      </Popover.Trigger>
      <Popover.Portal container={portalContainer}>
        <Popover.Positioner align="end" sideOffset={6} className="isolate z-50">
          <Popover.Popup className="w-80 bg-popover p-3 text-popover-foreground shadow-md ring-1 ring-foreground/10">
            <p className="text-xs font-medium">Implement with an agent</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              Starts a write-capable session in an isolated worktree — your
              working tree is never touched.
            </p>
            <ImplementPickers
              agent={agent}
              model={model}
              effort={effort}
              onAgent={(a) => {
                setAgent(a);
                setModel(""); // model lists differ between agents
              }}
              onModel={setModel}
              onEffort={setEffort}
            />
            <Button size="sm" className="mt-2.5 w-full" onClick={onStart}>
              Start session
            </Button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The popup's pickers. Mounts with the popup, so the effort query (which
 *  spawns the CLI for opencode) runs only while it shows; the picks themselves
 *  live in the button so they survive the popup closing. */
function ImplementPickers({
  agent,
  model,
  effort,
  onAgent,
  onModel,
  onEffort,
}: {
  agent: AgentKind;
  model: string;
  effort: string;
  onAgent: (a: AgentKind) => void;
  onModel: (m: string) => void;
  onEffort: (e: string) => void;
}) {
  const settings = useSettings();
  // The session starts with no isolation override, so it follows Settings;
  // nothing is asked before they resolve.
  const isolation = settings.data
    ? (settings.data.agentIsolation ?? "worktree")
    : null;
  const control = useEffortControl(
    isolation === null
      ? null
      : { kind: agent, binPath: null, model, isolation },
    effort,
  );
  const noteId = useId();
  return (
    <>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-y py-2">
        <AgentPicker value={agent} onChange={onAgent} />
        <ModelPicker value={model} onChange={onModel} agent={agent} />
        <EffortPicker
          value={effort}
          onChange={onEffort}
          control={control}
          describedBy={control.line ? noteId : undefined}
        />
      </div>
      {control.line && (
        <div className="mt-2">
          <EffortNote id={noteId} line={control.line} />
        </div>
      )}
    </>
  );
}
