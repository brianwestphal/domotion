import kerfjs from "eslint-plugin-kerfjs";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "tests/output/**",
      "tests/cache/**",
      "external/**",
      "src/capture/script.generated.ts",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  kerfjs.configs.recommended,
];
