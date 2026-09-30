/** TypeScript facade for the shared Node ESM command-line boundary. */
export {
  EXIT_AGREE,
  EXIT_MISMATCH,
  EXIT_ERROR,
  parseFlags,
  flag,
  requiredFlag,
  intFlag,
  shardFlag,
  isMain,
  runMain,
} from "./cli.mjs";
