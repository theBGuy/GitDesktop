import { Popover } from "@base-ui/react/popover";
import { CopyIcon, KanbanIcon } from "@phosphor-icons/react";
import { type ReactNode, useState } from "react";
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
import type {
  ProjectItemRemove,
  ProjectV2Ref,
  RemoteLens,
} from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { useUiStore } from "@/lib/stores/ui";
import { cn } from "@/lib/utils";

const NO_ACCESS_REASON = "You don't have write access to this project";
const READ_ONLY_SCOPE_REASON =
  "Your GitHub sign-in can read projects but not change them (needs the project scope)";
const UNSETTLED_REASON =
  "Can't load this item's projects yet — use Retry above";

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
  // The memberships AS SEEN at open. The close diffs draft-vs-SEEDED — what the
  // user actually looked at and toggled — never draft-vs-live: this is the one
  // picker seeded from an async query (the siblings seed from synchronous props,
  // per RemotePrView's "commits against LIVE props"), so a membership that lands
  // mid-open is in neither set and is left alone rather than read as an unchecked
  // row and unlinked. Live items serve only as the item-id lookup for removes.
  const [seeded, setSeeded] = useState<Set<string>>(new Set());
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
      // address. The mutation's `onSettled` returns its invalidate promise, so
      // this hold spans the settle REFETCH too — the placeholders are always
      // gone by the time it frees.
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
  // a natively-disabled checkbox can't take focus. An unsettled memberships read
  // outranks the scope: the catalog and the memberships are separate gh calls, so
  // rows can render live while the close has no trustworthy set to diff against.
  const rowLockedReason = (() => {
    switch (true) {
      case !memberships.isSuccess:
        return UNSETTLED_REASON;
      case readOnlyScope:
        return READ_ONLY_SCOPE_REASON;
      default:
        return undefined;
    }
  })();
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
  // The apply promise is only true while the rows can actually be toggled: a
  // locked list discards everything on close, and both lock states already say
  // why — and how to recover — above the rows. Truncation is a fact about the
  // catalog, so it stands either way.
  const showApplyNote = rows.length > 0 && rowLockedReason === undefined;
  const showTruncated = available.data?.truncated === true;
  // Both scope gaps ask for the same scope, so both remedy blocks fire the same
  // reconnect.
  const reconnectForProjectScope = () =>
    openReconnect({
      provider: "github",
      host,
      mode: "refresh",
      scopes: ["project"],
    });

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
      const applied = new Set(items.map((item) => item.project.id));
      setSeeded(applied);
      setDraft(new Set(applied));
      setOpen(true);
      return;
    }
    setOpen(false);
    // An unsettled read is not an empty membership set, and an untrusted set must
    // never mint removes.
    if (!memberships.isSuccess) return;
    const adds = [...draft]
      .filter((id) => !seeded.has(id))
      .map((id) => byId.get(id))
      .filter((project): project is ProjectV2Ref => !!project);
    const itemIdByProject = new Map(
      items.map((item) => [item.project.id, item.itemId]),
    );
    const removes: ProjectItemRemove[] = [];
    for (const id of seeded) {
      if (draft.has(id)) continue;
      const itemId = itemIdByProject.get(id);
      // Absent = unlinked elsewhere since this opened; `pending:` = an add whose
      // real item id doesn't exist yet, so the unlink the user drafted would be
      // dropped right here without a word. The trigger's in-flight hold now spans
      // the settle refetch, which puts a `pending:` id out of reach in practice.
      if (itemId === undefined || itemId.startsWith("pending:")) continue;
      removes.push({ projectId: id, itemId });
    }
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
                <ScopeGapBlock
                  host={host}
                  onReconnect={reconnectForProjectScope}
                >
                  Projects need the <span className="font-mono">project</span>{" "}
                  scope, which your GitHub sign-in is missing.
                </ScopeGapBlock>
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
                  {readOnlyScope && (
                    <div className="mb-1 border-b pb-1">
                      <ScopeGapBlock
                        host={host}
                        onReconnect={reconnectForProjectScope}
                      >
                        Changing projects needs the{" "}
                        <span className="font-mono">project</span> scope, which
                        your GitHub sign-in is missing.
                      </ScopeGapBlock>
                    </div>
                  )}
                  {/* Not gated on an empty list: membership rows render from
                      their own query, so the catalog can still be in flight
                      under a list that already looks complete. `canRead` keeps a
                      DISABLED query — permanently "pending" — from reading as one. */}
                  {canRead && available.isPending && (
                    <p className="px-1 py-1 text-xs text-muted-foreground">
                      Loading projects…
                    </p>
                  )}
                  {rows.length === 0 &&
                    readError === null &&
                    !(canRead && available.isPending) && (
                      <p className="px-1 py-1 text-xs text-muted-foreground">
                        No open projects in this repository or its owner.
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
                  {(showApplyNote || showTruncated) && (
                    <div className="mt-1 border-t px-1 pt-1.5 text-[11px] text-muted-foreground">
                      {showApplyNote && <p>Changes apply when this closes.</p>}
                      {showTruncated && <p>Some projects aren't shown.</p>}
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
 *  row — an unsettled memberships read, or a read-only token — and outranks the
 *  per-board `viewerCanUpdate` one. */
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
  const held = (() => {
    switch (true) {
      case lockedReason !== undefined:
        return lockedReason;
      case !project.viewerCanUpdate:
        return NO_ACCESS_REASON;
      default:
        return undefined;
    }
  })();
  if (held !== undefined) {
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

/** A scope gap this picker can't work around, plus its remedy — the in-app
 *  reconnect and the equivalent `gh` command for anyone who'd rather run it.
 *  Two arms share it: a classic token with NEITHER project scope (the reads can't
 *  be attempted at all) and one with only `read:project` (reads work, writes 403).
 *  Both need the same `project` scope, so both get the same remedy; `children` is
 *  the one sentence that differs. */
function ScopeGapBlock({
  host,
  onReconnect,
  children,
}: {
  host: string;
  onReconnect: () => void;
  children: ReactNode;
}) {
  // A host outside the reconnect grammar never reaches a copyable command string
  // (shell-syntax injection via a crafted remote) — only the command block is
  // suppressed: the explanation and the button stay.
  const hostSafe = isReconnectHostSafe(host);
  const cmd = `gh auth refresh --hostname ${reconnectHostArg(host)} -s project`;
  return (
    <div className="px-1 py-1 text-xs">
      <p className="text-muted-foreground">{children}</p>
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
