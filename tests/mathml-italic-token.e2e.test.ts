import type { Page } from "@playwright/test";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { captureElementTree, launchChromium, type CapturedElement } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";
import { invalidateFontEnvironmentCaches } from "../src/render/font-resolution.js";
import { isGlyphHelperAvailable } from "../src/render/glyph-helper.js";
import type {
  TextEmitterTransitionDiagnostic,
  TextRunProvenanceDiagnostic,
} from "../src/render/text-run-provenance.js";
import {
  getTextRunProvenance,
  resetTextRunProvenance,
  setRenderTextMode,
  setTextRunProvenanceEnabled,
} from "../src/render/text-to-path.js";
import {
  LINUX_MATHML_GREEK_TOKENS,
  validateLinuxMathmlGreekTokenEvidence,
  type LinuxMathmlGreekTokenEvidence,
} from "../tools/linux-mathml-greek-raster-contract.js";
import { tests as featureTests } from "./features.js";

const env = await (async () => {
  try { return { browser: await launchChromium() }; } catch { return null; }
})();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);

const initialHelperDisable = process.env.DOMOTION_DISABLE_HELPER;
function restoreHelperEnvironment(): void {
  if (initialHelperDisable == null) delete process.env.DOMOTION_DISABLE_HELPER;
  else process.env.DOMOTION_DISABLE_HELPER = initialHelperDisable;
  invalidateFontEnvironmentCaches();
}
afterEach(() => {
  setTextRunProvenanceEnabled(false);
  setRenderTextMode("embedded-font");
  restoreHelperEnvironment();
});
const describeBrowser = env ? describe : describe.skip;

function byMagicKey(nodes: CapturedElement[], key: string): CapturedElement | null {
  for (const node of nodes) {
    if (node.magicKey === key) return node;
    const child = byMagicKey(node.children ?? [], key);
    if (child != null) return child;
  }
  return null;
}

function withoutCaptureTextTerminal(node: CapturedElement): CapturedElement {
  const clone = structuredClone(node);
  const visit = (element: CapturedElement): void => {
    element.transformSubtreeRaster = undefined;
    element.elementRaster = undefined;
    for (const segment of element.textSegments ?? []) {
      segment.rasterDataUri = undefined;
      segment.rasterRect = undefined;
      segment.rasterGlyphs = undefined;
    }
    for (const child of element.children ?? []) visit(child);
  };
  visit(clone);
  return clone;
}

interface PlatformFace {
  familyName: string;
  postscriptName: string;
  isCustomFont: boolean;
  glyphCount: number;
}

async function cdpPaintedFaces(page: Page, ids: string[]): Promise<Record<string, PlatformFace>> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const result: Record<string, PlatformFace> = {};
    for (const id of ids) {
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${id}` });
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      const painted = fonts.filter((font) => font.glyphCount > 0);
      expect(painted, `${id}: CDP painted face cut`).toHaveLength(1);
      result[id] = {
        familyName: painted[0]!.familyName,
        postscriptName: painted[0]!.postScriptName,
        isCustomFont: painted[0]!.isCustomFont,
        glyphCount: painted[0]!.glyphCount,
      };
    }
    return result;
  } finally {
    await cdp.detach();
  }
}

const terminalKinds = new Set<TextEmitterTransitionDiagnostic["kind"]>([
  "capture-raster", "source-owned-boundary", "paths-succeeded",
]);

interface RenderEvidence {
  markup: string;
  terminal: TextEmitterTransitionDiagnostic;
  runs: TextRunProvenanceDiagnostic[];
}

function renderEvidence(node: CapturedElement, width: number, height: number): RenderEvidence {
  resetTextRunProvenance();
  setTextRunProvenanceEnabled(true);
  setRenderTextMode("paths");
  const markup = elementTreeToSvgInner([node], width, height);
  const snapshot = getTextRunProvenance();
  const terminals = snapshot.transitions.filter((transition) => terminalKinds.has(transition.kind));
  expect(markup, `${node.magicKey}: non-empty terminal markup`).not.toBe("");
  expect(snapshot.transitions.length, `${node.magicKey}: non-vacuous transition evidence`).toBeGreaterThan(0);
  expect(terminals, `${node.magicKey}: exactly one final text owner`).toHaveLength(1);
  return { markup, terminal: terminals[0]!, runs: snapshot.runs };
}

function assertSelectedRun(
  run: TextRunProvenanceDiagnostic,
  transformed: string,
  face: PlatformFace,
  label: string,
): void {
  expect(run.sourceText, label).toBe(transformed);
  expect(run.emittedText, label).toBe(transformed);
  expect(run.sourceSpan, label).toEqual([0, transformed.length]);
  expect(run.sourceCodepointSpan, label).toEqual([0, 1]);
  expect(run.selected.postscriptName, label).toBe(face.postscriptName);
  expect(run.selected.sourcePath, label).toEqual(expect.any(String));
  expect(run.selected.faceIndex, label).toEqual(expect.any(Number));
  expect(run.selected.sourceFile, label).toEqual(expect.objectContaining({
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    byteLength: expect.any(Number),
  }));
  expect(run.selected.sourceFile!.byteLength, label).toBeGreaterThan(0);
  expect(run.selected.shapesWithHarfbuzz, label).toBe(true);
  expect(run.glyphs, label).toHaveLength(1);
  const glyph = run.glyphs[0]!;
  expect(glyph.id, label).toBeGreaterThan(0);
  expect(glyph.cluster, label).toBe(0);
  expect(glyph.sourceSpan, label).toEqual([0, transformed.length]);
  expect(glyph.sourceCodepointSpan, label).toEqual([0, 1]);
  expect(glyph.xAdvance, label).toBeGreaterThan(0);
  for (const value of [glyph.yAdvance, glyph.xOffset, glyph.yOffset]) expect(Number.isFinite(value), label).toBe(true);
  expect(glyph.sourceOutline, label).toEqual(expect.objectContaining({
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    commandCount: expect.any(Number),
  }));
  expect(glyph.sourceOutline!.commandCount, label).toBeGreaterThan(0);
}

function preterminalEvidence(
  node: CapturedElement,
  width: number,
  height: number,
  transformed: string,
  face: PlatformFace,
): RenderEvidence & { run: TextRunProvenanceDiagnostic } {
  const evidence = renderEvidence(withoutCaptureTextTerminal(node), width, height);
  const runs = evidence.runs.filter((run) => run.sourceText === transformed);
  expect(runs, `${node.magicKey}: exact pre-terminal selected run`).toHaveLength(1);
  assertSelectedRun(runs[0]!, transformed, face, node.magicKey ?? transformed);
  return { ...evidence, run: runs[0]! };
}

function setHelperEnabled(enabled: boolean): void {
  if (enabled) delete process.env.DOMOTION_DISABLE_HELPER;
  else process.env.DOMOTION_DISABLE_HELPER = "1";
  invalidateFontEnvironmentCaches();
}

const cp = (text: string): number => text.codePointAt(0)!;
const italicCorrectionFont = readFileSync(new URL("./fixtures/fonts/largeop-italic-correction.woff.base64", import.meta.url), "utf8").trim();

describeBrowser("DM-2511: MathML italic-token logical oracle", () => {
  it("joins Blink math-auto geometry and face identity to the exact selected source before its terminal", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 720, height: 320 }, deviceScaleFactor: 1 });
    try {
      setHelperEnabled(true);
      await page.setContent(`<style>
        @font-face { font-family: ItalicCorrectionMath; src: url(data:font/woff;base64,${italicCorrectionFont}) format("woff"); }
        body { margin: 20px; }
        math { font-size: 32px; margin-right: 28px; }
        #script-base { font-family: ItalicCorrectionMath; }
      </style>
      <math><mi id="ascii" data-magic-key="ascii">a</mi></math>
      <math><mi id="greek" data-magic-key="greek">α</mi></math>
      <math><mi id="exceptional-h" data-magic-key="exceptional-h">h</mi></math>
      <math><mi id="supplementary" data-magic-key="supplementary">𝑎</mi></math>
      <math><mi id="normal" data-magic-key="normal" mathvariant="normal">a</mi></math>
      <math><mi id="css-italic" data-magic-key="css-italic" style="font-style:italic">b</mi></math>
      <div>
        <math display="block"><msubsup><mo id="script-base" largeop="true" movablelimits="false">⫿</mo><mi id="sub-script">x</mi><mi id="sup-script" data-magic-key="sup-script">x</mi></msubsup></math>
      </div>`, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);

      const ids = ["ascii", "greek", "exceptional-h", "supplementary", "normal", "css-italic", "sup-script"];
      const sourceRows = await page.evaluate((rowIds) => {
        const geometry = (el: Element) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          const rect = range.getBoundingClientRect();
          const style = getComputedStyle(el);
          return {
            left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width,
            textTransform: style.textTransform, fontStyle: style.fontStyle,
          };
        };
        return {
          tokens: Object.fromEntries(rowIds.map((id) => {
            const element = document.getElementById(id)!;
            return [id, { source: element.textContent ?? "", ...geometry(element) }];
          })),
          scriptControl: {
            base: geometry(document.getElementById("script-base")!),
            sup: geometry(document.getElementById("sup-script")!),
            sub: geometry(document.getElementById("sub-script")!),
          },
        };
      }, ids) as {
        tokens: Record<string, { source: string; left: number; top: number; right: number; bottom: number; width: number; textTransform: string; fontStyle: string }>;
        scriptControl: { base: { left: number }; sup: { left: number }; sub: { left: number } };
      };
      const faces = await cdpPaintedFaces(page, ids);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 720, height: 320 });
      const expected: Record<string, string> = {
        ascii: "𝑎", greek: "𝛼", "exceptional-h": "ℎ", supplementary: "𝑎",
        normal: "a", "css-italic": "𝑏", "sup-script": "𝑥",
      };

      for (const [id, transformed] of Object.entries(expected)) {
        const node = byMagicKey(tree, id);
        expect(node, id).not.toBeNull();
        const source = sourceRows.tokens[id]!;
        expect(cp(source.source), id).toBeGreaterThan(0);
        expect(node!.styles.textTransform, id).toBe(source.textTransform);
        expect(node!.text.trim(), id).toBe(transformed);
        expect(node!.textLeft, id).toBeCloseTo(source.left, 5);
        expect(node!.textTop, id).toBeCloseTo(source.top, 5);
        expect(faces[id]!.postscriptName, id).not.toBe("");

        const terminal = renderEvidence(node!, 720, 320);
        expect(terminalKinds.has(terminal.terminal.kind), `${id}: classified final terminal`).toBe(true);
        preterminalEvidence(node!, 720, 320, transformed, faces[id]!);
        expect(Math.round(node!.textTop! + node!.fontAscent!), id).toBeGreaterThan(source.top);
      }

      expect(sourceRows.tokens.ascii!.textTransform).toBe("math-auto");
      expect(sourceRows.tokens.normal!.textTransform).toBe("none");
      expect(sourceRows.tokens["css-italic"]!.fontStyle).toBe("italic");
      expect(cp(sourceRows.tokens.supplementary!.source)).toBe(0x1d44e);

      // Blink subtracts the base MATH italic correction from the subscript
      // offset while the superscript remains at the post-base origin. Equal
      // script strings make ordinary shaping/spacing a neutral control.
      expect(sourceRows.scriptControl.sup.left).toBeGreaterThan(sourceRows.scriptControl.sub.left + 0.1);
    } finally {
      restoreHelperEnvironment();
      await page.close();
    }
  }, 60_000);

  it("grades the canonical Greek fixture under helper-enabled and helper-disabled selection", async () => {
    const fixture = featureTests.find((candidate) => candidate.name === "mathml-mi-greek-italic");
    expect(fixture).toBeDefined();
    const width = fixture!.width ?? 800;
    const height = fixture!.height ?? 600;
    const page = await env!.browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    try {
      await page.setContent(fixture!.html, { waitUntil: "load" });
      await page.evaluate((tokens) => {
        for (const element of document.querySelectorAll("mi")) {
          const token = tokens.find((candidate) => candidate.source === element.textContent);
          if (token == null) continue;
          element.id = token.id;
          (element as HTMLElement).dataset.magicKey = token.id;
        }
      }, LINUX_MATHML_GREEK_TOKENS.map(({ id, source }) => ({ id, source })));
      await page.evaluate(() => document.fonts.ready);

      const ids = LINUX_MATHML_GREEK_TOKENS.map((token) => token.id);
      const sourceRows = await page.evaluate((rowIds) => Object.fromEntries(rowIds.map((id) => {
        const element = document.getElementById(id)!;
        const range = document.createRange();
        range.selectNodeContents(element);
        const rect = range.getBoundingClientRect();
        const style = getComputedStyle(element);
        return [id, {
          source: element.textContent ?? "", textTransform: style.textTransform, fontStyle: style.fontStyle,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        }];
      })), ids) as Record<string, {
        source: string; textTransform: string; fontStyle: string;
        rect: { x: number; y: number; width: number; height: number };
      }>;
      const faces = await cdpPaintedFaces(page, ids);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width, height });
      const nodes = Object.fromEntries(ids.map((id) => [id, byMagicKey(tree, id)])) as Record<string, CapturedElement | null>;
      for (const expected of LINUX_MATHML_GREEK_TOKENS) {
        expect(nodes[expected.id], expected.id).not.toBeNull();
        expect(sourceRows[expected.id]!.source, expected.id).toBe(expected.source);
        expect(sourceRows[expected.id]!.textTransform, expected.id).toBe("math-auto");
        expect(sourceRows[expected.id]!.fontStyle, expected.id).toBe("normal");
        expect(nodes[expected.id]!.text.trim(), expected.id).toBe(expected.transformed);
      }

      setHelperEnabled(true);
      expect(isGlyphHelperAvailable(), "helper-enabled control").toBe(true);
      const enabled = Object.fromEntries(LINUX_MATHML_GREEK_TOKENS.map((expected) => {
        const node = nodes[expected.id]!;
        const terminal = renderEvidence(node, width, height);
        expect(["capture-raster", "source-owned-boundary"], `${expected.id}: helper-enabled terminal`).toContain(terminal.terminal.kind);
        return [expected.id, {
          terminal: terminal.terminal,
          preterminal: preterminalEvidence(node, width, height, expected.transformed, faces[expected.id]!),
        }];
      }));

      setHelperEnabled(false);
      expect(isGlyphHelperAvailable(), "helper-disabled control").toBe(false);
      const disabled = Object.fromEntries(LINUX_MATHML_GREEK_TOKENS.map((expected) => {
        const node = nodes[expected.id]!;
        const terminal = renderEvidence(node, width, height);
        expect(["capture-raster", "source-owned-boundary"], `${expected.id}: helper-disabled terminal`).toContain(terminal.terminal.kind);
        return [expected.id, {
          terminal: terminal.terminal,
          preterminal: preterminalEvidence(node, width, height, expected.transformed, faces[expected.id]!),
        }];
      }));

      for (const expected of LINUX_MATHML_GREEK_TOKENS) {
        const on = enabled[expected.id]!;
        const off = disabled[expected.id]!;
        expect(off.terminal.kind, `${expected.id}: terminal survives helper disable`).toBe(on.terminal.kind);
        const onRun = on.preterminal.run;
        const offRun = off.preterminal.run;
        expect(onRun.selected.fontKey, `${expected.id}: helper-enabled route identity`).not.toBe("");
        expect(offRun.selected.fontKey, `${expected.id}: helper-disabled route identity`).not.toBe("");
        expect({
          postscriptName: offRun.selected.postscriptName,
          sourcePath: offRun.selected.sourcePath,
          faceIndex: offRun.selected.faceIndex,
          sourceFile: offRun.selected.sourceFile == null ? null : {
            sha256: offRun.selected.sourceFile.sha256,
            byteLength: offRun.selected.sourceFile.byteLength,
          },
          glyphs: offRun.glyphs,
        }, `${expected.id}: physical source identity remains exact`).toEqual({
          postscriptName: onRun.selected.postscriptName,
          sourcePath: onRun.selected.sourcePath,
          faceIndex: onRun.selected.faceIndex,
          sourceFile: onRun.selected.sourceFile == null ? null : {
            sha256: onRun.selected.sourceFile.sha256,
            byteLength: onRun.selected.sourceFile.byteLength,
          },
          glyphs: onRun.glyphs,
        });
      }
      const linuxProjection: LinuxMathmlGreekTokenEvidence[] = LINUX_MATHML_GREEK_TOKENS.map((expected) => {
        const source = sourceRows[expected.id]!;
        const node = nodes[expected.id]!;
        const run = enabled[expected.id]!.preterminal.run;
        const glyph = run.glyphs[0]!;
        const textTop = node.textTop ?? source.rect.y;
        const fontAscent = node.fontAscent!;
        return {
          id: expected.id,
          source: source.source,
          transformed: node.text.trim(),
          sourceCodePoint: cp(source.source),
          transformedCodePoint: cp(node.text.trim()),
          textTransform: source.textTransform as "math-auto",
          computedFontStyle: source.fontStyle as "normal",
          geometry: {
            x: node.textLeft ?? source.rect.x,
            y: textTop,
            width: node.textWidth ?? source.rect.width,
            height: node.textHeight ?? source.rect.height,
            textTop,
            fontAscent,
            baseline: textTop + fontAscent,
            matrix: [1, 0, 0, 1, 0, 0],
          },
          nativeFace: faces[expected.id]!,
          glyph: {
            gid: glyph.id,
            cluster: glyph.cluster,
            advanceX: glyph.xAdvance,
            advanceY: glyph.yAdvance,
            offsetX: glyph.xOffset,
            offsetY: glyph.yOffset,
            outlineSha256: glyph.sourceOutline!.sha256,
            outlineCommandCount: glyph.sourceOutline!.commandCount,
          },
        };
      });
      const linuxProblems = validateLinuxMathmlGreekTokenEvidence(linuxProjection);
      if (process.platform === "linux") expect(linuxProblems).toEqual([]);
      else expect(linuxProblems.length, "non-Linux host must not masquerade as authenticated FreeSans").toBeGreaterThan(0);
    } finally {
      restoreHelperEnvironment();
      await page.close();
    }
  }, 60_000);
});
