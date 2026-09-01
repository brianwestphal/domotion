import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { CDPSession, Page } from "@playwright/test";
import { rasterizeReplacedElements } from "./replaced-element-raster.js";
import type { CapturedElement, CaptureWarning } from "./types.js";

function target(rid: string, x: number): CapturedElement {
  return {
    tag: "canvas",
    children: [],
    styles: { transform: "none" },
    replacedSnapshot: { rid, x, y: 10, width: 20, height: 20 },
  } as unknown as CapturedElement;
}

interface FakeRasterPage {
  page: Page;
  restoreCalls: number;
  cleanupCalls: number;
  styleRemoveCalls: number;
  cdpDetachCalls: number;
}

async function fakeRasterPage(options: {
  failScreenshot?: number;
  failStyleInstall?: boolean;
} = {}): Promise<FakeRasterPage> {
  const png = await sharp({
    create: { width: 20, height: 20, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 1 } },
  }).png().toBuffer();
  const state = {
    restoreCalls: 0,
    cleanupCalls: 0,
    styleRemoveCalls: 0,
    cdpDetachCalls: 0,
    screenshotCalls: 0,
  };
  const cdp = {
    async send(method: string, params?: { selector?: string; nodeId?: number }) {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") {
        return { nodeId: params?.selector?.includes("dr1") ? 11 : 12 };
      }
      if (method === "DOM.getBoxModel") {
        const x = params?.nodeId === 12 ? 40 : 10;
        return { model: { content: [x, 10, x + 20, 10, x + 20, 30, x, 30] } };
      }
      return {};
    },
    async detach() { state.cdpDetachCalls++; },
  } as unknown as CDPSession;
  const page = {
    context: () => ({ newCDPSession: async () => cdp }),
    async addStyleTag() {
      if (options.failStyleInstall) throw new Error("style install failed");
      return {
        async evaluate() { state.styleRemoveCalls++; },
      };
    },
    async evaluate(fn: unknown, arg?: unknown) {
      if (typeof arg === "string") return true;
      const source = String(fn);
      if (source.includes("overflow-x")) return true;
      if (source.includes("querySelectorAll") && source.includes("data-domotion-rid")) {
        state.cleanupCalls++;
        return undefined;
      }
      if (source.includes("delete host[stateKey]")) state.restoreCalls++;
      return undefined;
    },
    async screenshot() {
      state.screenshotCalls++;
      if (state.screenshotCalls === options.failScreenshot) throw new Error("screenshot failed");
      return png;
    },
  } as unknown as Page;
  return {
    page,
    get restoreCalls() { return state.restoreCalls; },
    get cleanupCalls() { return state.cleanupCalls; },
    get styleRemoveCalls() { return state.styleRemoveCalls; },
    get cdpDetachCalls() { return state.cdpDetachCalls; },
  };
}

describe("replaced-element raster ownership", () => {
  it("reports one target failure, restores it, and continues rasterizing later targets", async () => {
    const fake = await fakeRasterPage({ failScreenshot: 1 });
    const tree = [target("dr1", 10), target("dr2", 40)];
    const warnings: CaptureWarning[] = [];

    const report = await rasterizeReplacedElements(
      fake.page,
      tree,
      { x: 0, y: 0, width: 100, height: 80 },
      { warnings },
    );

    expect(report).toMatchObject({ targetCount: 2, rasterizedCount: 1, skippedProjectiveCount: 0 });
    expect(report.failures).toEqual([{
      rid: "dr1",
      tag: "canvas",
      phase: "screenshot",
      detail: "screenshot failed",
    }]);
    expect(tree[0].replacedSnapshot?.dataUri).toBeUndefined();
    expect(tree[1].replacedSnapshot?.dataUri).toMatch(/^data:image\/png;base64,/);
    expect(warnings).toEqual([expect.objectContaining({
      selector: '[data-domotion-rid="dr1"]',
      feature: "replaced-element snapshot",
      status: "partial",
    })]);
    expect(fake.restoreCalls).toBe(2);
    expect(fake.cleanupCalls).toBe(1);
    expect(fake.styleRemoveCalls).toBe(1);
    expect(fake.cdpDetachCalls).toBe(1);
  });

  it("reports isolation setup failure and still releases global resources", async () => {
    const fake = await fakeRasterPage({ failStyleInstall: true });
    const warnings: CaptureWarning[] = [];

    const report = await rasterizeReplacedElements(
      fake.page,
      [target("dr1", 10), target("dr2", 40)],
      { x: 0, y: 0, width: 100, height: 80 },
      { warnings },
    );

    expect(report.rasterizedCount).toBe(0);
    expect(report.failures).toEqual([
      expect.objectContaining({ rid: "dr1", phase: "isolation", detail: expect.stringContaining("style install failed") }),
      expect.objectContaining({ rid: "dr2", phase: "isolation", detail: expect.stringContaining("style install failed") }),
    ]);
    expect(warnings).toHaveLength(2);
    expect(fake.restoreCalls).toBe(0);
    expect(fake.cleanupCalls).toBe(1);
    expect(fake.styleRemoveCalls).toBe(0);
    expect(fake.cdpDetachCalls).toBe(1);
  });
});
