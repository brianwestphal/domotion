import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = resolve(packageRoot, "..", "..");

export default defineConfig({
  root: repositoryRoot,
  test: {
    pool: "forks",
    maxWorkers: 1,
    globalSetup: [resolve(packageRoot, "vitest.global.ts")],
    env: { DOMOTION_NO_OPEN: "1" },
    testTimeout: 30_000,
    include: ["packages/text-engine/src/render/helper-serve-switch.test.ts"],
  },
});
