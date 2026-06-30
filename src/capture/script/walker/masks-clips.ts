// @ts-nocheck
//
// CSS mask discovery: walks each element's `cs.mask` / `cs.maskImage`
// (incl. `-webkit-` prefix) and routes the mask source into one of three
// emission paths:
//
//   1. Same-document fragment ref (`mask-image: url("#id")`) — collected
//      into the `maskDefs` map keyed by id; the renderer emits the
//      referenced inline `<mask>` element's outerHTML into the output SVG.
//
//   2. Same-document element ref (`mask-image: element(#id)`) — the
//      referenced element is tagged with `data-domotion-rid` and recorded
//      in `maskRasters` so the Node-side post-capture rasterize pass can
//      screenshot it and fill in `dataUri`. Null entries are kept to
//      remember "we already checked this id and the target was unusable",
//      letting the discovery loop short-circuit on the next consumer.
//
//   3. Everything else gets a warning (gradient / url() mask sources are
//      supported but emitted later in the pipeline so they don't need
//      walker-level work). External-file fragment refs
//      (`mask-image: url("./file.svg#id")`) are resolved *before* this walk by
//      the `inlineExternalSvgRefs` pre-pass (DM-496) — inlined as a
//      same-document `<mask>` def + the ref rewritten to `url(#id)` — so by
//      here they look like case 1; a warning here means that pre-pass couldn't
//      resolve it (fetch failed / non-http / missing fragment).
//
// The pass-through CSS mask properties (mask, maskImage, maskMode,
// maskSize, maskPosition, maskRepeat, maskComposite) live in the captured
// style sub-object and are emitted by the renderer separately — that's
// handled inline by captureInner, not here.
//
// clip-path: only the "skip the whole subtree" inset(>=50%) short-circuit
// is handled in captureInner alongside the other early-return predicates
// (zero-size, fixed-tiny-with-overflow). Moving it out would mean the
// handler returns a sentinel and the walker checks it — net loss for
// readability. The plain `clipPath: cs.clipPath` field in the style
// sub-object is renderer-side work, not walker-side.
//
// The factory owns `maskDefs`, `maskRasters`, and `maskRasterIdx`. The
// captureScript orchestration tail reads `maskDefs` / `maskRasters` after
// the walk completes and stamps them onto the root captured element.

export const createMasksClipsHandler = ({ vp, warn }) => {
  const maskDefs = new Map();
  const maskRasters = new Map();
  const clipPathDefs = new Map();
  let maskRasterIdx = 0;

  const discoverMasks = (el, cs, sel) => {
    if (!cs.mask || cs.mask === 'none' || cs.mask === '') return;
    // DM-1446: resolve same-document fragment refs against the element's OWN
    // document so a mask/clip/filter def living inside a recursed same-origin
    // <iframe> is found. For top-document elements this is `document` (no
    // behavior change).
    const doc = el.ownerDocument || document;

    // DM-470: only warn for mask sources we can't emit. Gradient and url()
    // mask-images round-trip cleanly through buildMaskDef() with size /
    // position / repeat / composite — those don't deserve a per-element
    // warning. element() paint references and inline-SVG fragment URLs
    // are the actual gaps; flag those instead.
    // See docs/20-css-mask-emission.md.
    const miSrc = cs.maskImage || cs.webkitMaskImage || '';

    // DM-493: same-document fragment refs (mask-image: url("#id")) are
    // resolved at capture time and emitted as inline <mask> defs.
    const fragMatch = /^url\(\s*(?:"|')?#([^"')\s]+)(?:"|')?\s*\)$/i.exec(miSrc);
    if (fragMatch != null) {
      const fragId = fragMatch[1];
      if (!maskDefs.has(fragId)) {
        const target = doc.getElementById(fragId);
        if (target != null && target.tagName.toLowerCase() === 'mask') {
          maskDefs.set(fragId, { id: fragId, outerHTML: target.outerHTML });
        } else {
          warn(sel, 'mask', 'mask-image fragment "#' + fragId + '" did not resolve to an inline <mask> element');
        }
      }
      return;
    }

    // External-file fragment refs (url("./file.svg#id")) — resolved before this
    // walk by the inlineExternalSvgRefs pre-pass (DM-496), which fetches the
    // file, inlines the <mask> as a same-document def, and rewrites the ref to
    // url(#id) (handled by the same-document branch above). Reaching here means
    // that pre-pass couldn't (fetch failed, non-http origin, or missing/wrong-
    // tag fragment) → the element paints unmasked, the prior baseline.
    const extFragMatch = /^url\(\s*(?:"|')?[^"')#]+#[^"')\s]+(?:"|')?\s*\)$/i.exec(miSrc);
    if (extFragMatch != null) {
      warn(sel, 'mask', 'external-file SVG mask-image fragment ref (url("./file.svg#id")) could not be resolved — element renders unmasked');
      return;
    }

    // DM-494: mask-image: element(#id) — record the referenced element for
    // post-capture rasterisation. Same-document only (CSS spec doesn't
    // define cross-document element()). Always-on (not opt-in) — dedupe by
    // id so multiple consumers share one screenshot, and skip when the
    // target is display:none / 0-area (painted output is empty so the
    // screenshot would just hide the mask anyway).
    const elementMatch = /^element\(\s*#([^)\s]+)\s*\)$/i.exec(miSrc);
    if (elementMatch != null) {
      const refId = elementMatch[1];
      if (maskRasters.has(refId)) return;
      // DM-1446/DM-1447: resolve the element() target against the consumer's own
      // document (inner-iframe targets too). The node-side rasterize pass
      // (rasterizeMaskSources) is frame-aware — it locates the rid'd target
      // across page.frames() and isolates it through the enclosing <iframe>
      // chain — so a target inside a recursed iframe is screenshotted correctly.
      const refTarget = doc.getElementById(refId);
      if (refTarget == null) {
        warn(sel, 'mask', 'mask-image: element(#' + refId + ') target not found in document');
        return;
      }
      const refCs = window.getComputedStyle(refTarget);
      if (refCs.display === 'none' || refCs.visibility === 'hidden') {
        warn(sel, 'mask', 'mask-image: element(#' + refId + ') target is display:none / hidden — emitting empty mask');
        maskRasters.set(refId, null);
        return;
      }
      const refRect = refTarget.getBoundingClientRect();
      if (refRect.width <= 0 || refRect.height <= 0) {
        warn(sel, 'mask', 'mask-image: element(#' + refId + ') target has zero-area painted box — emitting empty mask');
        maskRasters.set(refId, null);
        return;
      }
      // Animated source warning — capture is one frame, no way to keep the
      // mask in sync with a JS-driven canvas / CSS animation. Emit the
      // snapshot anyway (better than the alternative of empty mask hiding
      // the consumer entirely).
      if (typeof refTarget.getAnimations === 'function') {
        try {
          const anims = refTarget.getAnimations();
          if (anims != null && anims.length > 0) {
            warn(sel, 'mask', 'mask-image: element(#' + refId + ') target has ' + anims.length + ' active animation(s); the rasterized snapshot is t=0 only');
          }
        } catch (e) { /* getAnimations not supported, skip */ }
      }
      const refRid = 'mr' + (maskRasterIdx++);
      refTarget.setAttribute('data-domotion-rid', refRid);
      maskRasters.set(refId, {
        id: refId,
        rid: refRid,
        width: refRect.width,
        height: refRect.height,
        rect: {
          x: refRect.left - vp.x,
          y: refRect.top - vp.y,
          width: refRect.width,
          height: refRect.height,
        },
      });
      return;
    }

    const supported = /^(?:repeating-)?(?:linear|radial)-gradient\(/i.test(miSrc)
      || /^url\(/i.test(miSrc);
    if (!supported) {
      warn(sel, 'mask', 'non-gradient/non-url()/non-element() mask source — not emitted');
    }
  };

  // DM-826: clip-path: url("#id") same-document fragment ref. Resolves the
  // fragment to an inline `<clipPath>` element and stashes its outerHTML so
  // the renderer can emit it into the output SVG `<defs>`. See
  // `docs/39-clip-path-fragment-references.md`.
  //
  // Scope: same-document `<clipPath>` defs with `clipPathUnits="objectBoundingBox"`
  // (SVG auto-scales natively) or the default `userSpaceOnUse` (the renderer
  // mints a per-element translated copy — DM-828). External-file refs
  // (`url("./shapes.svg#id")`) are resolved *before* this walk by the
  // `inlineExternalSvgRefs` pre-pass (DM-829), which fetches the file, inlines
  // the `<clipPath>` as a same-document def, and rewrites the element's ref to
  // `url(#id)` — so by the time we get here a successfully-resolved external ref
  // looks like any same-document fragment. The `extFragMatch` branch below only
  // fires when that pre-pass couldn't resolve it (fetch failed / non-http).
  const discoverClipPaths = (el, cs, sel) => {
    const cp = cs.clipPath;
    if (!cp || cp === 'none' || cp === '') return;
    const doc = el.ownerDocument || document; // DM-1446: resolve inner-iframe defs

    // Strip an optional <geometry-box> keyword (`padding-box` / `border-box` /
    // …) before the url(...) check — `clip-path: url(#id) padding-box` is
    // valid per CSS Masking 1 §3.1. The renderer's geo-box handling is
    // shape-side; here we only care about the url() form.
    const cpShape = cp.replace(/\b(?:content-box|padding-box|border-box|margin-box|fill-box|stroke-box|view-box)\b/i, '').trim();
    const fragMatch = /^url\(\s*(?:"|')?#([^"')\s]+)(?:"|')?\s*\)$/i.exec(cpShape);
    if (fragMatch != null) {
      const fragId = fragMatch[1];
      if (!clipPathDefs.has(fragId)) {
        const target = doc.getElementById(fragId);
        if (target != null && target.tagName.toLowerCase() === 'clippath') {
          // SVG default for clipPathUnits is userSpaceOnUse (DM-828): the
          // renderer translates those per-consumer; objectBoundingBox is shared.
          const units = (target.getAttribute('clipPathUnits') || 'userSpaceOnUse').toLowerCase();
          clipPathDefs.set(fragId, {
            id: fragId,
            outerHTML: target.outerHTML,
            clipPathUnits: units === 'objectboundingbox' ? 'objectBoundingBox' : 'userSpaceOnUse',
          });
        } else {
          warn(sel, 'clip-path', 'clip-path fragment "#' + fragId + '" did not resolve to an inline <clipPath> element');
        }
      }
      return;
    }
    const extFragMatch = /^url\(\s*(?:"|')?[^"')#]+#[^"')\s]+(?:"|')?\s*\)$/i.exec(cpShape);
    if (extFragMatch != null) {
      // The inlineExternalSvgRefs pre-pass (DM-829) rewrites resolvable
      // external refs to same-document before this walk; reaching here means it
      // couldn't (fetch failed, non-http origin, or missing fragment) — the
      // element renders unclipped, same as the pre-DM-829 baseline.
      warn(sel, 'clip-path', 'external-file SVG fragment ref (url("./file.svg#id")) could not be resolved — element renders unclipped');
    }
  };

  // DM-934: CSS `filter: url(#id)` referencing an inline SVG `<filter>` def.
  // Same shape as discoverClipPaths but for filters — collect the def keyed
  // by id, the renderer copies it into the output SVG <defs> verbatim and
  // the existing pass-through emit of `cs.filter` as an inline style on the
  // element's group wrapper does the rest (the browser's SVG renderer
  // resolves `filter="url(#id)"` against the same-document def).
  //
  // Multi-value forms like `filter: blur(2px) url(#svg-glow)` collect every
  // url(#id) found in the value; each gets its own captured def.
  const filterDefs = new Map();
  const discoverFilters = (el, cs, sel) => {
    const f = cs.filter;
    if (!f || f === 'none' || f === '') return;
    const doc = el.ownerDocument || document; // DM-1446: resolve inner-iframe defs

    const re = /url\(\s*(?:"|')?#([^"')\s]+)(?:"|')?\s*\)/gi;
    let m;
    while ((m = re.exec(f)) != null) {
      const fragId = m[1];
      if (filterDefs.has(fragId)) continue;
      const target = doc.getElementById(fragId);
      if (target != null && target.tagName.toLowerCase() === 'filter') {
        filterDefs.set(fragId, { id: fragId, outerHTML: target.outerHTML });
      } else {
        warn(sel, 'filter', 'filter fragment "#' + fragId + '" did not resolve to an inline <filter> element');
      }
    }
  };

  return { discoverMasks, discoverClipPaths, discoverFilters, maskDefs, maskRasters, clipPathDefs, filterDefs };
};
