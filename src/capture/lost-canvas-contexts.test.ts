// @vitest-environment happy-dom
import type { Page } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capturedElement } from "../test-support/captured-fixtures.js";
import {
  LOST_CANVAS_CONTEXT_DETAIL,
  LOST_CANVAS_CONTEXT_FEATURE,
  LOST_CANVAS_SELECTORS,
  warnLostCanvasContexts,
} from "./lost-canvas-contexts.js";
import type { CaptureWarning } from "./types.js";

type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

function fakePage(send: Send) {
  const session = { send: vi.fn(send), detach: vi.fn(() => Promise.resolve()) };
  const newCDPSession = vi.fn(() => Promise.resolve(session));
  const page = { context: () => ({ newCDPSession }) } as unknown as Page;
  return { page, session, newCDPSession };
}

/** CDP answers for one context interface per `Runtime.evaluate` expression. */
function cdp(selectorsByInterface: Record<string, string[] | undefined>): Send {
  return (method, params) => {
    if (method === "Runtime.evaluate") {
      const name = /\? (\w+)\.prototype/.exec(String(params?.["expression"]))?.[1] ?? "";
      return Promise.resolve({ result: name in selectorsByInterface ? { objectId: `proto:${name}` } : {} });
    }
    if (method === "Runtime.queryObjects") {
      return Promise.resolve({ objects: { objectId: `array:${String(params?.["prototypeObjectId"])}` } });
    }
    if (method === "Runtime.callFunctionOn") {
      const name = String(params?.["objectId"]).replace("array:proto:", "");
      return Promise.resolve({ result: { value: selectorsByInterface[name] ?? [] } });
    }
    return Promise.resolve({});
  };
}

const canvasTree = [capturedElement({ tag: "body", children: [capturedElement({ tag: "canvas" })] })];

describe("warnLostCanvasContexts", () => {
  it("opens no CDP session when the captured tree has no canvas", async () => {
    const { page, newCDPSession } = fakePage(cdp({}));
    const warnings: CaptureWarning[] = [];
    await warnLostCanvasContexts(page, [capturedElement({ tag: "div" })], "body", warnings);
    expect(newCDPSession).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });

  it("warns once per lost canvas across context interfaces and releases its objects", async () => {
    const { page, session } = fakePage(
      cdp({
        CanvasRenderingContext2D: ["canvas#a"],
        WebGLRenderingContext: ["canvas#b", "canvas#a"],
        WebGL2RenderingContext: [],
      }),
    );
    const warnings: CaptureWarning[] = [];
    await warnLostCanvasContexts(page, canvasTree, "main", warnings);
    expect(warnings).toEqual([
      { selector: "canvas#a", feature: LOST_CANVAS_CONTEXT_FEATURE, detail: LOST_CANVAS_CONTEXT_DETAIL },
      { selector: "canvas#b", feature: LOST_CANVAS_CONTEXT_FEATURE, detail: LOST_CANVAS_CONTEXT_DETAIL },
    ]);
    const calls = session.send.mock.calls.filter(([method]) => method === "Runtime.callFunctionOn");
    expect(calls).toHaveLength(3);
    for (const [, params] of calls)
      expect(params).toMatchObject({ arguments: [{ value: "main" }], returnByValue: true });
    expect(session.send).toHaveBeenLastCalledWith("Runtime.releaseObjectGroup", {
      objectGroup: "domotion-lost-canvas-contexts",
    });
    expect(session.detach).toHaveBeenCalledTimes(1);
  });

  it("skips an interface the page does not define", async () => {
    const { page, session } = fakePage(cdp({ CanvasRenderingContext2D: ["canvas"] }));
    const warnings: CaptureWarning[] = [];
    await warnLostCanvasContexts(page, canvasTree, "body", warnings);
    expect(warnings.map((warning) => warning.selector)).toEqual(["canvas"]);
    expect(session.send.mock.calls.filter(([method]) => method === "Runtime.queryObjects")).toHaveLength(1);
  });

  it("never fails the capture when CDP is unavailable or a query throws", async () => {
    const warnings: CaptureWarning[] = [];
    const noSession = {
      context: () => ({ newCDPSession: () => Promise.reject(new Error("closed")) }),
    } as unknown as Page;
    await warnLostCanvasContexts(noSession, canvasTree, "body", warnings);

    const { page, session } = fakePage((method) =>
      method === "Runtime.releaseObjectGroup" ? Promise.reject(new Error("gone")) : Promise.reject(new Error("boom")),
    );
    await warnLostCanvasContexts(page, canvasTree, "body", warnings);
    expect(warnings).toEqual([]);
    expect(session.detach).toHaveBeenCalledTimes(1);
  });
});

describe("LOST_CANVAS_SELECTORS (in-page)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function run(contexts: unknown[], rootSelector: string): unknown {
    const fn = new Function(`return (${LOST_CANVAS_SELECTORS});`)() as (this: unknown[], root: string) => unknown;
    return fn.call(contexts, rootSelector);
  }

  it("names lost, connected canvases inside the capture root with the capture's selector shape", () => {
    document.body.innerHTML = `<main class="stage wide extra"><canvas class="chart"></canvas><canvas id="gl"></canvas><canvas class="ok"></canvas></main><aside><canvas class="outside"></canvas></aside>`;
    const [chart, gl, ok, outside] = [...document.querySelectorAll("canvas")];
    const detached = document.createElement("canvas");
    const context = (canvas: unknown, lost: boolean) => ({ canvas, isContextLost: () => lost });
    expect(
      run(
        [
          context(chart, true),
          context(gl, true),
          context(gl, true),
          context(ok, false),
          context(outside, true),
          context(detached, true),
          context({ width: 1 }, true),
        ],
        "main",
      ),
    ).toEqual(["body > main.stage.wide > canvas.chart", "canvas#gl"]);
  });
});
