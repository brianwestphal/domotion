import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isGlyphHelperAvailable, resolveInstalledFont } from "@domotion/text-engine/testing";
import { main } from "../tools/font-conformance.js";
import { syntheticCorpus } from "../tools/font-conformance-synthetic-stacks.js";

// The standalone SF Pro Text OTF is an Apple download, present on developer Macs
// and absent from the CI runner image; without it the shortcut cannot fire.
const describeOtfMac =
  process.platform === "darwin" && isGlyphHelperAvailable() && resolveInstalledFont("SF Pro Text") != null
    ? describe
    : describe.skip;

describeOtfMac("macOS standalone SF Pro OTF fallback", () => {
  it("leaves system-ui on the CoreText UI cascade while a named SF Pro Text keeps the OTF", async () => {
    const root = mkdtempSync(join(tmpdir(), "domotion-system-ui-sf-pro-otf-e2e-"));
    const stacksFile = join(root, "stacks.json");
    const output = join(root, "out");
    const corpus = syntheticCorpus();
    const systemUi = corpus.stacks.find((stack) => stack.fontFamily === "system-ui" && stack.fontWeight === 400);
    expect(systemUi).toBeDefined();
    const namedSfPro = { ...systemUi!, fontFamily: '"SF Pro Text"', example: "SF Pro Text @16px / 400" };
    writeFileSync(stacksFile, JSON.stringify({ ...corpus, stacks: [systemUi, namedSfPro] }));
    // Two-digit enclosed alphanumerics: absent from SFNS, present in the OTF.
    expect(await main(["--stacks", stacksFile, "--range", "2469,2470,24EB", "--out", output])).toBe(0);
    const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
    expect(report.data.summary.comparisons).toBe(6);
    expect(report.data.summary.mismatchTotal).toBe(0);
    expect(report.data.chromeFaces).toContainEqual(expect.objectContaining({ face: ".HiraKakuInterface-W4" }));
    expect(report.data.chromeFaces).toContainEqual(expect.objectContaining({ face: "SFProText-Regular" }));
  }, 90_000);
});
