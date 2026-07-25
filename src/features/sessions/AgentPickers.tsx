import {
  GaugeIcon,
  GearSixIcon,
  PlugsConnectedIcon,
  ShieldCheckIcon,
  UsersThreeIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AgentKind } from "@/lib/ai/agent";
import { MODEL_SUGGESTIONS } from "@/lib/ai/providers";
import type { McpServer } from "@/lib/settings/api";
import { useUiStore } from "@/lib/stores/ui";
import { cn } from "@/lib/utils";

// The agent / model / effort pickers, shared by the task composer, the plan
// composer, the plan's Implement popover, and the best-of-N arm editor. Kept in
// their own module so those surfaces don't import each other (the composer imports
// the ensemble dialog, which needs the pickers — a cycle if they lived together).

const CLAUDE_MODELS = MODEL_SUGGESTIONS["claude-cli"];
const CODEX_MODELS = MODEL_SUGGESTIONS["codex-cli"];
const COPILOT_MODELS = MODEL_SUGGESTIONS["copilot-cli"];
const OPENCODE_MODELS = MODEL_SUGGESTIONS["opencode-cli"];

/** Compact display labels for each agent CLI — for list rows, headers, badges. */
export const AGENT_LABELS: Record<AgentKind, string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "Copilot",
  opencode: "opencode",
};

/** The suggested model list for an agent (each CLI exposes different models). */
export function modelsForAgent(agent: AgentKind): string[] {
  switch (agent) {
    case "codex":
      return CODEX_MODELS;
    case "copilot":
      return COPILOT_MODELS;
    case "opencode":
      return OPENCODE_MODELS;
    default:
      return CLAUDE_MODELS;
  }
}

// "" (account default) maps to a non-empty sentinel for the Select value.
const DEFAULT_MODEL = "default";

export function ModelPicker({
  value,
  onChange,
  models,
}: {
  value: string;
  onChange: (m: string) => void;
  models: string[];
}) {
  return (
    <Select
      value={value || DEFAULT_MODEL}
      onValueChange={(v) => onChange(v === DEFAULT_MODEL ? "" : String(v))}
    >
      <SelectTrigger
        size="sm"
        aria-label="Agent model"
        className="w-auto border-0 text-muted-foreground shadow-none hover:bg-muted dark:bg-transparent"
      >
        <SelectValue />
      </SelectTrigger>
      {/* Models come from a narrow (w-auto) trigger, so the default
          `w-(--anchor-width)` popup clips long ids (e.g. `opencode/…`). Let it
          size to its content instead, capped so it can't run off-screen. */}
      <SelectContent className="w-fit max-w-sm">
        <SelectItem value={DEFAULT_MODEL}>Default model</SelectItem>
        {models.map((m) => (
          <SelectItem key={m} value={m}>
            {m}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const DEFAULT_EFFORT = "default";
const EFFORT_LEVELS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Max" },
] as const;

/** Reasoning/effort level for the next turn. Mapped per-CLI in Rust (Codex
 *  `model_reasoning_effort`, Copilot `--effort`, Claude a thinking keyword). The
 *  gauge icon marks it as effort so the collapsed value isn't mistaken for a model. */
export function EffortPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (e: string) => void;
}) {
  return (
    <Select
      value={value || DEFAULT_EFFORT}
      onValueChange={(v) => onChange(v === DEFAULT_EFFORT ? "" : String(v))}
    >
      <SelectTrigger
        size="sm"
        aria-label="Reasoning effort"
        className="w-auto gap-1 border-0 text-muted-foreground shadow-none hover:bg-muted dark:bg-transparent"
      >
        <GaugeIcon className="size-3.5" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT_EFFORT}>Default</SelectItem>
        {EFFORT_LEVELS.map((l) => (
          <SelectItem key={l.value} value={l.value}>
            {l.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** How a new task runs: one session, or best-of-N across several arms. */
export type RunMode = "single" | "ensemble";

/** A compact inline segmented control (radio-group of buttons). Used inside the
 *  composer Options popover for run mode, effort, and isolation — no nested
 *  dropdown, fully keyboard-operable: the ARIA radiogroup pattern, so the group is
 *  ONE tab stop (roving tabindex on the checked option) and the arrow keys move the
 *  selection with focus following it. Clicking is unchanged. */
function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  describedBy,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  ariaLabel: string;
  /** Id of a caveat rendered beside the group (e.g. the Isolation readiness note),
   *  so arrowing between options announces the warning with the selection. */
  describedBy?: string;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  // The tab stop. A value outside `options` (shouldn't happen) still leaves the
  // group reachable rather than trapping the keyboard past it.
  const checked = options.findIndex((o) => o.value === value);
  const roving = checked < 0 ? 0 : checked;

  // Arrow keys select-and-focus the neighbour, wrapping at the ends. The buttons
  // are stable DOM children, so the new target can be focused straight away — the
  // re-render then hands it the tab stop.
  const move = (delta: number) => {
    const next = (roving + delta + options.length) % options.length;
    onChange(options[next].value);
    const btn = groupRef.current?.children[next];
    if (btn instanceof HTMLElement) btn.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    }
  };

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      className="flex overflow-hidden rounded-none border border-input"
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={i === roving ? 0 : -1}
          onClick={() => onChange(o.value)}
          onKeyDown={onKeyDown}
          className={cn(
            "flex-1 px-1.5 py-1 text-[11px] transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring",
            i > 0 && "border-l border-input",
            value === o.value
              ? "bg-accent font-medium text-accent-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const EFFORT_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Auto" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Med" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Max" },
];

const RUN_MODE_OPTIONS: { value: RunMode; label: string }[] = [
  { value: "single", label: "Single" },
  { value: "ensemble", label: "Best-of-N" },
];

/** How a NEW session is sandboxed: a throwaway worktree on the host, or that
 *  worktree inside an ephemeral container. Fixed once the session starts. */
export type Isolation = "worktree" | "container";

const ISOLATION_OPTIONS: { value: Isolation; label: string }[] = [
  { value: "worktree", label: "Worktree" },
  { value: "container", label: "Container" },
];

/** A one-line caveat under the Isolation control — a readiness warning for
 *  container, or the host-downgrade disclosure. Computed by the call site (this
 *  module stays presentational). */
export interface IsolationNote {
  tone: "warn" | "muted";
  text: string;
  /** Offer a jump to Settings → AI (where the runtime/image is set up). */
  settingsAction?: boolean;
}

function effortLabel(value: string): string {
  return EFFORT_OPTIONS.find((o) => o.value === value)?.label ?? "Auto";
}

function isolationLabel(value: Isolation): string {
  return ISOLATION_OPTIONS.find((o) => o.value === value)?.label ?? "Worktree";
}

/** A labeled field row inside the Options popover. */
function OptionField({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        {icon}
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * The composer's collapsed "Options" popover. Provider + model stay inline on the
 * toolbar for quick access; everything else — run mode, reasoning effort, the
 * per-session isolation override, and the per-session MCP-server opt-in — lives
 * here so the action row never overflows or shifts as the box grows. Each control
 * renders only when the parent passes its props: run mode + isolation are
 * new-session only; effort drops out in best-of-N (each arm sets its own), while the
 * MCP selection stays and is SHARED across every arm; MCP self-hides when no servers
 * are registered. Isolation sits directly above MCP
 * because it gates it (Codex runs MCP only in a container), so the dependency reads
 * top-down. The trigger shows a count + summary tooltip of the non-default choices
 * so collapsing them stays discoverable. MCP rules (frozen at turn 1 for a new
 * session, strict "only these" for Claude, the container/host caveats) are
 * unchanged — see the call site.
 */
export function ComposerOptions({
  effort,
  onEffort,
  mode,
  onMode,
  isolation,
  mcp,
}: {
  effort?: string;
  onEffort?: (e: string) => void;
  mode?: RunMode;
  onMode?: (m: RunMode) => void;
  /** New-session isolation override. `isOverride` = the pick differs from the
   *  global setting (that's what the badge counts); `note` is the caller-computed
   *  readiness warning / host-downgrade disclosure. `onSettingsAction` runs the
   *  note's "Set up in Settings…" jump — the caller owns it because navigating
   *  unmounts the composer, so it has to stash its draft first. */
  isolation?: {
    value: Isolation;
    onChange: (v: Isolation) => void;
    isOverride: boolean;
    note?: IsolationNote;
    onSettingsAction?: () => void;
  };
  mcp?: {
    servers: McpServer[];
    value: string[];
    onChange: (ids: string[]) => void;
    disabledReason?: string;
  };
}) {
  const openSettings = useUiStore((s) => s.openSettings);
  // Links the Isolation caveat to its radiogroup (announced with the selection).
  const isolationNoteId = useId();

  const mcpListable = mcp && !mcp.disabledReason && mcp.servers.length > 0;
  const mcpCount = mcpListable
    ? mcp.servers.filter((s) => mcp.value.includes(s.id)).length
    : 0;

  // A summary of the non-default choices, surfaced as a count badge + tooltip so
  // the collapsed state reads at a glance without opening the popover.
  const summary: string[] = [];
  if (mode === "ensemble") summary.push("Best-of-N");
  if (effort) summary.push(`Effort: ${effortLabel(effort)}`);
  // Only an EXPLICIT pick that differs from the global setting counts — following
  // Settings → AI isn't a choice the user made here.
  if (isolation?.isOverride)
    summary.push(`Isolation: ${isolationLabel(isolation.value)}`);
  if (mcpCount > 0)
    summary.push(`${mcpCount} MCP server${mcpCount > 1 ? "s" : ""}`);
  const count = summary.length;

  const toggleMcp = (id: string, on: boolean) =>
    mcp?.onChange(on ? [...mcp.value, id] : mcp.value.filter((v) => v !== id));

  return (
    <Popover>
      <PopoverTrigger
        title={count > 0 ? summary.join(" · ") : "Run options"}
        render={
          <Button
            size="sm"
            variant="ghost"
            aria-label="Run options"
            className="gap-1 border-0 text-muted-foreground shadow-none hover:bg-muted dark:bg-transparent"
          />
        }
      >
        <GearSixIcon className="size-3.5" />
        Options
        {count > 0 && (
          <span className="ml-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-primary/15 px-1 text-[10px] font-medium text-primary tabular-nums">
            {count}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <div className="flex flex-col gap-3">
          {mode !== undefined && onMode && (
            <OptionField
              icon={<UsersThreeIcon className="size-3.5" />}
              label="Run mode"
            >
              <Segmented
                ariaLabel="Run mode"
                value={mode}
                onChange={onMode}
                options={RUN_MODE_OPTIONS}
              />
            </OptionField>
          )}
          {effort !== undefined && onEffort && (
            <OptionField
              icon={<GaugeIcon className="size-3.5" />}
              label="Reasoning effort"
            >
              <Segmented
                ariaLabel="Reasoning effort"
                value={effort}
                onChange={onEffort}
                options={EFFORT_OPTIONS}
              />
            </OptionField>
          )}
          {isolation && (
            <OptionField
              icon={<ShieldCheckIcon className="size-3.5" />}
              label="Isolation"
            >
              <Segmented
                ariaLabel="Isolation"
                value={isolation.value}
                onChange={isolation.onChange}
                options={ISOLATION_OPTIONS}
                describedBy={isolation.note ? isolationNoteId : undefined}
              />
              {isolation.note && (
                <p
                  id={isolationNoteId}
                  className={cn(
                    "flex items-start gap-1.5 text-[11px]",
                    isolation.note.tone === "warn"
                      ? "text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {/* Icon + text, never color alone. */}
                  {isolation.note.tone === "warn" && (
                    <WarningCircleIcon
                      weight="fill"
                      className="mt-px size-3.5 shrink-0"
                      aria-hidden
                    />
                  )}
                  <span>{isolation.note.text}</span>
                </p>
              )}
              {isolation.note?.settingsAction && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 justify-start text-muted-foreground"
                  onClick={() =>
                    isolation.onSettingsAction
                      ? isolation.onSettingsAction()
                      : openSettings("ai")
                  }
                >
                  Set up in Settings…
                </Button>
              )}
            </OptionField>
          )}
          {mcp?.disabledReason ? (
            <OptionField
              icon={<PlugsConnectedIcon className="size-3.5" />}
              label="MCP servers"
            >
              <p className="text-[11px] text-muted-foreground">
                {mcp.disabledReason}
              </p>
            </OptionField>
          ) : mcpListable ? (
            <OptionField
              icon={<PlugsConnectedIcon className="size-3.5" />}
              label="MCP servers"
            >
              <div className="flex flex-col gap-0.5">
                {mcp.servers.map((s) => (
                  <label
                    key={s.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-muted"
                  >
                    <Checkbox
                      checked={mcp.value.includes(s.id)}
                      onCheckedChange={(on) => toggleMcp(s.id, on === true)}
                    />
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-xs"
                      title={s.name}
                    >
                      {s.name}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground uppercase">
                      {s.transport}
                    </span>
                  </label>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-0.5 h-7 justify-start text-muted-foreground"
                  onClick={() => openSettings("mcp-servers")}
                >
                  Manage servers…
                </Button>
              </div>
            </OptionField>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Picks the CLI for a NEW session (fixed once it starts). Every agent runs either
 *  way — host (worktree-confined; Codex adds its own OS-enforced sandbox) or
 *  container, provided that agent is baked into the image. Only Codex's MCP support
 *  is container-only. Reused by the plan composer and the best-of-N arm editor. */
export function AgentPicker({
  value,
  onChange,
}: {
  value: AgentKind;
  onChange: (a: AgentKind) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) =>
        onChange(
          v === "copilot"
            ? "copilot"
            : v === "codex"
              ? "codex"
              : v === "opencode"
                ? "opencode"
                : "claude",
        )
      }
    >
      <SelectTrigger
        size="sm"
        aria-label="Agent"
        className="w-auto border-0 text-muted-foreground shadow-none hover:bg-muted dark:bg-transparent"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="claude">Claude</SelectItem>
        <SelectItem value="codex">Codex</SelectItem>
        <SelectItem value="copilot">GitHub Copilot</SelectItem>
        <SelectItem value="opencode">opencode</SelectItem>
      </SelectContent>
    </Select>
  );
}
