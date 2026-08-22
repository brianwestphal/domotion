// @ts-nocheck
//
// DM-2417: small, source-shaped primitives shared by the capture-side
// line-clamp probe.  Blink treats the generated clamp ellipsis as an inline
// fragment: it exists only at the clamp point, is shaped in the inline
// formatting context root's primary font, and is placed immediately after the
// last retained inline item (before it for RTL).  Keep those decisions here so
// the DOM measurement code below the walker does not grow a second, heuristic
// model of the feature.

/** Parse Blink's computed `-webkit-line-clamp` value. */
export const parseBlinkLineClampCount = (value) => {
  if (typeof value !== 'string' || !/^\s*[1-9]\d*\s*$/.test(value)) return null;
  const count = Number.parseInt(value, 10);
  return Number.isSafeInteger(count) && count > 0 ? count : null;
};

/**
 * CSSOM candidate gate.  Chromium serialises a legacy `display:-webkit-box`
 * clamp as `flow-root`, so capture additionally supplies the behavioural
 * result from its isolated clone probe.  `behaviorallyClamps` is deliberately
 * mandatory: an authored `display:flow-root` with the two WebKit properties is
 * not a line-clamp formatting context.
 */
export const blinkLineClampActivation = ({
  webkitLineClamp,
  webkitBoxOrient,
  computedDisplay,
  behaviorallyClamps,
}) => {
  const clampCount = parseBlinkLineClampCount(webkitLineClamp);
  if (clampCount == null) return null;
  if (webkitBoxOrient !== 'vertical') return null;
  if (computedDisplay !== 'flow-root') return null;
  if (behaviorallyClamps !== true) return null;
  return { clampCount };
};

/** Blink's primary-font coverage fallback for the generated marker. */
export const blinkLineClampEllipsisText = (primaryFontHasHorizontalEllipsis) =>
  primaryFontHasHorizontalEllipsis ? '\u2026' : '...';

/**
 * `InlineLayoutAlgorithm::SetupLineClampEllipsis` is reached only for a real
 * clamp point.  The last-line retry removes the marker when the unreserved
 * remainder fits, which capture observes as `totalLineCount <= clampCount`.
 */
export const blinkShouldEmitLineClampEllipsis = ({
  active,
  clampCount,
  totalLineCount,
  emptyLine = false,
  blockInInline = false,
}) => active === true
  && Number.isInteger(clampCount)
  && clampCount > 0
  && totalLineCount > clampCount
  && !emptyLine
  && !blockInInline;

/** Block-axis ordering of line boxes in the three supported writing modes. */
export const blinkLogicalLineOrder = (blockOffsets, writingMode) => {
  const unique = [...new Set(blockOffsets)].sort((a, b) => a - b);
  return writingMode === 'vertical-rl' || writingMode === 'sideways-rl'
    ? unique.reverse()
    : unique;
};

/**
 * Physical start of the generated fragment on the inline axis.  This mirrors
 * `LineTruncator::CreateEllipsis`: LTR starts at the retained item's far edge;
 * RTL backs up by the shaped marker advance.  The same rule applies to the Y
 * inline axis in vertical writing.
 */
export const blinkLineClampInlineStart = ({
  direction,
  adjacentInlineStart,
  adjacentInlineEnd,
  ellipsisAdvance,
}) => direction === 'rtl'
  ? adjacentInlineStart - ellipsisAdvance
  : adjacentInlineEnd;

/** Clamp-owned source fragments past the Nth logical line do not paint. */
export const blinkLineClampLineIsVisible = (logicalLineIndex, clampCount) =>
  Number.isInteger(logicalLineIndex)
  && Number.isInteger(clampCount)
  && logicalLineIndex >= 0
  && logicalLineIndex < clampCount;

const VERTICAL_WRITING_RE = /^(?:vertical|sideways)-/;

const collectTextCharacters = (root, vertical) => {
  const chars = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node != null; node = walker.nextNode()) {
    const owner = node.parentElement;
    if (owner == null) continue;
    const ownerStyle = getComputedStyle(owner);
    if (ownerStyle.display === 'none' || ownerStyle.visibility === 'hidden') continue;
    const source = node.textContent || '';
    for (let offset = 0; offset < source.length;) {
      const cp = source.codePointAt(offset);
      const ch = String.fromCodePoint(cp);
      const range = root.ownerDocument.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + ch.length);
      const rect = range.getBoundingClientRect();
      // Collapsed whitespace has a zero inline advance but a line-box height.
      // It is not the retained item Blink places the generated fragment after.
      const inlineAdvance = vertical ? rect.height : rect.width;
      if (rect.width > 0 && rect.height > 0 && !(inlineAdvance === 0 && /^\s+$/u.test(ch))) {
        chars.push({
          node,
          owner,
          ch,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
        });
      }
      offset += ch.length;
    }
  }
  return chars;
};

const groupLogicalLines = (chars, writingMode) => {
  const vertical = VERTICAL_WRITING_RE.test(writingMode);
  const groups = [];
  for (const char of chars) {
    const offset = vertical ? char.left : char.top;
    let line = groups.find((candidate) => Math.abs(candidate.blockOffset - offset) <= 1);
    if (line == null) {
      line = { blockOffset: offset, chars: [] };
      groups.push(line);
    }
    line.chars.push(char);
  }
  groups.sort((a, b) => a.blockOffset - b.blockOffset);
  if (writingMode === 'vertical-rl' || writingMode === 'sideways-rl') groups.reverse();
  return groups;
};

// `display:-webkit-box` and authored `display:flow-root` both serialise as
// flow-root.  Re-layout an inert clone with auto block-size: the former still
// has a clamp-owned scroll extent while the latter expands to all lines.  The
// clone keeps the real subtree/styles/font fallback, so this is a behavioural
// platform query rather than a fixture-derived dimension threshold.
const behaviorallyClampsInClone = (el, cs, writingMode) => {
  const parent = el.parentNode;
  if (parent == null) return false;
  const clone = el.cloneNode(true);
  clone.setAttribute('aria-hidden', 'true');
  clone.inert = true;
  clone.style.setProperty('position', 'fixed', 'important');
  clone.style.setProperty('left', '-100000px', 'important');
  clone.style.setProperty('top', '0', 'important');
  clone.style.setProperty('visibility', 'hidden', 'important');
  clone.style.setProperty('pointer-events', 'none', 'important');
  clone.style.setProperty('content-visibility', 'visible', 'important');
  clone.style.setProperty('contain', 'none', 'important');
  if (VERTICAL_WRITING_RE.test(writingMode)) {
    clone.style.setProperty('height', cs.height, 'important');
    clone.style.setProperty('width', 'auto', 'important');
    clone.style.setProperty('min-width', '0', 'important');
    clone.style.setProperty('max-width', 'none', 'important');
  } else {
    clone.style.setProperty('width', cs.width, 'important');
    clone.style.setProperty('height', 'auto', 'important');
    clone.style.setProperty('min-height', '0', 'important');
    clone.style.setProperty('max-height', 'none', 'important');
  }
  clone.style.setProperty('overflow', 'visible', 'important');
  parent.insertBefore(clone, el.nextSibling);
  try {
    return VERTICAL_WRITING_RE.test(writingMode)
      ? clone.scrollWidth > clone.clientWidth + 0.5
      : clone.scrollHeight > clone.clientHeight + 0.5;
  } finally {
    clone.remove();
  }
};

const firstFamily = (familyList) => {
  const match = /^\s*(?:"([^"]+)"|'([^']+)'|([^,]+))/.exec(familyList || '');
  return (match?.[1] || match?.[2] || match?.[3] || familyList || 'sans-serif').trim();
};

// CSS Font Loading exposes exact unicode-range coverage for authored faces.
// Installed platform primary faces used by Blink all carry U+2026 on supported
// targets; an unavailable/custom primary falls through to the three-period
// branch.  The return value is kept explicit on the captured fragment.
const primaryFontHasEllipsis = (doc, cs) => {
  const primary = firstFamily(cs.fontFamily).toLowerCase();
  let sawMatchingFace = false;
  for (const face of doc.fonts) {
    if ((face.family || '').replace(/^['"]|['"]$/g, '').toLowerCase() !== primary) continue;
    sawMatchingFace = true;
    const range = face.unicodeRange || 'U+0-10FFFF';
    const covers = range.split(',').some((part) => {
      const match = /U\+([0-9a-f?]+)(?:-([0-9a-f]+))?/i.exec(part.trim());
      if (match == null) return false;
      if (match[1].includes('?')) {
        const lo = Number.parseInt(match[1].replace(/\?/g, '0'), 16);
        const hi = Number.parseInt(match[1].replace(/\?/g, 'f'), 16);
        return 0x2026 >= lo && 0x2026 <= hi;
      }
      const lo = Number.parseInt(match[1], 16);
      const hi = match[2] == null ? lo : Number.parseInt(match[2], 16);
      return 0x2026 >= lo && 0x2026 <= hi;
    });
    if (covers) return true;
  }
  return !sawMatchingFace;
};

const measureMarker = (doc, cs, text, writingMode, scale) => {
  const probe = doc.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.textContent = text;
  probe.style.cssText = 'position:fixed;left:-100000px;top:0;display:inline-block;visibility:hidden;white-space:pre;margin:0;padding:0;border:0;';
  probe.style.fontFamily = cs.fontFamily;
  probe.style.fontSize = cs.fontSize;
  probe.style.fontWeight = cs.fontWeight;
  probe.style.fontStyle = cs.fontStyle;
  probe.style.fontStretch = cs.fontStretch;
  probe.style.fontKerning = cs.fontKerning;
  probe.style.fontFeatureSettings = cs.fontFeatureSettings;
  probe.style.fontVariationSettings = cs.fontVariationSettings;
  probe.style.fontVariant = cs.fontVariant;
  probe.style.letterSpacing = cs.letterSpacing;
  probe.style.lineHeight = cs.lineHeight;
  probe.style.direction = cs.direction;
  probe.style.writingMode = writingMode;
  probe.style.textOrientation = cs.textOrientation;
  doc.body.appendChild(probe);
  try {
    const rect = probe.getBoundingClientRect();
    return {
      inlineAdvance: (VERTICAL_WRITING_RE.test(writingMode) ? rect.height : rect.width) * scale,
      width: rect.width * scale,
      height: rect.height * scale,
    };
  } finally {
    probe.remove();
  }
};

/**
 * Capture-time platform probe.  Returns a finalizer invoked by each element's
 * text walker; a WeakMap makes the root analysis single-shot while descendants
 * reuse the exact logical-line ownership established for their clamp root.
 */
export const createLineClampHandler = ({ vp, measureFontMetrics, normColor, effectiveZoomFor }) => {
  const contexts = new WeakMap();
  let probeSequence = 0;

  const analyzeRoot = (el, cs) => {
    if (contexts.has(el)) return contexts.get(el);
    const parsed = parseBlinkLineClampCount(cs.webkitLineClamp || '');
    if (parsed == null || cs.webkitBoxOrient !== 'vertical' || cs.display !== 'flow-root') {
      contexts.set(el, null);
      return null;
    }
    const writingMode = cs.writingMode || 'horizontal-tb';
    const vertical = VERTICAL_WRITING_RE.test(writingMode);
    const chars = collectTextCharacters(el, vertical);
    const lines = groupLogicalLines(chars, writingMode);
    // No generated marker and no past-clamp fragments for a short remainder.
    if (lines.length <= parsed) {
      contexts.set(el, null);
      return null;
    }
    const activation = blinkLineClampActivation({
      webkitLineClamp: cs.webkitLineClamp,
      webkitBoxOrient: cs.webkitBoxOrient,
      computedDisplay: cs.display,
      behaviorallyClamps: behaviorallyClampsInClone(el, cs, writingMode),
    });
    if (activation == null) {
      contexts.set(el, null);
      return null;
    }
    const clampLine = lines[activation.clampCount - 1];
    if (clampLine == null || clampLine.chars.length === 0) {
      contexts.set(el, null);
      return null;
    }
    const direction = cs.direction === 'rtl' ? 'rtl' : 'ltr';
    // CSS zoom belongs to Blink's local layout/metric space. CSS transforms
    // are deliberately excluded: DM-2470 applies the signed fragment paint
    // matrix once after the complete marker/text bundle is emitted.
    const scale = effectiveZoomFor?.(el) || 1;
    const markerText = blinkLineClampEllipsisText(primaryFontHasEllipsis(el.ownerDocument, cs));
    const measured = measureMarker(el.ownerDocument, cs, markerText, writingMode, scale);
    const inlineStarts = clampLine.chars.map((char) => vertical ? char.top : char.left);
    const inlineEnds = clampLine.chars.map((char) => vertical ? char.bottom : char.right);
    const adjacentInlineStart = Math.min(...inlineStarts);
    const adjacentInlineEnd = Math.max(...inlineEnds);
    const inlineStart = blinkLineClampInlineStart({
      direction,
      adjacentInlineStart,
      adjacentInlineEnd,
      ellipsisAdvance: measured.inlineAdvance,
    });
    const adjacent = direction === 'rtl'
      ? clampLine.chars.reduce((best, char) => (vertical ? char.top : char.left) < (vertical ? best.top : best.left) ? char : best)
      : clampLine.chars.reduce((best, char) => (vertical ? char.bottom : char.right) > (vertical ? best.bottom : best.right) ? char : best);
    const adjacentStyle = getComputedStyle(adjacent.owner);
    const adjacentAscent = measureFontMetrics(adjacentStyle).ascent * (effectiveZoomFor?.(adjacent.owner) || 1);
    const rootMetrics = measureFontMetrics(cs);
    const rootAscent = rootMetrics.ascent * scale;
    const baseline = vertical
      ? adjacent.left + adjacentAscent
      : adjacent.top + adjacentAscent;
    const lineLeft = Math.min(...clampLine.chars.map((char) => char.left));
    const lineRight = Math.max(...clampLine.chars.map((char) => char.right));
    const lineTop = Math.min(...clampLine.chars.map((char) => char.top));
    const lineBottom = Math.max(...clampLine.chars.map((char) => char.bottom));
    const marker = vertical ? {
      text: markerText,
      x: lineLeft - vp.x,
      y: inlineStart - vp.y,
      width: lineRight - lineLeft,
      height: measured.inlineAdvance,
      yOffsets: [inlineStart - vp.y],
      verticalWritingMode: writingMode,
      verticalOrientations: ['rotated'],
      verticalAdvances: [measured.inlineAdvance],
      verticalNaturalWidths: [measured.width],
      fontAscent: rootMetrics.ascent,
    } : {
      text: markerText,
      x: inlineStart - vp.x,
      y: baseline - rootAscent - vp.y,
      width: measured.inlineAdvance,
      height: lineBottom - lineTop,
      xOffsets: [inlineStart - vp.x],
      fontAscent: rootMetrics.ascent,
    };
    Object.assign(marker, {
      generatedLineClampEllipsis: true,
      shapedWidth: measured.inlineAdvance,
      baseline: baseline - (vertical ? vp.x : vp.y),
      inlineOffset: inlineStart - (vertical ? vp.y : vp.x),
      color: normColor(cs.color),
      fontFamily: cs.fontFamily,
      fontSize: Number.parseFloat(cs.fontSize) || undefined,
      fontWeight: cs.fontWeight,
      fontStyle: cs.fontStyle,
      fontVariant: cs.fontVariant,
    });
    const probeId = `dm2417-${probeSequence++}`;
    el.setAttribute('data-domotion-line-clamp-probe', probeId);
    marker.lineClampProbeId = probeId;
    const context = { root: el, clampCount: activation.clampCount, writingMode, lines, marker };
    contexts.set(el, context);
    return context;
  };

  const nearestContext = (el) => {
    for (let cursor = el; cursor != null; cursor = cursor.parentElement) {
      const context = contexts.has(cursor)
        ? contexts.get(cursor)
        : analyzeRoot(cursor, getComputedStyle(cursor));
      if (context != null) return context;
    }
    return null;
  };

  const segmentLineIndex = (segment, context) => {
    const vertical = VERTICAL_WRITING_RE.test(context.writingMode);
    const offset = vertical ? segment.x + vp.x : segment.y + vp.y;
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let index = 0; index < context.lines.length; index++) {
      const distance = Math.abs(context.lines[index].blockOffset - offset);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    return bestDistance <= 1.5 ? bestIndex : -1;
  };

  const finalizeLineClampText = (el, cs, result) => {
    // Establish a root context before descending capture reaches its children.
    analyzeRoot(el, cs);
    const context = nearestContext(el);
    if (context == null) return result;
    const sourceSegments = result.textSegments || [];
    const retained = sourceSegments.filter((segment) => {
      if (segment.generatedLineClampEllipsis) return true;
      const index = segmentLineIndex(segment, context);
      return index < 0 || blinkLineClampLineIsVisible(index, context.clampCount);
    });
    if (el === context.root && blinkShouldEmitLineClampEllipsis({
      active: true,
      clampCount: context.clampCount,
      totalLineCount: context.lines.length,
    })) retained.push(context.marker);
    return {
      ...result,
      textSegments: retained,
      lineClampTextFragments: true,
    };
  };

  return { finalizeLineClampText };
};
