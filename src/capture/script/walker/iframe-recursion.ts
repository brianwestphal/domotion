//
// Same-origin and allowlisted cross-origin <iframe> recursion.
// Extracted from the capture script's orchestrator (`captureDocumentTree`).
// Part of the page-`evaluate`d CAPTURE_SCRIPT bundle — self-contained, page globals only;
// everything the orchestrator owns is passed in through the factory argument.

import { frameHostAllowed } from "../cross-origin.js";
import type { CrossOriginAllowlist } from "../cross-origin.js";
import type { CapturedElement } from "../../types.js";
import { sideWidths } from "../utils.js";

type FrameAuthority = NonNullable<CapturedElement["frameScrollIdentity"]> & { token?: string };

export const createIframeRecursionHandler = (ctx: {
  _counterPreWalk: (root: Element) => void;
  _crossOriginAllow: CrossOriginAllowlist | null;
  _fixedAncestors: Set<Element>;
  _frameScrollKey: string;
  _runCounterStylePrewalk: (doc?: Document) => void;
  _transformInfluenced: Set<Element>;
  capture: (el: Element) => CapturedElement | null;
  normColor: (color: string) => string;
  vp: { x: number; y: number; width: number; height: number };
}) => {
  const {
    _counterPreWalk,
    _crossOriginAllow,
    _fixedAncestors,
    _frameScrollKey,
    _runCounterStylePrewalk,
    _transformInfluenced,
    capture,
    normColor,
    vp,
  } = ctx;
  // DM-1441: is this frame cross-origin relative to the top document? Under the
  // Same-Origin Policy a cross-origin `contentDocument` is null, so in the
  // default (no browser flags) configuration this only ever returns false for
  // genuinely accessible frames. It exists so that if a frame's document is
  // readable ONLY because web security was disabled (the planned
  // `--cross-origin-frames` path), Phase-1 same-origin recursion refuses to
  // recurse it until the allowlist gate is wired. srcdoc / about:blank report
  // origin "null" (or inherit the embedder) — treated as same-origin.
  function _frameIsCrossOrigin(el: HTMLIFrameElement): boolean {
    try {
      var w = el.contentWindow;
      if (w == null) return true;
      var o = w.location && w.location.origin;
      if (o == null || o === "" || o === "null") return false;
      return o !== location.origin;
    } catch (e) {
      return true;
    }
  }

  // DM-1442: is a cross-origin frame permitted by the `--cross-origin-frames`
  // allowlist? Matched against the frame's CURRENT origin (readable here only
  // because web security was disabled to make the document accessible),
  // falling back to the `src` attribute. null allowlist ⇒ never (Phase 1).
  function _crossOriginFrameAllowed(el: HTMLIFrameElement): boolean {
    if (_crossOriginAllow == null) return false;
    var url;
    try {
      url = el.contentWindow && el.contentWindow.location ? el.contentWindow.location.href : el.src;
    } catch (e) {
      url = el.src;
    }
    return frameHostAllowed(url || "", _crossOriginAllow);
  }

  // DM-2537: child authority must be from this exact capture, carry the same
  // allowlist digest as the current document, and name the current Chromium
  // frame as its protocol parent. Failure is a raster boundary, never a URL- or
  // DOM-order fallback.
  function _iframeFrameAuthority(el: HTMLIFrameElement): FrameAuthority | null {
    if (_frameScrollKey === "") return null;
    try {
      // Node binds the child authority to this exact Chromium frame-owner
      // Element. Unlike reading a property through contentWindow, this remains
      // available for an inaccessible cross-origin child and can therefore
      // identify the raster boundary without crossing the Same-Origin Policy.
      var child = (el as unknown as Record<string, FrameAuthority | undefined>)[_frameScrollKey];
      var parentView = el.ownerDocument && el.ownerDocument.defaultView;
      var parent = parentView && (parentView as unknown as Record<string, FrameAuthority | undefined>)[_frameScrollKey];
      if (child == null || parent == null) return null;
      if (child.source !== "chromium-cdp-frame-scroll-v1" || parent.source !== "chromium-cdp-frame-scroll-v1")
        return null;
      if (child.captureId !== parent.captureId) return null;
      if (child.allowlistSha256 !== parent.allowlistSha256) return null;
      if (child.parentFrameId !== parent.frameId) return null;
      if (typeof child.frameId !== "string" || child.frameId === "") return null;
      if (child.access === "same-origin" || child.access === "cross-origin-allowlisted") {
        // A document navigation replaces the child global but not necessarily
        // its iframe owner Element or Chromium FrameId. Require the live child
        // main-world token before using the earlier allowlist decision, so a
        // navigation during the async prepasses can only become a raster.
        var childView = el.contentWindow;
        var liveChild =
          childView && (childView as unknown as Record<string, FrameAuthority | undefined>)[_frameScrollKey];
        if (
          liveChild == null ||
          liveChild.token !== child.token ||
          liveChild.frameId !== child.frameId ||
          liveChild.captureId !== child.captureId ||
          liveChild.allowlistSha256 !== child.allowlistSha256
        )
          return null;
      }
      return child;
    } catch (e) {
      return null;
    }
  }

  // DM-1441 / DM-1442: the accessible document of an <iframe> we may recurse, or
  // null when the frame can't be recursed (cross-origin and not allowlisted,
  // not yet loaded, a media/pixel frame with no DOM, or access throws). Used
  // both to gate the recursion and to decide whether to emit the "rendered as a
  // raster" warning.
  function _iframeIsRecursable(el: HTMLIFrameElement): Document | null {
    if (el.tagName == null || el.tagName.toLowerCase() !== "iframe") return null;
    var doc;
    try {
      doc = el.contentDocument;
    } catch (e) {
      return null;
    }
    if (doc == null || doc.body == null || doc.documentElement == null) return null;
    if (_frameScrollKey !== "") {
      var authority = _iframeFrameAuthority(el);
      if (authority == null) return null;
      if (authority.access !== "same-origin" && authority.access !== "cross-origin-allowlisted") return null;
    }
    // Same-origin frames always recurse (Phase 1). A cross-origin frame is only
    // reachable here when web security was disabled (the --cross-origin-frames
    // path); recurse it only when its origin is on the allowlist, else leave it
    // as the raster snapshot. (DM-1442)
    if (_frameIsCrossOrigin(el) && !_crossOriginFrameAllowed(el)) return null;
    return doc;
  }

  // DM-1441: walk a same-origin iframe's document into a native-SVG subtree in
  // the parent's coordinate space. Rather than offsetting every captured
  // coordinate field after the fact, we shift the SHARED `vp` origin for the
  // duration of the inner walk: every capture helper reads `vp.x`/`vp.y` live,
  // so the inner subtree comes out already positioned at the iframe's content
  // box AND the viewport cull tests inner content against the real painted
  // region. The shift composes correctly for nested iframes (each inner rect is
  // relative to its own frame's viewport, so successive shifts accumulate the
  // content-box origins down the chain). Returns the inner <html> node, or
  // undefined when the frame isn't recursable.
  function _captureIframeRecursion(
    el: HTMLIFrameElement,
    cs: CSSStyleDeclaration,
    rect: DOMRect,
  ): CapturedElement | undefined {
    var doc = _iframeIsRecursable(el);
    if (doc == null) return undefined;
    // Content-box top-left of the iframe in top-document client coords. The
    // inner document's own viewport origin (0,0) sits here, so adding it to the
    // inner rects places them in the parent's space.
    var bsw = sideWidths(cs, "border", "Width");
    var dx = rect.left + bsw.left + (parseFloat(cs.paddingLeft) || 0);
    var dy = rect.top + bsw.top + (parseFloat(cs.paddingTop) || 0);
    var savedX = vp.x,
      savedY = vp.y;
    vp.x = savedX - dx;
    vp.y = savedY - dy;
    var node: CapturedElement | null | undefined;
    try {
      // DM-1443: run the pre-passes (cull exemptions, cumulative scale, CSS
      // counters, @counter-style) against the inner document FIRST — with `vp`
      // already shifted — so the inner walk resolves counters, pre-scales text
      // metrics under inner transforms/zoom, and keeps in-viewport fixed/sticky/
      // transformed inner content. Without this the inner walk reused the outer
      // document's pre-pass state, which has no inner-element entries.
      _runInnerDocumentPrePasses(doc);
      node = capture(doc.documentElement);
    } catch (e) {
      node = undefined;
    } finally {
      vp.x = savedX;
      vp.y = savedY;
    }
    if (node == null) return undefined;
    // DM-1448: fill the iframe canvas. When the iframe is taller than its inner
    // content, Chrome paints the inner document's CANVAS background across the
    // whole inner viewport — by CSS background propagation, the canvas color is
    // the <html> background if opaque, else the propagated <body> background,
    // else transparent (the iframe is see-through). The recursed inner <html>
    // node only spans the content height, leaving the strip below it unpainted.
    // Set the inner <html> node's background to the resolved canvas color and
    // stretch it to the inner viewport box so the strip fills correctly (the
    // body paints its own box on top — matching Chrome's html-vs-body split).
    var canvasColor = _resolveIframeCanvasColor(doc);
    if (canvasColor != null) {
      node.styles.backgroundColor = canvasColor;
      var vpW = doc.documentElement.clientWidth || node.width;
      var vpH = doc.documentElement.clientHeight || node.height;
      if (node.width < vpW) node.width = vpW;
      if (node.height < vpH) node.height = vpH;
    }
    return node;
  }

  // DM-1448: the inner document's resolved canvas background color (CSS
  // background propagation), or null when the canvas is transparent (no fill —
  // the iframe stays see-through, as Chrome paints it). `<html>` wins when
  // opaque; otherwise `<body>` propagates to the canvas.
  function _isOpaqueColor(c: string | null | undefined): boolean {
    return c != null && c !== "" && c !== "transparent" && !/,\s*0\s*\)\s*$/.test(c);
  }
  function _resolveIframeCanvasColor(doc: Document): string | null {
    var htmlBg = getComputedStyle(doc.documentElement).backgroundColor;
    if (_isOpaqueColor(htmlBg)) return normColor(htmlBg);
    var bodyBg = doc.body != null ? getComputedStyle(doc.body).backgroundColor : null;
    if (bodyBg != null && _isOpaqueColor(bodyBg)) return normColor(bodyBg);
    return null;
  }

  // DM-1443: populate the shared pre-pass state for a recursed iframe's inner
  // document, mirroring the outer-document pre-passes in the orchestration tail.
  // Deliberately a SEPARATE implementation from the outer inline loops rather
  // than a shared refactor: the outer path is the hot path every fixture
  // exercises, so we leave it byte-identical and isolate the inner-iframe code
  // here. Adds inner elements to `_fixedAncestors` / `_transformInfluenced`,
  // snapshots inner counters into `_counterSnapshot`, and folds the iframe's own
  // `@counter-style` rules into `_counterStyles`. Runs with `vp` already shifted
  // to the iframe's space so the cull tests use the real painted region.
  function _runInnerDocumentPrePasses(doc: Document): void {
    var rootEl = doc.documentElement;
    var allEls = rootEl.getElementsByTagName("*");
    // position:fixed / sticky in-viewport ancestors (DM-513).
    for (var i = 0; i < allEls.length; i++) {
      var el = allEls[i];
      var pos = getComputedStyle(el).position;
      if (pos !== "fixed" && pos !== "sticky") continue;
      var r = el.getBoundingClientRect();
      if (r.right < vp.x || r.bottom < vp.y || r.left > vp.x + vp.width || r.top > vp.y + vp.height) continue;
      var cur = el.parentElement;
      while (cur != null && cur !== rootEl.parentElement) {
        if (_fixedAncestors.has(cur)) break;
        _fixedAncestors.add(cur);
        cur = cur.parentElement;
      }
    }
    // transform-influenced subtree exemptions (DM-587 / DM-637).
    for (var t = 0; t < allEls.length; t++) {
      var tel = allEls[t];
      var tt = getComputedStyle(tel).transform;
      if (tt === "none" || tt === "") continue;
      _transformInfluenced.add(tel);
      var tdescs = tel.getElementsByTagName("*");
      for (var td = 0; td < tdescs.length; td++) _transformInfluenced.add(tdescs[td]);
    }
    // CSS counters + @counter-style for the inner document.
    _counterPreWalk(rootEl);
    _runCounterStylePrewalk(doc);
  }

  return { _captureIframeRecursion, _iframeFrameAuthority, _iframeIsRecursable };
};
