import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repositoryRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

export default defineConfig({
  root: repositoryRoot,
  test: {
    pool: "forks",
    globalSetup: [resolve(fileURLToPath(new URL(".", import.meta.url)), "vitest.global.ts")],
    env: {
      DOMOTION_HELPER_NO_SERVE: "1",
      // Bound each one-shot helper process below the 30 s test timeout. A
      // stalled spawnSync blocks the worker's event loop, so at the 120 s
      // default Vitest could only report its own timeout, after the fact.
      // The transport retries a stall once, so the worst case is 2 × 10 s.
      DOMOTION_HELPER_ONE_SHOT_TIMEOUT_MS: "10000",
      DOMOTION_NO_OPEN: "1",
    },
    testTimeout: 30_000,
    // Keep hooks on the same budget as tests (Vitest's hook default is 10 s).
    hookTimeout: 30_000,
    include: ["packages/text-engine/src/**/*.test.ts"],
    exclude: ["**/dist/**", "**/tools/**/build/**", "**/helper-serve-switch.test.ts"],
  },
});
