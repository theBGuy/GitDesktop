import { Popover } from "@base-ui/react/popover";
import { CopyIcon, KanbanIcon } from "@phosphor-icons/react";
import { useEffect, useEffectEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { copyText } from "@/lib/clipboard";
import { presentError } from "@/lib/error-summary";
import {
  isReconnectHostSafe,
  reconnectHostArg,
  useActiveGhHost,
} from "@/lib/git/host";
import {
  useAvailableProjects,
  useEditItemProjects,
  useGhScopes,
  useItemProjects,
} from "@/lib/git/queries";
import type { ProjectV2Ref, RemoteLens } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { useUiStore } from "@/lib/stores/ui";
import { cn } from "@/lib/utils";

const NO_ACCESS_REASON = "You don't have write access to this project";
const READ_ONLY_SCOPE_REASON =
  "Your GitHub sign-in can read projects but not change them (needs the project scope)";

/** A closed board still holds items, so its rows and chips stay — the state rides
 *  the label as words, never as a colour. */
function projectLabel(project: ProjectV2Ref): string {
  return project.closed ? `${project.title} (closed)` : project.title;
}

/**
 * GitHub Projects (v2) membership editor + chips, shared by the issue and PR
 * views. Unlike the labels picker, memberships don't ride the parent entity, so
 * this owns both reads and the write. Edits are drafted while the popover is open
 * and committed as one batched mutation on close.
 */
export function ProjectsPopover({
  repoPath,
  enabled,
  kind,
  number,
  contentId,
  lens,
  disabledReason,
}: {
  repoPath: string;
  /** Gates the reads. Both call sites pass `true` — the real gate is the row-level
   *  `when` upstream, which never mounts this off GitHub. */
  enabled: boolean;
  /** Which surface this item is — the backend addresses issues and PRs apart. */
  kind: "issue" | "pr";
  number: number;
  /** The issue/PR GraphQL node id, which is what an add addresses. */
  contentId: string;
  /** The origin|upstream lens the parent PR/issue surface resolved. */
  lens: RemoteLens;
  /** Set when this picker can't be edited right now — the viewer lacks the access
   *  its action needs, or the surface is still loading the entity. The trigger
   *  stays visible but disabled and this text explains why. Absent = editable. */
  disabledReason?: string;
}) {
  const host = useActiveGhHost();
  const scopes = useGhScopes(host);
  const openReconnect = useUiStore((s) => s.openReconnect);
  // Only a classic token has readable scopes; a fine-grained/App token reports
  // none, so an absent `project` there is unknowable, not missing — fire the
  // reads and let the backend's own scope hint speak if it really is absent.
  const classicMissing =
    scopes.data?.classic === true &&
    !scopes.data.scopes.includes("project") &&
    !scopes.data.scopes.includes("read:project");
  // Read-only classic token: the reads work, every write 403s. Hold the rows
  // rather than letting each toggle round-trip to a rollback + toast.
  const readOnlyScope =
    scopes.data?.classic === true &&
    scopes.data.scopes.includes("read:project") &&
    !scopes.data.scopes.includes("project");
  const canRead = enabled && !classicMissing;

  // KNOWN LIMITATION, shared with LabelsPopover: a tab switch while this is open
  // strands the popup until that tab is revisited — the <Activity> hide freezes the
  // very subtree whose re-render would remove the portal, so no close initiated
  // here can win. Class fix is a planned follow-up; don't re-attempt it here.
  const [open, setOpen] = useState(false);
  // The catalog is an owner-wide query; it waits for a first open rather than
  // firing for every issue the user scrolls through.
  const [hasOpened, setHasOpened] = useState(false);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);

  const memberships = useItemProjects(repoPath, kind, number, canRead, lens);
  const available = useAvailableProjects(repoPath, canRead && hasOpened, lens);
  const editProjects = useEditItemProjects(repoPath, kind, number, lens);
  // Gated on `canRead` so a disabled query — the missing-scope path, whose whole
  // point is the popup's Reconnect button — can't hold the trigger shut forever.
  // An ERRORED read likewise mustn't hold it: the popup owns the Retry.
  const loadingMemberships = canRead && memberships.isPending;
  // Ranked: the caller's reason outranks a write the viewer started, which
  // outranks the first load.
  const heldReason = (() => {
    switch (true) {
      case disabledReason !== undefined:
        return disabledReason;
      // No second edit may be drafted while one is in flight: the cache still
      // holds `pending:` placeholders, and unlinking one has no item id to
      // address, so the close would drop it silently.
      case editProjects.isPending:
        return "Saving your last change…";
      case loadingMemberships:
        return "Loading projects…";
      default:
        return undefined;
    }
  })();

  const items = memberships.data ?? [];
  // Rows = the open catalog plus every membership, so a board beyond the server's
  // cap — or a closed one — is still there to be unlinked. OPEN catalog entries win
  // the dedup, that list being the authority on `viewerCanUpdate`; a closed board is
  // filtered out of the catalog first, so its membership copy represents it.
  const byId = new Map<string, ProjectV2Ref>();
  for (const project of available.data?.projects ?? []) {
    if (!project.closed) byId.set(project.id, project);
  }
  for (const item of items) {
    if (!byId.has(item.project.id)) byId.set(item.project.id, item.project);
  }
  const rows = [...byId.values()];
  const readError = memberships.error ?? available.error;
  // Locked rows are skipped by the arrow keys rather than made focus black holes:
  // a natively-disabled checkbox can't take focus.
  const rowLockedReason = readOnlyScope ? READ_ONLY_SCOPE_REASON : undefined;
  const navRows = rowLockedReason
    ? []
    : rows.filter((project) => project.viewerCanUpdate);
  const navIndexById = new Map(navRows.map((project, i) => [project.id, i]));
  const activeIndex =
    activeId === null ? -1 : (navIndexById.get(activeId) ?? -1);
  // Nothing active yet (or the active row vanished on a refetch) parks the single
  // tab stop on the first navigable row.
  const focusIndex = activeIndex === -1 ? 0 : activeIndex;
  const onRowKeyDown = listKeyboardNav({
    items: navRows,
    activeIndex,
    onActivate: (project) => setActiveId(project.id),
    rowKey: (project) => project.id,
  });

  // The only picker whose draft seeds from ASYNC data — the siblings seed from
  // synchronous props (RemotePrView's group comment: "commits against LIVE props").
  // A draft seeded before the memberships land would diff every existing link as
  // unchecked and unlink them all, so three guards: the trigger holds until they
  // settle, a late arrival unions into the draft, and the close refuses to diff
  // against an unsettled set.
  const unionSettledMemberships = useEffectEvent(() => {
    setDraft((prev) => {
      const next = new Set(prev);
      // Union, never replace: a row that didn't exist can't have been deliberately
      // unchecked, while an explicit toggle on a row that did must survive.
      for (const item of items) next.add(item.project.id);
      return next;
    });
  });
  useEffect(() => {
    if (open && memberships.isSuccess) unionSettledMemberships();
  }, [open, memberships.isSuccess]);

  function toggleDraft(id: string, on: boolean) {
    setDraft((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function handleOpenChange(o: boolean) {
    if (o) {
      setHasOpened(true);
      setDraft(new Set(items.map((item) => item.project.id)));
      setOpen(true);
      return;
    }
    setOpen(false);
    // Belt and braces on the seed hazard: an unsettled memberships read is not an
    // empty membership set, and an untrusted applied-set must never mint removes.
    if (!memberships.isSuccess) return;
    const applied = new Set(items.map((item) => item.project.id));
    const adds = [...draft]
      .filter((id) => !applied.has(id))
      .map((id) => byId.get(id))
      .filter((project): project is ProjectV2Ref => !!project);
    // A `pending:` item id belongs to an add that hasn't landed yet, so there is
    // nothing on the board to remove — the settling refetch reconciles it.
    const removes = items
      .filter(
        (item) =>
          !draft.has(item.project.id) && !item.itemId.startsWith("pending:"),
      )
      .map((item) => ({ projectId: item.project.id, itemId: item.itemId }));
    if (adds.length > 0 || removes.length > 0) {
      editProjects.mutate({ contentId, adds, removes });
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* Trigger first, so it never shifts as chips come and go. A natively
          disabled button swallows `title`, so the reason rides a wrapping span. */}
      <Popover.Root open={open} onOpenChange={handleOpenChange}>
        <span
          title={heldReason}
          className={
            heldReason ? "inline-flex cursor-not-allowed" : "inline-flex"
          }
        >
          <Popover.Trigger
            disabled={!!heldReason}
            render={
              <Button variant="ghost" size="xs" aria-label="Edit projects" />
            }
          >
            {editProjects.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <KanbanIcon data-icon="inline-start" />
            )}
            Projects
          </Popover.Trigger>
        </span>
        <Popover.Portal>
          <Popover.Positioner
            align="start"
            sideOffset={4}
            className="isolate z-50"
          >
            <Popover.Popup className="w-80 rounded-none bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10">
              <p className="px-1 pb-1.5 text-xs font-medium">Projects</p>
              {classicMissing ? (
                <MissingScopeBlock
                  host={host}
                  onReconnect={() =>
                    openReconnect({
                      provider: "github",
                      host,
                      mode: "refresh",
                      scopes: ["project"],
                    })
                  }
                />
              ) : (
                <>
                  {readError !== null && (
                    <div className="px-1 py-1 text-xs">
                      <p className="text-muted-foreground">
                        {presentError(readError).summary}
                      </p>
                      <Button
                        variant="outline"
                        size="xs"
                        className="mt-1.5"
                        onClick={() => {
                          memberships.refetch();
                          available.refetch();
                        }}
                      >
                        Retry
                      </Button>
                    </div>
                  )}
                  {rows.length === 0 && readError === null && (
                    <p className="px-1 py-1 text-xs text-muted-foreground">
                      {available.isPending
                        ? "Loading projects…"
                        : "No open projects in this repository or its owner."}
                    </p>
                  )}
                  <div
                    className="max-h-64 overflow-y-auto"
                    onKeyDown={onRowKeyDown}
                  >
                    {rows.map((project) => (
                      <ProjectRow
                        key={project.id}
                        project={project}
                        checked={draft.has(project.id)}
                        active={activeId === project.id}
                        rovingTab={
                          navIndexById.get(project.id) === focusIndex ? 0 : -1
                        }
                        lockedReason={rowLockedReason}
                        onToggle={(on) => toggleDraft(project.id, on)}
                        onFocus={() => setActiveId(project.id)}
                      />
                    ))}
                  </div>
                  {/* The truncation note stands alone: a 50-cap catalog of only
                      CLOSED boards renders zero rows, where a bare "no projects"
                      would be a lie. */}
                  {(rows.length > 0 || available.data?.truncated === true) && (
                    <div className="mt-1 border-t px-1 pt-1.5 text-[11px] text-muted-foreground">
                      {rows.length > 0 && (
                        <p>Changes apply when this closes.</p>
                      )}
                      {available.data?.truncated === true && (
                        <p>Some projects aren't shown.</p>
                      )}
                    </div>
                  )}
                </>
              )}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {items.map((item) => (
        <span
          key={item.itemId}
          className="inline-flex max-w-full items-center border px-1.5 py-0.5 text-[11px] text-muted-foreground"
          title={projectLabel(item.project)}
        >
          <span className="truncate">{projectLabel(item.project)}</span>
        </span>
      ))}
    </div>
  );
}

/** One board's checkbox row. A board the viewer can't change is held rather than
 *  hidden: the reason hovers on the row and is read out from the sr-only node,
 *  since a natively-disabled control announces neither. `lockedReason` holds EVERY
 *  row (a read-only token) and outranks the per-board one. */
function ProjectRow({
  project,
  checked,
  active,
  rovingTab,
  lockedReason,
  onToggle,
  onFocus,
}: {
  project: ProjectV2Ref;
  checked: boolean;
  active: boolean;
  /** Roving tabindex: one tab stop for the whole list, on the active row. */
  rovingTab: number;
  lockedReason?: string;
  onToggle: (on: boolean) => void;
  onFocus: () => void;
}) {
  const label = projectLabel(project);
  const held =
    lockedReason ?? (project.viewerCanUpdate ? null : NO_ACCESS_REASON);
  if (held !== null) {
    return (
      <div
        aria-disabled
        title={held}
        className="flex cursor-not-allowed items-center gap-2 px-1 py-1.5 text-xs opacity-50"
      >
        <Checkbox checked={checked} disabled />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="sr-only">{held}</span>
      </div>
    );
  }
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-2 px-1 py-1.5 text-xs hover:bg-muted/60",
        active && "bg-muted/60",
      )}
    >
      <Checkbox
        data-row={project.id}
        tabIndex={rovingTab}
        checked={checked}
        onCheckedChange={(v) => onToggle(v === true)}
        onFocus={onFocus}
      />
      <span className="min-w-0 flex-1 truncate" title={label}>
        {label}
      </span>
    </label>
  );
}

/** The one state no sibling picker has: a classic token without `project`, where
 *  the reads can't even be attempted. Offers the in-app reconnect, and the
 *  equivalent `gh` command for anyone who'd rather run it. */
function MissingScopeBlock({
  host,
  onReconnect,
}: {
  host: string;
  onReconnect: () => void;
}) {
  // A host outside the reconnect grammar never reaches a copyable command string
  // (shell-syntax injection via a crafted remote) — only the command block is
  // suppressed: the explanation and the button stay.
  const hostSafe = isReconnectHostSafe(host);
  const cmd = `gh auth refresh --hostname ${reconnectHostArg(host)} -s project`;
  return (
    <div className="px-1 py-1 text-xs">
      <p className="text-muted-foreground">
        Projects need the <span className="font-mono">project</span> scope,
        which your GitHub sign-in is missing.
      </p>
      <Button
        variant="outline"
        size="xs"
        className="mt-2"
        onClick={onReconnect}
      >
        Reconnect GitHub…
      </Button>
      {hostSafe && (
        <>
          <p className="mt-2 text-muted-foreground">
            Or run this, then reopen:
          </p>
          {/* Wraps rather than truncates: an Enterprise hostname outruns any popup
              width, and a half-shown command reads as the whole one. */}
          <div className="mt-1.5 flex items-start gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-muted px-1.5 py-1 font-mono text-[11px]">
              {cmd}
            </code>
            <button
              type="button"
              className="mt-1 shrink-0 cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
              title="Copy command"
              onClick={() => copyText(cmd, "Command copied")}
            >
              <CopyIcon className="size-3.5" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
