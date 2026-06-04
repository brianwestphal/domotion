import { defineConfig } from "vitest/config";

// Unit-test config (DM-1075). The default `vitest run` (= `npm test`) runs the
// fast, browser-free unit suite — every `*.test.ts` EXCEPT the browser-launching
// `*e2e.test.ts` files, which run on their own lane via `npm run test:e2e`
// (vitest.e2e.config.ts). Keep the two in sync where they overlap (esbuild/jsx,
// pool, timeout).
export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "kerfjs",
  },
  test: {
    pool: "forks",
    testTimeout: 30_000,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/tests/output/**",
      // Browser-launching e2e tests run via `npm run test:e2e` (Chromium-bound,
      // slower, env-sensitive) — kept out of the fast unit gate.
      "**/*e2e.test.ts",
    ],
    coverage: {
      provider: "v8",
      // Coverage reflects the unit suite (the fast gate). Generated bundles, the
      // page-eval CAPTURE_SCRIPT subtree (untyped, can't be instrumented here),
      // test-only support, and the test files themselves don't count.
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.generated.ts",
        "src/capture/script/**",
        "src/test-support/**",
        "src/**/*.d.ts",
      ],
      reporter: ["text-summary", "html"],
    },
  },
});
