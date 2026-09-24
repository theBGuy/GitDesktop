// Lets a `node --test` suite import `src/` modules that plain type stripping
// cannot load: Vite's `@/` alias and extensionless relative imports resolve to
// real files, and `import.meta.env` (which Vite injects at build time) exists.
//
// In-thread `module.registerHooks` only reach imports that start AFTER
// `installSrcHooks()` runs, and an ESM file links its whole static graph before
// its first line executes, so a suite must reach every aliased module through
// a dynamic `import()`. Stdlib-only, so it loads in the no-install guards job.
import { statSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC_ROOT = path.join(REPO_ROOT, "src");
const ROOT_PACKAGE_URL = pathToFileURL(
  path.join(REPO_ROOT, "package.json"),
).href;

const HAS_SCRIPT_EXT = /\.[cm]?[jt]sx?$/;
const URL_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/;
// No trailing newline: sharing line 1 keeps every stack-trace line number true
// (only line-1 columns shift).
const ENV_SHIM =
  'import.meta.env ??= { DEV: false, PROD: true, MODE: "test" };';

/** The first file Vite would pick for an extensionless base path. The exact
 *  path comes last so an already-extensioned `@/` specifier still resolves. */
function firstExisting(base) {
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    base,
  ]) {
    // Any stat error means not-a-file: POSIX answers ENOTDIR for a path through
    // a regular file (the `/index.ts` candidate of an extensioned specifier).
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

function isBare(specifier) {
  return (
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !URL_SCHEME.test(specifier)
  );
}

/** @returns {{ deregister(): void }} */
export function installSrcHooks() {
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      let base = null;
      if (specifier.startsWith("@/")) {
        base = path.join(SRC_ROOT, specifier.slice(2));
      } else if (
        (specifier.startsWith("./") || specifier.startsWith("../")) &&
        context.parentURL?.includes("/src/") &&
        !HAS_SCRIPT_EXT.test(specifier)
      ) {
        base = fileURLToPath(new URL(specifier, context.parentURL));
      }
      if (base) {
        const file = firstExisting(base);
        if (file) return next(pathToFileURL(file).href, context);
      }
      // Packages resolve from the repo root wherever the importer lives (a
      // suite's temp-dir copy of a src module has no node_modules above it).
      // Importers inside node_modules keep their own parent: pnpm links their
      // transitive deps beside them, not at the root.
      if (isBare(specifier) && !context.parentURL?.includes("/node_modules/")) {
        return next(specifier, { ...context, parentURL: ROOT_PACKAGE_URL });
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      // registerHooks load hooks are SYNCHRONOUS: next() returns the result
      // object; module.register()'s nextLoad is the async one.
      const out = next(url, context);
      if (!url.includes("/src/") || !/\.tsx?$/.test(url) || !out.source) {
        return out;
      }
      const text =
        typeof out.source === "string"
          ? out.source
          : new TextDecoder().decode(out.source);
      return { ...out, source: ENV_SHIM + text };
    },
  });
  return { deregister: () => hooks.deregister() };
}
