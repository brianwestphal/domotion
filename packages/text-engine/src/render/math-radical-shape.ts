import type { MathRadicalData } from "./open-type-math.js";

export interface MathRadicalGlyph {
  id: number;
  path: { commands: Array<{ command: string; args: number[] }> };
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  advanceWidth: number;
}

export interface MathRadicalShape {
  glyphs: Array<{ glyph: MathRadicalGlyph; offsetY: number }>;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  advanceWidth: number;
}

/** Blink tries ready-made variants by actual ink height, then assembles parts. */
export function selectMathRadicalShape(
  data: MathRadicalData,
  getGlyph: (id: number) => MathRadicalGlyph | null | undefined,
  targetUnits: number,
): MathRadicalShape | null {
  let largestVariant: MathRadicalGlyph | null = null;
  for (const record of data.variants) {
    const glyph = getGlyph(record.glyphId);
    if (glyph == null || glyph.path.commands.length === 0) continue;
    largestVariant = glyph;
    if (glyph.bbox.maxY - glyph.bbox.minY >= targetUnits) return oneGlyph(glyph);
  }
  const assembled = assemble(data, getGlyph, targetUnits);
  return assembled ?? (largestVariant == null ? null : oneGlyph(largestVariant));
}

function oneGlyph(glyph: MathRadicalGlyph): MathRadicalShape {
  return { glyphs: [{ glyph, offsetY: 0 }], bbox: glyph.bbox, advanceWidth: glyph.advanceWidth };
}

function assemble(
  data: MathRadicalData,
  getGlyph: (id: number) => MathRadicalGlyph | null | undefined,
  targetUnits: number,
): MathRadicalShape | null {
  if (data.assembly.length === 0) return null;
  type Part = (typeof data.assembly)[number];
  let parts: Part[] = [];
  let overlap = data.minConnectorOverlap;
  // Keep the same finite glyph-count bound as the shaping route. Very large
  // boxes fall back to the largest ready-made variant if they exceed it.
  for (let repetitions = 0; repetitions <= 512; repetitions++) {
    parts = data.assembly.flatMap((part) => (part.extender ? Array<Part>(repetitions).fill(part) : [part]));
    if (parts.length === 0 || parts.length > 1024) return null;
    const maxOverlap = Math.min(
      ...parts.slice(1).map((part, i) => Math.min(parts[i].endConnector, part.startConnector)),
    );
    if (parts.length > 1 && maxOverlap < data.minConnectorOverlap) return null;
    const fullAdvance = parts.reduce((sum, part) => sum + part.advance, 0);
    const maxSize = fullAdvance - data.minConnectorOverlap * (parts.length - 1);
    if (maxSize < targetUnits && repetitions < 512) continue;
    overlap =
      parts.length < 2
        ? 0
        : Math.max(data.minConnectorOverlap, Math.min(maxOverlap, (fullAdvance - targetUnits) / (parts.length - 1)));
    break;
  }

  const glyphs: MathRadicalShape["glyphs"] = [];
  let offsetY = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let advanceWidth = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const glyph = getGlyph(part.glyphId);
    if (glyph == null || glyph.path.commands.length === 0) return null;
    glyphs.push({ glyph, offsetY });
    minX = Math.min(minX, glyph.bbox.minX);
    minY = Math.min(minY, glyph.bbox.minY + offsetY);
    maxX = Math.max(maxX, glyph.bbox.maxX);
    maxY = Math.max(maxY, glyph.bbox.maxY + offsetY);
    advanceWidth = Math.max(advanceWidth, glyph.advanceWidth);
    if (i < parts.length - 1) offsetY += part.advance - overlap;
  }
  return { glyphs, bbox: { minX, minY, maxX, maxY }, advanceWidth };
}
