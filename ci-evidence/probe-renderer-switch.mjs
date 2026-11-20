// Does the first page's renderer start with --disable-gpu-compositing?
// usage: node tools/scratch/probe-renderer-switch.mjs [barrier|raw]
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";

const mode = process.argv[2] ?? "raw";
const browser = await chromium.launch({ headless: true });
if (mode === "barrier") {
  const s = await browser.newBrowserCDPSession();
  await s.send("SystemInfo.getInfo");
  await s.detach();
}
const page = await browser.newPage();
await page.setContent("<p>x</p>");
const ps =
  process.platform === "win32"
    ? execFileSync(
        "powershell",
        ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }"],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      )
    : execFileSync("ps", ["-ax", "-o", "command"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const renderers = ps.split("\n").filter((l) => l.includes("--type=renderer") && l.includes("headless"));
for (const r of renderers) {
  console.log(mode, "renderer disable-gpu-compositing:", r.includes("--disable-gpu-compositing"));
}
await browser.close();
