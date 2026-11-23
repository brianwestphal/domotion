import { chromium } from "@playwright/test";
import { expect, it, vi } from "vitest";
import { captureElementTree } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { invertLiveTextRect, type LiveTextInverse } from "../src/capture/live-text-inverse.js";
import { prepareTextPaintGeometry } from "../src/capture/text-paint-geometry-cdp.js";
import { capturedElement, capturedSegment } from "../src/test-support/captured-fixtures.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

it("joins direct horizontal Range and protocol geometry without neutralizing an authored scale", async () => {
  const browser = await chromium.launch();
  try {
    const viewport = { x: 0, y: 0, width: 320, height: 160 };
    const page = await browser.newPage({ viewport });
    await page.setContent(`<style>
      #owner{position:absolute;left:20.5px;top:20.25px;width:196px;height:32px;font:17px Arial;transform-origin:6.5px 8.25px;
      animation:sample 2s -1s linear both paused}
      @keyframes sample{from{transform:matrix(1.25,0,0,1.125,2.125,-2.25)}to{transform:matrix(1.75,0,0,1.375,4.125,-6.25)}}
    </style><div id="owner">A</div>`);
    await page.evaluate(() => document.fonts.ready);
    const readSource = () =>
      page.evaluate(() => {
        const owner = document.getElementById("owner")!;
        return {
          style: owner.getAttribute("style"),
          matrix: getComputedStyle(owner).transform,
          animations: owner.getAnimations().map(({ currentTime, playState, playbackRate }) => ({
            currentTime,
            playState,
            playbackRate,
          })),
        };
      });
    const before = await readSource();
    expect(before.matrix).toBe("matrix(1.5, 0, 0, 1.25, 3.125, -4.25)");
    const captureLegacy = vi.fn(async () => ({ tree: [] }));
    const captureReadOnly = vi.fn(async (key: string) => {
      const { inverse, box, text } = await page.evaluate((key) => {
        const state = (globalThis as Record<string, unknown>)[key] as { liveTextInverse: LiveTextInverse };
        const owner = document.getElementById("owner")!;
        const range = document.createRange();
        range.selectNodeContents(owner);
        const rect = range.getBoundingClientRect();
        return {
          inverse: state.liveTextInverse,
          box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          text: owner.textContent!,
        };
      }, key);
      const local = invertLiveTextRect(box, inverse)!;
      const owner = capturedElement({
        x: 20.5,
        y: 20.25,
        width: 196,
        height: 32,
        children: [],
        text,
        textSegments: [
          capturedSegment({
            ...local,
            text,
            fontAscent: 14,
            xOffsets: [0],
            xAdvances: [local.width],
            sourceMapping: {
              source: "dom-text-utf16-v1",
              sourceTextNodeIndex: 0,
              domText: text,
              domUtf16Span: [0, 1],
              role: "ordinary",
              renderedChunks: [{ renderedUtf16Span: [0, 1], domUtf16Span: [0, 1] }],
            },
          }),
        ],
      });
      return { tree: [Object.assign(owner, { _textPaintSourceKey: "f0:0" })] };
    });
    const probe = await prepareTextPaintGeometry(page, "#owner", viewport, captureLegacy, captureReadOnly);
    try {
      expect(captureReadOnly).toHaveBeenCalledOnce();
      expect(captureLegacy).not.toHaveBeenCalled();
      expect(await probe.verifyLiveTextFrame?.()).toBe(true);
      expect(await readSource()).toEqual(before);
      const facts = await page.evaluate(
        (key) =>
          ((globalThis as Record<string, unknown>)[key] as { factsByElement: Record<string, unknown> }).factsByElement[
            "0"
          ],
        probe.key,
      );
      expect(facts).toMatchObject({
        geometry: {
          source: "blink-text-fragment-affine-v2",
          fragments: [{ paintMatrix: [1.5, 0, 0, 1.25, -10.375, -11.375] }],
        },
      });
      await page.locator("#owner").evaluate((owner) => {
        owner.textContent = "B";
      });
      expect(await probe.verifyLiveTextFrame?.()).toBe(false);
    } finally {
      await probe.dispose();
    }
    await page.locator("#owner").evaluate((owner) => {
      owner.textContent = "A";
    });
    const captureDriftingFrame = async (key: string) => {
      const local = await captureReadOnly(key);
      await page.locator("#owner").evaluate((owner) => {
        owner.firstChild!.nodeValue = "B";
      });
      return local;
    };
    const stale = await prepareTextPaintGeometry(page, "#owner", viewport, captureLegacy, captureDriftingFrame);
    try {
      expect(captureReadOnly).toHaveBeenCalledTimes(2);
      expect(captureLegacy).toHaveBeenCalledOnce();
      expect(stale.verifyLiveTextFrame).toBeUndefined();
      expect(
        await page.evaluate(
          (key) =>
            ((globalThis as Record<string, unknown>)[key] as { liveTextInverse?: LiveTextInverse }).liveTextInverse,
          stale.key,
        ),
      ).toBeUndefined();
    } finally {
      await stale.dispose();
    }
  } finally {
    await closeBrowserSafely(browser);
  }
});

it("captures a direct authored text fragment through the live box wrapper", async () => {
  const browser = await chromium.launch();
  try {
    const viewport = { x: 0, y: 0, width: 320, height: 160 };
    const page = await browser.newPage({ viewport });
    await page.setContent(`<style>
      body{margin:0}
      .text{position:absolute;left:20.5px;top:20.25px;width:196px;height:32px;font:17px Arial;color:black}
      #owner{transform-origin:6.5px 8.25px;animation:sample 2s -1s linear both paused}
      @keyframes sample{from{transform:matrix(1.25,0,0,1.125,2.125,-2.25)}to{transform:matrix(1.75,0,0,1.375,4.125,-6.25)}}
    </style><div class="text" id="owner">A quick world</div>`);
    await page.evaluate(() => {
      const owner = document.getElementById("owner")!;
      const evidence = document.documentElement.dataset;
      evidence.testOwnerOverrides = "0";
      window.KeyframeEffect = new Proxy(window.KeyframeEffect, {
        construct(constructor, args, newTarget) {
          const effect = Reflect.construct(constructor, args, newTarget) as KeyframeEffect;
          if (effect.target === owner) evidence.testOwnerOverrides = String(Number(evidence.testOwnerOverrides) + 1);
          return effect;
        },
      });
    });
    const evidence = async () =>
      page.evaluate(() => {
        const owner = document.getElementById("owner")!;
        return {
          overrides: document.documentElement.dataset.testOwnerOverrides,
          matrix: getComputedStyle(owner).transform,
          sourceStyle: owner.getAttribute("style"),
          animations: owner.getAnimations().map(({ currentTime, playState, playbackRate }) => ({
            currentTime,
            playState,
            playbackRate,
          })),
        };
      });
    const before = await evidence();
    const tree = await captureElementTree(page, "body", viewport);
    expect(await evidence()).toEqual(before);
    const [owner] = tree;
    expect([owner.x, owner.y, owner.width, owner.height]).toEqual([20.5, 20.25, 196, 32]);
    expect(owner.styles.transform).toBe("matrix(1.5, 0, 0, 1.25, 3.625, -4.5)");
    expect(owner.textPaintGeometry).toMatchObject({
      source: "blink-text-fragment-affine-v2",
      neutral: { x: 20.5, y: 20.25, text: "A quick world" },
      fragments: [{ domUtf16Span: [0, 13], paintMatrix: [1.5, 0, 0, 1.25, -10.375, -11.375] }],
    });
    const svg = elementTreeToSvg(tree, 320, 160);
    expect(svg).toContain("matrix(1.5");
    expect(svg).toContain("A quick world");

    const finalFailure = new Error("final capture execution failed");
    const evaluate = page.evaluate.bind(page);
    let finalExecutions = 0;
    const failFinal = vi.spyOn(page, "evaluate").mockImplementation(async (source, input) => {
      if (
        typeof source === "string" &&
        source.includes('"textPaintGeometryKey":') &&
        !source.includes('"textPaintProbe":true')
      ) {
        finalExecutions++;
        if (finalExecutions === 1) throw finalFailure;
      }
      return evaluate(source, input);
    });
    try {
      await expect(captureElementTree(page, "body", viewport)).rejects.toThrow(finalFailure.message);
      expect(finalExecutions).toBe(1);
      expect(await evidence()).toEqual(before);
    } finally {
      failFinal.mockRestore();
    }
  } finally {
    await closeBrowserSafely(browser);
  }
});
