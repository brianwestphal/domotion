/** The MATH fields used to paint a radical with Blink's font-owned geometry. */
export interface MathRadicalData {
  verticalGap: number;
  displayStyleVerticalGap: number;
  ruleThickness: number;
  extraAscender: number;
  variants: Array<{ glyphId: number; advance: number }>;
  assembly: Array<{
    glyphId: number;
    startConnector: number;
    endConnector: number;
    advance: number;
    extender: boolean;
  }>;
  minConnectorOverlap: number;
}

interface RawMathFont {
  directory?: { tables?: Record<string, unknown> };
  stream?: { buffer?: Uint8Array };
}

/**
 * Fontkit leaves MATH opaque. Read only the four radical MathValueRecords and
 * the vertical MathGlyphConstruction for U+221A from the original SFNT bytes.
 * Every offset is checked against the table record before dereferencing.
 */
export function readMathRadicalData(font: RawMathFont, radicalGlyphId: number): MathRadicalData | null {
  const record = font.directory?.tables?.MATH as { offset?: number; length?: number } | undefined;
  const bytes = font.stream?.buffer;
  if (record?.offset == null || record.length == null || bytes == null) return null;
  if (!Number.isSafeInteger(record.offset) || !Number.isSafeInteger(record.length)) return null;
  const start = record.offset;
  const end = start + record.length;
  if (start < 0 || record.length < 10 || end > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const within = (at: number, size: number) => Number.isSafeInteger(at) && at >= start && at + size <= end;
  const u16 = (at: number) => (within(at, 2) ? view.getUint16(at, false) : null);
  const i16 = (at: number) => (within(at, 2) ? view.getInt16(at, false) : null);
  if (u16(start) !== 1 || u16(start + 2) !== 0) return null;

  const constantsOffset = u16(start + 4);
  const variantsOffset = u16(start + 8);
  if (constantsOffset == null || constantsOffset === 0 || variantsOffset == null || variantsOffset === 0) return null;
  const constants = start + constantsOffset;
  // MathConstants starts with four two-byte scalars, then four-byte MathValueRecords.
  // RadicalVerticalGap / DisplayStyleVerticalGap / RuleThickness / ExtraAscender
  // are records 45–48 in OpenType 1.9.1.
  const verticalGap = i16(constants + 8 + 45 * 4);
  const displayStyleVerticalGap = i16(constants + 8 + 46 * 4);
  const ruleThickness = i16(constants + 8 + 47 * 4);
  const extraAscender = i16(constants + 8 + 48 * 4);
  if (verticalGap == null || displayStyleVerticalGap == null || ruleThickness == null || extraAscender == null)
    return null;

  const variantsTable = start + variantsOffset;
  const minConnectorOverlap = u16(variantsTable);
  const coverageOffset = u16(variantsTable + 2);
  const verticalCount = u16(variantsTable + 6);
  if (minConnectorOverlap == null || coverageOffset == null || verticalCount == null) return null;
  if (!within(variantsTable + 10, verticalCount * 2)) return null;

  let coverageIndex = -1;
  if (coverageOffset !== 0) {
    const coverage = variantsTable + coverageOffset;
    const format = u16(coverage);
    const count = u16(coverage + 2);
    if (count == null) return null;
    if (format === 1) {
      if (!within(coverage + 4, count * 2)) return null;
      for (let i = 0; i < count; i++) {
        if (u16(coverage + 4 + i * 2) === radicalGlyphId) {
          coverageIndex = i;
          break;
        }
      }
    } else if (format === 2) {
      if (!within(coverage + 4, count * 6)) return null;
      for (let i = 0; i < count; i++) {
        const range = coverage + 4 + i * 6;
        const first = u16(range)!;
        const last = u16(range + 2)!;
        if (radicalGlyphId >= first && radicalGlyphId <= last) {
          coverageIndex = u16(range + 4)! + radicalGlyphId - first;
          break;
        }
      }
    } else return null;
  }
  if (coverageIndex < 0 || coverageIndex >= verticalCount) {
    return {
      verticalGap,
      displayStyleVerticalGap,
      ruleThickness,
      extraAscender,
      variants: [],
      assembly: [],
      minConnectorOverlap,
    };
  }

  const constructionOffset = u16(variantsTable + 10 + coverageIndex * 2);
  if (constructionOffset == null || constructionOffset === 0) return null;
  const construction = variantsTable + constructionOffset;
  const assemblyOffset = u16(construction);
  const variantCount = u16(construction + 2);
  if (assemblyOffset == null || variantCount == null || !within(construction + 4, variantCount * 4)) return null;
  const variants: MathRadicalData["variants"] = [];
  for (let i = 0; i < variantCount; i++) {
    variants.push({ glyphId: u16(construction + 4 + i * 4)!, advance: u16(construction + 6 + i * 4)! });
  }

  const assembly: MathRadicalData["assembly"] = [];
  if (assemblyOffset !== 0) {
    const assemblyTable = construction + assemblyOffset;
    const partCount = u16(assemblyTable + 4);
    if (partCount == null || !within(assemblyTable + 6, partCount * 10)) return null;
    for (let i = 0; i < partCount; i++) {
      const part = assemblyTable + 6 + i * 10;
      assembly.push({
        glyphId: u16(part)!,
        startConnector: u16(part + 2)!,
        endConnector: u16(part + 4)!,
        advance: u16(part + 6)!,
        extender: (u16(part + 8)! & 1) !== 0,
      });
    }
  }
  return {
    verticalGap,
    displayStyleVerticalGap,
    ruleThickness,
    extraAscender,
    variants,
    assembly,
    minConnectorOverlap,
  };
}
