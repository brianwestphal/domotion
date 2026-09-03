import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { preparePseudoFragmentGeometry } from "./pseudo-fragment-cdp.js";
import type { CapturedPseudoFragmentSet } from "./types.js";

describe("DM-2467 source-owned pseudo fragment capture", () => {
  it("keeps generated URL image paint at intrinsic size when the pseudo layout slot is smaller", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 360, height: 240 } });
    const dir = await mkdtemp(path.join(tmpdir(), "domotion-pseudo-image-"));
    try {
      await Promise.all([
        writeFile(path.join(dir, "asset.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="orange"/></svg>'),
        writeFile(path.join(dir, "fixture.html"), '<style>body{margin:0}#host{font:16px/24px Arial}#host::before{content:url("asset.svg");display:inline-block;width:24px;height:24px;vertical-align:middle}</style><p id="host">text</p>'),
      ]);
      await page.goto(pathToFileURL(path.join(dir, "fixture.html")).href);
      const probe = await preparePseudoFragmentGeometry(page, "body", { x: 0, y: 0, width: 360, height: 240 });
      try {
        const record = await page.evaluate((key) => {
          const registry = (globalThis as typeof globalThis & Record<string, unknown>)[key] as {
            factsByElement: Record<string, CapturedPseudoFragmentSet[]>;
          };
          return Object.values(registry.factsByElement).flat().find((entry) =>
            entry.pseudo === "::before");
        }, probe.key);
        expect(record).toMatchObject({
          status: "terminal-raster",
          reason: "generated URL image intrinsic paint exceeds its pseudo layout slot",
        });
        expect(record?.terminalRaster?.dataUri).toMatch(/^data:image\/png;base64,/);
        expect(record?.terminalRaster?.rect.width).toBeCloseTo(128, 0);
        expect(record?.terminalRaster?.rect.height).toBeCloseTo(128, 0);
      } finally {
        await probe.dispose();
      }
    } finally {
      await browser.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("retains ordered Blink records across generated-content controls", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 760, height: 640 } });
    try {
      await page.setContent(`<!doctype html><style>
        *{box-sizing:border-box}body{margin:0;font:16px/24px Arial,sans-serif}
        #root{padding:20px;width:700px}.probe{width:150px;margin:8px;border:1px solid transparent}
        #astral::before{content:"A😀 אבג";unicode-bidi:isolate;direction:rtl}
        #after::after{content:" tail";font:italic 700 17px/29px Georgia,serif}
        #mixed::before{content:"left" url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='9' height='7'%3E%3Crect width='9' height='7' fill='red'/%3E%3C/svg%3E") "right"}
        #vertical{writing-mode:vertical-rl;height:110px}#vertical::before{content:"縦A";border-inline:2px solid;padding-inline:3px}
        #fragmented{width:360px;height:92px;columns:3;column-gap:24px;column-fill:auto;line-height:18px}#fragmented::after{content:"one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four";box-decoration-break:clone;border:1px solid;padding:2px}
        #transformed{transform:translate(11px,7px) rotate(4deg)}#transformed::before{content:"matrix"}
      </style><main id="root">
        <div class="probe" id="astral">host</div><div class="probe" id="after">host</div>
        <div class="probe" id="mixed"></div><div class="probe" id="vertical"></div>
        <div class="probe" id="fragmented"></div><div class="probe" id="transformed"></div>
      </main>`);
      await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
      const probe = await preparePseudoFragmentGeometry(page, "#root", { x: 0, y: 0, width: 760, height: 640 });
      try {
        const records = await page.evaluate((key) => {
          const registry = (globalThis as typeof globalThis & Record<string, unknown>)[key] as {
            factsByElement: Record<string, CapturedPseudoFragmentSet[]>;
          };
          return Object.values(registry.factsByElement).flat();
        }, probe.key);
        expect(records).toHaveLength(6);
        expect(records.every((record) => record.source === "blink-pseudo-fragment-v1")).toBe(true);
        expect(records.map((record) => `${record.pseudo}:${record.status}:${record.reason ?? ""}`)).toEqual([
          "::before:exact:", "::after:exact:", "::before:exact:",
          "::before:exact:", "::after:exact:", "::before:exact:",
        ]);
        expect(records.find((record) => record.contentItems.some((item) => item.kind === "image"))?.contentItems.map((item) => item.kind)).toEqual(["text", "image", "text"]);
        expect(records.flatMap((record) => record.fragments).some((fragment) => fragment.kind === "text" && fragment.text.includes("😀"))).toBe(true);
        const astral = records.find((record) => record.fragments.some((fragment) =>
          fragment.kind === "text" && fragment.text.includes("😀")));
        expect(astral?.bitmapTextRaster).toMatchObject({
          source: "chromium-selected-bitmap-pseudo-text",
          isolated: true,
        });
        expect(astral?.bitmapTextRaster?.dataUri).toMatch(/^data:image\/png;base64,/);
        expect(astral?.bitmapTextRaster?.representations.length).toBeGreaterThan(0);
        expect(records.filter((record) => record.fragments.some((fragment) => fragment.kind === "text"))
          .every((record) => record.typography.resolvedFonts.length > 0)).toBe(true);
        expect(records.find((record) => record.writingMode === "vertical-rl")?.fragments.some((fragment) => fragment.kind === "text" && fragment.baseline.origin.x === fragment.baseline.end.x)).toBe(true);
        expect(records.flatMap((record) => record.boxFragments).some((fragment) =>
          Math.abs(fragment.physicalQuad[0].y - fragment.physicalQuad[1].y) > 0.1)).toBe(true);
        expect(await page.locator("[data-domotion-pseudo-target],[data-domotion-pseudo-ancestor]").count()).toBe(0);
        expect(probe.warnings).toEqual([]);
      } finally {
        await probe.dispose();
      }
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("fails an ambiguous protocol pairing closed to one isolated pseudo surface", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 360, height: 180 } });
    try {
      await page.setContent(`<!doctype html><style>
        html,body{margin:0;background:transparent}#root{padding:12px}#ambiguous{font:16px/18px Arial}
        #ambiguous::after{content:"protocol boundary";color:#1256a0;background:rgba(250,190,20,.4);border:1px solid;padding:2px}
      </style><main id="root"><div id="ambiguous"></div></main>`);
      const context = page.context();
      const newSession = context.newCDPSession.bind(context);
      context.newCDPSession = async () => { throw new Error("forced protocol unavailability"); };
      const probe = await preparePseudoFragmentGeometry(page, "#root", { x: 0, y: 0, width: 360, height: 180 });
      context.newCDPSession = newSession;
      try {
        const record = await page.evaluate((key) => {
          const registry = (globalThis as typeof globalThis & Record<string, unknown>)[key] as {
            factsByElement: Record<string, CapturedPseudoFragmentSet[]>;
          };
          return Object.values(registry.factsByElement).flat()[0];
        }, probe.key);
        expect(record).toMatchObject({ source: "blink-pseudo-fragment-v1", pseudo: "::after", status: "terminal-raster" });
        expect(record.terminalRaster?.isolated).toBe(true);
        expect(record.terminalRaster?.dataUri).toMatch(/^data:image\/png;base64,/);
        expect(record.terminalRaster?.rect.width).toBeGreaterThan(0);
        expect(record.fragments).toEqual([]);
        expect(probe.warnings).toHaveLength(1);
        expect(probe.warnings[0].detail).toContain("isolated Chromium-painted pseudo surface");
        expect(await page.locator("[data-domotion-pseudo-target],[data-domotion-pseudo-ancestor]").count()).toBe(0);
      } finally {
        await probe.dispose();
      }
    } finally {
      await browser.close();
    }
  }, 30_000);
});
