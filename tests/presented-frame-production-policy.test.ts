import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// DM-Z869QZ / DM-DPK3T8: a capture that can be the first one of a
// just-launched browser's first page must wait for a presented frame, or the
// DevTools surface copy can come back empty ("Unable to capture screenshot";
// measured 24 of 1,800 times after launchChromium's GPU barrier on hosted
// macOS). These shipped sites take that first capture without any earlier
// animation-frame barrier, so each must keep its wait ahead of the screenshot.
const SITES = [
  { file: "src/cli/review.ts", screenshot: "await page.screenshot({\n    path: outPng," },
  { file: "src/cli/capture.ts", screenshot: "return page.screenshot({\n            clip: { x: clip[0]" },
] as const;

describe("first-capture presented-frame policy (DM-Z869QZ)", () => {
  for (const site of SITES) {
    it(`${site.file} waits for a presented frame before its first capture`, () => {
      const source = readFileSync(site.file, "utf8");
      expect(source).toContain('from "../capture/presented-frame.js"');
      const capture = source.indexOf(site.screenshot);
      expect(capture).toBeGreaterThan(-1);
      const wait = source.lastIndexOf("await waitForPresentedFrame(page);", capture);
      expect(wait).toBeGreaterThan(-1);
      // The wait belongs to this capture: no other screenshot sits between them.
      expect(source.slice(wait, capture)).not.toContain(".screenshot(");
    });
  }
});
