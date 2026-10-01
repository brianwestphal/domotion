import { chromium } from "@playwright/test";
import { afterAll, describe, expect, it } from "vitest";
import { createPageRegistry } from "../src/capture/page-registry.js";

describe("capture page registry", () => {
  const browser = chromium.launch();
  afterAll(async () => (await browser).close());

  it("keeps live DOM values in separate frames and removes both after disposal", async () => {
    const page = await (await browser).newPage();
    try {
      await page.setContent('<div id="outer">outer</div><iframe srcdoc="<div id=inner>inner</div>"></iframe>');
      const frame = page.frames()[1];
      await frame.locator("#inner").waitFor();
      const registry = createPageRegistry<Map<string, Element>>(page, "LiveElements");
      await registry.tag(page, (id) => new Map([["node", document.querySelector(id)!]]), "#outer");
      await registry.tag(frame, (id) => new Map([["node", document.querySelector(id)!]]), "#inner");

      const outer = await registry.read(page);
      const inner = await registry.read(frame);
      try {
        expect(await outer.evaluate((map) => map?.get("node")?.id)).toBe("outer");
        expect(await inner.evaluate((map) => map?.get("node")?.id)).toBe("inner");
        expect(await outer.evaluate((map) => map?.get("node")?.ownerDocument === document)).toBe(true);
        expect(await inner.evaluate((map) => map?.get("node")?.ownerDocument === document)).toBe(true);
      } finally {
        await outer.dispose();
        await inner.dispose();
      }

      await registry.dispose();
      expect(await page.evaluate((key) => Object.hasOwn(globalThis, key), registry.key)).toBe(false);
      expect(await frame.evaluate((key) => Object.hasOwn(globalThis, key), registry.key)).toBe(false);
    } finally {
      await page.close();
    }
  });
});
