#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(".chromium-build/worktrees/dm2573/src");
const patchPath = resolve("tools/chromium-paged-page-record/renderer-page-record.patch");
const patch = readFileSync(patchPath);
const installed = execFileSync("git", ["-C", root, "diff", "--binary"], {
  maxBuffer: 4 * 1024 * 1024,
});
if (!installed.equals(patch)) {
  throw new Error("installed pinned Chromium delta differs from the retained DM-2710 patch");
}
const text = patch.toString("utf8");
for (const required of [
  "per-page-after-paint-before-record-consumption",
  "PostLayoutChildren()",
  "PreflightPaintRecord",
  "SkSVGCanvas::kConvertTextToPaths_Flag",
  "domotionPagedPageRecord",
  "kDomotionPagedPageRecordMaxBytes = 64 * 1024 * 1024",
]) {
  if (!text.includes(required)) throw new Error(`DM-2710 patch is missing ${required}`);
}
for (const forbidden of ["Page.captureScreenshot", "printToPDF-pdf-input"]) {
  if (text.includes(forbidden)) throw new Error(`DM-2710 patch contains forbidden input: ${forbidden}`);
}
console.log(JSON.stringify({
  chromiumRevision: "7d859f271cbda744098ac69f44978d4edfa62be3",
  patchSha256: createHash("sha256").update(patch).digest("hex"),
  patchByteLength: patch.byteLength,
  installedSourceDeltaMatchesExactly: true,
  captureDefaultEnabled: false,
  maximumSidecarBytes: 64 * 1024 * 1024,
}, null, 2));
