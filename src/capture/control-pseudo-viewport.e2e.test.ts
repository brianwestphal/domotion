import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { captureResolvedControlPseudoStyles } from "./pseudo-style-cdp.js";
import * as pseudoStyles from "./pseudo-style-cdp.js";
import { captureElementTree } from "./index.js";
import type { CapturedElement } from "./types.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => browser?.close());

const viewport = { x: 0, y: 0, width: 640, height: 320 };

async function fixture(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
  await page.setContent(`<style>
    html,body{margin:0}body{height:5000px}
    input{position:absolute;left:20px;width:200px;height:30px}
    input[type=range]{appearance:none}
    input::-webkit-slider-runnable-track{height:6px;background:rgb(101,1,102)}
    .scroll{position:absolute;left:300px;width:100px;height:80px;overflow:auto;resize:both}
    .scroll::-webkit-scrollbar-thumb{background:rgb(10,20,30)}
    .scroll::-webkit-resizer{background:rgb(30,20,10)}
  </style>
  <input id="near" style="top:20px" value="Visible value">
  <input id="range" type="range" style="top:80px">
  <input id="far" style="top:4000px" value="Far value">
  <input id="fixed" style="position:fixed;top:110px" value="Fixed value">
  <input id="sticky" style="position:sticky;top:160px" value="Sticky value">
  <div data-domotion-anim="reel"><input id="animated" style="top:4300px" value="Animated value"></div>
  <div style="transform:translateX(1px)"><input id="transformed" style="top:4500px" value="Transformed value"></div>
  <div id="scrollNear" class="scroll" style="top:150px"><div style="width:300px;height:300px"></div></div>
  <div id="scrollFar" class="scroll" style="top:3000px"><div style="width:300px;height:300px"></div></div>
  <video id="mediaFar" controls style="position:absolute;top:3500px;width:200px;height:100px"></video>
  ${Array.from({ length: 48 }, (_, i) => `<input type="range" style="top:${1000 + i * 40}px">`).join("")}
  <iframe style="position:absolute;top:0;left:400px;width:200px;height:100px" srcdoc="<input id='child' style='position:absolute;top:3000px' value='Child value'>"></iframe>`);
  const child = page.frames().find((frame) => frame !== page.mainFrame());
  await child!.waitForSelector("#child", { state: "attached" });
  return page;
}

async function capture(page: Page, filtered: boolean, refuseSnapshot = false) {
  const context = page.context();
  const newSession = context.newCDPSession.bind(context);
  const calls: Record<string, number> = {};
  const mediaParts = new Set<number>();
  let mediaStyleQueries = 0;
  type Node = {
    nodeId: number;
    nodeName: string;
    attributes?: string[];
    children?: Node[];
    shadowRoots?: Node[];
    contentDocument?: Node;
  };
  context.newCDPSession = async (target) => {
    const session = await newSession(target);
    const send = session.send.bind(session);
    session.send = (async (method: string, parameters?: object) => {
      calls[method] = (calls[method] ?? 0) + 1;
      if (method === "DOMSnapshot.captureSnapshot" && refuseSnapshot) throw new Error("controlled snapshot refusal");
      const nodeId = (parameters as { nodeId?: number } | undefined)?.nodeId;
      if (method === "CSS.getMatchedStylesForNode" && nodeId != null && mediaParts.has(nodeId)) mediaStyleQueries++;
      const response: unknown = await Reflect.apply(send, session, [method, parameters]);
      if (method === "DOM.getDocument") {
        const collect = (node: Node, inMedia: boolean): void => {
          inMedia ||= node.nodeName === "VIDEO" && (node.attributes ?? []).includes("mediaFar");
          if (inMedia) mediaParts.add(node.nodeId);
          for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) collect(child, inMedia);
          if (node.contentDocument != null) collect(node.contentDocument, inMedia);
        };
        collect((response as { root: Node }).root, false);
      }
      return response;
    }) as typeof session.send;
    return session;
  };
  try {
    const result = await captureResolvedControlPseudoStyles(page, filtered ? viewport : undefined);
    return { result, calls, mediaStyleQueries };
  } finally {
    context.newCDPSession = newSession;
  }
}

type Capture = Awaited<ReturnType<typeof capture>>;
async function facts(page: Page, captured: Capture) {
  const { propertyKey, inputValuePropertyKey, stylesByHost } = captured.result;
  const read = (selector: string) =>
    page.locator(selector).evaluate((element, key): unknown => Reflect.get(element, key), inputValuePropertyKey);
  const style = async (selector: string) => {
    const hostId = await page.locator(selector).evaluate((element, key) => {
      const id: unknown = Reflect.get(element, key);
      return typeof id === "string" ? id : undefined;
    }, propertyKey);
    return hostId == null ? undefined : stylesByHost[hostId];
  };
  const child = page.frames().find((frame) => frame !== page.mainFrame());
  return {
    near: await read("#near"),
    far: await read("#far"),
    fixed: await read("#fixed"),
    sticky: await read("#sticky"),
    animated: await read("#animated"),
    transformed: await read("#transformed"),
    range: (await style("#range"))?.track,
    scrollNear: await style("#scrollNear"),
    scrollFar: await style("#scrollFar"),
    child: await child!
      .locator("#child")
      .evaluate((element, key): unknown => Reflect.get(element, key), inputValuePropertyKey),
  };
}

describe("control pseudo viewport selection (DM-A93KQZ)", () => {
  it.each([1280, 800, 390])("preserves the production capture tree at %i px", async (width) => {
    const page = await fixture();
    const captureViewport = { ...viewport, width };
    const original = pseudoStyles.captureResolvedControlPseudoStyles;
    const spy = vi.spyOn(pseudoStyles, "captureResolvedControlPseudoStyles");
    try {
      await page.setViewportSize({ width, height: viewport.height });
      spy.mockImplementation((target) => original(target));
      const unfiltered = await captureElementTree(page, "body", captureViewport);
      spy.mockImplementation(original);
      const filtered = await captureElementTree(page, "body", captureViewport);
      expect(spy.mock.calls.at(-1)?.[1]).toEqual(captureViewport);
      // Frame provenance gets a fresh transaction UUID on every capture.
      const comparable = (nodes: CapturedElement[]): CapturedElement[] =>
        nodes.map((node) => ({
          ...node,
          children: comparable(node.children),
          frameScrollIdentity:
            node.frameScrollIdentity == null
              ? undefined
              : {
                  ...node.frameScrollIdentity,
                  captureId: "capture-transaction",
                },
        }));
      expect(comparable(filtered)).toEqual(comparable(unfiltered));
    } finally {
      spy.mockRestore();
      await page.close();
    }
  });

  it("reduces UA probes while preserving visible values, native pseudo facts, and protected subtrees", async () => {
    const page = await fixture();
    try {
      const before = await capture(page, false);
      const original = await facts(page, before);
      await before.result.dispose();
      const filtered = await capture(page, true);
      try {
        const selected = await facts(page, filtered);
        expect(selected.near).toEqual(original.near);
        expect(selected.near).toMatchObject({
          source: "chromium-ua-shadow-text-quad-v1",
          textHeight: expect.any(Number),
        });
        expect(selected.range).toEqual(original.range);
        expect(selected.range?.backgroundColor).toBe("rgb(101, 1, 102)");
        expect(original.scrollFar).toBeDefined();
        expect(selected.scrollFar).toBeUndefined();
        expect(selected.scrollNear).toEqual(original.scrollNear);
        expect(selected.scrollNear?.resizer?.backgroundColor).toBe("rgb(30, 20, 10)");
        expect(selected.scrollNear?.["scrollbar-thumb"]?.backgroundColor).toBe("rgb(10, 20, 30)");
        expect(before.mediaStyleQueries).toBeGreaterThan(0);
        expect(filtered.mediaStyleQueries).toBe(0);
        expect(selected.far).toBeUndefined();
        expect(selected.fixed).toEqual(original.fixed);
        expect(selected.sticky).toEqual(original.sticky);
        expect(selected.animated).toEqual(original.animated);
        expect(selected.animated).toBeDefined();
        expect(selected.transformed).toEqual(original.transformed);
        expect(selected.transformed).toBeDefined();
        expect(selected.child).toEqual(original.child);
        expect(selected.child).toBeDefined();
        expect(filtered.calls["DOMSnapshot.captureSnapshot"]).toBe(1);
        expect(filtered.calls["CSS.getMatchedStylesForNode"]).toBeLessThan(
          before.calls["CSS.getMatchedStylesForNode"] / 4,
        );
      } finally {
        await filtered.result.dispose();
      }
      await page.evaluate(() => window.scrollTo(0, 4000));
      const scrolled = await capture(page, true);
      try {
        const selected = await facts(page, scrolled);
        expect(selected.far).toMatchObject({
          source: "chromium-ua-shadow-text-quad-v1",
          textHeight: expect.any(Number),
        });
        expect(selected.near).toBeUndefined();
        expect(selected.fixed).toMatchObject({ textHeight: expect.any(Number) });
        expect(selected.sticky).toMatchObject({ textHeight: expect.any(Number) });
      } finally {
        await scrolled.result.dispose();
      }
      expect(
        await page
          .locator("#near")
          .evaluate((element, key) => Object.hasOwn(element, key), scrolled.result.inputValuePropertyKey),
      ).toBe(false);
    } finally {
      await page.close();
    }
  });

  it("keeps exact UA reads when snapshot selection fails", async () => {
    const page = await fixture();
    try {
      const captured = await capture(page, true, true);
      try {
        const selected = await facts(page, captured);
        expect(captured.calls["DOMSnapshot.captureSnapshot"]).toBe(1);
        expect(selected.far).toBeDefined();
        expect(selected.near).toMatchObject({ textHeight: expect.any(Number) });
        expect(selected.range?.backgroundColor).toBe("rgb(101, 1, 102)");
        expect(selected.scrollFar).toBeDefined();
        expect(captured.mediaStyleQueries).toBeGreaterThan(0);
      } finally {
        await captured.result.dispose();
      }
    } finally {
      await page.close();
    }
  });
});
