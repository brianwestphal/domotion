import type { Browser, Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { withRenderTextMode } from "../src/render/font-resolution.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { screenshotAfterPresentedFrame } from "../src/test-support/presented-frame-screenshot.js";

const viewport = { x: 0, y: 0, width: 260, height: 1680 };
const red = "rgb(195, 0, 0)";
const cases = [
  { id: "block", before: "<div>aa</div>", late: true },
  { id: "nested", before: "<div><div>aa</div></div>", late: true },
  { id: "empty", before: "<div></div>", late: true },
  { id: "grid", before: '<div style="display:grid">aa</div>', late: true },
  { id: "color", before: "<div>aa</div>", late: true },
  { id: "direct", before: "", late: false },
  { id: "float", before: '<div style="float:left">aa</div>', late: false },
  { id: "absolute", before: '<div style="position:absolute;right:0">aa</div>', late: false },
  { id: "hidden", before: '<div style="display:none">aa</div>', late: false },
  { id: "inline", before: "<span>aa</span>", late: false },
  { id: "contents", before: '<span style="display:contents">aa</span>', late: false },
  { id: "closed", before: '<div slot="later">aa</div>', late: false },
] as const;

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

const flat = (tree: CapturedElement[]): CapturedElement[] => tree.flatMap((node) => [node, ...flat(node.children)]);
const pixels = async (page: Page) =>
  sharp(await screenshotAfterPresentedFrame(page))
    .ensureAlpha()
    .raw()
    .toBuffer();

async function nativeLines(page: Page) {
  return page.locator("article").evaluateAll((owners) =>
    owners.map((owner) => {
      const text = Array.from(owner.childNodes).find((node): node is Text => node.nodeType === Node.TEXT_NODE)!;
      const range = document.createRange();
      range.selectNodeContents(text);
      const { x, y, width, height } = range.getBoundingClientRect();
      const baseline = owner.querySelector(":scope > .baseline")!.getBoundingClientRect().top;
      return {
        x,
        y,
        width,
        height,
        baseline,
        leadingY: owner.firstElementChild?.getBoundingClientRect().top,
        assignedSlot: text.assignedSlot?.name ?? null,
      };
    }),
  );
}

async function nativeInlineText(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const { nodes } = await cdp.send("Accessibility.getFullAXTree");
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const text = new Map<string, string>();
    const pending = [root];
    while (pending.length) {
      const node = pending.pop()!;
      pending.push(...(node.children ?? []));
      if (node.localName !== "article") continue;
      const id = node.attributes?.[node.attributes.indexOf("id") + 1];
      const member = node.children?.find((candidate) => candidate.nodeType === 3 && candidate.nodeValue === "hg");
      if (id == null || member == null) continue;
      const owner = nodes.find(
        (node) => node.backendDOMNodeId === member.backendNodeId && node.role?.value === "StaticText",
      );
      const inline = (owner?.childIds ?? [])
        .map((key) => byId.get(key))
        .filter((node) => node?.role?.value === "InlineTextBox")
        .map((node) => node?.name?.value)
        .join("");
      text.set(id, inline);
    }
    return text;
  } finally {
    await cdp.detach();
  }
}

it("preserves body styling after an ordinary leading block and the first-line styling of real first rows", async () => {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  const generated = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  try {
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      body { margin:0 }
      article { position:relative; font-size:32px; line-height:72px }
      article::first-line { font-size:64px; color:${red}; text-transform:uppercase }
      #color::first-line { font-size:32px; text-transform:none }
      .baseline { display:inline-block; width:0; height:0; vertical-align:baseline }
    </style>${cases.map(({ id, before }) => `<article id="${id}" lang="ja">${before}hg<span class="baseline"></span></article>`).join("")}`);
    await page.locator("#closed").evaluate((host) => {
      host.attachShadow({ mode: "closed" }).innerHTML = '<slot></slot><div><slot name="later"></slot></div>';
    });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const source = await nativeLines(page);
    const paintedText = await nativeInlineText(page);
    const original = await pixels(page);
    const before = await page.content();
    const tree = await captureElementTree(page, "body", viewport);
    expect(await nativeLines(page)).toEqual(source);
    expect(await page.content()).toBe(before);
    expect((await pixels(page)).equals(original)).toBe(true);

    const owners = flat(tree).filter((node) => node.tag === "article");
    expect(owners).toHaveLength(cases.length);
    for (const [index, { id, late }] of cases.entries()) {
      const owner = owners[index];
      const [direct] = owner.textSegments!;
      const { x, y, width, height, baseline, leadingY, assignedSlot } = source[index];
      const witness = JSON.stringify({ id, native: source[index], captured: direct });
      expect([direct.x, direct.y, direct.width, direct.height], witness).toEqual([x, y, width, height]);
      expect(paintedText.get(id), witness).toBe(late ? "hg" : "HG");
      expect(direct.text, witness).toBe(late ? "hg" : "HG");
      expect(direct.fontSize, witness).toBe(late ? undefined : 64);
      expect(direct.color, witness).toBe(late ? undefined : red);
      if (late || id === "direct") expect(direct.y + (direct.fontAscent ?? owner.fontAscent!), witness).toBe(baseline);
      if (id === "block" || id === "nested") {
        const [neutral] = owner.textPaintGeometry?.neutral?.textSegments ?? [];
        expect(neutral?.text, witness).toBe("hg");
        expect(neutral?.fontSize, witness).toBeUndefined();
        expect(neutral?.color, witness).toBeUndefined();
        expect(leadingY!, witness).toBeLessThan(y);
        const earlier = flat(owner.children).find((child) =>
          child.textSegments?.some((segment) => segment.text === "AA"),
        );
        expect(earlier?.textSegments?.[0].fontSize, witness).toBe(64);
        expect(earlier?.textSegments?.[0].color, witness).toBe(red);
      }
      if (id === "closed") {
        expect(assignedSlot, witness).toBeNull();
        expect(leadingY!, witness).toBeGreaterThan(y);
      }
    }

    if (process.platform === "darwin") {
      const svg = withRenderTextMode("embedded-font", () => elementTreeToSvg(tree, viewport.width, viewport.height));
      await generated.setContent(`<body style="margin:0">${svg}`);
      await generated.evaluate(() => document.fonts.ready.then(() => undefined));
      const rendered = await pixels(generated);
      for (const [index, { id, late }] of cases.entries()) {
        if (!late) continue;
        const { y, height } = source[index];
        const start = Math.floor(y) * viewport.width * 4;
        const end = Math.ceil(y + height) * viewport.width * 4;
        expect(rendered.subarray(start, end).equals(original.subarray(start, end)), id).toBe(true);
      }
    }
  } finally {
    await generated.close();
    await page.close();
  }
}, 30_000);
