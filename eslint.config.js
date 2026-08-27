import kerfjs from "eslint-plugin-kerfjs";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "tests/output/**",
      "tests/cache/**",
      "external/**",
      "src/capture/script.generated.ts",
      // Native-helper CMake build dirs (git-ignored, but ESLint flat config
      // doesn't read nested .gitignore). They hold compiler artifacts like
      // `compiler_depend.ts` that aren't real TypeScript.
      "tools/**/build/**",

      // Everything below is git-ignored but was NOT ESLint-ignored, and ESLint
      // flat config does not read .gitignore. That gap made `npm run lint` a
      // very different command on a working dev machine than in a fresh CI
      // checkout — measured on the maintainer's Mac, a full run covered ~7,400
      // files against 864 in a clean tree, and reported errors sourced entirely
      // from throwaway scratch code and from OTHER commits checked out in
      // sibling worktrees. A CI gate that is green while the same command is
      // unusable locally trains people to stop running it, so the ignore list
      // has to make the two agree.
      //
      // Throwaway probe scripts (the "put scratch probes here" convention).
      // ~430 lintable files locally, none of them project code.
      "tools/scratch/**",
      // Ad-hoc debug scripts from earlier sessions; same category as scratch.
      ".tmp/**",
      // Agent git worktrees live INSIDE the repo, so `eslint .` descends into
      // full second copies of the project — ~6,000 lintable files across ~6
      // checkouts, each pinned to a different commit. Linting them reports
      // problems from code that is not even checked out here.
      ".claude/worktrees/**",
      // Shared Chromium source/build mount used by parity evidence collectors.
      ".chromium-build/**",
      // Container-run artifacts redirected out of tests/output.
      "tests/output-*/**",
      // Vendored third-party build output (committed, but not our code, and
      // regenerated from HarfBuzz rather than hand-edited).
      "vendor/**",
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
