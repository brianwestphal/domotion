export const EXIT_AGREE: 0;
export const EXIT_MISMATCH: 1;
export const EXIT_ERROR: 2;
export type FlagSchema = Record<string, { type: "string" | "boolean" }>;
export function parseFlags(argv: string[], options: FlagSchema): Record<string, string | boolean | undefined>;
export function parseCommand(
  argv: string[],
  options: FlagSchema,
): { values: Record<string, string | boolean | undefined>; positionals: string[] };
export function flag<T extends string | boolean | null>(
  values: Record<string, string | boolean | undefined>,
  name: string,
  fallback?: T,
): string | boolean | T;
export function requiredFlag(values: Record<string, string | boolean | undefined>, name: string): string;
export function intFlag(values: Record<string, string | boolean | undefined>, name: string, minimum?: number): number;
export function shardFlag(
  values: Record<string, string | boolean | undefined>,
  name: string,
): { index: number; total: number } | null;
export function isMain(metaUrl: string, argv?: string[]): boolean;
export function runMain(main: () => number | void | Promise<number | void>): Promise<void>;
