//
// <img> / <input type=image> source facts and the broken-image seed record, extracted from the capture
// script's `captureInner`. Part of the page-`evaluate`d CAPTURE_SCRIPT bundle — self-contained, page globals
// only; every input is an explicit parameter.

interface LayoutRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const captureImageElement = ({
  el,
  tag,
  rect,
  vp,
  sel,
  effectiveZoomFor,
  sourceNodeIndex,
}: {
  el: HTMLElement;
  tag: string;
  rect: LayoutRect;
  vp: { x: number; y: number };
  sel: string;
  effectiveZoomFor: (el: Element) => number;
  sourceNodeIndex: number | undefined;
}) => {
  let imageSrc = undefined;
  let imageIntrinsic;
  let imageEffectiveZoom;
  let imageBroken;
  let imageAlt;
  let brokenImageFallback;
  let imageEmbeddingColorScheme: "light" | "dark" | undefined;
  if (tag === "img") {
    const img = el as HTMLImageElement;
    // currentSrc is the URL the browser actually resolved + loaded (from
    // srcset / <picture> <source>). Fall back to src when currentSrc is empty.
    imageSrc = img.currentSrc || img.src;
    // Intrinsic <img> dims — used by the renderer for object-fit: none.
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      imageIntrinsic = { w: img.naturalWidth, h: img.naturalHeight };
      imageEffectiveZoom = effectiveZoomFor(el);
    }
    // Broken-image fallback (DM-372): img.complete && naturalWidth===0 means
    // the browser tried to load and failed (or src was empty). Chrome paints
    // a small broken-image icon plus the alt text inline. Capture both so
    // the renderer can synthesize the same fallback.
    imageBroken = img.complete && img.naturalWidth === 0;
    imageAlt = img.alt || "";
    // The color scheme an SVG image document sees as its preferred scheme:
    // `LayoutImageResource::GetImage` passes `StyleEngine::
    // ResolveColorSchemeForEmbedding(&img style)` to the SVG image
    // (`core/layout/layout_image_resource.cc:227-233`, `core/css/
    // style_engine.cc:4644-4656`, chromium 7d859f27). With no recognized
    // scheme in the img's color-scheme flags that is the embedder document's
    // preferred scheme; otherwise the img's used scheme
    // (`ComputedStyleBuilder::SetUsedColorScheme`, `core/style/
    // computed_style.cc:3139-3181`). A computed `normal` takes its flags
    // from the first valid `<meta name=color-scheme>` (`ApplyColorSchemeValue`,
    // `longhands_custom.cc:2582-2600`; `Document::ColorSchemeMetaChanged`,
    // `core/dom/document.cc:8243-8260`). Forced darkening is a WebView
    // setting and is off in this capture.
    const ownerDoc = el.ownerDocument;
    const ownerWin = ownerDoc.defaultView;
    const prefersDark = ownerWin != null && ownerWin.matchMedia("(prefers-color-scheme: dark)").matches;
    let schemeValue = (ownerWin != null ? ownerWin.getComputedStyle(el).colorScheme : "") || "normal";
    if (schemeValue.trim().toLowerCase() === "normal") {
      const metas = ownerDoc.documentElement != null ? ownerDoc.documentElement.getElementsByTagName("meta") : [];
      for (let mi = 0; mi < metas.length; mi++) {
        const meta = metas[mi];
        if ((meta.getAttribute("name") || "").toLowerCase() !== "color-scheme") continue;
        const content = (meta.getAttribute("content") || "").trim();
        if (content !== "" && typeof CSS !== "undefined" && CSS.supports("color-scheme", content)) {
          schemeValue = content;
          break;
        }
      }
    }
    const schemeTokens = schemeValue.toLowerCase().split(/\s+/);
    const hasDark = schemeTokens.indexOf("dark") >= 0;
    const hasLight = schemeTokens.indexOf("light") >= 0;
    const hasOnly = schemeTokens.indexOf("only") >= 0;
    imageEmbeddingColorScheme =
      !hasDark && !hasLight && !hasOnly
        ? prefersDark
          ? "dark"
          : "light"
        : (hasDark && prefersDark) || (hasDark && !hasLight)
          ? "dark"
          : "light";
    // Seed only light-DOM/source facts here. Closed UA-shadow ownership,
    // used geometry, text shaping/font facts, and AX semantics are attached
    // by the Node/CDP post-pass while the private live-node registry exists.
    var _imageHasSrc = img.hasAttribute("src");
    var _imageHasAlt = img.hasAttribute("alt");
    var _imageHasTitle = img.hasAttribute("title");
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
        complete: img.complete === true,
        naturalWidth: Number(img.naturalWidth) || 0,
        naturalHeight: Number(img.naturalHeight) || 0,
        currentSrc: img.currentSrc || "",
        src: { present: _imageHasSrc, value: _imageHasSrc ? img.getAttribute("src") : null },
        alt: { present: _imageHasAlt, value: _imageHasAlt ? img.getAttribute("alt") : null },
        title: { present: _imageHasTitle, value: _imageHasTitle ? img.getAttribute("title") : null },
        // Blink HTMLImageElement::AltText: a present alt wins even when it
        // is empty; title is consulted only when alt is absent.
        resolvedText: _imageHasAlt
          ? img.getAttribute("alt") || ""
          : _imageHasTitle
            ? img.getAttribute("title") || ""
            : "",
      },
    };
  } else if (tag === "input" && (el as HTMLInputElement).type === "image") {
    // <input type="image"> renders the src as a clickable button-image.
    // No currentSrc / naturalWidth on HTMLInputElement; the bounding rect
    // already reflects width/height attributes or the image's natural size.
    imageSrc = (el as HTMLInputElement).src;
  }
  return {
    imageSrc,
    imageIntrinsic,
    imageEffectiveZoom,
    imageBroken,
    imageAlt,
    brokenImageFallback,
    imageEmbeddingColorScheme,
  };
};
