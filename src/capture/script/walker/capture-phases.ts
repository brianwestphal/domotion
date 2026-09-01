// @ts-nocheck
//
// Source-owned phase boundaries for the in-page element walker. These helpers
// are ordinary ESM for direct unit testing, but build-capture-script bundles
// them into the one self-contained browser injection used by page.evaluate().

export function captureGeometryStylePhase({
  el,
  cs,
  rect,
  vp,
  fixedAncestors,
  transformInfluenced,
  animInfluenced,
  isOutsideCaptureViewport,
}) {
  const outsideViewport = isOutsideCaptureViewport(rect, vp);
  // Ruby base/annotation boxes belong to the parent's ruby column. In vertical
  // layout their own DOMRects may lie outside a retained, visible owner.
  const rubyTag = el.tagName == null ? '' : el.tagName.toLowerCase();
  let rubyOwner = el.parentElement;
  while (rubyOwner != null) {
    const ownerTag = rubyOwner.tagName == null ? '' : rubyOwner.tagName.toLowerCase();
    if (ownerTag !== 'ruby' && ownerTag !== 'rt' && ownerTag !== 'rp') break;
    rubyOwner = rubyOwner.parentElement;
  }
  const rubyFragmentOfVisibleParent = (rubyTag === 'ruby' || rubyTag === 'rt' || rubyTag === 'rp')
    && rubyOwner != null
    && !isOutsideCaptureViewport(rubyOwner.getBoundingClientRect(), vp);
  if (outsideViewport && !rubyFragmentOfVisibleParent
      && !fixedAncestors.has(el) && !transformInfluenced.has(el) && !animInfluenced.has(el)) return null;

  // A hidden/collapsed border-collapse cell still owns shared grid edges;
  // other hidden elements do not paint. DM-375 / DM-450.
  const tag = el.tagName.toLowerCase();
  const bordersOnlyCell = (tag === 'td' || tag === 'th')
    && (cs.visibility === 'hidden' || cs.visibility === 'collapse')
    && cs.borderCollapse === 'collapse';
  if (cs.display === 'none') return null;
  if ((cs.visibility === 'hidden' || cs.visibility === 'collapse') && !bordersOnlyCell) return null;

  // Keep the content-visibility host box but never force layout or traversal
  // of its skipped subtree. DM-750.
  const contentVisibilityHidden = cs.contentVisibility === 'hidden';
  // Standard visually-hidden/sr-only recipes retain DOM text but no pixels.
  // Reject all three common forms before text capture. DM-580.
  const clip = cs.clip || '';
  if (clip !== 'auto' && clip !== '' && clip !== 'normal') {
    const match = clip.match(/rect\(\s*([^,\s]+)[ ,]+([^,\s]+)[ ,]+([^,\s]+)[ ,]+([^)\s]+)\s*\)/);
    if (match != null
        && parseFloat(match[1]) === 0 && parseFloat(match[2]) === 0
        && parseFloat(match[3]) === 0 && parseFloat(match[4]) === 0) return null;
  }
  const clipPath = cs.clipPath || '';
  if (clipPath.indexOf('inset(') === 0) {
    const match = clipPath.match(/inset\(\s*([0-9.]+)\s*%/);
    if (match != null && parseFloat(match[1]) >= 50) return null;
  }
  if (rect.width <= 1 && rect.height <= 1
      && (cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.overflowY === 'hidden')
      && (cs.position === 'absolute' || cs.position === 'fixed')) return null;

  // Empty zero-size boxes do not paint, except animated boxes, zero-advance
  // combining-mark ink, and images awaiting UA-shadow fallback classification.
  const zeroSized = rect.width === 0 || rect.height === 0;
  const hasAnimation = el.dataset != null
    && el.dataset.domotionAnim != null
    && el.dataset.domotionAnim !== '';
  const inkTextZeroWidth = rect.width === 0 && rect.height > 0
    && el.textContent != null && el.textContent.trim().length > 0;
  const keepImageFallbackState = tag === 'img';
  if (zeroSized && el.children.length === 0 && !hasAnimation
      && !inkTextZeroWidth && !keepImageFallbackState) return null;

  return {
    rect,
    tag,
    outsideViewport,
    bordersOnlyCell,
    contentVisibilityHidden,
    zeroSized,
  };
}

export function normalizePseudoShadowPhase({
  el,
  pseudoFragmentFacts,
  fontFamilyStackFor,
  nativeDecorationRefs,
  nativeDecorationKinds,
}) {
  if (Array.isArray(pseudoFragmentFacts)) {
    for (const fact of pseudoFragmentFacts) {
      if (fact?.typography?.fontFamily == null) continue;
      fact.typography.fontFamilyStack = fontFamilyStackFor(
        el,
        fact.typography.fontFamily,
        fact.pseudo,
      );
    }
  }

  const nativeDecorationParts = [];
  const missingNativeDecorationKinds = [];
  let nativeDecorationUnavailableReason;
  for (let kindIndex = 0; kindIndex < nativeDecorationKinds.length; kindIndex++) {
    const kind = nativeDecorationKinds[kindIndex];
    if (kind === 'menulist-button-arrow') continue;
    let found = false;
    for (let refIndex = 0; refIndex < nativeDecorationRefs.length; refIndex++) {
      const entry = nativeDecorationRefs[refIndex];
      if (entry == null || entry.kind !== kind || !(entry.node instanceof Element)) continue;
      found = true;
      if (kind === 'file-selector-button'
          && (entry.ownership == null || entry.ownership.effectiveAppearance == null)) {
        nativeDecorationUnavailableReason = entry.ownership && entry.ownership.reason
          ? entry.ownership.reason
          : 'file-selector child EffectiveAppearance unavailable';
      }
      const part = entry.node;
      const partStyle = getComputedStyle(part);
      const partRect = part.getBoundingClientRect();
      const partOpacity = parseFloat(partStyle.opacity);
      if (part.isConnected && partStyle.display !== 'none'
          && partStyle.visibility === 'visible'
          && (!isFinite(partOpacity) || partOpacity > 0)
          && partRect.width > 0 && partRect.height > 0) {
        nativeDecorationParts.push({
          kind,
          index: refIndex,
          x: partRect.left,
          y: partRect.top,
          width: partRect.width,
          height: partRect.height,
        });
      }
    }
    if (!found) missingNativeDecorationKinds.push(kind);
  }

  const auxiliaryKinds = nativeDecorationKinds.indexOf('file-selector-button') >= 0
    ? ['file-selector-status']
    : (nativeDecorationKinds.indexOf('menulist-button-arrow') >= 0 ? ['select-inner'] : []);
  for (const kind of auxiliaryKinds) {
    let found = false;
    for (let refIndex = 0; refIndex < nativeDecorationRefs.length; refIndex++) {
      const entry = nativeDecorationRefs[refIndex];
      if (entry == null || entry.kind !== kind || !(entry.node instanceof Element)) continue;
      found = true;
      const partRect = entry.node.getBoundingClientRect();
      if (entry.node.isConnected && partRect.width >= 0 && partRect.height >= 0) {
        nativeDecorationParts.push({
          kind,
          index: refIndex,
          x: partRect.left,
          y: partRect.top,
          width: partRect.width,
          height: partRect.height,
        });
      }
    }
    if (!found) missingNativeDecorationKinds.push(kind);
  }

  return {
    nativeDecorationParts,
    missingNativeDecorationKinds,
    nativeDecorationUnavailableReason,
  };
}

export function captureTraversalPhase({ el, tag, contentVisibilityHidden, capture }) {
  const children = [];
  if (contentVisibilityHidden) return children;
  for (const child of el.children) {
    if (tag === 'details' && !el.open && child.tagName.toLowerCase() !== 'summary') continue;
    if (tag === 'select'
        && (child.tagName.toLowerCase() === 'option' || child.tagName.toLowerCase() === 'optgroup')) continue;
    const captured = capture(child);
    if (captured == null) continue;
    const group = captured.scrollMarkerGroup;
    const before = captured._scrollMarkerGroupBefore;
    delete captured.scrollMarkerGroup;
    delete captured._scrollMarkerGroupBefore;
    const buttons = captured.scrollButtons;
    delete captured.scrollButtons;
    if (group && before) children.push(group);
    children.push(captured);
    if (group && !before) children.push(group);
    if (buttons) for (let index = 0; index < buttons.length; index++) children.push(buttons[index]);
  }
  return children;
}

export function assembleCaptureResultPhase({
  captured,
  el,
  cs,
  tag,
  rect,
  vp,
  bordersOnlyCell,
  detectInlineFragments,
  iframeFrameAuthority,
  captureIframeRecursion,
  handleReplacedElement,
  captureScrollMarkerGroup,
  captureScrollButtons,
}) {
  detectInlineFragments(el, cs, vp, captured);
  if (bordersOnlyCell) {
    captured.text = '';
    captured.children = [];
    captured.styles.backgroundColor = 'rgba(0, 0, 0, 0)';
    captured.styles.backgroundImage = undefined;
    captured.textSegments = undefined;
    captured.imageSrc = undefined;
    captured.svgContent = undefined;
    captured.pseudoImages = undefined;
    captured.elementRaster = undefined;
  }
  if (tag === 'iframe' && !bordersOnlyCell) {
    const authority = iframeFrameAuthority(el);
    if (authority != null) {
      captured.frameScrollIdentity = {
        source: authority.source,
        captureId: authority.captureId,
        frameId: authority.frameId,
        parentFrameId: authority.parentFrameId,
        access: authority.access,
        allowlistSha256: authority.allowlistSha256,
      };
    }
    const iframeNode = captureIframeRecursion(el, cs, rect);
    if (iframeNode != null) {
      captured.children = [iframeNode];
      captured._iframeRecursed = true;
      captured.styles.overflowX = 'hidden';
      captured.styles.overflowY = 'hidden';
    }
  }
  handleReplacedElement(el, cs, tag, rect, captured, bordersOnlyCell);
  delete captured._iframeRecursed;
  if (!bordersOnlyCell) {
    const markerGroup = captureScrollMarkerGroup(el, cs, rect);
    if (markerGroup) {
      captured.scrollMarkerGroup = markerGroup.node;
      captured._scrollMarkerGroupBefore = markerGroup.before;
    }
    const buttons = captureScrollButtons(el, cs, rect);
    if (buttons) captured.scrollButtons = buttons;
  }
  return captured;
}
