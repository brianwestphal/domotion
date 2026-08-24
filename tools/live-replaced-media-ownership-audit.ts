#!/usr/bin/env tsx
/** DM-2542 deterministic frozen-frame investigation; no production mutation. */
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { captureElementTreeWithWarnings } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const findCanvas = (tree: CapturedElement[]): CapturedElement | undefined => tree.flatMap((node) => [node, ...(node.children ?? [])]).find((node) => node.tag === "canvas");

export async function runLiveReplacedMediaOwnershipAudit() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 180, height: 120 } });
    await page.setContent("<canvas id=c width=120 height=80 style='width:120px;height:80px'></canvas>");
    const paint = (color: string) => page.locator("#c").evaluate((node, value) => {
      const canvas = node as HTMLCanvasElement;
      const context = canvas.getContext("2d")!;
      context.fillStyle = value;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }, color);
    const capture = async () => {
      const result = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 180, height: 120 });
      const snapshot = findCanvas(result.tree)?.replacedSnapshot?.dataUri;
      if (snapshot == null) throw new Error("canvas replaced snapshot missing");
      return { digest: sha(snapshot), warnings: result.warnings };
    };
    await paint("rgb(220,20,60)");
    const first = await capture();
    const same = await capture();
    await paint("rgb(20,90,220)");
    const changed = await capture();
    const warnings = [...first.warnings, ...same.warnings, ...changed.warnings];
    const controls = {
      samePresentedFrameIsStable: first.digest === same.digest,
      changedPresentedFrameMoves: first.digest !== changed.digest,
      expectedWarningsOnly: warnings.every((warning) =>
        (warning.feature === "<canvas>" && warning.detail.includes("not rendered"))
        || (warning.feature === "scrollbar-capture" && warning.detail.includes("__name is not defined"))),
    };
    return {
      schemaVersion: 1,
      sourceRevision: "chromium:7d859f271cbda744098ac69f44978d4edfa62be3",
      chromiumVersion: browser.version(),
      contract: "one frozen Chromium-presented frame embedded as a static image",
      unsupported: ["post-capture playback", "decoder-owned animation continuation", "media-time effects after capture"],
      warnings,
      controls,
      verdict: Object.values(controls).every(Boolean) ? "frozen-frame-exact" : "source-drift",
    } as const;
  } finally {
    await browser.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await runLiveReplacedMediaOwnershipAudit();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.verdict !== "frozen-frame-exact") process.exitCode = 1;
}
