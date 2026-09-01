import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import sharp from "sharp";
import { runAnimate } from "../src/cli/animate.js";
import { launchChromium } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

async function canLaunch(): Promise<boolean> {
  try {
    const browser = await launchChromium({ headless: true });
    await closeBrowserSafely(browser);
    return true;
  } catch {
    return false;
  }
}

const browserAvailable = await canLaunch();
const describeBrowser = browserAvailable ? describe : describe.skip;
const dir = mkdtempSync(join(tmpdir(), "domotion-animate-debug-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describeBrowser("animate debug reproduction bundle (DM-2636)", () => {
  it("writes one shared HAR, final SVG, and source/tree artifacts for every frame", async () => {
    const html = join(dir, "page.html");
    const config = join(dir, "demo.json");
    const output = join(dir, "demo.svgz");
    writeFileSync(html, `<!doctype html><style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%}body{background:#fff;font:24px sans-serif}.value{padding:20px;color:#123456}</style><div class="value">zero</div>`);
    writeFileSync(config, JSON.stringify({
      width: 180,
      height: 90,
      autoCompress: false,
      frames: [
        { input: html, duration: 200 },
        { continue: true, duration: 200, actions: [{ type: "setText", selector: ".value", value: "one" }] },
        { template: "lower-third", params: { title: "Embedded" }, duration: 300 },
      ],
    }));

    await runAnimate([config, "--quiet", "--debug", "--optimize", "-o", output], "");

    const debugDir = join(dir, "demo.debug");
    const har = JSON.parse(readFileSync(join(debugDir, "capture.har"), "utf8")) as { log?: { entries?: unknown[] } };
    expect(har.log).toBeTypeOf("object");
    expect(Array.isArray(har.log?.entries)).toBe(true);
    expect(readFileSync(join(debugDir, "actual.svg"), "utf8")).toBe(gunzipSync(readFileSync(output)).toString("utf8"));

    const expected0 = join(debugDir, "frames", "000", "expected.png");
    const expected1 = join(debugDir, "frames", "001", "expected.png");
    const tree0 = join(debugDir, "frames", "000", "captured-tree.json");
    const tree1 = join(debugDir, "frames", "001", "captured-tree.json");
    const expected2 = join(debugDir, "frames", "002", "expected.png");
    const tree2 = join(debugDir, "frames", "002", "captured-tree.json");
    for (const path of [expected0, expected1, expected2, tree0, tree1, tree2]) expect(existsSync(path), path).toBe(true);

    expect(await sharp(expected0).metadata()).toMatchObject({ width: 180, height: 90 });
    expect(await sharp(expected1).metadata()).toMatchObject({ width: 180, height: 90 });
    expect(await sharp(expected2).metadata()).toMatchObject({ width: 180, height: 90 });
    expect(readFileSync(expected0).equals(readFileSync(expected1))).toBe(false);
    const firstTree = JSON.parse(readFileSync(tree0, "utf8")) as unknown;
    const secondTree = JSON.parse(readFileSync(tree1, "utf8")) as unknown;
    expect(Array.isArray(firstTree)).toBe(true);
    expect(Array.isArray(secondTree)).toBe(true);
    expect(JSON.stringify(firstTree)).toContain("zero");
    expect(JSON.stringify(secondTree)).toContain("one");
    expect(JSON.parse(readFileSync(tree2, "utf8"))).toBeNull();
  }, 120_000);

  it("rejects plain --debug before launch when no output is available for naming", async () => {
    const config = join(dir, "no-output.json");
    writeFileSync(config, JSON.stringify({
      width: 100,
      height: 60,
      frames: [{ input: join(dir, "page.html"), duration: 100 }],
    }));
    await expect(runAnimate([config, "--debug", "--quiet"], "")).rejects.toThrow(
      "animate: --debug requires either --output",
    );
  });
});
