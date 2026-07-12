import { Popover } from "@base-ui/react/popover";
import {
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  CaretDownIcon,
  CheckCircleIcon,
  CircleDashedIcon,
  DotsThreeIcon,
  FlagIcon,
  TagIcon,
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ForgeUserAvatar } from "@/components/forge-user-avatar";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "@/components/markdown-editor";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Markdown } from "@/components/ui/markdown";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import { DueDateRow } from "@/features/issues/RemoteIssueViewParts";
import type { ForgeUserRef } from "@/lib/git/types";
import { formatBinding } from "@/lib/hotkeys/binding";
import { formatHmDelta, isValidJiraDuration } from "@/lib/jira/duration";
import {
  useJiraAssign,
  useJiraComment,
  useJiraCommentDelete,
  useJiraCommentEdit,
  useJiraDeleteWorklog,
  useJiraIssue,
  useJiraLabels,
  useJiraLink,
  useJiraLogWork,
  useJiraPermissions,
  useJiraPriorities,
  useJiraSetDueDate,
  useJiraSetLabels,
  useJiraSetOriginalEstimate,
  useJiraSetPriority,
  useJiraSetRemainingEstimate,
  useJiraTransition,
  useJiraTransitions,
  useJiraTransitionTo,
  useJiraUpdateWorklog,
  useJiraUserSearch,
} from "@/lib/jira/queries";
import type { JiraLink } from "@/lib/jira/store";
import {
  formatStoryPoints,
  type JiraComment,
  type JiraIssueDetails,
  type JiraStatusCategory,
  type JiraTimeTracking as JiraTimeTrackingData,
  type JiraWorklog,
} from "@/lib/jira/types";
import { useUiStore } from "@/lib/stores/ui";
import { formatRelativeTime } from "@/lib/time";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";

/** Platform-correct submit hint (Cmd+Enter on macOS, Ctrl+Enter else) — never a
 *  literal modifier (house platform-mod-key rule). */
const SUBMIT_HINT = formatBinding("mod+enter");

/** The category icon + tone shared by the chip and every menu row (so meaning is
 *  never color-only). `done` → the closed/merged treatment; else open/success. */
function statusPresentation(category: JiraStatusCategory) {
  const done = category === "done";
  return {
    Icon: done ? CheckCircleIcon : CircleDashedIcon,
    tone: done ? "text-merged" : "text-success",
  };
}

/** The static status chip: category picks the open/closed icon+token, the REAL
 *  status name is the text. Used read-only, and as the trigger label inside the
 *  interactive StatusMenu. `interactive` adds the dropdown-affordance chevron. */
function StatusChip({
  category,
  name,
  interactive = false,
}: {
  category: JiraStatusCategory;
  name: string;
  interactive?: boolean;
}) {
  const { Icon, tone } = statusPresentation(category);
  return (
    <span className="inline-flex items-center gap-1 border px-1.5 py-0.5 text-[11px]">
      <Icon className={`size-3.5 shrink-0 ${tone}`} />
      {name}
      {interactive && <CaretDownIcon className="size-3 shrink-0 opacity-60" />}
    </span>
  );
}

/**
 * Interactive status picker: the chip becomes a DropdownMenu trigger. Transitions
 * are fetched lazily on open (never on mount). Each menu item is a target status
 * (labeled by its to-status name, dot-toned by category); a self-transition back
 * to the current status renders as a checked, non-interactive current row.
 * Selecting one fires the optimistic `jira_issue_transition_to` mutation. Only
 * rendered when `transitionIssues` is permitted (the static chip covers the rest).
 */
function StatusMenu({
  repoPath,
  link,
  issueKey,
  category,
  name,
  busy,
  transitionTo,
}: {
  repoPath: string;
  link: JiraLink;
  issueKey: string;
  category: JiraStatusCategory;
  name: string;
  busy: boolean;
  transitionTo: ReturnType<typeof useJiraTransitionTo>;
}) {
  const [open, setOpen] = useState(false);
  const transitions = useJiraTransitions(repoPath, link, issueKey, open);

  function apply(t: {
    id: string;
    toStatusName: string;
    toStatusCategory: JiraStatusCategory;
  }) {
    transitionTo.mutate(
      {
        issueKey,
        transitionId: t.id,
        toStatusName: t.toStatusName,
        toStatusCategory: t.toStatusCategory,
      },
      {
        onSuccess: (r) => toast.success(`${issueKey} · ${r.statusName}`),
        onError: toastError,
      },
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        disabled={busy}
        aria-label={`Status: ${name}. Change status`}
        className="cursor-pointer rounded-none disabled:cursor-default disabled:opacity-60"
      >
        <StatusChip category={category} name={name} interactive />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        {transitions.isPending ? (
          <DropdownMenuItem disabled>Loading transitions…</DropdownMenuItem>
        ) : transitions.isError ? (
          <DropdownMenuItem
            // Base UI item: onClick fires the action (Radix-style onSelect
            // TYPECHECKS — it's the DOM text-selection event — but never fires
            // on click); closeOnClick={false} keeps the menu open for retry.
            closeOnClick={false}
            onClick={() => transitions.refetch()}
          >
            Couldn't load transitions — retry
          </DropdownMenuItem>
        ) : (transitions.data ?? []).length === 0 ? (
          <DropdownMenuItem disabled>No transitions available</DropdownMenuItem>
        ) : (
          (transitions.data ?? []).map((t) => {
            const { Icon, tone } = statusPresentation(t.toStatusCategory);
            // A self-transition (lands back on the current status) is shown as the
            // checked, non-interactive current row.
            const isCurrent = t.toStatusName === name;
            if (isCurrent) {
              return (
                <DropdownMenuCheckboxItem key={t.id} checked disabled>
                  <Icon className={`size-3.5 shrink-0 ${tone}`} />
                  {t.toStatusName}
                </DropdownMenuCheckboxItem>
              );
            }
            return (
              <DropdownMenuItem key={t.id} onClick={() => apply(t)}>
                <Icon className={`size-3.5 shrink-0 ${tone}`} />
                {t.toStatusName}
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A muted issue-type icon + name, part of the meta row. Jira serves a small
 *  square type glyph; rendered through the vendored Avatar primitives (the repo's
 *  image idiom) so it degrades to the type's initial when the glyph won't load. */
function IssueTypeMeta({ iconUrl, name }: { iconUrl: string; name: string }) {
  if (!name) return null;
  return (
    <span className="inline-flex items-center gap-1">
      <Avatar size="sm" className="size-3.5 shrink-0 rounded-none">
        {iconUrl && <AvatarImage src={iconUrl} alt="" />}
        <AvatarFallback className="rounded-none text-[8px]">
          {name.charAt(0).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      {name}
    </span>
  );
}

/** A sentinel `ForgeUserRef` for the "Unassign" row (folded into the items list
 *  so the combobox's render function handles it uniformly). Its id can't collide
 *  with a real Jira accountId. */
const UNASSIGN: ForgeUserRef = {
  id: "__gd_unassign__",
  label: "Unassign",
  avatarUrl: "",
  isBot: false,
};

/**
 * Single-assignee picker for the meta row (Jira issues have exactly one
 * assignee). A compact combobox: the debounced query drives `jira_user_search`,
 * arrow keys walk the results (Base UI Combobox), and an "Unassign" entry clears
 * it. Selecting fires the optimistic assign mutation; the trigger placeholder
 * reflects the live (optimistically-patched) assignee. Only rendered when
 * `assignIssues` is permitted.
 */
function JiraAssigneePicker({
  repoPath,
  link,
  issueKey,
  assignee,
}: {
  repoPath: string;
  link: JiraLink;
  issueKey: string;
  assignee: ForgeUserRef | null;
}) {
  const assign = useJiraAssign(repoPath, link);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  // Debounce the search input (server-driven) — mirrors the project-search
  // idiom in RepoJiraDialog; no shared debounce hook exists.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const users = useJiraUserSearch(link, issueKey, debounced, open);
  // Offer Unassign first when someone is currently assigned; the search results
  // follow. Drop
  // users the backend couldn't resolve an accountId for (id === "") — they're
  // unassignable by definition, and picking one would POST `{accountId: ""}`
  // and 400 (and an empty id also slips past the no-op guard when clearing).
  const items: ForgeUserRef[] = [
    ...(assignee ? [UNASSIGN] : []),
    ...(users.data ?? []).filter((u) => u.id !== ""),
  ];

  function apply(next: ForgeUserRef | null) {
    setOpen(false);
    setQuery("");
    // Skip a no-op assign (re-picking the current assignee, or clearing an
    // already-empty one) so we never fire a redundant PUT.
    if ((next?.id ?? null) === (assignee?.id ?? null)) return;
    assign.mutate(
      { issueKey, assignee: next },
      {
        onSuccess: () =>
          toast.success(next ? `Assigned to ${next.label}` : "Unassigned"),
        onError: toastError,
      },
    );
  }

  return (
    <Combobox
      open={open}
      onOpenChange={setOpen}
      items={items}
      itemToStringLabel={(u: ForgeUserRef) => u.label}
      value={null}
      onValueChange={(u: ForgeUserRef | null) => {
        if (u) apply(u.id === UNASSIGN.id ? null : u);
      }}
      inputValue={query}
      onInputValueChange={setQuery}
      openOnInputClick
    >
      <ComboboxInput
        className="w-48"
        placeholder={assignee ? assignee.label : "Assign…"}
        showTrigger
      />
      <ComboboxContent>
        <ComboboxEmpty>
          {users.isPending && debounced
            ? "Searching…"
            : users.isError
              ? "Couldn't search users."
              : "No matching users."}
        </ComboboxEmpty>
        <ComboboxList>
          {(item: ForgeUserRef) =>
            item.id === UNASSIGN.id ? (
              <ComboboxItem
                key={item.id}
                value={item}
                className="text-muted-foreground"
              >
                Unassign
              </ComboboxItem>
            ) : (
              <ComboboxItem key={item.id} value={item}>
                <ForgeUserAvatar user={item} ghHost={null} />
                <span className="truncate">{item.label}</span>
              </ComboboxItem>
            )
          }
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

/**
 * Compact priority picker (meta-row). A DropdownMenu, mirroring StatusMenu: the
 * trigger shows the current priority name (or "Priority…" when empty); options
 * are fetched lazily on open (never on mount). Each row renders the priority's
 * icon through the vendored Avatar primitives (initial fallback, like
 * IssueTypeMeta). Selecting fires the optimistic set-priority mutation. Only
 * rendered when `editIssues` is permitted.
 */
function JiraPriorityMenu({
  repoPath,
  link,
  issueKey,
  priorityName,
}: {
  repoPath: string;
  link: JiraLink;
  issueKey: string;
  priorityName: string;
}) {
  const [open, setOpen] = useState(false);
  const priorities = useJiraPriorities(link, open);
  const setPriority = useJiraSetPriority(repoPath, link);

  function apply(p: { id: string; name: string }) {
    // Skip a no-op re-pick of the current priority.
    if (p.name === priorityName) return;
    setPriority.mutate(
      { issueKey, priorityId: p.id, priorityName: p.name },
      {
        onSuccess: () => toast.success(`${issueKey} · ${p.name}`),
        onError: toastError,
      },
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        disabled={setPriority.isPending}
        aria-label={
          priorityName
            ? `Priority: ${priorityName}. Change priority`
            : "Set priority"
        }
        className="inline-flex cursor-pointer items-center gap-1 disabled:cursor-default disabled:opacity-60"
      >
        <FlagIcon className="size-3 shrink-0 opacity-60" />
        {priorityName || "Priority…"}
        <CaretDownIcon className="size-3 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        {priorities.isPending ? (
          <DropdownMenuItem disabled>Loading priorities…</DropdownMenuItem>
        ) : priorities.isError ? (
          <DropdownMenuItem
            // Base UI item: onClick fires the action (Radix-style onSelect
            // TYPECHECKS — it's the DOM text-selection event — but never fires
            // on click); closeOnClick={false} keeps the menu open for retry.
            closeOnClick={false}
            onClick={() => priorities.refetch()}
          >
            Couldn't load priorities — retry
          </DropdownMenuItem>
        ) : (priorities.data ?? []).length === 0 ? (
          <DropdownMenuItem disabled>No priorities available</DropdownMenuItem>
        ) : (
          (priorities.data ?? []).map((p) => (
            <DropdownMenuCheckboxItem
              key={p.id}
              checked={p.name === priorityName}
              // Base UI checkbox item: onClick fires the action (onSelect never
              // does); it toggles the check itself so we drive the mutation here.
              // closeOnClick: checkbox items default to staying OPEN (multi-
              // toggle semantics) — priority is single-select, close like
              // StatusMenu does.
              closeOnClick
              onClick={() => apply(p)}
            >
              <Avatar size="sm" className="size-3.5 shrink-0 rounded-none">
                {p.iconUrl && <AvatarImage src={p.iconUrl} alt="" />}
                <AvatarFallback className="rounded-none text-[8px]">
                  {p.name.charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              {p.name}
            </DropdownMenuCheckboxItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Jira-local labels editor. Jira labels are freeform, colorless strings, so this
 * is a Popover with the same interaction grammar as LabelsPopover (draft while
 * open, commit ONE set-labels mutation on close when changed) but adapted to
 * strings: a filter input that doubles as a "create" field, a checkbox list from
 * `useJiraLabels`, and an "Add …" row that creates a new label from the query.
 * Whitespace-containing input is rejected inline (Jira constraint) via a field
 * warning — never a dead disabled control. Only rendered when `editIssues`.
 */
function JiraLabelsPopover({
  repoPath,
  link,
  issueKey,
  labels,
}: {
  repoPath: string;
  link: JiraLink;
  issueKey: string;
  labels: string[];
}) {
  const [open, setOpen] = useState(false);
  const known = useJiraLabels(link, open);
  const setLabels = useJiraSetLabels(repoPath, link);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Jira labels can't contain whitespace — reject inline rather than let a bad
  // "create" slip through (the backend would 400).
  const trimmed = query.trim();
  const hasWhitespace = /\s/.test(trimmed);

  // Roving arrow-key navigation across the traversable rows (the "Add…" create
  // row, when present, then each option row — matching visual order). Each row
  // carries `data-label-row` and `tabIndex={-1}`; we move DOM focus between them
  // rather than tracking an active index in state, so the list and the Input
  // stay a single Tab stop while arrows walk the rows (house list-nav rule).
  function rows(): HTMLElement[] {
    const el = listRef.current;
    if (!el) return [];
    return [...el.querySelectorAll<HTMLElement>("[data-label-row]")];
  }
  function focusRow(index: number) {
    const list = rows();
    if (list.length === 0) return;
    const clamped = Math.max(0, Math.min(index, list.length - 1));
    list[clamped]?.focus();
  }
  /** ArrowUp/Down within the row list; ArrowUp from the first row returns to the
   *  Input. Returns true when it handled the key. */
  function onRowKeyDown(e: ReactKeyboardEvent, index: number): boolean {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(index + 1);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (index === 0) inputRef.current?.focus();
      else focusRow(index - 1);
      return true;
    }
    return false;
  }

  function toggle(name: string, on: boolean) {
    setDraft((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  }

  // Commit-on-close (INCLUDING Escape) is deliberate: it mirrors the app's
  // established labels idiom (conversations/LabelsPopover — "committed as one
  // batched mutation on close") and GitHub's own labels UX. Changing to an
  // explicit Save/Discard would diverge the two labels editors — if the idiom
  // changes, both change together as their own change.
  function handleOpenChange(o: boolean) {
    if (o) {
      setDraft(new Set(labels));
      setQuery("");
      setOpen(true);
      return;
    }
    setOpen(false);
    // Commit only when the set actually changed, so opening/closing without an
    // edit never fires a redundant replace.
    const applied = new Set(labels);
    const changed =
      draft.size !== applied.size || [...draft].some((n) => !applied.has(n));
    if (changed) {
      setLabels.mutate(
        { issueKey, labels: [...draft].sort() },
        { onError: toastError },
      );
    }
  }

  // The known labels filtered by the query, plus any drafted labels not in the
  // known set (e.g. just-created ones, or labels already on the issue that the
  // first page didn't return) so a checked draft label is always visible.
  const options = useMemo(() => {
    const all = new Set<string>([...(known.data ?? []), ...draft]);
    const q = trimmed.toLowerCase();
    return [...all]
      .filter((n) => !q || n.toLowerCase().includes(q))
      .sort((a, b) => a.localeCompare(b));
  }, [known.data, draft, trimmed]);

  // Offer to create the typed label when it's a valid, non-existing string.
  const canCreate =
    trimmed.length > 0 &&
    !hasWhitespace &&
    !options.some((n) => n.toLowerCase() === trimmed.toLowerCase());

  function create() {
    if (!canCreate) return;
    toggle(trimmed, true);
    setQuery("");
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Popover.Root open={open} onOpenChange={handleOpenChange}>
        <Popover.Trigger
          render={<Button variant="ghost" size="xs" aria-label="Edit labels" />}
        >
          <TagIcon data-icon="inline-start" />
          Labels
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner
            align="start"
            sideOffset={4}
            className="isolate z-50"
          >
            <Popover.Popup className="w-64 rounded-none bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10">
              <p className="px-1 pb-1.5 text-xs font-medium">Labels</p>
              <Input
                ref={inputRef}
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canCreate) {
                    e.preventDefault();
                    create();
                    return;
                  }
                  // ArrowDown drops focus into the row list (create row first
                  // when present, else the first option).
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    focusRow(0);
                  }
                }}
                placeholder="Filter or add a label…"
                aria-label="Filter or add a label"
                aria-invalid={hasWhitespace}
                className="h-7"
              />
              {hasWhitespace && (
                <p className="px-1 pt-1 text-[11px] text-destructive">
                  Labels can't contain spaces.
                </p>
              )}
              <div ref={listRef}>
                {canCreate && (
                  <button
                    type="button"
                    data-label-row
                    tabIndex={-1}
                    onClick={create}
                    onKeyDown={(e) => {
                      // Enter/Space activate the create row (it's a <button>, so
                      // the browser already fires onClick for both — just guard
                      // the arrows here). Its index is 0 (it renders first).
                      onRowKeyDown(e, 0);
                    }}
                    className="mt-1 flex w-full cursor-pointer items-center gap-2 px-1 py-1.5 text-left text-xs outline-none hover:bg-muted/60 focus-visible:bg-muted/60"
                  >
                    <TagIcon className="size-3 shrink-0" />
                    Add “{trimmed}”
                  </button>
                )}
                <div className="mt-1 max-h-56 overflow-y-auto">
                  {/* Honest error copy + retry when the fetch failed and there are
                    no local (drafted/checked) options to fall back on. Any
                    drafted labels still merge into `options` below and stay
                    toggleable even while the fetch is failing. */}
                  {options.length === 0 && !canCreate && known.isError ? (
                    <button
                      type="button"
                      // data-label-row: keeps ArrowDown-from-input reaching the
                      // retry row in the error state (it's the only row then).
                      data-label-row
                      tabIndex={-1}
                      onClick={() => known.refetch()}
                      className="flex w-full cursor-pointer items-center px-1 py-1 text-left text-xs text-muted-foreground hover:text-foreground"
                    >
                      Couldn't load labels — retry
                    </button>
                  ) : (
                    options.length === 0 &&
                    !canCreate && (
                      <p className="px-1 py-1 text-xs text-muted-foreground">
                        {known.isPending
                          ? "Loading labels…"
                          : trimmed
                            ? "No matching labels."
                            : "This site has no labels."}
                      </p>
                    )
                  )}
                  {options.map((name, i) => {
                    // Traversal index: the create row (when present) is 0, so the
                    // option rows follow it.
                    const rowIndex = (canCreate ? 1 : 0) + i;
                    const checked = draft.has(name);
                    return (
                      // Roving-focus row: a checkbox stays visible (semantics
                      // unchanged) but the ROW is the focusable, arrow-navigable
                      // element (tabIndex={-1}); Space/Enter toggles the draft.
                      <div
                        key={name}
                        data-label-row
                        role="checkbox"
                        aria-checked={checked}
                        tabIndex={-1}
                        onClick={() => toggle(name, !checked)}
                        onKeyDown={(e) => {
                          if (onRowKeyDown(e, rowIndex)) return;
                          if (e.key === " " || e.key === "Enter") {
                            e.preventDefault();
                            toggle(name, !checked);
                          }
                        }}
                        className="flex cursor-pointer items-center gap-2 px-1 py-1.5 text-xs outline-none hover:bg-muted/60 focus-visible:bg-muted/60"
                      >
                        <Checkbox checked={checked} tabIndex={-1} aria-hidden />
                        <span className="flex-1 truncate" title={name}>
                          {name}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
              <p className="mt-1 border-t px-1 pt-1.5 text-[11px] text-muted-foreground">
                Changes apply when this closes.
              </p>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {labels.map((label) => (
        <span
          key={label}
          className="border px-1.5 py-0.5 text-[11px] text-muted-foreground"
        >
          {label}
        </span>
      ))}
    </div>
  );
}

/**
 * One comment in the detail's comment list. On the viewer's OWN comments (matched
 * by accountId) it grows an always-visible compact "⋯" actions menu (never
 * hover-revealed): Edit swaps the body for a MarkdownEditor pre-filled with the
 * comment's markdown (mod+enter submits, matching the composer); Delete confirms
 * before firing. The menu is absent entirely when neither permission is granted.
 * Editing state is local, so a background refetch never wipes an open draft.
 */
function JiraCommentItem({
  repoPath,
  link,
  issueKey,
  comment,
  isOwn,
  canEdit,
  canDelete,
}: {
  repoPath: string;
  /** `null` during the link-pending window (a cached detail can still render
   *  before the link query settles) — the read-only body/header always render;
   *  the edit/delete affordances are simply absent until a link is present. */
  link: JiraLink | null;
  issueKey: string;
  comment: JiraComment;
  isOwn: boolean;
  canEdit: boolean;
  canDelete: boolean;
}) {
  const edit = useJiraCommentEdit(repoPath, link);
  const del = useJiraCommentDelete(repoPath, link);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const editorRef = useRef<MarkdownEditorHandle>(null);

  // Focus the editor when entering edit mode — one frame LATE, because the
  // actions DropdownMenu returns focus to its trigger as it closes, which
  // lands AFTER the textarea's autoFocus mount and steals it (caught live).
  useEffect(() => {
    if (!editing) return;
    const raf = requestAnimationFrame(() => editorRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [editing]);

  // Edit/delete require a live link (the mutations key on its site). During the
  // link-pending window the menu is simply absent — the comment still renders.
  const showMenu = link !== null && isOwn && (canEdit || canDelete);
  const edited =
    comment.updatedAt != null && comment.updatedAt !== comment.createdAt;

  function beginEdit() {
    setDraft(comment.bodyMd);
    setEditing(true);
  }

  function saveEdit() {
    const body = draft.trim();
    if (!body || body === comment.bodyMd.trim()) {
      setEditing(false);
      return;
    }
    edit.mutate(
      { issueKey, commentId: comment.id, bodyMd: body },
      {
        onSuccess: () => setEditing(false),
        onError: toastError,
      },
    );
  }

  function doDelete() {
    del.mutate(
      { issueKey, commentId: comment.id },
      {
        onSuccess: () => toast.success("Comment deleted"),
        onError: toastError,
      },
    );
    setConfirmDelete(false);
  }

  return (
    <div className="space-y-1">
      <p className="flex items-center gap-2 text-xs">
        {comment.author && (
          <ForgeUserAvatar user={comment.author} ghHost={null} />
        )}
        <span className="font-medium">
          {comment.author?.label ?? "unknown"}
        </span>
        <span className="text-muted-foreground">
          {formatRelativeTime(comment.createdAt)}
        </span>
        {edited && (
          <span className="text-muted-foreground italic">(edited)</span>
        )}
        {showMenu && !editing && (
          <>
            <span className="flex-1" />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Comment actions"
                    className="text-muted-foreground hover:text-foreground data-popup-open:text-foreground"
                  />
                }
              >
                <DotsThreeIcon className="size-4" weight="bold" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                {canEdit && (
                  <DropdownMenuItem onClick={beginEdit}>Edit</DropdownMenuItem>
                )}
                {canDelete && (
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setConfirmDelete(true)}
                  >
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </p>
      {editing ? (
        <div className="space-y-2">
          <MarkdownEditor
            ref={editorRef}
            aria-label="Edit comment"
            value={draft}
            onChange={setDraft}
            onKeyDown={(e) => {
              if (
                (e.ctrlKey || e.metaKey) &&
                e.key === "Enter" &&
                draft.trim() &&
                !edit.isPending
              ) {
                e.preventDefault();
                saveEdit();
              }
            }}
            rows={3}
            disabled={edit.isPending}
            textareaClassName="max-h-48 min-h-16 resize-y"
          />
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={
                !draft.trim() ||
                draft.trim() === comment.bodyMd.trim() ||
                edit.isPending
              }
              onClick={saveEdit}
              title={SUBMIT_HINT}
            >
              Save
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={edit.isPending}
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : comment.bodyMd.trim() ? (
        <Markdown>{comment.bodyMd}</Markdown>
      ) : (
        <p className="text-xs text-muted-foreground italic">(empty comment)</p>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onCancel={() => setConfirmDelete(false)}
        title="Delete comment?"
        body="This permanently deletes your comment on this Jira issue. This cannot be undone."
        confirmLabel="Delete comment"
        confirmVariant="destructive"
        pending={del.isPending}
        onConfirm={doDelete}
      />
    </div>
  );
}

/**
 * One worklog entry. Read-only for everyone; on the viewer's OWN entries (matched
 * by accountId) and with the matching permission it grows an always-visible
 * Edit/Delete pair (never hover-revealed). Edit is an inline row: duration + note
 * inputs prefilled, Enter commits, Esc cancels. The note is send-only-when-changed
 * (unchanged ⇒ duration-only update); EMPTYING a previously non-empty note is
 * blocked with an explanatory warning (Jira can't remove a note). Delete confirms.
 */
function JiraWorklogItem({
  repoPath,
  link,
  issueKey,
  worklog,
  isOwn,
  canEdit,
  canDelete,
}: {
  repoPath: string;
  /** `null` during the link-pending window — the read-only row always renders;
   *  the edit/delete affordances are simply absent until a link is present. */
  link: JiraLink | null;
  issueKey: string;
  worklog: JiraWorklog;
  isOwn: boolean;
  canEdit: boolean;
  canDelete: boolean;
}) {
  const update = useJiraUpdateWorklog(repoPath, link);
  const del = useJiraDeleteWorklog(repoPath, link);
  const [editing, setEditing] = useState(false);
  const [durationDraft, setDurationDraft] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Edit/delete require a live link (the mutations key on its site). During the
  // link-pending window the actions are simply absent — the row still renders.
  const showActions = link !== null && isOwn && (canEdit || canDelete);
  const hadNote = worklog.commentMd.trim().length > 0;

  const durationTrimmed = durationDraft.trim();
  const durationValid = isValidJiraDuration(durationTrimmed);
  const noteChanged = noteDraft !== worklog.commentMd;
  // Blocked: the user cleared a note that previously existed. Jira can't remove a
  // note once set — explain rather than silently drop or 400.
  const noteRemoved = hadNote && noteChanged && noteDraft.trim().length === 0;
  const canSaveEdit =
    durationValid && !noteRemoved && !update.isPending;

  function beginEdit() {
    setDurationDraft(worklog.timeSpent);
    setNoteDraft(worklog.commentMd);
    setEditing(true);
  }

  function saveEdit() {
    if (!canSaveEdit) return;
    update.mutate(
      {
        issueKey,
        worklogId: worklog.id,
        timeSpent: durationTrimmed,
        // Send the note ONLY when it changed to non-empty text (unchanged ⇒
        // undefined = leave as-is). Emptying an existing note is blocked above;
        // a whitespace-only draft on a note-less entry degrades to duration-only
        // rather than tripping the backend's can't-remove-a-note error.
        commentMd:
          noteChanged && noteDraft.trim().length > 0 ? noteDraft : undefined,
      },
      {
        onSuccess: () => setEditing(false),
        onError: toastError,
      },
    );
  }

  function doDelete() {
    del.mutate(
      { issueKey, worklogId: worklog.id },
      {
        onSuccess: () => toast.success("Worklog deleted"),
        onError: toastError,
      },
    );
    setConfirmDelete(false);
  }

  return (
    <div className="space-y-1">
      <p className="flex items-center gap-2 text-xs">
        {worklog.author && <ForgeUserAvatar user={worklog.author} ghHost={null} />}
        <span className="font-medium">{worklog.author?.label ?? "unknown"}</span>
        <span className="tabular-nums text-muted-foreground">
          {worklog.timeSpent}
        </span>
        <span className="text-muted-foreground">
          {formatRelativeTime(worklog.started)}
        </span>
        {showActions && !editing && (
          <>
            <span className="flex-1" />
            {canEdit && (
              <Button
                variant="ghost"
                size="xs"
                className="text-muted-foreground hover:text-foreground"
                aria-label="Edit worklog"
                onClick={beginEdit}
              >
                Edit
              </Button>
            )}
            {canDelete && (
              <Button
                variant="ghost"
                size="xs"
                className="text-muted-foreground hover:text-destructive"
                aria-label="Delete worklog"
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </Button>
            )}
          </>
        )}
      </p>
      {editing ? (
        <div className="space-y-1.5">
          <Input
            className="h-7"
            value={durationDraft}
            onChange={(e) => setDurationDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
                return;
              }
              if (e.key === "Enter" && canSaveEdit) {
                e.preventDefault();
                saveEdit();
              }
            }}
            placeholder="Time spent (e.g. 3h 30m)"
            aria-label="Edit time spent"
            aria-invalid={durationTrimmed.length > 0 && !durationValid}
            disabled={update.isPending}
          />
          <Input
            className="h-7"
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
                return;
              }
              if (e.key === "Enter" && canSaveEdit) {
                e.preventDefault();
                saveEdit();
              }
            }}
            placeholder="Note (optional)"
            aria-label="Edit worklog note"
            disabled={update.isPending}
          />
          {durationTrimmed.length > 0 && !durationValid && (
            <p className="text-[11px] text-destructive">
              Enter a Jira duration like 3h 30m or 1d.
            </p>
          )}
          {noteRemoved && (
            <p className="text-[11px] text-destructive">
              A note can't be removed once set — replace it, or delete this entry
              and log again.
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={!canSaveEdit}
              onClick={saveEdit}
            >
              Save
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={update.isPending}
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        worklog.commentMd.trim() && <Markdown>{worklog.commentMd}</Markdown>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onCancel={() => setConfirmDelete(false)}
        title="Delete worklog?"
        body="This permanently deletes your logged work on this Jira issue and restores the remaining estimate. This cannot be undone."
        confirmLabel="Delete worklog"
        confirmVariant="destructive"
        pending={del.isPending}
        onConfirm={doDelete}
      />
    </div>
  );
}

/**
 * The permission-gated "Time tracking" section for the issue rail. Rendered ONLY
 * when the feature is enabled on the project (`timeTracking !== null`) — feature
 * disabled ⇒ no section at all, regardless of permissions. Shows the
 * Original/Remaining/Spent figures with a spent-vs-original progress bar (values
 * always spelled out so meaning never rests on the bar color), then — gated per
 * permission — log-work inputs, original/remaining estimate editors, and the
 * worklog list. All mutations are non-optimistic; the section re-fetches on
 * settle, so a typed value may differ from the server-derived truth that lands.
 */
function JiraTimeTrackingSection({
  repoPath,
  link,
  issueKey,
  tracking,
  worklogs,
  worklogsTotal,
  viewerAccountId,
  issueUrl,
  canLogWork,
  canEditEstimates,
  canEditOwnWorklogs,
  canDeleteOwnWorklogs,
}: {
  repoPath: string;
  link: JiraLink | null;
  issueKey: string;
  tracking: JiraTimeTrackingData;
  worklogs: JiraWorklog[];
  worklogsTotal: number;
  viewerAccountId: string | null;
  issueUrl: string;
  canLogWork: boolean;
  canEditEstimates: boolean;
  canEditOwnWorklogs: boolean;
  canDeleteOwnWorklogs: boolean;
}) {
  const logWork = useJiraLogWork(repoPath, link);
  const setOriginal = useJiraSetOriginalEstimate(repoPath, link);
  const setRemaining = useJiraSetRemainingEstimate(repoPath, link);

  const [logDuration, setLogDuration] = useState("");
  const [logNote, setLogNote] = useState("");

  const originalSeconds = tracking.originalEstimateSeconds ?? 0;
  const spentSeconds = tracking.timeSpentSeconds ?? 0;
  // 0 seconds is treated the same as "none" in the display: after all worklogs
  // are deleted Jira lingers timeSpent as "0m"/0s (probed), and an unset field
  // is null/0 too — both read as "—".
  const originalStr = originalSeconds > 0 ? tracking.originalEstimate : null;
  const remainingStr =
    (tracking.remainingEstimateSeconds ?? 0) > 0
      ? tracking.remainingEstimate
      : null;
  const spentStr = spentSeconds > 0 ? tracking.timeSpent : null;

  // Progress + overage are only meaningful when both an estimate and spent exist.
  const pct =
    originalSeconds > 0
      ? Math.min(100, Math.round((spentSeconds / originalSeconds) * 100))
      : 0;
  const overSpent = originalSeconds > 0 && spentSeconds > originalSeconds;

  const logTrimmed = logDuration.trim();
  const logValid = isValidJiraDuration(logTrimmed);

  function submitLog() {
    if (!logValid || logWork.isPending) return;
    const note = logNote.trim();
    logWork.mutate(
      {
        issueKey,
        timeSpent: logTrimmed,
        // Only send a note when the user typed one (empty ⇒ noteless entry).
        commentMd: note ? note : undefined,
      },
      {
        onSuccess: () => {
          setLogDuration("");
          setLogNote("");
          toast.success(`Logged ${logTrimmed} on ${issueKey}`);
        },
        onError: toastError,
      },
    );
  }

  return (
    <section className="space-y-2" aria-label="Time tracking">
      <p className="text-[11px] font-medium text-muted-foreground">
        Time tracking
      </p>
      {/* Display (always) — the three figures + optional progress bar. */}
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-muted-foreground">Original</span>
          <span className="tabular-nums">{originalStr ?? "—"}</span>
        </div>
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-muted-foreground">Remaining</span>
          <span className="tabular-nums">{remainingStr ?? "—"}</span>
        </div>
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-muted-foreground">Spent</span>
          <span className={cn("tabular-nums", overSpent && "text-warning")}>
            {spentStr ?? "—"}
          </span>
        </div>
        {originalSeconds > 0 && spentSeconds > 0 && (
          <div
            className="h-1 w-full bg-muted"
            aria-hidden
            title={`${spentStr} of ${originalStr}`}
          >
            <div
              className={cn(
                "h-full transition-[width]",
                overSpent ? "bg-warning" : "bg-primary",
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
        {overSpent && (
          <p className="text-[11px] text-warning">
            {formatHmDelta(spentSeconds - originalSeconds)} over
          </p>
        )}
        {originalSeconds === 0 && spentSeconds === 0 && (
          <p className="text-[11px] text-muted-foreground">No time tracked.</p>
        )}
      </div>

      {/* Log work (when permitted). Enter in either input commits. */}
      {canLogWork && (
        <div className="space-y-1.5 pt-0.5">
          <Input
            className="h-7"
            value={logDuration}
            onChange={(e) => setLogDuration(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitLog();
              }
            }}
            placeholder="Log work (e.g. 3h 30m)"
            aria-label="Log work"
            aria-invalid={logTrimmed.length > 0 && !logValid}
            disabled={logWork.isPending}
          />
          <Input
            className="h-7"
            value={logNote}
            onChange={(e) => setLogNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitLog();
              }
            }}
            placeholder="Note (optional)"
            aria-label="Worklog note"
            disabled={logWork.isPending}
          />
          {logTrimmed.length > 0 && !logValid && (
            <p className="text-[11px] text-destructive">
              Enter a Jira duration like 3h 30m or 1d.
            </p>
          )}
          <Button
            size="xs"
            variant="outline"
            disabled={!logValid || logWork.isPending}
            onClick={submitLog}
          >
            Log
          </Button>
        </div>
      )}

      {/* Estimates (when permitted). Commit on blur/Enter; uncontrolled-while-
          focused (key + defaultValue), matching the GitLab TimeTrackingControls
          idiom. Grammar-validated before send; a redundant same-value edit is
          skipped. Server derivation may change what lands — that's expected. */}
      {canEditEstimates && (
        <div className="space-y-1.5 pt-0.5">
          <JiraEstimateInput
            label="Set original estimate"
            placeholder="Original estimate (e.g. 2d)"
            currentDisplay={tracking.originalEstimate ?? ""}
            hasValue={originalSeconds > 0}
            pending={setOriginal.isPending}
            onSet={(estimate) =>
              setOriginal.mutate({ issueKey, estimate }, { onError: toastError })
            }
          />
          <JiraEstimateInput
            label="Set remaining estimate"
            placeholder="Remaining estimate (e.g. 1d)"
            currentDisplay={tracking.remainingEstimate ?? ""}
            hasValue={(tracking.remainingEstimateSeconds ?? 0) > 0}
            pending={setRemaining.isPending}
            onSet={(estimate) =>
              setRemaining.mutate({ issueKey, estimate }, { onError: toastError })
            }
          />
        </div>
      )}

      {/* Worklog list (all authors, read-only; own entries gain edit/delete). */}
      {worklogs.length > 0 && (
        <div className="space-y-2 border-t pt-2">
          {worklogs.map((w) => (
            <JiraWorklogItem
              key={w.id}
              repoPath={repoPath}
              link={link}
              issueKey={issueKey}
              worklog={w}
              isOwn={viewerAccountId != null && w.author?.id === viewerAccountId}
              canEdit={canEditOwnWorklogs}
              canDelete={canDeleteOwnWorklogs}
            />
          ))}
          {worklogsTotal > worklogs.length && (
            <button
              type="button"
              onClick={() => openUrl(issueUrl)}
              className="inline-flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <ArrowSquareOutIcon className="size-3 shrink-0" />
              View all {worklogsTotal} in Jira
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * One estimate input (original or remaining). Uncontrolled-while-focused: `key`
 * on the display string + `defaultValue` reset it whenever the server value
 * changes, exactly the GitLab TimeTrackingControls idiom. Commits on blur/Enter
 * when the trimmed value both changed and is a valid Jira duration; an invalid
 * grammar surfaces an inline warning and blocks the commit. A Clear button
 * (present only when a value is set) clears the estimate (`null`).
 */
function JiraEstimateInput({
  label,
  placeholder,
  currentDisplay,
  hasValue,
  pending,
  onSet,
}: {
  label: string;
  placeholder: string;
  currentDisplay: string;
  hasValue: boolean;
  pending: boolean;
  onSet: (estimate: string | null) => void;
}) {
  // Local invalid flag so the warning renders while the field is focused (the
  // input itself stays uncontrolled). Reset whenever the server value changes.
  const [invalid, setInvalid] = useState(false);

  function commit(raw: string) {
    const next = raw.trim();
    // No-op: unchanged from the current display — never fire a redundant PUT.
    if (next === currentDisplay.trim()) {
      setInvalid(false);
      return;
    }
    if (next.length > 0 && !isValidJiraDuration(next)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onSet(next.length > 0 ? next : null);
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <Input
          key={currentDisplay}
          defaultValue={currentDisplay}
          className="h-7"
          placeholder={placeholder}
          aria-label={label}
          aria-invalid={invalid}
          disabled={pending}
          onChange={() => {
            if (invalid) setInvalid(false);
          }}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        {hasValue && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="shrink-0 text-muted-foreground"
            disabled={pending}
            onClick={() => {
              setInvalid(false);
              onSet(null);
            }}
          >
            Clear
          </Button>
        )}
      </div>
      {invalid && (
        <p className="text-[11px] text-destructive">
          Enter a Jira duration like 3h 30m or 1d.
        </p>
      )}
    </div>
  );
}

/**
 * Detail view for one Jira issue: header (key + summary + status chip), a muted
 * meta row (type, priority, assignee, reporter, due date / resolution), agile
 * fields, label chips, time tracking, the description and comments rendered as
 * markdown, and a "View in Jira" link-out. Every write affordance (transition,
 * assign, due date, priority, labels, comment, time tracking) is gated on the
 * caller's Jira project permissions — anything not permitted simply isn't
 * rendered, never disabled.
 */
export function JiraIssueView({
  repoPath,
  issueKey,
}: {
  repoPath: string;
  issueKey: string;
}) {
  const link = useJiraLink(repoPath);
  const selectIssue = useUiStore((s) => s.selectIssue);
  const details = useJiraIssue(repoPath, link.data, issueKey);
  // Per-project write permissions gate every affordance below: permitted →
  // rendered, not-permitted (or a failed probe → every flag `?? false`) →
  // absent. Never disabled. The read path above is unaffected by this query.
  const perms = useJiraPermissions(repoPath, link.data);
  const canComment = perms.data?.addComments ?? false;
  const canTransition = perms.data?.transitionIssues ?? false;
  const canAssign = perms.data?.assignIssues ?? false;
  const canSchedule = perms.data?.scheduleIssues ?? false;
  const canEditIssue = perms.data?.editIssues ?? false;
  const canEditOwnComments = perms.data?.editOwnComments ?? false;
  const canDeleteOwnComments = perms.data?.deleteOwnComments ?? false;
  const canLogWork = perms.data?.workOnIssues ?? false;
  const canEditOwnWorklogs = perms.data?.editOwnWorklogs ?? false;
  const canDeleteOwnWorklogs = perms.data?.deleteOwnWorklogs ?? false;

  const comment = useJiraComment(repoPath, link.data);
  const transition = useJiraTransition(repoPath, link.data);
  const transitionTo = useJiraTransitionTo(repoPath, link.data);
  const setDueDate = useJiraSetDueDate(repoPath, link.data);
  const [composeBody, setComposeBody] = useState("");
  const composerRef = useRef<MarkdownEditorHandle>(null);

  // The link resolved to nothing (unlinked, or unlinked while this view was
  // open): the issue query is disabled, so it would otherwise sit on a pending
  // skeleton forever. Teach + offer a way back rather than stranding it. Wait for
  // the link query itself to settle first so we don't flash this during load.
  if (!link.isPending && !link.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="max-w-sm text-xs text-muted-foreground">
          This repository is no longer linked to a Jira project.
        </p>
        <Button variant="outline" size="sm" onClick={() => selectIssue(null)}>
          Back to issues
        </Button>
      </div>
    );
  }

  if (details.isPending) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (details.isError || !details.data) {
    return <DiffPlaceholder message="Could not load this Jira issue" />;
  }

  const issue: JiraIssueDetails = details.data;
  const isDone = issue.statusCategory === "done";
  const busy =
    comment.isPending || transition.isPending || transitionTo.isPending;

  function submitComment() {
    const body = composeBody.trim();
    if (!body) return;
    // Clear the draft immediately (perceived speed); restore it on error, but
    // only if the composer is still empty so we never clobber newly-typed text.
    setComposeBody("");
    comment.mutate(
      { issueKey, bodyMd: body },
      {
        onError: (e) => {
          setComposeBody((cur) => (cur.trim() ? cur : body));
          toastError(e);
        },
      },
    );
  }

  function doTransition(direction: "close" | "reopen") {
    transition.mutate(
      { issueKey, direction },
      {
        onSuccess: (r) =>
          toast.success(
            direction === "close"
              ? `Closed ${issueKey} · ${r.statusName}`
              : `Reopened ${issueKey} · ${r.statusName}`,
          ),
        onError: toastError,
      },
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="space-y-2 border-b px-4 py-3">
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 text-sm font-medium">
            <span className="font-mono font-normal text-muted-foreground">
              {issue.key}
            </span>{" "}
            {issue.summary}
          </h2>
          <span className="flex-1" />
          {canTransition &&
            (isDone ? (
              <Button
                variant="outline"
                size="xs"
                disabled={busy}
                onClick={() => doTransition("reopen")}
                title="Reopen this issue"
              >
                <ArrowCounterClockwiseIcon data-icon="inline-start" />
                Reopen
              </Button>
            ) : (
              <Button
                variant="outline"
                size="xs"
                disabled={busy}
                onClick={() => doTransition("close")}
                title="Close this issue"
              >
                <CheckCircleIcon data-icon="inline-start" />
                Close
              </Button>
            ))}
          <Button
            variant="outline"
            size="xs"
            className="cursor-pointer"
            onClick={() => openUrl(issue.url)}
            title="Open this issue in Jira"
          >
            <ArrowSquareOutIcon data-icon="inline-start" />
            Jira
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {canTransition && link.data ? (
            <StatusMenu
              repoPath={repoPath}
              link={link.data}
              issueKey={issueKey}
              category={issue.statusCategory}
              name={issue.statusName}
              busy={busy}
              transitionTo={transitionTo}
            />
          ) : (
            <StatusChip
              category={issue.statusCategory}
              name={issue.statusName}
            />
          )}
          <IssueTypeMeta
            iconUrl={issue.issueTypeIconUrl}
            name={issue.issueTypeName}
          />
          {canEditIssue && link.data ? (
            <span className="inline-flex items-center gap-1">
              <span>·</span>
              <JiraPriorityMenu
                repoPath={repoPath}
                link={link.data}
                issueKey={issueKey}
                priorityName={issue.priorityName}
              />
            </span>
          ) : (
            issue.priorityName && <span>· {issue.priorityName}</span>
          )}
          <span>· opened {formatRelativeTime(issue.createdAt)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {canAssign && link.data ? (
            <span className="inline-flex items-center gap-1.5">
              <span>Assignee:</span>
              <JiraAssigneePicker
                repoPath={repoPath}
                link={link.data}
                issueKey={issueKey}
                assignee={issue.assignee}
              />
            </span>
          ) : (
            issue.assignee && (
              <span className="inline-flex items-center gap-1.5">
                <ForgeUserAvatar user={issue.assignee} ghHost={null} />
                <span>Assignee: {issue.assignee.label}</span>
              </span>
            )
          )}
          {issue.reporter && (
            <span className="inline-flex items-center gap-1.5">
              <ForgeUserAvatar user={issue.reporter} ghHost={null} />
              <span>Reporter: {issue.reporter.label}</span>
            </span>
          )}
          {canSchedule && link.data ? (
            <div className="w-40">
              <DueDateRow
                value={issue.dueDate}
                open={issue.statusCategory !== "done"}
                pending={setDueDate.isPending}
                onChange={(dueDate) =>
                  setDueDate.mutate(
                    { issueKey, dueDate },
                    { onError: toastError },
                  )
                }
              />
            </div>
          ) : (
            issue.dueDate && <span>Due {issue.dueDate}</span>
          )}
          {issue.resolutionName && (
            <span>Resolution: {issue.resolutionName}</span>
          )}
          {issue.storyPoints != null && (
            <span>Story points: {formatStoryPoints(issue.storyPoints)}</span>
          )}
          {issue.sprintName && (
            <span>
              Sprint: {issue.sprintName}
              {issue.sprintState ? ` (${issue.sprintState})` : ""}
            </span>
          )}
          {issue.parent && (
            <button
              type="button"
              // Navigate to the parent in-app. This view already lives inside
              // the Issues tab, so `selectIssue` alone re-targets it — no
              // `setRepoTab` needed (unlike JiraRefRow, which renders on OTHER
              // tabs and must switch to Issues first).
              // The `issue.parent &&` below is NOT dead: TS narrowing from the
              // outer `{issue.parent && …}` doesn't extend into a callback
              // (TS18047 without it) — it satisfies the compiler, not runtime.
              onClick={() =>
                issue.parent &&
                selectIssue({ kind: "jira", id: issue.parent.key })
              }
              title={`${issue.parent.key} ${issue.parent.summary}`}
              aria-label={`Open parent issue ${issue.parent.key}`}
              className="inline-flex cursor-pointer items-center gap-1 border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
            >
              <span>Parent:</span>
              <span className="font-mono">{issue.parent.key}</span>
              <span className="max-w-[16rem] truncate">
                {issue.parent.summary}
              </span>
            </button>
          )}
        </div>
        {canEditIssue && link.data ? (
          <JiraLabelsPopover
            repoPath={repoPath}
            link={link.data}
            issueKey={issueKey}
            labels={issue.labels}
          />
        ) : (
          issue.labels.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {issue.labels.map((label) => (
                <span
                  key={label}
                  className="border px-1.5 py-0.5 text-[11px] text-muted-foreground"
                >
                  {label}
                </span>
              ))}
            </div>
          )
        )}
        {/* Each chip group is prefixed with a muted label so the three
            visually-identical bare-chip sets (labels / components / fix
            versions) are never ambiguous. Rendered only when non-empty. */}
        {issue.components.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">
              Components
            </span>
            {issue.components.map((component) => (
              <span
                key={component}
                className="border px-1.5 py-0.5 text-[11px] text-muted-foreground"
              >
                {component}
              </span>
            ))}
          </div>
        )}
        {issue.fixVersions.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">
              Fix versions
            </span>
            {issue.fixVersions.map((version) => (
              <span
                key={version}
                className="border px-1.5 py-0.5 text-[11px] text-muted-foreground"
              >
                {version}
              </span>
            ))}
          </div>
        )}
        {/* Time tracking — only when the feature is enabled on the project
            (timeTracking !== null); disabled ⇒ no section at all. */}
        {issue.timeTracking !== null && (
          <JiraTimeTrackingSection
            repoPath={repoPath}
            // `?? null`: render read-only during the link-pending window; the
            // write affordances are gated on `link` inside the section.
            link={link.data ?? null}
            issueKey={issueKey}
            tracking={issue.timeTracking}
            worklogs={issue.worklogs}
            worklogsTotal={issue.worklogsTotal}
            viewerAccountId={issue.viewerAccountId}
            issueUrl={issue.url}
            canLogWork={canLogWork}
            canEditEstimates={canEditIssue}
            canEditOwnWorklogs={canEditOwnWorklogs}
            canDeleteOwnWorklogs={canDeleteOwnWorklogs}
          />
        )}
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-4">
          <div className="border-b pb-3">
            {issue.descriptionMd.trim() ? (
              <Markdown>{issue.descriptionMd}</Markdown>
            ) : (
              <p className="text-xs text-muted-foreground italic">
                No description provided.
              </p>
            )}
          </div>
          {issue.comments.map((c) => (
            <JiraCommentItem
              key={c.id}
              repoPath={repoPath}
              // `?? null`: render read-only even during the link-pending window
              // (a cached detail can show before the link query settles) — the
              // early unlinked return only fires once the link settles null.
              link={link.data ?? null}
              issueKey={issueKey}
              comment={c}
              isOwn={
                issue.viewerAccountId != null &&
                c.author?.id === issue.viewerAccountId
              }
              canEdit={canEditOwnComments}
              canDelete={canDeleteOwnComments}
            />
          ))}
          {issue.comments.length === 0 && (
            <p className="text-xs text-muted-foreground">No comments yet.</p>
          )}
        </div>
      </ScrollArea>

      {canComment && (
        <div className="space-y-2 border-t p-3">
          <MarkdownEditor
            ref={composerRef}
            aria-label="Leave a comment"
            placeholder="Leave a comment…"
            value={composeBody}
            onChange={setComposeBody}
            onKeyDown={(e) => {
              if (
                (e.ctrlKey || e.metaKey) &&
                e.key === "Enter" &&
                composeBody.trim() &&
                !comment.isPending
              ) {
                e.preventDefault();
                submitComment();
              }
            }}
            rows={2}
            disabled={comment.isPending}
            textareaClassName="max-h-32 min-h-12 resize-y"
          />
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!composeBody.trim() || comment.isPending}
              onClick={submitComment}
              title={SUBMIT_HINT}
            >
              Comment
            </Button>
            {composeBody.trim() && (
              <Button
                variant="ghost"
                size="sm"
                disabled={comment.isPending}
                onClick={() => setComposeBody("")}
                title="Discard this draft"
              >
                Clear
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
