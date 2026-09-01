import { defineConfig } from "vitest/config";

// Unit-test config (DM-1075). The default `vitest run` (= `npm test`) runs the
// fast, browser-free unit suite — every `*.test.ts` EXCEPT the browser-launching
// `*e2e.test.ts` files, which run on their own lane via `npm run test:e2e`
// (vitest.e2e.config.ts). Keep the two in sync where they overlap (oxc/jsx,
// pool, timeout).
export default defineConfig({
  // Vite 8 (vitest 4) transforms with oxc, not esbuild — an `esbuild: { jsx }`
  // block here is silently ignored. oxc's own default importSource is "react",
  // so state kerf explicitly rather than leaning on tsconfig.json picking it up.
  oxc: {
    jsx: {
      runtime: "automatic",
      importSource: "kerfjs",
    },
  },
  test: {
    pool: "forks",
    // DM-2043: a persistent native-helper child is a good fit for long-lived
    // render/conformance processes, but not for Vitest's short-lived fork pool.
    // Each test-file fork starts and unrefs its own helper; Vitest then reaps
    // the fork outside Node's normal `exit` cleanup, and on macOS the aggregate
    // run is eventually killed (exit 144) without a test summary. The one-shot
    // transport returns the same answers and gives every helper the same
    // lifetime as its request. `helper-serve-switch.test.ts` deliberately
    // removes this variable for its focused persistent-channel coverage.
    env: {
      DOMOTION_HELPER_NO_SERVE: "1",
      // Defense in depth: even a test that spawns a server-backed CLI without
      // its `--no-open` flag must not launch the user's desktop browser.
      DOMOTION_NO_OPEN: "1",
    },
    testTimeout: 30_000,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/tests/output/**",
      // In-repo agent worktrees. `git worktree add` under `.claude/worktrees/`
      // puts a FULL second checkout inside the repo root, so the `src/**` and
      // `tests/**` globs above match every test file in every worktree as well
      // as our own. Measured: 25 worktrees, 8,261 stray test files, and the
      // run died ~10s in with a bare exit 144 and no summary — the same commit
      // passing 3,369 tests when run from inside a worktree (which has no
      // nested worktrees of its own) and dying from the main checkout is what
      // isolated it. This mirrors `eslint.config.js`, which already lists the
      // same path for the same reason: neither tool reads `.gitignore`.
      "**/.claude/worktrees/**",
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
