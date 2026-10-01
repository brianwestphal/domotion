import { afterEach, describe, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import { collectExternalSvgUseDocumentsInPage } from "./external-svg-use.js";

afterEach(() => vi.unstubAllGlobals());

function page(html: string) {
  const window = new Window({ url: "https://sprite.example/page.html" });
  window.document.body.innerHTML = html;
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("location", window.location);
  vi.stubGlobal("DOMParser", window.DOMParser);
}

const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`;

describe("external SVG use prefetch graph", () => {
  it("resolves nested files relative to their source, once per URL, and stops cycles", async () => {
    page('<svg><use href="/icons/outer.svg#s"/><use href="/icons/outer.svg#s"/></svg>');
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (href: string) => {
      requested.push(href);
      return new Response(
        href.endsWith("outer.svg")
          ? svg('<symbol id="s"><use href="parts/inner.svg#x"/></symbol>')
          : svg('<g id="x"><use href="../outer.svg#s"/></g>'),
        { headers: { "content-type": "image/svg+xml" } },
      );
    });
    const reports = await collectExternalSvgUseDocumentsInPage({ timeoutMs: 100, maxDepth: 5, maxDocuments: 32 });
    expect(requested).toEqual([
      "https://sprite.example/icons/outer.svg",
      "https://sprite.example/icons/parts/inner.svg",
    ]);
    expect([...reports.values()].every((entry) => entry.document != null)).toBe(true);
  });

  it("records cross-origin and depth-limit failures without requesting them", async () => {
    page('<svg><use href="/outer.svg#s"/></svg>');
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (href: string) => {
      requested.push(href);
      return new Response(svg('<g id="s"><use href="/deeper.svg#x"/><use href="https://other.example/x.svg#x"/></g>'));
    });
    const reports = await collectExternalSvgUseDocumentsInPage({ timeoutMs: 100, maxDepth: 0, maxDocuments: 32 });
    expect(requested).toEqual(["https://sprite.example/outer.svg"]);
    expect(reports.get("https://sprite.example/deeper.svg")?.failure).toMatch(/depth limit/);
    expect(reports.get("https://other.example/x.svg")?.failure).toMatch(/depth limit/);
  });

  it("bounds the document count before making extra requests", async () => {
    page('<svg><use href="/a.svg#x"/><use href="/b.svg#x"/></svg>');
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (href: string) => {
      requested.push(href);
      return new Response(svg('<g id="x"/>'));
    });
    const reports = await collectExternalSvgUseDocumentsInPage({ timeoutMs: 100, maxDepth: 5, maxDocuments: 1 });
    expect(requested).toEqual(["https://sprite.example/a.svg"]);
    expect(reports.get("https://sprite.example/b.svg")?.failure).toMatch(/document limit/);
  });
});
