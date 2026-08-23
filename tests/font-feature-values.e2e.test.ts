import { afterAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium, type CapturedElement } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const HTML = `<!doctype html><style>
@font-feature-values "Feature Oracle" {
  @stylistic { fancy: 2; }
  @styleset { display: 1 3; }
  @character-variant { open: 4 7; }
  @swash { ornate: 5; }
}
#target { font-family: "Feature Oracle", serif; font-variant-alternates:
  stylistic(fancy) styleset(display) character-variant(open) swash(ornate); }
</style><div id="target">feature oracle</div>`;

const LAYERED_HTML = `<!doctype html><style>
@layer low, high;
@layer high {
  @font-feature-values "Layer Winner" { @stylistic { fancy: 1; unioned: 3; } }
}
@layer low {
  @font-feature-values "Layer Winner" { @stylistic { fancy: 2; } }
}
@font-feature-values "Outer Winner" { @stylistic { fancy: 1; } }
@layer high { @font-feature-values "Outer Winner" { @stylistic { fancy: 2; } } }
@font-feature-values "Shadow Winner" { @stylistic { fancy: 1; } }
#target { font-family: "Layer Winner"; font-variant-alternates: stylistic(fancy); }
</style><div id="target">layer ownership</div><div id="host"></div><script>
const shadow = document.querySelector("#host").attachShadow({ mode: "open" });
shadow.innerHTML = '<style>'
  + '@font-feature-values "Shadow Winner" { @stylistic { fancy: 2; } }'
  + '@font-feature-values "Shadow Only" { @stylistic { fancy: 1; } }'
  + '</style><span>shadow</span>';
</script>`;

function find(nodes: CapturedElement[], tag: string): CapturedElement | undefined {
  for (const node of nodes) {
    if (node.tag === tag) return node;
    const nested = find(node.children, tag);
    if (nested) return nested;
  }
}

async function setup(): Promise<Awaited<ReturnType<typeof launchChromium>> | null> {
  try { return await launchChromium(); } catch { return null; }
}
const browser = await setup();
afterAll(async () => closeBrowserSafely(browser), 15_000);
const describeBrowser = browser ? describe : describe.skip;

describeBrowser("DM-2160: @font-feature-values capture", () => {
  it("retains computed alternate functions and family-scoped CSSOM aliases", async () => {
    const page = await browser!.newPage({ viewport: { width: 500, height: 120 } });
    try {
      await page.setContent(HTML);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 500, height: 120 });
      const target = find(tree, "div")!;
      expect(target.styles.fontVariantAlternates).toContain("stylistic(fancy)");
      expect(target.styles.fontFeatureValues?.["feature oracle"]).toMatchObject({
        stylistic: { fancy: [2] }, styleset: { display: [1, 3] },
        characterVariant: { open: [4, 7] }, swash: { ornate: [5] },
      });
    } finally { await page.close(); }
  });

  it("captures Blink layer priority and document-only TreeScope ownership", async () => {
    const page = await browser!.newPage({ viewport: { width: 500, height: 120 } });
    try {
      await page.setContent(LAYERED_HTML);
      const tree = await captureElementTree(page, "#target", { x: 0, y: 0, width: 500, height: 120 });
      const target = find(tree, "div")!;
      expect(target.styles.fontFeatureValues?.["layer winner"]?.stylistic).toEqual({
        fancy: [1],
        unioned: [3],
      });
      expect(target.styles.fontFeatureValues?.["outer winner"]?.stylistic)
        .toEqual({ fancy: [1] });
      expect(target.styles.fontFeatureValues?.["shadow winner"]?.stylistic)
        .toEqual({ fancy: [1] });
      expect(target.styles.fontFeatureValues?.["shadow only"]).toBeUndefined();
    } finally { await page.close(); }
  });
});
