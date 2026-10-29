/** TypeScript facade for the shared Node ESM command-line boundary. */
export {
  EXIT_AGREE,
  EXIT_MISMATCH,
  EXIT_ERROR,
  parseFlags,
  parseCommand,
  flag,
  stringFlag,
  requiredFlag,
  intFlag,
  shardFlag,
  isMain,
  runMain,
} from "./cli.mjs";
export type { FlagSchema, FlagValues, FlagValuesOf } from "./cli.mjs";
