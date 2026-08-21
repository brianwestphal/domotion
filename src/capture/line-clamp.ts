import type { Page } from '@playwright/test';
import type { CapturedElement, CaptureWarning, TextSegment } from './types.js';

// DM-2417: DOM Range exposes every laid-out clamp-line character, including
// the tail Blink removes before painting its generated ellipsis. Chromium's AX
// tree, however, exposes the generated InlineTextBox and its exact immediately
// preceding (retained) InlineTextBox. Resolve that AX text box back to its
// backend DOM text node, measure the retained Range, and refine both marker
// origin and source visibility at that platform-owned boundary.

interface ClampTarget {
  root: CapturedElement;
  marker: TextSegment;
}

function collectTargets(tree: CapturedElement[]): ClampTarget[] {
  const targets: ClampTarget[] = [];
  const visit = (element: CapturedElement): void => {
    const marker = element.textSegments?.find((segment) =>
      segment.generatedLineClampEllipsis && segment.lineClampProbeId != null);
    if (marker) targets.push({ root: element, marker });
    for (const child of element.children ?? []) visit(child);
  };
  for (const root of tree) visit(root);
  return targets;
}

function trimHorizontalSegment(
  segment: TextSegment,
  boundary: number,
  direction: string,
): boolean {
  if (segment.xOffsets == null || segment.xAdvances == null) {
    return direction === 'rtl'
      ? segment.x + segment.width > boundary - 0.25
      : segment.x < boundary + 0.25;
  }
  let cut = 0;
  for (let i = 0; i < Math.min(segment.text.length, segment.xOffsets.length);) {
    const step = (segment.text.codePointAt(i) ?? 0) > 0xFFFF ? 2 : 1;
    const start = segment.xOffsets[i];
    const end = start + (segment.xAdvances[i] ?? 0);
    const retained = direction === 'rtl'
      ? start >= boundary - 0.25
      : end <= boundary + 0.25;
    if (!retained) break;
    // Capture repeats one codepoint's Range facts for both UTF-16 units. Move
    // by the whole scalar so trimming cannot leave a lone high surrogate.
    cut = i + step;
    i += step;
  }
  if (cut === 0) return false;
  if (cut < segment.text.length) {
    segment.text = segment.text.slice(0, cut);
    if (segment.sourceText != null) segment.sourceText = segment.sourceText.slice(0, cut);
    segment.xOffsets = segment.xOffsets.slice(0, cut);
    segment.xAdvances = segment.xAdvances.slice(0, cut);
    if (segment.rasterGlyphs != null) {
      segment.rasterGlyphs = segment.rasterGlyphs.filter((glyph) => glyph.charIndex < cut);
    }
    const left = Math.min(...segment.xOffsets);
    const right = Math.max(...segment.xOffsets.map((x, i) => x + (segment.xAdvances?.[i] ?? 0)));
    segment.x = left;
    segment.width = Math.max(0, right - left);
  }
  return true;
}

function trimVerticalSegment(
  segment: TextSegment,
  boundary: number,
  direction: string,
): boolean {
  if (segment.yOffsets == null || segment.verticalAdvances == null) {
    return direction === 'rtl'
      ? segment.y + segment.height > boundary - 0.25
      : segment.y < boundary + 0.25;
  }
  let cut = 0;
  for (let i = 0; i < Math.min(segment.text.length, segment.yOffsets.length);) {
    const step = (segment.text.codePointAt(i) ?? 0) > 0xFFFF ? 2 : 1;
    const start = segment.yOffsets[i];
    const end = start + (segment.verticalAdvances[i] ?? 0);
    const retained = direction === 'rtl'
      ? start >= boundary - 0.25
      : end <= boundary + 0.25;
    if (!retained) break;
    cut = i + step;
    i += step;
  }
  if (cut === 0) return false;
  if (cut < segment.text.length) {
    segment.text = segment.text.slice(0, cut);
    if (segment.sourceText != null) segment.sourceText = segment.sourceText.slice(0, cut);
    segment.yOffsets = segment.yOffsets.slice(0, cut);
    segment.verticalAdvances = segment.verticalAdvances.slice(0, cut);
    segment.verticalOrientations = segment.verticalOrientations?.slice(0, cut);
    segment.verticalNaturalWidths = segment.verticalNaturalWidths?.slice(0, cut);
    segment.height = Math.max(0, Math.max(...segment.yOffsets.map((y, i) =>
      y + (segment.verticalAdvances?.[i] ?? 0))) - Math.min(...segment.yOffsets));
  }
  return true;
}

function trimClampLineSource(
  root: CapturedElement,
  marker: TextSegment,
  boundary: number,
): void {
  const vertical = marker.verticalWritingMode != null;
  const direction = root.styles.direction === 'rtl' ? 'rtl' : 'ltr';
  const markerBaseline = marker.baseline ?? (vertical ? marker.x : marker.y + (marker.fontAscent ?? 0));
  const visit = (element: CapturedElement): void => {
    if (element.textSegments != null) {
      element.textSegments = element.textSegments.filter((segment) => {
        if (segment.generatedLineClampEllipsis) return true;
        const baseline = vertical
          ? segment.x + (segment.fontAscent ?? element.fontAscent ?? 0)
          : segment.y + (segment.fontAscent ?? element.fontAscent ?? 0);
        if (Math.abs(baseline - markerBaseline) > 2) return true;
        return vertical
          ? trimVerticalSegment(segment, boundary, direction)
          : trimHorizontalSegment(segment, boundary, direction);
      });
      if (element.textSegments.length === 0) element.textSegments = undefined;
    }
    for (const child of element.children ?? []) visit(child);
  };
  visit(root);
}

interface AxAnchor {
  markerText: string;
  backendDOMNodeId: number;
  retainedText: string;
}

/** Resolve generated line-clamp fragments through Chromium's AX tree. */
export async function refineLineClampEllipsisFragments(
  page: Page,
  tree: CapturedElement[],
  viewport: { x: number; y: number; width: number; height: number },
  warnings: CaptureWarning[] = [],
): Promise<void> {
  const targets = collectTargets(tree);
  if (targets.length === 0) return;
  const session = await page.context().newCDPSession(page);
  const unresolved = new Set(targets.map(({ marker }) => marker.lineClampProbeId!));
  try {
    await session.send('Accessibility.enable');
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    const documentResult = await session.send('DOM.getDocument', { depth: -1, pierce: true });
    const full = await session.send('Accessibility.getFullAXTree', { depth: -1 });
    const axById = new Map(full.nodes.map((node) => [node.nodeId, node]));

    for (const { root, marker } of targets) {
      const probeId = marker.lineClampProbeId!;
      try {
        const queried = await session.send('DOM.querySelector', {
          nodeId: documentResult.root.nodeId,
          selector: `[data-domotion-line-clamp-probe="${probeId}"]`,
        });
        if (queried.nodeId === 0) continue;
        const described = await session.send('DOM.describeNode', { nodeId: queried.nodeId });
        const partial = await session.send('Accessibility.getPartialAXTree', {
          backendNodeId: described.node.backendNodeId,
          fetchRelatives: true,
        });
        const rootAx = partial.nodes.find((node) => node.backendDOMNodeId === described.node.backendNodeId)
          ?? partial.nodes[0];
        if (rootAx == null) continue;
        const descendants = new Set<string>();
        const queue = [rootAx.nodeId];
        while (queue.length > 0) {
          const id = queue.shift()!;
          if (descendants.has(id)) continue;
          descendants.add(id);
          for (const childId of axById.get(id)?.childIds ?? []) queue.push(childId);
        }
        const anchors: AxAnchor[] = [];
        for (const id of descendants) {
          const parent = axById.get(id);
          if (parent?.backendDOMNodeId == null || parent.role?.value !== 'StaticText') continue;
          const children = parent.childIds ?? [];
          for (let index = 1; index < children.length; index++) {
            const generated = axById.get(children[index]);
            const retained = axById.get(children[index - 1]);
            const markerText = generated?.name?.value;
            const retainedText = retained?.name?.value;
            if (generated?.role?.value !== 'InlineTextBox'
              || retained?.role?.value !== 'InlineTextBox'
              || (markerText !== '…' && markerText !== '...')
              || typeof retainedText !== 'string' || retainedText.length === 0) continue;
            anchors.push({ markerText, retainedText, backendDOMNodeId: parent.backendDOMNodeId });
          }
        }
        let best: { anchor: AxAnchor; rect: { left: number; right: number; top: number; bottom: number } } | null = null;
        let bestDistance = Infinity;
        for (const anchor of anchors) {
          const resolved = await session.send('DOM.resolveNode', { backendNodeId: anchor.backendDOMNodeId });
          if (resolved.object.objectId == null) continue;
          const measured = await session.send('Runtime.callFunctionOn', {
            objectId: resolved.object.objectId,
            functionDeclaration: `function(retained) {
              const text = this.nodeValue || '';
              const rects = [];
              let at = 0;
              while ((at = text.indexOf(retained, at)) !== -1) {
                const range = this.ownerDocument.createRange();
                range.setStart(this, at);
                range.setEnd(this, at + retained.length);
                for (const rect of range.getClientRects()) {
                  rects.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
                }
                at += Math.max(1, retained.length);
              }
              return rects;
            }`,
            arguments: [{ value: anchor.retainedText }],
            returnByValue: true,
          });
          const rects = (measured.result.value ?? []) as Array<{ left: number; right: number; top: number; bottom: number }>;
          for (const rect of rects) {
            const vertical = marker.verticalWritingMode != null;
            const direction = root.styles.direction === 'rtl' ? 'rtl' : 'ltr';
            const advance = marker.shapedWidth ?? (vertical ? marker.height : marker.width);
            const boundary = vertical
              ? (direction === 'rtl' ? rect.top : rect.bottom)
              : (direction === 'rtl' ? rect.left : rect.right);
            const candidateStart = direction === 'rtl' ? boundary - advance : boundary;
            const provisionalStart = (marker.inlineOffset ?? (vertical ? marker.y : marker.x))
              + (vertical ? viewport.y : viewport.x);
            // The block-axis term picks the clamp line; inline proximity then
            // disambiguates a real U+2026 in the author's source from Blink's
            // generated InlineTextBox on that same line.
            const blockDistance = vertical
              ? Math.abs(rect.left - (marker.x + viewport.x))
              : Math.abs(rect.top - (marker.y + viewport.y));
            const distance = blockDistance * 10_000 + Math.abs(candidateStart - provisionalStart);
            if (distance < bestDistance) {
              bestDistance = distance;
              best = { anchor, rect };
            }
          }
        }
        if (best == null) continue;
        const vertical = marker.verticalWritingMode != null;
        const direction = root.styles.direction === 'rtl' ? 'rtl' : 'ltr';
        marker.text = best.anchor.markerText;
        // Resolve the marker glyph in isolation through the same platform font
        // matcher Chromium used for paint. The authored stack remains the
        // renderer input; this records the concrete selected face as evidence
        // and lets downstream consumers audit fallback/synthesis explicitly.
        const fontProbeId = `${probeId}-font`;
        await page.evaluate(({ rootProbeId, fontProbeId: id, text }) => {
          const clampRoot = document.querySelector(`[data-domotion-line-clamp-probe="${rootProbeId}"]`);
          if (!(clampRoot instanceof HTMLElement)) return;
          const computed = getComputedStyle(clampRoot);
          const probe = document.createElement('span');
          probe.setAttribute('data-domotion-line-clamp-font-probe', id);
          probe.textContent = text;
          probe.style.cssText = 'position:fixed;left:0;top:0;opacity:0;pointer-events:none;white-space:pre;margin:0;padding:0;border:0;';
          probe.style.font = computed.font;
          probe.style.fontFamily = computed.fontFamily;
          probe.style.fontSize = computed.fontSize;
          probe.style.fontWeight = computed.fontWeight;
          probe.style.fontStyle = computed.fontStyle;
          probe.style.fontStretch = computed.fontStretch;
          probe.style.fontVariationSettings = computed.fontVariationSettings;
          probe.style.fontFeatureSettings = computed.fontFeatureSettings;
          probe.style.fontKerning = computed.fontKerning;
          probe.style.letterSpacing = computed.letterSpacing;
          probe.style.direction = computed.direction;
          probe.style.writingMode = computed.writingMode;
          probe.style.textOrientation = computed.textOrientation;
          document.body.appendChild(probe);
          // Force layout before CSS.getPlatformFontsForNode.
          void probe.getBoundingClientRect();
        }, { rootProbeId: probeId, fontProbeId, text: marker.text });
        try {
          const fontProbe = await session.send('DOM.querySelector', {
            nodeId: documentResult.root.nodeId,
            selector: `[data-domotion-line-clamp-font-probe="${fontProbeId}"]`,
          });
          if (fontProbe.nodeId !== 0) {
            const platformFonts = await session.send('CSS.getPlatformFontsForNode', { nodeId: fontProbe.nodeId });
            const face = platformFonts.fonts.find((font) => font.glyphCount > 0);
            if (face != null) {
              marker.resolvedFontFace = {
                familyName: face.familyName,
                ...(face.postScriptName !== '' ? { postScriptName: face.postScriptName } : {}),
                isCustomFont: face.isCustomFont,
              };
            }
          }
        } finally {
          await page.evaluate((id) => {
            document.querySelector(`[data-domotion-line-clamp-font-probe="${id}"]`)?.remove();
          }, fontProbeId).catch(() => undefined);
        }
        const advance = marker.shapedWidth ?? (vertical ? marker.height : marker.width);
        const physicalBoundary = vertical
          ? (direction === 'rtl' ? best.rect.top : best.rect.bottom)
          : (direction === 'rtl' ? best.rect.left : best.rect.right);
        const boundary = physicalBoundary - (vertical ? viewport.y : viewport.x);
        const start = direction === 'rtl' ? boundary - advance : boundary;
        marker.inlineOffset = start;
        if (vertical) {
          marker.y = start;
          marker.yOffsets = [start];
        } else {
          marker.x = start;
          marker.xOffsets = [start];
        }
        trimClampLineSource(root, marker, boundary);
        unresolved.delete(probeId);
      } finally {
        delete marker.lineClampProbeId;
      }
    }
  } catch {
    // Per-target warnings below make an unavailable AX domain visible to every
    // caller; never silently present the provisional DOM edge as exact.
  } finally {
    for (const probeId of unresolved) {
      warnings.push({
        selector: `[data-domotion-line-clamp-probe="${probeId}"]`,
        feature: 'line-clamp generated ellipsis',
        detail: 'Chromium AX did not expose the generated InlineTextBox; retained bounded provisional DOM geometry (DM-2417)',
      });
    }
    await page.evaluate(() => {
      for (const element of document.querySelectorAll('[data-domotion-line-clamp-probe]')) {
        element.removeAttribute('data-domotion-line-clamp-probe');
      }
    }).catch(() => undefined);
    await session.send('Accessibility.disable').catch(() => undefined);
    await session.detach().catch(() => undefined);
  }
}
