// @ts-nocheck
//
// <img> / <input type=image> source facts and the broken-image seed record, extracted from the capture
// script's `captureInner`. Part of the page-`evaluate`d CAPTURE_SCRIPT bundle — self-contained, page globals
// only; every input is an explicit parameter.

export const captureImageElement = ({ el, tag, rect, vp, sel, effectiveZoomFor, sourceNodeIndex }) => {
  let imageSrc = undefined;
  let imageIntrinsic;
  let imageEffectiveZoom;
  let imageBroken;
  let imageAlt;
  let brokenImageFallback;
  if (tag === "img") {
    // currentSrc is the URL the browser actually resolved + loaded (from
    // srcset / <picture> <source>). Fall back to src when currentSrc is empty.
    imageSrc = el.currentSrc || el.src;
    // Intrinsic <img> dims — used by the renderer for object-fit: none.
    if (el.naturalWidth > 0 && el.naturalHeight > 0) {
      imageIntrinsic = { w: el.naturalWidth, h: el.naturalHeight };
      imageEffectiveZoom = effectiveZoomFor(el);
    }
    // Broken-image fallback (DM-372): el.complete && naturalWidth===0 means
    // the browser tried to load and failed (or src was empty). Chrome paints
    // a small broken-image icon plus the alt text inline. Capture both so
    // the renderer can synthesize the same fallback.
    imageBroken = el.complete && el.naturalWidth === 0;
    imageAlt = el.alt || "";
    // Seed only light-DOM/source facts here. Closed UA-shadow ownership,
    // used geometry, text shaping/font facts, and AX semantics are attached
    // by the Node/CDP post-pass while the private live-node registry exists.
    var _imageHasSrc = el.hasAttribute("src");
    var _imageHasAlt = el.hasAttribute("alt");
    var _imageHasTitle = el.hasAttribute("title");
    brokenImageFallback = {
      schemaVersion: 1,
      authority: "chromium-ua-shadow-v1",
      sourceNodeIndex: sourceNodeIndex,
      selector: sel,
      effectiveZoom: effectiveZoomFor(el),
      hostRect: {
        x: rect.left - vp.x,
        y: rect.top - vp.y,
        width: rect.width,
        height: rect.height,
      },
      source: {
        complete: el.complete === true,
        naturalWidth: Number(el.naturalWidth) || 0,
        naturalHeight: Number(el.naturalHeight) || 0,
        currentSrc: el.currentSrc || "",
        src: { present: _imageHasSrc, value: _imageHasSrc ? el.getAttribute("src") : null },
        alt: { present: _imageHasAlt, value: _imageHasAlt ? el.getAttribute("alt") : null },
        title: { present: _imageHasTitle, value: _imageHasTitle ? el.getAttribute("title") : null },
        // Blink HTMLImageElement::AltText: a present alt wins even when it
        // is empty; title is consulted only when alt is absent.
        resolvedText: _imageHasAlt
          ? el.getAttribute("alt") || ""
          : _imageHasTitle
            ? el.getAttribute("title") || ""
            : "",
      },
    };
  } else if (tag === "input" && el.type === "image") {
    // <input type="image"> renders the src as a clickable button-image.
    // No currentSrc / naturalWidth on HTMLInputElement; the bounding rect
    // already reflects width/height attributes or the image's natural size.
    imageSrc = el.src;
  }
  return { imageSrc, imageIntrinsic, imageEffectiveZoom, imageBroken, imageAlt, brokenImageFallback };
};
