import { installTransport, type Transport } from "@/lib/transport";

// The companion runs in a phone browser, NOT inside Tauri — there is no IPC
// bridge here. It reaches the desktop purely over HTTP (see `lib/api.ts`), so no
// data call routes through the transport seam in this slice.
//
// We still install a transport, though: any desktop module pulled in transitively
// (e.g. via a shared type file that also has runtime exports) may call
// `getTransport().invoke(...)` at import/eval time. Installing one that REJECTS
// LOUDLY means such a call fails with a clear message instead of throwing the
// opaque "No transport installed" error — or, worse, silently reaching for a
// Tauri global that doesn't exist. The rejection is shaped like the app's
// AppError so callers that inspect `.kind`/`.message` behave consistently.

const notAvailable = (cmd: string): Promise<never> =>
  Promise.reject({
    kind: "command",
    message: `Backend command "${cmd}" is not available on the phone companion — it talks to the desktop over HTTP, not the Tauri IPC bridge.`,
  });

const companionTransport: Transport = {
  invoke: (cmd) => notAvailable(cmd),
  invokeStreaming: (cmd) => notAvailable(cmd),
};

installTransport(companionTransport);
