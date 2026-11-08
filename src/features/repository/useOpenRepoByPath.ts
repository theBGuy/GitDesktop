import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback } from "react";
import { toast } from "sonner";
import { usePlanStore } from "@/features/plan/store";
import { useResearchStore } from "@/features/research/store";
import { track } from "@/lib/analytics";
import { presentError } from "@/lib/error-summary";
import { validateRepo } from "@/lib/git/api";
import { normPath } from "@/lib/git/path";
import { userWorktreesOptions } from "@/lib/git/queries";
import {
  identityContradictsWithin,
  repoIdentityStrict,
  repoIdentityUnmemoized,
} from "@/lib/git/repo-identity";
import type { RepoInfo } from "@/lib/git/types";
import {
  findReopenRecord,
  type ReopenRecordView,
  resolveReopenTarget,
} from "@/lib/last-checkout/resolve";
import {
  getLastCheckoutSnapshot,
  lastCheckoutReady,
  refreshLastCheckout,
} from "@/lib/last-checkout/store";
import { queryClient as appQueryClient } from "@/lib/query-client";
import { migrateRepoData } from "@/lib/repo-data-migration";
import { scriptsKeys } from "@/lib/scripts/queries";
import { repoDisplayName } from "@/lib/settings/api";
import {
  useAddRecentRepo,
  useRelocateRecentRepo,
  useRemoveRecentRepo,
  useSettings,
} from "@/lib/settings/queries";
import { useConfirm } from "@/lib/stores/confirm";
import { repoNameFromPath } from "@/lib/stores/notifications";
import { registerRepoShellWarmup, useUiStore } from "@/lib/stores/ui";
import { isAppError } from "@/lib/tauri/invoke";
import { toastComposedError, toastError } from "@/lib/toast";
import { createOpenClaims } from "./open-claims";
import { settleWithin } from "./repo-shell-budget";
import { warmRepoShell } from "./repo-shell-prefetch";

/** How long a recents redirect waits for the record re-read, so a landing write
 *  queued behind a slow git read holds the click for no longer; the re-read
 *  itself still runs and lands late. The readiness wait before it is unbounded
 *  until a load lands. */
const RECORD_REFRESH_BOUND_MS = 1500;

/** Every open this module makes, recorded or worktree, and every held repo
 *  switch the store makes through the warm-up registered below, numbered against
 *  the store's `interactionEpoch` (its settle-late contract). The two direct
 *  `openRepo` sites retire pending opens through the epoch bump; both also claim
 *  through `claimWarmRepoShell`, which RepoDialogs' failure reopen honours and a
 *  worktree promote's landing ignores. */
const openClaims = createOpenClaims(
  () => useUiStore.getState().interactionEpoch,
);

/** Claims an open at its REQUEST; the check fails once a newer open or any
 *  navigation arrives. */
export const claimRepoOpen = openClaims.claim;

/** Notes the latest open without claiming one; the check fails once a newer
 *  open or any navigation arrives. */
export const repoOpenWatermark = openClaims.watermark;

// The store's cross-repo landings hold on this (src/lib can't import it). Below
// `openClaims`, which it closes over; the module-level client is the app's.
registerRepoShellWarmup((root) => {
  const stillCurrent = claimRepoOpen();
  return { settled: warmRepoShell(appQueryClient, root), stillCurrent };
});

/**
 * The shared tail for opening a repo the user picked, once its path has
 * validated: warm the repo's shell reads, record it in recents, wait out the
 * warm-up budget, then switch, unless a newer open or navigation arrived meanwhile
 * (silently: that newer action is what the user sees). The other repo switches
 * warm too: {@link useOpenWorktree} without recording, the store navigators'
 * cross-repo arms (notification and My work jumps) through the warm-up
 * registered above, and the failure reopen in RepoDialogs and a promote's
 * landing in worktree-removal by awaiting `claimWarmRepoShell` before `openRepo`.
 *
 * The recents write finishes BEFORE the switch, so the row exists when
 * RepositoryView mounts and its open-time visibility probe persists onto it; a
 * superseded open still records its repo. A recents redirect records the
 * clicked main row (`recordAs`) and opens a worktree, whose probe still
 * reaches that row: the probe writes match rows by repo identity.
 * The write is best-effort, since a settings-write failure must never block
 * opening. Resolves true once the switch was REQUESTED: a dirty Settings may
 * still hold it behind its Unsaved changes prompt, whose Keep editing cancels
 * it, and one with nothing unsaved but a save still writing holds it until the
 * save lands (a failed save, a later move or a newer open drops it).
 * Callers whose own awaits are part of the open request (drop, Recents, the
 * folder picker, a submodule opened as a repo) claim before those awaits and
 * pass `stillCurrent`, as {@link useOpenWorktree} claims before its own; a caller
 * whose pre-open await may end in something other than an open (BranchSwitcher's
 * worktree lookups) takes {@link repoOpenWatermark} and yields to a newer open
 * instead. Clone, create, and Explore's clone open their own result and take the
 * default, a claim at their completion.
 */
export function useOpenRecordedRepo() {
  const openRepo = useUiStore((s) => s.openRepo);
  const { mutateAsync: addRecent } = useAddRecentRepo();
  const queryClient = useQueryClient();
  return useCallback(
    async (
      info: RepoInfo,
      stillCurrent: () => boolean = claimRepoOpen(),
      // `onApplied` rides to `openRepo`, firing only when the switch lands.
      // `recordAs` is the row recents records when it isn't the one opened.
      {
        recordAs,
        ...opts
      }: { onApplied?: () => void; recordAs?: RepoInfo } = {},
    ): Promise<boolean> => {
      const warmed = warmRepoShell(queryClient, info.root);
      const recorded = recordAs ?? info;
      await addRecent({ path: recorded.root, name: recorded.name }).catch(
        () => undefined,
      );
      await warmed;
      if (!stillCurrent()) return false;
      openRepo(info, opts);
      return true;
    },
    [addRecent, openRepo, queryClient],
  );
}

/**
 * Opens a repository by path: validates it, records it in recents, and switches
 * the app to it. A `source: "recent"` path that's no longer a git repo offers a
 * toast to **Locate…** the folder's new home (moved on disk) or **Remove** the
 * stale row; a `source: "picker"` one is a folder the user just chose rather
 * than a recents row to repair, so it only reports that it isn't a repository.
 * Resolves whether the switch was requested: false on a failure (which toasts)
 * and when a newer open or navigation superseded this one (silent); a dirty
 * Settings may still hold the switch behind its Unsaved changes prompt, whose
 * Keep editing cancels it, and one with nothing unsaved but a save still
 * writing holds it until the save lands (a failed save, a later move or a newer
 * open drops it).
 * A `source: "recent"` click on a main row reopens the worktree its repo was
 * last left in, unless `opts.preferMain`, that repo is the open one, or the
 * worktree no longer checks out; every miss opens main silently. A recents
 * click retired by a newer open or a navigation before it starts opening
 * resolves false without recording its row, which would otherwise jump to the
 * top of recents after the user moved on; a superseded picker, submodule or
 * relocate open still records its repo.
 * Callers: the shared recents list, macOS File → Open Recent, the folder
 * picker in {@link usePickAndOpenRepo}, and a submodule opened as its own
 * repository from the Submodules dialog.
 */
export function useOpenRepoByPath() {
  const openRecorded = useOpenRecordedRepo();
  const removeRecent = useRemoveRecentRepo();
  const relocate = useRelocateRecentRepo();
  const settings = useSettings();
  const recentRepos = settings.data?.recentRepos;
  const queryClient = useQueryClient();

  // Counted when the switch lands, never at the request: a dirty Settings can
  // hold it, and Keep editing cancels it.
  const recordOpenAndTrack = useCallback(
    (
      info: RepoInfo,
      source: "recent" | "picker" | "relocate",
      stillCurrent: () => boolean,
      opts?: { recordAs?: RepoInfo },
    ) =>
      openRecorded(info, stillCurrent, {
        ...opts,
        onApplied: () => track({ name: "repo_opened", properties: { source } }),
      }),
    [openRecorded],
  );

  // A recents row whose folder moved: pick the new folder, validate it, repoint
  // the existing row in place (preserving alias + probed metadata), then open.
  const locateAndReopen = useCallback(
    async (oldPath: string) => {
      const picked = await openDialog({
        directory: true,
        title: "Locate repository",
      });
      if (typeof picked !== "string") return;
      try {
        const info = await validateRepo(picked);
        // Any git repo validates, but the OLD folder is gone so we can't verify
        // it's the SAME repo — picking a different one would irreversibly fold
        // this repo's app data into another's identity keys. Confirm first (the
        // house rule for destructive paths). The name comes from the recents row
        // (alias or name), else the moved folder's basename.
        const oldRow = recentRepos?.find((r) => r.path === oldPath);
        const oldName =
          (oldRow && repoDisplayName(oldRow)) || repoNameFromPath(oldPath);
        const confirmed = await useConfirm.getState().ask({
          title: `Relocate "${oldName}"?`,
          body: `GitDesktop will point this entry at ${info.root} — its alias, local PRs, issues, review history, and settings will follow the folder. If this is a different repository, that data is merged in and can't be undone.`,
          confirmLabel: "Relocate",
          scope: "app",
        });
        if (!confirmed) return;
        // Claimed past the prompt, which the user answers in place: the window
        // this guards is the relocate, re-home, and open that follow.
        const stillCurrent = claimRepoOpen();
        // Best-effort, like the addRecent write below — a settings failure must
        // never block opening. Repoint before addRecent so the follow-up write
        // finds the row at its new path and just refreshes name/order.
        await relocate
          .mutateAsync({ oldPath, newPath: info.root })
          .catch(() => undefined);
        // Re-home every per-repo app-data store (local PRs/issues, review history,
        // automations, Jira link, …) onto the new location's identity key. Purely
        // best-effort — a migration failure must never block opening the repo.
        await migrateRepoData(oldPath, info.root).catch(() => undefined);
        // The task config is cached under one global key, and a save made from a
        // pre-migration snapshot would persist the old scope keys back over the
        // re-home — in their identity form, which folding won't repair. Reset
        // rather than invalidate: observers drop to pending (a brief skeleton)
        // instead of serving stale tasks through the refetch. Not awaited, so it
        // can never hold up the open.
        void queryClient
          .resetQueries({ queryKey: scriptsKeys.config })
          .catch(() => undefined);
        // The plan/research stores hydrate once at startup, so their live runs
        // still carry the old path — repoint them, or the sidebar loses them and
        // their debounced autosave writes the pre-migration paths back to disk.
        usePlanStore.getState().relocateRepoPath(oldPath, info.root);
        useResearchStore.getState().relocateRepoPath(oldPath, info.root);
        await recordOpenAndTrack(info, "relocate", stillCurrent);
      } catch (e) {
        if (isAppError(e) && e.kind === "notARepo") {
          // The picked folder isn't a repo — no Locate/Remove actions here (no
          // recursion; the original row is still in the list to re-offer).
          toast.error(`${picked} is not a git repository.`);
        } else {
          toastError(e);
        }
      }
    },
    [relocate, recordOpenAndTrack, recentRepos, queryClient],
  );

  return useCallback(
    async (
      path: string,
      source: "recent" | "picker" = "recent",
      // Claimed before validating (a default evaluates at call entry), so the
      // latest intent wins: a newer open retires this one even when that newer
      // open then fails. A caller with awaits of its own ahead of this call
      // claims before them and passes the claim.
      stillCurrent: () => boolean = claimRepoOpen(),
      // true = the Shift escape / "Open in main workspace": never redirect.
      opts?: { preferMain?: boolean },
    ): Promise<boolean> => {
      // Pinned at the request: every later step compares against the repo that
      // was open when the user clicked, never wherever the app has moved since.
      const openPathPinned = useUiStore.getState().repoPath;
      try {
        const info = await validateRepo(path);
        // A retired recents click records nothing: its row would jump to the
        // top of recents after the user moved on (a newer open or navigation).
        if (source === "recent" && !stillCurrent()) return false;
        if (source === "recent" && !opts?.preferMain) {
          // Unbounded: a click over a cold, empty snapshot would open main,
          // whose landing then overwrites the remembered worktree.
          await lastCheckoutReady();
          if (!stillCurrent()) return false;
          // Re-read on the write chain so an earlier landing still queued, or
          // another instance's newer record, is seen. Past the bound the click
          // goes on, so a queued write slower than that can still read stale.
          await settleWithin([refreshLastCheckout()], RECORD_REFRESH_BOUND_MS);
          if (!stillCurrent()) return false;
          const record = findReopenRecord(
            getLastCheckoutSnapshot(),
            info.root,
            openPathPinned,
            Date.now(),
          );
          if (record) {
            const target = await resolveRedirectTarget(
              queryClient,
              record,
              info.root,
              openPathPinned,
              stillCurrent,
            );
            // Retired: record nothing, as above. A failed redirect opens the
            // clicked main row.
            if (!stillCurrent()) return false;
            if (target)
              return await recordOpenAndTrack(target, source, stillCurrent, {
                recordAs: info,
              });
          }
        }
        return await recordOpenAndTrack(info, source, stillCurrent);
      } catch (e) {
        if (isAppError(e) && e.kind === "notARepo") {
          if (source === "picker") {
            // The user is acting on a folder they just picked, not on a recents
            // row, so the row-repair actions (Locate/Remove) don't apply here.
            toast.error(`${path} is not a git repository.`);
          } else {
            toast.error(`${path} is no longer a git repository.`, {
              duration: 10_000,
              action: {
                label: "Locate…",
                onClick: () => void locateAndReopen(path),
              },
              cancel: {
                label: "Remove",
                onClick: () =>
                  void removeRecent.mutateAsync(path).catch(() => undefined),
              },
            });
          }
        } else {
          // A folder git can't read is still a repository: git's own message,
          // and no Locate/Remove offer to drop it from recents.
          const row = recentRepos?.find((r) => r.path === path);
          const name = (row && repoDisplayName(row)) || repoNameFromPath(path);
          toastComposedError({
            title: `Couldn't open ${name}`,
            errors: [e],
            description: presentError(e).summary,
          });
        }
        return false;
      }
    },
    [
      recordOpenAndTrack,
      locateAndReopen,
      removeRecent,
      recentRepos,
      queryClient,
    ],
  );
}

/**
 * The validated worktree a recents click on `clickedRoot`'s row reopens, or
 * null for main. Reads the open repo's identity beside a FRESH list (no
 * staleTime: a removed worktree must show), then requires the candidate to
 * validate as its own root under the record's identity, since another repo
 * may live at the remembered path now. That identity is asked of git past the
 * memo, and an in-window memo answer contradicting it (under either the
 * record's spelling or the validated root's) opens main instead. Null once
 * `stillCurrent` fails.
 */
async function resolveRedirectTarget(
  queryClient: QueryClient,
  record: ReopenRecordView,
  clickedRoot: string,
  openPathPinned: string | null,
  stillCurrent: () => boolean,
): Promise<RepoInfo | null> {
  const [openIdentity, worktrees] = await Promise.all([
    openPathPinned === null
      ? null
      : repoIdentityStrict(openPathPinned).catch(() => "unresolved" as const),
    queryClient
      .fetchQuery({ ...userWorktreesOptions(clickedRoot), retry: false })
      .catch(() => null),
  ]);
  if (!stillCurrent()) return null;
  const candidate = resolveReopenTarget({
    clickedRoot,
    record,
    preferMain: false,
    openIdentity,
    worktrees,
  });
  if (candidate === null) return null;
  const info = await validateRepo(candidate).catch(() => null);
  if (!stillCurrent() || info === null) return null;
  if (normPath(info.root) !== normPath(candidate)) return null;
  // Git is asked past the memo to catch a replaced folder, and the memo must
  // agree too: the landing's stores key on it, so a contradicted memo opens main.
  const landed = await repoIdentityUnmemoized(candidate).catch(() => null);
  if (!stillCurrent() || landed === null) return null;
  const want = normPath(record.identity);
  if (normPath(landed) !== want) return null;
  // The memo keys raw spellings and the landing opens `info.root`, so both are
  // checked. An in-window answer naming another repo (or the raw-path
  // no-identity fallback) vetoes, since the landing would key on it; one older
  // than the TTL re-resolves at landing whenever git answers, and can't
  // mis-key the landing.
  const contradicted = [candidate, info.root].some((key) =>
    identityContradictsWithin(key, record.identity),
  );
  return contradicted ? null : info;
}

/**
 * Switches the active repo to a linked worktree directory. A worktree's `.git`
 * is a pointer file, but `validateRepo` runs `rev-parse --show-toplevel`, which
 * resolves it to the worktree root — so opening it Just Works. Unlike
 * {@link useOpenRepoByPath} this does NOT record the path in recents: worktrees
 * are child checkouts of a repo already in the switcher, not first-class repos.
 *
 * Resolves true once the switch was REQUESTED — false when the open failed
 * (which toasts), when the user switched repos, navigated, or asked for another
 * open meanwhile, or when `stillWanted` retired it; all but the failure are
 * silent. A requested switch can still be held by a dirty Settings, whose Keep
 * editing cancels it, so a caller that reports the navigation to the user does
 * so from `opts.onApplied`, which runs only when the switch lands. The guard
 * reads the live repo when this is CALLED, so a caller that awaits something
 * else FIRST needs its own check before calling.
 *
 * @param stillWanted Re-checked after `validateRepo` and the shell warm-up, for
 * a caller that sequences several opens: a newer one can start while those run,
 * and the repo is unchanged in that case, so only the caller knows it is stale.
 * A standalone open passes nothing.
 */
export function useOpenWorktree() {
  const openRepo = useUiStore((s) => s.openRepo);
  const queryClient = useQueryClient();
  return useCallback(
    async (
      path: string,
      stillWanted?: () => boolean,
      opts?: { onApplied?: () => void },
    ) => {
      // `openRepo` writes GLOBAL navigation state, so it may only fire while the
      // app is still where this call started — the user can switch repositories,
      // open Settings, or start another open while the awaits below run, and an
      // unguarded write would yank them back into the previous repo's worktree.
      // The toast stays unconditional: the validation failed wherever they are now.
      //
      // `stillWanted` covers what those checks can't: a caller sequencing
      // several opens (the branch switcher) can have the user pick again while
      // THIS open is pending, and nothing global moves in that case. A caller
      // whose open stands alone passes nothing.
      const firedOn = useUiStore.getState().repoPath;
      const stillCurrent = claimRepoOpen();
      try {
        const info = await validateRepo(path);
        await warmRepoShell(queryClient, info.root);
        if (useUiStore.getState().repoPath !== firedOn) return false;
        if (!stillCurrent()) return false;
        if (stillWanted && !stillWanted()) return false;
        openRepo(info, opts);
        return true;
      } catch (e) {
        toastError(e);
        return false;
      }
    },
    [openRepo, queryClient],
  );
}

/**
 * Prompts for a local folder, then opens it as a repository (validate, record
 * in recents, switch to it). App is the sole caller — it registers this as the
 * `add-local-repository` action, and every surface offering "Open repository…"
 * dispatches that action rather than calling here.
 */
export function usePickAndOpenRepo() {
  const openByPath = useOpenRepoByPath();
  return useCallback(async () => {
    const path = await openDialog({
      directory: true,
      title: "Open repository",
    });
    if (typeof path === "string") await openByPath(path, "picker");
  }, [openByPath]);
}
