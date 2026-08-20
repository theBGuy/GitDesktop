import { ArrowSquareOutIcon, TerminalIcon } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { copyText } from "@/lib/clipboard";
import {
  forgeReconnect,
  forgeReconnectCancel,
  openInTerminal,
} from "@/lib/git/api";
import { isReconnectHostSafe } from "@/lib/git/host";
import { useInvalidateAfterReconnect } from "@/lib/git/queries";
import { providerLabel, type ReconnectEvent } from "@/lib/git/types";
import { useSettings } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { errorMessage } from "@/lib/tauri/invoke";
import { toastError } from "@/lib/toast";

/** The distinct phases the reconnect flow drives through, from the streamed
 *  `ReconnectEvent`s. `starting` is the pre-event state; `code` is gh's device
 *  flow; `lines` is glab's browser flow (no code); `finished` is terminal. */
type Phase =
  | { kind: "starting" }
  | { kind: "code"; code: string; url: string }
  | { kind: "lines"; lines: string[] }
  | {
      kind: "finished";
      ok: boolean;
      login: string | null;
      message: string | null;
    };

/**
 * The global one-click reconnect dialog for a dead (or new) gh/glab session.
 * Opened from anywhere via the ui store's `reconnectTarget`; mounted once next to
 * the other global dialogs in `App`. Drives GitHub's device flow (a one-time code
 * + "Open browser") and GitLab's `--web` flow (progress lines) in-app, so a user
 * never has to drop to a terminal. Every close path cancels the live Rust flow.
 */
export function ReconnectDialog() {
  const target = useUiStore((s) => s.reconnectTarget);
  const closeReconnect = useUiStore((s) => s.closeReconnect);
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) closeReconnect();
      }}
    >
      {/* Remount per target so a fresh flow (new session id, clean phase) starts
          for each open — and unmounts (cancelling its live session) on close. */}
      {target && (
        <ReconnectFlow
          key={`${target.provider}|${target.host}|${target.mode}|${(target.scopes ?? []).join(",")}`}
          provider={target.provider}
          host={target.host}
          mode={target.mode}
          scopes={target.scopes}
          onClose={closeReconnect}
        />
      )}
    </Dialog>
  );
}

function ReconnectFlow({
  provider,
  host,
  mode,
  scopes,
  onClose,
}: {
  provider: "github" | "gitlab";
  host: string;
  mode: "login" | "refresh";
  scopes?: string[];
  onClose: () => void;
}) {
  const label = providerLabel(provider);
  const isGitHub = provider === "github";
  const settings = useSettings();
  const repoPath = useUiStore((s) => s.repoPath);
  const invalidate = useInvalidateAfterReconnect();

  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  // The live session id, so every close path (and Try again) cancels the right
  // Rust flow. A ref because cleanup + the restart handler read the current id
  // without re-subscribing.
  const sessionIdRef = useRef<string | null>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const autoCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The copy-paste fallback must match the flow the dialog was driving, argv spelling
  // included: a GitHub "refresh" maps to `gh auth refresh` (preserves granted scopes,
  // plus one `-s` per requested scope), everything else to `auth login --web` (glab has
  // no `refresh` subcommand — login re-runs OAuth for it in both modes).
  // gh refreshes the host's ACTIVE account, so on a multi-account host the scopes land
  // wherever `gh auth switch` last pointed.
  // Null when the host fails the reconnect grammar, so a crafted remote host can't
  // put shell syntax into the copyable command (the in-app flow re-validates anyway).
  const fallbackCommand = !isReconnectHostSafe(host)
    ? null
    : isGitHub && mode === "refresh"
      ? `gh auth refresh --hostname ${host}${(scopes ?? []).map((s) => ` -s ${s}`).join("")}`
      : `${isGitHub ? "gh" : "glab"} auth login --hostname ${host} --web`;

  // Handle streamed events without re-subscribing the channel on every render:
  // useEffectEvent reads the latest closures (invalidate/settings) but stays
  // referentially stable, so the start effect below runs exactly once.
  const onEvent = useEffectEvent((event: ReconnectEvent) => {
    if (event.type === "code") {
      setPhase({ kind: "code", code: event.code, url: event.url });
    } else if (event.type === "line") {
      setPhase((p) =>
        p.kind === "lines"
          ? { kind: "lines", lines: [...p.lines, event.text] }
          : { kind: "lines", lines: [event.text] },
      );
    } else {
      // Terminal Rust-side: the flow's guard already unregistered its session, so null
      // the ref — otherwise the unmount cleanup and start()'s prior-cancel would cancel
      // an already-finished flow (which would re-seed a registry tombstone).
      sessionIdRef.current = null;
      setPhase({
        kind: "finished",
        ok: event.ok,
        login: event.login,
        message: event.message,
      });
      if (event.ok) {
        invalidate();
        toast.success(
          event.login ? `Connected as @${event.login}` : "Connected",
        );
        autoCloseRef.current = setTimeout(onClose, 1200);
      }
    }
  });

  // Start (or restart) a reconnect flow: mints a session id, opens the channel,
  // and resets to the starting phase. Cancels any prior live session first so a
  // "Try again" never leaves an orphaned CLI subprocess.
  const start = useEffectEvent(() => {
    const prior = sessionIdRef.current;
    if (prior) forgeReconnectCancel(prior).catch(() => undefined);
    if (autoCloseRef.current) clearTimeout(autoCloseRef.current);
    const sessionId = crypto.randomUUID();
    sessionIdRef.current = sessionId;
    setPhase({ kind: "starting" });
    forgeReconnect({
      sessionId,
      provider,
      host,
      mode,
      scopes,
      onEvent,
    }).catch((e) => {
      // A hard launch failure (CLI missing, spawn error) surfaces as a failed
      // finish so the fallbacks (terminal / copy command) are offered.
      if (sessionIdRef.current === sessionId) {
        setPhase({
          kind: "finished",
          ok: false,
          login: null,
          message: errorMessage(e),
        });
      }
    });
  });

  // Kick off once on mount; cancel the live session on unmount (every close path
  // unmounts this component — Esc/×/backdrop/cancel/Try-again-restart).
  useEffect(() => {
    start();
    return () => {
      if (autoCloseRef.current) clearTimeout(autoCloseRef.current);
      const id = sessionIdRef.current;
      if (id) forgeReconnectCancel(id).catch(() => undefined);
    };
  }, []);

  // Initial focus on the primary action once the code phase paints (gh); glab
  // has no primary until finished, so this is a no-op there.
  useEffect(() => {
    if (phase.kind === "code") primaryRef.current?.focus();
  }, [phase.kind]);

  const title = mode === "login" ? `Sign in to ${label}` : `Reconnect ${label}`;
  const showHost = host !== "github.com" && host !== "gitlab.com";

  function openTerminalFallback() {
    if (!repoPath) return;
    openInTerminal(
      repoPath,
      settings.data?.terminal,
      settings.data?.terminalPath,
      settings.data?.terminalCommand,
    ).catch(toastError);
  }

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {showHost && (
          <p className="font-mono text-xs text-muted-foreground">{host}</p>
        )}
      </DialogHeader>

      {phase.kind === "starting" && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner />
          <span>Starting {isGitHub ? "gh" : "glab"} sign-in…</span>
        </div>
      )}

      {phase.kind === "code" && (
        <div className="space-y-3">
          <p
            className="select-all text-center font-mono text-2xl tracking-[0.15em]"
            aria-label={`One-time code ${phase.code}`}
          >
            {phase.code}
          </p>
          <p className="text-center text-xs text-muted-foreground">
            Enter the code in your browser to finish signing in.
          </p>
          <div className="flex items-center justify-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => copyText(phase.code, "Code copied")}
            >
              Copy code
            </Button>
            <Button
              ref={primaryRef}
              size="sm"
              onClick={() => openUrl(phase.url).catch(toastError)}
            >
              <ArrowSquareOutIcon data-icon="inline-start" />
              Open {host}
            </Button>
          </div>
          <div
            className="flex items-center justify-center gap-2 text-xs text-muted-foreground"
            aria-live="polite"
          >
            <Spinner />
            <span>Waiting for approval…</span>
          </div>
        </div>
      )}

      {phase.kind === "lines" && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Follow the sign-in in your browser — glab opens it for you.
          </p>
          <div
            className="space-y-0.5 font-mono text-[11px] text-muted-foreground"
            aria-live="polite"
          >
            {phase.lines.slice(-3).map((line, i) => (
              // Progress lines have no stable id; the tail window is tiny and
              // append-only, so the position within the last-3 window plus the
              // line text is a stable-enough key.
              <p key={`${i}:${line}`} className="truncate">
                {line}
              </p>
            ))}
          </div>
        </div>
      )}

      {phase.kind === "finished" && phase.ok && (
        <p className="text-xs text-success">
          {phase.login ? `Connected as @${phase.login}` : "Connected"}
        </p>
      )}

      {phase.kind === "finished" && !phase.ok && (
        <div className="space-y-3 text-xs">
          <p className="text-destructive">
            {phase.message ?? "Sign-in didn't complete."}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={start}>
              Try again
            </Button>
            {repoPath && (
              <Button variant="ghost" size="sm" onClick={openTerminalFallback}>
                <TerminalIcon data-icon="inline-start" />
                Open terminal instead
              </Button>
            )}
          </div>
          {fallbackCommand && (
            <p className="text-muted-foreground">
              Or run{" "}
              <button
                type="button"
                className="cursor-pointer font-mono underline underline-offset-2"
                onClick={() => copyText(fallbackCommand, "Command copied")}
                title="Copy command"
              >
                {fallbackCommand}
              </button>{" "}
              in a terminal.
            </p>
          )}
        </div>
      )}
    </DialogContent>
  );
}
