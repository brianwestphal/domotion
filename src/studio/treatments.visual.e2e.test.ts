import { createHash } from "node:crypto";
import type { Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../capture/index.js";
import { applyStudioTreatments } from "./treatments.js";

const BASE = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" fill="#0f172a"/><rect x="52" y="42" width="216" height="96" rx="16" fill="#2563eb"/></svg>`;
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20" fill="#f59e0b"/></svg>`;
const examples = [
  { kind: "device-frame", device: "phone" },
  { kind: "browser-chrome", label: "studio.local" },
  { kind: "terminal-chrome", title: "Build" },
  { kind: "zoom-pan", transform: { from: { x: 0, y: 0 }, to: { x: -20, y: -10, scale: 1.2 } } },
  { kind: "spotlight", mask: { region: { x: 52, y: 42, width: 216, height: 96 } } },
  { kind: "callout", text: "Primary action", anchor: { x: 100, y: 80 }, box: { x: 170, y: 112, width: 130, height: 44 } },
  { kind: "title-card", title: "Ship clearly", subtitle: "A cinematic story" },
  { kind: "logo-reveal", logo: LOGO, width: 90 },
] as const;

describe("Studio treatment rendered examples", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await launchChromium(); });
  afterAll(async () => { await browser?.close(); });

  it("renders every preset deterministically in Chromium at a fixed animation time", async () => {
    const page = await browser.newPage({ viewport: { width: 500, height: 400 } });
    try {
      for (const treatment of examples) {
        const rendered = applyStudioTreatments(BASE, [treatment], {
          brand: { palette: { primary: "#f59e0b", accent: "#38bdf8", background: "#111827", text: "#f8fafc" } },
        });
        await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${rendered.svg}`);
        await page.evaluate(async () => {
          for (const animation of document.getAnimations()) {
            animation.pause();
            animation.currentTime = 400;
          }
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        });
        const target = page.locator("svg").first();
        await target.screenshot({ animations: "allow" }); // Warm decoded SVG-image resources.
        const first = await target.screenshot({ animations: "allow" });
        const second = await target.screenshot({ animations: "allow" });
        expect(first.length, treatment.kind).toBeGreaterThan(500);
        expect(createHash("sha256").update(first).digest("hex"), treatment.kind)
          .toBe(createHash("sha256").update(second).digest("hex"));
      }
    } finally {
      await page.close();
    }
  });
});
