import { defineConfig } from "vitest/config";
import { e2eLaneConfig, resolveE2ELane } from "./tests/e2e-lanes.js";
import { coverageConfig } from "./vitest.coverage.js";

const lane = resolveE2ELane(process.env["DOMOTION_E2E_LANE"]);
const laneConfig = e2eLaneConfig(lane);

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
    // Browser files are much heavier than ordinary unit-test forks: most own
    // a Chromium process tree and several also rasterize every animation
    // state. The default command runs the ordinary files with two workers,
    // then the three measured heavy files alone with one worker. Direct config
    // use defaults to the complete suite at one worker. This keeps resource
    // contention from turning correctness and cleanup timeouts into flakes.
    maxWorkers: laneConfig.maxWorkers,
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
    include: laneConfig.include,
    exclude: laneConfig.exclude,
    // The merged all-suite report asks this lane for JSON only. Sharing the
    // unit lane's source boundary keeps the two Istanbul maps compatible.
    coverage: coverageConfig,
  },
});
