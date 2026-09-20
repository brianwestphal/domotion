export const coverageConfig = {
  provider: "v8" as const,
  include: ["src/**/*.ts", "src/**/*.tsx"],
  exclude: [
    "**/*.test.ts",
    "**/*.test.tsx",
    "**/*.generated.ts",
    "src/capture/script/**",
    "src/test-support/**",
    "src/**/*.d.ts",
  ],
};
