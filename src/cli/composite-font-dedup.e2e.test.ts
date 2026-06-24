import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { launchChromium } from "../capture/index.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";
import { composeCompositeConfig } from "./composite.js";

/**
 * DM-1331 regression guard: several `cast` layers that use the same monospace
 * must embed it ONCE. `composeCompositeConfig` renders all cast layers through a
 * shared embedded-font builder (`manageFonts:false` → `getEmbeddedFontFaceCss()`),
 * so two terminals with DIFFERENT text (different glyph subsets) share one
 * (union-subset) `@font-face` set — which the per-payload dedup (DM-1329) could
 * not merge. Without the shared builder the count would scale with the number of
 * cast layers.
 */

const E = "\x1b";
const ev = (t: number, d: string): string => JSON.stringify([t, "o", d]);
const castOf = (lines: string[]): string =>
  [JSON.stringify({ version: 2, width: 40, height: 6, title: "c" }), ...lines.map((l, i) => ev(0.5 + i, `${l}\r\n`)), ev(5, "")].join("\n");

// Two casts in the SAME monospace but DIFFERENT text → different glyph subsets.
const CAST_A = castOf([`${E}[32malpha bravo${E}[0m`, `${E}[33mcharlie${E}[0m`]);
const CAST_B = castOf([`${E}[36mdelta echo${E}[0m`, `${E}[1mfoxtrot golf${E}[0m`]);

const countFontFaces = (svg: string): number => (svg.match(/@font-face/g) ?? []).length;

async function setup() {
  try {
    return { browser: await launchChromium() };
  } catch {
    return null;
  }
}
const env = await setup();
afterAll(async () => {
  await closeBrowserSafely(env?.browser);
}, 15_000);

const describeBrowser = env ? describe : describe.skip;

describeBrowser("composite cross-layer font dedup (DM-1331)", () => {
  it("two cast layers with different text share one embedded-font set", async () => {
    const { browser } = env!;
    const dir = mkdtempSync(join(tmpdir(), "dm-composite-"));
    writeFileSync(join(dir, "a.cast"), CAST_A);
    writeFileSync(join(dir, "b.cast"), CAST_B);

    const svg = await composeCompositeConfig(
      browser,
      {
        width: 400, height: 400,
        layers: [
          { cast: "a.cast", term: { mode: "incremental", theme: "dark" }, x: 0, y: 0 },
          { cast: "b.cast", term: { mode: "incremental", theme: "dark" }, x: 0, y: 200 },
        ],
      },
      dir,
    );

    // Shared: the font-face count is per-variant, NOT per cast layer.
    const faces = countFontFaces(svg);
    expect(faces).toBeGreaterThan(0);
    expect(faces).toBeLessThanOrEqual(8);
    // Both layers' families are un-prefixed `dmfN` (no `c0_`/`c1_` font prefix),
    // resolving against the single shared block — no dangling references.
    const faceFamilies = new Set([...svg.matchAll(/@font-face[^}]*font-family:\s*"([^"]+)"/g)].map((m) => m[1]));
    const refFamilies = new Set([...svg.matchAll(/font-family[:=]\s*"(c?\d*_?dmf\d+)"/g)].map((m) => m[1]));
    for (const ref of refFamilies) expect(faceFamilies, `dangling font ref ${ref}`).toContain(ref);
    expect([...faceFamilies].every((f) => /^dmf\d+$/.test(f))).toBe(true);
  });
});
