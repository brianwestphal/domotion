import { afterAll, describe, expect, it } from "vitest";
import { captureElementTree, elementTreeToSvg, launchChromium } from "../src/index.js";
import { withFlattenNestedSvg } from "../src/render/svg-inline.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-97E2CN: SVG text presentation set by the page cascade (a `font-family:
// var(--token)` on the <svg>, class-driven font-size / weight / anchor on the
// <text>) must survive re-embedding, in both the nested-<svg> output and the
// `--flatten-nested-svg` output, where the root <svg> becomes a <g>.
const browser = await launchChromium();
afterAll(async () => closeBrowserSafely(browser), 15_000);

const PAGE = `<!doctype html><style>
  :root{--sans: Helvetica, Arial, sans-serif}
  html,body{margin:0}
  body{font-family:Georgia, serif;font-size:14px}
  svg.gauge{font-family:var(--sans);fill:rgb(200, 0, 0)}
  .value{text-anchor:middle;font-size:22px;font-weight:700}
  .unit{font-size:11px;font-style:italic;letter-spacing:2px}
</style><div id="frame"><svg class="gauge" viewBox="0 0 100 60" width="200" height="120"><text class="value" x="50" y="30">72<tspan class="unit">km</tspan></text></svg></div>`;

function openingTag(markup: string, name: string): string {
  const match = new RegExp(`<${name}(?=[\\s/>])[^>]*>`).exec(markup);
  expect(match, `<${name}> present`).not.toBeNull();
  return match![0];
}

describe("inline SVG text presentation survives re-embedding (DM-97E2CN)", () => {
  it.each([false, true])(
    "flatten-nested-svg=%s",
    async (flatten) => {
      const context = await browser.newContext({ viewport: { width: 240, height: 160 } });
      const page = await context.newPage();
      try {
        await page.setContent(PAGE);
        const tree = await captureElementTree(page, "#frame", { x: 0, y: 0, width: 240, height: 160 });
        const output = withFlattenNestedSvg(flatten, () => elementTreeToSvg(tree, 240, 160));

        // The root's baked family and fill reach the output root (the nested
        // <svg>, or the flattened <g> that replaces it).
        const root = flatten ? openingTag(output, 'g class="gauge"') : openingTag(output, 'svg class="gauge"');
        expect(root).toContain('font-family="Helvetica, Arial, sans-serif"');
        expect(root).toContain('fill="rgb(200, 0, 0)"');
        if (flatten) {
          expect(output).not.toContain('<svg class="gauge"');
          expect(root).toMatch(/transform="matrix\(/);
          expect(root).not.toMatch(/\s(?:viewBox|width|height)=/);
        }

        const text = openingTag(output, "text");
        expect(text).toContain("font-family: Helvetica, Arial, sans-serif");
        expect(text).toContain("font-size: 22px");
        expect(text).toContain("font-weight: 700");
        expect(text).toContain("text-anchor: middle");
        // Keyword form, so the flatten safety check does not see a viewport `%`.
        expect(text).toContain("font-stretch: normal");

        // The tspan carries only what differs from its <text>.
        const tspan = openingTag(output, "tspan");
        expect(tspan).toContain("font-size: 11px");
        expect(tspan).toContain("font-style: italic");
        expect(tspan).toContain("letter-spacing: 2px");
        expect(tspan).not.toContain("font-family:");
        expect(tspan).not.toContain("text-anchor:");
      } finally {
        await context.close();
      }
    },
    60_000,
  );
});
