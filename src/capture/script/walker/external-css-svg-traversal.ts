import type { ExternalCssSvgJournal } from "../../external-css-svg.js";

/** Only the branches leading to a retained native CSS owner have a projected
 * child list. The ordinary walk keeps its own DOM children everywhere else. */
export function externalCssSvgJournal(key?: string): ExternalCssSvgJournal | undefined {
  return key == null ? undefined : ((globalThis as Record<string, unknown>)[key] as ExternalCssSvgJournal | undefined);
}
