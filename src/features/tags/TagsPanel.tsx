import { CaretDownIcon, PlusIcon, TagIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ListRowSkeletons } from "@/components/list-row-skeleton";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import {
  forgeFeatureReady,
  useCreateTag,
  useForgeStatus,
  useHoverPrefetch,
  usePrefetchRelease,
  useReleaseList,
  useRepoStatus,
  useTagList,
} from "@/lib/git/queries";
import type { ReleaseInfo } from "@/lib/git/types";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { useUiStore } from "@/lib/stores/ui";
import { parseableDate } from "@/lib/time";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { CreateReleaseDialog } from "./CreateReleaseDialog";

/** Latest / Pre-release / Draft badges for a tag that backs a release. */
function ReleaseBadges({ release }: { release: ReleaseInfo }) {
  return (
    <>
      {release.isLatest && <Badge variant="default">Latest</Badge>}
      {release.isPrerelease && <Badge variant="secondary">Pre-release</Badge>}
      {release.isDraft && <Badge variant="secondary">Draft</Badge>}
    </>
  );
}

export function TagsPanel({ repoPath }: { repoPath: string }) {
  const gh = useForgeStatus(repoPath);
  // Release READS are provider-neutral (GitHub + GitLab); the badge/detail light up
  // for any provider with releases implemented. Publishing follows the per-action
  // create flag (GitHub + GitLab — the dialog hides the GitHub-only toggles there).
  const ghReady = forgeFeatureReady(gh.data, "releases");
  const canCreateRelease = forgeFeatureReady(gh.data, "releaseCreate");
  const tagList = useTagList(repoPath);
  const releaseList = useReleaseList(repoPath, ghReady);
  const status = useRepoStatus(repoPath);
  const createTag = useCreateTag(repoPath);
  const selectedTag = useUiStore((s) => s.selectedTag);
  const selectTag = useUiStore((s) => s.selectTag);
  const prefetchRelease = usePrefetchRelease(repoPath);
  const hoverPrefetch = useHoverPrefetch();

  const [filterText, setFilterText] = useState("");
  const [createReleaseOpen, setCreateReleaseOpen] = useState(false);
  const [newTagOpen, setNewTagOpen] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const pendingCreate = useUiStore((s) => s.pendingCreate);
  const clearPendingCreate = useUiStore((s) => s.clearPendingCreate);

  useHotkeyAction("focus-filter", () => filterRef.current?.focus());

  // Opened from the command palette / New menu via requestCreate (any tab).
  // Re-check the release gate here — the palette registration gates too, but a
  // pending request must not open the dialog on a repo that can't publish.
  useEffect(() => {
    if (pendingCreate === "release") {
      if (canCreateRelease) setCreateReleaseOpen(true);
      clearPendingCreate();
    } else if (pendingCreate === "tag") {
      setNewTagOpen(true);
      clearPendingCreate();
    }
  }, [pendingCreate, clearPendingCreate, canCreateRelease]);

  const tags = tagList.data ?? [];
  const releases = releaseList.data ?? [];
  const releaseByTag = new Map(releases.map((r) => [r.tagName, r]));
  const tagNames = new Set(tags.map((t) => t.name));
  // Draft releases may have no local tag ref yet — still surface them.
  const draftRows = releases
    .filter((r) => !tagNames.has(r.tagName))
    .map((r) => ({ name: r.tagName, date: r.publishedAt, release: r }));
  const rows = [
    ...tags.map((t) => ({
      name: t.name,
      date: t.date,
      release: releaseByTag.get(t.name),
    })),
    ...draftRows,
  ];

  const query = filterText.trim().toLowerCase();
  const visible = query
    ? rows.filter((r) => r.name.toLowerCase().includes(query))
    : rows;

  const headOid = status.data?.branch?.oid ?? null;

  const onListKeyDown = listKeyboardNav({
    items: visible.map((r) => ({ id: r.name })),
    activeIndex: visible.findIndex((r) => r.name === selectedTag?.tag),
    onActivate: (t) => selectTag({ tag: t.id }),
    rowKey: (t) => t.id,
  });

  // Awaited, not per-call callbacks: a panel hidden mid-create (repo-tab switch)
  // drops react-query's callbacks, and with them the selection onto the new tag.
  async function createNewTag() {
    const name = newTagName.trim();
    if (!name || !headOid) return;
    try {
      await createTag.mutateAsync({ name, hash: headOid });
    } catch (e) {
      toastError(e);
      return;
    }
    toast.success(`Created tag ${name}`);
    setNewTagOpen(false);
    setNewTagName("");
    // `selectTag` is global — a repo switch mid-create must not adopt this
    // tag into the other repo's selection.
    if (useUiStore.getState().repoPath === repoPath) selectTag({ tag: name });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b p-2">
        <h2 className="px-1 text-xs font-medium text-muted-foreground">Tags</h2>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="xs" className="ml-auto">
                <PlusIcon data-icon="inline-start" />
                New
                <CaretDownIcon data-icon="inline-end" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="min-w-52">
            <DropdownMenuItem
              disabled={!canCreateRelease}
              title={
                canCreateRelease
                  ? undefined
                  : gh.data?.provider === "gitlab"
                    ? "Sign in with the GitLab CLI (glab) to publish a release."
                    : "Connect this repository to GitHub or GitLab to publish a release."
              }
              onClick={() => setCreateReleaseOpen(true)}
            >
              New release…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!headOid}
              title={headOid ? undefined : "No commit to tag yet."}
              onClick={() => {
                setNewTagName("");
                setNewTagOpen(true);
              }}
            >
              New tag (on current commit)…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="border-b p-2">
        <Input
          ref={filterRef}
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          placeholder="Filter tags"
          className="h-7"
          autoComplete="off"
        />
      </div>
      {/* overflow-hidden contains the list's natural height (vendored Root is
          `relative`-only) so a long list can't leak a window scrollbar. */}
      <ScrollArea className="min-h-0 flex-1 overflow-hidden">
        {tagList.isPending ? (
          <ListRowSkeletons rows={2} lines={2} name="tags" />
        ) : visible.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">
            {rows.length > 0
              ? "No tags match the filter."
              : "No tags yet. The New menu above creates a tag on the current commit or publishes a release."}
          </p>
        ) : (
          <div onKeyDown={onListKeyDown}>
            {visible.map((row) => {
              const active = selectedTag?.tag === row.name;
              return (
                <button
                  type="button"
                  key={row.name}
                  data-row={row.name}
                  className={cn(
                    "block w-full border-b px-3 py-2 text-left",
                    active
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-muted/60",
                  )}
                  onClick={() => selectTag({ tag: row.name })}
                  onMouseEnter={() =>
                    row.release &&
                    hoverPrefetch(() => prefetchRelease(row.name))
                  }
                >
                  <p className="flex items-center gap-1.5 text-xs font-medium">
                    <TagIcon className="size-3 shrink-0 text-muted-foreground" />
                    <span className="truncate" title={row.name}>
                      {row.name}
                    </span>
                    {row.release && <ReleaseBadges release={row.release} />}
                  </p>
                  <p className="mt-0.5 truncate pl-4 text-[11px] text-muted-foreground">
                    {row.release ? "release · " : "tag · "}
                    {parseableDate(row.date) ? (
                      <RelativeTime date={row.date} />
                    ) : (
                      "—"
                    )}
                  </p>
                </button>
              );
            })}
          </div>
        )}
      </ScrollArea>

      <CreateReleaseDialog
        repoPath={repoPath}
        open={createReleaseOpen}
        onOpenChange={setCreateReleaseOpen}
      />

      <Dialog open={newTagOpen} onOpenChange={setNewTagOpen}>
        <DialogContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void createNewTag();
            }}
          >
            <DialogHeader>
              <DialogTitle>New tag</DialogTitle>
              <DialogDescription>
                Creates a lightweight tag on the current commit (
                <span className="font-mono">{headOid?.slice(0, 7)}</span>). Push
                it or create a release from its detail view.
              </DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              placeholder="v1.2.0"
              autoComplete="off"
              className="font-mono"
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setNewTagOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!newTagName.trim() || createTag.isPending}
              >
                {createTag.isPending && <Spinner data-icon="inline-start" />}
                Create tag
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
