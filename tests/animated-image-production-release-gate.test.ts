import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adjudicateAnimatedImageProductionRelease } from "../tools/animated-image-production-release-gate.js";

async function artifact(root: string, platform: "macOS" | "Linux" | "Windows", failed = 0) {
  const dir = join(root, `animated-image-production-${platform}`); await mkdir(dir);
  await writeFile(join(dir, "decoder.json"), JSON.stringify({ verdict: "decoder-frame-exact", errors: [],
    browser: { headless: true, platform: platform === "macOS" ? "MacIntel" : platform === "Linux" ? "Linux x86_64" : "Win32" } }));
  await writeFile(join(dir, "production-tests.json"), JSON.stringify({ success: failed === 0,
    numPassedTests: 18 - failed, numFailedTests: failed }));
  await writeFile(join(dir, "run-env.json"), JSON.stringify({ os: platform, boot: `${platform}-boot` }));
}

describe("animated-image macOS/Linux/Windows production release gate", () => {
  it("requires all three exact native artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "animated-image-release-"));
    await artifact(root, "macOS"); await artifact(root, "Linux"); await artifact(root, "Windows");
    expect((await adjudicateAnimatedImageProductionRelease(root)).verdict).toBe("macos-linux-windows-production-exact");
  });
  it("rejects a missing platform and a red production test", async () => {
    const missing = await mkdtemp(join(tmpdir(), "animated-image-release-")); await artifact(missing, "macOS");
    expect((await adjudicateAnimatedImageProductionRelease(missing)).failures).toContain("Linux: native artifact missing");
    const red = await mkdtemp(join(tmpdir(), "animated-image-release-"));
    await artifact(red, "macOS"); await artifact(red, "Linux"); await artifact(red, "Windows", 1);
    expect((await adjudicateAnimatedImageProductionRelease(red)).failures).toContain("Windows: focused production matrix did not pass completely");
  });
  it("keeps the native workflow explicitly headless, three-platform, and artifact-retaining", async () => {
    const workflow = await readFile(".github/workflows/animated-image-production-release.yml", "utf8");
    expect(workflow).toContain("runner: macos-latest"); expect(workflow).toContain("runner: ubuntu-latest");
    expect(workflow).toContain("runner: windows-latest");
    expect(workflow).toContain("media:animated-image-frame-audit");
    expect(workflow).toContain("tests/animated-image-static-frame.e2e.test.ts");
    expect(workflow).toContain("media:animated-image-production-release");
    expect(workflow).toContain("animated-image-macos-linux-windows-release-evidence");
    const packageJson = await readFile("package.json", "utf8");
    expect(packageJson).toContain('"media:animated-image-frame-audit": "node --import tsx tools/animated-image-frame-selection-audit-cli.ts"');
    expect(packageJson).toContain('"media:animated-image-production-release": "node --import tsx tools/animated-image-production-release-gate-cli.ts"');
    expect(await readFile("tools/animated-image-frame-selection-audit-cli.ts", "utf8")).toContain("mainAnimatedImageFrameSelectionAudit");
    expect(await readFile("tools/animated-image-production-release-gate-cli.ts", "utf8")).toContain("mainAnimatedImageProductionReleaseGate");
  });
});
