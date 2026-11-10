/** Own temporary CSS external-fragment definitions without author fetch/timers. */
import type { Page } from "@playwright/test";
import type { AsyncDisposable } from "./cdp-lifecycle.js";
import { evaluateInFrame } from "./evaluate-in-frame.js";
import { openExternalSvgTransport } from "./external-svg-transport.js";
import { EXTERNAL_SVG_FETCH_TIMEOUT_MS } from "./external-svg-use.js";
import { createPageRegistry } from "./page-registry.js";
import { privateCaptureKey } from "./private-key.js";

// Keep static fragment identity stable across captures of the same Page.
const definitionPrefixes = new WeakMap<Page, string>();

type Property = "clip-path" | "mask-image";
interface Reference {
  href: string;
  fragment: string;
  start: number;
  length: number;
}
interface Target {
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
interface Journal {
  token: string;
  prefix: string;
  targets: Target[];
  styles: SavedStyle[];
  host: SVGSVGElement | null;
  clones: Element[];
  ids: string[];
  hostMarkup: string | null;
}
export interface ExternalCssSvgPrime extends AsyncDisposable {
  registryKey: string;
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
  const dispose = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    return (closing ??= (async () => {
      try {
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
      ({ token, prefix }) => {
        const here = new URL(document.URL);
        here.hash = "";
        const targets: Target[] = [];
        for (const element of document.querySelectorAll("*")) {
          if (!(element instanceof HTMLElement || element instanceof SVGElement)) continue;
          const style = getComputedStyle(element);
          for (const property of ["clip-path", "mask-image"] as const) {
            const computed = style.getPropertyValue(property);
            const references: Reference[] = [];
            const expression = /url\(\s*["']?([^"')#]+)#([^"')\s]+)["']?\s*\)/gi;
            for (const match of computed.matchAll(expression)) {
              try {
                const href = new URL(match[1], document.baseURI).href;
                if (href === here.href) continue;
                references.push({ href, fragment: match[2], start: match.index, length: match[0].length });
              } catch {
                /* The existing walker owns invalid references. */
              }
            }
            if (references.length > 0) targets.push({ element, property, computed, references });
          }
        }
        return { token, prefix, targets, styles: [], host: null, clones: [], ids: [], hostMarkup: null };
      },
      { token, prefix },
    );
    const hrefs = await evaluateInFrame(
      page,
      ({ key, token }) => {
        const state = (globalThis as typeof globalThis & Record<string, Journal>)[key];
        if (state?.token !== token) throw new Error("external CSS SVG source ownership unavailable");
        return [...new Set(state.targets.flatMap((target) => target.references.map((reference) => reference.href)))];
      },
      { key: registry.key, token },
    );
    if (hrefs.length === 0) {
      await registry.dispose();
      disposed = true;
      return { registryKey: registry.key, dispose };
    }
    const documents: Array<{ href: string; text: string }> = [];
    if (hrefs.length > 0) {
      transport = await openExternalSvgTransport(page.mainFrame(), EXTERNAL_SVG_FETCH_TIMEOUT_MS);
      // Bind the earlier CSS snapshot to the document authenticated by the
      // transport. A navigation before setup must not fetch stale source URLs.
      await evaluateInFrame(
        page,
        ({ key, token }) => {
          if ((globalThis as typeof globalThis & Record<string, Journal>)[key]?.token !== token)
            throw new Error("external CSS SVG source ownership changed before fetching");
        },
        { key: registry.key, token },
      );
      for (const href of hrefs) {
        const result = await transport.fetch(href);
        if ("failure" in result) {
          const reason =
            /^HTTP \d{3}$/.test(result.failure) ||
            result.failure === "the fetch timed out" ||
            result.failure === "the document is not well-formed SVG"
              ? result.failure
              : "the renderer fetch was refused or failed";
          throw new Error(`external CSS SVG resource could not be read: ${reason}`);
        }
        documents.push({ href, text: result.text });
      }
    }
    await evaluateInFrame(
      page,
      ({ key, token, documents }) => {
        const state = (globalThis as typeof globalThis & Record<string, Journal>)[key];
        if (state?.token !== token) throw new Error("external CSS SVG source ownership changed");
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
        for (const target of state.targets) {
          if (!target.element.isConnected) continue;
          if (getComputedStyle(target.element).getPropertyValue(target.property) !== target.computed)
            throw new Error("external CSS SVG source changed while reading its resource");
          const matches = target.references.map((reference) => {
            const element = parsed.get(reference.href)?.getElementById(reference.fragment);
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
            const identity = `${target.property}|${reference.href}#${reference.fragment}`;
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
        }
      },
      { key: registry.key, token, documents },
    );
    await transport?.dispose();
    transport = undefined;
    return { registryKey: registry.key, dispose };
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
