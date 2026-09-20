import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ["transformed-module.fixture.ts"],
    coverage: {
      provider: "v8",
      include: ["transformed-module.ts"],
      reporter: ["json"],
    },
  },
});
