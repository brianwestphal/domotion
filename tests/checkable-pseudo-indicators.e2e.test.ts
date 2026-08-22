import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";

import { captureElementTreeWithWarnings } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { checkablePseudoFactsOwnIndicator, renderFormControl } from "../src/render/form-controls.js";

function flatten(tree: CapturedElement[]): CapturedElement[] {
  return tree.flatMap((element) => [element, ...flatten(element.children ?? [])]);
}

describe("DM-2459 source-owned checkable indicators", () => {
  it("routes none/base pseudos exactly and keeps native auto on Chromium ownership", async () => {
    const browser = await chromium.launch({ headless: true, args: ["--enable-blink-features=AppearanceBase"] });
    const page = await browser.newPage({ viewport: { width: 520, height: 220 }, deviceScaleFactor: 2 });
    try {
      await page.setContent(`<!doctype html><style>
        body{margin:0;padding:20px;background:white}.row{display:flex;gap:17px;align-items:center}
        .none{appearance:none;box-sizing:border-box;width:25px;height:25px;margin:0;border:2px solid #a01477}
        #before::before{content:"";display:block;width:11px;height:11px;margin:5px;background:#cf009f;border-radius:50%;transform:rotate(17deg)}
        #after::after{content:"✓";display:block;color:#cf009f;font:700 16px/20px Arial}
        #base{appearance:base;color:#cf009f;font-size:26px}
        #base::checkmark{content:"◆" / "";color:#cf009f;transform:translate(1px,-1px)}
      </style><main id="scene" class="row">
        <input data-domotion-anim="before" id="before" class="none" type="radio" checked>
        <input data-domotion-anim="after" id="after" class="none" type="checkbox" checked>
        <input data-domotion-anim="empty" id="empty" class="none" type="checkbox">
        <input data-domotion-anim="base" id="base" type="checkbox" checked>
        <input data-domotion-anim="auto" id="auto" type="radio" checked>
      </main>`);
      const result = await captureElementTreeWithWarnings(page, "#scene", { x: 0, y: 0, width: 520, height: 220 });
      const byId = new Map(flatten(result.tree).filter((element) => element.animId != null).map((element) => [element.animId!, element]));

      expect(byId.get("before")?.pseudoFragments?.map((record) => record.pseudo)).toEqual(["::before"]);
      expect(byId.get("after")?.pseudoFragments?.map((record) => record.pseudo)).toEqual(["::after"]);
      expect(byId.get("empty")?.pseudoFragments).toEqual([]);
      expect(byId.get("base")?.pseudoFragments?.map((record) => record.pseudo)).toEqual(["::checkmark"]);
      for (const id of ["before", "after", "empty", "base"]) {
        const element = byId.get(id)!;
        expect(checkablePseudoFactsOwnIndicator(element)).toBe(true);
        expect(renderFormControl(element, "")).toBe("");
      }

      const native = byId.get("auto")!;
      expect(checkablePseudoFactsOwnIndicator(native)).toBe(false);
      expect(native.nativeControlRaster).toBeDefined();
      const svg = elementTreeToSvg(result.tree, 520, 220);
      expect(svg).toContain('data-domotion-pseudo-owner="source-fragments"');
      expect(svg).toContain(`href="${native.nativeControlRaster!.dataUri}"`);
      expect(result.warnings.filter((warning) => warning.feature === "generated-pseudo-fragment-geometry")).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
