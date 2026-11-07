import { Popover } from "@base-ui/react/popover";
import {
  CaretDownIcon,
  CheckCircleIcon,
  FolderOpenIcon,
  TreeStructureIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { MENU_HELD_ROW_CLASS } from "@/components/menu-held-row";
import { usePanelPortalContainer } from "@/components/panel-portal";
import { PathText } from "@/components/path-text";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { PROMOTION_BLOCKS_CHECKOUT } from "@/features/repository/checkout-copy";
import { useCloseSettled } from "@/features/repository/publish-confirm";
import { useOpenWorktree } from "@/features/repository/useOpenRepoByPath";
import { refuseWhileLeaving } from "@/features/repository/WorktreesDialog";
import {
  composePickedPath,
  deriveSiblingPath,
  isAbsolutePath,
  splitPath,
  underPickedParent,
} from "@/features/repository/worktree-paths";
import { isWorktreeDiverged, type WorktreeDiverged } from "@/lib/git/api";
import { normPath } from "@/lib/git/path";
import {
  type PendingPrWrite,
  PR_WRITES_KEY,
  pendingMutationEntries,
  pendingWriteOfKind,
  pendingWritesFor,
  readPendingPrWrite,
  useCheckoutPrWorktree,
  useGhAccounts,
  useUserWorktrees,
} from "@/lib/git/queries";
import type { RemoteLens } from "@/lib/git/types";
import { listUserWorktrees, type UserWorktree } from "@/lib/git/worktree";
import { refuseWhileOffline, useOfflineHold } from "@/lib/offline-writes";
import { useConfirm } from "@/lib/stores/confirm";
import { landedIn } from "@/lib/stores/notifications";
import { useUiStore } from "@/lib/stores/ui";
import {
  promotionBlocksCheckout,
  useIsRemovingWorktree,
  useWorktreeRemovalStore,
} from "@/lib/stores/worktree-removal";
import { toastError } from "@/lib/toast";
import { useLatestRef } from "@/lib/use-latest-ref";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";

/** The plain checkout half and its caret, joined into one split control. */
export const CHECKOUT_SPLIT_CLASS = "inline-flex shrink-0 items-stretch";

/** The caret's accessible name: it is its own tab stop beside the plain half. */
export const checkoutOptionsLabel = (n: number) => `Checkout options for #${n}`;

/** The caret where the loaded header's will stand, held for `reason`: the loading
 *  frame mirrors the live split control. */
export function HeldCheckoutCaret({
  number,
  reason,
}: {
  number: number;
  reason: string;
}) {
  return (
    <DisabledReasonButton
      variant="outline"
      size="icon-xs"
      disabled
      reason={reason}
      aria-label={checkoutOptionsLabel(number)}
      wrapperClassName="-ml-px"
    >
      <CaretDownIcon />
    </DisabledReasonButton>
  );
}

/** The reason every checkout control holds while any checkout runs: both flavors
 *  write this repository's refs, so one in flight refuses the other. */
export function checkoutRunningReason(
  running: PendingPrWrite | undefined,
  ownPr: boolean,
): string | undefined {
  if (running === undefined) return undefined;
  return ownPr || running.target == null
    ? "Checking out…"
    : `Checking out #${running.target}…`;
}

/** gh grew `pr checkout --worktree` in 2.98.0. Missing parts read as 0, so "2.98"
 *  passes; anything unparseable is unknown and passes too, since the backend
 *  refuses a too-old gh on its own. */
export function supportsWorktreeCheckout(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  if (![major, minor, patch].every(Number.isFinite)) return true;
  if (major !== 2) return major > 2;
  if (minor !== 98) return minor > 98;
  // 2.98.x: the floor is 2.98.0, so every patch passes.
  return true;
}

/** Why the worktree flavor is held by the installed gh, or undefined while the
 *  version is unknown (unread, or "" when gh isn't found): fail open. */
function versionReason(version: string | undefined): string | undefined {
  if (!version || supportsWorktreeCheckout(version)) return undefined;
  return `Needs GitHub CLI 2.98 or newer (you have ${version})`;
}

/** Reads gh's version only while mounted, so the PR view itself spawns nothing:
 *  the menu content and the popover body mount only while open. */
function GhVersionGate({
  children,
}: {
  children: (reason: string | undefined) => ReactNode;
}) {
  const gh = useGhAccounts();
  return children(versionReason(gh.data?.version));
}

/** Base UI activates on keydown without a repeat check, so a key still held from
 *  the previous step would act again. */
function ignoreHeldActivation(
  e: KeyboardEvent & { preventBaseUIHandler?(): void },
) {
  if (e.repeat && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    e.preventBaseUIHandler?.();
  }
}

/** A folder's comparison key: separator-, case- and trailing-separator-blind,
 *  since a typed path may differ from git's spelling. */
function folderKey(p: string): string {
  return normPath(p).replace(/\/+$/, "");
}

/** Point-in-time twin of `useIsRemovingWorktree`, across every repo bucket (a
 *  removal started from another checkout keys under that one). A relative
 *  typed path is out of reach: it is never resolved lexically, so it matches no
 *  removal. */
function removingNow(path: string): boolean {
  const want = folderKey(path);
  return Object.values(useWorktreeRemovalStore.getState().byRepo).some(
    (entries) => Object.keys(entries).some((k) => folderKey(k) === want),
  );
}

/** The PR branch's own worktree. The repository's own checkout is never it:
 *  opening that is a no-op, and gh refuses to update it as a worktree.
 *  Accepted miss: a cross-repository PR checks out as `<owner>/<head>`, and the
 *  PR details carry no head owner, so only its bare head name is matched. */
function branchRow(
  rows: UserWorktree[] | undefined,
  branch: string,
  repoPath: string,
): UserWorktree | undefined {
  return rows?.find(
    (w) =>
      !w.isMain &&
      w.branch === branch &&
      normPath(w.path) !== normPath(repoPath),
  );
}

function pathRow(
  rows: UserWorktree[] | undefined,
  path: string,
): UserWorktree | undefined {
  const want = folderKey(path);
  return rows?.find((w) => folderKey(w.path) === want);
}

/** The worktree a run wrote. gh resolves a relative folder against the
 *  repository while opening one resolves against the process, so when the
 *  typed path matches no row the branch's row (git's absolute path) answers. */
function writtenRow(
  rows: UserWorktree[] | undefined,
  p: Pin,
  target: string,
): UserWorktree | undefined {
  return pathRow(rows, target) ?? branchRow(rows, p.headRefName, p.repoPath);
}

/** The folder a success toast may open: the row the run wrote, else the typed
 *  path only when it is absolute. A relative one would open against the
 *  process's directory, so the toast then offers nothing. */
function openablePath(
  written: UserWorktree | undefined,
  target: string,
): string | undefined {
  if (written) return written.path;
  return isAbsolutePath(target) ? target : undefined;
}

type SuccessKind = "create" | "update" | "current" | "reset";

const SUCCESS_COPY: Record<SuccessKind, (n: number) => string> = {
  create: (n) => `Checked out #${n} in a worktree`,
  update: () => "Worktree updated to the PR",
  current: () => "Worktree already up to date.",
  reset: () => "Worktree reset to the PR",
};

const DISCARD_LABEL: Record<"listed" | "more", (n: number) => string> = {
  listed: (n) => `Discard ${n} commit${n === 1 ? "" : "s"} and reset`,
  more: () => "Discard more than 20 commits and reset",
};

/** The PR and repository a popover was opened on: every continuation re-checks
 *  them before it closes, asks or retries, since the user can move on mid-run. */
interface Pin {
  repoPath: string;
  number: number;
  lens: RemoteLens;
  headRefName: string;
}

export interface PrWorktreeCheckoutHandle {
  /** The palette route: opens the popover directly, skipping the menu. */
  openFromPalette: () => void;
}

/**
 * The remote PR header's split Checkout: `children` is the plain half (or the
 * "Checked out" chip), and the caret beside it opens "Check out in a worktree…",
 * whose popover names a sibling folder by PR number and runs
 * `gh pr checkout --worktree`. When the PR's head branch already has a worktree
 * the same popover offers Open and Update instead (fork PRs: see `branchRow`;
 * the create path then surfaces the backend's own refusal). Busy state comes from the view's
 * pending-write cache reads (`runningReason`, `pending`), never this component's
 * own mutation observer: the view is reused across PRs.
 */
export function PrWorktreeCheckout({
  ref,
  repoPath,
  number,
  lens,
  prNumber,
  headRefName,
  staleReason,
  runningReason,
  pending,
  detailsStale,
  children,
}: {
  ref?: Ref<PrWorktreeCheckoutHandle>;
  repoPath: string;
  /** The selected PR, which writes address. */
  number: number;
  lens: RemoteLens;
  /** The rendered PR, which copy names; it lags `number` through a switch. */
  prNumber: number;
  headRefName: string;
  /** Set while the rendered details are another PR's placeholder. */
  staleReason: string | undefined;
  /** {@link checkoutRunningReason}: set while any checkout runs. */
  runningReason: string | undefined;
  /** This PR's own checkout is the one running. */
  pending: boolean;
  /** A placeholder or a hold: handlers refuse, as the plain half's does. */
  detailsStale: boolean;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  // A menu-route close lands on the caret; a palette-route close keeps Base UI's
  // rule (back to whatever was focused before it opened).
  const [route, setRoute] = useState<"menu" | "palette">("menu");
  const menuClose = useCloseSettled(menuOpen);
  const popoverClose = useCloseSettled(popoverOpen);
  const caretRef = useRef<HTMLButtonElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pinRef = useRef<Pin | null>(null);
  // Compare-and-clear token: holds from the click, before the pending-write cache
  // read re-renders the controls held.
  const flight = useRef<object | null>(null);
  const live = useLatestRef({ repoPath, number, lens, popoverOpen });
  // `live` freezes once the host unmounts (the PR merged, the selection cleared),
  // so a continuation outliving it must read that as the user having left.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const offlineHold = useOfflineHold();
  const portalContainer = usePanelPortalContainer();
  const inputId = useId();

  // Both popups close in the render that moves the PR, its lens or the
  // repository: the view is reused, and a portaled popup stays live outside a
  // hold's `inert`. One number names a different PR in each lens.
  const identity = `${repoPath}\n${lens}\n${number}\n${prNumber}`;
  const [openedFor, setOpenedFor] = useState(identity);
  if (openedFor !== identity) {
    setOpenedFor(identity);
    setMenuOpen(false);
    setPopoverOpen(false);
  }

  const [path, setPath] = useState("");
  const [pathEdited, setPathEdited] = useState(false);
  const [pickedParent, setPickedParent] = useState<string | null>(null);
  useSeedOnOpen(popoverOpen, () => {
    setPath("");
    setPathEdited(false);
    setPickedParent(null);
  });

  // `data` only: a pending or failed read shows the create form, never a claim.
  const rows = useUserWorktrees(repoPath, menuOpen || popoverOpen).data;
  const mainPath = rows?.find((w) => w.isMain)?.path ?? repoPath;
  const derivedPath = deriveSiblingPath(mainPath, `pr-${number}`);
  const followingPath =
    pickedParent === null
      ? derivedPath
      : underPickedParent(pickedParent, splitPath(derivedPath).name);
  const effectivePath = pathEdited ? path : followingPath;
  // Latched when the popover opens, so a list landing while it is open never
  // swaps the body under the focused control; the next open reads afresh.
  const [existing, setExisting] = useState<UserWorktree | undefined>();
  // Display only: the handlers re-read every repo's removals at fire time.
  const removing = useIsRemovingWorktree(repoPath, existing?.path);

  const checkout = useCheckoutPrWorktree(repoPath);
  const queryClient = useQueryClient();
  const openWorktree = useOpenWorktree();

  /** The selection is read from the store: the view's own `number` lags a
   *  switch through its deferred render, so it can still name the PR the user
   *  already left. */
  function stillOn(p: Omit<Pin, "headRefName">): boolean {
    const now = live.current;
    const selected = useUiStore.getState().selectedPr;
    return (
      mounted.current &&
      landedIn(p.repoPath).live &&
      selected?.kind === "remote" &&
      selected.id === String(p.number) &&
      normPath(now.repoPath) === normPath(p.repoPath) &&
      now.number === p.number &&
      now.lens === p.lens
    );
  }

  /** The popover is still the one `p` opened: each opening mints its own pin,
   *  so a run from an earlier one never closes or asks over a newer draft. */
  function ownsPopover(p: Pin): boolean {
    return pinRef.current === p && stillOn(p);
  }

  function leftBeforeReset(p: Pin): false {
    toast.info(
      `You left #${p.number} before its worktree could be reset, so nothing was discarded.`,
    );
    return false;
  }

  function openPopover(from: "menu" | "palette") {
    if (detailsStale) return;
    pinRef.current = { repoPath, number, lens, headRefName };
    // `data` only: a pending or failed read opens the create form, never a
    // claim.
    setExisting(branchRow(rows, headRefName, repoPath));
    setRoute(from);
    setPopoverOpen(true);
  }

  useImperativeHandle(ref, () => ({
    openFromPalette: () => openPopover("palette"),
  }));

  async function openFromMenu() {
    const at = { repoPath, number, lens };
    setMenuOpen(false);
    // The popover opens only once the menu's focus return has landed, or that
    // return would steal the folder field's initial focus.
    await menuClose.waitClosed();
    if (!stillOn(at)) return;
    openPopover("menu");
  }

  async function browse() {
    const p = pinRef.current;
    let picked: string | null;
    try {
      picked = await openDialog({
        directory: true,
        title: "Folder to create the worktree in",
      });
    } catch (e) {
      toastError(e);
      return;
    }
    if (typeof picked !== "string" || !picked) return;
    // A pick answering an earlier opening (closed, reopened, or another PR's)
    // would land in a field the user never browsed from.
    if (!p || !live.current.popoverOpen || !ownsPopover(p)) return;
    if (pathEdited) setPath(composePickedPath(picked, path, derivedPath));
    else setPickedParent(picked);
  }

  /** Mirrors the plain half's fire-time refusals. */
  function refusedAtFire(): boolean {
    if (detailsStale || runningReason !== undefined || flight.current)
      return true;
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return true;
    }
    return false;
  }

  async function askReset(p: Pin, d: WorktreeDiverged): Promise<boolean> {
    if (!ownsPopover(p)) return leftBeforeReset(p);
    // The popover closes first: a dialog opened over its close would lose its
    // initial focus to the popover's focus return.
    setPopoverOpen(false);
    await popoverClose.waitClosed();
    if (!ownsPopover(p)) return leftBeforeReset(p);
    const ok = await useConfirm.getState().ask({
      title: "Reset this worktree to the PR?",
      body: <ResetBody diverged={d} />,
      confirmLabel: DISCARD_LABEL[d.more ? "more" : "listed"](d.commits.length),
      confirmVariant: "destructive",
    });
    if (!ok) return false;
    if (!ownsPopover(p)) return leftBeforeReset(p);
    if (promotionBlocksCheckout(p.repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return false;
    }
    return true;
  }

  async function run(typed: string, kind: "create" | "update") {
    // The backend trims the folder it writes, so the holds, reads and toast pin
    // below must all see that same spelling.
    const target = typed.trim();
    const p = pinRef.current;
    if (!p || !target || refusedAtFire()) return;
    const token = {};
    flight.current = token;
    let force = false;
    let expectedHead: string | undefined;
    try {
      // Read fresh, never the row the popover latched: that one came from the
      // cache before the open's own refetch, so it can predate local commits.
      const headBefore =
        kind === "update"
          ? pathRow(await readRows(p), target)?.head
          : undefined;
      if (!stillOn(p)) return;
      // A forced retry that meets a FRESH divergence asks again over the fresh
      // payload; nothing ever retries without an answer.
      for (;;) {
        // gh fetches, so a write pressed offline would park and fire whenever
        // the connection returns; checked after every await, the confirm's too.
        if (refuseWhileOffline()) return;
        // The fire-time holds predate the reads and the confirm above: a
        // removal or promotion claimed meanwhile refuses here.
        if (promotionBlocksCheckout(p.repoPath)) {
          toast.info(PROMOTION_BLOCKS_CHECKOUT);
          return;
        }
        if (refuseWhileLeaving(folderKey(target), removingNow(target))) return;
        // Silent, as the plain half's own refusal is: its reason is on screen.
        if (checkoutRunsNow(p.repoPath)) return;
        try {
          await checkout.mutateAsync({
            number: p.number,
            lens: p.lens,
            path: target,
            force,
            expectedHead,
          });
          const written = writtenRow(await readRows(p), p, target);
          let outcome: SuccessKind = force ? "reset" : kind;
          // gh exits 0 on a fast-forward and on a no-op alike; a failed read
          // on either side keeps "updated", a fair claim.
          if (
            outcome === "update" &&
            headBefore !== undefined &&
            written?.head === headBefore
          )
            outcome = "current";
          toast.success(SUCCESS_COPY[outcome](p.number), {
            action: openWorktreeAction(openablePath(written, target)),
          });
          if (ownsPopover(p)) setPopoverOpen(false);
          return;
        } catch (e) {
          if (!isWorktreeDiverged(e)) {
            toastError(e);
            return;
          }
          if (!(await askReset(p, e))) return;
          force = true;
          // The measured sha, never a re-resolved ref.
          expectedHead = e.head;
        }
      }
    } finally {
      if (flight.current === token) flight.current = null;
    }
  }

  /** Fire-time twin of `runningReason`: the same pending-write scan
   *  `usePendingPrWrites` renders from, so a checkout started from another
   *  surface during this run's awaits refuses it. */
  function checkoutRunsNow(repo: string): boolean {
    const writes = pendingWritesFor(
      pendingMutationEntries(
        queryClient
          .getMutationCache()
          .findAll({ mutationKey: PR_WRITES_KEY, status: "pending" }),
      ),
      repo,
      readPendingPrWrite,
    );
    return pendingWriteOfKind(writes, "checkout") !== undefined;
  }

  /** A fresh worktree-list read; undefined when it fails. It bypasses the
   *  cache, since a query fetch would join one already in flight, which can
   *  have read the heads before local work moved them. */
  async function readRows(p: Pin): Promise<UserWorktree[] | undefined> {
    try {
      return await listUserWorktrees(p.repoPath);
    } catch {
      return undefined;
    }
  }

  /** The success toast's switch: the path is the one this run wrote, pinned
   *  now. The toast outlives the view, so removal is read at the click. */
  function openWorktreeAction(path: string | undefined) {
    if (path === undefined) return undefined;
    return {
      label: "Open worktree",
      onClick: () => {
        if (refuseWhileLeaving(folderKey(path), removingNow(path))) return;
        void openWorktree(path);
      },
    };
  }

  async function openExisting() {
    const p = pinRef.current;
    if (!p || !existing || detailsStale || flight.current) return;
    if (
      refuseWhileLeaving(folderKey(existing.path), removingNow(existing.path))
    )
      return;
    const token = {};
    flight.current = token;
    try {
      await openWorktree(existing.path);
      if (ownsPopover(p)) setPopoverOpen(false);
    } finally {
      if (flight.current === token) flight.current = null;
    }
  }

  function updateExisting() {
    if (
      !existing ||
      refuseWhileLeaving(folderKey(existing.path), removingNow(existing.path))
    )
      return;
    void run(existing.path, "update");
  }

  const removingReason = removing
    ? "This worktree is being removed."
    : undefined;

  return (
    <>
      <div ref={anchorRef} className={CHECKOUT_SPLIT_CLASS}>
        {children}
        <DropdownMenu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          onOpenChangeComplete={menuClose.onOpenChangeComplete}
        >
          <DropdownMenuTrigger
            ref={caretRef}
            onKeyDown={ignoreHeldActivation}
            render={
              <DisabledReasonButton
                variant="outline"
                size="icon-xs"
                disabled={staleReason !== undefined}
                reason={staleReason}
                aria-label={checkoutOptionsLabel(prNumber)}
                wrapperClassName="-ml-px"
              />
            }
          >
            <CaretDownIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56">
            <GhVersionGate>
              {(gate) => {
                const reason = runningReason ?? gate;
                return (
                  <DropdownMenuItem
                    disabled={reason !== undefined}
                    onClick={() => void openFromMenu()}
                    onKeyDown={ignoreHeldActivation}
                    className={`flex-col items-start gap-0.5 ${MENU_HELD_ROW_CLASS}`}
                  >
                    <span className="flex items-center gap-2">
                      <TreeStructureIcon className="size-4" aria-hidden />
                      Check out in a worktree…
                    </span>
                    {reason !== undefined && (
                      <span className="pl-6 text-[11px] text-muted-foreground">
                        {" "}
                        {reason}
                      </span>
                    )}
                  </DropdownMenuItem>
                );
              }}
            </GhVersionGate>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {/* Trap focus so Tab cycles inside: with no Trigger to hand focus back
          to, Base UI's focus guards would otherwise let it escape. Trapping
          needs a Close part in the popup; pointer presses outside still close. */}
      <Popover.Root
        modal="trap-focus"
        open={popoverOpen}
        onOpenChange={(o) => {
          if (!o) setPopoverOpen(false);
        }}
        onOpenChangeComplete={popoverClose.onOpenChangeComplete}
      >
        <Popover.Portal container={portalContainer}>
          <Popover.Positioner
            anchor={anchorRef}
            align="end"
            sideOffset={4}
            className="isolate z-50"
          >
            <Popover.Popup
              initialFocus={() => inputRef.current ?? true}
              finalFocus={route === "menu" ? caretRef : undefined}
              className="flex w-[360px] max-w-(--available-width) flex-col gap-2 rounded-none bg-popover p-3 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none"
            >
              <Popover.Title className="text-xs font-semibold">
                Check out #{prNumber} in a worktree
              </Popover.Title>
              <GhVersionGate>
                {(gate) =>
                  existing ? (
                    <>
                      <Popover.Description className="text-muted-foreground">
                        This pull request already has a worktree.
                      </Popover.Description>
                      <p className="flex min-w-0 items-center gap-1.5">
                        <CheckCircleIcon
                          className="size-3.5 shrink-0"
                          aria-hidden
                        />
                        <PathText
                          path={existing.path}
                          className="font-mono text-[11px]"
                        />
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        On{" "}
                        <code className="font-mono break-all">
                          {existing.branch}
                        </code>
                      </p>
                      <div className="mt-1 flex gap-2">
                        <DisabledReasonButton
                          size="sm"
                          disabled={
                            (staleReason ?? removingReason ?? runningReason) !==
                            undefined
                          }
                          reason={
                            staleReason ?? removingReason ?? runningReason
                          }
                          onClick={() => void openExisting()}
                          // The fallback initial focus: a key still held from
                          // the menu item lands here.
                          onKeyDown={ignoreHeldActivation}
                        >
                          Open worktree
                        </DisabledReasonButton>
                        <DisabledReasonButton
                          variant="outline"
                          size="sm"
                          disabled={
                            (staleReason ??
                              removingReason ??
                              runningReason ??
                              offlineHold ??
                              gate) !== undefined
                          }
                          reason={
                            staleReason ??
                            removingReason ??
                            runningReason ??
                            offlineHold ??
                            gate
                          }
                          onClick={updateExisting}
                          onKeyDown={ignoreHeldActivation}
                        >
                          {pending && <Spinner data-icon="inline-start" />}
                          Update to PR
                        </DisabledReasonButton>
                        <Popover.Close
                          render={
                            <Button
                              variant="ghost"
                              size="sm"
                              className="ml-auto"
                            />
                          }
                        >
                          Close
                        </Popover.Close>
                      </div>
                    </>
                  ) : (
                    <CreateForm
                      inputId={inputId}
                      inputRef={inputRef}
                      value={effectivePath}
                      onEdit={(v) => {
                        setPath(v);
                        setPathEdited(true);
                      }}
                      onBrowse={() => void browse()}
                      headRefName={headRefName}
                      reason={
                        staleReason ??
                        runningReason ??
                        offlineHold ??
                        gate ??
                        (effectivePath.trim()
                          ? undefined
                          : "Enter a folder for the worktree.")
                      }
                      pending={pending}
                      onSubmit={() => void run(effectivePath, "create")}
                    />
                  )
                }
              </GhVersionGate>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </>
  );
}

function CreateForm({
  inputId,
  inputRef,
  value,
  onEdit,
  onBrowse,
  headRefName,
  reason,
  pending,
  onSubmit,
}: {
  inputId: string;
  inputRef: Ref<HTMLInputElement>;
  value: string;
  onEdit: (value: string) => void;
  onBrowse: () => void;
  headRefName: string;
  reason: string | undefined;
  pending: boolean;
  onSubmit: () => void;
}) {
  return (
    <>
      <Popover.Description className="text-muted-foreground">
        Nothing is created until you confirm.
      </Popover.Description>
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
        <label htmlFor={inputId} className="text-muted-foreground">
          Folder
        </label>
        <Input
          id={inputId}
          ref={inputRef}
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => onEdit(e.target.value)}
          // A held Enter (from the menu item, say) must never run the checkout.
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (!e.repeat && reason === undefined) onSubmit();
          }}
          placeholder="Path for the new worktree"
          className="h-7 font-mono text-[11px]"
        />
        <Button
          variant="outline"
          size="icon-sm"
          onClick={onBrowse}
          aria-label="Browse for the folder to create it in"
          title="Browse for the folder to create it in"
        >
          <FolderOpenIcon />
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Checks out{" "}
        <code className="font-mono break-all text-foreground">
          {headRefName}
        </code>{" "}
        in its own folder — your current branch and files stay put.
      </p>
      <div className="mt-1 flex justify-end gap-2">
        <Popover.Close render={<Button variant="outline" size="sm" />}>
          Cancel
        </Popover.Close>
        <DisabledReasonButton
          size="sm"
          disabled={reason !== undefined}
          reason={reason}
          onClick={onSubmit}
        >
          {pending && <Spinner data-icon="inline-start" />}
          Check out
        </DisabledReasonButton>
      </div>
    </>
  );
}

/** The reset confirm's body: spans only, since it renders inside the dialog's
 *  description paragraph. Commits wrap rather than truncate, so every subject
 *  reads in full. */
function ResetBody({ diverged }: { diverged: WorktreeDiverged }) {
  const untracked = untrackedCount(diverged);
  return (
    <>
      <span className="block">
        The worktree at <PathText path={diverged.path} className="font-mono" />{" "}
        has commits that aren't on the pull request, so it can't fast-forward.
        Resetting it discards them:
      </span>
      <span
        role="list"
        className="mt-2 block space-y-0.5 font-mono text-[11px]"
      >
        {diverged.commits.map((c) => (
          <span key={c.sha} role="listitem" className="flex gap-2">
            <span className="shrink-0 text-muted-foreground">
              {c.sha.slice(0, 7)}
            </span>
            <span className="min-w-0 break-words">{c.subject}</span>
          </span>
        ))}
      </span>
      {diverged.more && <span className="mt-1 block">…and more</span>}
      {diverged.dirty && (
        <span className="mt-2 block">
          Its uncommitted changes are discarded too.
        </span>
      )}
      {untracked > 0 && (
        <span className="mt-2 block">
          {UNTRACKED_LINE[untracked === 1 ? "one" : "many"](untracked)}
        </span>
      )}
    </>
  );
}

const UNTRACKED_LINE: Record<"one" | "many", (n: number) => string> = {
  one: () =>
    "1 untracked file at a path the pull request tracks is overwritten too.",
  many: (n) =>
    `${n} untracked files at paths the pull request tracks are overwritten too.`,
};

/** Untracked files the reset overwrites: only those at paths the PR tracks,
 *  since every other untracked file survives it. An older payload carries no
 *  count, which reads as none. */
function untrackedCount(d: WorktreeDiverged): number {
  const n = (d as unknown as Record<string, unknown>).untracked;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 0;
}
