#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { chromium } from "@playwright/test";

const binaryPath = resolve(process.argv[2] ??
  ".chromium-build/worktrees/dm2573/src/out/DM2573/headless_shell");
const outputPath = resolve(process.argv[3] ??
  "docs/evidence/dm2711-paged-page-svg-smoke.json");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fontPath = resolve("assets/fonts/fixture/DomotionFixtureMono-Regular.ttf");
const fontBytes = await readFile(fontPath);
const fontSha256 = sha256(fontBytes);
const fontDataUrl = `data:font/ttf;base64,${fontBytes.toString("base64")}`;
const expectedOracle = {
  binarySha256: "228befe1ecb53e21ac4cab40c8ddc118da02cdc6e8e4d90656e1e953e3a1c9d6",
  pinnedFontSha256: "aa42f50d4b43c91b1af561b48d75d6d3b5a54902eb83a8912934cfc2821e46a8",
  logicalLedgerByteLength: 572_991,
  logicalLedgerSha256: "3de1162959d13537c180441919a067147e4299bdb84a4369d06496e4caa761e1",
  pages: [
    [91_677, "dc6891cabe3f5498db448d2d22802507bf32f66687f6fbe1e85e83b44d7561ee"],
    [43_120, "facef769b1acf5c8219932b50ae5c5ca748064b540551e42163283310cdaf88f"],
    [85_375, "1e82b22c04e24a21e6c2d152e1498758f8f2298e02fa7ad27c08b9ff9c1fa919"],
    [34_089, "5cf3d41af217398dab9d40d24d2ce6f735185698b56ab108d66853dcbbf013a9"],
    [65_905, "55893d5c09c5dac46de29c06a6aa9ca76829d46963ae9fc724f18988f204c0b2"],
    [19_755, "867370eed12297f7ef643e9a279345a1db1974516d7a7364bac452443e5f67e7"],
    [10_161, "1212385586ec6378b1caf77193b1e2fe2bef8be86f8aec1999f465ba4e7e9a4c"],
    [9_058, "828e34b74132f59361348d31b5efd9d8dc9f93e4e2504b3cfa8007d992771276"],
  ],
};

async function discardPdfStream(session, response) {
  if (typeof response.stream !== "string" || response.stream.length === 0) {
    throw new Error("printToPDF did not return the requested unopened PDF stream");
  }
  if (typeof response.data === "string" && response.data.length > 0) {
    throw new Error("printToPDF unexpectedly materialized PDF bytes");
  }
  await session.send("IO.close", { handle: response.stream });
}

const browser = await chromium.launch({
  executablePath: binaryPath,
  headless: true,
  args: ["--no-first-run", "--disable-background-networking"],
});
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(`<!doctype html>
    <style>
      @font-face { font-family: DM2711Fixture; src: url("${fontDataUrl}") format("truetype"); font-display: block; }
      @page { size: 420px 320px; margin: 24px; }
      * { box-sizing: border-box; }
      body { margin: 0; font: 13px DM2711Fixture; background: #fff7ed; }
      table { border-collapse: collapse; width: 100%; }
      caption { caption-side: top; }
      th, td { border: 3px solid #234; padding: 5px; }
      thead, tfoot { break-inside: avoid; }
      .continued { height: 350px; vertical-align: top; }
      .forced { break-before: page; break-after: page; }
      .row-break { break-before: page; break-after: page; }
      .rtl-zoom { direction: rtl; zoom: 1.2; }
      .bottom { caption-side: bottom; }
      .vertical-rl { writing-mode: vertical-rl; width: 150px; height: 210px; }
      .vertical-lr { writing-mode: vertical-lr; width: 150px; height: 210px; }
    </style>
    <table id="flow"><caption>Top caption</caption>
      <thead><tr><th>Key</th><th>Value</th><th>Note</th></tr></thead>
      <tfoot><tr><td colspan="3">Repeated footer</td></tr></tfoot>
      <tbody>
        <tr><td rowspan="2">row span</td><td colspan="2">column span</td></tr>
        <tr><td>span continuation</td><td>cell</td></tr>
        ${Array.from({ length: 8 }, (_, index) =>
          `<tr${index === 3 ? ' class="row-break"' : ""}><td>Row ${index + 1}</td><td>${index * index}</td><td>whole row</td></tr>`).join("")}
        <tr><td>continued row</td><td colspan="2" class="continued">Tall cell</td></tr>
        ${Array.from({ length: 5 }, (_, index) =>
          `<tr><td>Tail ${index + 1}</td><td>${index + 20}</td><td>end</td></tr>`).join("")}
      </tbody>
    </table>
    <section class="forced"><table class="rtl-zoom"><caption class="bottom">Bottom caption</caption>
      <tbody><tr><td>RTL</td><td>zoom</td></tr><tr><td>second</td><td>row</td></tr></tbody></table></section>
    <section class="forced"><table class="vertical-rl"><tbody><tr><td>vertical right</td><td>one</td></tr></tbody></table></section>
    <section class="forced"><table class="vertical-lr"><tbody><tr><td>vertical left</td><td>two</td></tr></tbody></table></section>`);
  await page.evaluate(() => document.fonts.ready);
  const session = await page.context().newCDPSession(page);
  const request = {
    printBackground: true,
    preferCSSPageSize: true,
    transferMode: "ReturnAsStream",
  };
  const defaultOff = await session.send("Page.printToPDF", request);
  await discardPdfStream(session, defaultOff);
  if ("domotionPagedPageRecord" in defaultOff) {
    throw new Error("ordinary printToPDF unexpectedly returned a paged-page record");
  }
  const enabled = await session.send("Page.printToPDF", {
    ...request,
    domotionPagedTableEvidence: true,
  });
  await discardPdfStream(session, enabled);
  if (typeof enabled.domotionPagedPageRecord !== "string") {
    throw new Error("private printToPDF response omitted the paged-page record");
  }
  if (enabled.domotionSourceRestoredExactly !== true) {
    throw new Error("PrintEnd did not restore the observed source layout state");
  }
  const record = JSON.parse(enabled.domotionPagedPageRecord);
  const tableRecord = JSON.parse(enabled.domotionPagedTableEvidence);
  if (record.helperAbi !== "domotion-paged-page-record-v1"
      || record.capturePhase !== "per-page-after-paint-before-record-consumption"
      || record.pdfOrScreenshotUsedAsInput !== false
      || record.printCaptureId !== tableRecord.printCaptureId
      || !Array.isArray(record.pages) || record.pages.length < 2) {
    throw new Error("paged-page record identity or multi-page coverage is incomplete");
  }
  const unavailable = record.pages.filter((candidate) => candidate.status !== "authenticated");
  if (unavailable.length > 0) {
    throw new Error(`smoke page failed closed: ${JSON.stringify(unavailable.map((page) => ({
      pageIndex: page.pageIndex,
      reason: page.reason,
      unsupportedPaintOps: page.unsupportedPaintOps,
    })))}`);
  }
  if (!Array.isArray(tableRecord.pages)
      || tableRecord.pages.length !== record.pages.length) {
    throw new Error("full and same-hook table transports disagree on page coverage");
  }
  const matrix = {
    repeatedHeader: false,
    repeatedFooter: false,
    wholeRowSeam: false,
    continuedRowSeam: false,
    topCaption: false,
    bottomCaption: false,
    spanningInterior: false,
    forcedBreak: false,
    nonUnitZoom: false,
    rtl: false,
    verticalRl: false,
    verticalLr: false,
    rawLogicalRectCount: 0,
    resolvedEdgeGridEntries: 0,
  };
  const resolvedGridByTableSource = new Map();
  for (const [selectionIndex, candidate] of record.pages.entries()) {
    const svgRoot = /<svg\b([^>]*)>/.exec(candidate.vectorPaintSvg ?? "")?.[1] ?? "";
    const width = Number(/\bwidth="([0-9.]+)"/.exec(svgRoot)?.[1]);
    const height = Number(/\bheight="([0-9.]+)"/.exec(svgRoot)?.[1]);
    if (candidate.selectionIndex !== selectionIndex
        || typeof candidate.pageIndex !== "number"
        || !Array.isArray(candidate.fragments) || candidate.fragments.length === 0
        || !candidate.fragments.some((fragment) => fragment.kind === "page-area")
        || !Array.isArray(candidate.paintOpTypes) || candidate.paintOpTypes.length === 0
        || typeof candidate.vectorPaintSvg !== "string"
        || !candidate.vectorPaintSvg.includes("<svg")
        || width !== Math.ceil(candidate.pageContainer.width)
        || height !== Math.ceil(candidate.pageContainer.height)
        || !new RegExp(`\\bviewBox="0 0 ${width} ${height}"`).test(svgRoot)) {
      throw new Error(`page ${selectionIndex} lacks authenticated geometry or vector paint: ${JSON.stringify({
        returnedSelectionIndex: candidate.selectionIndex,
        pageIndex: candidate.pageIndex,
        fragmentCount: candidate.fragments?.length,
        hasPageArea: candidate.fragments?.some((fragment) => fragment.kind === "page-area"),
        paintOpCount: candidate.paintOpTypes?.length,
        vectorPaintPrefix: candidate.vectorPaintSvg?.slice(0, 80),
      })}`);
    }
    if (JSON.stringify(candidate.collapsedTablePage)
        !== JSON.stringify(tableRecord.pages[candidate.pageIndex])) {
      throw new Error(`page ${candidate.pageIndex} same-hook table facts differ from the full sidecar`);
    }
    matrix.forcedBreak ||= candidate.fragments.some((fragment) =>
      fragment.breakToken?.forcedBreak === true
      || fragment.breakBefore !== 0 || fragment.breakAfter !== 0);
    matrix.nonUnitZoom ||= candidate.fragments.some((fragment) =>
      fragment.effectiveZoom !== 1);
    for (const table of candidate.collapsedTablePage.tableOccurrences) {
      matrix.rtl ||= table.direction === "rtl";
      matrix.verticalRl ||= table.writingMode === "vertical-rl";
      matrix.verticalLr ||= table.writingMode === "vertical-lr";
      matrix.topCaption ||= table.captionOccurrences.some((caption) =>
        caption.side === "block-start");
      matrix.bottomCaption ||= table.captionOccurrences.some((caption) =>
        caption.side === "block-end");
      matrix.repeatedHeader ||= table.sectionOccurrences.some((section) =>
        section.repeatRole === "repeated-header");
      matrix.repeatedFooter ||= table.sectionOccurrences.some((section) =>
        section.repeatRole === "repeated-footer");
      matrix.wholeRowSeam ||= table.sectionOccurrences.some((section) =>
        section.startBreak.kind === "whole-row" || section.endBreak.kind === "whole-row");
      matrix.continuedRowSeam ||= table.sectionOccurrences.some((section) =>
        section.startBreak.kind === "continued-row" || section.endBreak.kind === "continued-row");
      matrix.spanningInterior ||= table.spanningCells.some((span) =>
        span.interiorCollapsedEdgeIndices.length > 0);
      const edgesPerRow = (table.totalColumns + 1) * 2;
      const expectedResolvedIndices = [];
      for (let row = 0; row <= table.totalRows; row++) {
        for (let column = 0; column <= table.totalColumns; column++) {
          if (row < table.totalRows) expectedResolvedIndices.push(row * edgesPerRow + column * 2);
          if (column < table.totalColumns) expectedResolvedIndices.push(row * edgesPerRow + column * 2 + 1);
        }
      }
      if (!Array.isArray(table.resolvedCollapsedEdgeGrid)
          || table.resolvedCollapsedEdgeGrid.length !== expectedResolvedIndices.length
          || table.resolvedCollapsedEdgeGrid.some((edge, index) =>
            edge.sourceEdgeIndex !== expectedResolvedIndices[index])) {
        throw new Error(`page ${candidate.pageIndex} has an incomplete resolved collapsed-edge grid`);
      }
      matrix.resolvedEdgeGridEntries += table.resolvedCollapsedEdgeGrid.length;
      const resolvedGridJson = JSON.stringify(table.resolvedCollapsedEdgeGrid);
      const priorGrid = resolvedGridByTableSource.get(table.tableSourceIndex);
      if (priorGrid != null && priorGrid !== resolvedGridJson) {
        throw new Error(`table ${table.tableSourceIndex} resolved edge grid changed across page occurrences`);
      }
      resolvedGridByTableSource.set(table.tableSourceIndex, resolvedGridJson);
      for (const edge of table.collapsedEdges) {
        const painted = edge.paintOrder !== null;
        if (painted !== (edge.logicalRectRaw !== null)
            || (edge.logicalRectRaw && !Object.values(edge.logicalRectRaw).every(Number.isSafeInteger))) {
          throw new Error(`page ${candidate.pageIndex} has an inexact raw collapsed-border tuple`);
        }
        if (painted) matrix.rawLogicalRectCount += 1;
      }
    }
  }
  const missingMatrix = Object.entries(matrix).filter(([, value]) =>
    value === false || value === 0).map(([name]) => name);
  if (missingMatrix.length > 0) {
    throw new Error(`native fixture matrix is incomplete: ${missingMatrix.join(", ")}`);
  }
  const repeated = await session.send("Page.printToPDF", {
    ...request,
    domotionPagedTableEvidence: true,
  });
  await discardPdfStream(session, repeated);
  const repeatedRecord = JSON.parse(repeated.domotionPagedPageRecord);
  const repeatedTableRecord = JSON.parse(repeated.domotionPagedTableEvidence);
  if (repeated.domotionSourceRestoredExactly !== true
      || repeatedRecord.printCaptureId !== repeatedTableRecord.printCaptureId
      || repeatedRecord.printCaptureId === record.printCaptureId
      || repeatedRecord.pages.length !== record.pages.length
      || repeatedRecord.pages.some((candidate, index) =>
        candidate.vectorPaintSvg !== record.pages[index].vectorPaintSvg)) {
    throw new Error("repeated same-process capture was not transaction-bound and byte-deterministic");
  }
  const withoutBackgrounds = await session.send("Page.printToPDF", {
    ...request,
    printBackground: false,
    domotionPagedTableEvidence: true,
  });
  await discardPdfStream(session, withoutBackgrounds);
  const withoutBackgroundsRecord = JSON.parse(withoutBackgrounds.domotionPagedPageRecord);
  const withoutBackgroundsTableRecord = JSON.parse(withoutBackgrounds.domotionPagedTableEvidence);
  if (JSON.stringify(withoutBackgroundsTableRecord.printParameters)
        === JSON.stringify(tableRecord.printParameters)
      || withoutBackgroundsRecord.pages.every((candidate, index) =>
        candidate.vectorPaintSvg === record.pages[index]?.vectorPaintSvg)) {
    throw new Error("paint-affecting printBackground policy is not bound by native parameters and SVG bytes");
  }
  await page.setContent(`<!doctype html><script>
    addEventListener("beforeprint", () => {
      const frame = document.createElement("iframe");
      frame.id = "transient-print-frame";
      frame.srcdoc = "<p>painted child frame</p>";
      document.body.append(frame);
    });
    addEventListener("afterprint", () => document.querySelector("#transient-print-frame")?.remove());
  </script><p>top document</p>`);
  const transientChildFrame = await session.send("Page.printToPDF", {
    ...request,
    domotionPagedTableEvidence: true,
  });
  await discardPdfStream(session, transientChildFrame);
  const transientChildFrameRecord = JSON.parse(transientChildFrame.domotionPagedPageRecord);
  if (transientChildFrame.domotionSourceRestoredExactly !== true
      || !transientChildFrameRecord.pages?.some((candidate) =>
        candidate.status === "unavailable"
        && candidate.unsupportedPaintOps?.includes("ChildFrame"))) {
    throw new Error("transient beforeprint child frame did not fail closed at the native paint hook");
  }
  const binary = await readFile(binaryPath);
  const sidecar = Buffer.from(enabled.domotionPagedPageRecord, "utf8");
  const logicalLedger = Buffer.from(`${JSON.stringify({ pages: tableRecord.pages }, null, 2)}\n`, "utf8");
  const artifact = {
    schemaVersion: 1,
    ticket: "DM-2711",
    chromiumRevision: "7d859f271cbda744098ac69f44978d4edfa62be3",
    binaryPath,
    binarySha256: sha256(binary),
    pinnedFontPath: fontPath,
    pinnedFontSha256: fontSha256,
    defaultOff: true,
    privateResponsePresent: true,
    observedPrintLayoutStateRestoredExactly: true,
    pdfOrScreenshotBytesReadForFacts: false,
    sidecarByteLength: sidecar.byteLength,
    sidecarSha256: sha256(sidecar),
    pageCount: record.pages.length,
    repeatCaptureUsedDistinctTransactionNonce: true,
    repeatCaptureSvgBytesIdentical: true,
    printBackgroundParameterAndPaintBound: true,
    transientBeforePrintChildFrameRejected: true,
    logicalLedgerByteLength: logicalLedger.byteLength,
    logicalLedgerSha256: sha256(logicalLedger),
    matrix,
    pages: record.pages.map((candidate) => ({
      selectionIndex: candidate.selectionIndex,
      pageIndex: candidate.pageIndex,
      fragmentCount: candidate.fragments.length,
      inlineItemCount: candidate.fragments.reduce(
        (sum, fragment) => sum + fragment.inlineItems.length, 0),
      paintOpCount: candidate.paintOpTypes.length,
      vectorPaintByteLength: candidate.vectorPaintByteLength,
      vectorPaintSha256: sha256(candidate.vectorPaintSvg),
    })),
    pass: true,
  };
  const actualOracle = {
    binarySha256: artifact.binarySha256,
    pinnedFontSha256: artifact.pinnedFontSha256,
    logicalLedgerByteLength: artifact.logicalLedgerByteLength,
    logicalLedgerSha256: artifact.logicalLedgerSha256,
    pages: artifact.pages.map((candidate) =>
      [candidate.vectorPaintByteLength, candidate.vectorPaintSha256]),
  };
  if (JSON.stringify(actualOracle) !== JSON.stringify(expectedOracle)) {
    throw new Error(`native expected-vs-SVG oracle drifted: ${JSON.stringify(actualOracle)}`);
  }
  await mkdir(dirname(outputPath), { recursive: true });
  const pagesDirectory = resolve(dirname(outputPath), "dm2711-paged-page-svg.pages");
  await mkdir(pagesDirectory, { recursive: true });
  await writeFile(resolve(dirname(outputPath), "dm2711-paged-page-logical-ledger.json"), logicalLedger);
  await Promise.all(record.pages.map((candidate) => writeFile(
    resolve(pagesDirectory, `page-${String(candidate.pageIndex + 1).padStart(4, "0")}.svg`),
    candidate.vectorPaintSvg,
  )));
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify({
    pass: true,
    pages: artifact.pageCount,
    sidecarByteLength: artifact.sidecarByteLength,
    observedPrintLayoutStateRestoredExactly: artifact.observedPrintLayoutStateRestoredExactly,
  }, null, 2));
} finally {
  await browser.close().catch(() => {});
}
