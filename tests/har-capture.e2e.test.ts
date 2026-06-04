import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isHarPath, inferHarPageUrl } from "../src/cli/common.js";
import { runCapture } from "../src/cli/capture.js";
import { launchChromium } from "../src/index.js";

// DM-889: HAR-file capture source. Fast, deterministic unit tests for the
// detection + URL-inference helpers, plus a browser-gated end-to-end replay of
// a cached real-world HAR through the actual `runCapture` CLI path.

describe("isHarPath", () => {
  it("auto-detects .har inputs (case-insensitive), not URLs / other files / stdin", () => {
    expect(isHarPath("page.har")).toBe(true);
    expect(isHarPath("/abs/path/Apple-DESKTOP.HAR")).toBe(true);
    expect(isHarPath("page.svg")).toBe(false);
    expect(isHarPath("page.html")).toBe(false);
    expect(isHarPath("https://example.com/x.har/")).toBe(false); // trailing slash → not a .har file
    expect(isHarPath("-")).toBe(false);
  });
});

describe("inferHarPageUrl", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "dm889-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const writeHar = (name: string, log: unknown): string => {
    const p = path.join(tmp, name);
    writeFileSync(p, JSON.stringify({ log }));
    return p;
  };

  it("returns the first 2xx text/html entry's URL", () => {
    const har = writeHar("html.har", {
      entries: [
        { request: { url: "https://cdn.example/app.js" }, response: { status: 200, content: { mimeType: "application/javascript" } } },
        { request: { url: "https://example.com/page" }, response: { status: 200, content: { mimeType: "text/html; charset=utf-8" } } },
      ],
    });
    expect(inferHarPageUrl(har)).toBe("https://example.com/page");
  });

  it("prefers a URL-valued pages[0].title when present", () => {
    const har = writeHar("title.har", {
      pages: [{ title: "https://example.com/home" }],
      entries: [{ request: { url: "https://example.com/other" }, response: { status: 200, content: { mimeType: "text/html" } } }],
    });
    expect(inferHarPageUrl(har)).toBe("https://example.com/home");
  });

  it("falls back to the first entry's URL when no html entry exists", () => {
    const har = writeHar("nohtml.har", {
      entries: [{ request: { url: "https://example.com/first.json" }, response: { status: 200, content: { mimeType: "application/json" } } }],
    });
    expect(inferHarPageUrl(har)).toBe("https://example.com/first.json");
  });

  it("throws when there are no usable entries", () => {
    const har = writeHar("empty.har", { entries: [] });
    expect(() => inferHarPageUrl(har)).toThrow(/could not infer a page URL/);
  });

  it("throws on an unreadable / malformed HAR", () => {
    const p = path.join(tmp, "bad.har");
    writeFileSync(p, "{not json");
    expect(() => inferHarPageUrl(p)).toThrow(/could not read HAR/);
  });
});

// End-to-end: replay a cached real-world HAR through `runCapture`, offline.
// google-desktop.har is the lightest fixture (34 entries). Gated on a
// launchable browser (skips in a sandbox that blocks browser launch).
const HAR = path.resolve("tests/cache/real-world/google-desktop.har");
const browserOk = await (async () => {
  if (!existsSync(HAR)) return false;
  try { const b = await launchChromium(); await b.close(); return true; } catch { return false; }
})();
const describeE2E = browserOk ? describe : describe.skip;

describeE2E("HAR replay through runCapture (DM-889)", () => {
  const out = path.join(mkdtempSync(path.join(tmpdir(), "dm889-e2e-")), "google.svg");
  afterAll(() => rmSync(path.dirname(out), { recursive: true, force: true }));

  it("captures a non-empty SVG from a .har input, offline (notFound: abort)", async () => {
    await runCapture(["--quiet", "--width", "1280", "--height", "800", "-o", out, HAR], "");
    expect(existsSync(out)).toBe(true);
    const svg = readFileSync(out, "utf8");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('viewBox="0 0 1280 800"');
    expect(svg.length).toBeGreaterThan(1000); // real captured content, not an empty shell
  }, 120_000);
});
