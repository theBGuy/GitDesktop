import {
  ArrowDownIcon,
  ArrowUpIcon,
  CaretDownIcon,
  SparkleIcon,
  XIcon,
} from "@phosphor-icons/react";
import {
  type FocusEvent,
  type KeyboardEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { MENU_HELD_ROW_CLASS } from "@/components/menu-held-row";
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
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { PROMOTION_BLOCKS_CHECKOUT } from "@/features/repository/checkout-copy";
import { clipTitle, clipTitleFromText } from "@/lib/clip-title";
import {
  useRebaseEdit,
  useRewriteCommits,
  useUnpushedMessages,
} from "@/lib/git/queries";
import type { CommitSummary } from "@/lib/git/types";
import {
  bindingToAriaKeyshortcuts,
  eventToBinding,
  formatBinding,
} from "@/lib/hotkeys/binding";
import { useRovingRows } from "@/lib/list-keyboard-nav";
import { useAiEnabled } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { promotionBlocksCheckout } from "@/lib/stores/worktree-removal";
import { toastError } from "@/lib/toast";
import { useLatestRef } from "@/lib/use-latest-ref";
import { cn } from "@/lib/utils";
import {
  compilePlan,
  type EditRow,
  FOLD_HELD_LABEL,
  moveAnnouncement,
  type RowAction,
} from "./edit-history-plan";
import {
  leftRebaseInProgress,
  useGenerateSquashMessage,
} from "./RewriteDialogs";

/** Action labels + one-line descriptions for the per-row picker. Squash and
 *  fixup carry no static hint: theirs names the commit they combine into. */
const ACTIONS: { value: RowAction; label: string; hint?: string }[] = [
  { value: "pick", label: "Pick", hint: "Keep this commit as-is" },
  {
    value: "reword",
    label: "Reword",
    hint: "Keep the changes, edit the message",
  },
  { value: "squash", label: "Squash" },
  { value: "fixup", label: "Fixup" },
  {
    value: "edit",
    label: "Edit",
    hint: "Stop to amend this commit's changes",
  },
  { value: "drop", label: "Drop", hint: "Remove this commit entirely" },
];
const ACTION_LABEL = new Map(ACTIONS.map((a) => [a.value, a.label]));

type FoldAction = "squash" | "fixup";
const isFold = (a: RowAction): a is FoldAction =>
  a === "squash" || a === "fixup";
/** The second line of a fold's menu hint, after the quoted target. */
const FOLD_HINT_TAIL: Record<FoldAction, string> = {
  squash: "joining the messages",
  fixup: "keeping that commit's message",
};
const FOLD_HELD_HINT = "No older kept commit in this list to combine into";
const BUSY_REASON = "The rewrite is still running.";
const AT_NEWEST = "Already the newest commit";
const AT_OLDEST = "Already the oldest commit";

/** The dialog's move chords, as canonical bindings (`eventToBinding`'s own
 *  spelling). Feature-local rather than registry bindings: they act on the
 *  focused commit row, which only this handler can see. */
const MOVE_CHORDS: Partial<Record<string, "up" | "down" | "top" | "bottom">> = {
  "alt+up": "up",
  "alt+down": "down",
  "alt+home": "top",
  "alt+end": "bottom",
};
const MOVE_KEYSHORTCUTS = Object.keys(MOVE_CHORDS)
  .map(bindingToAriaKeyshortcuts)
  .join(" ");
/** Every key a row answers with Alt held. The chords above match first; any
 *  other Alt press on these (Alt+←, Alt+Shift+Home) is swallowed, so Alt never
 *  degrades to plain navigation or reaches the webview's own accelerators. */
const ALT_SWALLOWED_KEYS: ReadonlySet<string> = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
]);
/** Zero-width space, built from its code point so no invisible byte sits in
 *  source. Toggled into the live region so a repeated message re-announces. */
const ZWSP = String.fromCharCode(0x200b);

/** The commit row for `hash` inside `list`, or null. */
function findRow(list: HTMLElement | null, hash: string): HTMLElement | null {
  return (
    list?.querySelector<HTMLElement>(`[data-row="${CSS.escape(hash)}"]`) ?? null
  );
}

/** A menu item's second line: what a squash or fixup combines into (or why it
 *  can't), else the action's static hint. */
function ActionHint({
  action,
  hint,
  target,
}: {
  action: RowAction;
  hint?: string;
  target: string | null;
}) {
  if (!isFold(action))
    return <span className="text-[11px] text-muted-foreground">{hint}</span>;
  // Foreground, so it reads muted under the held item's disabled opacity.
  if (target === null)
    return (
      <span className="text-[11px] text-foreground">{FOLD_HELD_HINT}</span>
    );
  // The subject truncates to what the first line leaves after its quotes, so
  // it always starts right after the opening one. The text still reads as one
  // sentence, since typeahead reads the item's whole text.
  return (
    <span className="flex max-w-full flex-col text-[11px] text-muted-foreground">
      <span className="flex min-w-0 max-w-full">
        <span className="shrink-0 whitespace-pre">Combine into "</span>
        <span className="min-w-0 truncate" onMouseEnter={clipTitle(target)}>
          {target}
        </span>
        <span className="shrink-0">",</span>
      </span>
      <span> {FOLD_HINT_TAIL[action]}</span>
    </span>
  );
}

/**
 * The unified interactive-rebase editor over the unpushed tip (`base..HEAD`).
 * Each row picks an action (pick / reword / squash / fixup / edit / drop),
 * reorders with its ↑/↓ buttons, Alt+↑/↓ or Alt+Home/End, and edits its
 * message inline when the action bakes one (reword, squash, and a pick or edit
 * a squash folds into).
 * The plan compiles to the replay engine, which applies it all at once (a
 * conflict rolls it back), or to a resumable rebase when a row is set to edit.
 */
export function EditHistoryDialog({
  repoPath,
  base,
  commits,
  open,
  onOpenChange,
  onDone,
}: {
  repoPath: string;
  base: string;
  /** Editable unpushed commits, newest-first (matches the history list). */
  commits: CommitSummary[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const rewrite = useRewriteCommits(repoPath);
  const rebaseEdit = useRebaseEdit(repoPath);
  const busy = rewrite.isPending || rebaseEdit.isPending;
  const setRepoTab = useUiStore((s) => s.setRepoTab);
  const messages = useUnpushedMessages(repoPath, base, open);

  const [order, setOrder] = useState<string[]>(() =>
    commits.map((c) => c.hash),
  );
  const [actions, setActions] = useState<Record<string, RowAction>>({});
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  // Bumps on every reseed, so focus the reorder dropped can be put back.
  const [reseedNonce, setReseedNonce] = useState(0);
  const [menuHash, setMenuHash] = useState<string | null>(null);

  // Reseed when a different set of commits arrives (render-time adjustment).
  const key = commits.map((c) => c.hash).join();
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setOrder(commits.map((c) => c.hash));
    setActions({});
    setOverrides({});
    setReseedNonce((n) => n + 1);
    // A menu whose row left would otherwise reopen by itself if the row came
    // back; one whose row survived stays open.
    if (menuHash !== null && !commits.some((c) => c.hash === menuHash)) {
      setMenuHash(null);
    }
  }

  const subjectOf = useMemo(
    () => new Map(commits.map((c) => [c.hash, c.subject])),
    [commits],
  );
  const fullMessages = messages.data ?? {};

  // Per-row AI message generation (reword only — a single commit's own diff).
  // The hash lives in state so render can read which row is generating; the ref
  // mirrors it for the async completion callback (which fires after streaming).
  const [genHash, setGenHash] = useState<string | null>(null);
  const genHashRef = useLatestRef(genHash);
  const aiEnabled = useAiEnabled();
  const ai = useGenerateSquashMessage(repoPath, (message) => {
    const h = genHashRef.current;
    if (h) setOverrides((o) => ({ ...o, [h]: message }));
  });

  const rows: EditRow[] = useMemo(
    () =>
      order.map((hash) => {
        const action = actions[hash] ?? "pick";
        const subject = subjectOf.get(hash) ?? hash.slice(0, 7);
        // The full original message (or subject until it loads); compilePlan
        // uses it only for reword/squash leaders and squash contributions.
        const message = overrides[hash] ?? fullMessages[hash] ?? subject;
        return { hash, subject, action, message };
      }),
    [order, actions, overrides, subjectOf, fullMessages],
  );

  const originalHashes = useMemo(() => commits.map((c) => c.hash), [commits]);
  const plan = useMemo(
    () => compilePlan(rows, originalHashes),
    [rows, originalHashes],
  );
  // reword/squash bake the message into the rewrite, so they can't be applied
  // until the full bodies have loaded — otherwise a multi-line body would be
  // silently truncated to its subject.
  const needsMessages = rows.some(
    (r) => r.action === "reword" || r.action === "squash",
  );

  // The rows are one Tab stop (message fields and Generate keep their own); the
  // trigger and arrow buttons are tabIndex -1, as Enter or Space opens the menu
  // from the row.
  const nav = useRovingRows({ items: rows, rowKey: (r) => r.hash });
  const listRef = useRef<HTMLDivElement>(null);
  const lastFocusedRow = useRef<string | null>(null);
  // The row whose menu `onOpenChange(true)` opened during a key-driven click.
  const keyOpenedRow = useRef<string | null>(null);
  const [moveFocus, setMoveFocus] = useState<{
    hash: string;
    nonce: number;
  } | null>(null);
  const [announcement, setAnnouncement] = useState({ text: "", seq: 0 });
  const announce = (text: string) =>
    setAnnouncement((prev) => ({ text, seq: prev.seq + 1 }));

  // A move re-orders keyed nodes, which can drop focus off the moved row (and a
  // button click parks it on a button), so every move lands focus back on it.
  useLayoutEffect(() => {
    if (moveFocus === null) return;
    const el = findRow(listRef.current, moveFocus.hash);
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  }, [moveFocus]);

  // A reseed re-orders and can drop rows too. Focus returns only when it was on
  // a row or fell to the body; a message field, Generate or the footer keep it.
  useLayoutEffect(() => {
    if (reseedNonce === 0) return;
    const list = listRef.current;
    if (list === null) return;
    const active = document.activeElement;
    const onRow =
      active instanceof HTMLElement &&
      list.contains(active) &&
      active.closest("[data-row-message]") === null;
    if (!onRow && active !== null && active !== document.body) return;
    const remembered = lastFocusedRow.current;
    const el =
      (remembered === null ? null : findRow(list, remembered)) ??
      list.querySelector<HTMLElement>("[data-row]");
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  }, [reseedNonce]);

  function setAction(hash: string, action: RowAction) {
    setActions((a) => ({ ...a, [hash]: action }));
  }

  // Moves the row at `index` to `to` and announces it (`moveAnnouncement` says
  // what that covers). The next plan is compiled here: the memoized one is a
  // render behind inside the handler.
  function moveTo(index: number, to: number) {
    if (to === index || to < 0 || to >= order.length) return;
    const nextOrder = [...order];
    const [hash] = nextOrder.splice(index, 1);
    nextOrder.splice(to, 0, hash);
    const nextRows = [...rows];
    const [moved] = nextRows.splice(index, 1);
    nextRows.splice(to, 0, moved);
    const nextPlan = compilePlan(nextRows, originalHashes);
    setOrder(nextOrder);
    setMoveFocus((prev) => ({ hash, nonce: (prev?.nonce ?? 0) + 1 }));

    announce(
      moveAnnouncement({
        prev: plan,
        next: nextPlan,
        action: moved.action,
        hash,
        from: index,
        to,
        total: order.length,
      }),
    );
  }

  function move(index: number, delta: -1 | 1) {
    moveTo(index, index + delta);
  }

  function onListKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // Rows only: caret keys in a message field, and keys on a button or in a
    // menu, keep their own behavior.
    const row = e.target;
    if (!(row instanceof HTMLElement)) return;
    const hash = row.getAttribute("data-row");
    if (hash === null) return;
    const chord = eventToBinding(e);
    const direction = chord === null ? undefined : MOVE_CHORDS[chord];
    const swallowed = e.altKey && ALT_SWALLOWED_KEYS.has(e.key);
    // Plain Home/End only; a modified one keeps its native behavior.
    const jump = chord === "home" || chord === "end";
    // Unmodified only: the canonical binding carries every modifier, so a
    // modified Enter or Space keeps its native behavior (Shift+Space scrolls,
    // Alt+Space is the system menu).
    const menuKey = chord === "enter" || chord === "space";

    // While busy, walking the rows stays live (it changes nothing); moves, the
    // Alt swallow and the menu open refuse with the reason.
    if (busy && (direction !== undefined || swallowed || menuKey)) {
      e.preventDefault();
      if (!e.repeat) announce(BUSY_REASON);
      return;
    }
    // No repeat gate: holding the chord repeats the move.
    if (direction !== undefined) {
      e.preventDefault();
      const index = order.indexOf(hash);
      const last = order.length - 1;
      switch (direction) {
        case "up":
        case "top":
          if (index === 0) {
            // Once per press: a held chord at the end would spam the region.
            if (!e.repeat) announce(AT_NEWEST);
          } else moveTo(index, direction === "up" ? index - 1 : 0);
          return;
        case "down":
        case "bottom":
          if (index === last) {
            if (!e.repeat) announce(AT_OLDEST);
          } else moveTo(index, direction === "down" ? index + 1 : last);
          return;
      }
    }
    if (swallowed) {
      e.preventDefault();
      return;
    }
    if (jump) {
      const all = e.currentTarget.querySelectorAll<HTMLElement>("[data-row]");
      const edge = chord === "home" ? all[0] : all[all.length - 1];
      if (edge === undefined) return;
      e.preventDefault();
      edge.focus();
      edge.scrollIntoView({ block: "nearest" });
      return;
    }
    if (menuKey) {
      // Every press is handled, so a held Space can't scroll the list; only the
      // first opens, as a held Enter would flicker the menu.
      e.preventDefault();
      if (e.repeat) return;
      // A controlled open gets no keyboard highlight, so open through Base UI's
      // own keyboard-activation click (detail 0, no pointer type) on the trigger.
      const trigger = row.querySelector<HTMLElement>("[data-action-trigger]");
      const click = () =>
        trigger?.dispatchEvent(
          new PointerEvent("click", {
            bubbles: true,
            cancelable: true,
            composed: true,
            detail: 0,
          }),
        );
      keyOpenedRow.current = null;
      click();
      // A press that ended off the trigger makes Base UI swallow one click.
      if (keyOpenedRow.current !== hash) click();
      return;
    }
    nav.onRowKeyDown(e);
  }

  function onListFocusCapture(e: FocusEvent<HTMLDivElement>) {
    if (e.target instanceof HTMLElement && e.target.hasAttribute("data-row")) {
      lastFocusedRow.current = e.target.getAttribute("data-row");
    }
  }

  // A failure that left the rebase in progress (a timed-out or interrupted run,
  // or a rollback that couldn't abort) hands off to Changes like a paused edit;
  // a clean rollback keeps the dialog open with the plan intact.
  async function handOffIfLeftRebasing() {
    if (!(await leftRebaseInProgress(repoPath))) return;
    if (useUiStore.getState().repoPath !== repoPath) return;
    onOpenChange(false);
    setRepoTab("changes");
    onDone();
  }

  // Awaited rather than per-call mutation callbacks: this dialog is mounted
  // conditionally, so closing it mid-rewrite would drop the outcome — including
  // the hand-off to the Changes tab that the paused rebase depends on.
  async function apply() {
    if (plan.error || !plan.changed) return;
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return;
    }
    if (plan.hasEdit) {
      // Resumable path: starts a real rebase that pauses at the first Edit —
      // the conflict/op banner in Changes takes it from there.
      try {
        await rebaseEdit.mutateAsync({
          base,
          steps: plan.steps,
          dropped: plan.dropped,
        });
        toast.success("Rebase started — paused to edit a commit");
        onOpenChange(false);
        if (useUiStore.getState().repoPath === repoPath) setRepoTab("changes");
        onDone();
      } catch (e) {
        toastError(e);
        await handOffIfLeftRebasing();
      }
      return;
    }
    try {
      await rewrite.mutateAsync({
        base,
        steps: plan.steps,
        dropped: plan.dropped,
      });
      toast.success(
        plan.resultCount === 1
          ? "History rewritten into one commit"
          : `History rewritten — ${plan.resultCount} commits`,
      );
      onOpenChange(false);
      onDone();
    } catch (e) {
      toastError(e);
      await handOffIfLeftRebasing();
    }
  }

  return (
    <Dialog
      open={open}
      // Close requests are ignored while the rewrite runs: a seconds-scale
      // local operation whose outcome this dialog still owes the user. A repo
      // switch, or leaving the repository view, unmounts it anyway; the
      // awaited continuation still settles, and its tab hand-off guards on
      // the live repo.
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      {/* The corner X would be a dead control while the guard above swallows
          every close path, so it goes away for the duration. */}
      <DialogContent
        className="flex max-h-[85vh] flex-col sm:max-w-2xl"
        showCloseButton={!busy}
        initialFocus={() =>
          listRef.current?.querySelector<HTMLElement>("[data-row]") ?? true
        }
      >
        <DialogHeader>
          <DialogTitle>Edit history</DialogTitle>
          <DialogDescription>
            Reshape your unpushed commits — reword, squash, fixup, drop, or
            reorder. Newest on top; {formatBinding("alt+up")} and{" "}
            {formatBinding("alt+down")} move the focused commit. This rewrites
            local history; a conflict rolls it back.
          </DialogDescription>
        </DialogHeader>

        <div
          ref={listRef}
          role="list"
          aria-label="Commits, newest first"
          className="min-h-0 flex-1 space-y-px overflow-y-auto border"
          onKeyDown={onListKeyDown}
          onFocusCapture={onListFocusCapture}
        >
          {rows.map((row, index) => {
            const view = plan.views[index];
            const dropped = row.action === "drop";
            const target = view.foldTarget;
            const folds = isFold(row.action);
            const folding = folds && target !== null;
            const held = folds && target === null;
            const foldState = (() => {
              switch (true) {
                case folding:
                  return `, into "${target}"`;
                case held:
                  return `, ${FOLD_HELD_LABEL}`;
                default:
                  return "";
              }
            })();
            const upReason = (() => {
              switch (true) {
                case busy:
                  return BUSY_REASON;
                case index === 0:
                  return AT_NEWEST;
                default:
                  return null;
              }
            })();
            const downReason = (() => {
              switch (true) {
                case busy:
                  return BUSY_REASON;
                case index === order.length - 1:
                  return AT_OLDEST;
                default:
                  return null;
              }
            })();
            return (
              <div
                key={row.hash}
                role="listitem"
                {...nav.rowProps(row)}
                aria-label={`${ACTION_LABEL.get(row.action)} ${row.hash.slice(0, 7)} ${row.subject}${foldState}`}
                aria-keyshortcuts={MOVE_KEYSHORTCUTS}
                className="border-b outline-none last:border-b-0 focus-visible:bg-muted/40 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset data-[dropped=true]:bg-muted/30"
                data-dropped={dropped}
              >
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <DropdownMenu
                    open={menuHash === row.hash}
                    onOpenChange={(o) => {
                      if (o) keyOpenedRow.current = row.hash;
                      // Clears only its own row, so a close racing another
                      // row's open can't wipe that open.
                      setMenuHash((cur) => {
                        if (o) return row.hash;
                        return cur === row.hash ? null : cur;
                      });
                    }}
                  >
                    <DropdownMenuTrigger
                      render={
                        <DisabledReasonButton
                          variant="outline"
                          size="xs"
                          tabIndex={-1}
                          disabled={busy}
                          reason={BUSY_REASON}
                          data-action-trigger=""
                          className="w-20 justify-between"
                          aria-label={`Action for ${row.subject}`}
                        >
                          {ACTION_LABEL.get(row.action)}
                          <CaretDownIcon />
                        </DisabledReasonButton>
                      }
                    />
                    <DropdownMenuContent
                      align="start"
                      className="w-64"
                      // Back to the row, so the next arrow walks the list
                      // instead of reopening the menu from its trigger.
                      finalFocus={() =>
                        findRow(listRef.current, row.hash) ?? true
                      }
                    >
                      {ACTIONS.map((a) => {
                        const heldItem = isFold(a.value) && target === null;
                        return (
                          <DropdownMenuItem
                            key={a.value}
                            disabled={heldItem}
                            // Named outright: the hint's first line is three
                            // flex items, which a name from content joins with
                            // spaces inside the quotes.
                            aria-label={
                              isFold(a.value) && target !== null
                                ? `${a.label} Combine into "${target}", ${FOLD_HINT_TAIL[a.value]}`
                                : undefined
                            }
                            onClick={() => setAction(row.hash, a.value)}
                            // Base UI activates a menu item on keydown with no
                            // repeat check, so a key still held from opening
                            // the menu would pick the highlighted item.
                            onKeyDown={(e) => {
                              if (
                                e.repeat &&
                                (e.key === "Enter" || e.key === " ")
                              ) {
                                e.preventDefault();
                                e.preventBaseUIHandler();
                              }
                            }}
                            className={cn(
                              "flex-col items-start gap-0.5",
                              heldItem && MENU_HELD_ROW_CLASS,
                            )}
                          >
                            <span className="text-xs font-medium">
                              {a.label}
                            </span>
                            <ActionHint
                              action={a.value}
                              hint={a.hint}
                              target={target}
                            />
                          </DropdownMenuItem>
                        );
                      })}
                    </DropdownMenuContent>
                  </DropdownMenu>

                  {/* Reserved on every row, so the fold glyph shifts nothing. */}
                  <span
                    aria-hidden
                    className="w-3 shrink-0 text-center text-[11px] text-muted-foreground"
                  >
                    {folding ? "↳" : null}
                  </span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {row.hash.slice(0, 7)}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-xs",
                      dropped && "text-muted-foreground line-through",
                    )}
                    onMouseEnter={clipTitleFromText}
                  >
                    {row.subject}
                  </span>
                  {folding && (
                    <span
                      className="max-w-[40%] truncate text-[11px] text-muted-foreground"
                      onMouseEnter={clipTitle(target)}
                    >
                      into <span className="text-foreground">"{target}"</span>
                    </span>
                  )}
                  {held && (
                    <span
                      className="max-w-[40%] truncate text-[11px] text-warning"
                      onMouseEnter={clipTitleFromText}
                    >
                      {FOLD_HELD_LABEL}
                    </span>
                  )}
                  {row.action === "edit" && (
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      pauses to amend
                    </span>
                  )}
                  {dropped && (
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      removed
                    </span>
                  )}
                  <DisabledReasonButton
                    variant="ghost"
                    size="icon-xs"
                    tabIndex={-1}
                    aria-label={`Move ${row.subject} up`}
                    title={`Move up (${formatBinding("alt+up")})`}
                    disabled={upReason !== null}
                    reason={upReason}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUpIcon />
                  </DisabledReasonButton>
                  <DisabledReasonButton
                    variant="ghost"
                    size="icon-xs"
                    tabIndex={-1}
                    aria-label={`Move ${row.subject} down`}
                    title={`Move down (${formatBinding("alt+down")})`}
                    disabled={downReason !== null}
                    reason={downReason}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDownIcon />
                  </DisabledReasonButton>
                </div>

                {view.showMessage && (
                  <div
                    className="space-y-1 px-2 pb-2 pl-29"
                    data-row-message=""
                  >
                    <Textarea
                      aria-label={`Message for ${row.subject}`}
                      rows={row.action === "squash" ? 4 : 3}
                      // Disabled until the full bodies load, so editing can't
                      // capture a subject-only message and drop the body.
                      disabled={busy || !messages.isSuccess}
                      placeholder={
                        messages.isLoading ? "Loading message…" : undefined
                      }
                      className="max-h-40 min-h-16 resize-y font-mono text-xs"
                      value={messages.isSuccess ? row.message : ""}
                      onChange={(e) =>
                        setOverrides((o) => ({
                          ...o,
                          [row.hash]: e.target.value,
                        }))
                      }
                    />
                    {aiEnabled &&
                      row.action === "reword" &&
                      (ai.generating && genHash === row.hash ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={ai.cancel}
                        >
                          <XIcon data-icon="inline-start" />
                          Cancel
                        </Button>
                      ) : (
                        <DisabledReasonButton
                          type="button"
                          variant="ghost"
                          size="xs"
                          disabled={ai.generating || !messages.isSuccess}
                          title="Generate this commit's message with AI"
                          // `ai.generating` here means ANOTHER row is
                          // generating — this row's own run renders Cancel.
                          reason={
                            ai.generating
                              ? "Another commit message is generating"
                              : messages.isError
                                ? "Couldn't load commit messages"
                                : "Loading commit messages…"
                          }
                          onClick={() => {
                            setGenHash(row.hash);
                            ai.generate(`${row.hash}^`, row.hash);
                          }}
                        >
                          <SparkleIcon data-icon="inline-start" />
                          Generate
                        </DisabledReasonButton>
                      ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {/* Inside the popup: the dialog is modal, so content outside it is
            hidden from assistive tech. The seq's zero-width space makes a
            repeated message (the same end bump twice) still announce. */}
        <span role="status" aria-live="polite" className="sr-only">
          {announcement.text}
          {ZWSP.repeat(announcement.seq % 2)}
        </span>

        <DialogFooter className="sm:items-center sm:justify-between">
          <div className="mr-auto text-xs text-muted-foreground">
            {messages.isError ? (
              <span className="text-warning">
                Couldn't load commit messages.{" "}
                <button
                  type="button"
                  className="cursor-pointer underline underline-offset-2"
                  onClick={() => messages.refetch()}
                >
                  Retry
                </button>
              </span>
            ) : plan.error ? (
              <span className="text-warning">{plan.error}</span>
            ) : (
              <>
                Result:{" "}
                <span className="tabular-nums text-foreground">
                  {plan.resultCount}
                </span>{" "}
                {plan.resultCount === 1 ? "commit" : "commits"}
                {plan.hasEdit && (
                  <span className="block text-[11px]">
                    Pauses at each Edit so you can amend it, then Continue from
                    the banner.
                  </span>
                )}
              </>
            )}
          </div>
          <DisabledReasonButton
            variant="outline"
            disabled={busy}
            reason={BUSY_REASON}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </DisabledReasonButton>
          <Button
            disabled={
              busy ||
              !plan.changed ||
              plan.error !== null ||
              (needsMessages && !messages.isSuccess)
            }
            onClick={apply}
          >
            {busy && <Spinner data-icon="inline-start" />}
            {plan.hasEdit ? "Start rebase" : "Rewrite history"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
