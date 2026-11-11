import { useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { PathText } from "@/components/path-text";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { copyText } from "@/lib/clipboard";
import {
  useInstallKeepLocalHook,
  useKeepLocalHookStatus,
  useKeepLocalHookWritePending,
  useRemoveKeepLocalHook,
} from "@/lib/git/queries";
import type { KeepLocalHookStatus } from "@/lib/git/types";
import { ACT_PENDING_REASON } from "@/lib/offline-writes";
import { useAiEnabled } from "@/lib/settings/queries";
import { landedIn, originNoteFor } from "@/lib/stores/notifications";
import { errorMessage } from "@/lib/tauri/invoke";
import { toastError, toastErrorWithNote } from "@/lib/toast";
import { useRetained } from "@/lib/use-retained";
import {
  KEEP_LOCAL_HOOK_AFTER_WRITE,
  KEEP_LOCAL_HOOK_BLOCKED,
  KEEP_LOCAL_HOOK_BUTTONS,
  KEEP_LOCAL_HOOK_CHECKING,
  KEEP_LOCAL_HOOK_CLONE_LEAD,
  KEEP_LOCAL_HOOK_CLONE_TAIL,
  KEEP_LOCAL_HOOK_COPIED,
  KEEP_LOCAL_HOOK_INERT,
  KEEP_LOCAL_HOOK_INSTALLED,
  KEEP_LOCAL_HOOK_NO_VERIFY,
  KEEP_LOCAL_HOOK_NOT_DONE,
  KEEP_LOCAL_HOOK_OFFER_BODY,
  KEEP_LOCAL_HOOK_OFFER_TITLE,
  KEEP_LOCAL_HOOK_ON_BODY,
  KEEP_LOCAL_HOOK_REMOVED,
  KEEP_LOCAL_HOOK_SNIPPET_LABEL,
  KEEP_LOCAL_HOOK_SNIPPET_LEAD,
  KEEP_LOCAL_HOOK_TITLE,
  KEEP_LOCAL_HOOK_UNREAD,
  keepLocalHookFile,
} from "./keep-local-copy";

/** What the dialog shows: the status's state, or no data yet / a failed read. */
type HookView = KeepLocalHookStatus["state"] | "loading" | "failed";

type HookWrite = "install" | "remove";

/** Whether a write's returned status counts as done; anything else (an install
 *  that lost a race comes back blocked) leaves the dialog open. A remove is done
 *  once GitDesktop's file is gone and the hooks folder is no link, since nothing
 *  is deleted through a linked hooks folder. */
const WRITE_DONE: Record<HookWrite, (after: KeepLocalHookStatus) => boolean> = {
  install: (after) => after.state === "installed",
  remove: (after) => !after.managedHookPresent && !after.hooksDirRedirected,
};

const WRITE_TOAST: Record<HookWrite, string> = {
  install: KEEP_LOCAL_HOOK_INSTALLED,
  remove: KEEP_LOCAL_HOOK_REMOVED,
};

/** What a status says the clone holds: the blocked reason, else the state. */
function hookStateDetail(status: KeepLocalHookStatus): string | null {
  if (status.state !== "blocked")
    return KEEP_LOCAL_HOOK_AFTER_WRITE[status.state];
  return status.blocked
    ? KEEP_LOCAL_HOOK_BLOCKED[status.blocked](status.manager)
    : null;
}

/**
 * The terminal push guard: installs, shows or removes the managed pre-push hook,
 * or explains why it can't be installed. Bound to the repo it opened for; the
 * host drops it on a repo switch. `session` is the open's token, and
 * `isLiveSession` answers after an await whether that open is still the shown
 * one, so a late settle never closes or annotates a dialog it wasn't pressed in.
 */
export function KeepLocalHookDialog({
  repoPath,
  open,
  session,
  isLiveSession,
  onOpenChange,
}: {
  repoPath: string;
  open: boolean;
  session: object | null;
  isLiveSession(session: object): boolean;
  onOpenChange(open: boolean): void;
}) {
  const status = useKeepLocalHookStatus(repoPath, open);
  const install = useInstallKeepLocalHook(repoPath);
  const remove = useRemoveKeepLocalHook(repoPath);
  const aiEnabled = useAiEnabled();
  // A write's failure, stamped with the open it was pressed in.
  const [failure, setFailure] = useState<{
    session: object;
    text: string;
  } | null>(null);
  const failureText =
    session !== null && failure?.session === session ? failure.text : null;

  const liveView: HookView = (() => {
    switch (true) {
      case status.data !== undefined:
        return status.data.state;
      case status.isError:
        return "failed";
      default:
        return "loading";
    }
  })();
  // Frozen while closing, so a write's cache seed never repaints the exit fade.
  const view = useRetained(liveView, open);
  const data = useRetained(status.data, open);

  // From the mutation cache, so a dialog reopened during an earlier open's write
  // holds too. Only the act button holds; the exit button never does.
  const writing = useKeepLocalHookWritePending(repoPath);
  const held = writing || status.isFetching;
  const heldReason = writing ? ACT_PENDING_REASON : KEEP_LOCAL_HOOK_CHECKING;

  // Every state has one safe button, and focus lands on it on open and on every
  // change of state, so a key still held from the menu never installs or
  // removes, and a button that unmounts under focus never drops it to <body>.
  const contentRef = useRef<HTMLDivElement>(null);
  const safeRef = useRef<HTMLButtonElement>(null);
  const shownView = useRef<HookView | null>(null);
  useLayoutEffect(() => {
    const previous = shownView.current;
    shownView.current = view;
    if (!open || previous === null || previous === view) return;
    const active = document.activeElement;
    if (
      active === null ||
      active === document.body ||
      contentRef.current?.contains(active)
    )
      safeRef.current?.focus();
  }, [view, open]);

  async function runWrite(kind: HookWrite) {
    if (session === null) return;
    const token = session;
    const repo = repoPath;
    setFailure(null);
    let after: KeepLocalHookStatus;
    try {
      after = await (kind === "install" ? install : remove).mutateAsync({
        repo,
      });
    } catch (e) {
      if (isLiveSession(token)) {
        setFailure({ session: token, text: errorMessage(e) });
        return;
      }
      const note = originNoteFor(repo);
      if (note) toastErrorWithNote(e, note);
      else toastError(e);
      return;
    }
    if (WRITE_DONE[kind](after)) {
      toast.success(`${WRITE_TOAST[kind]}${landedIn(repo).away}`);
      if (isLiveSession(token)) onOpenChange(false);
      return;
    }
    // Never silent: inline while its open is shown (the can't-install state
    // already explains a blocked install, and states a blocked remove's reason),
    // otherwise a toast naming the repository when it isn't the shown one.
    const detail = hookStateDetail(after);
    if (isLiveSession(token)) {
      if (kind === "install" && after.state === "blocked") return;
      const lead = `${KEEP_LOCAL_HOOK_NOT_DONE[kind]}.`;
      setFailure({
        session: token,
        text: after.state === "blocked" ? lead : `${lead} ${detail}`,
      });
      return;
    }
    toast.info(
      `${KEEP_LOCAL_HOOK_NOT_DONE[kind]}${landedIn(repo).away}`,
      detail ? { description: detail } : undefined,
    );
  }

  const failureLine = failureText ? (
    <p role="alert" className="text-xs text-destructive">
      {failureText}
    </p>
  ) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={contentRef}
        className="max-h-[85vh] overflow-y-auto"
        initialFocus={() => safeRef.current}
      >
        {(() => {
          switch (view) {
            case "absent":
              return (
                <>
                  <DialogHeader>
                    <DialogTitle className="pr-8">
                      {KEEP_LOCAL_HOOK_OFFER_TITLE}
                    </DialogTitle>
                    <DialogDescription>
                      {KEEP_LOCAL_HOOK_OFFER_BODY[aiEnabled ? "ai" : "noAi"]}
                    </DialogDescription>
                  </DialogHeader>
                  <ul className="min-w-0 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                    <li>
                      <span className="flex min-w-0 flex-wrap">
                        <span>{KEEP_LOCAL_HOOK_CLONE_LEAD}</span>
                        <PathText
                          path={keepLocalHookFile(data?.hooksPath ?? "")}
                          className="font-mono text-xs leading-5"
                        />
                        <span>{KEEP_LOCAL_HOOK_CLONE_TAIL}</span>
                      </span>
                    </li>
                    <li>{KEEP_LOCAL_HOOK_NO_VERIFY}</li>
                  </ul>
                  {failureLine}
                  <DialogFooter>
                    <Button
                      ref={safeRef}
                      variant="ghost"
                      onClick={() => onOpenChange(false)}
                    >
                      {KEEP_LOCAL_HOOK_BUTTONS.cancel}
                    </Button>
                    <DisabledReasonButton
                      disabled={held}
                      reason={heldReason}
                      onClick={() => void runWrite("install")}
                    >
                      {KEEP_LOCAL_HOOK_BUTTONS.install}
                    </DisabledReasonButton>
                  </DialogFooter>
                </>
              );
            case "installed":
              return (
                <>
                  <DialogHeader>
                    <DialogTitle className="pr-8">
                      {KEEP_LOCAL_HOOK_TITLE}
                    </DialogTitle>
                    <DialogDescription>
                      {KEEP_LOCAL_HOOK_ON_BODY}
                    </DialogDescription>
                  </DialogHeader>
                  {failureLine}
                  <DialogFooter>
                    <DisabledReasonButton
                      variant="outline"
                      disabled={held}
                      reason={heldReason}
                      onClick={() => void runWrite("remove")}
                    >
                      {KEEP_LOCAL_HOOK_BUTTONS.remove}
                    </DisabledReasonButton>
                    <Button ref={safeRef} onClick={() => onOpenChange(false)}>
                      {KEEP_LOCAL_HOOK_BUTTONS.close}
                    </Button>
                  </DialogFooter>
                </>
              );
            case "blocked":
              return (
                <>
                  <DialogHeader>
                    <DialogTitle className="pr-8">
                      {KEEP_LOCAL_HOOK_TITLE}
                    </DialogTitle>
                    <DialogDescription>
                      {data?.blocked
                        ? KEEP_LOCAL_HOOK_BLOCKED[data.blocked](data.manager)
                        : null}{" "}
                      {KEEP_LOCAL_HOOK_SNIPPET_LEAD}
                    </DialogDescription>
                  </DialogHeader>
                  <pre
                    // Focusable so a keyboard can scroll a long check.
                    tabIndex={0}
                    aria-label={KEEP_LOCAL_HOOK_SNIPPET_LABEL}
                    className="max-h-48 min-w-0 overflow-auto whitespace-pre rounded-md border border-border bg-muted/50 p-3 font-mono text-[11px] leading-relaxed"
                  >
                    {data?.snippet}
                  </pre>
                  {data?.managedHookPresent ? (
                    <p className="text-sm text-muted-foreground">
                      {KEEP_LOCAL_HOOK_INERT}
                    </p>
                  ) : null}
                  {failureLine}
                  <DialogFooter>
                    <Button
                      ref={safeRef}
                      variant="ghost"
                      onClick={() => onOpenChange(false)}
                    >
                      {KEEP_LOCAL_HOOK_BUTTONS.close}
                    </Button>
                    {data?.managedHookPresent ? (
                      <DisabledReasonButton
                        variant="outline"
                        disabled={held}
                        reason={heldReason}
                        onClick={() => void runWrite("remove")}
                      >
                        {KEEP_LOCAL_HOOK_BUTTONS.remove}
                      </DisabledReasonButton>
                    ) : null}
                    <Button
                      variant="outline"
                      onClick={() =>
                        void copyText(
                          data?.snippet ?? "",
                          KEEP_LOCAL_HOOK_COPIED,
                        )
                      }
                    >
                      {KEEP_LOCAL_HOOK_BUTTONS.copy}
                    </Button>
                  </DialogFooter>
                </>
              );
            case "failed":
              return (
                <>
                  <DialogHeader>
                    <DialogTitle className="pr-8">
                      {KEEP_LOCAL_HOOK_TITLE}
                    </DialogTitle>
                    <DialogDescription>
                      {KEEP_LOCAL_HOOK_UNREAD}
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    {/* No held state: a retry with no data turns the read pending,
                        which swaps this state for the busy one at once. */}
                    <Button
                      variant="outline"
                      onClick={() => void status.refetch()}
                    >
                      {KEEP_LOCAL_HOOK_BUTTONS.retry}
                    </Button>
                    <Button ref={safeRef} onClick={() => onOpenChange(false)}>
                      {KEEP_LOCAL_HOOK_BUTTONS.close}
                    </Button>
                  </DialogFooter>
                </>
              );
            default:
              return (
                <>
                  <DialogHeader>
                    <DialogTitle className="pr-8">
                      {KEEP_LOCAL_HOOK_TITLE}
                    </DialogTitle>
                    <DialogDescription aria-busy="true">
                      {KEEP_LOCAL_HOOK_CHECKING}
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button ref={safeRef} onClick={() => onOpenChange(false)}>
                      {KEEP_LOCAL_HOOK_BUTTONS.close}
                    </Button>
                  </DialogFooter>
                </>
              );
          }
        })()}
      </DialogContent>
    </Dialog>
  );
}
