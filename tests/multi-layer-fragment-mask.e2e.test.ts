import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { captureElementTreeWithWarnings, elementTreeToSvg, launchChromium } from "../src/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const WIDTH = 520;
const HEIGHT = 330;

function escapedSrcdoc(source: string): string {
  return source.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

const INNER = `<!doctype html><style>
  html,body{margin:0;width:220px;height:180px;background:white}
  svg{position:absolute;width:0;height:0;overflow:hidden}
  .slot{position:absolute;width:80px;height:60px}
  .case{width:40px;height:30px;zoom:2;background:rgb(17,17,17);
    mask-image:url(#a),url(#b);mask-mode:alpha,match-source;
    mask-size:3px 4px,7px 9px;mask-position:83% 71%,13px 17px;
    mask-repeat:space round,no-repeat;mask-origin:content-box,border-box;
    mask-clip:content-box,padding-box}
  #add{left:10px;top:10px}.add{mask-composite:add}
  #intersect{left:110px;top:10px}.intersect{mask-composite:intersect}
  #subtract{left:10px;top:90px}.subtract{mask-composite:subtract}
  #exclude{left:110px;top:90px}.exclude{mask-image:url(#a),url(#b),url(#c);
    mask-mode:alpha,match-source,alpha;mask-composite:exclude,intersect,add}
</style><svg><defs>
  <mask id="a" maskUnits="objectBoundingBox" maskContentUnits="objectBoundingBox" x="0" y="0" width="1" height="1" style="mask-type:luminance"><rect x=".375" width=".625" height="1" fill="black"/></mask>
  <mask id="b" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="0" y="0" width="30" height="30" style="mask-type:alpha"><rect width="30" height="30" fill="white"/></mask>
  <mask id="c" maskUnits="objectBoundingBox" maskContentUnits="objectBoundingBox" x="0" y="0" width="1" height="1" style="mask-type:alpha"><rect width="1" height=".5" fill="white"/></mask>
</defs></svg>
<div id="add" class="slot"><div class="case add"></div></div>
<div id="intersect" class="slot"><div class="case intersect"></div></div>
<div id="subtract" class="slot"><div class="case subtract"></div></div>
<div id="exclude" class="slot"><div class="case exclude"></div></div>`;

function sourceHtml(): string {
  return `<!doctype html><style>
    html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;background:white}
    svg{position:absolute;width:0;height:0;overflow:hidden}
    iframe{position:absolute;left:20px;top:20px;width:220px;height:180px;border:0}
    .outer{position:absolute;left:400px;width:80px;height:60px;background:rgb(17,17,17);
      mask-image:url(#a),url(#b);mask-mode:alpha,match-source;
      mask-size:3px 4px,7px 9px;mask-position:83% 71%,13px 17px;
      mask-repeat:space round,no-repeat;mask-origin:content-box,border-box;
      mask-clip:content-box,padding-box}
    #outer-add{top:10px;mask-composite:add}
    #outer-intersect{top:90px;mask-composite:intersect}
    #outer-subtract{top:170px;mask-composite:subtract}
    #outer-exclude{top:250px;mask-image:url(#a),url(#b),url(#c);
      mask-mode:alpha,match-source,alpha;mask-composite:exclude,intersect,add}
  </style><svg><defs>
    <mask id="a" maskUnits="objectBoundingBox" maskContentUnits="objectBoundingBox" x="0" y="0" width="1" height="1" style="mask-type:luminance"><rect width=".625" height="1" fill="black"/></mask>
    <mask id="b" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="20" y="0" width="60" height="60" style="mask-type:alpha"><rect x="20" width="60" height="60" fill="white"/></mask>
    <mask id="c" maskUnits="objectBoundingBox" maskContentUnits="objectBoundingBox" x="0" y="0" width="1" height="1" style="mask-type:alpha"><rect y=".5" width="1" height=".5" fill="white"/></mask>
  </defs></svg>
  <iframe srcdoc="${escapedSrcdoc(INNER)}"></iframe>
  <div id="outer-add" class="outer"></div><div id="outer-intersect" class="outer"></div>
  <div id="outer-subtract" class="outer"></div><div id="outer-exclude" class="outer"></div>`;
}

function flatten(nodes: CapturedElement[]): CapturedElement[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

function consumers(nodes: CapturedElement[]): CapturedElement[] {
  return flatten(nodes).filter((node) => (node.maskFragmentReferences?.length ?? 0) > 0);
}

async function rgbaBytes(png: Buffer): Promise<Buffer> {
  return (await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })).data;
}

async function changedChannels(a: Buffer, b: Buffer): Promise<number> {
  const [aa, bb] = await Promise.all([rgbaBytes(a), rgbaBytes(b)]);
  expect(bb.length).toBe(aa.length);
  let changed = 0;
  for (let index = 0; index < aa.length; index++) if (aa[index] !== bb[index]) changed++;
  return changed;
}

async function render(page: import("@playwright/test").Page, tree: CapturedElement[]): Promise<Buffer> {
  const svg = elementTreeToSvg(tree, WIDTH, HEIGHT);
  await page.setContent(`<body style="margin:0;background:white">${svg}</body>`, { waitUntil: "load" });
  return page.screenshot({ clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
}

const env = { browser: await launchChromium() };
afterAll(async () => closeBrowserSafely(env.browser), 15_000);

describe("multi-layer same-document SVG mask fragments (DM-2520)", () => {
  for (const dpr of [1, 2]) {
    it(`keeps ordered TreeScope, units, modes, operators, and zoom exact at DPR ${dpr}`, async () => {
      const context = await env.browser.newContext({
        viewport: { width: WIDTH, height: HEIGHT },
        deviceScaleFactor: dpr,
      });
      const source = await context.newPage();
      const rendered = await context.newPage();
      try {
        await source.setContent(sourceHtml(), { waitUntil: "load" });
        await source.waitForFunction(() => document.querySelector("iframe")?.contentDocument?.querySelectorAll(".case").length === 4);
        const expected = await source.screenshot({ clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
        const capture = await captureElementTreeWithWarnings(source, "body", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
        expect(capture.warnings.filter((warning) => /did not resolve to an inline/.test(warning.detail))).toEqual([]);

        const masked = consumers(capture.tree);
        expect(masked).toHaveLength(8);
        expect(masked.every((node) => node.maskFragmentReferences
          ?.every((reference, index) => reference.layerIndex === index && reference.id === ["a", "b", "c"][index]))).toBe(true);
        expect(masked.filter((node) => node.maskFragmentReferences?.length === 3)).toHaveLength(2);
        expect(masked.every((node) => new Set(node.maskFragmentReferences?.map((reference) => reference.scope)).size === 1)).toBe(true);
        expect(new Set(masked.flatMap((node) => node.maskFragmentReferences?.map((reference) => reference.scope) ?? [])).size).toBe(2);
        expect(masked.filter((node) => node.fragmentReferenceZoom === 2)).toHaveLength(4);

        const root = capture.tree[0];
        expect((root.maskDefs ?? []).filter((definition) => definition.id === "a")).toHaveLength(2);
        expect((root.maskDefs ?? []).filter((definition) => definition.id === "b")).toHaveLength(2);
        expect((root.maskDefs ?? []).filter((definition) => definition.id === "c")).toHaveLength(2);
        expect((root.maskDefs ?? []).find((definition) => definition.id === "a")?.maskContentUnits).toBe("objectBoundingBox");
        expect((root.maskDefs ?? []).filter((definition) => definition.id === "b").map((definition) => definition.userSpaceRegion))
          .toEqual(expect.arrayContaining([{ x: 20, y: 0, width: 60, height: 60 }, { x: 0, y: 0, width: 30, height: 30 }]));

        const actual = await render(rendered, capture.tree);
        expect(await changedChannels(expected, actual)).toBe(0);

        if (dpr === 1) {
          const innerScope = masked.find((node) => node.fragmentReferenceZoom === 2)!.maskFragmentReferences![0].scope;
          const outerScope = masked.find((node) => node.fragmentReferenceZoom === 1)!.maskFragmentReferences![0].scope;

          const wrongScope = structuredClone(capture.tree);
          for (const node of consumers(wrongScope).filter((candidate) => candidate.fragmentReferenceZoom === 2)) {
            for (const reference of node.maskFragmentReferences!) reference.scope = outerScope;
          }
          expect(innerScope).not.toBe(outerScope);
          expect(await changedChannels(expected, await render(rendered, wrongScope))).toBeGreaterThan(0);

          const wrongComposite = structuredClone(capture.tree);
          for (const node of consumers(wrongComposite)) node.styles.maskComposite = "add, add";
          expect(await changedChannels(expected, await render(rendered, wrongComposite))).toBeGreaterThan(0);

          const wrongMode = structuredClone(capture.tree);
          for (const node of consumers(wrongMode)) node.styles.maskMode = "match-source, match-source";
          expect(await changedChannels(expected, await render(rendered, wrongMode))).toBeGreaterThan(0);

          const wrongZoom = structuredClone(capture.tree);
          for (const node of consumers(wrongZoom).filter((candidate) => candidate.fragmentReferenceZoom === 2)) {
            node.fragmentReferenceZoom = 1;
          }
          expect(await changedChannels(expected, await render(rendered, wrongZoom))).toBeGreaterThan(0);
        }
      } finally {
        await context.close();
      }
    }, 90_000);
  }
});
