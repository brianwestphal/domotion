import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assertJsonHarFile, loadHarArchive } from "../src/capture/har-fetcher.js";
import { isHarPath, inferHarPageUrl } from "../src/cli/common.js";
import { parseCaptureArgs } from "../src/cli/capture.js";
const dir = mkdtempSync(join(tmpdir(), "dm-har-format-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
describe("JSON HAR input boundary (DM-9K75QG)", () => {
  it.each(["archive.har", "archive.har.zip"])("rejects ZIP magic before browser bring-up: %s", (name) => {
    const path = join(dir, name);
    writeFileSync(path, Buffer.from([0x50, 0x4b, 3, 4, 0, 0]));
    expect(isHarPath(path)).toBe(true);
    expect(() => assertJsonHarFile(path)).toThrow("ZIP HAR input is unsupported");
    expect(() => loadHarArchive(path)).toThrow("ZIP HAR input is unsupported");
    expect(() => inferHarPageUrl(path)).toThrow("ZIP HAR input is unsupported");
    expect(() => parseCaptureArgs([path, "--url", "https://fixture.invalid/"])).toThrow("ZIP HAR input is unsupported");
  });
  it("accepts ordinary JSON with sidecars without rewriting its bytes", () => {
    const path = join(dir, "ordinary.har");
    writeFileSync(
      path,
      JSON.stringify({
        log: {
          entries: [
            {
              request: { url: "https://fixture.invalid/", method: "GET" },
              response: { status: 200, content: { _file: "body.bin" } },
            },
          ],
        },
      }),
    );
    expect(() => assertJsonHarFile(path)).not.toThrow();
    expect(loadHarArchive(path).entries).toHaveLength(1);
    expect(inferHarPageUrl(path)).toBe("https://fixture.invalid/");
  });
});
