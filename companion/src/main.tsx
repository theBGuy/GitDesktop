// Position is load-bearing (mirrors the desktop's main.tsx): the transport must
// be installed before any other module's evaluation can reach an invoke(). This
// installs the companion's REJECTING transport — the phone talks to the desktop
// over HTTP, never the Tauri IPC bridge — so this import stays FIRST.
import "./transport";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { queryClient } from "./lib/queries";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
