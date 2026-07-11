import {
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  CaretDownIcon,
  CheckCircleIcon,
  CircleDashedIcon,
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ForgeUserAvatar } from "@/components/forge-user-avatar";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "@/components/markdown-editor";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
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
import { Markdown } from "@/components/ui/markdown";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import type { ForgeUserRef } from "@/lib/git/types";
import { formatBinding } from "@/lib/hotkeys/binding";
import {
  useJiraAssign,
  useJiraComment,
  useJiraIssue,
  useJiraLink,
  useJiraPermissions,
  useJiraTransition,
  useJiraTransitions,
  useJiraTransitionTo,
  useJiraUserSearch,
} from "@/lib/jira/queries";
import type { JiraLink } from "@/lib/jira/store";
import type { JiraIssueDetails, JiraStatusCategory } from "@/lib/jira/types";
import { useUiStore } from "@/lib/stores/ui";
import { formatRelativeTime } from "@/lib/time";
import { toastError } from "@/lib/toast";

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
 * Read-only detail for one Jira issue: header (key + summary + status chip), a
 * muted meta row (type, priority, assignee, reporter, due date / resolution),
 * label chips, the description and comments rendered as markdown, and a "View in
 * Jira" link-out. No write affordances in phase 1 — none rendered, not disabled.
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

  const comment = useJiraComment(repoPath, link.data);
  const transition = useJiraTransition(repoPath, link.data);
  const transitionTo = useJiraTransitionTo(repoPath, link.data);
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
          {issue.priorityName && <span>· {issue.priorityName}</span>}
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
          {issue.dueDate && <span>Due {issue.dueDate}</span>}
          {issue.resolutionName && (
            <span>Resolution: {issue.resolutionName}</span>
          )}
        </div>
        {issue.labels.length > 0 && (
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
            <div key={c.id} className="space-y-1">
              <p className="flex items-center gap-2 text-xs">
                {c.author && <ForgeUserAvatar user={c.author} ghHost={null} />}
                <span className="font-medium">
                  {c.author?.label ?? "unknown"}
                </span>
                <span className="text-muted-foreground">
                  {formatRelativeTime(c.createdAt)}
                </span>
              </p>
              {c.bodyMd.trim() ? (
                <Markdown>{c.bodyMd}</Markdown>
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  (empty comment)
                </p>
              )}
            </div>
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
