import { defineConfig } from "vitest/config";

// E2E-test config (DM-1075). Runs ONLY the browser-launching `*e2e.test.ts`
// files (Chromium-bound, slower, env-sensitive) — separate from the fast unit
// gate in vitest.config.ts. `npm run test:e2e`.
export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "kerfjs",
  },
  test: {
    pool: "forks",
    testTimeout: 60_000,
    include: ["src/**/*e2e.test.ts", "tests/**/*e2e.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/tests/output/**"],
  },
});
