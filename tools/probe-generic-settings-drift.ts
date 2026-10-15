// Watch a Chromium Page's generic font families for a mid-session reset.
//
// A Page's `serif` / `sans-serif` / `monospace` come from Playwright's per-page
// `Page.setFontFamilies` overlay on top of Chromium's WebPreferences. Any
// browser-side WebPreferences push re-applies the WebPreferences maps and
// replaces the overlay (doc 198). Hosted macOS runners have shown that reset
// with no screenshot involved, so this probe holds Pages idle and samples them,
// to say WHEN the reset happens and under which activity.
//
// Arms, each in its own browser so one cannot trigger another:
//   idle      one persistent CDP observer, nothing else
//   attach    plus a fresh CDP session attached and detached every interval
//   capture   plus a full `captureElementTree` every interval
//
// Every result line is prefixed `GENDRIFT` for reading out of a CI job log.
// Usage: npx tsx tools/probe-generic-settings-drift.ts [--minutes 5] [--interval 2]
import type { CDPSession, Page } from "@playwright/test";
import { captureElementTree, launchChromium } from "../src/index.js";

const args = process.argv.slice(2);
const option = (name: string, fallback: number): number => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? Number(args[index + 1]) : fallback;
};
const minutes = option("minutes", 5);
const intervalMs = option("interval", 2) * 1000;
const arms = ["idle", "attach", "capture"] as const;
type Arm = (typeof arms)[number];

const log = (arm: Arm, message: string): void => {
  console.log(`GENDRIFT ${new Date().toISOString()} ${arm.padEnd(7)} ${message}`);
};

let probeCount = 0;
async function paintedFamilies(page: Page, cdp: CDPSession): Promise<string> {
  const id = `drift-${++probeCount}`;
  await page.evaluate((spanId) => {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<span id="${spanId}"><span style="font-family:sans-serif">Abc</span>` +
        `<span style="font-family:serif">Abc</span><span style="font-family:monospace">Abc</span></span>`,
    );
    return document.getElementById(spanId)?.getBoundingClientRect().width;
  }, id);
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: `#${id} > span` });
  const faces: string[] = [];
  for (const nodeId of nodeIds) {
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    faces.push(fonts[0]?.postScriptName || fonts[0]?.familyName || "?");
  }
  await page.evaluate((spanId) => document.getElementById(spanId)?.remove(), id);
  return faces.join("/");
}

async function runArm(arm: Arm): Promise<{ arm: Arm; samples: number; flips: number }> {
  const browser = await launchChromium();
  try {
    const ctx = await browser.newContext({ viewport: { width: 400, height: 300 } });
    const page = await ctx.newPage();
    await page.setContent(`<html lang="en"><body style="margin:0"><p>drift probe</p></body></html>`);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    let previous = await paintedFamilies(page, cdp);
    log(arm, `start ${previous}`);
    let samples = 1;
    let flips = 0;
    const deadline = Date.now() + minutes * 60_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      if (arm === "attach") {
        const extra = await ctx.newCDPSession(page);
        await extra.send("Runtime.evaluate", { expression: "1" });
        await extra.detach();
      } else if (arm === "capture") {
        await captureElementTree(page, "body", { x: 0, y: 0, width: 400, height: 300 });
      }
      const current = await paintedFamilies(page, cdp);
      samples++;
      if (current !== previous) {
        flips++;
        log(arm, `FLIP after ${samples} samples: ${previous} -> ${current}`);
        previous = current;
      }
    }
    log(arm, `end ${previous} samples=${samples} flips=${flips}`);
    return { arm, samples, flips };
  } finally {
    await browser.close();
  }
}

const results = await Promise.all(arms.map((arm) => runArm(arm)));
console.log(`GENDRIFT summary ${JSON.stringify(results)}`);
