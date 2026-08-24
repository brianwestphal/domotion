/**
 * Source-owned helpers for named `font-variant-alternates` values (doc 204).
 *
 * Blink resolves the author-facing aliases against the document's
 * `@font-feature-values` storage before it hands the resulting OpenType tags
 * to HarfBuzz.  The broad shaping corpus carries the storage in this compact
 * serializable form so its synthetic probe page can ask the same question.
 */
import { BufferFlag, ClusterLevel } from "../vendor/harfbuzzjs/dist/index.mjs";
import type {
  FontFeatureValueCategory,
  FontFeatureValueTable,
  FontFeatureValueTables,
} from "../src/font-feature-values-cascade.js";
import {
  harfbuzzShapeRun,
  registerHbBufferSource,
  type ShapeResult,
} from "../src/render/harfbuzz-shaper.js";
import { resolveFontVariantAlternates } from "../src/render/text.js";

export type {
  FontFeatureValueCategory,
  FontFeatureValueTable,
  FontFeatureValueTables,
} from "../src/font-feature-values-cascade.js";

const SUBRULE: Record<FontFeatureValueCategory, string> = {
  annotation: "annotation",
  ornaments: "ornaments",
  stylistic: "stylistic",
  swash: "swash",
  characterVariant: "character-variant",
  styleset: "styleset",
};

const CATEGORIES = Object.keys(SUBRULE) as FontFeatureValueCategory[];

function cssIdent(value: string): string {
  if (!/^-?[_a-zA-Z][_a-zA-Z0-9-]*$/.test(value)) {
    throw new Error(`font-feature-values alias is not a CSS identifier: ${value}`);
  }
  return value;
}

/**
 * Emit one deterministic effective rule per family.
 *
 * The extractor has already fused same-family author rules into the table.
 * Re-emitting that effective storage avoids carrying unrelated stylesheet
 * text while preserving the exact aliases and integer values Blink resolves.
 */
export function serializeFontFeatureValues(tables: FontFeatureValueTables | undefined): string {
  if (tables == null) return "";
  const rules: string[] = [];
  for (const family of Object.keys(tables).sort()) {
    const table = tables[family];
    const blocks: string[] = [];
    for (const category of CATEGORIES) {
      const aliases = table[category];
      if (aliases == null) continue;
      const declarations = Object.entries(aliases)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, values]) => `${cssIdent(name)}:${values.join(" ")};`)
        .join("");
      if (declarations !== "") blocks.push(`@${SUBRULE[category]}{${declarations}}`);
    }
    if (blocks.length > 0) rules.push(`@font-feature-values ${JSON.stringify(family)}{${blocks.join("")}}`);
  }
  return rules.join("");
}

/** The exact user-feature list Blink's alias resolver contributes. */
export function resolvedFeatureValueList(
  alternates: string | undefined,
  fontFamily: string,
  tables: FontFeatureValueTables | undefined,
): string[] {
  return resolveFontVariantAlternates(
    alternates,
    fontFamily,
    tables as Parameters<typeof resolveFontVariantAlternates>[2],
  ) ?? [];
}

export interface ExactFeatureValueGlyph {
  id: number;
  cluster: number;
  sourceSpan: [number, number];
  xAdvance: number;
  yAdvance: number;
  xOffset: number;
  yOffset: number;
  flags: number;
  unsafeToBreak: boolean;
}

export interface ExactFeatureValueRecord {
  text: string;
  features: string[];
  clusters: number[];
  glyphs: ExactFeatureValueGlyph[];
}

function sourceEnd(text: string, cluster: number, clusters: number[]): number {
  const later = clusters.filter((candidate) => candidate > cluster);
  return later.length > 0 ? Math.min(...later) : text.length;
}

function record(result: ShapeResult, text: string, features: string[]): ExactFeatureValueRecord {
  return {
    text,
    features: [...features],
    clusters: [...result.clusters],
    glyphs: result.glyphs.map((glyph, index) => ({
      id: glyph.id,
      cluster: result.clusters[index],
      sourceSpan: [
        result.clusters[index],
        sourceEnd(text, result.clusters[index], result.clusters),
      ],
      xAdvance: result.positions[index].xAdvance,
      yAdvance: result.positions[index].yAdvance,
      xOffset: result.positions[index].xOffset,
      yOffset: result.positions[index].yOffset,
      flags: result.glyphFlags[index],
      unsafeToBreak: (result.glyphFlags[index] & 1) !== 0,
    })),
  };
}

/**
 * Shape a retained webfont with Chromium's pinned HarfBuzz inputs and retain
 * the complete logical record. This is pre-raster and uses no tolerance.
 */
export function exactWebfontFeatureRecord(
  bytes: Uint8Array,
  text: string,
  features: string[],
  fontSizePx = 32,
  faceIndex = 0,
): ExactFeatureValueRecord {
  const result = harfbuzzShapeRun(
    registerHbBufferSource(bytes),
    faceIndex,
    text,
    "ltr",
    fontSizePx,
    null,
    features,
    {
      script: "Latn",
      language: "en",
      bufferFlags: BufferFlag.BOT | BufferFlag.EOT,
      clusterLevel: ClusterLevel.MONOTONE_CHARACTERS,
    },
  );
  if (result == null) throw new Error("font-feature-values fixture could not be shaped");
  return record(result, text, features);
}

export function exactFeatureValueSignature(value: ExactFeatureValueRecord): string {
  return JSON.stringify(value.glyphs.map((glyph) => [
    glyph.id,
    glyph.cluster,
    glyph.sourceSpan,
    glyph.xAdvance,
    glyph.yAdvance,
    glyph.xOffset,
    glyph.yOffset,
    glyph.flags,
  ]));
}
