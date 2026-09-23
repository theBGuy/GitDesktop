import { ArrowSquareOutIcon, TerminalIcon } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { CopyIconButton } from "@/components/CopyIconButton";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { clipTitleFromText } from "@/lib/clip-title";
import { copyText } from "@/lib/clipboard";
import {
  forgeReconnect,
  forgeReconnectCancel,
  openInTerminal,
} from "@/lib/git/api";
import { isReconnectHostSafe, reconnectHostArg } from "@/lib/git/host";
import { useInvalidateAfterReconnect } from "@/lib/git/queries";
import { providerLabel, type ReconnectEvent } from "@/lib/git/types";
import { useSettings } from "@/lib/settings/queries";
import { type ReconnectTarget, useUiStore } from "@/lib/stores/ui";
import { errorMessage } from "@/lib/tauri/invoke";
import { toastError } from "@/lib/toast";

/** The distinct phases the reconnect flow drives through, from the streamed
 *  `ReconnectEvent`s. `starting` is the pre-event state; `progress` is CLI output with
 *  no verification URL yet; `verify` holds the URL (and the one-time code once the
 *  CLI's wording is recognised); `finished` is terminal. Progress lines live in their
 *  own state, so a late one can never displace the verification the user is acting on.
 *  `kind` stays `"verify"` across the code upgrade — the initial-focus effect keys on
 *  it, and must not pull focus back once the user has tabbed on. */
type Phase =
  | { kind: "starting" }
  | { kind: "progress" }
  | { kind: "verify"; code: string | null; url: string }
  | {
      kind: "finished";
      ok: boolean;
      login: string | null;
      message: string | null;
    };

/** Derived from the store's target so the dialog can't drift from what opens it. */
type ReconnectProvider = ReconnectTarget["provider"];

/** The heading over the raw CLI output, before any verification URL is known. */
const PROGRESS_COPY: Record<ReconnectProvider, string> = {
  github: "Waiting on gh…",
  gitlab: "glab is opening your browser.",
};

/** The instruction above the verification link once a one-time code is in hand. */
const VERIFY_WITH_CODE_COPY: Record<ReconnectProvider, string> = {
  github: "Enter this code in your browser to finish signing in.",
  gitlab: "Finish signing in on GitLab.",
};

/** The caption over the CLI's own output when no code was parsed. */
const LINES_LABEL: Record<ReconnectProvider, string> = {
  github: "What gh reported",
  gitlab: "What glab reported",
};

/** Trailing progress lines kept on screen while the flow is still talking. */
const PROGRESS_TAIL = 3;

/** The window for the code-null fallback, where the CLI's raw output is the only
 *  place an unrecognised one-time code can be read: a wording that prints the code
 *  and then keeps talking must not scroll it away. */
const UNPARSED_OUTPUT_TAIL = 8;

/**
 * The global one-click reconnect dialog for a dead (or new) gh/glab session.
 * Opened from anywhere via the ui store's `reconnectTarget`; mounted once next to
 * the other global dialogs in `App`. Drives GitHub's device flow and GitLab's `--web`
 * flow in-app, so a user never has to drop to a terminal. Whatever the CLI's wording,
 * the verification link itself is shown, copyable, and openable. Every close path
 * cancels the live Rust flow.
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
  provider: ReconnectProvider;
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
  // Progress output is its own state, never a phase: a line arriving after the
  // verification URL must not wipe the code or link the user is acting on.
  const [lines, setLines] = useState<string[]>([]);
  // The live session id, so every close path (and Try again) cancels the right
  // Rust flow. A ref because cleanup + the restart handler read the current id
  // without re-subscribing.
  const sessionIdRef = useRef<string | null>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const autoCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The `<session id>|<url>` we already auto-opened. Keyed on both because the device
  // URL is a constant per host: a url-only latch would suppress the re-open on every
  // "Try again". Latched on the ATTEMPT — a failed open toasts once and leaves the
  // always-visible button as the retry, rather than re-firing on the code upgrade.
  const autoOpenedRef = useRef<string | null>(null);
  const linesLabelId = useId();

  const hostArg = reconnectHostArg(host);
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
      ? `gh auth refresh --hostname ${hostArg}${(scopes ?? []).map((s) => ` -s ${s}`).join("")}`
      : `${isGitHub ? "gh" : "glab"} auth login --hostname ${hostArg} --web`;

  // Handle streamed events without re-subscribing the channel on every render:
  // useEffectEvent keeps the reads (invalidate/onClose) fresh without being a
  // dependency — the start effect's own deps are what make it run exactly once.
  const onEvent = useEffectEvent((event: ReconnectEvent) => {
    if (event.type === "code") {
      setPhase({ kind: "verify", code: event.code, url: event.url });
      // gh's non-interactive device flow never opens a browser itself, so open it
      // here. glab opens its own (and its authorize URL carries a single-use
      // localhost callback), so a second tab there would race the first.
      // https only: the row below deliberately shows and copies `http://` too (a
      // self-managed host's own choice), but an UNCLICKED open never follows a
      // cleartext URL — every GitHub-family device URL is https.
      if (isGitHub && event.url.startsWith("https://")) {
        const attempt = `${sessionIdRef.current}|${event.url}`;
        if (autoOpenedRef.current !== attempt) {
          autoOpenedRef.current = attempt;
          openUrl(event.url).catch(toastError);
        }
      }
    } else if (event.type === "line") {
      // Capped at the largest window any view renders: a 900s flow can stream far
      // more than that, and nothing reads past the tail.
      setLines((prev) =>
        [...prev, event.text].slice(
          -Math.max(PROGRESS_TAIL, UNPARSED_OUTPUT_TAIL),
        ),
      );
      setPhase((p) => (p.kind === "starting" ? { kind: "progress" } : p));
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
    setLines([]);
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

  // Initial focus on the primary action once the verify phase paints. Keyed on `kind`
  // alone: the code arriving after a URL-only event keeps the phase `verify`, so this
  // doesn't re-fire and steal focus from a user already on the copy button.
  useEffect(() => {
    if (phase.kind === "verify") primaryRef.current?.focus();
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

      {phase.kind === "verify" && (
        <div className="min-w-0 space-y-3">
          {phase.code !== null && (
            <p
              className="select-all text-center font-mono text-2xl tracking-[0.15em]"
              aria-label={`One-time code ${phase.code}`}
            >
              {phase.code}
            </p>
          )}
          <p className="text-center text-xs text-muted-foreground">
            {phase.code !== null
              ? VERIFY_WITH_CODE_COPY[provider]
              : "Open this page to finish signing in."}
          </p>
          <div className="flex items-center gap-2 text-xs">
            <code
              className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-1 font-mono"
              onMouseEnter={clipTitleFromText}
            >
              {phase.url}
            </code>
            <CopyIconButton
              text={phase.url}
              label="Copy link"
              toast="Link copied"
            />
          </div>
          <div className="flex items-center justify-center gap-2">
            {phase.code !== null && <CopyCodeButton code={phase.code} />}
            <Button
              ref={primaryRef}
              size="sm"
              onClick={() => openUrl(phase.url).catch(toastError)}
            >
              <ArrowSquareOutIcon data-icon="inline-start" />
              Open {host}
            </Button>
          </div>
          {phase.code === null && lines.length > 0 && (
            <div className="space-y-1">
              <p id={linesLabelId} className="text-xs text-muted-foreground">
                {LINES_LABEL[provider]}
              </p>
              <ProgressLines
                lines={lines}
                tail={UNPARSED_OUTPUT_TAIL}
                labelledBy={linesLabelId}
                live="off"
              />
            </div>
          )}
          <div
            className="flex items-center justify-center gap-2 text-xs text-muted-foreground"
            aria-live="polite"
          >
            <Spinner />
            <span>Waiting for approval…</span>
          </div>
        </div>
      )}

      {phase.kind === "progress" && (
        <div className="min-w-0 space-y-2">
          <p className="text-xs text-muted-foreground">
            {PROGRESS_COPY[provider]}
          </p>
          <ProgressLines
            lines={lines}
            tail={PROGRESS_TAIL}
            label="CLI output"
            live="polite"
          />
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

/** Its own component so the narrowed non-null code reaches the click handler — a
 *  property narrowed in JSX widens again inside a closure. */
function CopyCodeButton({ code }: { code: string }) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => copyText(code, "Code copied")}
    >
      Copy code
    </Button>
  );
}

/** The tail of the CLI's own output. Deliberately wraps rather than truncating: this
 *  is the only place the user can read what the CLI actually said. Height-capped,
 *  scrollable, and pinned to the newest line because `DialogContent` neither caps nor
 *  scrolls — a few 300-char lines at this size would push the centered dialog
 *  off-viewport. Every call site names the region (`label` or `labelledBy`) and picks
 *  `live`. */
function ProgressLines({
  lines,
  tail,
  live,
  label,
  labelledBy,
}: {
  lines: string[];
  tail: number;
  /** `"off"` where the code and link above are the actionable content: a tall polite
   *  region re-announces the whole block on every arriving line. */
  live: "polite" | "off";
  label?: string;
  labelledBy?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Re-pin per line: this region appends live, and an overflowing one renders scrolled
  // to the top, hiding the newest output — the whole point of showing it. Reading
  // `lines` is what makes the dependency real; a mount-only pin would go stale.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && lines.length > 0) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <div
      ref={scrollRef}
      className="max-h-40 space-y-0.5 overflow-y-auto break-words font-mono text-[11px] text-muted-foreground"
      role="group"
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-live={live}
      // A scrollable region has to be reachable without a pointer.
      tabIndex={0}
    >
      {lines.slice(-tail).map((line, i) => (
        // Progress lines have no stable id; the tail window is tiny and append-only,
        // so the position within it plus the line text is a stable-enough key.
        <p key={`${i}:${line}`}>{line}</p>
      ))}
    </div>
  );
}
