export const EXIT_AGREE: 0;
export const EXIT_MISMATCH: 1;
export const EXIT_ERROR: 2;
/** `multiple: true` collects repeated string flags into an array (node:util
 * `parseArgs`). */
export type FlagSchema = Record<string, { type: "string" | "boolean"; multiple?: boolean }>;
export type FlagValues = Record<string, string | boolean | string[] | undefined>;
type FlagValue<D> = D extends { type: "boolean" } ? boolean : D extends { multiple: true } ? string[] : string;
/** The parsed record, typed by the declared schema (and still indexable by
 * an arbitrary name). */
export type FlagValuesOf<O extends FlagSchema> = { [K in keyof O]?: FlagValue<O[K]> } & FlagValues;
export function parseFlags<const O extends FlagSchema>(argv: string[], options: O): FlagValuesOf<O>;
export function parseCommand<const O extends FlagSchema>(
  argv: string[],
  options: O,
): { values: FlagValuesOf<O>; positionals: string[] };
/** Read one declared flag (with or without its `--` prefix); `fallback`
 * (default `null`) when absent. */
export function flag<V extends FlagValues, K extends keyof V & string, F = null>(
  values: V,
  name: K | `--${K}`,
  fallback?: F,
): Exclude<V[K], undefined> | F;
export function flag<F = null>(values: FlagValues, name: string, fallback?: F): string | boolean | string[] | F;
/** A single-valued string flag (or `fallback`), for helpers that take the
 * flag name as a runtime string. */
export function stringFlag(values: FlagValues, name: string, fallback?: string): string | undefined;
export function requiredFlag(values: FlagValues, name: string): string;
export function intFlag(values: FlagValues, name: string, minimum?: number): number;
export function shardFlag(values: FlagValues, name: string): { index: number; total: number } | null;
export function isMain(metaUrl: string, argv?: string[]): boolean;
export function runMain(main: () => number | void | Promise<number | void>): Promise<void>;
