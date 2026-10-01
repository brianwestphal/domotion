/** Prefetch same-origin SVG documents needed by external <use> chains. */
import type { Page } from "@playwright/test";
import type { AsyncDisposable } from "./cdp-lifecycle.js";
import { createPageRegistry } from "./page-registry.js";

export const EXTERNAL_SVG_FETCH_TIMEOUT_MS = 5000;
export const EXTERNAL_SVG_MAX_DEPTH = 5;
export const EXTERNAL_SVG_MAX_DOCUMENTS = 32;

type Entry = { document: Document | null; failure?: string };

export interface ExternalSvgUsePrime extends AsyncDisposable {
  /** Window property holding a `Map<documentUrl, { document: Document | null; failure?: string }>`. */
  registryKey: string;
}

/** Runs inside one Chromium frame; kept self-contained for callback serialization. */
export async function collectExternalSvgUseDocumentsInPage(options: {
  timeoutMs: number;
  maxDepth: number;
  maxDocuments: number;
}): Promise<Map<string, Entry>> {
  const XLINK = "http://www.w3.org/1999/xlink";
  const registry = new Map<string, Entry>();
  const here = new URL(document.URL);
  here.hash = "";
  const pending: Array<{ href: string; depth: number }> = [];
  const queued = new Set<string>();
  const enqueue = (raw: string, base: string, depth: number): void => {
    if (raw === "" || raw.startsWith("#")) return;
    let href: string;
    try {
      const url = new URL(raw, base);
      url.hash = "";
      href = url.href;
    } catch {
      return;
    }
    if (queued.has(href)) return;
    queued.add(href);
    if (depth > options.maxDepth) {
      registry.set(href, { document: null, failure: "nested external <use> chain exceeded the depth limit" });
    } else if (queued.size > options.maxDocuments) {
      registry.set(href, { document: null, failure: "external SVG document limit exceeded" });
    } else {
      pending.push({ href, depth });
    }
  };
  for (const use of Array.from(document.querySelectorAll("use"))) {
    enqueue(use.getAttribute("href") ?? use.getAttributeNS(XLINK, "href") ?? "", document.baseURI, 0);
  }
  while (pending.length > 0) {
    const depth = pending[0].depth;
    const split = pending.findIndex((item) => item.depth !== depth);
    const layer = pending.splice(0, split < 0 ? pending.length : split);
    await Promise.all(
      layer.map(async ({ href }) => {
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
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeoutMs);
        try {
          const response = await fetch(href, { credentials: "same-origin", signal: controller.signal });
          if (!response.ok) {
            registry.set(href, { document: null, failure: `HTTP ${response.status}` });
            return;
          }
          const text = await response.text();
          const parsed = new DOMParser().parseFromString(text, "image/svg+xml");
          if (parsed.getElementsByTagName("parsererror").length > 0) {
            registry.set(href, { document: null, failure: "the document is not well-formed SVG" });
            return;
          }
          registry.set(href, { document: parsed });
          for (const use of Array.from(parsed.querySelectorAll("use"))) {
            enqueue(use.getAttribute("href") ?? use.getAttributeNS(XLINK, "href") ?? "", href, depth + 1);
          }
        } catch (error) {
          registry.set(href, {
            document: null,
            failure: error instanceof Error && error.name === "AbortError" ? "the fetch timed out" : String(error),
          });
        } finally {
          clearTimeout(timer);
        }
      }),
    );
  }
  return registry;
}

export async function primeExternalSvgUseDocuments(page: Page): Promise<ExternalSvgUsePrime> {
  const registry = createPageRegistry<Map<string, Entry>>(page, "ExternalSvgUse");
  const frames = page.frames();
  await Promise.all(
    frames.map(async (frame) => {
      try {
        await registry.tag(frame, collectExternalSvgUseDocumentsInPage, {
          timeoutMs: EXTERNAL_SVG_FETCH_TIMEOUT_MS,
          maxDepth: EXTERNAL_SVG_MAX_DEPTH,
          maxDocuments: EXTERNAL_SVG_MAX_DOCUMENTS,
        });
      } catch {
        /* Detached/cross-process frames have no registry. */
      }
    }),
  );
  return { registryKey: registry.key, dispose: () => registry.dispose() };
}
