import { afterAll, describe, expect, it } from "vitest";

import { captureElementTreeWithWarnings, launchChromium } from "../src/index.js";
import { measureBlinkPlatformResizer } from "../src/capture/index.js";
import { CAPTURE_SCRIPT } from "../src/capture/script.generated.js";
import type { CapturedElement } from "../src/capture/types.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

async function setup() {
  try {
    return { browser: await launchChromium({ args: ["--enable-blink-features=AppearanceBase"] }) };
  } catch {
    return null;
  }
}
const env = await setup();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env == null ? describe.skip : describe;

function walk(nodes: CapturedElement[]): CapturedElement[] {
  return nodes.flatMap((node) => [node, ...walk(node.children ?? [])]);
}

function controls(tree: CapturedElement[]): CapturedElement[] {
  return walk(tree).filter((node) => (
    node.tag === "button" || node.tag === "input" || node.tag === "select"
    || node.tag === "textarea" || node.tag === "progress" || node.tag === "meter"
  ));
}

describeBrowser("Blink EffectiveAppearance native-control ownership", () => {
  it("warns and chooses the conservative Chromium owner when cascade facts are inaccessible", async () => {
    const viewport = { width: 260, height: 150 };
    const page = await env!.browser.newPage({ viewport, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<button id="unknown" style="margin:30px;width:140px;height:42px">unknown origin</button>`);
      const args = {
        sel: "body",
        vp: { x: 0, y: 0, ...viewport },
        cof: "",
        rt: 15,
        rs: 1,
        pk: "",
        ps: {},
        eak: "__deliberately_missing_effective_appearance_facts__",
        ear: "forced inaccessible author stylesheet",
        sk: "",
        pq: [],
        pqk: "",
      };
      const result = await page.evaluate(`(${CAPTURE_SCRIPT})(${JSON.stringify(args)})`) as {
        tree: CapturedElement[];
        warnings: Array<{ feature: string; detail: string }>;
      };
      const warning = result.warnings.find(({ feature }) => feature === "effective-appearance-cascade");
      expect(warning?.detail).toContain("forced inaccessible author stylesheet");
      expect(warning?.detail).toContain("conservative Chromium host raster");
      expect(controls(result.tree)[0].nativeControlRaster).toBeDefined();
      expect(controls(result.tree)[0].styles.effectiveAppearance).toBeUndefined();
    } finally {
      await page.close();
    }
  });

  it("routes every source switch and preserves negative author-style controls", async () => {
    const viewport = { width: 900, height: 760 };
    const page = await env!.browser.newPage({ viewport, deviceScaleFactor: 2 });
    try {
      await page.setContent(`<style>
        html,body{margin:0;background:white}
        .grid{display:grid;grid-template-columns:repeat(4,190px);gap:9px;padding:12px}
        .control{width:160px;height:30px}
        .font-only{font:700 18px serif}
        .color-padding{color:rgb(140,20,60);padding:4px 19px;text-shadow:1px 1px #ccc}
        .background{background:rgb(22,130,201)}
        .border{border:4px solid rgb(210,33,84)}
        .shadow{box-shadow:0 0 0 4px rgb(37,180,91)}
        .vertical{writing-mode:vertical-rl;direction:rtl;zoom:1.25}
        .sideways{writing-mode:sideways-lr;direction:ltr;zoom:.8}
      </style><div class="grid">
        <button class="control">default</button>
        <button class="control" disabled>disabled</button>
        <button class="control font-only">font</button>
        <button class="control color-padding">color-padding</button>
        <button class="control shadow">button-shadow</button>
        <button class="control background">button-background</button>
        <button class="control border">button-border</button>
        <input class="control font-only" type="button" value="input-font">
        <input class="control background" type="submit" value="input-background">
        <progress class="control"></progress>
        <progress class="control shadow" value=".4"></progress>
        <progress class="control border" value=".4"></progress>
        <meter class="control" min="0" max="1" value=".6"></meter>
        <meter class="control background" min="0" max="1" value=".6"></meter>
        <select class="control"><option>native menu</option></select>
        <select class="control shadow"><option>shadow menu</option></select>
        <input class="control" type="search" value="native search">
        <input class="control shadow" type="search" value="shadow search">
        <input class="control border" type="text" value="border text">
        <textarea class="control background">background textarea</textarea>
        <input class="control background" type="checkbox" checked>
        <input class="control border" type="radio" checked style="accent-color:rgb(210,33,84)">
        <input class="control shadow vertical" type="range" value="40">
        <input class="control sideways" type="checkbox">
        <button class="control" style="appearance:none">none</button>
        <button class="control" style="appearance:base">base</button>
        <select class="control" style="appearance:base-select"><option>base select</option></select>
      </div>`);

      const capture = await captureElementTreeWithWarnings(
        page, "body", { x: 0, y: 0, ...viewport },
      );
      expect(capture.warnings.filter((warning) => warning.feature === "effective-appearance-cascade")).toEqual([]);

      const actual = controls(capture.tree).map((node) => ({
        tag: node.tag,
        type: node.styles.inputType,
        effective: node.styles.effectiveAppearance,
        raster: node.nativeControlRaster != null,
      }));
      expect(actual).toEqual([
        { tag: "button", type: undefined, effective: "button", raster: true },
        { tag: "button", type: undefined, effective: "button", raster: true },
        { tag: "button", type: undefined, effective: "button", raster: true },
        { tag: "button", type: undefined, effective: "button", raster: true },
        { tag: "button", type: undefined, effective: "button", raster: true },
        { tag: "button", type: undefined, effective: "none", raster: false },
        { tag: "button", type: undefined, effective: "none", raster: false },
        { tag: "input", type: "button", effective: "push-button", raster: true },
        { tag: "input", type: "submit", effective: "none", raster: false },
        { tag: "progress", type: undefined, effective: "progress-bar", raster: true },
        { tag: "progress", type: undefined, effective: "progress-bar", raster: true },
        { tag: "progress", type: undefined, effective: "none", raster: false },
        { tag: "meter", type: undefined, effective: "meter", raster: true },
        { tag: "meter", type: undefined, effective: "none", raster: false },
        { tag: "select", type: undefined, effective: "menulist", raster: true },
        { tag: "select", type: undefined, effective: "menulist-button", raster: false },
        { tag: "input", type: "search", effective: "searchfield", raster: true },
        { tag: "input", type: "search", effective: "none", raster: false },
        { tag: "input", type: "text", effective: "none", raster: false },
        { tag: "textarea", type: undefined, effective: "none", raster: false },
        { tag: "input", type: "checkbox", effective: "checkbox", raster: true },
        { tag: "input", type: "radio", effective: "radio", raster: true },
        { tag: "input", type: "range", effective: "slider-horizontal", raster: true },
        { tag: "input", type: "checkbox", effective: "checkbox", raster: true },
        { tag: "button", type: undefined, effective: "none", raster: false },
        { tag: "button", type: undefined, effective: "base", raster: false },
        { tag: "select", type: undefined, effective: "base-select", raster: false },
      ]);
    } finally {
      await page.close();
    }
  }, 90_000);

  it("keeps default button ownership across interaction, scheme, forced colors, zoom, DPR, writing mode, and direction", async () => {
    const rows = [
      { colorScheme: "light" as const, forcedColors: "none" as const, dpr: 1, writing: "horizontal-tb", direction: "ltr" },
      { colorScheme: "dark" as const, forcedColors: "none" as const, dpr: 2, writing: "vertical-rl", direction: "rtl" },
      { colorScheme: "light" as const, forcedColors: "active" as const, dpr: 1, writing: "sideways-lr", direction: "ltr" },
    ];
    for (const row of rows) {
      const context = await env!.browser.newContext({
        viewport: { width: 320, height: 190 },
        deviceScaleFactor: row.dpr,
        colorScheme: row.colorScheme,
        forcedColors: "none",
      });
      const page = await context.newPage();
      try {
        // Measure the platform corner outside forced-colors. That independent
        // resizer probe uses a color discriminator which forced-colors is
        // allowed to replace; this ticket's matrix then changes media state
        // while retaining the same BrowserContext/platform metrics.
        await measureBlinkPlatformResizer(page);
        await page.emulateMedia({ forcedColors: row.forcedColors });
        await page.setContent(`<style>
          html,body{margin:0;color-scheme:light dark}
          button{position:absolute;left:70px;top:55px;width:150px;height:52px;
            writing-mode:${row.writing};direction:${row.direction};zoom:1.25;
            font:700 16px sans-serif;color:ButtonText;padding:5px 14px;text-shadow:none}
        </style><button id="state">state</button>`);

        const assertNative = async () => {
          const capture = await captureElementTreeWithWarnings(
            page, "body", { x: 0, y: 0, width: 320, height: 190 },
          );
          expect(capture.warnings.filter((warning) => warning.feature === "effective-appearance-cascade")).toEqual([]);
          const button = controls(capture.tree).find((node) => node.tag === "button")!;
          expect(button.styles.effectiveAppearance).toBe("button");
          expect(button.nativeControlRaster).toBeDefined();
        };

        await assertNative();
        await page.focus("#state");
        await assertNative();
        await page.hover("#state");
        await assertNative();
        await page.mouse.down();
        await assertNative();
        await page.mouse.up();
      } finally {
        await page.mouse.up().catch(() => undefined);
        await context.close();
      }
    }
  }, 120_000);
});
