import type { Browser, Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/capture/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-F42BPG native contract: which layout objects are eligible for paint and
// layout containment, and what read-only native fact can answer it for
// source-specific replaced, control and SVG owners.
//
// Source (Chromium 7d859f27): `LayoutObject::IsEligibleForPaintOrLayoutContainment`
// is false by default (core/layout/layout_object.h:621-624), true for every
// LayoutBox (layout_box.h:1178-1181) and false again for table rows, sections
// and columns (table/layout_table_row.h:95, layout_table_section.h:89,
// layout_table_column.h:87). LayoutReplaced (images in every load state,
// video, canvas, iframe, object), LayoutSVGRoot (a LayoutReplaced), and
// LayoutSVGBlock (foreignObject, SVG text) are LayoutBoxes. LayoutInline,
// LayoutText and LayoutSVGModelObject (inner <svg>, <g>, shapes) are not.
//
// `LayoutObject::IsStackingContext` is
// `IsStackingContextWithoutContainment() || ((contains layout || paint) &&
// eligible) || IsOverscrollAreaParent()` (layout_object.h:695-712), and
// DOMSnapshot reports exactly that per layout object
// (inspector_dom_snapshot_agent.cc:687-688). With containment declared:
//  - a false flag proves the object is ineligible;
//  - a true flag proves eligibility only when no other stacking reason
//    applies, so it cannot be attributed to containment on its own.
// The read never mutates or clones the source element. Appending a fixed child
// to the source (the neutral-host probe's question asked of the real element)
// is both a forbidden mutation and wrong for replaced/control owners, whose
// children do not lay out; it is shown here only as the rejected alternative.
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const broken = "data:image/png;base64,AAAA";
const cases: Array<{ name: string; html: string; eligible: boolean | null }> = [
  { name: "block div", html: `<div id="t" style="contain:layout">x</div>`, eligible: true },
  { name: "inline span", html: `<span id="t" style="contain:layout">x</span>`, eligible: false },
  { name: "loaded inline img", html: `<img id="t" src="${png}" style="contain:layout">`, eligible: true },
  {
    name: "errored inline img with alt",
    html: `<img id="t" src="${broken}" alt="broken alt" style="contain:layout">`,
    eligible: true,
  },
  { name: "errored img without alt", html: `<img id="t" src="${broken}" style="contain:layout">`, eligible: true },
  { name: "img without src", html: `<img id="t" style="contain:layout">`, eligible: true },
  {
    name: "outer svg root",
    html: `<svg id="t" width="20" height="20" style="contain:layout"><rect width="5" height="5"/></svg>`,
    eligible: true,
  },
  {
    name: "inner svg",
    html: `<svg width="20" height="20"><svg id="t" width="10" height="10" style="contain:layout"><rect width="5" height="5"/></svg></svg>`,
    eligible: false,
  },
  {
    name: "svg g",
    html: `<svg width="20" height="20"><g id="t" style="contain:layout"><rect width="5" height="5"/></g></svg>`,
    eligible: false,
  },
  {
    name: "svg text (LayoutSVGBlock)",
    html: `<svg width="40" height="20"><text id="t" y="10" style="contain:layout">t</text></svg>`,
    eligible: true,
  },
  {
    name: "svg foreignObject",
    html: `<svg width="40" height="20"><foreignObject id="t" width="20" height="20" style="contain:layout"><div>x</div></foreignObject></svg>`,
    eligible: true,
  },
  { name: "text input", html: `<input id="t" style="contain:layout">`, eligible: true },
  { name: "checkbox", html: `<input id="t" type="checkbox" style="contain:layout">`, eligible: true },
  { name: "image input", html: `<input id="t" type="image" src="${png}" style="contain:layout">`, eligible: true },
  { name: "select", html: `<select id="t" style="contain:layout"><option>a</option></select>`, eligible: true },
  { name: "textarea", html: `<textarea id="t" style="contain:layout"></textarea>`, eligible: true },
  { name: "meter", html: `<meter id="t" value="0.5" style="contain:layout"></meter>`, eligible: true },
  { name: "progress", html: `<progress id="t" value="0.5" style="contain:layout"></progress>`, eligible: true },
  { name: "video", html: `<video id="t" style="contain:layout"></video>`, eligible: true },
  { name: "canvas", html: `<canvas id="t" width="10" height="10" style="contain:layout"></canvas>`, eligible: true },
  { name: "iframe", html: `<iframe id="t" style="contain:layout"></iframe>`, eligible: true },
  { name: "br", html: `a<br id="t" style="contain:layout">b`, eligible: false },
  {
    name: "table row",
    html: `<table><tr id="t" style="contain:layout"><td>a</td></tr></table>`,
    eligible: false,
  },
  {
    name: "table cell",
    html: `<table><tr><td id="t" style="contain:layout">a</td></tr></table>`,
    eligible: true,
  },
  // No layout object at all: no DOMSnapshot answer, so the fact stays absent.
  { name: "display contents", html: `<div id="t" style="contain:layout;display:contents">x</div>`, eligible: null },
];

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

/** DOMSnapshot's stacking flag for #t, joined by backend node id; null without a layout object. */
async function snapshotStacking(page: Page): Promise<boolean | null> {
  const session = await page.context().newCDPSession(page);
  try {
    const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
    const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#t" });
    const { node } = await session.send("DOM.describeNode", { nodeId });
    const snapshot = await session.send("DOMSnapshot.captureSnapshot", { computedStyles: [] });
    const doc = snapshot.documents[0];
    const nodeIndex = doc.nodes.backendNodeId?.indexOf(node.backendNodeId) ?? -1;
    const layoutIndex = doc.layout.nodeIndex.indexOf(nodeIndex);
    if (layoutIndex < 0) return null;
    return doc.layout.stackingContexts.index.includes(layoutIndex);
  } finally {
    await session.detach();
  }
}

describe("containment eligibility native authority (DM-F42BPG)", () => {
  it.each(cases)("DOMSnapshot answers eligibility read-only: $name", async ({ html, eligible }) => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<!doctype html><body>${html}</body>`);
      await page.evaluate(() => Promise.all(Array.from(document.images, (image) => image.decode().catch(() => {}))));
      const before = await page.evaluate(() => document.body.innerHTML);
      expect(await snapshotStacking(page)).toBe(eligible);
      // Read-only: the source tree is byte-identical afterward.
      expect(await page.evaluate(() => document.body.innerHTML)).toBe(before);
    } finally {
      await page.close();
    }
  });

  it("cannot attribute a true flag to containment when another stacking reason applies", async () => {
    const page = await browser.newPage();
    try {
      // An inline span is ineligible, yet opacity makes it a stacking context.
      await page.setContent(`<!doctype html><body><span id="t" style="contain:layout;opacity:.5">x</span></body>`);
      expect(await snapshotStacking(page)).toBe(true);
      // Negative control: without containment the replaced image is no
      // stacking context, so the containment-bearing true above is not a
      // property of the tag.
      await page.setContent(`<!doctype html><body><img id="t" src="${png}"></body>`);
      expect(await snapshotStacking(page)).toBe(false);
    } finally {
      await page.close();
    }
  });

  it("rejects the fixed-child question on replaced and control owners", async () => {
    const page = await browser.newPage();
    try {
      for (const html of [
        `<img id="t" src="${png}" style="contain:layout">`,
        `<input id="t" style="contain:layout">`,
      ]) {
        await page.setContent(`<!doctype html><body>${html}</body>`);
        // Eligible per source and DOMSnapshot, but an appended fixed child
        // does not lay out under the replaced/control owner.
        expect(await snapshotStacking(page)).toBe(true);
        const offsetParent = await page.evaluate(() => {
          const fixed = document.createElement("i");
          fixed.style.position = "fixed";
          const target = document.getElementById("t")!;
          target.appendChild(fixed);
          const answer = fixed.offsetParent === target;
          fixed.remove();
          return answer;
        });
        expect(offsetParent).toBe(false);
      }
    } finally {
      await page.close();
    }
  });
});
