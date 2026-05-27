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
      // Native-helper CMake build dirs (git-ignored, but ESLint flat config
      // doesn't read nested .gitignore). They hold compiler artifacts like
      // `compiler_depend.ts` that aren't real TypeScript.
      "tools/**/build/**",
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
