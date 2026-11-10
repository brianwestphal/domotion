import { describe, expect, it } from "vitest";
import { collectExternalSvgUseDocuments, type ExternalSvgSourceFrame } from "./external-svg-use.js";

const source = (hrefs: string[]): ExternalSvgSourceFrame => ({
  url: "https://sprite.example/page.html",
  baseURI: "https://sprite.example/page.html",
  origin: "https://sprite.example",
  hrefs,
});
const limits = { maxDepth: 5, maxDocuments: 32 };

describe("external SVG use prefetch graph", () => {
  it("resolves nested files relative to their source, once per URL, and stops cycles", async () => {
    const requested: string[] = [];
    const text = '<svg xmlns="http://www.w3.org/2000/svg">  original text \u2603 </svg>';
    const reports = await collectExternalSvgUseDocuments(
      source(["/icons/outer.svg#s", "/icons/outer.svg#s"]),
      async (href) => {
        requested.push(href);
        return { text, hrefs: href.endsWith("outer.svg") ? ["parts/inner.svg#x"] : ["../outer.svg#s"] };
      },
      limits,
    );
    expect(requested).toEqual([
      "https://sprite.example/icons/outer.svg",
      "https://sprite.example/icons/parts/inner.svg",
    ]);
    expect([...reports.values()]).toEqual([{ text }, { text }]);
  });

  it("records cross-origin and depth-limit failures without requesting them", async () => {
    const requested: string[] = [];
    const reports = await collectExternalSvgUseDocuments(
      source(["/outer.svg#s"]),
      async (href) => {
        requested.push(href);
        return { text: "svg", hrefs: ["/deeper.svg#x", "https://other.example/x.svg#x"] };
      },
      { ...limits, maxDepth: 0 },
    );
    expect(requested).toEqual(["https://sprite.example/outer.svg"]);
    expect(reports.get("https://sprite.example/deeper.svg")).toMatchObject({
      failure: expect.stringMatching(/depth limit/),
    });
    expect(reports.get("https://other.example/x.svg")).toMatchObject({ failure: expect.stringMatching(/depth limit/) });
  });

  it("bounds the document count before making extra requests", async () => {
    const requested: string[] = [];
    const reports = await collectExternalSvgUseDocuments(
      source(["/a.svg#x", "/b.svg#x"]),
      async (href) => {
        requested.push(href);
        return { text: "svg", hrefs: [] };
      },
      { ...limits, maxDocuments: 1 },
    );
    expect(requested).toEqual(["https://sprite.example/a.svg"]);
    expect(reports.get("https://sprite.example/b.svg")).toMatchObject({
      failure: expect.stringMatching(/document limit/),
    });
  });

  it("retains same-document identity while refusing foreign/non-http URLs even with CORS permission", async () => {
    const requested: string[] = [];
    const reports = await collectExternalSvgUseDocuments(
      source(["#local", "page.html#same", "https://other.example/a.svg#x", "data:image/svg+xml,x", "http://["]),
      async (href) => {
        requested.push(href);
        return { text: "svg", hrefs: [] };
      },
      limits,
    );
    expect(requested).toEqual([]);
    expect(reports.get("https://sprite.example/page.html")).toEqual({ currentDocument: true });
    expect(reports.get("https://other.example/a.svg")).toMatchObject({
      failure: expect.stringMatching(/not same-origin/),
    });
    expect(reports.get("data:image/svg+xml,x")).toMatchObject({ failure: expect.stringMatching(/not same-origin/) });
    expect(reports.size).toBe(3);
  });

  it("retains explicit network/parser/HTTP/timeout diagnostics instead of promoting failed documents", async () => {
    const reports = await collectExternalSvgUseDocuments(
      source(["/a.svg#x", "/b.svg#x", "/c.svg#x"]),
      async (href) => ({
        failure: href.endsWith("a.svg")
          ? "HTTP 404"
          : href.endsWith("b.svg")
            ? "the fetch timed out"
            : "the document is not well-formed SVG",
      }),
      limits,
    );
    expect([...reports.values()]).toEqual([
      { failure: "HTTP 404" },
      { failure: "the fetch timed out" },
      { failure: "the document is not well-formed SVG" },
    ]);
  });
});
