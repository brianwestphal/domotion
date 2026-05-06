import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "#jsx",
  },
  resolve: {
    alias: {
      "#jsx/jsx-runtime": resolve(__dirname, "src/jsx-runtime.ts"),
      "#jsx/jsx-dev-runtime": resolve(__dirname, "src/jsx-runtime.ts"),
    },
  },
  test: {
    pool: "forks",
    testTimeout: 30_000,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/tests/output/**"],
  },
});
