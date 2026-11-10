/** Prefetch same-origin SVG documents needed by external <use> chains. */
import type { Page } from "@playwright/test";
import type { AsyncDisposable } from "./cdp-lifecycle.js";
import { evaluateInFrame } from "./evaluate-in-frame.js";
import { openExternalSvgTransport, type ExternalSvgResponse } from "./external-svg-transport.js";
import { createPageRegistry } from "./page-registry.js";

export const EXTERNAL_SVG_FETCH_TIMEOUT_MS = 5000;
export const EXTERNAL_SVG_MAX_DEPTH = 5;
export const EXTERNAL_SVG_MAX_DOCUMENTS = 32;

type Entry = { document: Document | null; failure?: string };
type SourceEntry = { text: string } | { currentDocument: true } | { failure: string };
export interface ExternalSvgSourceFrame {
  url: string;
  baseURI: string;
  origin: string;
  hrefs: string[];
}
export interface ExternalSvgUsePrime extends AsyncDisposable {
  /** Window property holding a `Map<documentUrl, { document: Document | null; failure?: string }>`. */
  registryKey: string;
}

/** Bound the URL graph; the loader owns native request-mode/redirect admission. */
export async function collectExternalSvgUseDocuments(
  source: ExternalSvgSourceFrame,
  load: (href: string) => Promise<ExternalSvgResponse>,
  options: { maxDepth: number; maxDocuments: number },
): Promise<Map<string, SourceEntry>> {
  const registry = new Map<string, SourceEntry>();
  const here = new URL(source.url);
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
      registry.set(href, { failure: "nested external <use> chain exceeded the depth limit" });
    } else if (queued.size > options.maxDocuments) {
      registry.set(href, { failure: "external SVG document limit exceeded" });
    } else {
      pending.push({ href, depth });
    }
  };
  for (const href of source.hrefs) enqueue(href, source.baseURI, 0);
  while (pending.length > 0) {
    const depth = pending[0].depth;
    const split = pending.findIndex((item) => item.depth !== depth);
    const layer = pending.splice(0, split < 0 ? pending.length : split);
    await Promise.all(
      layer.map(async ({ href }) => {
        if (href === here.href) {
          registry.set(href, { currentDocument: true });
          return;
        }
        const url = new URL(href);
        if (url.origin !== source.origin || (url.protocol !== "http:" && url.protocol !== "https:")) {
          registry.set(href, {
            failure: `${url.protocol}//${url.host} is not same-origin http(s), which Chromium requires of an external <use> target`,
          });
          return;
        }
        const response = await load(href);
        if ("failure" in response) {
          registry.set(href, response);
          return;
        }
        registry.set(href, { text: response.text });
        for (const child of response.hrefs) enqueue(child, href, depth + 1);
      }),
    );
  }
  return registry;
}

export async function primeExternalSvgUseDocuments(page: Page): Promise<ExternalSvgUsePrime> {
  const registry = createPageRegistry<Map<string, Entry>>(page, "ExternalSvgUse");
  try {
    const results = await Promise.allSettled(
      page.frames().map(async (frame) => {
        let transport: Promise<Awaited<ReturnType<typeof openExternalSvgTransport>>> | undefined;
        let failure: unknown;
        try {
          const source = await evaluateInFrame(frame, () => ({
            url: document.URL,
            baseURI: document.baseURI,
            origin: location.origin,
            hrefs: Array.from(document.querySelectorAll("use")).map(
              (use) => use.getAttribute("href") ?? use.getAttributeNS("http://www.w3.org/1999/xlink", "href") ?? "",
            ),
          }));
          const documents = await collectExternalSvgUseDocuments(
            source,
            async (href) => {
              transport ??= openExternalSvgTransport(frame, EXTERNAL_SVG_FETCH_TIMEOUT_MS);
              // SVGUseElement explicitly requests kSameOrigin. Let native
              // fetch enforce every redirect hop, including out-and-back;
              // the shared transport retains generic CORS for other callers.
              return (await transport).fetch(href, "same-origin");
            },
            { maxDepth: EXTERNAL_SVG_MAX_DEPTH, maxDocuments: EXTERNAL_SVG_MAX_DOCUMENTS },
          );
          await registry.tag(
            frame,
            (sources: Array<[string, SourceEntry]>) => {
              const entries = new Map<string, Entry>();
              for (const [href, source] of sources) {
                if ("failure" in source) entries.set(href, { document: null, failure: source.failure });
                else if ("currentDocument" in source) entries.set(href, { document });
                else {
                  try {
                    const parsed = new DOMParser().parseFromString(source.text, "image/svg+xml");
                    entries.set(
                      href,
                      parsed.getElementsByTagName("parsererror").length > 0
                        ? { document: null, failure: "the document is not well-formed SVG" }
                        : { document: parsed },
                    );
                  } catch (error) {
                    entries.set(href, { document: null, failure: String(error) });
                  }
                }
              }
              return entries;
            },
            [...documents],
          );
        } catch (error) {
          // A removed/navigating source has no reusable registry. Other setup
          // failures must remain visible instead of granting broader privileges.
          if (
            !frame.isDetached() &&
            !/Execution context was destroyed|Target page, context or browser has been closed/.test(String(error))
          )
            failure = error;
        } finally {
          try {
            await (await transport?.catch(() => undefined))?.dispose();
          } catch (cleanupError) {
            failure =
              failure == null
                ? cleanupError
                : new AggregateError([failure, cleanupError], "external SVG fetch and cleanup failed");
          }
        }
        if (failure != null) throw failure;
      }),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  } catch (error) {
    await registry.dispose();
    throw error;
  }
  return { registryKey: registry.key, dispose: () => registry.dispose() };
}
