/** Native CSS resource paint; never reads/refetches resource bytes or changes CSP. */
import type { Page } from "@playwright/test";
import sharp from "sharp";
import { openCssSvgShadowGuard } from "./external-css-svg-shadow-guard.js";
import { evaluateInFrame } from "./evaluate-in-frame.js";
import type { ExternalCssSvgJournal } from "./external-css-svg.js";
import {
  cssSvgScreenshotTimeLeft,
  EXTERNAL_CSS_SVG_PIXEL_BUDGET,
  EXTERNAL_CSS_SVG_SCREENSHOT_MS,
  readExternalCssSvgScreenshotSpace,
  type ExternalCssSvgScreenshotRect,
} from "./external-css-svg-screenshot.js";
import { privateCaptureKey } from "./private-key.js";
import type { CapturedElement } from "./types.js";
import { isTransparentBackground } from "../utils/transparent-background.js";

export interface CssSvgIsolation {
  attribute: string;
  marked: Array<{ element: Element; before: string | null; owned: string }>;
  sheet: HTMLStyleElement;
  text: string;
  rules: string;
  ownerFacts: Array<{ element: Element; styles: string[]; children: Node[] }>;
  ancestors: Element[];
  slotAssignmentsChanged: boolean;
  slotListeners: AbortController;
  textObserver?: MutationObserver;
  textChanged?: boolean;
  /** Outside never-painted local definitions kept at their native style. */
  dependencies: Array<{ element: Element; styles: string }>;
  /** The ancestor path paints direct text or markers, hidden via text channels. */
  ancestorText: boolean;
  /** One owned constructed copy of the isolation rules adopted by each author root,
   * since a document sheet never matches inside a shadow tree. */
  shadowSheets: Array<{
    root: ShadowRoot;
    sheet: CSSStyleSheet;
    rules: string;
    before: CSSStyleSheet[];
    released: boolean;
  }>;
}
type Identity = { key: string; token: string };
interface AncestorPaint {
  backgroundImage: string;
  boxShadow: string;
  borderImageSource: string;
  colors: string[];
  /** Ancestor alpha is neutralized for the stamp; the renderer re-applies it. */
  opacity: string;
  /** Text-paint colors and shadow; empty unless the ancestor path paints text. */
  text: string[];
}
function requireTransparentAncestors(facts: AncestorPaint[], message: string): void {
  if (
    facts.some(
      (fact) =>
        fact.opacity !== "1" ||
        // text-shadow must be `none`; every color must be transparent.
        fact.text.some((value) =>
          /\d+(?:\.\d+)?px/.test(value) ? true : value !== "none" && !isTransparentBackground(value),
        ) ||
        fact.backgroundImage !== "none" ||
        fact.boxShadow !== "none" ||
        fact.borderImageSource !== "none" ||
        fact.colors.some((color) => !isTransparentBackground(color)),
    )
  )
    throw new Error(message);
}
async function bounded<T>(work: Promise<T>, timeout = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("external CSS native paint operation timed out")), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function restoreExternalCssSvgIsolation(page: Page, identity: Identity): Promise<void> {
  if (page.isClosed()) return;
  const failures = await bounded(
    evaluateInFrame(
      page,
      ({ key, token }) => {
        const state = (globalThis as Record<string, unknown>)[key] as ExternalCssSvgJournal | undefined;
        if (state == null) return 0;
        if (state.token !== token) return 1;
        // Registered closed roots never outlive one isolation attempt.
        state.authorShadowRoots = undefined;
        const isolation = state.isolation;
        if (isolation == null) return 0;
        let failures = 0;
        try {
          isolation.slotListeners.abort();
        } catch {
          failures++;
        }
        try {
          isolation.textObserver?.disconnect();
        } catch {
          failures++;
        }
        // Always release an owned adopted sheet by identity; a changed author list
        // or mutated owned rules is reported, never repaired.
        for (const saved of isolation.shadowSheets) {
          if (saved.released) continue;
          try {
            const current = [...saved.root.adoptedStyleSheets];
            const rules = Array.from(saved.sheet.cssRules)
              .map((rule) => rule.cssText)
              .join("\n");
            const next = current.filter((sheet) => sheet !== saved.sheet);
            if (next.length !== current.length) saved.root.adoptedStyleSheets = next;
            saved.released = true;
            if (
              next.length === current.length ||
              rules !== saved.rules ||
              next.length !== saved.before.length ||
              next.some((sheet, index) => sheet !== saved.before[index])
            )
              failures++;
          } catch {
            failures++;
          }
        }
        // Release only our stylesheet, even when a foreign marker prevents complete
        // cleanup. Never leave a known-owned hide sheet active merely to retain evidence.
        if (isolation.sheet.isConnected) {
          try {
            const rules = Array.from(isolation.sheet.sheet?.cssRules ?? [])
              .map((rule) => rule.cssText)
              .join("\n");
            if (
              isolation.sheet.textContent !== isolation.text ||
              rules !== isolation.rules ||
              isolation.sheet.attributes.length !== 0
            )
              failures++;
            else isolation.sheet.remove();
          } catch {
            failures++;
          }
        }
        for (const saved of isolation.marked) {
          try {
            if (saved.element.getAttribute(isolation.attribute) === saved.before) continue;
            if (saved.element.getAttribute(isolation.attribute) !== saved.owned) {
              failures++;
              continue;
            }
            if (saved.before == null) saved.element.removeAttribute(isolation.attribute);
            else saved.element.setAttribute(isolation.attribute, saved.before);
            if (saved.element.getAttribute(isolation.attribute) !== saved.before) failures++;
          } catch {
            failures++;
          }
        }
        if (failures === 0) state.isolation = undefined;
        return failures;
      },
      identity,
    ),
    1000,
  );
  if (failures > 0) throw new Error(`${failures} external CSS native isolation cleanup operations unconfirmed`);
}

async function readNativeOwnerScreenshot(page: Page, viewport: ExternalCssSvgScreenshotRect) {
  const deadline = Date.now() + EXTERNAL_CSS_SVG_SCREENSHOT_MS;
  const live = await readExternalCssSvgScreenshotSpace(page, false);
  const fullPage =
    viewport.x < 0 ||
    viewport.y < 0 ||
    viewport.x + viewport.width > live.width ||
    viewport.y + viewport.height > live.height;
  let clip = viewport;
  let offsetX = 0;
  let offsetY = 0;
  const space = fullPage ? await readExternalCssSvgScreenshotSpace(page, true) : null;
  if (space != null) {
    const x = viewport.x + space.x;
    const y = viewport.y + space.y;
    const left = Math.max(0, x);
    const top = Math.max(0, y);
    clip = {
      x: left,
      y: top,
      width: Math.min(space.width, x + viewport.width) - left,
      height: Math.min(space.height, y + viewport.height) - top,
    };
    if (clip.width <= 0 || clip.height <= 0) return null;
    offsetX = left - x;
    offsetY = top - y;
    if (clip.width * clip.height * space.scale ** 2 > EXTERNAL_CSS_SVG_PIXEL_BUDGET)
      throw new Error("external CSS native full-page paint budget exceeded");
  }
  const shot = await page.screenshot({
    clip,
    fullPage,
    omitBackground: true,
    type: "png",
    timeout: cssSvgScreenshotTimeLeft(deadline),
  });
  if (space != null) {
    const current = await readExternalCssSvgScreenshotSpace(page, true);
    if (
      current.x !== space.x ||
      current.y !== space.y ||
      current.width !== space.width ||
      current.height !== space.height ||
      current.scale !== space.scale
    )
      throw new Error("external CSS native full-page paint screenshot coordinates changed");
  }
  return { shot, clip, offsetX, offsetY, scale: space?.scale };
}

export async function rasterizeExternalCssSvgSurfaces(
  page: Page,
  tree: CapturedElement[],
  viewport: ExternalCssSvgScreenshotRect,
  identity: Identity,
): Promise<void> {
  const targets: NonNullable<CapturedElement["externalCssSvgRaster"]>[] = [];
  const visit = (nodes: CapturedElement[]) => {
    for (const node of nodes) {
      if (node.externalCssSvgRaster != null) targets.push(node.externalCssSvgRaster);
      else if (
        node.projectiveHidden !== true &&
        node.svgContent == null &&
        node.backdropCompositeRaster?.dataUri == null &&
        node.transformSubtreeRaster == null &&
        node.nativeControlRaster == null &&
        node.urlFilterRaster == null
      )
        visit(node.children ?? []);
    }
  };
  visit(tree);
  if (targets.length === 0) return;
  if (targets.length > 32 || viewport.width * viewport.height > EXTERNAL_CSS_SVG_PIXEL_BUDGET)
    throw new Error("external CSS native paint budget exceeded");
  for (const [targetIndex, target] of targets.entries()) {
    let shadowGuard: Awaited<ReturnType<typeof openCssSvgShadowGuard>> | undefined;
    let primary: unknown;
    let failed = false;
    try {
      const attribute = `data-${privateCaptureKey("CssPaint").toLowerCase()}`;
      // Registers the actual open and closed author roots before isolation reaches them.
      shadowGuard = await openCssSvgShadowGuard(page, { ...identity, ownerToken: target.token });
      const beforePaint = await bounded(
        evaluateInFrame(
          page,
          ({ key, token, ownerToken, targetIndex, attribute }) => {
            const state = (globalThis as Record<string, unknown>)[key] as ExternalCssSvgJournal | undefined;
            if (state?.token !== token || state.isolation != null)
              throw new Error("external CSS paint document identity unavailable");
            const selected = [...state.rasterOwners].filter(([, value]) => value.token === ownerToken);
            if (selected.length !== 1) throw new Error("external CSS paint owner identity unavailable");
            const [owner, facts] = selected[0];
            if (owner.ownerDocument !== document)
              throw new Error("external CSS paint owner document identity unavailable");
            if (
              !(owner instanceof HTMLElement) ||
              owner === document.body ||
              owner === document.documentElement ||
              !owner.isConnected
            )
              throw new Error("external CSS native owner is outside the supported HTML boundary");
            for (const property of facts.properties)
              if (getComputedStyle(owner).getPropertyValue(property.property) !== property.computed)
                throw new Error("external CSS paint selection changed");
            // Every author tree scope, including closed roots registered by the
            // ownership guard. A document sheet and document-scoped queries never
            // reach inside a shadow tree, so each scope is walked and isolated.
            const roots = state.authorShadowRoots ?? [];
            const hosts = new Map<Element, ShadowRoot>();
            for (const root of roots) {
              if (
                !(root instanceof ShadowRoot) ||
                hosts.has(root.host) ||
                root.host.getRootNode({ composed: true }) !== document
              )
                throw new Error("external CSS native isolation author-shadow scope changed");
              hosts.set(root.host, root);
            }
            const scopes: Array<Document | ShadowRoot> = [document, ...roots];
            const everyElement = (): Element[] => scopes.flatMap((scope) => [...scope.querySelectorAll("*")]);
            // Open roots are page-visible; the CDP-registered set must cover them.
            for (const element of everyElement())
              if (element.shadowRoot != null && hosts.get(element) !== element.shadowRoot)
                throw new Error("external CSS native isolation author-shadow scope changed");
            const ownerScope = owner.getRootNode();
            if (ownerScope !== document && !(ownerScope instanceof ShadowRoot && roots.includes(ownerScope)))
              throw new Error("external CSS native owner tree scope is unavailable");
            // Flat-tree parent. A closed root's slot is hidden from `assignedSlot`,
            // so assignment is read from each registered root's own slots.
            const assigned = new Map<Node, HTMLSlotElement>();
            for (const root of roots)
              for (const slot of root.querySelectorAll("slot"))
                for (const node of slot.assignedNodes()) assigned.set(node, slot);
            const flatParent = (node: Node): Element | null => {
              const parent = node.parentNode;
              if (parent instanceof Element && hosts.has(parent)) return assigned.get(node) ?? null;
              if (parent instanceof ShadowRoot) return parent.host;
              if (parent instanceof HTMLSlotElement && parent.assignedNodes().length > 0) return null;
              return node.parentElement;
            };
            const flatChildren = (element: Element): Node[] => {
              const root = hosts.get(element);
              if (root != null) return [...root.childNodes];
              if (element instanceof HTMLSlotElement && roots.includes(element.getRootNode() as ShadowRoot)) {
                const nodes = element.assignedNodes();
                return nodes.length > 0 ? nodes : [...element.childNodes];
              }
              return [...element.childNodes];
            };
            if (
              facts.shadowPath?.some(
                (node, i, path) => (node instanceof ShadowRoot ? node.host : node.parentNode) !== (path[i + 1] ?? null),
              )
            )
              throw new Error("external CSS native owner source ancestry changed");
            const owned = new Set<Element>();
            const pendingOwner = [owner as Element];
            while (pendingOwner.length > 0) {
              const element = pendingOwner.pop()!;
              if (owned.has(element)) throw new Error("external CSS native owner flat subtree is ambiguous");
              owned.add(element);
              for (const child of flatChildren(element).reverse())
                if (child instanceof Element) pendingOwner.push(child);
            }
            for (const [branch, expected] of state.projectedChildren) {
              const current = flatChildren(branch);
              if (current.length !== expected.length || current.some((node, i) => node !== expected[i]))
                throw new Error("external CSS native owner projected branch changed");
            }
            for (const [node, source] of state.projectedText)
              if (!node.isConnected || node.data !== source.value || node.parentNode !== source.parent)
                throw new Error("external CSS projected text changed before isolation");
            if (
              owner.getAnimations({ subtree: true }).length > 0 ||
              // Each tree scope reports only its own animations.
              scopes.some((scope) =>
                scope
                  .getAnimations()
                  .some(
                    (animation) =>
                      animation instanceof CSSTransition ||
                      (animation.effect instanceof KeyframeEffect &&
                        animation.effect.target instanceof Element &&
                        owned.has(animation.effect.target)),
                  ),
              )
            )
              throw new Error("external CSS native owner has unsupported active animation or transitions");
            if (
              document.documentElement.clientWidth < innerWidth ||
              document.documentElement.clientHeight < innerHeight
            )
              throw new Error("external CSS native owner has unsupported exposed root scrollbars");
            const ancestors = new Set<Element>();
            let transformedAncestor = false;
            // An ancestor overflow clip is painted with the pixel-snapped clip
            // rect (`FragmentPaintPropertyTreeBuilder::UpdateOverflowClip` sets
            // `ToSnappedClipRect(clip_rect)` = `ToPixelSnappedRect`,
            // paint_property_tree_builder.cc:2536-2538, :3085-3099, pin
            // 7d859f27), so the stamp is hard-clipped on whole device pixels.
            // The renderer re-applies the captured padding-box clip; the two are
            // the same set of whole pixels, and applying it twice is exact,
            // only when that box is device-pixel aligned, unrounded, unscrolled
            // by scrollbars and untransformed. Anything else still refuses.
            let clippingAncestor = false;
            const rootOverflowPropagates = (element: Element) =>
              element === document.documentElement ||
              (element === document.body && getComputedStyle(document.documentElement).overflowX === "visible");
            const exactOverflowClip = (element: Element, style: CSSStyleDeclaration): boolean => {
              const clips =
                style.overflowX !== "visible" ||
                style.overflowY !== "visible" ||
                /paint|strict|content/.test(style.contain);
              if (!clips || rootOverflowPropagates(element)) return true;
              clippingAncestor = true;
              const dpr = devicePixelRatio;
              const rect = element.getBoundingClientRect();
              const aligned = (value: number) => Math.abs(value * dpr - Math.round(value * dpr)) < 1e-6;
              const left = parseFloat(style.borderLeftWidth);
              const top = parseFloat(style.borderTopWidth);
              const right = parseFloat(style.borderRightWidth);
              const bottom = parseFloat(style.borderBottomWidth);
              return (
                // hidden/clip only: auto/scroll can paint ancestor scrollbars,
                // and a one-axis clip leaves the other axis unclipped.
                /^(hidden|clip)$/.test(style.overflowX) &&
                /^(hidden|clip)$/.test(style.overflowY) &&
                style.overflowClipMargin === "0px" &&
                [
                  style.borderTopLeftRadius,
                  style.borderTopRightRadius,
                  style.borderBottomRightRadius,
                  style.borderBottomLeftRadius,
                ].every((radius) => radius === "0px") &&
                element instanceof HTMLElement &&
                aligned(rect.left + left) &&
                aligned(rect.top + top) &&
                aligned(rect.right - right) &&
                aligned(rect.bottom - bottom)
              );
            };
            let topmost: Element = owner;
            for (let ancestor = flatParent(owner); ancestor != null; ancestor = flatParent(ancestor))
              topmost = ancestor;
            // An unassigned light child of a host is outside the flat tree.
            if (topmost !== document.documentElement)
              throw new Error("external CSS native owner is outside the flat tree");
            for (let ancestor = flatParent(owner); ancestor != null; ancestor = flatParent(ancestor)) {
              ancestors.add(ancestor);
              const style = getComputedStyle(ancestor);
              // A static 2D ancestor transform is frozen by the walk and re-applied
              // by the renderer's <g transform>; the stamp is a viewport-space crop
              // placed through the inverse of that CTM. 3D and individual-property
              // transforms are not part of that contract.
              if (style.transform !== "none") transformedAncestor = true;
              if (
                ancestor.getAnimations().length > 0 ||
                /^matrix3d\(/.test(style.transform) ||
                style.perspective !== "none" ||
                style.transformStyle === "preserve-3d" ||
                style.rotate !== "none" ||
                style.scale !== "none" ||
                style.translate !== "none" ||
                style.offsetPath !== "none" ||
                style.filter !== "none" ||
                style.backdropFilter !== "none" ||
                style.maskImage !== "none" ||
                style.clipPath !== "none" ||
                style.mixBlendMode !== "normal" ||
                !exactOverflowClip(ancestor, style) ||
                style.zoom !== "1" ||
                style.textDecorationLine !== "none" ||
                // An image marker cannot be made transparent through `color`.
                (style.display.includes("list-item") && style.listStyleImage !== "none")
              )
                throw new Error("external CSS native owner has unsupported ancestor effects or clipping");
            }
            // A snapped clip under a transform is antialiased in device space.
            if (clippingAncestor && transformedAncestor)
              throw new Error("external CSS native owner has unsupported ancestor effects or clipping");
            // Same-document resource definitions outside the owner would be hidden
            // with foreign paint. Keep their transitive closure at its native
            // style instead, but only when it is content Blink never paints
            // directly, so no foreign visible paint can enter the stamp.
            const here = new URL(document.URL);
            here.hash = "";
            // DecodeUrlEscapeSequences(kUtf8OrIsomorphic), url/url_util.cc:833-891
            // at pin 7d859f27 (Node twin: src/capture/blink-url-fragment.ts).
            const decode = (input: string): string => {
              const source = new TextEncoder().encode(input);
              const bytes: number[] = [];
              const hex = (byte: number) => /[0-9a-f]/i.test(String.fromCharCode(byte));
              for (let index = 0; index < source.length; index++) {
                if (
                  source[index] === 0x25 &&
                  index + 2 < source.length &&
                  hex(source[index + 1]) &&
                  hex(source[index + 2])
                ) {
                  bytes.push(parseInt(String.fromCharCode(source[index + 1], source[index + 2]), 16));
                  index += 2;
                } else bytes.push(source[index]);
              }
              try {
                return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(bytes));
              } catch {
                return bytes.map((byte) => String.fromCharCode(byte)).join("");
              }
            };
            // CSSUrlData::IsLocal (css_url_data.cc:231-234) and
            // SVGURLReferenceResolver (svg_uri_reference.cc:89-111): local when
            // the specified URL starts with '#' or equals the document URL.
            const localTarget = (raw: string, element: Element): Element | null => {
              let url: URL;
              try {
                url = new URL(raw, element.baseURI);
              } catch {
                return null;
              }
              const fragment = url.hash.slice(1);
              url.hash = "";
              if ((!raw.startsWith("#") && url.href !== here.href) || fragment === "") return null;
              const scope = element.getRootNode();
              if (!(scope instanceof Document || scope instanceof ShadowRoot))
                throw new Error("external CSS native local-definition tree scope is unavailable");
              return scope.getElementById(decode(fragment));
            };
            const urls = (value: string): string[] =>
              [...value.matchAll(/url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))\s*\)/gi)].map((match) =>
                (match[1] ?? match[2] ?? match[3]).replace(/\\(.)/g, "$1"),
              );
            const referenceProperties = [
              "clip-path",
              "mask-image",
              "filter",
              "fill",
              "stroke",
              "marker-start",
              "marker-mid",
              "marker-end",
            ];
            // SVGURIReference::LegacyHrefString (svg_uri_reference.cc:82-87): href wins over xlink:href.
            const hrefOwners = new Set([
              "use",
              "lineargradient",
              "radialgradient",
              "pattern",
              "feimage",
              "textpath",
              "mpath",
            ]);
            // LayoutSVGHiddenContainer paints nothing: <defs>, <symbol> and every
            // LayoutSVGResourceContainer (layout_svg_hidden_container.h:29-52,
            // layout_svg_resource_container.h:45, svg_defs_element.cc:31-33).
            const neverPainted = new Set([
              "defs",
              "symbol",
              "clippath",
              "mask",
              "pattern",
              "marker",
              "filter",
              "lineargradient",
              "radialgradient",
            ]);
            const dependencies = new Set<Element>();
            const pending: Element[] = [];
            const requireDependency = (target: Element | null): void => {
              if (target == null || owned.has(target) || dependencies.has(target) || pending.includes(target)) return;
              if (ancestors.has(target) || target.contains(owner))
                throw new Error("external CSS native owner has an outside local-definition dependency containing it");
              let hidden = false;
              for (let node: Element | null = target; node != null && !hidden; node = node.parentElement)
                hidden = node instanceof SVGElement && neverPainted.has(node.localName.toLowerCase());
              if (!(target instanceof SVGElement) || !hidden)
                throw new Error(
                  "external CSS native owner has an unsupported directly painted outside local-definition dependency",
                );
              pending.push(target);
            };
            const scanReferences = (element: Element, pseudos: string[]): void => {
              for (const pseudo of pseudos) {
                const computed = getComputedStyle(element, pseudo || null);
                for (const name of referenceProperties)
                  for (const raw of urls(computed.getPropertyValue(name))) requireDependency(localTarget(raw, element));
              }
              if (element instanceof SVGElement && hrefOwners.has(element.localName.toLowerCase())) {
                const href =
                  element.getAttribute("href") ?? element.getAttributeNS("http://www.w3.org/1999/xlink", "href");
                if (href != null) requireDependency(localTarget(href, element));
              }
            };
            for (const element of owned) {
              const style = getComputedStyle(element);
              if (style.backdropFilter !== "none" || style.mixBlendMode !== "normal")
                throw new Error("external CSS native owner requires backdrop compositing");
              scanReferences(element, ["", "::before", "::after"]);
            }
            // Transitive closure; the visited set terminates cycles and shared defs.
            while (pending.length > 0) {
              const root = pending.pop()!;
              for (const element of [root, ...root.querySelectorAll("*")]) {
                if (dependencies.has(element)) continue;
                dependencies.add(element);
                scanReferences(element, [""]);
              }
            }
            if (dependencies.size > 4096)
              throw new Error("external CSS native owner local-definition dependency budget exceeded");
            for (const element of everyElement()) {
              for (const pseudo of ["", "::before", "::after"]) {
                const style = getComputedStyle(element, pseudo || null);
                const affected = ancestors.has(element)
                  ? /^(all|visibility|opacity|background(?:-.*)?|border(?:-.*)?|box-shadow|outline(?:-.*)?)$/
                  : /^(all|visibility)$/;
                if (
                  style.transitionProperty.split(",").some((name) => affected.test(name.trim())) &&
                  style.transitionDuration.split(",").some((duration) => parseFloat(duration) > 0)
                )
                  throw new Error("external CSS native isolation has unsupported transition channels");
              }
            }
            const boost = ":not(#domotion-css-isolation-unused)";
            const hide = boost.repeat(2);
            const show = boost.repeat(3);
            const sheet = document.createElement("style");
            const fingerprintEntries = (element: Element, pseudo: string) => {
              const style = getComputedStyle(element, pseudo || null);
              return Array.from(style).map((name) => `${name}:${style.getPropertyValue(name)}`);
            };
            const fingerprint = (element: Element, pseudo: string) => fingerprintEntries(element, pseudo).join("\n");
            const isolation: CssSvgIsolation = {
              attribute,
              marked: [],
              sheet,
              text: "",
              rules: "",
              ownerFacts: [...owned].map((element) => ({
                element,
                children: flatChildren(element),
                styles: ["", "::before", "::after"].map((pseudo) => fingerprint(element, pseudo)),
              })),
              ancestors: [...ancestors],
              slotAssignmentsChanged: false,
              slotListeners: new AbortController(),
              ancestorText: false,
              dependencies: [...dependencies].map((element) => ({ element, styles: fingerprint(element, "") })),
              shadowSheets: [],
            };
            // Publish ownership before any mutation, including a throwing setter.
            state.isolation = isolation;
            if (state.projectedText.size > 0) {
              const observer = new MutationObserver(() => {
                isolation.textChanged = true;
              });
              isolation.textObserver = observer;
              for (const [node, source] of state.projectedText) {
                observer.observe(node, { characterData: true });
                if (source.parent != null) observer.observe(source.parent, { childList: true });
              }
            }
            // A slot assignment can change and return to the same nodes between
            // screenshots. Listen in the actual root, including closed scopes.
            for (const root of roots)
              root.addEventListener(
                "slotchange",
                () => {
                  isolation.slotAssignmentsChanged = true;
                },
                {
                  capture: true,
                  signal: isolation.slotListeners.signal,
                },
              );
            const rules = [
              `*:not([${attribute}])${hide},*:not([${attribute}])${hide}::before,*:not([${attribute}])${hide}::after{visibility:hidden!important}`,
            ];
            // Hiding an ancestor can suppress an external SVG mask even after its
            // owner is re-shown. Keep native ancestor visibility and remove only
            // paint channels which cannot contribute to the owner's isolated stamp.
            // Direct ancestor text, ::first-line/::first-letter and text markers
            // paint through inherited text-paint channels; make them transparent
            // on the ancestor path and pin the owner to its own computed values
            // so nothing it or its subtree inherits changes.
            // Only when the ancestor path paints text at all, so ordinary owners
            // keep the exact pre-existing isolation.
            const ancestorText = [...ancestors].some(
              (ancestor) =>
                getComputedStyle(ancestor).display.includes("list-item") ||
                flatChildren(ancestor).some(
                  (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "",
                ),
            );
            isolation.ancestorText = ancestorText;
            // Hiding inherited text paint needs a pin rule matched on the owner,
            // and a CSP-blocked external CSS mask whose owner gains a newly
            // matched (or inline) declaration stops painting natively (measured:
            // the stamp comes back fully transparent; an inherited-only change
            // or a plain re-attach keeps it). Clip paths survive; masks under
            // ancestor text refuse.
            if ([...owned].some((element) => getComputedStyle(element).maskImage !== "none")) {
              if (ancestorText) throw new Error("external CSS native owner has unsupported ancestor text over a mask");
              // With even an unused document font face, removing the isolation
              // sheet can clear the source mask after a correct PNG readback.
              if (
                document.fonts.size > 0 &&
                [...state.projectedText.values()].some(
                  (source) => source.parent !== source.flatParent && !owned.has(source.flatParent),
                )
              )
                throw new Error("external CSS projected text cannot preserve a native mask with document font faces");
            }
            const textHide = ancestorText
              ? ";color:transparent!important;-webkit-text-fill-color:transparent!important;-webkit-text-stroke-color:transparent!important;text-shadow:none!important;text-emphasis-color:transparent!important"
              : "";
            for (const ancestor of ancestors) {
              const index = String(isolation.marked.length);
              rules.push(
                `[${attribute}="${index}"]${show}{background:transparent!important;border-color:transparent!important;border-image:none!important;box-shadow:none!important;outline-color:transparent!important;opacity:1!important${textHide}}`,
              );
              rules.push(
                `[${attribute}="${index}"]${show}::before,[${attribute}="${index}"]${show}::after{visibility:hidden!important}`,
              );
              if (ancestorText) {
                rules.push(
                  `[${attribute}="${index}"]${show}::first-line,[${attribute}="${index}"]${show}::first-letter{background:transparent!important${textHide}}`,
                );
                rules.push(`[${attribute}="${index}"]${show}::marker{color:transparent!important}`);
              }
              isolation.marked.push({ element: ancestor, before: ancestor.getAttribute(attribute), owned: index });
              ancestor.setAttribute(attribute, index);
            }
            // The owner keeps its own text paint. Colors equal to `color` are
            // pinned as `currentcolor`, which inherits as a keyword like the
            // initial value; any other difference is caught by the owner-subtree
            // fingerprint check below and refuses.
            const ownerText = getComputedStyle(owner);
            const pinned = (
              [
                ["color", ownerText.color],
                ["-webkit-text-fill-color", ownerText.webkitTextFillColor],
                ["-webkit-text-stroke-color", ownerText.webkitTextStrokeColor],
                ["text-shadow", ownerText.textShadow],
                ["text-emphasis-color", ownerText.textEmphasisColor],
              ] as const
            )
              .map(([name, value]) => {
                if (/[;{}!]/.test(value)) throw new Error("external CSS native owner text paint is unsupported");
                const pin =
                  name !== "color" && name !== "text-shadow" && value === ownerText.color ? "currentcolor" : value;
                return `${name}:${pin}!important`;
              })
              .join(";");
            for (const element of owned) {
              const index = String(isolation.marked.length);
              if (element === owner && ancestorText) rules.push(`[${attribute}="${index}"]${show}{${pinned}}`);
              isolation.marked.push({ element, before: element.getAttribute(attribute), owned: index });
              element.setAttribute(attribute, index);
            }
            // A dependency inherits `hidden` from its hidden foreign ancestors,
            // so pin each element's own native visibility explicitly.
            for (const element of dependencies) {
              const visibility = getComputedStyle(element).visibility;
              if (!/^(visible|hidden|collapse)$/.test(visibility))
                throw new Error("external CSS native dependency visibility is unsupported");
              const index = String(isolation.marked.length);
              rules.push(`[${attribute}="${index}"]${show}{visibility:${visibility}!important}`);
              isolation.marked.push({ element, before: element.getAttribute(attribute), owned: index });
              element.setAttribute(attribute, index);
            }
            isolation.text = rules.join("\n");
            sheet.textContent = isolation.text;
            try {
              (document.head ?? document.documentElement).appendChild(sheet);
            } finally {
              isolation.rules = Array.from(sheet.sheet?.cssRules ?? [])
                .map((rule) => rule.cssText)
                .join("\n");
            }
            if (sheet.sheet == null) throw new Error("external CSS native isolation stylesheet was refused");
            // The same rules in each author root, appended last to its adopted
            // sheets. Selectors match only within the adopting tree scope, so one
            // global attribute index serves every scope.
            for (const root of roots) {
              const owned = new CSSStyleSheet();
              owned.replaceSync(isolation.text);
              const saved = {
                root,
                sheet: owned,
                rules: Array.from(owned.cssRules)
                  .map((rule) => rule.cssText)
                  .join("\n"),
                before: [...root.adoptedStyleSheets],
                released: false,
              };
              if (saved.rules !== isolation.rules)
                throw new Error("external CSS native isolation stylesheet was refused");
              // Publish ownership before the mutation.
              isolation.shadowSheets.push(saved);
              root.adoptedStyleSheets = [...saved.before, owned];
            }
            for (const [ownerIndex, fact] of isolation.ownerFacts.entries()) {
              for (const [index, pseudo] of ["", "::before", "::after"].entries()) {
                const entries = fingerprintEntries(fact.element, pseudo);
                const before = fact.styles[index];
                if (entries.join("\n") === before) continue;

                // Locate the first differing entry at the live declaration's
                // boundaries. A computed value can itself contain a newline.
                // Log only a stable subtree ordinal and a standard name.
                let offset = 0;
                let property = "property-list";
                for (const entry of entries) {
                  const end = offset + entry.length;
                  if (!before.startsWith(entry, offset) || (end < before.length && before[end] !== "\n")) {
                    const name = entry.slice(0, entry.indexOf(":"));
                    if (before.startsWith(`${name}:`, offset))
                      property = name.startsWith("--")
                        ? "custom-property"
                        : /^-?[a-z][a-z0-9-]{0,79}$/.test(name)
                          ? name
                          : "unavailable";
                    break;
                  }
                  offset = end + 1;
                }
                throw new Error(
                  `external CSS native isolation changed inherited owner paint (target-index=${targetIndex}, owner-index=${ownerIndex}, pseudo=${pseudo || "element"}, property=${property})`,
                );
              }
            }
            for (const fact of isolation.dependencies)
              if (fingerprint(fact.element, "") !== fact.styles)
                throw new Error("external CSS native isolation changed an outside local-definition dependency");
            const textPaint = (element: Element, style: CSSStyleDeclaration): string[] => {
              const firstLine = getComputedStyle(element, "::first-line");
              const firstLetter = getComputedStyle(element, "::first-letter");
              return [
                style.color,
                style.webkitTextFillColor,
                style.webkitTextStrokeColor,
                style.textEmphasisColor,
                style.textShadow,
                firstLine.color,
                firstLine.webkitTextFillColor,
                firstLine.textShadow,
                firstLetter.color,
                firstLetter.webkitTextFillColor,
                firstLetter.textShadow,
                getComputedStyle(element, "::marker").color,
              ];
            };
            const paint: AncestorPaint[] = [];
            for (const element of everyElement()) {
              if (owned.has(element) || dependencies.has(element)) continue;
              if (ancestors.has(element)) {
                const style = getComputedStyle(element);
                paint.push({
                  backgroundImage: style.backgroundImage,
                  boxShadow: style.boxShadow,
                  borderImageSource: style.borderImageSource,
                  colors: [
                    style.backgroundColor,
                    style.borderTopColor,
                    style.borderRightColor,
                    style.borderBottomColor,
                    style.borderLeftColor,
                    style.outlineColor,
                  ],
                  opacity: style.opacity,
                  text: isolation.ancestorText ? textPaint(element, style) : [],
                });
                for (const pseudo of ["::before", "::after"])
                  if (getComputedStyle(element, pseudo).visibility !== "hidden")
                    throw new Error("external CSS native isolation could not suppress ancestor pseudo paint");
                continue;
              }
              for (const pseudo of ["", "::before", "::after"])
                if (getComputedStyle(element, pseudo || null).visibility !== "hidden")
                  throw new Error("external CSS native isolation could not suppress foreign paint");
            }
            return { paint, transformed: transformedAncestor, fullPageMismatch: facts.fullPageMismatch };
          },
          { ...identity, ownerToken: target.token, targetIndex, attribute },
        ),
      );
      requireTransparentAncestors(beforePaint.paint, "external CSS native isolation could not suppress ancestor paint");
      await shadowGuard.arm();
      const readback = await bounded(readNativeOwnerScreenshot(page, viewport));
      if (readback == null) {
        target.empty = true;
        continue;
      }
      const { shot, clip, offsetX, offsetY, scale } = readback;
      const afterPaint = await bounded(
        evaluateInFrame(
          page,
          ({ key, token, ownerToken }) => {
            const state = (globalThis as Record<string, unknown>)[key] as ExternalCssSvgJournal | undefined;
            if (state?.token !== token || state.isolation == null)
              throw new Error("external CSS paint document changed during screenshot");
            const selected = [...state.rasterOwners].find(([, value]) => value.token === ownerToken);
            if (selected == null || !selected[0].isConnected || selected[0].ownerDocument !== document)
              throw new Error("external CSS paint owner changed during screenshot");
            // The scopes isolated before the screenshot, each still holding its owned sheet.
            const isolation = state.isolation;
            if (isolation.slotAssignmentsChanged)
              throw new Error("external CSS shadow ownership changed during slot assignment");
            if (isolation.textChanged || isolation.textObserver?.takeRecords().length)
              throw new Error("external CSS projected text changed during screenshot");
            for (const [node, source] of state.projectedText) {
              const current = [...source.range.getClientRects()];
              if (
                !node.isConnected ||
                node.data !== source.value ||
                node.parentNode !== source.parent ||
                source.range.startContainer !== node ||
                source.range.endContainer !== node ||
                source.range.startOffset !== 0 ||
                source.range.endOffset !== node.length ||
                current.length !== source.rects.length ||
                current.some((rect, i) => {
                  const original = source.rects[i];
                  return (
                    rect.x !== original.x ||
                    rect.y !== original.y ||
                    rect.width !== original.width ||
                    rect.height !== original.height
                  );
                })
              )
                throw new Error("external CSS projected text identity or geometry changed during screenshot");
            }
            const roots = isolation.shadowSheets.map((saved) => saved.root);
            if (
              roots.length !== (state.authorShadowRoots ?? []).length ||
              isolation.shadowSheets.some(
                (saved, index) =>
                  saved.root !== state.authorShadowRoots![index] ||
                  !saved.root.host.isConnected ||
                  !saved.root.adoptedStyleSheets.includes(saved.sheet),
              )
            )
              throw new Error("external CSS native author-shadow isolation changed during screenshot");
            const hosts = new Map(roots.map((root) => [root.host, root] as const));
            const everyElement = (): Element[] =>
              [document, ...roots].flatMap((scope) => [...scope.querySelectorAll("*")]);
            for (const element of everyElement())
              if (element.shadowRoot != null && hosts.get(element) !== element.shadowRoot)
                throw new Error("external CSS native author-shadow isolation changed during screenshot");
            const assigned = new Map<Node, HTMLSlotElement>();
            for (const root of roots)
              for (const slot of root.querySelectorAll("slot"))
                for (const node of slot.assignedNodes()) assigned.set(node, slot);
            const flatParent = (node: Node): Element | null => {
              const parent = node.parentNode;
              if (parent instanceof Element && hosts.has(parent)) return assigned.get(node) ?? null;
              if (parent instanceof ShadowRoot) return parent.host;
              if (parent instanceof HTMLSlotElement && parent.assignedNodes().length > 0) return null;
              return node.parentElement;
            };
            const owned = new Set(state.isolation.ownerFacts.map((fact) => fact.element));
            const flatChildren = (element: Element): Node[] => {
              const root = hosts.get(element);
              if (root != null) return [...root.childNodes];
              if (element instanceof HTMLSlotElement && roots.includes(element.getRootNode() as ShadowRoot)) {
                const nodes = element.assignedNodes();
                if (nodes.length > 0) return nodes;
              }
              return [...element.childNodes];
            };
            for (const [branch, expected] of state.projectedChildren) {
              const current = flatChildren(branch);
              if (current.length !== expected.length || current.some((node, index) => node !== expected[index]))
                throw new Error("external CSS native owner projected branch changed during screenshot");
            }
            const ancestors: Element[] = [];
            for (let ancestor = flatParent(selected[0]); ancestor != null; ancestor = flatParent(ancestor))
              ancestors.push(ancestor);
            if (
              ancestors.length !== state.isolation.ancestors.length ||
              ancestors.some((element, index) => element !== state.isolation!.ancestors[index])
            )
              throw new Error("external CSS paint ancestry changed during screenshot");
            const dependencies = new Set(state.isolation.dependencies.map((fact) => fact.element));
            for (const fact of state.isolation.dependencies) {
              const style = getComputedStyle(fact.element);
              if (
                !fact.element.isConnected ||
                fact.element.ownerDocument !== document ||
                Array.from(fact.element.children).some((child) => !dependencies.has(child)) ||
                Array.from(style)
                  .map((name) => `${name}:${style.getPropertyValue(name)}`)
                  .join("\n") !== fact.styles
              )
                throw new Error("external CSS native local-definition dependency changed during screenshot");
            }
            const textPaint = (element: Element, style: CSSStyleDeclaration): string[] => {
              const firstLine = getComputedStyle(element, "::first-line");
              const firstLetter = getComputedStyle(element, "::first-letter");
              return [
                style.color,
                style.webkitTextFillColor,
                style.webkitTextStrokeColor,
                style.textEmphasisColor,
                style.textShadow,
                firstLine.color,
                firstLine.webkitTextFillColor,
                firstLine.textShadow,
                firstLetter.color,
                firstLetter.webkitTextFillColor,
                firstLetter.textShadow,
                getComputedStyle(element, "::marker").color,
              ];
            };
            const paint: AncestorPaint[] = [];
            for (const element of everyElement()) {
              if (owned.has(element) || dependencies.has(element)) continue;
              const ancestor = ancestors.includes(element);
              const style = getComputedStyle(element);
              if (ancestor)
                paint.push({
                  backgroundImage: style.backgroundImage,
                  boxShadow: style.boxShadow,
                  borderImageSource: style.borderImageSource,
                  colors: [
                    style.backgroundColor,
                    style.borderTopColor,
                    style.borderRightColor,
                    style.borderBottomColor,
                    style.borderLeftColor,
                    style.outlineColor,
                  ],
                  opacity: style.opacity,
                  text: state.isolation.ancestorText ? textPaint(element, style) : [],
                });
              for (const pseudo of ancestor ? ["::before", "::after"] : ["", "::before", "::after"])
                if (getComputedStyle(element, pseudo || null).visibility !== "hidden")
                  throw new Error("external CSS foreign paint changed during screenshot");
            }
            for (const fact of selected[1].properties)
              if (getComputedStyle(selected[0]).getPropertyValue(fact.property) !== fact.computed)
                throw new Error("external CSS paint selection changed during screenshot");
            for (const fact of state.isolation.ownerFacts) {
              const children = flatChildren(fact.element);
              if (
                !fact.element.isConnected ||
                fact.element.ownerDocument !== document ||
                children.length !== fact.children.length ||
                children.some((node, index) => node !== fact.children[index])
              )
                throw new Error("external CSS native subtree changed during screenshot");
              for (const [index, pseudo] of ["", "::before", "::after"].entries()) {
                const style = getComputedStyle(fact.element, pseudo || null);
                const fingerprint = Array.from(style)
                  .map((name) => `${name}:${style.getPropertyValue(name)}`)
                  .join("\n");
                if (fingerprint !== fact.styles[index])
                  throw new Error("external CSS native owner paint changed during screenshot");
              }
            }
            return paint;
          },
          { ...identity, ownerToken: target.token },
        ),
      );
      requireTransparentAncestors(afterPaint, "external CSS ancestor paint changed during screenshot");
      await shadowGuard.verify();
      const { data, info } = await sharp(shot, scale == null ? {} : { limitInputPixels: EXTERNAL_CSS_SVG_PIXEL_BUDGET })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      if (
        scale != null &&
        (Math.abs(info.width - clip.width * scale) > 1 || Math.abs(info.height - clip.height * scale) > 1)
      )
        throw new Error("external CSS native full-page paint screenshot dimensions changed");
      let left = info.width,
        top = info.height,
        right = -1,
        bottom = -1;
      for (let y = 0; y < info.height; y++)
        for (let x = 0; x < info.width; x++) {
          if (data[(y * info.width + x) * 4 + 3] === 0) continue;
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
      if (right < left || bottom < top) {
        // A full-page mismatch identifies differing paint, but an empty
        // isolated screenshot cannot tell whether the source was empty or
        // the isolation suppressed it (observed with an external SVG mask).
        if (scale != null && beforePaint.fullPageMismatch)
          throw new Error("external CSS native full-page paint could not verify an empty owner stamp");
        target.empty = true;
      } else {
        const width = right - left + 1,
          height = bottom - top + 1;
        const cropped = await sharp(shot).extract({ left, top, width, height }).png().toBuffer();
        target.x = offsetX + (left * clip.width) / info.width;
        target.y = offsetY + (top * clip.height) / info.height;
        target.width = (width * clip.width) / info.width;
        target.height = (height * clip.height) / info.height;
        target.dataUri = `data:image/png;base64,${cropped.toString("base64")}`;
      }
      // The crop is in viewport space; under a frozen ancestor transform its
      // rectangle is not the owner's local box (culling must not treat it so).
      if (beforePaint.transformed) target.viewportSpace = true;
      else delete target.viewportSpace;
    } catch (error) {
      failed = true;
      primary = error;
      throw error;
    } finally {
      try {
        const cleanups = await Promise.allSettled([
          shadowGuard?.dispose(),
          restoreExternalCssSvgIsolation(page, identity),
        ]);
        const failures = cleanups.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
        if (failures.length === 1) throw failures[0];
        if (failures.length > 0) throw new AggregateError(failures, "external CSS native isolation cleanup failed");
      } catch (error) {
        if (failed) throw new AggregateError([primary, error], "external CSS native paint and cleanup failed");
        throw error;
      }
    }
  }
}
