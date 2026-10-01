import { release } from "node:os";
import { describe, expect, it } from "vitest";
import { familyMatchEnvironment, fontconfigVersionResult } from "../tools/family-match-environment.js";
// @ts-ignore -- shared inventory module has no declaration file
import { inventoryDocument } from "../tools/font-inventory.mjs";

describe("family-match environment producer", () => {
  it("retains a fontconfig version printed on stderr without invoking a shell", () => {
    expect(fontconfigVersionResult({ status: 0, stdout: "", stderr: "fontconfig version 2.15.0\n" })).toBe(
      "fontconfig version 2.15.0",
    );
    expect(fontconfigVersionResult({ status: 1, stdout: "", stderr: "failed" })).toBe("unavailable");
  });

  it("uses the observed browser and the shared font inventory", () => {
    const env = familyMatchEnvironment("observed-browser");
    expect(env).toMatchObject({
      envContract: "capture-run-env/1",
      platform: process.platform,
      arch: process.arch,
      chromium: "observed-browser",
      osRelease: release(),
      fontDigest: inventoryDocument().digest,
    });
  });
});
