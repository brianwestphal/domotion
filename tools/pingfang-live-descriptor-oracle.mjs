import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { chromium } from "@playwright/test";
import { PINGFANG_DESCRIPTOR_CODEPOINTS as cps, validatePingFangDescriptorArtifact } from "./pingfang-live-descriptor-schema.mjs";

if (process.platform !== "darwin") throw new Error("PingFang live descriptor oracle requires macOS");
const swift = new URL("./pingfang-live-descriptor.swift", import.meta.url).pathname;
const runSwift = (repeats) => JSON.parse(execFileSync("swift", [swift, String(repeats)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
const cold = [runSwift(1), runSwift(1), runSwift(1)];
const warm = runSwift(3);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent(cps.map((cp) => `<span data-cp="${cp}" style="font:32px STHeitiSC-Light">${String.fromCodePoint(cp)}</span>`).join(""));
const session = await page.context().newCDPSession(page);
await session.send("DOM.enable"); await session.send("CSS.enable");
const browserRows = [];
for (const cp of cps) {
  const node = page.locator(`[data-cp="${cp}"]`);
  const width = await node.evaluate((el) => { const range = document.createRange(); range.selectNodeContents(el); return range.getBoundingClientRect().width; });
  const { root } = await session.send("DOM.getDocument");
  const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector: `[data-cp="${cp}"]` });
  const fonts = await session.send("CSS.getPlatformFontsForNode", { nodeId });
  browserRows.push({ codepoint: cp, hex: `U+${cp.toString(16).toUpperCase()}`, rangeWidth: width, platformFonts: fonts.fonts });
}
const chromiumVersion = await browser.version(); await browser.close();
const command = (cmd, args = []) => { try { return execFileSync(cmd, args, { encoding: "utf8" }).trim(); } catch { return null; } };
const inventory = command("system_profiler", ["SPFontsDataType", "-json"]) ?? "";
const artifact = {
  schemaVersion: 1,
  environment: { os: os.version(), release: os.release(), arch: os.arch(), swVers: command("sw_vers"), chromiumVersion,
    sourceSha: command("git", ["rev-parse", "HEAD"]), fontInventoryDigest: createHash("sha256").update(inventory).digest("hex") },
  codepoints: cps, coldProcesses: cold, warmProcess: warm, browserRows,
};
validatePingFangDescriptorArtifact(artifact);
const output = process.env.PINGFANG_DESCRIPTOR_OUTPUT ?? "pingfang-live-descriptor.json";
writeFileSync(output, JSON.stringify(artifact, null, 2) + "\n");
console.log(`PINGFANG-DESCRIPTOR ${output} ${readFileSync(output).length} bytes`);
