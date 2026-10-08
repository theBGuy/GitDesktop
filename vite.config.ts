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
  selectors: string[];
  nodes: PostcssDecl[];
  remove: () => void;
}
interface PostcssRoot {
  source?: { input: { file?: string } };
  walkRules: (cb: (rule: PostcssRule) => void) => void;
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

// The same sheet carries a GitHub highlight.js theme (hex colors keyed on the
// wrapper's data-theme) that would out-color our --gd-syn-* token rules in
// code-highlight.css. Delete only rules whose every selector is a themed
// `.diff-line-syntax-raw .hljs*` selector and whose declarations are purely
// typographic; the layout rules (`pre code.hljs` padding) stay. Fails closed:
// any sheet's surviving hljs color/background that isn't a --gd-syn-* token
// fails the build, as does a vendor sheet missing either theme's strips.
const VENDOR_HLJS_SELECTOR =
  /^\.diff-tailwindcss-wrapper\[data-theme="(light|dark)"\] \.diff-line-syntax-raw \.hljs(?:-|$)/;
// The `styles/*` export resolves to `dist/css/*`.
const VENDOR_SHEET =
  /@git-diff-view\/react\/(?:dist\/css|styles)\/diff-view\.css(?:\?|$)/;
const VENDOR_HLJS_PROPS = new Set([
  "color",
  "background",
  "background-color",
  "font-style",
  "font-weight",
]);
const PAINT_PROPS = new Set(["color", "background", "background-color"]);
const stripDiffViewHljsTheme = {
  postcssPlugin: "gd-strip-diff-view-hljs-theme",
  Once(root: PostcssRoot) {
    const file = root.source?.input.file?.replaceAll("\\", "/") ?? "";
    const stripped = { light: 0, dark: 0 };
    root.walkRules((rule) => {
      const themes = rule.selectors.map(
        (s) => VENDOR_HLJS_SELECTOR.exec(s)?.[1],
      );
      const typographic = rule.nodes.every(
        (n) =>
          n.type === "comment" ||
          (n.type === "decl" && VENDOR_HLJS_PROPS.has(n.prop ?? "")),
      );
      if (themes.every((t) => t !== undefined) && typographic) {
        rule.remove();
        for (const t of new Set(themes)) stripped[t as "light" | "dark"]++;
      }
    });
    const leftovers: string[] = [];
    root.walkRules((rule) => {
      const hljsSelector = rule.selectors.some(
        (s) => s.includes(".diff-line-syntax-raw") && s.includes(".hljs"),
      );
      const painted = rule.nodes.some(
        (n) =>
          n.type === "decl" &&
          PAINT_PROPS.has(n.prop ?? "") &&
          !(n.value ?? "").trim().startsWith("var(--gd-syn-"),
      );
      if (hljsSelector && painted) leftovers.push(rule.selector);
    });
    const vendorShort =
      VENDOR_SHEET.test(file) && (stripped.light === 0 || stripped.dark === 0);
    if (leftovers.length > 0 || vendorShort) {
      throw new Error(
        `gd-strip-diff-view-hljs-theme: vendor hljs theme changed shape in ${file} (stripped light ${stripped.light} / dark ${stripped.dark}; unstripped: ${leftovers.join(" | ") || "none"}) — re-check the guard against diff-view.css`,
      );
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
  // adds our diff-view strippers (declared above) to the css pipeline that runs
  // in both dev and build.
  css: {
    postcss: {
      plugins: [stripDiffViewColorReset, stripDiffViewHljsTheme],
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
      // 3. ignore src-tauri & site (their own toolchains), tool dirs, and
      //    doc/config globs the dev server shouldn't reload on. **/*.md
      //    knowingly covers CHANGELOG.md (imported ?raw by WhatsNew) —
      //    accepted: it's edited at release time, not during dev.
      ignored: [
        "**/src-tauri/**",
        "**/site/**",
        "*.yml",
        "*.yaml",
        "**/*.md",
        "**/.github/**",
        "**/.claude/**",
        "**/.agents/**",
        "**/.impeccable/**",
        "**/.vscode/**",
        "**/design/**",
      ],
    },
  },
}));
