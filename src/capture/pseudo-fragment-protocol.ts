/**
 * Source-transcribed decoder for Blink generated-content protocol geometry.
 *
 * DOMSnapshot text boxes are fragmentainer-local and use UTF-16 offsets.
 * DOM.getContentQuads supplies the ordered physical pseudo box fragments. This
 * module joins those two independent protocol views without cloning the node or
 * consulting Domotion's legacy pseudo placement heuristics.
 */

export type PseudoType = "before" | "after";
export type WritingMode =
  | "horizontal-tb"
  | "vertical-rl"
  | "vertical-lr"
  | "sideways-rl"
  | "sideways-lr";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Quad = [Point, Point, Point, Point];

export interface PhysicalEdges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface SnapshotTextBox {
  bounds: Rect;
  startUtf16: number;
  lengthUtf16: number;
  /** Independent HarfBuzz-backed browser measurement when available. */
  shapedAdvance?: number;
}

export interface SnapshotLayoutRow {
  layoutIndex: number;
  bounds: Rect;
  text?: string;
  textBoxes: SnapshotTextBox[];
}

export interface PseudoProtocolStyle {
  writingMode: WritingMode;
  direction: "ltr" | "rtl";
  boxDecorationBreak: "slice" | "clone";
  border: PhysicalEdges;
  padding: PhysicalEdges;
  margin: PhysicalEdges;
  primaryFontAscent: number;
  fontSize: number;
  lineHeight: number | "normal";
}

export interface PseudoProtocolInput {
  hostCorrelationId: string;
  pseudo: PseudoType;
  layoutRows: SnapshotLayoutRow[];
  contentQuads: Quad[];
  style: PseudoProtocolStyle;
  protocolAvailable?: boolean;
}

export interface LogicalEdgeOwnership {
  inlineStart: boolean;
  inlineEnd: boolean;
  blockStart: boolean;
  blockEnd: boolean;
}

export interface PseudoContentItem {
  index: number;
  kind: "text" | "image";
  layoutIndex: number;
  text?: string;
}

export interface FragmentBaseline {
  /** Physical paint-space baseline segment after Blink's writing transform. */
  origin: Point;
  end: Point;
  ascent: number;
  source: "TextFragmentPainter.primary-font-ascent+writing-transform";
}

export interface PseudoTextFragment {
  kind: "text";
  contentItemIndex: number;
  sourceStartUtf16: number;
  sourceEndUtf16: number;
  text: string;
  visualOrder: number;
  boxFragmentIndex: number;
  localRect: Rect;
  physicalRect: Rect;
  physicalQuad: Quad;
  protocolInlineAdvance: number;
  shapedInlineAdvance: number;
  baseline: FragmentBaseline;
}

export interface PseudoImageFragment {
  kind: "image";
  contentItemIndex: number;
  visualOrder: number;
  boxFragmentIndex: number;
  localRect: Rect;
  physicalRect: Rect;
  physicalQuad: Quad;
}

export type PseudoFragment = PseudoTextFragment | PseudoImageFragment;

export interface PseudoBoxFragment {
  index: number;
  physicalQuad: Quad;
  physicalRect: Rect;
  localContentRect: Rect | null;
  localBorderRect: Rect | null;
  edgeOwnership: LogicalEdgeOwnership;
  /** Present only for an axis-aligned, translation-only protocol pairing. */
  fragmentainerTranslation: Point | null;
}

export interface DecodedPseudoFragmentSet {
  hostCorrelationId: string;
  pseudo: PseudoType;
  status: "exact" | "unpainted" | "ambiguous" | "protocol-unavailable";
  reason?: string;
  writingMode: WritingMode;
  direction: "ltr" | "rtl";
  contentItems: PseudoContentItem[];
  boxFragments: PseudoBoxFragment[];
  fragments: PseudoFragment[];
}

interface FragmentEvent {
  kind: "text" | "image";
  contentItemIndex: number;
  localRect: Rect;
  startUtf16?: number;
  endUtf16?: number;
  text?: string;
  shapedAdvance?: number;
}

const EPSILON = 0.8;

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function validRect(rect: Rect): boolean {
  return finite(rect.x) && finite(rect.y) && finite(rect.width) && finite(rect.height) && rect.width >= 0 && rect.height >= 0;
}

function validQuad(quad: Quad): boolean {
  return quad.length === 4 && quad.every((point) => finite(point.x) && finite(point.y));
}

export function rectFromQuad(quad: Quad): Rect {
  const xs = quad.map((point) => point.x);
  const ys = quad.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function unionRects(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x, y, width: right - x, height: bottom - y };
}

function contains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x - EPSILON && inner.y >= outer.y - EPSILON &&
    inner.x + inner.width <= outer.x + outer.width + EPSILON &&
    inner.y + inner.height <= outer.y + outer.height + EPSILON;
}

function isVertical(writingMode: WritingMode): boolean {
  return writingMode !== "horizontal-tb";
}

function inlineAdvance(rect: Rect, writingMode: WritingMode): number {
  return isVertical(writingMode) ? rect.height : rect.width;
}

function blockInterval(rect: Rect, writingMode: WritingMode): [number, number] {
  return isVertical(writingMode)
    ? [rect.x, rect.x + rect.width]
    : [rect.y, rect.y + rect.height];
}

function axisAligned(quad: Quad): boolean {
  return Math.abs(quad[0].y - quad[1].y) <= EPSILON &&
    Math.abs(quad[1].x - quad[2].x) <= EPSILON &&
    Math.abs(quad[2].y - quad[3].y) <= EPSILON &&
    Math.abs(quad[3].x - quad[0].x) <= EPSILON;
}

function addEdges(a: PhysicalEdges, b: PhysicalEdges): PhysicalEdges {
  return { top: a.top + b.top, right: a.right + b.right, bottom: a.bottom + b.bottom, left: a.left + b.left };
}

function edgeOwnership(index: number, count: number, breakMode: "slice" | "clone"): LogicalEdgeOwnership {
  return {
    inlineStart: breakMode === "clone" || index === 0,
    inlineEnd: breakMode === "clone" || index === count - 1,
    blockStart: true,
    blockEnd: true,
  };
}

type PhysicalSide = keyof PhysicalEdges;

function logicalPhysicalSides(style: PseudoProtocolStyle): {
  inlineStart: PhysicalSide;
  inlineEnd: PhysicalSide;
  blockStart: PhysicalSide;
  blockEnd: PhysicalSide;
} {
  const { writingMode, direction } = style;
  if (writingMode === "horizontal-tb") {
    return {
      inlineStart: direction === "ltr" ? "left" : "right",
      inlineEnd: direction === "ltr" ? "right" : "left",
      blockStart: "top",
      blockEnd: "bottom",
    };
  }
  const reverseInline = writingMode === "sideways-lr" ? direction === "ltr" : direction === "rtl";
  return {
    inlineStart: reverseInline ? "bottom" : "top",
    inlineEnd: reverseInline ? "top" : "bottom",
    blockStart: writingMode === "vertical-rl" || writingMode === "sideways-rl" ? "right" : "left",
    blockEnd: writingMode === "vertical-rl" || writingMode === "sideways-rl" ? "left" : "right",
  };
}

function ownedInsets(style: PseudoProtocolStyle, ownership: LogicalEdgeOwnership): PhysicalEdges {
  const available = addEdges(style.border, style.padding);
  const sides = logicalPhysicalSides(style);
  const result: PhysicalEdges = { top: 0, right: 0, bottom: 0, left: 0 };
  if (ownership.inlineStart) result[sides.inlineStart] = available[sides.inlineStart];
  if (ownership.inlineEnd) result[sides.inlineEnd] = available[sides.inlineEnd];
  if (ownership.blockStart) result[sides.blockStart] = available[sides.blockStart];
  if (ownership.blockEnd) result[sides.blockEnd] = available[sides.blockEnd];
  return result;
}

function expand(rect: Rect, edges: PhysicalEdges): Rect {
  return {
    x: rect.x - edges.left,
    y: rect.y - edges.top,
    width: rect.width + edges.left + edges.right,
    height: rect.height + edges.top + edges.bottom,
  };
}

function pointOnQuad(quad: Quad, u: number, v: number): Point {
  // CDP quads are ordered top-left, top-right, bottom-right, bottom-left.
  const top = { x: quad[0].x + (quad[1].x - quad[0].x) * u, y: quad[0].y + (quad[1].y - quad[0].y) * u };
  const bottom = { x: quad[3].x + (quad[2].x - quad[3].x) * u, y: quad[3].y + (quad[2].y - quad[3].y) * u };
  return { x: top.x + (bottom.x - top.x) * v, y: top.y + (bottom.y - top.y) * v };
}

function mapPoint(point: Point, source: Rect, target: Quad): Point {
  const u = source.width === 0 ? 0 : (point.x - source.x) / source.width;
  const v = source.height === 0 ? 0 : (point.y - source.y) / source.height;
  return pointOnQuad(target, u, v);
}

function mapRect(rect: Rect, source: Rect, target: Quad): Quad {
  return [
    mapPoint({ x: rect.x, y: rect.y }, source, target),
    mapPoint({ x: rect.x + rect.width, y: rect.y }, source, target),
    mapPoint({ x: rect.x + rect.width, y: rect.y + rect.height }, source, target),
    mapPoint({ x: rect.x, y: rect.y + rect.height }, source, target),
  ];
}

/** Blink TextFragmentPainter's line-relative origin and writing transform. */
export function blinkTextPaintBaseline(
  rect: Rect,
  writingMode: WritingMode,
  ascent: number,
  advance: number,
): { origin: Point; end: Point } {
  if (writingMode === "horizontal-tb") {
    return { origin: { x: rect.x, y: rect.y + ascent }, end: { x: rect.x + advance, y: rect.y + ascent } };
  }
  if (writingMode === "sideways-lr") {
    return {
      origin: { x: rect.x + ascent, y: rect.y + rect.height },
      end: { x: rect.x + ascent, y: rect.y + rect.height - advance },
    };
  }
  return {
    origin: { x: rect.x + rect.width - ascent, y: rect.y },
    end: { x: rect.x + rect.width - ascent, y: rect.y + advance },
  };
}

function selectAggregateRow(rows: SnapshotLayoutRow[]): SnapshotLayoutRow | null {
  if (rows.length === 0) return null;
  const candidates = rows.filter((row) => row.text == null && rows.every((other) => row === other || contains(row.bounds, other.bounds)));
  return (candidates.length > 0 ? candidates : rows.filter((row) => row.text == null))
    .sort((a, b) => a.layoutIndex - b.layoutIndex)[0] ?? null;
}

function buildItemsAndEvents(rows: SnapshotLayoutRow[], aggregate: SnapshotLayoutRow | null): {
  contentItems: PseudoContentItem[];
  events: FragmentEvent[];
} | { error: string } {
  const contentRows = rows.filter((row) => row !== aggregate).sort((a, b) => a.layoutIndex - b.layoutIndex);
  const contentItems: PseudoContentItem[] = [];
  const events: FragmentEvent[] = [];
  for (const row of contentRows) {
    if (!validRect(row.bounds)) return { error: `invalid layout bounds at ${row.layoutIndex}` };
    const isText = row.text != null;
    const item: PseudoContentItem = {
      index: contentItems.length,
      kind: isText ? "text" : "image",
      layoutIndex: row.layoutIndex,
      ...(isText ? { text: row.text } : {}),
    };
    contentItems.push(item);
    if (!isText) {
      events.push({ kind: "image", contentItemIndex: item.index, localRect: row.bounds });
      continue;
    }
    for (const box of row.textBoxes) {
      if (!validRect(box.bounds)) return { error: `invalid text-box bounds at ${row.layoutIndex}` };
      const end = box.startUtf16 + box.lengthUtf16;
      if (!Number.isInteger(box.startUtf16) || !Number.isInteger(box.lengthUtf16) || box.startUtf16 < 0 || end > row.text!.length) {
        return { error: `invalid UTF-16 range ${box.startUtf16}:${end} for layout ${row.layoutIndex}` };
      }
      events.push({
        kind: "text",
        contentItemIndex: item.index,
        localRect: box.bounds,
        startUtf16: box.startUtf16,
        endUtf16: end,
        text: row.text!.slice(box.startUtf16, end),
        shapedAdvance: box.shapedAdvance,
      });
    }
  }
  return { contentItems, events };
}

function groupEvents(events: FragmentEvent[], writingMode: WritingMode): FragmentEvent[][] {
  const groups: FragmentEvent[][] = [];
  let current: FragmentEvent[] = [];
  let currentBlock: [number, number] | null = null;
  for (const event of events) {
    const block = blockInterval(event.localRect, writingMode);
    const overlaps = currentBlock != null && Math.min(currentBlock[1], block[1]) >= Math.max(currentBlock[0], block[0]) - EPSILON;
    if (current.length > 0 && !overlaps) {
      groups.push(current);
      current = [];
      currentBlock = null;
    }
    current.push(event);
    currentBlock = currentBlock == null
      ? block
      : [Math.min(currentBlock[0], block[0]), Math.max(currentBlock[1], block[1])];
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function ambiguous(input: PseudoProtocolInput, reason: string, contentItems: PseudoContentItem[] = []): DecodedPseudoFragmentSet {
  return {
    hostCorrelationId: input.hostCorrelationId,
    pseudo: input.pseudo,
    status: "ambiguous",
    reason,
    writingMode: input.style.writingMode,
    direction: input.style.direction,
    contentItems,
    boxFragments: [],
    fragments: [],
  };
}

export function decodePseudoFragmentProtocol(input: PseudoProtocolInput): DecodedPseudoFragmentSet {
  const base = {
    hostCorrelationId: input.hostCorrelationId,
    pseudo: input.pseudo,
    writingMode: input.style.writingMode,
    direction: input.style.direction,
  };
  if (input.protocolAvailable === false) {
    return { ...base, status: "protocol-unavailable", reason: "Chromium protocol unavailable", contentItems: [], boxFragments: [], fragments: [] };
  }
  if (input.layoutRows.some((row) => !validRect(row.bounds)) || input.contentQuads.some((quad) => !validQuad(quad))) {
    return ambiguous(input, "non-finite or negative protocol geometry");
  }
  if (input.layoutRows.length === 0 || input.contentQuads.length === 0) {
    return { ...base, status: "unpainted", reason: "pseudo has no observable layout fragments", contentItems: [], boxFragments: [], fragments: [] };
  }

  const aggregate = selectAggregateRow(input.layoutRows);
  const built = buildItemsAndEvents(input.layoutRows, aggregate);
  if ("error" in built) return ambiguous(input, built.error);
  const { contentItems, events } = built;

  // An empty decorative box has no anonymous child rows but remains a real
  // box fragment. All non-empty rows must pair one-for-one with ordered quads.
  const groups = events.length === 0 ? input.contentQuads.map(() => [] as FragmentEvent[]) : groupEvents(events, input.style.writingMode);
  if (groups.length !== input.contentQuads.length) {
    return ambiguous(input, `ordered fragment cardinality mismatch: ${groups.length} snapshot groups, ${input.contentQuads.length} quads`, contentItems);
  }

  const boxFragments: PseudoBoxFragment[] = [];
  const fragments: PseudoFragment[] = [];
  let visualOrder = 0;
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    const quad = input.contentQuads[index];
    const physicalRect = rectFromQuad(quad);
    const ownership = edgeOwnership(index, groups.length, input.style.boxDecorationBreak);
    const insets = ownedInsets(input.style, ownership);
    const contentRect = group.length > 0 ? unionRects(group.map((event) => event.localRect)) : null;
    const localBorderRect = contentRect == null ? aggregate?.bounds ?? null : expand(contentRect, insets);
    if (localBorderRect == null) return ambiguous(input, "box quad has no matching aggregate or content geometry", contentItems);

    let translation: Point | null = null;
    if (axisAligned(quad) && Math.abs(localBorderRect.width - physicalRect.width) <= EPSILON && Math.abs(localBorderRect.height - physicalRect.height) <= EPSILON) {
      translation = { x: physicalRect.x - localBorderRect.x, y: physicalRect.y - localBorderRect.y };
    }
    boxFragments.push({
      index,
      physicalQuad: quad,
      physicalRect,
      localContentRect: contentRect,
      localBorderRect,
      edgeOwnership: ownership,
      fragmentainerTranslation: translation,
    });

    for (const event of group) {
      const mappedQuad = mapRect(event.localRect, localBorderRect, quad);
      const mappedRect = rectFromQuad(mappedQuad);
      if (event.kind === "image") {
        fragments.push({
          kind: "image",
          contentItemIndex: event.contentItemIndex,
          visualOrder: visualOrder++,
          boxFragmentIndex: index,
          localRect: event.localRect,
          physicalRect: mappedRect,
          physicalQuad: mappedQuad,
        });
        continue;
      }
      const protocolAdvance = inlineAdvance(event.localRect, input.style.writingMode);
      const shapedAdvance = event.shapedAdvance ?? protocolAdvance;
      const localBaseline = blinkTextPaintBaseline(event.localRect, input.style.writingMode, input.style.primaryFontAscent, shapedAdvance);
      const physicalBaseline = {
        origin: mapPoint(localBaseline.origin, localBorderRect, quad),
        end: mapPoint(localBaseline.end, localBorderRect, quad),
      };
      fragments.push({
        kind: "text",
        contentItemIndex: event.contentItemIndex,
        sourceStartUtf16: event.startUtf16!,
        sourceEndUtf16: event.endUtf16!,
        text: event.text!,
        visualOrder: visualOrder++,
        boxFragmentIndex: index,
        localRect: event.localRect,
        physicalRect: mappedRect,
        physicalQuad: mappedQuad,
        protocolInlineAdvance: protocolAdvance,
        shapedInlineAdvance: shapedAdvance,
        baseline: {
          ...physicalBaseline,
          ascent: input.style.primaryFontAscent,
          source: "TextFragmentPainter.primary-font-ascent+writing-transform",
        },
      });
    }
  }

  return { ...base, status: "exact", contentItems, boxFragments, fragments };
}

export function protocolRecordErrors(input: PseudoProtocolInput, record: DecodedPseudoFragmentSet): string[] {
  const errors: string[] = [];
  if (record.status !== "exact") return [`record is ${record.status}: ${record.reason ?? "unknown"}`];
  if (record.boxFragments.length !== input.contentQuads.length) errors.push("box-fragment cardinality differs from content quads");
  for (let i = 0; i < Math.min(record.boxFragments.length, input.contentQuads.length); i++) {
    if (JSON.stringify(record.boxFragments[i].physicalQuad) !== JSON.stringify(input.contentQuads[i])) errors.push(`box fragment ${i} does not retain its protocol quad`);
  }
  const aggregate = selectAggregateRow(input.layoutRows);
  const built = buildItemsAndEvents(input.layoutRows, aggregate);
  if ("error" in built) return [...errors, built.error];
  if (record.contentItems.length !== built.contentItems.length) errors.push("generated content-item boundary was lost");
  if (record.fragments.length !== built.events.length) errors.push("anonymous fragment row was dropped or unioned");
  for (let i = 0; i < Math.min(record.fragments.length, built.events.length); i++) {
    const actual = record.fragments[i];
    const expected = built.events[i];
    if (actual.kind !== expected.kind) errors.push(`fragment ${i} changed anonymous child kind`);
    if (actual.contentItemIndex !== expected.contentItemIndex) errors.push(`fragment ${i} changed content-item ownership`);
    if (actual.visualOrder !== i) errors.push(`fragment ${i} changed protocol visual order`);
    if (actual.kind === "text" && expected.kind === "text") {
      if (actual.sourceStartUtf16 !== expected.startUtf16 || actual.sourceEndUtf16 !== expected.endUtf16 || actual.text !== expected.text) {
        errors.push(`fragment ${i} changed its UTF-16 source slice`);
      }
      const local = blinkTextPaintBaseline(expected.localRect, input.style.writingMode, input.style.primaryFontAscent, actual.shapedInlineAdvance);
      const box = record.boxFragments[actual.boxFragmentIndex];
      if (box?.localBorderRect != null) {
        const expectedOrigin = mapPoint(local.origin, box.localBorderRect, box.physicalQuad);
        const expectedEnd = mapPoint(local.end, box.localBorderRect, box.physicalQuad);
        if (Math.hypot(actual.baseline.origin.x - expectedOrigin.x, actual.baseline.origin.y - expectedOrigin.y) > EPSILON) errors.push(`fragment ${i} baseline does not use primary ascent/writing transform`);
        if (Math.hypot(actual.baseline.end.x - expectedEnd.x, actual.baseline.end.y - expectedEnd.y) > EPSILON) errors.push(`fragment ${i} baseline advance does not use the writing transform`);
      }
    }
  }
  for (let i = 0; i < record.boxFragments.length; i++) {
    const expected = edgeOwnership(i, record.boxFragments.length, input.style.boxDecorationBreak);
    if (JSON.stringify(record.boxFragments[i].edgeOwnership) !== JSON.stringify(expected)) errors.push(`box fragment ${i} changed logical edge ownership`);
    const local = record.boxFragments[i].localBorderRect;
    const quad = input.contentQuads[i];
    if (local != null && axisAligned(quad)) {
      const rect = rectFromQuad(quad);
      const expectsTranslation = Math.abs(local.width - rect.width) <= EPSILON && Math.abs(local.height - rect.height) <= EPSILON;
      const tx = record.boxFragments[i].fragmentainerTranslation;
      if (expectsTranslation && (tx == null || Math.abs(tx.x - (rect.x - local.x)) > EPSILON || Math.abs(tx.y - (rect.y - local.y)) > EPSILON)) {
        errors.push(`box fragment ${i} lost fragmentainer translation`);
      }
    }
  }
  return errors;
}
