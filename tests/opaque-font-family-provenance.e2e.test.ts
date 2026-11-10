import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium, type CapturedElement } from "../src/index.js";
import {
  matchedFamilyIsUnambiguouslyAuthored,
  type MatchedFamilyDeclarations,
} from "../src/capture/font-family-declarations.js";
import { captureFontFamilyDeclarationFacts } from "../src/capture/font-family-declarations-cdp.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { getFontInstance } from "../src/render/font-resolution.js";

const browser = await launchChromium();
afterAll(() => closeBrowserSafely(browser));

function flatten(nodes: CapturedElement[]): CapturedElement[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

describe("opaque initial-named font declarations", () => {
  it("distinguishes native concrete faces from UA standard without admitting reset/substitution ambiguity", async () => {
    const page = await browser.newPage({ viewport: { width: 720, height: 900 }, deviceScaleFactor: 1 });
    const output = resolve(
      process.env["DOMOTION_OUTPUT_DIR"] ?? (process.platform === "linux" ? "tests/output-linux" : "tests/output"),
      "opaque-font-family",
    );
    const evidence: Record<string, unknown> = {
      schema: 2,
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      architecture: process.arch,
      osRelease: release(),
      node: process.version,
      browser: browser.version(),
      sourceSha: process.env["GITHUB_SHA"] ?? null,
      fixtureSha256: createHash("sha256")
        .update(readFileSync(new URL(import.meta.url)))
        .digest("hex"),
      captureBundleSha256: createHash("sha256")
        .update(readFileSync(new URL("../src/capture/script.generated.ts", import.meta.url)))
        .digest("hex"),
      phase: "setup",
    };
    let failed = false;
    try {
      await page.setContent("<!doctype html><p>initial</p>");
      const initial = await page.locator("p").evaluate((el) => getComputedStyle(el).fontFamily);
      await page.route("https://provenance.test/", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="https://cdn.provenance.test/font.css">
        <style>p{font-size:32px;margin:0;line-height:48px}.known{font-family:${initial}}</style>
        <p id="ua" lang="ja">A漢 ua</p><p id="literal" lang="ja">A漢 literal</p>
        <div class="ancestor"><p id="inherited" lang="ja">A漢 inherited</p><p id="child-reset" lang="ja">A漢 child-reset</p></div>
        <p id="shorthand" lang="ja">A漢 shorthand</p><p id="inactive" lang="ja">A漢 inactive</p>
        <p id="reset" lang="ja">A漢 reset</p><p id="escaped-reset" lang="ja">A漢 escaped-reset</p><p id="override-reset" lang="ja">A漢 override-reset</p>
        <p id="override-literal" lang="ja">A漢 override-literal</p><p id="variable-invalid" lang="ja">A漢 variable-invalid</p>
        <p id="variable-literal" lang="ja">A漢 variable-literal</p><p id="known" class="known" lang="ja">A漢 known</p>
        <p id="animated-reset" lang="ja">A漢 animated-reset</p><p id="pseudo-reset" lang="ja">A漢 pseudo-reset</p>`,
        }),
      );
      await page.route("https://cdn.provenance.test/font.css", (route) =>
        route.fulfill({
          contentType: "text/css",
          body: `#literal,.ancestor{font-family:${initial}!important}#shorthand{font:32px ${initial}}
        @media (width < 1px){#inactive{font-family:${initial}}}
        #reset{font-family:initial}#child-reset{font-\\66 amily:initial!important}#escaped-reset{font-family:\\69 nitial}#override-reset{font-family:${initial};font-family:initial}
        #override-literal{font-family:Georgia;font-family:${initial}}
        #variable-invalid{font-family:var(--missing)}#variable-literal{--face:${initial};font-family:var(--face)}
        #pseudo::before{content:'generated';font-family:${initial}}
        @keyframes standard-family{from,to{font-family:initial}}
        #animated-reset{font-family:${initial};animation:standard-family 1s infinite}
        #pseudo-reset::before{content:'animated';font-family:${initial};animation:standard-family 1s infinite}`,
        }),
      );
      await page.goto("https://provenance.test/", { waitUntil: "load" });
      await page.evaluate(() => {
        const p = document.createElement("p");
        p.id = "pseudo";
        p.lang = "ja";
        p.textContent = "A漢 pseudo-host";
        document.body.appendChild(p);
      });
      expect(
        await page.evaluate(() => {
          try {
            void document.styleSheets[0].cssRules;
            return false;
          } catch {
            return true;
          }
        }),
      ).toBe(true);
      evidence.initial = initial;
      evidence.fixtureHtml = await page.content();
      const probe = await captureFontFamilyDeclarationFacts(page);
      try {
        evidence.probeWarnings = probe.warnings;
        expect(probe.warnings).toEqual([]);
        const facts = await page.evaluate(
          (key) =>
            Object.fromEntries(
              [...document.querySelectorAll("p")].map((el) => [
                el.id,
                (el as unknown as Record<string, unknown>)[key] ?? null,
              ]),
            ),
          probe.propertyKey,
        );
        evidence.directDeclarationFacts = facts;
        evidence.phase = "direct-declaration-facts";
        for (const id of ["literal", "inherited", "shorthand", "override-literal", "known"]) {
          expect(facts[id], id).toMatchObject({ authored: true, family: initial });
        }
        expect(facts.pseudo).toMatchObject({ authored: false, authoredPseudos: ["before"] });
        // DM-ESH89H: unresolved values get no new authority. In particular a
        // child reset must never acquire its authored ancestor's concrete fact.
        for (const id of [
          "ua",
          "inactive",
          "reset",
          "escaped-reset",
          "child-reset",
          "override-reset",
          "variable-invalid",
          "variable-literal",
          "animated-reset",
          "pseudo-reset",
        ]) {
          expect(facts[id], id).toBeNull();
        }
      } finally {
        await probe.dispose();
      }
      expect(
        await page.evaluate(
          (key) => [...document.querySelectorAll("*")].some((el) => Object.hasOwn(el, key)),
          probe.propertyKey,
        ),
      ).toBe(false);
      const tree = flatten(await captureElementTree(page, "body", { x: 0, y: 0, width: 720, height: 900 }));
      const family = (id: string) =>
        tree.find((node) => node.text.trim() === `A漢 ${id}`)?.styles.fontFamilyStack?.genericFamily;
      evidence.sourceStyleFacts = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.setProperty("all", "initial", "important");
        probe.style.setProperty("display", "none", "important");
        let currentInitialFamily: string;
        try {
          document.documentElement.appendChild(probe);
          currentInitialFamily = getComputedStyle(probe).fontFamily;
        } finally {
          probe.remove();
        }
        return {
          currentInitialFamily,
          stylesheets: [...document.styleSheets].map((sheet) => {
            try {
              return { href: sheet.href, readable: true, rules: [...sheet.cssRules].map((rule) => rule.cssText) };
            } catch {
              return { href: sheet.href, readable: false };
            }
          }),
          elements: [...document.querySelectorAll("p")].map((element) => {
            const ancestors: Array<{ tag: string; id: string; inlineFamily: string; face: string | null }> = [];
            for (let node: HTMLElement | null = element; node != null; node = node.parentElement) {
              ancestors.push({
                tag: node.tagName,
                id: node.id,
                inlineFamily: node.style.fontFamily,
                face: node.getAttribute("face"),
              });
            }
            return { id: element.id, computedFamily: getComputedStyle(element).fontFamily, ancestors };
          }),
        };
      });
      const widths = await page.evaluate(() =>
        Object.fromEntries(
          ["ua", "literal", "inherited", "known", "shorthand", "child-reset", "escaped-reset", "animated-reset"].map(
            (id) => {
              const range = document.createRange();
              const el = document.getElementById(id)!;
              range.setStart(el.firstChild!, 0);
              range.setEnd(el.firstChild!, 1);
              return [id, range.getBoundingClientRect().width];
            },
          ),
        ),
      );
      evidence.widths = widths;
      evidence.capturedGenericFamilies = Object.fromEntries(
        [...(await page.locator("p").evaluateAll((nodes) => nodes.map((node) => node.id)))].map((id) => [
          id,
          family(id),
        ]),
      );
      evidence.capturedTypography = tree.map((node) => ({
        text: node.text,
        styles: node.styles.fontFamilyStack,
        segments: node.textSegments?.map((segment) => ({ text: segment.text, family: segment.fontFamilyStack })),
      }));
      evidence.phase = "captured-tree";
      expect(widths.known).toBeGreaterThan(0);
      for (const id of ["literal", "inherited", "shorthand"]) expect(widths[id], id).toBe(widths.known);
      for (const id of ["child-reset", "escaped-reset", "animated-reset"]) expect(widths[id], id).toBe(widths.ua);
      const native = await page.context().newCDPSession(page);
      try {
        await native.send("DOM.enable");
        await native.send("CSS.enable");
        const { root } = await native.send("DOM.getDocument");
        const faces = new Map<string, string[]>();
        const declarations: Record<string, unknown> = {};
        evidence.nativeDeclarations = declarations;
        evidence.paintedFaces = {};
        for (const id of ["ua", "literal", "inherited", "known", "shorthand", "child-reset", "animated-reset"]) {
          const { nodeId } = await native.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${id}` });
          const matched = await native.send("CSS.getMatchedStylesForNode", { nodeId });
          const animated = await native.send("CSS.getAnimatedStylesForNode", { nodeId });
          const classifierInput: MatchedFamilyDeclarations = {
            ...matched,
            animationStyles: animated.animationStyles,
            transitionsStyle: animated.transitionsStyle,
            inherited: matched.inherited?.map((scope, index) => ({
              ...scope,
              animationStyles: animated.inherited?.[index]?.animationStyles,
              transitionsStyle: animated.inherited?.[index]?.transitionsStyle,
            })),
          };
          declarations[id] = {
            unambiguouslyAuthored: matchedFamilyIsUnambiguouslyAuthored(classifierInput),
            classifierInput,
          };
          const { fonts } = await native.send("CSS.getPlatformFontsForNode", { nodeId });
          expect(fonts.length, id).toBeGreaterThan(0);
          expect(
            fonts.every((font) => font.glyphCount > 0 && !font.isCustomFont),
            id,
          ).toBe(true);
          faces.set(id, [...new Set(fonts.map((font) => `${font.familyName}|${font.postScriptName}`))].sort());
          evidence.paintedFaces = Object.fromEntries(faces);
        }
        for (const id of ["literal", "inherited", "shorthand"]) expect(faces.get(id), id).toEqual(faces.get("known"));
        for (const id of ["child-reset", "animated-reset"]) expect(faces.get(id), id).toEqual(faces.get("ua"));
      } finally {
        await native.detach();
      }
      evidence.phase = "native-evidence-collected";
      for (const id of ["literal", "inherited", "shorthand", "override-literal", "known"])
        expect(family(id), id).toBe("none");
      for (const id of [
        "ua",
        "inactive",
        "reset",
        "escaped-reset",
        "child-reset",
        "override-reset",
        "variable-invalid",
        "animated-reset",
      ])
        expect(family(id), id).toBe("standard");
      expect(
        tree
          .find((node) => node.text.trim() === "A漢 pseudo-host")
          ?.pseudoFragments?.find((record) => record.pseudo === "::before")?.typography.fontFamilyStack?.genericFamily,
      ).toBe("none");
      expect(
        tree
          .find((node) => node.text.trim() === "A漢 pseudo-reset")
          ?.pseudoFragments?.find((record) => record.pseudo === "::before")?.typography.fontFamilyStack?.genericFamily,
      ).toBe("standard");
      if (process.platform === "darwin") {
        const concrete = getFontInstance("times", 400, 32)!;
        const standard = getFontInstance("u-hiragino-kaku-gothic-pron", 400, 32)!;
        const advance = (face: typeof concrete) => (face.glyphForCodePoint(65).advanceWidth! / face.unitsPerEm) * 32;
        expect(Math.abs(advance(concrete) - advance(standard))).toBeGreaterThan(0.5);
        expect(widths.literal).toBeCloseTo(advance(concrete), 1);
        expect(widths.inherited).toBe(widths.literal);
        expect(widths.known).toBe(widths.literal);
        expect(widths.ua).toBeCloseTo(advance(standard), 1);
        expect(widths["child-reset"]).toBe(widths.ua);
      }
      evidence.phase = "passed";
    } catch (error) {
      failed = true;
      evidence.failed = true;
      throw error;
    } finally {
      try {
        mkdirSync(output, { recursive: true });
        writeFileSync(join(output, "native-context.json"), JSON.stringify(evidence, null, 2));
      } catch (error) {
        // Preserve the strict assertion if evidence storage independently fails.
        if (!failed) throw error;
        console.warn("Could not retain opaque font-family fixture evidence");
      } finally {
        await page.close();
      }
    }
  });
  it("recovers same-process iframe and shadow-root opaque declarations without marking UA siblings", async () => {
    const page = await browser.newPage({ viewport: { width: 720, height: 300 } });
    try {
      await page.setContent("<!doctype html><p>initial</p>");
      const initial = await page.locator("p").evaluate((el) => getComputedStyle(el).fontFamily);
      await page.route("https://roots.test/", (route) =>
        route.fulfill({ contentType: "text/html", body: '<!doctype html><iframe></iframe><div id="host"></div>' }),
      );
      await page.route("https://cdn.roots.test/family.css", (route) =>
        route.fulfill({ contentType: "text/css", body: `.literal{font-family:${initial}}` }),
      );
      await page.goto("https://roots.test/");
      await page.evaluate(() => {
        const html =
          '<link rel="stylesheet" href="https://cdn.roots.test/family.css"><p class="literal" lang="ja">frame-literal</p><p lang="ja">frame-ua</p>';
        document.querySelector("iframe")!.srcdoc = html;
        document.getElementById("host")!.attachShadow({ mode: "open" }).innerHTML = html.replaceAll(
          "frame-",
          "shadow-",
        );
      });
      await page.frameLocator("iframe").locator(".literal").waitFor();
      await page.waitForLoadState("networkidle");
      const probe = await captureFontFamilyDeclarationFacts(page);
      try {
        expect(probe.warnings).toEqual([]);
        const facts = await page.evaluate((key) => {
          const frame = document.querySelector("iframe")!.contentDocument!;
          const shadow = document.getElementById("host")!.shadowRoot!;
          return [frame, shadow].map((root) =>
            [...root.querySelectorAll("p")].map((el) => (el as unknown as Record<string, unknown>)[key] ?? null),
          );
        }, probe.propertyKey);
        for (const [literal, ua] of facts) {
          expect(literal).toMatchObject({ authored: true });
          expect(ua).toBeNull();
        }
      } finally {
        await probe.dispose();
      }
    } finally {
      await page.close();
    }
  });
});
