/**
 * Stacking-context analysis: which elements establish a stacking context, and
 * gathering a context's paint-ordered children. Extracted verbatim from
 * element-tree-to-svg.ts (DM-1305); self-contained (only the CapturedElement type).
 */

import type { CapturedElement } from "../capture/types.js";

/**
 * DM-525: parent's `display` decides whether this element is a flex/grid
 * item, which extends the z-index → stacking-context rule even when the
 * item is `position: static` (per CSS Flexbox 1 §5.4 / CSS Grid 1 §17).
 */
export function isFlexOrGridContainerDisplay(display: string | undefined | null): boolean {
  if (display == null) return false;
  return display === "flex" || display === "inline-flex"
      || display === "grid" || display === "inline-grid";
}

/**
 * DM-473: does this element establish a CSS stacking context?
 *
 * Stacking-context creators we model:
 *   - positioned (`position` ≠ `static`) AND `z-index` ≠ `auto`
 *   - flex/grid item AND `z-index` ≠ `auto` (DM-525 — per CSS Flexbox 1 §5.4 /
 *     CSS Grid 1: z-index on a flex/grid item creates an SC even when
 *     position:static, behaving as if position were relative)
 *   - `position: fixed` / `position: sticky` (always create one in modern CSS)
 *   - `opacity` < 1
 *   - `transform` ≠ `none`
 *   - `filter` ≠ `none`
 *   - `mix-blend-mode` ≠ `normal`
 *   - `mask-image` ≠ `none` / `clip-path` ≠ `none` (we already wrap these in
 *     a `<g mask=...>` / `<g clip-path=...>`, which isolates paint)
 *   - `isolation: isolate`
 *
 * Not yet modeled (low real-world frequency):
 *   - `perspective` ≠ `none`
 *
 * Used by the paint-order flattening pass: a positioned descendant whose
 * nearest *real* SC ancestor is the parent SC root must be hoisted into
 * the parent SC's sort, not buried inside its non-SC direct parent.
 */
export function establishesStackingContext(el: CapturedElement, parentDisplay?: string): boolean {
  const s = el.styles;
  // An element targeted by an intra-frame animation (`animId`) is animating
  // transform / opacity / filter — any of which creates a stacking context in
  // CSS. Mirror that here so the element's whole subtree renders ATOMICALLY,
  // nested inside its `anim-<id>` wrapper, instead of being flattened up to an
  // ancestor SC's paint list. Without this, a flex container that fades (its
  // flex-item child hoists to the root SC per DM-683) leaves the `anim-` group
  // empty so the animation moves nothing; and a flex item that slides leaves
  // its own text/children behind. The lower-third template (panel that fades +
  // slides) hit exactly this — only the panel's background animated.
  if (el.animId != null && el.animId !== "") return true;
  const positioned = s.position != null && s.position !== "static";
  const zRaw = s.zIndex;
  if (positioned && zRaw != null && zRaw !== "" && zRaw !== "auto") return true;
  // DM-525: flex/grid item with explicit z-index — Chrome treats this as a
  // stacking context root even at position:static.
  if (isFlexOrGridContainerDisplay(parentDisplay)
      && zRaw != null && zRaw !== "" && zRaw !== "auto") return true;
  if (s.position === "fixed" || s.position === "sticky") return true;
  const op = parseFloat(s.opacity);
  if (Number.isFinite(op) && op < 1) return true;
  if (s.transform != null && s.transform !== "" && s.transform !== "none") return true;
  // DM-587: the capture script now records `styles.transform = 'none'` for
  // every element (live rects are baked in, no wrap needed), but tracks the
  // original "was non-none at capture time" bit in `transformCreatesSc` so
  // SC detection still works. Without this, e.g. a `<div style="transform:
  // translate(0)">` with z-indexed descendants would stop trapping their
  // z-index resolution and the descendants would hoist to a higher SC.
  if (s.transformCreatesSc) return true;
  // DM-589: CSS Transforms 2 §4 — any `transform-style` value != `flat`
  // (typically `preserve-3d`) creates a stacking context. Real-world hit:
  // stripe.com's speaker-card uses preserve-3d so its z-index:-1 speaker
  // photo can paint at the card's local SC step 2 (above the white bg)
  // instead of hoisting to a higher SC where it'd render behind the card.
  if (s.transformStyle != null && s.transformStyle !== "" && s.transformStyle !== "flat") return true;
  if (s.filter != null && s.filter !== "" && s.filter !== "none") return true;
  if (s.mixBlendMode != null && s.mixBlendMode !== "" && s.mixBlendMode !== "normal") return true;
  if (s.maskImage != null && s.maskImage !== "" && s.maskImage !== "none") return true;
  if (s.clipPath != null && s.clipPath !== "" && s.clipPath !== "none") return true;
  // DM-498: `will-change` listing any SC-creating property creates an SC.
  // Per CSS-Will-Change-1: "If any non-initial value of any of the listed
  // properties would create a stacking context on the element, the element
  // creates a stacking context." Real-world high-traffic case: apple.com's
  // hero carousel uses `will-change: transform` on the slide container, so
  // without this detection the hoist pass disrupts the natural paint order
  // and the buttons render BEHIND the artwork. Tokenize on comma+whitespace
  // and check exact name equality — substring matching would falsely flag
  // `scroll-position` (which doesn't create an SC) on the `position` token.
  if (s.willChange != null && s.willChange !== "" && s.willChange !== "auto") {
    const _scWcProps: ReadonlySet<string> = new Set([
      "transform", "opacity", "filter", "backdrop-filter",
      "mask", "mask-image", "clip-path", "perspective",
      "top", "right", "bottom", "left",
      "position", "z-index", "isolation", "mix-blend-mode", "contain",
    ]);
    const tokens = s.willChange.split(/[\s,]+/);
    for (const t of tokens) {
      if (_scWcProps.has(t.toLowerCase())) return true;
    }
  }
  // DM-498: `contain: paint | strict | content` creates an SC.
  if (s.contain != null && s.contain !== "" && s.contain !== "none") {
    if (/\b(?:paint|strict|content)\b/i.test(s.contain)) return true;
  }
  // DM-498: `isolation: isolate` creates an SC.
  if (s.isolation === "isolate") return true;
  // DM-487: `overflow != visible` (scroll container) creates a stacking
  // context — any of overflow / overflow-x / overflow-y in {auto, scroll,
  // hidden, clip}. Without this, sticky / positioned descendants of an
  // overflow:auto scroller get hoisted PAST the scroller's clip-path
  // wrapper into the implicit root SC, leaking out of the scroller's
  // viewport (observable on `13-deep-sticky-edges`: scroller 1's deep
  // sticky headers painted into scroller 2's area).
  const ox = s.overflowX;
  const oy = s.overflowY;
  if ((ox != null && ox !== "visible") || (oy != null && oy !== "visible")) return true;
  return false;
}

/**
 * DM-473: build the flat paint list for one stacking context.
 *
 * For each direct child of the SC root, walk into the child's subtree only
 * as long as the child is NOT itself an SC root, and pull every positioned
 * descendant (transitively) up into the flat list. Each hoisted descendant
 * is also added to `hoistedOut` so the renderer's normal DFS skips them at
 * their natural location and we don't double-emit. SC-root descendants
 * are NOT recursed into — they bring their own SC scope and their internal
 * paint order resolves independently when their renderElement runs.
 */
export function gatherStackingContextChildren(
  children: CapturedElement[],
  hoistedOut: Set<CapturedElement>,
  parentDisplay?: string,
  /**
   * DM-683: out-parameter populated with elements that should paint at CSS
   * 2.1 Appendix E step 5 (in-flow inline-level non-positioned) rather than
   * step 3 (block). Currently only flex/grid items are tagged here — they
   * paint as inline blocks per CSS Flexbox 1 §5.4 / CSS Grid 1 §17.
   * `sortChildrenByPaintOrder` reads this set to route members into the
   * inline bucket (between floats and zeroOrAuto).
   */
  hoistedAsInline?: Set<CapturedElement>,
  /**
   * DM-673: when set, this map is populated with `{ hoistedDescendant →
   * overflow-clip ancestor }` for any positioned descendant that escapes an
   * `overflow != visible` ancestor whose ONLY SC-creating property is the
   * overflow. The renderer reads this map to re-wrap the descendant's
   * emission in the same `<g clip-path>` the ancestor would have wrapped
   * it in had it stayed nested.
   */
  overflowClipForHoisted?: Map<CapturedElement, CapturedElement>,
  /**
   * DM-712: out-parameter populated with flex/grid items that were hoisted
   * because they carry an explicit z-index. Once hoisted, the sort needs
   * to know to z-bucket these (CSS Flexbox 1 §5.4 / CSS Grid 1 §17) — the
   * sort's own `isFlexGrid` check fires off the immediate-parent display,
   * which is the SC root after hoisting (typically `block`), losing the
   * original "flex item with z" signal. `sortChildrenByPaintOrder` reads
   * this set and routes members through the positive / zeroOrAuto buckets
   * based on the captured z-index.
   */
  hoistedAsZSorted?: Set<CapturedElement>,
): CapturedElement[] {
  const out: CapturedElement[] = [];
  /**
   * `floatHoistBlocked` is true once the recursion descends through a
   * `position:relative` / `position:absolute` ancestor with `z-index: auto`
   * (or `0`). Per CSS 2.1 Appendix E §6, such an element paints at step 6
   * as if it were a stacking context, but its positioned + SC descendants
   * still belong to the parent SC. Floats inside an atomic positioned
   * ancestor stay with it (they paint at step 4 of the atomic group's
   * internal paint order), not at the parent SC's step 4. Without this gate
   * a float hoisted past its atomic positioned ancestor paints BENEATH
   * the ancestor's atomic content — Slashdot's mobile `<a class="login">`
   * float inside `.header { z-index:1000; position:static }` (descendant
   * of `.stages { position:relative }`) was rendering before the white
   * `.river-prop` page background and disappeared completely.
   */
  const collectFromNonSC = (parent: CapturedElement, floatHoistBlocked: boolean = false, currentOverflowAncestor: CapturedElement | null = null): void => {
    const childParentDisplay = parent.styles.display;
    const parentIsFlexGrid = isFlexOrGridContainerDisplay(childParentDisplay);
    // DM-537: when the parent is a flex/grid container, flex items hoisted
    // out of it into the parent SC's flat paint list must carry their
    // order-modified document order with them. The post-hoist
    // `sortChildrenByPaintOrder` runs with the parent SC's display (often
    // `block`) so its own `isFlexGrid` check fires `false` and the inline
    // bucket falls back to DOM order — losing the flex `order` reordering
    // and the `flex-direction: *-reverse` paint reversal. Pre-sort the
    // iteration here so the hoisted items land in the right order in `out`.
    let iterChildren = parent.children;
    if (parentIsFlexGrid && iterChildren.length > 1) {
      const sorted = iterChildren
        .map((c, idx) => ({ c, idx, ord: parseInt(c.styles.order ?? "0", 10) || 0 }))
        .sort((a, b) => a.ord - b.ord || a.idx - b.idx)
        .map((x) => x.c);
      const fd = parent.styles.flexDirection;
      const reverseFlex = fd === "row-reverse" || fd === "column-reverse";
      iterChildren = reverseFlex ? sorted.slice().reverse() : sorted;
    }
    for (const c of iterChildren) {
      // DM-543: skip elements already hoisted by a higher SC pass (e.g. a
      // root-level position:fixed pre-pass added this pin to topLevelFlat;
      // re-pushing it here would double-emit it inside the local clip group).
      if (hoistedOut.has(c)) continue;
      const positioned = c.styles.position != null && c.styles.position !== "static";
      // DM-558: also hoist a flex/grid item with explicit z-index even when
      // position:static — it's an SC root by CSS Flexbox 1 §5.4 / CSS Grid 1
      // §17 (already detected by `establishesStackingContext`'s flex/grid
      // branch), and SC roots paint atomically in their nearest parent SC
      // sort. Without this hoist, the SC stays nested inside its non-SC
      // ancestor's sub-tree and renders at that depth in DOM order — so a
      // flex-item button with z:4 inside `<div style="position:relative">`
      // ends up painting BEFORE a sibling positioned `<div>` that should be
      // beneath it. (Apple hero `tile-wrapper > tile-content > tile-ctas >
      // a.button` rendered BEHIND the captured background image because the
      // button's z:4 hoist never fired — position:static + the legacy
      // `if (positioned)` check skipped it.)
      //
      // Both hoist targets are real stacking contexts: a per-element SC root
      // (the `renderElement` call) and the implicit document root (the
      // top-level call) — `gatherStackingContextChildren` only ever recurses
      // through non-SC / overflow-only-SC ancestors, so a flex-item-z is only
      // reached here when its nearest *real* SC ancestor is the hoist target.
      // The z-bucket survives the hoist via the `hoistedAsZSorted` tag below,
      // which `sortChildrenByPaintOrder` reads even when `parentDisplay` isn't
      // flex/grid (e.g. the `block` document root) — so the item z-sorts
      // correctly rather than falling into the inline bucket in DOM order.
      const zRaw = c.styles.zIndex;
      const hasExplicitZ = zRaw != null && zRaw !== "" && zRaw !== "auto";
      const flexGridItemSC = parentIsFlexGrid && hasExplicitZ;
      // DM-639: per CSS 2.1 §9.9 paint order, ALL floats in a stacking
      // context paint at step 4 — AFTER all block-level non-positioned
      // descendants (step 3) of the SC. Floats are not confined to their
      // immediate parent's sort. Without this hoist, a float that extends
      // beyond its parent (e.g. `<div>{floats}</div>` whose parent has zero
      // height because floats are out of flow) gets covered by later block
      // siblings of the float's ancestors instead of painting on top of them.
      // Real-world hit: 14-deep-float-bfc section 1's float-left FL extends
      // ~60 px below the .frame and is covered by section 2's gray bar.
      const isFloat = !positioned && (c.styles.float ?? "none") !== "none";
      // DM-683: per CSS Flexbox 1 §5.4 ("Flex items paint exactly the same
      // as inline blocks"), flex items paint at CSS 2.1 Appendix E step 5
      // (in-flow inline-level non-positioned descendants) — AFTER block
      // siblings at step 3 + floats at step 4 within the same stacking
      // context. When a flex item OVERFLOWS its flex container and the
      // container has block-level following siblings (e.g. `15-deep-flex-
      // aspect-ratio` section 2: `.row.col` with a `1:2` aspect-ratio item
      // 388 px tall inside a 360 px tall container, followed by `.frame3`
      // — Chrome paints the overflowing item ON TOP of `.frame3` because
      // step 5 > step 3), our DOM-order paint covered the overflow with
      // the following sibling. Hoist flex items to the SC root paint list
      // so the post-sort places them after step-3 blocks, mirroring the
      // float-hoist (DM-639) pattern. Same atomic-positioned-ancestor
      // gate as floats: a `position:relative` z=auto ancestor scopes the
      // item to its own atomic paint.
      const isFlexItem = !positioned && parentIsFlexGrid;
      if (positioned || flexGridItemSC || (isFloat && !floatHoistBlocked) || (isFlexItem && !floatHoistBlocked)) {
        out.push(c);
        hoistedOut.add(c);
        if (isFlexItem && !positioned && !flexGridItemSC) {
          hoistedAsInline?.add(c);
        }
        // DM-712 / DM-687: a flex/grid item hoisted because of its explicit
        // z-index (not because it's positioned) loses its z-bucket info once
        // it's a child of the SC root for sort purposes. Tag it so the sort
        // still buckets it by z. Without this, e.g. resend.com's "Contact
        // management" card paints its z:10 content BEFORE its z:auto
        // absolute-positioned gradient overlay sibling (gradient ends up on
        // top and reads as solid black), and `13-deep-z-index-flex-grid`
        // painted A z:4 BEHIND D z:2 because its flex container hung off the
        // implicit root SC.
        if (flexGridItemSC && !positioned) {
          hoistedAsZSorted?.add(c);
        }
        // DM-673: if we hoisted `c` past an overflow-clip ancestor (and
        // `c` isn't `position:fixed` — which escapes overflow per CSS
        // Overflow 3 §2.2), remember the ancestor so the renderer can
        // re-wrap `c` in its clip-path.
        if (currentOverflowAncestor != null && c.styles.position !== "fixed") {
          overflowClipForHoisted?.set(c, currentOverflowAncestor);
        }
      }
      // DM-673: also recurse THROUGH `overflow != visible` SCs whose ONLY
      // SC-creating property is the overflow (per `isOverflowOnlySC`). Per
      // Chrome's paint model these scroll containers paint atomically only
      // for their bg/border at step 3, while positioned descendants escape
      // to the parent SC's step 6 — intermixed in tree order with sibling
      // positioned descendants. Mark `c` as the overflow ancestor so any
      // descendant we hoist further down gets the clip-path applied.
      const cIsOverflowOnly = isOverflowOnlySC(c);
      if (!establishesStackingContext(c, childParentDisplay) || cIsOverflowOnly) {
        // Block float hoisting from this point downward if `c` itself is a
        // positioned z=auto/0 element — its descendants' floats paint with
        // it atomically, not at the parent SC. Existing float-block state
        // propagates downward too.
        const cBlocks = positioned && !hasExplicitZ;
        const nextOverflowAncestor = cIsOverflowOnly ? c : currentOverflowAncestor;
        collectFromNonSC(c, floatHoistBlocked || cBlocks, nextOverflowAncestor);
      }
    }
  };
  for (const c of children) {
    if (hoistedOut.has(c)) continue;
    out.push(c);
    const cIsOverflowOnly = isOverflowOnlySC(c);
    if (!establishesStackingContext(c, parentDisplay) || cIsOverflowOnly) {
      // If `c` is a `position:relative/absolute` with `z-index: auto/0` it
      // paints atomically at step 6 — block float hoisting from its subtree
      // (matches the `cBlocks` rule inside collectFromNonSC).
      const cPositioned = c.styles.position != null && c.styles.position !== "static";
      const cZRaw = c.styles.zIndex;
      const cHasExplicitZ = cZRaw != null && cZRaw !== "" && cZRaw !== "auto";
      // DM-673: if `c` is an overflow-only SC, mark `c` as the overflow
      // ancestor for any positioned descendant we hoist out of it.
      const nextOverflowAncestor = cIsOverflowOnly ? c : null;
      collectFromNonSC(c, cPositioned && !cHasExplicitZ, nextOverflowAncestor);
    }
  }
  return out;
}

/**
 * DM-673: returns true when `el` is a stacking context whose ONLY reason
 * for being one is `overflow != visible`. Such elements are scroll
 * containers but not "real" SCs in Chrome's paint model — their bg/border
 * paint in normal flow at CSS 2.1 Appendix E step 3, while their
 * positioned descendants escape to the parent SC's step 6 (intermixed in
 * tree order with positioned descendants from sibling overflow scrollers
 * and `position:fixed` descendants that escape their CBs).
 *
 * Pixel-probed evidence from `13-deep-fixed-in-transform`: pin 0 (escaped
 * fixed-to-viewport) is visible BELOW `.frame`'s bottom at y=748-758 over
 * section 2's bg (so pin 0 paints AFTER section 2 bg), but `.frame`'s
 * beige bg covers pin 0 at y=737-746 (so `.frame` paints AFTER pin 0).
 * That interleaving is only possible if section 2 is non-atomic and
 * `.frame` hoists to body's step 6 alongside pin 0.
 *
 * For SCs that have ANY other SC-creating property (positioned, transform,
 * filter, opacity, etc.), we still keep them atomic — their descendants
 * are contained by the layer, matching Chrome's behavior.
 */
export function isOverflowOnlySC(el: CapturedElement): boolean {
  const s = el.styles;
  // An animation target must stay atomic so its descendants render INSIDE its
  // `anim-<id>` wrapper (see establishesStackingContext). Treating it as a
  // pass-through overflow-only scroller would hoist its children out and the
  // animation would only move the element's own box, not its content.
  if (el.animId != null && el.animId !== "") return false;
  // Must actually create an SC via overflow
  const ox = s.overflowX;
  const oy = s.overflowY;
  const overflowIsSC = (ox != null && ox !== "visible") || (oy != null && oy !== "visible");
  if (!overflowIsSC) return false;
  // Must have NO other SC-creating property
  const positioned = s.position != null && s.position !== "static";
  if (positioned) return false;
  if (s.transform != null && s.transform !== "" && s.transform !== "none") return false;
  if (s.transformCreatesSc) return false;
  if (s.transformStyle != null && s.transformStyle !== "" && s.transformStyle !== "flat") return false;
  const op = parseFloat(s.opacity);
  if (Number.isFinite(op) && op < 1) return false;
  if (s.filter != null && s.filter !== "" && s.filter !== "none") return false;
  if (s.mixBlendMode != null && s.mixBlendMode !== "" && s.mixBlendMode !== "normal") return false;
  if (s.maskImage != null && s.maskImage !== "" && s.maskImage !== "none") return false;
  if (s.clipPath != null && s.clipPath !== "" && s.clipPath !== "none") return false;
  if (s.isolation === "isolate") return false;
  if (s.contain != null && s.contain !== "" && s.contain !== "none") {
    if (/\b(?:paint|strict|content)\b/i.test(s.contain)) return false;
  }
  if (s.willChange != null && s.willChange !== "" && s.willChange !== "auto") {
    const _scWcProps: ReadonlySet<string> = new Set([
      "transform", "opacity", "filter", "backdrop-filter",
      "mask", "mask-image", "clip-path", "perspective",
      "top", "right", "bottom", "left",
      "position", "z-index", "isolation", "mix-blend-mode", "contain",
    ]);
    const tokens = s.willChange.split(/[\s,]+/);
    for (const t of tokens) {
      if (_scWcProps.has(t.toLowerCase())) return false;
    }
  }
  return true;
}
