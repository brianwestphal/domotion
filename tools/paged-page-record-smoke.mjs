#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { chromium } from "@playwright/test";

const binaryPath = resolve(process.argv[2] ??
  ".chromium-build/worktrees/dm2573/src/out/DM2573/headless_shell");
const outputPath = resolve(process.argv[3] ??
  "docs/evidence/dm2710-paged-page-record-smoke.json");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const browser = await chromium.launch({
  executablePath: binaryPath,
  headless: true,
  args: ["--no-first-run", "--disable-background-networking"],
});
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(`<!doctype html>
    <style>
      @page { size: 420px 320px; margin: 24px; }
      body { margin: 0; font: 16px Arial; }
      h1 { background: linear-gradient(90deg, #e7f0ff, #fff); }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 3px solid #234; padding: 8px; }
      thead { break-inside: avoid; }
    </style>
    <h1>Paged record</h1>
    <table><thead><tr><th>Key</th><th>Value</th></tr></thead>
      <tbody>${Array.from({ length: 18 }, (_, index) =>
        `<tr><td>Row ${index + 1}</td><td>${index * index}</td></tr>`).join("")}</tbody>
    </table>`);
  const session = await page.context().newCDPSession(page);
  const request = {
    printBackground: true,
    preferCSSPageSize: true,
    transferMode: "ReturnAsBase64",
  };
  const defaultOff = await session.send("Page.printToPDF", request);
  if ("domotionPagedPageRecord" in defaultOff) {
    throw new Error("ordinary printToPDF unexpectedly returned a paged-page record");
  }
  const enabled = await session.send("Page.printToPDF", {
    ...request,
    domotionPagedTableEvidence: true,
  });
  if (typeof enabled.domotionPagedPageRecord !== "string") {
    throw new Error("private printToPDF response omitted the paged-page record");
  }
  if (enabled.domotionSourceRestoredExactly !== true) {
    throw new Error("PrintEnd did not restore the observed source layout state");
  }
  const record = JSON.parse(enabled.domotionPagedPageRecord);
  if (record.helperAbi !== "domotion-paged-page-record-v1"
      || record.capturePhase !== "per-page-after-paint-before-record-consumption"
      || record.pdfOrScreenshotUsedAsInput !== false
      || !Array.isArray(record.pages) || record.pages.length < 2) {
    throw new Error("paged-page record identity or multi-page coverage is incomplete");
  }
  const unavailable = record.pages.filter((candidate) => candidate.status !== "authenticated");
  if (unavailable.length > 0) {
    throw new Error(`smoke page failed closed: ${JSON.stringify(unavailable)}`);
  }
  for (const [selectionIndex, candidate] of record.pages.entries()) {
    if (candidate.selectionIndex !== selectionIndex
        || typeof candidate.pageIndex !== "number"
        || !Array.isArray(candidate.fragments) || candidate.fragments.length === 0
        || !candidate.fragments.some((fragment) => fragment.kind === "page-area")
        || !Array.isArray(candidate.paintOpTypes) || candidate.paintOpTypes.length === 0
        || typeof candidate.vectorPaintSvg !== "string"
        || !candidate.vectorPaintSvg.includes("<svg")) {
      throw new Error(`page ${selectionIndex} lacks authenticated geometry or vector paint: ${JSON.stringify({
        returnedSelectionIndex: candidate.selectionIndex,
        pageIndex: candidate.pageIndex,
        fragmentCount: candidate.fragments?.length,
        hasPageArea: candidate.fragments?.some((fragment) => fragment.kind === "page-area"),
        paintOpCount: candidate.paintOpTypes?.length,
        vectorPaintPrefix: candidate.vectorPaintSvg?.slice(0, 80),
      })}`);
    }
  }
  const binary = await readFile(binaryPath);
  const sidecar = Buffer.from(enabled.domotionPagedPageRecord, "utf8");
  const artifact = {
    schemaVersion: 1,
    ticket: "DM-2710",
    chromiumRevision: "7d859f271cbda744098ac69f44978d4edfa62be3",
    binaryPath,
    binarySha256: sha256(binary),
    defaultOff: true,
    privateResponsePresent: true,
    sourceRestoredExactly: true,
    pdfOrScreenshotBytesReadForFacts: false,
    sidecarByteLength: sidecar.byteLength,
    sidecarSha256: sha256(sidecar),
    pageCount: record.pages.length,
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
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify({
    pass: true,
    pages: artifact.pageCount,
    sidecarByteLength: artifact.sidecarByteLength,
    sourceRestoredExactly: artifact.sourceRestoredExactly,
  }, null, 2));
} finally {
  await browser.close().catch(() => {});
}
