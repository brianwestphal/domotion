import type { Browser, CDPSession, Page } from "@playwright/test";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { launchChromium, captureElementTree } from "../src/capture/index.js";
import { prepareInsetRootShadowContext } from "../src/capture/inset-root-shadow-context.js";
import { CAPTURE_SCRIPT } from "../src/capture/script.generated.js";
import type { CapturedElement, CaptureScriptArgs } from "../src/capture/types.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

let browser: Browser;
let priorProbe: string | undefined;
const viewport = { x: 0, y: 0, width: 100, height: 100 };
const html =
  '<style>body{margin:0}#host{display:block;width:100px;height:100px}#only{position:absolute;left:20px;top:20px;width:20px;height:20px;box-shadow:inset 0 0 0 3px red}</style><div id="host"><div id="only"></div></div>';
beforeAll(async () => {
  priorProbe = process.env["DOMOTION_GENERIC_PROBE"];
  process.env["DOMOTION_GENERIC_PROBE"] = "0";
  browser = await launchChromium();
});
afterAll(async () => {
  await closeBrowserSafely(browser);
  if (priorProbe == null) delete process.env["DOMOTION_GENERIC_PROBE"];
  else process.env["DOMOTION_GENERIC_PROBE"] = priorProbe;
});
async function rawCapture(page: Page, key?: string): Promise<CapturedElement[]> {
  const args = { selector: "#only", viewport, insetRootShadowContextKey: key } satisfies Partial<CaptureScriptArgs>;
  const result = (await page.evaluate(`(${CAPTURE_SCRIPT})(${JSON.stringify(args)})`)) as { tree: CapturedElement[] };
  return result.tree;
}
it("does not open CDP for noncandidate or independently painted roots", async () => {
  const page = await browser.newPage({ viewport });
  const create = vi.spyOn(page.context(), "newCDPSession");
  try {
    for (const style of ["box-shadow:none", "background:blue"]) {
      await page.setContent(html);
      await page.locator("#only").evaluate((el, style) => el.setAttribute("style", style), style);
      const probe = await prepareInsetRootShadowContext(page, "#only");
      expect(probe.key).toBeUndefined();
      expect(probe.warnings).toEqual([]);
      await probe.dispose();
    }
    expect(create).not.toHaveBeenCalled();
  } finally {
    create.mockRestore();
    await page.close();
  }
});
it("refuses a selected host with an empty closed author root", async () => {
  const page = await browser.newPage({ viewport });
  try {
    await page.setContent(html);
    await page.locator("#only").evaluate((el) => el.attachShadow({ mode: "closed" }));
    expect(await captureElementTree(page, "#only", viewport)).toEqual([]);
  } finally {
    await page.close();
  }
});
it.each(["open", "closed"] as const)("refuses the new root path through an %s slotted author tree", async (mode) => {
  const page = await browser.newPage({ viewport });
  try {
    await page.setContent(html.replaceAll("left:20px;top:20px", "left:20.5px;top:20.5px"));
    await page.evaluate((mode) => {
      const shadow = document.querySelector("#host")!.attachShadow({ mode });
      shadow.innerHTML =
        '<div style="position:relative;width:100px;height:100px;transform:translate(.5px,.5px)"><slot></slot></div>';
    }, mode);
    const rect = await page.locator("#only").evaluate((el) => el.getBoundingClientRect().toJSON());
    expect([rect.x, rect.y, rect.width, rect.height].every(Number.isInteger)).toBe(true);
    expect(await captureElementTree(page, "#only", viewport)).toEqual([]);
    expect(await captureElementTree(page, "#host", viewport)).toHaveLength(1);
  } finally {
    await page.close();
  }
});
it("refuses missing provenance and binds a conclusive fact to the actual selected element", async () => {
  const page = await browser.newPage({ viewport });
  let old: Awaited<ReturnType<typeof prepareInsetRootShadowContext>> | undefined;
  let fresh: Awaited<ReturnType<typeof prepareInsetRootShadowContext>> | undefined;
  try {
    await page.setContent(html);
    expect(await rawCapture(page)).toEqual([]);
    old = await prepareInsetRootShadowContext(page, "#only");
    expect(old.key).toBeDefined();
    expect(await rawCapture(page, old.key)).toHaveLength(1);
    await page.locator("#only").evaluate((el) => el.replaceWith(el.cloneNode(true)));
    expect(await rawCapture(page, old.key)).toEqual([]);
    fresh = await prepareInsetRootShadowContext(page, "#only");
    expect(fresh.key).not.toBe(old.key);
    expect(await rawCapture(page, fresh.key)).toHaveLength(1);
  } finally {
    await old?.dispose();
    await fresh?.dispose();
    await page.close();
  }
});
it.each(["source", "document", "context"])("refuses unknown %s provenance", async (property) => {
  const page = await browser.newPage({ viewport });
  let probe: Awaited<ReturnType<typeof prepareInsetRootShadowContext>> | undefined;
  try {
    await page.setContent(html);
    probe = await prepareInsetRootShadowContext(page, "#only");
    expect(probe.key).toBeDefined();
    await page.evaluate(
      ({ key, property }) => {
        const host = globalThis as typeof globalThis & Record<string, object>;
        Object.defineProperty(host[key!], property, { value: "unknown" });
      },
      { key: probe.key, property },
    );
    expect(await rawCapture(page, probe.key)).toEqual([]);
  } finally {
    await probe?.dispose();
    await page.close();
  }
});
it("refuses a foreign owner without deleting that owner's replacement value", async () => {
  const page = await browser.newPage({ viewport });
  let probe: Awaited<ReturnType<typeof prepareInsetRootShadowContext>> | undefined;
  try {
    await page.setContent(html);
    probe = await prepareInsetRootShadowContext(page, "#only");
    await page.evaluate((key) => {
      const host = globalThis as typeof globalThis & Record<string, { owner: string }>;
      host[key!].owner = "foreign";
    }, probe.key);
    expect(await rawCapture(page, probe.key)).toEqual([]);
    await probe.dispose();
    expect(await page.evaluate((key) => key != null && key in globalThis, probe.key)).toBe(true);
  } finally {
    if (probe?.key)
      await page.evaluate((key) => {
        delete (globalThis as typeof globalThis & Record<string, unknown>)[key];
      }, probe.key);
    await probe?.dispose();
    await page.close();
  }
});
it("does not depend on source-page timers and disposes its owned registry", async () => {
  const page = await browser.newPage({ viewport });
  let probe: Awaited<ReturnType<typeof prepareInsetRootShadowContext>> | undefined;
  try {
    await page.setContent(html);
    await page.evaluate(() => {
      Object.defineProperty(window, "setTimeout", { value: () => 0 });
    });
    probe = await prepareInsetRootShadowContext(page, "#only");
    expect(await rawCapture(page, probe.key)).toHaveLength(1);
    const key = probe.key;
    await probe.dispose();
    expect(await page.evaluate((key) => key == null || !(key in globalThis), key)).toBe(true);
  } finally {
    await probe?.dispose();
    await page.close();
  }
});
it("refuses a Node-deadline expiry and detaches a session delivered after it", async () => {
  const page = await browser.newPage({ viewport });
  await page.setContent(html);
  const context = page.context();
  const late = await context.newCDPSession(page);
  const detach = vi.spyOn(late, "detach");
  let release: (session: CDPSession) => void = () => undefined;
  let requested: () => void = () => undefined;
  const requestedPromise = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const held = new Promise<CDPSession>((resolve) => {
    release = resolve;
  });
  const create = vi.spyOn(context, "newCDPSession").mockImplementationOnce(() => {
    requested();
    return held;
  });
  let probe: Awaited<ReturnType<typeof prepareInsetRootShadowContext>> | undefined;
  try {
    const pending = prepareInsetRootShadowContext(page, "#only", 1000);
    await requestedPromise;
    probe = await pending;
    expect(probe.key).toBeUndefined();
    expect(probe.warnings.some((warning) => warning.detail.includes("Node deadline"))).toBe(true);
    release(late);
    await expect.poll(() => detach.mock.calls.length).toBeGreaterThan(0);
    expect(
      await page.evaluate(() => Object.keys(globalThis).filter((key) => key.includes("InsetRootShadowContext"))),
    ).toEqual([]);
  } finally {
    release(late);
    create.mockRestore();
    await probe?.dispose();
    await late.detach().catch(() => undefined);
    await page.close();
  }
}, 10000);
