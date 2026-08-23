import type { Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { rasterizeBackdropFilters } from "./emoji.js";
import type { CapturedElement, CaptureWarning } from "./types.js";

const viewport = { x: 0, y: 0, width: 120, height: 80 };

function target(options: { token?: string; frosted?: boolean; effectSpace?: boolean } = {}): CapturedElement {
  return {
    tag: "div",
    text: "",
    x: 10,
    y: 10,
    width: 60,
    height: 40,
    styles: options.frosted ? { frostedBgFallback: "rgb(245, 245, 245)" } : {},
    children: [],
    backdropFilterRaster: {
      x: 10,
      y: 10,
      width: 60,
      height: 40,
      token: options.token,
      selector: "#glass",
      effectSpace: options.effectSpace === false ? undefined : {
        source: "blink-backdrop-effect-tree-v1",
        nearestRoot: { kind: "document", depth: 1, selector: "html", reasons: ["document-root"] },
        ancestors: [],
      },
    },
  } as unknown as CapturedElement;
}

function snapshot(options: { token?: string; laterOwner?: boolean } = {}) {
  const strings = ["data-domotion-backdrop-raster", options.token ?? "bf0"];
  const backendNodeId = options.laterOwner ? [11, 12] : [11];
  return {
    strings,
    documents: [{
      nodes: {
        backendNodeId,
        parentIndex: options.laterOwner ? [-1, -1] : [-1],
        attributes: options.token == null
          ? backendNodeId.map(() => [])
          : [[0, 1], ...(options.laterOwner ? [[]] : [])],
      },
      layout: {
        nodeIndex: options.laterOwner ? [0, 1] : [0],
        bounds: options.laterOwner
          ? [[10, 10, 60, 40], [20, 20, 40, 30]]
          : [[10, 10, 60, 40]],
        paintOrders: options.laterOwner ? [1, 2] : [1],
      },
    }],
  };
}

function fakePage(options: {
  snapshot: ReturnType<typeof snapshot>;
  resolveFails?: boolean;
  screenshotFails?: boolean;
}): Page {
  const cdp = {
    send: vi.fn(async (method: string) => {
      if (method === "DOMSnapshot.captureSnapshot") return options.snapshot;
      if (method === "DOM.resolveNode") {
        if (options.resolveFails) throw new Error("resolve failed");
        return { object: { objectId: "object-1" } };
      }
      return { result: { value: { v: "", p: "" } } };
    }),
    detach: vi.fn(async () => undefined),
  };
  return {
    context: () => ({ newCDPSession: async () => cdp }),
    screenshot: vi.fn(async () => {
      if (options.screenshotFails) throw new Error("screenshot failed");
      return Buffer.from("chromium-png");
    }),
    evaluate: vi.fn(async (_callback: unknown, argument?: unknown) =>
      argument != null && typeof argument === "object" && "restoreToken" in argument
        ? "exact"
        : undefined),
  } as unknown as Page;
}

describe("rasterizeBackdropFilters diagnostics", () => {
  it("emits no warning for a fully isolated Chromium materialization", async () => {
    const tree = [target({ token: "bf0" })];
    const warnings: CaptureWarning[] = [];
    await rasterizeBackdropFilters(fakePage({ snapshot: snapshot({ token: "bf0" }) }), tree, viewport, warnings);
    expect(tree[0].backdropFilterRaster?.dataUri).toMatch(/^data:image\/png;base64,/);
    expect(warnings).toEqual([]);
  });

  it("reports a planner miss after retaining an unisolated Chromium crop", async () => {
    const tree = [target({ token: "bf0" })];
    const warnings: CaptureWarning[] = [];
    await rasterizeBackdropFilters(fakePage({ snapshot: snapshot() }), tree, viewport, warnings);
    expect(tree[0].backdropFilterRaster?.dataUri).toMatch(/^data:image\/png;base64,/);
    expect(warnings).toEqual([expect.objectContaining({
      feature: "backdrop-filter",
      status: "partial",
      detail: expect.stringContaining("fallback: unisolated Chromium page crop"),
    })]);
  });

  it("reports a legacy final-effect-space crop when the source-owned record is absent", async () => {
    const tree = [target({ token: "bf0", effectSpace: false })];
    const warnings: CaptureWarning[] = [];
    await rasterizeBackdropFilters(fakePage({ snapshot: snapshot({ token: "bf0" }) }), tree, viewport, warnings);
    expect(tree[0].backdropFilterRaster?.dataUri).toMatch(/^data:image\/png;base64,/);
    expect(warnings).toEqual([expect.objectContaining({
      status: "partial",
      detail: expect.stringContaining("effect-space correlation was unavailable"),
    })]);
  });

  it("reports a CDP node-resolution miss after retaining the partial crop", async () => {
    const tree = [target({ token: "bf0" })];
    const warnings: CaptureWarning[] = [];
    await rasterizeBackdropFilters(fakePage({
      snapshot: snapshot({ token: "bf0", laterOwner: true }),
      resolveFails: true,
    }), tree, viewport, warnings);
    expect(tree[0].backdropFilterRaster?.dataUri).toMatch(/^data:image\/png;base64,/);
    expect(warnings).toEqual([expect.objectContaining({
      status: "partial",
      detail: expect.stringContaining("1 CDP paint owner was not resolved"),
    })]);
  });

  it("reports screenshot failure as unavailable and keeps the real frosted fallback", async () => {
    const tree = [target({ token: "bf0", frosted: true })];
    const warnings: CaptureWarning[] = [];
    await rasterizeBackdropFilters(fakePage({
      snapshot: snapshot({ token: "bf0" }),
      screenshotFails: true,
    }), tree, viewport, warnings);
    expect(tree[0].backdropFilterRaster?.dataUri).toBeUndefined();
    expect(warnings).toEqual([expect.objectContaining({
      status: "unavailable",
      detail: expect.stringContaining("captured frosted-background color without a sampled backdrop"),
    })]);
  });

  it("reports a missing live token before attempting CDP", async () => {
    const tree = [target()];
    const warnings: CaptureWarning[] = [];
    const page = fakePage({ snapshot: snapshot({ token: "bf0" }) });
    await rasterizeBackdropFilters(page, tree, viewport, warnings);
    expect(page.context().newCDPSession).toBeDefined();
    expect(warnings).toEqual([expect.objectContaining({
      status: "unavailable",
      detail: expect.stringContaining("no live-DOM isolation token"),
    })]);
  });
});
