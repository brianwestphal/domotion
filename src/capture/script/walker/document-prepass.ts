//
// Document-level registries and prepasses of the in-page CAPTURE_SCRIPT,
// split out of `src/capture/script/index.ts`: the private Node/CDP fact
// registries the walk consults, the root-relative prepasses that must run
// before any element is captured (fixed/sticky ancestry, transform and
// animation culling exemptions, backdrop effect snapshot, transform-related
// LayoutBox probe, projective fact index), the zoom / background-attachment
// scale resolvers, and the root capture + top-level payload attachment.
// Every function owns only the state it returns; nothing is held at module
// scope, so each capture call stays independent.

import { isPaintedColor } from "../../../utils/transparent-background.js";
import { selectProjectiveRasterOwnerIndexes } from "../../projective-owner.js";
import { backdropEffectNeutralizations, backdropRootReasons } from "../../backdrop-effect-space.js";
import { composeEffectiveTransform, transformHasRotationOrSkew } from "./transforms.js";
import { collectFontFeatureValues } from "../font-feature-values.js";
import type { CaptureScriptArgs, CapturedElement } from "../../types.js";
import type { ProjectivePaintNodeFact } from "../../projective-owner.js";
import type { CollapsedBorderFragmentRecord } from "../../collapsed-border-fragment-record.js";

type TextPaintRegistry = {
  indexByElement?: WeakMap<Element, number>;
  factsByElement?: Array<{ geometry?: CapturedElement["textPaintGeometry"] }>;
  token: string;
  indexByTextNode?: WeakMap<Node, number>;
};
type PseudoFragmentRegistry = {
  indexByElement?: WeakMap<Element, number>;
  factsByElement?: Array<CapturedElement["pseudoFragments"]>;
};
type CaptureWindow = Window & typeof globalThis & Record<string, unknown>;
type Viewport = CaptureScriptArgs["viewport"];

/** Lazily allocated per-root (document / shadow root) reference scopes. */
export const createSvgReferenceScopes = () => {
  const scopes = new WeakMap<Node, number>();
  let nextScope = 0;
  return (el: Element) => {
    var root = el.getRootNode ? el.getRootNode() : el.ownerDocument;
    var existing = scopes.get(root);
    if (existing != null) return existing;
    var allocated = nextScope++;
    scopes.set(root, allocated);
    return allocated;
  };
};

/** DM-2469 / DM-2467: lookups into the private per-frame registries the
 * Node/CDP prepasses install. The Node/CDP affine probe retains live nodes in
 * a private per-frame registry; the synchronous walker consumes only
 * immutable facts, so no author-visible attributes or source-order guesses
 * are involved. Exact generated-content fragment records come from one
 * frame-scoped CDP prepass; presence (including a terminal-raster record)
 * disables the legacy clone/probe path for that live host. */
export const createCaptureFactRegistries = (args: CaptureScriptArgs) => {
  function textPaintRegistryFor(el: Element): TextPaintRegistry | undefined {
    if (typeof args.textPaintGeometryKey !== "string" || args.textPaintGeometryKey === "") return undefined;
    var view = el.ownerDocument != null ? el.ownerDocument.defaultView : undefined;
    return view != null
      ? ((view as CaptureWindow)[args.textPaintGeometryKey] as TextPaintRegistry | undefined)
      : undefined;
  }
  function textPaintElementIndexFor(el: Element) {
    var registry = textPaintRegistryFor(el);
    return registry != null && registry.indexByElement != null ? registry.indexByElement.get(el) : undefined;
  }
  function textPaintFactFor(el: Element) {
    var registry = textPaintRegistryFor(el);
    var index = textPaintElementIndexFor(el);
    return registry != null && index != null && registry.factsByElement != null
      ? registry.factsByElement[index]
      : undefined;
  }
  function textPaintSourceKeyFor(el: Element) {
    var registry = textPaintRegistryFor(el);
    var index = textPaintElementIndexFor(el);
    return registry != null && index != null ? registry.token + ":" + index : undefined;
  }
  function textPaintSourceTextNodeIndexFor(node: Node) {
    var registry =
      node != null && node.ownerDocument != null
        ? ((node.ownerDocument.defaultView as CaptureWindow | null)?.[args.textPaintGeometryKey ?? ""] as
            TextPaintRegistry | undefined)
        : undefined;
    return registry != null && registry.indexByTextNode != null ? registry.indexByTextNode.get(node) : undefined;
  }
  function pseudoFragmentFactsFor(el: Element) {
    if (typeof args.pseudoFragmentKey !== "string" || args.pseudoFragmentKey === "") return undefined;
    var view = el.ownerDocument != null ? el.ownerDocument.defaultView : undefined;
    var registry =
      view != null
        ? ((view as CaptureWindow)[args.pseudoFragmentKey] as PseudoFragmentRegistry | undefined)
        : undefined;
    var index = registry != null && registry.indexByElement != null ? registry.indexByElement.get(el) : undefined;
    return registry != null && index != null && registry.factsByElement != null
      ? registry.factsByElement[index]
      : undefined;
  }
  return {
    textPaintFactFor,
    textPaintSourceKeyFor,
    textPaintSourceTextNodeIndexFor,
    pseudoFragmentFactsFor,
  };
};

/** Per-document `@font-feature-values` tables, collected once per document. */
export const createFontFeatureValuesLookup = () => {
  const byDocument = new WeakMap<Document, ReturnType<typeof collectFontFeatureValues>>();
  return (doc: Document) => {
    let tables = byDocument.get(doc);
    if (tables == null) {
      tables = collectFontFeatureValues(doc);
      byDocument.set(doc, tables);
    }
    return tables;
  };
};

/** Fragmented collapsed-table paint is allowed only when the Node/CDP
 * prepass authenticated one transform-neutral physical section record from
 * independent CSSOM and protocol geometry. Keep the live DOM correlation in
 * a private WeakMap; no author-visible id participates in ownership. */
export const buildCollapsedBorderFragmentLookup = (args: CaptureScriptArgs) => {
  const registry =
    typeof args.collapsedBorderFragmentKey === "string"
      ? ((globalThis as Record<string, unknown>)[args.collapsedBorderFragmentKey] as {
          tables: Element[];
          records: unknown[];
        } | null)
      : null;
  const byTable = new WeakMap<Element, CollapsedBorderFragmentRecord>();
  if (registry != null && Array.isArray(registry.tables) && Array.isArray(registry.records)) {
    for (let _cbfi = 0; _cbfi < registry.tables.length; _cbfi++) {
      const _cbfTable = registry.tables[_cbfi];
      const _cbfRecord = registry.records[_cbfi];
      if (_cbfTable != null && _cbfRecord != null) {
        byTable.set(_cbfTable, _cbfRecord as CollapsedBorderFragmentRecord);
      }
    }
  }
  return byTable;
};

/** DM-513: find position:fixed / position:sticky descendants whose rect
 * intersects the viewport. Their DOM-tree parents may be far outside the
 * viewport (e.g. slashdot's #mongo-stick-it ad bar pinned at top:710px while
 * its <footer> ancestor sits at y=7140 in document flow), and the
 * per-element viewport filter in captureInner would otherwise drop the whole
 * subtree. Mark every ancestor of every in-viewport fixed/sticky element so
 * captureInner knows to walk past those ancestors as transparent containers.
 * position:absolute is NOT included because absolute elements are positioned
 * relative to their containing block, so if their CB ancestor's rect is
 * offscreen, so is the absolute child. */
export const collectFixedAncestors = (root: Element, allEls: HTMLCollectionOf<Element>, vp: Viewport) => {
  const fixedAncestors = new Set<Element>();
  for (let _i = 0; _i < allEls.length; _i++) {
    const _el = allEls[_i];
    const _pos = getComputedStyle(_el).position;
    if (_pos !== "fixed" && _pos !== "sticky") continue;
    const _r = _el.getBoundingClientRect();
    const _outside = _r.right < vp.x || _r.bottom < vp.y || _r.left > vp.x + vp.width || _r.top > vp.y + vp.height;
    if (_outside) continue;
    // Walk up and mark every ancestor up to root.
    let _cur = _el.parentElement;
    while (_cur != null && _cur !== root.parentElement) {
      if (fixedAncestors.has(_cur)) break;
      fixedAncestors.add(_cur);
      _cur = _cur.parentElement;
    }
  }
  return fixedAncestors;
};

/** DM-587: every descendant of a transformed ancestor must escape the
 * outsideViewport early-return in captureInner. Because the per-element
 * freeze pass clears each ancestor's CSS transform before descending,
 * getBoundingClientRect on a descendant returns its NATURAL-layout position
 * (no ancestor translates / scales). For a carousel-style widget where the
 * "current slide" is brought into the viewport by a parent
 * `transform: translate(-Npx, 0)` (Stripe's connect-platform
 * payment-card-content does exactly this), the descendant's natural rect is
 * offscreen — without this set the cull drops it and the renderer never sees
 * the slide at all. The renderer re-applies the saved transform when drawing,
 * so descendants captured here will be painted at the correct post-transform
 * position. */
export const collectTransformInfluenced = (allEls: HTMLCollectionOf<Element>) => {
  const transformInfluenced = new Set<Element>();
  for (let _ti = 0; _ti < allEls.length; _ti++) {
    const _tel = allEls[_ti];
    const _tt = getComputedStyle(_tel).transform;
    if (_tt === "none" || _tt === "") continue;
    // Mark the transformed element itself AND every descendant. The element
    // itself needs the exemption because its own post-transform rect may be
    // entirely outside the viewport (e.g. framer's marquee `<ul>` is
    // `transform: translateX(-1000px)` at some animation frames), and the
    // `outsideViewport` cull would drop the ul + abort recursion before its
    // (in-viewport) descendant lis ever get walked. Including the transformed
    // element keeps the recursion alive so its descendants are captured.
    // (DM-637 / framer brand-logo carousel.)
    transformInfluenced.add(_tel);
    const _tdescs = _tel.getElementsByTagName("*");
    for (let _tj = 0; _tj < _tdescs.length; _tj++) {
      transformInfluenced.add(_tdescs[_tj]);
    }
  }
  return transformInfluenced;
};

/** DM-1532: an element carrying `data-domotion-anim` gets a post-capture
 * intra-frame animation that CAN be a transform (e.g. an odometer digit reel
 * whose strip `translateY`-rolls, scrolling otherwise-offscreen digit cells
 * through a clipped window). Capture runs on the static, untransformed DOM
 * and can't know the animation's range, so it would drop those offscreen
 * cells before the animation ever brings them in. Exempt the whole animated
 * subtree from the `outsideViewport` early-return; the post-capture,
 * animation-aware viewBox cull (`cullElementsOutsideViewBox`) then trims any
 * that never actually enter the viewport during the scene. Mirrors
 * `collectTransformInfluenced`. */
export const collectAnimInfluenced = (allEls: HTMLCollectionOf<Element>) => {
  const animInfluenced = new Set<Element>();
  for (let _ai = 0; _ai < allEls.length; _ai++) {
    const _ael = allEls[_ai];
    if ((_ael as HTMLElement).dataset?.domotionAnim == null || (_ael as HTMLElement).dataset.domotionAnim === "")
      continue;
    animInfluenced.add(_ael);
    const _adescs = _ael.getElementsByTagName("*");
    for (let _aj = 0; _aj < _adescs.length; _aj++) animInfluenced.add(_adescs[_aj]);
  }
  return animInfluenced;
};

/** Attachment ownership walks beyond the selected capture root. A fixed
 * background on the root still becomes scroll-attached when an authored
 * transform ancestor outside that root establishes the containing block;
 * likewise, a transform on an inert inline ancestor must remain a negative
 * control. Include those ancestors in the LayoutBox applicability probe. */
export const collectOwnershipElements = (root: Element, allEls: HTMLCollectionOf<Element>) => {
  const ownershipEls = [root, ...Array.from(allEls)];
  let _ownershipAncestor = root.parentElement;
  while (_ownershipAncestor != null) {
    ownershipEls.push(_ownershipAncestor);
    _ownershipAncestor = _ownershipAncestor.parentElement;
  }
  return ownershipEls;
};

const backdropFactsFor = (_element: Element, _style: CSSStyleDeclaration) => ({
  isDocumentRoot: _element === _element.ownerDocument.documentElement,
  opacity: _style.opacity || "1",
  filter: _style.filter || "none",
  backdropFilter:
    _style.backdropFilter ||
    (_style as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter ||
    "none",
  clipPath: _style.clipPath || "none",
  maskImage: _style.maskImage || "none",
  maskBorderSource: (_style as CSSStyleDeclaration & { maskBorderSource?: string }).maskBorderSource || "none",
  mixBlendMode: _style.mixBlendMode || "normal",
  willChange: _style.willChange || "auto",
  transform: _style.transform || "none",
  translate: _style.translate || "none",
  rotate: _style.rotate || "none",
  scale: _style.scale || "none",
});

/** DM-2487: snapshot the ancestor effect tree before the transform walker can
 * temporarily freeze rotate/skew declarations. This source-owned record is
 * consumed by the Node screenshot pass; ordinary stacking, isolation,
 * overflow, positioning, and transforms do not become Backdrop Roots. */
export const createBackdropEffectSpace = (ownershipEls: Element[], shortSelector: (el: Element) => string) => {
  const backdropEffectFacts = new WeakMap<Element, ReturnType<typeof backdropFactsFor>>();
  for (let _bi = 0; _bi < ownershipEls.length; _bi++) {
    const _element = ownershipEls[_bi];
    const _styleWindow = _element.ownerDocument?.defaultView ?? window;
    backdropEffectFacts.set(_element, backdropFactsFor(_element, _styleWindow.getComputedStyle(_element)));
  }
  return (_target: Element) => {
    const _ancestors = [];
    let _nearestRoot;
    let _ancestor = _target.parentElement;
    let _depth = 1;
    while (_ancestor != null) {
      const _styleWindow = _ancestor.ownerDocument?.defaultView ?? window;
      const _facts =
        backdropEffectFacts.get(_ancestor) || backdropFactsFor(_ancestor, _styleWindow.getComputedStyle(_ancestor));
      const _reasons = backdropRootReasons(_facts);
      const _neutralize = backdropEffectNeutralizations(_facts);
      const _selector = shortSelector(_ancestor);
      if (_nearestRoot == null && _reasons.length > 0) {
        _nearestRoot = {
          kind: _facts.isDocumentRoot ? "document" : "element",
          depth: _depth,
          selector: _selector,
          reasons: _reasons,
        };
      }
      if (_reasons.length > 0 || _neutralize.length > 0) {
        _ancestors.push({ depth: _depth, selector: _selector, reasons: _reasons, neutralize: _neutralize });
      }
      _ancestor = _ancestor.parentElement;
      _depth++;
    }
    // A connected HTML target always reaches documentElement. Keep this
    // conservative fallback explicit for detached/custom-document probes.
    if (_nearestRoot == null) {
      _nearestRoot = { kind: "document", depth: 0, selector: "html", reasons: ["document-root"] };
    }
    return {
      source: "blink-backdrop-effect-tree-v1",
      nearestRoot: _nearestRoot,
      ancestors: _ancestors,
    };
  };
};

const TRANSFORM_RELATED_WILL_CHANGE = new Set([
  "transform",
  "transform-style",
  "perspective",
  "translate",
  "rotate",
  "scale",
  "offset-path",
  "offset-position",
]);
const PROBE_UNSUPPORTED_TAGS = /^(?:AUDIO|CANVAS|EMBED|IFRAME|IMG|INPUT|METER|OBJECT|PROGRESS|SELECT|TEXTAREA|VIDEO)$/;

const hasTransformRelatedSignal = (_cs: CSSStyleDeclaration) => {
  if (
    (_cs.transform != null && _cs.transform !== "" && _cs.transform !== "none") ||
    (_cs.translate != null && _cs.translate !== "" && _cs.translate !== "none") ||
    (_cs.rotate != null && _cs.rotate !== "" && _cs.rotate !== "none") ||
    (_cs.scale != null && _cs.scale !== "" && _cs.scale !== "none") ||
    _cs.transformStyle === "preserve-3d" ||
    (_cs.perspective != null && _cs.perspective !== "" && _cs.perspective !== "none")
  )
    return true;
  if (_cs.willChange == null || _cs.willChange === "" || _cs.willChange === "auto") return false;
  const _tokens = _cs.willChange.split(/[\s,]+/);
  for (let _wi = 0; _wi < _tokens.length; _wi++) {
    if (TRANSFORM_RELATED_WILL_CHANGE.has(_tokens[_wi].toLowerCase())) return true;
  }
  return false;
};

/** DM-2385: a computed transform-related value does not imply that Blink's
 * LayoutObject can apply it. In particular, a non-replaced `display:inline`
 * element serializes perspective/transform normally but fails the `IsBox()`
 * arm in ComputeIsFixedContainer and creates neither a fixed CB nor a
 * perspective paint node. ComputedStyle's stacking-context predicate remains
 * separate. CSSOM does not expose IsBox(), but fixed ownership is observable
 * without matrix inference: give a neutral temporary host the candidate's
 * computed display and an active perspective; its fixed child's offsetParent
 * is that host exactly when Blink constructed an IsBox layout object. Using a
 * neutral host avoids changing the source element or letting its independent
 * filter/contain state answer the transform question. Probe only
 * transform-related candidates, remove the zero-size host immediately, and
 * retain the boolean for perspective activation and fixed ownership. */
export const probeTransformRelatedBoxes = (ownershipEls: Element[], transformRelatedBox: WeakMap<Element, boolean>) => {
  for (let _oi = 0; _oi < ownershipEls.length; _oi++) {
    const _owner = ownershipEls[_oi];
    const _ownerStyle = getComputedStyle(_owner);
    if (!hasTransformRelatedSignal(_ownerStyle)) continue;
    // Replaced/control content and SVG suppress an appended HTML child, so a
    // false result there would describe the probe host rather than IsBox().
    // Such elements cannot expose an authored fixed descendant through this
    // tree; leave the fact undefined so their own perspective paint retains
    // the source-compatible fallback.
    if (_owner.namespaceURI === "http://www.w3.org/2000/svg" || PROBE_UNSUPPORTED_TAGS.test(_owner.tagName)) continue;
    const _probeHost = document.createElement("span");
    _probeHost.setAttribute("aria-hidden", "true");
    _probeHost.style.setProperty("all", "initial", "important");
    _probeHost.style.setProperty("display", _ownerStyle.display, "important");
    _probeHost.style.setProperty("perspective", "1px", "important");
    _probeHost.style.setProperty("visibility", "hidden", "important");
    _probeHost.style.setProperty("width", "0", "important");
    _probeHost.style.setProperty("height", "0", "important");
    _probeHost.style.setProperty("margin", "0", "important");
    _probeHost.style.setProperty("padding", "0", "important");
    _probeHost.style.setProperty("border", "0", "important");
    const _probe = document.createElement("i");
    _probe.setAttribute("aria-hidden", "true");
    _probe.style.setProperty("all", "initial", "important");
    _probe.style.setProperty("position", "fixed", "important");
    _probe.style.setProperty("width", "0", "important");
    _probe.style.setProperty("height", "0", "important");
    _probeHost.appendChild(_probe);
    try {
      (document.body || document.documentElement).appendChild(_probeHost);
      transformRelatedBox.set(_owner, _probe.offsetParent === _probeHost);
    } catch (_e) {
      // If the neutral host cannot participate in layout, leave the compatible
      // computed-style fallback undefined rather than guessing.
    } finally {
      _probeHost.remove();
    }
  }
};

/** DM-2474: CSS 3D ownership comes from Chromium's live paint quads,
 * gathered by the Node/CDP prepass before capture mutates transforms. DOM
 * object correlation is held in a private page-global array, so no marker
 * attribute or appended HTML child can change SVG layout. SVG graphics
 * children are source-flattened affine and deliberately do not receive a
 * general box homography; outer SVG roots and HTML boxes may. */
export const indexProjectiveFacts = (args: CaptureScriptArgs) => {
  const projectiveFacts = (
    Array.isArray(args.projectiveFacts) ? args.projectiveFacts : []
  ) as ProjectivePaintNodeFact[];
  const projectiveDomNodes =
    typeof args.projectiveKey === "string" && Array.isArray((globalThis as Record<string, unknown>)[args.projectiveKey])
      ? ((globalThis as Record<string, unknown>)[args.projectiveKey] as Element[])
      : [];
  const projectiveNodeIndex = new WeakMap<Element, number>();
  const projectedQuads = new WeakMap<Element, Array<{ x: number; y: number }>>();
  const projectiveAbsH = new WeakMap<Element, number[]>();
  for (let _pi = 0; _pi < projectiveFacts.length; _pi++) {
    const _fact = projectiveFacts[_pi];
    const _pel = projectiveDomNodes[_pi];
    if (_pel == null || _fact == null) continue;
    projectiveNodeIndex.set(_pel, _pi);
    if (_fact.role === "svg-graphics") continue;
    const _values = _fact.borderQuad || _fact.quad;
    if (!Array.isArray(_values) || _values.length !== 8) continue;
    projectedQuads.set(_pel, [
      { x: _values[0], y: _values[1] },
      { x: _values[2], y: _values[3] },
      { x: _values[4], y: _values[5] },
      { x: _values[6], y: _values[7] },
    ]);
  }
  const nonAffineProjectiveRoots = new Set<Element>();
  for (const _ownerIndex of selectProjectiveRasterOwnerIndexes(projectiveFacts)) {
    const _owner = projectiveDomNodes[_ownerIndex];
    if (_owner != null) nonAffineProjectiveRoots.add(_owner);
  }
  return { projectiveFacts, projectiveNodeIndex, projectedQuads, projectiveAbsH, nonAffineProjectiveRoots };
};

/** DM-2470: keep effective CSS zoom as a local layout/metric input. CSS
 * transforms never enter this map; authoritative textPaintGeometry owns
 * their complete signed affine mapping after shaping. */
export const createEffectiveZoomResolver = () => {
  const cumulativeZoom = new Map<Element, number>();
  const effectiveZoomFor = (el: Element | null): number => {
    if (el == null) return 1;
    const hit = cumulativeZoom.get(el);
    if (hit != null) return hit;
    const parentZoom = effectiveZoomFor(el.parentElement);
    const own = parseFloat(getComputedStyle(el).zoom);
    const zoom = parentZoom * (Number.isFinite(own) && own > 0 ? own : 1);
    cumulativeZoom.set(el, zoom);
    return zoom;
  };
  return effectiveZoomFor;
};

// Background attachment is a separate box-paint protocol. Its live physical
// scroll geometry still needs pure scale magnitudes, so keep that conversion
// narrowly named and owned here rather than sharing it with text.
const backgroundAttachmentAxisScale = (_tt: string): [number, number] => {
  if (_tt == null || _tt === "none" || _tt === "") return [1, 1];
  const _m2 = /^matrix\(\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)/.exec(_tt);
  let _sa = 1,
    _sd = 1;
  if (_m2 != null) {
    _sa = parseFloat(_m2[1]);
    _sd = parseFloat(_m2[4]);
  } else {
    const _m3 = /^matrix3d\(([^)]+)\)/.exec(_tt);
    if (_m3 != null) {
      const _parts = _m3[1].split(",");
      _sa = parseFloat(_parts[0]);
      _sd = parseFloat(_parts[5]);
    }
  }
  if (!isFinite(_sa) || !isFinite(_sd)) return [1, 1];
  const _sx = Math.abs(_sa) > 0 ? Math.abs(_sa) : 1;
  const _sy = Math.abs(_sd) > 0 ? Math.abs(_sd) : 1;
  return [_sx, _sy];
};

/** Background attachment geometry is serialized in the same physical space
 * as the element rect. Pure translate/scale transforms stay live during
 * capture, so their scale is already baked into that space. Rotation/skew
 * transforms are temporarily frozen and later re-applied by the SVG wrapper;
 * folding their matrix a/d terms into scroll offsets would apply that part
 * twice. Resolve the scale along the real DOM ancestry and cache the result. */
export const createBackgroundAttachmentPaintScale = () => {
  const paintScale = new WeakMap<Element, [number, number]>();
  const paintScaleFor = (el: Element | null): [number, number] => {
    if (el == null) return [1, 1];
    const _hit = paintScale.get(el);
    if (_hit != null) return _hit;
    const _parent = paintScaleFor(el.parentElement);
    const _styleWindow = el.ownerDocument?.defaultView ?? window;
    const _style = _styleWindow.getComputedStyle(el);
    const _effectiveTransform = composeEffectiveTransform(_style);
    const _ownScale = transformHasRotationOrSkew(_effectiveTransform)
      ? [1, 1]
      : backgroundAttachmentAxisScale(_effectiveTransform);
    const _ownZoom = parseFloat(_style.zoom);
    const _zoom = Number.isFinite(_ownZoom) && _ownZoom > 0 ? _ownZoom : 1;
    const _resolved: [number, number] = [_parent[0] * _ownScale[0] * _zoom, _parent[1] * _ownScale[1] * _zoom];
    paintScale.set(el, _resolved);
    return _resolved;
  };
  return paintScaleFor;
};

/** Capture the root element itself when it owns content, border or background
 * (DM-362: <body style="border:3px solid pink"> was not rendering because we
 * only walked root.children). When the root has nothing visually
 * distinctive, fall through to the child walk so we don't wrap every page in
 * a redundant outer rect. */
export const captureRootElements = (
  root: Element,
  capture: (el: Element) => CapturedElement | null,
  nonAffineProjectiveRoots: Set<Element>,
) => {
  const result: CapturedElement[] = [];
  const rootCs = window.getComputedStyle(root);
  const rootTag = root.tagName.toLowerCase();
  // Intrinsic images/SVG, replaced snapshots and native controls emit their
  // own content even when their CSS box has no background, border or text.
  // Admission must reach those existing producers; capture's visibility and
  // geometry gates still decide whether the selected owner is retained.
  const rootHasContentPaint =
    /^(?:img|svg|canvas|video|iframe|object|embed|input|textarea|select|button|progress|meter)$/.test(rootTag) ||
    (rootTag.indexOf("-") > 0 && root.shadowRoot != null);
  const rootHasBorder =
    (parseFloat(rootCs.borderTopWidth) || 0) > 0 ||
    (parseFloat(rootCs.borderRightWidth) || 0) > 0 ||
    (parseFloat(rootCs.borderBottomWidth) || 0) > 0 ||
    (parseFloat(rootCs.borderLeftWidth) || 0) > 0;
  const rootBg = rootCs.backgroundColor;
  // DM-855: also capture the root when it carries a gradient/image background,
  // not just a solid color. `backgroundColor` is `transparent` for a
  // gradient-only <body>, so checking it alone made us skip capturing the root
  // element and drop its background entirely. Treating a non-`none`
  // `background-image` as "has background" captures the root as a normal
  // element, routing its gradient through the existing element-gradient path.
  const rootBgImage = rootCs.backgroundImage;
  const rootHasBgImage = rootBgImage != null && rootBgImage !== "none" && rootBgImage !== "";
  const rootHasBg = isPaintedColor(rootBg) || rootHasBgImage;
  // DM-365: invalid HTML like <p>foo<div>bar</div>baz</p> auto-closes the <p>
  // when the <div> opens, leaving "baz" as a direct text-node child of <body>.
  // Chrome paints it; we'd miss it if we only walked root.children (Element
  // children only). When the root has any direct text-node child with non-
  // whitespace content, capture root so its text-node walk picks them up.
  let rootHasDirectText = false;
  for (const node of root.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && (node.textContent || "").trim() !== "") {
      rootHasDirectText = true;
      break;
    }
  }
  if (rootHasContentPaint || rootHasBorder || rootHasBg || rootHasDirectText || nonAffineProjectiveRoots.has(root)) {
    const c = capture(root);
    if (c) result.push(c);
  } else {
    for (const child of root.children) {
      const c = capture(child);
      if (c) result.push(c);
    }
  }
  return result;
};

/** Attach the document-level payloads (collected SVG defs, mask rasters,
 * root scrollbars, page dark-mode and overflow signals) to the first
 * captured root element. */
export const attachRootPayloads = (
  result: CapturedElement[],
  args: CaptureScriptArgs,
  collected: {
    maskDefs: Map<unknown, unknown>;
    clipPathDefs: Map<unknown, unknown>;
    filterDefs: Map<unknown, unknown>;
    maskRasters: Map<unknown, unknown>;
  },
) => {
  // DM-493: attach the collected mask fragment defs to the first root element
  // as a top-level payload. Renderer reads tree[0].maskDefs to emit the mask
  // defs into the output SVG.
  if (collected.maskDefs.size > 0 && result.length > 0) {
    result[0].maskDefs = Array.from(collected.maskDefs.values()) as CapturedElement["maskDefs"];
  }
  // DM-826: same shape as maskDefs above — top-level collection of inline
  // <clipPath> defs the renderer emits into the output SVG. See docs/39.
  if (collected.clipPathDefs.size > 0 && result.length > 0) {
    result[0].clipPathDefs = Array.from(collected.clipPathDefs.values()) as CapturedElement["clipPathDefs"];
  }
  // DM-934: same shape — inline <filter> defs referenced by CSS `filter:
  // url(#id)`. The renderer copies these into the output SVG and the
  // existing pass-through of cs.filter as an inline style on the wrapping
  // group references them.
  if (collected.filterDefs.size > 0 && result.length > 0) {
    result[0].filterDefs = Array.from(collected.filterDefs.values()) as CapturedElement["filterDefs"];
  }
  // DM-494: attach mask raster references (mask-image: element(#id)). Skip
  // null entries (display:none / zero-area / not-found targets). The post-
  // capture rasterize pass on the Node side fills in dataUri.
  if (collected.maskRasters.size > 0 && result.length > 0) {
    var rasterArr = [];
    for (var entry of collected.maskRasters.values()) {
      if (entry != null) rasterArr.push(entry);
    }
    if (rasterArr.length > 0) result[0].maskRasters = rasterArr as CapturedElement["maskRasters"];
  }
  // DM-552: stamp page-level dark-mode signals on the captured tree's root
  // element. The renderer reads these to emit color-scheme="dark" on the
  // root <svg> (this slice) and to source the body-bg fallback in the
  // transparent-root case (DM-554 wires up the second consumer).
  if (result.length > 0) {
    try {
      var _rootScrollbarOwner = document.scrollingElement;
      var _rootScrollbarRecord =
        _rootScrollbarOwner != null && typeof args.scrollbarPropertyKey === "string" && args.scrollbarPropertyKey !== ""
          ? (_rootScrollbarOwner as Element & Record<string, unknown>)[args.scrollbarPropertyKey]
          : undefined;
      if (_rootScrollbarRecord != null)
        result[0].rootScrollbars = _rootScrollbarRecord as CapturedElement["rootScrollbars"];
      var _isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      result[0].styles.rootColorScheme = _isDark ? "dark" : "light";
      var _docCs = window.getComputedStyle(document.documentElement);
      result[0].styles.rootBgComputed = _docCs.backgroundColor;
      // DM-1244: <html>'s overflow decides whether <body>'s overflow propagates
      // to the viewport (it only does when <html> is `overflow: visible`). The
      // renderer needs it to know whether to apply <body>'s own overflow clip.
      result[0].styles.rootOverflowX = _docCs.overflowX;
      result[0].styles.rootOverflowY = _docCs.overflowY;
    } catch (_e) {
      /* no-op — never block capture on this */
    }
  }
};
