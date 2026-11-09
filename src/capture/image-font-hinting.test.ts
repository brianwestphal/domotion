import { describe, expect, it } from "vitest";
import { explicitGlobalFontHinting } from "./image-font-hinting.js";

const shell = "/opt/chromium/chrome-headless-shell";
describe("observed image font hinting", () => {
  it("keeps normal multiprocess, custom Chrome and unknown flags conservative", () => {
    expect(explicitGlobalFontHinting([shell, "--no-sandbox", "--font-render-hinting=medium"])).toBeUndefined();
    expect(
      explicitGlobalFontHinting(["/bin/chrome", "--single-process", "--font-render-hinting=none"]),
    ).toBeUndefined();
    expect(explicitGlobalFontHinting([shell, "--single-process"])).toBeUndefined();
    expect(explicitGlobalFontHinting([shell, "--single-process", "--font-render-hinting=max"])).toBeUndefined();
  });

  it("reads explicit modes and final duplicate values from an actual command line", () => {
    for (const mode of ["none", "slight", "medium", "full"]) {
      expect(explicitGlobalFontHinting([shell, "--single-process", `--font-render-hinting=${mode}`])).toBe(mode);
    }
    expect(
      explicitGlobalFontHinting([
        shell,
        "--single-process",
        "--font-render-hinting=full",
        "--font-render-hinting=none",
      ]),
    ).toBe("none");
  });
});
