import { Popover } from "@base-ui/react/popover";
import { UserCheckIcon } from "@phosphor-icons/react";
import { Children, type ReactNode, useState } from "react";
import { ForgeUserAvatar } from "@/components/forge-user-avatar";
import { MetaValueCell, UserChip } from "@/components/meta-field-cells";
import { usePanelPortalContainer } from "@/components/panel-portal";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useForgeGhHost } from "@/lib/git/host";
import { useReviewerCandidates } from "@/lib/git/queries";
import type { ForgeUserRef, RemoteLens } from "@/lib/git/types";

/**
 * A short, stable disambiguator for a reviewer whose label collides with a
 * DIFFERENT account's label — real workspaces can hold two accounts with an
 * identical display_name AND nickname (only the uuid is guaranteed distinct).
 * Returns null unless some OTHER ref in `all` (different id) shares this label;
 * when colliding, returns the uuid's first hyphen-segment with braces stripped
 * (e.g. "{0d55e607-aeb2-…}" → "0d55e607") so the two entries read apart.
 */
export function userRefHint(
  ref: ForgeUserRef,
  all: ForgeUserRef[],
): string | null {
  const collides = all.some((o) => o.id !== ref.id && o.label === ref.label);
  if (!collides) return null;
  return ref.id.replace(/[{}]/g, "").split("-")[0] || null;
}

/**
 * Reviewer multi-select for the PR view — a shared control on all three
 * providers (`implemented.mrReviewers`). Mirrors `AssigneesPopover`, with one
 * structural difference: entries are `{id, label}` pairs, not bare login strings
 * — Bitbucket identity must travel as the account uuid (nicknames aren't unique
 * and participant objects never carry `username`), while the label stays human.
 * The caller passes only the human reviewers as `value`; bot requests (e.g.
 * GitHub Copilot) are display-only and never enter this managed set.
 *
 * Edits batch into one `onChange` when the popover closes (each change is a
 * network PUT, like the assignees picker in the view). Candidates load only while
 * the popover is enabled; the PR author is already filtered out server-side (the
 * backend excludes them — providers reject an author-reviewer).
 */
export function ReviewersPopover({
  repoPath,
  number,
  enabled,
  value,
  onChange,
  lens,
  disabledReason,
  cells = false,
  children,
}: {
  repoPath: string;
  number: number | null;
  enabled: boolean;
  value: ForgeUserRef[];
  onChange: (next: ForgeUserRef[]) => void;
  /** The origin|upstream lens the parent surface resolved (create dialog: "origin"). */
  lens: RemoteLens;
  /** Set when this picker can't be edited right now — the viewer lacks the access
   *  its action needs, or the surface is still loading the entity. The trigger
   *  stays visible but disabled and this text explains why. Absent = editable. */
  disabledReason?: string;
} & (
  | {
      /** Emit the trigger and the chips as two SIBLING elements rather than one
       *  inline row, so a caller's label/value grid can place each in its own
       *  column. */
      cells: true;
      /** Display-only reviewer chips the caller owns (bot requests, completed
       *  reviews), rendered after this picker's own chips so the whole field
       *  reads as one value. Pass them as bare children, never wrapped in a
       *  Fragment: the empty-cell test drops null/undefined/booleans but counts
       *  a Fragment as content whatever is inside it. */
      children?: ReactNode;
    }
  // Children have nowhere to render outside `cells`, so the type refuses them
  // rather than dropping them silently.
  | { cells?: false; children?: never }
)) {
  const candidates = useReviewerCandidates(repoPath, number, enabled, lens);
  // GitHub reviewer ids are logins (avatars served at `<host>/<login>.png`), so the
  // avatar is login-derived there; off GitHub it's the initial fallback unless the
  // ref carries a real avatarUrl (GitLab/Bitbucket do).
  const ghHost = useForgeGhHost(repoPath);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Map<string, ForgeUserRef>>(new Map());
  const portalContainer = usePanelPortalContainer();

  // Collision universe for the candidate rows: candidates ∪ current value, so a
  // selected colliding reviewer still gets a hint. For the chips: value ∪
  // candidates when loaded, else just value (candidates aren't fetched until the
  // popover opens, so a fresh render of the chips must stand on `value` alone).
  const loaded = candidates.data ?? [];
  const rowUniverse = [...loaded, ...value];
  const chipUniverse = loaded.length > 0 ? [...value, ...loaded] : value;

  function toggle(user: ForgeUserRef, on: boolean) {
    setDraft((prev) => {
      const next = new Map(prev);
      if (on) next.set(user.id, user);
      else next.delete(user.id);
      return next;
    });
  }

  function handleOpenChange(o: boolean) {
    if (o) {
      setDraft(new Map(value.map((r) => [r.id, r])));
      setOpen(true);
      return;
    }
    setOpen(false);
    // Only commit when the draft actually differs from `value` — otherwise
    // merely opening and closing the popover would fire a redundant reviewer
    // PUT (onChange → setReviewers.mutate). Compare id sets.
    const valueIds = new Set(value.map((r) => r.id));
    const changed =
      draft.size !== valueIds.size ||
      value.some((r) => !draft.has(r.id)) ||
      [...draft.keys()].some((id) => !valueIds.has(id));
    if (changed) onChange([...draft.values()]);
  }

  const trigger = (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      {/* A natively disabled button swallows `title`, so the reason rides a
          wrapping span. */}
      <span
        title={disabledReason}
        className={
          disabledReason ? "inline-flex cursor-not-allowed" : "inline-flex"
        }
      >
        <Popover.Trigger
          disabled={!!disabledReason}
          render={
            <Button variant="ghost" size="xs" aria-label="Edit reviewers" />
          }
        >
          <UserCheckIcon data-icon="inline-start" />
          Reviewers
        </Popover.Trigger>
      </span>
      <Popover.Portal container={portalContainer}>
        <Popover.Positioner
          align="start"
          sideOffset={4}
          className="isolate z-50"
        >
          <Popover.Popup className="w-60 rounded-none bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10">
            <p className="px-1 pb-1.5 text-xs font-medium">Reviewers</p>
            {(candidates.data ?? []).length === 0 && (
              <p className="px-1 py-1 text-xs text-muted-foreground">
                {candidates.isPending
                  ? "Loading…"
                  : candidates.isError
                    ? "Couldn't load workspace members."
                    : "No eligible reviewers — the workspace has no other members."}
              </p>
            )}
            {loaded.map((user) => {
              const hint = userRefHint(user, rowUniverse);
              return (
                <label
                  key={user.id}
                  title={hint ? `${user.label} (${hint})` : undefined}
                  className="flex cursor-pointer items-center gap-2 px-1 py-1.5 text-xs hover:bg-muted/60"
                >
                  <Checkbox
                    checked={draft.has(user.id)}
                    onCheckedChange={(v) => toggle(user, v === true)}
                  />
                  <ForgeUserAvatar user={user} ghHost={ghHost} />
                  <span
                    className="flex-1 truncate"
                    title={hint ? `${user.label} (${hint})` : user.label}
                  >
                    {user.label}
                    {hint && (
                      <span className="text-muted-foreground"> · {hint}</span>
                    )}
                  </span>
                </label>
              );
            })}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
  const chips = value.map((user) => {
    const hint = userRefHint(user, chipUniverse);
    return (
      <UserChip
        key={user.id}
        user={user}
        ghHost={ghHost}
        hint={hint}
        title={hint ? `${user.label} (${hint})` : undefined}
      />
    );
  });

  if (cells) {
    // Caller-owned chips count toward the cell being populated, so a PR whose
    // only reviewers are bots or finished reviews shows them, not the dash.
    // `toArray` over `count`: it drops null/undefined/booleans, so a caller's
    // `{cond && chips}` can't report content while rendering none.
    const empty = value.length === 0 && Children.toArray(children).length === 0;
    return (
      <>
        {trigger}
        <MetaValueCell label="Reviewers" empty={empty}>
          {chips}
          {children}
        </MetaValueCell>
      </>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {trigger}
      {chips}
    </div>
  );
}
