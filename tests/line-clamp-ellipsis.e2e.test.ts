import { afterAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  captureElementTreeWithWarnings,
  elementTreeToSvgInner,
  launchChromium,
  type CapturedElement,
  type TextSegment,
} from '../src/index.js';
import { closeBrowserSafely } from '../src/test-support/close-browser-safely.js';

// DM-2417 browser matrix.  These are capture-contract assertions rather than
// screenshot fixture coordinates: each row asks Chromium to lay out different
// text/style/direction axes, then verifies that the generated fragment facts
// and the source-fragment visibility boundary survive into the tree/SVG.

const W = 980;
const H = 1450;
const WORDS = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega';

const HTML = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 8px; font-family: Arial, sans-serif; }
  .row { margin: 0 0 12px; }
  .clamp { width: 176px; font: 16px/20px Arial, sans-serif; display: -webkit-box;
    -webkit-box-orient: vertical; overflow: visible; }
  .hidden { overflow: hidden; }
  .boundary { width: 154px; font: 17px/22px Georgia, serif; }
  .mixed { width: 164px; font: 18px/24px Arial, sans-serif; }
  .mixed span { font: 25px/30px Georgia, serif; }
  .rtl { direction: rtl; width: 172px; font: 18px/23px Arial, sans-serif; }
  .vertical { writing-mode: vertical-rl; height: 150px; width: auto;
    font: 18px/24px Arial, sans-serif; }
  .zoom { zoom: 1.25; }
  .flex { display: flex; width: 300px; }
  .flex > .clamp { flex: 0 0 170px; }
  .ordinary { width: 85px; white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis; font: 16px/20px Arial, sans-serif; }
  .inactive { width: 176px; font: 16px/20px Arial, sans-serif;
    -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .fake-flow-root { display: flow-root; height: 40px; }
  .oracle-area { position: absolute; left: 430px; top: 18px; }
  .oracle { margin: 0 0 22px; display: -webkit-box; -webkit-box-orient: vertical;
    overflow: hidden; width: 176px; font: 20px/25px Arial, sans-serif; }
  .oracle > span { color: transparent !important; }
  .oracle-red { color: rgb(224,32,32); }
  .oracle-green { color: rgb(21,153,71); direction: rtl; }
  .oracle-blue { color: rgb(36,94,232); width: 158px; font: 18px/24px Georgia, serif; }
  .oracle-magenta { color: rgb(179,42,204); writing-mode: vertical-rl;
    height: 150px; width: auto; }
</style><body>
  <div id="c1" class="row clamp hidden" style="-webkit-line-clamp:1">one ${WORDS}</div>
  <div id="c2" class="row clamp" style="-webkit-line-clamp:2">two ${WORDS}</div>
  <div id="c3" class="row clamp hidden" style="-webkit-line-clamp:3">three ${WORDS}</div>
  <div id="c5" class="row clamp" style="-webkit-line-clamp:5">five ${WORDS} ${WORDS}</div>
  <div id="short" class="row clamp hidden" style="-webkit-line-clamp:3">short text</div>
  <div id="boundary" class="row clamp boundary hidden" style="-webkit-line-clamp:2">boundary <span>alpha beta gamma</span> <strong>delta epsilon zeta eta theta iota</strong></div>
  <div id="mixed" class="row clamp mixed hidden" style="-webkit-line-clamp:2">root alpha 漢字 <span>BIG beta gamma delta</span> omega epsilon zeta eta</div>
  <div class="row flex"><div id="flex-child" class="clamp hidden" style="-webkit-line-clamp:2">flex ${WORDS}</div></div>
  <div id="rtl" class="row clamp rtl hidden" style="-webkit-line-clamp:2">rtl ${WORDS}</div>
  <div id="vertical" class="row clamp vertical hidden" style="-webkit-line-clamp:2">vertical ${WORDS}</div>
  <div id="zoom" class="row clamp zoom hidden" style="-webkit-line-clamp:2">zoom ${WORDS}</div>
  <div id="astral" class="row clamp hidden" style="-webkit-line-clamp:1">astral 𝔘𝔘𝔘𝔘𝔘𝔘𝔘𝔘𝔘𝔘 𝔘𝔘𝔘𝔘𝔘𝔘𝔘𝔘𝔘𝔘 continuation ${WORDS}</div>
  <div id="inactive" class="row inactive">inactive ${WORDS}</div>
  <div id="fake" class="row inactive fake-flow-root">fake ${WORDS}</div>
  <div id="unclamped" class="row clamp hidden">unclamped ${WORDS}</div>
  <div id="ordinary" class="row ordinary">ordinary text overflow marker remains independent</div>
  <section class="oracle-area">
    <div class="oracle oracle-red" style="-webkit-line-clamp:1"><span>${WORDS}</span></div>
    <div class="oracle oracle-green" style="-webkit-line-clamp:2"><span>${WORDS}</span></div>
    <div class="oracle oracle-blue" style="-webkit-line-clamp:3"><span>alpha beta <b style="font-size:27px">gamma delta epsilon</b> ${WORDS}</span></div>
    <div class="oracle oracle-magenta" style="-webkit-line-clamp:2"><span>vertical ${WORDS}</span></div>
  </section>
</body>`;

const children = (node: CapturedElement): CapturedElement[] => node.children ?? [];

function findByIdText(nodes: CapturedElement[], prefix: string): CapturedElement | undefined {
  for (const node of nodes) {
    if (node.text.startsWith(prefix)) return node;
    const found = findByIdText(children(node), prefix);
    if (found) return found;
  }
  return undefined;
}

function marker(node: CapturedElement | undefined): TextSegment | undefined {
  return node?.textSegments?.find((segment) => segment.generatedLineClampEllipsis);
}

function allSegments(node: CapturedElement): TextSegment[] {
  return [
    ...(node.textSegments ?? []),
    ...children(node).flatMap(allSegments),
  ];
}

const browser = await launchChromium().catch(() => null);
afterAll(async () => closeBrowserSafely(browser), 15_000);
const describeBrowser = browser ? describe : describe.skip;

describeBrowser('DM-2417 generated line-clamp ellipsis capture', () => {
  let tree: CapturedElement[];
  let svg = '';
  let expectedPng: Buffer;
  let actualPng: Buffer;
  let captureWarnings: Array<{ feature: string }> = [];

  it('captures the matrix at DPR 2', async () => {
    const page = await browser!.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
    try {
      await page.setContent(HTML, { waitUntil: 'load' });
      expectedPng = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
      const captured = await captureElementTreeWithWarnings(page, 'body', { x: 0, y: 0, width: W, height: H });
      tree = captured.tree;
      captureWarnings = captured.warnings;
      svg = elementTreeToSvgInner(tree, W, H);
      const svgDoc = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="white"/>${svg}</svg>`;
      await page.setContent(`<!doctype html><body style="margin:0">${svgDoc}</body>`, { waitUntil: 'load' });
      actualPng = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
    } finally {
      await page.close();
    }
    expect(tree.length).toBeGreaterThan(0);
    expect(captureWarnings.filter((warning) => warning.feature === 'line-clamp generated ellipsis')).toEqual([]);
  });

  it.each([
    ['one ', 1], ['two ', 2], ['three ', 3], ['five ', 5],
  ])('captures one generated marker and at most %i visible logical lines for %s', (prefix, clampCount) => {
    const node = findByIdText(tree, prefix)!;
    const generated = marker(node);
    expect(generated).toMatchObject({
      text: '…',
      generatedLineClampEllipsis: true,
      fontFamily: 'Arial, sans-serif',
      fontSize: 16,
      fontWeight: '400',
      fontStyle: 'normal',
    });
    expect(generated!.resolvedFontFace?.familyName).toBe('Arial');
    expect(generated!.resolvedFontFace?.postScriptName).toBeTruthy();
    expect(generated!.shapedWidth).toBeGreaterThan(0);
    expect(Number.isFinite(generated!.baseline)).toBe(true);
    expect(Number.isFinite(generated!.inlineOffset)).toBe(true);
    const sourceLines = new Set(allSegments(node)
      .filter((segment) => !segment.generatedLineClampEllipsis)
      .map((segment) => Math.round(segment.y)));
    expect(sourceLines.size).toBeLessThanOrEqual(clampCount);
  });

  it('does not generate for short, inactive block, or authored flow-root controls', () => {
    expect(marker(findByIdText(tree, 'short text'))).toBeUndefined();
    expect(marker(findByIdText(tree, 'inactive '))).toBeUndefined();
    expect(marker(findByIdText(tree, 'fake '))).toBeUndefined();
    expect(marker(findByIdText(tree, 'unclamped '))).toBeUndefined();
  });

  it('removes the DOM-laid-out continuation tail at the AX-retained boundary', () => {
    const node = findByIdText(tree, 'one ')!;
    const generated = marker(node)!;
    const retainedEnds = allSegments(node)
      .filter((segment) => !segment.generatedLineClampEllipsis)
      .flatMap((segment) => (segment.xOffsets ?? []).map((x, index) =>
        x + (segment.xAdvances?.[index] ?? 0)));
    expect(retainedEnds.length).toBeGreaterThan(0);
    expect(Math.max(...retainedEnds)).toBeLessThanOrEqual(generated.x + 0.25);
    const astral = findByIdText(tree, 'astral ')!;
    expect(marker(astral)).toBeDefined();
    for (const segment of allSegments(astral)) {
      // Range facts repeat for both UTF-16 units; trimming must nevertheless
      // retain or remove the full supplementary-plane scalar atomically.
      expect(segment.text).not.toMatch(/[\uD800-\uDBFF]$/u);
      expect([...segment.text].join('')).toBe(segment.text);
    }
  });

  it('keeps root ellipsis style across inline and mixed-size boundaries', () => {
    const boundary = marker(findByIdText(tree, 'boundary'))!;
    expect(boundary.fontFamily).toContain('Georgia');
    expect(boundary.fontSize).toBe(17);
    const mixed = marker(findByIdText(tree, 'root alpha'))!;
    expect(mixed.fontFamily).toBe('Arial, sans-serif');
    expect(mixed.fontSize).toBe(18);
  });

  it('covers flex-child, RTL, vertical writing, and zoom/DPR facts', () => {
    expect(marker(findByIdText(tree, 'flex '))).toBeDefined();
    const rtl = marker(findByIdText(tree, 'rtl '))!;
    expect(rtl.inlineOffset).toBeLessThan(rtl.x + rtl.width + 0.01);
    const vertical = marker(findByIdText(tree, 'vertical '))!;
    expect(vertical.verticalWritingMode).toBe('vertical-rl');
    expect(vertical.yOffsets).toEqual([vertical.inlineOffset]);
    const zoom = marker(findByIdText(tree, 'zoom '))!;
    expect(zoom.shapedWidth).toBeGreaterThan(16);
  });

  it('renders generated fragments while preserving ordinary text-overflow', () => {
    expect(svg).toContain('aria-label="ordinary text overflow marker remains independent"');
    expect(svg).toMatch(/<text[^>]*>…<\/text>/);
    expect(marker(findByIdText(tree, 'ordinary '))).toBeUndefined();
    expect(findByIdText(tree, 'ordinary ')!.styles.textOverflow).toBe('ellipsis');
  });

  it('matches Chromium generated-fragment ink bounds in isolated paint oracle rows', async () => {
    const decode = async (png: Buffer) => sharp(png).removeAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    const [expected, actual] = await Promise.all([decode(expectedPng), decode(actualPng)]);
    const targets: Array<[number, number, number]> = [
      [224, 32, 32], [21, 153, 71], [36, 94, 232], [179, 42, 204],
    ];
    const bounds = (decoded: Awaited<ReturnType<typeof decode>>, target: [number, number, number]) => {
      let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, count = 0;
      const { data, info } = decoded;
      for (let y = 0; y < info.height; y++) {
        for (let x = 0; x < info.width; x++) {
          const i = (y * info.width + x) * info.channels;
          const distance = Math.abs(data[i] - target[0])
            + Math.abs(data[i + 1] - target[1])
            + Math.abs(data[i + 2] - target[2]);
          if (distance > 90) continue;
          count++;
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
      }
      return { minX, minY, maxX, maxY, count };
    };
    for (const target of targets) {
      const chrome = bounds(expected, target);
      const rendered = bounds(actual, target);
      expect(chrome.count).toBeGreaterThan(4);
      expect(rendered.count).toBeGreaterThan(4);
      // DPR=2: tolerate two CSS pixels of independent glyph rasterisation,
      // while requiring the generated fragment to occupy the same line/side.
      for (const key of ['minX', 'minY', 'maxX', 'maxY'] as const) {
        expect(Math.abs(rendered[key] - chrome[key]), `${target.join(',')} ${key} chrome=${JSON.stringify(chrome)} rendered=${JSON.stringify(rendered)}`).toBeLessThanOrEqual(4);
      }
    }
  });
});
