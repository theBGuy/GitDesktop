import type { AgentCommand } from "@/lib/git/api";
import type { CustomCommand } from "@/lib/settings/api";

/**
 * An item in the agent composer's `/` menu. Three kinds:
 * - `command` — a prompt template. No agent CLI parses `/command` in headless
 *   (`-p`/`exec`) mode, so we expand it client-side (`$ARGUMENTS`, `$1`..`$9`)
 *   and send the result.
 * - `skill` — an Agent Skill dir. We DON'T inline its body: the CLI already
 *   loaded the real skill from disk, so we nudge it by name.
 * - `native` — a built-in command of the SELECTED CLI; delivery is per-CLI
 *   (see NATIVE_COMMANDS).
 * Sources: `builtin`, `agent` (discovered from the selected CLI's command/skill
 * dirs incl. the neutral `.agents/skills` store), `custom` (user-defined, edited
 * under Settings → Slash commands) — merged by name with the precedence
 * documented on `mergeCommands`.
 */
export interface SlashCommand {
  name: string;
  description: string;
  /** Template body for commands; empty for skills, native and actions. */
  prompt: string;
  kind: "command" | "skill" | "native";
  source: "builtin" | "agent" | "custom";
  /** Where a discovered command/skill lives. */
  scope?: "project" | "global";
  /** Hint shown after the name in the menu, e.g. `[file]`. */
  argumentHint?: string;
  /** Built-in actions run instead of sending a prompt. */
  action?: "clear";
}

/** Starter commands every session gets. Tuned for an agent working in a
 *  throwaway worktree (it can read the diff and the tree). `$ARGUMENTS` sits on
 *  a trailing line so each reads cleanly with or without arguments. */
export const BUILTIN_COMMANDS: SlashCommand[] = [
  {
    name: "review",
    kind: "command",
    source: "builtin",
    argumentHint: "[optional focus]",
    description: "Review the working changes for bugs and clarity",
    prompt:
      "Review the changes in this worktree for correctness, bugs, edge cases, and clarity. Call out anything risky and suggest concrete fixes.\n\n$ARGUMENTS",
  },
  {
    name: "test",
    kind: "command",
    source: "builtin",
    argumentHint: "[file or behavior]",
    description: "Write tests covering edge cases",
    prompt:
      "Write thorough tests, covering edge cases and failure modes, for the following. Match the project's existing test style and run them.\n\n$ARGUMENTS",
  },
  {
    name: "fix",
    kind: "command",
    source: "builtin",
    argumentHint: "[describe the issue]",
    description: "Diagnose and fix an issue",
    prompt:
      "Find and fix the following issue. Explain the root cause first, then make the change.\n\n$ARGUMENTS",
  },
  {
    name: "explain",
    kind: "command",
    source: "builtin",
    argumentHint: "[file or symbol]",
    description: "Explain how something works",
    prompt:
      "Explain how the following works, step by step, citing the relevant files and lines.\n\n$ARGUMENTS",
  },
  {
    name: "refactor",
    kind: "command",
    source: "builtin",
    argumentHint: "[file or symbol]",
    description: "Refactor without changing behavior",
    prompt:
      "Refactor the following for readability and maintainability without changing behavior. Keep the diff focused.\n\n$ARGUMENTS",
  },
  {
    name: "clear",
    kind: "command",
    source: "builtin",
    description: "Clear the message box",
    prompt: "",
    action: "clear",
  },
];

/**
 * A curated subset of each CLI's OWN commands (the full lists are large and
 * mostly interactive-TUI only). Delivery differs because not all CLIs resolve
 * `/name` in headless mode:
 * - **Claude, Copilot** parse `/name` in `-p` — passed through verbatim (no
 *   `prompt`) so the CLI runs its real command, incl. agent-backed ones like
 *   Copilot's `/review`.
 * - **Codex** (`codex exec`) / **opencode** (`opencode run`) do NOT — `/name`
 *   reaches the model as plain text, so those entries carry a `prompt` template
 *   we expand instead. (opencode's `--command` would run them natively — deferred.)
 * These override a same-named builtin for that agent; a user's own entry wins.
 */
const NATIVE_COMMANDS: Record<
  string,
  {
    name: string;
    description: string;
    argumentHint?: string;
    prompt?: string;
  }[]
> = {
  claude: [
    {
      name: "init",
      description: "Generate an AGENTS.md / CLAUDE.md for this project",
    },
    {
      name: "security-review",
      description: "Review the changes for security issues",
      argumentHint: "[optional focus]",
    },
    {
      name: "pr-comments",
      description: "Fetch and summarize this PR's review comments",
    },
  ],
  copilot: [
    {
      name: "review",
      description: "Run Copilot's code-review agent on the changes",
      argumentHint: "[optional focus]",
    },
    {
      name: "security-review",
      description: "Run Copilot's security-review agent",
    },
    {
      name: "init",
      description: "Generate .github/copilot-instructions.md from the codebase",
    },
    {
      name: "plan",
      description: "Produce an implementation plan before coding",
      argumentHint: "[task]",
    },
  ],
  codex: [
    {
      name: "init",
      description: "Generate an AGENTS.md for this project",
      prompt:
        "Create an AGENTS.md for this project: summarize the build, test, and lint commands, the layout, and the key conventions a coding agent should follow. Keep it concise.\n\n$ARGUMENTS",
    },
    {
      name: "plan",
      description: "Produce an implementation plan before coding",
      argumentHint: "[task]",
      prompt:
        "Produce a detailed, step-by-step implementation plan for the following before writing any code — list the files to touch and the order of changes.\n\n$ARGUMENTS",
    },
  ],
  opencode: [
    {
      name: "init",
      description: "Generate an AGENTS.md for this project",
      prompt:
        "Create an AGENTS.md for this project: summarize the build, test, and lint commands, the layout, and the key conventions a coding agent should follow. Keep it concise.\n\n$ARGUMENTS",
    },
  ],
};

// A `/name` invocation: the name, then (after whitespace) the rest as args.
// Names are letters/digits then word chars or hyphens; `/etc/hosts …` won't
// match (no whitespace after the name), so genuine paths are sent literally.
const INVOCATION_RE = /^\/([a-zA-Z0-9][\w-]*)(?:\s+([\s\S]*))?$/;

/** Parses a `/name args…` invocation from the (trimmed) draft, or null. */
export function parseSlashInvocation(
  text: string,
): { name: string; args: string } | null {
  const m = INVOCATION_RE.exec(text);
  if (!m) return null;
  return { name: m[1], args: m[2] ?? "" };
}

/** Finds a command/skill by name, case-insensitively (first match wins). */
export function findCommand(
  commands: SlashCommand[],
  name: string,
): SlashCommand | undefined {
  const n = name.toLowerCase();
  return commands.find((c) => c.name.toLowerCase() === n);
}

/** Builds the final prompt for a picked entry: skills get a by-name nudge (the
 *  CLI loads the real skill from disk); a native entry without a template passes
 *  `/name args` through verbatim; everything else goes through `expandCommand`. */
export function buildPrompt(cmd: SlashCommand, args: string): string {
  const trimmed = args.trim();
  if (cmd.kind === "skill") {
    const nudge = `Use the "${cmd.name}" skill.`;
    return trimmed ? `${nudge}\n\n${trimmed}` : nudge;
  }
  if (cmd.kind === "native") {
    // Template ⇒ Codex/opencode (no headless `/name`): send as an instruction.
    // Otherwise pass the CLI's own command through for Claude/Copilot to run.
    if (cmd.prompt) return expandCommand(cmd, args);
    return trimmed ? `/${cmd.name} ${trimmed}` : `/${cmd.name}`;
  }
  return expandCommand(cmd, args);
}

/**
 * Expands a command template against the user's argument string. Substitutes
 * `$ARGUMENTS` (the full args) and `$1`..`$9` (whitespace-split tokens). If the
 * template has no placeholder, non-empty args are appended as a trailing
 * paragraph so a bare `/cmd extra text` still carries the extra instruction.
 */
export function expandCommand(cmd: SlashCommand, args: string): string {
  const trimmed = args.trim();
  // `\b` so `$1` matches only as a whole token — a literal `$10` (a price) or
  // `$12` stays intact instead of being read as `$1` + "0".
  const hasPlaceholder =
    /\$ARGUMENTS\b/.test(cmd.prompt) || /\$[1-9]\b/.test(cmd.prompt);
  let out = cmd.prompt;
  if (hasPlaceholder) {
    const tokens = trimmed ? trimmed.split(/\s+/) : [];
    out = out
      .replace(/\$ARGUMENTS\b/g, trimmed)
      .replace(/\$([1-9])\b/g, (_, d: string) => tokens[Number(d) - 1] ?? "");
  } else if (trimmed) {
    out = `${out}\n\n${trimmed}`;
  }
  return out.trim();
}

/** Merges built-ins + the agent's native commands + the agent's discovered
 *  commands/skills + the user's custom commands into one menu, deduped by NAME
 *  (one entry per `/name`) with precedence custom > discovered > native >
 *  builtin. Inserting low→high means a later same-name entry wins while the
 *  Map keeps the original menu position. */
export function mergeCommands(
  discovered: AgentCommand[],
  custom: CustomCommand[],
  agent: string,
): SlashCommand[] {
  const byName = new Map<string, SlashCommand>();
  for (const c of BUILTIN_COMMANDS) byName.set(c.name.toLowerCase(), c);
  for (const n of NATIVE_COMMANDS[agent] ?? []) {
    byName.set(n.name.toLowerCase(), {
      name: n.name,
      description: n.description,
      prompt: n.prompt ?? "",
      kind: "native",
      source: "builtin",
      argumentHint: n.argumentHint,
    });
  }
  for (const c of discovered) {
    if (!c.name.trim()) continue;
    byName.set(c.name.toLowerCase(), {
      name: c.name,
      description: c.description,
      prompt: c.prompt,
      kind: c.kind,
      source: "agent",
      scope: c.scope,
      argumentHint: c.argumentHint || undefined,
    });
  }
  for (const c of custom) {
    const name = c.name.trim();
    if (!name) continue;
    byName.set(name.toLowerCase(), {
      name,
      description: c.description,
      prompt: c.prompt,
      kind: "command",
      source: "custom",
    });
  }
  return [...byName.values()];
}

/** Filters + ranks for the menu: name-prefix matches first, then substring
 *  matches, each group keeping its original order. */
export function filterCommands(
  commands: SlashCommand[],
  query: string,
): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return commands;
  const prefix: SlashCommand[] = [];
  const contains: SlashCommand[] = [];
  for (const c of commands) {
    const n = c.name.toLowerCase();
    if (n.startsWith(q)) prefix.push(c);
    else if (n.includes(q)) contains.push(c);
  }
  return [...prefix, ...contains];
}
