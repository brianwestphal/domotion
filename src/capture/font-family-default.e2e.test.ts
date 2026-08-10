import { afterAll, describe, expect, it } from "vitest";
import { launchChromium, captureElementTree, type CapturedElement } from "../index.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";

// DM-2051: an element with NO author-declared font-family is a Blink
// kStandardFamily description that resolves through settings.Standard(script)
// (`platform/fonts/font_selector.cc:71-75`, rev 7d859f27) — script-keyed, so a
// `lang=ja` element with no declared family paints the Japanese standard face
// for the whole run even though getComputedStyle().fontFamily serializes to the
// concrete standard name ("Times"). Capture cannot tell that apart from a
// declared `font-family: Times` (identical computed string) by the string
// alone, so it detects the UA-default case and rewrites the captured family to
// the `-webkit-standard` generic keyword — which the renderer's
// matchFamilyNameToKey("-webkit-standard", true, lang) routes script-keyed.
//
// Ground truth for every scenario below was measured against Chrome via CDP
// CSS.getPlatformFontsForNode (tools/scratch/dm2051-standard-family-probe.mjs):
// the "rewritten" rows are the ones Chrome paints as the Japanese standard face
// for the WHOLE run; the "untouched" rows are the ones Chrome paints with the
// concrete Latin family for Latin and only falls back for CJK. Detection is
// lang-independent (it is about declaredness), so the scenarios carry unique
// ASCII text purely so the test can locate each captured node.

const W = 400, H = 500;

const HTML =
  `<!doctype html><html><head><meta charset="utf-8">` +
  `<style>.rule-concrete{font-family:Verdana}</style></head><body>` +
  // UA-default (no declared family anywhere) — MUST rewrite.
  `<p lang="ja">undeclared-ja</p>` +
  `<p lang="en">undeclared-en</p>` +
  // Declared concrete family — MUST NOT rewrite (same computed string as undeclared).
  `<p lang="ja" style="font-family:Times">declared-times</p>` +
  // Declared via the `font` shorthand (computed first family is concrete) — MUST NOT.
  `<p lang="ja" style="font:16px Georgia">via-shorthand</p>` +
  // Declared concrete family on an ANCESTOR (font-family inherits) — MUST NOT.
  `<div style="font-family:'Courier New'"><p lang="ja">via-ancestor</p></div>` +
  // Declared via an author RULE — MUST NOT.
  `<p class="rule-concrete" lang="ja">via-rule</p>` +
  // `<font face>` presentation attribute — MUST NOT.
  `<font face="Times" lang="ja">via-fontface</font>` +
  // Declared GENERIC keyword — already routed script-keyed by the declared path;
  // the concrete-name test excludes it, so it is left as the generic keyword.
  `<p lang="ja" style="font-family:sans-serif">declared-generic</p>` +
  // UA monospace (pre) — computed serializes to the `monospace` keyword, not a
  // concrete name, so it too is left untouched by this detection.
  `<pre lang="ja">ua-monospace</pre>` +
  // Form control — UA `font: -webkit-small-control` is a CONCRETE system font
  // ("Arial"), not kStandardFamily; must NOT be rewritten, and neither must a
  // descendant that inherits the control font.
  `<button lang="ja">form-button</button>` +
  `<button lang="ja"><span>button-child</span></button>` +
  `</body></html>`;

interface Node { text?: string; styles?: Record<string, string | undefined>; children?: Node[] }

function findByText(nodes: Node[], text: string): Node | undefined {
  for (const n of nodes) {
    if (typeof n.text === "string" && n.text.trim() === text) return n;
    if (n.children) {
      const inner = findByText(n.children, text);
      if (inner) return inner;
    }
  }
  return undefined;
}

function familyOf(tree: CapturedElement[], text: string): string | undefined {
  return findByText(tree as unknown as Node[], text)?.styles?.fontFamily;
}

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

describeBrowser("DM-2051: capture rewrites UA-default font-family to -webkit-standard", () => {
  let tree: CapturedElement[];

  it("captures the scenario page", async () => {
    const { browser } = env!;
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      await page.setContent(HTML, { waitUntil: "load" });
      tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
    } finally {
      await page.close();
    }
    expect(tree.length).toBeGreaterThan(0);
  });

  it("rewrites a genuinely-undeclared family to -webkit-standard (ja and en alike)", () => {
    expect(familyOf(tree, "undeclared-ja")).toBe("-webkit-standard");
    // The rewrite is lang-independent (declaredness); the renderer applies the
    // per-script routing, so lang=en → the Latin standard downstream.
    expect(familyOf(tree, "undeclared-en")).toBe("-webkit-standard");
  });

  it("leaves a DECLARED concrete family untouched (no double-standard)", () => {
    // Identical computed string to the undeclared case; the detection must
    // distinguish them via the cascade, not the string.
    expect(familyOf(tree, "declared-times")).toBe("Times");
  });

  it("detects the `font` shorthand as a declaration", () => {
    expect(familyOf(tree, "via-shorthand")).toBe("Georgia");
  });

  it("detects a concrete family declared on an ANCESTOR (font-family inherits)", () => {
    const ff = familyOf(tree, "via-ancestor");
    expect(ff).not.toBe("-webkit-standard");
    expect(ff).toContain("Courier New");
  });

  it("detects a family set by an author RULE, not just inline styles", () => {
    expect(familyOf(tree, "via-rule")).toBe("Verdana");
  });

  it("detects the `<font face>` presentation attribute", () => {
    expect(familyOf(tree, "via-fontface")).toBe("Times");
  });

  it("leaves a declared GENERIC keyword as-is (already routed script-keyed)", () => {
    expect(familyOf(tree, "declared-generic")).toBe("sans-serif");
  });

  it("leaves a UA generic (pre → monospace keyword) untouched", () => {
    expect(familyOf(tree, "ua-monospace")).toBe("monospace");
  });

  it("does NOT flag a form control (UA system font is concrete, not standard)", () => {
    // A control's `font: -webkit-small-control` is a concrete system font, not
    // the standard initial value — Chrome does not route it script-keyed.
    expect(familyOf(tree, "form-button")).not.toBe("-webkit-standard");
    // A descendant inherits the control font, so it must not be flagged either.
    expect(familyOf(tree, "button-child")).not.toBe("-webkit-standard");
  });
});
