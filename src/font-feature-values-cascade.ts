import { parseCssFontFamilyEntries } from "./font-family-stack.js";

export type FontFeatureValueCategory =
  | "annotation"
  | "ornaments"
  | "stylistic"
  | "swash"
  | "characterVariant"
  | "styleset";

export type FontFeatureValueTable = Partial<Record<
  FontFeatureValueCategory,
  Record<string, number[]>
>>;

/** Family names are normalized like Blink's case-folded storage keys. */
export type FontFeatureValueTables = Record<string, FontFeatureValueTable>;

/** Blink's implicit outer layer sorts above every explicit cascade layer. */
export const IMPLICIT_OUTER_LAYER_ORDER = 0xffff;

/**
 * One CSSOM rule after its owning layer has been assigned canonical postorder.
 *
 * `fontFamily` deliberately remains CSS text until this boundary so quoted
 * commas, escapes, and generic-looking literals all use the shared parser.
 */
export interface FontFeatureValueRuleRecord {
  fontFamily: string;
  layerOrder: number;
  table: FontFeatureValueTable;
}

interface PrioritizedAlias {
  layerOrder: number;
  values: number[];
}

/**
 * Mirror Blink `FontFeatureValuesStorage::FuseUpdate`.
 *
 * Alias keys are independent: definitions union across rules/categories, and
 * a collision is replaced only by a rule in an equal or higher-priority
 * layer. Equality is intentional because Blink visits rules in source order,
 * so the later declaration in one layer wins.
 */
export function fuseFontFeatureValueRules(
  records: readonly FontFeatureValueRuleRecord[],
): FontFeatureValueTables {
  const prioritized: Record<string, Partial<Record<
    FontFeatureValueCategory,
    Record<string, PrioritizedAlias>
  >>> = {};

  for (const record of records) {
    const families = parseCssFontFamilyEntries(record.fontFamily)
      .map((entry) => entry.name.toLowerCase());
    for (const family of families) {
      const familyTable = prioritized[family] ?? (prioritized[family] = {});
      for (const category of Object.keys(record.table) as FontFeatureValueCategory[]) {
        const aliases = record.table[category];
        if (aliases == null) continue;
        const categoryTable = familyTable[category] ?? (familyTable[category] = {});
        for (const [alias, values] of Object.entries(aliases)) {
          const existing = categoryTable[alias];
          if (existing == null || record.layerOrder >= existing.layerOrder) {
            categoryTable[alias] = {
              layerOrder: record.layerOrder,
              values: [...values],
            };
          }
        }
      }
    }
  }

  const fused: FontFeatureValueTables = {};
  for (const [family, familyTable] of Object.entries(prioritized)) {
    const output: FontFeatureValueTable = {};
    for (const category of Object.keys(familyTable) as FontFeatureValueCategory[]) {
      const aliases = familyTable[category];
      if (aliases == null) continue;
      output[category] = Object.fromEntries(
        Object.entries(aliases).map(([alias, value]) => [alias, [...value.values]]),
      );
    }
    fused[family] = output;
  }
  return fused;
}
