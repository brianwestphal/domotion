import * as fk from "fontkit";
import { captureElementTree, launchChromium, type CapturedElement } from "../src/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import {
  getFixtureTextRunProvenance,
  resetTextRunProvenance,
  setTextRunProvenanceEnabled,
} from "../src/render/text-run-provenance.js";
import { setRenderTextMode } from "../src/render/text-to-path.js";

const fontkit = (fk as { default?: typeof fk }).default ?? fk;
const SOURCE = "LABEL TEXT";
const html = `<!doctype html><style>*{box-sizing:border-box}body{margin:0;background:#fff}</style>
<div style="padding:20px"><div style="font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.05em;font-family:-apple-system,sans-serif">Label text</div></div>`;

function findText(nodes: CapturedElement[], text: string): CapturedElement | null {
  for (const node of nodes) {
    if (node.text === text) return node;
    const child = findText(node.children ?? [], text);
    if (child != null) return child;
  }
  return null;
}

function unitsPerEm(path: string, faceIndex: number | null): number {
  const opened = fontkit.openSync(path) as unknown as { fonts?: Array<{ unitsPerEm: number }>; unitsPerEm?: number };
  if (opened.fonts != null) return opened.fonts[faceIndex ?? 0].unitsPerEm;
  return opened.unitsPerEm ?? 1000;
}

const browser = await launchChromium({ args: ["--font-render-hinting=none"] });
try {
  const page = await browser.newPage({ viewport: { width: 320, height: 120 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 320, height: 120 });
  const node = findText(tree, SOURCE);
  if (node == null) throw new Error("text-small label was not captured");
  const segment = node.textSegments?.find((candidate) => candidate.text === SOURCE);
  const xOffsets = segment?.xOffsets;
  if (segment == null || xOffsets == null || xOffsets.length !== SOURCE.length) {
    throw new Error("text-small label lacks complete captured xOffsets");
  }

  setRenderTextMode("paths");
  setTextRunProvenanceEnabled(true);
  resetTextRunProvenance();
  elementTreeToSvg(tree, 320, 120);
  const provenance = getFixtureTextRunProvenance("text-small");
  const run = provenance.runs.find((candidate) => candidate.sourceText === SOURCE);
  if (run == null || run.shapeError != null || run.selected.sourcePath == null) {
    throw new Error(`no shaped provenance for text-small: ${run?.shapeError ?? "missing run"}`);
  }

  const upem = unitsPerEm(run.selected.sourcePath, run.selected.faceIndex);
  const scale = run.request.fontSizePx / upem;
  const origin0 = xOffsets[0];
  let nativeCursor = 0;
  let previousCluster = -1;
  let clusterCursor = 0;
  const nativeAnchors = new Map<number, number>();
  for (const glyph of run.glyphs) {
    if (!nativeAnchors.has(glyph.cluster)) nativeAnchors.set(glyph.cluster, nativeCursor);
    nativeCursor += glyph.xAdvance * scale;
  }
  const rows = run.glyphs.map((glyph) => {
    if (glyph.cluster !== previousCluster) {
      previousCluster = glyph.cluster;
      clusterCursor = 0;
    }
    const capturedOrigin = xOffsets[glyph.sourceSpan[0]] - origin0;
    const emittedOrigin = capturedOrigin + (clusterCursor + glyph.xOffset) * scale;
    const collapsedOrigin = (nativeAnchors.get(glyph.cluster) ?? 0) + (clusterCursor + glyph.xOffset) * scale;
    clusterCursor += glyph.xAdvance;
    return {
      glyphId: glyph.id,
      cluster: glyph.cluster,
      capturedOrigin,
      rawHarfBuzz: { xAdvance: glyph.xAdvance, xOffset: glyph.xOffset, yOffset: glyph.yOffset },
      emittedOrigin,
      collapsedMutationOrigin: collapsedOrigin,
    };
  });
  const last = rows.at(-1)!;
  const mutationDelta = last.collapsedMutationOrigin - last.emittedOrigin;
  if (Math.abs(mutationDelta) < 1) throw new Error(`collapsed-anchor mutation was inert (${mutationDelta})`);
  if (!rows.every((row) => Math.abs(row.emittedOrigin - row.capturedOrigin - row.rawHarfBuzz.xOffset * scale) < 1e-6)) {
    throw new Error("emitted cluster origins do not preserve captured anchors");
  }

  const baseline = Math.floor(segment.y + (segment.fontAscent ?? node.fontAscent ?? 0) + 0.5);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    platform: process.platform,
    sourceAuthority: provenance.sourceAuthority,
    record: {
      sourceText: SOURCE,
      selectedFace: run.selected,
      fontSizePx: run.request.fontSizePx,
      unitsPerEm: upem,
      snappedBaseline: baseline,
      rows,
      mutation: { kind: "collapse-captured-cluster-anchors-to-native-advances", lastGlyphDeltaPx: mutationDelta },
    },
  }, null, 2)}\n`);
} finally {
  setTextRunProvenanceEnabled(false);
  setRenderTextMode("embedded-font");
  await browser.close();
}
