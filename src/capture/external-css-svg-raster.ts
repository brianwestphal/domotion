/** Native CSS resource paint; never reads/refetches resource bytes or changes CSP. */
import type { Page } from "@playwright/test";
import sharp from "sharp";
import { openCssSvgShadowGuard } from "./external-css-svg-shadow-guard.js";
import { evaluateInFrame } from "./evaluate-in-frame.js";
import type { ExternalCssSvgJournal } from "./external-css-svg.js";
import { privateCaptureKey } from "./private-key.js";
import type { CapturedElement } from "./types.js";
import { isTransparentBackground } from "../utils/transparent-background.js";

export interface CssSvgIsolation {
  attribute: string;
  marked: Array<{ element: Element; before: string | null; owned: string }>;
  sheet: HTMLStyleElement;
  text: string;
  rules: string;
  ownerFacts: Array<{ element: Element; styles: string[] }>;
  ancestors: Element[];
  /** Outside never-painted local definitions kept at their native style. */
  dependencies: Array<{ element: Element; styles: string }>;
}
type Identity = { key: string; token: string };
interface AncestorPaint {
  backgroundImage: string;
  boxShadow: string;
  borderImageSource: string;
  colors: string[];
  /** Ancestor alpha is neutralized for the stamp; the renderer re-applies it. */
  opacity: string;
}
function requireTransparentAncestors(facts: AncestorPaint[], message: string): void {
  if (
    facts.some(
      (fact) =>
        fact.opacity !== "1" ||
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
        const isolation = state.isolation;
        if (isolation == null) return 0;
        let failures = 0;
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

export async function rasterizeExternalCssSvgSurfaces(
  page: Page,
  tree: CapturedElement[],
  viewport: { x: number; y: number; width: number; height: number },
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
  if (targets.length > 32 || viewport.width * viewport.height > 16_777_216)
    throw new Error("external CSS native paint budget exceeded");
  for (const target of targets) {
    let shadowGuard: Awaited<ReturnType<typeof openCssSvgShadowGuard>> | undefined;
    let primary: unknown;
    let failed = false;
    try {
      const attribute = `data-${privateCaptureKey("CssPaint").toLowerCase()}`;
      const beforePaint = await bounded(
        evaluateInFrame(
          page,
          ({ key, token, ownerToken, attribute }) => {
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
            if (
              owner.getAnimations({ subtree: true }).length > 0 ||
              document.getAnimations().some((animation) => animation instanceof CSSTransition)
            )
              throw new Error("external CSS native owner has unsupported active animation or transitions");
            if (
              document.documentElement.clientWidth < innerWidth ||
              document.documentElement.clientHeight < innerHeight
            )
              throw new Error("external CSS native owner has unsupported exposed root scrollbars");
            const ancestors = new Set<Element>();
            for (let ancestor = owner.parentElement; ancestor != null; ancestor = ancestor.parentElement) {
              ancestors.add(ancestor);
              const style = getComputedStyle(ancestor);
              if (
                ancestor.getAnimations().length > 0 ||
                style.transform !== "none" ||
                style.filter !== "none" ||
                style.backdropFilter !== "none" ||
                style.maskImage !== "none" ||
                style.clipPath !== "none" ||
                style.mixBlendMode !== "normal" ||
                style.overflowX !== "visible" ||
                style.overflowY !== "visible" ||
                style.zoom !== "1" ||
                /paint|strict|content/.test(style.contain) ||
                style.textDecorationLine !== "none" ||
                Array.from(ancestor.childNodes).some(
                  (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "",
                )
              )
                throw new Error("external CSS native owner has unsupported ancestor effects or clipping");
            }
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
            const localTarget = (raw: string): Element | null => {
              let url: URL;
              try {
                url = new URL(raw, document.baseURI);
              } catch {
                return null;
              }
              const fragment = url.hash.slice(1);
              url.hash = "";
              if ((!raw.startsWith("#") && url.href !== here.href) || fragment === "") return null;
              return document.getElementById(decode(fragment));
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
              if (target == null || owner.contains(target) || dependencies.has(target) || pending.includes(target))
                return;
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
                  for (const raw of urls(computed.getPropertyValue(name))) requireDependency(localTarget(raw));
              }
              if (element instanceof SVGElement && hrefOwners.has(element.localName.toLowerCase())) {
                const href =
                  element.getAttribute("href") ?? element.getAttributeNS("http://www.w3.org/1999/xlink", "href");
                if (href != null) requireDependency(localTarget(href));
              }
            };
            for (const element of [owner, ...owner.querySelectorAll("*")]) {
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
            for (const element of document.querySelectorAll("*")) {
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
            const fingerprint = (element: Element, pseudo: string) => {
              const style = getComputedStyle(element, pseudo || null);
              return Array.from(style)
                .map((name) => `${name}:${style.getPropertyValue(name)}`)
                .join("\n");
            };
            const isolation: CssSvgIsolation = {
              attribute,
              marked: [],
              sheet,
              text: "",
              rules: "",
              ownerFacts: [owner, ...owner.querySelectorAll("*")].map((element) => ({
                element,
                styles: ["", "::before", "::after"].map((pseudo) => fingerprint(element, pseudo)),
              })),
              ancestors: [...ancestors],
              dependencies: [...dependencies].map((element) => ({ element, styles: fingerprint(element, "") })),
            };
            // Publish ownership before any mutation, including a throwing setter.
            state.isolation = isolation;
            const rules = [
              `*:not([${attribute}])${hide},*:not([${attribute}])${hide}::before,*:not([${attribute}])${hide}::after{visibility:hidden!important}`,
            ];
            // Hiding an ancestor can suppress an external SVG mask even after its
            // owner is re-shown. Keep native ancestor visibility and remove only
            // paint channels which cannot contribute to the owner's isolated stamp.
            for (const ancestor of ancestors) {
              const index = String(isolation.marked.length);
              rules.push(
                `[${attribute}="${index}"]${show}{background:transparent!important;border-color:transparent!important;border-image:none!important;box-shadow:none!important;outline-color:transparent!important;opacity:1!important}`,
              );
              rules.push(
                `[${attribute}="${index}"]${show}::before,[${attribute}="${index}"]${show}::after{visibility:hidden!important}`,
              );
              isolation.marked.push({ element: ancestor, before: ancestor.getAttribute(attribute), owned: index });
              ancestor.setAttribute(attribute, index);
            }
            for (const element of [owner, ...owner.querySelectorAll("*")]) {
              const index = String(isolation.marked.length);
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
            for (const fact of isolation.ownerFacts)
              if (
                ["", "::before", "::after"].some(
                  (pseudo, index) => fingerprint(fact.element, pseudo) !== fact.styles[index],
                )
              )
                throw new Error("external CSS native isolation changed inherited owner paint");
            for (const fact of isolation.dependencies)
              if (fingerprint(fact.element, "") !== fact.styles)
                throw new Error("external CSS native isolation changed an outside local-definition dependency");
            const paint: AncestorPaint[] = [];
            for (const element of document.querySelectorAll("*")) {
              if (owner.contains(element) || dependencies.has(element)) continue;
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
            return paint;
          },
          { ...identity, ownerToken: target.token, attribute },
        ),
      );
      requireTransparentAncestors(beforePaint, "external CSS native isolation could not suppress ancestor paint");
      shadowGuard = await openCssSvgShadowGuard(page, { ...identity, ownerToken: target.token });
      const shot = await bounded(page.screenshot({ clip: viewport, omitBackground: true, type: "png", timeout: 5000 }));
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
            const ancestors: Element[] = [];
            for (let ancestor = selected[0].parentElement; ancestor != null; ancestor = ancestor.parentElement)
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
            const paint: AncestorPaint[] = [];
            for (const element of document.querySelectorAll("*")) {
              if (selected[0].contains(element) || dependencies.has(element)) continue;
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
                });
              for (const pseudo of ancestor ? ["::before", "::after"] : ["", "::before", "::after"])
                if (getComputedStyle(element, pseudo || null).visibility !== "hidden")
                  throw new Error("external CSS foreign paint changed during screenshot");
            }
            for (const fact of selected[1].properties)
              if (getComputedStyle(selected[0]).getPropertyValue(fact.property) !== fact.computed)
                throw new Error("external CSS paint selection changed during screenshot");
            for (const fact of state.isolation.ownerFacts) {
              if (
                !fact.element.isConnected ||
                fact.element.ownerDocument !== document ||
                !selected[0].contains(fact.element)
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
      const { data, info } = await sharp(shot).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
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
      if (right < left || bottom < top) target.empty = true;
      else {
        const width = right - left + 1,
          height = bottom - top + 1;
        const cropped = await sharp(shot).extract({ left, top, width, height }).png().toBuffer();
        target.x = (left * viewport.width) / info.width;
        target.y = (top * viewport.height) / info.height;
        target.width = (width * viewport.width) / info.width;
        target.height = (height * viewport.height) / info.height;
        target.dataUri = `data:image/png;base64,${cropped.toString("base64")}`;
      }
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
