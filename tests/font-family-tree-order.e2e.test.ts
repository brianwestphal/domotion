import type { Browser, CDPSession, Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureElementTreeWithWarnings, launchChromium } from "../src/capture/index.js";
import { captureFontFamilyDeclarationFacts } from "../src/capture/font-family-declarations-cdp.js";
import { familyDomRecords, nativeFontFamilyType, type FamilyDomNode } from "../src/capture/font-family-cascade-cdp.js";
import type { FamilyMatched } from "../src/capture/font-family-cascade.js";
import type { CapturedElement } from "../src/capture/types.js";
import { capturedFontFamilyCss } from "../src/font-family-stack.js";
import { getFontInstance, resolveFontKey } from "../src/render/font-resolution.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// Blink orders author declarations from different tree contexts by
// `tree_order` (style_resolver.cc MatchAuthorRules, match_result.cc
// BeginAddingAuthorRulesForTreeScope, cascade_priority.h EncodeTreeOrder,
// Chromium 7d859f27): for normal declarations the later (outer) context wins,
// for important ones the earlier (inner) context wins, and a slotted element
// inherits from its slot. Every case computes to the initial family name, so
// only the winning declaration's type (the `initial` keyword or the literal
// name) separates Chrome's two outcomes: under lang=ja, `initial` selects the
// script-keyed standard font, while the literal name paints that family.

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser));

type Case = { id: string; type: "standard" | "concrete"; shadowHost?: string };
const CASES: Case[] = [
  // ::slotted (shadow scope, earlier) vs #id (document scope, later), normal.
  { id: "slotted-outer-concrete", type: "concrete" },
  { id: "slotted-outer-initial", type: "standard" },
  // :host !important (earlier) beats #id !important (later).
  { id: "host-important", type: "standard" },
  // ::part from the document (later) beats the shadow's own rule, normal.
  { id: "part-outer", type: "standard", shadowHost: "part-host" },
  // Flat-tree inheritance: the slot's shadow wrapper, not the light-DOM host.
  { id: "flat-inherit", type: "standard" },
  // Nested layers by post-order: `a` (2) beats `a.c` (1) and `a.b` (0).
  { id: "nested-layer-initial", type: "standard" },
  { id: "nested-layer-concrete", type: "concrete" },
];

const paragraph = (id: string) => `<p id="${id}"><span id="a-${id}">A</span> ${id}</p>`;

async function load(page: Page, initial: string): Promise<void> {
  await page.setContent(`<!doctype html><html lang="ja"><meta charset="utf-8"><style>
body{margin:0}p{font-size:32px;margin:0;line-height:48px}
#slotted-outer-concrete{font-family:${initial}}
#slotted-outer-initial{font-family:initial}
#host-important{font-family:${initial} !important}
#part-host::part(lbl){font-family:initial}
#flat-host{font-family:${initial}}
@layer a { @layer b { #nested-layer-initial{font-family:${initial}} } }
@layer a.c { #nested-layer-initial{font-family:${initial}} }
@layer a { #nested-layer-initial{font-family:initial} }
@layer a.b { #nested-layer-concrete{font-family:initial} }
@layer a { #nested-layer-concrete{font-family:${initial}} }
</style>
<div id="slot-host">${paragraph("slotted-outer-concrete")}${paragraph("slotted-outer-initial")}</div>
${paragraph("host-important")}
<div id="part-host"></div>
<div id="flat-host">${paragraph("flat-inherit")}</div>
${paragraph("nested-layer-initial")}${paragraph("nested-layer-concrete")}
<script>
document.getElementById("slot-host").attachShadow({ mode: "open" }).innerHTML =
  '<style>::slotted(#slotted-outer-concrete){font-family:initial}::slotted(#slotted-outer-initial){font-family:${initial}}</style><slot></slot>';
document.getElementById("host-important").attachShadow({ mode: "open" }).innerHTML =
  '<style>:host{font-family:initial !important}</style><slot></slot>';
document.getElementById("part-host").attachShadow({ mode: "open" }).innerHTML =
  '<style>[part=lbl]{font-family:${initial}}</style>${paragraph("part-outer").replace("<p ", '<p part="lbl" ')}';
document.getElementById("flat-host").attachShadow({ mode: "open" }).innerHTML =
  '<style>div{font-family:initial}</style><div><slot></slot></div>';
</script>`);
}

type PiercedNode = FamilyDomNode & { attributes?: string[]; children?: PiercedNode[]; shadowRoots?: PiercedNode[] };
function findById(root: PiercedNode, id: string): PiercedNode | undefined {
  const attrs = root.attributes ?? [];
  const index = attrs.indexOf("id");
  if (index >= 0 && attrs[index + 1] === id) return root;
  for (const child of [...(root.children ?? []), ...(root.shadowRoots ?? [])]) {
    const found = findById(child, id);
    if (found != null) return found;
  }
  return undefined;
}

async function withSession<T>(page: Page, fn: (cdp: CDPSession, root: PiercedNode) => Promise<T>): Promise<T> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    return await fn(cdp, root as PiercedNode);
  } finally {
    await cdp.detach();
  }
}

const flat = (nodes: CapturedElement[]): CapturedElement[] => nodes.flatMap((n) => [n, ...flat(n.children)]);

describe("font-family cascade across tree scopes", () => {
  it("matches Chrome's tree-order winner and painted face for each tree context", async () => {
    const page = await browser.newPage({ viewport: { width: 640, height: 640 }, deviceScaleFactor: 1 });
    try {
      await page.setContent("<!doctype html><p>x</p>");
      const initial = await page.locator("p").evaluate((el) => getComputedStyle(el).fontFamily);
      await load(page, initial);

      // Chrome's painted face for the "A" of each case.
      const painted = await withSession(page, async (cdp, root) => {
        const out: Record<string, string> = {};
        for (const c of CASES) {
          const node = findById(root, `a-${c.id}`);
          if (node == null) throw new Error(`no node for ${c.id}`);
          const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: node.nodeId });
          const used = fonts.filter((font) => font.glyphCount > 0);
          expect(used, c.id).toHaveLength(1);
          out[c.id] = used[0].postScriptName;
        }
        return out;
      });
      // The two declaration types paint different faces, so the oracle
      // discriminates — except on Linux, where it cannot by construction:
      // Playwright's Linux generic table has no per-script entries, so
      // `GenericFontFamilySettings::GenericFontFamilyForScript` falls back to
      // the common-script "Times New Roman" for every script
      // (`generic_font_family_settings.cc:81-107`, Chromium 7d859f27) and the
      // `initial` keyword names the same family as the literal. No installed
      // font can separate them there; the type facts below still discriminate.
      const byType = (type: Case["type"]) => new Set(CASES.filter((c) => c.type === type).map((c) => painted[c.id]));
      expect(byType("standard").size).toBe(1);
      expect(byType("concrete").size).toBe(1);
      expect([...byType("standard")][0] !== [...byType("concrete")][0]).toBe(process.platform !== "linux");

      // The production fact provider proves each type with no refusal.
      const probe = await captureFontFamilyDeclarationFacts(page);
      const facts: Record<string, unknown> = {};
      try {
        for (const c of CASES) {
          const locator =
            c.shadowHost == null ? page.locator(`#${c.id}`) : page.locator(`#${c.shadowHost}`).locator(`#${c.id}`);
          facts[c.id] = await locator.evaluate(
            (el, key) => (el as unknown as Record<string, unknown>)[key] ?? null,
            probe.propertyKey,
          );
        }
      } finally {
        await probe.dispose();
      }
      expect(probe.warnings.map((w) => w.detail)).toEqual([]);
      for (const c of CASES) expect(facts[c.id], c.id).toMatchObject({ familyType: c.type, familyTypeUsable: true });

      // The captured stack resolves to the face Chrome painted. The light-DOM
      // walker does not descend into a plain element's shadow tree, so the
      // ::part case has no captured node; its fact is checked above.
      const { tree } = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 640, height: 640 });
      for (const c of CASES.filter((row) => row.shadowHost == null)) {
        const node = flat(tree).find((n) => n.tag === "p" && n.text.trim() === c.id);
        const stack = node?.styles.fontFamilyStack;
        expect(stack?.genericFamily, c.id).toBe(c.type === "standard" ? "standard" : "none");
        const font = getFontInstance(resolveFontKey(capturedFontFamilyCss("", stack!), "ja"), 400, 32);
        expect(font?.postscriptName, c.id).toBe(painted[c.id]);
      }
    } finally {
      await page.close();
    }
  });

  it("negative control: the reversed inspector rule order is refused, never reinterpreted", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent("<!doctype html><p>x</p>");
      const initial = await page.locator("p").evaluate((el) => getComputedStyle(el).fontFamily);
      await load(page, initial);
      await withSession(page, async (cdp, root) => {
        const records = familyDomRecords(root);
        for (const id of ["slotted-outer-concrete", "slotted-outer-initial", "host-important"]) {
          const node = findById(root, id)!;
          const matched = (await cdp.send("CSS.getMatchedStylesForNode", {
            nodeId: node.nodeId,
          })) as unknown as FamilyMatched;
          const native = await nativeFontFamilyType(cdp, node.nodeId, matched, records);
          expect(native.resolution, id).toHaveProperty("type");
          const reversed = { ...matched, matchedCSSRules: [...(matched.matchedCSSRules ?? [])].reverse() };
          expect((await nativeFontFamilyType(cdp, node.nodeId, reversed, records)).resolution, id).toEqual({
            reason: "matched font rule order contradicts tree order",
          });
        }
      });
    } finally {
      await page.close();
    }
  });
});
