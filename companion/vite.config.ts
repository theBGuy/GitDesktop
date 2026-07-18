import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The phone companion is a SEPARATE Vite app from the desktop frontend: its own
// root (this dir), its own entry (`src/main.tsx`), and its own bundle served by
// the desktop's LAN server. It shares the desktop's TYPES via the `@` alias
// (type-only imports — see `src/lib/api.ts`) but none of its runtime code.
//
// Deliberately minimal vs. the root config: no React Compiler / babel pass (this
// is a small hand-tuned app, not the desktop's hot path), and NO css-inlining
// plugins — the LAN server serves this under a strict `script-src 'self';
// style-src 'self'` CSP, so every script/style must load from a built file.
// Vite's default production output (external hashed .js/.css) complies.
// `tailwindcss()` IS required (Tailwind v4 rides its own Vite plugin, not
// postcss) — without it the `@theme`/`@custom-variant`/utilities in index.css
// pass through un-compiled and every utility class is a no-op.
export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "../src"),
    },
  },
  build: {
    // The desktop LAN server serves the bundle from here (assets under
    // `/assets/`). The sibling package creates this dir with a `.gitkeep`.
    outDir: path.resolve(__dirname, "../src-tauri/companion-dist"),
    // Clears the dir before each build (drops the tracked `.gitkeep` from the
    // WORKING TREE, which is harmless — git still tracks it, so `git checkout`
    // restores it; a stale bundle would otherwise linger between builds).
    emptyOutDir: true,
  },
});
