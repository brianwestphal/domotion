import { afterAll, describe, expect, it } from "vitest";

import { captureElementTreeWithWarnings, launchChromium } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// The closed-UA-shadow input value text top is authorized only by one
// axis-aligned Chromium text quad whose host box still matches the DOM walk
// (doc 171). When the quad is rejected the walker keeps its line-height
// estimate, and that approximation must surface as a named capture warning
// rather than stay silent.
const browser = await launchChromium();
afterAll(async () => closeBrowserSafely(browser), 15_000);

async function geometryWarnings(body: string): Promise<{ selector: string; detail: string }[]> {
  const viewport = { width: 640, height: 320 };
  const page = await browser.newPage({ viewport });
  try {
    await page.setContent(`<style>
      html,body{margin:0;background:white;font:16px Arial}
      input{position:absolute;left:40px;width:200px;height:40px;font:16px Arial}
    </style>${body}`);
    const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, ...viewport });
    return capture.warnings
      .filter(({ feature }) => feature === "input-value-geometry")
      .map(({ selector, detail }) => ({ selector, detail }));
  } finally {
    await page.close();
  }
}

describe("closed-shadow input value geometry warnings", () => {
  it("stays silent when the Chromium text quad authorizes the value top", async () => {
    expect(
      await geometryWarnings(`
        <input id="plain" style="top:20px" value="Hello">
        <input id="filled" style="top:80px" value="Typed" placeholder="Hidden placeholder">
        <input id="placeholder" style="top:140px" placeholder="Shown placeholder">`),
    ).toEqual([]);
  });

  it("names a rotated host's rejected quad", async () => {
    const warnings = await geometryWarnings(
      `<input id="rotated" style="top:40px;transform:rotate(12deg)" value="Rotated">`,
    );
    expect(warnings).toEqual([
      {
        selector: "input#rotated",
        detail:
          "closed-shadow value text quad rejected (non-axis-aligned-quad); value text top estimated from line-height and font metrics",
      },
    ]);
  });

  it("keeps a uniformly scaled host's authority: the quad and the walk see the same box", async () => {
    // `host-box-changed` (a relayout or neutralized transform between the CDP
    // quad and the walk) is covered by the walker unit test.
    expect(await geometryWarnings(`<input id="scaled" style="top:40px;transform:scale(1.5)" value="Scaled">`)).toEqual(
      [],
    );
  });
});
