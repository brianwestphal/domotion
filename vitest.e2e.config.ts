import { defineConfig } from "vitest/config";

// E2E-test config (DM-1075). Runs ONLY the browser-launching `*e2e.test.ts`
// files (Chromium-bound, slower, env-sensitive) — separate from the fast unit
// gate in vitest.config.ts. `npm run test:e2e`.
export default defineConfig({
  // Vite 8 (vitest 4) transforms with oxc, not esbuild — see vitest.config.ts.
  oxc: {
    jsx: {
      runtime: "automatic",
      importSource: "kerfjs",
    },
  },
  test: {
    pool: "forks",
    // Restore the product render mode after every browser test. Tests that
    // inspect paths-mode structure opt into it explicitly in their own scope.
    // The setup also closes the persistent native glyph helper after each file;
    // keep production transport enabled here (DM-2672), unlike the unit lane.
    setupFiles: ["./tests/e2e-setup.ts"],
    env: {
      DOMOTION_NO_OPEN: "1",
      // The review server otherwise invokes the platform default-browser
      // opener. Browser tests drive its URL with Playwright instead.
      REVIEW_NO_OPEN: "1",
    },
    testTimeout: 60_000,
    include: ["src/**/*e2e.test.ts", "tests/**/*e2e.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/tests/output/**"],
  },
});
