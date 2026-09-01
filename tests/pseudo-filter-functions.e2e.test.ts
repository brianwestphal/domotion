import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import {
  captureElementTree,
  elementTreeToSvg,
  launchChromium,
  type CapturedElement,
} from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const W = 760;
const H = 440;

const FILTERS = [
  "blur(3px)",
  "brightness(1.45)",
  "contrast(0.55)",
  "drop-shadow(rgb(220, 20, 60) 6px 4px 3px)",
  "grayscale(0.75)",
  "hue-rotate(73deg)",
  "invert(0.7)",
  "opacity(0.35)",
  "saturate(0.2)",
  "sepia(0.85)",
  "opacity(0.35) drop-shadow(rgb(220, 20, 60) 6px 4px 3px)",
  "drop-shadow(rgb(220, 20, 60) 6px 4px 3px) opacity(0.35)",
] as const;

const CARD_MARKUP = FILTERS.map((filter, i) =>
  `<div class="card c${i}" data-filter="${filter}"></div>`,
).join("");

const HTML = `<!doctype html><style>
  html,body{margin:0;width:${W}px;height:${H}px;background:rgb(245,247,251)}
  #grid{position:absolute;left:24px;top:24px;width:690px;display:grid;
    grid-template-columns:repeat(4,138px);gap:26px 32px}
  .card{position:relative;box-sizing:border-box;width:138px;height:82px;
    isolation:isolate;background:rgb(238,211,126);border:1px solid rgb(40,50,70)}
  .card::before{content:"";position:absolute;left:25px;top:17px;width:70px;height:38px;
    border-radius:8px;background:rgba(37,112,219,.62);filter:var(--f)}
  ${FILTERS.map((filter, i) => `.c${i}{--f:${filter}}`).join("\n")}
  .c3::before{left:18px;top:12px;width:64px;height:34px}
  .c10::before{transform:rotate(11deg);transform-origin:13px 9px}
  .c11{overflow:hidden}.c11::before{left:-8px;top:10px}
  #identity,#none{position:absolute;top:382px;width:52px;height:36px;background:white}
  #identity{left:24px}#none{left:92px}
  #identity::before,#none::before{content:"";position:absolute;inset:5px;background:#286fd6}
  #identity::before{filter:blur(0px)}#none::before{filter:none}
  #zoom{position:absolute;left:500px;top:300px;width:52px;height:36px;zoom:1.25;background:white}
  #zoom::before{content:"";position:absolute;inset:5px;background:rgba(40,111,214,.7);
    filter:blur(2px) saturate(1.4);transform:translate(3px,2px) rotate(7deg);transform-origin:6px 4px}
</style><main id="grid">${CARD_MARKUP}</main>
<div id="identity"></div><div id="none"></div><div id="zoom"></div>`;

const env = await (async () => {
  try { return { browser: await launchChromium() }; } catch { return null; }
})();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
const describeBrowser = env ? describe : describe.skip;

function pseudoRecords(nodes: CapturedElement[]): NonNullable<CapturedElement["pseudoFragments"]> {
  const result: NonNullable<CapturedElement["pseudoFragments"]> = [];
  const visit = (node: CapturedElement): void => {
    result.push(...(node.pseudoFragments ?? []));
    for (const child of node.children ?? []) visit(child);
  };
  for (const node of nodes) visit(node);
  return result;
}

function byAnimId(nodes: CapturedElement[], id: string): CapturedElement | null {
  for (const node of nodes) {
    if (node.animId === id) return node;
    const child = byAnimId(node.children ?? [], id);
    if (child != null) return child;
  }
  return null;
}

function stripPseudoFilters(nodes: CapturedElement[]): void {
  const visit = (node: CapturedElement): void => {
    for (const record of node.pseudoFragments ?? []) record.paint.filter = "none";
    for (const box of node.pseudoBoxes ?? []) delete box.filter;
    for (const image of node.pseudoImages ?? []) delete image.filter;
    for (const segment of node.textSegments ?? []) {
      if (segment.pseudoBox != null) delete segment.pseudoBox.filter;
    }
    for (const child of node.children ?? []) visit(child);
  };
  for (const node of nodes) visit(node);
}

async function meanAbsoluteError(a: Buffer, b: Buffer): Promise<number> {
  const [aa, bb] = await Promise.all([
    sharp(a).removeAlpha().raw().toBuffer(),
    sharp(b).removeAlpha().raw().toBuffer(),
  ]);
  expect(bb.length).toBe(aa.length);
  let sum = 0;
  for (let i = 0; i < aa.length; i++) sum += Math.abs(aa[i] - bb[i]);
  return sum / aa.length;
}

async function regionMeanAbsoluteError(
  a: Buffer,
  b: Buffer,
  dpr: number,
  rect: { x: number; y: number; width: number; height: number },
): Promise<number> {
  const extract = {
    left: Math.round(rect.x * dpr),
    top: Math.round(rect.y * dpr),
    width: Math.round(rect.width * dpr),
    height: Math.round(rect.height * dpr),
  };
  const [aa, bb] = await Promise.all([
    sharp(a).extract(extract).removeAlpha().raw().toBuffer(),
    sharp(b).extract(extract).removeAlpha().raw().toBuffer(),
  ]);
  let sum = 0;
  for (let i = 0; i < aa.length; i++) sum += Math.abs(aa[i] - bb[i]);
  return sum / aa.length;
}

function imageDocument(svg: string): string {
  return `<body style="margin:0"><img alt="rendered" style="display:block;width:${W}px;height:${H}px" src="data:image/svg+xml,${encodeURIComponent(svg)}"></body>`;
}

describeBrowser("DM-2367: pseudo-element CSS filter lists", () => {
  it("keeps the effect owner on generated text and replaced-image content", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 420, height: 180 }, deviceScaleFactor: 1 });
    const imageUrl = "data:image/svg+xml," + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="20"><rect width="28" height="20" fill="#2870db"/><circle cx="8" cy="8" r="5" fill="#f4cf55"/></svg>',
    );
    try {
      await page.setContent(`<style>html,body{margin:0}.host{position:absolute;top:30px;height:70px}
        #text{left:25px;width:150px;font:700 24px/40px Arial,sans-serif}
        #text::before{content:"PF";display:inline-block;padding:3px 7px;background:#2870db;color:white;
          filter:hue-rotate(31deg) drop-shadow(rgb(160,20,80) 3px 2px 1px);opacity:.7}
        #image{left:170px;width:120px;zoom:1.25}#image::after{content:url("${imageUrl}");display:inline-block;
          width:28px;height:20px;filter:blur(2px) invert(.65) saturate(1.8);
          transform:translate(2px,1px) scale(.85);transform-origin:4px 7px}
      </style><div id="text" class="host" data-domotion-anim="text">main</div>
      <div id="image" class="host" data-domotion-anim="image"></div>`, { waitUntil: "load" });
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 420, height: 180 });
      const text = byAnimId(tree, "text")!;
      const textPseudo = text.pseudoFragments?.find((record) => record.pseudo === "::before");
      expect(textPseudo?.paint.filter).toBe(
        await page.locator("#text").evaluate((el) => getComputedStyle(el, "::before").filter),
      );
      expect(textPseudo?.paint.opacity).toBeCloseTo(0.7, 4);

      const image = byAnimId(tree, "image")!.pseudoFragments?.find((record) => record.pseudo === "::after");
      const imageComputed = await page.locator("#image").evaluate((el) => {
        const style = getComputedStyle(el, "::after");
        return {
          filter: style.filter,
          transform: style.transform,
          transformOrigin: style.transformOrigin,
        };
      });
      // Computed pseudo paint properties stay in the pseudo's pre-zoom CSS
      // plane. The physical fragment below carries the host's effective zoom.
      expect(image?.paint).toMatchObject(imageComputed);
      expect(image?.fragments.find((fragment) => fragment.kind === "image")?.physicalRect)
        .toMatchObject({ width: 28 * 1.25 * 0.85, height: 20 * 1.25 * 0.85 });

      const svg = elementTreeToSvg(tree, 420, 180);
      expect(svg).toContain(`style="filter:${textPseudo!.paint.filter}"`);
      expect(svg).toContain(`style="filter:${image!.paint.filter}"`);
      expect(svg).toContain(`opacity="0.7" style="filter:${textPseudo!.paint.filter}"`);
      expect(svg).toMatch(/data-domotion-pseudo="::after"[^>]*style="filter:blur\(2px\) invert[^\"]*"><g transform="matrix\(/);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("captures every shorthand function and emits the computed lists verbatim", async () => {
    const page = await env!.browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      await page.setContent(HTML);
      const computed = await page.locator(".card").evaluateAll((cards) =>
        cards.map((card) => getComputedStyle(card, "::before").filter),
      );
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
      const captured = pseudoRecords(tree).map((record) => record.paint.filter);
      for (const filter of computed) expect(captured).toContain(filter);

      const svg = elementTreeToSvg(tree, W, H);
      for (const filter of computed) expect(svg).toContain(`style="filter:${filter}"`);
      expect(svg).not.toContain("<feGaussianBlur");
      expect(svg).not.toContain("<image");
      expect(svg).toContain('style="filter:blur(0px)"');
      expect(svg).not.toContain('style="filter:none"');

      const forward = computed[10];
      const reverse = computed[11];
      expect(forward).not.toBe(reverse);
      expect(svg.indexOf(`style="filter:${forward}"`)).toBeLessThan(
        svg.indexOf(`style="filter:${reverse}"`),
      );
      expect(svg).toMatch(/style="filter:opacity\(0\.35\) drop-shadow[^\"]*"><g transform="matrix\(/);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("beats a filter-stripped mutation across DPR while preserving zoom, transform, clipping, and moving-pixel regions", async () => {
    for (const dpr of [1, 2]) {
      const context = await env!.browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: dpr });
      const source = await context.newPage();
      const rendered = await context.newPage();
      try {
        await source.setContent(HTML);
        const expected = await source.screenshot({ type: "png" });
        const tree = await captureElementTree(source, "body", { x: 0, y: 0, width: W, height: H });
        const exactSvg = elementTreeToSvg(tree, W, H);
        await rendered.setContent(imageDocument(exactSvg), { waitUntil: "load" });
        const actual = await rendered.screenshot({ type: "png" });

        const mutation = structuredClone(tree);
        stripPseudoFilters(mutation);
        const mutationSvg = elementTreeToSvg(mutation, W, H);
        await rendered.setContent(imageDocument(mutationSvg), { waitUntil: "load" });
        const mutated = await rendered.screenshot({ type: "png" });

        const exactError = await meanAbsoluteError(expected, actual);
        const mutationError = await meanAbsoluteError(expected, mutated);
        expect(exactError, `DPR ${dpr} exact MAE`).toBeLessThan(2.2);
        expect(exactError, `DPR ${dpr} mutation discriminator`).toBeLessThan(mutationError * 0.35);

        const focused = [
          { name: "drop-shadow output bounds", rect: { x: 534, y: 24, width: 138, height: 82 } },
          { name: "transform/filter nesting", rect: { x: 364, y: 240, width: 138, height: 82 } },
          { name: "overflow clip outside filter", rect: { x: 534, y: 240, width: 138, height: 82 } },
          { name: "effective zoom", rect: { x: 616, y: 366, width: 90, height: 65 } },
        ];
        for (const control of focused) {
          const focusedExact = await regionMeanAbsoluteError(expected, actual, dpr, control.rect);
          const focusedMutation = await regionMeanAbsoluteError(expected, mutated, dpr, control.rect);
          expect(focusedExact, `DPR ${dpr} ${control.name} MAE`).toBeLessThan(3);
          expect(focusedExact, `DPR ${dpr} ${control.name} mutation`).toBeLessThan(focusedMutation * 0.5);
        }
      } finally {
        await context.close();
      }
    }
  }, 120_000);
});
