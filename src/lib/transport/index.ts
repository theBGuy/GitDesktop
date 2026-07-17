/**
 * IPC transport seam. Every backend call funnels through the single invoke()
 * wrapper (@/lib/tauri/invoke), which delegates to whichever Transport is
 * installed here. The desktop app installs the Tauri-backed transport; a future
 * LAN-companion bundle can bind an HTTP transport, and tests can bind a mock —
 * all without touching any of the ~36 call sites that import invoke().
 */
export interface Transport {
  /** Invoke a backend command. Implementations reject with raw errors —
   *  normalization to AppError happens once, in the invoke() wrapper. */
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

let current: Transport | null = null;

/** Install the transport all invoke() calls route through. Installers are
 *  side-effect modules imported once at the app entry, before any invoke(). */
export function installTransport(t: Transport): void {
  if (import.meta.env.DEV && current)
    console.warn("[transport] replacing installed transport");
  current = t;
}

/** The installed transport. Throws if none is installed yet — a signal that an
 *  installer import is missing at the app entry. */
export function getTransport(): Transport {
  if (!current)
    throw new Error(
      "No transport installed — import an installer (e.g. @/lib/transport/install-desktop) at the app entry before any invoke().",
    );
  return current;
}
