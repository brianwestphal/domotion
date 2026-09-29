import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { captureElementTree, launchChromium } from "../src/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

/**
 * A replaced-element snapshot must contain only the target's own pixels. A NON-ANCESTOR positioned
 * `::after` that covers the canvas and states `visibility: visible` itself is the case a
 * hide-every-element stylesheet misses (`visibility` is inherited, but an explicit value on the pseudo
 * is not), so `SNAPSHOT_HIDE_CSS` names `*::before, *::after`. The visual fixture of the same name
 * cannot gate this on its own — a leak moves its raw diff from 0 to ~1.4% yet stays under the lenient
 * pass threshold — so this asserts on the snapshot PNG's pixels directly.
 */
async function setup() {
  try {
    return { browser: await launchChromium() };
  } catch {
    return null;
  }
}
const env = await setup();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env ? describe : describe.skip;

const OVERLAY_RED = [220, 38, 38] as const;

function walk(nodes: CapturedElement[]): CapturedElement[] {
  return nodes.flatMap((node) => [node, ...walk(node.children ?? [])]);
}

async function snapshotPixels(
  dataUri: string,
): Promise<{ data: Buffer; width: number; height: number; channels: number }> {
  const bytes = Buffer.from(dataUri.replace(/^data:image\/png;base64,/, ""), "base64");
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

describeBrowser("replaced-element snapshot isolation: non-ancestor pseudo overlays", () => {
  const html = (overlay: string): string => `<!doctype html><style>
    body { margin: 0 }
    .box { position: relative; width: 200px; height: 100px; margin: 20px }
    canvas { position: absolute; left: 0; top: 0; z-index: 1; display: block }
    .ov { position: absolute; left: 0; top: 0; width: 200px; height: 100px; z-index: 10; visibility: visible }
    ${overlay}
  </style><div class="box"><canvas id="c" width="200" height="100"></canvas><div class="ov"></div></div>
  <script>const c=document.getElementById('c').getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,200,100);c.fillStyle='#000';c.fillRect(20,20,30,30);</script>`;

  it("leaves the pseudo out of the canvas snapshot even when it declares visibility: visible", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 260, height: 160 } });
    try {
      await page.setContent(
        html(
          `.ov::after { content: ""; position: absolute; left: 60px; top: 30px; width: 80px; height: 40px;
            background: rgba(${OVERLAY_RED.join(",")}, .7); visibility: visible }`,
        ),
      );
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 260, height: 160 });
      const canvas = walk(tree).find((node) => node.tag === "canvas")!;
      const uri = canvas.replacedSnapshot?.dataUri;
      expect(uri, "canvas snapshot was not captured").toBeDefined();
      const { data, width, height, channels } = await snapshotPixels(uri!);
      const scaleX = width / 200;
      const scaleY = height / 100;
      const at = (x: number, y: number): [number, number, number] => {
        const o = (Math.floor(y * scaleY) * width + Math.floor(x * scaleX)) * channels;
        return [data[o], data[o + 1], data[o + 2]];
      };
      // Under the overlay box (60..140 x 30..70), away from the black square: the canvas's own white.
      expect(at(100, 50)).toEqual([255, 255, 255]);
      expect(at(70, 40)).toEqual([255, 255, 255]);
      // The canvas's own ink survives (isolation must not blank the target).
      expect(at(35, 35)).toEqual([0, 0, 0]);
      // And no pixel anywhere carries the overlay's red.
      let red = 0;
      for (let i = 0; i < data.length; i += channels) {
        if (data[i] > 150 && data[i + 1] < 120 && data[i + 2] < 120) red++;
      }
      expect(red).toBe(0);
    } finally {
      await page.close();
    }
  });

  it("also isolates a ::before pseudo and an author !important visibility on the pseudo", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 260, height: 160 } });
    try {
      await page.setContent(
        html(
          `.ov::before { content: ""; position: absolute; left: 60px; top: 30px; width: 80px; height: 40px;
            background: rgb(${OVERLAY_RED.join(",")}); visibility: visible !important }`,
        ),
      );
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 260, height: 160 });
      const uri = walk(tree).find((node) => node.tag === "canvas")!.replacedSnapshot?.dataUri;
      expect(uri).toBeDefined();
      const { data, width, channels } = await snapshotPixels(uri!);
      const o = (Math.floor(50 * (width / 200)) * width + Math.floor(100 * (width / 200))) * channels;
      expect([data[o], data[o + 1], data[o + 2]]).toEqual([255, 255, 255]);
    } finally {
      await page.close();
    }
  });

  it("also isolates a non-ancestor ELEMENT whose class rule forces visibility: visible !important", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 260, height: 160 } });
    try {
      await page.setContent(
        `<!doctype html><style>
          body { margin: 0 }
          .box { position: relative; width: 200px; height: 100px; margin: 20px }
          canvas { position: absolute; left: 0; top: 0; z-index: 1; display: block }
          .veil { position: absolute; left: 60px; top: 30px; width: 80px; height: 40px; z-index: 10;
                  background: rgb(220, 38, 38); visibility: visible !important }
          body.page { background: rgb(0, 128, 0) !important }
        </style>
        <body class="page"><div class="box"><canvas id="c" width="200" height="100"></canvas><div class="veil"></div></div>
        <script>const c=document.getElementById('c').getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,200,100);</script></body>`,
      );
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 260, height: 160 });
      const uri = walk(tree).find((node) => node.tag === "canvas")!.replacedSnapshot?.dataUri;
      expect(uri).toBeDefined();
      const { data, width, channels } = await snapshotPixels(uri!);
      const scale = width / 200;
      const o = (Math.floor(50 * scale) * width + Math.floor(100 * scale)) * channels;
      // Neither the veil's red nor the page's !important green background is in the canvas snapshot.
      expect([data[o], data[o + 1], data[o + 2]]).toEqual([255, 255, 255]);
    } finally {
      await page.close();
    }
  });
});
