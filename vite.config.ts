import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

// Minimal structural shapes for the postcss Rule/Declaration nodes we inspect —
// `postcss` is a transitive dep (no direct types exposed to tsc), and the plugin
// only touches these fields, so we avoid adding a dependency just for the type.
interface PostcssDecl {
  type: string;
  prop?: string;
  value?: string;
}
interface PostcssRule {
  selector: string;
  nodes: PostcssDecl[];
  remove: () => void;
}

// @git-diff-view ships `.diff-line-extend-wrapper * { color: initial }` (and the
// widget-wrapper twin). Unlayered and imported last, those two rules beat every
// layered Tailwind utility and flatten our slot content (composers, draft cards,
// thread anchors) to black — `initial` = CanvasText since we declare no
// color-scheme. Deleting JUST these rules restores natural inheritance and lets
// our utilities apply, without disturbing any other library behavior (its "+"
// button etc. depend on the sheet winning ties on its own markup, so the sheet
// itself must stay unlayered and last — do NOT wrap it in a cascade layer).
const stripDiffViewColorReset = {
  postcssPlugin: "gd-strip-diff-view-color-reset",
  Rule(rule: PostcssRule) {
    if (
      (rule.selector === ".diff-line-extend-wrapper *" ||
        rule.selector === ".diff-line-widget-wrapper *") &&
      rule.nodes.length === 1 &&
      rule.nodes[0].type === "decl" &&
      rule.nodes[0].prop === "color" &&
      rule.nodes[0].value === "initial"
    ) {
      rule.remove();
    }
  },
};

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    react(),
    tailwindcss(),
    babel({ presets: [reactCompilerPreset()] }),
  ],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  // Tailwind v4 rides its own vite plugin (`tailwindcss()` above), not the
  // postcss config, so this postcss plugin list is purely additive — it only
  // adds our diff-view color-reset stripper (declared above) to the css
  // pipeline that runs in both dev and build.
  css: {
    postcss: {
      plugins: [stripDiffViewColorReset],
    },
  },

  // Pre-bundle the Shiki diff highlighter and the grammar bundles it imports by
  // subpath, so the dev server resolves them up front (a subpath import added
  // after the server is running otherwise fails until a restart).
  optimizeDeps: {
    include: [
      "@shikijs/langs/astro",
      "@shikijs/langs/gdscript",
      "@shikijs/langs/hcl",
      "@shikijs/langs/json",
      "@shikijs/langs/jsonnet",
      "@shikijs/langs/jsx",
      "@shikijs/langs/prisma",
      "@shikijs/langs/solidity",
      "@shikijs/langs/svelte",
      "@shikijs/langs/terraform",
      "@shikijs/langs/toml",
      "@shikijs/langs/tsx",
      "@shikijs/langs/vue",
      "@shikijs/langs/wgsl",
      "@shikijs/langs/zig",
    ],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri` & `site` since we don't want to trigger reloads when those files change
      ignored: [
        "**/src-tauri/**",
        "**/site/**",
        "*.md",
        "*.yml",
        "*.yaml",
        "**/.github/**",
        "**/.claude/**",
        "**/.agents/**",
        "**/.impeccable/**",
        "**/.vscode/**"
      ],
    },
  },
}));
