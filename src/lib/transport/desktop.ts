import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { Transport } from "@/lib/transport";

/** The desktop transport: forwards straight to Tauri's IPC bridge. Errors pass
 *  through raw — the invoke() wrapper normalizes them to AppError. */
export const desktopTransport: Transport = {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    return tauriInvoke<T>(cmd, args);
  },
};
