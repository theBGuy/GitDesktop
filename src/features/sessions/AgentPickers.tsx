import {
  GaugeIcon,
  GearSixIcon,
  PlugsConnectedIcon,
  ShieldCheckIcon,
  UsersThreeIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
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
import { type AgentKind, isAgentKind } from "@/lib/ai/agent";
import {
  EFFORT_UNAVAILABLE_SUFFIX,
  type EffortControlState,
  effortSelectItems,
  useEffortControl,
} from "@/lib/ai/effort-levels";
import { modelPickerEmptyText, useAgentModels } from "@/lib/ai/models";
import { EFFORT_LEVEL_LABELS, EFFORT_LEVELS } from "@/lib/ai/review-effort";
import { hasChordModifier } from "@/lib/hotkeys/binding";
import type { McpServer } from "@/lib/settings/api";
import { useUiStore } from "@/lib/stores/ui";
import {
  ARIA_DISABLED_CLASS,
  useDisabledReason,
} from "@/lib/use-disabled-reason";
import { cn } from "@/lib/utils";

// The agent / model / effort pickers, shared by the task composer, the plan
// composer, the plan's Implement popover, and the best-of-N arm editor. Kept in
// their own module so those surfaces don't import each other (the composer imports
// the ensemble dialog, which needs the pickers — a cycle if they lived together).

/** Compact display labels for each agent CLI — for list rows, headers, badges. */
export const AGENT_LABELS: Record<AgentKind, string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "Copilot",
  opencode: "opencode",
};

/** The warning shown when a container session's agent isn't baked into the image.
 *  One source so the composer's isolation note and the best-of-N arms can't drift. */
export function imageMissingAgentText(agent: AgentKind): string {
  return `The agent image wasn't built with ${AGENT_LABELS[agent]} — add it under Settings → AI and rebuild.`;
}

/** The model for a run: the agent's models are searchable — its live catalog
 *  where the CLI can list one (opencode, Codex, Copilot), else that CLI's static
 *  suggestions — and any other id typed here reaches the CLI verbatim (custom
 *  providers publish ids no static list can carry). `""` is the account default
 *  and shows the placeholder. */
export function ModelPicker({
  value,
  onChange,
  agent,
}: {
  value: string;
  onChange: (m: string) => void;
  agent: AgentKind;
}) {
  // Listing a CLI's catalog spawns it, so the probe waits for intent to pick a
  // model — sticky, so the list stays put for the rest of the picker's life.
  const [wanted, setWanted] = useState(false);
  // Agent-tab-scoped by design, a backstop: every call site renders under the agent
  // tab's <Activity>, whose hidden subtree already fetches nothing.
  const agentTabShowing = useUiStore((s) => s.repoTab === "agent");
  const available = useAgentModels(agent, {
    enabled: wanted && agentTabShowing,
  });
  // Verbatim: the CLI orders its own catalog (opencode puts its providers
  // first, codex sorts by priority), and the fallback is that CLI's static
  // suggestions.
  const models = available.data?.models ?? [];

  return (
    <Combobox
      items={models}
      // The input text is the source of truth — a typed id needs no match.
      inputValue={value}
      onInputValueChange={(model) => onChange(model)}
      // UNCLAMPED on purpose: Base UI syncs the input to the selected item's
      // label as the popup finishes closing, and a null selection syncs it to
      // "" — clamping to the suggestion list would wipe a typed id on close.
      value={value || null}
      onValueChange={(model) => {
        if (model) onChange(model);
      }}
      openOnInputClick
      onOpenChange={(open) => {
        if (open) setWanted(true);
      }}
    >
      {/* Composer-toolbar weight: quiet until focus, matching the sibling
          Select-based pickers on the same row. */}
      <ComboboxInput
        aria-label="Agent model"
        placeholder="Default model"
        // Long ids outrun the capped width with the caret hiding the tail, and
        // an input has no truncation tooltip of its own.
        title={value || undefined}
        className="h-7 w-auto max-w-44 min-w-28 border-transparent text-muted-foreground hover:bg-muted dark:bg-transparent"
        onFocus={() => setWanted(true)}
      />
      {/* The input is narrow, so the default `w-(--anchor-width)` popup clips
          long ids (e.g. `opencode/…`). Size to content, capped on-screen. */}
      <ComboboxContent className="w-fit max-w-sm">
        <ComboboxEmpty>
          {modelPickerEmptyText(available.isFetching)}
        </ComboboxEmpty>
        {/* Render FUNCTION, not static rows: only this form maps the store's
            filtered items, so static children would never narrow as you type. */}
        <ComboboxList>
          {(model: string) => (
            <ComboboxItem key={model} value={model}>
              <span className="truncate font-mono">{model}</span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

const DEFAULT_EFFORT = "default";

/** The effort Select's no-level row. Labels come from `effortSelectItems`:
 *  without an `items` map Base UI shows the raw stored value ("xhigh") in the
 *  trigger, and the popup renders from the same map so the two can never drift. */
const DEFAULT_EFFORT_ITEM = { key: DEFAULT_EFFORT, label: "Default" };

/** Reasoning/effort level for the next turn. Mapped per-CLI in Rust (Codex
 *  `model_reasoning_effort`, Copilot `--effort`, Claude a thinking keyword). The
 *  gauge icon marks it as effort so the collapsed value isn't mistaken for a model.
 *  With a `control`, blocked levels stay listed as disabled `(unavailable)` rows
 *  and the stored level is kept; a whole-blocked picker is held by readOnly + a
 *  gated open state, never Base UI's `disabled`, which drops it from the tab
 *  order. `describedBy` names the caller's line, passed only while it renders. */
export function EffortPicker({
  value,
  onChange,
  control,
  describedBy,
}: {
  value: string;
  onChange: (e: string) => void;
  control?: EffortControlState;
  describedBy?: string;
}) {
  const items = effortSelectItems(DEFAULT_EFFORT_ITEM, control);
  const held = control?.allBlocked ?? false;
  const [open, setOpen] = useState(false);
  if (held && open) setOpen(false);
  return (
    <Select
      items={items}
      value={value || DEFAULT_EFFORT}
      // Defense in depth: Base UI also commits through paths with no disabled
      // check (its hidden-input autofill), so a blocked level is refused here.
      onValueChange={(v) => {
        const next = v === DEFAULT_EFFORT ? "" : String(v);
        if (next === value || control?.blocked[next] !== undefined) return;
        onChange(next);
      }}
      readOnly={held}
      open={open}
      onOpenChange={(next) => {
        if (!held) setOpen(next);
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label="Reasoning effort"
        aria-disabled={held || undefined}
        aria-describedby={describedBy}
        className={cn(
          "w-auto gap-1 border-0 text-muted-foreground shadow-none hover:bg-muted dark:bg-transparent",
          ARIA_DISABLED_CLASS,
        )}
      >
        <GaugeIcon className="size-3.5" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="min-w-48">
        {Object.entries(items).map(([level, label]) => (
          <SelectItem
            key={level}
            value={level}
            disabled={
              control?.blocked[level === DEFAULT_EFFORT ? "" : level] !==
              undefined
            }
          >
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The one-line caveat under a picker (the Isolation readiness note, an effort
 *  reason): `warn` = full-contrast text + filled icon, `muted` = muted text. */
function CaveatLine({
  id,
  tone,
  text,
}: {
  id: string;
  tone: "warn" | "muted";
  text: string;
}) {
  return (
    <p
      id={id}
      className={cn(
        "flex items-start gap-1.5 text-[11px]",
        tone === "warn" ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {/* Icon + text, never color alone. */}
      {tone === "warn" && (
        <WarningCircleIcon
          weight="fill"
          className="mt-px size-3.5 shrink-0"
          aria-hidden
        />
      )}
      <span className="min-w-0 break-words">{text}</span>
    </p>
  );
}

/** The effort control's reason line, or nothing for a null line. Its id is the
 *  control's `aria-describedby` only while it renders. */
export function EffortNote({
  id,
  line,
}: {
  id: string;
  line: EffortControlState["line"];
}) {
  if (!line) return null;
  return <CaveatLine id={id} tone={line.tone} text={line.text} />;
}

/** How a new task runs: one session, or best-of-N across several arms. */
export type RunMode = "single" | "ensemble";

/** A compact inline segmented control (radio-group of buttons). Used inside the
 *  composer Options popover for run mode, effort, and isolation — no nested
 *  dropdown, fully keyboard-operable: the ARIA radiogroup pattern, so the group is
 *  ONE tab stop (roving tabindex on the checked option) and the arrow keys move the
 *  selection with focus following it. Clicking is unchanged. */
interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Why the option can't be picked: it stays in place, focusable but inert. */
  blockedReason?: string;
  /** Ends a blocked option's accessible name with "(unavailable)". */
  markBlocked?: boolean;
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  describedBy,
  held = false,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentedOption<T>[];
  ariaLabel: string;
  /** Id of a caveat rendered beside the group (e.g. the Isolation readiness note),
   *  so arrowing between options announces the warning with the selection. */
  describedBy?: string;
  /** Every option is blocked for one reason, which the group's description
   *  carries: options then render no reason node of their own. */
  held?: boolean;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const open = (i: number) => options[i].blockedReason === undefined;
  // The tab stop: the checked option (even a blocked one, so a stored level
  // stays reachable), else the first open one. A value outside `options` still
  // leaves the group reachable rather than trapping the keyboard past it.
  const checked = options.findIndex((o) => o.value === value);
  const firstOpen = options.findIndex((o) => o.blockedReason === undefined);
  const roving = checked >= 0 ? checked : Math.max(firstOpen, 0);

  // Arrow keys select-and-focus the next open option in the pressed direction,
  // wrapping at the ends; with none, the press changes nothing. The buttons are
  // stable, so the target can be focused straight away; the re-render then hands
  // it the tab stop.
  const move = (delta: number) => {
    const n = options.length;
    for (let step = 1; step < n; step++) {
      const next = (((roving + delta * step) % n) + n) % n;
      if (!open(next)) continue;
      onChange(options[next].value);
      const btn = groupRef.current?.querySelectorAll('[role="radio"]')[next];
      if (btn instanceof HTMLElement) btn.focus();
      return;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    // A chorded arrow belongs to the app's shortcut listener.
    if (hasChordModifier(e)) return;
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
      aria-disabled={held || undefined}
      className="flex overflow-hidden rounded-none border border-input"
    >
      {options.map((o, i) => (
        <SegmentedButton
          key={o.value}
          option={o}
          first={i === 0}
          checked={value === o.value}
          tabStop={i === roving}
          held={held}
          onPick={() => onChange(o.value)}
          onKeyDown={onKeyDown}
        />
      ))}
    </div>
  );
}

/** One radio of `Segmented`, its own component so the disabled-reason hook runs
 *  per option. A blocked option is `aria-disabled` (never native `disabled`, so
 *  it keeps focus); the hook withholds its click, which a raw button's Enter and
 *  Space arrive as. */
function SegmentedButton<T extends string>({
  option,
  first,
  checked,
  tabStop,
  held,
  onPick,
  onKeyDown,
}: {
  option: SegmentedOption<T>;
  first: boolean;
  checked: boolean;
  tabStop: boolean;
  held: boolean;
  onPick: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const blocked = option.blockedReason !== undefined;
  const reason = useDisabledReason({
    disabled: blocked,
    reason: option.blockedReason,
    onClick: onPick,
  });
  return (
    <span
      className={cn(
        "flex flex-1",
        !first && "border-l border-input",
        blocked && "cursor-not-allowed",
      )}
      title={reason.wrapperTitle}
    >
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        tabIndex={tabStop ? 0 : -1}
        onKeyDown={onKeyDown}
        {...reason.nativeProps}
        // Held: the group's description already is every option's reason.
        aria-describedby={held ? undefined : reason.describedBy}
        aria-label={
          blocked && option.markBlocked
            ? `${option.label}${EFFORT_UNAVAILABLE_SUFFIX}`
            : undefined
        }
        className={cn(
          "flex-1 px-1.5 py-1 text-[11px] transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring",
          ARIA_DISABLED_CLASS,
          checked
            ? "bg-accent font-medium text-accent-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        {/* Struck through as the non-color mark of a level this model lacks. */}
        <span className={cn(blocked && !held && "line-through")}>
          {option.label}
        </span>
      </button>
      {/* `hidden` rather than sr-only: a description may point at hidden text,
          and an sr-only sibling would be read again as page text. */}
      {!held && reason.blockedReason !== null && (
        <span id={reason.reasonId} hidden>
          {reason.blockedReason}
        </span>
      )}
    </span>
  );
}

/** The empty value is this surface's "no level" row — the composer stores an
 *  absent effort as `""`, not the Select's `"default"` sentinel. */
const EFFORT_OPTIONS: SegmentedOption<string>[] = [
  { value: "", label: "Auto" },
  ...EFFORT_LEVELS.map((value) => ({
    value,
    label: EFFORT_LEVEL_LABELS[value],
  })),
];

/** The effort radios for a control state. Only the four levels take the
 *  "(unavailable)" mark; the no-level option is held with them, never marked. */
function effortOptions(
  control: EffortControlState | undefined,
): SegmentedOption<string>[] {
  if (!control) return EFFORT_OPTIONS;
  return EFFORT_OPTIONS.map((o) => {
    const blockedReason = control.blocked[o.value];
    return blockedReason === undefined
      ? o
      : { ...o, blockedReason, markBlocked: o.value !== "" };
  });
}

/** The Options popover's effort row. `control` absent = today's control. */
function EffortField({
  value,
  onChange,
  control,
}: {
  value: string;
  onChange: (e: string) => void;
  control?: EffortControlState;
}) {
  const noteId = useId();
  const line = control?.line ?? null;
  return (
    <OptionField
      icon={<GaugeIcon className="size-3.5" />}
      label="Reasoning effort"
    >
      <Segmented
        ariaLabel="Reasoning effort"
        value={value}
        onChange={onChange}
        options={effortOptions(control)}
        held={control?.allBlocked}
        describedBy={line ? noteId : undefined}
      />
      <EffortNote id={noteId} line={line} />
    </OptionField>
  );
}

/** The effort row asking which levels the model offers. Mounts with the
 *  popover's content, so the CLI is spawned only once Options opens. */
function EffortFieldForModel({
  value,
  onChange,
  effortFor,
}: {
  value: string;
  onChange: (e: string) => void;
  effortFor: EffortFor;
}) {
  // A null isolation asks nothing yet; the same field stays mounted, so a
  // focused radio keeps focus when the isolation resolves.
  const control = useEffortControl(
    effortFor.isolation === null
      ? null
      : {
          kind: effortFor.agent,
          binPath: null,
          model: effortFor.model,
          isolation: effortFor.isolation,
        },
    value,
  );
  return <EffortField value={value} onChange={onChange} control={control} />;
}

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
/** What the composer's run would pass, so the effort row can ask which levels
 *  the model offers. `isolation` is null while it isn't known yet. */
interface EffortFor {
  agent: AgentKind;
  model: string;
  isolation: Isolation | null;
}

export function ComposerOptions({
  effort,
  onEffort,
  effortFor,
  mode,
  onMode,
  isolation,
  mcp,
}: {
  effort?: string;
  onEffort?: (e: string) => void;
  /** Turns on the per-model effort state. Absent = today's effort control. */
  effortFor?: EffortFor;
  mode?: RunMode;
  onMode?: (m: RunMode) => void;
  /** New-session isolation override. `isOverride` = the pick differs from the
   *  global setting (that's what the badge counts); `note` is the caller-computed
   *  readiness warning / host-downgrade disclosure. `onSettingsAction` runs the
   *  note's "Set up in Settings…" jump and is REQUIRED — navigating unmounts the
   *  composer, so the caller must stash its start-state first; a convenience
   *  fallback here would silently reintroduce that state loss. */
  isolation?: {
    value: Isolation;
    onChange: (v: Isolation) => void;
    isOverride: boolean;
    note?: IsolationNote;
    onSettingsAction: () => void;
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
          {effort !== undefined &&
            onEffort &&
            (effortFor ? (
              <EffortFieldForModel
                value={effort}
                onChange={onEffort}
                effortFor={effortFor}
              />
            ) : (
              <EffortField value={effort} onChange={onEffort} />
            ))}
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
                <CaveatLine
                  id={isolationNoteId}
                  tone={isolation.note.tone}
                  text={isolation.note.text}
                />
              )}
              {isolation.note?.settingsAction && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 justify-start text-muted-foreground"
                  onClick={isolation.onSettingsAction}
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

/** Trigger + popup labels for the agent Select. Deliberately not AGENT_LABELS:
 *  this picker spells Copilot out ("GitHub Copilot") where the compact list-row
 *  label doesn't. One source so the trigger can never drift from the popup. */
const AGENT_PICKER_ITEMS: Record<AgentKind, string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "GitHub Copilot",
  opencode: "opencode",
};

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
      items={AGENT_PICKER_ITEMS}
      value={value}
      onValueChange={(v) => onChange(isAgentKind(v) ? v : "claude")}
    >
      <SelectTrigger
        size="sm"
        aria-label="Agent"
        className="w-auto border-0 text-muted-foreground shadow-none hover:bg-muted dark:bg-transparent"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Object.entries(AGENT_PICKER_ITEMS).map(([kind, label]) => (
          <SelectItem key={kind} value={kind}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
