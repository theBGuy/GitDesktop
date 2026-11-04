import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

// Merges the app's Vite config rather than restating its plugins, so the React
// Compiler preset the app ships with also compiles the code under test.
export default defineConfig(async (env) =>
  mergeConfig(await viteConfig(env), {
    test: {
      include: ["src/test/**/*.test.{ts,tsx}"],
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      globals: false,
      // Calls reset per test; suites re-apply implementations in beforeEach.
      clearMocks: true,
    },
  }),
);
