import type { TextSegment } from "../capture/types.js";

/**
 * One line-local decorating-box witness. Blink rebuilds InlinePaintContext's
 * DecoratingBox list for every line and stores the FragmentItem content
 * offset; flattening that list to a union or a rounded baseline loses wrapped
 * continuation ownership (Chromium 7d859f271c, inline_paint_context.cc and
 * decorating_box.h).
 */
export interface DecorationFragmentRecord {
  version: "blink-decorating-box-fragment-v1";
  fragmentIndex: number;
  writingMode: string;
  direction: string;
  inlineStart: number;
  inlineEnd: number;
  lineOver: number;
  baseline: number;
  usedFontAscent: number;
  usedFontDescent?: number;
  /** MakeWave starts at -wavelength, i.e. phase zero at each paint fragment. */
  continuationPhase: 0;
}

export interface DecorationFragmentCarrier {
  decorationFragments?: DecorationFragmentRecord[];
}

export function buildDecorationFragmentRecords(
  segments: readonly TextSegment[] | undefined,
  writingMode: string | undefined,
  direction: string | undefined,
  fallbackAscent: number,
  fallbackDescent?: number,
): DecorationFragmentRecord[] | undefined {
  if (segments == null || segments.length === 0) return undefined;
  const mode = writingMode ?? "horizontal-tb";
  const vertical = mode.startsWith("vertical") || mode.startsWith("sideways");
  const records = segments.map((segment, fragmentIndex) => ({
    version: "blink-decorating-box-fragment-v1" as const,
    fragmentIndex,
    writingMode: mode,
    direction: direction ?? "ltr",
    inlineStart: vertical ? segment.y : segment.x,
    inlineEnd: vertical ? segment.y + segment.height : segment.x + segment.width,
    lineOver: vertical ? segment.x : segment.y,
    baseline: segment.baseline ?? (vertical
      ? segment.x + (segment.fontAscent ?? fallbackAscent)
      : segment.y + (segment.fontAscent ?? fallbackAscent)),
    // DecoratingBox stores its own UsedFont, not the target text run's.
    usedFontAscent: fallbackAscent,
    usedFontDescent: fallbackDescent,
    continuationPhase: 0 as const,
  }));
  return records.every((record) => Object.values(record).every((value) =>
    value == null || typeof value !== "number" || Number.isFinite(value))) ? records : undefined;
}

export interface DecorationTargetFragment {
  writingMode: string;
  inlineStart: number;
  inlineEnd: number;
  lineOver: number;
  baseline: number;
}

/**
 * Join a painted text fragment to the decorating box on the same line. Line
 * identity wins; inline overlap then distinguishes bidi fragments on a line.
 * Equal candidates are genuinely ambiguous and fail closed instead of using
 * DOM order or a merged-line approximation.
 */
export function selectDecorationFragment(
  records: readonly DecorationFragmentRecord[] | undefined,
  target: DecorationTargetFragment,
  lineLimit: number,
): DecorationFragmentRecord | undefined {
  if (records == null || records.length === 0) return undefined;
  const candidates = records.map((record) => {
    if (record.writingMode !== target.writingMode) return undefined;
    const lineDistance = Math.abs(record.lineOver - target.lineOver);
    if (lineDistance > lineLimit) return undefined;
    const overlap = Math.max(0,
      Math.min(record.inlineEnd, target.inlineEnd) - Math.max(record.inlineStart, target.inlineStart));
    const inlineDistance = overlap > 0 ? 0 : Math.min(
      Math.abs(record.inlineEnd - target.inlineStart),
      Math.abs(target.inlineEnd - record.inlineStart),
    );
    return { record, lineDistance, overlap, inlineDistance };
  }).filter((value): value is NonNullable<typeof value> => value != null)
    .sort((a, b) => a.lineDistance - b.lineDistance
      || b.overlap - a.overlap || a.inlineDistance - b.inlineDistance);
  const best = candidates[0];
  if (best == null) return undefined;
  const second = candidates[1];
  if (second != null && second.lineDistance === best.lineDistance
      && second.overlap === best.overlap && second.inlineDistance === best.inlineDistance) {
    return undefined;
  }
  return best.record;
}
