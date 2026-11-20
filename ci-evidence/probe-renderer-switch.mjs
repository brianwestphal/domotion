// Does the first page's renderer start with --disable-gpu-compositing?
// Only this browser's descendants are inspected (other browsers may be running).
// usage: node tools/scratch/probe-renderer-switch.mjs [barrier|raw]
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";

const mode = process.argv[2] ?? "raw";
const marker = `--domotion-probe-${process.pid}-${Date.now()}`;
const browser = await chromium.launch({ headless: true, args: [marker] });
if (mode === "barrier") {
  const s = await browser.newBrowserCDPSession();
  const info = await s.send("SystemInfo.getInfo");
  await s.detach();
  console.log(
    "at barrier:",
    JSON.stringify({
      compositing: info.gpu.featureStatus?.gpu_compositing,
      webgl: info.gpu.featureStatus?.webgl,
      gl: info.gpu.auxAttributes?.glImplementationParts,
    }),
  );
}
if (process.env.LIST_BEFORE) console.log(mode, "renderers before newPage:", JSON.stringify(rendererSwitches()));
const page = await browser.newPage();
await page.setContent("<p>x</p>");

function processes() {
  if (process.platform === "win32") {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)\" }",
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    return out.split(/\r?\n/).map((l) => l.split("\t"));
  }
  const out = execFileSync("ps", ["-axww", "-o", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\n").map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return m ? [m[1], m[2], m[3]] : [];
  });
}

function rendererSwitches() {
const procs = processes().filter((p) => p.length === 3);
const root = procs.find(([, , cmd]) => cmd.includes(marker) && !cmd.includes("--type="));
const tree = new Set(root ? [root[0]] : []);
let grew = true;
while (grew) {
  grew = false;
  for (const [pid, ppid] of procs) {
    if (!tree.has(pid) && tree.has(ppid)) {
      tree.add(pid);
      grew = true;
    }
  }
}
return procs
  .filter(([pid, , cmd]) => tree.has(pid) && cmd.includes("--type=renderer"))
  .map(([pid, , cmd]) => `${pid}:${cmd.includes("--disable-gpu-compositing") ? "sw" : "gpu"}:zerocopy=${cmd.includes("--enable-zero-copy")}`);
}
console.log(mode, "renderers after page (pid:sw = has --disable-gpu-compositing):", JSON.stringify(rendererSwitches()));
await browser.close();
