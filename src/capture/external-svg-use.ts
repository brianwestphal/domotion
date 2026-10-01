/**
 * Prefetch the external SVG documents that `<use href="sprite.svg#icon">` references point at.
 *
 * CAPTURE_SCRIPT is synchronous, so it cannot fetch. A `<use>` whose target lives in another file used to
 * be left dangling in the cloned SVG, which paints nothing while Chromium painted the icon. This prepass
 * runs first, in every frame: it collects each distinct external document the page's `<use>` elements
 * name, fetches it, parses it as an SVG document, and stashes the result on the window under a private key
 * for the capture script to resolve against. A document it cannot use is stashed with the reason, so the
 * script can warn and hand the host SVG to Chromium's raster instead of guessing.
 *
 * Only what Chromium itself would load is fetched: an external `<use>` must be same-origin, so a
 * cross-origin (or non-http) URL is recorded as a failure without a request.
 */
import type { Page } from "@playwright/test";
import type { AsyncDisposable } from "./cdp-lifecycle.js";
import { createPageRegistry } from "./page-registry.js";

/** How long one external document may take before it is recorded as failed. */
export const EXTERNAL_SVG_FETCH_TIMEOUT_MS = 5000;

export interface ExternalSvgUsePrime extends AsyncDisposable {
  /** Window property holding a `Map<documentUrl, { document: Document | null; failure?: string }>`. */
  registryKey: string;
}

export async function primeExternalSvgUseDocuments(page: Page): Promise<ExternalSvgUsePrime> {
  type Entry = { document: Document | null; failure?: string };
  const registry = createPageRegistry<Map<string, Entry>>(page, "ExternalSvgUse");
  const registryKey = registry.key;
  const frames = page.frames();
  await Promise.all(
    frames.map(async (frame) => {
      try {
        await registry.tag(
          frame,
          async (timeoutMs) => {
            const XLINK = "http://www.w3.org/1999/xlink";
            type Entry = { document: Document | null; failure?: string };
            const registry = new Map<string, Entry>();
            const here = new URL(document.URL);
            here.hash = "";
            const wanted = new Set<string>();
            for (const use of Array.from(document.querySelectorAll("use"))) {
              const raw = use.getAttribute("href") ?? use.getAttributeNS(XLINK, "href") ?? "";
              if (raw === "" || raw.startsWith("#")) continue;
              try {
                const url = new URL(raw, document.baseURI);
                url.hash = "";
                wanted.add(url.href);
              } catch {
                /* an unparsable reference stays unregistered and is reported by the script */
              }
            }
            await Promise.all(
              Array.from(wanted).map(async (href) => {
                if (href === here.href) {
                  registry.set(href, { document });
                  return;
                }
                const url = new URL(href);
                if (url.origin !== location.origin || (url.protocol !== "http:" && url.protocol !== "https:")) {
                  registry.set(href, {
                    document: null,
                    failure: `${url.protocol}//${url.host} is not same-origin http(s), which Chromium requires of an external <use> target`,
                  });
                  return;
                }
                try {
                  const controller = new AbortController();
                  const timer = setTimeout(() => controller.abort(), timeoutMs);
                  let text: string;
                  try {
                    const response = await fetch(href, { credentials: "same-origin", signal: controller.signal });
                    if (!response.ok) {
                      registry.set(href, { document: null, failure: `HTTP ${response.status}` });
                      return;
                    }
                    text = await response.text();
                  } finally {
                    clearTimeout(timer);
                  }
                  const parsed = new DOMParser().parseFromString(text, "image/svg+xml");
                  if (parsed.getElementsByTagName("parsererror").length > 0) {
                    registry.set(href, { document: null, failure: "the document is not well-formed SVG" });
                    return;
                  }
                  registry.set(href, { document: parsed });
                } catch (error) {
                  registry.set(href, {
                    document: null,
                    failure:
                      error instanceof Error && error.name === "AbortError" ? "the fetch timed out" : String(error),
                  });
                }
              }),
            );
            return registry;
          },
          EXTERNAL_SVG_FETCH_TIMEOUT_MS,
        );
      } catch {
        /* a frame that cannot run the prepass (detached, cross-process) simply has no registry */
      }
    }),
  );
  return {
    registryKey,
    dispose: () => registry.dispose(),
  };
}
