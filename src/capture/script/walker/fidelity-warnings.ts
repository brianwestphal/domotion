//
// Fidelity warnings for features the renderer cannot fully round-trip, extracted from the capture
// script's `captureInner`. They are emitted in two groups because mask/clip/filter discovery (which can
// warn itself) runs between them and warning order is part of the capture's observable output. Part of the
// page-`evaluate`d CAPTURE_SCRIPT bundle — self-contained, page globals only.

type Warn = (selector: string, feature: string, detail: string) => void;
interface FrameAuthority {
  access?: string;
  frameId?: string;
}
interface FidelityWarningsContext {
  warn: Warn;
  _iframeIsRecursable: (el: Element) => unknown;
  _iframeFrameAuthority: (el: Element) => FrameAuthority | null | undefined;
  _frameScrollKey: string;
}

export const createFidelityWarnings = (ctx: FidelityWarningsContext) => {
  const { warn, _iframeIsRecursable, _iframeFrameAuthority, _frameScrollKey } = ctx;
  /** Warnings that precede mask / clip-path / filter discovery. */
  const warnBeforeMaskDiscovery = (el: Element, cs: CSSStyleDeclaration, sel: string) => {
    if (cs.transform && cs.transform.startsWith("matrix3d")) {
      warn(sel, "transform-3d", "static 3D plane projected to vector SVG from Chromium-measured corners");
    }
    // DM-2490: backdrop-filter diagnostics belong to the Node post-pass. The
    // synchronous walk can declare a source-surface owner, but only the later
    // DOMSnapshot / CDP isolation and screenshot steps know whether Chromium
    // materialized it exactly or retained a partial/unavailable fallback.
    // writing-mode != horizontal-tb is handled via elementRaster (SK-1128)
    // — the text region is screenshot-rasterized so vertical text and
    // sideways glyph rotation come from Chromes own paint. No warning.
    if (cs.position === "fixed" || cs.position === "sticky") {
      warn(
        sel,
        "position:" + cs.position,
        "rendered as a static snapshot at t=0; scroll-following behavior is not animated",
      );
    }
  };
  /** Warnings that follow mask / clip-path / filter discovery. */
  const warnAfterMaskDiscovery = (el: Element, cs: CSSStyleDeclaration, tag: string, sel: string) => {
    if (cs.borderImageSource && cs.borderImageSource !== "none") {
      warn(sel, "border-image", "9-slice composition pending (SK-466); border-image-source ignored");
    }
    if (tag === "canvas" || tag === "video" || tag === "object" || tag === "embed") {
      warn(sel, "<" + tag + ">", "element type is not rendered by domotion");
    } else if (tag === "iframe") {
      // DM-1441: same-origin <iframe> documents recurse to native SVG (crisp,
      // scalable, selectable text). Only warn when the frame's document is
      // inaccessible (cross-origin under the Same-Origin Policy, or a
      // media/pixel frame) and it therefore stays a raster snapshot.
      if (_iframeIsRecursable(el) == null) {
        var _frameBoundary = _iframeFrameAuthority(el);
        var _frameBoundaryAccess = _frameBoundary && _frameBoundary.access;
        var _frameBoundaryId = _frameBoundary && _frameBoundary.frameId ? _frameBoundary.frameId : "unknown";
        if (_frameBoundaryAccess === "cross-origin-denied") {
          warn(
            sel,
            "<iframe>",
            "frame " +
              _frameBoundaryId +
              " was denied by this capture's cross-origin allowlist; rendered as a static Chromium raster and no child scroll state was read",
          );
        } else if (_frameBoundaryAccess === "inaccessible") {
          warn(
            sel,
            "<iframe>",
            "frame " +
              _frameBoundaryId +
              " was allowlisted/same-origin but inaccessible from the parent document; rendered as a static Chromium raster and no child scroll state was read",
          );
        } else if (
          _frameBoundaryAccess === "identity-unavailable" ||
          (_frameScrollKey !== "" && _frameBoundary == null)
        ) {
          warn(
            sel,
            "<iframe>",
            "child Chromium FrameId authority was unavailable or did not belong to this parent; rendered as a static Chromium raster and no child scroll state was read",
          );
        } else {
          warn(
            sel,
            "<iframe>",
            "cross-origin / inaccessible frame rendered as a static raster snapshot; same-origin frames recurse to native SVG",
          );
        }
      }
    }
    // DM-2481: the Node-side live-frame probe owns scrollbar warnings. Do not
    // infer object existence from overflow plus scroll/client sizes: that
    // loses width:none, overlay fade, always-on custom bars and RTL state.
    // DM-547/549/550/2327: conic-gradient layers are painted into PNG tiles by
    // the live Chromium capture pre-pass and emitted as
    // <pattern><image> via buildConicGradientDef. The previous unconditional
    // warning fired even when the layer rendered correctly — moved to
    // the raster pipeline, which warns only when a tile cannot be produced.
    // text-align: justify combined with wrapping — renderer doesn't space-stretch.
    if (cs.textAlign === "justify") {
      warn(sel, "text-align:justify", "path-mode renderer does not space-stretch justified text");
    }
  };
  return { warnBeforeMaskDiscovery, warnAfterMaskDiscovery };
};
