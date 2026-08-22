import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { captureElementTree, elementTreeToSvgInner, launchChromium, setRenderTextMode } from "../src/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

/**
 * DM-2362 — Blink's ClipPath::ParseSingleValue treats a URL reference as an
 * exclusive operation.  A geometry box may accompany a basic shape or stand
 * alone, but `url(#id) padding-box` (in either order) is invalid.  For the URL
 * form Blink uses the HTML border box and forcibly uses the SVG fill box.
 */

async function setup() {
  try { return { browser: await launchChromium() }; } catch { return null; }
}

const env = await setup();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
const describeBrowser = env ? describe : describe.skip;

const BOXES = ["content-box", "padding-box", "border-box", "margin-box", "fill-box", "stroke-box", "view-box"];

function flatten(nodes: CapturedElement[]): CapturedElement[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

async function luminanceAtCss(png: Buffer, x: number, y: number, dpr: number): Promise<number> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = Math.max(0, Math.min(info.width - 1, Math.floor(x * dpr)));
  const py = Math.max(0, Math.min(info.height - 1, Math.floor(y * dpr)));
  const i = (py * info.width + px) * info.channels;
  return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
}

describeBrowser("URL clip-path reference boxes (DM-2362)", () => {
  it("keeps URL syntax exclusive and rejects stale URL-plus-box captures", async () => {
    const context = await env!.browser.newContext({ viewport: { width: 280, height: 180 } });
    const page = await context.newPage();
    try {
      await page.setContent(`<!doctype html><style>body{margin:0}#valid{width:120px;height:80px;background:#111;clip-path:url(#valid-clip)}</style>
        <svg width="0" height="0"><defs><clipPath id="valid-clip"><rect width="40" height="80"/></clipPath><clipPath id="invalid-clip"><rect width="20" height="80"/></clipPath></defs></svg>
        <div id="valid"></div>`);

      const syntax = await page.evaluate((boxes) => boxes.flatMap((box) => [
        `url(#invalid-clip) ${box}`,
        `${box} url(#invalid-clip)`,
      ]).map((value) => {
        const html = document.createElement("div");
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        html.setAttribute("style", `clip-path:${value}`);
        svg.setAttribute("style", `clip-path:${value}`);
        document.body.append(html, svg);
        const row = {
          value,
          supported: CSS.supports("clip-path", value),
          htmlSpecified: html.style.clipPath,
          htmlComputed: getComputedStyle(html).clipPath,
          svgSpecified: svg.style.clipPath,
          svgComputed: getComputedStyle(svg).clipPath,
        };
        html.remove();
        svg.remove();
        return row;
      }), BOXES);

      expect(syntax).toHaveLength(BOXES.length * 2);
      expect(syntax.every((row) => !row.supported
        && row.htmlSpecified === "" && row.htmlComputed === "none"
        && row.svgSpecified === "" && row.svgComputed === "none")).toBe(true);

      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 280, height: 180 });
      const root = tree[0];
      expect((root.clipPathDefs ?? []).map((def) => def.id)).toContain("valid-clip");
      expect((root.clipPathDefs ?? []).map((def) => def.id)).not.toContain("invalid-clip");

      const valid = flatten(tree).find((node) => node.tag === "div" && /^url\(/.test(node.styles.clipPath ?? ""));
      expect(valid).toBeDefined();
      valid!.styles.clipPath = "url(#valid-clip) padding-box";
      const mutated = elementTreeToSvgInner(tree, 280, 180);
      expect(mutated).not.toMatch(/id="[^"]*cpfrag/);
      expect(mutated).not.toMatch(/clip-path="url\(#[^"]*cpfrag/);
    } finally {
      await context.close();
    }
  }, 60_000);

  it.each([1, 2])("matches Chromium's HTML border-box and SVG fill-box URL ownership at DPR %i", async (dpr) => {
    const width = 260;
    const height = 560;
    const context = await env!.browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
    const page = await context.newPage();
    try {
      await page.setContent(`<!doctype html><style>
        *{box-sizing:border-box}html,body{margin:0;width:${width}px;height:${height}px;background:#fff}
        #html-valid{position:absolute;left:20px;top:20px;width:200px;height:100px;border:20px solid #111;padding:11px 7px;background:#111;clip-path:url(#html-clip)}
        #svg-valid{position:absolute;left:20px;top:180px;width:200px;height:120px;overflow:visible}
        #invalid{position:absolute;left:20px;top:330px;width:200px;height:70px;background:#111;clip-path:url(#invalid-clip) padding-box}
        #object-host{position:absolute;left:20px;top:420px;width:200px;height:100px;clip-path:url(#html-object-clip)}
        #object-host>i{position:absolute;left:80px;top:20px;width:80px;height:60px;background:#111}
      </style>
      <svg width="0" height="0" aria-hidden="true"><defs>
        <clipPath id="html-clip"><rect width="30" height="100"/></clipPath>
        <clipPath id="invalid-clip"><rect width="20" height="70"/></clipPath>
        <clipPath id="html-object-clip" clipPathUnits="objectBoundingBox"><rect width=".5" height="1"/></clipPath>
      </defs></svg>
      <div id="html-valid"></div>
      <svg id="svg-valid" viewBox="0 0 200 120"><defs><clipPath id="svg-clip" clipPathUnits="objectBoundingBox"><rect width=".25" height="1"/></clipPath></defs><rect x="60" y="30" width="80" height="40" fill="#111" stroke="#111" stroke-width="20" clip-path="url(#svg-clip)"/></svg>
      <div id="invalid"></div>
      <div id="object-host"><i></i></div>`);

      expect(await page.locator("#invalid").evaluate((element) => getComputedStyle(element).clipPath)).toBe("none");
      const source = await page.screenshot({ clip: { x: 0, y: 0, width, height } });

      setRenderTextMode("paths");
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width, height });
      const svg = elementTreeToSvgInner(tree, width, height);
      const svgDocument = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#fff"/>${svg}</svg>`;
      await page.setContent(`<!doctype html><body style="margin:0">${svgDocument}</body>`);
      const rendered = await page.screenshot({ clip: { x: 0, y: 0, width, height } });

      const probes = [
        { x: 25, y: 70, dark: true, discriminator: "HTML border-box left edge" },
        { x: 55, y: 70, dark: false, discriminator: "HTML padding/content offset must not move URL clip" },
        { x: 98, y: 230, dark: true, discriminator: "SVG URL reference uses fill-box" },
        { x: 102, y: 230, dark: false, discriminator: "SVG stroke-box mutation must stay clipped" },
        { x: 205, y: 365, dark: true, discriminator: "invalid URL-plus-box declaration paints unclipped" },
        { x: 110, y: 460, dark: true, discriminator: "HTML objectBoundingBox maps through the transparent host border box" },
        { x: 130, y: 460, dark: false, discriminator: "offset child bbox must not replace the HTML reference box" },
      ];
      for (const probe of probes) {
        const sourceLuminance = await luminanceAtCss(source, probe.x, probe.y, dpr);
        const renderedLuminance = await luminanceAtCss(rendered, probe.x, probe.y, dpr);
        expect(sourceLuminance, `Chromium: ${probe.discriminator}`).toSatisfy((value: number) => probe.dark ? value < 40 : value > 215);
        expect(renderedLuminance, `Domotion: ${probe.discriminator}`).toSatisfy((value: number) => probe.dark ? value < 40 : value > 215);
      }
    } finally {
      await context.close();
    }
  }, 60_000);

  it("resolves only valid same-document URL references through two nested iframes", async () => {
    const context = await env!.browser.newContext({ viewport: { width: 360, height: 260 } });
    const page = await context.newPage();
    try {
      await page.setContent(`<iframe id="outer" style="border:0;width:340px;height:240px"></iframe>`);
      await page.evaluate(() => {
        const outer = document.querySelector<HTMLIFrameElement>("#outer")!;
        const outerDocument = outer.contentDocument!;
        outerDocument.open();
        outerDocument.write('<!doctype html><body style="margin:0"><iframe id="inner" style="border:0;width:320px;height:220px"></iframe></body>');
        outerDocument.close();
        const inner = outerDocument.querySelector<HTMLIFrameElement>("#inner")!;
        inner.srcdoc = `<!doctype html><style>body{margin:0}.valid{width:100px;height:80px;background:#111;clip-path:url(#nested-valid)}.invalid{width:100px;height:80px;background:#111;clip-path:url(#nested-invalid) content-box}</style><svg width="0" height="0"><defs><clipPath id="nested-valid"><rect width="40" height="80"/></clipPath><clipPath id="nested-invalid"><rect width="20" height="80"/></clipPath></defs></svg><div class="valid"></div><div class="invalid"></div>`;
      });
      await page.waitForFunction(() => {
        const outer = document.querySelector<HTMLIFrameElement>("#outer");
        const inner = outer?.contentDocument?.querySelector<HTMLIFrameElement>("#inner");
        return inner?.contentDocument?.querySelector(".valid") != null;
      });

      const nestedComputed = await page.evaluate(() => {
        const outer = document.querySelector<HTMLIFrameElement>("#outer")!;
        const inner = outer.contentDocument!.querySelector<HTMLIFrameElement>("#inner")!;
        const doc = inner.contentDocument!;
        return {
          valid: getComputedStyle(doc.querySelector(".valid")!).clipPath,
          invalid: getComputedStyle(doc.querySelector(".invalid")!).clipPath,
        };
      });
      expect(nestedComputed.valid).toMatch(/^url\(/);
      expect(nestedComputed.invalid).toBe("none");

      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 360, height: 260 });
      const defs = (tree[0].clipPathDefs ?? []).map((def) => def.id);
      expect(defs).toContain("nested-valid");
      expect(defs).not.toContain("nested-invalid");
      expect(elementTreeToSvgInner(tree, 360, 260)).toMatch(/clip-path="url\(#[^"]*cpfrag/);
    } finally {
      await context.close();
    }
  }, 60_000);
});
