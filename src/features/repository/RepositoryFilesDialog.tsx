import { WarningIcon } from "@phosphor-icons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Badge } from "@/components/ui/badge";
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
import { Spinner } from "@/components/ui/spinner";
import {
  aiExcludePatternLinesForPath,
  globLiteralPath,
  literalPathspec,
  trimIgnorePattern,
} from "@/lib/git/glob";
import {
  useAiExcludedView,
  useAppendRepoAiIgnore,
  useForceAdd,
  useIgnoredFiles,
  useRemoveRepoAiIgnore,
  useTrackedFiles,
  useUnignoreRules,
  useUntrack,
} from "@/lib/git/queries";
import type { AiIgnoreVerdict, IgnoredFile } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import {
  useAiEnabled,
  useSaveSettings,
  useSettings,
} from "@/lib/settings/queries";
import { ignoreToast, toastError, toastErrorWithNote } from "@/lib/toast";
import { useRetained } from "@/lib/use-retained";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import { cn } from "@/lib/utils";

/** Which list the dialog opens on — exported for the palette actions that route
 *  to one directly. */
export type RepositoryFilesTab = "tracked" | "ignored" | "ai";
type Tab = RepositoryFilesTab;

/** How a tab names its contents in the filter, the count line and the empty
 *  states, since the id itself ("ai") doesn't read as English. */
const TAB_LABEL: Record<Tab, string> = {
  tracked: "tracked",
  ignored: "ignored",
  ai: "AI-excluded",
};

/** Rows carrying a second line need the taller estimate. */
const ROW_HEIGHT: Record<Tab, number> = { tracked: 30, ignored: 48, ai: 48 };

/** The .gitignore rule that untracking a file adds, anchored to the repo root
 *  and escaped so a path holding `[`, `*` or `?` matches only itself. */
const ignorePattern = (path: string) => `/${globLiteralPath(path)}`;

/** How that rule reads to a human — the same anchored path without the glob
 *  escapes, which are noise to everyone but git. */
const ignoreLabel = (path: string) => `/${path}`;

/**
 * One AI ignore rule as the strip renders it: where the line lives, and what the
 * matcher did with it across the working tree. `decided` counts every path the
 * rule settled — a negation settles the paths it keeps VISIBLE — while `hidden`
 * counts only the ones it hides.
 */
type RuleStat = {
  index: number;
  pattern: string;
  source: "repo" | "global";
  negated: boolean;
  hidden: number;
  decided: number;
  /** An earlier positive rule excludes a folder this negation sits under, which
   *  is the one dead-`!` cause with a fix worth naming. */
  folderTrap: boolean;
};

/** A pattern's path with git's anchor and folder slashes dropped, so two rules
 *  can be compared as path segments. */
const rulePath = (pattern: string) =>
  pattern.replace(/^\/+/, "").replace(/\/+$/, "");

/**
 * Whether a positive rule BEFORE `at` excludes a folder that `target` (the
 * negation's own path) sits inside. A `!` decides nothing for three different
 * reasons — nothing on disk matches, a later rule wins, or git refuses to
 * re-include below an excluded directory — and only the third has advice to
 * give, so the folder sentence rides this evidence rather than the bare count.
 */
function hasEnclosingRule(
  exclude: string[],
  at: number,
  target: string,
): boolean {
  for (let j = 0; j < at; j++) {
    const line = exclude[j];
    if (line.trimStart().startsWith("!")) continue;
    const base = rulePath(line);
    if (base && (target === base || target.startsWith(`${base}/`))) return true;
  }
  return false;
}

/** A rule the removal flow deletes, identified by its position in the evaluated
 *  list; the source decides which store the line comes out of. */
type AiRuleRef = { index: number; source: "repo" | "global"; pattern: string };

/** An ODD run of backslashes before an alphanumeric: one escape git will eat,
 *  nearly always a Windows separator typed where it wants `/`. An even run is a
 *  literal backslash, which is what this app's own generated lines write. */
const ESCAPED_CHAR = /(?:^|[^\\])(?:\\\\)*\\[A-Za-z0-9]/;

/** What a pending confirm dialog will do once accepted. */
type Pending =
  | { kind: "untrack"; paths: string[] }
  | { kind: "forceAdd"; paths: string[] }
  | { kind: "removeRule"; rules: { source: string; pattern: string }[] }
  | { kind: "removeAiRule"; rules: AiRuleRef[] }
  | null;

/** How many items the action names — paths for the file actions, rules for the
 *  two rule-removing ones. */
const pendingCount = (p: NonNullable<Pending>) =>
  "rules" in p ? p.rules.length : p.paths.length;

/** Where removing AI rules lands depends on which stores the selected lines
 *  live in, so the confirm names exactly the ones it will touch. */
function aiRemoveDescription(rules: AiRuleRef[]): string {
  const repo = rules.some((r) => r.source === "repo");
  const global = rules.some((r) => r.source === "global");
  if (repo && global) {
    return "Removing a rule un-hides every file it matches from AI context, unless another rule still matches them. Repo lines are deleted from .gitdesktop/aiignore (commit to share); Global lines are removed from Settings and affect every repository:";
  }
  if (global) {
    return "Removing a rule un-hides every file it matches from AI context, in every repository, unless another rule still matches them. These lines are removed from your global AI ignore patterns in Settings:";
  }
  return "Removing a rule un-hides every file it matches from AI context, unless another rule still matches them. These lines are deleted from this repo's .gitdesktop/aiignore — commit the change to share it:";
}

/** The confirm dialog's whole voice per action, so its title, warning and
 *  button can never end up describing different ones. The description takes the
 *  payload, since the AI one reads differently per rule source. */
const PENDING_COPY: Record<
  NonNullable<Pending>["kind"],
  {
    title: (n: number) => string;
    description: (p: NonNullable<Pending>) => string;
    confirm: string;
  }
> = {
  untrack: {
    title: (n) => `Untrack ${n} ${n === 1 ? "file" : "files"}?`,
    description: () =>
      "These files stay on disk, but git stops tracking them. Each gets an anchored rule added to .gitignore so it isn't re-added. To undo, remove the rule from the Ignored tab and re-add the file.",
    confirm: "Untrack",
  },
  forceAdd: {
    title: (n) => `Force-add ${n} ${n === 1 ? "item" : "items"}?`,
    description: () =>
      "These start being tracked despite .gitignore. A directory (trailing “/”) tracks all of its currently-ignored contents — review the list before confirming:",
    confirm: "Force-add",
  },
  removeRule: {
    title: (n) => `Remove ${n} .gitignore rule${n === 1 ? "" : "s"}?`,
    description: () =>
      "Removing a rule un-ignores every file it matched across the repo — not just the ones you selected. These lines are deleted from their .gitignore files:",
    confirm: "Remove",
  },
  removeAiRule: {
    title: (n) => `Remove ${n} AI ignore rule${n === 1 ? "" : "s"}?`,
    description: (p) =>
      p.kind === "removeAiRule" ? aiRemoveDescription(p.rules) : "",
    confirm: "Remove",
  },
};

export function RepositoryFilesDialog({
  repoPath,
  open,
  onOpenChange,
  initialTab,
}: {
  repoPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: RepositoryFilesTab;
}) {
  const [tab, setTab] = useState<Tab>("tracked");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // The keyboard-focused row (arrow-key navigation) and the pivot a Shift+Arrow
  // range extends from — both tracked by path so they survive re-renders.
  const [activePath, setActivePath] = useState<string | null>(null);
  const [anchorPath, setAnchorPath] = useState<string | null>(null);
  // Position of the AI rule the list is narrowed to, or null for every rule.
  const [ruleFilter, setRuleFilter] = useState<number | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const shownPending = useRetained(pending);

  const aiEnabled = useAiEnabled();
  const settings = useSettings();
  const tracked = useTrackedFiles(repoPath, open && tab === "tracked");
  const ignored = useIgnoredFiles(repoPath, open && tab === "ignored");
  // Held until settings resolve: a view keyed off an unresolved read would show
  // repo rules alone and claim that is everything hiding a file.
  const aiView = useAiExcludedView(
    repoPath,
    open && tab === "ai" && aiEnabled && settings.isSuccess,
    settings.data?.aiIgnorePatterns ?? "",
  );
  const untrack = useUntrack(repoPath);
  const forceAdd = useForceAdd(repoPath);
  const unignore = useUnignoreRules(repoPath);
  const appendAiIgnore = useAppendRepoAiIgnore(repoPath);
  const removeAiIgnore = useRemoveRepoAiIgnore(repoPath);
  const saveSettings = useSaveSettings();
  const onError = (e: unknown) => toastError(e);
  const filterRef = useRef<HTMLInputElement>(null);

  // Reset transient state whenever the active list or the dialog changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear on tab/open switch
  useEffect(() => {
    setSelected(new Set());
    setFilter("");
    setActivePath(null);
    setAnchorPath(null);
    setRuleFilter(null);
  }, [tab, open]);

  // The tab an open lands on. Applied on the open transition alone, so a tab the
  // user picks inside an open dialog isn't pulled back by a re-render. Gated on
  // aiEnabled here too — the callers all gate already, but a future opener must
  // not be able to land the dialog on a tab whose button isn't rendered.
  useSeedOnOpen(open, () => {
    const target = initialTab ?? "tracked";
    setTab(target === "ai" && !aiEnabled ? "tracked" : target);
  });

  // Hiding AI features takes their tab with it, mid-open included.
  useEffect(() => {
    if (!aiEnabled) setTab((t) => (t === "ai" ? "tracked" : t));
  }, [aiEnabled]);

  const q = filter.trim().toLowerCase();
  const ignoredByPath = useMemo(() => {
    const map = new Map<string, IgnoredFile>();
    for (const f of ignored.data ?? []) map.set(f.path, f);
    return map;
  }, [ignored.data]);

  const ai = aiView.data;
  const aiDerived = useMemo(() => {
    const repoRules = ai?.repoRules ?? [];
    const globalRules = ai?.globalRules ?? [];
    const verdicts = ai?.verdicts ?? [];
    const unreadable = ai?.unreadable ?? [];
    // Verdict indices address this exact array, repo lines first (the order the
    // matcher evaluated), so a rule's source is its position.
    const exclude = [...repoRules, ...globalRules];
    const hiddenCount = new Array<number>(exclude.length).fill(0);
    const decidedCount = new Array<number>(exclude.length).fill(0);
    const hiddenByPath = new Map<string, AiIgnoreVerdict>();
    for (const v of verdicts) {
      // Out-of-range indices are dropped whole: an unattributable verdict would
      // otherwise route its removal at whichever store that position lands in.
      if (v.patternIndex < 0 || v.patternIndex >= exclude.length) continue;
      decidedCount[v.patternIndex]++;
      if (v.negated) continue;
      hiddenCount[v.patternIndex]++;
      hiddenByPath.set(v.path, v);
    }
    const stats: RuleStat[] = exclude.map((pattern, i) => {
      const negated = pattern.trimStart().startsWith("!");
      const decided = decidedCount[i];
      return {
        index: i,
        pattern,
        source: i < repoRules.length ? "repo" : "global",
        negated,
        hidden: hiddenCount[i],
        decided,
        folderTrap:
          negated &&
          decided === 0 &&
          hasEnclosingRule(exclude, i, rulePath(pattern.trimStart().slice(1))),
      };
    });
    return {
      stats,
      hiddenByPath,
      repoCount: repoRules.length,
      untracked: new Set(ai?.untracked ?? []),
      unreadable: new Set(unreadable),
      paths: [...hiddenByPath.keys()].toSorted().concat(unreadable.toSorted()),
    };
  }, [ai]);

  const ruleStats = aiDerived.stats;
  // Derived, not cleared by an effect: the tab gate holds on the render that
  // switches tabs (the reset effect only fires after paint), and dropping a
  // filter left pointing past the end beats re-attributing it to whichever rule
  // a removal shifted into that position.
  const activeRule =
    tab === "ai" && ruleFilter !== null && ruleFilter < ruleStats.length
      ? ruleFilter
      : null;

  const filtered = useMemo(() => {
    const lists: Record<Tab, string[]> = {
      tracked: tracked.data ?? [],
      ignored: (ignored.data ?? []).map((f) => f.path),
      ai: aiDerived.paths,
    };
    let base = lists[tab];
    if (activeRule !== null) {
      base = base.filter(
        (p) => aiDerived.hiddenByPath.get(p)?.patternIndex === activeRule,
      );
    }
    return q ? base.filter((p) => p.toLowerCase().includes(q)) : base;
  }, [tab, tracked.data, ignored.data, aiDerived, activeRule, q]);

  const view = { tracked, ignored, ai: aiView }[tab];
  // A settings error keeps the ai view's query disabled, which reads as pending
  // forever — surface it as the error it is instead of an endless spinner.
  const settingsBlocked = tab === "ai" && settings.isError;
  const pendingLoad = view.isPending && !settingsBlocked;
  const isError = view.isError || settingsBlocked;
  const busy =
    untrack.isPending ||
    forceAdd.isPending ||
    unignore.isPending ||
    appendAiIgnore.isPending ||
    removeAiIgnore.isPending ||
    saveSettings.isPending;

  // Actions and counts operate on the *visible* selection only: a file hidden
  // by the filter can't be acted on (it reappears, still selected, when the
  // filter clears), so you never touch something you can't see.
  const selectedPaths = filtered.filter((p) => selected.has(p));
  const count = selectedPaths.length;

  function toggle(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  const activeIndex = activePath ? filtered.indexOf(activePath) : -1;

  // ArrowUp/Down move the focused row; Shift extends a range from the anchor.
  // Wired on both the filter input and the list, so arrows always navigate
  // (never scroll) regardless of where focus sits.
  const navKeyDown = listKeyboardNav({
    items: filtered,
    activeIndex,
    onActivate: (path, to, shift) => {
      setActivePath(path);
      if (shift) {
        const anchor = anchorPath ?? activePath ?? path;
        const a = filtered.indexOf(anchor);
        if (a !== -1) {
          const [lo, hi] = a <= to ? [a, to] : [to, a];
          setSelected((prev) => {
            const next = new Set(prev);
            for (let i = lo; i <= hi; i++) next.add(filtered[i]);
            return next;
          });
        }
      } else {
        setAnchorPath(path);
      }
    },
  });
  // Enter toggles the focused row from the filter input (Space stays free to type).
  function onFilterKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && activePath && filtered.includes(activePath)) {
      e.preventDefault();
      toggle(activePath);
      return;
    }
    navKeyDown(e);
  }
  // Inside the list, Space/Enter on the container toggles the focused row; a
  // focused checkbox handles its own Space natively, so only act on the container.
  function onListKeyDown(e: KeyboardEvent) {
    if (
      (e.key === "Enter" || e.key === " ") &&
      e.target === e.currentTarget &&
      activePath &&
      filtered.includes(activePath)
    ) {
      e.preventDefault();
      toggle(activePath);
      return;
    }
    navKeyDown(e);
  }

  // Arrows walk the rule buttons themselves — the strip is its own list, and Esc
  // is left alone (it closes the dialog).
  function onRulesKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const buttons = [
      ...e.currentTarget.querySelectorAll<HTMLButtonElement>("[data-rule]"),
    ];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    e.preventDefault();
    const to = at + (e.key === "ArrowDown" ? 1 : -1);
    buttons[Math.min(Math.max(to, 0), buttons.length - 1)]?.focus();
  }

  // Header checkbox toggles every (filtered) row.
  const allSelected =
    filtered.length > 0 && filtered.every((p) => selected.has(p));
  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) for (const p of filtered) next.delete(p);
      else for (const p of filtered) next.add(p);
      return next;
    });
  }

  function runUntrack(paths: string[]) {
    untrack.mutate(
      {
        pathspecs: paths.map(literalPathspec),
        ignorePatterns: paths.map(ignorePattern),
      },
      {
        onSuccess: () => {
          toast.success(
            `Untracked ${paths.length} file${paths.length === 1 ? "" : "s"} — kept on disk, added to .gitignore`,
          );
          setSelected(new Set());
          setPending(null);
        },
        onError: (e) => {
          onError(e);
          setPending(null);
        },
      },
    );
  }

  function runForceAdd(paths: string[]) {
    forceAdd.mutate(paths.map(literalPathspec), {
      onSuccess: () => {
        toast.success(`Force-added ${paths.length} items`);
        setSelected(new Set());
        setPending(null);
      },
      onError: (e) => {
        onError(e);
        setPending(null);
      },
    });
  }

  function runRemoveRules(rules: { source: string; pattern: string }[]) {
    unignore.mutate(rules, {
      onSuccess: () => {
        toast.success(
          `Removed ${rules.length} rule${rules.length === 1 ? "" : "s"} from .gitignore`,
        );
        setSelected(new Set());
        setPending(null);
      },
      onError: (e) => {
        onError(e);
        setPending(null);
      },
    });
  }

  // Bulk AI-exclude from the tracked list — the add path for files with nothing
  // pending. Deduped: a `\`-bearing path emits a `/`-separated twin line, and the
  // duplicate would read as a false partial once the Rust side collapses it.
  // Awaited, since closing the dialog mid-append would drop per-call callbacks
  // and with them the toast and the selection reset.
  async function runExcludeFromAi(paths: string[]) {
    const patterns = [...new Set(paths.flatMap(aiExcludePatternLinesForPath))];
    try {
      const added = await appendAiIgnore.mutateAsync(patterns);
      toast.success(
        ignoreToast(added, patterns.length, ".gitdesktop/aiignore"),
      );
      setSelected(new Set());
    } catch (e) {
      onError(e);
    }
  }

  // Two stores, one action: repo lines come out of the repo's aiignore file,
  // global ones out of the settings string (rebuilt whole, through the
  // serialized save chain). Awaited rather than per-call callbacks, since the
  // dialog can close mid-flight; a repo write that landed before the settings
  // write failed is disclosed rather than reported as success. Both counts are
  // MEASURED — an external edit can have taken a line already, and the toast
  // reports what came out rather than what was asked for.
  async function runRemoveAiRules(rules: AiRuleRef[]) {
    const repoPatterns = rules
      .filter((r) => r.source === "repo")
      .map((r) => r.pattern);
    const globalPatterns = rules
      .filter((r) => r.source === "global")
      .map((r) => r.pattern);
    let repoRemoved = false;
    let removed = 0;
    try {
      if (repoPatterns.length > 0) {
        removed += await removeAiIgnore.mutateAsync(repoPatterns);
        repoRemoved = true;
      }
      if (globalPatterns.length > 0) {
        const current = settings.data;
        if (!current) throw new Error("Settings haven't loaded yet.");
        const drop = new Set(globalPatterns);
        const lines = current.aiIgnorePatterns.split("\n");
        const kept = lines.filter((line) => !drop.has(trimIgnorePattern(line)));
        removed += lines.length - kept.length;
        if (kept.length !== lines.length) {
          await saveSettings.mutateAsync({
            ...current,
            aiIgnorePatterns: kept.join("\n"),
          });
        }
      }
      if (removed === 0) {
        toast.success("Those rules were already gone — the list is up to date");
      } else {
        toast.success(
          `Removed ${removed} AI ignore rule${removed === 1 ? "" : "s"}`,
        );
      }
      setSelected(new Set());
      setRuleFilter(null);
      setPending(null);
    } catch (e) {
      if (repoRemoved) {
        toastErrorWithNote(
          e,
          "Repo rules removed; updating global patterns failed",
        );
      } else {
        onError(e);
      }
      setPending(null);
    }
  }

  // The distinct rules behind the selected ignored files (deduped — several
  // files can share one pattern like `*.log`).
  function selectedRules() {
    const seen = new Set<string>();
    const rules: { source: string; pattern: string }[] = [];
    for (const path of selectedPaths) {
      const f = ignoredByPath.get(path);
      if (!f || !f.pattern) continue;
      const key = `${f.source} ${f.pattern}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rules.push({ source: f.source, pattern: f.pattern });
    }
    return rules;
  }

  // The same, for AI rules: keyed by position, so two files hidden by one line
  // remove it once. An unreadable name has no rule to remove and drops out.
  function selectedAiRules(): AiRuleRef[] {
    const seen = new Set<number>();
    const refs: AiRuleRef[] = [];
    for (const path of selectedPaths) {
      const v = aiDerived.hiddenByPath.get(path);
      if (!v || seen.has(v.patternIndex)) continue;
      seen.add(v.patternIndex);
      refs.push({
        index: v.patternIndex,
        source: v.patternIndex < aiDerived.repoCount ? "repo" : "global",
        pattern: v.pattern,
      });
    }
    return refs;
  }

  const rules = selectedRules();
  const aiRules = selectedAiRules();

  function countLine(): string {
    if (count > 0) return `${count} selected`;
    const n = filtered.length;
    const s = n === 1 ? "" : "s";
    if (activeRule !== null) return `${n} file${s} hidden by this rule`;
    return `${n} ${TAB_LABEL[tab]} file${s}`;
  }

  function emptyMessage(): ReactNode {
    // `q`, not the raw field: a whitespace-only filter narrows nothing, so it
    // must not claim the filter emptied the list.
    if (q) return "No files match the filter.";
    if (tab === "tracked") return "No tracked files.";
    if (tab === "ignored") return "Nothing is being ignored.";
    if (ruleStats.length === 0) {
      return (
        <>
          Nothing is hidden from AI context yet. Right-click files in the
          changes list and choose “Exclude from AI” to write a rule into this
          repo's <span className="font-mono">.gitdesktop/aiignore</span>, or
          fill in “Excluded files” under Settings → AI to cover every
          repository.
        </>
      );
    }
    if (activeRule !== null) return "No files match this rule.";
    return "None of the current files match your AI ignore patterns.";
  }

  const ignoredRowInfo = (path: string) => {
    const info = ignoredByPath.get(path);
    if (!info) return null;
    return (
      <span className="block truncate text-[11px] text-muted-foreground">
        ignored by{" "}
        <span className="font-mono">
          {info.source}
          {info.line ? `:${info.line}` : ""}
        </span>{" "}
        · <span className="font-mono">{info.pattern}</span>
      </span>
    );
  };

  // No line numbers on the AI side: the indices address the comment-stripped
  // list the matcher read, which would misname the line in the user's file.
  const aiRowInfo = (path: string) => {
    if (aiDerived.unreadable.has(path)) {
      return (
        <span className="block truncate text-[11px] text-muted-foreground">
          always hidden — file name can't be read as text
        </span>
      );
    }
    const v = aiDerived.hiddenByPath.get(path);
    if (!v) return null;
    return (
      <span className="block truncate text-[11px] text-muted-foreground">
        hidden by {v.patternIndex < aiDerived.repoCount ? "Repo" : "Global"} ·{" "}
        <span className="font-mono">{v.pattern}</span>
      </span>
    );
  };

  const aiRowSuffix = (path: string) =>
    aiDerived.untracked.has(path) ? (
      <span className="shrink-0 font-sans text-muted-foreground">
        · untracked
      </span>
    ) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[80vh] flex-col sm:max-w-2xl"
        initialFocus={() => filterRef.current}
      >
        <DialogHeader>
          <DialogTitle>Repository files</DialogTitle>
          <DialogDescription>
            Manage what git tracks beyond your pending changes — untrack files
            committed by mistake, or surface and re-add files ignored by mistake
            {aiEnabled ? ", or review what your AI ignore patterns hide." : "."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant={tab === "tracked" ? "secondary" : "ghost"}
            size="xs"
            aria-pressed={tab === "tracked"}
            onClick={() => setTab("tracked")}
          >
            Tracked
          </Button>
          <Button
            type="button"
            variant={tab === "ignored" ? "secondary" : "ghost"}
            size="xs"
            aria-pressed={tab === "ignored"}
            onClick={() => setTab("ignored")}
          >
            Ignored
          </Button>
          {aiEnabled && (
            <Button
              type="button"
              variant={tab === "ai" ? "secondary" : "ghost"}
              size="xs"
              aria-pressed={tab === "ai"}
              onClick={() => setTab("ai")}
            >
              AI excluded
            </Button>
          )}
        </div>

        <Input
          ref={filterRef}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={onFilterKeyDown}
          placeholder={`Filter ${TAB_LABEL[tab]} files — ↑↓ to move, Enter to select`}
          aria-label={`Filter ${TAB_LABEL[tab]} files`}
          className="h-8"
          autoComplete="off"
        />

        {tab === "ai" && ruleStats.length > 0 && (
          <div
            className="max-h-56 shrink-0 overflow-y-auto border p-1 text-xs"
            onKeyDown={onRulesKeyDown}
          >
            <p className="px-1 pb-1 text-[11px] text-muted-foreground">
              Rules — evaluated top to bottom; the last match wins
            </p>
            {ruleStats.map((rule) => (
              <RuleRow
                key={`${rule.index}:${rule.pattern}`}
                rule={rule}
                active={activeRule === rule.index}
                onToggle={() =>
                  setRuleFilter(activeRule === rule.index ? null : rule.index)
                }
              />
            ))}
          </div>
        )}

        {(filtered.length > 0 || activeRule !== null) && (
          <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
            {filtered.length > 0 && (
              <label className="flex flex-1 cursor-pointer items-center gap-2">
                <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
                <span className="flex-1">{countLine()}</span>
              </label>
            )}
            {activeRule !== null && (
              <button
                type="button"
                className="ml-auto cursor-pointer underline underline-offset-2 hover:text-foreground"
                onClick={() => setRuleFilter(null)}
              >
                Show all
              </button>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 border">
          {pendingLoad ? (
            <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
              <Spinner /> Loading…
            </div>
          ) : isError ? (
            <p className="p-4 text-xs text-muted-foreground">
              Couldn't load {TAB_LABEL[tab]} files.
            </p>
          ) : filtered.length === 0 ? (
            <p className="p-4 text-xs text-muted-foreground">
              {emptyMessage()}
            </p>
          ) : (
            <FileList
              paths={filtered}
              rowInfo={tab === "ai" ? aiRowInfo : ignoredRowInfo}
              rowSuffix={tab === "ai" ? aiRowSuffix : undefined}
              selected={selected}
              activePath={activePath}
              rowHeight={ROW_HEIGHT[tab]}
              onToggle={toggle}
              onKeyDown={onListKeyDown}
            />
          )}
        </div>

        <DialogFooter className="flex-wrap gap-2 sm:justify-start">
          {count === 0 ? (
            <p className="text-xs text-muted-foreground">
              Select files to act on them.
            </p>
          ) : (
            <>
              {tab === "tracked" && (
                <>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      setPending({ kind: "untrack", paths: selectedPaths })
                    }
                  >
                    Untrack {count} {count === 1 ? "file" : "files"} (keep on
                    disk)
                  </Button>
                  {aiEnabled && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => runExcludeFromAi(selectedPaths)}
                    >
                      Exclude {count} from AI
                    </Button>
                  )}
                </>
              )}
              {tab === "ignored" && (
                <>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      setPending({ kind: "forceAdd", paths: selectedPaths })
                    }
                  >
                    Force-add {count}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || rules.length === 0}
                    onClick={() => setPending({ kind: "removeRule", rules })}
                  >
                    Remove {rules.length} rule{rules.length === 1 ? "" : "s"}
                  </Button>
                </>
              )}
              {tab === "ai" && (
                <DisabledReasonButton
                  size="sm"
                  disabled={busy || aiRules.length === 0}
                  reason={
                    aiRules.length === 0
                      ? "These files are hidden because their names can't be read as text, so there's no rule to remove."
                      : null
                  }
                  onClick={() =>
                    setPending({ kind: "removeAiRule", rules: aiRules })
                  }
                >
                  {aiRules.length === 0
                    ? "Remove rules"
                    : `Remove ${aiRules.length} rule${aiRules.length === 1 ? "" : "s"}`}
                </DisabledReasonButton>
              )}
            </>
          )}
          {count > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => setSelected(new Set())}
            >
              Clear
            </Button>
          )}
        </DialogFooter>
      </DialogContent>

      {/* Confirm the .gitignore-affecting / index-bloating actions. Returns
          focus to the filter when it closes, since the action button it opened
          from often disappears (the selection clears) on success. */}
      <Dialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
      >
        <DialogContent finalFocus={() => filterRef.current}>
          <DialogHeader>
            <DialogTitle>
              {shownPending &&
                PENDING_COPY[shownPending.kind].title(
                  pendingCount(shownPending),
                )}
            </DialogTitle>
            <DialogDescription>
              {shownPending &&
                PENDING_COPY[shownPending.kind].description(shownPending)}
            </DialogDescription>
          </DialogHeader>
          {shownPending?.kind === "untrack" && (
            <ul className="max-h-40 overflow-auto border p-2 text-xs">
              {shownPending.paths.map((p) => (
                <li key={p} className="truncate font-mono" title={p}>
                  {ignoreLabel(p)}
                </li>
              ))}
            </ul>
          )}
          {shownPending?.kind === "forceAdd" && (
            <ul className="max-h-40 overflow-auto border p-2 text-xs">
              {shownPending.paths.map((p) => (
                <li key={p} className="truncate font-mono" title={p}>
                  {p}
                  {p.endsWith("/") && (
                    <span className="ml-1 font-sans text-muted-foreground">
                      — directory, adds all contents
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {shownPending?.kind === "removeRule" && (
            <ul className="max-h-40 overflow-auto border p-2 text-xs">
              {shownPending.rules.map((r) => (
                <li key={`${r.source}:${r.pattern}`} className="font-mono">
                  {r.pattern}{" "}
                  <span className="font-sans text-muted-foreground">
                    — {r.source}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {shownPending?.kind === "removeAiRule" && (
            <ul className="max-h-40 overflow-auto border p-2 text-xs">
              {shownPending.rules.map((r) => (
                <li key={`${r.source}:${r.index}`} className="font-mono">
                  {r.pattern}{" "}
                  <span className="font-sans text-muted-foreground">
                    —{" "}
                    {r.source === "repo" ? "Repo aiignore" : "Global settings"}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                if (pending?.kind === "untrack") runUntrack(pending.paths);
                else if (pending?.kind === "forceAdd")
                  runForceAdd(pending.paths);
                else if (pending?.kind === "removeRule")
                  runRemoveRules(pending.rules);
                else if (pending?.kind === "removeAiRule")
                  runRemoveAiRules(pending.rules);
              }}
            >
              {shownPending && PENDING_COPY[shownPending.kind].confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}

/** The right-hand status of a rule row. A negation reports what it KEEPS
 *  visible, never what it "re-includes": git reports the last match, and a `!`
 *  that matched was not necessarily putting anything back. */
function ruleStatus(rule: RuleStat): string {
  if (rule.negated) return `keeps ${rule.decided} visible`;
  if (rule.hidden === 0) return "no matches";
  return `${rule.hidden} file${rule.hidden === 1 ? "" : "s"}`;
}

/** Why a `!` line decided nothing. The bare count can't tell the three causes
 *  apart, so the folder advice is appended only where the evidence backs it. */
function deadNegationNote(rule: RuleStat): string {
  const cause =
    "matches nothing — no current file matches, or a later rule decides first";
  if (!rule.folderTrap) return cause;
  // No terminal period: it would abut the pattern and read as a literal `dir/.`
  return `${cause}. A file inside an excluded folder can't be re-included; exclude with dir/* instead of dir/`;
}

/** One row of the rules strip. A positive rule is a button that narrows the list
 *  to its own matches; a negation has no rows to show, so it stays static. */
function RuleRow({
  rule,
  active,
  onToggle,
}: {
  rule: RuleStat;
  active: boolean;
  onToggle: () => void;
}) {
  const body = (
    <>
      <Badge variant="outline" className="h-4 shrink-0 px-1 text-[10px]">
        {rule.source === "repo" ? "Repo" : "Global"}
      </Badge>
      <span className="min-w-0 flex-1 truncate font-mono" title={rule.pattern}>
        {rule.pattern}
      </span>
      <span className="shrink-0 text-muted-foreground">{ruleStatus(rule)}</span>
    </>
  );
  return (
    <div>
      {rule.negated ? (
        <div className="flex items-center gap-2 px-1 py-0.5">{body}</div>
      ) : (
        <button
          type="button"
          data-rule
          aria-pressed={active}
          onClick={onToggle}
          className={cn(
            "flex w-full cursor-pointer items-center gap-2 px-1 py-0.5 text-left hover:bg-muted/60",
            active && "bg-accent/60",
          )}
        >
          {body}
        </button>
      )}
      {rule.negated && rule.decided === 0 && (
        <p className="flex items-start gap-1 px-1 pb-1 text-[11px] text-warning">
          <WarningIcon className="mt-px size-3 shrink-0" />
          <span>{deadNegationNote(rule)}</span>
        </p>
      )}
      {!rule.negated &&
        rule.decided === 0 &&
        ESCAPED_CHAR.test(rule.pattern) && (
          <p className="px-1 pb-1 text-[11px] text-muted-foreground">
            a backslash escapes the next character — for a path separator use /
          </p>
        )}
    </div>
  );
}

/**
 * The virtualized file rows. Lives in its own component — mounted only once data
 * is ready and the dialog is laid out — so the scroll element exists when the
 * virtualizer first observes it (the same structure as CloneRepoDialog's
 * RepoBrowser). Mounting the virtualizer alongside an always-rendered scroll div
 * raced the ref and left the list blank until an unrelated re-render.
 *
 * `rowSuffix` and `rowInfo` are the per-tab content: what trails the path on its
 * own line, and the muted line beneath it.
 */
function FileList({
  paths,
  rowInfo,
  rowSuffix,
  selected,
  activePath,
  rowHeight,
  onToggle,
  onKeyDown,
}: {
  paths: string[];
  rowInfo: (path: string) => ReactNode;
  rowSuffix?: (path: string) => ReactNode;
  selected: Set<string>;
  activePath: string | null;
  rowHeight: number;
  onToggle: (path: string) => void;
  onKeyDown: (e: KeyboardEvent) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: paths.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  // Keep the keyboard-focused row scrolled into view (it may not be mounted yet).
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on active/list change
  useEffect(() => {
    if (!activePath) return;
    const idx = paths.indexOf(activePath);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "auto" });
  }, [activePath, paths]);

  return (
    <div
      ref={parentRef}
      className="h-full overflow-y-auto"
      onKeyDown={onKeyDown}
      tabIndex={-1}
    >
      <div
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((vi) => {
          const path = paths[vi.index];
          return (
            <div
              key={path}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${vi.start}px)` }}
            >
              <label
                className={cn(
                  "flex cursor-pointer items-start gap-2 border-b px-2 py-1.5 text-xs hover:bg-muted/60",
                  selected.has(path) && "bg-accent/60",
                  path === activePath && "ring-1 ring-ring ring-inset",
                )}
              >
                <Checkbox
                  className="mt-0.5"
                  checked={selected.has(path)}
                  onCheckedChange={() => onToggle(path)}
                />
                <span className="min-w-0 flex-1">
                  {/* The suffix sits OUTSIDE the truncating span, so a long path
                      shortens instead of swallowing the marker. */}
                  {rowSuffix ? (
                    <span className="flex items-baseline gap-1">
                      <span className="truncate font-mono" title={path}>
                        {path}
                      </span>
                      {rowSuffix(path)}
                    </span>
                  ) : (
                    <span className="block truncate font-mono" title={path}>
                      {path}
                    </span>
                  )}
                  {rowInfo(path)}
                </span>
              </label>
            </div>
          );
        })}
      </div>
    </div>
  );
}
