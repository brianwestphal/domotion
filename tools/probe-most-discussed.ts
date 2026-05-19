/**
 * Probe: dump the slashdot carousel "Most Discussed" header structure to
 * understand how the visible underline is styled.
 */
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });
  await context.routeFromHAR(resolve(CACHE_DIR, "slashdot-mobile.har"), { url: "**/*", notFound: "fallback" });
  const page = await context.newPage();
  await page.goto("https://slashdot.org/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  // Check pseudo-element ::before / ::after content for Most Discussed.
  const pseudos = await page.evaluate(() => {
    const out: any[] = [];
    // Walk every element, check ::before and ::after content for "Most Discussed".
    for (const el of Array.from(document.querySelectorAll("*"))) {
      for (const pseudo of ["::before", "::after"] as const) {
        const cs = getComputedStyle(el, pseudo);
        const content = cs.content;
        if (content != null && content !== "none" && content !== "normal" && content.includes("Most Discussed")) {
          const r = el.getBoundingClientRect();
          out.push({
            tag: el.tagName,
            cls: (el as HTMLElement).className?.toString?.(),
            pseudo,
            content,
            rect: { x: r.left, y: r.top, w: r.width, h: r.height },
            display: cs.display,
            fontStyle: cs.fontStyle,
            textDecoration: cs.textDecoration,
            textDecorationLine: cs.textDecorationLine,
            textDecorationColor: cs.textDecorationColor,
            textDecorationStyle: cs.textDecorationStyle,
            textDecorationThickness: cs.textDecorationThickness,
            borderBottom: cs.borderBottom,
            borderBottomWidth: cs.borderBottomWidth,
            position: cs.position,
            top: cs.top,
            left: cs.left,
            width: cs.width,
            height: cs.height,
            // The CSS source of the rule that set the content (if reachable).
            // We can read the matched rules via getMatchedCSSRules? Not standard.
          });
        }
      }
    }
    return out;
  });
  console.log("=== Pseudo-elements containing 'Most Discussed' ===");
  for (const p of pseudos) console.log(JSON.stringify(p));

  const dump = await page.evaluate(() => {
    const carousel = document.body;
    if (carousel == null) return { html: null, walks: [] as any[] };
    const html = "";
    const walks: any[] = [];
    const tw = document.createTreeWalker(carousel, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = tw.nextNode()) != null) {
      const t = n.nodeValue?.trim() ?? "";
      if (t.includes("Most Discussed")) {
        const ancestry: any[] = [];
        let p: Element | null = (n as Text).parentElement;
        for (let i = 0; i < 8 && p != null; i++) {
          const cs = getComputedStyle(p);
          const r = p.getBoundingClientRect();
          ancestry.push({
            tag: p.tagName,
            cls: (p as HTMLElement).className,
            rect: { x: r.left, y: r.top, w: r.width, h: r.height },
            fontStyle: cs.fontStyle,
            fontWeight: cs.fontWeight,
            textDecoration: cs.textDecoration,
            textDecorationLine: cs.textDecorationLine,
            borderBottom: cs.borderBottom,
            display: cs.display,
            visibility: cs.visibility,
          });
          p = p.parentElement;
        }
        walks.push({ text: t, ancestry });
      }
    }
    return { html, walks };
  });
  console.log("=== #carousel innerHTML (first 3000) ===");
  console.log(dump.html);
  console.log("\n=== Walks for 'Most Discussed' ===");
  for (const w of dump.walks) {
    console.log("TEXT:", JSON.stringify(w.text));
    for (const a of w.ancestry) console.log("  ", JSON.stringify(a));
    console.log("");
  }

  await browser.close();
}
void main();
