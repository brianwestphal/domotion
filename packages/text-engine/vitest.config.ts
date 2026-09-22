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
      DOMOTION_NO_OPEN: "1",
    },
    testTimeout: 30_000,
    include: ["packages/text-engine/src/**/*.test.ts"],
    exclude: ["**/dist/**", "**/tools/**/build/**", "**/helper-serve-switch.test.ts"],
  },
});
