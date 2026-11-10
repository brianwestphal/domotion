import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { retainNativeShadowSource } from "./native-shadow-evidence.js";
let browser: Browser;
let priorProbe: string | undefined;
beforeAll(async () => {
  priorProbe = process.env["DOMOTION_GENERIC_PROBE"];
  process.env["DOMOTION_GENERIC_PROBE"] = "0";
  browser = await launchChromium();
});
afterAll(async () => {
  await closeBrowserSafely(browser);
  if (priorProbe == null) delete process.env["DOMOTION_GENERIC_PROBE"];
  else process.env["DOMOTION_GENERIC_PROBE"] = priorProbe;
});
it("retains unmodified native source/output PNGs when a subsequent controlled assertion fails", async () => {
  const viewport = { x: 0, y: 0, width: 100, height: 100 };
  const page = await browser.newPage({ viewport }),
    output = await browser.newPage({ viewport });
  try {
    const fixtureHtml =
      '<style>body{margin:0}#only{display:block;width:20px;height:20px;background:transparent;box-shadow:4px 4px 0 red}</style><div id="container"><div id="only"></div></div>';
    await page.setContent(fixtureHtml);
    const sourcePng = await page.screenshot({ omitBackground: true });
    const witness = retainNativeShadowSource({
      id: "controlled-assertion-failure",
      label: "actual J2 buffers, deliberately wrong comparison expectation",
      fixtureFile: import.meta.url,
      fixtureHtml,
      browserVersion: browser.version(),
      viewport,
      sourcePng,
    });
    const tree = await captureElementTree(page, "#container", viewport);
    await output.setContent("<style>body{margin:0}</style>" + elementTreeToSvg(tree, 100, 100));
    const outputPng = await output.screenshot({ omitBackground: true });
    witness.output("#container", outputPng);
    const rgba = async (bytes: Buffer) => sharp(bytes).ensureAlpha().raw().toBuffer();
    const source = await rgba(sourcePng),
      actual = await rgba(outputPng);
    expect(actual).toEqual(source);
    const deliberatelyWrong = Buffer.from(source);
    deliberatelyWrong[0] = deliberatelyWrong[0] === 255 ? 0 : 255;
    expect(() => expect(actual).toEqual(deliberatelyWrong)).toThrow();
    expect(readFileSync(join(witness.directory, "source.png"))).toEqual(sourcePng);
    expect(readFileSync(join(witness.directory, "output-container.png"))).toEqual(outputPng);
    const metadata = JSON.parse(readFileSync(join(witness.directory, "metadata.json"), "utf8")) as {
      outputs: Record<string, unknown>;
    };
    expect(metadata.outputs).toHaveProperty("container");
  } finally {
    await page.close();
    await output.close();
  }
});
