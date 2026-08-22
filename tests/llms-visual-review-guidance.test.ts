import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function section(markdown: string, start: string, end: string): string {
  const startIndex = markdown.indexOf(start);
  const endIndex = markdown.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) return "";
  return markdown.slice(startIndex, endIndex);
}

describe("AI generated-SVG visual-review guidance", () => {
  const llms = readFileSync(resolve(ROOT, "llms.txt"), "utf8");
  const reviewLoop = section(llms, "### Work the loop", "### Motion");
  const siteGuide = readFileSync(
    resolve(ROOT, "site/src/content/docs/developer/using-ai.md"),
    "utf8",
  );
  const siteGuideText = siteGuide.replace(/\s+/g, " ");

  it("makes rendered output—not successful generation—the pre-handoff gate", () => {
    expect(reviewLoop).toContain("never hand an SVG back for user review");
    expect(reviewLoop).toContain("actually open the pixels");
    expect(reviewLoop).toContain("A plausible SVG source file is not the deliverable");
    expect(reviewLoop).toContain("do not claim the artifact was visually reviewed");
  });

  it("covers still, timeline, full-motion, and reference inspection routes", () => {
    for (const tool of ["svg-to-image", "svg-to-video", "svg-scrubber", "svg-review"]) {
      expect(reviewLoop, `${tool} is missing from the visual handoff gate`).toContain(tool);
    }
    expect(reviewLoop).toContain("--scale 2");
    expect(reviewLoop).toContain("--at <ms>");
    expect(reviewLoop).toContain("watch one complete loop");
    expect(reviewLoop).toContain("final state just before the loop/cut");
  });

  it("keeps the public AI guide aligned with the shipped llms.txt contract", () => {
    expect(siteGuideText).toContain("Before handing an SVG back for human review");
    expect(siteGuideText).toContain("watch one complete loop");
    expect(siteGuideText).toContain("A successful command alone is not a visual review");
    for (const tool of ["svg-to-image", "svg-to-video", "svg-scrubber", "svg-review"]) {
      expect(siteGuide, `${tool} is missing from the public AI guide`).toContain(tool);
    }
  });
});
