import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

describe("declarative animation module boundaries", () => {
  it("keeps stable facades while assigning command, artifact, capture, and SVG ownership", () => {
    const cliFacade = source("animate.ts");
    const command = source("animate-command.ts");
    const artifact = source("animate-artifact.ts");
    const session = source("animate-capture-session.ts");
    const frameCapture = source("animate-frame-capture.ts");
    const animatorFacade = source("../animation/animator.ts");
    const generator = source("../animation/svg-generator.ts");

    expect(cliFacade).not.toContain("parseArgs(");
    expect(cliFacade).not.toContain("browser.newContext");
    expect(command).toContain("parseArgs(");
    expect(command).toContain("launchChromium()");
    expect(artifact).toContain("writeAnimateArtifact");
    expect(session).toContain("openAnimateCaptureSession");
    expect(frameCapture).toContain("captureAnimateFrame");

    expect(animatorFacade).not.toContain("function generateAnimatedSvgBody");
    expect(generator).toContain("function generateAnimatedSvgBody");
    expect(generator).not.toContain("launchChromium");
  });
});
