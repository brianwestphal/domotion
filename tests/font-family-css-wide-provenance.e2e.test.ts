import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { launchChromium, captureElementTreeWithWarnings } from "../src/capture/index.js";
import * as familyDeclarations from "../src/capture/font-family-declarations-cdp.js";
import { capturedFontFamilyCss } from "../src/font-family-stack.js";
import type { CapturedElement } from "../src/capture/types.js";
import { getFontInstance, resolveFontKey, withRenderTextMode } from "../src/render/font-resolution.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser));
const W = 720,
  H = 900;
const fixtures = [
  { id: "ua", type: "standard" },
  { id: "literal", type: "concrete" },
  { id: "initial", type: "standard", parent: true },
  { id: "inherit", type: "concrete", parent: true },
  { id: "unset", type: "concrete", parent: true },
  { id: "revert", type: "concrete", parent: true },
  { id: "layer-reset", type: "standard", parent: true },
  { id: "important-layer", type: "standard", parent: true },
  { id: "var-concrete", type: "concrete" },
  { id: "var-initial", type: "standard", parent: true },
  { id: "var-invalid", type: "concrete", parent: true },
  { id: "font-pending", type: "concrete" },
  { id: "all-initial", type: "standard", parent: true },
  { id: "override-initial", type: "standard" },
  { id: "override-concrete", type: "concrete" },
  { id: "pseudo-host", type: "concrete" },
  { id: "pseudo-animated", type: "standard" },
  { id: "locale-auto", type: "standard", parent: true, usable: false },
] as const;
const flat = (nodes: CapturedElement[]): CapturedElement[] => nodes.flatMap((n) => [n, ...flat(n.children)]);
const hash = (input: Buffer | string) => createHash("sha256").update(input).digest("hex");
async function capture(page: import("@playwright/test").Page, literalOnly: boolean) {
  const original = familyDeclarations.captureFontFamilyDeclarationFacts;
  const probe = await original(page, { literalOnly });
  let facts: Record<string, unknown>;
  try {
    facts = await page.evaluate(
      (key) =>
        Object.fromEntries(
          [...document.querySelectorAll("p")].map((el) => [
            el.id,
            (el as unknown as Record<string, unknown>)[key] ?? null,
          ]),
        ),
      probe.propertyKey,
    );
  } finally {
    await probe.dispose();
    expect(
      await page.evaluate(
        (key) => [...document.querySelectorAll("*")].some((el) => Object.hasOwn(el, key)),
        probe.propertyKey,
      ),
    ).toBe(false);
  }
  // A/B the actual production entry point by replacing only our own declaration
  // provider with its explicit legacy mode. Browser/CDP/scheduler behavior is unchanged.
  const spy = vi
    .spyOn(familyDeclarations, "captureFontFamilyDeclarationFacts")
    .mockImplementation((target) => original(target, { literalOnly }));
  try {
    const result = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: W, height: H });
    expect(spy).toHaveBeenCalledOnce();
    return { tree: result.tree, facts, warnings: result.warnings };
  } finally {
    spy.mockRestore();
  }
}
const viewport = { width: W, height: H };
describe("CSS-wide/substituted initial-name type (DM-ESH89H)", () => {
  it.each(["readable", "opaque"] as const)(
    "matches native family type and actual painted advances in %s CSS",
    async (mode) => {
      const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
      const directory = join(
        process.env.DOMOTION_FONT_FAMILY_PROVENANCE_EVIDENCE ??
          (process.env.DOMOTION_OUTPUT_DIR ?? "tests/output") + "/font-family-css-wide",
        mode,
      );
      const evidence: Record<string, unknown> = {
        generatedAt: new Date().toISOString(),
        sourceCommit: process.env.GITHUB_SHA ?? null,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        browser: browser.version(),
        mode,
      };
      let failed = false;
      try {
        await page.setContent("<!doctype html><p>initial</p>");
        const initial = await page.locator("p").evaluate((el) => getComputedStyle(el).fontFamily);
        const css = `@layer low,high;body{margin:0}p{font-size:32px;margin:0;line-height:48px}.parent{font-family:${initial}}
   #literal,#pseudo-host{font-family:${initial}}#initial{font-family:initial}#inherit{font-family:inherit}#unset{font-family:unset}#revert{font-family:revert}
   @layer low{#layer-reset,#important-layer{font-family:initial}}@layer high{#layer-reset{font-family:revert-layer}#important-layer{font-family:revert-layer!important}}
   #var-concrete{--face:${initial};font-family:var(--face)}#var-initial{font-family:var(--missing,initial)}#var-invalid{font-family:var(--missing)}
   #font-pending{--font:32px ${initial};font:var(--font)!important;line-height:48px}#all-initial{all:initial;font-size:32px;line-height:48px;display:block;-webkit-locale:"ja"}#locale-auto{all:initial;font-size:32px;line-height:48px;display:block}
   #override-initial{font-family:${initial};font-family:initial}#override-concrete{font-family:initial;font-family:${initial}}
   #pseudo-host::before{content:"A";font-family:initial}#pseudo-animated{font-family:initial}
   @keyframes concrete-pseudo{from,to{font-family:${initial}}}#pseudo-animated::before{content:"A";animation:concrete-pseudo 100s infinite}`;
        const sheet =
          mode === "opaque" ? "https://cdn.font-provenance.test/font.css" : "https://font-provenance.test/font.css";
        const body = fixtures
          .map(
            (f) =>
              `${"parent" in f && f.parent ? '<div class="parent">' : ""}<p id="${f.id}" lang="ja"><span id="a-${f.id}">A</span>漢 ${f.id}</p>${"parent" in f && f.parent ? "</div>" : ""}`,
          )
          .join("");
        const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${sheet}">${body}`;
        const unexpected: string[] = [];
        await page.route("**/*", (route) => {
          if (route.request().url() === "https://font-provenance.test/")
            return route.fulfill({ contentType: "text/html", body: html });
          if (route.request().url() === sheet) return route.fulfill({ contentType: "text/css", body: css });
          unexpected.push(new URL(route.request().url()).origin);
          return route.abort();
        });
        await page.goto("https://font-provenance.test/", { waitUntil: "load" });
        expect(
          await page.evaluate(() => {
            try {
              void document.styleSheets[0].cssRules;
              return true;
            } catch {
              return false;
            }
          }),
        ).toBe(mode === "readable");
        const sourcePng = await page.screenshot();
        evidence.fixtureHtmlSha256 = hash(html);
        evidence.fixtureCssSha256 = hash(css);
        evidence.fixtureHtmlBytes = Buffer.byteLength(html);
        evidence.fixtureCssBytes = Buffer.byteLength(css);
        evidence.initial = initial;
        evidence.fixtureSha256 = hash(await readFile(new URL(import.meta.url)));
        evidence.captureBundleSha256 = hash(
          await readFile(new URL("../src/capture/script.generated.ts", import.meta.url)),
        );
        const native = await page.context().newCDPSession(page);
        const nativeRows: Array<Record<string, unknown>> = [];
        try {
          await native.send("DOM.enable");
          await native.send("CSS.enable");
          const { root } = await native.send("DOM.getDocument");
          for (const fixture of fixtures) {
            const { nodeId } = await native.send("DOM.querySelector", {
              nodeId: root.nodeId,
              selector: `#a-${fixture.id}`,
            });
            const { fonts } = await native.send("CSS.getPlatformFontsForNode", { nodeId });
            const painted = fonts.filter((font) => font.glyphCount > 0);
            expect(painted).toHaveLength(1);
            expect(painted[0].isCustomFont).toBe(false);
            const width = await page.locator(`#a-${fixture.id}`).evaluate((el) => {
              const r = document.createRange();
              r.selectNodeContents(el);
              return r.getBoundingClientRect().width;
            });
            const key = resolveFontKey(painted[0].familyName, "ja"),
              font = getFontInstance(key, 400, 32);
            expect(font, fixture.id).toBeDefined();
            expect(font!.postscriptName, fixture.id).toBe(painted[0].postScriptName);
            const advance = (font!.glyphForCodePoint(65).advanceWidth! / font!.unitsPerEm) * 32;
            // Blink LayoutUnit quantizes fragment widths to 1/64 CSS px.
            expect(Math.abs(width - advance), fixture.id).toBeLessThanOrEqual(1 / 64);
            nativeRows.push({
              id: fixture.id,
              type: fixture.type,
              painted: painted[0],
              width,
              fontKey: key,
              fontkitAdvance: advance,
            });
          }
        } finally {
          await native.detach();
        }
        evidence.native = nativeRows;
        const legacy = await capture(page, true),
          current = await capture(page, false);
        evidence.legacyFacts = legacy.facts;
        evidence.currentFacts = current.facts;
        evidence.warnings = current.warnings;
        expect(current.warnings).toHaveLength(2);
        expect(current.warnings.some((w) => w.detail.includes("DM-PJG8E9"))).toBe(true);
        expect(current.warnings.some((w) => w.detail.includes("interpolated family lost original type"))).toBe(true);
        expect(current.facts["locale-auto"]).toMatchObject({
          familyType: "standard",
          familyTypeUsable: false,
          familyTypeLocale: "auto",
          familyTypeLanguage: "ja",
        });
        const stacks = (tree: CapturedElement[]) =>
          Object.fromEntries(
            fixtures.map((f) => [
              f.id,
              flat(tree).find((n) => n.text.trim().endsWith(`漢 ${f.id}`))?.styles.fontFamilyStack,
            ]),
          );
        const before = stacks(legacy.tree),
          after = stacks(current.tree);
        evidence.legacyStacks = before;
        evidence.currentStacks = after;
        for (const fixture of fixtures) {
          expect(after[fixture.id]?.genericFamily, fixture.id).toBe(
            "usable" in fixture && fixture.usable === false
              ? before[fixture.id]?.genericFamily
              : fixture.type === "standard"
                ? "standard"
                : "none",
          );
          if ("usable" in fixture && fixture.usable === false) {
            expect(after[fixture.id]).toEqual(before[fixture.id]);
            continue;
          }
          const nativeRow = nativeRows.find((row) => row.id === fixture.id)!;
          const actual = after[fixture.id]!;
          const key = resolveFontKey(capturedFontFamilyCss("", actual), "ja");
          const font = getFontInstance(key, 400, 32);
          expect(font!.postscriptName, fixture.id).toBe(
            (nativeRow.painted as { postScriptName: string }).postScriptName,
          );
        }
        expect(before.initial?.genericFamily).toBe(mode === "readable" ? "none" : "standard");
        expect(after.initial?.genericFamily).toBe("standard");
        expect(before[mode === "opaque" ? "var-concrete" : "var-initial"]?.genericFamily).not.toBe(
          after[mode === "opaque" ? "var-concrete" : "var-initial"]?.genericFamily,
        );
        const pseudo = flat(current.tree)
          .find((n) => n.text.trim().endsWith("漢 pseudo-host"))
          ?.pseudoFragments?.find((p) => p.pseudo === "::before");
        expect(pseudo?.typography.fontFamilyStack?.genericFamily).toBe("standard");
        const animatedPseudo = flat(current.tree)
          .find((n) => n.text.trim().endsWith("漢 pseudo-animated"))
          ?.pseudoFragments?.find((p) => p.pseudo === "::before");
        const oldAnimatedPseudo = flat(legacy.tree)
          .find((n) => n.text.trim().endsWith("漢 pseudo-animated"))
          ?.pseudoFragments?.find((p) => p.pseudo === "::before");
        expect(animatedPseudo?.typography.fontFamilyStack).toEqual(oldAnimatedPseudo?.typography.fontFamilyStack);
        expect(animatedPseudo?.typography.fontFamilyStack?.genericFamily).toBe(
          mode === "readable" ? "none" : "standard",
        );
        expect(current.facts["pseudo-animated"]).toMatchObject({
          familyType: "standard",
          pseudoFamilyTypes: { before: { usable: false } },
        });
        expect(await page.screenshot(), "owned capture probes must preserve source paint").toEqual(sourcePng);
        const oldSvg = withRenderTextMode("embedded-font", () => elementTreeToSvg(legacy.tree, W, H)),
          newSvg = withRenderTextMode("embedded-font", () => elementTreeToSvg(current.tree, W, H));
        const pngs = [];
        for (const svg of [oldSvg, newSvg]) {
          await page.setContent(`<body style="margin:0">${svg}`);
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          pngs.push(await page.screenshot());
        }
        const rgbaBytes = async (png: Buffer) => sharp(png).ensureAlpha().raw().toBuffer();
        const expected = await rgbaBytes(sourcePng);
        const differences = [];
        for (const png of pngs) {
          const actual = await rgbaBytes(png);
          let pixels = 0;
          for (let i = 0; i < expected.length; i += 4)
            if (!expected.subarray(i, i + 4).equals(actual.subarray(i, i + 4))) pixels++;
          differences.push((pixels / (W * H)) * 100);
        }
        evidence.diffPct = { legacy: differences[0], current: differences[1] };
        if (process.platform === "darwin") expect(differences[1]).toBeLessThan(differences[0]);
        expect(unexpected).toEqual([]);
        await mkdir(directory, { recursive: true });
        await Promise.all([
          writeFile(join(directory, "source.png"), sourcePng),
          writeFile(join(directory, "legacy.png"), pngs[0]),
          writeFile(join(directory, "captured.png"), pngs[1]),
          writeFile(join(directory, "source.html"), html),
          writeFile(join(directory, "source.css"), css),
          writeFile(join(directory, "legacy.svg"), oldSvg),
          writeFile(join(directory, "captured.svg"), newSvg),
        ]);
        evidence.passed = true;
      } catch (error) {
        failed = true;
        evidence.failed = true;
        throw error;
      } finally {
        try {
          await mkdir(directory, { recursive: true });
          await writeFile(join(directory, "results.json"), JSON.stringify(evidence, null, 2));
        } catch (error) {
          if (!failed) throw error;
        } finally {
          await page.close();
        }
      }
    },
  );
});
