/** Own temporary CSS external-fragment definitions without author fetch/timers. */
import type { Page } from "@playwright/test";
import sharp from "sharp";
import type { AsyncDisposable } from "./cdp-lifecycle.js";
import { evaluateInFrame } from "./evaluate-in-frame.js";
import { openExternalSvgTransport } from "./external-svg-transport.js";
import { EXTERNAL_SVG_FETCH_TIMEOUT_MS } from "./external-svg-use.js";
import { createPageRegistry } from "./page-registry.js";
import { discoverExternalCssShadowTargets } from "./external-css-svg-shadow-guard.js";
import { privateCaptureKey } from "./private-key.js";
import {
  rasterizeExternalCssSvgSurfaces,
  restoreExternalCssSvgIsolation,
  type CssSvgIsolation,
} from "./external-css-svg-raster.js";
import {
  cssSvgScreenshotTimeLeft,
  EXTERNAL_CSS_SVG_PIXEL_BUDGET,
  EXTERNAL_CSS_SVG_SCREENSHOT_MS,
  readExternalCssSvgScreenshotSpace,
} from "./external-css-svg-screenshot.js";
import type { CapturedElement } from "./types.js";
import { externalCssSvgReferences, type ExternalCssSvgUrlReference } from "./blink-url-fragment.js";

// Keep static fragment identity stable across captures of the same Page.
const definitionPrefixes = new WeakMap<Page, string>();

type Property = "clip-path" | "mask-image";
type Reference = ExternalCssSvgUrlReference;
interface Target {
  shadowPath?: Node[];
  element: HTMLElement | SVGElement;
  property: Property;
  computed: string;
  references: Reference[];
}
interface SavedProperty {
  name: Property;
  before: string;
  priority: string;
  owned: string;
  ownedPriority: string;
}
interface SavedStyle {
  element: HTMLElement | SVGElement;
  before: string | null;
  owned: string | null;
  properties: SavedProperty[];
}
/** One owned `!important` sheet rule overriding a normal inline author declaration. */
interface SheetOverride {
  element: HTMLElement;
  property: Property;
  /** Value of `overrideAttribute` that selects `element`. */
  ordinal: string;
  rule: CSSStyleRule;
}
export interface ExternalCssSvgJournal {
  token: string;
  prefix: string;
  targets: Target[];
  /** Composed branches needed to reach actual native CSS owners in author scopes. */
  projectedChildren: Map<Element, Node[]>;
  projectedText: Map<Text, { parent: Node | null; flatParent: Element; value: string; range: Range; rects: DOMRect[] }>;
  styles: SavedStyle[];
  /** Private attribute selecting overridden elements; minted per prepass. */
  overrideAttribute: string;
  /** Adopted constructed sheet holding the owned override rules. */
  overrideSheet: CSSStyleSheet | null;
  overrides: SheetOverride[];
  overrideSerial: number;
  host: SVGSVGElement | null;
  clones: Element[];
  ids: string[];
  hostMarkup: string | null;
  rasterOwners: Map<
    Element,
    {
      token: string;
      properties: Array<{ property: Property; computed: string }>;
      fullPageMismatch?: boolean;
      shadowPath?: Node[];
    }
  >;
  isolation?: CssSvgIsolation;
  /** The main document's open and closed author roots, registered by the
   * native-paint ownership guard from its pierced CDP tree for one isolation. */
  authorShadowRoots?: ShadowRoot[];
}
type Journal = ExternalCssSvgJournal;
interface SwappedTarget {
  index: number;
  /** Union of the target subtree's client rects, in CSS px; null when it paints nothing. */
  rect: { x: number; y: number; width: number; height: number } | null;
  animated: boolean;
}
interface PrimeFrame {
  data: Buffer;
  width: number;
  height: number;
  /** Device pixels per CSS px. */
  scale: number;
  /** Client-to-document offset for full-page captures. */
  x: number;
  y: number;
}

async function primeFrame(page: Page, fullPage: boolean): Promise<PrimeFrame> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = Date.now() + EXTERNAL_CSS_SVG_SCREENSHOT_MS;
  try {
    const { shot, space } = await Promise.race([
      (async () => {
        const space = await readExternalCssSvgScreenshotSpace(page, fullPage);
        if (fullPage && space.width * space.height * space.scale ** 2 > EXTERNAL_CSS_SVG_PIXEL_BUDGET)
          throw new Error("external CSS SVG full-page paint verification budget exceeded");
        const shot = await page.screenshot({ fullPage, type: "png", timeout: cssSvgScreenshotTimeLeft(deadline) });
        return { shot, space };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("external CSS SVG paint verification timed out")),
          EXTERNAL_CSS_SVG_SCREENSHOT_MS,
        );
      }),
    ]);
    const { data, info } = await sharp(shot, fullPage ? { limitInputPixels: EXTERNAL_CSS_SVG_PIXEL_BUDGET } : {})
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (
      fullPage &&
      (Math.abs(info.width - space.width * space.scale) > 1 || Math.abs(info.height - space.height * space.scale) > 1)
    )
      throw new Error("external CSS SVG paint verification viewport changed");
    const scale = fullPage ? space.scale : space.width > 0 ? info.width / space.width : 1;
    return { data, width: info.width, height: info.height, scale, x: space.x, y: space.y };
  } finally {
    clearTimeout(timer);
  }
}

function requireSamePrimeSpace(first: PrimeFrame, second: PrimeFrame): void {
  if (
    first.width !== second.width ||
    first.height !== second.height ||
    first.scale !== second.scale ||
    first.x !== second.x ||
    first.y !== second.y
  )
    throw new Error("external CSS SVG paint verification viewport changed");
}

/** Two pre-swap frames; pixels that differ between them are not evidence. */
async function stablePrimeFrames(page: Page, fullPage: boolean): Promise<{ frame: PrimeFrame; unstable: Uint8Array }> {
  const first = await primeFrame(page, fullPage);
  const second = await primeFrame(page, fullPage);
  requireSamePrimeSpace(first, second);
  const unstable = new Uint8Array(first.width * first.height);
  for (let pixel = 0; pixel < unstable.length; pixel++)
    for (let channel = 0; channel < 3; channel++)
      if (first.data[pixel * 3 + channel] !== second.data[pixel * 3 + channel]) unstable[pixel] = 1;
  return { frame: second, unstable };
}

/**
 * Targets whose swap changed a stable source pixel. A changed pixel inside one
 * or more targets' subtree rects (grown by a margin for shadows/outlines) is
 * attributed to them; a change no target covers implicates every non-animated
 * target. Animated targets cannot be verified this way and keep the vector path.
 */
export function attributePaintChanges(
  before: { frame: PrimeFrame; unstable: Uint8Array },
  after: PrimeFrame,
  swapped: SwappedTarget[],
  margin = 16,
): number[] {
  requireSamePrimeSpace(before.frame, after);
  const { x, y, scale } = before.frame;
  const boxes = swapped.map((target) =>
    target.rect == null || target.animated
      ? null
      : {
          left: Math.floor((x + target.rect.x - margin) * scale),
          top: Math.floor((y + target.rect.y - margin) * scale),
          right: Math.ceil((x + target.rect.x + target.rect.width + margin) * scale),
          bottom: Math.ceil((y + target.rect.y + target.rect.height + margin) * scale),
        },
  );
  const mismatched = new Set<number>();
  let unattributed = false;
  for (let y = 0; y < after.height; y++)
    for (let x = 0; x < after.width; x++) {
      const pixel = y * after.width + x;
      if (before.unstable[pixel] === 1) continue;
      const offset = pixel * 3;
      if (
        after.data[offset] === before.frame.data[offset] &&
        after.data[offset + 1] === before.frame.data[offset + 1] &&
        after.data[offset + 2] === before.frame.data[offset + 2]
      )
        continue;
      let attributed = false;
      boxes.forEach((box, index) => {
        if (box != null && x >= box.left && x < box.right && y >= box.top && y < box.bottom) {
          mismatched.add(swapped[index].index);
          attributed = true;
        }
      });
      if (!attributed) unattributed = true;
    }
  if (unattributed)
    swapped.forEach((target, index) => {
      if (boxes[index] != null) mismatched.add(target.index);
    });
  return [...mismatched].sort((a, b) => a - b);
}
export interface ExternalCssSvgPrime extends AsyncDisposable {
  registryKey: string;
  rasterize(tree: CapturedElement[], viewport: { x: number; y: number; width: number; height: number }): Promise<void>;
}

/** Kept at the original main-document prepass boundary. No child/foreign page mutations. */
export async function primeExternalCssSvgReferences(page: Page): Promise<ExternalCssSvgPrime> {
  const registry = createPageRegistry<Journal>(page, "CssSvgFragments");
  const token = privateCaptureKey("CssSvgOwner");
  const prefix = definitionPrefixes.get(page) ?? privateCaptureKey("CssSvgDefinition");
  definitionPrefixes.set(page, prefix);
  let transport: Awaited<ReturnType<typeof openExternalSvgTransport>> | undefined;
  let disposed = false;
  let closing: Promise<void> | undefined;
  const rasterize: ExternalCssSvgPrime["rasterize"] = (tree, viewport) =>
    rasterizeExternalCssSvgSurfaces(page, tree, viewport, { key: registry.key, token });
  const dispose = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    return (closing ??= (async () => {
      try {
        await restoreExternalCssSvgIsolation(page, { key: registry.key, token });
        const failures = await evaluateInFrame(
          page,
          ({ key, token }) => {
            const scope = globalThis as typeof globalThis & Record<string, Journal | undefined>;
            const state = scope[key];
            if (state == null) return 0;
            if (state.token !== token) return 1;
            let failures = 0;
            for (const saved of state.styles) {
              try {
                if (saved.element.getAttribute("style") === saved.owned) {
                  if (saved.before == null) saved.element.removeAttribute("style");
                  else saved.element.setAttribute("style", saved.before);
                  if (saved.element.getAttribute("style") !== saved.before) failures++;
                } else {
                  for (const property of saved.properties) {
                    const style = saved.element.style;
                    if (
                      style.getPropertyValue(property.name) !== property.owned ||
                      style.getPropertyPriority(property.name) !== property.ownedPriority
                    )
                      continue;
                    if (property.before === "") style.removeProperty(property.name);
                    else style.setProperty(property.name, property.before, property.priority);
                    if (
                      style.getPropertyValue(property.name) !== property.before ||
                      style.getPropertyPriority(property.name) !== property.priority
                    )
                      failures++;
                  }
                  if (saved.before == null && saved.element.style.length === 0) saved.element.removeAttribute("style");
                }
              } catch {
                failures++;
              }
            }
            // Owned override rules go before the attributes selecting them, so
            // the author's untouched declaration (and its loaded resource)
            // applies again without a re-parse or a new fetch.
            try {
              const sheet = state.overrideSheet;
              if (sheet != null) {
                if (document.adoptedStyleSheets.includes(sheet))
                  document.adoptedStyleSheets = document.adoptedStyleSheets.filter((adopted) => adopted !== sheet);
                if (document.adoptedStyleSheets.includes(sheet)) failures++;
              }
              for (const override of state.overrides) {
                if (override.element.getAttribute(state.overrideAttribute) === override.ordinal)
                  override.element.removeAttribute(state.overrideAttribute);
                if (override.element.getAttribute(state.overrideAttribute) === override.ordinal) failures++;
              }
            } catch {
              failures++;
            }
            if (state.host != null) {
              if (
                state.host.outerHTML !== state.hostMarkup ||
                Array.from(state.host.children).some((child) => !state.clones.includes(child))
              )
                failures++;
              // An author may adopt a temporary definition while capture awaits
              // I/O. Retain that live dependency instead of deleting foreign paint.
              const here = new URL(document.URL);
              here.hash = "";
              const usesDefinition = (value: string): boolean => {
                for (const match of value.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
                  try {
                    const raw = match[1].trim();
                    const url = new URL(raw, document.baseURI);
                    const fragment = decodeURIComponent(url.hash.slice(1));
                    url.hash = "";
                    if ((raw.startsWith("#") || url.href === here.href) && state.ids.includes(fragment)) return true;
                  } catch {
                    // Generated IDs are ASCII; invalid escapes cannot identify one.
                  }
                }
                return false;
              };
              for (const element of document.querySelectorAll("*")) {
                if (state.host.contains(element)) continue;
                const style = getComputedStyle(element);
                if (usesDefinition(style.clipPath) || usesDefinition(style.maskImage)) {
                  failures++;
                  break;
                }
              }
              if (failures === 0) {
                state.host.remove();
                if (state.host.isConnected) failures++;
              }
            }
            if (failures === 0) {
              delete scope[key];
              if (scope[key] === state) failures++;
            }
            return failures;
          },
          { key: registry.key, token },
        );
        if (failures > 0) throw new Error(`${failures} external CSS SVG cleanup operations unconfirmed`);
        await registry.dispose();
        disposed = true;
      } catch (error) {
        if (page.isClosed()) {
          disposed = true;
          return;
        }
        throw error;
      } finally {
        closing = undefined;
      }
    })());
  };
  try {
    await registry.tag(
      page,
      ({ token, prefix, overrideAttribute }) => {
        // Node tokenizes these computed values and decodes Blink's fragment
        // identity (src/capture/blink-url-fragment.ts); keep every candidate.
        const targets: Target[] = [];
        for (const element of document.querySelectorAll("*")) {
          if (!(element instanceof HTMLElement || element instanceof SVGElement)) continue;
          const style = getComputedStyle(element);
          for (const property of ["clip-path", "mask-image"] as const) {
            const computed = style.getPropertyValue(property);
            if (/url\(/i.test(computed)) targets.push({ element, property, computed, references: [] });
          }
        }
        return {
          token,
          prefix,
          targets,
          projectedChildren: new Map(),
          projectedText: new Map(),
          styles: [],
          overrideAttribute,
          overrideSheet: null,
          overrides: [],
          overrideSerial: 0,
          host: null,
          clones: [],
          ids: [],
          hostMarkup: null,
          rasterOwners: new Map(),
        };
      },
      { token, prefix, overrideAttribute: privateCaptureKey("CssSvgOverride") },
    );
    await discoverExternalCssShadowTargets(page, { key: registry.key, token });
    const snapshot = await evaluateInFrame(
      page,
      ({ key, token }) => {
        const state = (globalThis as typeof globalThis & Record<string, Journal>)[key];
        if (state?.token !== token) throw new Error("external CSS SVG source ownership unavailable");
        return {
          baseUrl: document.baseURI,
          documentUrl: document.URL,
          targets: state.targets.map((target) => ({
            property: target.property,
            computed: target.computed,
            shadowNative: target.shadowPath != null,
          })),
        };
      },
      { key: registry.key, token },
    );
    const references = snapshot.targets.map((target) =>
      externalCssSvgReferences(target.property, target.computed, snapshot.baseUrl, snapshot.documentUrl),
    );
    const hrefs = [
      ...new Set(
        references.flatMap((refs, index) => (snapshot.targets[index].shadowNative ? [] : refs.map((ref) => ref.href))),
      ),
    ];
    if (references.every((refs) => refs.length === 0)) {
      await registry.dispose();
      disposed = true;
      return { registryKey: registry.key, dispose, rasterize };
    }
    const documents: Array<{ href: string; text: string }> = [];
    const unreadable: string[] = [];
    if (hrefs.length > 0) transport = await openExternalSvgTransport(page.mainFrame(), EXTERNAL_SVG_FETCH_TIMEOUT_MS);
    await evaluateInFrame(
      page,
      ({ key, token, references }) => {
        const state = (globalThis as typeof globalThis & Record<string, Journal>)[key];
        if (state?.token !== token || state.targets.length !== references.length)
          throw new Error("external CSS SVG source ownership changed before fetching");
        state.targets.forEach((target, index) => (target.references = references[index]));
        state.targets = state.targets.filter((target) => target.references.length > 0);
        for (const target of state.targets) {
          if (target.shadowPath == null) continue;
          let scope = target.element.getRootNode();
          while (scope instanceof ShadowRoot) {
            const host = scope.host;
            if (state.projectedChildren.has(host)) break;
            state.projectedChildren.set(host, [...scope.childNodes]);
            for (const slot of scope.querySelectorAll("slot")) {
              const assigned = slot.assignedNodes();
              state.projectedChildren.set(slot, assigned.length ? assigned : [...slot.childNodes]);
            }
            scope = host.getRootNode();
          }
        }
        for (const [flatParent, children] of state.projectedChildren)
          for (const node of children) {
            if (!(node instanceof Text) || !node.data.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            state.projectedText.set(node, {
              parent: node.parentNode,
              flatParent,
              value: node.data,
              range,
              rects: [...range.getClientRects()],
            });
          }
      },
      { key: registry.key, token, references },
    );
    if (transport) {
      for (const href of hrefs) {
        const result = await transport.fetch(href);
        if ("failure" in result) {
          unreadable.push(href);
          continue;
        }
        documents.push({ href, text: result.text });
      }
    }
    // The readable path copies the auxiliary response, whose bytes are not
    // proven to be the ones Chromium selected for native paint (a no-store
    // resource may differ per request). Byte identity is unobservable through
    // public CDP, so verify paint instead: two pre-swap frames identify unstable
    // pixels, and any stable pixel the swap changes sends its owner(s) back to
    // native paint.
    const fullPage =
      documents.length > 0 &&
      (await evaluateInFrame(
        page,
        ({ key, token, readable }) => {
          const state = (globalThis as typeof globalThis & Record<string, Journal | undefined>)[key];
          if (state?.token !== token) throw new Error("external CSS SVG source ownership changed before verification");
          const hrefs = new Set(readable);
          const width = innerWidth;
          const height = innerHeight;
          return state.targets.some(
            ({ element, references, shadowPath }) =>
              shadowPath == null &&
              element.isConnected &&
              references.every(({ href }) => hrefs.has(href)) &&
              element.getAnimations({ subtree: true }).length === 0 &&
              [element, ...element.querySelectorAll("*")].some((node) =>
                [...node.getClientRects()].some(
                  (rect) =>
                    rect.width > 0 &&
                    rect.height > 0 &&
                    (rect.left < 0 || rect.top < 0 || rect.right > width || rect.bottom > height),
                ),
              ),
          );
        },
        { key: registry.key, token, readable: documents.map(({ href }) => href) },
      ));
    const verify = documents.length > 0 ? await stablePrimeFrames(page, fullPage) : null;
    const swapped = await evaluateInFrame(
      page,
      ({ key, token, documents, unreadable }) => {
        const state = (globalThis as typeof globalThis & Record<string, Journal>)[key];
        if (state?.token !== token) throw new Error("external CSS SVG source ownership changed");
        const swapped: SwappedTarget[] = [];
        const paintFact = (target: Target): SwappedTarget => {
          let left = Infinity,
            top = Infinity,
            right = -Infinity,
            bottom = -Infinity;
          for (const element of [target.element, ...target.element.querySelectorAll("*")])
            for (const rect of element.getClientRects()) {
              left = Math.min(left, rect.left);
              top = Math.min(top, rect.top);
              right = Math.max(right, rect.right);
              bottom = Math.max(bottom, rect.bottom);
            }
          return {
            index: state.targets.indexOf(target),
            rect: right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null,
            animated: target.element.getAnimations({ subtree: true }).length > 0,
          };
        };
        const SVGNS = "http://www.w3.org/2000/svg";
        const parsed = new Map(
          documents.map(({ href, text }) => [href, new DOMParser().parseFromString(text, "image/svg+xml")]),
        );
        // A previously observed private ID can be referenced by an author even
        // when no matching element exists. Do not temporarily satisfy it.
        const here = new URL(document.URL);
        here.hash = "";
        const reserved = new Set<string>();
        for (const element of document.querySelectorAll("*")) {
          const computed = getComputedStyle(element);
          for (const property of ["clip-path", "mask-image"] as const) {
            for (const match of computed
              .getPropertyValue(property)
              .matchAll(/url\(\s*["']?([^"')#]*)#([^"')\s]+)["']?\s*\)/gi)) {
              try {
                if (match[1] === "" || new URL(match[1], document.baseURI).href === here.href)
                  reserved.add(decodeURIComponent(match[2]));
              } catch {
                /* Invalid references remain owned by the renderer. */
              }
            }
          }
        }
        const definitions = new Map<string, string>();
        const styles = new Map<HTMLElement | SVGElement, SavedStyle>();
        const nativeOwners = new Set<Element>(
          state.targets
            .filter(
              (target) =>
                target.shadowPath != null || target.references.some((reference) => unreadable.includes(reference.href)),
            )
            .map((target) => target.element),
        );
        const projectedParents = new Map<Element, Element>();
        for (const [parent, children] of state.projectedChildren)
          for (const child of children) if (child instanceof Element) projectedParents.set(child, parent);
        const parentOf = (element: Element) => projectedParents.get(element) ?? element.parentElement;
        for (const target of state.targets) {
          if (!target.element.isConnected) {
            if (target.shadowPath) throw new Error("external CSS shadow owner disconnected during preparation");
            continue;
          }
          if (getComputedStyle(target.element).getPropertyValue(target.property) !== target.computed)
            throw new Error("external CSS SVG source changed while reading its resource");
          let retainedByAncestor = false;
          for (let parent = parentOf(target.element); parent != null; parent = parentOf(parent)) {
            if (nativeOwners.has(parent)) {
              retainedByAncestor = true;
              break;
            }
          }
          if (retainedByAncestor) continue;
          if (nativeOwners.has(target.element)) {
            let owner = state.rasterOwners.get(target.element);
            if (owner == null) {
              owner = {
                token: `${state.prefix}_raster_${state.rasterOwners.size}`,
                properties: [],
                shadowPath: target.shadowPath,
              };
              state.rasterOwners.set(target.element, owner);
            }
            owner.properties.push({ property: target.property, computed: target.computed });
            continue;
          }
          const matches = target.references.map((reference) => {
            // Blink's decoded resource-document ID, never the computed spelling.
            const element = parsed.get(reference.href)?.getElementById(reference.id);
            const wanted = target.property === "clip-path" ? "clippath" : "mask";
            return { reference, element: element?.tagName.toLowerCase() === wanted ? element : null };
          });
          // Preserve the existing missing/wrong-fragment path. It differs from
          // failing to read a resource which Chromium may already have painted.
          if (matches.some((match) => match.element == null)) {
            if (matches.length > 1) throw new Error("external CSS SVG mixed-layer reference could not be resolved");
            continue;
          }
          let value = target.computed;
          for (const { reference, element } of matches.slice().reverse()) {
            const identity = `${target.property}|${reference.href}#${reference.id}`;
            let id = definitions.get(identity);
            if (id == null) {
              if (state.host == null) {
                state.host = document.createElementNS(SVGNS, "svg");
                state.host.setAttribute("width", "0");
                state.host.setAttribute("height", "0");
                state.host.setAttribute("aria-hidden", "true");
                state.host.style.position = "absolute";
                state.hostMarkup = state.host.outerHTML;
                (document.body ?? document.documentElement).appendChild(state.host);
              }
              const clone = document.importNode(element!, true) as Element;
              let ordinal = state.ids.length;
              do {
                id = `${state.prefix}_${ordinal++}`;
              } while (document.getElementById(id) != null || reserved.has(id));
              clone.setAttribute("id", id);
              state.ids.push(id);
              state.clones.push(clone);
              try {
                state.host.appendChild(clone);
              } finally {
                state.hostMarkup = state.host.outerHTML;
              }
              definitions.set(identity, id);
            }
            value = value.slice(0, reference.start) + `url("#${id}")` + value.slice(reference.start + reference.length);
          }
          // DM-3N15PB: a normal inline `clip-path` declaration is overridden
          // from an owned sheet rule, so the declaration and its CSSURIValue
          // (which owns the loaded ExternalSVGResource) are never re-parsed.
          // Restoring by re-parsing creates a new resource whose Load() fetches
          // again, and a no-store SVG document is always reloaded
          // (resource_fetcher.cc DetermineRevalidationPolicyInternal,
          // svg_resource.cc:241-286, Chromium 7d859f27), which could repaint
          // the source with new bytes. `mask-image` keeps the inline swap: its
          // image resource is reused within the document even when no-store
          // (kReuseNoStoreImageOnSameSrcReassignment), and re-applying the
          // shadowed author declaration instead left the native mask painting
          // nothing.
          const owned = target.element;
          if (
            target.property === "clip-path" &&
            owned instanceof HTMLElement &&
            owned.style.getPropertyValue(target.property) !== "" &&
            owned.style.getPropertyPriority(target.property) === ""
          ) {
            if (state.overrideSheet == null) {
              state.overrideSheet = new CSSStyleSheet();
              document.adoptedStyleSheets = [...document.adoptedStyleSheets, state.overrideSheet];
            }
            const sheet = state.overrideSheet;
            const existing = state.overrides.find((candidate) => candidate.element === owned);
            const ordinal = existing?.ordinal ?? String(state.overrideSerial++);
            const index = sheet.insertRule(`[${state.overrideAttribute}="${ordinal}"]{}`, sheet.cssRules.length);
            const rule = sheet.cssRules[index] as CSSStyleRule;
            const override: SheetOverride = { element: owned, property: target.property, ordinal, rule };
            state.overrides.push(override);
            if (existing == null) owned.setAttribute(state.overrideAttribute, ordinal);
            rule.style.setProperty(target.property, value, "important");
            // An author `!important` sheet rule can outrank the owned rule;
            // such a target falls back to the inline override below.
            if (getComputedStyle(owned).getPropertyValue(target.property) !== target.computed) {
              swapped.push(paintFact(target));
              continue;
            }
            sheet.deleteRule(Array.from(sheet.cssRules).indexOf(rule));
            state.overrides.splice(state.overrides.indexOf(override), 1);
            if (!state.overrides.some((candidate) => candidate.element === owned))
              owned.removeAttribute(state.overrideAttribute);
          }
          let saved = styles.get(target.element);
          if (saved == null) {
            saved = {
              element: target.element,
              before: target.element.getAttribute("style"),
              owned: target.element.getAttribute("style"),
              properties: [],
            };
            state.styles.push(saved);
            styles.set(target.element, saved);
          }
          const property: SavedProperty = {
            name: target.property,
            before: target.element.style.getPropertyValue(target.property),
            priority: target.element.style.getPropertyPriority(target.property),
            owned: value,
            ownedPriority: "important",
          };
          saved.properties.push(property);
          try {
            target.element.style.setProperty(target.property, value, "important");
            property.owned = target.element.style.getPropertyValue(target.property);
            property.ownedPriority = target.element.style.getPropertyPriority(target.property);
          } finally {
            saved.owned = target.element.getAttribute("style");
          }
          swapped.push(paintFact(target));
        }
        return swapped;
      },
      { key: registry.key, token, documents, unreadable },
    );
    if (verify != null && swapped.length > 0) {
      const after = await primeFrame(page, fullPage);
      const mismatched = attributePaintChanges(verify, after, swapped);
      if (mismatched.length > 0)
        await evaluateInFrame(
          page,
          ({ key, token, indices, fullPage }) => {
            const state = (globalThis as typeof globalThis & Record<string, Journal>)[key];
            if (state?.token !== token) throw new Error("external CSS SVG source ownership changed while verifying");
            const owners = new Set(indices.map((index) => state.targets[index].element));
            const revert = (element: Element) =>
              [...owners].some((owner) => owner === element || owner.contains(element));
            for (const saved of state.styles) {
              if (!revert(saved.element)) continue;
              for (const property of saved.properties.splice(0)) {
                const style = saved.element.style;
                if (
                  style.getPropertyValue(property.name) !== property.owned ||
                  style.getPropertyPriority(property.name) !== property.ownedPriority
                )
                  throw new Error("external CSS SVG owned property changed while verifying");
                if (property.before === "") style.removeProperty(property.name);
                else style.setProperty(property.name, property.before, property.priority);
              }
              if (saved.before == null && saved.element.style.length === 0) saved.element.removeAttribute("style");
              saved.owned = saved.element.getAttribute("style");
            }
            // Removing an owned rule restores the author's declaration without
            // re-parsing it, so native paint keeps the resource it loaded.
            for (const override of state.overrides.filter((candidate) => revert(candidate.element))) {
              const sheet = state.overrideSheet!;
              const at = Array.from(sheet.cssRules).indexOf(override.rule);
              if (at < 0) throw new Error("external CSS SVG owned rule changed while verifying");
              sheet.deleteRule(at);
              state.overrides.splice(state.overrides.indexOf(override), 1);
              if (
                !state.overrides.some((other) => other.element === override.element) &&
                override.element.getAttribute(state.overrideAttribute) === override.ordinal
              )
                override.element.removeAttribute(state.overrideAttribute);
            }
            for (const target of state.targets) {
              if (!revert(target.element)) continue;
              if (getComputedStyle(target.element).getPropertyValue(target.property) !== target.computed)
                throw new Error("external CSS SVG source paint could not be restored for native ownership");
              // Descendants stay inside their native owner's stamp.
              if (!owners.has(target.element)) continue;
              let owner = state.rasterOwners.get(target.element);
              if (owner == null) {
                owner = { token: `${state.prefix}_raster_${state.rasterOwners.size}`, properties: [] };
                state.rasterOwners.set(target.element, owner);
              }
              if (fullPage) owner.fullPageMismatch = true;
              owner.properties.push({ property: target.property, computed: target.computed });
            }
          },
          { key: registry.key, token, indices: mismatched, fullPage },
        );
    }
    await transport?.dispose();
    transport = undefined;
    return { registryKey: registry.key, dispose, rasterize };
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await transport?.dispose();
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    try {
      await dispose();
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    if (failures.length > 1) throw new AggregateError(failures, "external CSS SVG preparation and cleanup failed");
    throw error;
  }
}
