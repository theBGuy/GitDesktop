import { installTransport } from "@/lib/transport";
import { desktopTransport } from "@/lib/transport/desktop";

// Side-effect-only module: importing it installs the Tauri-backed transport.
// The app entry (main.tsx) imports this FIRST so the transport is in place
// before any other module can reach an invoke().
installTransport(desktopTransport);
