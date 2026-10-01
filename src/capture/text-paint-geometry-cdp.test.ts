import { describe, expect, it, vi } from "vitest";
import type { CDPSession } from "@playwright/test";

import { measureRangeFragments, measureTextPaintRows } from "./text-paint-geometry-cdp.js";

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

function row(sourceTextNodeIndex: number) {
  return {
    sourceKey: `source:${sourceTextNodeIndex}`,
    sourceTextNodeIndex,
    surfaceOwnerKey: `surface:${sourceTextNodeIndex}`,
    writingMode: "horizontal-tb",
    direction: "ltr",
    transformBox: "view-box",
    transformOrigin: "0px 0px",
    effectiveZoom: 1,
  };
}

describe("bounded text paint CDP measurement (DM-2680)", () => {
  it("bounds row chains, preserves mapping order, isolates failures, and releases every acquired object", async () => {
    let activeRows = 0;
    let maxActiveRows = 0;
    let nextBackendNodeId = 100;
    const objectForBackend = new Map<number, string>();
    const released: string[] = [];

    const send = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "Runtime.evaluate") {
        const match = /textRows\?\.\[(\d+)\]/.exec(String(params.expression));
        const objectId = `${String(params.contextId)}:${match?.[1] ?? "missing"}`;
        activeRows++;
        maxActiveRows = Math.max(maxActiveRows, activeRows);
        await delay(Number(match?.[1] ?? 0) % 2 === 0 ? 4 : 1);
        return { result: { objectId } };
      }
      if (method === "DOM.describeNode") {
        const backendNodeId = nextBackendNodeId++;
        objectForBackend.set(backendNodeId, String(params.objectId));
        await delay(1);
        return { node: { backendNodeId } };
      }
      if (method === "DOM.getContentQuads") {
        const backendNodeId = Number(params.backendNodeId);
        const objectId = objectForBackend.get(backendNodeId)!;
        await delay(objectId.endsWith(":1") ? 4 : 1);
        if (objectId === "10:2") throw new Error("controlled row failure");
        const base = Number(objectId.split(":")[0]) * 10 + Number(objectId.split(":")[1]);
        return { quads: [[base, base + 1, base + 2, base + 3, base + 4, base + 5, base + 6, base + 7]] };
      }
      if (method === "Runtime.releaseObject") {
        const objectId = String(params.objectId);
        released.push(objectId);
        activeRows--;
        if (objectId === "11:0") throw new Error("controlled release failure");
        return {};
      }
      throw new Error(`unexpected CDP method: ${method}`);
    });
    const session = { send } as unknown as CDPSession;
    const frames = [
      { frame: {}, token: "f0", rows: [row(0), row(1), row(2)], hasTransformOwners: false },
      { frame: {}, token: "f1", rows: [row(0), row(1)], hasTransformOwners: false },
    ] as unknown as Parameters<typeof measureTextPaintRows>[2];

    const result = await measureTextPaintRows(
      session,
      "probe",
      frames,
      new Map([
        ["f0", 10],
        ["f1", 11],
      ]),
      { x: 1, y: 2 },
      2,
    );

    expect(maxActiveRows).toBe(2);
    expect(activeRows).toBe(0);
    expect([...result.keys()]).toEqual(["f0:0", "f0:1", "f1:0", "f1:1"]);
    expect(result.get("f0:0")?.[0]).toEqual([99, 99, 101, 101, 103, 103, 105, 105]);
    expect(result.get("f1:1")?.[0]).toEqual([110, 110, 112, 112, 114, 114, 116, 116]);
    expect(result.has("f0:2")).toBe(false);
    expect(new Set(released)).toEqual(new Set(["10:0", "10:1", "10:2", "11:0", "11:1"]));
    expect(send.mock.calls.filter(([method]) => method === "Runtime.releaseObject")).toHaveLength(5);
  });
});

describe("Range FragmentItem probe whole-frame failure", () => {
  it("reports a failed frame once and keeps the other frames' rows", async () => {
    const frameThatFails = {
      evaluate: vi.fn(async () => {
        throw new Error("Execution context was destroyed");
      }),
    };
    const frameThatWorks = {
      evaluate: vi.fn(async () => [{ fragments: [], failureReason: "measured" }]),
    };
    const frames = [
      { frame: frameThatFails, token: "f0", rows: [], hasTransformOwners: false },
      { frame: frameThatWorks, token: "f1", rows: [], hasTransformOwners: false },
    ] as unknown as Parameters<typeof measureRangeFragments>[0];
    const failures: unknown[] = [];

    const result = await measureRangeFragments(frames, "probe", (error) => failures.push(error));

    expect(failures).toEqual([new Error("Execution context was destroyed")]);
    expect([...result.keys()]).toEqual(["f1:0"]);
    expect(result.get("f1:0")?.failureReason).toBe("measured");
  });

  it("stays silent when every frame is measured", async () => {
    const frames = [
      {
        frame: { evaluate: async () => [] },
        token: "f0",
        rows: [],
        hasTransformOwners: false,
      },
    ] as unknown as Parameters<typeof measureRangeFragments>[0];
    const failures: unknown[] = [];
    await measureRangeFragments(frames, "probe", (error) => failures.push(error));
    expect(failures).toEqual([]);
  });
});
