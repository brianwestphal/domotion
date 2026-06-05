import { afterAll, describe, expect, it } from "vitest";
import { launchChromium, captureElementTree, type CapturedElement } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-1105: an in-flow `::before` text marker (a code-diff "+" gutter) on a host
// whose content begins with a CHILD element — `<span class="code"><span
// class="kw">function</span> run</span>` with `.code::before { content: "+" }`.
// The pseudo-injection re-anchor (pseudo-inject.ts) flushed the marker against
// the host's first OWN text segment (` run`), which sits AFTER the leading
// `function` token span — so the "+" landed mid-line instead of at the line
// start. Chrome paints a static ::before at the host's content-box left and
// shifts ALL following content (child spans included) right. The fix clamps the
// flush anchor so the marker never moves right of the content-box left.
//
// This is a deterministic capture-level guard: the perceptual visual-diff gate
// in features.ts is too lenient on a thin green marker to catch the ~110px shift
// reliably, so we assert the captured segment x directly.

const W = 320, H = 80;
const PAD = 20;
const HTML =
  `<!doctype html><html><head><meta charset="utf-8"><style>` +
  `body{margin:0;background:#0d1117}` +
  `.wrap{padding:${PAD}px}` +
  `.code{position:relative;display:block;white-space:pre;font:22px/30px monospace;color:#c9d1d9}` +
  `.code::before{content:"+";color:#3fb950}` +
  `.kw{color:#ff7b72}` +
  `</style></head><body><div class="wrap">` +
  `<div class="code"><span class="kw">function</span> run</div>` +
  `</div></body></html>`;

async function setup() {
  try {
    const browser = await launchChromium();
    return { browser };
  } catch {
    return null;
  }
}

const env = await setup();
afterAll(async () => {
  await closeBrowserSafely(env?.browser);
}, 15_000);

const describeBrowser = env ? describe : describe.skip;

function walk(nodes: CapturedElement[], cb: (n: CapturedElement) => void): void {
  for (const n of nodes) {
    cb(n);
    if (n.children) walk(n.children as CapturedElement[], cb);
  }
}

describeBrowser("DM-1105: in-flow ::before marker before a child-first line", () => {
  it("anchors the '+' gutter at the host content-box left, not after the leading token", async () => {
    const { browser } = env!;
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      await page.setContent(HTML, { waitUntil: "load" });
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });

      // The `.code` host: ::before "+" text is concatenated onto the host text,
      // so its captured `text` begins with "+".
      let host: CapturedElement | null = null;
      walk(tree, (n) => {
        if (host == null && typeof n.text === "string" && n.text.startsWith("+") && n.text.includes("run")) host = n;
      });
      expect(host, "found the .code host with the '+' ::before").not.toBeNull();
      const h = host!;

      const segs = (h.textSegments ?? []) as Array<{ text?: string; x: number }>;
      const plus = segs.find((s) => (s.text ?? "").trim() === "+");
      const own = segs.find((s) => (s.text ?? "").includes("run"));
      expect(plus, "captured a '+' segment").toBeTruthy();
      expect(own, "captured the host's own ' run' segment").toBeTruthy();

      // The host content-box left is its x (no padding/border on .code itself);
      // the panel padding puts it at ~PAD. The marker must sit at the line start
      // (within a few px for the pseudo's own metrics), NOT after the leading
      // `function` token span (which would place it ~100px+ to the right, near
      // the host's own ` run` segment).
      expect(plus!.x).toBeLessThan(h.x + 12);
      expect(plus!.x).toBeGreaterThan(h.x - 6);
      // And unambiguously to the LEFT of the host's own text run (the bug put it
      // immediately left of `own`, i.e. only ~one glyph-width apart).
      expect(own!.x - plus!.x).toBeGreaterThan(40);
    } finally {
      await page.close();
    }
  }, 60_000);
});
