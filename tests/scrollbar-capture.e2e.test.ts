import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { captureElementTreeWithWarnings, launchChromium } from "../src/capture/index.js";
import { prepareFrameScrollCapture } from "../src/capture/frame-scroll-state.js";
import type { ControlPseudoKind, ResolvedPseudoStyleCapture } from "../src/capture/pseudo-style-cdp.js";
import { prepareCapturedScrollbarSets } from "../src/capture/scrollbar-capture.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import type { CapturedElement } from "../src/capture/types.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { screenshotAfterPresentedFrame } from "../src/test-support/presented-frame-screenshot.js";

const env = await (async () => {
  try {
    return { browser: await launchChromium({ headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] }) };
  } catch {
    return null;
  }
})();
afterAll(async () => {
  await closeBrowserSafely(env?.browser);
}, 15_000);
const describeBrowser = env == null ? describe.skip : describe;

function byAnimId(nodes: CapturedElement[], id: string): CapturedElement | null {
  for (const node of nodes) {
    if (node.animId === id) return node;
    const child = byAnimId(node.children ?? [], id);
    if (child != null) return child;
  }
  return null;
}

function rgbaDifference(
  a: Uint8Array,
  b: Uint8Array,
): {
  changedPixels: number;
  maxChannelDelta: number;
  firstChangedByte: number | null;
} {
  expect(a.length).toBe(b.length);
  let changedPixels = 0;
  let maxChannelDelta = 0;
  let firstChangedByte: number | null = null;
  for (let offset = 0; offset < a.length; offset += 4) {
    let changed = false;
    for (let channel = 0; channel < 4; channel++) {
      const delta = Math.abs(a[offset + channel]! - b[offset + channel]!);
      if (delta === 0) continue;
      changed = true;
      maxChannelDelta = Math.max(maxChannelDelta, delta);
      if (firstChangedByte == null) firstChangedByte = offset + channel;
    }
    if (changed) changedPixels++;
  }
  return { changedPixels, maxChannelDelta, firstChangedByte };
}

/** The native fixture uses a blue thumb and warm or neutral backing pixels. */
async function nativeThumbCenter(png: Buffer, box: { x: number; y: number; width: number; height: number }) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width;
  let top = info.height;
  let right = -1;
  let bottom = -1;
  for (let y = Math.ceil(box.y); y < Math.floor(box.y + box.height); y++) {
    for (let x = Math.ceil(box.x); x < Math.floor(box.x + box.width); x++) {
      const offset = (y * info.width + x) * info.channels;
      const red = data[offset]!;
      const green = data[offset + 1]!;
      const blue = data[offset + 2]!;
      if (blue < red + 45 || blue < green + 30) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  return right < left ? null : { x: (left + right + 1) / 2, y: (top + bottom + 1) / 2 };
}

const CUSTOM_CSS = `
  .scrollbox{width:180px;height:120px;overflow:scroll;border:3px solid #111}
  .scrollbox::-webkit-scrollbar{width:16px;height:14px;background:#aaa}
  .scrollbox::-webkit-scrollbar-track{background:rgb(201,31,32)}
  .scrollbox::-webkit-scrollbar-thumb{background:rgb(33,61,203);border:2px solid rgb(201,31,32)}
  .scrollbox::-webkit-scrollbar-corner{background:rgb(25,155,71)}
  .scrollbox::-webkit-scrollbar-button{display:none}
`;

describeBrowser("DM-2481: authoritative Blink scrollbar capture", () => {
  it("clears tagged frames after discovery fails and can prepare again", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 240, height: 180 } });
    try {
      await page.setContent(`<!doctype html><style>
        #target{width:120px;height:80px;overflow:auto;scrollbar-width:none}
        #target>i{display:block;width:280px;height:220px}
      </style><div id="target"><i></i></div>`);
      const frame = page.mainFrame();
      const originalEvaluate = frame.evaluate.bind(frame);
      Object.defineProperty(frame, "evaluate", {
        configurable: true,
        value: async (expression: unknown, argument?: unknown) => {
          if (typeof expression === "string" && expression.includes("storedNodes.push")) {
            throw new Error("injected discovery failure");
          }
          return originalEvaluate(expression as string, argument);
        },
      });
      const options: Pick<ResolvedPseudoStyleCapture, "propertyKey" | "stylesByHost" | "dynamicScrollbarKinds"> = {
        propertyKey: "",
        stylesByHost: {},
        dynamicScrollbarKinds: new Set<ControlPseudoKind>(),
      };
      let failed: Awaited<ReturnType<typeof prepareCapturedScrollbarSets>>;
      try {
        failed = await prepareCapturedScrollbarSets(page, "body", { x: 0, y: 0, width: 240, height: 180 }, options);
      } finally {
        Reflect.deleteProperty(frame, "evaluate");
      }
      expect(failed.warnings.some(({ detail }) => detail.includes("injected discovery failure"))).toBe(true);
      expect(
        await page.evaluate(() =>
          Object.keys(globalThis).filter(
            (key) =>
              key.startsWith("__domotionCapturedScrollbarNodes_") ||
              key.startsWith("__domotionCapturedScrollbarMarker_"),
          ),
        ),
      ).toEqual([]);
      const prepared = await prepareCapturedScrollbarSets(
        page,
        "body",
        { x: 0, y: 0, width: 240, height: 180 },
        options,
      );
      try {
        expect(prepared.warnings.some(({ detail }) => detail.includes("discovery failed"))).toBe(false);
      } finally {
        await prepared.dispose();
      }
    } finally {
      await page.close();
    }
  });

  it("keeps source-run discovery independent of authored __name frame globals", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 240, height: 180 } });
    try {
      await page.setContent(`<!doctype html><style>
        html,body{margin:0}
        #target{width:120px;height:80px;overflow:auto;scrollbar-width:none}
        #target>i{display:block;width:280px;height:220px}
        iframe{width:120px;height:80px;border:0}
      </style><div id="target"><i></i></div><iframe></iframe>`);
      const child = page.frames().find((frame) => frame !== page.mainFrame())!;
      await child.setContent(`<!doctype html><style>
        html,body{margin:0}
        #target{width:100px;height:70px;overflow:auto;scrollbar-width:none}
        #target>i{display:block;width:240px;height:190px}
      </style><div id="target"><i></i></div>`);
      await page.evaluate(
        "Object.defineProperty(globalThis, '__name', { value: 'authored-sentinel', configurable: true })",
      );
      await child.evaluate(
        "Object.defineProperty(globalThis, '__name', { value: 'child-sentinel', configurable: true })",
      );
      const frameScrollCapture = await prepareFrameScrollCapture(page, undefined);
      const prepared = await prepareCapturedScrollbarSets(
        page,
        "body",
        { x: 0, y: 0, width: 240, height: 180 },
        { propertyKey: "", stylesByHost: {}, dynamicScrollbarKinds: new Set() },
        { frameScrollCapture },
      );
      try {
        const topFacts = await page.locator("#target").evaluate(
          (element, propertyKey) => ({
            authoredName: (globalThis as typeof globalThis & { __name?: unknown }).__name,
            status: (element as (HTMLElement | SVGElement) & Record<string, { status?: string }>)[propertyKey]?.status,
          }),
          prepared.propertyKey,
        );
        const childFacts = await child.locator("#target").evaluate(
          (element, propertyKey) => ({
            authoredName: (globalThis as typeof globalThis & { __name?: unknown }).__name,
            status: (element as (HTMLElement | SVGElement) & Record<string, { status?: string }>)[propertyKey]?.status,
          }),
          prepared.propertyKey,
        );
        expect(topFacts).toEqual({ authoredName: "authored-sentinel", status: "absent" });
        expect(childFacts).toEqual({ authoredName: "child-sentinel", status: "absent" });
      } finally {
        await prepared.dispose();
        await frameScrollCapture.dispose();
      }
      expect(await page.evaluate("globalThis.__name")).toBe("authored-sentinel");
      expect(await child.evaluate("globalThis.__name")).toBe("child-sentinel");
      const registryKeys = () =>
        Object.keys(globalThis).filter(
          (key) =>
            key.startsWith("__domotionCapturedScrollbarNodes_") || key.startsWith("__domotionCapturedScrollbarMarker_"),
        );
      expect(await page.evaluate(registryKeys)).toEqual([]);
      expect(await child.evaluate(registryKeys)).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it("embeds exact same-frame platform-native strip pixels without resampling", async () => {
    const context = await env!.browser.newContext({ viewport: { width: 400, height: 260 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const scratch = await mkdtemp(join(tmpdir(), "domotion-native-scrollbar-"));
    try {
      await page.setContent(`<!doctype html><style>
        html,body{margin:0;overflow:hidden}
        #native{margin:20.25px;width:200px;height:140px;overflow:scroll;resize:both;
          scrollbar-color:rgb(20,40,160) rgb(230,220,200);scrollbar-width:auto;
          background:rgb(255,238,221);border:3px solid rgb(17,34,51)}
        #native>div{width:600px;height:500px;background:linear-gradient(#efe,#fee)}
        #sentinel{position:absolute;left:300px;top:30px;width:22px;height:19px;background:rgb(7,201,91)}
        #none{overflow:scroll;scrollbar-width:none;width:30px;height:30px}
        #visible{overflow:visible;width:30px;height:30px}
        #auto-empty{overflow:auto;width:30px;height:30px}
      </style>
      <div id="native" data-domotion-anim="native"><div></div></div>
      <div id="sentinel"></div>
      <div id="none" data-domotion-anim="none"><div style="width:90px;height:90px"></div></div>
      <div id="visible" data-domotion-anim="visible"><div style="width:90px;height:90px"></div></div>
      <div id="auto-empty" data-domotion-anim="auto-empty"></div>`);
      const nativeBox = (await page.locator("#native").boundingBox())!;
      await page.locator("#native").evaluate((element) => {
        element.scrollTop = 100;
        element.scrollLeft = 70;
      });
      // Keep the platform overlay animator in its hovered state while the
      // capture prepasses run; programmatic offsets avoid inertial-scroll drift.
      await page.mouse.move(nativeBox.x + nativeBox.width - 2, nativeBox.y + 50);
      await page.waitForTimeout(250);
      const sourcePath = join(scratch, "source.png");
      await writeFile(sourcePath, await page.screenshot({ type: "png" }));

      const capture = await captureElementTreeWithWarnings(
        page,
        "body",
        { x: 0, y: 0, width: 400, height: 260 },
        { rasterizeFromImagePath: sourcePath },
      );
      const target = byAnimId(capture.tree, "native")!;
      const set = target.scrollbars!;
      expect(byAnimId(capture.tree, "none")?.scrollbars?.status).toBe("absent");
      expect(byAnimId(capture.tree, "visible")?.scrollbars).toBeUndefined();
      expect(byAnimId(capture.tree, "auto-empty")?.scrollbars?.status).toBe("absent");
      expect(capture.warnings.filter(({ feature }) => feature === "scrollbar-capture")).toEqual([]);

      // Headless Chromium on macOS may prove that the platform overlay is
      // fully faded even after hover. That is an authoritative absence, not a
      // failed capture; visible overlays continue through the exact-pixel
      // assertions below.
      if (set.status === "absent") {
        expect(set).toMatchObject({
          overlay: null,
          noInkReason: "overlay-source-frame-empty",
          missingFacts: [],
        });
        return;
      }
      expect(set).toMatchObject({
        status: "captured",
        captureDpr: 2,
        outputTransform: { space: "capture-viewport", matrix: [1, 0, 0, 1, 0, 0] },
        missingFacts: [],
      });
      expect(typeof set.overlay).toBe("boolean");
      expect(set.paintPhase).toBe(set.overlay ? "overlay-overflow-controls" : "background");
      const source = await sharp(sourcePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const capturedBars = [set.horizontal, set.vertical].filter((bar) => bar != null);
      expect(capturedBars.length).toBeGreaterThan(0);
      for (const bar of capturedBars) {
        const raster = bar?.nativeRaster;
        expect(raster).toMatchObject({
          captureDpr: 2,
          precomposited: true,
          opacitySource: "precomposited-source-frame",
          interaction: { hostHovered: true, hostPressed: false },
          platformFingerprint: { hideScrollbarsDefaultRemoved: true },
        });
        expect(raster?.dataUri).toMatch(/^data:image\/png;base64,/);
        expect(raster?.pixelWidth).toBe(Math.round((raster?.width ?? 0) * 2));
        expect(raster?.pixelHeight).toBe(Math.round((raster?.height ?? 0) * 2));
        const encoded = Buffer.from(raster!.dataUri!.split(",")[1]!, "base64");
        const crop = await sharp(encoded).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const left = Math.round(raster!.x * 2);
        const top = Math.round(raster!.y * 2);
        const expected = Buffer.alloc(crop.info.width * crop.info.height * 4);
        for (let y = 0; y < crop.info.height; y++) {
          const start = ((top + y) * source.info.width + left) * 4;
          expected.set(source.data.subarray(start, start + crop.info.width * 4), y * crop.info.width * 4);
        }
        expect(Buffer.compare(crop.data, expected)).toBe(0);
      }

      const svg = elementTreeToSvg(capture.tree, 400, 260);
      expect(svg.indexOf("native-horizontal")).toBeLessThan(svg.indexOf("native-vertical"));
      expect(svg).toContain('data-domotion-scrollbar-route="native-raster"');
      expect(svg).toContain("rgb(7,201,91)");
      expect(svg).not.toContain('fill="rgba(0,0,0,0.40)"');

      const outputPage = await context.newPage();
      try {
        await outputPage.setContent(`<style>html,body{margin:0}</style>${svg}`);
        const output = await sharp(await outputPage.screenshot({ type: "png" }))
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        for (const bar of [set.horizontal, set.vertical]) {
          const raster = bar!.nativeRaster!;
          const left = Math.round(raster.x * 2);
          const top = Math.round(raster.y * 2);
          const resizer = set.resizerOverlap?.rect;
          const laterOwnedRects: Array<{ x: number; y: number; width: number; height: number }> =
            bar!.orientation === "horizontal"
              ? [set.vertical?.nativeRaster, set.nativeCornerRaster].flatMap((owner) => (owner == null ? [] : [owner]))
              : [set.nativeCornerRaster].flatMap((owner) => (owner == null ? [] : [owner]));
          for (let y = 0; y < raster.pixelHeight; y++) {
            const sourceStart = ((top + y) * source.info.width + left) * 4;
            const outputStart = ((top + y) * output.info.width + left) * 4;
            const sourceRow = Buffer.from(source.data.subarray(sourceStart, sourceStart + raster.pixelWidth * 4));
            const outputRow = Buffer.from(output.data.subarray(outputStart, outputStart + raster.pixelWidth * 4));
            // The renderer follows ScrollableAreaPainter order: horizontal,
            // vertical, corner, then resizer. The encoded strip itself was
            // required byte-exact above. In the composed surface, compare only
            // pixels that still belong to this strip after later native owners
            // have painted their overlapping rectangles.
            const absoluteY = top + y;
            for (const owner of laterOwnedRects) {
              const ownerLeft = Math.floor(owner.x * 2);
              const ownerTop = Math.floor(owner.y * 2);
              const ownerRight = Math.ceil((owner.x + owner.width) * 2);
              const ownerBottom = Math.ceil((owner.y + owner.height) * 2);
              if (absoluteY < ownerTop || absoluteY >= ownerBottom) continue;
              for (
                let absoluteX = Math.max(left, ownerLeft);
                absoluteX < Math.min(left + raster.pixelWidth, ownerRight);
                absoluteX++
              ) {
                const offset = (absoluteX - left) * 4;
                sourceRow.copy(outputRow, offset, offset, offset + 4);
              }
            }
            if (resizer != null) {
              // ScrollableAreaPainter deliberately paints the resizer after
              // both native strips and the corner. The strip's encoded crop is
              // still byte-exact above; exclude only those later-owned device
              // pixels when checking the composed SVG surface.
              // The later-owned vector resizer antialiases one device pixel
              // beyond its mathematical rect. Exclude that coverage fringe;
              // the encoded strip itself was already required byte-exact
              // above, so this does not relax native-raster fidelity.
              const resizerLeft = Math.floor(resizer.x * 2) - 1;
              const resizerTop = Math.floor(resizer.y * 2) - 1;
              const resizerRight = Math.ceil((resizer.x + resizer.width) * 2) + 1;
              const resizerBottom = Math.ceil((resizer.y + resizer.height) * 2) + 1;
              if (absoluteY >= resizerTop && absoluteY < resizerBottom) {
                for (
                  let absoluteX = Math.max(left, resizerLeft);
                  absoluteX < Math.min(left + raster.pixelWidth, resizerRight);
                  absoluteX++
                ) {
                  const offset = (absoluteX - left) * 4;
                  sourceRow.copy(outputRow, offset, offset, offset + 4);
                }
              }
            }
            expect(
              rgbaDifference(sourceRow, outputRow),
              `${bar!.orientation} row ${y}; raster=${JSON.stringify(raster)}; resizer=${JSON.stringify(resizer)}`,
            ).toEqual({
              changedPixels: 0,
              maxChannelDelta: 0,
              firstChangedByte: null,
            });
          }
        }
      } finally {
        await outputPage.close();
      }
    } finally {
      await context.close();
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "author-custom scrollbars", transform: "translate(10.5px, 10px)", axis: null },
    { name: "author-custom scrollbars", transform: "scale(1.2)", axis: null },
    { name: "native-raster horizontal scrollbar", transform: "scale(1.2)", axis: "horizontal" },
    { name: "native-raster vertical scrollbar", transform: "scale(1.2)", axis: "vertical" },
  ] as const)("paints viewport-owned $name once beneath $transform", async ({ transform, axis }) => {
    const viewport = { width: 330, height: 250 };
    const page = await env!.browser.newPage({ viewport, deviceScaleFactor: 1 });
    const scratch = await mkdtemp(join(tmpdir(), "domotion-transformed-scrollbar-"));
    try {
      const horizontal = axis === "horizontal";
      const route = axis == null ? "author-custom" : "native-raster";
      await page.setContent(`<!doctype html><style>
        html,body{margin:0;width:100%;height:100%;background:white}
        #wrap{position:absolute;left:63px;top:51px;transform-origin:top left;transform:${transform}}
        ${CUSTOM_CSS}
        #owner{width:180px;height:120px;overflow:${axis == null ? "scroll" : horizontal ? "auto hidden" : "hidden auto"}}
        .native{scrollbar-color:rgb(20,40,160) rgb(230,220,200);background:#ffeedd;border:3px solid #333}
        #owner>div{width:${axis === "vertical" ? "100%" : "500px"};height:${horizontal ? "100%" : "500px"}}
        .native>div{background:#efe}
      </style><div id="wrap"><div id="owner" class="${axis == null ? "scrollbox" : "native"}" data-domotion-anim="owner"><div></div></div></div>`);
      const owner = page.locator("#owner");
      await owner.evaluate((element, axis) => {
        element.scrollTop = axis === "horizontal" ? 0 : 90;
        element.scrollLeft = axis === "vertical" ? 0 : 140;
      }, axis);
      const box = (await owner.boundingBox())!;
      let source: Buffer;
      let sourceThumb: Awaited<ReturnType<typeof nativeThumbCenter>> = null;
      if (axis == null) {
        await page.mouse.move(box.x + box.width - 2, box.y + 50);
        await page.waitForTimeout(250);
        source = await page.screenshot();
      } else {
        // Actual wheel input activates the one platform scrollbar for this
        // host. Use its presented ink to hit the thumb inside the scaled
        // border, including when the platform paints a wider hovered strip.
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(horizontal ? 16 : 0, horizontal ? 0 : 16);
        const offsets = () =>
          owner.evaluate((element) => ({ horizontal: element.scrollLeft, vertical: element.scrollTop }));
        await expect.poll(async () => (await offsets())[axis]).toBeGreaterThan(horizontal ? 140 : 90);
        expect((await offsets())[horizontal ? "vertical" : "horizontal"]).toBe(0);
        const observed = { center: null as Awaited<ReturnType<typeof nativeThumbCenter>> };
        await expect
          .poll(async () => {
            observed.center = await nativeThumbCenter(await screenshotAfterPresentedFrame(page), box);
            return observed.center;
          })
          .not.toBeNull();
        const center = observed.center!;
        await page.mouse.move(center.x, center.y);
        source = await screenshotAfterPresentedFrame(page);
        sourceThumb = await nativeThumbCenter(source, box);
        expect(sourceThumb, `${axis} thumb is painted in the supplied frame`).not.toBeNull();
      }
      const path = join(scratch, "source.png");
      await writeFile(path, source);
      const capture = await captureElementTreeWithWarnings(
        page,
        "body",
        { x: 0, y: 0, ...viewport },
        {
          rasterizeFromImagePath: path,
        },
      );
      const set = byAnimId(capture.tree, "owner")!.scrollbars!;
      expect(
        [set.horizontal?.route, set.vertical?.route],
        `scrollbar paints ${set.status} with ${set.noInkReason ?? set.missingFacts.join(", ")}`,
      ).toEqual([axis === "vertical" ? undefined : route, horizontal ? undefined : route]);
      expect(set.outputTransform).toEqual({ space: "capture-viewport", matrix: [1, 0, 0, 1, 0, 0] });
      const svg = elementTreeToSvg(capture.tree, viewport.width, viewport.height);
      await page.setContent(`<style>html,body{margin:0}</style>${svg}`);
      const matrix = await page.evaluate(() => {
        const group = document.querySelector<SVGGraphicsElement>("[data-domotion-scrollbar-route]")!;
        const { a, b, c, d, e, f } = group.getScreenCTM()!;
        return [a, b, c, d, e, f];
      });
      for (const [i, entry] of matrix.entries()) expect(entry).toBeCloseTo(set.outputTransform.matrix[i]!, 5);
      const output = await (axis == null ? page.screenshot() : screenshotAfterPresentedFrame(page));
      if (axis == null) {
        const bars = [set.horizontal!, set.vertical!];
        const tracks = bars.map((bar) => bar.parts.find(({ kind }) => kind === "track")?.rect);
        expect(tracks.every((rect) => rect != null)).toBe(true);
        const probes = [
          { rect: tracks[0]!, u: 0.05, v: 0.5, rgb: [201, 31, 32] },
          { rect: tracks[1]!, u: 0.5, v: 0.05, rgb: [201, 31, 32] },
          ...bars.map((bar) => ({
            rect: bar.parts.find((part) => part.kind === "thumb")!.rect,
            u: 0.5,
            v: 0.5,
            rgb: [33, 61, 203],
          })),
          { rect: set.corner!.rect, u: 0.5, v: 0.5, rgb: [25, 155, 71] },
        ];
        // Probe each track just inside its start. The edge pixel itself blends
        // with the border when Chromium lays out a fractional device origin.
        for (const png of [source, output]) {
          const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
          for (const { rect, u, v, rgb } of probes) {
            const x = Math.floor(rect.x + rect.width * u),
              y = Math.floor(rect.y + rect.height * v);
            const offset = (y * info.width + x) * info.channels;
            expect([...data.subarray(offset, offset + 3)], `pixel at ${x},${y}`).toEqual(rgb);
          }
        }
      } else {
        // This source has no resizer. Compare the whole embedded crop and the
        // final strip with the same source frame.
        expect(set.status).toBe("captured");
        expect(set.missingFacts).toEqual([]);
        const raster = set[axis]!.nativeRaster!;
        expect(raster.dataUri).toMatch(/^data:image\/png;base64,/);
        const rect = { left: raster.x, top: raster.y, width: raster.pixelWidth, height: raster.pixelHeight };
        expect(sourceThumb!.x).toBeGreaterThanOrEqual(rect.left);
        expect(sourceThumb!.x).toBeLessThan(rect.left + rect.width);
        expect(sourceThumb!.y).toBeGreaterThanOrEqual(rect.top);
        expect(sourceThumb!.y).toBeLessThan(rect.top + rect.height);
        const image = await sharp(source).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        // The projected layout gutter can end one pixel inside the themed
        // paint. Check the complete authored-color track, including its end.
        let uncoveredTrackPixels = 0;
        for (let y = Math.ceil(box.y); y < Math.floor(box.y + box.height); y++) {
          for (let x = Math.ceil(box.x); x < Math.floor(box.x + box.width); x++) {
            const offset = (y * image.info.width + x) * 3;
            const { data } = image;
            if (data[offset] !== 230 || data[offset + 1] !== 220 || data[offset + 2] !== 200) continue;
            const inside = x >= rect.left && x < rect.left + rect.width && y >= rect.top && y < rect.top + rect.height;
            if (!inside) uncoveredTrackPixels++;
          }
        }
        expect(uncoveredTrackPixels, `${axis} track pixels outside the native crop`).toBe(0);
        const expected = await sharp(source).extract(rect).ensureAlpha().raw().toBuffer();
        const embedded = Buffer.from(raster.dataUri!.split(",")[1]!, "base64");
        expect(
          rgbaDifference(expected, await sharp(embedded).ensureAlpha().raw().toBuffer()),
          `${axis} embedded crop`,
        ).toEqual({ changedPixels: 0, maxChannelDelta: 0, firstChangedByte: null });
        expect(
          rgbaDifference(expected, await sharp(output).extract(rect).ensureAlpha().raw().toBuffer()),
          `${axis} final SVG crop`,
        ).toEqual({ changedPixels: 0, maxChannelDelta: 0, firstChangedByte: null });
      }
    } finally {
      await page.close();
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("selects the author route when customization exists only on a part pseudo", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 360, height: 240 } });
    try {
      await page.setContent(`<!doctype html><style>
        html,body{margin:0}
        #part-only{margin:20px;width:180px;height:120px;overflow:scroll}
        #part-only::-webkit-scrollbar-thumb{background:rgb(33,61,203)}
        #part-only>div{width:500px;height:500px}
      </style><div id="part-only" data-domotion-anim="part-only"><div></div></div>`);
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 360, height: 240 });
      const set = byAnimId(capture.tree, "part-only")!.scrollbars!;
      expect([set.horizontal?.route, set.vertical?.route]).toContain("author-custom");
      const thumb = set.vertical?.parts.find(({ kind }) => kind === "thumb");
      expect(thumb?.finalPseudoStyle?.backgroundColor).toBe("rgb(33, 61, 203)");
      expect(
        await page.evaluate(() =>
          Object.keys(globalThis).filter(
            (key) =>
              key.startsWith("__domotionCapturedScrollbarNodes_") ||
              key.startsWith("__domotionCapturedScrollbarMarker_"),
          ),
        ),
      ).toEqual([]);
      const repeated = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 360, height: 240 });
      expect(byAnimId(repeated.tree, "part-only")!.scrollbars?.vertical?.route).toBe("author-custom");
      expect(await page.locator("#part-only").getAttribute("style")).toBeNull();
    } finally {
      await page.close();
    }
  });

  it("keeps anonymous state-dependent paint as an owner-only part crop", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 360, height: 240 } });
    try {
      await page.setContent(`<!doctype html><style>
        html,body{margin:0}
        #dynamic{margin:20px;width:180px;height:120px;overflow:scroll}
        #dynamic::-webkit-scrollbar{width:16px;height:14px;background:rgb(201,31,32)}
        #dynamic::-webkit-scrollbar-track{background:rgb(201,31,32)}
        #dynamic::-webkit-scrollbar-thumb{background:rgb(33,61,203)!important}
        #dynamic::-webkit-scrollbar-thumb:vertical{background:rgb(171,42,199)!important}
        #dynamic::-webkit-scrollbar-button{display:none}
        #dynamic>div{width:500px;height:500px}
      </style><div id="dynamic" data-domotion-anim="dynamic"><div></div></div>`);
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 360, height: 240 });
      const target = byAnimId(capture.tree, "dynamic")!;
      const verticalThumb = target.scrollbars?.vertical?.parts.find(({ kind }) => kind === "thumb");
      const horizontalThumb = target.scrollbars?.horizontal?.parts.find(({ kind }) => kind === "thumb");
      expect(verticalThumb?.raster).toMatchObject({
        provenance: "dynamic-author-part",
        captureDpr: 1,
      });
      expect(verticalThumb?.raster?.dataUri).toMatch(/^data:image\/png;base64,/);
      // Detection is deliberately conservative at pseudo-kind granularity:
      // stable CDP cannot prove which anonymous orientation instance won, so
      // both thumb owners stay source pixels instead of replaying selectors.
      expect(horizontalThumb?.raster?.provenance).toBe("dynamic-author-part");
      const svg = elementTreeToSvg(capture.tree, 360, 240);
      expect(svg).toContain('data-domotion-scrollbar-part="track"');
      expect(svg).toContain('data-domotion-scrollbar-part="thumb"');
      expect(svg).toContain("data:image/png;base64,");
      expect(svg).not.toContain("dynamic-scrollbar-pseudo-cascade");
    } finally {
      await page.close();
    }
  });

  it("rasterizes an unsupported effect only inside the author part owner", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 360, height: 240 } });
    try {
      await page.setContent(`<!doctype html><style>
        html,body{margin:0}
        #filtered{margin:20px;width:180px;height:120px;overflow:scroll}
        #filtered::-webkit-scrollbar{width:16px;height:14px;background:rgb(201,31,32)}
        #filtered::-webkit-scrollbar-track{background:rgb(201,31,32)}
        #filtered::-webkit-scrollbar-thumb{background:rgb(33,61,203);filter:blur(1px)}
        #filtered::-webkit-scrollbar-button{display:none}
        #filtered>div{width:500px;height:500px}
      </style><div id="filtered" data-domotion-anim="filtered"><div></div></div>`);
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 360, height: 240 });
      const target = byAnimId(capture.tree, "filtered")!;
      const thumb = target.scrollbars?.vertical?.parts.find(({ kind }) => kind === "thumb");
      const track = target.scrollbars?.vertical?.parts.find(({ kind }) => kind === "track");
      expect(thumb?.raster).toMatchObject({ provenance: "unsupported-author-part" });
      expect(thumb?.raster?.dataUri).toMatch(/^data:image\/png;base64,/);
      expect(track?.raster).toBeUndefined();
      const svg = elementTreeToSvg(capture.tree, 360, 240);
      const thumbGroup = svg.slice(svg.indexOf('data-domotion-scrollbar-part="thumb"'));
      expect(thumbGroup).toContain("<image");
      expect(svg).toContain('data-domotion-scrollbar-part="track"');
    } finally {
      await page.close();
    }
  });

  it("captures custom frame/part geometry, ranges, corner, logical side, and final unqualified winners", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 700, height: 330 } });
    try {
      await page.setContent(`<!doctype html><style>
        html,body{margin:0}${CUSTOM_CSS}
        .scrollbox{position:absolute;top:20px}
        #ltr{left:20px}
        #rtl{left:250px;direction:rtl}
        #none{left:480px;scrollbar-width:none}
      </style>
      <div id="ltr" class="scrollbox" data-domotion-anim="ltr"><div style="width:500px;height:500px"></div></div>
      <div id="rtl" class="scrollbox" data-domotion-anim="rtl"><div style="width:500px;height:500px"></div></div>
      <div id="none" class="scrollbox" data-domotion-anim="none"><div style="width:500px;height:500px"></div></div>`);
      await page.locator("#ltr").evaluate((element) => {
        element.scrollTop = 120;
        element.scrollLeft = 80;
      });
      await page.locator("#rtl").evaluate((element) => {
        element.scrollTop = 90;
        element.scrollLeft = -70;
      });
      await page.locator("#none").evaluate((element) => {
        element.scrollTop = 60;
        element.scrollLeft = 50;
      });

      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 700, height: 330 });
      const ltr = byAnimId(capture.tree, "ltr")!;
      const rtl = byAnimId(capture.tree, "rtl")!;
      const none = byAnimId(capture.tree, "none")!;

      expect(ltr.scrollbars).toMatchObject({
        status: "captured",
        source: "blink-live-marker-probe-v1",
        overlay: false,
        paintPhase: "background",
        captureDpr: 1,
        effectiveZoom: 1,
        horizontal: {
          route: "author-custom",
          logicalSide: "bottom",
          currentPosition: 80,
          frameRect: { height: 14 },
        },
        vertical: {
          route: "author-custom",
          logicalSide: "right",
          currentPosition: 120,
          frameRect: { width: 16 },
        },
        corner: { kind: "corner", rect: { width: 16, height: 14 } },
      });
      expect(ltr.scrollbars?.vertical?.parts.find(({ kind }) => kind === "thumb")?.finalPseudoStyle).toMatchObject({
        backgroundColor: "rgb(33, 61, 203)",
        border: "2px solid rgb(201, 31, 32)",
      });
      expect(ltr.scrollbars?.horizontal?.parts.map(({ kind }) => kind)).toEqual([
        "background",
        "track",
        "back-track",
        "forward-track",
        "thumb",
      ]);
      expect(rtl.scrollbars?.vertical?.logicalSide).toBe("left");
      expect(rtl.scrollbars?.horizontal?.currentPosition).toBe(-70);
      expect(none.scrollbars).toMatchObject({ status: "absent", horizontal: undefined, vertical: undefined });

      const scrollbarWarnings = capture.warnings.filter(({ feature }) => feature === "scrollbar-capture");
      expect(scrollbarWarnings).toEqual([]);

      const svg = elementTreeToSvg(capture.tree, 700, 330);
      expect(svg).not.toContain('fill="rgba(0,0,0,0.40)"');
      expect(svg).toContain('data-domotion-scrollbar-route="author-custom"');
      expect(svg).toContain('data-domotion-scrollbar-part="thumb"');
    } finally {
      await page.close();
    }
  });

  it("normalizes device pixels once while retaining CSS zoom and capture DPR", async () => {
    const context = await env!.browser.newContext({ viewport: { width: 420, height: 280 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    try {
      await page.setContent(`<!doctype html><style>
        html,body{margin:0}${CUSTOM_CSS}
        #zoomed{margin:20px;zoom:1.25}
      </style><div id="zoomed" class="scrollbox" data-domotion-anim="zoomed"><div style="width:500px;height:500px"></div></div>`);
      await page.locator("#zoomed").evaluate((element) => {
        element.scrollTop = 100;
      });
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 420, height: 280 });
      const set = byAnimId(capture.tree, "zoomed")!.scrollbars!;
      expect(set.captureDpr).toBe(2);
      expect(set.effectiveZoom).toBeCloseTo(1.25, 5);
      expect(set.vertical?.frameRect.width).toBeCloseTo(20, 1);
      expect(Math.abs((set.horizontal?.frameRect.height ?? 0) - 17.5)).toBeLessThanOrEqual(0.5);
      expect(set.outputTransform).toEqual({ space: "capture-viewport", matrix: [1, 0, 0, 1, 0, 0] });
    } finally {
      await context.close();
    }
  });

  it("fails closed when a non-axis-aligned transform prevents source-axis correlation", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 520, height: 360 } });
    try {
      await page.setContent(`<!doctype html><style>
        html,body{margin:0}${CUSTOM_CSS}
        #rotated{margin:70px;transform:rotate(8deg);transform-origin:top left}
      </style><div id="rotated" class="scrollbox" data-domotion-anim="rotated"><div style="width:500px;height:500px"></div></div>`);
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 520, height: 360 });
      const set = byAnimId(capture.tree, "rotated")!.scrollbars!;
      expect(set).toMatchObject({ status: "unavailable", horizontal: undefined, vertical: undefined });
      expect(set.missingFacts).toContain("scrollbar-axis-under-non-axis-aligned-transform");
      expect(capture.warnings).toContainEqual(
        expect.objectContaining({
          selector: "div#rotated",
          feature: "scrollbar-capture",
        }),
      );
    } finally {
      await page.close();
    }
  });

  it("retains forced-colors and dark-scheme context when theme paint hides marker colors", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 420, height: 280 } });
    try {
      await page.emulateMedia({ colorScheme: "dark", forcedColors: "active" });
      await page.setContent(`<!doctype html><style>
        html,body{margin:0;background:Canvas;color-scheme:light dark}
        #forced{margin:20px;width:180px;height:120px;overflow:scroll}
        #forced>div{width:500px;height:500px}
      </style><div id="forced" data-domotion-anim="forced"><div></div></div>`);
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 420, height: 280 });
      const set = byAnimId(capture.tree, "forced")!.scrollbars!;
      expect(set.forcedColors).toBe(true);
      if (set.status === "absent") {
        // A fully faded platform overlay has no source-frame ink. This is a
        // proven negative, not the old marker-paint failure.
        expect(set.noInkReason).toBe("overlay-source-frame-empty");
      } else if (set.status === "unavailable") {
        // Forced-colors theme paint can suppress the marker probe entirely on
        // a runner whose native bars occupy layout space. That is an honest
        // unavailable observation, not proof of either a visible or faded
        // overlay; retain the context and the missing-fact explanation.
        expect(set.missingFacts).toEqual(expect.arrayContaining(["marker-paint", "scrollbar-object-existence"]));
      } else {
        expect(["captured", "partial"]).toContain(set.status);
        for (const bar of [set.horizontal, set.vertical]) {
          if (bar != null) expect(bar.usedColorScheme).toBe("dark");
        }
      }
    } finally {
      await page.close();
    }
  });

  it("retains viewport scrollbar ownership when the selected body root omits html", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 360, height: 240 } });
    try {
      await page.setContent(`<!doctype html><style>
        html,body{margin:0}
        html::-webkit-scrollbar{width:16px;height:14px;background:#aaa}
        html::-webkit-scrollbar-track{background:rgb(201,31,32)}
        html::-webkit-scrollbar-thumb{background:rgb(33,61,203)}
        html::-webkit-scrollbar-corner{background:rgb(25,155,71)}
        html::-webkit-scrollbar-button{display:none}
        main{width:700px;height:650px;background:#eee}
      </style><main></main>`);
      await page.evaluate(() => {
        window.scrollTo(80, 110);
      });
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 360, height: 240 });
      expect(capture.tree[0]?.rootScrollbars).toMatchObject({
        rootScroller: true,
        overlay: false,
        horizontal: { route: "author-custom", currentPosition: 80 },
        vertical: { route: "author-custom", currentPosition: 110 },
      });
      expect(
        await page.evaluate(() => ({
          computed: [
            getComputedStyle(document.documentElement).overflowX,
            getComputedStyle(document.documentElement).overflowY,
          ],
          inline: [document.documentElement.style.overflowX, document.documentElement.style.overflowY],
        })),
      ).toEqual({ computed: ["visible", "visible"], inline: ["", ""] });
    } finally {
      await page.close();
    }
  });

  it("leaves absent or literal root style attributes exactly as authored (DM-W4VADZ)", async () => {
    // Six contained spans overflow the 200x100 viewport, so the root scroller
    // takes the standard-color marker route, which writes inline scrollbar and
    // overflow properties on the root while it measures.
    const markup = (htmlStyle: string | null, bodyStyle: string | null) => {
      const attr = (value: string | null) => (value == null ? "" : ` style="${value}"`);
      return `<!doctype html><html${attr(htmlStyle)}><head><style>span{display:block;contain:layout;width:40px;height:20px}</style></head><body${attr(bodyStyle)}>${"<span></span>".repeat(6)}</body></html>`;
    };
    for (const [htmlStyle, bodyStyle] of [
      [null, null],
      ["--keep: a", "margin: 0px"],
    ] as const) {
      const page = await env!.browser.newPage({ viewport: { width: 200, height: 100 } });
      try {
        await page.setContent(markup(htmlStyle, bodyStyle));
        const attributes = () =>
          page.evaluate(() => [document.documentElement.getAttribute("style"), document.body.getAttribute("style")]);
        expect(await attributes()).toEqual([htmlStyle, bodyStyle]);
        await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 200, height: 100 });
        expect(await attributes()).toEqual([htmlStyle, bodyStyle]);
      } finally {
        await page.close();
      }
    }
  });
  it("records Playwright's hidden-scrollbar launch as an explicit unavailable negative", async () => {
    const hiddenBrowser = await launchChromium({ headless: true });
    const page = await hiddenBrowser.newPage({ viewport: { width: 360, height: 240 } });
    try {
      await page.setContent(`<!doctype html><style>html,body{margin:0}${CUSTOM_CSS}</style>
        <div id="hidden" class="scrollbox" data-domotion-anim="hidden"><div style="width:500px;height:500px"></div></div>`);
      await page.locator("#hidden").evaluate((element) => {
        element.scrollTop = 80;
      });
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 360, height: 240 });
      const set = byAnimId(capture.tree, "hidden")!.scrollbars!;
      expect(set.status).toBe("unavailable");
      expect(set.missingFacts).toEqual(expect.arrayContaining(["scrollbar-object-existence", "marker-paint"]));
      expect(capture.warnings).toContainEqual(
        expect.objectContaining({
          selector: "div#hidden",
          feature: "scrollbar-capture",
        }),
      );
    } finally {
      await page.close();
      await closeBrowserSafely(hiddenBrowser);
    }
  });
});
