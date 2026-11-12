//
// <img> / <input type=image> source facts and the broken-image seed record, extracted from the capture
// script's `captureInner`. Part of the page-`evaluate`d CAPTURE_SCRIPT bundle — self-contained, page globals
// only; every input is an explicit parameter.

interface PrimedContentImage {
  kind: "url" | "url-with-items" | "other-image";
  url: string;
  state: "loaded" | "error" | "pending";
  width: number;
  height: number;
}

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
  contentImageKey,
  warn,
}: {
  el: HTMLElement;
  tag: string;
  rect: LayoutRect;
  vp: { x: number; y: number };
  sel: string;
  effectiveZoomFor: (el: Element) => number;
  sourceNodeIndex: number | undefined;
  contentImageKey?: string | undefined;
  warn?: (selector: string, property: string, message: string) => void;
}) => {
  let imageSrc = undefined;
  let imageIntrinsic;
  let imageDecodedIntrinsic;
  let imageEffectiveZoom;
  let imageBroken;
  let imageAlt;
  let brokenImageFallback;
  let imageEmbeddingColorScheme: "light" | "dark" | undefined;
  let imageOrientationNone: true | undefined;
  // The img's own computed `content`, classified and loaded by the async
  // prime pass (primePseudoImageIntrinsics). A single unerrored generated
  // image owns the box in place of src and the UA fallback. An image followed
  // by other items makes an ordinary box (LayoutObject::CreateObject), so any
  // retained UA shadow still paints and the seed path below classifies it; an
  // errored first image returns layout to the src disposition.
  const primedContent: { element?: PrimedContentImage } | undefined =
    tag === "img" && typeof contentImageKey === "string" && contentImageKey !== ""
      ? Reflect.get(el, contentImageKey)
      : undefined;
  const ownContent = primedContent?.element;
  if (ownContent != null && ownContent.kind === "other-image" && warn != null) {
    warn(sel, "content", "a generated non-URL image replaces this <img>; its src is painted instead");
  }
  if (ownContent != null && ownContent.kind === "url" && ownContent.state !== "error") {
    if (ownContent.state === "loaded") {
      imageSrc = ownContent.url;
      if (ownContent.width > 0 && ownContent.height > 0) {
        imageIntrinsic = { w: ownContent.width, h: ownContent.height };
        imageEffectiveZoom = effectiveZoomFor(el);
      }
    } else if (warn != null) {
      warn(sel, "content", "the generated image replacing this <img> had not loaded; nothing is painted");
    }
    imageBroken = false;
    imageAlt = (el as HTMLImageElement).alt || "";
  } else if (tag === "img") {
    const img = el as HTMLImageElement;
    // currentSrc is the URL the browser actually resolved + loaded (from
    // srcset / <picture> <source>). Fall back to src when currentSrc is empty.
    imageSrc = img.currentSrc || img.src;
    // Intrinsic <img> dims — used by the renderer for object-fit: none.
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      imageIntrinsic = { w: img.naturalWidth, h: img.naturalHeight };
      imageEffectiveZoom = effectiveZoomFor(el);
      const host = el.ownerDocument.defaultView as
        | (Window & {
            __domotionDecodedImageRatios?: {
              active: boolean;
              facts: WeakMap<
                Element,
                {
                  source: string;
                  naturalWidth: number;
                  naturalHeight: number;
                  orientation: string;
                  width: number;
                  height: number;
                }
              >;
            };
          })
        | null;
      const state = host?.__domotionDecodedImageRatios;
      const decoded = state?.active ? state.facts.get(el) : undefined;
      if (
        decoded != null &&
        decoded.source === imageSrc &&
        decoded.naturalWidth === img.naturalWidth &&
        decoded.naturalHeight === img.naturalHeight &&
        el.ownerDocument.defaultView?.getComputedStyle(el).imageOrientation === decoded.orientation
      ) {
        imageDecodedIntrinsic = { w: decoded.width, h: decoded.height };
      }
    }
    // Blink applies `image-orientation: none` only to an access-allowed
    // bitmap; a CORS-tainted one keeps its EXIF orientation
    // (ImageResourceContent::ForceOrientationIfNecessary,
    // image_resource_content.cc:338-343, Chromium 6b5a1b80). A canvas read of
    // the same element is the page-visible form of that access check.
    if (img.naturalWidth > 0 && el.ownerDocument.defaultView?.getComputedStyle(el).imageOrientation === "none") {
      try {
        const probe = el.ownerDocument.createElement("canvas");
        probe.width = 1;
        probe.height = 1;
        const probeContext = probe.getContext("2d");
        if (probeContext != null) {
          probeContext.drawImage(img, 0, 0, 1, 1);
          probeContext.getImageData(0, 0, 1, 1);
          imageOrientationNone = true;
        }
      } catch {
        // Tainted: Chromium respects the image's own orientation.
      }
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
      // An errored generated image hands layout back to the src disposition,
      // exactly as ordinary content does (HTMLImageElement::CreateLayoutObject).
      ...(ownContent != null && ownContent.state === "error" ? { erroredContentImage: true } : {}),
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
    imageDecodedIntrinsic,
    imageEffectiveZoom,
    imageBroken,
    imageAlt,
    brokenImageFallback,
    imageEmbeddingColorScheme,
    imageOrientationNone,
  };
};
