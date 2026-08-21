import { afterAll, describe, expect, it } from 'vitest';
import {
  captureElementTree,
  elementTreeToSvgInner,
  launchChromium,
} from '../src/index.js';
import { closeBrowserSafely } from '../src/test-support/close-browser-safely.js';

const browser = await launchChromium().catch(() => null);
afterAll(async () => closeBrowserSafely(browser), 15_000);
const describeBrowser = browser ? describe : describe.skip;

const WIDTH = 920;
const HEIGHT = 720;

const HTML = `<!doctype html><style>body{margin:0}svg{display:block;margin:0}</style>
<svg id="subject" width="900" height="700" viewBox="0 0 450 350">
  <defs>
    <path id="straight" d="M20 35 H210"/>
    <path id="scaled" d="M20 85 C80 25 150 145 220 85" pathLength="100"/>
    <path id="moved" d="M5 5 Q70 70 135 5" transform="translate(235 35) rotate(8)"/>
    <path id="closed" d="M260 145 h130 v55 h-130 z"/>
    <path id="css-path" d="M0 0" style='d:path("M 20 245 C 90 195 150 295 225 245")'/>
    <path id="nested-path" d="M10 30 H170"/>
  </defs>
  <g font-family="Arial" font-size="13" fill="black">
    <text data-case="href-absolute"><textPath href="#straight" startOffset="17">href absolute</textPath></text>
    <text data-case="href-percent"><textPath href="#scaled" startOffset="25%">percent offset</textPath></text>
    <text data-case="path-length-equivalent"><textPath href="#scaled" startOffset="25">percent offset</textPath></text>
    <text data-case="inline-path"><textPath path="M20 125 C75 75 145 175 220 125" startOffset="12%">inline path</textPath></text>
    <text data-case="transformed-ref"><textPath href="#moved" startOffset="8">transformed ref</textPath></text>
    <text data-case="closed-anchor" text-anchor="middle"><textPath href="#closed" startOffset="50%">closed middle</textPath></text>
    <text data-case="rtl-end" direction="rtl" text-anchor="end"><textPath href="#straight" startOffset="90%">RTL end</textPath></text>
    <text data-case="css-d"><textPath href="#css-path" startOffset="10%">CSS d winner</textPath></text>
    <text data-case="invalid"><textPath path="not a path">invalid</textPath></text>
    <text data-case="unresolved"><textPath href="#missing">unresolved</textPath></text>
  </g>
  <svg x="235" y="255" width="190" height="75" viewBox="0 0 190 75">
    <text data-case="nested-viewbox" font-family="Arial" font-size="13"><textPath href="#nested-path" startOffset="10%">nested viewBox</textPath></text>
  </svg>
</svg>`;

type Matrix = Record<string, unknown>;

async function snapshot(page: import('@playwright/test').Page): Promise<Matrix> {
  return page.evaluate(() => {
    const round = (value: number) => Number(value.toFixed(4));
    const matrix = (value: DOMMatrix | null) => value == null ? null
      : [value.a, value.b, value.c, value.d, value.e, value.f].map(round);
    const result: Record<string, unknown> = {};
    for (const text of document.querySelectorAll<SVGTextElement>('text[data-case]')) {
      const textPath = text.querySelector<SVGTextPathElement>('textPath')!;
      const href = textPath.getAttribute('href');
      const referenced = href?.startsWith('#')
        ? document.getElementById(href.slice(1)) as SVGPathElement | null
        : null;
      let pathLength: number | null = null;
      if (referenced instanceof SVGPathElement) pathLength = round(referenced.getTotalLength());
      else if (textPath.getAttribute('path')) {
        const probe = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        probe.setAttribute('d', textPath.getAttribute('path')!);
        text.ownerSVGElement!.appendChild(probe);
        try { pathLength = round(probe.getTotalLength()); } catch { pathLength = null; }
        probe.remove();
      }
      const chars = [];
      for (let i = 0; i < text.getNumberOfChars(); i++) {
        try {
          const start = text.getStartPositionOfChar(i);
          const end = text.getEndPositionOfChar(i);
          chars.push({
            start: [round(start.x), round(start.y)],
            end: [round(end.x), round(end.y)],
            rotation: round(text.getRotationOfChar(i)),
          });
        } catch {
          chars.push(null);
        }
      }
      const bbox = text.getBBox();
      result[text.dataset.case!] = {
        pathLength,
        pathCtm: matrix(referenced?.getCTM() ?? null),
        textCtm: matrix(text.getCTM()),
        computedLength: round(text.getComputedTextLength()),
        bbox: [bbox.x, bbox.y, bbox.width, bbox.height].map(round),
        chars,
      };
    }
    return result;
  });
}

describeBrowser('DM-2416 Blink inline SVG textPath intermediate oracle', () => {
  it('preserves Blink path, transform, glyph geometry, rotation, and visibility branches', async () => {
    const context = await browser!.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
    const source = await context.newPage();
    const consumer = await context.newPage();
    try {
      await source.setContent(HTML);
      const expected = await snapshot(source);
      const tree = await captureElementTree(source, 'body', { x: 0, y: 0, width: WIDTH, height: HEIGHT });
      const inner = elementTreeToSvgInner(tree, WIDTH, HEIGHT);
      await consumer.setContent(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">${inner}</svg>`);
      const actual = await snapshot(consumer);

      expect(actual).toEqual(expected);
      expect(expected['href-percent']).toEqual(expected['path-length-equivalent']);
      for (const name of ['invalid', 'unresolved']) {
        const hidden = expected[name] as { chars: Array<{ start: number[]; end: number[] } | null> };
        expect(hidden.chars.every((char) => char == null
          || (char.start[0] === 0 && char.start[1] === 0
            && char.end[0] === 0 && char.end[1] === 0))).toBe(true);
      }
    } finally {
      await context.close();
    }
  }, 60_000);

  it('detects duplicate fragment ids introduced when independent tree scopes are combined', async () => {
    const context = await browser!.newContext({ viewport: { width: 500, height: 260 } });
    const source = await context.newPage();
    const consumer = await context.newPage();
    const child = (owner: string, path: string) => `<svg width="220" height="100" viewBox="0 0 220 100">
      <path id="shared-text-path" d="${path}"/>
      <text data-owner="${owner}" font-family="Arial" font-size="14"><textPath href="#shared-text-path">scope ${owner}</textPath></text>
    </svg>`;
    const escaped = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    try {
      await source.setContent(`<iframe srcdoc="${escaped(child('a', 'M10 25 H200'))}"></iframe>
        <iframe srcdoc="${escaped(child('b', 'M10 75 H200'))}"></iframe>`);
      const expected = await Promise.all(source.frames().slice(1).map((frame) => frame.locator('text').evaluate((text: SVGTextElement) => {
        const point = text.getStartPositionOfChar(0);
        return [point.x, point.y];
      })));
      const tree = await captureElementTree(source, 'body', { x: 0, y: 0, width: 500, height: 260 });
      const inner = elementTreeToSvgInner(tree, 500, 260);
      await consumer.setContent(`<svg xmlns="http://www.w3.org/2000/svg" width="500" height="260">${inner}</svg>`);
      const actual = await consumer.locator('text[data-owner]').evaluateAll((texts: SVGTextElement[]) => texts.map((text) => {
        const point = text.getStartPositionOfChar(0);
        return [point.x, point.y];
      }));

      expect(expected).toEqual([[10, 25], [10, 75]]);
      expect(actual[0]).toEqual(expected[0]);
      // Current passthrough combines independently-scoped SVGs into one
      // consumer document. Both hrefs then bind the first duplicate id.
      expect(actual[1]).not.toEqual(expected[1]);
      expect(actual[1]).toEqual(expected[0]);
    } finally {
      await context.close();
    }
  }, 60_000);
});
