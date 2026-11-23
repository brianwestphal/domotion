import { chromium, type Page } from "@playwright/test";
import { expect, it, vi } from "vitest";
import { captureElementTree } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { invertLiveTextRect, type LiveTextInverse } from "../src/capture/live-text-inverse.js";
import { prepareTextPaintGeometry } from "../src/capture/text-paint-geometry-cdp.js";
import { capturedElement, capturedSegment } from "../src/test-support/captured-fixtures.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

async function waitForAuthoredPause(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const owner = document.getElementById("owner")!;
    void getComputedStyle(owner).transform;
    await Promise.all(owner.getAnimations().map((animation) => animation.ready));
  });
}

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
    await waitForAuthoredPause(page);
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

it.each([
  {
    mode: "one wrapped node",
    width: 72,
    content: "A quick world with several short words",
    spans: [
      [0, 7],
      [8, 13],
      [14, 18],
      [19, 26],
      [27, 32],
      [33, 38],
    ],
    rowIndices: [0, 0, 0, 0, 0, 0],
  },
  {
    mode: "adjacent nodes on one line",
    width: 196,
    content: "A quick<!-- a separating comment --> world",
    spans: [
      [0, 7],
      [0, 6],
    ],
    rowIndices: [0, 1],
  },
  {
    mode: "adjacent wrapped nodes",
    width: 72,
    content: "A quick world<!-- a separating comment --> with several short words",
    checkLaterRowDrift: true,
    spans: [
      [0, 7],
      [8, 13],
      [1, 5],
      [6, 13],
      [14, 19],
      [20, 25],
    ],
    rowIndices: [0, 0, 1, 1, 1, 1],
  },
])("uses one live wrapper for $mode", async ({ width, content, spans, rowIndices, checkLaterRowDrift }) => {
  const browser = await chromium.launch();
  try {
    const viewport = { x: 0, y: 0, width: 320, height: 200 };
    const page = await browser.newPage({ viewport });
    await page.setContent(`<!doctype html><style>
      body{margin:0}
      #owner{position:absolute;left:20.5px;top:20.25px;width:${width}px;height:136px;font:17px/18.375px Arial;
        padding:.25px .375px;transform-origin:6.5px 8.25px;animation:sample 2s -1s linear both paused}
      @keyframes sample{from{transform:matrix(1.25,0,0,1.125,2.125,-2.25)}to{transform:matrix(1.75,0,0,1.375,4.125,-6.25)}}
    </style><div id="owner">${content}</div>`);
    await waitForAuthoredPause(page);
    await page.evaluate(() => {
      const owner = document.getElementById("owner")!;
      const data = document.documentElement.dataset;
      data.testOwnerOverrides = "0";
      data.testOwnerStyleMutations = "0";
      window.KeyframeEffect = new Proxy(window.KeyframeEffect, {
        construct(constructor, args, newTarget) {
          const effect = Reflect.construct(constructor, args, newTarget) as KeyframeEffect;
          if (effect.target === owner) data.testOwnerOverrides = String(Number(data.testOwnerOverrides) + 1);
          return effect;
        },
      });
      new MutationObserver((records) => {
        data.testOwnerStyleMutations = String(Number(data.testOwnerStyleMutations) + records.length);
      }).observe(owner, { attributes: true, attributeFilter: ["style"] });
    });
    const sourceState = () =>
      page.evaluate(() => {
        const owner = document.getElementById("owner")!;
        const data = document.documentElement.dataset;
        return {
          matrix: getComputedStyle(owner).transform,
          style: owner.getAttribute("style"),
          animations: owner.getAnimations().map(({ currentTime, playState, pending, playbackRate }) => ({
            currentTime,
            playState,
            pending,
            playbackRate,
          })),
          counts: [data.testOwnerOverrides, data.testOwnerStyleMutations],
        };
      });
    const before = await sourceState();
    expect(before.counts).toEqual(["0", "0"]);
    const tree = await captureElementTree(page, "body", viewport);
    expect(await sourceState()).toEqual(before);
    const [owner] = tree;
    expect([owner.x, owner.y, owner.width, owner.height]).toEqual([20.5, 20.25, width + 0.75, 136.5]);
    expect(owner.styles.transform).toBe("matrix(1.5, 0, 0, 1.25, 3.625, -4.5)");
    const fragments = owner.textPaintGeometry!.fragments;
    expect(fragments.map(({ domUtf16Span }) => domUtf16Span)).toEqual(spans);
    expect(fragments.map(({ sourceTextNodeIndex }) => sourceTextNodeIndex)).toEqual(rowIndices);
    const expectedMatrix = [1.5, 0, 0, 1.25, -10.375, -11.375];
    for (const { paintMatrix } of fragments) {
      paintMatrix.forEach((coefficient, index) => expect(coefficient).toBeCloseTo(expectedMatrix[index], 12));
    }
    const svg = elementTreeToSvg(tree, 320, 200);
    expect(svg.match(/matrix\(1\.5/g)).toHaveLength(1);
    expect(svg).toContain("quick");
    expect(svg).toContain("world");

    if (checkLaterRowDrift) {
      const evaluate = page.evaluate.bind(page);
      let finalExecutions = 0;
      const deferSecondRowChange = vi.spyOn(page, "evaluate").mockImplementation(async (source, input) => {
        const result = await evaluate(source, input);
        if (
          typeof source === "string" &&
          source.includes('"textPaintGeometryKey":') &&
          !source.includes('"textPaintProbe":true') &&
          ++finalExecutions === 1
        ) {
          await evaluate(() => {
            document.getElementById("owner")!.lastChild!.nodeValue = " with new words";
          });
        }
        return result;
      });
      try {
        const [drifted] = await captureElementTree(page, "body", viewport);
        expect(finalExecutions).toBe(2);
        expect(drifted.styles.transform).toBe("none");
        expect(drifted.text).toContain("with new words");
        expect(await sourceState()).toMatchObject({
          matrix: before.matrix,
          style: before.style,
          animations: before.animations,
        });
      } finally {
        deferSecondRowChange.mockRestore();
      }
    }
  } finally {
    await closeBrowserSafely(browser);
  }
});

it.each([
  {
    mode: "styled first line",
    css: "#owner::first-line{text-transform:uppercase}",
    content: "A quick world with several short words",
  },
  {
    mode: "static inline child",
    css: "",
    content: 'A quick <span style="color:green">world with several short words</span>',
  },
])("keeps the existing live text capture for a $mode", async ({ css, content }) => {
  const browser = await chromium.launch();
  try {
    const viewport = { x: 0, y: 0, width: 320, height: 200 };
    const page = await browser.newPage({ viewport });
    await page.setContent(`<!doctype html><style>
      #owner{position:absolute;left:20.5px;top:20.25px;width:72px;font:17px Arial;animation:sample 2s -1s linear both paused}
      @keyframes sample{from{transform:scale(1.25)}to{transform:scale(1.75)}}
      ${css}
    </style><div id="owner">${content}</div>`);
    await waitForAuthoredPause(page);
    const [owner] = await captureElementTree(page, "body", viewport);
    expect(owner.styles.transform).toBe("none");
  } finally {
    await closeBrowserSafely(browser);
  }
});
